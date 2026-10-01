import { collectResearch } from './research.js';
import { MODE_PROFILES } from './modes.js';
import { getBroker, BrokerError, fetchBrokerStatus } from './broker/index.js';
import { runPretradeMoA } from './pretrade.js';
import { runMixtureOfAgents, type MoARevisionHints } from './moa.js';
import { checkApproveConfirm } from './security.js';
import {
  evaluateRisk,
  persistRiskFlags,
  recordPaperTradeDay,
} from './risk.js';
import {
  loadState,
  saveState,
  uid,
  portfolioValue,
  type AppState,
  type DailyAlert,
  type TradeRecord,
} from './store.js';

function round(n: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

export class ExecuteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecuteError';
  }
}

function clampAmount(
  alert: DailyAlert,
  amount: number,
  state: AppState,
  sizeFactor: number,
): number {
  const mode = MODE_PROFILES[state.mode];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ExecuteError('투자/매도 금액은 0보다 커야 합니다.');
  }

  if (alert.side === 'buy') {
    const marks = Object.fromEntries(state.positions.map((p) => [p.symbol, p.avgPrice]));
    const equity = portfolioValue(state, marks);
    // 포지션 한도·예비금은 현금 우선 (총자산 기준 오버매수 방지)
    const cashBase = Math.max(state.cash, 1);
    const maxByMode = Math.min(
      (cashBase * mode.maxPositionPct) / 100,
      (equity * mode.maxPositionPct) / 100,
    );
    const minCashReserve = Math.min((equity * mode.minCashPct) / 100, state.cash * 0.35);
    const spendable = Math.max(0, state.cash - minCashReserve);
    const capped = round(
      Math.min(amount, alert.maxAmount, maxByMode, spendable, state.cash) * sizeFactor,
    );
    const minPx = alert.researchSummary?.price || alert.entry;
    if (minPx > 0 && capped < minPx) {
      throw new ExecuteError(
        `모드(${mode.label}) 한도/현금 부족으로 매수할 수 없습니다. 가용현금 약 ${round(spendable)}`,
      );
    }
    return capped;
  }

  const held = state.positions.find((p) => p.symbol === alert.symbol);
  const maxSell = (held?.shares ?? 0) * alert.entry;
  const capped = Math.min(amount, alert.maxAmount, maxSell) * sizeFactor;
  if (capped <= 0) throw new ExecuteError('매도할 보유 수량이 없습니다.');
  return round(capped);
}

function applyLocalBuy(
  state: AppState,
  symbol: string,
  name: string,
  currency: string,
  shares: number,
  price: number,
) {
  const cost = round(shares * price);
  if (cost > state.cash) throw new ExecuteError('현금이 부족합니다.');
  state.cash = round(state.cash - cost);
  const existing = state.positions.find((p) => p.symbol === symbol);
  if (existing) {
    const totalShares = existing.shares + shares;
    existing.avgPrice = round(
      (existing.avgPrice * existing.shares + price * shares) / totalShares,
    );
    existing.shares = totalShares;
    existing.updatedAt = new Date().toISOString();
    existing.name = name;
  } else {
    state.positions.push({
      symbol,
      name,
      shares,
      avgPrice: price,
      currency,
      updatedAt: new Date().toISOString(),
    });
  }
}

function applyLocalSell(state: AppState, symbol: string, shares: number, price: number) {
  const existing = state.positions.find((p) => p.symbol === symbol);
  if (!existing) throw new ExecuteError('보유 포지션이 없습니다.');
  const qty = Math.min(existing.shares, shares);
  const proceeds = round(qty * price);
  existing.shares -= qty;
  existing.updatedAt = new Date().toISOString();
  state.cash = round(state.cash + proceeds);
  if (existing.shares <= 0) {
    state.positions = state.positions.filter((p) => p.symbol !== symbol);
  }
  return qty;
}

/** 브로커 잔고/포지션을 로컬 상태에 반영 (읽기 전용 — LIVE 무장 불필요) */
export async function syncFromBroker(state: AppState = loadState()): Promise<AppState> {
  if (!state.preferBroker) return state;
  const broker = getBroker(false);
  if (!broker) return state;

  const account = await broker.getAccount();
  await new Promise((r) => setTimeout(r, 1200));
  const positions = await broker.getPositions();

  state.cash = round(account.cash);
  state.currency = account.currency || state.currency;
  if (!state.startingCash || state.currency !== account.currency) {
    state.startingCash = round(account.equity);
  }

  const now = new Date().toISOString();
  state.positions = positions.map((p) => ({
    symbol: p.symbol,
    name: p.name || p.symbol,
    shares: p.qty,
    avgPrice: p.avgEntryPrice,
    currency: p.currency || account.currency || 'KRW',
    updatedAt: now,
  }));

  saveState(state);
  return state;
}

/**
 * 사용자 confirm="허락" + 사전거래 MoA 통과 시에만 체결.
 * LIVE를 영구 무장하지 않고, 해당 주문에만 일회성으로 브로커 live 클라이언트를 사용.
 */
