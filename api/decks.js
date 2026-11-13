/*
 * スライドの保存 API（Vercel サーバーレス関数）
 *
 *   GET    /api/decks           自分のスライド一覧（各デッキの1枚目と枚数だけ。サムネイル用）
 *   GET    /api/decks?id=…      1件（デッキ全体）
 *   PUT    /api/decks?id=…      保存（無ければ作成、あれば上書き）  本文 = デッキ全体
 *   DELETE /api/decks?id=…      削除
 *
 * デッキの id はブラウザ側で作る（スライドはオフラインでも作り始められるため）。
 * すべて Authorization: Bearer <Firebase ID トークン> が必要。他人のデッキは見えない。
 */
const { requireUser, httpError } = require('./_lib/auth');
const db = require('./_lib/db');
const { send, readBody, route, iso } = require('./_lib/http');

const ID_RE = /^[a-z0-9]{1,40}$/;

function checkId(id) {
  if (!id || !ID_RE.test(id)) throw httpError(400, 'id が正しくありません。');
  return id;
}

function checkDeck(body, id) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.slides) || !body.slides.length) {
    throw httpError(400, 'スライドのデータではありません。');
  }
  const ms = (v) => (Number.isFinite(+v) && +v > 0 ? +v : Date.now());
  return {
    ...body,
    id,
    title: String(body.title || '無題のスライド').slice(0, 100),
    created: ms(body.created),
    updated: ms(body.updated),
  };
}

module.exports = route(async (req, res, url) => {
  const user = await requireUser(req);
  const id = url.searchParams.get('id');

  if (req.method === 'GET' && !id) {
    const { rows } = await db.query(
      `SELECT id, title, data->'theme' AS theme, data->'slides'->0 AS first,
              jsonb_array_length(data->'slides') AS count,
              (data->>'created')::double precision AS created,
              (data->>'updated')::double precision AS updated
         FROM decks WHERE uid = $1 ORDER BY updated_at DESC`,
      [user.uid]);
    return send(res, 200, { decks: rows });
  }

  if (req.method === 'GET') {
    const { rows } = await db.query('SELECT data FROM decks WHERE uid = $1 AND id = $2', [user.uid, checkId(id)]);
    if (!rows.length) throw httpError(404, 'スライドが見つかりませんでした。');
    return send(res, 200, { deck: rows[0].data });
  }

  if (req.method === 'PUT') {
    const deck = checkDeck(await readBody(req), checkId(id));
    const { rows } = await db.query(
      `INSERT INTO decks (uid, id, title, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (uid, id) DO UPDATE SET title = EXCLUDED.title, data = EXCLUDED.data, updated_at = now()
         RETURNING updated_at`,
      [user.uid, deck.id, deck.title, JSON.stringify(deck)]);
    return send(res, 200, { ok: true, saved_at: iso(rows[0].updated_at) });
  }

  if (req.method === 'DELETE') {
    const { rowCount } = await db.query('DELETE FROM decks WHERE uid = $1 AND id = $2', [user.uid, checkId(id)]);
    if (!rowCount) throw httpError(404, 'スライドが見つかりませんでした。');
    return send(res, 200, { ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE, OPTIONS');
  throw httpError(405, 'この操作には対応していません。');
});
