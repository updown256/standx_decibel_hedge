// ============================================================
// Type definitions for the hedge bot
// ============================================================

export interface HedgeConfig {
  // Trading parameters
  symbol: string;           // e.g. "BTC" — mapped to each exchange's format
  orderSize: string;        // e.g. "0.001" — decimal string
  leverage: number;         // e.g. 5
  priceTolerance: number;   // Safety valve %. Skip only if mid price diff exceeds this. 0=disabled. Default 5%.

  // Rotation settings
  rotationMode: 'fixed' | 'random';
  rotationIntervalMs: number;      // fixed interval in ms (min 60000 = 1 min)
  rotationRandomMinMs: number;     // random mode min (ms)
  rotationRandomMaxMs: number;     // random mode max (ms)

  // Exchange assignment (which side starts where)
  initialLongExchange: 'standx' | 'decibel';

  // Wallet config
  walletMode: 'shared' | 'separate';  // same or different wallets
}

export interface ExchangeCredentials {
  // StandX
  standx: {
    evmPrivateKey: string;    // EVM wallet private key (BSC)
  };
  // Decibel
  decibel: {
    apiWalletPrivateKey: string;   // Aptos API wallet private key
    apiWalletAddress: string;       // Aptos API wallet address
    bearerToken: string;            // Geomi bearer token
    subaccountAddress?: string;     // Trading account address
  };
}

export interface Position {
  exchange: 'standx' | 'decibel';
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  leverage: number;
}

export interface TradeRecord {
  timestamp: number;
  exchange: 'standx' | 'decibel';
  action: 'open' | 'close';
  side: 'long' | 'short';
  size: string;
  price: string;
  fee: string;
  orderId: string;
}

export interface PnLSummary {
  standx: {
    realizedPnl: number;
    unrealizedPnl: number;
    totalFees: number;
    tradeCount: number;
    volume: number;
  };
  decibel: {
    realizedPnl: number;
    unrealizedPnl: number;
    totalFees: number;
    tradeCount: number;
    volume: number;
  };
  netPnl: number;
  totalFees: number;
  totalVolume: number;
}

export interface OrderResult {
  success: boolean;
  orderId: string;
  price: string;
  size: string;
  fee: string;
  error?: string;
}

export interface ExchangeClient {
  name: 'standx' | 'decibel';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getPrice(symbol: string): Promise<{ bid: string; ask: string; mid: string }>;
  placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    size: string;
    price: string;
    reduceOnly?: boolean;
  }): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<boolean>;
  getPosition(symbol: string): Promise<Position | null>;
  getBalance(): Promise<{ available: string; equity: string }>;
}
