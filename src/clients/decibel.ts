// ============================================================
// Decibel Exchange Client
// ============================================================
// Decibel is a fully on-chain perps DEX on Aptos L1.
// - REST API: read-only queries (prices, positions, balances)
// - Order execution: Aptos Move transactions via @aptos-labs/ts-sdk
// - WebSocket: real-time account updates
// ============================================================

import {
  Aptos,
  AptosConfig,
  Network,
  Ed25519PrivateKey,
  Account,
  InputEntryFunctionData,
  UserTransactionResponse,
} from '@aptos-labs/ts-sdk';
import WebSocket from 'ws';
import { vault, safeLog } from '../utils/security';
import { ExchangeClient, OrderResult, Position } from '../utils/types';

// ============================================================
// Constants
// ============================================================

const REST_BASE_MAINNET = 'https://api.mainnet.aptoslabs.com/decibel';
const WS_URL_MAINNET = 'wss://api.mainnet.aptoslabs.com/decibel/ws';
const ORIGIN_HEADER = 'https://netna-app.decibel.trade/trade';

// Decibel Move module address (mainnet)
// Source: https://docs.decibel.trade/developer-hub/on-chain/overview/contract-reference
const DECIBEL_MODULE = '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';

// On-chain decimal scaling: both price and size use 9 decimals
const SCALE = 10 ** 9;

// Time-in-force (Move u8 enum — Decibel specific)
// const TIF_GTC = 0;        // Good-til-cancel
const TIF_POST_ONLY = 1;    // Post-only (maker) — minimizes fees
// const TIF_IOC = 2;        // Immediate-or-cancel

// Symbol mapping: internal symbol -> Decibel market name
const SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTC/USD',
  ETH: 'ETH/USD',
  SOL: 'SOL/USD',
};

// WS reconnect limits
const WS_MAX_SESSION_MS = 55 * 60 * 1000; // 55 min (server max is 60)
const WS_HEARTBEAT_INTERVAL_MS = 25_000;
const WS_RECONNECT_BASE_MS = 10_000;   // 429 방지: 10초부터 시작
const WS_RECONNECT_MAX_MS = 120_000;   // 최대 2분

// ============================================================
// Helpers
// ============================================================

function toU64(value: string): string {
  return Math.round(parseFloat(value) * SCALE).toString();
}

let orderIdCounter = 0;
function makeClientOrderId(): string {
  orderIdCounter++;
  return `${Date.now()}${orderIdCounter}${Math.floor(Math.random() * 1000)}`;
}

// ============================================================
// DecibelClient
// ============================================================

export class DecibelClient implements ExchangeClient {
  name = 'decibel' as const;

  private aptos: Aptos | null = null;
  private account: Account | null = null;
  private bearerToken: string = '';
  private subaccountAddress: string = '';
  private walletAddress: string = '';
  private restBase: string = REST_BASE_MAINNET;
  private wsUrl: string = WS_URL_MAINNET;

  // symbol -> on-chain market address
  private marketAddresses: Map<string, string> = new Map();

  // Module address for Decibel smart contracts (configurable)
  private moduleAddress: string = DECIBEL_MODULE;

  // WebSocket
  private ws: WebSocket | null = null;
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wsSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnecting = false;
  private wsReconnectAttempt = 0;

  // Position cache (updated via WS)
  private positionCache: Map<string, Position> = new Map();

