import { resolveTossConfig, TossBroker } from './broker/toss.js';
import type { TraderMode } from './modes.js';

export type StrategyStyle = 'mean_reversion' | 'momentum' | 'break_follow' | 'trim';

export interface CandidatePick {
  symbol: string;
  source: string;
  style: StrategyStyle;
  whySelected: string;
  priority: number;
}

const FALLBACK_KR_LIQUID = [
  '005930', // 삼성전자
  '000660', // SK하이닉스
  '035420', // NAVER
  '035720', // 카카오
  '005380', // 현대차
  '051910', // LG화학
  '006400', // 삼성SDI
  '068270', // 셀트리온
  '105560', // KB금융
  '055550', // 신한지주
  '012450', // 한화에어로스페이스
  '028260', // 삼성물산
];

const FALLBACK_US_LIQUID = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD'];

async function tossClient(): Promise<TossBroker | null> {
  const cfg = resolveTossConfig();
  if (!cfg) return null;
  return new TossBroker(cfg, false);
}

async function safeRankings(
  client: TossBroker,
  type: Parameters<TossBroker['getRankings']>[0]['type'],
  market: 'KR' | 'US',
  duration: Parameters<TossBroker['getRankings']>[0]['duration'],
  count: number,
): Promise<Awaited<ReturnType<TossBroker['getRankings']>>> {
  try {
    await new Promise((r) => setTimeout(r, 250));
    return await client.getRankings({
      type,
      marketCountry: market,
      duration,
      count,
      excludeInvestmentCaution: true,
    });
  } catch (err) {
    console.error('[universe/rankings]', type, market, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * 모드에 맞게 AI가 오늘 볼 종목 후보를 스스로 고릅니다.
 * - 안전형: 대형 유동성 + 급락 후 반등(평균회귀)
 * - 밸런스형: 거래대금 상위 + 완만한 모멘텀
 * - 수익형: 급등/거래량 모멘텀 중심
 */
export async function buildAutonomousUniverse(
  mode: TraderMode,
  heldSymbols: string[],
): Promise<{ candidates: CandidatePick[]; summary: string }> {
  const client = await tossClient();
  const picks = new Map<string, CandidatePick>();

  const add = (p: CandidatePick) => {
    const prev = picks.get(p.symbol);
    if (!prev || p.priority > prev.priority) picks.set(p.symbol, p);
  };

  if (client) {
    if (mode === 'safe') {
      const liquid = await safeRankings(client, 'MARKET_TRADING_AMOUNT', 'KR', '1d', 40);
      const losers = await safeRankings(client, 'TOP_LOSERS', 'KR', '1d', 30);
      for (const r of liquid.slice(0, 20)) {
        add({
          symbol: r.symbol,
          source: 'KR 거래대금 상위',
          style: 'mean_reversion',
          whySelected: `유동성 상위(${r.rank}위) 대형주 — 안전형 기본 유니버스`,
          priority: 50 - r.rank,
        });
      }
      for (const r of losers.slice(0, 15)) {
        // avoid extreme crashes (< -12%)
        const chg = (r.changeRate ?? 0) * 100;
        if (chg < -12) continue;
        add({
          symbol: r.symbol,
          source: 'KR 급락',
          style: 'mean_reversion',
          whySelected: `단기 급락(${chg.toFixed(1)}%) 후 반등 후보 — 안전형 평균회귀`,
          priority: 80 - r.rank,
        });
      }
    } else if (mode === 'balance') {
      const liquid = await safeRankings(client, 'MARKET_TRADING_AMOUNT', 'KR', '1d', 30);
      const gainers = await safeRankings(client, 'TOP_GAINERS', 'KR', '1d', 20);
      const tossVol = await safeRankings(client, 'TOSS_SECURITIES_TRADING_AMOUNT', 'KR', '1d', 20);
      for (const r of liquid.slice(0, 15)) {
        add({
          symbol: r.symbol,
          source: 'KR 거래대금',
          style: 'flow_follow',
          whySelected: `시장 거래대금 ${r.rank}위 — 밸런스형 수급 추적`,
          priority: 55 - r.rank,
        });
      }
      for (const r of gainers.slice(0, 12)) {
        const chg = (r.changeRate ?? 0) * 100;
        if (chg > 15) continue; // too extended for balance
        add({
          symbol: r.symbol,
          source: 'KR 상승',
          style: 'momentum',
          whySelected: `완만한 상승(${chg.toFixed(1)}%) 모멘텀 — 밸런스형`,
          priority: 70 - r.rank,
        });
      }
      for (const r of tossVol.slice(0, 10)) {
        add({
          symbol: r.symbol,
          source: '토스 거래대금',
          style: 'flow_follow',
          whySelected: `토스 체결 대금 ${r.rank}위 — 개인 수급 확인`,
          priority: 60 - r.rank,
        });
      }
    } else {
      // profit
      const gainersKr = await safeRankings(client, 'TOP_GAINERS', 'KR', '1d', 25);
      const gainersUs = await safeRankings(client, 'TOP_GAINERS', 'US', '1d', 15);
      const tossKr = await safeRankings(client, 'TOSS_SECURITIES_TRADING_VOLUME', 'KR', 'realtime', 20);
      for (const r of gainersKr.slice(0, 18)) {
        add({
          symbol: r.symbol,
          source: 'KR 급등',
          style: 'momentum',
          whySelected: `급등 랭킹 ${r.rank}위 — 수익형 모멘텀`,
          priority: 90 - r.rank,
        });
      }
      for (const r of gainersUs.slice(0, 10)) {
        add({
          symbol: r.symbol,
          source: 'US 급등',
          style: 'momentum',
          whySelected: `미국 급등 ${r.rank}위 — 수익형 모멘텀`,
          priority: 75 - r.rank,
        });
      }
      for (const r of tossKr.slice(0, 12)) {
        add({
          symbol: r.symbol,
          source: '토스 거래량',
          style: 'flow_follow',
          whySelected: `토스 실시간 거래량 ${r.rank}위 — 단기 탄력`,
          priority: 85 - r.rank,
        });
      }
    }
  }

  // always include holdings for sell decisions
  for (const sym of heldSymbols) {
    add({
      symbol: sym.toUpperCase(),
      source: '보유종목',
      style: 'trim',
      whySelected: '보유 포지션 리스크/익절 점검',
      priority: 100,
    });
  }

  // fallback if rankings empty (no toss / API fail)
  if (picks.size <= heldSymbols.length) {
    const fb = mode === 'profit' ? [...FALLBACK_KR_LIQUID, ...FALLBACK_US_LIQUID] : FALLBACK_KR_LIQUID;
    fb.forEach((symbol, i) =>
      add({
        symbol,
        source: 'fallback-liquid',
        style: mode === 'safe' ? 'mean_reversion' : mode === 'balance' ? 'flow_follow' : 'momentum',
        whySelected: '랭킹 조회 실패/공백 — 유동성 유니버스 대체 스캔',
        priority: 40 - i,
      }),
    );
  }

  const candidates = [...picks.values()].sort((a, b) => b.priority - a.priority);
  // cap research load
  const capped = candidates.slice(0, mode === 'safe' ? 18 : mode === 'balance' ? 24 : 30);

  const summary =
    mode === 'safe'
      ? `안전형: 대형 유동성·급락 반등 후보 ${capped.length}개를 AI가 선정`
      : mode === 'balance'
        ? `밸런스형: 수급·완만한 모멘텀 후보 ${capped.length}개를 AI가 선정`
        : `수익형: 급등·거래량 모멘텀 후보 ${capped.length}개를 AI가 선정`;

  return { candidates: capped, summary };
}

export function buildPlaybook(input: {
  side: 'buy' | 'sell';
  style: StrategyStyle;
  mode: TraderMode;
  score: number;
  entry: number;
  target: number;
  stop: number;
  suggestedAmount: number;
  currency: string;
}): { strategy: StrategyStyle; howToInvest: string; horizon: string } {
  const style = input.side === 'sell' ? 'trim' : input.style;
  const horizon =
    input.mode === 'safe' ? '수일~2주' : input.mode === 'balance' ? '1~5거래일' : '당일~3거래일';

  if (input.side === 'sell') {
    return {
      strategy: 'trim',
      horizon,
      howToInvest: `보유분 중 약 ${Math.round(input.suggestedAmount)} ${input.currency} 규모를 시장가/지정가 매도. 손절(${input.stop})·목표가(${input.target}) 이탈 시 잔량도 정리.`,
    };
  }

  if (style === 'mean_reversion') {
    return {
      strategy: style,
      horizon,
      howToInvest: `눌림/급락 후 반등 자리. 진입가 근처(${input.entry})에서 분할 매수, 손절 ${input.stop} 이탈 시 즉시 청산, 1차 목표 ${input.target}. 추천 투입 ${Math.round(input.suggestedAmount)} ${input.currency}.`,
    };
  }
  if (style === 'momentum') {
    return {
      strategy: style,
      horizon,
      howToInvest: `추세 추종. 강세 지속 시에만 유지하고, ${input.stop} 깨지면 바로 손절. 목표 ${input.target}에서 일부 익절. 추천 투입 ${Math.round(input.suggestedAmount)} ${input.currency} (신호 ${input.score}).`,
    };
  }
  return {
    strategy: 'flow_follow',
    horizon,
    howToInvest: `거래대금·수급이 실린 종목 추종. 과열(목표가 도달/손절 터치) 시 비중 축소. 추천 투입 ${Math.round(input.suggestedAmount)} ${input.currency}.`,
  };
}
