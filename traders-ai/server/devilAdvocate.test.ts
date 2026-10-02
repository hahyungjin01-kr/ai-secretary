import { describe, expect, it } from 'vitest';
import { runDevilAdvocate } from './devilAdvocate.js';
import type { ResearchBundle } from './types.js';

function research(over: Partial<ResearchBundle> = {}): ResearchBundle {
  return {
    symbol: '005930',
    name: '삼성전자',
    currency: 'KRW',
    price: 70000,
    changePercent: -1,
    rsi14: 45,
    volumeRatio: 1.1,
    trailingPE: 12,
    news: [{ title: 'n', publisher: 'p', link: '', publishedAt: null }],
    dataWarnings: [],
    history: [],
    ...over,
  } as ResearchBundle;
}

describe('runDevilAdvocate', () => {
  it('does not always veto a healthy buy (no automatic high>=3)', () => {
    const result = runDevilAdvocate(research(), {
      side: 'buy',
      score: 70,
      agreement: 0.7,
      entry: 70000,
      target: 80000,
      stop: 65000,
      rewardRisk: 2,
      thesis: 'ok',
    });
    expect(result.veto).toBe(false);
    expect(result.challenges.some((c) => c.id === 'public-info')).toBe(true);
    expect(result.challenges.find((c) => c.id === 'public-info')?.severity).not.toBe('high');
  });

  it('vetoes weak agreement + knife on sharp drop', () => {
    const result = runDevilAdvocate(research({ changePercent: -6, dataWarnings: ['a', 'b'] }), {
      side: 'buy',
      score: 40,
      agreement: 0.35,
      entry: 70000,
      target: 72000,
      stop: 69000,
      rewardRisk: 1.1,
      thesis: 'weak',
    });
    expect(result.veto).toBe(true);
  });
});
