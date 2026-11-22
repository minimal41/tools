/*
 * チェックリスト
 *
 * ログイン中   … アカウント（Firestore の users/{uid}/checklists）に保存。どの端末からでも開ける。
 * 未ログイン   … このブラウザ（localStorage）に保存。
 */
import * as account from '../shared/account.js';

const LOCAL_KEY = 'tools.checklists';
const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const state = { lists: {}, order: [], currentId: null, confirmDelete: false, ready: false, mode: null };

function setStatus(s, text) { $('status').dataset.s = s; $('status-text').textContent = text; }

/* ---------- 保存先 ---------- */

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
}
function writeLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state.order.map((id) => ({ id, ...state.lists[id] }))));
    return true;
  } catch { return false; }
}

async function load(user) {
  state.ready = false;
  state.mode = user ? 'account' : 'local';
  let lists = [];
  if (user) {
    setStatus('idle', '読み込み中…');
    try { lists = await account.checklists.list(); }
    catch (e) {
      setStatus('error', '読み込めませんでした');
      emptyMain('リストを読み込めませんでした', e.message || 'ページを開き直してください。');
      return;
    }
  } else {
    lists = readLocal();
  }
  // position（並び替えた順）を優先し、無いものは作った順
  const pos = (l) => (typeof l.position === 'number' ? l.position : Infinity);
  lists.sort((a, b) => pos(a) - pos(b) || (a.createdAt || 0) - (b.createdAt || 0));
  state.lists = {}; state.order = [];
  for (const { id, ...l } of lists) { state.lists[id] = l; state.order.push(id); }
  state.currentId = state.order[0] || null;
  state.ready = true;
  showWhere();
  setStatus('saved', user ? 'アカウントに保存済み' : 'このブラウザに保存済み');
  render();
}

function showWhere() {
  const p = $('where');
  p.hidden = false;
  p.textContent = '';
  if (state.mode === 'account') {
    p.textContent = 'リストはアカウントに保存され、どの端末からでも開けます。';
  } else if (account.isConfigured) {
    p.append('ログインしていないので、リストはこのブラウザだけに保存されます。');
    const a = document.createElement('a');
    a.href = account.loginUrl('../index.html', 'login');
    a.textContent = 'ログインするとアカウントに保存できます';
    p.append(' ', a);
  } else {
    p.textContent = 'リストはこのブラウザに保存されます。';
  }
}

/* ---------- 保存（リストごとに少し待ってまとめて書き込む） ---------- */

const timers = {};
const pending = new Set();
const inflight = {};

function scheduleSave(id) {
  if (state.mode === 'local') {
    const ok = writeLocal();
    setStatus(ok ? 'saved' : 'error', ok ? 'このブラウザに保存済み' : 'このブラウザに保存できませんでした');
    return;
  }
  pending.add(id);
  setStatus('saving', '保存中…');
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => flush(id), 500);
}

async function flush(id) {
  if (inflight[id]) { timers[id] = setTimeout(() => flush(id), 200); return; }
  inflight[id] = true;
  pending.delete(id);
  const list = state.lists[id];
  try {
    if (list) await account.checklists.put({ id, ...structuredClone(list) });
    else await account.checklists.remove(id);
    if (!pending.size) setStatus('saved', 'アカウントに保存済み');
  } catch (e) {
    pending.add(id);
    setStatus('error', '保存できませんでした。もう一度操作してください');
  } finally { inflight[id] = false; }
}

