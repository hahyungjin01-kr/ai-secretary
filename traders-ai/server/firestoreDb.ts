import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { useFirestoreBackend } from './runtime.js';

let db: Firestore | null = null;

export function getDb(): Firestore {
  if (!useFirestoreBackend()) {
    throw new Error('Firestore backend is not enabled (STATE_BACKEND≠firestore)');
  }
  if (db) return db;
  if (getApps().length === 0) {
    try {
      initializeApp({ credential: applicationDefault() });
    } catch {
      // FIREBASE_CONFIG / default credentials inside Cloud Functions
      initializeApp();
    }
  }
  db = getFirestore();
  return db;
}

export const FS_STATE_PATH = {
  collection: 'traders',
  stateDoc: 'state',
  pushDoc: 'push',
} as const;
