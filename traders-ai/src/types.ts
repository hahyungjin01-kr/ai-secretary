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
  status: 'pending' | 'queued' | 'executing' | 'executed' | 'skipped' | 'expired';
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

export interface NotifyInfo {
  enabled: boolean;
  timeKst: string;
  timezone: string;
  subscriptionCount: number;
  vapidReady: boolean;
  nextHint: string;
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
  schedule?: {
    enabled: boolean;
    timeKst: string;
    timezone: string;
    weekdaysOnly: boolean;
    lastAttemptAt: string | null;
    lastResult: string | null;
    nextHint: string;
    notify?: NotifyInfo & {
      lastAttemptAt: string | null;
      lastResult: string | null;
    };
    executeQueued?: {
      timeKst: string;
      lastAttemptAt: string | null;
      lastResult: string | null;
      nextHint: string;
    };
  };
  notify?: NotifyInfo;
  broker: BrokerStatus;
  disclaimer: string;
  approvePhrase?: string;
  createdCount?: number;
  scanned?: number;
  universeSummary?: string;
  skippedReason?: string;
  created?: DailyAlert[];
  alert?: DailyAlert;
  trade?: TradeRecord;
}

declare global {
  interface Window {
    __TRADERS_API_SECRET__?: string;
  }
}

const SECRET_KEY = 'traders_ai_api_secret';

// 예전 접속토큰 UI 잔여값 정리
try {
  localStorage.removeItem('traders_ai_token');
} catch {
  // ignore
}

let cachedSecret: string | null = null;
let secretReady: Promise<string> | null = null;

function readInjectedSecret(): string {
  try {
    if (typeof window !== 'undefined' && window.__TRADERS_API_SECRET__) {
      return window.__TRADERS_API_SECRET__;
    }
  } catch {
    // ignore
  }
  try {
    return localStorage.getItem(SECRET_KEY) ?? '';
  } catch {
    return '';
  }
}

export async function ensureApiSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const injected = readInjectedSecret();
  if (injected) {
    cachedSecret = injected;
    try {
      localStorage.setItem(SECRET_KEY, injected);
    } catch {
      // ignore
    }
    void persistSecretToSw(injected);
    return injected;
  }
  if (!secretReady) {
    secretReady = (async () => {
      const res = await fetch('/api/bootstrap', {
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      const data = (await res.json()) as { apiSecret?: string };
      const s = data.apiSecret ?? '';
      if (!s) throw new Error('API 시크릿을 받지 못했습니다. 서버를 확인하세요.');
      cachedSecret = s;
      try {
        localStorage.setItem(SECRET_KEY, s);
      } catch {
        // ignore
      }
      void persistSecretToSw(s);
      return s;
    })().finally(() => {
      secretReady = null;
    });
  }
  return secretReady;
}

async function persistSecretToSw(secret: string) {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: 'traders-ai:set-secret', secret });
  } catch {
    // ignore
  }
}

async function apiHeaders(json = true): Promise<HeadersInit> {
  const secret = await ensureApiSecret();
  const h: Record<string, string> = {
    'ngrok-skip-browser-warning': 'true',
    'X-Traders-Secret': secret,
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const attempt = async () => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 20_000);
    try {
      return await fetch(input, {
        ...init,
        signal: init?.signal ?? ctrl.signal,
        headers: {
          'ngrok-skip-browser-warning': 'true',
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } finally {
      window.clearTimeout(timer);
    }
  };
  try {
    return await attempt();
  } catch (first) {
    // 일시적 ngrok/모바일 끊김 1회 재시도
    try {
      await new Promise((r) => setTimeout(r, 400));
      return await attempt();
    } catch {
      const name = first instanceof Error ? first.name : '';
      if (name === 'AbortError') {
        throw new Error('서버 응답이 너무 느립니다. 새로고침 후 다시 시도하세요.');
      }
      throw new Error('서버에 연결하지 못했습니다. 주소/터널을 확인하세요.');
    }
  }
}

async function parse<T>(res: Response): Promise<T> {
  let data: { error?: string } = {};
  try {
    data = await res.json();
  } catch {
    throw new Error('서버 응답을 읽지 못했습니다. 페이지를 새로고침 후 다시 시도하세요.');
  }
  if (!res.ok) throw new Error(data?.error || '요청 실패');
  return data as T;
}

export async function fetchDashboard(): Promise<Dashboard> {
  await ensureApiSecret();
  return parse(await apiFetch('/api/dashboard', { headers: await apiHeaders(false) }));
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
      headers: await apiHeaders(),
      body: JSON.stringify(body),
    }),
  );
}

export async function runDaily(force = false): Promise<Dashboard> {
  return parse(
    await apiFetch('/api/daily/run', {
      method: 'POST',
      headers: await apiHeaders(),
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
  if (action === 'execute') body.confirm = confirm ?? '최종확인';
  else if (confirm !== undefined) body.confirm = confirm;
  return parse(
    await apiFetch(`/api/alerts/${id}/act`, {
      method: 'POST',
      headers: await apiHeaders(),
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
      headers: await apiHeaders(),
      body: JSON.stringify({ confirm: '최종확인' }),
    }),
  );
}

export async function syncBroker(): Promise<Dashboard> {
  return parse(
    await apiFetch('/api/broker/sync', {
      method: 'POST',
      headers: await apiHeaders(),
      body: '{}',
    }),
  );
}

export async function fetchEgressIps(): Promise<{ ips: string[]; hint: string }> {
  return parse(await apiFetch('/api/broker/egress', { headers: await apiHeaders(false) }));
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function enablePhoneNotify(): Promise<{ ok: true; endpoint: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('이 브라우저는 푸시 알림을 지원하지 않습니다. Chrome/Android 또는 홈 화면 추가(iOS)를 사용하세요.');
  }
  if (!window.isSecureContext) {
    throw new Error('알림은 HTTPS(또는 localhost)에서만 켤 수 있습니다.');
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error('알림 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.');
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const secret = await ensureApiSecret();
  reg.active?.postMessage({ type: 'traders-ai:set-secret', secret });

  const { publicKey } = await parse<{ publicKey: string }>(
    await apiFetch('/api/push/vapid-public-key', { headers: await apiHeaders(false) }),
  );

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  await parse(
    await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: await apiHeaders(),
      body: JSON.stringify({ subscription: sub.toJSON() }),
    }),
  );

  return { ok: true, endpoint: sub.endpoint };
}

export async function sendTestNotify(): Promise<{ sent: number; failed: number }> {
  return parse(
    await apiFetch('/api/push/test', {
      method: 'POST',
      headers: await apiHeaders(),
      body: '{}',
    }),
  );
}

export async function getPushStatus(): Promise<{
  subscribed: boolean;
  permission: NotificationPermission | 'unsupported';
}> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { subscribed: false, permission: 'unsupported' };
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return { subscribed: Boolean(sub), permission: Notification.permission };
  } catch {
    return { subscribed: false, permission: Notification.permission };
  }
}

export async function setLiveTrading(arm: boolean, confirm = ''): Promise<Dashboard> {
  return parse(
    await apiFetch('/api/broker/live', {
      method: 'POST',
      headers: await apiHeaders(),
      body: JSON.stringify({ arm, confirm }),
    }),
  );
}

