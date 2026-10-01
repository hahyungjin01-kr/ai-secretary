import { buildTradePlan } from './analysis.js';
import { runDevilAdvocate } from './devilAdvocate.js';
import { getMode, type InvestorMode } from './modes.js';
import { collectResearch } from './research.js';
import type { DevilChallenge, ResearchBundle, TradePlan } from './types.js';

export type UserAction = 'buy' | 'sell';
export type DecisionStatus = 'approve' | 'watch' | 'reject';

export interface ActionReviewResult {
  modeId: InvestorMode;
  modeLabel: string;
  action: UserAction;
  amount: number;
  research: ResearchBundle;
  plan: TradePlan;
  checks: { item: string; ok: boolean; note: string }[];
  decision: DecisionStatus;
  decisionReason: string;
  devilAdvocate: DevilChallenge[];
  humanGate: {
    required: true;
    message: string;
    autoTradeEnabled: false;
  };
  disclaimer: string;
}

function round(n: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

export async function reviewUserAction(input: {
  mode: string;
  symbol: string;
  capital: number;
  action: UserAction;
  amount: number;
  holdingAmount?: number;
}): Promise<ActionReviewResult> {
  const mode = getMode(input.mode);
  const amount = Number(input.amount);
  const capital = Number(input.capital);
  const holdingAmount = Number(input.holdingAmount ?? 0);
  const action = input.action;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('금액은 0보다 커야 합니다.');
  }
  if (!Number.isFinite(capital) || capital <= 0) {
    throw new Error('계좌 금액이 필요합니다.');
  }

  const research = await collectResearch(input.symbol);
  const plan = buildTradePlan(research, capital, mode.riskPercent, mode);
  const checks: ActionReviewResult['checks'] = [];

  const maxBuy = round((capital * mode.maxBuyPercent) / 100);
  const amountPct = round((amount / capital) * 100, 2);

  if (action === 'buy') {
    checks.push({
      item: '모드 매수 한도',
      ok: amount <= maxBuy + 0.01,
      note: `입력 ${amount.toLocaleString()} / 한도 ${maxBuy.toLocaleString()} (${mode.maxBuyPercent}% of capital)`,
    });
    checks.push({
      item: '신호와 방향 일치',
      ok: plan.bias !== 'avoid',
      note:
        plan.bias === 'avoid'
          ? 'AI 편향이 회피인데 매수 금액이 들어옴'
          : `현재 편향: ${plan.bias}`,
    });
    checks.push({
      item: '손익비 기준',
      ok: plan.rewardRisk >= mode.minRewardRisk,
      note: `R:R ${plan.rewardRisk} (모드 최소 ${mode.minRewardRisk})`,
    });
    checks.push({
      item: '1회 손실 한도 정합',
      ok: plan.maxLossPercentOfCapital <= mode.riskPercent + 0.05,
      note: `예상 최대손실 ${plan.maxLossPercentOfCapital}% ≤ ${mode.riskPercent}%`,
    });
  } else {
    const maxSell =
      holdingAmount > 0 ? holdingAmount : amount; // holding 미입력 시 입력액만 검증
    checks.push({
      item: '보유 대비 매도액',
      ok: holdingAmount <= 0 || amount <= holdingAmount + 0.01,
      note:
        holdingAmount > 0
          ? `매도 ${amount.toLocaleString()} / 보유 ${holdingAmount.toLocaleString()}`
          : '보유 금액 미입력 — 사용자가 직접 보유량을 확인하세요',
    });
    checks.push({
      item: '매도 신호 정합',
      ok: plan.bias === 'avoid' || (research.rsi14 != null && research.rsi14 >= mode.rsiSellMin),
      note:
        plan.bias === 'avoid'
          ? '회피/과열 구간이라 매도 검토와 맞음'
          : `RSI ${research.rsi14 ?? '—'} (매도 참고 ${mode.rsiSellMin}+)`,
    });
    checks.push({
      item: '전량 청산 과잉 여부',
      ok: !(holdingAmount > 0 && amount >= holdingAmount * 0.99 && mode.id === 'safe' && plan.bias !== 'avoid'),
      note:
        mode.id === 'safe' && holdingAmount > 0 && amount >= maxSell * 0.99
          ? '안전형은 신호가 약할 때 전량보다 일부 매도를 권장'
          : '매도 규모 점검 통과 또는 해당 없음',
    });
  }

  checks.push({
    item: '데이터 경고',
    ok: research.dataWarnings.length === 0,
    note:
      research.dataWarnings.length === 0
        ? '경고 없음'
        : research.dataWarnings.join(' / '),
  });

  const failed = checks.filter((c) => !c.ok);
  let decision: DecisionStatus = 'approve';
  let decisionReason = '';

  if (failed.length === 0) {
    decision = action === 'buy' && plan.bias === 'watch' ? 'watch' : 'approve';
    decisionReason =
      decision === 'watch'
        ? `금액은 모드 한도 안이지만 신호가 관망입니다. ${amountPct}% 비중으로 조건만 더 보세요.`
        : `${mode.label} 규칙과 충돌 없음. ${action === 'buy' ? '매수' : '매도'} ${amount.toLocaleString()} 검토 승인 가능(사람 최종 확인).`;
  } else if (failed.some((f) => f.item.includes('한도') || f.item.includes('회피'))) {
    decision = 'reject';
    decisionReason = `차단: ${failed.map((f) => f.item).join(', ')}. 금액을 줄이거나 오늘은 쉬세요.`;
  } else {
    decision = 'watch';
    decisionReason = `관망: ${failed.map((f) => f.item).join(', ')}. 조건이 맞을 때까지 대기.`;
  }

  // Soft-reject hard limit breaches
  if (action === 'buy' && amount > maxBuy) {
    decision = 'reject';
    decisionReason = `${mode.label} 매수 한도(${mode.maxBuyPercent}%)를 초과했습니다.`;
  }

  const devilAdvocate = runDevilAdvocate(research, plan, {
    modeLabel: mode.label,
    userAction: action,
    userAmount: amount,
    decision,
  });

  return {
    modeId: mode.id,
    modeLabel: mode.label,
    action,
    amount,
    research,
    plan,
    checks,
    decision,
    decisionReason,
    devilAdvocate,
    humanGate: {
      required: true,
      message:
        '일일 알림 금액은 제안일 뿐입니다. AI 검토 후 주문은 사용자가 증권사에서 직접 합니다.',
      autoTradeEnabled: false,
    },
    disclaimer:
      '모의투자용 의사결정 보조. 수익 보장 없음. 판단과 책임은 사용자에게 있습니다.',
  };
}