  constructor(opts?: { restBase?: string; wsUrl?: string; moduleAddress?: string }) {
    if (opts?.restBase) this.restBase = opts.restBase;
    if (opts?.wsUrl) this.wsUrl = opts.wsUrl;
    if (opts?.moduleAddress) this.moduleAddress = opts.moduleAddress;
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  async connect(): Promise<void> {
    // Load credentials from vault
    const walletKey = vault.get('decibel_wallet_key');
    if (!walletKey) throw new Error('[Decibel] API wallet private key not found in vault');

    this.bearerToken = vault.get('decibel_bearer') || '';
    if (!this.bearerToken) throw new Error('[Decibel] Bearer token not found in vault');

    this.subaccountAddress = vault.get('decibel_subaccount') || '';

    // Init Aptos SDK
    const config = new AptosConfig({ network: Network.MAINNET });
    this.aptos = new Aptos(config);

    // Create signing account from private key → address auto-derived
    const privateKey = new Ed25519PrivateKey(walletKey);
    this.account = Account.fromPrivateKey({ privateKey });
    this.walletAddress = this.account.accountAddress.toString();

    // Auto-discover Trading Account if not provided
    if (!this.subaccountAddress) {
      await this.discoverSubaccount();
    }
    if (!this.subaccountAddress) {
      // Fallback to wallet address
      this.subaccountAddress = this.walletAddress;
      safeLog.warn('[Decibel] No Trading Account found. Using API Wallet address as fallback.');
    }

    // Fetch market addresses from asset_contexts
    await this.fetchMarketAddresses();

    safeLog.info(`[Decibel] Connected | wallet=${this.walletAddress.slice(0, 10)}... | subaccount=${this.subaccountAddress.slice(0, 10)}... | markets=${this.marketAddresses.size}`);

    // Start WS after delay (REST 호출 후 rate limit 여유 확보)
    setTimeout(() => this.connectWebSocket(), 3000);
  }

  async disconnect(): Promise<void> {
    this.closeWebSocket();
    this.aptos = null;
    this.account = null;
    this.positionCache.clear();
    safeLog.info('[Decibel] Disconnected');
  }

  // ----------------------------------------------------------
  // REST: Prices
  // ----------------------------------------------------------

  async getPrice(symbol: string): Promise<{ bid: string; ask: string; mid: string }> {
    const marketName = SYMBOL_MAP[symbol] || `${symbol}/USD`;
    // 심볼 → 마켓 주소 변환
    const marketAddr = this.marketAddresses.get(marketName) || this.marketAddresses.get(symbol) || '';

    // 특정 마켓만 조회 (주소가 있으면 query param 사용)
    const query = marketAddr ? `?market=${marketAddr}` : '';
    const data = await this.restGet(`/api/v1/prices${query}`);

    let entry: any = null;
    if (Array.isArray(data)) {
      if (marketAddr) {
        // 주소로 매칭
        entry = data.find((p: any) => p.market === marketAddr);
      }
      if (!entry) {
        // 이름으로 폴백
        entry = data.find((p: any) => p.market === marketName || p.symbol === marketName || p.name === marketName);
      }
      if (!entry && data.length === 1) {
        // 단일 결과면 그대로 사용
        entry = data[0];
      }
    } else if (data && typeof data === 'object') {
      entry = data[marketAddr] || data[marketName];
    }

    if (!entry) {
      throw new Error(`[Decibel] Price not found for ${marketName} (addr: ${marketAddr?.slice(0, 10)}...)`);
    }

    // API 응답 필드: mark_px, mid_px, oracle_px (bid/ask 없음)
    const markPx = parseFloat(entry.mark_px ?? entry.mark_price ?? '0');
    const midPx = parseFloat(entry.mid_px ?? entry.mid_price ?? '0');
    const oraclePx = parseFloat(entry.oracle_px ?? entry.oracle_price ?? '0');
    const price = midPx || markPx || oraclePx;

    if (price <= 0) {
      throw new Error(`[Decibel] Invalid price for ${marketName}: mark=${markPx}, mid=${midPx}, oracle=${oraclePx}`);
    }

    // bid/ask 없으므로 mid 기준 ±0.01% 스프레드 추정
    const spread = price * 0.0001;
    const bid = (price - spread).toFixed(2);
    const ask = (price + spread).toFixed(2);
    const mid = price.toFixed(2);

    return { bid, ask, mid };
  }

  // ----------------------------------------------------------
  // REST: Position
  // ----------------------------------------------------------

  async getPosition(symbol: string): Promise<Position | null> {
    const data = await this.restGet(`/api/v1/account_positions?account=${this.subaccountAddress}`);

    const marketName = SYMBOL_MAP[symbol] || `${symbol}/USD`;
    const positions = Array.isArray(data) ? data : (data?.positions ?? []);

    const pos = positions.find(
      (p: any) => p.market === marketName || p.symbol === marketName || p.market_name === marketName,
    );

    if (!pos || parseFloat(pos.size ?? pos.qty ?? '0') === 0) {
      return null;
    }

    const sizeRaw = parseFloat(pos.size ?? pos.qty ?? '0');
    const side: 'long' | 'short' = sizeRaw > 0 ? 'long' : 'short';

    return {
      exchange: 'decibel',
      side,
      size: Math.abs(sizeRaw).toString(),
      entryPrice: String(pos.entry_price ?? pos.avg_price ?? '0'),
      unrealizedPnl: String(pos.unrealized_pnl ?? pos.unrealized_funding ?? pos.upnl ?? '0'),
      leverage: Number(pos.user_leverage ?? pos.leverage ?? 1),
    };
  }

  // ----------------------------------------------------------
  // REST: Balance
  // ----------------------------------------------------------

  async getBalance(): Promise<{ available: string; equity: string }> {
    const data = await this.restGet(`/api/v1/account_overviews?account=${this.subaccountAddress}`);
    safeLog.info(`[Decibel] Balance raw: ${JSON.stringify(data).slice(0, 500)}`);

    // Handle both single object and array response
    const overview = Array.isArray(data) ? data[0] : data;

    if (!overview) {
      return { available: '0', equity: '0' };
    }

    return {
      available: String(overview.available_balance ?? overview.usdc_cross_withdrawable_balance ?? overview.free_collateral ?? overview.available ?? '0'),
      equity: String(overview.perp_equity_balance ?? overview.equity ?? overview.account_value ?? overview.total ?? '0'),
    };
  }

  // ----------------------------------------------------------
  // On-chain: Place Order (Aptos Move transaction)
  // ----------------------------------------------------------

  async placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    size: string;
    price: string;
    reduceOnly?: boolean;
  }): Promise<OrderResult> {
    if (!this.aptos || !this.account) {
      throw new Error('[Decibel] Not connected');
    }

    const marketName = SYMBOL_MAP[params.symbol] || `${params.symbol}/USD`;
    const marketAddress = this.marketAddresses.get(marketName);
    if (!marketAddress) {
      throw new Error(`[Decibel] Market address unknown for ${marketName}. Known: ${[...this.marketAddresses.keys()].join(', ')}`);
    }

    const isBuy = params.side === 'buy';
    const priceU64 = toU64(params.price);
    const sizeU64 = toU64(params.size);
    const reduceOnly = params.reduceOnly ?? false;
    const clientOrderId = makeClientOrderId();

    safeLog.info(`[Decibel] Placing ${params.side} ${params.size} ${marketName} @ ${params.price} | reduce_only=${reduceOnly} | coid=${clientOrderId}`);

    try {
      // ABI: dex_accounts_entry::place_order_to_subaccount
      // params: subaccount, market, price, size, is_buy, tif, is_reduce_only,
      //         client_order_id?, stop_price?, tp_trigger?, tp_limit?, sl_trigger?, sl_limit?,
      //         builder_address?, builder_fees?
      const txData: InputEntryFunctionData = {
        function: `${this.moduleAddress}::dex_accounts_entry::place_order_to_subaccount`,
        typeArguments: [],
        functionArguments: [
          this.subaccountAddress,   // Object<Subaccount>
          marketAddress,            // Object<PerpMarket>
          priceU64,                 // u64 price (9 decimals)
          sizeU64,                  // u64 size (9 decimals)
          isBuy,                    // bool
          TIF_POST_ONLY,            // u8 time_in_force (1 = PostOnly/maker)
          reduceOnly,               // bool
          clientOrderId,            // Option<String> client_order_id
          null,                     // Option<u64> stop_price
          null,                     // Option<u64> tp_trigger_price
          null,                     // Option<u64> tp_limit_price
          null,                     // Option<u64> sl_trigger_price
          null,                     // Option<u64> sl_limit_price
          null,                     // Option<address> builder_address
          null,                     // Option<u64> builder_fees
        ],
      };

      const transaction = await this.aptos.transaction.build.simple({
        sender: this.account.accountAddress,
        data: txData,
      });

      const pendingTx = await this.aptos.signAndSubmitTransaction({
        signer: this.account,
        transaction,
      });

      // Wait for confirmation
      const confirmedTx = await this.aptos.waitForTransaction({
        transactionHash: pendingTx.hash,
      }) as UserTransactionResponse;

      const success = confirmedTx.success;
      const txHash = confirmedTx.hash;

      if (!success) {
        const vmStatus = confirmedTx.vm_status ?? 'unknown';
        safeLog.error(`[Decibel] Order failed: ${vmStatus} | tx=${txHash}`);
        return {
          success: false,
          orderId: txHash,
          price: params.price,
          size: params.size,
          fee: '0',
          error: `Transaction failed: ${vmStatus}`,
        };
      }

      // Estimate fee (gas in APT, not trading fee)
      const gasUsed = Number(confirmedTx.gas_used ?? '0');
      const gasPrice = Number(confirmedTx.gas_unit_price ?? '100');
      const gasFeeApt = (gasUsed * gasPrice) / 1e8;

      safeLog.info(`[Decibel] Order submitted | tx=${txHash} | gas=${gasFeeApt.toFixed(6)} APT`);

      return {
        success: true,
        orderId: txHash,
        price: params.price,
        size: params.size,
        fee: gasFeeApt.toFixed(8),
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      safeLog.error(`[Decibel] Order error: ${msg}`);
      return {
        success: false,
        orderId: '',
        price: params.price,
        size: params.size,
        fee: '0',
        error: msg,
      };
    }
  }

  // ----------------------------------------------------------
  // On-chain: Cancel Order (Aptos Move transaction)
  // ----------------------------------------------------------

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.aptos || !this.account) {
      throw new Error('[Decibel] Not connected');
    }

    safeLog.info(`[Decibel] Cancelling order ${orderId}`);

    try {
      const txData: InputEntryFunctionData = {
        function: `${this.moduleAddress}::dex_accounts_entry::cancel_order_to_subaccount`,
        typeArguments: [],
        functionArguments: [
          this.subaccountAddress,  // Object<Subaccount>
          orderId,                 // u128 order_id
          this.marketAddresses.values().next().value ?? '', // Object<PerpMarket>
        ],
      };

      const transaction = await this.aptos.transaction.build.simple({
        sender: this.account.accountAddress,
        data: txData,
      });

      const pendingTx = await this.aptos.signAndSubmitTransaction({
        signer: this.account,
        transaction,
      });

      const confirmedTx = await this.aptos.waitForTransaction({
        transactionHash: pendingTx.hash,
      }) as UserTransactionResponse;

      if (!confirmedTx.success) {
        safeLog.error(`[Decibel] Cancel failed: ${confirmedTx.vm_status} | tx=${confirmedTx.hash}`);
        return false;
      }

      safeLog.info(`[Decibel] Cancel confirmed | tx=${confirmedTx.hash}`);
      return true;
    } catch (err: any) {
      safeLog.error(`[Decibel] Cancel error: ${err?.message ?? err}`);
      return false;
    }
  }

  // ----------------------------------------------------------
  // REST helper
  // ----------------------------------------------------------

  private async restGet(path: string): Promise<any> {
    const url = `${this.restBase}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Origin': ORIGIN_HEADER,
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[Decibel] REST ${res.status} ${res.statusText}: ${path} — ${body}`);
    }

    return res.json();
  }

  // ----------------------------------------------------------
  // Market address discovery
  // ----------------------------------------------------------

  private async fetchMarketAddresses(): Promise<void> {
    try {
      const data = await this.restGet('/api/v1/markets');
      const markets = Array.isArray(data) ? data : [];

      for (const m of markets) {
        const name = m.market_name ?? '';
        const addr = m.market_addr ?? '';
        if (name && addr) {
          // "BTC/USD" → "BTC/USD" 그대로 + "BTC" 축약도 등록
          this.marketAddresses.set(name, addr);
          const short = name.split('/')[0];
          if (short && short !== name) {
            this.marketAddresses.set(short, addr);
          }
        }
      }

      if (this.marketAddresses.size === 0) {
        safeLog.warn('[Decibel] No market addresses discovered from /api/v1/markets. Orders will fail.');
      } else {
        safeLog.info(`[Decibel] Discovered ${this.marketAddresses.size} market(s): ${[...this.marketAddresses.keys()].join(', ')}`);
      }
    } catch (err: any) {
      safeLog.warn(`[Decibel] Failed to fetch market addresses: ${err?.message ?? err}. Set manually via setMarketAddress().`);
    }
  }

  /**
   * Auto-discover Trading Account (subaccount) via REST API.
   */
  private async discoverSubaccount(): Promise<void> {
    try {
      const data = await this.restGet(`/api/v1/subaccounts?owner=${this.walletAddress}`);
      const accounts = Array.isArray(data) ? data : (data?.subaccounts ?? data?.accounts ?? []);

      if (accounts.length > 0) {
        // Use the first (or most recently created) subaccount
        const sub = accounts[accounts.length - 1];
        this.subaccountAddress = sub.address ?? sub.subaccount_address ?? sub.account ?? '';
        if (this.subaccountAddress) {
          safeLog.info(`[Decibel] Auto-discovered Trading Account: ${this.subaccountAddress.slice(0, 10)}...`);
        }
      } else {
        safeLog.warn('[Decibel] No Trading Accounts found for this API Wallet.');
      }
    } catch (err: any) {
      safeLog.warn(`[Decibel] Subaccount discovery failed: ${err?.message ?? err}`);
    }
  }

  getWalletAddress(): string {
    return this.subaccountAddress || this.walletAddress;
  }

  setMarketAddress(symbol: string, address: string): void {
    const marketName = SYMBOL_MAP[symbol] || `${symbol}/USD`;
    this.marketAddresses.set(marketName, address);
  }

  // ----------------------------------------------------------
  // WebSocket
  // ----------------------------------------------------------

  private connectWebSocket(): void {
    if (this.ws) this.closeWebSocket();

    try {
      this.ws = new WebSocket(this.wsUrl, [`decibel`, this.bearerToken], {
        headers: {
          'Origin': ORIGIN_HEADER,
        },
      });

      this.ws.on('open', () => {
        safeLog.info('[Decibel] WS connected');
        this.wsReconnectAttempt = 0;

        // Subscribe to account channels
        this.wsSend({ method: 'subscribe', topic: `account_positions:${this.subaccountAddress}` });
        this.wsSend({ method: 'subscribe', topic: `account_overview:${this.subaccountAddress}` });
        this.wsSend({ method: 'subscribe', topic: `order_updates:${this.subaccountAddress}` });
        this.wsSend({ method: 'subscribe', topic: `user_trades:${this.subaccountAddress}` });

        // Heartbeat: respond to server pings
        this.wsHeartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, WS_HEARTBEAT_INTERVAL_MS);

        // Auto-reconnect before session expires
        this.wsSessionTimer = setTimeout(() => {
          safeLog.info('[Decibel] WS session approaching limit, reconnecting...');
          this.reconnectWebSocket();
        }, WS_MAX_SESSION_MS);
      });

      this.ws.on('message', (raw: WebSocket.Data) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleWsMessage(msg);
        } catch {
          // Non-JSON message (ping/pong frame)
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        safeLog.info(`[Decibel] WS closed: ${code} ${reason.toString()}`);
        this.clearWsTimers();
        if (!this.wsReconnecting && this.aptos) {
          // Unexpected close — exponential backoff reconnect
          const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, this.wsReconnectAttempt), WS_RECONNECT_MAX_MS);
          this.wsReconnectAttempt++;
          safeLog.info(`[Decibel] WS reconnect in ${(delay / 1000).toFixed(0)}s (attempt ${this.wsReconnectAttempt})`);
          setTimeout(() => this.reconnectWebSocket(), delay);
        }
      });

      this.ws.on('error', (err: Error) => {
        safeLog.error(`[Decibel] WS error: ${err.message}`);
        // 429 rate limit — 추가 백오프
        if (err.message.includes('429')) {
          this.wsReconnectAttempt = Math.max(this.wsReconnectAttempt, 2);
        }
      });

      this.ws.on('pong', () => {
        // Server responded to our ping — connection alive
      });
    } catch (err: any) {
      safeLog.error(`[Decibel] WS connection failed: ${err?.message ?? err}`);
    }
  }

  private handleWsMessage(msg: any): void {
    const topic = msg.topic ?? msg.channel ?? '';

    if (topic.startsWith('account_positions:')) {
      // Decibel WS: positions are in msg.positions (array)
      this.updatePositionCache(msg.positions ?? msg.data ?? msg.payload);
    }
    // order_updates and user_trades are logged but not cached
    if (topic.startsWith('order_updates:')) {
      // Decibel WS: order data is in msg.order (object)
      const d = msg.order ?? msg.data ?? msg.payload;
      if (d) {
        safeLog.info(`[Decibel] WS order update: ${d.status ?? 'unknown'} | id=${d.order_id ?? d.id ?? '?'}`);
      }
    }
    if (topic.startsWith('user_trades:')) {
      // Decibel WS: trades are in msg.trades (array)
      const trades = msg.trades ?? msg.data ?? msg.payload;
      const arr = Array.isArray(trades) ? trades : (trades ? [trades] : []);
      for (const d of arr) {
        safeLog.info(`[Decibel] WS trade: ${d.side ?? '?'} ${d.size ?? d.qty ?? '?'} @ ${d.price ?? '?'}`);
      }
    }
  }

  private updatePositionCache(data: any): void {
    if (!data) return;
    const positions = Array.isArray(data) ? data : [data];
    for (const pos of positions) {
      const market = pos.market ?? pos.symbol ?? pos.market_name ?? '';
      const sizeRaw = parseFloat(pos.size ?? pos.qty ?? '0');
      if (sizeRaw === 0) {
        this.positionCache.delete(market);
        continue;
      }
      const side: 'long' | 'short' = sizeRaw > 0 ? 'long' : 'short';
      this.positionCache.set(market, {
        exchange: 'decibel',
        side,
        size: Math.abs(sizeRaw).toString(),
        entryPrice: String(pos.entry_price ?? pos.avg_price ?? '0'),
        unrealizedPnl: String(pos.unrealized_pnl ?? pos.unrealized_funding ?? pos.upnl ?? '0'),
        leverage: Number(pos.user_leverage ?? pos.leverage ?? 1),
      });
    }
  }

  private reconnectWebSocket(): void {
    this.wsReconnecting = true;
    this.closeWebSocket();
    this.wsReconnecting = false;
    this.connectWebSocket();
  }

  private closeWebSocket(): void {
    this.clearWsTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private clearWsTimers(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
    if (this.wsSessionTimer) {
      clearTimeout(this.wsSessionTimer);
      this.wsSessionTimer = null;
    }
  }

  private wsSend(data: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
