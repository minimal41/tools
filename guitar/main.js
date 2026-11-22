/*
 * ギター譜
 *
 * TAB を1音ずつ打つ「TAB を打つ」と、コード・押さえ方・リズムを選んで流し込む「コード＋リズム」の2つの入力。
 * 流し込んだところには、TAB の上にコードの押さえ方（ダイアグラム）を表示する。
 *
 * 保存：ログイン中 … アカウント（Firestore の users/{uid}/guitarTabs）
 *       未ログイン … このブラウザ（localStorage）
 *
 * 曲のデータ（body）
 *   { meter, tempo, nameMode, parts: [ { name, capo, measures } ] }（パートごとに小節とカポを持つ。拍子とテンポは共通）
 *   measures: [ { n: {step: [6弦…1弦]}, st: {step: 'D'|'U'}, c: {step: {r, q, b, f}} } ] }
 *   フレットは数字（カポからの数）か 'x'。弦の並びは 0 = 6弦 … 5 = 1弦。
 */
import * as account from '../shared/account.js';
import { QUALITIES, ROOTS, ROOT_LABELS, chordName, voicings, diagramInfo, midiOf } from './chords.js';
import { STROKES, ARPEGGIOS, resolveArp, strokeGlyph } from './patterns.js';
import * as audio from './audio.js';

const LOCAL_KEY = 'tools.guitarTabs';
const PREFS_KEY = 'tools.guitarTabs.prefs';
const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const METERS = {
  '4/4': { steps: 16, beat: 4, label: (s) => s / 4 + 1 },
  '3/4': { steps: 12, beat: 4, label: (s) => s / 4 + 1 },
  '2/4': { steps: 8, beat: 4, label: (s) => s / 4 + 1 },
  '6/8': { steps: 12, beat: 6, sub: 2, label: (s) => s / 2 + 1 },
};
const STRING_NAMES = ['6弦', '5弦', '4弦', '3弦', '2弦', '1弦'];

const state = {
  songs: {}, order: [], currentId: null, mode: null, ready: false,
  tool: 'tab',
  sel: { m: 0, s: 0, str: 5 },
  selChord: null, // { m, s }：クリックしたコード表示
  pick: { root: 0, q: '', bass: null, vi: 0, showAll: false },
  rhythm: { kind: 'stroke', stroke: 's-8beat', arp: 'a-basic', len: 'end' },
  custom: { stroke: [], arp: [] },
  advance: 2,
  part: 0, // いま開いているパートの番号
  playAll: true, // 再生で全パートを鳴らすか
  undo: [], redo: [],
};

loadPrefs();

/* ---------- 便利関数 ---------- */

const song = () => state.songs[state.currentId];
const body = () => song()?.body;
/** 曲データの中の、いま開いているパート */
const P = (b) => b.parts[Math.min(state.part, b.parts.length - 1)];
const pt = () => P(body());
const meter = () => METERS[body()?.meter] || METERS['4/4'];
const S = () => meter().steps;

function emptyMeasure() { return { n: {}, st: {}, c: {}, sc: {}, t: {} }; }
function newPart(name, capo = 0, count = 4) {
  return { name, capo: Number(capo) || 0, measures: Array.from({ length: count }, emptyMeasure) };
}
function newBody(opts = {}) {
  return {
    meter: METERS[opts.meter] ? opts.meter : '4/4',
    tempo: clampTempo(opts.tempo ?? 90), nameMode: 'shape',
    parts: [newPart('パート1', opts.capo)],
  };
}
function clampTempo(v) { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(300, Math.max(30, v)) : 90; }

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (p.rhythm) Object.assign(state.rhythm, p.rhythm);
    if (p.custom) Object.assign(state.custom, p.custom);
    if (p.advance != null) state.advance = p.advance;
    if (p.tool) state.tool = p.tool;
    if (p.playAll != null) state.playAll = !!p.playAll;
  } catch { /* 無視 */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ rhythm: state.rhythm, custom: state.custom, advance: state.advance, tool: state.tool, playAll: state.playAll }));
  } catch { /* 無視 */ }
}

function setStatus(s, text) { $('status').dataset.s = s; $('status-text').textContent = text; }

/* ---------- 保存 ---------- */

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
}
function writeLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state.order.map((id) => ({ id, ...state.songs[id] }))));
    return true;
  } catch { return false; }
}

function normalizeBody(b) {
  const out = newBody(b || {});
  out.nameMode = b?.nameMode === 'sound' ? 'sound' : 'shape';
  const fixMeasures = (ms) => (Array.isArray(ms) && ms.length
    ? ms.map((m) => ({ n: m?.n || {}, st: m?.st || {}, c: m?.c || {}, sc: m?.sc || {}, t: m?.t || {} }))
    : Array.from({ length: 4 }, emptyMeasure));
  if (Array.isArray(b?.parts) && b.parts.length) {
    out.parts = b.parts.map((pp, i) => ({ name: pp?.name || `パート${i + 1}`, capo: Number(pp?.capo) || 0, measures: fixMeasures(pp?.measures) }));
  } else {
    // パートが無かったころの曲は、1つ目のパートにする
    out.parts = [{ name: 'パート1', capo: Number(b?.capo) || 0, measures: fixMeasures(b?.measures) }];
  }
  return out;
}

async function load(user) {
  state.ready = false;
  state.mode = user ? 'account' : 'local';
  let rows = [];
  if (user) {
    setStatus('idle', '読み込み中…');
    try {
      rows = (await account.guitarTabs.list()).map((r) => {
        let b = null;
        try { b = JSON.parse(r.data || 'null'); } catch { /* 壊れていたら空にする */ }
        return { id: r.id, title: r.title, position: r.position, createdAt: r.createdAt, updatedAt: r.updatedAt, body: b };
      });
    } catch (e) {
      setStatus('error', '読み込めませんでした');
      $('score').innerHTML = `<div class="empty">曲を読み込めませんでした。${esc(e.message || 'ページを開き直してください。')}</div>`;
      return;
    }
  } else {
    rows = readLocal();
  }
  const pos = (r) => (typeof r.position === 'number' ? r.position : Infinity);
  rows.sort((a, b) => pos(a) - pos(b) || (a.createdAt || 0) - (b.createdAt || 0));
  state.songs = {}; state.order = [];
  for (const r of rows) {
    state.songs[r.id] = {
      title: r.title || '無題', position: r.position ?? state.order.length,
      createdAt: r.createdAt || Date.now(), updatedAt: r.updatedAt || Date.now(), body: normalizeBody(r.body),
    };
    state.order.push(r.id);
  }
  state.ready = true;
  if (!state.order.length) {
    createSong({ title: 'はじめての曲', capo: 0, meter: '4/4', tempo: 90 }, false);
  } else {
    openSong(state.order[0]);
  }
  showWhere();
  setStatus('saved', user ? 'アカウントに保存済み' : 'このブラウザに保存済み');
}

function showWhere() {
  const p = $('where');
  p.hidden = false;
  p.textContent = '';
  if (state.mode === 'account') {
    p.textContent = '曲はアカウントに保存され、どの端末からでも開けます。';
  } else if (account.isConfigured) {
    p.append('ログインしていないので、曲はこのブラウザだけに保存されます。');
    const a = document.createElement('a');
    a.href = account.loginUrl('../index.html', 'login');
    a.textContent = 'ログインするとアカウントに保存できます';
    p.append(' ', a);
  } else {
    p.textContent = '曲はこのブラウザに保存されます。';
  }
}

const timers = {};
const pending = new Set();
const inflight = {};

function scheduleSave(id = state.currentId) {
  if (!id) return;
  if (state.mode === 'local') {
    clearTimeout(timers.local);
    timers.local = setTimeout(() => {
      timers.local = null;
      const ok = writeLocal();
      setStatus(ok ? 'saved' : 'error', ok ? 'このブラウザに保存済み' : 'このブラウザに保存できませんでした（容量がいっぱいかもしれません）');
    }, 250);
    return;
  }
  pending.add(id);
  setStatus('saving', '保存中…');
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => flush(id), 700);
}

async function flush(id) {
  if (inflight[id]) { timers[id] = setTimeout(() => flush(id), 200); return; }
  inflight[id] = true;
  pending.delete(id);
  const sg = state.songs[id];
  try {
    if (sg) {
      await account.guitarTabs.put({
        id, title: sg.title, position: sg.position, createdAt: sg.createdAt, updatedAt: sg.updatedAt,
        data: JSON.stringify(sg.body),
      });
    } else {
      await account.guitarTabs.remove(id);
    }
    if (!pending.size) setStatus('saved', 'アカウントに保存済み');
  } catch (e) {
    pending.add(id);
    setStatus('error', '保存できませんでした。もう一度操作してください');
  } finally { inflight[id] = false; }
}

