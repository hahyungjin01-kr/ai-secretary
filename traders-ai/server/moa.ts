import type { ResearchBundle, DevilChallenge } from './types.js';
import type { ModeProfile } from './modes.js';
import { runMixtureOfExperts, type ExpertSide, type MoEResult } from './moe.js';
import { runDevilAdvocate, type DevilResult } from './devilAdvocate.js';

export interface AgentOpinion {
  agentId: string;
  agentName: string;
  role: 'proposer' | 'critic' | 'risk' | 'aggregator';
  side: ExpertSide;
  score: number;
  note: string;
}

export interface MoADecision {
  side: 'buy' | 'sell' | 'hold';
  score: number;
  confidence: number;
  thesis: string;
  entry: number;
  target: number;
  stop: number;
  rewardRisk: number;
  /** 사이징 축소 배수 (악마/리스크 반영) */
  sizeFactor: number;
  expertVotes: ExpertVote[];
  agentOpinions: AgentOpinion[];
  devilAdvocate: DevilChallenge[];
  devilSummary: string;
  moaSummary: string;
  passedGate: boolean;
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

function levels(
  research: ResearchBundle,
  side: ExpertSide,
  mode: ModeProfile,
): { entry: number; target: number; stop: number; rewardRisk: number } {
  const entry = round(research.price);
  const dist = stopDistance(research);
  if (side === 'sell') {
    const stop = round(entry + dist);
    const target = round(Math.max(0.01, entry - dist * mode.minRewardRisk));
    const rewardRisk = round(
      Math.abs(entry - target) / Math.max(0.01, Math.abs(stop - entry)),
      2,
    );
    return { entry, target, stop, rewardRisk };
  }
  if (side === 'buy') {
    const stop = round(Math.max(0.01, entry - dist));
    const riskPerShare = Math.max(0.01, entry - stop);
    const target = round(entry + riskPerShare * mode.minRewardRisk);
    const rewardRisk = round((target - entry) / riskPerShare, 2);
    return { entry, target, stop, rewardRisk };
  }
  return { entry, target: entry, stop: entry, rewardRisk: 0 };
}

/** 독립 제안 에이전트: 각자 다른 피처만 보고 판단 (상관 투표 완화) */
function independentProposer(
  agentId: string,
  agentName: string,
  research: ResearchBundle,
  lens: 'technical' | 'fundamental' | 'flow',
): AgentOpinion {
  let buy = 45;
  let sell = 40;
  const notes: string[] = [];

  if (lens === 'technical') {
    const rsi = research.rsi14;
    const bb = research.bollinger;
    if (rsi != null) {
      if (rsi <= 32) {
        buy += 22;
        notes.push(`RSI ${rsi}`);
      } else if (rsi >= 72) {
        sell += 22;
        notes.push(`RSI ${rsi}`);
      }
    }
    if (bb) {
      if (research.price <= bb.lower) {
        buy += 14;
        notes.push('BB하단');
      } else if (research.price >= bb.upper) {
        sell += 14;
        notes.push('BB상단');
      }
    }
  } else if (lens === 'fundamental') {
    if (research.trailingPE != null) {
      if (research.trailingPE > 0 && research.trailingPE < 14) {
        buy += 16;
        notes.push(`PER ${research.trailingPE}`);
      } else if (research.trailingPE > 40) {
        buy -= 14;
        sell += 8;
        notes.push(`고PER ${research.trailingPE}`);
      }
    }
    if (research.returnOnEquity != null && research.returnOnEquity >= 12) {
      buy += 8;
      notes.push(`ROE ${research.returnOnEquity}`);
    }
    if (research.news.length === 0) {
      buy -= 10;
      notes.push('뉴스공백');
    }
  } else {
    const chg = research.changePercent;
    const vol = research.volumeRatio;
    if (chg != null && chg <= -3) {
      buy += 10;
      notes.push(`${chg}%`);
    }
    if (chg != null && chg >= 3.5) {
      sell += 12;
      notes.push(`${chg}%급등`);
    }
    if (vol != null && vol >= 1.7) {
      buy += 8;
      sell += 6;
      notes.push(`vol ${vol}x`);
    }
    if (vol != null && vol < 0.5) {
      buy -= 12;
      notes.push('유동성↓');
    }
  }

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));
  let side: ExpertSide = 'hold';
  let score = Math.max(buy, sell) * 0.85;
  if (buy >= 58 && buy > sell + 4) {
    side = 'buy';
    score = buy;
  } else if (sell >= 58 && sell > buy + 4) {
    side = 'sell';
    score = sell;
  }

  return {
    agentId,
    agentName,
    role: 'proposer',
    side,
    score: round(score, 1),
    note: `${agentName}: ${side} (${notes.slice(0, 3).join(', ') || '중립'})`,
  };
}

