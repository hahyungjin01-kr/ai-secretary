import type { ResearchBundle } from './types.js';
import type { DailyAlert } from './store.js';
import { runDevilAdvocate } from './devilAdvocate.js';
import type { ModeProfile } from './modes.js';

export type GateSide = 'allow' | 'deny' | 'caution';

export interface PretradeExpertVote {
  expertId: string;
  expertName: string;
  side: GateSide;
  score: number;
  weight: number;
  reasons: string[];
}

export interface PretradeMoAResult {
  allow: boolean;
  /** 장외 등 재분석으로도 못 푸는 거부 */
  hardDeny: boolean;
  /** 재분석 MoA로 고치면 통과 가능한 거부 */
  revisable: boolean;
  summary: string;
  votes: PretradeExpertVote[];
  agentNotes: string[];
  adjustedPrice: number;
  sizeFactor: number;
  blockReasons: string[];
  reviseReasons: string[];
}

function isKrSymbol(symbol: string): boolean {
  return /^[0-9]{6}$/.test(symbol) || (/^[0-9A-Z]{6}$/.test(symbol) && /\d/.test(symbol));
}

/** KST 기준 한국 정규장 (버퍼 포함 08:50–15:35) */
export function isKrCashSession(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 8 * 60 + 50 && mins <= 15 * 60 + 35;
}

