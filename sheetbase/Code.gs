/**
 * Sheetbase — Google スプレッドシートをデータベースにするサーバー（Google Apps Script）
 *
 * 使い方（くわしくは README.md）
 *   1. スプレッドシートを開き、「拡張機能 → Apps Script」にこのファイルを貼り付ける
 *   2. 関数 setup を一度実行する（管理キーがログに出る）
 *   3. 「デプロイ → 新しいデプロイ → ウェブアプリ」
 *        実行するユーザー：自分 ／ アクセスできるユーザー：全員
 *   4. 出てきた URL を sheetbase.js の createClient に渡す
 *
 * シート 1 枚がテーブル 1 つ。1 行目が列名、2 行目からがデータ。
 */

/* ───────── 設定 ───────── */

/**
 * テーブルごとのアクセスルール。'*' は書いていないテーブルすべてに使われる。
 *   'public' … だれでも
 *   'auth'   … ログインした人
 *   'owner'  … ログインした人が、自分の行（userId が自分）だけ
 *   'admin'  … 管理キーを持つ人だけ
 */
var RULES = {
  '*': { read: 'public', write: 'auth' }
  // 例:
  // todos: { read: 'owner',  write: 'owner' },
  // posts: { read: 'public', write: 'owner' },
  // logs:  { read: 'admin',  write: 'public' }
};

/** true なら、まだ無いテーブル・列への書き込みで自動的にシート・列を作る。false なら管理キーのときだけ作る */
var AUTO_SCHEMA = true;

/** だれでもアカウントを作れるか。false なら signUp は管理キーが必要 */
var ALLOW_SIGNUP = true;

/** ログインの有効期間（日） */
var TOKEN_DAYS = 30;

/** 1 回のリクエストで書き込める行数の上限 */
var MAX_ROWS_PER_WRITE = 500;

/* ───────── 入口 ───────── */

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return respond_({ data: null, error: { code: 'bad_request', message: 'JSON を読めませんでした' } });
  }
  return respond_(run_(req));
}

/** GET は読み取り専用。例: ?table=todos&limit=10&order=createdAt.desc */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var req = { action: p.action || (p.table ? 'select' : 'ping'), key: p.key, token: p.token };
  if (req.action !== 'select' && req.action !== 'ping' && req.action !== 'getUser') {
    return respond_({ data: null, error: { code: 'bad_request', message: 'GET で使えるのは select / ping / getUser だけです' } });
  }
  try {
    req.table = p.table;
    if (p.columns) req.columns = p.columns.split(',');
    if (p.filters) req.filters = JSON.parse(p.filters);
    if (p.limit) req.limit = Number(p.limit);
    if (p.offset) req.offset = Number(p.offset);
    if (p.order) {
      req.order = p.order.split(',').map(function (s) {
        var parts = s.split('.');
        return { col: parts[0], asc: parts[1] !== 'desc' };
      });
    }
  } catch (err) {
    return respond_({ data: null, error: { code: 'bad_request', message: 'パラメータを読めませんでした' } });
  }
  return respond_(run_(req));
}

/** エディタから一度だけ実行する。キーを作ってログに表示する */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', 'sb_admin_' + randomId_() + randomId_());
  secret_();
  Logger.log('管理キー (ADMIN_KEY): ' + props.getProperty('ADMIN_KEY'));
  Logger.log('管理キーはすべてのルールを飛ばせます。ブラウザに配るコードには書かないでください。');
  Logger.log('公開キー (API_KEY): ' + (props.getProperty('API_KEY') || '未設定（URL を知っていればだれでも呼べます）'));
}

/* ───────── 本体 ───────── */

function run_(req) {
  try {
    if (!req || typeof req !== 'object') fail_('bad_request', 'リクエストが正しくありません');
    var ctx = context_(req);
    var out = dispatch_(req, ctx);
    if (out && out.__envelope) return { data: out.data, count: out.count, error: null };
    return { data: out, error: null };
  } catch (err) {
    if (err && err.apiCode) return { data: null, error: { code: err.apiCode, message: err.message } };
    return { data: null, error: { code: 'server_error', message: String((err && err.message) || err) } };
  }
}

