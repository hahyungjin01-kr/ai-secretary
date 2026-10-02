/** Cloud Agent 출구 IP는 요청마다 바뀔 수 있음 — 토스 허용 IP 등록용 */

const PROBE_URLS = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
];

export async function probeEgressIp(): Promise<string | null> {
  for (const url of PROBE_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      // try next
    }
  }
  return null;
}

let cachedIps: { at: number; ips: string[] } | null = null;

/** 여러 번 샘플링해 회전 출구 IP 목록을 모은다 */
export async function sampleEgressIps(samples = 8, force = false): Promise<string[]> {
  if (!force && cachedIps && Date.now() - cachedIps.at < 5 * 60_000) {
    return cachedIps.ips;
  }
  const found = new Set<string>();
  for (let i = 0; i < samples; i += 1) {
    const ip = await probeEgressIp();
    if (ip) found.add(ip);
    await new Promise((r) => setTimeout(r, 120));
  }
  const ips = [...found].sort();
  cachedIps = { at: Date.now(), ips };
  return ips;
}

export function isIpDeniedMessage(message: string, status?: number): boolean {
  if (status === 403) return true;
  return /허용되지 않은\s*IP|ip address not allowed|access_denied|not allowed.*ip/i.test(
    message,
  );
}

export async function withIpRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 10,
): Promise<T> {
  let lastErr: Error | null = null;
  const seenIps: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr = err instanceof Error ? err : new Error(msg);
      if (!isIpDeniedMessage(msg) || attempt === attempts) break;

      const ip = await probeEgressIp();
      if (ip && !seenIps.includes(ip)) seenIps.push(ip);
      console.warn(`[egress] ${label} IP denied (try ${attempt}/${attempts}) ip=${ip ?? '?'}`);
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  const ips = seenIps.length ? seenIps : await sampleEgressIps(6);
  const tip =
    ips.length > 0
      ? ` 토스 Open API 허용 IP에 등록: ${ips.join(', ')}`
      : ' 토스 Open API에서 이 서버 출구 IP를 허용 목록에 등록하세요.';
  throw new Error(`${lastErr?.message || '허용되지 않은 IP'}.${tip}`);
}
