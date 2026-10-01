import { collectResearch } from './research.js';
import { MODE_PROFILES } from './modes.js';
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

/**
 * 사용자가 금액만 입력하면, 모드 규칙 + 현재가로 수량/체결을 시스템이 결정합니다.
 * MVP는 페이퍼 트레이딩(모의체결)입니다.
 */
export async function actOnAlert(
  alertId: string,
  amount: number,
  action: 'execute' | 'skip' = 'execute',
): Promise<{ state: AppState; alert: DailyAlert; trade?: TradeRecord }> {
  const state = loadState();
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!alert) throw new ExecuteError('알림을 찾을 수 없습니다.');
  if (alert.status !== 'pending') throw new ExecuteError('이미 처리된 알림입니다.');

  if (action === 'skip') {
    alert.status = 'skipped';
    alert.actedAt = new Date().toISOString();
    alert.executionNote = '사용자가 건너뜀';
    saveState(state);
    return { state, alert };
  }

  // refresh price before fill
  const research = await collectResearch(alert.symbol);
  alert.entry = research.price;
  alert.researchSummary = {
    price: research.price,
    changePercent: research.changePercent,
    rsi14: research.rsi14,
    volumeRatio: research.volumeRatio,
    newsTitles: research.news.slice(0, 3).map((n) => n.title),
  };

  const fillAmount = clampAmount(alert, amount, state);
  const price = research.price;
  let shares = 0;
  let note = '';

  if (alert.side === 'buy') {
    shares = Math.floor(fillAmount / price);
    if (shares <= 0) throw new ExecuteError('금액이 주가보다 작아 1주도 매수할 수 없습니다.');
    const cost = round(shares * price);
    if (cost > state.cash) throw new ExecuteError('현금이 부족합니다.');

    state.cash = round(state.cash - cost);
    const existing = state.positions.find((p) => p.symbol === alert.symbol);
    if (existing) {
      const totalShares = existing.shares + shares;
      existing.avgPrice = round(
        (existing.avgPrice * existing.shares + price * shares) / totalShares,
      );
      existing.shares = totalShares;
      existing.updatedAt = new Date().toISOString();
      existing.name = research.name;
    } else {
      state.positions.push({
        symbol: alert.symbol,
        name: research.name,
        shares,
        avgPrice: price,
        currency: research.currency,
        updatedAt: new Date().toISOString(),
      });
    }
    note = `${MODE_PROFILES[state.mode].label} 규칙으로 ${shares}주 매수 체결 (모의)`;
  } else {
    const existing = state.positions.find((p) => p.symbol === alert.symbol);
    if (!existing) throw new ExecuteError('보유 포지션이 없습니다.');
    shares = Math.min(existing.shares, Math.floor(fillAmount / price));
    if (shares <= 0) {
      // sell all remaining if amount covers fractional remainder intent
      shares = existing.shares;
    }
    // if user asked near max, sell all
    if (fillAmount >= alert.maxAmount * 0.95) shares = existing.shares;

    const proceeds = round(shares * price);
    existing.shares -= shares;
    existing.updatedAt = new Date().toISOString();
    state.cash = round(state.cash + proceeds);
    if (existing.shares <= 0) {
      state.positions = state.positions.filter((p) => p.symbol !== alert.symbol);
    }
    note = `${MODE_PROFILES[state.mode].label} 규칙으로 ${shares}주 매도 체결 (모의)`;
  }

  const trade: TradeRecord = {
    id: uid('trade'),
    alertId: alert.id,
    symbol: alert.symbol,
    side: alert.side,
    amount: round(shares * price),
    shares,
    price,
    mode: state.mode,
    reason: alert.thesis,
    at: new Date().toISOString(),
  };

  alert.status = 'executed';
  alert.actedAt = trade.at;
  alert.executionNote = note;
  state.trades = [trade, ...state.trades].slice(0, 300);
  saveState(state);
  return { state, alert, trade };
}
