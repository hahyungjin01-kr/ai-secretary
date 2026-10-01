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
  status: 'pending' | 'executing' | 'executed' | 'skipped' | 'expired';
  strategy?: string;
  howToInvest?: string;
  horizon?: string;
  selectedBy?: 'ai' | 'user';
  selectionSource?: string;
  expertSummary?: string;
  moaSummary?: string;
  devilSummary?: string;
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
  venue: 'local-paper' | 'toss';
  provider: 'none' | 'toss';
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
  lastUniverseSummary?: string | null;
  lastUniverseSymbols?: string[];
  lastUniverseAt?: string | null;
  preferBroker: boolean;
  liveTradingArmed: boolean;
  liveArmedAt: string | null;
  paperTrading: boolean;
  risk?: {
    paperOnly: boolean;
    liveUnlocked: boolean;
    canUnlockLive: boolean;
    killSwitchActive: boolean;
    killSwitchReason: string | null;
    dailyLossLimitPct: number;
    dayPnl: number;
    dayPnlPct: number;
    consecutiveLosses: number;
    maxConsecutiveLosses: number;
    buysLocked: boolean;
    lockReason: string | null;
    message: string;
  };
  broker: BrokerStatus;
  disclaimer: string;
  accessTokenRequired?: boolean;
  approvePhrase?: string;
  createdCount?: number;
  scanned?: number;
  universeSummary?: string;
  skippedReason?: string;
  created?: DailyAlert[];
  alert?: DailyAlert;
  trade?: TradeRecord;
}

const TOKEN_KEY = 'traders_ai_token';

export function getAccessToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAccessToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

function authHeaders(json = true): HeadersInit {
  const h: Record<string, string> = {
    // ngrok 무료 안내 HTML이 API 응답을 가로채지 않게 함
    'ngrok-skip-browser-warning': 'true',
  };
  if (json) h['Content-Type'] = 'application/json';
  const t = getAccessToken();
  if (t) h['X-Traders-Token'] = t;
  return h;
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(
      '서버에 연결하지 못했습니다. 주소/터널을 확인하거나, 접속 토큰을 저장했는지 보세요.',
    );
  }
}

async function parse<T>(res: Response): Promise<T> {
  let data: { error?: string } = {};
  try {
    data = await res.json();
  } catch {
    throw new Error(
      res.status === 401
        ? '접속 토큰이 필요합니다. 화면에 TRADERS_AI_TOKEN을 저장하세요.'
        : '서버 응답을 읽지 못했습니다. 페이지를 새로고침 후 다시 시도하세요.',
    );
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        data?.error ||
          '접속 토큰이 필요합니다. .env의 TRADERS_AI_TOKEN을 복사해 저장하세요.',
      );
    }
    throw new Error(data?.error || '요청 실패');
  }
  return data as T;
}

export async function fetchDashboard(): Promise<Dashboard> {
  return parse(await apiFetch('/api/dashboard', { headers: authHeaders(false) }));
}

export async function updateSettings(body: {
  mode?: TraderMode;
  watchlist?: string[];
  cash?: number;
  resetStarting?: boolean;
  preferBroker?: boolean;
}): Promise<Dashboard> {
  return parse(
    await apiFetch('/api/settings', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }),
  );
}

export async function runDaily(force = false): Promise<Dashboard> {
  return parse(
    await apiFetch('/api/daily/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ force }),
    }),
  );
}

export async function actOnAlert(
  id: string,
  amount?: number,
  action: 'execute' | 'skip' = 'execute',
  confirm?: string,
): Promise<Dashboard> {
  const body: { action: 'execute' | 'skip'; amount?: number; confirm?: string } = { action };
  if (amount !== undefined) body.amount = amount;
  if (confirm !== undefined) body.confirm = confirm;
  return parse(
    await apiFetch(`/api/alerts/${id}/act`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }),
  );
}

export async function confirmAllPending(): Promise<
  Dashboard & {
    confirmedCount?: number;
    failed?: { id: string; symbol: string; error: string }[];
    notice?: string;
  }
> {
  return parse(
    await apiFetch('/api/alerts/confirm-all', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ confirm: '최종확인' }),
    }),
  );
}

export async function syncBroker(): Promise<Dashboard> {
  return parse(
    await apiFetch('/api/broker/sync', {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    }),
  );
}

export async function setLiveTrading(arm: boolean, confirm = ''): Promise<Dashboard> {
  return parse(
    await apiFetch('/api/broker/live', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ arm, confirm }),
    }),
  );
}

