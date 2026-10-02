export type TraderMode = 'safe' | 'balance' | 'profit';

export interface ModeProfile {
  id: TraderMode;
  label: string;
  description: string;
  /** 1회 거래에서 허용하는 계좌 대비 최대 손실 % */
  riskPercent: number;
  /** 단일 종목 최대 투입 비중(계좌 %) */
  maxPositionPct: number;
  /** 최소 손익비 */
  minRewardRisk: number;
  /** 매수 신호 최소 점수 */
  minBuyScore: number;
  /** 매도 신호 최소 점수 */
  minSellScore: number;
  /** 일일 신규 매수 알림 상한 */
  maxDailyBuyAlerts: number;
  /** 현금 최소 유지 비중 */
  minCashPct: number;
}

export const MODE_PROFILES: Record<TraderMode, ModeProfile> = {
  safe: {
    id: 'safe',
    label: '안전형',
    description: '보수적으로, 계좌 현금의 일부만 씁니다.',
    riskPercent: 0.75,
    maxPositionPct: 12,
    minRewardRisk: 2,
    minBuyScore: 62,
    minSellScore: 55,
    maxDailyBuyAlerts: 2,
    minCashPct: 25,
  },
  balance: {
    id: 'balance',
    label: '밸런스형',
    description: '중간 비중으로 알아서 투자합니다.',
    riskPercent: 1.5,
    maxPositionPct: 22,
    minRewardRisk: 1.5,
    minBuyScore: 52,
    minSellScore: 50,
    maxDailyBuyAlerts: 4,
    minCashPct: 15,
  },
  profit: {
    id: 'profit',
    label: '수익형',
    description: '공격적으로, 여유 현금을 더 씁니다.',
    riskPercent: 3,
    maxPositionPct: 35,
    minRewardRisk: 1.2,
    minBuyScore: 45,
    minSellScore: 45,
    maxDailyBuyAlerts: 6,
    minCashPct: 5,
  },
};

export function isTraderMode(v: unknown): v is TraderMode {
  return v === 'safe' || v === 'balance' || v === 'profit';
}
