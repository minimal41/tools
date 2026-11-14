/*
 * ログインの控え（Vercel サーバーレス関数）
 *
 * Firebase はログイン状態をブラウザの保存領域（IndexedDB）に覚えているが、
 * ブラウザによっては一定期間で消されたり、起動時の確認に失敗して消えたりする。
 * そこで、ログインを続けるための鍵（リフレッシュトークン）を、
 * JavaScript から読めない Cookie（HttpOnly）にも控えておき、消えたときはそこから戻す。
 *
 *   POST   /api/session   控えを保存（本文 { refreshToken }、Authorization: Bearer <ID トークン> が必要）
 *   GET    /api/session   控えを返す（Cookie の期限も延ばす）
 *   DELETE /api/session   控えを消す（ログアウト時）
 *
 * Cookie は同じサイトからのリクエストにしか付かない（SameSite=Lax）ので、
 * ページと API を同じ場所（Vercel）に置いているときだけ働く。
 */
const { requireUser, httpError } = require('./_lib/auth');
const { send, readBody, route } = require('./_lib/http');

const MAX_AGE = 400 * 24 * 60 * 60; // ブラウザが許す上限（約400日）。使うたびに延びる
const TOKEN = 'tools_rt';           // 鍵そのもの。JavaScript からは読めない
const FLAG = 'tools_in';            // 「控えがある」という目印だけ。ページ側が問い合わせるかどうかの判断に使う

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

function setCookies(res, token) {
  const age = token ? MAX_AGE : 0;
  const common = `Secure; SameSite=Lax; Max-Age=${age}`;
  res.setHeader('Set-Cookie', [
    `${TOKEN}=${token ? encodeURIComponent(token) : ''}; Path=/api/session; HttpOnly; ${common}`,
    `${FLAG}=${token ? '1' : ''}; Path=/; ${common}`,
  ]);
}

module.exports = route(async (req, res) => {
  if (req.method === 'GET') {
    const token = readCookie(req, TOKEN);
    setCookies(res, token); // あれば期限を延ばし、無ければ目印も片付ける
    return send(res, 200, { refreshToken: token || null });
  }

  if (req.method === 'POST') {
    await requireUser(req); // ログイン中の本人からの依頼だけ受ける
    const body = await readBody(req);
    const token = body && body.refreshToken;
    if (typeof token !== 'string' || token.length < 20 || token.length > 3000 || /[\s;,]/.test(token)) {
      throw httpError(400, 'データの形式が正しくありません。');
    }
    setCookies(res, token);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    setCookies(res, null);
    return send(res, 200, { ok: true });
  }

  throw httpError(405, 'この操作はできません。');
});
