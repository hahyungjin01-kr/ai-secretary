import { buildTradePlan } from './analysis.js';
import { getMode, type InvestorMode, type ModePreset } from './modes.js';
import { collectResearch } from './research.js';
import type { ResearchBundle, TradePlan } from './types.js';

export type AlertAction = 'buy' | 'sell' | 'hold';

export interface DailyAlert {
  symbol: string;
  name: string;
  currency: string;
  price: number;
  action: AlertAction;
  suggestedAmount: number;
  suggestedShares: number;
  reason: string;
  modeId: InvestorMode;
}

export interface DailyBriefing {
  asOf: string;
  mode: ModePreset;
  capital: number;
  alerts: DailyAlert[];
  summary: string;
  disclaimer: string;
}

function round(n: number, d = 2): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function decideDailyAction(
  research: ResearchBundle,
  plan: TradePlan,
  mode: ModePreset,
  capital: number,
  holdingAmount: number,
): DailyAlert {
  const price = research.price;
  const rsi = research.rsi14;
  let action: AlertAction = 'hold';
  let reason = plan.thesis;
  let suggestedAmount = 0;

  const overbought =
    (rsi != null && rsi >= mode.rsiSellMin) || plan.bias === 'avoid';
  const buyCandidate =
    plan.bias === 'buy' ||
    (rsi != null && rsi <= mode.rsiBuyMax && plan.bias !== 'avoid');

  if (overbought && holdingAmount > 0) {
    action = 'sell';
    suggestedAmount = round((holdingAmount * mode.sellTrimPercent) / 100);
    reason = `${mode.label} 기준 과열/회피 신호 → 보유분의 약 ${mode.sellTrimPercent}% 매도 검토`;
  } else if (buyCandidate && plan.bias !== 'avoid') {
    action = 'buy';
    const byCap = (capital * mode.maxBuyPercent) / 100;
    const byRisk = plan.positionNotional > 0 ? plan.positionNotional : byCap * 0.5;
    suggestedAmount = round(Math.min(byCap, Math.max(byRisk, capital * 0.02)));
    reason = `${mode.label} 기준 매수 후보 → 계좌의 최대 ${mode.maxBuyPercent}% 한도 안에서 검토`;
  } else {
    action = 'hold';
    suggestedAmount = 0;
    reason = `${mode.label} 기준 오늘은 관망. 억지 진입보다 알림만 확인하세요.`;
  }

  const suggestedShares =
    price > 0 && suggestedAmount > 0 ? Math.floor(suggestedAmount / price) : 0;

  return {
    symbol: research.symbol,
    name: research.name,
    currency: research.currency,
    price,
    action,
    suggestedAmount,
    suggestedShares,
    reason,
    modeId: mode.id,
  };
}

export async function buildDailyBriefing(input: {
  mode: string;
  capital: number;
  symbols: string[];
  holdings?: Record<string, number>;
}): Promise<DailyBriefing> {
  const mode = getMode(input.mode);
  const capital = input.capital;
  const symbols = input.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const holdings = input.holdings ?? {};

  const alerts: DailyAlert[] = [];
  for (const symbol of symbols.slice(0, 8)) {
    const research = await collectResearch(symbol);
    const plan = buildTradePlan(research, capital, mode.riskPercent, mode);
    const holdingAmount = Number(holdings[symbol] ?? holdings[symbol.toLowerCase()] ?? 0);
    alerts.push(
      decideDailyAction(research, plan, mode, capital, holdingAmount),
    );
  }

  const buys = alerts.filter((a) => a.action === 'buy').length;
  const sells = alerts.filter((a) => a.action === 'sell').length;
  const holds = alerts.filter((a) => a.action === 'hold').length;

  return {
    asOf: new Date().toISOString(),
    mode,
    capital,
    alerts,
    summary: `오늘 알림 (${mode.label}): 매수 검토 ${buys} · 매도 검토 ${sells} · 관망 ${holds}. 금액을 입력하면 AI가 모드 규칙으로 재검토합니다.`,
    disclaimer:
      '일일 알림은 주문이 아닙니다. 모의투자 우선. 최종 실행은 사람, 자동주문 없음.',
  };
}
