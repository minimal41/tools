/*
 * スライドに追加したフォントの保存 API（Vercel サーバーレス関数）
 *
 *   GET    /api/fonts                 自分のフォント一覧 { name, kind, size, chunks }
 *   GET    /api/fonts?name=…&seq=n    フォントファイルの n 番目のかたまり { data: base64 }
 *   PUT    /api/fonts?name=…          登録を始める  本文 { kind, size, chunks }
 *   PUT    /api/fonts?name=…&seq=n    n 番目のかたまりを送る  本文 { data: base64 }
 *   PUT    /api/fonts?name=…&done=1   送り終えた（ここで一覧に出るようになる）
 *   DELETE /api/fonts?name=…          削除
 *
 * kind: file = フォントファイル / name = 端末に入っているフォントの名前 / pick = 選んだ Google フォント
 *
 * 日本語フォントは 1 ファイルで 10MB を超えることがあり、Vercel は 1 回に約 4MB までしか
 * 受け取れないので、ファイルは小分けにして送る。
 * すべて Authorization: Bearer <Firebase ID トークン> が必要。他人のフォントは見えない。
 */
const { requireUser, httpError } = require('./_lib/auth');
const db = require('./_lib/db');
const { send, readBody, route } = require('./_lib/http');

const NAME_RE = /^[\p{L}\p{N} \-]{1,60}$/u;
const KINDS = ['file', 'name', 'pick'];
const CHUNK_MAX = 2.6 * 1024 * 1024;      // 1 かたまりの上限（ブラウザ側は 2.5MB ずつ送る）
const FILE_MAX = 40 * 1024 * 1024;        // 1 ファイルの上限
const TOTAL_MAX = 150 * 1024 * 1024;      // 1 アカウントの合計の上限
const COUNT_MAX = 300;

function checkName(name) {
  if (!name || !NAME_RE.test(name)) throw httpError(400, 'フォントの名前が正しくありません。');
  return name;
}

const int = (v) => (Number.isInteger(+v) && +v >= 0 ? +v : NaN);

module.exports = route(async (req, res, url) => {
  const user = await requireUser(req);
  const q = url.searchParams;
  const hasName = q.has('name');
  const name = hasName ? checkName(q.get('name')) : null;
  const seq = q.has('seq') ? int(q.get('seq')) : null;
  if (seq !== null && Number.isNaN(seq)) throw httpError(400, '番号が正しくありません。');

  if (req.method === 'GET' && !hasName) {
    const { rows } = await db.query(
      'SELECT name, kind, size, chunks FROM fonts WHERE uid = $1 AND complete ORDER BY created_at, name',
      [user.uid]);
    return send(res, 200, { fonts: rows });
  }

  if (req.method === 'GET' && seq !== null) {
    const { rows } = await db.query(
      'SELECT data FROM font_chunks WHERE uid = $1 AND name = $2 AND seq = $3', [user.uid, name, seq]);
    if (!rows.length) throw httpError(404, 'フォントが見つかりませんでした。');
    return send(res, 200, { data: rows[0].data.toString('base64') });
  }

  if (req.method === 'PUT' && hasName && seq === null && !q.has('done')) {
    const body = await readBody(req);
    const kind = body && body.kind;
    if (!KINDS.includes(kind)) throw httpError(400, 'データの形式が正しくありません。');
    const size = kind === 'file' ? int(body.size) : 0;
    const chunks = kind === 'file' ? int(body.chunks) : 0;
    if (Number.isNaN(size) || Number.isNaN(chunks)) throw httpError(400, 'データの形式が正しくありません。');
    if (kind === 'file') {
      if (!size || !chunks || chunks > Math.ceil(FILE_MAX / (1024 * 1024))) throw httpError(400, 'データの形式が正しくありません。');
      if (size > FILE_MAX) throw httpError(413, 'フォントファイルが大きすぎます（40MB まで）。');
    }
    const { rows } = await db.query(
      'SELECT count(*)::int AS n, coalesce(sum(size), 0)::bigint AS total FROM fonts WHERE uid = $1 AND name <> $2',
      [user.uid, name]);
    if (rows[0].n >= COUNT_MAX) throw httpError(413, '追加できるフォントの数の上限に達しました。');
    if (Number(rows[0].total) + size > TOTAL_MAX) throw httpError(413, 'アカウントに保存できるフォントの容量（150MB）を超えます。使わないフォントを削除してください。');

    // 同じ名前で登録し直すときは、前のファイルを捨てる
    await db.query('DELETE FROM font_chunks WHERE uid = $1 AND name = $2', [user.uid, name]);
    await db.query(
      `INSERT INTO fonts (uid, name, kind, size, chunks, complete) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (uid, name) DO UPDATE SET kind = $3, size = $4, chunks = $5, complete = $6`,
      [user.uid, name, kind, size, chunks, kind !== 'file']);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && hasName && seq !== null) {
    const { rows } = await db.query('SELECT chunks FROM fonts WHERE uid = $1 AND name = $2', [user.uid, name]);
    if (!rows.length || seq >= rows[0].chunks) throw httpError(400, '番号が正しくありません。');
    const body = await readBody(req);
    if (!body || typeof body.data !== 'string') throw httpError(400, 'データの形式が正しくありません。');
    const data = Buffer.from(body.data, 'base64');
    if (!data.length || data.length > CHUNK_MAX) throw httpError(413, 'データが大きすぎます。');
    await db.query(
      `INSERT INTO font_chunks (uid, name, seq, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (uid, name, seq) DO UPDATE SET data = $4`,
      [user.uid, name, seq, data]);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && hasName && q.has('done')) {
    const { rows } = await db.query(
      `SELECT f.chunks, f.size,
              (SELECT count(*)::int FROM font_chunks c WHERE c.uid = f.uid AND c.name = f.name) AS got,
              (SELECT coalesce(sum(length(c.data)), 0)::bigint FROM font_chunks c WHERE c.uid = f.uid AND c.name = f.name) AS bytes
         FROM fonts f WHERE f.uid = $1 AND f.name = $2`, [user.uid, name]);
    if (!rows.length) throw httpError(404, 'フォントが見つかりませんでした。');
    if (rows[0].got !== rows[0].chunks || Number(rows[0].bytes) !== rows[0].size) {
      throw httpError(400, 'フォントファイルを最後まで受け取れませんでした。もう一度追加してください。');
    }
    await db.query('UPDATE fonts SET complete = true WHERE uid = $1 AND name = $2', [user.uid, name]);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && hasName) {
    await db.query('DELETE FROM font_chunks WHERE uid = $1 AND name = $2', [user.uid, name]);
    await db.query('DELETE FROM fonts WHERE uid = $1 AND name = $2', [user.uid, name]);
    return send(res, 200, { ok: true });
  }

  throw httpError(405, 'この操作はできません。');
});
