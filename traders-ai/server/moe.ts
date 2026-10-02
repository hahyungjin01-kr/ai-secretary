import type { ResearchBundle } from './types.js';
import type { ModeProfile } from './modes.js';

export type ExpertSide = 'buy' | 'sell' | 'hold';

export interface ExpertVote {
  expertId: string;
  expertName: string;
  side: ExpertSide;
  /** 해당 side에 대한 확신 0–100 */
  score: number;
  weight: number;
  reasons: string[];
}

export interface MoEResult {
  votes: ExpertVote[];
  buyScore: number;
  sellScore: number;
  holdScore: number;
  consensusSide: ExpertSide;
  /** 합의 가중치 비율 0–1 */
  agreement: number;
  thesis: string;
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function modeWeights(mode: ModeProfile): Record<string, number> {
  if (mode.id === 'safe') {
    return {
      technical: 0.9,
      momentum: 0.6,
      valuation: 1.3,
      risk: 1.4,
      news: 1.1,
    };
  }
  if (mode.id === 'profit') {
    return {
      technical: 1.1,
      momentum: 1.4,
      valuation: 0.7,
      risk: 0.8,
      news: 0.9,
    };
  }
  return {
    technical: 1,
    momentum: 1,
    valuation: 1,
    risk: 1,
    news: 1,
  };
}

function technicalExpert(research: ResearchBundle): Omit<ExpertVote, 'weight'> {
  const reasons: string[] = [];
  let buy = 40;
  let sell = 35;
  const rsi = research.rsi14;
  const bb = research.bollinger;
  const price = research.price;

  if (rsi != null) {
    if (rsi <= 30) {
      buy += 30;
      reasons.push(`RSI ${rsi} 과매도`);
    } else if (rsi <= 40) {
      buy += 16;
      reasons.push(`RSI ${rsi} 반등 후보`);
    } else if (rsi >= 75) {
      sell += 30;
      reasons.push(`RSI ${rsi} 과매수`);
    } else if (rsi >= 65) {
      sell += 14;
      reasons.push(`RSI ${rsi} 과열`);
    } else {
      reasons.push(`RSI ${rsi} 중립`);
    }
  } else {
    reasons.push('RSI 부재');
    buy -= 5;
    sell -= 5;
  }

  if (bb) {
    if (price <= bb.lower) {
      buy += 18;
      reasons.push('볼린저 하단');
    } else if (price >= bb.upper) {
      sell += 18;
      reasons.push('볼린저 상단');
    }
  }

  buy = clamp(buy);
  sell = clamp(sell);
  if (buy >= sell && buy >= 55) {
    return { expertId: 'technical', expertName: '기술분석', side: 'buy', score: buy, reasons };
  }
  if (sell > buy && sell >= 55) {
    return { expertId: 'technical', expertName: '기술분석', side: 'sell', score: sell, reasons };
  }
  return {
    expertId: 'technical',
    expertName: '기술분석',
    side: 'hold',
    score: clamp(Math.max(buy, sell)),
    reasons,
  };
}

function momentumExpert(research: ResearchBundle): Omit<ExpertVote, 'weight'> {
  const reasons: string[] = [];
  let buy = 42;
  let sell = 38;
  const chg = research.changePercent;
  const vol = research.volumeRatio;

  if (chg != null) {
    if (chg <= -4) {
      buy += 14;
      reasons.push(`당일 ${chg}% 급락(반등/위험 공존)`);
    } else if (chg <= -2) {
      buy += 8;
      reasons.push(`당일 ${chg}% 하락`);
    } else if (chg >= 4) {
      sell += 16;
      buy += 6;
      reasons.push(`당일 ${chg}% 급등(추격 주의)`);
    } else if (chg >= 2) {
      buy += 10;
      reasons.push(`당일 ${chg}% 상승 모멘텀`);
    }
  }

  if (vol != null) {
    if (vol >= 1.8) {
      buy += 12;
      sell += 8;
      reasons.push(`거래량 ${vol}x 급증`);
    } else if (vol < 0.5) {
      buy -= 14;
      reasons.push(`거래량 부진 ${vol}x`);
    }
  }

  // 52주 위치
  if (research.fiftyTwoWeekHigh && research.fiftyTwoWeekLow && research.price > 0) {
    const span = research.fiftyTwoWeekHigh - research.fiftyTwoWeekLow;
    if (span > 0) {
      const pos = (research.price - research.fiftyTwoWeekLow) / span;
      if (pos <= 0.2) {
        buy += 8;
        reasons.push('52주 하단권');
      } else if (pos >= 0.9) {
        sell += 10;
        reasons.push('52주 고점권');
      }
    }
  }

  buy = clamp(buy);
  sell = clamp(sell);
  if (buy >= sell && buy >= 55) {
    return { expertId: 'momentum', expertName: '모멘텀', side: 'buy', score: buy, reasons };
  }
  if (sell > buy && sell >= 55) {
    return { expertId: 'momentum', expertName: '모멘텀', side: 'sell', score: sell, reasons };
  }
  return {
    expertId: 'momentum',
    expertName: '모멘텀',
    side: 'hold',
    score: clamp(Math.max(buy, sell)),
    reasons,
  };
}

function valuationExpert(research: ResearchBundle): Omit<ExpertVote, 'weight'> {
  const reasons: string[] = [];
  let buy = 45;
  let sell = 40;

  if (research.trailingPE != null) {
    if (research.trailingPE < 0) {
      buy -= 12;
      reasons.push('적자 PER');
    } else if (research.trailingPE < 12) {
      buy += 14;
      reasons.push(`저PER ${research.trailingPE}`);
    } else if (research.trailingPE > 45) {
      buy -= 16;
      sell += 8;
      reasons.push(`고PER ${research.trailingPE}`);
    } else {
      reasons.push(`PER ${research.trailingPE}`);
    }
  } else {
    reasons.push('PER 없음');
  }

  if (research.priceToBook != null) {
    if (research.priceToBook < 1) {
      buy += 8;
      reasons.push(`PBR ${research.priceToBook}`);
    } else if (research.priceToBook > 8) {
      buy -= 8;
      reasons.push(`고PBR ${research.priceToBook}`);
    }
  }

  if (research.returnOnEquity != null) {
    if (research.returnOnEquity >= 15) {
      buy += 8;
      reasons.push(`ROE ${research.returnOnEquity}%`);
    } else if (research.returnOnEquity < 5) {
      buy -= 6;
      reasons.push(`낮은 ROE ${research.returnOnEquity}%`);
    }
  }

  buy = clamp(buy);
  sell = clamp(sell);
  if (buy >= 58 && buy > sell) {
    return { expertId: 'valuation', expertName: '밸류에이션', side: 'buy', score: buy, reasons };
  }
  if (sell >= 58 && sell > buy) {
    return { expertId: 'valuation', expertName: '밸류에이션', side: 'sell', score: sell, reasons };
  }
  return {
    expertId: 'valuation',
    expertName: '밸류에이션',
    side: 'hold',
    score: clamp(Math.max(buy, sell)),
    reasons,
  };
}

function riskExpert(research: ResearchBundle): Omit<ExpertVote, 'weight'> {
  const reasons: string[] = [];
  let buy = 48;
  let sell = 42;

  if (research.dataWarnings.length > 0) {
    buy -= 6 * Math.min(3, research.dataWarnings.length);
    reasons.push(`데이터 경고 ${research.dataWarnings.length}건`);
  }

  if (research.volumeRatio != null && research.volumeRatio < 0.4) {
    buy -= 12;
    reasons.push('유동성 부족');
  }

  if (research.avgVolume != null && research.avgVolume < 50_000) {
    buy -= 10;
    sell += 4;
    reasons.push('평균 거래량 낮음');
  }

  // 변동성 프록시
  const recent = research.candles.slice(-10);
  if (recent.length >= 5 && research.price > 0) {
    const ranges = recent.map((c) => (c.high - c.low) / Math.max(0.01, c.close));
    const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    if (avg > 0.05) {
      buy -= 8;
      sell += 6;
      reasons.push(`고변동성(일중 ${(avg * 100).toFixed(1)}%)`);
    }
  }

  buy = clamp(buy);
  sell = clamp(sell);
  // risk expert prefers hold/sell when risk high
  if (buy < 40) {
    return {
      expertId: 'risk',
      expertName: '리스크',
      side: 'hold',
      score: clamp(100 - buy),
      reasons: reasons.length ? reasons : ['리스크 관망'],
    };
  }
  if (sell > buy && sell >= 55) {
    return { expertId: 'risk', expertName: '리스크', side: 'sell', score: sell, reasons };
  }
  if (buy >= 60) {
    return { expertId: 'risk', expertName: '리스크', side: 'buy', score: buy, reasons };
  }
  return {
    expertId: 'risk',
    expertName: '리스크',
    side: 'hold',
    score: 55,
    reasons: reasons.length ? reasons : ['리스크 허용 범위 관망'],
  };
}

function newsExpert(research: ResearchBundle): Omit<ExpertVote, 'weight'> {
  const reasons: string[] = [];
  let buy = 45;
  let sell = 40;
  const titles = research.news.map((n) => n.title.toLowerCase());

  if (titles.length === 0) {
    buy -= 8;
    reasons.push('관련 뉴스 공백');
    return {
      expertId: 'news',
      expertName: '뉴스·촉매',
      side: 'hold',
      score: 52,
      reasons,
    };
  }

  const neg = ['하락', '적자', '우려', '급락', '제재', '소송', '리콜', '손실', 'down', 'loss', 'lawsuit'];
  const pos = ['상승', '흑자', '수주', '돌파', '호실적', '상향', 'surge', 'beat', 'record', '계약'];

  let posHit = 0;
  let negHit = 0;
  for (const t of titles) {
    if (neg.some((k) => t.includes(k))) negHit += 1;
    if (pos.some((k) => t.includes(k))) posHit += 1;
  }

  if (negHit > posHit) {
    sell += 12 + negHit * 4;
    buy -= 8;
    reasons.push(`부정 헤드라인 ${negHit}건`);
  } else if (posHit > negHit) {
    buy += 10 + posHit * 3;
    reasons.push(`긍정 헤드라인 ${posHit}건`);
  } else {
    reasons.push(`헤드라인 ${titles.length}건(혼재/중립)`);
  }

  reasons.push(`예: ${research.news[0].title.slice(0, 48)}`);

  buy = clamp(buy);
  sell = clamp(sell);
  if (buy >= 58 && buy > sell) {
    return { expertId: 'news', expertName: '뉴스·촉매', side: 'buy', score: buy, reasons };
  }
  if (sell >= 58 && sell > buy) {
    return { expertId: 'news', expertName: '뉴스·촉매', side: 'sell', score: sell, reasons };
  }
  return {
    expertId: 'news',
    expertName: '뉴스·촉매',
    side: 'hold',
    score: clamp(Math.max(buy, sell)),
    reasons,
  };
}

/**
 * Mixture of Experts: 전문가별 투표를 모드 가중치로 혼합.
 */
export function runMixtureOfExperts(
  research: ResearchBundle,
  mode: ModeProfile,
  heldShares: number,
): MoEResult {
  const w = modeWeights(mode);
  const raw = [
    technicalExpert(research),
    momentumExpert(research),
    valuationExpert(research),
    riskExpert(research),
    newsExpert(research),
  ];

  const votes: ExpertVote[] = raw.map((v) => ({
    ...v,
    weight: w[v.expertId] ?? 1,
  }));

  // 보유 중이면 매도 전문가 의견에 소폭 가산
  if (heldShares > 0) {
    for (const v of votes) {
      if (v.side === 'sell') v.weight *= 1.15;
    }
  }

  let buyScore = 0;
  let sellScore = 0;
  let holdScore = 0;
  let tw = 0;

  for (const v of votes) {
    tw += v.weight;
    if (v.side === 'buy') buyScore += v.score * v.weight;
    else if (v.side === 'sell') sellScore += v.score * v.weight;
    else holdScore += v.score * v.weight;
  }

  buyScore = tw > 0 ? buyScore / tw : 0;
  sellScore = tw > 0 ? sellScore / tw : 0;
  holdScore = tw > 0 ? holdScore / tw : 0;

  let consensusSide: ExpertSide = 'hold';
  let best = holdScore;
  if (buyScore >= sellScore && buyScore >= holdScore) {
    consensusSide = 'buy';
    best = buyScore;
  } else if (sellScore > buyScore && sellScore >= holdScore) {
    consensusSide = 'sell';
    best = sellScore;
  }

  const agreeWeight = votes
    .filter((v) => v.side === consensusSide)
    .reduce((s, v) => s + v.weight, 0);
  const agreement = tw > 0 ? agreeWeight / tw : 0;

  const topReasons = votes
    .filter((v) => v.side === consensusSide)
    .flatMap((v) => v.reasons.slice(0, 2))
    .slice(0, 5);

  const thesis = `MoE ${consensusSide.toUpperCase()} (합의 ${(agreement * 100).toFixed(0)}%, 점수 ${best.toFixed(0)}): ${topReasons.join('; ')}`;

  return {
    votes,
    buyScore: Math.round(buyScore * 10) / 10,
    sellScore: Math.round(sellScore * 10) / 10,
    holdScore: Math.round(holdScore * 10) / 10,
    consensusSide,
    agreement: Math.round(agreement * 100) / 100,
    thesis,
  };
}