/** 미국 정규장 대략 (America/New_York 09:30–16:00, 주말 제외) */
export function isUsCashSession(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function sessionExpert(symbol: string): PretradeExpertVote {
  const kr = isKrSymbol(symbol);
  const open = kr ? isKrCashSession() : isUsCashSession();
  if (open) {
    return {
      expertId: 'session',
      expertName: '장운영',
      side: 'allow',
      score: 80,
      weight: 1.4,
      reasons: [kr ? '한국 정규장 시간' : '미국 정규장 시간'],
    };
  }
  return {
    expertId: 'session',
    expertName: '장운영',
    side: 'deny',
    score: 95,
    weight: 1.6,
    reasons: [kr ? '한국 장외/휴장 — 시장가 주문 위험' : '미국 장외/휴장 — 시장가 주문 위험'],
  };
}

function driftExpert(alert: DailyAlert, research: ResearchBundle): PretradeExpertVote {
  const base = alert.entry || alert.researchSummary.price;
  const px = research.price;
  if (!(base > 0) || !(px > 0)) {
    return {
      expertId: 'drift',
      expertName: '가격괴리',
      side: 'deny',
      score: 90,
      weight: 1.3,
      reasons: ['유효 가격 없음'],
    };
  }
  const drift = Math.abs(px - base) / base;
  if (drift >= 0.03) {
    return {
      expertId: 'drift',
      expertName: '가격괴리',
      side: 'deny',
      score: 92,
      weight: 1.4,
      reasons: [`제안가 대비 ${(drift * 100).toFixed(1)}% 변동 — 재분석 필요`],
    };
  }
  if (drift >= 0.015) {
    return {
      expertId: 'drift',
      expertName: '가격괴리',
      side: 'caution',
      score: 70,
      weight: 1.1,
      reasons: [`가격 ${(drift * 100).toFixed(1)}% 변동 — 수량 축소`],
    };
  }
  return {
    expertId: 'drift',
    expertName: '가격괴리',
    side: 'allow',
    score: 75,
    weight: 1,
    reasons: [`괴리 ${(drift * 100).toFixed(2)}% 허용`],
  };
}

function capitalExpert(
  alert: DailyAlert,
  cash: number,
  buyingPower: number | null,
): PretradeExpertVote {
  const need = alert.suggestedAmount;
  const bp = buyingPower != null && buyingPower > 0 ? buyingPower : cash;
  if (alert.side === 'sell') {
    return {
      expertId: 'capital',
      expertName: '자금',
      side: 'allow',
      score: 70,
      weight: 1.1,
      reasons: ['매도는 보유 수량 기준으로 재검증'],
    };
  }
  if (need > bp) {
    return {
      expertId: 'capital',
      expertName: '자금',
      side: 'deny',
      score: 95,
      weight: 1.5,
      reasons: [`필요 ${Math.round(need)} > 매수가능 ${Math.round(bp)}`],
    };
  }
  if (need > bp * 0.9) {
    return {
      expertId: 'capital',
      expertName: '자금',
      side: 'caution',
      score: 65,
      weight: 1.2,
      reasons: ['매수가능 대비 비중이 큼 — 축소 권고'],
    };
  }
  return {
    expertId: 'capital',
    expertName: '자금',
    side: 'allow',
    score: 78,
    weight: 1.2,
    reasons: [`매수가능 여유 ${Math.round(bp - need)}`],
  };
}

function devilExpert(
  alert: DailyAlert,
  research: ResearchBundle,
  mode: ModeProfile,
): PretradeExpertVote {
  const devil = runDevilAdvocate(research, {
    side: alert.side,
    score: alert.score,
    agreement: alert.confidence ?? 0.5,
    entry: research.price,
    target: alert.target,
    stop: alert.stop,
    rewardRisk:
      alert.side === 'buy' && research.price > alert.stop
        ? (alert.target - research.price) / Math.max(0.01, research.price - alert.stop)
        : 1.5,
    thesis: alert.thesis,
  });

  const storedHigh = (alert.devilChallenges ?? []).filter((c) => c.severity === 'high').length;
  const high = Math.max(
    storedHigh,
    devil.challenges.filter((c) => c.severity === 'high').length,
  );

  if (devil.veto || high >= 3) {
    return {
      expertId: 'devil',
      expertName: '악마의변호인',
      side: 'deny',
      score: 96,
      weight: 1.7,
      reasons: [devil.summary, `고위험 반박 ${high}건`, `모드 ${mode.label}`],
    };
  }
  if (high >= 2 || devil.riskPenalty >= 0.25) {
    return {
      expertId: 'devil',
      expertName: '악마의변호인',
      side: 'caution',
      score: 72,
      weight: 1.4,
      reasons: [devil.summary, '고위험 다수 — 사이징 축소'],
    };
  }
  return {
    expertId: 'devil',
    expertName: '악마의변호인',
    side: 'allow',
    score: 60,
    weight: 1.2,
    reasons: [devil.summary],
  };
}

function dataExpert(research: ResearchBundle): PretradeExpertVote {
  if (research.dataWarnings.length >= 3) {
    return {
      expertId: 'data',
      expertName: '데이터품질',
      side: 'deny',
      score: 90,
      weight: 1.3,
      reasons: research.dataWarnings.slice(0, 3),
    };
  }
  if (research.dataWarnings.length > 0) {
    return {
      expertId: 'data',
      expertName: '데이터품질',
      side: 'caution',
      score: 65,
      weight: 1,
      reasons: research.dataWarnings.slice(0, 2),
    };
  }
  return {
    expertId: 'data',
    expertName: '데이터품질',
    side: 'allow',
    score: 70,
    weight: 0.9,
    reasons: ['경고 없음'],
  };
}

function confidenceExpert(alert: DailyAlert): PretradeExpertVote {
  const c = alert.confidence ?? 0;
  if (c < 0.35) {
    return {
      expertId: 'confidence',
      expertName: '신뢰도',
      side: 'deny',
      score: 88,
      weight: 1.3,
      reasons: [`MoA 신뢰도 ${(c * 100).toFixed(0)}% 미달`],
    };
  }
  if (c < 0.5) {
    return {
      expertId: 'confidence',
      expertName: '신뢰도',
      side: 'caution',
      score: 68,
      weight: 1.1,
      reasons: [`신뢰도 ${(c * 100).toFixed(0)}% — 축소`],
    };
  }
  return {
    expertId: 'confidence',
    expertName: '신뢰도',
    side: 'allow',
    score: 74,
    weight: 1,
    reasons: [`신뢰도 ${(c * 100).toFixed(0)}%`],
  };
}

/** 재분석으로 해결 불가한 전문가 (장운영) */
const HARD_DENY_EXPERTS = new Set(['session']);

/**
 * 사전거래 MoE → MoA 집계.
 * - hard deny(장외): 주문 불가
 * - revisable deny: 중단하지 말고 분석 MoA 재실행으로 허용안 모색
 * - caution: 사이징 축소
 */
export function runPretradeMoA(input: {
  alert: DailyAlert;
  research: ResearchBundle;
  mode: ModeProfile;
  cash: number;
  buyingPower: number | null;
}): PretradeMoAResult {
  const votes: PretradeExpertVote[] = [
    sessionExpert(input.alert.symbol),
    driftExpert(input.alert, input.research),
    capitalExpert(input.alert, input.cash, input.buyingPower),
    devilExpert(input.alert, input.research, input.mode),
    dataExpert(input.research),
    confidenceExpert(input.alert),
  ];

  const denies = votes.filter((v) => v.side === 'deny');
  const cautions = votes.filter((v) => v.side === 'caution');
  const hardDenies = denies.filter((v) => HARD_DENY_EXPERTS.has(v.expertId));
  const softDenies = denies.filter((v) => !HARD_DENY_EXPERTS.has(v.expertId));

  let sizeFactor = 1;
  for (const c of cautions) {
    sizeFactor *= c.expertId === 'devil' || c.expertId === 'drift' ? 0.7 : 0.85;
  }
  for (const d of softDenies) {
    sizeFactor *= d.expertId === 'capital' ? 0.6 : 0.55;
  }
  sizeFactor = Math.max(0.25, Math.round(sizeFactor * 100) / 100);

  const hardDeny = hardDenies.length > 0;
  const revisable = !hardDeny && softDenies.length > 0;
  const allow = denies.length === 0;
  const blockReasons = denies.flatMap((d) => d.reasons);
  const reviseReasons = softDenies.flatMap((d) => d.reasons);

  const agentNotes = [
    `장운영 에이전트: ${votes.find((v) => v.expertId === 'session')?.side}`,
    `리스크 에이전트: hard ${hardDenies.length} / soft-deny ${softDenies.length} / caution ${cautions.length}`,
    hardDeny
      ? '집계 에이전트: 하드 차단 (재분석 불가)'
      : revisable
        ? '집계 에이전트: 재분석 MoA로 허용안 모색'
        : cautions.length
          ? '집계 에이전트: 주의·축소 허용'
          : '집계 에이전트: 허용',
  ];

  let summary: string;
  if (allow) {
    summary = `사전거래 MoA 통과${cautions.length ? ` (주의 ${cautions.length}·사이징×${sizeFactor})` : ''}`;
  } else if (hardDeny) {
    summary = `사전거래 하드 차단: ${blockReasons.slice(0, 2).join(' / ')}`;
  } else {
    summary = `사전거래 soft-deny → 분석 MoA 재실행 필요: ${reviseReasons.slice(0, 2).join(' / ')}`;
  }

  return {
    allow,
    hardDeny,
    revisable,
    summary,
    votes,
    agentNotes,
    adjustedPrice: input.research.price,
    sizeFactor,
    blockReasons,
    reviseReasons,
  };
}
