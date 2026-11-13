/**
 * Sheetbase クライアント — Code.gs（Google Apps Script）と話すための小さな SDK
 *
 *   const sb = Sheetbase.createClient('https://script.google.com/macros/s/XXXX/exec');
 *   const { data, error } = await sb.from('todos').select().eq('done', false).order('createdAt');
 *
 * ブラウザでは <script src="sheetbase.js"> で window.Sheetbase、Node では require('./sheetbase.js')。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sheetbase = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var memoryStore = {};

  function defaultStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.getItem('sheetbase:test');
        return localStorage;
      }
    } catch (err) { /* 使えないときはメモリに置く */ }
    return {
      getItem: function (k) { return k in memoryStore ? memoryStore[k] : null; },
      setItem: function (k, v) { memoryStore[k] = String(v); },
      removeItem: function (k) { delete memoryStore[k]; }
    };
  }

  /**
   * @param {string} url  ウェブアプリの URL（…/exec）
   * @param {object} [options]
   *   apiKey   … API_KEY または ADMIN_KEY（設定したときだけ）
   *   storage  … ログイン情報の置き場所（既定は localStorage）
   *   fetch    … fetch の差しかえ
   */
  function createClient(url, options) {
    if (!url) throw new Error('Sheetbase: URL がありません');
    options = options || {};
    var storage = options.storage || defaultStorage();
    var storageKey = 'sheetbase:session:' + url;
    var doFetch = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
    if (!doFetch) throw new Error('Sheetbase: fetch が使えません');

    var session = null;
    try { session = JSON.parse(storage.getItem(storageKey) || 'null'); } catch (err) { session = null; }
    if (session && session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) session = null;

    var listeners = [];

    function setSession(next, event) {
      session = next;
      try {
        if (next) storage.setItem(storageKey, JSON.stringify(next));
        else storage.removeItem(storageKey);
      } catch (err) { /* 保存できなくても続ける */ }
      listeners.slice().forEach(function (fn) {
        try { fn(event, next); } catch (err) { /* 聞き手のエラーは無視 */ }
      });
    }

    /** サーバーを呼ぶ。かならず { data, error, count } を返し、例外は投げない */
    function call(body) {
      var req = {};
      Object.keys(body).forEach(function (k) { if (body[k] !== undefined) req[k] = body[k]; });
      if (options.apiKey) req.key = options.apiKey;
      if (session && session.token && body.action !== 'signIn' && body.action !== 'signUp') req.token = session.token;
      // Content-Type を text/plain にすると、ブラウザが事前確認（preflight）を送らないので Apps Script でも通る
      return doFetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(req)
      }).then(function (res) {
        return res.text();
      }).then(function (text) {
        var json;
        try {
          json = JSON.parse(text);
        } catch (err) {
          return fail('bad_response', 'サーバーの返事を読めませんでした。URL とデプロイの設定（アクセス：全員）を確かめてください');
        }
        if (json.error && json.error.code === 'invalid_token' && session) setSession(null, 'SIGNED_OUT');
        return { data: json.data === undefined ? null : json.data, error: json.error || null, count: json.count == null ? null : json.count };
      }).catch(function (err) {
        return fail('network', String((err && err.message) || err));
      });
    }

    function fail(code, message) {
      return { data: null, error: { code: code, message: message }, count: null };
    }

    /* ───── クエリ ───── */

    function Query(table) {
      this._table = table;
      this._action = 'select';
      this._filters = [];
      this._order = [];
      this._single = null;
    }

    var proto = Query.prototype;

    /** 読む。columns は 'id,title' または ['id','title']。省くと全部の列 */
    proto.select = function (columns) {
      var cols = typeof columns === 'string' ? columns.split(',') : columns;
      if (cols) {
        cols = cols.map(function (c) { return String(c).trim(); }).filter(function (c) { return c && c !== '*'; });
        if (cols.length) this._columns = cols;
      }
      return this;
    };
    /** 足す。1 行でも配列でも */
    proto.insert = function (rows) { this._action = 'insert'; this._rows = rows; return this; };
    /** 書きかえる。eq などの条件が必要 */
    proto.update = function (values) { this._action = 'update'; this._values = values; return this; };
    /** あれば書きかえ、なければ足す。{ onConflict: '列名' }（既定は id） */
    proto.upsert = function (rows, opts) {
      this._action = 'upsert'; this._rows = rows; this._onConflict = opts && opts.onConflict; return this;
    };
    /** 消す。eq などの条件が必要 */
    proto.delete = function () { this._action = 'delete'; return this; };

    ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is', 'contains'].forEach(function (op) {
      proto[op] = function (col, val) { this._filters.push({ col: col, op: op, val: val }); return this; };
    });
    /** { 列: 値 } をまとめて eq にする */
    proto.match = function (obj) {
      var self = this;
      Object.keys(obj).forEach(function (k) { self.eq(k, obj[k]); });
      return this;
    };

    proto.order = function (col, opts) {
      this._order.push({ col: col, asc: !(opts && opts.ascending === false) });
      return this;
    };
    proto.limit = function (n) { this._limit = n; return this; };
    proto.range = function (from, to) { this._offset = from; this._limit = to - from + 1; return this; };
    /** 1 行だけを data に入れる。0 行・2 行以上はエラー */
    proto.single = function () { this._single = 'one'; return this; };
    /** 1 行か null を data に入れる */
    proto.maybeSingle = function () { this._single = 'maybe'; return this; };

    proto._body = function () {
      var b = { action: this._action, table: this._table };
      if (this._action === 'select') {
        b.columns = this._columns;
        b.order = this._order.length ? this._order : undefined;
        b.limit = this._limit;
        b.offset = this._offset;
      }
      if (this._action === 'insert' || this._action === 'upsert') b.rows = this._rows;
      if (this._action === 'upsert') b.onConflict = this._onConflict;
      if (this._action === 'update') b.values = this._values;
      if (this._action !== 'insert' && this._action !== 'upsert' && this._filters.length) b.filters = this._filters;
      return b;
    };

    proto._run = function () {
      var single = this._single;
      return call(this._body()).then(function (res) {
        if (res.error || !single) return res;
        var rows = res.data || [];
        if (rows.length === 1) return { data: rows[0], error: null, count: res.count };
        if (rows.length === 0 && single === 'maybe') return { data: null, error: null, count: res.count };
        return fail('not_single', rows.length ? '2 行以上見つかりました' : '行が見つかりませんでした');
      });
    };

    // await できるようにする
    proto.then = function (onOk, onErr) { return this._run().then(onOk, onErr); };
    proto.catch = function (onErr) { return this._run().catch(onErr); };

    /**
     * 一定時間ごとに読み直し、中身が変わったら callback({ data, error, count }) を呼ぶ。
     * 戻り値の関数を呼ぶと止まる。（スプレッドシートは変更を知らせてくれないので、見に行く方式）
     */
    proto.subscribe = function (callback, opts) {
      var self = this;
      var interval = Math.max(2000, (opts && opts.interval) || 5000);
      var last;
      var stopped = false;
      var timer = null;
      function tick() {
        self._run().then(function (res) {
          if (stopped) return;
          var snap = JSON.stringify(res.error ? res.error : res.data);
          if (snap !== last) { last = snap; callback(res); }
          timer = setTimeout(tick, interval);
        });
      }
      tick();
      return function unsubscribe() { stopped = true; if (timer) clearTimeout(timer); };
    };

    /* ───── 認証 ───── */

    function startSession(res) {
      if (res.error) return { data: { user: null, session: null }, error: res.error };
      setSession(res.data, 'SIGNED_IN');
      return { data: { user: res.data.user, session: res.data }, error: null };
    }

    var auth = {
      signUp: function (cred) {
        return call({ action: 'signUp', email: cred.email, password: cred.password }).then(startSession);
      },
      signIn: function (cred) {
        return call({ action: 'signIn', email: cred.email, password: cred.password }).then(startSession);
      },
      signOut: function () {
        setSession(null, 'SIGNED_OUT');
        return Promise.resolve({ error: null });
      },
      /** いまログインしている人（通信しない）。いなければ null */
      getUser: function () { return session ? session.user : null; },
      getSession: function () { return session; },
      /** ログイン・ログアウトのたびに callback(event, session)。戻り値の関数で解除 */
      onAuthStateChange: function (callback) {
        listeners.push(callback);
        return function () {
          var i = listeners.indexOf(callback);
          if (i >= 0) listeners.splice(i, 1);
        };
      }
    };

    return {
      from: function (table) { return new Query(table); },
      auth: auth,
      /** つながるか確かめる */
      ping: function () { return call({ action: 'ping' }); },
      /** テーブルの一覧（管理キーが必要） */
      tables: function () { return call({ action: 'tables' }); }
    };
  }

  return { createClient: createClient };
});
