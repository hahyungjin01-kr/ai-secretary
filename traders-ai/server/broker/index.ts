import { TossBroker, resolveTossConfig } from './toss.js';
import type { BrokerClient, BrokerStatus, BrokerVenue } from './types.js';

export type { BrokerClient, BrokerStatus, BrokerVenue } from './types.js';
export { BrokerError } from './toss.js';

let singleton: TossBroker | null = null;
let singletonKey: string | null = null;

function configKey(cfg: NonNullable<ReturnType<typeof resolveTossConfig>>): string {
  return `${cfg.clientId}|${cfg.clientSecret}|${cfg.baseUrl}|${cfg.accountSeq ?? ''}`;
}

/** 프로세스당 브로커 1개 — 요청마다 새로 만들면 토큰이 서로 무효화됨 */
export function getBroker(liveArmed: boolean): BrokerClient | null {
  const cfg = resolveTossConfig();
  if (!cfg) {
    singleton = null;
    singletonKey = null;
    return null;
  }
  const key = configKey(cfg);
  if (!singleton || singletonKey !== key) {
    singleton = new TossBroker(cfg, liveArmed);
    singletonKey = key;
  } else {
    singleton.setLiveArmed(liveArmed);
  }
  return singleton;
}

export function brokerConfigSummary(): {
  configured: boolean;
  venue: BrokerVenue | 'local-paper';
  provider: 'none' | 'toss';
  liveCapable: boolean;
  baseUrl: string | null;
} {
  const cfg = resolveTossConfig();
  if (!cfg) {
    return {
      configured: false,
      venue: 'local-paper',
      provider: 'none',
      liveCapable: false,
      baseUrl: null,
    };
  }
  return {
    configured: true,
    venue: 'toss',
    provider: 'toss',
    liveCapable: true,
    baseUrl: cfg.baseUrl,
  };
}

export async function fetchBrokerStatus(liveArmed: boolean): Promise<BrokerStatus> {
  const broker = getBroker(liveArmed);
  if (!broker) {
    return {
      configured: false,
      connected: false,
      venue: 'local-paper',
      provider: 'none',
      baseUrl: null,
      liveCapable: false,
      liveArmed: false,
      message:
        '토스증권 API 키가 없습니다. traders-ai/.env 에 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 을 넣으세요.',
    };
  }
  return broker.getStatus();
}
