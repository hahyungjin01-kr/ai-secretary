import type { ResearchBundle, DevilChallenge } from './types.js';
import type { ModeProfile } from './modes.js';
import {
  runMixtureOfExperts,
  type ExpertSide,
  type ExpertVote,
  type MoEResult,
} from './moe.js';
import { runDevilAdvocate, type DevilResult } from './devilAdvocate.js';

export interface AgentOpinion {
  agentId: string;
  agentName: string;
  role: 'proposer' | 'critic' | 'risk' | 'aggregator';
  side: ExpertSide;
  score: number;
  note: string;
}

/** deny/caution 피드백으로 분석 MoA를 다시 돌릴 때 힌트 */
export interface MoARevisionHints {
  round: number;
  reasons: string[];
  /** 사이징을 더 줄이도록 강제 */
  forceSizeFactor?: number;
  /** 악마 비토를 축소 매수로 완화 시도 */
  softenDevilVeto?: boolean;
  /** 신뢰도 하한을 낮춰 보수 제안 허용 */
  relaxConfidenceFloor?: number;
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
  revisionRound?: number;
  revisionNotes?: string[];
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
  hints?: MoARevisionHints,
): MoADecision {
  const revisionRound = hints?.round ?? 0;
  const revisionNotes = hints?.reasons?.length
    ? [`재분석 #${revisionRound}: ${hints.reasons.slice(0, 3).join(' / ')}`]
    : [];

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

  // 재분석 라운드에서는 비토를 즉시 hold로 끝내지 않고, 축소·재설계로 허용안을 만든다
  const soften = Boolean(hints?.softenDevilVeto && devil.veto && draftSide !== 'hold');
  const critic: AgentOpinion = {
    agentId: 'devil-advocate',
    agentName: '악마의 변호인',
    role: 'critic',
    side: devil.veto && !soften ? 'hold' : draftSide,
    score: round(Math.max(0, draftScore * (1 - devil.riskPenalty) * (soften ? 0.85 : 1)), 1),
    note: soften
      ? `${devil.summary} → 재분석: 거부 대신 축소 허용안 설계`
      : devil.summary,
  };

  let afterDevilSide: ExpertSide = devil.veto && !soften ? 'hold' : draftSide;
  let afterDevilScore = critic.score;
  if (soften) revisionNotes.push('악마 비토를 축소 매수 허용안으로 전환');

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

  if (devil.veto && !soften) finalSide = 'hold';

  // 재분석 시 임계를 소폭 완화해 "허용 가능한 보수안"을 찾는다
  const buyFloor = revisionRound > 0 ? mode.minBuyScore - 6 : mode.minBuyScore;
  const sellFloor = revisionRound > 0 ? mode.minSellScore - 4 : mode.minSellScore;
  if (finalSide === 'buy' && finalScore < buyFloor) finalSide = 'hold';
  if (finalSide === 'sell' && finalScore < sellFloor) finalSide = 'hold';
  if (finalSide === 'sell' && heldShares <= 0) finalSide = 'hold';

  // soft veto 후 점수가 낮으면 매수로 유지하되 사이즈만 강하게 축소
  if (soften && finalSide === 'hold' && draftSide === 'buy' && afterDevilScore >= buyFloor - 4) {
    finalSide = 'buy';
    finalScore = Math.max(afterDevilScore, buyFloor);
    revisionNotes.push('집계: hold 대신 축소 매수안 채택');
  }

  const finalLevels = levels(research, finalSide, mode);
  let sizeFactor = round(
    Math.max(0.25, 1 - devil.riskPenalty - (moe.agreement < 0.5 ? 0.15 : 0)),
    2,
  );
  if (hints?.forceSizeFactor != null) {
    sizeFactor = round(Math.min(sizeFactor, hints.forceSizeFactor), 2);
  }
  if (soften) sizeFactor = round(Math.min(sizeFactor, 0.45), 2);
  if (revisionRound > 0) {
    sizeFactor = round(Math.min(sizeFactor, Math.max(0.25, 0.7 - revisionRound * 0.15)), 2);
  }

  let confidence = round(
    Math.min(
      0.95,
      Math.max(
        0.15,
        (moe.agreement * 0.55 + (Math.min(finalScore, 100) / 100) * 0.45) *
          (1 - devil.riskPenalty * 0.5),
      ),
    ),
    2,
  );
  if (hints?.relaxConfidenceFloor != null && confidence < hints.relaxConfidenceFloor) {
    // 재분석 보수안: 신뢰도 바닥을 힌트 수준까지 보정(과신 방지용 상한 유지)
    confidence = round(Math.min(hints.relaxConfidenceFloor, 0.55), 2);
    revisionNotes.push(`신뢰도 바닥 보정 → ${(confidence * 100).toFixed(0)}%`);
  }

  const aggregator: AgentOpinion = {
    agentId: 'aggregator',
    agentName: '집계 에이전트',
    role: 'aggregator',
    side: finalSide,
    score: round(finalScore, 1),
    note: `MoA 최종 ${finalSide} · 신뢰도 ${(confidence * 100).toFixed(0)}% · 사이징×${sizeFactor}${
      revisionRound ? ` · 재분석#${revisionRound}` : ''
    }`,
  };

  const agentOpinions = [...proposers, critic, risk, aggregator];
  const passedGate = finalSide === 'buy' || finalSide === 'sell';

  const thesisParts = [moe.thesis, critic.note, aggregator.note, ...revisionNotes];

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
    devilSummary: soften ? `${devil.summary} (재분석으로 축소 허용 시도)` : devil.summary,
    moaSummary:
      `제안 ${proposers.map((p) => p.side[0]).join('')}` +
      ` → 악마${devil.veto ? (soften ? '완화' : '거부') : '통과'} → 리스크 ${risk.side} → 최종 ${finalSide}` +
      (revisionRound ? ` · 재분석#${revisionRound}` : ''),
    passedGate,
    revisionRound,
    revisionNotes,
  };
}

