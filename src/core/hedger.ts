// ============================================================
// Hedger Orchestrator
// ============================================================
// Manages the hedge cycle: open both sides → wait → close both → swap → repeat
// Verifies fills via position queries. Graceful stop with position cleanup.
// ============================================================

import { ExchangeClient, HedgeConfig } from '../utils/types';
import { Tracker } from './tracker';
import { safeLog } from '../utils/security';

const FILL_CHECK_INTERVAL_MS = 2000;
const FILL_CHECK_MAX_RETRIES = 15; // 30 seconds max
const CLOSE_RETRY_MAX = 3;

interface HedgeState {
  running: boolean;
  currentCycle: number;
  longExchange: 'standx' | 'decibel';
  shortExchange: 'standx' | 'decibel';
  isPositionOpen: boolean;
  lastRotation: number;
}

export class Hedger {
  private standx: ExchangeClient;
  private decibel: ExchangeClient;
  private config: HedgeConfig;
  private tracker: Tracker;
  private state: HedgeState;
  private stopResolve: (() => void) | null = null;

  constructor(
    standx: ExchangeClient,
    decibel: ExchangeClient,
    config: HedgeConfig,
    tracker: Tracker,
  ) {
    this.standx = standx;
    this.decibel = decibel;
    this.config = config;
    this.tracker = tracker;

    const longEx = config.initialLongExchange;
    const shortEx = longEx === 'standx' ? 'decibel' : 'standx';

    this.state = {
      running: false,
      currentCycle: 0,
      longExchange: longEx,
      shortExchange: shortEx,
      isPositionOpen: false,
      lastRotation: Date.now(),
    };
  }

  async start(): Promise<void> {
    this.state.running = true;
    safeLog.info('[Hedger] Starting hedge bot...');
    this.printConfig();

    while (this.state.running) {
      try {
        await this.runCycle();
      } catch (err: any) {
        safeLog.error(`[Hedger] Cycle error: ${err?.message ?? err}`);
        await sleep(10000);
      }
    }

    // If positions are still open on stop, close them
    if (this.state.isPositionOpen) {
      safeLog.info('[Hedger] Closing remaining positions before exit...');
      await this.closeAllPositions();
    }

    safeLog.info('[Hedger] Bot stopped.');
    if (this.stopResolve) this.stopResolve();
  }

