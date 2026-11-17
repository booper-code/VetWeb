// Firebase is loaded dynamically at runtime to avoid requiring the package during static type checks.
// dbRef/firestore are exported as live bindings: initializeFirebase() reassigns them and
// importers always read the current value.
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { getDevicePreference, requestTrustedDevice, watchDevicePreference, broadcastDeviceWipe, setDeviceClearState } from './offline-device';

const getFirebaseConfig = () => {
  return {
    apiKey: "AIzaSyAvRasTDM9QV79i9V4t5mbxfOPuGQybwIs",
    authDomain: "vetcloudpro.firebaseapp.com",
    projectId: "vetcloudpro",
    storageBucket: "vetcloudpro.firebasestorage.app",
    messagingSenderId: "2281264630",
    appId: "1:2281264630:web:24a779ef0a2f2fcceae3d7",
    measurementId: "G-T381W4YXF3"
  };
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
export let firestore: typeof import('firebase/firestore') | null = null;
export let dbRef: Firestore | null = null;

type FirebaseConnection = { app: FirebaseApp; auth: Auth; db: Firestore; firestore: typeof import('firebase/firestore') };
let initialization: Promise<FirebaseConnection> | null = null;
let stopped = false;
let cacheMode: 'memory' | 'persistent' = 'memory';
let persistenceNotice: string | null = null;
let stopDeviceWatch: (() => void) | null = null;
export const getFirebaseDeviceState = () => ({ cacheMode, persistenceNotice, restartRequired: stopped });

// IndexedDB deleteDatabase can stay pending indefinitely when a tab ignores
// versionchange. The SDK does not reject that blocked-delete case on its own.
async function clearPersistence(sdk: typeof import('firebase/firestore'), db: Firestore) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sdk.clearIndexedDbPersistence(db),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Device cleanup is blocked. Close other VetWeb tabs and retry.')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export const initializeFirebase = (): Promise<FirebaseConnection> => {
  if (stopped) return Promise.reject(new Error('Device storage changed. Restart the app before reconnecting.'));
  // Subscribe before the first asynchronous import/auth/persistence operation.
  // A wipe during initialization must stop this tab, including memory-only tabs.
  if (!stopDeviceWatch) stopDeviceWatch = watchDevicePreference(change => {
    if (change === 'wipe' || getDevicePreference() === 'memory') {
      void clearOfflineDeviceData({ broadcast: false }).catch(() => {
        persistenceNotice = 'Close all other VetWeb tabs, then retry clearing device data.';
      });
    }
  });
  if (!initialization) initialization = connect().catch(error => {
    initialization = null;
    throw error;
  });
  return initialization;
};

async function connect(): Promise<FirebaseConnection> {
  const config = getFirebaseConfig();
  try {
    const { initializeApp, getApps, getApp } = await import('firebase/app');
    const { getAuth, setPersistence, inMemoryPersistence, browserLocalPersistence, signOut } = await import('firebase/auth');
    const firestoreModule = await import('firebase/firestore');
    if (stopped) throw new Error('Device storage changed during initialization. Restart the app.');
    if (getApps().length === 0) {
      app = initializeApp(config);
    } else {
      app = getApp();
    }
    
    auth = getAuth(app);
    const trusted = getDevicePreference() === 'trusted';
    await auth.authStateReady();
    if (!trusted) {
      // Remove any session left by older versions before exposing Auth to callers.
      await signOut(auth);
    }
    try {
      await setPersistence(auth, trusted ? browserLocalPersistence : inMemoryPersistence);
    } catch {
      await setPersistence(auth, inMemoryPersistence);
      persistenceNotice = 'Session restoration is unavailable; sign in again after closing this page.';
    }
    // getFirestore defaults to memory. The legacy async opt-in is intentional:
    // unlike persistentLocalCache initialization it reports IndexedDB failures,
    // allowing us to expose a confirmed memory fallback before any reads occur.
    dbRef = firestoreModule.getFirestore(app);
    firestore = firestoreModule;
    if (trusted) {
      try {
        await firestoreModule.enableIndexedDbPersistence(dbRef);
        cacheMode = 'persistent';
      } catch {
        cacheMode = 'memory';
        persistenceNotice = 'Offline record storage is unavailable (another tab or browser restriction). This session uses memory only.';
      }
    } else {
      // Fail closed if old clinical storage cannot be removed (e.g. another tab).
      await clearPersistence(firestoreModule, dbRef);
    }
    if (trusted && getDevicePreference() !== 'trusted') {
      void clearOfflineDeviceData().catch(() => {
        persistenceNotice = 'Close all other VetWeb tabs, then retry clearing device data.';
      });
    }
    if (stopped) throw new Error('Device storage changed during initialization. Restart the app.');
    return { app, auth, db: dbRef, firestore };
    
  } catch (e) {
    throw e;
  }
}

/** Wait for SDK auth restoration; membership/role must still be validated online. */
export async function restoreFirebaseSession() {
  const connection = await initializeFirebase();
  await connection.auth.authStateReady();
  return connection.auth.currentUser;
}

let clearing: Promise<void> | null = null;
/**
 * Destructive, explicit device clear. Caller must confirm loss of pending local
 * writes/drafts and stop subscriptions first. This is NOT a sync/flush operation.
 * Requires a manual restart afterwards, including when another tab blocks clear.
 */
export function clearOfflineDeviceData({ broadcast = true } = {}): Promise<void> {
  if (clearing) return clearing;
  stopped = true;
  setDeviceClearState({ phase: 'clearing', message: 'Signing out and clearing this device. Do not close this tab yet.' });
  clearing = Promise.resolve().then(async () => {
    let preferenceFailed = false;
    try { requestTrustedDevice(false); } catch { preferenceFailed = true; }
    if (broadcast) broadcastDeviceWipe();
    if (initialization) await initialization.catch(() => undefined);
    stopDeviceWatch?.();
    stopDeviceWatch = null;
    const sdk = firestore ?? await import('firebase/firestore');
    if (auth) {
      const { signOut, setPersistence, inMemoryPersistence } = await import('firebase/auth');
      await signOut(auth);
      await setPersistence(auth, inMemoryPersistence);
    }
    if (dbRef) {
      await sdk.terminate(dbRef);
      await clearPersistence(sdk, dbRef);
    } else {
      const { initializeApp, getApps, getApp } = await import('firebase/app');
      const cleanupApp = getApps().length ? getApp() : initializeApp(getFirebaseConfig());
      const { getAuth, signOut, setPersistence, inMemoryPersistence } = await import('firebase/auth');
      const cleanupAuth = getAuth(cleanupApp);
      await cleanupAuth.authStateReady();
      await signOut(cleanupAuth);
      await setPersistence(cleanupAuth, inMemoryPersistence);
      const cleanupDb = sdk.getFirestore(cleanupApp);
      await sdk.terminate(cleanupDb);
      await clearPersistence(sdk, cleanupDb);
    }
    cacheMode = 'memory';
    persistenceNotice = null;
    if (preferenceFailed) throw new Error('Could not remove trusted-device consent.');
    setDeviceClearState({ phase: 'cleared', message: 'Cached clinical data was cleared and this tab signed out. Restart the app before signing in again.' });
  }).catch(error => {
    setDeviceClearState({ phase: 'failed', message: 'Could not confirm device cleanup. Close other VetWeb tabs and retry clearing. Do not leave this device unattended.' });
    throw error;
  }).finally(() => { clearing = null; });
  return clearing;
}
