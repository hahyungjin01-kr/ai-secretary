import YahooFinance from 'yahoo-finance2';
import { RSI, BollingerBands } from 'technicalindicators';
import type { Candle, NewsItem, ResearchBundle } from './types.js';

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

function round(n: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

/** 토스 심볼(005930, AAPL) → Yahoo 조회용 심볼 */
export function toYahooSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (/^[0-9]{6}$/.test(s)) return `${s}.KS`;
  if (/^[0-9A-Z]{6}$/.test(s) && /\d/.test(s)) return `${s}.KS`;
  return s;
}

/** Yahoo 심볼 → 앱/토스용 심볼 */
export function toAppSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.(KS|KQ)$/i, '');
}

export async function resolveSymbol(query: string): Promise<string> {
  const q = query.trim();
  if (!q) throw new Error('종목 심볼 또는 이름을 입력하세요.');

  // 이미 토스/야후 형식
  if (/^[0-9]{6}$/.test(q) || /^[0-9A-Z]{6}$/.test(q.toUpperCase())) {
    return q.toUpperCase();
  }
  if (/^[A-Za-z]{1,5}(\.[A-Za-z]{1,3})?$/.test(q)) {
    return toAppSymbol(q);
  }

  const search = await yahooFinance.search(q);
  const match =
    search?.quotes?.find(
      (x: { quoteType?: string; symbol?: string }) =>
        x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF'),
    ) ?? search?.quotes?.[0];

  if (!match?.symbol) {
    throw new Error(`종목을 찾지 못했습니다: ${q}`);
  }
  return toAppSymbol(String(match.symbol));
}

export async function collectResearch(inputSymbol: string): Promise<ResearchBundle> {
  const symbol = await resolveSymbol(inputSymbol);
  const yahooSymbol = toYahooSymbol(symbol);
  const warnings: string[] = [];

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 120);

  async function loadQuote(sym: string) {
    return yahooFinance.quote(sym).catch(() => null);
  }

  let quote = await loadQuote(yahooSymbol);
  let usedYahoo = yahooSymbol;
  // KOSDAQ 등 .KS 실패 시 .KQ 재시도
  if ((!quote || quote.regularMarketPrice == null) && /^[0-9A-Z]{6}\.KS$/.test(yahooSymbol)) {
    const alt = yahooSymbol.replace(/\.KS$/, '.KQ');
    quote = await loadQuote(alt);
    if (quote?.regularMarketPrice != null) usedYahoo = alt;
  }

  const [historical, summary, search] = await Promise.all([
    yahooFinance
      .historical(usedYahoo, { period1: start, period2: end, interval: '1d' })
      .catch(() => [] as Awaited<ReturnType<typeof yahooFinance.historical>>),
    yahooFinance
      .quoteSummary(usedYahoo, {
        modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData'],
      })
      .catch(() => null),
    yahooFinance.search(usedYahoo).catch(() => null),
  ]);

  if (!quote || quote.regularMarketPrice == null) {
    throw new Error(`시세를 가져오지 못했습니다: ${symbol}`);
  }

  const candles: Candle[] = (historical ?? [])
    .filter((h) => h.close != null)
    .map((h) => ({
      date: new Date(h.date).toISOString().slice(0, 10),
      open: Number(h.open),
      high: Number(h.high),
      low: Number(h.low),
      close: Number(h.close),
      volume: Number(h.volume ?? 0),
    }));

  const closes = candles.map((c) => c.close);
  let rsi14: number | null = null;
  let bollinger: ResearchBundle['bollinger'] = null;

  if (closes.length >= 20) {
    const rsi = RSI.calculate({ values: closes, period: 14 });
    rsi14 = rsi.length ? round(rsi[rsi.length - 1]) : null;
    const bb = BollingerBands.calculate({
      values: closes,
      period: 20,
      stdDev: 2,
    });
    if (bb.length) {
      const last = bb[bb.length - 1];
      bollinger = {
        upper: round(last.upper),
        middle: round(last.middle),
        lower: round(last.lower),
      };
    }
  } else {
    warnings.push('가격 히스토리가 짧아 RSI/볼린저 신뢰도가 낮습니다.');
  }

  const sd = summary?.summaryDetail ?? {};
  const ks = summary?.defaultKeyStatistics ?? {};
  const fd = summary?.financialData ?? {};

  const volume = quote.regularMarketVolume ?? null;
  const avgVolume =
    (sd as { averageVolume?: number }).averageVolume ??
    quote.averageDailyVolume3Month ??
    null;
  const volumeRatio =
    volume != null && avgVolume != null && avgVolume > 0
      ? round(volume / avgVolume, 2)
      : null;

  const news: NewsItem[] = ((search as { news?: Array<Record<string, unknown>> })?.news ?? [])
    .slice(0, 5)
    .map((n) => ({
      title: String(n.title ?? ''),
      publisher: n.publisher ? String(n.publisher) : undefined,
      link: n.link ? String(n.link) : undefined,
      publishedAt: n.providerPublishTime
        ? new Date(Number(n.providerPublishTime) * 1000).toISOString()
        : undefined,
    }))
    .filter((n) => n.title);

  if (news.length === 0) {
    warnings.push('최신 뉴스 헤드라인을 확보하지 못했습니다.');
  }
  if (!summary) {
    warnings.push('재무 요약 모듈 조회에 실패했습니다. 밸류에이션은 제한됩니다.');
  }

  return {
    symbol,
    name: String(quote.longName || quote.shortName || symbol),
    currency: String(quote.currency || 'USD'),
    asOf: new Date().toISOString(),
    price: round(Number(quote.regularMarketPrice)),
    changePercent:
      quote.regularMarketChangePercent != null
        ? round(Number(quote.regularMarketChangePercent), 2)
        : null,
    volume,
    avgVolume,
    volumeRatio,
    fiftyTwoWeekHigh:
      quote.fiftyTwoWeekHigh != null ? round(Number(quote.fiftyTwoWeekHigh)) : null,
    fiftyTwoWeekLow:
      quote.fiftyTwoWeekLow != null ? round(Number(quote.fiftyTwoWeekLow)) : null,
    marketCap:
      (sd as { marketCap?: number }).marketCap != null
        ? Number((sd as { marketCap?: number }).marketCap)
        : quote.marketCap != null
          ? Number(quote.marketCap)
          : null,
    trailingPE:
      (sd as { trailingPE?: number }).trailingPE != null
        ? round(Number((sd as { trailingPE?: number }).trailingPE), 2)
        : null,
    priceToBook:
      (ks as { priceToBook?: number }).priceToBook != null
        ? round(Number((ks as { priceToBook?: number }).priceToBook), 2)
        : null,
    returnOnEquity:
      (fd as { returnOnEquity?: number }).returnOnEquity != null
        ? round(Number((fd as { returnOnEquity?: number }).returnOnEquity) * 100, 2)
        : null,
    rsi14,
    bollinger,
    candles: candles.slice(-60),
    news,
    dataWarnings: warnings,
  };
}
