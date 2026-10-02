import type {
  BrokerAccount,
  BrokerClient,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  BrokerStatus,
  BrokerVenue,
} from './types.js';

const BASE_URL = 'https://openapi.tossinvest.com';
/** Per-request timeout — Cloud/ngrok egress + IP retries must not hang the UI */
const FETCH_TIMEOUT_MS = Number(process.env.TOSS_FETCH_TIMEOUT_MS || 8_000);
const TOKEN_MAX_ATTEMPTS = Number(process.env.TOSS_TOKEN_MAX_ATTEMPTS || 3);
const REQUEST_MAX_ATTEMPTS = Number(process.env.TOSS_REQUEST_MAX_ATTEMPTS || 3);

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const outer = init.signal;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new BrokerError(`토스 API 응답 시간 초과 (${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export class BrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerError';
  }
}

export function resolveTossConfig(): {
  clientId: string;
  clientSecret: string;
  accountSeq: number | null;
  baseUrl: string;
} | null {
  const clientId = (
    process.env.TOSS_CLIENT_ID ||
    process.env.TOSS_API_KEY ||
    process.env.TOSSINVEST_CLIENT_ID ||
    ''
  ).trim();
  const clientSecret = (
    process.env.TOSS_CLIENT_SECRET ||
    process.env.TOSS_SECRET_KEY ||
    process.env.TOSSINVEST_CLIENT_SECRET ||
    ''
  ).trim();
  if (!clientId || !clientSecret) return null;

  const accountRaw = (
    process.env.TOSSINVEST_ACCOUNT ||
    process.env.TOSS_ACCOUNT_SEQ ||
    ''
  ).trim();
  const accountSeq = accountRaw ? Number(accountRaw) : null;

  return {
    clientId,
    clientSecret,
    accountSeq: Number.isFinite(accountSeq as number) ? (accountSeq as number) : null,
    baseUrl: (process.env.TOSS_BASE_URL || BASE_URL).replace(/\/$/, ''),
  };
}

function isInvalidTokenError(status: number, message: string): boolean {
  if (status === 401) return true;
  return /유효하지 않은 토큰|invalid.?token|token.*(expired|revoked|invalid)|최신 토큰으로 다시/i.test(
    message,
  );
}

function isIpDenied(status: number, message: string): boolean {
  if (status === 403) return true;
  return /허용되지 않은\s*IP|ip address not allowed|access_denied|not allowed.*ip/i.test(
    message,
  );
}

/** 프로세스 전역 토큰 — 인스턴스마다 새로 발급하면 이전 토큰이 즉시 무효화됨 */
const sharedToken: {
  access: string | null;
  expiresAt: number;
  inflight: Promise<string> | null;
} = {
  access: null,
  expiresAt: 0,
  inflight: null,
};

export class TossBroker implements BrokerClient {
  readonly provider = 'toss' as const;
  readonly venue: BrokerVenue = 'toss';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private preferredAccountSeq: number | null;
  private liveArmed: boolean;
  private resolvedAccountSeq: number | null = null;

  constructor(
    cfg: NonNullable<ReturnType<typeof resolveTossConfig>>,
    liveArmed: boolean,
  ) {
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.baseUrl = cfg.baseUrl;
    this.preferredAccountSeq = cfg.accountSeq;
    this.liveArmed = liveArmed;
  }

  setLiveArmed(armed: boolean) {
    this.liveArmed = armed;
  }

  private clearToken() {
    sharedToken.access = null;
    sharedToken.expiresAt = 0;
  }

  private async getAccessToken(force = false): Promise<string> {
    if (sharedToken.inflight) {
      try {
        await sharedToken.inflight;
      } catch {
        // ignore; may re-fetch below
      }
    }
    const now = Date.now();
    if (!force && sharedToken.access && now < sharedToken.expiresAt - 60_000) {
      return sharedToken.access;
    }
    if (force) this.clearToken();

    sharedToken.inflight = this.fetchAccessToken().finally(() => {
      sharedToken.inflight = null;
    });
    return sharedToken.inflight;
  }

  private async fetchAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    // 이 환경은 출구 IP가 여러 개라 허용 IP 외 경로로 나가면 403이 날 수 있음 → 짧은 재시도
    let lastErr = '토스 토큰 발급 실패';
    for (let attempt = 1; attempt <= TOKEN_MAX_ATTEMPTS; attempt++) {
      const res = await fetchWithTimeout(`${this.baseUrl}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
      const data = asRecord(await res.json().catch(() => ({})));
      if (res.ok) {
        const access = String(data.access_token || '');
        if (!access) throw new BrokerError('토스 access_token 이 비어 있습니다.');
        sharedToken.access = access;
        sharedToken.expiresAt = Date.now() + num(data.expires_in, 3600) * 1000;
        return access;
      }

      const desc = String(
        data.error_description ||
          asRecord(data.error).message ||
          data.message ||
          `HTTP ${res.status}`,
      );
      lastErr = desc;
      if (!isIpDenied(res.status, desc) || attempt === TOKEN_MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    throw new BrokerError(`토스 토큰 발급 실패: ${lastErr}`);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { account?: boolean } = {},
  ): Promise<T> {
    let token = await this.getAccessToken();
    const buildHeaders = (bearer: string): Record<string, string> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      };
      if (init.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      return headers;
    };

    let lastErr = `토스 API 오류`;
    let refreshed = false;
    const maxAttempts = REQUEST_MAX_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const headers = buildHeaders(token);
      if (opts.account) {
        headers['X-Tossinvest-Account'] = String(await this.resolveAccountSeq());
      }

      const res = await fetchWithTimeout(`${this.baseUrl}${path}`, { ...init, headers });
      const json = await res.json().catch(() => ({}));
      const data = asRecord(json);
      if (res.ok) return json as T;

      const err = asRecord(data.error);
      lastErr = String(err.message || data.message || `토스 API 오류 (${res.status})`);

      if (!refreshed && isInvalidTokenError(res.status, lastErr)) {
        refreshed = true;
        this.clearToken();
        token = await this.getAccessToken(true);
        continue;
      }

      // 출구 IP 회전 환경: 허용 IP가 아니면 짧게만 재시도 (UI/헬스 블로킹 방지)
      if (isIpDenied(res.status, lastErr) && attempt < maxAttempts) {
        this.clearToken();
        await new Promise((r) => setTimeout(r, 200 * attempt));
        token = await this.getAccessToken(true);
        continue;
      }

      const retryable =
        res.status === 429 || /한도|rate|too many|요청 한도/i.test(lastErr);
      if (!retryable || attempt === maxAttempts) break;
      const waitMs = Number(res.headers.get('retry-after') || 0) * 1000 || 1200 * attempt;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    throw new BrokerError(lastErr);
  }

  private async resolveAccountSeq(): Promise<number> {
    if (this.resolvedAccountSeq != null) return this.resolvedAccountSeq;
    if (this.preferredAccountSeq != null) {
      this.resolvedAccountSeq = this.preferredAccountSeq;
      return this.resolvedAccountSeq;
    }

    const res = await this.request<{ result?: Array<Record<string, unknown>> }>(
      '/api/v1/accounts',
      {},
      { account: false },
    );
    const accounts = res.result ?? [];
    const brokerage =
      accounts.find((a) => a.accountType === 'BROKERAGE') ?? accounts[0];
    if (!brokerage?.accountSeq) {
      throw new BrokerError('토스 계좌를 찾지 못했습니다. TOSSINVEST_ACCOUNT 를 설정하세요.');
    }
    this.resolvedAccountSeq = num(brokerage.accountSeq);
    return this.resolvedAccountSeq;
  }

  async listAccounts(): Promise<Array<{ accountSeq: number; accountNo: string; accountType: string }>> {
    const res = await this.request<{ result?: Array<Record<string, unknown>> }>(
      '/api/v1/accounts',
      {},
      { account: false },
    );
    return (res.result ?? []).map((a) => ({
      accountSeq: num(a.accountSeq),
      accountNo: String(a.accountNo ?? ''),
      accountType: String(a.accountType ?? ''),
    }));
  }

  async getAccount(): Promise<BrokerAccount> {
    const accounts = await this.listAccounts();
    const seq = await this.resolveAccountSeq();
    const selected = accounts.find((a) => a.accountSeq === seq) ?? accounts[0];

    // ACCOUNT/ASSET rate limits are tight — call sequentially with small gaps
    await new Promise((r) => setTimeout(r, 1100));
    const bpKrw = await this.request<{ result?: Record<string, unknown> }>(
      '/api/v1/buying-power?currency=KRW',
      {},
      { account: true },
    );
    await new Promise((r) => setTimeout(r, 1100));
    const holdings = await this.request<{ result?: Record<string, unknown> }>(
      '/api/v1/holdings',
      {},
      { account: true },
    );

    let cashUsd: number | null = null;
    try {
      await new Promise((r) => setTimeout(r, 1100));
      const bpUsd = await this.request<{ result?: Record<string, unknown> }>(
        '/api/v1/buying-power?currency=USD',
        {},
        { account: true },
      );
      cashUsd = num(asRecord(bpUsd.result).cashBuyingPower, 0);
    } catch {
      cashUsd = null;
    }

    const cash = num(asRecord(bpKrw.result).cashBuyingPower, 0);
    const overview = asRecord(holdings.result);
    const marketValue = asRecord(asRecord(overview.marketValue).amount);
    const mvKrw = num(marketValue.krw, 0);
    const mvUsd =
      marketValue.usd == null || marketValue.usd === ''
        ? null
        : num(marketValue.usd, 0);
    const equity = cash + mvKrw;

    return {
      id: String(selected?.accountNo || seq),
      status: 'ACTIVE',
      currency: 'KRW',
      cash,
      equity,
      buyingPower: cash,
      portfolioValue: equity,
      patternDayTrader: false,
      tradingBlocked: false,
      accountBlocked: false,
      accountSeq: seq,
      accountNo: selected?.accountNo,
      cashUsd,
      marketValueKrw: mvKrw,
      marketValueUsd: mvUsd,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const res = await this.request<{ result?: Record<string, unknown> }>(
      '/api/v1/holdings',
      {},
      { account: true },
    );
    const items = (asRecord(res.result).items as Array<Record<string, unknown>>) ?? [];
    return items.map((p) => {
      const qty = num(p.quantity);
      const avg = num(p.averagePurchasePrice);
      const last = num(p.lastPrice);
      const mv = asRecord(p.marketValue);
      const pl = asRecord(p.profitLoss);
      const marketValue = num(mv.amount ?? qty * last);
      const unrealizedPl = num(pl.amount ?? (last - avg) * qty);
      const rate = num(pl.rate, avg > 0 ? (last - avg) / avg : 0);
      return {
        symbol: String(p.symbol ?? '').toUpperCase(),
        name: String(p.name ?? p.symbol ?? ''),
        qty,
        avgEntryPrice: avg,
        marketValue,
        currentPrice: last,
        unrealizedPl,
        unrealizedPlpc: Math.abs(rate) <= 2 ? rate * 100 : rate,
        currency: String(p.currency ?? 'KRW'),
      };
    });
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    if (!this.liveArmed) {
      throw new BrokerError(
        '토스 실주문이 잠겨 있습니다. 앱에서 LIVE 확인을 켠 뒤에만 주문됩니다.',
      );
    }
    if (!Number.isFinite(order.qty) || order.qty <= 0) {
      throw new BrokerError('주문 수량이 올바르지 않습니다.');
    }

    const payload: Record<string, unknown> = {
      symbol: order.symbol.toUpperCase(),
      side: order.side === 'sell' ? 'SELL' : 'BUY',
      orderType: order.type === 'limit' ? 'LIMIT' : 'MARKET',
      timeInForce: 'DAY',
      quantity: String(Math.floor(order.qty)),
    };
    if (order.type === 'limit') {
      if (order.limitPrice == null) throw new BrokerError('지정가 주문의 가격이 필요합니다.');
      payload.price = String(order.limitPrice);
    }
    if (order.clientOrderId) {
      payload.clientOrderId = order.clientOrderId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
    }

    const created = await this.request<{ result?: Record<string, unknown> }>(
      '/api/v1/orders',
      { method: 'POST', body: JSON.stringify(payload) },
      { account: true },
    );
    const orderId = String(asRecord(created.result).orderId || '');
    if (!orderId) throw new BrokerError('주문 ID를 받지 못했습니다.');

    // best-effort detail fetch for fill info
    let status = 'PENDING';
    let filledQty = 0;
    let filledAvg: number | null = null;
    try {
      const detail = await this.request<{ result?: Record<string, unknown> }>(
        `/api/v1/orders/${encodeURIComponent(orderId)}`,
        {},
        { account: true },
      );
      const o = asRecord(detail.result);
      status = String(o.status || status);
      const execution = asRecord(o.execution);
      filledQty = num(execution.filledQuantity, 0);
      filledAvg =
        execution.averageFilledPrice != null ? num(execution.averageFilledPrice) : null;
    } catch {
      // keep submitted state
    }

    return {
      id: orderId,
      symbol: order.symbol.toUpperCase(),
      side: order.side,
      qty: Math.floor(order.qty),
      filledQty,
      filledAvgPrice: filledAvg,
      status,
      submittedAt: new Date().toISOString(),
      raw: created,
    };
  }

  async getRankings(input: {
    type:
      | 'MARKET_TRADING_AMOUNT'
      | 'MARKET_TRADING_VOLUME'
      | 'TOP_GAINERS'
      | 'TOP_LOSERS'
      | 'TOSS_SECURITIES_TRADING_AMOUNT'
      | 'TOSS_SECURITIES_TRADING_VOLUME';
    marketCountry: 'KR' | 'US';
    duration: 'realtime' | '1d' | '1w' | '1mo' | '3mo' | '6mo' | '1y';
    count?: number;
    excludeInvestmentCaution?: boolean;
  }): Promise<
    Array<{
      rank: number;
      symbol: string;
      currency: string;
      lastPrice: number;
      changeRate: number | null;
      tradingAmount: number;
      tradingVolume: number;
    }>
  > {
    const qs = new URLSearchParams({
      type: input.type,
      marketCountry: input.marketCountry,
      duration: input.duration,
      count: String(input.count ?? 30),
      excludeInvestmentCaution: String(input.excludeInvestmentCaution ?? true),
    });
    const res = await this.request<{ result?: Record<string, unknown> }>(
      `/api/v1/rankings?${qs}`,
      {},
      { account: false },
    );
    const rankings = (asRecord(res.result).rankings as Array<Record<string, unknown>>) ?? [];
    return rankings.map((r) => {
      const price = asRecord(r.price);
      return {
        rank: num(r.rank),
        symbol: String(r.symbol ?? '').toUpperCase(),
        currency: String(r.currency ?? 'KRW'),
        lastPrice: num(price.lastPrice),
        changeRate: price.changeRate == null ? null : num(price.changeRate),
        tradingAmount: num(r.tradingAmount),
        tradingVolume: num(r.tradingVolume),
      };
    });
  }

  async getStatus(): Promise<BrokerStatus> {
    try {
      const account = await this.getAccount();
      return {
        configured: true,
        connected: true,
        venue: 'toss',
        provider: 'toss',
        baseUrl: this.baseUrl,
        liveCapable: true,
        liveArmed: this.liveArmed,
        account,
        message: this.liveArmed
          ? '토스증권 계좌 연결 · 실주문 가능'
          : '토스증권 계좌 연결 · 실주문은 잠금 상태 (조회만 가능)',
      };
    } catch (err) {
      return {
        configured: true,
        connected: false,
        venue: 'toss',
        provider: 'toss',
        baseUrl: this.baseUrl,
        liveCapable: true,
        liveArmed: this.liveArmed,
        message: '토스증권 연결 실패',
        error: err instanceof Error ? err.message : 'unknown',
      };
    }
  }
}
