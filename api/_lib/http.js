/* API 共通：レスポンス・CORS・リクエスト本文の読み込み */
const { httpError } = require('./auth');

const MAX_BODY = 4 * 1024 * 1024; // Vercel の上限（4.5MB）より少し小さく
const TOO_BIG = 'データが大きすぎて保存できません。画像を小さくしてください。';

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(data === undefined ? '' : JSON.stringify(data));
}

function cors(res) {
  // 認証は Cookie ではなく Authorization ヘッダーなので、どのオリジンから呼ばれても安全
  // （GitHub Pages など別の場所に置いたページからも使えるようにする）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body; // Vercel が JSON を解析済み
  }
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!raw) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw httpError(413, TOO_BIG);
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (raw.length > MAX_BODY) throw httpError(413, TOO_BIG);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, 'データの形式が正しくありません。'); }
}

/* 共通の入口：CORS・OPTIONS・エラー処理をまとめる */
function route(fn) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return send(res, 204);
    try {
      await fn(req, res, new URL(req.url, 'http://localhost'));
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'サーバーでエラーが発生しました。' });
    }
  };
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

module.exports = { send, readBody, route, iso };
