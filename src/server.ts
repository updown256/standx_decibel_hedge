// ============================================================
// Express Web Server for Hedge Bot GUI
// ============================================================

import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import { ethers } from 'ethers';
import { vault, safeLog } from './utils/security';
import { HedgeConfig } from './utils/types';
import { StandXClient } from './clients/standx';
import { DecibelClient } from './clients/decibel';
import { Hedger } from './core/hedger';
import { Tracker } from './core/tracker';

// ── State ─────────────────────────────────────────────────

let hedger: Hedger | null = null;
let tracker: Tracker | null = null;
let standxClient: StandXClient | null = null;
let decibelClient: DecibelClient | null = null;
let currentConfig: HedgeConfig | null = null;
let botRunning = false;
let lastError = '';
let recentLogs: string[] = [];

const MAX_LOGS = 100;
const MAX_RECENT_TRADES = 50;
const DEFAULT_PORT = 3847;

// ── Log capture ───────────────────────────────────────────
// Override safeLog methods to also capture messages for the GUI

const originalInfo = safeLog.info.bind(safeLog);
const originalWarn = safeLog.warn.bind(safeLog);
const originalError = safeLog.error.bind(safeLog);

function pushLog(level: string, msg: string): void {
  const ts = new Date().toISOString();
  recentLogs.push(`[${ts}] [${level}] ${msg}`);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs = recentLogs.slice(-MAX_LOGS);
  }
}

safeLog.info = (msg: string, ...args: unknown[]) => {
  pushLog('INFO', msg);
  originalInfo(msg, ...args);
};

safeLog.warn = (msg: string, ...args: unknown[]) => {
  pushLog('WARN', msg);
  originalWarn(msg, ...args);
};

safeLog.error = (msg: string, ...args: unknown[]) => {
  pushLog('ERROR', msg);
  originalError(msg, ...args);
};

// ── Express app ───────────────────────────────────────────

const app = express();

app.use(express.json());

// Static files: dist/public (cpx copies src/public → dist/public at build time)
const distPublic = path.join(__dirname, 'public');

app.use(express.static(distPublic));

// ── API Endpoints ─────────────────────────────────────────

app.post('/api/credentials', async (req: Request, res: Response) => {
  try {
    const {
      standx_evm_key,
      decibel_wallet_key,
      decibel_bearer,
    } = req.body;

    if (!standx_evm_key || !decibel_wallet_key || !decibel_bearer) {
      res.json({ success: false, error: 'Missing required credential fields' });
      return;
    }

    // Store in vault — address is auto-derived from private key
    vault.set('standx_evm_key', standx_evm_key);
    vault.set('decibel_wallet_key', decibel_wallet_key);
    vault.set('decibel_bearer', decibel_bearer);
    if (req.body.decibel_subaccount) {
      vault.set('decibel_subaccount', req.body.decibel_subaccount);
    }

    // Try to connect both clients
    standxClient = new StandXClient();
    decibelClient = new DecibelClient();

    await Promise.all([
      standxClient.connect(),
      decibelClient.connect(),
    ]);

    // Fetch balances to show in GUI
    let standxBalance = { available: '0', equity: '0' };
    let decibelBalance = { available: '0', equity: '0' };

    try { standxBalance = await standxClient.getBalance(); } catch (e: any) { safeLog.warn(`[Server] StandX balance error: ${e?.message}`); }
    try { decibelBalance = await decibelClient.getBalance(); } catch (e: any) { safeLog.warn(`[Server] Decibel balance error: ${e?.message}`); }

    // Get wallet addresses for display
    let standxAddr = '';
    try {
      const evmKey = vault.get('standx_evm_key');
      if (evmKey) standxAddr = new ethers.Wallet(evmKey).address;
    } catch { /* ok */ }
    const decibelAddr = decibelClient?.getWalletAddress?.() || vault.get('decibel_subaccount') || '';

    safeLog.info(`[Server] Connected | StandX: $${standxBalance.available} | Decibel: $${decibelBalance.available}`);
    res.json({
      success: true,
      addresses: {
        standx: standxAddr,
        decibel: decibelAddr,
      },
      balances: {
        standx: standxBalance,
        decibel: decibelBalance,
      },
    });
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    safeLog.error(`[Server] Credential/connect error: ${errorMsg}`);
    standxClient = null;
    decibelClient = null;
    res.json({ success: false, error: errorMsg });
  }
});

app.post('/api/config', (req: Request, res: Response) => {
  try {
    const config = req.body as Partial<HedgeConfig>;

    // Validate
    if (!config.orderSize || parseFloat(config.orderSize) <= 0) {
      res.json({ success: false, error: 'orderSize must be > 0' });
      return;
    }
    if (!config.leverage || config.leverage < 1 || config.leverage > 40) {
      res.json({ success: false, error: 'leverage must be 1-40' });
      return;
    }
    if (!config.rotationIntervalMs || config.rotationIntervalMs < 60000) {
      res.json({ success: false, error: 'rotationIntervalMs must be >= 60000 (1 min)' });
      return;
    }

    currentConfig = {
      symbol: config.symbol || 'BTC',
      orderSize: config.orderSize,
      leverage: config.leverage,
      priceTolerance: config.priceTolerance ?? 1,
      rotationMode: config.rotationMode || 'fixed',
      rotationIntervalMs: config.rotationIntervalMs,
      rotationRandomMinMs: config.rotationRandomMinMs ?? 60000,
      rotationRandomMaxMs: config.rotationRandomMaxMs ?? 300000,
      initialLongExchange: config.initialLongExchange || 'standx',
      walletMode: config.walletMode || 'shared',
    };

    safeLog.info(`[Server] Config saved: ${JSON.stringify({
      symbol: currentConfig.symbol,
      size: currentConfig.orderSize,
      leverage: currentConfig.leverage,
      rotation: currentConfig.rotationMode,
    })}`);

    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: err?.message ?? String(err) });
  }
});

