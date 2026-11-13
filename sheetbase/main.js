/* Sheetbase の説明ページ：コードのコピーと「ためす」 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var sb = null;
  var SAVED_URL = 'sheetbase:playground:url';

  function say(el, text, kind) {
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function busy(button, on) { button.disabled = on; }

  /* ── Code.gs をコピー ── */
  $('copyCode').addEventListener('click', function () {
    var status = $('copyStatus');
    fetch('Code.gs').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      return navigator.clipboard.writeText(text);
    }).then(function () {
      say(status, 'コピーしました', 'ok');
    }).catch(function () {
      say(status, 'コピーできませんでした。「ダウンロード」を使ってください', 'err');
    });
  });

  /* ── つなぐ ── */
  try { $('url').value = localStorage.getItem(SAVED_URL) || ''; } catch (err) { /* 保存なしで続ける */ }

  $('connect').addEventListener('click', function () {
    var url = $('url').value.trim();
    var status = $('connStatus');
    if (!url) { say(status, 'URL を入れてください', 'err'); return; }
    var client = Sheetbase.createClient(url, { apiKey: $('key').value.trim() || undefined });
    busy($('connect'), true);
    say(status, 'つないでいます…');
    client.ping().then(function (res) {
      busy($('connect'), false);
      if (res.error) {
        say(status, 'つながりません：' + res.error.message, 'err');
        return;
      }
      sb = client;
      try { localStorage.setItem(SAVED_URL, url); } catch (err) { /* 保存なしで続ける */ }
      say(status, 'つながりました', 'ok');
      $('console').hidden = false;
      sb.auth.onAuthStateChange(showUser);
      showUser();
      load();
    });
  });

  /* ── ログイン ── */
  function showUser() {
    var user = sb.auth.getUser();
    $('signedIn').hidden = !user;
    $('authForm').hidden = !!user;
    $('who').textContent = user ? user.email + ' でログイン中' : '';
  }

  $('authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var action = (e.submitter && e.submitter.value) || 'signIn';
    var status = $('authStatus');
    say(status, '送っています…');
    sb.auth[action]({ email: $('email').value, password: $('password').value }).then(function (res) {
      if (res.error) { say(status, res.error.message, 'err'); return; }
      say(status, '');
      $('password').value = '';
      load();
    });
  });

  $('signOut').addEventListener('click', function () {
    sb.auth.signOut().then(load);
  });

  /* ── テーブル ── */
  function load() {
    var status = $('dbStatus');
    var table = $('table').value.trim();
    if (!table) { say(status, 'テーブル名を入れてください', 'err'); return; }
    say(status, '読みこんでいます…');
    return sb.from(table).select().order('createdAt', { ascending: false }).limit(50).then(function (res) {
      if (res.error) {
        say(status, res.error.message, 'err');
        $('tableWrap').hidden = true;
        return;
      }
      say(status, res.count + ' 行' + (res.count > res.data.length ? '（新しい ' + res.data.length + ' 行を表示）' : ''), 'ok');
      render(res.data);
    });
  }

  function show(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  function render(rows) {
    var el = $('rows');
    el.textContent = '';
    $('tableWrap').hidden = false;

    if (!rows.length) {
      var cell = el.insertRow().insertCell();
      cell.className = 'empty';
      cell.textContent = 'まだ行がありません';
      return;
    }

    var cols = [];
    rows.forEach(function (r) {
      Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); });
    });

    var head = el.createTHead().insertRow();
    cols.concat('').forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c;
      head.appendChild(th);
    });

    var body = el.createTBody();
    rows.forEach(function (r) {
      var tr = body.insertRow();
      cols.forEach(function (c) {
        var td = tr.insertCell();
        td.textContent = show(r[c]);
        td.title = td.textContent;
      });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '消す';
      del.setAttribute('aria-label', show(r.id) + ' を消す');
      del.addEventListener('click', function () { remove(r.id); });
      tr.insertCell().appendChild(del);
    });
  }

  function remove(id) {
    var status = $('dbStatus');
    if (id === null || id === undefined) { say(status, 'id の無い行はここからは消せません', 'err'); return; }
    say(status, '消しています…');
    sb.from($('table').value.trim()).delete().eq('id', id).then(function (res) {
      if (res.error) { say(status, res.error.message, 'err'); return; }
      if (!res.data.length) { say(status, '消せる行がありませんでした（自分の行ではないかもしれません）', 'err'); return; }
      load();
    });
  }

  $('insert').addEventListener('click', function () {
    var status = $('dbStatus');
    var rows;
    try {
      rows = JSON.parse($('json').value);
    } catch (err) {
      say(status, 'JSON が正しくありません', 'err');
      return;
    }
    busy($('insert'), true);
    say(status, '足しています…');
    sb.from($('table').value.trim()).insert(rows).then(function (res) {
      busy($('insert'), false);
      if (res.error) { say(status, res.error.message, 'err'); return; }
      load();
    });
  });

  $('reload').addEventListener('click', load);
})();