export interface AnalysisAllowResult {
  decision: MoADecision;
  rounds: number;
  history: string[];
}

/**
 * deny/실패 시 중단하지 않고, 피드백을 넣어 분석 MoA를 최대 maxRounds회 재실행해
 * 허용 가능한 안(passedGate)을 찾는다.
 */
export function runAnalysisUntilAllowable(
  research: ResearchBundle,
  mode: ModeProfile,
  heldShares: number,
  maxRounds = 3,
): AnalysisAllowResult {
  const history: string[] = [];
  let hints: MoARevisionHints | undefined;
  let last = runMixtureOfAgents(research, mode, heldShares);

  for (let round = 0; round < maxRounds; round++) {
    if (last.passedGate && last.side !== 'hold') {
      history.push(`round ${round}: 허용안 확보 (${last.moaSummary})`);
      return { decision: last, rounds: round + 1, history };
    }

    const reasons: string[] = [];
    if (!last.passedGate || last.side === 'hold') {
      reasons.push('집계 결과가 hold/미통과');
    }
    if (last.devilSummary.includes('거부')) reasons.push(last.devilSummary);
    if (last.confidence < 0.35) reasons.push(`신뢰도 낮음 ${(last.confidence * 100).toFixed(0)}%`);
    if (last.sizeFactor < 0.4) reasons.push(`사이징 과소 ×${last.sizeFactor}`);
    for (const n of last.revisionNotes ?? []) reasons.push(n);

    history.push(`round ${round}: 미허용 → 재분석 예약 (${reasons.slice(0, 2).join(' / ')})`);

    hints = {
      round: round + 1,
      reasons,
      forceSizeFactor: Math.max(0.25, 0.55 - round * 0.12),
      softenDevilVeto: true,
      relaxConfidenceFloor: 0.38 + round * 0.04,
    };
    last = runMixtureOfAgents(research, mode, heldShares, hints);
  }

  if (last.passedGate && last.side !== 'hold') {
    history.push(`final: 허용안 확보 (${last.moaSummary})`);
  } else {
    history.push(`final: ${maxRounds}회 재분석 후에도 허용안 없음`);
  }
  return { decision: last, rounds: maxRounds, history };
}
