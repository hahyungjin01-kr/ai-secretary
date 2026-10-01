import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraderMode } from './modes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

export interface Position {
  symbol: string;
  name: string;
  shares: number;
  avgPrice: number;
  currency: string;
  updatedAt: string;
}

export interface TradeRecord {
  id: string;
  alertId: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  shares: number;
  price: number;
  mode: TraderMode;
  reason: string;
  at: string;
  venue?: 'local-paper' | 'toss';
  brokerOrderId?: string;
  brokerStatus?: string;
}

export type AlertSide = 'buy' | 'sell';
export type AlertStatus = 'pending' | 'executing' | 'executed' | 'skipped' | 'expired';

export interface DailyAlert {
  id: string;
  date: string;
  symbol: string;
  name: string;
  side: AlertSide;
  score: number;
  thesis: string;
  entry: number;
  target: number;
  stop: number;
  suggestedAmount: number;
  maxAmount: number;
  currency: string;
  mode: TraderMode;
  status: AlertStatus;
  strategy?: string;
  howToInvest?: string;
  horizon?: string;
  selectedBy?: 'ai' | 'user';
  selectionSource?: string;
  /** MoE 전문가 요약 */
  expertSummary?: string;
  /** MoA 파이프라인 요약 */
  moaSummary?: string;
  /** 악마의 변호인 요약 */
  devilSummary?: string;
  /** 0–1 신뢰도 */
  confidence?: number;
  devilChallenges?: { id: string; claim: string; counter: string; severity: string }[];
  researchSummary: {
    price: number;
    changePercent: number | null;
    rsi14: number | null;
    volumeRatio: number | null;
    newsTitles: string[];
  };
  createdAt: string;
  actedAt?: string;
  executionNote?: string;
}

export interface AppState {
  mode: TraderMode;
  /** AI가 마지막으로 스캔한 유니버스 스냅샷 */
  watchlist: string[];
  cash: number;
  startingCash: number;
  currency: string;
  positions: Position[];
  alerts: DailyAlert[];
  trades: TradeRecord[];
  lastDailyRunAt: string | null;
  lastDailyRunDate: string | null;
  lastUniverseSummary: string | null;
  lastUniverseSymbols: string[];
  lastUniverseAt: string | null;
  /** 토스 실주문 잠금 해제. 기본 false */
  liveTradingArmed: boolean;
  liveArmedAt: string | null;
  preferBroker: boolean;
  /** 호환 필드 (페이퍼 검증 제거됨 — 기본 true) */
  liveTradingUnlocked: boolean;
  liveUnlockedAt: string | null;
  paperStartedAt: string | null;
  paperTradeDates: string[];
  dayBaseline: { date: string; equity: number } | null;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
}

const DEFAULT_STATE: AppState = {
  mode: 'balance',
  watchlist: ['005930', '000660', '035420', 'AAPL', 'TSLA'],
  cash: 10_000_000,
  startingCash: 10_000_000,
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
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadState(): AppState {
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) {
    saveState(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as AppState;
    return {
      ...DEFAULT_STATE,
      ...raw,
      positions: raw.positions ?? [],
      alerts: raw.alerts ?? [],
      trades: raw.trades ?? [],
      watchlist: raw.watchlist?.length ? raw.watchlist : DEFAULT_STATE.watchlist,
      liveTradingArmed: Boolean(raw.liveTradingArmed),
      liveArmedAt: raw.liveArmedAt ?? null,
      preferBroker: raw.preferBroker !== false,
      lastUniverseSummary: raw.lastUniverseSummary ?? null,
      lastUniverseSymbols: raw.lastUniverseSymbols ?? [],
      lastUniverseAt: raw.lastUniverseAt ?? null,
      liveTradingUnlocked: raw.liveTradingUnlocked !== false,
      liveUnlockedAt: raw.liveUnlockedAt ?? null,
      paperStartedAt: raw.paperStartedAt ?? null,
      paperTradeDates: Array.isArray(raw.paperTradeDates) ? raw.paperTradeDates : [],
      dayBaseline: raw.dayBaseline ?? null,
      killSwitchActive: Boolean(raw.killSwitchActive),
      killSwitchReason: raw.killSwitchReason ?? null,
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(state: AppState): void {
  ensureDataDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function portfolioValue(state: AppState, marks: Record<string, number>): number {
  const equity = state.positions.reduce((sum, p) => {
    const mark = marks[p.symbol] ?? p.avgPrice;
    return sum + p.shares * mark;
  }, 0);
  return state.cash + equity;
}