// ブラウザ保存は少し待ってまとめて書くので、ページを離れるときはすぐ書く
window.addEventListener('pagehide', () => {
  if (state.mode === 'local' && timers.local) { clearTimeout(timers.local); timers.local = null; writeLocal(); }
});
window.addEventListener('beforeunload', (e) => {
  if (pending.size) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- 曲の操作 ---------- */

function createSong(opts, focus = true) {
  const id = uid();
  state.songs[id] = { title: opts.title?.trim() || '新しい曲', position: state.order.length, createdAt: Date.now(), updatedAt: Date.now(), body: newBody(opts) };
  state.order.push(id);
  scheduleSave(id);
  openSong(id);
  if (focus) { $('title').focus(); $('title').select(); }
}

function openSong(id) {
  stop();
  state.currentId = id;
  state.part = 0;
  state.sel = { m: 0, s: 0, str: 5 };
  state.selChord = null;
  state.undo = []; state.redo = [];
  renderAll();
}

function deleteSong() {
  const sg = song();
  if (!sg) return;
  if (!confirm(`「${sg.title}」を削除します。元に戻せません。よろしいですか？`)) return;
  const id = state.currentId;
  delete state.songs[id];
  state.order = state.order.filter((x) => x !== id);
  scheduleSave(id);
  if (!state.order.length) createSong({ title: '新しい曲' }, false);
  else openSong(state.order[0]);
}

/** 曲の中身を変える。元に戻せるように前の状態を残す */
function edit(fn, { keepRedo = false } = {}) {
  const b = body();
  if (!b) return;
  state.undo.push(JSON.stringify(b));
  if (state.undo.length > 200) state.undo.shift();
  if (!keepRedo) state.redo = [];
  fn(b);
  touch();
}
function touch() {
  song().updatedAt = Date.now();
  scheduleSave();
  renderAll();
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(body()));
  song().body = JSON.parse(state.undo.pop());
  clampSel();
  touch();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(body()));
  song().body = JSON.parse(state.redo.pop());
  clampSel();
  touch();
}
function clampSel() {
  const b = body();
  state.part = Math.min(state.part, b.parts.length - 1);
  state.sel.m = Math.min(state.sel.m, P(b).measures.length - 1);
  state.sel.s = Math.min(state.sel.s, S() - 1);
  if (state.selChord && !P(b).measures[state.selChord.m]?.c[state.selChord.s]) state.selChord = null;
}

/* ---------- 位置 ---------- */

const gOf = (m, s) => m * S() + s;
function setSelG(g, str = state.sel.str) {
  const b = body();
  g = Math.max(0, g);
  const m = Math.floor(g / S());
  if (m >= P(b).measures.length) {
    // 最後の小節の先へ進んだら小節を足す
    while (P(b).measures.length <= m) P(b).measures.push(emptyMeasure());
    scheduleSave();
  }
  state.sel = { m, s: g % S(), str };
}

/** その位置で鳴っているコード（その位置かそれより前で最後に置いたコード） */
function chordAt(m, s) {
  const b = body();
  for (let mm = m; mm >= 0; mm--) {
    const c = P(b).measures[mm].c;
    const keys = Object.keys(c).map(Number).filter((k) => mm < m || k <= s).sort((a, b2) => b2 - a);
    if (keys.length) return { m: mm, s: keys[0], ...c[keys[0]] };
  }
  return null;
}

/* ---------- TAB の入力 ---------- */

function setFret(m, s, str, v) {
  edit((b) => {
    const meas = P(b).measures[m];
    const col = meas.n[s] ? meas.n[s].slice() : [null, null, null, null, null, null];
    col[str] = v;
    if (v == null || v === 'x') delete meas.t?.[`${s}_${str}`];
    if (col.every((x) => x == null)) { delete meas.n[s]; delete meas.st[s]; delete meas.sc?.[s]; } else meas.n[s] = col;
  });
}

/** スタッカート（その列の音を短く切る）を付けたり外したりする */
function toggleStaccato() {
  const { m, s } = state.sel;
  edit((b) => {
    const meas = P(b).measures[m];
    meas.sc ||= {};
    if (meas.sc[s]) delete meas.sc[s]; else meas.sc[s] = 1;
  });
}

/** 同じ弦で、その位置より前にある音（ハンマリング・プリングの元の音） */
function prevNote(m, s, str, ms = pt().measures) {
  const n = S();
  for (let g = gOf(m, s) - 1; g >= Math.max(0, gOf(m, s) - n * 2); g--) {
    const v = ms[Math.floor(g / n)]?.n[g % n]?.[str];
    if (v != null) return v === 'x' ? null : { m: Math.floor(g / n), s: g % n, fret: v };
  }
  return null;
}

/**
 * ハンマリング（h）・プリング（p）を、選んでいる音に付ける。
 * kind が 'auto' なら、前の音より高ければハンマリング、低ければプリング。同じ印をもう一度付けると外す
 */
function setLegato(kind) {
  const { m, s, str } = state.sel;
  const meas = pt().measures[m];
  const v = meas.n[s]?.[str];
  if (v == null || v === 'x') { flash('先に、印を付ける音のフレットを入れてください（ハンマリング・プリング・スライドはあとの音）。'); return; }
  const prev = prevNote(m, s, str);
  const needsPrev = kind === 'h' || kind === 'p' || kind === 's' || kind === 'auto';
  if (needsPrev && (!prev || prev.fret === v)) { flash('同じ弦の前（2小節以内）に、高さの違う音があるときに付けられます。'); return; }
  if (kind === 'gu' && v === 0) { flash('開放弦には下から入るグリッサンドを付けられません。'); return; }
  if (kind === 'auto') kind = v > prev.fret ? 'h' : 'p';
  const key = `${s}_${str}`;
  edit((b) => {
    const mm = P(b).measures[m];
    mm.t ||= {};
    if (!kind || mm.t[key] === kind) delete mm.t[key]; else mm.t[key] = kind;
  });
}

