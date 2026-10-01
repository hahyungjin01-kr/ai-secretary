/** Cloud / local runtime helpers */

export function isCloudFunctionsRuntime(): boolean {
  return Boolean(
    process.env.FUNCTION_TARGET ||
      process.env.K_SERVICE ||
      process.env.FIREBASE_CONFIG ||
      process.env.STATE_BACKEND === 'firestore',
  );
}

/** Persist app state & push subs to Firestore (Cloud Functions / explicit opt-in). */
export function useFirestoreBackend(): boolean {
  const v = (process.env.STATE_BACKEND || '').trim().toLowerCase();
  if (v === 'file' || v === 'local') return false;
  if (v === 'firestore') return true;
  return isCloudFunctionsRuntime();
}

/** In-process setInterval scheduler — local/Docker only. Cloud uses onSchedule. */
export function useInProcessScheduler(): boolean {
  const v = String(process.env.IN_PROCESS_SCHEDULER ?? '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return !isCloudFunctionsRuntime();
}

export function firebaseRegion(): string {
  return (process.env.FIREBASE_REGION || 'asia-northeast3').trim() || 'asia-northeast3';
}
