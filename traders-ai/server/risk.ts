import { MODE_PROFILES } from './modes.js';
import {
  saveState,
  todayKey,
  portfolioValue,
  type AppState,
  type TradeRecord,
} from './store.js';

export function dailyLossLimitPct(state: AppState): number {
  const env = Number(process.env.DAILY_LOSS_LIMIT_PCT);
  if (Number.isFinite(env) && env > 0) return env;
  const mode = MODE_PROFILES[state.mode];
  return Math.min(5, Math.max(1, mode.riskPercent * 2));
}

export interface RiskStatus {
  /** FORCE_PAPER=1 일 때만 true (페이퍼 검증 기간은 없음) */
  paperOnly: boolean;
  liveUnlocked: boolean;
  canUnlockLive: boolean;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  dailyLossLimitPct: number;
  dayPnl: number;
  dayPnlPct: number;
  dayBaselineEquity: number | null;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  buysLocked: boolean;
  lockReason: string | null;
  message: string;
}

/** 최근 체결 중 손실 매도 연속 횟수 (직전 매수 평단 대비) */
export function countConsecutiveLossTrades(trades: TradeRecord[]): number {
  let n = 0;
  for (const t of trades) {
    if (t.side !== 'sell') {
      if (t.side === 'buy') break;
      continue;
    }
    const priorBuy = trades.find(
      (x) => x.symbol === t.symbol && x.side === 'buy' && x.at < t.at,
    );
    if (priorBuy && t.price < priorBuy.price) {
      n += 1;
    } else {
      break;
    }
  }
  return n;
}

export function ensureDayBaseline(state: AppState, marks: Record<string, number> = {}): AppState {
  const today = todayKey();
  const equity = portfolioValue(state, {
    ...Object.fromEntries(state.positions.map((p) => [p.symbol, p.avgPrice])),
    ...marks,
  });
  if (!state.dayBaseline || state.dayBaseline.date !== today) {
    state.dayBaseline = { date: today, equity };
    if (state.killSwitchActive && state.killSwitchReason?.includes('일 손실')) {
      state.killSwitchActive = false;
      state.killSwitchReason = null;
    }
  }
  return state;
}

export function evaluateRisk(state: AppState, marks: Record<string, number> = {}): RiskStatus {
  ensureDayBaseline(state, marks);
  const forcePaperEnv = String(process.env.FORCE_PAPER || '').toLowerCase() === '1';
  const paperOnly = forcePaperEnv;
  // 페이퍼 검증 제거: 기본 실주문 허용 (토스 키·최종확인·킬스위치만)
  const liveUnlocked = !forcePaperEnv;

  const limitPct = dailyLossLimitPct(state);
  const baseline = state.dayBaseline?.equity ?? null;
  const equity = portfolioValue(state, {
    ...Object.fromEntries(state.positions.map((p) => [p.symbol, p.avgPrice])),
    ...marks,
  });
  const dayPnl = baseline != null ? Math.round((equity - baseline) * 100) / 100 : 0;
  const dayPnlPct =
    baseline && baseline > 0 ? Math.round((dayPnl / baseline) * 10000) / 100 : 0;

  let killSwitchActive = Boolean(state.killSwitchActive);
  let killSwitchReason = state.killSwitchReason;

  if (baseline && baseline > 0 && dayPnlPct <= -limitPct) {
    killSwitchActive = true;
    killSwitchReason = `일 손실 한도 ${limitPct}% 도달 (오늘 ${dayPnlPct}%)`;
  }

  const maxConsecutiveLosses = Number(process.env.MAX_CONSECUTIVE_LOSSES || 3);
  const consecutiveLosses = countConsecutiveLossTrades(state.trades ?? []);
  const streakLock =
    Number.isFinite(maxConsecutiveLosses) &&
    maxConsecutiveLosses > 0 &&
    consecutiveLosses >= maxConsecutiveLosses;

  let buysLocked = killSwitchActive || streakLock;
  let lockReason: string | null = null;
  if (killSwitchActive) lockReason = killSwitchReason;
  else if (streakLock) {
    buysLocked = true;
    lockReason = `연속 손실 매도 ${consecutiveLosses}회 — 당일 신규 매수 잠금`;
  }

  const message = paperOnly
    ? 'FORCE_PAPER=1 · 모의만 가능'
    : killSwitchActive
      ? `실주문 가능 · ${killSwitchReason}`
      : buysLocked
        ? `실주문 가능 · ${lockReason}`
        : `실주문 가능 · 일손실 한도 ${limitPct}%`;

  return {
    paperOnly,
    liveUnlocked,
    canUnlockLive: false,
    killSwitchActive,
    killSwitchReason,
    dailyLossLimitPct: limitPct,
    dayPnl,
    dayPnlPct,
    dayBaselineEquity: baseline,
    consecutiveLosses,
    maxConsecutiveLosses: Number.isFinite(maxConsecutiveLosses) ? maxConsecutiveLosses : 3,
    buysLocked,
    lockReason,
    message,
  };
}

export function persistRiskFlags(state: AppState, risk: RiskStatus): AppState {
  state.killSwitchActive = risk.killSwitchActive;
  state.killSwitchReason = risk.killSwitchReason;
  // 페이퍼 검증 제거에 맞춰 실주문 해금 플래그도 항상 열어 둠
  if (
    !state.liveTradingUnlocked &&
    String(process.env.FORCE_PAPER || '').toLowerCase() !== '1'
  ) {
    state.liveTradingUnlocked = true;
    state.liveUnlockedAt = state.liveUnlockedAt ?? new Date().toISOString();
  }
  return state;
}

export function recordPaperTradeDay(state: AppState, atIso: string): void {
  // 호환용 no-op에 가깝게 유지 (통계만 쌓음)
  const day = atIso.slice(0, 10);
  const dates = [...new Set([...(state.paperTradeDates ?? []), day])].sort();
  state.paperTradeDates = dates;
  if (!state.paperStartedAt) state.paperStartedAt = day;
}

export function unlockLiveTrading(state: AppState, _confirm: string): AppState {
  state.liveTradingUnlocked = true;
  state.liveUnlockedAt = new Date().toISOString();
  saveState(state);
  return state;
}

export function lockLiveTrading(state: AppState): AppState {
  // 페이퍼 검증 UI용 API는 유지하되, 강제 모의는 FORCE_PAPER로만
  state.liveTradingUnlocked = false;
  state.liveUnlockedAt = null;
  saveState(state);
  return state;
}
