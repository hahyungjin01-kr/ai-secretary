import type { ResearchBundle, TradePlan } from './types.js';

function round(n: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

export function buildTradePlan(
  research: ResearchBundle,
  capital: number,
  riskPercent: number,
): TradePlan {
  const price = research.price;
  const rsi = research.rsi14;
  const bb = research.bollinger;
  const volRatio = research.volumeRatio;

  let bias: TradePlan['bias'] = 'watch';
  const reasons: string[] = [];

  if (rsi != null && rsi <= 35) {
    bias = 'buy';
    reasons.push(`RSI ${rsi}로 단기 과매도 구간`);
  } else if (rsi != null && rsi >= 70) {
    bias = 'avoid';
    reasons.push(`RSI ${rsi}로 단기 과매수 구간`);
  } else {
    reasons.push(rsi != null ? `RSI ${rsi}로 중립` : 'RSI 데이터 부족');
  }

  if (bb) {
    if (price <= bb.lower) {
      if (bias !== 'avoid') bias = 'buy';
      reasons.push('볼린저 하단 근접');
    } else if (price >= bb.upper) {
      bias = 'avoid';
      reasons.push('볼린저 상단 근접');
    }
  }

  if (volRatio != null && volRatio >= 1.5) {
    reasons.push(`거래량 급증(평균 대비 ${volRatio}x)`);
  } else if (volRatio != null && volRatio < 0.6) {
    if (bias === 'buy') bias = 'watch';
    reasons.push(`거래량 부진(평균 대비 ${volRatio}x)`);
  }

  if (research.trailingPE != null && research.trailingPE > 45 && bias === 'buy') {
    bias = 'watch';
    reasons.push(`고PER(${research.trailingPE})로 안전마진 축소`);
  }

  // ATR proxy from recent range
  const recent = research.candles.slice(-14);
  const avgRange =
    recent.length > 0
      ? recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length
      : price * 0.02;

  const stopDistance = Math.max(avgRange * 1.2, price * 0.015);
  const entry = round(price);
  const stop = round(Math.max(0.01, entry - stopDistance));
  const riskPerShare = Math.max(0.01, entry - stop);
  const target = round(entry + riskPerShare * 2);
  const rewardRisk = round((target - entry) / riskPerShare, 2);

  const cappedRiskPct = Math.min(Math.max(riskPercent, 0.25), 5);
  const maxLossAmount = round((capital * cappedRiskPct) / 100);
  const positionSizeShares =
    bias === 'avoid' ? 0 : Math.max(0, Math.floor(maxLossAmount / riskPerShare));
  const positionNotional = round(positionSizeShares * entry);
  const maxLossPercentOfCapital =
    capital > 0 ? round((Math.min(maxLossAmount, positionSizeShares * riskPerShare) / capital) * 100, 2) : 0;

  const checklist: TradePlan['checklist'] = [
    {
      item: '가격·거래량 동기화',
      ok: research.volume != null,
      note: research.volume != null ? `거래량 ${research.volume.toLocaleString()}` : '거래량 없음',
    },
    {
      item: '뉴스 헤드라인 확인',
      ok: research.news.length > 0,
      note: research.news[0]?.title ?? '뉴스 없음 — 이벤트 리스크 미확인',
    },
    {
      item: '손절폭 대비 목표 수익',
      ok: rewardRisk >= 1.5,
      note: `R:R ${rewardRisk}`,
    },
    {
      item: '계좌 대비 손실 한도',
      ok: maxLossPercentOfCapital <= cappedRiskPct + 0.01,
      note: `최대 손실 ≈ ${maxLossPercentOfCapital}% (한도 ${cappedRiskPct}%)`,
    },
    {
      item: '데이터 경고 부재',
      ok: research.dataWarnings.length === 0,
      note:
        research.dataWarnings.length === 0
          ? '경고 없음'
          : research.dataWarnings.join(' / '),
    },
  ];

  const thesis =
    bias === 'buy'
      ? `${research.name}(${research.symbol}) 매수 검토: ${reasons.join('; ')}. 최종 주문은 사람 승인 후에만.`
      : bias === 'avoid'
        ? `${research.name}(${research.symbol}) 회피 권고: ${reasons.join('; ')}.`
        : `${research.name}(${research.symbol}) 관망: ${reasons.join('; ')}. 촉매·리스크 재확인 필요.`;

  return {
    bias,
    thesis,
    entry,
    target,
    stop,
    rewardRisk,
    positionSizeShares,
    positionNotional,
    maxLossAmount: round(Math.min(maxLossAmount, positionSizeShares * riskPerShare)),
    maxLossPercentOfCapital,
    checklist,
  };
}
