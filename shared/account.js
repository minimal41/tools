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
  let first = true;
  let queue = Promise.resolve();
  onAuthStateChanged(auth, (user) => {
    // 最初の確認でログインしていなければ、控え（Cookie）から戻せるか試してから結果を知らせる
    queue = queue.then(async () => {
      if (first) {
        first = false;
        if (!user && await restoreSession()) return; // 戻せたらページを読み込み直すので、ここでは知らせない
      }
      currentUser = user;
      resolved = true;
      readyResolve(user);
      listeners.forEach((cb) => cb(user));
      if (user) { restoreSucceeded(); saveSession(user); }
    });
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

/**
 * ツールのページからログイン画面（login.html）・新規登録画面（signup.html）へのリンク。
 * homePath は Tools ホーム（index.html）への道。ログイン後は今のページにもどる。
 */
export function loginUrl(homePath, mode = 'login') {
  const page = new URL(mode === 'signup' ? 'signup.html' : 'login.html', new URL(homePath, location.href));
  page.search = '?next=' + encodeURIComponent(location.href);
  return page.href;
}

/* ---------- ログインの控え ----------
 *
 * Firebase はログイン状態をブラウザの保存領域に覚えているが、ブラウザによっては
 * しばらく使わないと消されたり（Safari は約7日）、起動時の確認に失敗して消えたりする。
 * そこで、ログインを続けるための鍵を JavaScript から読めない Cookie（/api/session）にも
 * 控えておき、ログイン状態が消えていたらそこから戻す。Cookie は使うたびに約400日延びる。
 * ページと API が同じ場所（Vercel）にあるときだけ働く。
 */
const SESSION_URL = apiBase.replace(/\/$/, '') + '/api/session';
const sessionEnabled = !apiBase;
const hasSessionFlag = () => /(?:^|;\s*)tools_in=1/.test(document.cookie);

function store(kind) {
  try { const st = window[kind]; st.getItem('x'); return st; } catch { return null; }
}

/** いまのログインを Cookie に控える（鍵が変わったときと、目印が無いときだけ送る） */
async function saveSession(user) {
  if (!sessionEnabled || !user || !user.refreshToken) return;
  const ss = store('sessionStorage');
  const mark = user.refreshToken.slice(-24);
  if (ss && ss.getItem('tools.session') === 'off') return; // この場所には API が無い
  if (hasSessionFlag() && ss && ss.getItem('tools.session') === mark) return;
  try {
    const res = await fetch(SESSION_URL, {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: 'Bearer ' + await user.getIdToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });
    if (ss) ss.setItem('tools.session', res.ok ? mark : (res.status === 404 ? 'off' : ''));
  } catch (e) { /* 控えられなくても、ログイン自体はそのまま使える */ }
}

async function clearSession() {
  if (!sessionEnabled) return;
  const ss = store('sessionStorage');
  if (ss) ss.removeItem('tools.session');
  try { await fetch(SESSION_URL, { method: 'DELETE', keepalive: true }); } catch (e) { /* 無視 */ }
}

/**
 * ログイン状態が消えていたら、Cookie の控えから戻す。戻せたら true（ページを読み込み直す）。
 * 戻し方：控えの鍵で新しい ID トークンを受け取り、Firebase（10.12.2）がログイン状態を
 * 保存しておく場所に書き込んでから読み込み直す。Firebase は起動時にそれを見つけて、
 * サーバーに確かめたうえでログイン状態にする。
 */
async function restoreSession() {
  if (!sessionEnabled || !hasSessionFlag()) return false;
  const ss = store('sessionStorage');
  const ls = store('localStorage');
  if (!ss || !ls) return false;
  if (ss.getItem('tools.restore')) {
    // 直前に戻したのにログインできなかった（アカウントが無効など）。繰り返さないよう控えを消す
    ss.removeItem('tools.restore');
    await clearSession();
    return false;
  }
  try {
    const got = await (await fetch(SESSION_URL)).json();
    if (!got || !got.refreshToken) return false;
    const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(firebaseConfig.apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(got.refreshToken),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 403) await clearSession(); // 鍵が無効になっている
      return false;
    }
    const t = await res.json();
    if (!t.user_id || !t.id_token || !t.refresh_token) return false;
    ls.setItem(`firebase:authUser:${firebaseConfig.apiKey}:[DEFAULT]`, JSON.stringify({
      uid: t.user_id,
      emailVerified: false,   // 名前やメールアドレスは、起動時に Firebase がサーバーから読み直す
      isAnonymous: false,
      providerData: [],
      stsTokenManager: {
        refreshToken: t.refresh_token,
        accessToken: t.id_token,
        expirationTime: Date.now() + (Number(t.expires_in) || 3600) * 1000,
      },
      apiKey: firebaseConfig.apiKey,
      appName: '[DEFAULT]',
    }));
    ss.setItem('tools.restore', '1');
    location.reload();
    return true;
  } catch (e) {
    return false; // 通信できないときなどは、ログインしていない状態で続ける
  }
}

/** 戻したあとの読み込みでログインできていたら、やり直し防止の印を外す */
function restoreSucceeded() {
  const ss = store('sessionStorage');
  if (ss) ss.removeItem('tools.restore');
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
  await saveSession(cred.user); // すぐ別のページへ移っても控えが残るよう、ここで待つ
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
  await saveSession(cred.user); // すぐ別のページへ移っても控えが残るよう、ここで待つ
  return cred.user;
}

export async function logOut() {
  await clearSession();
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
      ? 'データが大きすぎて保存できません。'
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

/* ---------- スライドのデッキ ---------- */

export const decks = {
  /** 一覧：{ id, title, theme, first（1枚目）, count（枚数）, created, updated } */
  async list() {
    return (await api('/api/decks')).decks;
  },
  /** デッキ全体。見つからなければ null */
  async get(id) {
    try {
      return (await api('/api/decks?id=' + enc(id))).deck;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
  /** 保存（無ければ作成） */
  async put(deck) {
    await api('/api/decks?id=' + enc(deck.id), { method: 'PUT', body: deck });
  },
  async remove(id) {
    await api('/api/decks?id=' + enc(id), { method: 'DELETE' });
  },
};

/* ---------- スライドに追加したフォント ---------- */

const FONT_CHUNK = 2.5 * 1024 * 1024; // Vercel が 1 回に受け取れる量（約 4MB）に収まるよう小分けにする

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const fonts = {
  /** 一覧：{ name, kind, size, chunks }（kind: file / name / pick） */
  async list() {
    return (await api('/api/fonts')).fonts;
  },
  /** 保存。kind が file のときは data（ArrayBuffer）を小分けにして送る */
  async put({ name, kind, data }) {
    const path = '/api/fonts?name=' + enc(name);
    if (kind !== 'file') {
      await api(path, { method: 'PUT', body: { kind } });
      return;
    }
    const bytes = new Uint8Array(data);
    const chunks = Math.max(1, Math.ceil(bytes.length / FONT_CHUNK));
    await api(path, { method: 'PUT', body: { kind, size: bytes.length, chunks } });
    for (let i = 0; i < chunks; i++) {
      await api(path + '&seq=' + i, {
        method: 'PUT',
        body: { data: toBase64(bytes.subarray(i * FONT_CHUNK, (i + 1) * FONT_CHUNK)) },
      });
    }
    await api(path + '&done=1', { method: 'PUT', body: {} });
  },
  /** フォントファイルの中身（ArrayBuffer） */
  async get({ name, size, chunks }) {
    const out = new Uint8Array(size);
    let at = 0;
    for (let i = 0; i < chunks; i++) {
      const part = fromBase64((await api('/api/fonts?name=' + enc(name) + '&seq=' + i)).data);
      if (at + part.length > size) throw new Error('フォントのデータが壊れています。');
      out.set(part, at);
      at += part.length;
    }
    if (at !== size) throw new Error('フォントのデータが壊れています。');
    return out.buffer;
  },
  async remove(name) {
    await api('/api/fonts?name=' + enc(name), { method: 'DELETE' });
  },
};
