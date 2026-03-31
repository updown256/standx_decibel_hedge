import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import { vault, safeLog } from '../utils/security';
import { ExchangeClient, OrderResult, Position } from '../utils/types';

const AUTH_BASE = 'https://api.standx.com';
const TRADING_BASE = 'https://perps.standx.com';
const WS_STREAM = 'wss://perps.standx.com/ws-stream/v1';

const SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTC-USD',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = any;

function toExchangeSymbol(symbol: string): string {
  return SYMBOL_MAP[symbol.toUpperCase()] || `${symbol.toUpperCase()}-USD`;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

export class StandXClient implements ExchangeClient {
  name = 'standx' as const;
  private token: string = '';
  private ed25519KeyPair: nacl.SignKeyPair | null = null;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsPingTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string = uuidv4();

  private cachedPrice: { bid: string; ask: string; mid: string; ts: number } | null = null;
  private readonly PRICE_CACHE_MS = 500;

  async connect(): Promise<void> {
    this.ed25519KeyPair = nacl.sign.keyPair();
    const requestId = bs58.encode(this.ed25519KeyPair.publicKey);

    const evmKey = vault.get('standx_evm_key');
    if (!evmKey) throw new Error('StandX EVM key not found in vault');

    const wallet = new ethers.Wallet(evmKey);

    const prepareRes = await fetch(
      `${AUTH_BASE}/v1/offchain/prepare-signin?chain=bsc`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, address: wallet.address }),
      },
    );
    if (!prepareRes.ok) {
      const text = await prepareRes.text();
      throw new Error(`prepare-signin failed (${prepareRes.status}): ${text}`);
    }
    const prepareData: ApiResponse = await prepareRes.json();
    const signedData: string = prepareData.signedData ?? prepareData.data?.signedData;
    if (!signedData) throw new Error('No signedData in prepare-signin response');

    const jwtPayload = decodeJwtPayload(signedData);
    const message = jwtPayload.message as string;
    if (!message) throw new Error('No message in JWT payload');

    const signature = await wallet.signMessage(message);

    const loginRes = await fetch(
      `${AUTH_BASE}/v1/offchain/login?chain=bsc`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          signedData,
          signature,
        }),
      },
    );
    if (!loginRes.ok) {
      const text = await loginRes.text();
      throw new Error(`login failed (${loginRes.status}): ${text}`);
    }
    const loginData: ApiResponse = await loginRes.json();
    this.token = loginData.token ?? loginData.data?.token;
    if (!this.token) throw new Error('No token in login response');

    safeLog.info('[StandX] Authenticated successfully');
    this.connectWS();
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.token = '';
    this.ed25519KeyPair = null;
    safeLog.info('[StandX] Disconnected');
  }

  async getPrice(symbol: string): Promise<{ bid: string; ask: string; mid: string }> {
    const now = Date.now();
    if (this.cachedPrice && now - this.cachedPrice.ts < this.PRICE_CACHE_MS) {
      return { bid: this.cachedPrice.bid, ask: this.cachedPrice.ask, mid: this.cachedPrice.mid };
    }

    const exSym = toExchangeSymbol(symbol);
    const [priceData, depthData] = await Promise.all([
      this.publicGet('/api/query_symbol_price', { symbol: exSym }),
      this.publicGet('/api/query_depth_book', { symbol: exSym }),
    ]);

    let bid: string;
    let ask: string;

    const rawBids = depthData?.data?.bids ?? depthData?.bids ?? [];
    const rawAsks = depthData?.data?.asks ?? depthData?.asks ?? [];

    // depth_book bids/asks: [[price, qty], ...] 또는 [{price, qty}, ...]
    function extractPrice(entry: any): string {
      if (Array.isArray(entry)) return String(entry[0] ?? '0');
      return String(entry?.price ?? '0');
    }

    if (rawBids.length > 0 && rawAsks.length > 0) {
      bid = extractPrice(rawBids[0]);
      ask = extractPrice(rawAsks[0]);
    } else {
      const lastPrice: string = priceData?.data?.last_price ?? priceData?.last_price ?? '0';
      bid = lastPrice;
      ask = lastPrice;
    }

    // NaN 방지
    if (!bid || bid === '0' || isNaN(parseFloat(bid))) {
      const fallback = priceData?.data?.mark_price ?? priceData?.mark_price ?? priceData?.data?.last_price ?? priceData?.last_price ?? '0';
      bid = String(fallback);
      ask = String(fallback);
    }

    const midNum = (parseFloat(bid) + parseFloat(ask)) / 2;
    const mid = midNum.toFixed(2);

    this.cachedPrice = { bid, ask, mid, ts: now };
    return { bid, ask, mid };
  }

  async placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    size: string;
    price: string;
    reduceOnly?: boolean;
  }): Promise<OrderResult> {
    const exSym = toExchangeSymbol(params.symbol);
    const clOrdId = uuidv4();
    const roundedPrice = Math.round(parseFloat(params.price)).toString();

    const body = {
      symbol: exSym,
      side: params.side,
      order_type: 'limit',
      qty: params.size,
      price: roundedPrice,
      time_in_force: 'alo',
      reduce_only: params.reduceOnly ?? false,
      cl_ord_id: clOrdId,
    };

    const res = await this.signedPost('/api/new_order', body);

    if (res?.error || (res?.code !== undefined && Number(res.code) !== 0)) {
      return {
        success: false,
        orderId: '',
        price: roundedPrice,
        size: params.size,
        fee: '0',
        error: String(res?.error ?? res?.message ?? `Error code: ${res?.code}`),
      };
    }

    const orderId: string = res?.order_id ?? res?.data?.order_id ?? clOrdId;
    const makerFee = parseFloat(params.size) * parseFloat(roundedPrice) * 0.0001;

    return {
      success: true,
      orderId: String(orderId),
      price: roundedPrice,
      size: params.size,
      fee: makerFee.toFixed(6),
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const body = { order_id: orderId };
    const res = await this.signedPost('/api/cancel_order', body);

    if (res?.error || (res?.code && Number(res.code) >= 400)) {
      safeLog.warn(`[StandX] Cancel failed for ${orderId}: ${res?.error ?? res?.message}`);
      return false;
    }
    return true;
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const exSym = toExchangeSymbol(symbol);
    const res = await this.authGet('/api/query_positions', { symbol: exSym });

    const positions: ApiResponse[] =
      res?.positions ?? res?.data?.positions ?? res?.data ?? [];

    if (!Array.isArray(positions)) return null;

    const pos = positions.find(
      (p: ApiResponse) => p.symbol === exSym && parseFloat(String(p.qty ?? p.size ?? '0')) !== 0,
    );

    if (!pos) return null;

    const qty = parseFloat(String(pos.qty ?? pos.size ?? '0'));
    const side: 'long' | 'short' = qty > 0 ? 'long' : 'short';

    return {
      exchange: 'standx',
      side,
      size: Math.abs(qty).toString(),
      entryPrice: String(pos.entry_price ?? pos.avg_price ?? '0'),
      unrealizedPnl: String(pos.unrealized_pnl ?? pos.upnl ?? '0'),
      leverage: Number(pos.leverage ?? 1),
    };
  }

  async getBalance(): Promise<{ available: string; equity: string }> {
    const res = await this.authGet('/api/query_balance', {});
    safeLog.info(`[StandX] Balance raw: ${JSON.stringify(res).slice(0, 500)}`);
    const data: ApiResponse = res?.data ?? res;

    return {
      available: String(data?.cross_available ?? data?.available ?? '0'),
      equity: String(data?.equity ?? '0'),
    };
  }

  async changeLeverage(symbol: string, leverage: number): Promise<void> {
    const exSym = toExchangeSymbol(symbol);
    await this.signedPost('/api/change_leverage', { symbol: exSym, leverage });
  }

  // ── Private: HTTP helpers ──────────────────────────────────

  private async publicGet(path: string, params: Record<string, string>): Promise<ApiResponse> {
    const qs = new URLSearchParams(params).toString();
    const url = `${TRADING_BASE}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  private async authGet(path: string, params: Record<string, string>): Promise<ApiResponse> {
    this.ensureAuth();
    const qs = new URLSearchParams(params).toString();
    const url = `${TRADING_BASE}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AUTH GET ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  private async signedPost(path: string, body: Record<string, unknown>): Promise<ApiResponse> {
    this.ensureAuth();
    if (!this.ed25519KeyPair) throw new Error('ed25519 keypair not initialized');

    const requestId = uuidv4();
    const timestamp = Date.now();
    const payload = JSON.stringify(body);

    const signatureInput = `v1,${requestId},${timestamp},${payload}`;
    const signatureBytes = nacl.sign.detached(
      new TextEncoder().encode(signatureInput),
      this.ed25519KeyPair.secretKey,
    );
    const signatureB64 = Buffer.from(signatureBytes).toString('base64');

    const res = await fetch(`${TRADING_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        'x-request-sign-version': 'v1',
        'x-request-id': requestId,
        'x-request-timestamp': String(timestamp),
        'x-request-signature': signatureB64,
        'x-session-id': this.sessionId,
      },
      body: payload,
    });

    if (!res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`POST ${path} failed (${res.status}): ${text}`);
      }
    }
    return res.json();
  }

  private ensureAuth(): void {
    if (!this.token) throw new Error('StandX not authenticated. Call connect() first.');
  }

  // ── Private: WebSocket ─────────────────────────────────────

  private disconnected = false;

  private connectWS(): void {
    if (this.ws || this.disconnected) return;

    this.ws = new WebSocket(WS_STREAM);

    this.ws.on('open', () => {
      safeLog.info('[StandX] WS connected');
      this.wsAuth();
      this.subscribePriceStream('BTC-USD');
      this.startPing();
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleWsMessage(msg);
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      safeLog.warn('[StandX] WS closed, reconnecting in 5s');
      this.cleanupWs();
      this.wsReconnectTimer = setTimeout(() => this.connectWS(), 5000);
    });

    this.ws.on('error', (err: Error) => {
      safeLog.error(`[StandX] WS error: ${err.message}`);
    });
  }

  private wsAuth(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        auth: {
          token: this.token,
          streams: [{ channel: 'order' }, { channel: 'position' }],
        },
      }),
    );
  }

  private subscribePriceStream(symbol: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        subscribe: { channel: 'price', symbol },
      }),
    );
    this.ws.send(
      JSON.stringify({
        subscribe: { channel: 'depth_book', symbol },
      }),
    );
  }

  private handleWsMessage(msg: ApiResponse): void {
    const channel = msg.channel as string | undefined;
    if (!channel) return;

    if (channel === 'price' || channel === 'depth_book') {
      this.updateCachedPrice(msg);
    }
  }

  private updateCachedPrice(msg: ApiResponse): void {
    const data = msg.data ?? msg;

    if (msg.channel === 'depth_book') {
      const rawBids = data.bids as Array<any> | undefined;
      const rawAsks = data.asks as Array<any> | undefined;
      if (rawBids?.length && rawAsks?.length) {
        // Extract price from [price, qty] or {price, qty} format
        const getPrice = (entry: any): number => {
          if (Array.isArray(entry)) return parseFloat(String(entry[0] ?? '0'));
          return parseFloat(String(entry?.price ?? '0'));
        };
        // Sort bids descending (highest first), asks ascending (lowest first)
        const sortedBids = [...rawBids].sort((a, b) => getPrice(b) - getPrice(a));
        const sortedAsks = [...rawAsks].sort((a, b) => getPrice(a) - getPrice(b));
        const bid = String(getPrice(sortedBids[0]));
        const ask = String(getPrice(sortedAsks[0]));
        const mid = ((parseFloat(bid) + parseFloat(ask)) / 2).toFixed(2);
        this.cachedPrice = { bid, ask, mid, ts: Date.now() };
      }
    } else if (msg.channel === 'price') {
      const price = String(data.last_price ?? data.price ?? '');
      if (price && price !== '0') {
        const existing = this.cachedPrice;
        if (existing) {
          this.cachedPrice = { ...existing, mid: price, ts: Date.now() };
        } else {
          this.cachedPrice = { bid: price, ask: price, mid: price, ts: Date.now() };
        }
      }
    }
  }

  private startPing(): void {
    if (this.wsPingTimer) clearInterval(this.wsPingTimer);
    this.wsPingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 10_000);
  }

  private cleanupWs(): void {
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
  }
}
