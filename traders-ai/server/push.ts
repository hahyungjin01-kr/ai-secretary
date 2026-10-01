import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { loadState } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');
const SUBS_PATH = path.join(DATA_DIR, 'push-subscriptions.json');

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let configured = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadOrCreateVapid(): VapidKeys {
  ensureDataDir();
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) {
    return { publicKey: envPub, privateKey: envPriv };
  }
  if (fs.existsSync(VAPID_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8')) as VapidKeys;
      if (raw.publicKey && raw.privateKey) return raw;
    } catch {
      // regenerate below
    }
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PATH, JSON.stringify(keys, null, 2), 'utf8');
  return keys;
}

export function initPush(): { publicKey: string } {
  const keys = loadOrCreateVapid();
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:traders-ai@localhost';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  configured = true;
  return { publicKey: keys.publicKey };
}

export function getVapidPublicKey(): string {
  return loadOrCreateVapid().publicKey;
}

function loadSubs(): PushSubscriptionJSON[] {
  ensureDataDir();
  if (!fs.existsSync(SUBS_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8')) as PushSubscriptionJSON[];
    return Array.isArray(raw) ? raw.filter((s) => s?.endpoint && s?.keys?.p256dh && s?.keys?.auth) : [];
  } catch {
    return [];
  }
}

function saveSubs(subs: PushSubscriptionJSON[]) {
  ensureDataDir();
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2), 'utf8');
}

export function listSubscriptions(): PushSubscriptionJSON[] {
  return loadSubs();
}

export function upsertSubscription(sub: PushSubscriptionJSON): number {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('유효하지 않은 푸시 구독입니다.');
  }
  const subs = loadSubs().filter((s) => s.endpoint !== sub.endpoint);
  subs.push({
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
  saveSubs(subs);
  return subs.length;
}

export function removeSubscription(endpoint: string): number {
  const subs = loadSubs().filter((s) => s.endpoint !== endpoint);
  saveSubs(subs);
  return subs.length;
}

export interface NotifyPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function sendPushToAll(payload: NotifyPayload): Promise<{
  sent: number;
  failed: number;
  removed: number;
}> {
  if (!configured) initPush();
  const subs = loadSubs();
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0 };

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/#confirm',
    tag: payload.tag ?? 'traders-ai-confirm',
  });

  let sent = 0;
  let failed = 0;
  const stale: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
        sent += 1;
      } catch (err) {
        failed += 1;
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) stale.push(sub.endpoint);
        console.warn('[push] send failed', status ?? (err instanceof Error ? err.message : err));
      }
    }),
  );

  if (stale.length) {
    saveSubs(loadSubs().filter((s) => !stale.includes(s.endpoint)));
  }

  return { sent, failed, removed: stale.length };
}

/** 대기 제안이 있으면 최종 확인 알림, 없으면 안내만 */
export async function sendDailyConfirmReminder(): Promise<{
  pending: number;
  sent: number;
  failed: number;
  skippedReason?: string;
}> {
  const state = loadState();
  const pending = state.alerts.filter((a) => a.status === 'pending').length;
  const subs = loadSubs();
  if (subs.length === 0) {
    return { pending, sent: 0, failed: 0, skippedReason: '등록된 휴대폰 알림 없음' };
  }

  const payload: NotifyPayload =
    pending > 0
      ? {
          title: 'TRADERS AI · 최종 확인',
          body: `오늘 제안 ${pending}건 대기 중. 탭한 뒤 확인 버튼만 누르세요.`,
          url: '/#confirm',
          tag: 'traders-ai-confirm',
        }
      : {
          title: 'TRADERS AI',
          body: '오늘 대기 제안이 없습니다.',
          url: '/',
          tag: 'traders-ai-idle',
        };

  const result = await sendPushToAll(payload);
  return { pending, sent: result.sent, failed: result.failed };
}

export function notifyTimeKst(): string {
  const raw = (process.env.NOTIFY_TIME_KST || '18:00').trim();
  return /^\d{1,2}:\d{2}$/.test(raw) ? raw.padStart(5, '0') : '18:00';
}

export function notifyEnabled(): boolean {
  const v = String(process.env.NOTIFY_SCHEDULE_ENABLED ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

export function getNotifyInfo() {
  return {
    enabled: notifyEnabled(),
    timeKst: notifyTimeKst(),
    timezone: 'Asia/Seoul',
    subscriptionCount: loadSubs().length,
    vapidReady: Boolean(getVapidPublicKey()),
    nextHint: notifyEnabled()
      ? `평일 ${notifyTimeKst()} KST에 휴대폰 알림`
      : '알림 스케줄 꺼짐',
  };
}