function dispatch_(req, ctx) {
  switch (req.action) {
    case 'ping': return { ok: true, time: new Date().toISOString() };
    case 'select': return select_(req, ctx);
    case 'insert': return withLock_(function () { return insert_(req, ctx); });
    case 'update': return withLock_(function () { return update_(req, ctx); });
    case 'delete': return withLock_(function () { return delete_(req, ctx); });
    case 'upsert': return withLock_(function () { return upsert_(req, ctx); });
    case 'signUp': return withLock_(function () { return signUp_(req, ctx); });
    case 'signIn': return signIn_(req);
    case 'getUser':
      if (!ctx.user) fail_('unauthorized', 'ログインしていません');
      return { id: ctx.user.id, email: ctx.user.email };
    case 'tables':
      if (!ctx.admin) fail_('forbidden', '管理キーが必要です');
      return book_().getSheets().map(function (s) { return s.getName(); })
        .filter(function (n) { return n.charAt(0) !== '_'; });
    default:
      fail_('bad_request', '知らない action です: ' + req.action);
  }
}

function context_(req) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('API_KEY');
  var adminKey = props.getProperty('ADMIN_KEY');
  var admin = !!adminKey && req.key === adminKey;
  if (apiKey && !admin && req.key !== apiKey) fail_('invalid_key', 'API キーが違います');
  var user = null;
  if (req.token) {
    user = verifyToken_(String(req.token));
    if (!user) fail_('invalid_token', 'ログインの期限が切れました。もう一度ログインしてください');
  }
  return { admin: admin, user: user };
}

/* ───────── ルール ───────── */

/** その操作に使うルール（'public' など）を返す。許されないときはエラー */
function authorize_(table, op, ctx) {
  var rule = RULES[table] || RULES['*'] || {};
  var level = rule[op] || 'admin';
  if (ctx.admin) return 'admin';
  if (level === 'public') return level;
  if (level === 'auth' || level === 'owner') {
    if (!ctx.user) fail_('unauthorized', 'ログインが必要です');
    return level;
  }
  fail_('forbidden', 'この操作は許可されていません');
}

/* ───────── データベース ───────── */

function select_(req, ctx) {
  var name = tableName_(req.table);
  var level = authorize_(name, 'read', ctx);
  var sheet = book_().getSheetByName(name);
  var t = sheet ? readTable_(sheet) : { headers: [], rows: [] };
  var rows = t.rows.filter(matcher_(req.filters, level, ctx)).map(function (r) { return r.obj; });
  var count = rows.length;

  var order = req.order || [];
  if (order.length) {
    rows.sort(function (a, b) {
      for (var i = 0; i < order.length; i++) {
        var c = compare_(a[order[i].col], b[order[i].col]);
        if (c !== 0) return order[i].asc === false ? -c : c;
      }
      return 0;
    });
  }

  var offset = Math.max(0, Number(req.offset) || 0);
  if (offset || req.limit != null) {
    var limit = req.limit != null ? Math.max(0, Number(req.limit) || 0) : rows.length;
    rows = rows.slice(offset, offset + limit);
  }

  if (req.columns && req.columns.length) {
    var cols = req.columns.map(function (c) { return String(c).trim(); });
    rows = rows.map(function (r) {
      var o = {};
      cols.forEach(function (c) { o[c] = c in r ? r[c] : null; });
      return o;
    });
  }
  return { __envelope: true, data: rows, count: count };
}

function insert_(req, ctx) {
  var name = tableName_(req.table);
  var level = authorize_(name, 'write', ctx);
  var input = rowsOf_(req.rows);
  var sheet = openTable_(name, ctx, true);
  var t = readTable_(sheet);
  var seen = {};
  t.rows.forEach(function (r) { if (r.obj.id != null) seen[String(r.obj.id)] = true; });

  var now = new Date().toISOString();
  var objs = input.map(function (row) {
    var o = copy_(row);
    if (o.id == null || o.id === '') o.id = Utilities.getUuid();
    if (seen[String(o.id)]) fail_('conflict', 'id が重なっています: ' + o.id);
    seen[String(o.id)] = true;
    if (!ctx.admin || o.createdAt == null) o.createdAt = now;
    o.updatedAt = now;
    if (level === 'owner') o.userId = ctx.user.id;
    else if (!ctx.admin && 'userId' in o && !(ctx.user && o.userId === ctx.user.id)) delete o.userId;
    return o;
  });

  appendRows_(sheet, t, objs, ctx);
  return objs;
}

