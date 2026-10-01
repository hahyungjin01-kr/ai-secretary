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

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

export class TossBroker implements BrokerClient {
  readonly provider = 'toss' as const;
  readonly venue: BrokerVenue = 'toss';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private preferredAccountSeq: number | null;
  private liveArmed: boolean;
  private token: string | null = null;
  private tokenExpiresAt = 0;
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

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) return this.token;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    // 이 환경은 출구 IP가 여러 개라 허용 IP 외 경로로 나가면 403이 날 수 있음 → 재시도
    let lastErr = '토스 토큰 발급 실패';
    for (let attempt = 1; attempt <= 6; attempt++) {
      const res = await fetch(`${this.baseUrl}/oauth2/token`, {
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
        this.token = access;
        this.tokenExpiresAt = Date.now() + num(data.expires_in, 3600) * 1000;
        return access;
      }

      const desc = String(
        data.error_description ||
          asRecord(data.error).message ||
          data.message ||
          `HTTP ${res.status}`,
      );
      lastErr = desc;
      const ipDenied =
        res.status === 403 || /ip address not allowed/i.test(desc) || /access_denied/i.test(desc);
      if (!ipDenied || attempt === 6) break;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    throw new BrokerError(`토스 토큰 발급 실패: ${lastErr}`);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { account?: boolean } = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };

    if (opts.account) {
      const seq = await this.resolveAccountSeq();
      headers['X-Tossinvest-Account'] = String(seq);
    }
    if (init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    let lastErr = `토스 API 오류`;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
      const json = await res.json().catch(() => ({}));
      const data = asRecord(json);
      if (res.ok) return json as T;

      const err = asRecord(data.error);
      lastErr = String(err.message || data.message || `토스 API 오류 (${res.status})`);
      const retryable =
        res.status === 429 ||
        /한도|rate|too many|요청 한도/i.test(lastErr);
      if (!retryable || attempt === 4) break;
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
