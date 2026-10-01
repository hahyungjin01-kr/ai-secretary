/** 최종 확인 버튼이 보내는 값 */
export const APPROVE_PHRASE = '최종확인';

export function checkApproveConfirm(
  confirm: unknown,
): { ok: true } | { ok: false; error: string } {
  if (confirm === undefined || confirm === null || confirm === '') {
    return {
      ok: false,
      error: '최종 확인 문구가 없습니다. confirm: "최종확인" 이 필요합니다.',
    };
  }
  const c = String(confirm)
    .trim()
    .replace(/\s+/g, '');
  // 하위 호환: 예전 "허락"도 허용
  if (c !== APPROVE_PHRASE && c !== '허락') {
    return {
      ok: false,
      error: '실주문에는 최종 확인이 필요합니다.',
    };
  }
  return { ok: true };
}
