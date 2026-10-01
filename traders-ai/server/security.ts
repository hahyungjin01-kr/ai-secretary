/**
 * 공개 터널 환경에서 실주문/설정 변경을 막기 위한 최소 보호.
 * - TRADERS_AI_TOKEN 이 있으면 변경 API에 헤더 필요
 * - 실주문은 본문에 confirm: "허락" 필수
 */

export const APPROVE_PHRASE = '허락';

export function accessTokenConfigured(): boolean {
  return Boolean((process.env.TRADERS_AI_TOKEN || '').trim());
}

export function checkAccessToken(headerVal: unknown): { ok: true } | { ok: false; error: string } {
  const expected = (process.env.TRADERS_AI_TOKEN || '').trim();
  if (!expected) return { ok: true };
  const got = String(headerVal ?? '').trim();
  if (!got || got !== expected) {
    return {
      ok: false,
      error: '인증 토큰이 필요합니다. 헤더 X-Traders-Token 을 확인하세요.',
    };
  }
  return { ok: true };
}

export function checkApproveConfirm(
  confirm: unknown,
): { ok: true } | { ok: false; error: string } {
  const c = String(confirm ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (c !== APPROVE_PHRASE) {
    return {
      ok: false,
      error: `실주문 승인에는 confirm 값으로 "${APPROVE_PHRASE}" 를 보내야 합니다.`,
    };
  }
  return { ok: true };
}