  /**
   * Request graceful stop. Returns a promise that resolves when
   * all positions are closed and the main loop exits.
   */
  async stop(): Promise<void> {
    this.state.running = false;
    safeLog.info('[Hedger] Stop requested. Waiting for current cycle to finish...');

    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
      // If start() already exited (not running), resolve immediately
      setTimeout(() => resolve(), 30000); // 30s safety timeout
    });
  }

  // ── Main cycle ───────────────────────────────────────────

  private async runCycle(): Promise<void> {
    this.state.currentCycle++;
    const cycle = this.state.currentCycle;

    safeLog.info(`\n━━━ Cycle #${cycle} ━━━ Long=${this.state.longExchange} | Short=${this.state.shortExchange} ━━━`);

    // Step 1: Get prices from both exchanges
    const [standxPrice, decibelPrice] = await Promise.all([
      this.standx.getPrice(this.config.symbol),
      this.decibel.getPrice(this.config.symbol),
    ]);

    safeLog.info(`[Price] StandX mid=$${standxPrice.mid} | Decibel mid=$${decibelPrice.mid}`);

    // Step 2: Open hedge — Long on one, Short on the other
    const longClient = this.getClient(this.state.longExchange);
    const shortClient = this.getClient(this.state.shortExchange);
    const longPrice = this.state.longExchange === 'standx' ? standxPrice : decibelPrice;
    const shortPrice = this.state.shortExchange === 'standx' ? standxPrice : decibelPrice;

    const longBuyPrice = Math.round(parseFloat(longPrice.ask)).toString();
    const shortSellPrice = Math.round(parseFloat(shortPrice.bid)).toString();

    safeLog.info(`[Open] ${this.state.longExchange} BUY @ $${longBuyPrice} | ${this.state.shortExchange} SELL @ $${shortSellPrice}`);

    // Place both orders concurrently
    const [longResult, shortResult] = await Promise.all([
      longClient.placeOrder({
        symbol: this.config.symbol,
        side: 'buy',
        size: this.config.orderSize,
        price: longBuyPrice,
      }),
      shortClient.placeOrder({
        symbol: this.config.symbol,
        side: 'sell',
        size: this.config.orderSize,
        price: shortSellPrice,
      }),
    ]);

    // Handle submission failures
    if (!longResult.success && !shortResult.success) {
      safeLog.error(`[Open] Both orders failed. Long: ${longResult.error} | Short: ${shortResult.error}`);
      await sleep(5000);
      return;
    }

    if (!longResult.success || !shortResult.success) {
      const failedSide = !longResult.success ? 'long' : 'short';
      const successResult = failedSide === 'long' ? shortResult : longResult;
      const successClient = failedSide === 'long' ? shortClient : longClient;

      safeLog.warn(`[Open] ${failedSide} failed, cancelling other (${successResult.orderId})`);
      await successClient.cancelOrder(successResult.orderId);
      await this.emergencyClose(successClient, failedSide === 'long' ? 'buy' : 'sell');
      await sleep(5000);
      return;
    }

    // Step 2b: Verify fills — submission success ≠ fill
    safeLog.info('[Open] Orders submitted. Verifying fills...');
    const [longFilled, shortFilled] = await Promise.all([
      this.waitForFill(longClient, this.config.symbol),
      this.waitForFill(shortClient, this.config.symbol),
    ]);

    if (!longFilled || !shortFilled) {
      safeLog.warn(`[Open] Fill verification failed. Long: ${longFilled}, Short: ${shortFilled}`);
      // Cancel unfilled, close filled
      if (!longFilled) {
        await longClient.cancelOrder(longResult.orderId);
        if (shortFilled) await this.emergencyClose(shortClient, 'buy');
      }
      if (!shortFilled) {
        await shortClient.cancelOrder(shortResult.orderId);
        if (longFilled) await this.emergencyClose(longClient, 'sell');
      }
      await sleep(5000);
      return;
    }

    this.state.isPositionOpen = true;
    const now = Date.now();

    this.tracker.recordTrade({
      timestamp: now,
      exchange: this.state.longExchange,
      action: 'open',
      side: 'long',
      size: this.config.orderSize,
      price: longBuyPrice,
      fee: longResult.fee,
      orderId: longResult.orderId,
    });

    this.tracker.recordTrade({
      timestamp: now,
      exchange: this.state.shortExchange,
      action: 'open',
      side: 'short',
      size: this.config.orderSize,
      price: shortSellPrice,
      fee: shortResult.fee,
      orderId: shortResult.orderId,
    });

    safeLog.info(`[Open] Hedge verified | Long: ${longResult.orderId} | Short: ${shortResult.orderId}`);
    this.tracker.printStatus();

    // Step 3: Wait for rotation interval
    const waitMs = this.getRotationWaitMs();
    safeLog.info(`[Wait] Next rotation in ${(waitMs / 1000).toFixed(0)}s`);

    await this.waitWithHeartbeat(waitMs);

    if (!this.state.running) return; // stop() was called — closeAllPositions handles cleanup

    // Step 4: Close both positions (with retry)
    await this.closeAllPositions();

    // Step 5: Swap sides for next cycle
    this.swapSides();
    this.state.lastRotation = Date.now();

    safeLog.info(`[Swap] Sides swapped → Long=${this.state.longExchange} | Short=${this.state.shortExchange}`);
    this.tracker.printStatus();
  }

  // ── Position close with retry and verification ───────────

  private async closeAllPositions(): Promise<void> {
    safeLog.info('[Close] Closing both positions...');

    const longClient = this.getClient(this.state.longExchange);
    const shortClient = this.getClient(this.state.shortExchange);

    let longClosed = false;
    let shortClosed = false;

    for (let attempt = 1; attempt <= CLOSE_RETRY_MAX; attempt++) {
      if (longClosed && shortClosed) break;

      if (!longClosed || !shortClosed) {
        const [closePriceStandx, closePriceDecibel] = await Promise.all([
          this.standx.getPrice(this.config.symbol),
          this.decibel.getPrice(this.config.symbol),
        ]);

        const closePromises: Promise<void>[] = [];

        if (!longClosed) {
          const longClosePrice = this.state.longExchange === 'standx'
            ? Math.round(parseFloat(closePriceStandx.bid)).toString()
            : Math.round(parseFloat(closePriceDecibel.bid)).toString();

          closePromises.push(
            longClient.placeOrder({
              symbol: this.config.symbol,
              side: 'sell',
              size: this.config.orderSize,
              price: longClosePrice,
              reduceOnly: true,
            }).then((res) => {
              if (res.success) {
                this.tracker.recordTrade({
                  timestamp: Date.now(),
                  exchange: this.state.longExchange,
                  action: 'close',
                  side: 'long',
                  size: this.config.orderSize,
                  price: longClosePrice,
                  fee: res.fee,
                  orderId: res.orderId,
                });
                longClosed = true;
              } else {
                safeLog.warn(`[Close] Long close attempt ${attempt} failed: ${res.error}`);
              }
            })
          );
        }

        if (!shortClosed) {
          const shortClosePrice = this.state.shortExchange === 'standx'
            ? Math.round(parseFloat(closePriceStandx.ask)).toString()
            : Math.round(parseFloat(closePriceDecibel.ask)).toString();

          closePromises.push(
            shortClient.placeOrder({
              symbol: this.config.symbol,
              side: 'buy',
              size: this.config.orderSize,
              price: shortClosePrice,
              reduceOnly: true,
            }).then((res) => {
              if (res.success) {
                this.tracker.recordTrade({
                  timestamp: Date.now(),
                  exchange: this.state.shortExchange,
                  action: 'close',
                  side: 'short',
                  size: this.config.orderSize,
                  price: shortClosePrice,
                  fee: res.fee,
                  orderId: res.orderId,
                });
                shortClosed = true;
              } else {
                safeLog.warn(`[Close] Short close attempt ${attempt} failed: ${res.error}`);
              }
            })
          );
        }

        await Promise.all(closePromises);

        if (!longClosed || !shortClosed) {
          safeLog.info(`[Close] Retry ${attempt}/${CLOSE_RETRY_MAX}...`);
          await sleep(3000);
        }
      }
    }

    // Verify actual positions after close attempts
    const [longPos, shortPos] = await Promise.all([
      longClient.getPosition(this.config.symbol).catch(() => null),
      shortClient.getPosition(this.config.symbol).catch(() => null),
    ]);

    const longSize = longPos ? parseFloat(longPos.size) : 0;
    const shortSize = shortPos ? parseFloat(shortPos.size) : 0;

    if (longSize > 0 || shortSize > 0) {
      safeLog.error(`[Close] WARNING: Residual positions remain! Long: ${longSize} | Short: ${shortSize}`);
      this.state.isPositionOpen = true;
    } else {
      this.state.isPositionOpen = false;
      safeLog.info('[Close] Both positions closed and verified.');
    }
  }

  // ── Fill verification ────────────────────────────────────

  private async waitForFill(client: ExchangeClient, symbol: string): Promise<boolean> {
    for (let i = 0; i < FILL_CHECK_MAX_RETRIES; i++) {
      await sleep(FILL_CHECK_INTERVAL_MS);
      try {
        const pos = await client.getPosition(symbol);
        if (pos && parseFloat(pos.size) > 0) {
          return true;
        }
      } catch {
        // retry
      }
    }
    return false;
  }

  // ── Helpers ──────────────────────────────────────────────

  private getClient(exchange: 'standx' | 'decibel'): ExchangeClient {
    return exchange === 'standx' ? this.standx : this.decibel;
  }

  private swapSides(): void {
    const temp = this.state.longExchange;
    this.state.longExchange = this.state.shortExchange;
    this.state.shortExchange = temp;
  }

  private getRotationWaitMs(): number {
    if (this.config.rotationMode === 'fixed') {
      return this.config.rotationIntervalMs;
    }
    const min = this.config.rotationRandomMinMs;
    const max = this.config.rotationRandomMaxMs;
    return min + Math.floor(Math.random() * (max - min));
  }

  private async waitWithHeartbeat(ms: number): Promise<void> {
    const start = Date.now();
    const heartbeatInterval = 30000;

    while (Date.now() - start < ms && this.state.running) {
      const remaining = ms - (Date.now() - start);
      const waitChunk = Math.min(remaining, heartbeatInterval);
      await sleep(waitChunk);

      if (this.state.running && Date.now() - start < ms) {
        const secsLeft = Math.round((ms - (Date.now() - start)) / 1000);
        safeLog.info(`[Wait] ${secsLeft}s until rotation...`);
      }
    }
  }

  private async emergencyClose(client: ExchangeClient, side: 'buy' | 'sell'): Promise<void> {
    try {
      const price = await client.getPrice(this.config.symbol);
      const closePrice = side === 'sell'
        ? Math.round(parseFloat(price.bid)).toString()
        : Math.round(parseFloat(price.ask)).toString();

      await client.placeOrder({
        symbol: this.config.symbol,
        side,
        size: this.config.orderSize,
        price: closePrice,
        reduceOnly: true,
      });
      safeLog.info(`[Emergency] Closed position on ${client.name}`);
    } catch (err: any) {
      safeLog.error(`[Emergency] Failed to close on ${client.name}: ${err?.message}`);
    }
  }

  private printConfig(): void {
    const c = this.config;
    const lines = [
      '',
      '╔══════════════════════════════════════════════════════╗',
      '║                 HEDGE BOT CONFIG                    ║',
      '╠══════════════════════════════════════════════════════╣',
      `║  Symbol: ${c.symbol.padEnd(10)} │ Size: ${c.orderSize.padEnd(10)} │ Lev: ${c.leverage}x      ║`,
      `║  Tolerance: $${c.priceTolerance}    │ Wallet: ${c.walletMode.padEnd(10)}              ║`,
      `║  Rotation: ${c.rotationMode.padEnd(8)} │ ${c.rotationMode === 'fixed' ? `Interval: ${c.rotationIntervalMs / 1000}s` : `Range: ${c.rotationRandomMinMs / 1000}s - ${c.rotationRandomMaxMs / 1000}s`}       ║`,
      `║  Long: ${this.state.longExchange.padEnd(10)} │ Short: ${this.state.shortExchange.padEnd(10)}          ║`,
      '╚══════════════════════════════════════════════════════╝',
      '',
    ];
    console.log(lines.join('\n'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