app.post('/api/start', async (_req: Request, res: Response) => {
  try {
    if (botRunning) {
      res.json({ success: false, error: '봇이 이미 실행 중입니다.' });
      return;
    }
    if (!standxClient || !decibelClient) {
      res.json({ success: false, error: '거래소 미연결. 인증 정보를 먼저 입력하세요.' });
      return;
    }
    if (!currentConfig) {
      res.json({ success: false, error: '트레이딩 설정이 없습니다.' });
      return;
    }

    // Check balances before starting
    const errors: string[] = [];
    try {
      const sBal = await standxClient.getBalance();
      if (parseFloat(sBal.available) <= 0) errors.push('StandX 잔액이 0입니다.');
    } catch { errors.push('StandX 잔고 조회 실패.'); }

    try {
      const dBal = await decibelClient.getBalance();
      if (parseFloat(dBal.available) <= 0) errors.push('Decibel 잔액이 0입니다.');
    } catch { errors.push('Decibel 잔고 조회 실패.'); }

    if (errors.length > 0) {
      res.json({ success: false, error: errors.join(' ') });
      return;
    }

    tracker = new Tracker('./logs');
    hedger = new Hedger(standxClient, decibelClient, currentConfig, tracker);
    botRunning = true;
    lastError = '';

    // Start in background — don't await
    hedger.start().catch((err: any) => {
      lastError = err?.message ?? String(err);
      safeLog.error(`[Server] Hedger crashed: ${lastError}`);
      botRunning = false;
    });

    safeLog.info('[Server] Bot started');
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: err?.message ?? String(err) });
  }
});

app.post('/api/stop', async (_req: Request, res: Response) => {
  try {
    if (!botRunning || !hedger) {
      res.json({ success: false, error: 'Bot is not running' });
      return;
    }

    safeLog.info('[Server] Stopping bot...');
    await hedger.stop();
    botRunning = false;

    safeLog.info('[Server] Bot stopped');
    res.json({ success: true });
  } catch (err: any) {
    botRunning = false;
    res.json({ success: false, error: err?.message ?? String(err) });
  }
});

app.get('/api/status', async (_req: Request, res: Response) => {
  try {
    if (!botRunning || !tracker) {
      res.json({
        running: false,
        cycle: 0,
        connected: {
          standx: !!standxClient,
          decibel: !!decibelClient,
        },
        positions: { standx: null, decibel: null },
        summary: null,
        recentTrades: [],
        nextRotationMs: 0,
        logs: recentLogs.slice(-50),
        error: lastError || undefined,
      });
      return;
    }

    // Get positions if connected
    let standxPos = null;
    let decibelPos = null;
    try {
      if (standxClient && currentConfig) {
        standxPos = await standxClient.getPosition(currentConfig.symbol);
      }
    } catch { /* ignore */ }
    try {
      if (decibelClient && currentConfig) {
        decibelPos = await decibelClient.getPosition(currentConfig.symbol);
      }
    } catch { /* ignore */ }

    const summary = tracker.getSummary();
    const trades = tracker.getRecentTrades(MAX_RECENT_TRADES);

    res.json({
      running: botRunning,
      cycle: tracker.getTradeCount(),
      connected: {
        standx: !!standxClient,
        decibel: !!decibelClient,
      },
      positions: {
        standx: standxPos,
        decibel: decibelPos,
      },
      summary,
      recentTrades: trades,
      nextRotationMs: 0,
      logs: recentLogs.slice(-50),
      error: lastError || undefined,
    });
  } catch (err: any) {
    res.json({
      running: botRunning,
      cycle: 0,
      connected: { standx: false, decibel: false },
      positions: { standx: null, decibel: null },
      summary: null,
      recentTrades: [],
      nextRotationMs: 0,
      logs: recentLogs.slice(-50),
      error: err?.message ?? String(err),
    });
  }
});

app.get('/api/logs', (_req: Request, res: Response) => {
  res.json({ logs: recentLogs });
});

// ── Error handler ─────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  safeLog.error(`[Server] Unhandled error: ${err.message}`);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Server start ──────────────────────────────────────────

export async function startServer(): Promise<number> {
  const port = DEFAULT_PORT;

  const actualPort: number = await new Promise<number>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');

    server.on('listening', () => {
      safeLog.info(`[Server] Hedge Bot GUI running at http://localhost:${port}`);
      resolve(port);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        safeLog.warn(`[Server] Port ${port} in use, trying ${port + 1}...`);
        server.close();
        const altServer = app.listen(port + 1, '127.0.0.1');
        altServer.on('listening', () => {
          safeLog.info(`[Server] Hedge Bot GUI running at http://localhost:${port + 1}`);
          resolve(port + 1);
        });
        altServer.on('error', (altErr: NodeJS.ErrnoException) => {
          reject(new Error(`Cannot bind to port ${port} or ${port + 1}: ${altErr.message}`));
        });
        return;
      }
      reject(err);
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    safeLog.info('[Server] Shutting down...');
    if (botRunning && hedger) {
      await hedger.stop().catch(() => {});
      botRunning = false;
    }
    if (standxClient) await standxClient.disconnect().catch(() => {});
    if (decibelClient) await decibelClient.disconnect().catch(() => {});
    vault.wipe();
    safeLog.info('[Server] Goodbye.');
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return actualPort;
}
