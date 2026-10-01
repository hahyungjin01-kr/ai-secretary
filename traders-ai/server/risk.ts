import { MODE_PROFILES } from './modes.js';
import {
  saveState,
  todayKey,
  portfolioValue,
  type AppState,
  type TradeRecord,
} from './store.js';

/** 기본: 고유 페이퍼 거래일 10일 + 캘린더 14일 경과 후 실주문 해금 가능 */
export function requiredPaperDays(): number {
  const n = Number(process.env.MIN_PAPER_TRADE_DAYS || 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
}

export function requiredPaperCalendarDays(): number {
  const n = Number(process.env.MIN_PAPER_CALENDAR_DAYS || 14);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 14;
}

export function dailyLossLimitPct(state: AppState): number {
  const env = Number(process.env.DAILY_LOSS_LIMIT_PCT);
  if (Number.isFinite(env) && env > 0) return env;
  // 모드 1회 리스크의 ~2배, 상한 5%
  const mode = MODE_PROFILES[state.mode];
  return Math.min(5, Math.max(1, mode.riskPercent * 2));
}

export interface RiskStatus {
  paperOnly: boolean;
  liveUnlocked: boolean;
  paperTradeDays: number;
  paperTradeDaysRequired: number;
  paperCalendarDays: number;
  paperCalendarDaysRequired: number;
  paperStartedAt: string | null;
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

function uniqueSortedDates(dates: string[]): string[] {
  return [...new Set(dates.filter(Boolean))].sort();
}

function calendarDaysSince(isoDate: string | null): number {
  if (!isoDate) return 0;
  const start = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).getTime();
  const now = Date.now();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((now - start) / 86_400_000));
}

/** 최근 체결 중 손실 매도 연속 횟수 (직전 매수 평단 대비) */
export function countConsecutiveLossTrades(trades: TradeRecord[]): number {
  let n = 0;
  for (const t of trades) {
    if (t.side !== 'sell') {
      if (t.side === 'buy') break;
      continue;
    }
    // 매도만으로는 손익 부호를 확정하기 어려워, 같은 날 연속 매도 실패 프록시로
    // brokerStatus rejected 등을 쓰지 않는 한 — 금액 대비 작은 체결을 손실로 보지 않음
    // 대신: 직전 매수 평단을 trades 히스토리에서 추정
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
    // 날짜가 바뀌면 킬스위치는 사유가 일손실인 경우만 해제
    if (state.killSwitchActive && state.killSwitchReason?.includes('일 손실')) {
      state.killSwitchActive = false;
      state.killSwitchReason = null;
    }
  }
  return state;
}

export function evaluateRisk(state: AppState, marks: Record<string, number> = {}): RiskStatus {
  ensureDayBaseline(state, marks);
  const paperDates = uniqueSortedDates(state.paperTradeDates ?? []);
  const paperTradeDays = paperDates.length;
  const paperTradeDaysRequired = requiredPaperDays();
  const paperStartedAt = state.paperStartedAt;
  const paperCalendarDays = calendarDaysSince(paperStartedAt);
  const paperCalendarDaysRequired = requiredPaperCalendarDays();
  const liveUnlocked = Boolean(state.liveTradingUnlocked);
  const forcePaperEnv = String(process.env.FORCE_PAPER || '').toLowerCase() === '1';

  const canUnlockLive =
    !forcePaperEnv &&
    paperTradeDays >= paperTradeDaysRequired &&
    paperCalendarDays >= paperCalendarDaysRequired;

  const paperOnly = forcePaperEnv || !liveUnlocked;

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
    ? `페이퍼 모드: 거래일 ${paperTradeDays}/${paperTradeDaysRequired}, 경과일 ${paperCalendarDays}/${paperCalendarDaysRequired}` +
      (canUnlockLive ? ' · 실주문 해금 가능' : ' · 실주문 잠김(검증 기간)')
    : killSwitchActive
      ? `실주문 가능 · ${killSwitchReason}`
      : `실주문 가능 · 일손실 한도 ${limitPct}%`;

  return {
    paperOnly,
    liveUnlocked,
    paperTradeDays,
    paperTradeDaysRequired,
    paperCalendarDays,
    paperCalendarDaysRequired,
    paperStartedAt,
    canUnlockLive,
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

/** 상태 파일에 킬스위치/페이퍼 필드를 동기화 */
export function persistRiskFlags(state: AppState, risk: RiskStatus): AppState {
  state.killSwitchActive = risk.killSwitchActive;
  state.killSwitchReason = risk.killSwitchReason;
  if (!state.paperStartedAt && (state.paperTradeDates?.length ?? 0) > 0) {
    state.paperStartedAt = state.paperTradeDates[0] ?? todayKey();
  }
  return state;
}

export function recordPaperTradeDay(state: AppState, atIso: string): void {
  const day = atIso.slice(0, 10);
  const dates = uniqueSortedDates([...(state.paperTradeDates ?? []), day]);
  state.paperTradeDates = dates;
  if (!state.paperStartedAt) state.paperStartedAt = day;
}

export function unlockLiveTrading(state: AppState, confirm: string): AppState {
  const risk = evaluateRisk(state);
  if (!risk.canUnlockLive) {
    throw new Error(
      `페이퍼 검증 미달: 거래일 ${risk.paperTradeDays}/${risk.paperTradeDaysRequired}, 경과일 ${risk.paperCalendarDays}/${risk.paperCalendarDaysRequired}`,
    );
  }
  if (confirm.trim().toUpperCase() !== 'UNLOCK') {
    throw new Error('실주문 해금에는 confirm 값으로 UNLOCK 이 필요합니다.');
  }
  state.liveTradingUnlocked = true;
  state.liveUnlockedAt = new Date().toISOString();
  saveState(state);
  return state;
}

export function lockLiveTrading(state: AppState): AppState {
  state.liveTradingUnlocked = false;
  state.liveUnlockedAt = null;
  saveState(state);
  return state;
}