let flashTimer = 0;
function flash(text) {
  const el = document.getElementById('panel-msg');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function setStroke(v) {
  const { m, s } = state.sel;
  edit((b) => {
    if (v) P(b).measures[m].st[s] = v; else delete P(b).measures[m].st[s];
  });
}

let typing = null; // 2桁の数字をまとめる { m, s, str, value, t }
function typeDigit(d) {
  const { m, s, str } = state.sel;
  const now = Date.now();
  if (typing && typing.m === m && typing.s === s && typing.str === str && now - typing.t < 900 && typing.value < 10) {
    const v = typing.value * 10 + d;
    if (v <= 24) {
      // 1桁目に続けて書きかえる（元に戻すは1回で2桁ぶん戻る）
      const b = body();
      const col = P(b).measures[m].n[s].slice();
      col[str] = v; P(b).measures[m].n[s] = col;
      typing = null;
      touch();
      return;
    }
  }
  setFret(m, s, str, d);
  typing = { m, s, str, value: d, t: now };
}

function moveSel(dStep, dStr = 0) {
  const g = gOf(state.sel.m, state.sel.s) + dStep;
  const str = Math.min(5, Math.max(0, state.sel.str + dStr));
  if (g < 0) return;
  setSelG(g, str);
  state.selChord = null;
  typing = null;
  renderAll();
}

/** パネルのボタンから入れたときは、設定した分だけ先へ進む */
function keypadPut(v) {
  const { m, s, str } = state.sel;
  if (v === null) setFret(m, s, str, null);
  else setFret(m, s, str, v);
  if (state.advance && v !== null) moveSel(state.advance);
}

function putChordNotes(strings, frets) {
  const { m, s } = state.sel;
  edit((b) => {
    const meas = P(b).measures[m];
    const col = meas.n[s] ? meas.n[s].slice() : [null, null, null, null, null, null];
    for (const str of strings) col[str] = frets[str];
    meas.n[s] = col;
  });
  if (state.advance) moveSel(state.advance);
}

/* ---------- コード＋リズムの流し込み ---------- */

function pickFrets() {
  const list = voicings(state.pick.root, state.pick.q, state.pick.bass, 16);
  return list[Math.min(state.pick.vi, list.length - 1)] || list[0];
}

function currentPattern() {
  const r = state.rhythm;
  if (r.kind === 'stroke') {
    if (r.stroke === 'custom') return { kind: 'stroke', res: 1, tokens: customStroke() };
    return { kind: 'stroke', ...(STROKES.find((p) => p.id === r.stroke) || STROKES[0]) };
  }
  if (r.kind === 'arp') {
    if (r.arp === 'custom') return { kind: 'arp', res: 1, tokens: customArp() };
    return { kind: 'arp', ...(ARPEGGIOS.find((p) => p.id === r.arp) || ARPEGGIOS[0]) };
  }
  return { kind: 'none' };
}
function customStroke() {
  const n = S();
  const t = state.custom.stroke.slice(0, n);
  while (t.length < n) t.push('');
  return t;
}
function customArp() {
  const n = S();
  const t = state.custom.arp.slice(0, n).map((x) => (Array.isArray(x) ? x : []));
  while (t.length < n) t.push([]);
  return t;
}

function lengthSteps(startS) {
  const mt = meter();
  switch (state.rhythm.len) {
    case 'beat1': return mt.beat;
    case 'beat2': return mt.beat * 2;
    case 'bar1': return mt.steps;
    case 'bar2': return mt.steps * 2;
    case 'bar4': return mt.steps * 4;
    default: return mt.steps - startS; // 小節の終わりまで
  }
}

function applyChord() {
  const frets = pickFrets();
  if (!frets) return;
  const pat = currentPattern();
  const start = gOf(state.sel.m, state.sel.s);
  const len = Math.max(1, lengthSteps(state.sel.s));
  const n = S();
  edit((b) => {
    while (P(b).measures.length * n < start + len) P(b).measures.push(emptyMeasure());
    for (let g = start; g < start + len; g++) {
      const meas = P(b).measures[Math.floor(g / n)];
      const s = g % n;
      if (g > start) delete meas.c[s];
      if (pat.kind === 'none') continue;
      delete meas.n[s]; delete meas.st[s]; if (meas.sc) delete meas.sc[s];
      if (meas.t) for (const key of Object.keys(meas.t)) if (parseInt(key, 10) === s) delete meas.t[key];
      let tok = null;
      if (pat.kind === 'stroke') {
        if (s % pat.res === 0) tok = pat.tokens[(s / pat.res) % pat.tokens.length];
      } else {
        const off = g - start;
        if (off % pat.res === 0) tok = pat.tokens[(off / pat.res) % pat.tokens.length];
      }
      if (!tok || (Array.isArray(tok) && !tok.length)) continue;
      const col = [null, null, null, null, null, null];
      if (pat.kind === 'stroke') {
        if (tok === 'B') {
          const bs = frets.findIndex((f) => f !== 'x');
          col[bs] = frets[bs];
        } else {
          frets.forEach((f, i) => { if (f !== 'x') col[i] = tok.endsWith('x') ? 'x' : f; });
          meas.st[s] = tok[0];
        }
      } else {
        for (const str of resolveArp(tok, frets)) col[str] = frets[str];
      }
      if (col.some((x) => x != null)) {
        meas.n[s] = col;
        if (state.rhythm.stac) (meas.sc ||= {})[s] = 1;
      }
    }
    const first = P(b).measures[Math.floor(start / n)];
    first.c[start % n] = { r: state.pick.root, q: state.pick.q, b: state.pick.bass, f: frets.slice() };
  });
  state.selChord = null;
  setSelG(start + len);
  renderAll();
}

function removeChordMark() {
  const sc = state.selChord;
  if (!sc) return;
  state.selChord = null; // 先に外す（消したコードを描こうとしないように）
  edit((b) => { delete P(b).measures[sc.m].c[sc.s]; });
}

/** 選んでいる列：コード表示があればそれを、無ければその列の音（矢印・スタッカート・H/P も）を消す */
function clearColumn() {
  const { m, s } = state.sel;
  const meas = pt().measures[m];
  if (meas.c[s]) {
    edit((b) => { delete P(b).measures[m].c[s]; });
    return;
  }
  if (!meas.n[s] && !meas.st[s]) return;
  edit((b) => {
    const mm = P(b).measures[m];
    delete mm.n[s]; delete mm.st[s];
    if (mm.sc) delete mm.sc[s];
    if (mm.t) for (const key of Object.keys(mm.t)) if (parseInt(key, 10) === s) delete mm.t[key];
  });
}

/** 楽譜のコードをクリックしたら、そのコードを選んだ状態にする */
function selectChordMark(m, s) {
  const c = pt().measures[m].c[s];
  if (!c) return;
  state.selChord = { m, s };
  state.sel = { m, s, str: state.sel.str };
  state.pick.root = c.r; state.pick.q = c.q; state.pick.bass = c.b ?? null;
  const list = voicings(c.r, c.q, c.b ?? null, 16);
  const key = c.f.join(',');
  const i = list.findIndex((v) => v.join(',') === key);
  state.pick.vi = i >= 0 ? i : 0;
  if (i >= 8) state.pick.showAll = true;
  renderAll();
}

/* ---------- 小節の操作 ---------- */

function addMeasure() {
  edit((b) => { P(b).measures.push(emptyMeasure()); });
}
function insertMeasure() {
  edit((b) => { P(b).measures.splice(state.sel.m, 0, emptyMeasure()); });
}
function removeMeasure() {
  const b = body();
  if (P(b).measures.length <= 1) return;
  const meas = P(b).measures[state.sel.m];
  const used = Object.keys(meas.n).length || Object.keys(meas.c).length;
  if (used && !confirm(`${state.sel.m + 1}小節目を消します。よろしいですか？`)) return;
  edit((bb) => { P(bb).measures.splice(state.sel.m, 1); });
  clampSel();
  renderAll();
}

function changeMeter(next) {
  const b = body();
  if (!METERS[next] || next === b.meter) return;
  edit((bb) => {
    bb.meter = next;
    const n = METERS[next].steps;
    for (const meas of bb.parts.flatMap((pp) => pp.measures)) {
      for (const k of ['n', 'st', 'c', 'sc', 't']) for (const s of Object.keys(meas[k] || {})) if (parseInt(s, 10) >= n) delete meas[k][s];
    }
  });
  clampSel();
  renderAll();
}

/* ---------- 楽譜の描画 ---------- */

// 印刷のときは1行に4小節入るように、マスを細くして描き直す（CSS で幅を 1/4 にする）
let CW = 24, PADL = 10, PADR = 8;
function setPrintLayout(on) {
  [CW, PADL, PADR] = on ? [16, 8, 4] : [24, 10, 8];
  renderScore();
}
window.addEventListener('beforeprint', () => setPrintLayout(true));
window.addEventListener('afterprint', () => setPrintLayout(false));
const NAME_Y = 24, DG_Y = 36, STROKE_Y = 90, STR_Y0 = 114, STR_GAP = 13, BEAT_Y = 196, H = 204;
const strY = (str) => STR_Y0 + (5 - str) * STR_GAP; // 1弦がいちばん上
const colX = (s) => PADL + s * CW;

/**
 * コードのダイアグラム（横向き）。1弦が上・6弦が下、左がナット（ヘッド側）。
 * x, y = ナットの上端。fw = フレットの間隔（横）、sg = 弦の間隔（縦）。開放・ミュートの印はナットの左に出る
 */
function diagramSvg(frets, x, y, fw = 9.5, sg = 6) {
  const { start, barre } = diagramInfo(frets);
  const width = fw * 4, height = sg * 5;
  const sy = (i) => y + (5 - i) * sg; // i: 0 = 6弦 … 5 = 1弦
  let out = `<g class="dg">`;
  for (let i = 0; i < 6; i++) out += `<line class="s" x1="${x}" y1="${sy(i)}" x2="${x + width}" y2="${sy(i)}"/>`;
  for (let k = 0; k <= 4; k++) out += `<line class="${k === 0 && start === 1 ? 'nut' : 'f'}" x1="${x + k * fw}" y1="${y}" x2="${x + k * fw}" y2="${y + height}"/>`;
  if (start > 1) out += `<text class="pos" x="${x + fw * 0.5}" y="${y + height + 8}" text-anchor="middle">${start}fr</text>`;
  const r = Math.min(fw, sg) * 0.4;
  if (barre) {
    const cx = x + (barre.fret - start + 0.5) * fw;
    out += `<rect class="fd" x="${cx - r}" y="${sy(barre.to) - r}" width="${r * 2}" height="${(barre.to - barre.from) * sg + r * 2}" rx="${r}"/>`;
  }
  frets.forEach((f, i) => {
    const cy = sy(i);
    if (f === 'x') {
      const m = r * 0.85, cx = x - 5;
      out += `<line class="mute" x1="${cx - m}" y1="${cy - m}" x2="${cx + m}" y2="${cy + m}"/><line class="mute" x1="${cx - m}" y1="${cy + m}" x2="${cx + m}" y2="${cy - m}"/>`;
    } else if (f === 0) {
      out += `<circle class="open" cx="${x - 5}" cy="${cy}" r="${r * 0.85}"/>`;
    } else if (!(barre && f === barre.fret && i >= barre.from && i <= barre.to)) {
      out += `<circle class="fd" cx="${x + (f - start + 0.5) * fw}" cy="${cy}" r="${r}"/>`;
    }
  });
  return out + '</g>';
}

function displayName(c) {
  const b = body();
  return chordName(c.r, c.q, c.b, b.nameMode === 'sound' ? P(b).capo : 0);
}

function measureSvg(mi) {
  const b = body();
  const meas = P(b).measures[mi];
  const mt = meter();
  const n = mt.steps;
  const W = PADL + n * CW + PADR;
  const sel = state.sel;
  const isSelM = sel.m === mi;
  let o = `<svg class="measure" data-m="${mi}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${mi + 1}小節目">`;
  o += `<text class="num" x="2" y="10">${mi + 1}</text>`;

  // 列のクリック範囲（上のコード欄）
  for (let s = 0; s < n; s++) o += `<rect class="col" data-m="${mi}" data-s="${s}" x="${colX(s)}" y="12" width="${CW}" height="${STR_Y0 - 20}"/>`;
  if (isSelM && state.tool === 'chord') {
    o += `<rect class="selcol" x="${colX(sel.s)}" y="12" width="${CW}" height="${STR_Y0 + STR_GAP * 5 + 6 - 12}"/>`;
  }
  o += `<rect class="ph" data-ph="${mi}" x="0" y="${STR_Y0 - 8}" width="${CW}" height="${STR_GAP * 5 + 16}" visibility="hidden"/>`;

  // 拍の線
  for (let s = mt.beat; s < n; s += mt.beat) o += `<line class="beatline" x1="${colX(s)}" y1="${STR_Y0}" x2="${colX(s)}" y2="${strY(0)}"/>`;
  // 弦
  for (let str = 0; str < 6; str++) o += `<line class="staff" x1="0" y1="${strY(str)}" x2="${W}" y2="${strY(str)}"/>`;
  o += `<line class="bar" x1="0.6" y1="${STR_Y0}" x2="0.6" y2="${strY(0)}"/><line class="bar" x1="${W - 0.6}" y1="${STR_Y0}" x2="${W - 0.6}" y2="${strY(0)}"/>`;
  if (mi === P(b).measures.length - 1) o += `<line class="bar" x1="${W - 3.5}" y1="${STR_Y0}" x2="${W - 3.5}" y2="${strY(0)}"/>`;

  // 拍の番号
  const labStep = mt.sub || mt.beat;
  for (let s = 0; s < n; s += labStep) o += `<text class="beat" x="${colX(s) + CW / 2}" y="${BEAT_Y}">${mt.label(s)}</text>`;

  // コード
  const keys = Object.keys(meas.c).map(Number).sort((a, c) => a - c);
  keys.forEach((s, i) => {
    const c = meas.c[s];
    const next = i + 1 < keys.length ? keys[i + 1] : n + 2;
    const room = (next - s) * CW;
    const x = colX(s) + 4;
    const selected = state.selChord && state.selChord.m === mi && state.selChord.s === s;
    o += `<g class="chordmark${selected ? ' selected' : ''}" data-cm="${mi}" data-cs="${s}">`;
    o += `<rect class="hit" x="${colX(s)}" y="12" width="${Math.min(room, 58)}" height="${STROKE_Y - 14}" rx="4"/>`;
    o += `<text class="cname" x="${x}" y="${NAME_Y}">${esc(displayName(c))}</text>`;
    if (room >= 48) o += diagramSvg(c.f, x + 7, DG_Y, 9.5, 6.2);
    o += `</g>`;
  });

  // ストロークの矢印
  for (const [k, v] of Object.entries(meas.st)) {
    const cx = colX(Number(k)) + CW / 2;
    const top = STROKE_Y - 8, bot = STROKE_Y + 8;
    if (v === 'D') {
      o += `<line class="arrow" x1="${cx}" y1="${top}" x2="${cx}" y2="${bot - 4}"/><path class="arrowhead" d="M${cx - 3.5} ${bot - 5}L${cx + 3.5} ${bot - 5}L${cx} ${bot + 1}Z"/>`;
    } else if (v === 'U') {
      o += `<line class="arrow" x1="${cx}" y1="${bot}" x2="${cx}" y2="${top + 4}"/><path class="arrowhead" d="M${cx - 3.5} ${top + 5}L${cx + 3.5} ${top + 5}L${cx} ${top - 1}Z"/>`;
    }
  }

  // スタッカートの点（TAB の下）
  for (const k of Object.keys(meas.sc || {})) {
    o += `<circle class="stac" cx="${colX(Number(k)) + CW / 2}" cy="${strY(0) + 6.5}" r="2"/>`;
  }

  // ハンマリング・プリング（弧と H / P）、スライド（前の音からの斜めの線と S）、グリッサンド（音の前後の短い斜めの線）
  for (const [key, kind] of Object.entries(meas.t || {})) {
    const [s2, str] = key.split('_').map(Number);
    const v = meas.n[s2]?.[str];
    if (v == null) continue;
    const x2 = colX(s2) + CW / 2;
    const ys = strY(str);
    if (kind === 'gu') {
      o += `<line class="slide" x1="${x2 - CW * 0.62}" y1="${ys + 4.5}" x2="${x2 - 6}" y2="${ys - 1.5}"/>`;
      continue;
    }
    if (kind === 'gd') {
      o += `<line class="slide" x1="${x2 + 6}" y1="${ys - 1.5}" x2="${x2 + CW * 0.62}" y2="${ys + 4.5}"/>`;
      continue;
    }
    const prev = prevNote(mi, s2, str);
    const x1 = prev && prev.m === mi ? colX(prev.s) + CW / 2 : 2;
    const mid = (x1 + x2) / 2;
    if (kind === 's') {
      const up = prev ? v > prev.fret : true;
      const d = up ? 1 : -1;
      o += `<line class="slide" x1="${x1 + 7}" y1="${ys + 3 * d}" x2="${x2 - 7}" y2="${ys - 3 * d}"/>`;
      o += `<text class="slurtxt" x="${mid}" y="${ys - 7}">S</text>`;
      continue;
    }
    const y = ys - 6.5;
    o += `<path class="slur" d="M${x1 + 3} ${y}Q${mid} ${y - 7} ${x2 - 3} ${y}"/>`;
    o += `<text class="slurtxt" x="${mid}" y="${y - 5}">${kind === 'h' ? 'H' : 'P'}</text>`;
  }

  // フレットの数字
  for (const [k, col] of Object.entries(meas.n)) {
    const cx = colX(Number(k)) + CW / 2;
    col.forEach((v, str) => {
      if (v == null) return;
      const y = strY(str);
      if (v === 'x') {
        o += `<rect class="fretbg" x="${cx - 5}" y="${y - 5}" width="10" height="10"/><line class="mutex" x1="${cx - 3.5}" y1="${y - 3.5}" x2="${cx + 3.5}" y2="${y + 3.5}"/><line class="mutex" x1="${cx - 3.5}" y1="${y + 3.5}" x2="${cx + 3.5}" y2="${y - 3.5}"/>`;
      } else {
        const w = String(v).length > 1 ? 16 : 10;
        o += `<rect class="fretbg" x="${cx - w / 2}" y="${y - 6}" width="${w}" height="12"/><text class="fret" x="${cx}" y="${y}">${v}</text>`;
      }
    });
  }

  // 選んでいるマス
  if (isSelM && state.tool === 'tab') {
    o += `<rect class="selcell" x="${colX(sel.s) + 2}" y="${strY(sel.str) - 7}" width="${CW - 4}" height="14" rx="3"/>`;
  }
  // マスのクリック範囲
  for (let s = 0; s < n; s++) {
    for (let str = 0; str < 6; str++) {
      o += `<rect class="cell" data-m="${mi}" data-s="${s}" data-str="${str}" x="${colX(s)}" y="${strY(str) - STR_GAP / 2}" width="${CW}" height="${STR_GAP}"/>`;
    }
  }
  return o + '</svg>';
}

function renderScore() {
  const b = body();
  if (!b) return;
  $('score').innerHTML = P(b).measures.map((_, i) => measureSvg(i)).join('');
  const sg = song();
  $('sheet-title').textContent = sg.title;
  const meta = [];
  if (b.parts.length > 1) meta.push(`<span><b>${esc(P(b).name)}</b></span>`);
  meta.push(P(b).capo ? `<span><b>Capo ${P(b).capo}</b></span>` : '<span>カポなし</span>');
  meta.push(`<span>${esc(b.meter)}</span>`, `<span>♩ = ${b.tempo}</span>`);
  if (P(b).capo) meta.push(`<span>コード名：${b.nameMode === 'sound' ? '実音' : '押さえ方'}</span>`);
  $('sheet-meta').innerHTML = meta.join('');
  $('remove-measure').disabled = P(b).measures.length <= 1;
}

function renderSongbar() {
  const sg = song();
  const b = body();
  const sel = $('song-select');
  sel.innerHTML = state.order.map((id) => `<option value="${id}"${id === state.currentId ? ' selected' : ''}>${esc(state.songs[id].title || '無題')}</option>`).join('');
  if (document.activeElement !== $('title')) $('title').value = sg.title;
  $('capo').value = P(b).capo;
  $('meter').value = b.meter;
  if (document.activeElement !== $('tempo')) $('tempo').value = b.tempo;
  $('namemode').value = b.nameMode;
  $('undo').disabled = !state.undo.length;
  $('redo').disabled = !state.redo.length;
  $('capo-label').textContent = b.parts.length > 1 ? `カポ（${P(b).name}）` : 'カポ';
  renderParts();
}

/* ---------- パート ---------- */

function renderParts() {
  const b = body();
  $('parts').innerHTML = b.parts.map((pp, i) => `<button type="button" class="btn${i === state.part ? ' on' : ''}" data-part="${i}" aria-pressed="${i === state.part}" title="${esc(pp.name)}${i === state.part ? '（もう一度押すと設定）' : ''}">${esc(pp.name)}</button>`).join('')
    + `<button type="button" class="btn" data-part="add" title="パートを足す">＋<span class="lbl"> パート</span></button>`
    + `<button type="button" class="btn" data-part="menu" title="このパートの名前・カポ・複製・削除" aria-label="パートの設定">⋯</button>`;
  $('play-all').setAttribute('aria-pressed', state.playAll);
  $('play-all').hidden = b.parts.length < 2;
}

function switchPart(i) {
  if (i === state.part) return;
  state.part = i;
  state.selChord = null;
  typing = null;
  clampSel();
  renderAll();
}

function addPart(copy = false) {
  const cur = pt();
  let made;
  edit((b) => {
    const name = `パート${b.parts.length + 1}`;
    made = copy
      ? { ...structuredClone(cur), name: `${cur.name}のコピー` }
      : newPart(name, cur.capo, cur.measures.length);
    b.parts.push(made);
  });
  state.part = body().parts.length - 1;
  state.selChord = null;
  clampSel();
  renderAll();
}

function openPartDialog() {
  const f = $('part-form');
  f.name.value = pt().name;
  f.capo.value = String(pt().capo);
  $('part-delete').disabled = body().parts.length < 2;
  $('part-dialog').showModal();
  f.name.select();
}

/* ---------- パネル ---------- */

function renderPanel() {
  $('tab-tab').setAttribute('aria-selected', state.tool === 'tab');
  $('tab-chord').setAttribute('aria-selected', state.tool === 'chord');
  $('panel-body').innerHTML = state.tool === 'tab' ? tabPanel() : chordPanel();
}

function whereText() {
  const { m, s, str } = state.sel;
  const mt = meter();
  const beat = Math.floor(s / mt.beat) + 1;
  const sub = s % mt.beat;
  const subTxt = sub ? `の ${sub + 1}つ目の16分` : '';
  return `<b>${m + 1}小節目</b> ${beat}拍目${subTxt}` + (state.tool === 'tab' ? ` ／ <b>${STRING_NAMES[str]}</b>` : '');
}

function tabPanel() {
  const { m, s } = state.sel;
  const st = pt().measures[m].st[s] || '';
  const frets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 'x'];
  let h = `<div class="pbody">`;
  if (state.selChord) {
    const c = pt().measures[state.selChord.m].c[state.selChord.s];
    h += `<div class="selchord">楽譜の <b>${esc(displayName(c))}</b>（${state.selChord.m + 1}小節目）を選んでいます<span class="sp"></span>
      <button type="button" class="btn danger" data-act="del-chord">コード表示を消す</button></div>
      <p class="hint">Delete か Backspace でも消せます。</p>`;
  }
  h += `<div class="sec"><div class="sec-h">選んでいる位置</div><div class="where">${whereText()}</div>
    <p class="hint">楽譜のマスをクリックして選びます。キーボード：<kbd>0</kbd>〜<kbd>9</kbd>（続けて打つと2桁）・<kbd>X</kbd> ミュート・<kbd>S</kbd> スタッカート・<kbd>H</kbd> ハンマリング・<kbd>P</kbd> プリング・<kbd>Delete</kbd> <kbd>Backspace</kbd> 消す（コードを選んでいるときはコード）・<kbd>←</kbd><kbd>→</kbd> 前後・<kbd>↑</kbd><kbd>↓</kbd> 弦・<kbd>Space</kbd> 再生</p></div>`;

  h += `<div class="sec"><div class="sec-h">フレット</div><div class="keypad">`;
  for (const f of frets) h += `<button type="button" data-fret="${f}">${f === 'x' ? '×' : f}</button>`;
  h += `<button type="button" class="wide" data-fret="del">消す</button>`;
  h += `<button type="button" class="wide" data-move="-1">← 前</button><button type="button" class="wide" data-move="1">次 →</button>`;
  h += `<button type="button" class="wide" data-mstr="1">↑ 上の弦</button><button type="button" class="wide" data-mstr="-1">↓ 下の弦</button>`;
  h += `</div></div>`;

  h += `<div class="sec"><div class="sec-h">ボタンで入れたあと進む</div><div class="seg">`;
  for (const [v, l] of [[0, '進まない'], [1, '16分'], [2, '8分'], [4, '4分']]) h += `<button type="button" data-adv="${v}" aria-pressed="${state.advance === v}">${l}</button>`;
  h += `</div></div>`;

  h += `<div class="sec"><div class="sec-h">ストロークの矢印</div><div class="seg">`;
  for (const [v, l] of [['D', '↓ ダウン'], ['U', '↑ アップ'], ['', 'なし']]) h += `<button type="button" data-stroke="${v}" aria-pressed="${st === v}">${l}</button>`;
  h += `</div></div>`;

  const lg = pt().measures[m].t?.[`${s}_${state.sel.str}`] || '';
  h += `<div class="sec"><div class="sec-h">ハンマリング・プリング・スライド <small>選んでいる音に付ける</small></div><div class="seg">
    <button type="button" data-legato="h" aria-pressed="${lg === 'h'}">H ハンマリング</button>
    <button type="button" data-legato="p" aria-pressed="${lg === 'p'}">P プリング</button>
    <button type="button" data-legato="s" aria-pressed="${lg === 's'}">S スライド</button>
    <button type="button" data-legato="gu" aria-pressed="${lg === 'gu'}">↗ グリッサンド（下から入る）</button>
    <button type="button" data-legato="gd" aria-pressed="${lg === 'gd'}">↘ グリッサンド（弾いて下へ抜く）</button>
    <button type="button" data-legato="" aria-pressed="false">外す</button></div>
    <p class="hint">ハンマリング・プリング・スライドは、同じ弦の前の音から選んでいる音へ弾かずにつなげます（あとの音を選んで押す）。
      グリッサンドは、選んだ音に下から滑り込む／弾いたあと下へ滑らせて消します。
      キーボード：<kbd>H</kbd> <kbd>P</kbd> <kbd>/</kbd> スライド・<kbd>G</kbd> 下から入る・<kbd>Shift</kbd>+<kbd>G</kbd> 下へ抜く</p>
    <p class="hint" id="panel-msg" role="status" hidden></p></div>`;

  const stac = !!pt().measures[m].sc?.[s];
  h += `<div class="sec"><div class="sec-h">スタッカート <small>この位置の音を短く切る（キーボード <kbd>S</kbd>）</small></div><div class="seg">
    <button type="button" data-act="stac" aria-pressed="${stac}">・ スタッカート${stac ? '（付いています）' : ''}</button></div></div>`;

  // コードの音から入れる（アルペジオを1音ずつ打つとき）
  const at = chordAt(m, s);
  const src = at ? { name: displayName(at), f: at.f, from: '楽譜のこの位置のコード' }
    : { name: chordName(state.pick.root, state.pick.q, state.pick.bass), f: pickFrets(), from: '「コード＋リズム」で選んでいるコード' };
  h += `<div class="sec"><div class="sec-h">コードの音から入れる <small>${esc(src.from)}：<b>${esc(src.name)}</b></small></div><div class="chordnotes">`;
  for (let str = 5; str >= 0; str--) {
    const f = src.f[str];
    h += `<button type="button" data-cn="${str}" ${f === 'x' ? 'disabled' : ''}>${STRING_NAMES[str]} <b>${f === 'x' ? '×' : f}</b></button>`;
  }
  h += `</div><div class="seg"><button type="button" data-cn="all">和音で入れる（全部の弦）</button></div>
    <p class="hint">押さえたままアルペジオを弾くときは、弦のボタンを順に押すと、そのコードのフレットが入って次へ進みます。</p></div>`;
  return h + `</div>`;
}

