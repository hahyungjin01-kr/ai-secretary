import type {
  BrokerAccount,
  BrokerClient,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  BrokerStatus,
  BrokerVenue,
} from './types.js';

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export class BrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerError';
  }
}

export function resolveAlpacaConfig(): {
  key: string;
  secret: string;
  baseUrl: string;
  venue: BrokerVenue;
  liveCapable: boolean;
} | null {
  const key = (process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID || '').trim();
  const secret = (
    process.env.ALPACA_API_SECRET ||
    process.env.APCA_API_SECRET_KEY ||
    ''
  ).trim();
  if (!key || !secret) return null;

  const explicit = (process.env.ALPACA_BASE_URL || '').trim().replace(/\/$/, '');
  const wantLive =
    process.env.ALPACA_LIVE === 'true' ||
    process.env.ALPACA_LIVE === '1' ||
    /api\.alpaca\.markets$/i.test(explicit);

  const baseUrl =
    explicit ||
    (wantLive ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets');

  const isLiveHost = /\/\/api\.alpaca\.markets$/i.test(baseUrl);
  const venue: BrokerVenue = isLiveHost ? 'alpaca-live' : 'alpaca-paper';

  return {
    key,
    secret,
    baseUrl,
    venue,
    liveCapable: isLiveHost,
  };
}

export class AlpacaBroker implements BrokerClient {
  readonly provider = 'alpaca' as const;
  readonly venue: BrokerVenue;
  private readonly key: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly liveCapable: boolean;
  private liveArmed: boolean;

  constructor(
    cfg: NonNullable<ReturnType<typeof resolveAlpacaConfig>>,
    liveArmed: boolean,
  ) {
    this.key = cfg.key;
    this.secret = cfg.secret;
    this.baseUrl = cfg.baseUrl;
    this.venue = cfg.venue;
    this.liveCapable = cfg.liveCapable;
    this.liveArmed = liveArmed;
  }

  setLiveArmed(armed: boolean) {
    this.liveArmed = armed;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'APCA-API-KEY-ID': this.key,
        'APCA-API-SECRET-KEY': this.secret,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text };
    }

    if (!res.ok) {
      const msg =
        typeof body === 'object' && body && 'message' in body
          ? String((body as { message: unknown }).message)
          : `Alpaca HTTP ${res.status}`;
      throw new BrokerError(msg);
    }
    return body as T;
  }

  async getAccount(): Promise<BrokerAccount> {
    const a = await this.request<Record<string, unknown>>('/v2/account');
    return {
      id: String(a.id ?? ''),
      status: String(a.status ?? 'unknown'),
      currency: String(a.currency ?? 'USD'),
      cash: num(a.cash),
      equity: num(a.equity),
      buyingPower: num(a.buying_power),
      portfolioValue: num(a.portfolio_value ?? a.equity),
      patternDayTrader: Boolean(a.pattern_day_trader),
      tradingBlocked: Boolean(a.trading_blocked),
      accountBlocked: Boolean(a.account_blocked),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const rows = await this.request<Array<Record<string, unknown>>>('/v2/positions');
    return (rows ?? []).map((p) => ({
      symbol: String(p.symbol ?? '').toUpperCase(),
      qty: Math.abs(num(p.qty)),
      avgEntryPrice: num(p.avg_entry_price),
      marketValue: Math.abs(num(p.market_value)),
      currentPrice: num(p.current_price),
      unrealizedPl: num(p.unrealized_pl),
      unrealizedPlpc: num(p.unrealized_plpc) * 100,
    }));
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    if (this.liveCapable && !this.liveArmed) {
      throw new BrokerError(
        '실계좌(Live) 주문이 잠겨 있습니다. 앱에서 LIVE 확인을 켠 뒤에만 주문됩니다.',
      );
    }
    if (!Number.isFinite(order.qty) || order.qty <= 0) {
      throw new BrokerError('주문 수량이 올바르지 않습니다.');
    }

    const payload: Record<string, unknown> = {
      symbol: order.symbol.toUpperCase(),
      qty: String(order.qty),
      side: order.side,
      type: order.type ?? 'market',
      time_in_force: order.timeInForce ?? 'day',
    };
    if (order.clientOrderId) payload.client_order_id = order.clientOrderId;
    if (order.type === 'limit' && order.limitPrice != null) {
      payload.limit_price = String(order.limitPrice);
    }

    const o = await this.request<Record<string, unknown>>('/v2/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      id: String(o.id ?? ''),
      symbol: String(o.symbol ?? order.symbol).toUpperCase(),
      side: (o.side === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
      qty: num(o.qty, order.qty),
      filledQty: num(o.filled_qty),
      filledAvgPrice: o.filled_avg_price != null ? num(o.filled_avg_price) : null,
      status: String(o.status ?? 'submitted'),
      submittedAt: String(o.submitted_at ?? new Date().toISOString()),
      raw: o,
    };
  }

  async getStatus(): Promise<BrokerStatus> {
    try {
      const account = await this.getAccount();
      const blocked = account.tradingBlocked || account.accountBlocked;
      return {
        configured: true,
        connected: true,
        venue: this.venue,
        provider: 'alpaca',
        baseUrl: this.baseUrl,
        liveCapable: this.liveCapable,
        liveArmed: this.liveArmed,
        account,
        message: blocked
          ? '계좌는 연결됐지만 거래가 차단된 상태입니다.'
          : this.liveCapable
            ? this.liveArmed
              ? 'Alpaca 실계좌 연결 · 실주문 가능'
              : 'Alpaca 실계좌 연결 · 실주문은 잠금 상태'
            : 'Alpaca 페이퍼 계좌 연결됨',
      };
    } catch (err) {
      return {
        configured: true,
        connected: false,
        venue: this.venue,
        provider: 'alpaca',
        baseUrl: this.baseUrl,
        liveCapable: this.liveCapable,
        liveArmed: this.liveArmed,
        message: 'Alpaca 연결 실패',
        error: err instanceof Error ? err.message : 'unknown',
      };
    }
  }
}