export async function actOnAlert(
  alertId: string,
  amount: number,
  action: 'execute' | 'skip' = 'execute',
  confirm = '',
): Promise<{ state: AppState; alert: DailyAlert; trade?: TradeRecord }> {
  let state = loadState();
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!alert) throw new ExecuteError('알림을 찾을 수 없습니다.');

  if (alert.status === 'executing') {
    throw new ExecuteError('이미 주문 처리 중입니다. 체결/거부 결과를 확인한 뒤 다시 시도하세요.');
  }
  if (alert.status !== 'pending') throw new ExecuteError('이미 처리된 알림입니다.');

  if (action === 'skip') {
    alert.status = 'skipped';
    alert.actedAt = new Date().toISOString();
    alert.executionNote = '사용자가 거절함';
    saveState(state);
    return { state, alert };
  }

  const conf = checkApproveConfirm(confirm);
  if (!conf.ok) throw new ExecuteError(conf.error);

  try {
    state = await syncFromBroker(state);
  } catch (err) {
    if (state.preferBroker && getBroker(false)) {
      throw new ExecuteError(
        `브로커 동기화 실패: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  // 리스크 게이트: 일손실 킬스위치 / 연속손실 → 신규 매수 차단 (매도는 허용)
  const risk0 = evaluateRisk(state);
  persistRiskFlags(state, risk0);
  saveState(state);
  if (alert.side === 'buy' && risk0.buysLocked) {
    throw new ExecuteError(risk0.lockReason || '리스크 잠금으로 매수할 수 없습니다.');
  }

  const research = await collectResearch(alert.symbol);
  // 괴리 검사용으로 제안 시점 entry는 유지하고, 현재가만 요약에 반영
  const proposedEntry = alert.entry;
  alert.researchSummary = {
    price: research.price,
    changePercent: research.changePercent,
    rsi14: research.rsi14,
    volumeRatio: research.volumeRatio,
    newsTitles: research.news.slice(0, 3).map((n) => n.title),
  };

  let buyingPower: number | null = null;
  try {
    const status = await fetchBrokerStatus(false);
    buyingPower = status.account?.buyingPower ?? null;
  } catch {
    buyingPower = state.cash;
  }

  const mode = MODE_PROFILES[state.mode];
  const heldShares =
    state.positions.find((p) => p.symbol === alert.symbol)?.shares ?? 0;

  let gate = runPretradeMoA({
    alert: { ...alert, entry: proposedEntry },
    research,
    mode,
    cash: state.cash,
    buyingPower,
  });

  // soft-deny면 중단하지 않고 분석 MoA를 다시 돌려 허용안을 만든다
  const reviseLog: string[] = [];
  for (let round = 0; !gate.allow && gate.revisable && round < 3; round++) {
    const hints: MoARevisionHints = {
      round: round + 1,
      reasons: gate.reviseReasons.length ? gate.reviseReasons : gate.blockReasons,
      forceSizeFactor: Math.max(0.25, gate.sizeFactor * 0.75),
      softenDevilVeto: true,
      relaxConfidenceFloor: 0.4,
    };
    const revised = runMixtureOfAgents(research, mode, heldShares, hints);
    reviseLog.push(
      `재분석#${round + 1}: ${revised.moaSummary} ← ${gate.reviseReasons.slice(0, 1).join('')}`,
    );

    if (!revised.passedGate || revised.side === 'hold') {
      // 같은 사이드 유지하며 금액만 축소 재시도
      alert.suggestedAmount = round(alert.suggestedAmount * Math.max(0.35, hints.forceSizeFactor ?? 0.5));
      alert.confidence = Math.max(alert.confidence ?? 0, hints.relaxConfidenceFloor ?? 0.4);
      alert.moaSummary = `${alert.moaSummary ?? ''} · ${reviseLog[reviseLog.length - 1]}`;
    } else {
      alert.side = revised.side;
      alert.score = revised.score;
      alert.entry = revised.entry;
      alert.target = revised.target;
      alert.stop = revised.stop;
      alert.confidence = revised.confidence;
      alert.thesis = `${alert.thesis} · ${revised.thesis}`;
      alert.devilSummary = revised.devilSummary;
      alert.devilChallenges = revised.devilAdvocate.map((c) => ({
        id: c.id,
        claim: c.claim,
        counter: c.counter,
        severity: c.severity,
      }));
      alert.moaSummary = revised.moaSummary;
      alert.suggestedAmount = round(
        Math.min(alert.maxAmount, alert.suggestedAmount) * revised.sizeFactor,
      );
      alert.howToInvest = `재분석 허용안 ×${revised.sizeFactor}: ${revised.moaSummary}`;
    }

    gate = runPretradeMoA({
      alert: { ...alert, entry: alert.entry },
      research,
      mode,
      cash: state.cash,
      buyingPower,
    });
  }

  if (!gate.allow) {
    // hard deny이거나 재분석으로도 못 푼 경우만 중단
    const note = reviseLog.length
      ? `${gate.summary} (재분석 ${reviseLog.length}회 시도)`
      : gate.summary;
    alert.executionNote = note;
    saveState(state);
    throw new ExecuteError(note);
  }

  if (reviseLog.length) {
    alert.executionNote = `재분석 후 허용: ${reviseLog.join(' | ')}`;
  }

  const requested = Number.isFinite(amount) && amount > 0 ? amount : alert.suggestedAmount;
  const fillAmount = clampAmount(alert, requested, state, gate.sizeFactor);
  const price = research.price;
  let shares = 0;

  if (alert.side === 'buy') {
    shares = Math.floor(fillAmount / price);
    if (shares <= 0) throw new ExecuteError('금액이 주가보다 작아 1주도 매수할 수 없습니다.');
  } else {
    const existing = state.positions.find((p) => p.symbol === alert.symbol);
    if (!existing) throw new ExecuteError('매도할 보유 수량이 없습니다.');
    shares = Math.min(existing.shares, Math.floor(fillAmount / price));
    if (shares <= 0 || fillAmount >= alert.maxAmount * 0.95 * gate.sizeFactor) {
      shares = existing.shares;
    }
  }

  // 멱등: executing 마킹 후 주문 (실패 시 pending 복구, 성공 불명 시 executing 유지)
  alert.status = 'executing';
  alert.executionNote = `사전거래 MoA 통과 · 주문 중… (${gate.summary})`;
  saveState(state);

  const risk = evaluateRisk(state, { [alert.symbol]: research.price });
  persistRiskFlags(state, risk);
  // FORCE_PAPER=1 이 아니면 토스 연동 시 실주문
  const wantsLive = Boolean(state.preferBroker && getBroker(false) && !risk.paperOnly);
  // 건별 일회성 live 클라이언트 — state.liveTradingArmed 는 건드리지 않음
  const broker = wantsLive ? getBroker(true) : null;
  let venue: TradeRecord['venue'] = 'local-paper';
  let brokerOrderId: string | undefined;
  let brokerStatus: string | undefined;
  let fillPrice = price;
  let note = '';

  try {
    if (broker) {
      const order = await broker.placeOrder({
        symbol: alert.symbol,
        side: alert.side,
        qty: shares,
        type: 'market',
        timeInForce: 'day',
        clientOrderId: `tai_${alert.id}`.slice(0, 36),
      });
      venue = broker.venue;
      brokerOrderId = order.id;
      brokerStatus = order.status;
      if (order.filledAvgPrice != null && order.filledAvgPrice > 0) {
        fillPrice = order.filledAvgPrice;
      }
      if (order.filledQty > 0) shares = order.filledQty;

      try {
        state = await syncFromBroker(state);
      } catch (syncErr) {
        // 주문은 나갔으므로 executed로 확정하고 동기화 경고만 남김
        console.error('[execute] post-order sync', syncErr);
      }
      note = `최종확인 · 토스 ${alert.side === 'buy' ? '매수' : '매도'} ${shares}주 (${order.status}) · ${gate.summary}`;
    } else {
      if (alert.side === 'buy') {
        applyLocalBuy(state, alert.symbol, research.name, research.currency, shares, fillPrice);
      } else {
        shares = applyLocalSell(state, alert.symbol, shares, fillPrice);
      }
      note = risk.paperOnly
        ? `최종확인 · FORCE_PAPER 모의 ${shares}주 · ${risk.message}`
        : `최종확인 · 로컬 모의 ${shares}주 · ${gate.summary}`;
    }
  } catch (err) {
    // 주문 API 실패 — 재시도 가능하도록 pending 복구
    const fresh = loadState();
    const a = fresh.alerts.find((x) => x.id === alertId);
    if (a && a.status === 'executing') {
      a.status = 'pending';
      a.executionNote = `주문 실패로 복구: ${err instanceof Error ? err.message : 'unknown'}`;
      saveState(fresh);
    }
    const msg = err instanceof BrokerError || err instanceof Error ? err.message : '주문 실패';
    throw new ExecuteError(`주문 실패: ${msg}`);
  }

  // reload alert ref after possible sync save
  state = loadState();
  const done = state.alerts.find((a) => a.id === alertId);
  if (!done) throw new ExecuteError('알림 상태를 잃었습니다.');

  const trade: TradeRecord = {
    id: uid('trade'),
    alertId: done.id,
    symbol: done.symbol,
    side: done.side,
    amount: round(shares * fillPrice),
    shares,
    price: fillPrice,
    mode: state.mode,
    reason: done.thesis,
    at: new Date().toISOString(),
    venue,
    brokerOrderId,
    brokerStatus,
  };

  done.status = 'executed';
  done.actedAt = trade.at;
  done.executionNote = note;
  done.entry = fillPrice;
  state.trades = [trade, ...state.trades].slice(0, 300);
  if (venue === 'local-paper') {
    recordPaperTradeDay(state, trade.at);
  }
  // LIVE 영구 무장 금지
  state.liveTradingArmed = false;
  const riskAfter = evaluateRisk(state, { [done.symbol]: fillPrice });
  persistRiskFlags(state, riskAfter);
  saveState(state);
  return { state, alert: done, trade };
}
