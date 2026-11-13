/*
 * Firebase の ID トークンを検証して、ログイン中のユーザー（uid）を取り出す。
 * ブラウザ側は shared/account.js が Authorization: Bearer <ID トークン> を付けて呼ぶ。
 *
 * 必要な環境変数: FIREBASE_PROJECT_ID（Firebase のプロジェクト ID）
 * 検証にはサービスアカウントの鍵は不要（Google の公開鍵で署名を確かめる）。
 */
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

function auth() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) throw httpError(500, 'サーバーの設定が不足しています（FIREBASE_PROJECT_ID）。');
    initializeApp({ projectId });
  }
  return getAuth();
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function requireUser(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw httpError(401, 'ログインしていません。');
  try {
    const decoded = await auth().verifyIdToken(m[1]);
    return { uid: decoded.uid, email: decoded.email || '' };
  } catch (e) {
    if (e.status) throw e;
    throw httpError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。');
  }
}

module.exports = { requireUser, httpError };
