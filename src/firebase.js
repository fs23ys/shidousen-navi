import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// 複数のGoogleアカウントを許可できるよう、カンマ区切りで指定する。
export const OWNER_EMAILS = (import.meta.env.VITE_OWNER_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

const googleProvider = new GoogleAuthProvider();

export function isOwner(user) {
  return !!user && !!user.email && OWNER_EMAILS.includes(user.email.toLowerCase());
}

export async function signInWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  if (!isOwner(cred.user)) {
    await fbSignOut(auth);
    throw new Error('NOT_OWNER');
  }
  return cred.user;
}

export function signOut() {
  return fbSignOut(auth);
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, (user) => {
    callback(isOwner(user) ? user : null);
  });
}
