/*
 * Tools 共通アカウント（Firebase Authentication + Cloud Firestore）
 *
 * アカウントの作成・ログインは Tools のホーム（/index.html）で行い、
 * 各ツールはこのモジュールを読み込んでログイン状態とユーザーデータを使う。
 *
 * Firestore の構成
 *   users/{uid}                 … ユーザー情報（email, displayName, createdAt, lastLoginAt）
 *   users/{uid}/sites/{siteId}  … Making Site で作ったサイト（title, html, state, createdAt, updatedAt）
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail, updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc,
  collection, getDocs, query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const isConfigured =
  !!firebaseConfig.apiKey && !/^YOUR_/.test(firebaseConfig.apiKey);

let auth = null;
let db = null;
if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  auth.languageCode = 'ja';
  db = getFirestore(app);
}

const NOT_CONFIGURED = 'Firebase が未設定です（shared/firebase-config.js を設定してください）。';

/* ---------- ログイン状態 ---------- */

let currentUser = null;
let resolved = false;
const listeners = new Set();
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

if (auth) {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    resolved = true;
    readyResolve(user);
    listeners.forEach((cb) => cb(user));
  });
} else {
  resolved = true;
  readyResolve(null);
}

/** 現在のユーザー（未ログインなら null） */
export function getUser() { return currentUser; }

/** 初回のログイン状態が確定するまで待って、ユーザーを返す */
export function waitForUser() { return ready; }

/** ログイン状態が変わるたびに呼ばれる。登録時点の状態でも一度呼ばれる。戻り値で解除 */
export function onUserChanged(cb) {
  listeners.add(cb);
  if (resolved) cb(currentUser);
  return () => listeners.delete(cb);
}

/** ツールのページから Tools ホームのログイン画面へのリンク */
export function loginUrl(homePath, mode = 'login') {
  return `${homePath}?account=${mode}&next=${encodeURIComponent(location.href)}`;
}

/* ---------- アカウント操作 ---------- */

function requireAuth() {
  if (!auth) throw Object.assign(new Error(NOT_CONFIGURED), { code: 'tools/not-configured' });
}

export async function signUp({ email, password, displayName }) {
  requireAuth();
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) await updateProfile(cred.user, { displayName });
  await setDoc(doc(db, 'users', cred.user.uid), {
    email: cred.user.email,
    displayName: displayName || '',
    createdAt: serverTimestamp(),
    lastLoginAt: serverTimestamp(),
  });
  return cred.user;
}

export async function signIn({ email, password }) {
  requireAuth();
  const cred = await signInWithEmailAndPassword(auth, email, password);
  // ユーザー情報が無い（古いアカウント等）場合でも作られるよう merge で書く
  await setDoc(doc(db, 'users', cred.user.uid), {
    email: cred.user.email,
    lastLoginAt: serverTimestamp(),
  }, { merge: true }).catch((e) => console.warn('ユーザー情報の更新に失敗しました', e));
  return cred.user;
}

export async function logOut() {
  if (auth) await signOut(auth);
}

export async function resetPassword(email) {
  requireAuth();
  await sendPasswordResetEmail(auth, email);
}

export async function getProfile() {
  if (!currentUser) return null;
  const snap = await getDoc(doc(db, 'users', currentUser.uid));
  return snap.exists() ? snap.data() : null;
}

export async function updateDisplayName(displayName) {
  if (!currentUser) throw new Error('ログインしていません。');
  await updateProfile(currentUser, { displayName });
  await setDoc(doc(db, 'users', currentUser.uid), { displayName }, { merge: true });
}

/** Firebase のエラーを日本語のメッセージにする */
export function errorMessage(err) {
  const code = (err && err.code) || '';
  const map = {
    'tools/not-configured': NOT_CONFIGURED,
    'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
    'auth/missing-email': 'メールアドレスを入力してください。',
    'auth/missing-password': 'パスワードを入力してください。',
    'auth/invalid-credential': 'メールアドレスまたはパスワードが正しくありません。',
    'auth/invalid-login-credentials': 'メールアドレスまたはパスワードが正しくありません。',
    'auth/wrong-password': 'メールアドレスまたはパスワードが正しくありません。',
    'auth/user-not-found': 'メールアドレスまたはパスワードが正しくありません。',
    'auth/email-already-in-use': 'このメールアドレスは既に登録されています。ログインしてください。',
    'auth/weak-password': 'パスワードは6文字以上にしてください。',
    'auth/too-many-requests': '試行回数が多すぎます。しばらくしてからお試しください。',
    'auth/network-request-failed': 'ネットワークに接続できませんでした。',
    'auth/user-disabled': 'このアカウントは無効化されています。',
    'auth/operation-not-allowed': 'メール/パスワードでのログインが有効になっていません（Firebase コンソールで有効にしてください）。',
    'permission-denied': 'データへのアクセスが許可されていません（Firestore のルールを確認してください）。',
    'invalid-argument': 'データが大きすぎるか、形式が正しくないため保存できませんでした。',
  };
  return map[code] || (err && err.message) || '不明なエラーが発生しました。';
}

/* ---------- Making Site のサイト ---------- */

function sitesCol() {
  if (!currentUser) throw new Error('ログインしていません。');
  return collection(db, 'users', currentUser.uid, 'sites');
}

function toSite(snap) {
  const d = snap.data();
  const ts = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : null);
  return {
    id: snap.id,
    title: d.title || '',
    html: d.html || null,
    state: d.state || null,
    created_at: ts(d.createdAt),
    updated_at: ts(d.updatedAt),
  };
}

export const sites = {
  async list() {
    const snaps = await getDocs(query(sitesCol(), orderBy('createdAt', 'desc')));
    return snaps.docs.map(toSite);
  },
  async get(id) {
    const snap = await getDoc(doc(sitesCol(), id));
    return snap.exists() ? toSite(snap) : null;
  },
  async create(data) {
    const ref = await addDoc(sitesCol(), {
      ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    return ref.id;
  },
  async update(id, data) {
    await updateDoc(doc(sitesCol(), id), { ...data, updatedAt: serverTimestamp() });
  },
  async remove(id) {
    await deleteDoc(doc(sitesCol(), id));
  },
};
