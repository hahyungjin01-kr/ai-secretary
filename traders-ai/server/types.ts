export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NewsItem {
  title: string;
  publisher?: string;
  link?: string;
  publishedAt?: string;
}

export interface ResearchBundle {
  symbol: string;
  name: string;
  currency: string;
  asOf: string;
  price: number;
  changePercent: number | null;
  volume: number | null;
  avgVolume: number | null;
  volumeRatio: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  priceToBook: number | null;
  returnOnEquity: number | null;
  rsi14: number | null;
  bollinger: { upper: number; middle: number; lower: number } | null;
  candles: Candle[];
  news: NewsItem[];
  dataWarnings: string[];
}

export interface TradePlan {
  bias: 'buy' | 'watch' | 'avoid';
  thesis: string;
  entry: number;
  target: number;
  stop: number;
  rewardRisk: number;
  positionSizeShares: number;
  positionNotional: number;
  maxLossAmount: number;
  maxLossPercentOfCapital: number;
  checklist: { item: string; ok: boolean; note: string }[];
}

export interface DevilChallenge {
  id: string;
  claim: string;
  counter: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ReviewResult {
  research: ResearchBundle;
  plan: TradePlan;
  devilAdvocate: DevilChallenge[];
  humanGate: {
    required: true;
    message: string;
    autoTradeEnabled: false;
  };
  disclaimer: string;
}
