import type { DevilChallenge, ResearchBundle } from './types.js';
import type { ExpertSide } from './moe.js';

export interface DevilInput {
  side: ExpertSide;
  score: number;
  agreement: number;
  entry: number;
  target: number;
  stop: number;
  rewardRisk: number;
  thesis: string;
}

export interface DevilResult {
  challenges: DevilChallenge[];
  /** 0–1, 높을수록 제안이 위험/의약 */
  riskPenalty: number;
  /** true면 매수/매도를 관망으로 강등 권고 */
  veto: boolean;
  summary: string;
}

/**
 * 악마의 변호인: 분석 결론을 항상 반박·스트레스 테스트.
 */
export function runDevilAdvocate(
  research: ResearchBundle,
  draft: DevilInput,
): DevilResult {
  const challenges: DevilChallenge[] = [];

  challenges.push({
    id: 'public-info',
    claim: '시세·뉴스·지표를 잘 모으면 초과수익이 난다',
    counter:
      '공개 정보는 이미 가격에 반영됐을 수 있다. 이 분석은 보조일 뿐 알파를 보장하지 않는다.',
    severity: 'high',
  });

  if (draft.side === 'buy') {
    challenges.push({
      id: 'catching-knife',
      claim: '과매도/하락이면 반등한다',
      counter: '추가 하락·가치함정·실적 쇼크가 가능. 손절이 깨지면 가설을 즉시 폐기하라.',
      severity: 'high',
    });
  }

  if (draft.side === 'sell') {
    challenges.push({
      id: 'selling-winner',
      claim: '과열이면 반드시 돌려야 한다',
      counter: '강한 추세에서는 과열이 더 갈 수 있다. 전량보다 분할 축소가 나을 수 있다.',
      severity: 'medium',
    });
  }

  if (draft.agreement < 0.55) {
    challenges.push({
      id: 'weak-consensus',
      claim: '전문가 혼합 점수가 있으니 진입해도 된다',
      counter: `MoE 합의 ${(draft.agreement * 100).toFixed(0)}%로 낮다. 의견 분열 시에는 관망이 기본값이다.`,
      severity: 'high',
    });
  }

  if (draft.rewardRisk > 0 && draft.rewardRisk < 1.3) {
    challenges.push({
      id: 'poor-rr',
      claim: '손절만 있으면 된다',
      counter: `손익비 ${draft.rewardRisk}는 얇다. 체결 슬리피지·갭을 감안하면 기대값이 더 나빠질 수 있다.`,
      severity: 'high',
    });
  }

  if (research.trailingPE != null && research.trailingPE > 35 && draft.side === 'buy') {
    challenges.push({
      id: 'valuation',
      claim: `고PER(${research.trailingPE})도 성장으로 정당화된다`,
      counter: '성장 가정이 틀릴 때의 낙폭을 먼저 수치화하라. 금리·가이던스에 민감하다.',
      severity: 'medium',
    });
  }

  if (research.news.length === 0) {
    challenges.push({
      id: 'news-gap',
      claim: '차트만으로 진입 가능하다',
      counter: '이벤트·공시 공백은 미확인 리스크다. 촉매 없는 매수는 비중을 줄이거나 건너뛰라.',
      severity: 'medium',
    });
  } else {
    challenges.push({
      id: 'news-lag',
      claim: '헤드라인이 곧 촉매다',
      counter: `"${research.news[0].title.slice(0, 60)}" 는 이미 반영됐을 수 있다. 속보 추격을 경계하라.`,
      severity: 'medium',
    });
  }

  if (research.dataWarnings.length > 0) {
    challenges.push({
      id: 'data-quality',
      claim: '데이터가 있으니 신뢰할 수 있다',
      counter: `데이터 경고: ${research.dataWarnings.slice(0, 2).join(' / ')}. 입력 품질이 낮으면 결론도 약하다.`,
      severity: 'high',
    });
  }

  if (research.volumeRatio != null && research.volumeRatio < 0.5 && draft.side === 'buy') {
    challenges.push({
      id: 'liquidity',
      claim: '가격이 싸면 사도 된다',
      counter: '거래량 부진 구간 매수는 체결·청산이 어렵다. 유동성 리스크를 먼저 보라.',
      severity: 'medium',
    });
  }

  challenges.push({
    id: 'human-gate',
    claim: 'AI가 합의했으니 바로 주문해도 된다',
    counter: '최종 매수는 사용자 허락 후에만. 모델 합의도 틀렸을 수 있다.',
    severity: 'high',
  });

  const high = challenges.filter((c) => c.severity === 'high').length;
  const medium = challenges.filter((c) => c.severity === 'medium').length;
  let riskPenalty = Math.min(0.55, high * 0.1 + medium * 0.05);

  if (draft.agreement < 0.45) riskPenalty += 0.12;
  if (draft.score < 50) riskPenalty += 0.08;

  // 강한 비토: 고위험 다수·합의 약함·데이터 불량·손익비 부실
  const veto =
    draft.side !== 'hold' &&
    (high >= 3 ||
      (draft.agreement < 0.5 && high >= 2) ||
      (research.dataWarnings.length >= 2 && draft.side === 'buy' && draft.agreement < 0.6) ||
      (draft.rewardRisk > 0 && draft.rewardRisk < 1.2) ||
      (draft.score < 48 && draft.side === 'buy'));

  const summary = veto
    ? `악마의 변호인: 진입 거부 (고위험 ${high}건 · 합의 ${(draft.agreement * 100).toFixed(0)}%).`
    : `악마의 변호인: 점검 ${challenges.length}건 · 페널티 ${(riskPenalty * 100).toFixed(0)}%p.`;

  return {
    challenges: challenges.slice(0, 7),
    riskPenalty: Math.round(riskPenalty * 100) / 100,
    veto,
    summary,
  };
}
