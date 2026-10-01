import type { DevilChallenge, ResearchBundle, TradePlan } from './types.js';

/**
 * 악마의 변호인: "조사=알파", "시나리오=확률", "손절=지킨다" 가정을 깨뜨린다.
 */
export function runDevilAdvocate(
  research: ResearchBundle,
  plan: TradePlan,
): DevilChallenge[] {
  const challenges: DevilChallenge[] = [];

  challenges.push({
    id: 'efficiency',
    claim: '조사와 지표를 잘 모으면 초과수익이 난다',
    counter:
      '공개 시세·뉴스·RSI는 이미 널리 반영된 정보일 수 있다. 이 리포트는 의사결정 보조일 뿐 알파 보장이 아니다.',
    severity: 'high',
  });

  challenges.push({
    id: 'rule-overconfidence',
    claim: `규칙 엔진이 ${plan.bias.toUpperCase()} 편향을 제시했다`,
    counter:
      '규칙 기반 편향은 과적합·후행지표 함정이 있다. 백테스트/벤치마크 비교 없이 비중을 키우지 마라.',
    severity: 'high',
  });

  if (plan.bias === 'buy') {
    challenges.push({
      id: 'value-trap-or-momentum',
      claim: '과매도/하단 근접이면 반등한다',
      counter:
        '추가 하락·가치함정·실적 쇼크가 가능. 손절이 깨지면 물타기 금지, 가설 폐기 우선.',
      severity: 'high',
    });
  }

  if (research.trailingPE != null && research.trailingPE > 30) {
    challenges.push({
      id: 'valuation',
      claim: `PER ${research.trailingPE}도 성장으로 정당화된다`,
      counter:
        '고멀티플은 금리·가이던스 미스에 민감. 성장 가정이 틀릴 때의 낙폭을 먼저 수치화하라.',
      severity: 'medium',
    });
  }

  if (research.news.length === 0) {
    challenges.push({
      id: 'news-gap',
      claim: '뉴스가 없어도 차트만으로 진입 가능하다',
      counter:
        '이벤트·공시 공백은 미확인 리스크다. 촉매 없는 진입은 관망 쪽으로 무게를 옮겨라.',
      severity: 'medium',
    });
  } else {
    challenges.push({
      id: 'news-lag',
      claim: '헤드라인이 곧 촉매다',
      counter: `최신 헤드라인("${research.news[0].title}")은 이미 가격에 반영됐을 수 있다. 속보 추격 매수를 경계하라.`,
      severity: 'medium',
    });
  }

  if (plan.positionSizeShares > 0 && plan.maxLossPercentOfCapital > 2) {
    challenges.push({
      id: 'sizing',
      claim: '손절만 있으면 비중은 공격해도 된다',
      counter:
        '손절 미체결·갭하락·감정 붕괴로 실제 손실이 한도를 넘을 수 있다. 비중을 더 줄여라.',
      severity: 'high',
    });
  }

  challenges.push({
    id: 'human-gate',
    claim: 'AI가 정리했으니 바로 주문해도 된다',
    counter:
      '캡션/설계 원칙: AI는 검토만, 최종 판단과 주문은 사람. 자동매매 실행 경로는 의도적으로 비활성화되어 있다.',
    severity: 'high',
  });

  return challenges.slice(0, 6);
}