function update_(req, ctx) {
  var name = tableName_(req.table);
  var level = authorize_(name, 'write', ctx);
  if (!req.filters || !req.filters.length) fail_('bad_request', 'update には条件（eq など）が必要です');
  var values = req.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail_('bad_request', 'values がありません');
  var sheet = book_().getSheetByName(name);
  if (!sheet) return [];
  var t = readTable_(sheet);
  var hit = t.rows.filter(matcher_(req.filters, level, ctx));
  return patchRows_(sheet, t, hit.map(function (r) { return { row: r, values: values }; }), ctx);
}

function delete_(req, ctx) {
  var name = tableName_(req.table);
  var level = authorize_(name, 'write', ctx);
  if (!req.filters || !req.filters.length) fail_('bad_request', 'delete には条件（eq など）が必要です');
  var sheet = book_().getSheetByName(name);
  if (!sheet) return [];
  var t = readTable_(sheet);
  var hit = t.rows.filter(matcher_(req.filters, level, ctx));
  // 下の行から消す（上から消すと行番号がずれる）
  hit.slice().sort(function (a, b) { return b.rowNumber - a.rowNumber; })
    .forEach(function (r) { sheet.deleteRow(r.rowNumber); });
  return hit.map(function (r) { return r.obj; });
}

/** onConflict の列（ふつうは id）が同じ行があれば更新、なければ追加 */
function upsert_(req, ctx) {
  var name = tableName_(req.table);
  var level = authorize_(name, 'write', ctx);
  var key = req.onConflict ? String(req.onConflict) : 'id';
  var input = rowsOf_(req.rows);
  var sheet = openTable_(name, ctx, true);
  var t = readTable_(sheet);
  var index = {};
  t.rows.forEach(function (r) { if (r.obj[key] != null) index[String(r.obj[key])] = r; });

  var patches = [];
  var fresh = [];
  input.forEach(function (row) {
    var found = row[key] != null ? index[String(row[key])] : null;
    if (!found) { fresh.push(row); return; }
    if (level === 'owner' && String(found.obj.userId) !== String(ctx.user.id)) {
      fail_('forbidden', 'ほかの人の行は書きかえられません');
    }
    patches.push({ row: found, values: row });
  });

  var updated = patchRows_(sheet, t, patches, ctx);
  var inserted = fresh.length
    ? insert_({ table: name, rows: fresh }, ctx)
    : [];
  return updated.concat(inserted);
}

/* ───────── 認証 ───────── */

var USERS_ = '_users';

function signUp_(req, ctx) {
  if (!ALLOW_SIGNUP && !ctx.admin) fail_('forbidden', '新しいアカウントは作れません');
  var email = String(req.email || '').trim().toLowerCase();
  var password = String(req.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('bad_request', 'メールアドレスが正しくありません');
  if (password.length < 8) fail_('bad_request', 'パスワードは 8 文字以上にしてください');

  var ss = book_();
  var sheet = ss.getSheetByName(USERS_);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_);
    writeHeaders_(sheet, 1, ['id', 'email', 'passwordHash', 'salt', 'createdAt']);
  }
  var t = readTable_(sheet);
  if (t.rows.some(function (r) { return r.obj.email === email; })) {
    fail_('conflict', 'このメールアドレスはもう登録されています');
  }
  var salt = randomId_();
  var user = {
    id: Utilities.getUuid(),
    email: email,
    passwordHash: hashPassword_(password, salt),
    salt: salt,
    createdAt: new Date().toISOString()
  };
  appendRows_(sheet, t, [user], { admin: true });
  return session_(user);
}

function signIn_(req) {
  var email = String(req.email || '').trim().toLowerCase();
  var password = String(req.password || '');
  var sheet = book_().getSheetByName(USERS_);
  var found = null;
  if (sheet) {
    readTable_(sheet).rows.forEach(function (r) { if (r.obj.email === email) found = r.obj; });
  }
  if (!found || hashPassword_(password, String(found.salt)) !== found.passwordHash) {
    fail_('invalid_credentials', 'メールアドレスかパスワードが違います');
  }
  return session_(found);
}

