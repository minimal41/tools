/*
 * ギター譜の曲データと保存（曲の一覧ページと、曲ごとの編集ページで共通）
 *
 * 保存先：ログイン中 … アカウント（Firestore の users/{uid}/guitarTabs/{id}。中身は data に JSON 文字列）
 *         未ログイン … このブラウザ（localStorage の tools.guitarTabs。曲の配列）
 *
 * 曲：{ id, title, position, createdAt, updatedAt, body }
 * body：{ meter, tempo, nameMode, parts: [ { name, capo, measures } ] }
 */
import * as account from '../shared/account.js';

export const LOCAL_KEY = 'tools.guitarTabs';
export const METER_IDS = ['4/4', '3/4', '2/4', '6/8'];

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 曲データ ---------- */

export function emptyMeasure() { return { n: {}, st: {}, c: {}, sc: {}, t: {}, sl: {}, tr: {} }; }

export function newPart(name, capo = 0, count = 4) {
  return { name, capo: Number(capo) || 0, measures: Array.from({ length: count }, emptyMeasure) };
}

export function clampTempo(v) {
  v = Math.round(Number(v));
  return Number.isFinite(v) ? Math.min(300, Math.max(30, v)) : 90;
}

export function newBody(opts = {}) {
  return {
    meter: METER_IDS.includes(opts.meter) ? opts.meter : '4/4',
    tempo: clampTempo(opts.tempo ?? 90), nameMode: 'shape',
    parts: [newPart('パート1', opts.capo)],
  };
}

/** 保存されていた中身を、今の形にそろえる（古い形の曲も読めるように） */
export function normalizeBody(b) {
  const out = newBody(b || {});
  out.nameMode = b?.nameMode === 'sound' ? 'sound' : 'shape';
  const fixMeasures = (ms) => (Array.isArray(ms) && ms.length
    ? ms.map((m) => ({ n: m?.n || {}, st: m?.st || {}, c: m?.c || {}, sc: m?.sc || {}, t: m?.t || {}, sl: m?.sl || {}, tr: m?.tr || {} }))
    : Array.from({ length: 4 }, emptyMeasure));
  if (Array.isArray(b?.parts) && b.parts.length) {
    out.parts = b.parts.map((pp, i) => ({ name: pp?.name || `パート${i + 1}`, capo: Number(pp?.capo) || 0, measures: fixMeasures(pp?.measures) }));
  } else {
    // パートが無かったころの曲は、1つ目のパートにする
    out.parts = [{ name: 'パート1', capo: Number(b?.capo) || 0, measures: fixMeasures(b?.measures) }];
  }
  return out;
}

export function newSong(opts = {}) {
  const now = Date.now();
  return { id: uid(), title: opts.title?.trim() || '新しい曲', position: 0, createdAt: now, updatedAt: now, body: newBody(opts) };
}

/* ---------- 保存先 ---------- */

function readLocal() {
  try {
    const rows = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
function writeLocalRows(rows) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
}

function fromRow(r) {
  let b = r.body;
  if (b == null && typeof r.data === 'string') {
    try { b = JSON.parse(r.data); } catch { b = null; }
  }
  return {
    id: r.id, title: r.title || '無題', position: typeof r.position === 'number' ? r.position : 0,
    createdAt: r.createdAt || Date.now(), updatedAt: r.updatedAt || r.createdAt || Date.now(), body: normalizeBody(b),
  };
}

/** mode: 'account' | 'local' */
export async function listSongs(mode) {
  const rows = mode === 'account' ? await account.guitarTabs.list() : readLocal();
  return rows.filter((r) => r && r.id).map(fromRow);
}

export async function getSong(mode, id) {
  if (mode === 'account') {
    const r = await account.guitarTabs.get(id);
    return r ? fromRow(r) : null;
  }
  const r = readLocal().find((x) => x.id === id);
  return r ? fromRow(r) : null;
}

/** 1曲だけ保存する（ブラウザ保存でも、ほかの曲は読み直してから書くので、別のタブの変更を消さない） */
export async function putSong(mode, song) {
  const { id, title, position, createdAt, updatedAt, body } = song;
  if (mode === 'account') {
    await account.guitarTabs.put({ id, title, position, createdAt, updatedAt, data: JSON.stringify(body) });
    return;
  }
  const rows = readLocal();
  const row = { id, title, position, createdAt, updatedAt, body };
  const i = rows.findIndex((x) => x.id === id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  writeLocalRows(rows);
}

export async function removeSong(mode, id) {
  if (mode === 'account') { await account.guitarTabs.remove(id); return; }
  writeLocalRows(readLocal().filter((x) => x.id !== id));
}

/** 「ログインしていないのでこのブラウザに保存」などの案内 */
export function describeWhere(el, mode, homePath) {
  el.hidden = false;
  el.textContent = '';
  if (mode === 'account') {
    el.textContent = '曲はアカウントに保存され、どの端末からでも開けます。';
  } else if (account.isConfigured) {
    el.append('ログインしていないので、曲はこのブラウザだけに保存されます。');
    const a = document.createElement('a');
    a.href = account.loginUrl(homePath, 'login');
    a.textContent = 'ログインするとアカウントに保存できます';
    el.append(' ', a);
  } else {
    el.textContent = '曲はこのブラウザに保存されます。';
  }
}
