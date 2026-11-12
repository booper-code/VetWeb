// Firebase is loaded dynamically at runtime to avoid requiring the package during static type checks.
// dbRef/firestore are exported as live bindings: initializeFirebase() reassigns them and
// importers always read the current value.
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

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

export const initializeFirebase = async () => {
  if (app && auth && dbRef && firestore) return { app, auth, db: dbRef, firestore };
  const config = getFirebaseConfig();
  
  try {
    console.log('[Firebase] initializing connection...');
    const { initializeApp, getApps, getApp } = await import('firebase/app');
    const { getAuth } = await import('firebase/auth');
    const firestoreModule = await import('firebase/firestore');
    
    // THE FIX: Check if Firebase is already running to prevent the React double-render crash
    if (getApps().length === 0) {
      app = initializeApp(config);
    } else {
      app = getApp();
    }
    
    auth = getAuth(app);
    dbRef = firestoreModule.getFirestore(app);
    firestore = firestoreModule;
    
    console.log('[Firebase] successfully connected to:', config.projectId);
    return { app, auth, db: dbRef, firestore };
    
  } catch (e) {
    console.error('Firebase initialization failed:', e);
    throw e;
  }
};