function chordPanel() {
  const p = state.pick;
  const b = body();
  const list = voicings(p.root, p.q, p.bass, 16);
  if (p.vi >= list.length) p.vi = 0;
  const shown = p.showAll ? list : list.slice(0, 8);
  const name = chordName(p.root, p.q, p.bass);
  const sound = P(b).capo ? chordName(p.root, p.q, p.bass, P(b).capo) : '';
  let h = `<div class="pbody">`;

  if (state.selChord) {
    const c = P(b).measures[state.selChord.m].c[state.selChord.s];
    h += `<div class="selchord">楽譜の <b>${esc(displayName(c))}</b>（${state.selChord.m + 1}小節目）を選んでいます<span class="sp"></span>
      <button type="button" class="btn danger" data-act="del-chord">コード表示を消す</button></div>`;
  }

  h += `<div class="sec"><div class="sec-h">入れる位置</div><div class="where">${whereText()}</div>
    <p class="hint">楽譜の上をクリックして、コードを始める位置を選びます。Delete か Backspace で、選んだ位置のコード（無ければその位置の音）を消せます。</p></div>`;

  h += `<div class="sec"><div class="sec-h">コード</div><div class="cname-big">${esc(name)}${sound ? `<small>カポ${P(b).capo}の実音：${esc(sound)}</small>` : ''}</div>`;
  h += `<div class="roots">`;
  ROOTS.forEach((r, i) => { h += `<button type="button" data-root="${i}" aria-pressed="${p.root === i}" title="${ROOT_LABELS[i]}">${r}</button>`; });
  h += `</div><div class="row2">
    <label class="field"><span>種類</span><select class="in" id="pick-q">${QUALITIES.map((q) => `<option value="${q.id}"${q.id === p.q ? ' selected' : ''}>${q.id ? esc(q.id) : '（なし）'}　${q.label}</option>`).join('')}</select></label>
    <label class="field"><span>ベース音（オンコード）</span><select class="in" id="pick-bass"><option value="">なし</option>${ROOTS.map((r, i) => (i === p.root ? '' : `<option value="${i}"${p.bass === i ? ' selected' : ''}>/${r}</option>`)).join('')}</select></label>
  </div></div>`;

  h += `<div class="sec"><div class="sec-h">押さえ方 <small>${list.length ? `${list.length}通りから選べます` : ''}</small></div>`;
  if (!list.length) {
    h += `<p class="hint">この組み合わせで押さえやすい形が見つかりませんでした。ベース音や種類を変えてください。</p>`;
  } else {
    h += `<div class="voicings">`;
    shown.forEach((f, i) => {
      h += `<button type="button" data-vi="${i}" aria-pressed="${p.vi === i}" title="${f.join(' ')}"><svg viewBox="-11 -4 56 54" aria-hidden="true">${diagramSvg(f, 0, 2, 10, 7)}</svg><span class="vf">${f.join(' ')}</span></button>`;
    });
    h += `</div>`;
    if (list.length > 8) h += `<div class="seg"><button type="button" data-act="more">${p.showAll ? '少なく表示' : 'ほかの押さえ方も見る'}</button></div>`;
  }
  h += `</div>`;

  const r = state.rhythm;
  h += `<div class="sec"><div class="sec-h">リズム</div><div class="seg">`;
  for (const [v, l] of [['stroke', 'ストローク'], ['arp', 'アルペジオ'], ['none', 'コード表示だけ']]) h += `<button type="button" data-kind="${v}" aria-pressed="${r.kind === v}">${l}</button>`;
  h += `</div>`;
  if (r.kind === 'none') {
    h += `<p class="hint">TAB はそのままにして、上にコードの押さえ方だけを表示します。</p>`;
  } else {
    const items = r.kind === 'stroke' ? STROKES : ARPEGGIOS;
    const cur = r.kind === 'stroke' ? r.stroke : r.arp;
    h += `<div class="patterns" role="radiogroup">`;
    for (const it of items) {
      h += `<label><input type="radio" name="pat" value="${it.id}"${cur === it.id ? ' checked' : ''}><span class="pn">${esc(it.name)}</span><span class="ph2">${esc(r.kind === 'stroke' ? it.tokens.map(strokeGlyph).join(' ') + '　' + it.hint : it.hint)}</span></label>`;
    }
    h += `<label><input type="radio" name="pat" value="custom"${cur === 'custom' ? ' checked' : ''}><span class="pn">自分で作る</span><span class="ph2">下のマスで1小節分を作ります</span></label>`;
    h += `</div>`;
    if (cur === 'custom') h += r.kind === 'stroke' ? customStrokeEditor() : customArpEditor();
    if (r.kind === 'arp') h += `<p class="hint">アルペジオは、選んだ押さえ方のフレットをそのまま使います。B はベース（いちばん低い弦）、N はその1本上の弦です。</p>`;
  }
  h += `</div>`;

  if (r.kind !== 'none') {
    h += `<div class="sec"><div class="sec-h">弾き方</div><div class="seg">
      <button type="button" data-act="stac-all" aria-pressed="${!!r.stac}">・ スタッカートで弾く（音を短く切る）</button></div></div>`;
  }

  const mt = meter();
  h += `<div class="sec"><div class="sec-h">長さ</div><div class="seg">`;
  const lens = [['beat1', '1拍'], ['beat2', '2拍'], ['end', '小節の終わりまで'], ['bar2', '2小節'], ['bar4', '4小節']];
  for (const [v, l] of lens) {
    h += `<button type="button" data-len="${v}" aria-pressed="${r.len === v}">${l}</button>`;
  }
  h += `</div></div>`;
  h += `</div>`;
  h += `<div class="apply"><button type="button" class="btn primary" data-act="apply"${list.length ? '' : ' disabled'}>${esc(name)} を入れる</button>
    <p class="hint">入れたあとは続きの位置へ進むので、次のコードを選んで続けて入れられます。同じ範囲の TAB は置きかわります。</p></div>`;
  return h;
}

