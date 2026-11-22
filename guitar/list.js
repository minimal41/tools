/*
 * ギター譜：曲の一覧
 *
 * 保存されている曲を並べる。曲を押すと、その曲のページ（edit.html?id=曲のID）を開く。
 * 新しい曲・複製・削除もここで行う。
 */
import * as account from '../shared/account.js';
import { chordName } from './chords.js';
import { esc, uid, newSong, listSongs, putSong, removeSong, describeWhere } from './songs.js';

const $ = (id) => document.getElementById(id);
const SORT_KEY = 'tools.guitarTabs.listSort';

const state = { mode: null, songs: [], ready: false };

function setStatus(s, text) { $('status').dataset.s = s; $('status-text').textContent = text; }

try { $('sort').value = localStorage.getItem(SORT_KEY) || 'updated'; } catch { /* 無視 */ }

async function load(user) {
  state.ready = false;
  state.mode = user ? 'account' : 'local';
  describeWhere($('where'), state.mode, '../index.html');
  setStatus('idle', '読み込み中…');
  try {
    state.songs = await listSongs(state.mode);
  } catch (e) {
    setStatus('error', '読み込めませんでした');
    showEmpty('曲を読み込めませんでした', esc(e.message || 'ページを開き直してください。'), false);
    return;
  }
  state.ready = true;
  setStatus('saved', `${state.songs.length}曲`);
  render();
}

/* ---------- 表示 ---------- */

const dateFmt = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 1つ目のパートのコード進行（最初の8つ） */
function chordPreview(sg) {
  const b = sg.body;
  const out = [];
  for (const meas of b.parts[0].measures) {
    for (const k of Object.keys(meas.c).map(Number).sort((x, y) => x - y)) {
      const c = meas.c[k];
      const name = chordName(c.r, c.q, c.b, b.nameMode === 'sound' ? b.parts[0].capo : 0);
      if (out[out.length - 1] !== name) out.push(name);
      if (out.length >= 9) return out.slice(0, 8).join('  ') + '  …';
    }
  }
  return out.join('  ');
}

function sorted() {
  const q = $('search').value.trim().toLowerCase();
  const list = state.songs.filter((s) => !q || s.title.toLowerCase().includes(q));
  const by = $('sort').value;
  if (by === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  else if (by === 'created') list.sort((a, b) => a.createdAt - b.createdAt);
  else list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

function render() {
  if (!state.ready) return;
  const list = sorted();
  $('list').innerHTML = list.map((sg) => {
    const b = sg.body;
    const p0 = b.parts[0];
    const measures = Math.max(...b.parts.map((p) => p.measures.length));
    const chords = chordPreview(sg);
    const capos = [...new Set(b.parts.map((p) => p.capo))];
    const capoTxt = capos.length > 1 ? 'カポ パートごと' : p0.capo ? `<b>Capo ${p0.capo}</b>` : 'カポなし';
    return `<li class="card">
      <a class="open" href="edit.html?id=${encodeURIComponent(sg.id)}">
        <span class="t">${esc(sg.title || '無題')}</span>
        <span class="meta"><span>${capoTxt}</span><span>${esc(b.meter)}</span><span>♩=${b.tempo}</span><span>${measures}小節</span>${b.parts.length > 1 ? `<span>${b.parts.length}パート</span>` : ''}</span>
        <span class="chords${chords ? '' : ' none'}">${chords ? esc(chords) : 'コードはまだありません'}</span>
      </a>
      <div class="foot">
        <span class="when">更新 ${dateFmt.format(new Date(sg.updatedAt))}</span>
        <span class="acts">
          <button type="button" class="btn small" data-copy="${esc(sg.id)}">複製</button>
          <button type="button" class="btn small danger" data-del="${esc(sg.id)}">削除</button>
        </span>
      </div>
    </li>`;
  }).join('');
  if (!state.songs.length) {
    showEmpty('まだ曲がありません', '「＋ 新しい曲」から作ると、ここに並びます。', true);
  } else if (!list.length) {
    showEmpty('見つかりませんでした', `「${esc($('search').value)}」を含む曲名はありません。`, false);
  } else {
    $('empty').hidden = true;
  }
}

function showEmpty(title, text, withButton) {
  const el = $('empty');
  el.hidden = false;
  el.innerHTML = `<strong>${title}</strong>${text}${withButton ? '<br><button type="button" class="btn primary" data-act="new">＋ 新しい曲を作る</button>' : ''}`;
}

/* ---------- 操作 ---------- */

function openNewDialog() {
  if (!state.ready) return;
  const f = $('new-form');
  f.title.value = '新しい曲'; f.capo.value = '0'; f.meter.value = '4/4'; f.tempo.value = '90';
  $('new-dialog').showModal();
  f.title.select();
}

async function createAndOpen(opts) {
  const sg = newSong(opts);
  setStatus('idle', '作っています…');
  try {
    await putSong(state.mode, sg);
  } catch (e) {
    setStatus('error', '作れませんでした');
    alert('曲を作れませんでした。' + (e.message || ''));
    return;
  }
  location.href = `edit.html?id=${encodeURIComponent(sg.id)}`;
}

async function duplicate(id) {
  const src = state.songs.find((s) => s.id === id);
  if (!src) return;
  const now = Date.now();
  const copy = { ...structuredClone(src), id: uid(), title: `${src.title}のコピー`, createdAt: now, updatedAt: now };
  try {
    await putSong(state.mode, copy);
  } catch (e) {
    alert('複製できませんでした。' + (e.message || ''));
    return;
  }
  state.songs.push(copy);
  setStatus('saved', `${state.songs.length}曲`);
  render();
}

async function remove(id) {
  const sg = state.songs.find((s) => s.id === id);
  if (!sg) return;
  if (!confirm(`「${sg.title}」を削除します。元に戻せません。よろしいですか？`)) return;
  try {
    await removeSong(state.mode, id);
  } catch (e) {
    alert('削除できませんでした。' + (e.message || ''));
    return;
  }
  state.songs = state.songs.filter((s) => s.id !== id);
  setStatus('saved', `${state.songs.length}曲`);
  render();
}

$('new-capo').innerHTML = Array.from({ length: 13 }, (_, i) => `<option value="${i}">${i === 0 ? 'なし' : i}</option>`).join('');
$('new-song').addEventListener('click', openNewDialog);
$('new-dialog').addEventListener('close', () => {
  if ($('new-dialog').returnValue !== 'ok') return;
  const f = $('new-form');
  createAndOpen({ title: f.title.value, capo: f.capo.value, meter: f.meter.value, tempo: f.tempo.value });
});
$('search').addEventListener('input', render);
$('sort').addEventListener('change', () => {
  try { localStorage.setItem(SORT_KEY, $('sort').value); } catch { /* 無視 */ }
  render();
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-copy], [data-del], [data-act="new"]');
  if (!t) return;
  if (t.dataset.copy) duplicate(t.dataset.copy);
  else if (t.dataset.del) remove(t.dataset.del);
  else openNewDialog();
});

// ほかのタブ（曲のページ）で保存されたら一覧を新しくする（ブラウザ保存のとき）
window.addEventListener('storage', (e) => {
  if (state.mode === 'local' && e.key === 'tools.guitarTabs') load(null);
});
// 曲のページから「戻る」で来たときも新しくする
window.addEventListener('pageshow', (e) => { if (e.persisted && state.mode) load(account.getUser()); });

account.onUserChanged((user) => {
  if (state.mode === (user ? 'account' : 'local') && state.ready) return;
  load(user);
});
