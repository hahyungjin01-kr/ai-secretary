import { flushQueuedOrders, syncFromBroker } from './execute.js';
import { runDailyAnalysis } from './daily.js';
import {
  ensureStoreReady,
  loadState,
  waitForStorePersist,
} from './store.js';
import {
  ensurePushReady,
  getNotifyInfo,
  notifyEnabled,
  notifyTimeKst,
  sendDailyConfirmReminder,
  waitForPushPersist,
} from './push.js';
import { useInProcessScheduler } from './runtime.js';

export interface ScheduleInfo {
  enabled: boolean;
  timeKst: string;
  timezone: string;
  weekdaysOnly: boolean;
  lastAttemptAt: string | null;
  lastResult: string | null;
  nextHint: string;
  notify?: ReturnType<typeof getNotifyInfo> & {
    lastAttemptAt: string | null;
    lastResult: string | null;
  };
  executeQueued?: {
    timeKst: string;
    lastAttemptAt: string | null;
    lastResult: string | null;
    nextHint: string;
  };
}

let lastAttemptAt: string | null = null;
let lastResult: string | null = null;
let lastFiredKey: string | null = null;

let lastNotifyAttemptAt: string | null = null;
let lastNotifyResult: string | null = null;
let lastNotifyFiredKey: string | null = null;

let lastFlushAttemptAt: string | null = null;
let lastFlushResult: string | null = null;
let lastFlushFiredKey: string | null = null;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let notifying = false;
let flushing = false;

