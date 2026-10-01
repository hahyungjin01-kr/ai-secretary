import type { ResearchBundle } from './types.js';
import type { ModeProfile } from './modes.js';

export interface SignalDecision {
  side: 'buy' | 'sell' | 'hold';
  score: number;
  thesis: string;
  entry: number;
  target: number;
  stop: number;
  rewardRisk: number;
}

function round(n: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function stopDistance(research: ResearchBundle): number {
  const price = research.price;
  const recent = research.candles.slice(-14);
  const avgRange =
    recent.length > 0
      ? recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length
      : price * 0.02;
  return Math.max(avgRange * 1.2, price * 0.015);
}

export function scoreSignals(
  research: ResearchBundle,
  mode: ModeProfile,
  heldShares: number,
): SignalDecision {
  const price = research.price;
  const rsi = research.rsi14;
  const bb = research.bollinger;
  const vol = research.volumeRatio;
  const reasons: string[] = [];

  let buy = 40;
  let sell = 35;

  if (rsi != null) {
    if (rsi <= 30) {
      buy += 28;
      reasons.push(`RSI ${rsi} 과매도`);
    } else if (rsi <= 40) {
      buy += 16;
      reasons.push(`RSI ${rsi} 약세 반등 후보`);
    } else if (rsi >= 75) {
      sell += 28;
      reasons.push(`RSI ${rsi} 과매수`);
    } else if (rsi >= 65) {
      sell += 14;
      reasons.push(`RSI ${rsi} 과열`);
    } else {
      reasons.push(`RSI ${rsi} 중립`);
    }
  }

  if (bb) {
    if (price <= bb.lower) {
      buy += 18;
      reasons.push('볼린저 하단 근접');
    } else if (price >= bb.upper) {
      sell += 18;
      reasons.push('볼린저 상단 근접');
    } else if (price > bb.middle) {
      buy += 4;
    } else {
      sell += 4;
    }
  }

  if (vol != null) {
    if (vol >= 1.6) {
      buy += 10;
      sell += 6;
      reasons.push(`거래량 ${vol}x`);
    } else if (vol < 0.55) {
      buy -= 12;
      reasons.push(`거래량 부진 ${vol}x`);
    }
  }

  if (research.changePercent != null) {
    if (research.changePercent <= -3) {
      buy += 8;
      reasons.push(`당일 ${research.changePercent}% 하락`);
    } else if (research.changePercent >= 3.5) {
      sell += 10;
      reasons.push(`당일 ${research.changePercent}% 급등`);
    }
  }

  if (research.trailingPE != null && research.trailingPE > 50) {
    buy -= 10;
    reasons.push(`고PER ${research.trailingPE}`);
  }

  if (research.dataWarnings.length > 2) {
    buy -= 8;
    sell -= 4;
  }

  // mode tilt
  if (mode.id === 'safe') {
    buy -= 8;
    sell += 4;
  } else if (mode.id === 'profit') {
    buy += 10;
    sell -= 2;
  }

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  const dist = stopDistance(research);
  const entry = round(price);

  // Prefer sell if we hold and sell score wins
  if (heldShares > 0 && sell >= mode.minSellScore && sell >= buy) {
    const stop = round(entry + dist); // short-risk style stop above for monitoring
    const target = round(Math.max(0.01, entry - dist * mode.minRewardRisk));
    const rewardRisk = round(Math.abs(entry - target) / Math.max(0.01, Math.abs(stop - entry)), 2);
    return {
      side: 'sell',
      score: sell,
      thesis: `${research.name} 매도 후보: ${reasons.join('; ')}`,
      entry,
      target,
      stop,
      rewardRisk,
    };
  }

  if (buy >= mode.minBuyScore && buy > sell) {
    const stop = round(Math.max(0.01, entry - dist));
    const riskPerShare = Math.max(0.01, entry - stop);
    const target = round(entry + riskPerShare * mode.minRewardRisk);
    const rewardRisk = round((target - entry) / riskPerShare, 2);
    return {
      side: 'buy',
      score: buy,
      thesis: `${research.name} 매수 후보: ${reasons.join('; ')}`,
      entry,
      target,
      stop,
      rewardRisk,
    };
  }

  return {
    side: 'hold',
    score: Math.max(buy, sell),
    thesis: `${research.name} 관망: ${reasons.join('; ')}`,
    entry,
    target: entry,
    stop: entry,
    rewardRisk: 0,
  };
}