function customStrokeEditor() {
  const t = customStroke();
  const mt = meter();
  let h = `<div class="custom"><div class="crow"><span class="clab">ストローク</span>`;
  t.forEach((v, i) => {
    h += `<button type="button" class="cc${i % mt.beat === 0 ? ' beat' : ''}${v ? ' on' : ''}" data-cs="${i}" title="${i + 1}">${v ? strokeGlyph(v).replace('×', 'x') : ''}</button>`;
  });
  h += `</div></div><p class="hint">マスを押すたびに ↓ → ↑ → ↓x（ブラッシング）→ ↑x → B（ベースだけ）→ 休み と変わります。1マスが16分音符です。</p>`;
  return h;
}

function customArpEditor() {
  const t = customArp();
  const mt = meter();
  const f = pickFrets() || ['x', 'x', 'x', 'x', 'x', 'x'];
  const played = f.map((v, i) => (v !== 'x' ? i : -1)).filter((i) => i >= 0);
  const bass = played[0];
  const rows = [['1', '1弦'], ['2', '2弦'], ['3', '3弦'], ['4', '4弦'], ['5', '5弦'], ['N', 'N'], ['B', 'B']];
  let h = `<div class="custom">`;
  for (const [role, label] of rows) {
    let lab = label;
    if (/^\d$/.test(role)) {
      const s = 6 - Number(role);
      lab += f[s] === 'x' || s <= bass ? '' : ` ${f[s]}`;
    }
    h += `<div class="crow"><span class="clab" title="${esc(lab)}">${esc(lab)}</span>`;
    t.forEach((cell, i) => {
      const on = cell.includes(role);
      h += `<button type="button" class="cc${i % mt.beat === 0 ? ' beat' : ''}${on ? ' on' : ''}" data-ca="${i}" data-role="${role}" title="${i + 1}"></button>`;
    });
    h += `</div>`;
  }
  h += `</div><p class="hint">1マスが16分音符です。弦の番号のフレットは今の押さえ方のもの。押さえ方で弾かない弦は飛ばされます。</p>`;
  return h;
}