function session_(user) {
  var exp = Date.now() + TOKEN_DAYS * 86400000;
  var body = Utilities.base64EncodeWebSafe(JSON.stringify({ id: user.id, email: user.email, exp: exp }), Utilities.Charset.UTF_8);
  return {
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
    token: body + '.' + sign_(body),
    expiresAt: new Date(exp).toISOString()
  };
}

function verifyToken_(token) {
  var parts = token.split('.');
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) return null;
  try {
    var p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    if (!p.id || !(p.exp > Date.now())) return null;
    return { id: p.id, email: p.email };
  } catch (err) {
    return null;
  }
}

function sign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret_()));
}

function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = randomId_() + randomId_();
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function hashPassword_(password, salt) {
  var h = salt + ':' + password;
  for (var i = 0; i < 200; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + h, Utilities.Charset.UTF_8));
  }
  return h;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function randomId_() {
  return Utilities.getUuid().replace(/-/g, '');
}

/* ───────── シートの読み書き ───────── */

function book_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) fail_('server_error', 'スプレッドシートが見つかりません。スクリプトプロパティ SPREADSHEET_ID を設定してください');
  return ss;
}

function tableName_(name) {
  name = String(name == null ? '' : name).trim();
  if (!name || name.length > 80 || name.charAt(0) === '_' || /[\[\]\*\?\/\\:']/.test(name)) {
    fail_('bad_request', 'テーブル名が正しくありません');
  }
  return name;
}

function openTable_(name, ctx, create) {
  var ss = book_();
  var sheet = ss.getSheetByName(name);
  if (!sheet && create) {
    if (!AUTO_SCHEMA && !ctx.admin) fail_('not_found', 'テーブルがありません: ' + name);
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

/**
 * シートを読む。
 * 戻り値: { headers: [列名], rows: [{ rowNumber, raw: [セルの値], obj: {列名: 値} }] }
 */
function readTable_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var raw = values[i];
    var obj = {};
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = fromCell_(raw[c]);
      if (v !== null) empty = false;
      obj[headers[c]] = v;
    }
    if (!empty) rows.push({ rowNumber: i + 1, raw: raw, obj: obj });
  }
  return { headers: headers, rows: rows };
}

/** まだ無い列を右に足す。t.headers も更新する */
function ensureColumns_(sheet, t, keys, ctx) {
  var add = [];
  keys.forEach(function (k) {
    k = String(k).trim();
    if (!k) fail_('bad_request', '列名が空です');
    if (t.headers.indexOf(k) < 0 && add.indexOf(k) < 0) add.push(k);
  });
  if (!add.length) return;
  if (!AUTO_SCHEMA && !ctx.admin && t.headers.length) fail_('bad_request', '列がありません: ' + add.join(', '));
  writeHeaders_(sheet, t.headers.length + 1, add);
  t.headers = t.headers.concat(add);
}

function writeHeaders_(sheet, startCol, names) {
  sheet.getRange(1, startCol, 1, names.length)
    .setValues([names.map(function (n) { return toCell_(n); })]);
  if (startCol === 1) sheet.setFrozenRows(1);
}

function appendRows_(sheet, t, objs, ctx) {
  if (!objs.length) return;
  var keys = [];
  if (!t.headers.length) keys = ['id', 'createdAt', 'updatedAt'];
  objs.forEach(function (o) { Object.keys(o).forEach(function (k) { keys.push(k); }); });
  ensureColumns_(sheet, t, keys, ctx);
  var matrix = objs.map(function (o) {
    return t.headers.map(function (h) { return h && h in o ? toCell_(o[h]) : ''; });
  });
  sheet.getRange(Math.max(sheet.getLastRow(), 1) + 1, 1, matrix.length, t.headers.length).setValues(matrix);
}

/** patches: [{ row, values }]。書きかえた後の行を返す */
function patchRows_(sheet, t, patches, ctx) {
  if (!patches.length) return [];
  var now = new Date().toISOString();
  var keys = ['updatedAt'];
  patches.forEach(function (p) {
    p.values = copy_(p.values);
    delete p.values.id;
    if (!ctx.admin) { delete p.values.createdAt; delete p.values.userId; }
    p.values.updatedAt = now;
    Object.keys(p.values).forEach(function (k) { keys.push(k); });
  });
  ensureColumns_(sheet, t, keys, ctx);
  return patches.map(function (p) {
    var line = t.headers.map(function (h, c) {
      if (h && h in p.values) return toCell_(p.values[h]);
      var old = c < p.row.raw.length ? p.row.raw[c] : '';
      return typeof old === 'string' && old !== '' ? "'" + old : old;
    });
    sheet.getRange(p.row.rowNumber, 1, 1, line.length).setValues([line]);
    var obj = copy_(p.row.obj);
    t.headers.forEach(function (h) { if (h && !(h in obj)) obj[h] = null; });
    Object.keys(p.values).forEach(function (k) {
      obj[k] = p.values[k] === undefined || p.values[k] === '' ? null : p.values[k];
    });
    return obj;
  });
}

