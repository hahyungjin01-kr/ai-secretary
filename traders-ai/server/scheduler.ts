import { syncFromBroker } from './execute.js';
import { runDailyAnalysis } from './daily.js';
import { loadState } from './store.js';
import {
  getNotifyInfo,
  notifyEnabled,
  notifyTimeKst,
  sendDailyConfirmReminder,
} from './push.js';

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
}

let lastAttemptAt: string | null = null;
let lastResult: string | null = null;
let lastFiredKey: string | null = null;

let lastNotifyAttemptAt: string | null = null;
let lastNotifyResult: string | null = null;
let lastNotifyFiredKey: string | null = null;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let notifying = false;

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
  };
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
  lastAttemptAt = new Date().toISOString();
  try {
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
  } catch (err) {
    lastResult = err instanceof Error ? err.message : '스케줄 실행 실패';
    console.error('[scheduler]', lastResult);
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
  lastNotifyAttemptAt = new Date().toISOString();
  try {
    const result = await sendDailyConfirmReminder();
    lastNotifyResult = result.skippedReason
      ? result.skippedReason
      : `알림 ${result.sent}건 (대기 ${result.pending})`;
    console.log('[scheduler] notify', lastNotifyResult);
  } catch (err) {
    lastNotifyResult = err instanceof Error ? err.message : '알림 실패';
    console.error('[scheduler] notify', lastNotifyResult);
  } finally {
    notifying = false;
  }
}

async function tick() {
  await tickAnalysis();
  await tickNotify();
}

export function startDailyScheduler() {
  if (timer) return;
  if (!scheduleEnabled() && !notifyEnabled()) {
    console.log('[scheduler] disabled');
    return;
  }
  console.log(
    `[scheduler] analysis ${scheduleEnabled() ? scheduleTimeKst() : 'off'} · notify ${
      notifyEnabled() ? notifyTimeKst() : 'off'
    } KST weekdays`,
  );
  void tick();
  timer = setInterval(() => {
    void tick();
  }, 20_000);
}