function renderAll() {
  if (!song()) return;
  renderSongbar();
  renderScore();
  renderPanel();
}

/* ---------- 再生 ---------- */

const play = { on: false, timer: null, raf: 0, next: 0, g: 0, end: 0, queue: [], lastPh: null };

function start() {
  const b = body();
  const n = S();
  play.on = true;
  play.g = gOf(state.sel.m, 0);
  play.parts = state.playAll ? b.parts.map((pp, i) => ({ p: pp, i })) : [{ p: P(b), i: state.part }];
  play.end = Math.max(...play.parts.map(({ p }) => p.measures.length)) * n;
  // 曲で使う音を先に作っておく（再生中に作ると音が遅れることがある）
  const notes = new Set();
  for (const { p } of play.parts) {
    for (const meas of p.measures) for (const col of Object.values(meas.n)) col.forEach((v, str) => { if (v != null) notes.add((v === 'x' ? 'x' : '') + midiOf(str, v === 'x' ? 0 : v, p.capo)); });
  }
  audio.prepare([...notes]);
  play.next = audio.now() + 0.08;
  play.queue = [];
  $('play').textContent = '■ 止める';
  play.timer = setInterval(tick, 25);
  tick();
  play.raf = requestAnimationFrame(drawHead);
}
function stop() {
  if (!play.on) return;
  play.on = false;
  clearInterval(play.timer);
  cancelAnimationFrame(play.raf);
  audio.stopAll();
  if (play.lastPh) play.lastPh.setAttribute('visibility', 'hidden');
  play.lastPh = null;
  $('play').textContent = '▶ 再生';
}
function tick() {
  const b = body();
  const n = S();
  const dt = 60 / b.tempo / 4;
  while (play.next < audio.now() + 0.15) {
    if (play.g >= play.end) return;
    const s = play.g % n;
    for (const { p: part, i: voice } of play.parts) playStep(part, voice, s, n, dt);
    play.queue.push({ t: play.next, g: play.g });
    play.g++;
    play.next += dt;
  }
}
/** 1つのパートの、いまの位置の音を鳴らす（voice：パートごとに弦の鳴り方を分ける番号） */
function playStep(part, voice, s, n, dt) {
  const ms = part.measures;
  const capo = part.capo;
  const mi = Math.floor(play.g / n);
  const meas = ms[mi];
  const col = meas?.n[s];
  if (!col) return;
  const dir = meas.st[s];
  const strings = [0, 1, 2, 3, 4, 5].filter((i) => col[i] != null);
  if (dir === 'U') strings.reverse();
  // ストロークは弦を順に少しずつずらす。アップは軽めに
  const gap = dir ? 0.016 : 0;
  const vel = dir === 'U' ? 0.68 : dir === 'D' ? 0.82 : 0.9;
  strings.forEach((str, i) => {
    const v = col[str];
    const mark = meas.t?.[`${s}_${str}`];
    const when = play.next + i * gap;
    if (mark === 's' && v !== 'x') {
      // スライド：前の音を弾き直さずに、音程をずらしていく
      const prev = prevNote(mi, s, str, ms);
      if (prev && audio.slide(str, v - prev.fret, Math.max(when - Math.min(0.12, dt * 0.8), audio.now()), when, false, voice)) return;
    }
    // ハンマリング・プリングは弾かずに鳴らすので、小さく柔らかく
    const legato = mark === 'h' || mark === 'p';
    audio.pluck(str, midiOf(str, v === 'x' ? 0 : v, capo), when, v === 'x',
      vel * (dir ? 1 - i * 0.03 : 1) * (legato ? 0.62 : 1), legato ? 0.018 : 0.008,
      mark === 'gu' ? { from: -5, time: Math.min(0.14, dt * 1.2) } : null, voice);
    if (mark === 'gd') audio.slide(str, -7, when + Math.min(0.25, dt * 1.5), when + Math.min(0.25, dt * 1.5) + 0.22, true, voice);
  });
  if (meas.sc?.[s]) {
    // スタッカート：次の音までの半分くらいで、このパートの鳴っている弦を全部止める
    let k = 1;
    while (k < 4) {
      const g2 = play.g + k;
      if (ms[Math.floor(g2 / n)]?.n[g2 % n]) break;
      k++;
    }
    audio.damp(play.next + strings.length * gap + Math.max(0.07, k * dt * 0.5), voice);
  }
}

