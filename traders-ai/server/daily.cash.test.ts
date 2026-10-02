import { describe, expect, it } from 'vitest';
import { reconcilePendingAlerts, spendableCash } from './daily.js';
import type { AppState, DailyAlert } from './store.js';

function alert(over: Partial<DailyAlert>): DailyAlert {
  return {
    id: over.id ?? 'x',
    date: '2026-10-01',
    symbol: over.symbol ?? '005930',
    name: over.name ?? 't',
    side: over.side ?? 'buy',
    score: 60,
    thesis: 't',
    entry: over.entry ?? 1000,
    target: 1200,
    stop: 900,
    suggestedAmount: over.suggestedAmount ?? 500_000,
    maxAmount: over.maxAmount ?? 500_000,
    currency: 'KRW',
    mode: 'balance',
    status: over.status ?? 'pending',
    confidence: over.confidence ?? 0.6,
    researchSummary: {
      price: over.entry ?? 1000,
      changePercent: 0,
      rsi14: null,
      volumeRatio: null,
      newsTitles: [],
    },
    createdAt: new Date().toISOString(),
  };
}

function state(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'balance',
    watchlist: [],
    cash: 274_864,
    startingCash: 274_864,
    currency: 'KRW',
    positions: [
      {
        symbol: 'HOLD',
        name: 'h',
        shares: 10,
        avgPrice: 30000,
        currency: 'KRW',
        updatedAt: new Date().toISOString(),
      },
    ],
    alerts: [],
    trades: [],
    lastDailyRunAt: null,
    lastDailyRunDate: null,
    lastUniverseSummary: null,
    lastUniverseSymbols: [],
    lastUniverseAt: null,
    liveTradingArmed: false,
    liveArmedAt: null,
    preferBroker: true,
    liveTradingUnlocked: true,
    liveUnlockedAt: null,
    paperStartedAt: null,
    paperTradeDates: [],
    dayBaseline: null,
    killSwitchActive: false,
    killSwitchReason: null,
    ...over,
  };
}

describe('spendableCash', () => {
  it('stays within cash', () => {
    const s = state();
    const sp = spendableCash(s);
    expect(sp).toBeGreaterThan(0);
    expect(sp).toBeLessThanOrEqual(s.cash);
  });
});

describe('reconcilePendingAlerts', () => {
  it('expires buys when sells are pending', () => {
    const s = state({
      alerts: [
        alert({ id: 's1', side: 'sell', symbol: 'HOLD', suggestedAmount: 10000, status: 'pending' }),
        alert({ id: 'b1', side: 'buy', symbol: '225190', suggestedAmount: 200000, status: 'pending' }),
      ],
    });
    reconcilePendingAlerts(s);
    expect(s.alerts.find((a) => a.id === 'b1')?.status).toBe('expired');
    expect(s.alerts.find((a) => a.id === 's1')?.status).toBe('pending');
  });

  it('shrinks buys to fit cash budget', () => {
    const s = state({
      alerts: [
        alert({
          id: 'b1',
          side: 'buy',
          symbol: 'A',
          entry: 10000,
          suggestedAmount: 200000,
          confidence: 0.9,
        }),
        alert({
          id: 'b2',
          side: 'buy',
          symbol: 'B',
          entry: 10000,
          suggestedAmount: 200000,
          confidence: 0.5,
        }),
      ],
    });
    reconcilePendingAlerts(s);
    const pendingBuys = s.alerts.filter((a) => a.status === 'pending' && a.side === 'buy');
    const sum = pendingBuys.reduce((n, a) => n + a.suggestedAmount, 0);
    expect(sum).toBeLessThanOrEqual(s.cash + 1);
  });

  it('leaves queued alerts alone', () => {
    const s = state({
      alerts: [
        alert({ id: 'q1', side: 'buy', status: 'queued', suggestedAmount: 999999 }),
        alert({ id: 'b1', side: 'buy', status: 'pending', suggestedAmount: 50000, entry: 10000 }),
      ],
    });
    reconcilePendingAlerts(s);
    expect(s.alerts.find((a) => a.id === 'q1')?.status).toBe('queued');
    expect(s.alerts.find((a) => a.id === 'q1')?.suggestedAmount).toBe(999999);
  });
});
