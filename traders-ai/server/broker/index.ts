import { AlpacaBroker, resolveAlpacaConfig } from './alpaca.js';
import type { BrokerClient, BrokerStatus, BrokerVenue } from './types.js';

export type { BrokerClient, BrokerStatus, BrokerVenue } from './types.js';
export { BrokerError } from './alpaca.js';

export function getBroker(liveArmed: boolean): BrokerClient | null {
  const cfg = resolveAlpacaConfig();
  if (!cfg) return null;
  return new AlpacaBroker(cfg, liveArmed);
}

export function brokerConfigSummary(): {
  configured: boolean;
  venue: BrokerVenue | 'local-paper';
  provider: 'none' | 'alpaca';
  liveCapable: boolean;
  baseUrl: string | null;
} {
  const cfg = resolveAlpacaConfig();
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
    venue: cfg.venue,
    provider: 'alpaca',
    liveCapable: cfg.liveCapable,
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
        'Alpaca API 키가 없습니다. traders-ai/.env 에 ALPACA_API_KEY / ALPACA_API_SECRET 을 넣으세요.',
    };
  }
  return broker.getStatus();
}