function drawHead() {
  if (!play.on) return;
  const t = audio.now();
  let cur = null;
  while (play.queue.length && play.queue[0].t <= t) cur = play.queue.shift();
  if (cur) {
    const n = S();
    const m = Math.floor(cur.g / n), s = cur.g % n;
    const el = document.querySelector(`[data-ph="${m}"]`);
    if (play.lastPh && play.lastPh !== el) play.lastPh.setAttribute('visibility', 'hidden');
    if (el) {
      el.setAttribute('x', colX(s));
      el.setAttribute('visibility', 'visible');
      if (s === 0) el.closest('svg')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    play.lastPh = el;
  }
  if (!play.queue.length && play.g >= play.end) { setTimeout(stop, 400); return; }
  play.raf = requestAnimationFrame(drawHead);
}

/* ---------- テキスト書き出し ---------- */

function toText() {
  const b = body();
  const sg = song();
  const n = S();
  const W = 3;
  const lines = [sg.title + (b.parts.length > 1 ? `（${P(b).name}）` : ''), (P(b).capo ? `Capo ${P(b).capo}` : 'カポなし') + `  ${b.meter}  ♩=${b.tempo}`, ''];
  const perLine = n >= 16 ? 4 : 6;
  const labels = ['e', 'B', 'G', 'D', 'A', 'E'];
  for (let i = 0; i < P(b).measures.length; i += perLine) {
    const group = P(b).measures.slice(i, i + perLine);
    let chordLine = '  ', strokeLine = '  ';
    const rows = labels.map((l) => l + '|');
    group.forEach((meas) => {
      const cl = new Array(n * W + 1).fill(' ');
      let free = 0;
      for (let s = 0; s < n; s++) {
        const c = meas.c[s];
        if (c) {
          const name = displayName(c);
          const at = Math.max(s * W, free);
          [...name].forEach((ch, k) => { if (at + k < cl.length) cl[at + k] = ch; });
          free = at + name.length + 1;
        }
        strokeLine += ((meas.st[s] === 'D' ? 'v' : meas.st[s] === 'U' ? '^' : ' ') + (meas.sc?.[s] ? '.' : '')).padEnd(W);
        for (let r = 0; r < 6; r++) {
          const v = meas.n[s]?.[5 - r];
          const lg = meas.t?.[`${s}_${5 - r}`];
          const prevF = lg === 's' ? prevNote(i + group.indexOf(meas), s, 5 - r)?.fret : null;
          const mark = lg === 's' ? (prevF != null && v < prevF ? '\\' : '/') : lg === 'gu' ? '/' : lg === 'h' || lg === 'p' ? lg : '';
          const txt = v == null ? '' : mark + String(v) + (lg === 'gd' ? '\\' : '');
          rows[r] += (txt + '---').slice(0, W);
        }
      }
      chordLine += cl.join('');
      strokeLine += ' ';
      for (let r = 0; r < 6; r++) rows[r] += '|';
    });
    if (chordLine.trim()) lines.push(chordLine.trimEnd());
    if (strokeLine.trim()) lines.push(strokeLine.trimEnd());
    lines.push(...rows, '');
  }
  return lines.join('\n');
}

/* ---------- イベント ---------- */

function fillCapoOptions(sel) {
  sel.innerHTML = Array.from({ length: 13 }, (_, i) => `<option value="${i}">${i === 0 ? 'なし' : i}</option>`).join('');
}
fillCapoOptions($('capo'));
fillCapoOptions($('new-capo'));

$('song-select').addEventListener('change', (e) => openSong(e.target.value));
$('title').addEventListener('input', (e) => {
  song().title = e.target.value;
  song().updatedAt = Date.now();
  scheduleSave();
  $('sheet-title').textContent = e.target.value;
  const opt = $('song-select').selectedOptions[0];
  if (opt) opt.textContent = e.target.value || '無題';
});
$('capo').addEventListener('change', (e) => { edit((b) => { P(b).capo = Number(e.target.value); }); });
$('meter').addEventListener('change', (e) => changeMeter(e.target.value));
$('tempo').addEventListener('change', (e) => { edit((b) => { b.tempo = clampTempo(e.target.value); }); });
$('namemode').addEventListener('change', (e) => { edit((b) => { b.nameMode = e.target.value; }); });
$('undo').addEventListener('click', undo);
$('parts').addEventListener('click', (e) => {
  const t = e.target.closest('[data-part]');
  if (!t) return;
  const v = t.dataset.part;
  if (v === 'add') addPart();
  else if (v === 'menu') openPartDialog();
  else if (Number(v) === state.part) openPartDialog();
  else switchPart(Number(v));
});
$('play-all').addEventListener('click', () => {
  state.playAll = !state.playAll;
  savePrefs();
  renderParts();
});
fillCapoOptions($('part-capo'));
$('part-dialog').addEventListener('close', () => {
  if ($('part-dialog').returnValue !== 'ok') return;
  const f = $('part-form');
  const name = f.name.value.trim() || pt().name;
  const capo = Number(f.capo.value) || 0;
  if (name === pt().name && capo === pt().capo) return;
  edit((b) => { P(b).name = name; P(b).capo = capo; });
});
$('part-copy').addEventListener('click', () => { $('part-dialog').close('cancel'); addPart(true); });
$('part-delete').addEventListener('click', () => {
  if (body().parts.length < 2) return;
  if (!confirm(`「${pt().name}」を削除します。よろしいですか？（「戻す」で元に戻せます）`)) return;
  $('part-dialog').close('cancel');
  const i = state.part;
  edit((b) => { b.parts.splice(i, 1); });
  state.part = Math.max(0, i - 1);
  state.selChord = null;
  clampSel();
  renderAll();
});
$('redo').addEventListener('click', redo);
$('play').addEventListener('click', () => (play.on ? stop() : start()));
$('print').addEventListener('click', () => window.print());
$('delete-song').addEventListener('click', deleteSong);
$('add-measure').addEventListener('click', addMeasure);
$('insert-measure').addEventListener('click', insertMeasure);
$('remove-measure').addEventListener('click', removeMeasure);

$('new-song').addEventListener('click', () => {
  if (!state.ready) return;
  const f = $('new-form');
  f.title.value = '新しい曲'; f.capo.value = '0'; f.meter.value = '4/4'; f.tempo.value = '90';
  $('new-dialog').showModal();
  f.title.select();
});
$('new-dialog').addEventListener('close', () => {
  if ($('new-dialog').returnValue !== 'ok') return;
  const f = $('new-form');
  createSong({ title: f.title.value, capo: f.capo.value, meter: f.meter.value, tempo: f.tempo.value });
});

$('text-out').addEventListener('click', () => {
  $('text-area').value = toText();
  $('text-dialog').showModal();
});
$('copy-text').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('text-area').value); $('copy-text').textContent = 'コピーしました'; }
  catch { $('text-area').select(); document.execCommand('copy'); $('copy-text').textContent = 'コピーしました'; }
  setTimeout(() => { $('copy-text').textContent = 'コピー'; }, 1500);
});

