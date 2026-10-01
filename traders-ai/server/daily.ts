import { collectResearch } from './research.js';
import { MODE_PROFILES } from './modes.js';
import { runMixtureOfAgents } from './moa.js';
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

function suggestedBuyAmount(
  state: AppState,
  price: number,
  stop: number,
  sizeFactor: number,
): {
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
  const usePct = mode.id === 'safe' ? 0.8 : mode.id === 'balance' ? 0.9 : 0.95;
  const suggested = round(Math.min(max, max * usePct * sizeFactor));
  return { suggested: Math.max(0, suggested), max: Math.max(0, max) };
}

function suggestedSellAmount(
  heldShares: number,
  price: number,
  modeId: AppState['mode'],
  sizeFactor: number,
): {
  suggested: number;
  max: number;
} {
  const max = round(heldShares * price);
  const pct = modeId === 'safe' ? 1 : modeId === 'balance' ? 0.6 : 0.4;
  return { suggested: round(max * pct * sizeFactor), max };
}

function expertSummary(votes: { expertName: string; side: string; score: number }[]): string {
  return votes.map((v) => `${v.expertName}:${v.side[0]}${Math.round(v.score)}`).join(' · ');
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
      skippedReason: '오늘은 이미 AI 선정을 실행했습니다. 다시 맡기면 재분석합니다.',
    };
  }

  for (const a of state.alerts) {
    if (a.status === 'pending' && a.date !== date) a.status = 'expired';
  }

  const heldSymbols = state.positions.map((p) => p.symbol);
  const { candidates, summary } = await buildAutonomousUniverse(state.mode, heldSymbols);
  state.lastUniverseSummary = `${summary} · MoE+MoA+악마의변호인 점검`;
  state.lastUniverseSymbols = candidates.map((c) => c.symbol);
  state.lastUniverseAt = new Date().toISOString();

  const created: DailyAlert[] = [];
  let buyCount = 0;

  for (const cand of candidates) {
    try {
      const research = await collectResearch(cand.symbol);
      const held = state.positions.find((p) => p.symbol === research.symbol);
      const heldShares = held?.shares ?? 0;

      // MoE → MoA proposers → 악마의 변호인 → 리스크 → 집계
      const decision = runMixtureOfAgents(research, mode, heldShares);
      if (!decision.passedGate || decision.side === 'hold') {
        console.log(
          '[daily/moa-skip]',
          research.symbol,
          decision.moaSummary,
          `conf=${decision.confidence}`,
        );
        continue;
      }

      const ex = expertSummary(decision.expertVotes);

      if (decision.side === 'buy') {
        if (buyCount >= mode.maxDailyBuyAlerts) continue;
        const { suggested, max } = suggestedBuyAmount(
          state,
          decision.entry,
          decision.stop,
          decision.sizeFactor,
        );
        if (max < decision.entry || suggested < decision.entry) continue;

        // 신뢰도 너무 낮으면 제안 자체를 막음
        if (decision.confidence < 0.35) continue;

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
          howToInvest: `${playbook.howToInvest} (MoA 신뢰도 ${(decision.confidence * 100).toFixed(0)}%)`,
          horizon: playbook.horizon,
          selectedBy: 'ai',
          selectionSource: cand.source,
          expertSummary: ex,
          moaSummary: decision.moaSummary,
          devilSummary: decision.devilSummary,
          confidence: decision.confidence,
          devilChallenges: decision.devilAdvocate.map((c) => ({
            id: c.id,
            claim: c.claim,
            counter: c.counter,
            severity: c.severity,
          })),
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
        const { suggested, max } = suggestedSellAmount(
          heldShares,
          decision.entry,
          state.mode,
          decision.sizeFactor,
        );
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
          expertSummary: ex,
          moaSummary: decision.moaSummary,
          devilSummary: decision.devilSummary,
          confidence: decision.confidence,
          devilChallenges: decision.devilAdvocate.map((c) => ({
            id: c.id,
            claim: c.claim,
            counter: c.counter,
            severity: c.severity,
          })),
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
    const ca = a.confidence ?? 0;
    const cb = b.confidence ?? 0;
    if (cb !== ca) return cb - ca;
    return b.score - a.score;
  });

  state.alerts = [...created, ...state.alerts].slice(0, 200);
  state.lastDailyRunAt = new Date().toISOString();
  state.lastDailyRunDate = date;
  state.watchlist = state.lastUniverseSymbols.slice(0, 12);
  saveState(state);

  return {
    state,
    created,
    scanned: candidates.length,
    universeSummary: state.lastUniverseSummary ?? summary,
  };
}
