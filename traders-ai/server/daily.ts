import { collectResearch } from './research.js';
import { MODE_PROFILES } from './modes.js';
import { runAnalysisUntilAllowable } from './moa.js';
import { buildAutonomousUniverse, buildPlaybook, type StrategyStyle } from './universe.js';
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

/** 실제 쓸 수 있는 현금 (총자산 아님) */
function spendableCash(state: AppState): number {
  const mode = MODE_PROFILES[state.mode];
  const marks = Object.fromEntries(state.positions.map((p) => [p.symbol, p.avgPrice]));
  const equity = portfolioValue(state, marks);
  const minCashReserve = (equity * mode.minCashPct) / 100;
  // 현금이 적으면 예비금도 현금 기준으로 완화 — 현금 초과 제안 방지
  const reserve = Math.min(minCashReserve, state.cash * 0.35);
  return Math.max(0, round(state.cash - reserve));
}

function suggestedBuyAmount(
  state: AppState,
  price: number,
  stop: number,
  sizeFactor: number,
  cashBudget: number,
): {
  suggested: number;
  max: number;
} {
  const mode = MODE_PROFILES[state.mode];
  if (cashBudget < price || price <= 0) return { suggested: 0, max: 0 };

  // 포지션/리스크 한도는 현금·예산 기준으로 잡음 (총자산 기준 오버 제안 방지)
  const cashBase = Math.max(state.cash, cashBudget);
  const maxByPosition = (cashBase * mode.maxPositionPct) / 100;
  const riskBudget = (cashBase * mode.riskPercent) / 100;
  const riskPerShare = Math.max(0.01, price - stop);
  const sharesByRisk = Math.floor(riskBudget / riskPerShare);
  const byRisk = sharesByRisk * price;

  const maxRaw = Math.min(maxByPosition, cashBudget, byRisk > 0 ? byRisk : cashBudget);
  const usePct = mode.id === 'safe' ? 0.8 : mode.id === 'balance' ? 0.9 : 0.95;
  let suggestedRaw = Math.min(maxRaw, maxRaw * usePct * sizeFactor);

  // 정수 주 단위로 현금 예산 안에 맞춤
  const maxShares = Math.floor(cashBudget / price);
  const wantShares = Math.floor(suggestedRaw / price);
  const shares = Math.max(0, Math.min(maxShares, wantShares));
  const suggested = round(shares * price);
  const max = round(Math.min(maxRaw, maxShares * price));
  return { suggested, max };
}

function suggestedSellAmount(
  heldShares: number,
  price: number,
  modeId: AppState['mode'],
  sizeFactor: number,
  confidence: number,
): {
  suggested: number;
  max: number;
} {
  const max = round(heldShares * price);
  // 중요 매도(신뢰도 높음)는 전량에 가깝게 — 매도 후 다음날 재제안
  let pct = modeId === 'safe' ? 1 : modeId === 'balance' ? 0.75 : 0.55;
  if (confidence >= 0.55) pct = 1;
  else if (confidence >= 0.4) pct = Math.max(pct, 0.85);
  const shares = Math.max(1, Math.floor(heldShares * pct * sizeFactor));
  const qty = Math.min(heldShares, shares);
  return { suggested: round(qty * price), max };
}

function expertSummary(votes: { expertName: string; side: string; score: number }[]): string {
  return votes.map((v) => `${v.expertName}:${v.side[0]}${Math.round(v.score)}`).join(' · ');
}

type DraftAlert = Omit<DailyAlert, 'id' | 'createdAt' | 'status'> & {
  status?: DailyAlert['status'];
};

