export type BrokerVenue = 'local-paper' | 'alpaca-paper' | 'alpaca-live';

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

export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  currentPrice: number;
  unrealizedPl: number;
  unrealizedPlpc: number;
}

export interface BrokerOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  /** whole shares */
  qty: number;
  type?: 'market' | 'limit';
  limitPrice?: number;
  timeInForce?: 'day' | 'gtc' | 'ioc';
  clientOrderId?: string;
}

export interface BrokerOrderResult {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  filledQty: number;
  filledAvgPrice: number | null;
  status: string;
  submittedAt: string;
  raw?: unknown;
}

export interface BrokerStatus {
  configured: boolean;
  connected: boolean;
  venue: BrokerVenue;
  provider: 'none' | 'alpaca';
  baseUrl: string | null;
  liveCapable: boolean;
  liveArmed: boolean;
  message: string;
  account?: BrokerAccount;
  error?: string;
}

export interface BrokerClient {
  venue: BrokerVenue;
  provider: 'alpaca';
  getStatus(): Promise<BrokerStatus>;
  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<BrokerPosition[]>;
  placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult>;
}