function scheduleEnabled(): boolean {
  const v = String(process.env.DAILY_SCHEDULE_ENABLED ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** HH:MM in KST, default 17:30 */
export function scheduleTimeKst(): string {
  const raw = (process.env.DAILY_RUN_TIME_KST || '17:30').trim();
  return /^\d{1,2}:\d{2}$/.test(raw) ? raw.padStart(5, '0') : '17:30';
}

function weekdaysOnly(): boolean {
  const v = String(process.env.DAILY_SCHEDULE_WEEKDAYS_ONLY ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function kstParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return {
    wd,
    hour,
    minute,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function kstDayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function getScheduleInfo(): ScheduleInfo {
  const time = scheduleTimeKst();
  const notify = getNotifyInfo();
  return {
    enabled: scheduleEnabled(),
    timeKst: time,
    timezone: 'Asia/Seoul',
    weekdaysOnly: weekdaysOnly(),
    lastAttemptAt,
    lastResult,
    nextHint: scheduleEnabled()
      ? `평일 ${time} 분석 · ${notify.timeKst} 휴대폰 알림`
      : '스케줄 꺼짐 (DAILY_SCHEDULE_ENABLED=0)',
    notify: {
      ...notify,
      lastAttemptAt: lastNotifyAttemptAt,
      lastResult: lastNotifyResult,
    },
    executeQueued: {
      timeKst: executeQueuedTimeKst(),
      lastAttemptAt: lastFlushAttemptAt,
      lastResult: lastFlushResult,
      nextHint: `예약 주문은 평일 ${executeQueuedTimeKst()} KST에 자동 실행`,
    },
  };
}

/** 장 시작 직후 — 전일 장외 최종확인 예약분 실행 */
export function executeQueuedTimeKst(): string {
  const raw = (process.env.EXECUTE_QUEUED_TIME_KST || '09:05').trim();
  return /^\d{1,2}:\d{2}$/.test(raw) ? raw.padStart(5, '0') : '09:05';
}

async function readyForJob() {
  await ensureStoreReady();
  await ensurePushReady();
}

async function finishJob() {
  await waitForStorePersist();
  await waitForPushPersist();
}

/** Cloud Scheduler / 수동 호출용 — 시각 매칭 없이 바로 일일 분석 */
export async function runScheduledAnalysisJob(): Promise<string> {
  await readyForJob();
  lastAttemptAt = new Date().toISOString();
  try {
    if (!scheduleEnabled()) {
      lastResult = '스케줄 꺼짐';
      return lastResult;
    }
    try {
      await syncFromBroker(loadState());
    } catch (err) {
      console.warn('[scheduler] sync', err instanceof Error ? err.message : err);
    }
    const result = await runDailyAnalysis(false);
    lastResult = result.skippedReason
      ? result.skippedReason
      : `생성 ${result.created.length}건 / 스캔 ${result.scanned}`;
    console.log('[scheduler] daily run', lastResult);
    return lastResult;
  } catch (err) {
    lastResult = err instanceof Error ? err.message : '스케줄 실행 실패';
    console.error('[scheduler]', lastResult);
    throw err;
  } finally {
    await finishJob();
  }
}

/** Cloud Scheduler / 수동 호출용 — 최종 확인 푸시 */
export async function runScheduledNotifyJob(): Promise<string> {
  await readyForJob();
  lastNotifyAttemptAt = new Date().toISOString();
  try {
    if (!notifyEnabled()) {
      lastNotifyResult = '알림 스케줄 꺼짐';
      return lastNotifyResult;
    }
    const result = await sendDailyConfirmReminder();
    lastNotifyResult = result.skippedReason
      ? result.skippedReason
      : `알림 ${result.sent}건 (대기 ${result.pending})`;
    console.log('[scheduler] notify', lastNotifyResult);
    return lastNotifyResult;
  } catch (err) {
    lastNotifyResult = err instanceof Error ? err.message : '알림 실패';
    console.error('[scheduler] notify', lastNotifyResult);
    throw err;
  } finally {
    await finishJob();
  }
}

/** Cloud Scheduler / 수동 호출용 — 예약(queued) 주문 플러시 */
export async function runScheduledFlushJob(): Promise<string> {
  await readyForJob();
  lastFlushAttemptAt = new Date().toISOString();
  try {
    const queuedN = loadState().alerts.filter((a) => a.status === 'queued').length;
    if (queuedN === 0) {
      lastFlushResult = '예약 없음';
      return lastFlushResult;
    }
    const result = await flushQueuedOrders();
    lastFlushResult = `예약 ${result.attempted} · 체결 ${result.executed} · 남음 ${result.stillQueued} · 실패 ${result.failed.length}`;
    console.log('[scheduler] flush queued', lastFlushResult);
    return lastFlushResult;
  } catch (err) {
    lastFlushResult = err instanceof Error ? err.message : '예약 실행 실패';
    console.error('[scheduler] flush', lastFlushResult);
    throw err;
  } finally {
    await finishJob();
  }
}

async function tickAnalysis() {
  if (!scheduleEnabled() || running) return;
  const { wd, hhmm } = kstParts();
  if (weekdaysOnly() && (wd === 'Sat' || wd === 'Sun')) return;
  if (hhmm !== scheduleTimeKst()) return;

  const fireKey = `${kstDayKey()}T${hhmm}`;
  if (lastFiredKey === fireKey) return;

  running = true;
  lastFiredKey = fireKey;
  try {
    await runScheduledAnalysisJob();
  } finally {
    running = false;
  }
}

async function tickNotify() {
  if (!notifyEnabled() || notifying) return;
  const { wd, hhmm } = kstParts();
  if (weekdaysOnly() && (wd === 'Sat' || wd === 'Sun')) return;
  if (hhmm !== notifyTimeKst()) return;

  const fireKey = `${kstDayKey()}Tnotify-${hhmm}`;
  if (lastNotifyFiredKey === fireKey) return;

  notifying = true;
  lastNotifyFiredKey = fireKey;
  try {
    await runScheduledNotifyJob();
  } finally {
    notifying = false;
  }
}

async function tickFlushQueued() {
  if (flushing) return;
  const { wd, hhmm } = kstParts();
  if (weekdaysOnly() && (wd === 'Sat' || wd === 'Sun')) return;
  if (hhmm !== executeQueuedTimeKst()) return;

  const fireKey = `${kstDayKey()}Tflush-${hhmm}`;
  if (lastFlushFiredKey === fireKey) return;

  flushing = true;
  lastFlushFiredKey = fireKey;
  try {
    await runScheduledFlushJob();
  } finally {
    flushing = false;
  }
}

async function tick() {
  await tickFlushQueued();
  await tickAnalysis();
  await tickNotify();
}

export function startDailyScheduler() {
  if (timer) return;
  if (!useInProcessScheduler()) {
    console.log(
      '[scheduler] in-process timer off (Cloud Scheduler / Firebase onSchedule 사용)',
    );
    return;
  }
  console.log(
    `[scheduler] analysis ${scheduleEnabled() ? scheduleTimeKst() : 'off'} · notify ${
      notifyEnabled() ? notifyTimeKst() : 'off'
    } · flush-queued ${executeQueuedTimeKst()} KST weekdays`,
  );
  void tick();
  timer = setInterval(() => {
    void tick();
  }, 20_000);
}
