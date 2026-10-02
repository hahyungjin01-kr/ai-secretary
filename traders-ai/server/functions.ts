/**
 * Firebase Cloud Functions entry (Hosting rewrite + Cloud Scheduler).
 * Deploy: npm run deploy:firebase
 */
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { createApp, prepareLocalBoot } from './app.js';
import { initPush } from './push.js';
import {
  runScheduledAnalysisJob,
  runScheduledFlushJob,
  runScheduledNotifyJob,
} from './scheduler.js';
import { firebaseRegion } from './runtime.js';

process.env.STATE_BACKEND = process.env.STATE_BACKEND || 'firestore';
process.env.IN_PROCESS_SCHEDULER = process.env.IN_PROCESS_SCHEDULER || '0';

const region = firebaseRegion();

const tossClientId = defineString('TOSS_CLIENT_ID', { default: '' });
const tossClientSecret = defineSecret('TOSS_CLIENT_SECRET');
const tradersApiSecret = defineSecret('TRADERS_API_SECRET');
const vapidPublicKey = defineString('VAPID_PUBLIC_KEY', { default: '' });
const vapidPrivateKey = defineSecret('VAPID_PRIVATE_KEY');
const vapidSubject = defineString('VAPID_SUBJECT', {
  default: 'mailto:traders-ai@example.com',
});

const sharedSecrets = [tossClientSecret, tradersApiSecret, vapidPrivateKey];

function applyParamsToEnv() {
  if (tossClientId.value()) process.env.TOSS_CLIENT_ID = tossClientId.value();
  if (tossClientSecret.value()) {
    process.env.TOSS_CLIENT_SECRET = tossClientSecret.value();
  }
  if (tradersApiSecret.value()) {
    process.env.TRADERS_API_SECRET = tradersApiSecret.value();
  }
  if (vapidPublicKey.value()) process.env.VAPID_PUBLIC_KEY = vapidPublicKey.value();
  if (vapidPrivateKey.value()) {
    process.env.VAPID_PRIVATE_KEY = vapidPrivateKey.value();
  }
  if (vapidSubject.value()) process.env.VAPID_SUBJECT = vapidSubject.value();
  process.env.STATE_BACKEND = 'firestore';
  process.env.IN_PROCESS_SCHEDULER = '0';
}

let bootPromise: Promise<void> | null = null;
async function bootOnce() {
  if (bootPromise) {
    await bootPromise;
    return;
  }
  bootPromise = (async () => {
    applyParamsToEnv();
    await prepareLocalBoot();
    try {
      initPush();
    } catch (err) {
      console.error('[functions] push init', err);
    }
  })();
  await bootPromise;
}

const expressApp = createApp({ serveStatic: false });

export const api = onRequest(
  {
    region,
    memory: '1GiB',
    timeoutSeconds: 300,
    maxInstances: 3,
    secrets: sharedSecrets,
  },
  async (req, res) => {
    await bootOnce();
    expressApp(req, res);
  },
);

export const scheduledDaily = onSchedule(
  {
    region,
    schedule: '30 17 * * 1-5',
    timeZone: 'Asia/Seoul',
    memory: '1GiB',
    timeoutSeconds: 540,
    maxInstances: 1,
    secrets: sharedSecrets,
  },
  async () => {
    await bootOnce();
    await runScheduledAnalysisJob();
  },
);

export const scheduledNotify = onSchedule(
  {
    region,
    schedule: '0 18 * * 1-5',
    timeZone: 'Asia/Seoul',
    memory: '512MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
    secrets: sharedSecrets,
  },
  async () => {
    await bootOnce();
    await runScheduledNotifyJob();
  },
);

export const scheduledFlush = onSchedule(
  {
    region,
    schedule: '5 9 * * 1-5',
    timeZone: 'Asia/Seoul',
    memory: '1GiB',
    timeoutSeconds: 540,
    maxInstances: 1,
    secrets: sharedSecrets,
  },
  async () => {
    await bootOnce();
    await runScheduledFlushJob();
  },
);
