import { collectResearch } from './research.js';
import { MODE_PROFILES } from './modes.js';
import { getBroker, BrokerError } from './broker/index.js';
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

function clampAmount(alert: DailyAlert, amount: number, state: AppState): number {
  const mode = MODE_PROFILES[state.mode];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ExecuteError('투자/매도 금액은 0보다 커야 합니다.');
  }

  if (alert.side === 'buy') {
    const marks = Object.fromEntries(state.positions.map((p) => [p.symbol, p.avgPrice]));
    const equity = portfolioValue(state, marks);
    const maxByMode = (equity * mode.maxPositionPct) / 100;
    const minCashReserve = (equity * mode.minCashPct) / 100;
    const spendable = Math.max(0, state.cash - minCashReserve);
    const capped = Math.min(amount, alert.maxAmount, maxByMode, spendable);
    if (capped < alert.entry) {
      throw new ExecuteError(
        `모드(${mode.label}) 한도/현금 부족으로 매수할 수 없습니다. 최대 약 ${round(capped)}`,
      );
    }
    return round(capped);
  }

  const held = state.positions.find((p) => p.symbol === alert.symbol);
  const maxSell = (held?.shares ?? 0) * alert.entry;
  const capped = Math.min(amount, alert.maxAmount, maxSell);
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

/** 브로커 잔고/포지션을 로컬 상태에 반영 */
export async function syncFromBroker(state: AppState = loadState()): Promise<AppState> {
  if (!state.preferBroker) return state;
  const broker = getBroker(state.liveTradingArmed);
  if (!broker) return state;

  const account = await broker.getAccount();
  // ASSET rate limit — wait before holdings refetch in getPositions
  await new Promise((r) => setTimeout(r, 1200));
  const positions = await broker.getPositions();

  state.cash = round(account.cash);
  state.currency = account.currency || state.currency;
  // 토스 실잔고 기준으로 시작자본도 맞춰 손익 표시가 어긋나지 않게 함
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
 * 사용자가 「허락」하면 AI 추천 금액으로 체결합니다.
 * 토스 연동 중이면 허락 = 그 건 실주문 승인입니다.
 */
export async function actOnAlert(
  alertId: string,
  amount: number,
  action: 'execute' | 'skip' = 'execute',
): Promise<{ state: AppState; alert: DailyAlert; trade?: TradeRecord }> {
  let state = loadState();
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!alert) throw new ExecuteError('알림을 찾을 수 없습니다.');
  if (alert.status !== 'pending') throw new ExecuteError('이미 처리된 알림입니다.');

  if (action === 'skip') {
    alert.status = 'skipped';
    alert.actedAt = new Date().toISOString();
    alert.executionNote = '사용자가 거절함';
    saveState(state);
    return { state, alert };
  }

  // refresh local cash/positions from broker before sizing
  try {
    state = await syncFromBroker(state);
  } catch (err) {
    if (state.preferBroker && getBroker(true)) {
      throw new ExecuteError(
        `브로커 동기화 실패: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  const research = await collectResearch(alert.symbol);
  alert.entry = research.price;
  alert.researchSummary = {
    price: research.price,
    changePercent: research.changePercent,
    rsi14: research.rsi14,
    volumeRatio: research.volumeRatio,
    newsTitles: research.news.slice(0, 3).map((n) => n.title),
  };

  // 금액 미입력/0이면 AI 추천 금액 사용
  const requested = Number.isFinite(amount) && amount > 0 ? amount : alert.suggestedAmount;
  const fillAmount = clampAmount(alert, requested, state);
  const price = research.price;
  let shares = 0;

  if (alert.side === 'buy') {
    shares = Math.floor(fillAmount / price);
    if (shares <= 0) throw new ExecuteError('금액이 주가보다 작아 1주도 매수할 수 없습니다.');
  } else {
    const existing = state.positions.find((p) => p.symbol === alert.symbol);
    if (!existing) throw new ExecuteError('매도할 보유 수량이 없습니다.');
    shares = Math.min(existing.shares, Math.floor(fillAmount / price));
    if (shares <= 0 || fillAmount >= alert.maxAmount * 0.95) shares = existing.shares;
  }

  // 허락 = 실주문 승인 (별도 LIVE 아밍 불필요)
  const brokerReady = Boolean(state.preferBroker && getBroker(true));
  if (brokerReady) {
    state.liveTradingArmed = true;
    state.liveArmedAt = state.liveArmedAt ?? new Date().toISOString();
  }

  const broker = brokerReady ? getBroker(true) : null;
  let venue: TradeRecord['venue'] = 'local-paper';
  let brokerOrderId: string | undefined;
  let brokerStatus: string | undefined;
  let fillPrice = price;
  let note = '';

  if (broker) {
    try {
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

      state = await syncFromBroker(state);
      note = `허락 승인 · 토스증권 ${alert.side === 'buy' ? '매수' : '매도'} ${shares}주 (${order.status})`;
    } catch (err) {
      const msg = err instanceof BrokerError || err instanceof Error ? err.message : '주문 실패';
      throw new ExecuteError(`토스 주문 실패: ${msg}`);
    }
  } else {
    if (alert.side === 'buy') {
      applyLocalBuy(state, alert.symbol, research.name, research.currency, shares, fillPrice);
    } else {
      shares = applyLocalSell(state, alert.symbol, shares, fillPrice);
    }
    note = `허락 승인 · 로컬 모의 ${shares}주 ${alert.side === 'buy' ? '매수' : '매도'}`;
  }

  const trade: TradeRecord = {
    id: uid('trade'),
    alertId: alert.id,
    symbol: alert.symbol,
    side: alert.side,
    amount: round(shares * fillPrice),
    shares,
    price: fillPrice,
    mode: state.mode,
    reason: alert.thesis,
    at: new Date().toISOString(),
    venue,
    brokerOrderId,
    brokerStatus,
  };

  alert.status = 'executed';
  alert.actedAt = trade.at;
  alert.executionNote = note;
  state.trades = [trade, ...state.trades].slice(0, 300);
  saveState(state);
  return { state, alert, trade };
}
