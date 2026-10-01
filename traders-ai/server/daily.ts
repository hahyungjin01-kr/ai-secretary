import { collectResearch } from './research.js';
import { MODE_PROFILES } from './modes.js';
import { scoreSignals } from './signals.js';
import { buildAutonomousUniverse, buildPlaybook } from './universe.js';
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
  universeSummary?: string;
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
      universeSummary: state.lastUniverseSummary ?? undefined,
      skippedReason: '오늘은 이미 AI 일일 선정을 실행했습니다. force로 재실행할 수 있습니다.',
    };
  }

  for (const a of state.alerts) {
    if (a.status === 'pending' && a.date !== date) a.status = 'expired';
  }

  const heldSymbols = state.positions.map((p) => p.symbol);
  const { candidates, summary } = await buildAutonomousUniverse(state.mode, heldSymbols);
  state.lastUniverseSummary = summary;
  state.lastUniverseSymbols = candidates.map((c) => c.symbol);
  state.lastUniverseAt = new Date().toISOString();

  const created: DailyAlert[] = [];
  let buyCount = 0;

  for (const cand of candidates) {
    try {
      const research = await collectResearch(cand.symbol);
      const held = state.positions.find((p) => p.symbol === research.symbol);
      const heldShares = held?.shares ?? 0;
      const decision = scoreSignals(research, mode, heldShares);
      if (decision.side === 'hold') continue;

      if (decision.side === 'buy') {
        if (buyCount >= mode.maxDailyBuyAlerts) continue;
        const { suggested, max } = suggestedBuyAmount(state, decision.entry, decision.stop);
        if (max < decision.entry) continue;
        const playbook = buildPlaybook({
          side: 'buy',
          style: cand.style,
          mode: state.mode,
          score: decision.score,
          entry: decision.entry,
          target: decision.target,
          stop: decision.stop,
          suggestedAmount: suggested,
          currency: research.currency,
        });
        buyCount += 1;
        created.push({
          id: uid('alert'),
          date,
          symbol: research.symbol,
          name: research.name,
          side: 'buy',
          score: decision.score,
          thesis: `${cand.whySelected} / ${decision.thesis}`,
          entry: decision.entry,
          target: decision.target,
          stop: decision.stop,
          suggestedAmount: suggested,
          maxAmount: max,
          currency: research.currency,
          mode: state.mode,
          status: 'pending',
          strategy: playbook.strategy,
          howToInvest: playbook.howToInvest,
          horizon: playbook.horizon,
          selectedBy: 'ai',
          selectionSource: cand.source,
          researchSummary: {
            price: research.price,
            changePercent: research.changePercent,
            rsi14: research.rsi14,
            volumeRatio: research.volumeRatio,
            newsTitles: research.news.slice(0, 3).map((n) => n.title),
          },
          createdAt: new Date().toISOString(),
        });
      } else if (decision.side === 'sell' && heldShares > 0) {
        const { suggested, max } = suggestedSellAmount(heldShares, decision.entry, state.mode);
        const playbook = buildPlaybook({
          side: 'sell',
          style: 'trim',
          mode: state.mode,
          score: decision.score,
          entry: decision.entry,
          target: decision.target,
          stop: decision.stop,
          suggestedAmount: suggested,
          currency: research.currency,
        });
        created.push({
          id: uid('alert'),
          date,
          symbol: research.symbol,
          name: research.name,
          side: 'sell',
          score: decision.score,
          thesis: `${cand.whySelected} / ${decision.thesis}`,
          entry: decision.entry,
          target: decision.target,
          stop: decision.stop,
          suggestedAmount: suggested,
          maxAmount: max,
          currency: research.currency,
          mode: state.mode,
          status: 'pending',
          strategy: playbook.strategy,
          howToInvest: playbook.howToInvest,
          horizon: playbook.horizon,
          selectedBy: 'ai',
          selectionSource: cand.source,
          researchSummary: {
            price: research.price,
            changePercent: research.changePercent,
            rsi14: research.rsi14,
            volumeRatio: research.volumeRatio,
            newsTitles: research.news.slice(0, 3).map((n) => n.title),
          },
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('[daily]', cand.symbol, err instanceof Error ? err.message : err);
    }
  }

  created.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'sell' ? -1 : 1;
    return b.score - a.score;
  });

  state.alerts = [...created, ...state.alerts].slice(0, 200);
  state.lastDailyRunAt = new Date().toISOString();
  state.lastDailyRunDate = date;
  // watchlist becomes AI's latest universe snapshot (not user-managed)
  state.watchlist = state.lastUniverseSymbols.slice(0, 12);
  saveState(state);

  return {
    state,
    created,
    scanned: candidates.length,
    universeSummary: summary,
  };
}
