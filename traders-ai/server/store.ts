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
  venue?: 'local-paper' | 'alpaca-paper' | 'alpaca-live';
  brokerOrderId?: string;
  brokerStatus?: string;
}

export type AlertSide = 'buy' | 'sell';
export type AlertStatus = 'pending' | 'executed' | 'skipped' | 'expired';

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
  watchlist: string[];
  cash: number;
  startingCash: number;
  currency: string;
  positions: Position[];
  alerts: DailyAlert[];
  trades: TradeRecord[];
  lastDailyRunAt: string | null;
  lastDailyRunDate: string | null;
  /** 실계좌(Alpaca Live) 주문 잠금 해제. 기본 false */
  liveTradingArmed: boolean;
  liveArmedAt: string | null;
  preferBroker: boolean;
}

const DEFAULT_STATE: AppState = {
  mode: 'balance',
  watchlist: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN'],
  cash: 10_000,
  startingCash: 10_000,
  currency: 'USD',
  positions: [],
  alerts: [],
  trades: [],
  lastDailyRunAt: null,
  lastDailyRunDate: null,
  liveTradingArmed: false,
  liveArmedAt: null,
  preferBroker: true,
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