function toAlert(draft: DraftAlert): DailyAlert {
  return {
    ...draft,
    id: uid('alert'),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

/**
 * 대기 중인 제안을 현금 정책에 맞게 정리:
 * - 매도 대기 있으면 매수 대기 만료
 * - 매수만 있으면 합계가 가용현금을 넘지 않게 축소/만료
 */
export function reconcilePendingAlerts(state: AppState): AppState {
  const pending = state.alerts.filter((a) => a.status === 'pending');
  const sells = pending.filter((a) => a.side === 'sell');
  const buys = pending.filter((a) => a.side === 'buy');

  if (sells.length > 0 && buys.length > 0) {
    for (const b of buys) {
      b.status = 'expired';
      b.actedAt = new Date().toISOString();
      b.executionNote = '보유 매도 우선 — 매수 제안은 매도 체결 다음날로 연기';
    }
    return state;
  }

  if (buys.length === 0) return state;

  let budget = spendableCash(state);
  const ordered = [...buys].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || b.score - a.score,
  );

  for (const alert of ordered) {
    const price = alert.researchSummary?.price || alert.entry;
    if (price <= 0 || budget < price) {
      alert.status = 'expired';
      alert.actedAt = new Date().toISOString();
      alert.executionNote = '가용 현금 부족으로 제안 만료';
      continue;
    }
    const maxShares = Math.floor(budget / price);
    const wantShares = Math.floor(alert.suggestedAmount / price);
    const shares = Math.max(0, Math.min(maxShares, wantShares));
    const next = round(shares * price);
    if (next < price) {
      alert.status = 'expired';
      alert.actedAt = new Date().toISOString();
      alert.executionNote = '가용 현금 부족으로 제안 만료';
      continue;
    }
    if (next < alert.suggestedAmount) {
      const note = `현금 한도에 맞춰 ${round(alert.suggestedAmount)} → ${next} 로 조정`;
      alert.executionNote = alert.executionNote ? `${alert.executionNote} / ${note}` : note;
    }
    alert.suggestedAmount = next;
    alert.maxAmount = Math.min(alert.maxAmount, round(maxShares * price));
    budget = round(Math.max(0, budget - next));
  }

  return state;
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

  const sellDrafts: DraftAlert[] = [];
  const buyDrafts: DraftAlert[] = [];

  for (const cand of candidates) {
    try {
      const research = await collectResearch(cand.symbol);
      const held = state.positions.find((p) => p.symbol === research.symbol);
      const heldShares = held?.shares ?? 0;

      const { decision, rounds, history } = runAnalysisUntilAllowable(
        research,
        mode,
        heldShares,
        3,
      );
      if (!decision.passedGate || decision.side === 'hold') {
        console.log(
          '[daily/moa-skip]',
          research.symbol,
          decision.moaSummary,
          `rounds=${rounds}`,
          history[history.length - 1],
        );
        continue;
      }

      const ex = expertSummary(decision.expertVotes);
      const reviseTag = rounds > 1 ? ` · 재분석 ${rounds}회 후 허용` : '';

      if (decision.side === 'sell' && heldShares > 0) {
        const { suggested, max } = suggestedSellAmount(
          heldShares,
          decision.entry,
          state.mode,
          decision.sizeFactor,
          decision.confidence,
        );
        if (suggested <= 0) continue;
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
        sellDrafts.push({
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
          strategy: playbook.strategy,
          howToInvest: `${playbook.howToInvest}${reviseTag} · 매도 체결 후 다음날 매수 재제안`,
          horizon: playbook.horizon,
          selectedBy: 'ai',
          selectionSource: cand.source,
          expertSummary: ex,
          moaSummary: `${decision.moaSummary}${reviseTag}`,
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
        });
      } else if (decision.side === 'buy') {
        if (decision.confidence < 0.32) continue;
        buyDrafts.push({
          date,
          symbol: research.symbol,
          name: research.name,
          side: 'buy',
          score: decision.score,
          thesis: `${cand.whySelected} / ${decision.thesis}`,
          entry: decision.entry,
          target: decision.target,
          stop: decision.stop,
          suggestedAmount: 0, // 예산 배분 시 채움
          maxAmount: 0,
          currency: research.currency,
          mode: state.mode,
          strategy: cand.style,
          howToInvest: '',
          horizon: undefined,
          selectedBy: 'ai',
          selectionSource: cand.source,
          expertSummary: ex,
          moaSummary: `${decision.moaSummary}${reviseTag}`,
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
          // sizing helpers carried via entry/stop/size in decision — stash on thesis temp? use fields
          // store sizeFactor in howToInvest placeholder then rebuild — better attach via closure below
        });
        // Attach sizing meta on the last draft
        const last = buyDrafts[buyDrafts.length - 1] as DraftAlert & {
          _sizeFactor?: number;
        };
        last._sizeFactor = decision.sizeFactor;
      }
    } catch (err) {
      console.error('[daily]', cand.symbol, err instanceof Error ? err.message : err);
    }
  }

  // 매도 우선: 보유 매도가 있으면 당일은 매도만 — 매수는 다음날(현금 확보 후)
  sellDrafts.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || b.score - a.score);

  const created: DailyAlert[] = [];
  let policyNote = '';

  if (sellDrafts.length > 0) {
    for (const d of sellDrafts) created.push(toAlert(d));
    policyNote = `보유 매도 ${sellDrafts.length}건 우선 · 매수는 매도 체결 다음날 제안 (현금 ${round(state.cash)})`;
    console.log('[daily]', policyNote);
  } else {
    // 매수만: 현금 예산 안에서 합계가 넘지 않게 순차 배분
    let budget = spendableCash(state);
    const cashNow = state.cash;
    buyDrafts.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || b.score - a.score);

    let buyCount = 0;
    for (const d of buyDrafts) {
      if (buyCount >= mode.maxDailyBuyAlerts) break;
      if (budget < d.entry) break;

      const sizeFactor =
        (d as DraftAlert & { _sizeFactor?: number })._sizeFactor ?? 1;
      const { suggested, max } = suggestedBuyAmount(
        state,
        d.entry,
        d.stop,
        sizeFactor,
        budget,
      );
      if (max < d.entry || suggested < d.entry) continue;

      const style = (d.strategy as StrategyStyle) || 'momentum';
      const playbook = buildPlaybook({
        side: 'buy',
        style,
        mode: state.mode,
        score: d.score,
        entry: d.entry,
        target: d.target,
        stop: d.stop,
        suggestedAmount: suggested,
        currency: d.currency,
      });

      d.suggestedAmount = suggested;
      d.maxAmount = max;
      d.strategy = playbook.strategy;
      d.howToInvest = `${playbook.howToInvest} (MoA 신뢰도 ${(((d.confidence ?? 0) * 100)).toFixed(0)}% · 현금한도 ${round(cashNow)} 내 배분)`;
      d.horizon = playbook.horizon;
      delete (d as DraftAlert & { _sizeFactor?: number })._sizeFactor;

      created.push(toAlert(d));
      budget = round(Math.max(0, budget - suggested));
      buyCount += 1;
    }

    const buySum = created.reduce((s, a) => s + a.suggestedAmount, 0);
    policyNote = `매수 ${created.length}건 · 합계 ${round(buySum)} / 가용현금 ${round(spendableCash(state))} (총현금 ${round(cashNow)})`;
    console.log('[daily]', policyNote);
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
  state.lastUniverseSummary = `${state.lastUniverseSummary} · ${policyNote}`;
  state.watchlist = state.lastUniverseSymbols.slice(0, 12);
  saveState(state);

  return {
    state,
    created,
    scanned: candidates.length,
    universeSummary: state.lastUniverseSummary ?? summary,
  };
}
