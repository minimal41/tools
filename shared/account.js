/*
 * Tools 共通アカウント
 *
 * アカウントの作成・ログインは Tools のホーム（/index.html）で行い、
 * 各ツールはこのモジュールを読み込んでログイン状態とデータを使う。
 *
 *   アカウント・ユーザー情報 … Firebase（Authentication + Firestore の users/{uid}）
 *   サイトなどのデータ       … Vercel（/api/sites、Postgres に保存）
 *                              Firebase の ID トークンを付けて呼び、サーバー側で本人確認する。
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail, updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, apiBase } from './config.js';

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

const NOT_CONFIGURED = 'Firebase が未設定です（shared/config.js を設定してください）。';

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
  };
  return map[code] || (err && err.message) || '不明なエラーが発生しました。';
}

/* ---------- Vercel の API ---------- */

/** ログイン中のユーザーとして Vercel の API を呼ぶ */
async function api(path, { method = 'GET', body } = {}) {
  if (!currentUser) throw Object.assign(new Error('ログインしていません。'), { code: 'tools/not-logged-in' });
  const token = await currentUser.getIdToken();
  let res;
  try {
    res = await fetch(apiBase.replace(/\/$/, '') + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error('保存用のサーバー（Vercel）に接続できませんでした。'), { code: 'tools/api-unreachable' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = res.status === 413
      ? 'サイトのデータが大きすぎて保存できません。画像を小さくしてください。'
      : `サーバーでエラーが発生しました（${res.status}）。`;
    throw Object.assign(new Error(data.error || fallback), { code: 'tools/api-' + res.status, status: res.status });
  }
  return data;
}

/* ---------- Making Site のサイト ---------- */

const enc = encodeURIComponent;

export const sites = {
  /** 一覧（html / state は含まない。has_html で HTML 保存済みかが分かる） */
  async list() {
    return (await api('/api/sites')).sites;
  },
  /** 1件（html / state を含む）。見つからなければ null */
  async get(id) {
    try {
      return (await api('/api/sites?id=' + enc(id))).site;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
  async create(data) {
    return (await api('/api/sites', { method: 'POST', body: data })).id;
  },
  async update(id, data) {
    await api('/api/sites?id=' + enc(id), { method: 'PUT', body: data });
  },
  async remove(id) {
    await api('/api/sites?id=' + enc(id), { method: 'DELETE' });
  },
};