/**
 * JS の値 → セルの値。
 * 文字列は先頭に ' を付けて「文字のまま」入れる（"001" が 1 になったり、=式 が動いたりしないように）。
 */
function toCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === '' ? '' : "'" + v;
  return "'" + JSON.stringify(v);
}

/** セルの値 → JS の値。空は null、日付は ISO 文字列、JSON らしい文字列は配列・オブジェクトにもどす */
function fromCell_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  if (typeof v === 'string') {
    var c = v.charAt(0);
    if (c === '{' || c === '[') {
      try { return JSON.parse(v); } catch (err) { /* ふつうの文字列 */ }
    }
  }
  return v;
}

/* ───────── 条件 ───────── */

function matcher_(filters, level, ctx) {
  var list = (filters || []).map(function (f) {
    if (!f || typeof f.col !== 'string' || !OPS_[f.op]) fail_('bad_request', '条件が正しくありません');
    return f;
  });
  return function (r) {
    if (level === 'owner' && String(r.obj.userId) !== String(ctx.user.id)) return false;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var v = f.col in r.obj ? r.obj[f.col] : null;
      if (!OPS_[f.op](v, f.val)) return false;
    }
    return true;
  };
}

var OPS_ = {
  eq: function (a, b) { return equal_(a, b); },
  neq: function (a, b) { return !equal_(a, b); },
  gt: function (a, b) { return a != null && b != null && compare_(a, b) > 0; },
  gte: function (a, b) { return a != null && b != null && compare_(a, b) >= 0; },
  lt: function (a, b) { return a != null && b != null && compare_(a, b) < 0; },
  lte: function (a, b) { return a != null && b != null && compare_(a, b) <= 0; },
  like: function (a, b) { return a != null && likeRegex_(b, '').test(String(a)); },
  ilike: function (a, b) { return a != null && likeRegex_(b, 'i').test(String(a)); },
  'in': function (a, b) { return Array.isArray(b) && b.some(function (x) { return equal_(a, x); }); },
  is: function (a, b) { return b === null ? a === null : a === b; },
  contains: function (a, b) {
    if (Array.isArray(a)) return a.some(function (x) { return equal_(x, b); });
    return typeof a === 'string' && a.indexOf(String(b)) >= 0;
  }
};

function equal_(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/** 並べかえ用。null は最後、数どうしは数として、ほかは文字として比べる */
function compare_(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  var na = Number(a), nb = Number(b);
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && !isNaN(na) && !isNaN(nb) && a !== '' && b !== '') return na - nb;
  var sa = typeof a === 'object' ? JSON.stringify(a) : String(a);
  var sb = typeof b === 'object' ? JSON.stringify(b) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** SQL の LIKE（% は何文字でも、_ は 1 文字） */
function likeRegex_(pattern, flags) {
  var src = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]');
  return new RegExp('^' + src + '$', flags);
}

/* ───────── 小物 ───────── */

function rowsOf_(rows) {
  var list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) fail_('bad_request', '行がありません');
  if (list.length > MAX_ROWS_PER_WRITE) fail_('bad_request', '一度に書けるのは ' + MAX_ROWS_PER_WRITE + ' 行までです');
  list.forEach(function (r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail_('bad_request', '行はオブジェクトにしてください');
  });
  return list;
}

function copy_(o) {
  var out = {};
  Object.keys(o).forEach(function (k) { out[k] = o[k]; });
  return out;
}

/** 書き込みは 1 つずつ順番に（同時に来ても行が重ならないように） */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    fail_('busy', 'いま混み合っています。少し待ってやり直してください');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function fail_(code, message) {
  var err = new Error(message);
  err.apiCode = code;
  throw err;
}

function respond_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