$('tab-tab').addEventListener('click', () => { state.tool = 'tab'; savePrefs(); renderAll(); });
$('tab-chord').addEventListener('click', () => { state.tool = 'chord'; savePrefs(); renderAll(); });

// 楽譜のクリック
$('score').addEventListener('click', (e) => {
  const cm = e.target.closest('[data-cm]');
  if (cm) {
    selectChordMark(Number(cm.dataset.cm), Number(cm.dataset.cs));
    return;
  }
  const t = e.target.closest('[data-s]');
  if (!t) return;
  const m = Number(t.dataset.m), s = Number(t.dataset.s);
  const str = t.dataset.str != null ? Number(t.dataset.str) : state.sel.str;
  state.sel = { m, s, str };
  state.selChord = null;
  typing = null;
  renderAll();
});

// パネルのクリック
$('panel-body').addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el) return;
  const d = el.dataset;
  if (d.fret != null) {
    if (d.fret === 'del') keypadPut(null);
    else keypadPut(d.fret === 'x' ? 'x' : Number(d.fret));
  } else if (d.move) moveSel(Number(d.move));
  else if (d.mstr) moveSel(0, Number(d.mstr));
  else if (d.adv != null) { state.advance = Number(d.adv); savePrefs(); renderPanel(); }
  else if (d.stroke != null) setStroke(d.stroke);
  else if (d.cn != null) {
    const { m, s } = state.sel;
    const at = chordAt(m, s);
    const f = at ? at.f : pickFrets();
    if (!f) return;
    const strings = d.cn === 'all' ? [0, 1, 2, 3, 4, 5].filter((i) => f[i] !== 'x') : [Number(d.cn)];
    putChordNotes(strings, f);
  } else if (d.root != null) {
    state.pick.root = Number(d.root);
    if (state.pick.bass === state.pick.root) state.pick.bass = null;
    state.pick.vi = 0; state.pick.showAll = false;
    renderPanel();
  } else if (d.vi != null) { state.pick.vi = Number(d.vi); renderPanel(); }
  else if (d.kind) { state.rhythm.kind = d.kind; savePrefs(); renderPanel(); }
  else if (d.len) { state.rhythm.len = d.len; savePrefs(); renderPanel(); }
  else if (d.cs != null) {
    const order = ['', 'D', 'U', 'Dx', 'Ux', 'B'];
    const t = customStroke();
    const i = Number(d.cs);
    t[i] = order[(order.indexOf(t[i]) + 1) % order.length];
    state.custom.stroke = t; savePrefs(); renderPanel();
  } else if (d.ca != null) {
    const t = customArp();
    const i = Number(d.ca);
    const cell = new Set(t[i]);
    if (cell.has(d.role)) cell.delete(d.role); else cell.add(d.role);
    t[i] = [...cell];
    state.custom.arp = t; savePrefs(); renderPanel();
  } else if (d.act === 'apply') applyChord();
  else if (d.act === 'more') { state.pick.showAll = !state.pick.showAll; renderPanel(); }
  else if (d.act === 'del-chord') removeChordMark();
  else if (d.act === 'stac') toggleStaccato();
  else if (d.legato != null) setLegato(d.legato);
  else if (d.act === 'stac-all') { state.rhythm.stac = !state.rhythm.stac; savePrefs(); renderPanel(); }
});
$('panel-body').addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'pick-q') { state.pick.q = t.value; state.pick.vi = 0; state.pick.showAll = false; renderPanel(); }
  else if (t.id === 'pick-bass') { state.pick.bass = t.value === '' ? null : Number(t.value); state.pick.vi = 0; state.pick.showAll = false; renderPanel(); }
  else if (t.name === 'pat') {
    if (state.rhythm.kind === 'stroke') state.rhythm.stroke = t.value; else state.rhythm.arp = t.value;
    savePrefs(); renderPanel();
  }
});

// キーボード
document.addEventListener('keydown', (e) => {
  if (!state.ready || !song()) return;
  if (e.target.closest('input, textarea, select, dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); if (play.on) stop(); else start(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); moveSel(-1); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); moveSel(1); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    // 選んでいるコード表示を消す。コード＋リズムでは、選んでいる位置のコード（無ければその列の音）を消す
    if (state.selChord) { e.preventDefault(); removeChordMark(); return; }
    if (state.tool === 'chord') { e.preventDefault(); clearColumn(); return; }
  }
  if (state.tool !== 'tab') return;
  if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(0, 1); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(0, -1); return; }
  const { m, s, str } = state.sel;
  if (/^[0-9]$/.test(e.key)) { e.preventDefault(); typeDigit(Number(e.key)); return; }
  if (e.key === '/') { e.preventDefault(); typing = null; setLegato('s'); return; }
  if (e.key === 'g' || e.key === 'G') { e.preventDefault(); typing = null; setLegato(e.shiftKey ? 'gd' : 'gu'); return; }
  if (e.key === 'h' || e.key === 'H') { e.preventDefault(); typing = null; setLegato('h'); return; }
  if (e.key === 'p' || e.key === 'P') { e.preventDefault(); typing = null; setLegato('p'); return; }
  if (e.key === 's' || e.key === 'S') { e.preventDefault(); typing = null; toggleStaccato(); return; }
  if (e.key === 'x' || e.key === 'X') { e.preventDefault(); typing = null; setFret(m, s, str, 'x'); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault(); typing = null;
    if (pt().measures[m].n[s]?.[str] != null) setFret(m, s, str, null);
    else if (e.key === 'Backspace') moveSel(-1);
  }
});

/* ---------- 開始 ---------- */

account.onUserChanged((user) => {
  if (state.mode === (user ? 'account' : 'local') && state.ready) return;
  load(user);
});