/** MoE 보조 투표 (독립 제안과 충돌 시 감점용) */
function moeSupportSide(moe: MoEResult, side: ExpertSide): number {
  if (side === 'buy') return moe.buyScore;
  if (side === 'sell') return moe.sellScore;
  return moe.holdScore;
}

function riskAgent(
  research: ResearchBundle,
  side: ExpertSide,
  score: number,
  rewardRisk: number,
  mode: ModeProfile,
  heldShares: number,
): AgentOpinion {
  let adj = score;
  const notes: string[] = [];

  if (side === 'buy' && rewardRisk < mode.minRewardRisk) {
    adj -= 12;
    notes.push(`R:R ${rewardRisk} < 모드 ${mode.minRewardRisk}`);
  }
  if (research.dataWarnings.length > 1) {
    adj -= 8;
    notes.push('데이터 경고 다수');
  }
  if (side === 'sell' && heldShares <= 0) {
    return {
      agentId: 'risk-agent',
      agentName: '리스크 에이전트',
      role: 'risk',
      side: 'hold',
      score: 30,
      note: '보유 없음 → 매도 불가, 관망',
    };
  }
  if (side === 'buy' && adj < mode.minBuyScore) {
    notes.push('매수 임계 미달');
  }

  let outSide: ExpertSide = side;
  if (side === 'buy' && adj < mode.minBuyScore) outSide = 'hold';
  if (side === 'sell' && adj < mode.minSellScore) outSide = 'hold';

  return {
    agentId: 'risk-agent',
    agentName: '리스크 에이전트',
    role: 'risk',
    side: outSide,
    score: round(Math.max(0, adj), 1),
    note: notes.length ? notes.join('; ') : '리스크 게이트 통과',
  };
}

/**
 * Mixture of Agents:
 * 1) 제안 에이전트 3인(기술/펀더/모멘텀) → MoE 기반
 * 2) 악마의 변호인 항상 점검
 * 3) 리스크 에이전트 게이트
 * 4) 집계 에이전트가 최종 결정
 */
