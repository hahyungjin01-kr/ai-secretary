export type TraderMode = 'safe' | 'balance' | 'profit';

export interface ModeProfile {
  id: TraderMode;
  label: string;
  description: string;
  riskPercent: number;
  maxPositionPct: number;
  minRewardRisk: number;
  minBuyScore: number;
  minSellScore: number;
  maxDailyBuyAlerts: number;
  minCashPct: number;
}

export interface PositionView {
  symbol: string;
  name: string;
  shares: number;
  avgPrice: number;
  currency: string;
  updatedAt: string;
  mark: number;
  marketValue: number;
  pnl: number;
  pnlPct: number;
}

export interface DailyAlert {
  id: string;
  date: string;
  symbol: string;
  name: string;
  side: 'buy' | 'sell';
  score: number;
  thesis: string;
  entry: number;
  target: number;
  stop: number;
  suggestedAmount: number;
  maxAmount: number;
  currency: string;
  mode: TraderMode;
  status: 'pending' | 'executed' | 'skipped' | 'expired';
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

export interface BrokerAccount {
  id: string;
  status: string;
  currency: string;
  cash: number;
  equity: number;
  buyingPower: number;
  portfolioValue: number;
  patternDayTrader: boolean;
  tradingBlocked: boolean;
  accountBlocked: boolean;
}

export interface BrokerStatus {
  configured: boolean;
  connected: boolean;
  venue: 'local-paper' | 'alpaca-paper' | 'alpaca-live';
  provider: 'none' | 'alpaca';
  baseUrl: string | null;
  liveCapable: boolean;
  liveArmed: boolean;
  message: string;
  account?: BrokerAccount;
  error?: string;
}

export interface Dashboard {
  mode: TraderMode;
  modeProfile: ModeProfile;
  modes: ModeProfile[];
  watchlist: string[];
  cash: number;
  startingCash: number;
  currency: string;
  equity: number;
  pnl: number;
  pnlPct: number;
  positions: PositionView[];
  alerts: DailyAlert[];
  pendingAlerts: DailyAlert[];
  trades: TradeRecord[];
  lastDailyRunAt: string | null;
  lastDailyRunDate: string | null;
  preferBroker: boolean;
  liveTradingArmed: boolean;
  liveArmedAt: string | null;
  paperTrading: boolean;
  broker: BrokerStatus;
  disclaimer: string;
  createdCount?: number;
  scanned?: number;
  skippedReason?: string;
  created?: DailyAlert[];
  alert?: DailyAlert;
  trade?: TradeRecord;
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || '요청 실패');
  return data as T;
}

export async function fetchDashboard(): Promise<Dashboard> {
  return parse(await fetch('/api/dashboard'));
}

export async function updateSettings(body: {
  mode?: TraderMode;
  watchlist?: string[];
  cash?: number;
  resetStarting?: boolean;
  preferBroker?: boolean;
}): Promise<Dashboard> {
  return parse(
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function runDaily(force = false): Promise<Dashboard> {
  return parse(
    await fetch('/api/daily/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    }),
  );
}

export async function actOnAlert(
  id: string,
  amount: number,
  action: 'execute' | 'skip' = 'execute',
): Promise<Dashboard> {
  return parse(
    await fetch(`/api/alerts/${id}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, action }),
    }),
  );
}

export async function syncBroker(): Promise<Dashboard> {
  return parse(
    await fetch('/api/broker/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}

export async function setLiveTrading(arm: boolean, confirm = ''): Promise<Dashboard> {
  return parse(
    await fetch('/api/broker/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arm, confirm }),
    }),
  );
}
