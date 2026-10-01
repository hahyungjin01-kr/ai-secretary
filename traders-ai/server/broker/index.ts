import { TossBroker, resolveTossConfig } from './toss.js';
import type { BrokerClient, BrokerStatus, BrokerVenue } from './types.js';

export type { BrokerClient, BrokerStatus, BrokerVenue } from './types.js';
export { BrokerError } from './toss.js';

export function getBroker(liveArmed: boolean): BrokerClient | null {
  const cfg = resolveTossConfig();
  if (!cfg) return null;
  return new TossBroker(cfg, liveArmed);
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
