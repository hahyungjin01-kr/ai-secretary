import type { ResearchBundle, DevilChallenge } from './types.js';
import type { ModeProfile } from './modes.js';
import { runMixtureOfExperts, type ExpertVote, type ExpertSide, type MoEResult } from './moe.js';
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

/** Proposer agent: MoE를 특정 전문가 가중으로 재해석 */
function proposerFromVotes(
  agentId: string,
  agentName: string,
  moe: MoEResult,
  preferExpertIds: string[],
): AgentOpinion {
  const preferred = moe.votes.filter((v) => preferExpertIds.includes(v.expertId));
  const pool = preferred.length > 0 ? preferred : moe.votes;
  const buy = pool.filter((v) => v.side === 'buy');
  const sell = pool.filter((v) => v.side === 'sell');
  const hold = pool.filter((v) => v.side === 'hold');

  const scoreOf = (arr: ExpertVote[]) =>
    arr.length === 0
      ? 0
      : arr.reduce((s, v) => s + v.score * v.weight, 0) / arr.reduce((s, v) => s + v.weight, 0);

  const buyS = scoreOf(buy);
  const sellS = scoreOf(sell);
  const holdS = scoreOf(hold) || 45;

  let side: ExpertSide = 'hold';
  let score = holdS;
  if (buyS >= sellS && buyS >= holdS && buyS >= 52) {
    side = 'buy';
    score = buyS;
  } else if (sellS > buyS && sellS >= holdS && sellS >= 52) {
    side = 'sell';
    score = sellS;
  }

  return {
    agentId,
    agentName,
    role: 'proposer',
    side,
    score: round(score, 1),
    note: `${agentName} 제안: ${side} (${score.toFixed(0)})`,
  };
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
  // Layer-0: shared MoE feature votes
  const moe = runMixtureOfExperts(research, mode, heldShares);

  // Layer-1 proposers (MoA)
  const proposers: AgentOpinion[] = [
    proposerFromVotes('tech-proposer', '기술 제안', moe, ['technical', 'momentum']),
    proposerFromVotes('fund-proposer', '펀더 제안', moe, ['valuation', 'news']),
    proposerFromVotes('tape-proposer', '수급 제안', moe, ['momentum', 'risk', 'news']),
  ];

  // Soft vote among proposers
  let buyW = 0;
  let sellW = 0;
  let holdW = 0;
  for (const p of proposers) {
    if (p.side === 'buy') buyW += p.score;
    else if (p.side === 'sell') sellW += p.score;
    else holdW += p.score;
  }

  // Blend with MoE consensus
  buyW += moe.buyScore * (1 + moe.agreement);
  sellW += moe.sellScore * (1 + moe.agreement);
  holdW += moe.holdScore;

  let draftSide: ExpertSide = 'hold';
  let draftScore = moe.holdScore;
  if (buyW >= sellW && buyW >= holdW) {
    draftSide = 'buy';
    const n = Math.max(1, proposers.filter((p) => p.side === 'buy').length);
    draftScore = (moe.buyScore * 0.55 + buyW / (n + 1) * 0.45);
  } else if (sellW > buyW && sellW >= holdW) {
    draftSide = 'sell';
    const n = Math.max(1, proposers.filter((p) => p.side === 'sell').length);
    draftScore = (moe.sellScore * 0.55 + sellW / (n + 1) * 0.45);
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
