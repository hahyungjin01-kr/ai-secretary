import { collectResearch } from './research.js';
import { MODE_PROFILES } from './modes.js';
import { scoreSignals } from './signals.js';
import {
  loadState,
  saveState,
  todayKey,
  uid,
  portfolioValue,
  type AppState,
  type DailyAlert,
} from './store.js';

function round(n: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function suggestedBuyAmount(state: AppState, price: number, stop: number): {
  suggested: number;
  max: number;
} {
  const mode = MODE_PROFILES[state.mode];
  const marks = Object.fromEntries(state.positions.map((p) => [p.symbol, p.avgPrice]));
  const equity = portfolioValue(state, marks);
  const maxByPosition = (equity * mode.maxPositionPct) / 100;
  const riskBudget = (equity * mode.riskPercent) / 100;
  const riskPerShare = Math.max(0.01, price - stop);
  const sharesByRisk = Math.floor(riskBudget / riskPerShare);
  const byRisk = sharesByRisk * price;
  const minCashReserve = (equity * mode.minCashPct) / 100;
  const spendable = Math.max(0, state.cash - minCashReserve);
  const max = round(Math.min(maxByPosition, spendable, byRisk || spendable));
  const suggested = round(Math.min(max, max * (mode.id === 'profit' ? 0.85 : 0.65)));
  return { suggested: Math.max(0, suggested), max: Math.max(0, max) };
}

function suggestedSellAmount(heldShares: number, price: number, modeId: AppState['mode']): {
  suggested: number;
  max: number;
} {
  const max = round(heldShares * price);
  const pct = modeId === 'safe' ? 1 : modeId === 'balance' ? 0.6 : 0.4;
  return { suggested: round(max * pct), max };
}

export async function runDailyAnalysis(force = false): Promise<{
  state: AppState;
  created: DailyAlert[];
  scanned: number;
  skippedReason?: string;
}> {
  const state = loadState();
  const date = todayKey();
  const mode = MODE_PROFILES[state.mode];

  if (!force && state.lastDailyRunDate === date) {
    const pending = state.alerts.filter((a) => a.date === date && a.status === 'pending');
    return {
      state,
      created: pending,
      scanned: 0,
      skippedReason: '오늘은 이미 일일 분석을 실행했습니다. force로 재실행할 수 있습니다.',
    };
  }

  // expire yesterday pending
  for (const a of state.alerts) {
    if (a.status === 'pending' && a.date !== date) a.status = 'expired';
  }

  const created: DailyAlert[] = [];
  let buyCount = 0;

  for (const symbol of state.watchlist) {
    try {
      const research = await collectResearch(symbol);
      const held = state.positions.find((p) => p.symbol === research.symbol);
      const heldShares = held?.shares ?? 0;
      const decision = scoreSignals(research, mode, heldShares);

      if (decision.side === 'hold') continue;

      if (decision.side === 'buy') {
        if (buyCount >= mode.maxDailyBuyAlerts) continue;
        const { suggested, max } = suggestedBuyAmount(state, decision.entry, decision.stop);
        if (max < decision.entry) continue; // can't afford 1 share effectively
        buyCount += 1;
        const alert: DailyAlert = {
          id: uid('alert'),
          date,
          symbol: research.symbol,
          name: research.name,
          side: 'buy',
          score: decision.score,
          thesis: decision.thesis,
          entry: decision.entry,
          target: decision.target,
          stop: decision.stop,
          suggestedAmount: suggested,
          maxAmount: max,
          currency: research.currency,
          mode: state.mode,
          status: 'pending',
          researchSummary: {
            price: research.price,
            changePercent: research.changePercent,
            rsi14: research.rsi14,
            volumeRatio: research.volumeRatio,
            newsTitles: research.news.slice(0, 3).map((n) => n.title),
          },
          createdAt: new Date().toISOString(),
        };
        created.push(alert);
      } else if (decision.side === 'sell' && heldShares > 0) {
        const { suggested, max } = suggestedSellAmount(heldShares, decision.entry, state.mode);
        const alert: DailyAlert = {
          id: uid('alert'),
          date,
          symbol: research.symbol,
          name: research.name,
          side: 'sell',
          score: decision.score,
          thesis: decision.thesis,
          entry: decision.entry,
          target: decision.target,
          stop: decision.stop,
          suggestedAmount: suggested,
          maxAmount: max,
          currency: research.currency,
          mode: state.mode,
          status: 'pending',
          researchSummary: {
            price: research.price,
            changePercent: research.changePercent,
            rsi14: research.rsi14,
            volumeRatio: research.volumeRatio,
            newsTitles: research.news.slice(0, 3).map((n) => n.title),
          },
          createdAt: new Date().toISOString(),
        };
        created.push(alert);
      }
    } catch (err) {
      console.error('[daily]', symbol, err instanceof Error ? err.message : err);
    }
  }

  // sort: sells first, then buy by score
  created.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'sell' ? -1 : 1;
    return b.score - a.score;
  });

  state.alerts = [...created, ...state.alerts].slice(0, 200);
  state.lastDailyRunAt = new Date().toISOString();
  state.lastDailyRunDate = date;
  saveState(state);

  return { state, created, scanned: state.watchlist.length };
}
