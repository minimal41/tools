/*
 * Making Site のサイト保存 API（Vercel サーバーレス関数）
 *
 *   GET    /api/sites           自分のサイト一覧（html / state は含まない）
 *   GET    /api/sites?id=…      1件（html / state を含む）
 *   POST   /api/sites           作成   { title, html?, state? } → { id }
 *   PUT    /api/sites?id=…      更新   { title?, html?, state? }（送った項目だけ変更）
 *   DELETE /api/sites?id=…      削除
 *
 * すべて Authorization: Bearer <Firebase ID トークン> が必要。
 * 他人のサイトは見えない（uid で絞り込む）。
 */
const crypto = require('node:crypto');
const { requireUser, httpError } = require('./_lib/auth');
const db = require('./_lib/db');
const { send, readBody, route, iso } = require('./_lib/http');

/* 受け取ってよい項目だけを取り出して型を確かめる */
function pickFields(body) {
  const out = {};
  if (!body || typeof body !== 'object') throw httpError(400, 'データの形式が正しくありません。');
  if ('title' in body) {
    if (typeof body.title !== 'string') throw httpError(400, 'title が正しくありません。');
    out.title = body.title.slice(0, 200);
  }
  if ('html' in body) {
    if (body.html !== null && typeof body.html !== 'string') throw httpError(400, 'html が正しくありません。');
    out.html = body.html;
  }
  if ('state' in body) {
    if (body.state !== null && typeof body.state !== 'object') throw httpError(400, 'state が正しくありません。');
    out.state = body.state;
  }
  return out;
}

function toSite(row, full) {
  const site = {
    id: row.id,
    title: row.title,
    has_html: row.has_html !== undefined ? row.has_html : row.html != null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
  if (full) {
    site.html = row.html;
    site.state = row.state;
  }
  return site;
}

module.exports = route(async (req, res, url) => {
    const user = await requireUser(req);
    const id = url.searchParams.get('id');

    if (req.method === 'GET' && !id) {
      const { rows } = await db.query(
        `SELECT id, title, html IS NOT NULL AS has_html, created_at, updated_at
           FROM sites WHERE uid = $1 ORDER BY created_at DESC`,
        [user.uid]);
      return send(res, 200, { sites: rows.map((r) => toSite(r, false)) });
    }

    if (req.method === 'GET') {
      const { rows } = await db.query('SELECT * FROM sites WHERE id = $1 AND uid = $2', [id, user.uid]);
      if (!rows.length) throw httpError(404, 'サイトが見つかりませんでした。');
      return send(res, 200, { site: toSite(rows[0], true) });
    }

    if (req.method === 'POST') {
      const f = pickFields(await readBody(req));
      const newId = crypto.randomUUID();
      await db.query(
        `INSERT INTO sites (id, uid, title, html, state) VALUES ($1, $2, $3, $4, $5)`,
        [newId, user.uid, f.title || '', f.html ?? null, f.state === undefined ? null : JSON.stringify(f.state)]);
      return send(res, 201, { id: newId });
    }

    if (req.method === 'PUT') {
      if (!id) throw httpError(400, 'id を指定してください。');
      const f = pickFields(await readBody(req));
      const sets = [];
      const params = [id, user.uid];
      for (const key of ['title', 'html', 'state']) {
        if (!(key in f)) continue;
        params.push(key === 'state' && f.state !== null ? JSON.stringify(f.state) : f[key]);
        sets.push(`${key} = $${params.length}`);
      }
      sets.push('updated_at = now()');
      const { rowCount } = await db.query(
        `UPDATE sites SET ${sets.join(', ')} WHERE id = $1 AND uid = $2`, params);
      if (!rowCount) throw httpError(404, 'サイトが見つかりませんでした。');
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      if (!id) throw httpError(400, 'id を指定してください。');
      const { rowCount } = await db.query('DELETE FROM sites WHERE id = $1 AND uid = $2', [id, user.uid]);
      if (!rowCount) throw httpError(404, 'サイトが見つかりませんでした。');
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE, OPTIONS');
    throw httpError(405, 'この操作には対応していません。');
});