window.addEventListener('beforeunload', (e) => {
  if (pending.size) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- 操作 ---------- */

function createList() {
  if (!state.ready) return;
  const id = uid();
  state.lists[id] = { title: '新しいリスト', items: [], position: state.order.length, createdAt: Date.now(), updatedAt: Date.now() };
  state.order.push(id);
  state.currentId = id; state.confirmDelete = false;
  scheduleSave(id); render();
  const t = $('title-input'); if (t) { t.focus(); t.select(); }
}
function touch(id) { state.lists[id].updatedAt = Date.now(); scheduleSave(id); }

function moveInArray(arr, from, to) {
  const [x] = arr.splice(from, 1);
  arr.splice(to, 0, x);
}

/** リストの順番を変えて、順番が変わったリストだけ保存する */
function moveList(from, to) {
  if (from === to) return;
  moveInArray(state.order, from, to);
  state.order.forEach((id, i) => {
    if (state.lists[id].position !== i) { state.lists[id].position = i; scheduleSave(id); }
  });
  render();
}

function moveItem(listId, from, to) {
  if (from === to) return;
  moveInArray(state.lists[listId].items, from, to);
  touch(listId);
  render();
}

/* ---------- 並び替え（つまみをドラッグ、またはつまみにフォーカスして ↑↓） ---------- */

/**
 * row: 動かす行。handle: そのつまみ。getRows: 並んでいる行をいまの順で返す。index: 元の番号。
 * onMove(from, to) で状態を更新して描画し直す。
 */
function sortable(row, handle, getRows, index, onMove) {
  handle.addEventListener('keydown', (e) => {
    const n = getRows().length;
    let to = null;
    if (e.key === 'ArrowUp' && index > 0) to = index - 1;
    if (e.key === 'ArrowDown' && index < n - 1) to = index + 1;
    if (to === null) return;
    e.preventDefault();
    const focusKey = handle.dataset.key;
    onMove(index, to);
    const again = document.querySelector(`.handle[data-key="${focusKey}"]`);
    if (again) again.focus();
  });

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 行を DOM 上で動かすとつまみのポインタキャプチャが外れるので、ページ全体で受け取る
    const pid = e.pointerId;
    const parent = row.parentElement;
    row.classList.add('dragging');
    document.body.classList.add('sorting');
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      ev.preventDefault();
      // ポインタの高さに応じて、行を DOM 上で入れ替えて見せる
      for (const other of getRows()) {
        if (other === row) continue;
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const before = row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING;
        if (before && ev.clientY < mid) { parent.insertBefore(row, other); break; }
        if (!before && ev.clientY > mid) { parent.insertBefore(row, other.nextSibling); }
      }
    };
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      row.classList.remove('dragging');
      document.body.classList.remove('sorting');
      const to = getRows().indexOf(row);
      if (to !== index) onMove(index, to); else render();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}

function makeHandle(key, label) {
  const h = document.createElement('button');
  h.type = 'button'; h.className = 'handle'; h.textContent = '⋮⋮';
  h.dataset.key = key;
  h.setAttribute('aria-label', `${label}を並び替え（↑↓キーで移動）`);
  h.title = 'ドラッグで並び替え';
  return h;
}

/* ---------- 描画 ---------- */

function button(cls, text, onClick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = onClick;
  return b;
}

function renderNav() {
  const nav = $('list-nav'); nav.textContent = '';
  const getRows = () => [...nav.querySelectorAll('.nav-row')];
  state.order.forEach((id, index) => {
    const l = state.lists[id]; if (!l) return;
    const row = document.createElement('div'); row.className = 'nav-row';
    const handle = makeHandle('list-' + id, `「${l.title || '無題のリスト'}」`);
    sortable(row, handle, getRows, index, moveList);
    const b = button('list-btn', '', () => { state.currentId = id; state.confirmDelete = false; render(); });
    b.setAttribute('aria-current', id === state.currentId ? 'true' : 'false');
    const name = document.createElement('span'); name.textContent = l.title || '無題のリスト';
    const c = document.createElement('span'); c.className = 'count';
    c.textContent = `${l.items.filter((i) => i.done).length}/${l.items.length}`;
    b.append(name, c);
    row.append(handle, b);
    nav.append(row);
  });
  $('new-list').hidden = !state.ready;
}

function emptyMain(title, body) {
  const m = $('main');
  m.innerHTML = '<div class="empty"><strong></strong><span></span></div>';
  m.querySelector('strong').textContent = title;
  m.querySelector('span').textContent = body;
}

function renderMain() {
  if (!state.ready) return;
  const m = $('main');
  const id = state.currentId, l = id && state.lists[id];
  if (!l) {
    emptyMain('まだリストがありません', '「＋ 新しいリスト」から最初のチェックリストを作りましょう。買い物、旅行の持ち物、今日のタスクなど何でもどうぞ。');
    const b = button('btn', '最初のリストを作る', createList);
    b.style.alignSelf = 'center';
    m.append(b);
    return;
  }
  const done = l.items.filter((i) => i.done).length, total = l.items.length;
  m.innerHTML = `
    <div class="title-row"><input class="title-input" id="title-input" aria-label="リスト名" maxlength="80"></div>
    <div class="progress"><div class="bar"><i></i></div><span id="pg"></span></div>
    <form class="add" id="add-form"><input id="new-item" placeholder="項目を追加（Enterで追加）" maxlength="300" autocomplete="off"><button class="btn" type="submit">追加</button></form>
    <ul class="items" id="items"></ul>
    <div class="foot" id="foot"></div>`;
  const ti = $('title-input'); ti.value = l.title;
  ti.oninput = () => { l.title = ti.value; touch(id); renderNav(); };
  m.querySelector('.bar i').style.width = total ? (done / total * 100) + '%' : '0%';
  $('pg').textContent = total ? `${done} / ${total} 完了` : '項目なし';
  $('add-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('new-item').value.trim(); if (!v) return;
    l.items.push({ id: uid(), text: v, done: false }); touch(id);
    render(); $('new-item').focus();
  };
  const ul = $('items');
  if (!total) {
    const li = document.createElement('li'); li.className = 'empty'; li.style.border = '0';
    li.textContent = '上の欄から項目を追加してください。'; ul.append(li);
  }
  const getItemRows = () => [...ul.querySelectorAll('li[data-item]')];
  l.items.forEach((it, index) => {
    const li = document.createElement('li'); if (it.done) li.className = 'done';
    li.dataset.item = it.id;
    const handle = makeHandle('item-' + it.id, `「${it.text}」`);
    sortable(li, handle, getItemRows, index, (from, to) => moveItem(id, from, to));
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = it.done; cb.id = 'cb-' + it.id;
    cb.onchange = () => { it.done = cb.checked; touch(id); render(); };
    const lab = document.createElement('label'); lab.className = 'text'; lab.htmlFor = cb.id; lab.textContent = it.text;
    const del = button('ghost danger del', '削除', () => { l.items = l.items.filter((x) => x !== it); touch(id); render(); });
    del.setAttribute('aria-label', `「${it.text}」を削除`);
    li.append(handle, cb, lab, del); ul.append(li);
  });
  const foot = $('foot');
  if (state.confirmDelete) {
    const box = document.createElement('div'); box.className = 'confirm';
    const msg = document.createElement('span'); msg.textContent = 'このリストを削除しますか？元に戻せません。';
    const yes = button('ghost danger', '削除する', () => {
      delete state.lists[id]; state.order = state.order.filter((x) => x !== id);
      state.currentId = state.order[0] || null; state.confirmDelete = false; scheduleSave(id); render();
    });
    yes.style.color = 'var(--danger)';
    const no = button('ghost', 'やめる', () => { state.confirmDelete = false; render(); });
    box.append(msg, yes, no); foot.append(box);
  } else {
    const clr = button('ghost', '完了した項目を消す', () => { l.items = l.items.filter((x) => !x.done); touch(id); render(); });
    const reset = button('ghost', 'チェックを全部外す', () => { l.items.forEach((x) => { x.done = false; }); touch(id); render(); });
    clr.disabled = reset.disabled = !done;
    const left = document.createElement('div'); left.append(clr, reset);
    foot.append(left, button('ghost danger', 'リストを削除', () => { state.confirmDelete = true; render(); }));
  }
}

function render() {
  const active = document.activeElement && document.activeElement.id;
  renderNav(); renderMain();
  if (active === 'title-input' && $('title-input')) $('title-input').focus();
}

$('new-list').onclick = createList;
$('new-list').hidden = true;

account.onUserChanged((user) => { load(user); });
