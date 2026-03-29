// ============================================================
// Fee & PnL Tracker
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { TradeRecord, PnLSummary } from '../utils/types';

export class Tracker {
  private trades: TradeRecord[] = [];
  private logDir: string;
  private unrealizedPnlCache: Record<'standx' | 'decibel', number> = { standx: 0, decibel: 0 };

  constructor(logDir: string = './logs') {
    this.logDir = logDir;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    this.appendCsv(trade);
  }

  getSummary(): PnLSummary {
    const summary: PnLSummary = {
      standx: { realizedPnl: 0, unrealizedPnl: 0, totalFees: 0, tradeCount: 0, volume: 0 },
      decibel: { realizedPnl: 0, unrealizedPnl: 0, totalFees: 0, tradeCount: 0, volume: 0 },
      netPnl: 0,
      totalFees: 0,
      totalVolume: 0,
    };

    for (const t of this.trades) {
      const ex = summary[t.exchange];
      ex.totalFees += parseFloat(t.fee);
      ex.tradeCount += 1;
      ex.volume += parseFloat(t.size) * parseFloat(t.price);
    }

    summary.standx.unrealizedPnl = this.unrealizedPnlCache.standx;
    summary.decibel.unrealizedPnl = this.unrealizedPnlCache.decibel;
    summary.totalFees = summary.standx.totalFees + summary.decibel.totalFees;
    summary.totalVolume = summary.standx.volume + summary.decibel.volume;
    summary.netPnl = summary.standx.realizedPnl + summary.decibel.realizedPnl
      + summary.standx.unrealizedPnl + summary.decibel.unrealizedPnl
      - summary.totalFees;

    return summary;
  }

  updateUnrealizedPnl(exchange: 'standx' | 'decibel', pnl: number): void {
    this.unrealizedPnlCache[exchange] = pnl;
  }

  printStatus(): void {
    const s = this.getSummary();
    const lines = [
      '',
      '╔══════════════════════════════════════════════════════╗',
      '║                   HEDGE BOT STATUS                  ║',
      '╠══════════════════════════════════════════════════════╣',
      `║  StandX  │ Trades: ${pad(s.standx.tradeCount, 5)} │ Vol: $${pad(s.standx.volume.toFixed(2), 12)} │ Fee: $${pad(s.standx.totalFees.toFixed(4), 8)} ║`,
      `║  Decibel │ Trades: ${pad(s.decibel.tradeCount, 5)} │ Vol: $${pad(s.decibel.volume.toFixed(2), 12)} │ Fee: $${pad(s.decibel.totalFees.toFixed(4), 8)} ║`,
      '╠══════════════════════════════════════════════════════╣',
      `║  Total Volume: $${pad(s.totalVolume.toFixed(2), 14)} │ Total Fees: $${pad(s.totalFees.toFixed(4), 10)} ��`,
      `║  Net P&L: $${pad(s.netPnl.toFixed(4), 15)}                              ║`,
      '╚══════════════════════════════════════════════════════╝',
      '',
    ];
    console.log(lines.join('\n'));
  }

  getTradeCount(): number {
    return this.trades.length;
  }

  getRecentTrades(limit: number = 50): TradeRecord[] {
    return this.trades.slice(-limit);
  }

  private appendCsv(trade: TradeRecord): void {
    const csvPath = path.join(this.logDir, `trades_${today()}.csv`);
    const exists = fs.existsSync(csvPath);

    const line = [
      new Date(trade.timestamp).toISOString(),
      trade.exchange,
      trade.action,
      trade.side,
      trade.size,
      trade.price,
      trade.fee,
      trade.orderId,
    ].join(',');

    if (!exists) {
      const header = 'timestamp,exchange,action,side,size,price,fee,orderId';
      fs.writeFileSync(csvPath, header + '\n' + line + '\n', { encoding: 'utf-8' });
    } else {
      fs.appendFileSync(csvPath, line + '\n', { encoding: 'utf-8' });
    }
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pad(val: string | number, width: number): string {
  const s = String(val);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
