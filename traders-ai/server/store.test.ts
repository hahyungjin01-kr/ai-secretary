import { describe, expect, it } from 'vitest';
import { recoverStaleExecuting, todayKey, type AppState } from './store.js';

function baseState(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'balance',
    watchlist: [],
    cash: 1000,
    startingCash: 1000,
    currency: 'KRW',
    positions: [],
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

describe('todayKey', () => {
  it('returns YYYY-MM-DD in KST shape', () => {
    expect(todayKey(new Date('2026-10-01T15:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 00:30 UTC = 09:30 KST same calendar day Oct 1
    expect(todayKey(new Date('2026-10-01T00:30:00Z'))).toBe('2026-10-01');
    // 15:30 UTC = 00:30 KST next day Oct 2
    expect(todayKey(new Date('2026-10-01T15:30:00Z'))).toBe('2026-10-02');
  });
});

describe('recoverStaleExecuting', () => {
  it('recovers all executing when maxAgeMs <= 0', () => {
    const state = baseState({
      alerts: [
        {
          id: 'a1',
          date: '2026-10-01',
          symbol: '005930',
          name: '삼성',
          side: 'buy',
          score: 60,
          thesis: 't',
          entry: 1,
          target: 2,
          stop: 0.5,
          suggestedAmount: 100,
          maxAmount: 100,
          currency: 'KRW',
          mode: 'balance',
          status: 'executing',
          researchSummary: {
            price: 1,
            changePercent: 0,
            rsi14: null,
            volumeRatio: null,
            newsTitles: [],
          },
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(recoverStaleExecuting(state, 0)).toBe(1);
    expect(state.alerts[0].status).toBe('pending');
  });
});