export function runMixtureOfAgents(
  research: ResearchBundle,
  mode: ModeProfile,
  heldShares: number,
): MoADecision {
  // Layer-0: MoE 전문가 앙상블
  const moe = runMixtureOfExperts(research, mode, heldShares);

  // Layer-1: 독립 렌즈 제안 에이전트 3인 (피처 분리)
  const proposers: AgentOpinion[] = [
    independentProposer('tech-proposer', '기술 제안', research, 'technical'),
    independentProposer('fund-proposer', '펀더 제안', research, 'fundamental'),
    independentProposer('tape-proposer', '수급 제안', research, 'flow'),
  ];

  let buyW = 0;
  let sellW = 0;
  let holdW = 0;
  for (const p of proposers) {
    if (p.side === 'buy') buyW += p.score;
    else if (p.side === 'sell') sellW += p.score;
    else holdW += p.score;
  }

  // MoE는 보조 가중 (제안자 과반이 우선)
  buyW += moe.buyScore * 0.65 * (0.5 + moe.agreement);
  sellW += moe.sellScore * 0.65 * (0.5 + moe.agreement);
  holdW += moe.holdScore * 0.8;

  let draftSide: ExpertSide = 'hold';
  let draftScore = moe.holdScore;
  if (buyW >= sellW && buyW >= holdW) {
    draftSide = 'buy';
    const n = Math.max(1, proposers.filter((p) => p.side === 'buy').length);
    draftScore = proposers.filter((p) => p.side === 'buy').reduce((s, p) => s + p.score, 0) / n;
    draftScore = draftScore * 0.6 + moeSupportSide(moe, 'buy') * 0.4;
  } else if (sellW > buyW && sellW >= holdW) {
    draftSide = 'sell';
    const n = Math.max(1, proposers.filter((p) => p.side === 'sell').length);
    draftScore = proposers.filter((p) => p.side === 'sell').reduce((s, p) => s + p.score, 0) / n;
    draftScore = draftScore * 0.6 + moeSupportSide(moe, 'sell') * 0.4;
  }

  // 제안자 과반이 아니면 관망으로 강등 (가짜 합의 방지)
  const majority = proposers.filter((p) => p.side === draftSide).length >= 2;
  if (draftSide !== 'hold' && !majority) {
    draftSide = 'hold';
    draftScore = Math.max(moe.holdScore, 45);
  }

  // 보유 없으면 sell 금지
  if (draftSide === 'sell' && heldShares <= 0) {
    draftSide = 'hold';
    draftScore = Math.max(draftScore * 0.7, moe.holdScore);
  }

  const lv = levels(research, draftSide, mode);

  // Always: devil's advocate
  const devil: DevilResult = runDevilAdvocate(research, {
    side: draftSide,
    score: draftScore,
    agreement: moe.agreement,
    entry: lv.entry,
    target: lv.target,
    stop: lv.stop,
    rewardRisk: lv.rewardRisk,
    thesis: moe.thesis,
  });

  const critic: AgentOpinion = {
    agentId: 'devil-advocate',
    agentName: '악마의 변호인',
    role: 'critic',
    side: devil.veto ? 'hold' : draftSide,
    score: round(Math.max(0, draftScore * (1 - devil.riskPenalty)), 1),
    note: devil.summary,
  };

  let afterDevilSide: ExpertSide = devil.veto ? 'hold' : draftSide;
  let afterDevilScore = critic.score;

  // Risk agent
  const risk = riskAgent(
    research,
    afterDevilSide,
    afterDevilScore,
    lv.rewardRisk,
    mode,
    heldShares,
  );

  // Aggregator
  let finalSide: ExpertSide = risk.side;
  let finalScore = risk.score;

  // MoA 합의: 제안자 과반 + MoE 동의 + 악마 비토 없음일 때만 공격적 유지
  const proposerAgree =
    proposers.filter((p) => p.side === draftSide).length >= 2 && moe.consensusSide === draftSide;

  if (!proposerAgree && finalSide !== 'hold') {
    finalScore -= 8;
    if (
      (finalSide === 'buy' && finalScore < mode.minBuyScore) ||
      (finalSide === 'sell' && finalScore < mode.minSellScore)
    ) {
      finalSide = 'hold';
    }
  }

  if (devil.veto) finalSide = 'hold';

  // mode thresholds
  if (finalSide === 'buy' && finalScore < mode.minBuyScore) finalSide = 'hold';
  if (finalSide === 'sell' && finalScore < mode.minSellScore) finalSide = 'hold';
  if (finalSide === 'sell' && heldShares <= 0) finalSide = 'hold';

  const finalLevels = levels(research, finalSide, mode);
  const sizeFactor = round(
    Math.max(0.35, 1 - devil.riskPenalty - (moe.agreement < 0.5 ? 0.15 : 0)),
    2,
  );

  const confidence = round(
    Math.min(
      0.95,
      Math.max(
        0.15,
        (moe.agreement * 0.55 + Math.min(finalScore, 100) / 100 * 0.45) * (1 - devil.riskPenalty * 0.5),
      ),
    ),
    2,
  );

  const aggregator: AgentOpinion = {
    agentId: 'aggregator',
    agentName: '집계 에이전트',
    role: 'aggregator',
    side: finalSide,
    score: round(finalScore, 1),
    note: `MoA 최종 ${finalSide} · 신뢰도 ${(confidence * 100).toFixed(0)}% · 사이징×${sizeFactor}`,
  };

  const agentOpinions = [...proposers, critic, risk, aggregator];
  const passedGate = finalSide === 'buy' || finalSide === 'sell';

  const thesisParts = [
    moe.thesis,
    devil.summary,
    aggregator.note,
  ];

  return {
    side: finalSide === 'hold' ? 'hold' : finalSide,
    score: round(finalScore, 1),
    confidence,
    thesis: thesisParts.join(' / '),
    entry: finalLevels.entry,
    target: finalLevels.target,
    stop: finalLevels.stop,
    rewardRisk: finalLevels.rewardRisk,
    sizeFactor,
    expertVotes: moe.votes,
    agentOpinions,
    devilAdvocate: devil.challenges,
    devilSummary: devil.summary,
    moaSummary: `제안 ${proposers.map((p) => p.side[0]).join('')}` +
      ` → 악마${devil.veto ? '거부' : '통과'} → 리스크 ${risk.side} → 최종 ${finalSide}`,
    passedGate,
  };
}
