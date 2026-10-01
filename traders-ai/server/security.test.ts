import { describe, expect, it } from 'vitest';
import { checkApproveConfirm, APPROVE_PHRASE } from './security.js';

describe('checkApproveConfirm', () => {
  it('rejects missing confirm', () => {
    expect(checkApproveConfirm(undefined).ok).toBe(false);
    expect(checkApproveConfirm('').ok).toBe(false);
  });

  it('accepts 최종확인 and legacy 허락', () => {
    expect(checkApproveConfirm(APPROVE_PHRASE).ok).toBe(true);
    expect(checkApproveConfirm(' 최종 확인 ').ok).toBe(true);
    expect(checkApproveConfirm('허락').ok).toBe(true);
  });

  it('rejects wrong phrase', () => {
    expect(checkApproveConfirm('LIVE').ok).toBe(false);
  });
});
