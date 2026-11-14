/* スライド：エディタ */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const stage = $('#stage'), selbox = $('#selbox'), tools = $('#tools'), thumbs = $('#thumbs');

let deck, theme;
let cur = 0;            // 表示中のスライド
let selId = null;       // 選択中の部品
let editing = null;     // 文字を入力中の部品
let editDirty = false;
let savedRange = null;  // 入力中の選択範囲（ツールバー操作で失われないよう控える）
let scale = 1;
let clip = null;
const undoStack = [], redoStack = [];
let last, saveT;

const slide = () => deck.slides[cur];
const selEl = () => slide().els.find(e => e.id === selId);
const nodeOf = id => stage.querySelector(`[data-id="${id}"]`);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- 保存と履歴 ---------- */
const snap = () => JSON.stringify({ slides: deck.slides, cur });

function setStatus(s) { $('#status').textContent = s; }

let unsaved = false;   // まだ保存先に届いていない変更があるか
let remote = false;    // アカウント（Vercel）に保存しているか

async function save() {
  clearTimeout(saveT);
  const at = deck.updated;
  try {
    await Store.put(deck);
    if (deck.updated === at) { unsaved = false; setStatus('保存済み'); }
  } catch (e) {
    console.warn(e);
    setStatus('保存できませんでした');
  }
}

function touch() {
  deck.updated = Date.now();
  unsaved = true;
  setStatus('保存中…');
  clearTimeout(saveT);
  // ネット越しに保存するときは、送る回数を減らすため少し長めに待つ
  saveT = setTimeout(save, remote ? 1200 : 400);
}

function commit() {
  undoStack.push(last);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  last = snap();
  touch();
  updateThumb();
  syncBar();
}

function restore(s) {
  const o = JSON.parse(s);
  deck.slides = o.slides;
  cur = clamp(o.cur, 0, deck.slides.length - 1);
  selId = null;
  last = s;
  touch();
  renderAll();
}

function undo() { endEdit(); if (!undoStack.length) return; redoStack.push(last); restore(undoStack.pop()); }
function redo() { endEdit(); if (!redoStack.length) return; undoStack.push(last); restore(redoStack.pop()); }

/* ---------- 描画 ---------- */
function renderStage() {
  fillStage(stage, slide());
  $('#bg').value = hex6(slide().bg, '#ffffff');
  updateSel();
}

function renderPanel() {
  thumbs.replaceChildren(...deck.slides.map((s, i) => {
    const it = document.createElement('div');
    it.className = 'thumb-item' + (i === cur ? ' cur' : '');
    it.draggable = true;
    it.dataset.i = i;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = i + 1;
    it.append(n, makeThumb(s));
    return it;
  }));
}

function updateThumb() {
  const it = thumbs.children[cur];
  if (it) fillStage(it.querySelector('.stage'), slide());
}

function renderAll() { renderPanel(); renderStage(); }

function go(i) {
  endEdit();
  cur = clamp(i, 0, deck.slides.length - 1);
  selId = null;
  [...thumbs.children].forEach((c, k) => c.classList.toggle('cur', k === cur));
  thumbs.children[cur]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderStage();
}

function fit() {
  const w = $('#work');
  const pad = w.clientWidth < 600 ? 12 : 32;
  scale = Math.max(0.1, Math.min((w.clientWidth - pad * 2) / SW, (w.clientHeight - pad * 2) / SH));
  const wrap = $('#stageWrap');
  wrap.style.width = SW * scale + 'px';
  wrap.style.height = SH * scale + 'px';
  wrap.style.setProperty('--s', scale);
  wrap.style.setProperty('--inv', 1 / scale);
}

function updateSelBox() {
  const n = selId && nodeOf(selId);
  selbox.hidden = !n;
  if (!n) return;
  selbox.style.left = n.offsetLeft + 'px';
  selbox.style.top = n.offsetTop + 'px';
  selbox.style.width = n.offsetWidth + 'px';
  selbox.style.height = n.offsetHeight + 'px';
  selbox.classList.toggle('editing', editing === selId);
}

function updateSel() { updateSelBox(); syncBar(); }

const hex6 = (v, fb) => /^#[0-9a-fA-F]{6}$/.test(v || '') ? v : fb;

/* ツールバーの表示を選択中の部品に合わせる */
function syncBar() {
  const el = selEl();
  tools.dataset.ctx = el ? el.type : 'none';
  $('[data-act="undo"]').disabled = !undoStack.length;
  $('[data-act="redo"]').disabled = !redoStack.length;
  if (!el) return;
  if (el.type === 'text') {
    // 入力中は、カーソルのある場所（選んでいる文字）の書式を表示する
    const cs = editing ? getComputedStyle(selStyleNode()) : null;
    $('#fontName').textContent = fontLabel(firstFamily(cs ? cs.fontFamily : el.font));
    if (document.activeElement !== $('#size')) $('#size').value = cs ? Math.round(parseFloat(cs.fontSize)) : el.size;
    const align = cs ? ({ center: 'center', right: 'right', end: 'right' }[cs.textAlign] || 'left') : (el.align || 'left');
    $('#color').value = hex6(el.color, '#1d1d1b');
    $('#lh').value = String(el.lh || 1.4);
    const cmd = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' };
    $$('[data-fmt]').forEach(b => {
      const k = b.dataset.fmt;
      let on = !!el[k];
      if (editing) { try { on = document.queryCommandState(cmd[k]); } catch (e) { /* 対応していない環境 */ } }
      b.classList.toggle('on', on);
    });
    $$('[data-align]').forEach(b => b.classList.toggle('on', align === b.dataset.align));
    $$('[data-va]').forEach(b => b.classList.toggle('on', (el.va || 'top') === b.dataset.va));
    $('[data-act="list"]').disabled = !editing;
  } else if (el.type === 'shape') {
    $('#fill').value = hex6(el.fill, '#ffffff');
    $('#stroke').value = hex6(el.stroke, '#1d1d1b');
    if (document.activeElement !== $('#sw')) $('#sw').value = String(el.sw || 0);
    $('#radius').value = String(el.radius || 0);
    $('#radius').disabled = el.shape === 'ellipse';
  }
}

/* ---------- 文字の入力 ---------- */
function startEdit(id, selectAll) {
  if (editing === id) return;
  endEdit();
  const n = nodeOf(id);
  if (!n) return;
  selId = id;
  editing = id;
  editDirty = false;
  n.classList.add('editing');
  const t = n.firstChild;
  t.contentEditable = 'true';
  t.focus();
  const r = document.createRange();
  r.selectNodeContents(t);
  if (!selectAll) r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  updateSel();
}

function endEdit() {
  if (!editing) return;
  const id = editing;
  const el = slide().els.find(e => e.id === id);
  const n = nodeOf(id);
  editing = null;
  savedRange = null;
  if (el && n) {
    const t = n.firstChild;
    t.contentEditable = 'false';
    n.classList.remove('editing');
    const html = sanitize(t.innerHTML);
    if (!t.textContent.trim()) {
      // 空になったテキストは片付ける
      slide().els = slide().els.filter(e => e !== el);
      selId = null;
      commit();
      renderStage();
    } else if (html !== el.html || editDirty) {
      el.html = html;
      commit();
    }
  }
  getSelection().removeAllRanges();
  updateSel();
}

document.addEventListener('selectionchange', () => {
  if (!editing) return;
  const s = getSelection();
  const t = nodeOf(editing)?.firstChild;
  if (s.rangeCount && t && t.contains(s.anchorNode)) {
    savedRange = s.getRangeAt(0).cloneRange();
    syncBar();
  }
});

stage.addEventListener('input', () => { if (editing) { editDirty = true; updateSelBox(); } });

// 貼り付けは文字だけにする（よそのページの装飾を持ち込まない）
stage.addEventListener('paste', e => {
  if (!editing) return;
  e.preventDefault();
  e.stopPropagation();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});

/* 入力中の選択範囲に対して操作する */
function withSel(fn) {
  const t = nodeOf(editing).firstChild;
  t.focus();
  if (savedRange) {
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(savedRange);
  }
  fn(t);
  // 操作で文書が書き換わるので、控えを取り直す
  const now = getSelection();
  if (now.rangeCount && t.contains(now.anchorNode)) savedRange = now.getRangeAt(0).cloneRange();
  editDirty = true;
  updateSelBox();
}

const hasRange = () => editing && savedRange && !savedRange.collapsed;

/* 選択範囲の先頭の文字が入っている要素（ツールバーに今の書式を出すために使う） */
function selStyleNode() {
  const t = nodeOf(editing).firstChild;
  if (!savedRange) return t;
  let n = savedRange.startContainer;
  const o = savedRange.startOffset;
  if (n.nodeType === 1) {
    n = n.childNodes[o] || n;
  } else if (!savedRange.collapsed && o === n.length) {
    // 範囲が文字の切れ目から始まっているときは、次の文字を見る
    const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    w.currentNode = n;
    n = w.nextNode() || n;
  }
  while (n && n.nodeType !== 1) n = n.parentNode;
  return n && t.contains(n) ? n : t;
}

const FONT_ATTR = { 'font-family': 'face', 'color': 'color', 'font-size': 'size' };

function stripProp(root, prop) {
  root.querySelectorAll('*').forEach(c => {
    c.style.removeProperty(prop);
    if (c.tagName === 'FONT' && FONT_ATTR[prop]) c.removeAttribute(FONT_ATTR[prop]);
  });
}

function stripHtml(html, prop) {
  const t = document.createElement('template');
  t.innerHTML = html;
  stripProp(t.content, prop);
  return t.innerHTML;
}

/* 選択範囲だけに書式をかける。いったん目印のフォント名で囲み、span に置き換える */
function wrapSel(t, prop, val) {
  // 目印は変えたい性質と同じ種類の命令で付ける（ほかの書式を巻き添えで消さないため）
  const [cmd, arg, q] = {
    'font-family': ['fontName', 'zzmark', 'font[face="zzmark"]'],
    'font-size': ['fontSize', '7', 'font[size="7"]'],
    'color': ['foreColor', '#010203', 'font[color="#010203"]'],
  }[prop];
  document.execCommand('styleWithCSS', false, false);
  document.execCommand(cmd, false, arg);
  const made = [];
  t.querySelectorAll(q).forEach(f => {
    let s = document.createElement('span');
    const keep = { face: 'font-family', color: 'color' };
    for (const a in keep) if (keep[a] !== prop && f.getAttribute(a)) s.style.setProperty(keep[a], f.getAttribute(a));
    stripProp(f, prop);
    s.append(...f.childNodes);
    f.replaceWith(s);
    const p = s.parentElement;
    if (p !== t && p.tagName === 'SPAN' && p.childNodes.length === 1) {
      // 同じ範囲を囲み直したときに入れ子が増えないようにする
      s.replaceWith(...s.childNodes);
      s = p;
    }
    s.style.setProperty(prop, val);
    made.push(s);
  });
  if (made.length) {
    const r = document.createRange();
    r.setStartBefore(made[0]);
    r.setEndAfter(made[made.length - 1]);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    savedRange = r.cloneRange();
  }
}

const CSS_PROP = { font: 'font-family', size: 'font-size', color: 'color' };
const cssVal = (k, v) => k === 'size' ? v + 'px' : v;

/* フォント・サイズ・色。範囲を選んでいればそこだけ、そうでなければ箱全体 */
function setText(key, val, live) {
  const el = selEl();
  if (!el || el.type !== 'text') return;
  const prop = CSS_PROP[key];
  if (hasRange()) {
    withSel(t => wrapSel(t, prop, cssVal(key, val)));
  } else {
    el[key] = val;
    if (editing) {
      const t = nodeOf(el.id).firstChild;
      stripProp(t, prop);
      applyTextStyle(t, el);
      editDirty = true;
      updateSelBox();
    } else {
      el.html = stripHtml(el.html, prop);
      if (!live) commit();
      renderStage();
    }
  }
  syncBar();
}

function toggleFmt(k) {
  const el = selEl();
  if (!el || el.type !== 'text') return;
  const cmd = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' }[k];
  if (editing) {
    withSel(() => { document.execCommand('styleWithCSS', false, true); document.execCommand(cmd); });
    syncBar();
  } else {
    el[k] = !el[k];
    commit();
    renderStage();
  }
}

/* 左右の揃え。入力中は選んでいる行だけ、そうでなければ箱全体 */
function setAlign(a) {
  const el = selEl();
  if (!el || el.type !== 'text') return;
  if (editing) {
    withSel(t => alignLines(t, a));
    syncBar();
  } else {
    el.align = a;
    el.html = stripHtml(el.html, 'text-align');
    commit();
    renderStage();
  }
}

/* 選択範囲にかかっている行を、行ごとの div にして揃えを付ける */
function alignLines(t, a) {
  const r = savedRange;
  const pos = r && { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
  const isBlock = n => n.nodeType === 1 && /^(DIV|P|UL|OL)$/.test(n.tagName);
  // まず、箱の直下にある裸の文字列を <br> 区切りで行（div）にまとめる
  let line = null;
  [...t.childNodes].forEach(n => {
    if (isBlock(n)) { line = null; return; }
    if (!line) { line = document.createElement('div'); t.insertBefore(line, n); }
    if (n.nodeName === 'BR') { if (!line.firstChild) line.append(n); else n.remove(); line = null; }
    else line.append(n);
  });
  // 行にまとめる間に選択が外れるので、元の位置に戻す
  const range = document.createRange();
  try {
    if (!pos || pos.sc === t || pos.ec === t || !t.contains(pos.sc) || !t.contains(pos.ec)) throw new Error('whole');
    range.setStart(pos.sc, pos.so);
    range.setEnd(pos.ec, pos.eo);
  } catch (e) {
    range.selectNodeContents(t);
    if (pos && pos.sc === pos.ec && pos.so === pos.eo && !t.textContent) range.collapse(true);
  }
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const blocks = [...t.children].filter(b => range.intersectsNode(b));
  (blocks.length ? blocks : [...t.children]).forEach(b => {
    stripProp(b, 'text-align');
    b.style.textAlign = a;
  });
}

/* 箱全体にかかる設定（行間・上下の位置など） */
function setBox(key, val, live) {
  const el = selEl();
  if (!el) return;
  el[key] = val;
  if (editing) {
    const n = nodeOf(el.id);
    applyTextStyle(n.firstChild, el);
    n.style.justifyContent = { middle: 'center', bottom: 'flex-end' }[el.va] || 'flex-start';
    editDirty = true;
    updateSel();
  } else {
    if (!live) commit();
    renderStage();
  }
}

/* ---------- 部品の追加・整理 ---------- */
function addEl(el) {
  endEdit();
  slide().els.push(el);
  selId = el.id;
  commit();
  renderStage();
}

function addText() {
  // 背景に埋もれない色で置く
  const ink = hex6(theme.ink, '#1d1d1b');
  const color = isDark(slide().bg) ? (isDark(ink) ? '#ffffff' : ink) : (isDark(ink) ? ink : '#1d1d1b');
  const el = tx(440, 320, 400, 60, 'テキスト', { font: theme.body, color, size: 32 });
  addEl(el);
  startEdit(el.id, true);
}

function isDark(c) {
  if (!/^#[0-9a-fA-F]{6}$/.test(c || '')) return false;
  const n = parseInt(c.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 110;
}

function addShape(kind) {
  const fill = theme.accent;
  const ink = isDark(slide().bg) ? '#ffffff' : '#1d1d1b';
  const m = {
    rect: box(520, 280, 240, 160, fill),
    round: box(520, 280, 240, 160, fill, { radius: 24 }),
    ellipse: box(540, 260, 200, 200, fill, { shape: 'ellipse' }),
    line: box(440, 358, 400, 4, ink),
  };
  addEl(m[kind]);
}

function addImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    // 保存容量を食いすぎないよう、長辺 1600px までに縮める
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const src = file.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.88) : c.toDataURL('image/png');
    URL.revokeObjectURL(url);
    const f = Math.min(640 / c.width, 480 / c.height, 1);
    const w = Math.round(c.width * f), h = Math.round(c.height * f);
    addEl({ id: uid(), type: 'image', x: Math.round((SW - w) / 2), y: Math.round((SH - h) / 2), w, h, src });
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('この画像は読み込めませんでした'); };
  img.src = url;
}

function delSel() {
  const el = selEl();
  if (!el) return;
  endEdit();
  slide().els = slide().els.filter(e => e.id !== el.id);
  selId = null;
  commit();
  renderStage();
}

function dupSel() {
  const el = selEl();
  if (!el) return;
  endEdit();
  pasteEl(el);
}

function pasteEl(src) {
  const c = { ...JSON.parse(JSON.stringify(src)), id: uid() };
  c.x = clamp(c.x + 24, -c.w + 20, SW - 20);
  c.y = clamp(c.y + 24, -c.h + 20, SH - 20);
  addEl(c);
}

function order(toFront) {
  const el = selEl();
  if (!el) return;
  endEdit();
  const a = slide().els.filter(e => e !== el);
  toFront ? a.push(el) : a.unshift(el);
  slide().els = a;
  commit();
  renderStage();
}

/* ---------- スライドの追加・並べ替え ---------- */
function structural(fn) {
  endEdit();
  fn();
  selId = null;
  commit();
  renderAll();
  thumbs.children[cur]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const addSlide = kind => structural(() => { deck.slides.splice(cur + 1, 0, buildSlide(theme, kind)); cur++; });

const dupSlide = () => structural(() => {
  const c = JSON.parse(JSON.stringify(slide()));
  c.id = uid();
  c.els.forEach(e => { e.id = uid(); });
  deck.slides.splice(cur + 1, 0, c);
  cur++;
});

function delSlide() {
  if (deck.slides.length === 1) {
    structural(() => { deck.slides = [{ id: uid(), bg: theme.bg, els: [] }]; cur = 0; });
    return;
  }
  structural(() => { deck.slides.splice(cur, 1); cur = Math.min(cur, deck.slides.length - 1); });
}

function moveSlide(from, to) {
  to = clamp(to, 0, deck.slides.length - 1);
  if (from === to) return;
  structural(() => { deck.slides.splice(to, 0, deck.slides.splice(from, 1)[0]); cur = to; });
}

/* ---------- マウス・タッチ操作 ---------- */
function startDrag(ev, mode, dir) {
  const el = selEl(), n = nodeOf(selId);
  const s0 = { x: el.x, y: el.y, w: el.w, h: el.type === 'text' ? n.offsetHeight : el.h };
  const p0 = { x: ev.clientX, y: ev.clientY };
  const ratio = s0.w / s0.h;
  let moved = false;
  const gV = $('#guideV'), gH = $('#guideH');

  const move = e => {
    const dx = (e.clientX - p0.x) / scale, dy = (e.clientY - p0.y) / scale;
    if (!moved && Math.hypot(e.clientX - p0.x, e.clientY - p0.y) < 3) return;
    moved = true;
    let { x, y, w, h } = s0;
    if (mode === 'move') {
      x += dx; y += dy;
      // スライドの中央に近づいたら吸いつける
      const sx = Math.abs(x + w / 2 - SW / 2) < 6, sy = Math.abs(y + h / 2 - SH / 2) < 6;
      if (sx) x = (SW - w) / 2;
      if (sy) y = (SH - h) / 2;
      gV.hidden = !sx; gH.hidden = !sy;
    } else {
      const min = 8;
      if (dir.includes('e')) w = Math.max(min, s0.w + dx);
      if (dir.includes('w')) { w = Math.max(min, s0.w - dx); x = s0.x + s0.w - w; }
      if (dir.includes('s')) h = Math.max(el.type === 'shape' ? 1 : min, s0.h + dy);
      if (dir.includes('n')) { h = Math.max(el.type === 'shape' ? 1 : min, s0.h - dy); y = s0.y + s0.h - h; }
      if (el.type === 'image' && dir.length === 2) {
        h = w / ratio;
        if (dir.includes('n')) y = s0.y + s0.h - h;
      }
    }
    el.x = Math.round(x); el.y = Math.round(y); el.w = Math.round(w);
    if (mode !== 'move') el.h = Math.round(h);
    n.style.left = el.x + 'px'; n.style.top = el.y + 'px'; n.style.width = el.w + 'px';
    if (mode !== 'move') n.style[el.type === 'text' ? 'minHeight' : 'height'] = el.h + 'px';
    updateSelBox();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    gV.hidden = gH.hidden = true;
    if (moved) commit();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

stage.addEventListener('pointerdown', e => {
  if (e.button > 0) return;
  const n = e.target.closest('.el');
  if (n && editing === n.dataset.id) return;   // 入力中の箱の中は普通のカーソル操作
  endEdit();
  if (!n) { selId = null; updateSel(); return; }
  e.preventDefault();
  document.activeElement?.blur();
  selId = n.dataset.id;
  updateSel();
  startDrag(e, 'move');
});

stage.addEventListener('dblclick', e => {
  const n = e.target.closest('.el.text');
  if (n) startEdit(n.dataset.id, false);
});

selbox.addEventListener('pointerdown', e => {
  const h = e.target.dataset.h;
  if (!h || !selEl()) return;
  e.preventDefault();
  e.stopPropagation();
  endEdit();
  startDrag(e, 'resize', h);
});

$('#work').addEventListener('pointerdown', e => {
  if (e.target.id === 'work' || e.target.id === 'stageWrap') { endEdit(); selId = null; updateSel(); }
});

// 画像のドラッグ＆ドロップ
$('#work').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
$('#work').addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  addImageFile(e.dataTransfer.files[0]);
});

/* ページ一覧 */
let panelFocus = false;   // ページ一覧を操作中か（Delete / Backspace でスライドを消せる）
function setPanelFocus(on) {
  panelFocus = on;
  document.body.classList.toggle('panel-focus', on);
}
thumbs.addEventListener('click', e => {
  const it = e.target.closest('.thumb-item');
  if (!it) return;
  go(+it.dataset.i);
  document.activeElement?.blur();
  setPanelFocus(true);
});
// 一覧の外を触ったら、一覧の操作はおしまい
document.addEventListener('pointerdown', e => { if (!e.target.closest('#panel')) setPanelFocus(false); }, true);
let dragFrom = null;
thumbs.addEventListener('dragstart', e => {
  const it = e.target.closest('.thumb-item');
  if (!it) return;
  dragFrom = +it.dataset.i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
});
thumbs.addEventListener('dragover', e => {
  if (dragFrom == null) return;
  e.preventDefault();
  $$('.thumb-item.over').forEach(x => x.classList.remove('over'));
  e.target.closest('.thumb-item')?.classList.add('over');
});
thumbs.addEventListener('drop', e => {
  e.preventDefault();
  const it = e.target.closest('.thumb-item');
  if (it && dragFrom != null) moveSlide(dragFrom, +it.dataset.i);
  dragFrom = null;
});
thumbs.addEventListener('dragend', () => { dragFrom = null; $$('.thumb-item.over').forEach(x => x.classList.remove('over')); });

/* ---------- ツールバー ---------- */
const ACTIONS = {
  undo, redo, addText,
  addImage: () => $('#imgFile').click(),
  sizeDown: () => stepSize(-2),
  sizeUp: () => stepSize(2),
  list: () => { if (editing) { withSel(() => document.execCommand('insertUnorderedList')); } },
  noFill: () => { const el = selEl(); if (el?.type === 'shape') { el.fill = 'transparent'; if (!el.sw) el.sw = 2; commit(); renderStage(); } },
  front: () => order(true),
  back: () => order(false),
  dup: dupSel,
  del: delSel,
  slideDup: dupSlide,
  slideDel: delSlide,
  slidePrev: () => moveSlide(cur, cur - 1),
  slideNext: () => moveSlide(cur, cur + 1),
  present: () => present(),
  print: printDeck,
  exportJson: () => { endEdit(); download(fileName(deck.title) + '.json', new Blob([JSON.stringify(deck)], { type: 'application/json' })); },
};

function stepSize(d) {
  const el = selEl();
  if (el?.type === 'text') setText('size', clamp((+$('#size').value || el.size) + d, 6, 400));
}

// ボタンを押しても入力中の選択が外れないようにする
document.addEventListener('mousedown', e => {
  if (e.target.closest('button') && e.target.closest('.bar, .pop, #panel')) e.preventDefault();
});

document.addEventListener('click', e => {
  const b = e.target.closest('button');
  const popBtn = e.target.closest('[data-pop]');
  if (!e.target.closest('.pop') || (b && b.classList.contains('item'))) closePops(popBtn?.dataset.pop);
  if (popBtn) { togglePop(popBtn); return; }
  if (!b) return;
  if (b.dataset.act) ACTIONS[b.dataset.act]?.();
  else if (b.dataset.fmt) toggleFmt(b.dataset.fmt);
  else if (b.dataset.align) setAlign(b.dataset.align);
  else if (b.dataset.va) setBox('va', b.dataset.va);
  else if (b.dataset.shape) addShape(b.dataset.shape);
  else if (b.dataset.layout) addSlide(b.dataset.layout);
  else if (b.dataset.font) pickFont(b.dataset.font);
});

function closePops(except) { $$('.pop.open').forEach(p => { if (p.id !== except) p.classList.remove('open'); }); }

function togglePop(btn) {
  const p = document.getElementById(btn.dataset.pop);
  if (p.classList.toggle('open')) {
    if (p.id === 'popFont') { $('#fontQ').value = ''; renderFontList(); }
    const r = btn.getBoundingClientRect();
    p.style.left = clamp(r.left, 8, innerWidth - p.offsetWidth - 8) + 'px';
    const below = r.bottom + 4;
    p.style.top = (below + p.offsetHeight > innerHeight ? Math.max(8, r.top - p.offsetHeight - 4) : below) + 'px';
  }
}

/* ---------- フォントの選択 ----------
 * ふだんは日本語フォントと、自分で追加・選択したフォントだけを並べる。
 * それ以外の Google フォントは検索して選ぶと、次からは一覧に並ぶ。 */
const SYSTEM_FONTS = [['Arial', F.arial], ['Times New Roman', F.times], ['Georgia', F.georgia]];
const JA_FONTS = (() => {
  const list = FONTS.slice(0, 9).map(([label, css]) => ({ label, css, name: firstFamily(css), ja: true }));
  const have = new Set(list.map(f => f.name));
  GF.forEach((g, name) => { if (g.ja && !have.has(name)) list.push({ label: name, css: fontCss(name), name, ja: true }); });
  return list;
})();
const JA_NAMES = new Set(JA_FONTS.map(f => f.name));
const ALL_FONTS = (() => {
  const list = [...JA_FONTS];
  const have = new Set(JA_NAMES);
  [...FONTS.slice(9), ...SYSTEM_FONTS].forEach(([label, css]) => {
    const name = firstFamily(css);
    if (!have.has(name)) { have.add(name); list.push({ label, css, name }); }
  });
  GF.forEach((g, name) => { if (!have.has(name)) list.push({ label: name, css: fontCss(name), name }); });
  return list;
})();
const fontByName = new Map(ALL_FONTS.map(f => [f.name, f]));
const fontLabel = name => fontByName.get(name)?.label || name;

/* 以前はブラウザに覚えていた「選んだフォント」を、追加したフォントと同じ場所（アカウントにも保存される）へ移す */
async function migratePicked() {
  let old = [];
  try { old = JSON.parse(localStorage.getItem('slides.pickedFonts') || '[]'); localStorage.removeItem('slides.pickedFonts'); } catch (e) { return; }
  for (const n of Array.isArray(old) ? old : []) {
    const name = cleanFontName(n);
    if (name && !JA_NAMES.has(name) && !customFonts.some(c => c.name === name)) {
      (await addCustomFont({ name, kind: 'pick' })).saved.catch(() => {});
    }
  }
}

/* このスライドで使っているフォントの名前 */
function usedFonts() {
  const set = new Set();
  deck.slides.forEach(sl => sl.els.forEach(e => {
    if (e.type !== 'text') return;
    set.add(firstFamily(e.font));
    for (const m of String(e.html || '').replace(/&quot;/g, "'").matchAll(/font-family:\s*([^;"]+)/g)) set.add(firstFamily(m[1]));
  }));
  set.delete('');
  return set;
}

/* 一覧の項目を、その書体で表示する。まだ読み込んでいない Google フォントは、
   名前に使う文字だけの小さなデータを取り寄せる */
const previews = new Map();
const SAMPLE = 'あア永';
function showPreview(btn) {
  const name = btn.dataset.name;
  if (fontLoaded.has(name) || !GF.has(name)) { btn.style.fontFamily = btn.dataset.font; return; }
  let p = previews.get(name);
  if (!p) {
    const g = GF.get(name);
    const url = 'https://fonts.googleapis.com/css?family=' + encodeURIComponent(name).replace(/%20/g, '+') + ':' + g.spec.split(',')[0]
      + '&text=' + encodeURIComponent(name + (g.ja ? SAMPLE : ''));
    p = fetch(url).then(r => r.ok ? r.text() : Promise.reject(new Error(r.status)))
      .then(css => {
        const m = css.match(/url\((https:\/\/[^)]+)\)/);
        if (!m) throw new Error('no font');
        const face = new FontFace('pv ' + name, `url(${m[1]})`);
        document.fonts.add(face);
        return face.load();
      });
    previews.set(name, p);
  }
  p.then(() => { btn.style.fontFamily = `'pv ${name}', sans-serif`; }).catch(() => { /* 名前だけ表示する */ });
}
const previewIO = new IntersectionObserver(list => list.forEach(en => {
  if (!en.isIntersecting) return;
  previewIO.unobserve(en.target);
  showPreview(en.target);
}), { root: $('#fontList'), rootMargin: '80px' });

function renderFontList() {
  const q = $('#fontQ').value.trim().toLowerCase();
  const used = usedFonts();
  const el = selEl();
  const curName = el?.type === 'text' ? firstFamily(editing ? getComputedStyle(selStyleNode()).fontFamily : el.font) : '';
  const custom = customFonts.filter(c => c.kind !== 'pick').map(c => ({ label: c.name, css: fontCss(c.name), name: c.name, custom: true }));
  const picked = customFonts.filter(c => c.kind === 'pick').map(c => c.name);
  const customNames = new Set(custom.map(c => c.name));
  // 日本語フォント以外で、選んだことがある・このスライドで使っているもの
  const extraNames = [...new Set([...picked, ...used])].filter(n => !JA_NAMES.has(n) && !customNames.has(n));
  const extra = extraNames.map(n => ({ ...(fontByName.get(n) || { label: n, css: fontCss(n), name: n }), picked: picked.includes(n) && !used.has(n) }));

  const list = $('#fontList');
  previewIO.disconnect();
  const frag = document.createDocumentFragment();
  const head = text => {
    const h = document.createElement('div');
    h.className = 'pop-label';
    h.textContent = text;
    frag.append(h);
  };
  const row = f => {
    const r = document.createElement('div');
    r.className = 'frow';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item' + (f.name === curName ? ' on' : '');
    b.dataset.font = f.css;
    b.dataset.name = f.name;
    b.textContent = f.label;
    if (GF.get(f.name)?.ja && f.label === f.name) {
      const sm = document.createElement('span');
      sm.className = 'sample';
      sm.textContent = SAMPLE;
      b.append(sm);
    }
    r.append(b);
    previewIO.observe(b);
    if (f.custom || f.picked) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.textContent = '×';
      x.title = f.custom ? 'このフォントを削除' : '一覧から外す';
      x.dataset[f.custom ? 'fontDel' : 'fontUnpick'] = f.name;
      r.append(x);
    }
    frag.append(r);
  };

  if (q) {
    const pool = [...custom, ...ALL_FONTS.filter(f => !customNames.has(f.name))];
    const hits = pool.filter(f => f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q));
    const MAX = 150;
    head(hits.length ? `検索結果（${hits.length} 件${hits.length > MAX ? `・先頭の ${MAX} 件を表示` : ''}）` : '見つかりませんでした');
    hits.slice(0, MAX).forEach(row);
  } else {
    if (custom.length) { head('自分で追加したフォント'); custom.forEach(row); }
    if (extra.length) { head('選んだフォント'); extra.forEach(row); }
    head('日本語フォント');
    JA_FONTS.forEach(row);
  }
  list.replaceChildren(frag);
  list.scrollTop = 0;
}

function pickFont(css) {
  const name = firstFamily(css);
  if (!JA_NAMES.has(name) && !customFonts.some(c => c.name === name)) {
    // 選んだフォントも、次から一覧に並ぶように覚えておく
    addCustomFont({ name, kind: 'pick' }).then(r => r.saved).catch(() => {});
  }
  useFont(css);
  setText('font', css);
}

$('#fontQ').addEventListener('input', renderFontList);
$('#fontQ').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  $('#fontList .item')?.click();   // Enter で先頭の候補を選ぶ
});

$('#fontList').addEventListener('click', async e => {
  const x = e.target.closest('.x');
  if (!x) return;
  const name = x.dataset.fontUnpick || x.dataset.fontDel;
  if (x.dataset.fontDel && !confirm(`「${name}」を追加したフォントから削除します。`)) return;
  try { await removeCustomFont(name); }
  catch (err) { alert('アカウントから削除できませんでした：' + Store.errorText(err)); }
  renderFontList();
});

$('#fontFileBtn').addEventListener('click', () => $('#fontFile').click());
$('#fontFile').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  let lastName = null;
  for (const f of files) {
    const name = cleanFontName(f.name.replace(/\.[^.]+$/, ''));
    try {
      if (!name) throw new Error('name');
      const data = await f.arrayBuffer();
      await new FontFace(name, data.slice(0)).load();   // フォントとして読めるか確かめる
      const { saved } = await addCustomFont({ name, kind: 'file', data });
      lastName = name;
      // アカウントへの保存は大きいと時間がかかるので、待たずに先へ進む
      fontSaving(name, saved);
    } catch (err) {
      alert(`「${f.name}」はフォントとして読み込めませんでした。`);
    }
  }
  if (lastName) { pickFont(fontCss(lastName)); updateThumb(); }
});

/* フォントファイルをアカウントに保存している間の表示と、失敗したときの知らせ */
let fontJobs = 0;
function fontSaving(name, saved) {
  fontJobs++;
  $('#fontStatus').textContent = 'フォントをアカウントに保存中…';
  saved.then(
    r => { if (r === 'saved') flashFontStatus('フォントをアカウントに保存しました'); },
    err => alert(`「${name}」をアカウントに保存できませんでした（このブラウザでは使えます）：` + Store.errorText(err)),
  ).finally(() => { if (--fontJobs === 0 && /保存中/.test($('#fontStatus').textContent)) $('#fontStatus').textContent = ''; });
}
function flashFontStatus(text) {
  $('#fontStatus').textContent = text;
  setTimeout(() => { if ($('#fontStatus').textContent === text) $('#fontStatus').textContent = ''; }, 4000);
}

async function addFontByName() {
  const v = cleanFontName($('#fontNameIn').value);
  if (!v) return;
  $('#fontNameIn').value = '';
  // Google フォントにある名前なら、それを選ぶ
  const known = ALL_FONTS.find(f => f.name.toLowerCase() === v.toLowerCase());
  if (known) { pickFont(known.css); closePops(); return; }
  if (!customFonts.some(c => c.name === v && c.kind !== 'pick')) {
    (await addCustomFont({ name: v, kind: 'name' })).saved.catch(err => console.warn(err));
  }
  pickFont(fontCss(v));
  closePops();
}
$('#fontNameAdd').addEventListener('click', addFontByName);
$('#fontNameIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFontByName(); } });

// フォントが届くと文字の幅が変わるので、枠と縮小表示を合わせ直す
document.fonts.addEventListener('loadingdone', () => { if (deck) { updateSelBox(); } });
$('#size').addEventListener('change', e => {
  const v = clamp(Math.round(+e.target.value) || 28, 6, 400);
  e.target.value = v;
  setText('size', v);
});
$('#lh').addEventListener('change', e => setBox('lh', +e.target.value));

/* 色は動かしている間も反映し、決めたときに履歴へ入れる */
function colorInput(id, onLive, onDone) {
  $(id).addEventListener('input', e => onLive(e.target.value));
  $(id).addEventListener('change', e => onDone(e.target.value));
}
colorInput('#color', v => setText('color', v, true), () => { if (!editing) commit(); });
colorInput('#fill', v => setBox('fill', v, true), () => commit());
colorInput('#stroke', v => { const el = selEl(); if (el && !el.sw) el.sw = 2; setBox('stroke', v, true); }, () => commit());
colorInput('#bg', v => { slide().bg = v; stage.style.background = v; }, () => commit());
const swVal = v => clamp(Math.round(+v) || 0, 0, 200);
$('#sw').addEventListener('input', e => { if (e.target.value !== '') setBox('sw', swVal(e.target.value), true); });
$('#sw').addEventListener('change', e => { e.target.value = swVal(e.target.value); setBox('sw', swVal(e.target.value)); });
$('#radius').addEventListener('change', e => setBox('radius', +e.target.value));

$('#imgFile').addEventListener('change', e => { addImageFile(e.target.files[0]); e.target.value = ''; });

$('#title').addEventListener('input', e => {
  deck.title = e.target.value.trim() || '無題のスライド';
  document.title = deck.title + ' - スライド';
  touch();
});

/* ---------- 設定：ページ一覧の位置 ---------- */
function setPanelPos(pos, remember) {
  document.body.classList.toggle('panel-bottom', pos === 'bottom');
  document.body.classList.toggle('panel-left', pos !== 'bottom');
  $$('input[name="panelPos"]').forEach(r => { r.checked = r.value === pos; });
  $('[data-act="slidePrev"]').textContent = pos === 'bottom' ? '←' : '↑';
  $('[data-act="slideNext"]').textContent = pos === 'bottom' ? '→' : '↓';
  if (remember) { try { localStorage.setItem('slides.panelPos', pos); } catch (e) { /* 保存できなくても動かす */ } }
  fit();
}
$$('input[name="panelPos"]').forEach(r => r.addEventListener('change', () => setPanelPos(r.value, true)));

/* ---------- キーボード ---------- */
document.addEventListener('keydown', e => {
  if (!$('#present').hidden) { presentKey(e); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F5') { e.preventDefault(); present(); return; }
  if (editing) {
    if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
    return;
  }
  if (e.target.closest('input, select, textarea')) return;
  const el = selEl();
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 'd') { e.preventDefault(); dupSel(); }
  else if (mod && k === 'c' && el) { clip = JSON.parse(JSON.stringify(el)); }
  else if (mod && k === 'x' && el) { clip = JSON.parse(JSON.stringify(el)); delSel(); }
  else if (mod && el?.type === 'text' && { b: 'bold', i: 'italic', u: 'underline' }[k]) { e.preventDefault(); toggleFmt({ b: 'bold', i: 'italic', u: 'underline' }[k]); }
  else if (mod) return;
  else if ((e.key === 'Delete' || e.key === 'Backspace') && el) { e.preventDefault(); delSel(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && panelFocus) { e.preventDefault(); delSlide(); }
  else if (e.key === 'Escape') { selId = null; updateSel(); }
  else if (e.key === 'Enter' && el?.type === 'text') { e.preventDefault(); startEdit(el.id, false); }
  else if (e.key.startsWith('Arrow') && el) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') el.x -= d; else if (e.key === 'ArrowRight') el.x += d;
    else if (e.key === 'ArrowUp') el.y -= d; else el.y += d;
    commit();
    renderStage();
  }
  else if (e.key === 'PageDown' || (e.key.startsWith('Arrow') && (e.key === 'ArrowDown' || e.key === 'ArrowRight'))) { e.preventDefault(); go(cur + 1); }
  else if (e.key === 'PageUp' || (e.key.startsWith('Arrow') && (e.key === 'ArrowUp' || e.key === 'ArrowLeft'))) { e.preventDefault(); go(cur - 1); }
});

document.addEventListener('paste', e => {
  if (editing || e.target.closest('input, textarea')) return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); addImageFile(f); }
  else if (clip) { e.preventDefault(); pasteEl(clip); }
});

/* ---------- 発表 ---------- */
let pIdx = 0;

function present() {
  endEdit();
  closePops();
  pIdx = cur;
  $('#present').hidden = false;
  showP();
  $('#present').requestFullscreen?.().catch(() => { /* 全画面にできない環境ではそのまま表示 */ });
}

function showP() {
  const st = $('#pStage');
  fillStage(st, deck.slides[pIdx]);
  const k = Math.min(innerWidth / SW, innerHeight / SH);
  st.style.transform = `scale(${k})`;
  st.style.left = (innerWidth - SW * k) / 2 + 'px';
  st.style.top = (innerHeight - SH * k) / 2 + 'px';
  $('#pCount').textContent = `${pIdx + 1} / ${deck.slides.length}`;
}

function stepP(d) {
  const n = clamp(pIdx + d, 0, deck.slides.length - 1);
  if (n !== pIdx) { pIdx = n; showP(); }
}

function endP() {
  if ($('#present').hidden) return;
  $('#present').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  go(pIdx);
}

function presentKey(e) {
  e.preventDefault();
  if (e.key === 'Escape') endP();
  else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) stepP(1);
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) stepP(-1);
  else if (e.key === 'Home') { pIdx = 0; showP(); }
  else if (e.key === 'End') { pIdx = deck.slides.length - 1; showP(); }
}

$('#present').addEventListener('click', e => {
  if (e.target.id === 'pClose') { endP(); return; }
  stepP(e.clientX < innerWidth / 3 ? -1 : 1);   // 画面の左1/3で戻る
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) endP(); else showP();
});

/* ---------- 印刷（PDF） ---------- */
function printDeck() {
  endEdit();
  $('#printArea').replaceChildren(...deck.slides.map(s => {
    const st = document.createElement('div');
    st.className = 'stage';
    fillStage(st, s);
    return st;
  }));
  print();
}
addEventListener('afterprint', () => $('#printArea').replaceChildren());

/* ---------- はじめる ---------- */
addEventListener('resize', () => { fit(); if (!$('#present').hidden) showP(); });
new ResizeObserver(fit).observe($('#work'));
addEventListener('pagehide', () => { endEdit(); if (deck && unsaved) Store.put(deck).catch(() => {}); });
/* アカウントへの保存が終わっていないうちにページを閉じようとしたら確認する */
addEventListener('beforeunload', e => {
  if (!deck || !remote) return;
  endEdit();
  if (unsaved) { save(); e.preventDefault(); e.returnValue = ''; }
});
/* 一覧へ戻るときは、保存を済ませてから移動する */
document.querySelector('.bar.top a[href="index.html"]').addEventListener('click', async e => {
  if (!deck) return;
  e.preventDefault();
  endEdit();
  if (unsaved) {
    await save();
    if (unsaved && !confirm('保存できていない変更があります。このまま一覧へ戻りますか？')) return;
  }
  unsaved = false;
  location.href = 'index.html';
});
document.addEventListener('visibilitychange', () => { if (document.hidden && deck) { endEdit(); save(); } });

(async function init() {
  const id = new URLSearchParams(location.search).get('id');
  remote = !!(await Store.remote());
  try { deck = id && await Store.get(id); } catch (e) {
    console.warn(e);
    alert('スライドを読み込めませんでした：' + Store.errorText(e));
    deck = null;
  }
  if (!deck) { location.replace('index.html'); return; }
  theme = themeOf(deck.theme);

  await customReady;
  migratePicked();
  // ほかの端末で追加したフォントが届いたら、開いている一覧と表示を更新する
  onFontsChanged = () => {
    if ($('#popFont').classList.contains('open')) renderFontList();
    if (deck) { updateSelBox(); syncBar(); }
  };
  $('#popLayout').append(...LAYOUTS.map(([kind, label]) => {
    const b = document.createElement('button');
    b.className = 'item';
    b.dataset.layout = kind;
    b.textContent = label;
    return b;
  }));

  $('#title').value = deck.title;
  document.title = deck.title + ' - スライド';

  let pos = null;
  try { pos = localStorage.getItem('slides.panelPos'); } catch (e) { /* 既定の位置を使う */ }
  setPanelPos(pos || (innerWidth < 720 ? 'bottom' : 'left'), false);

  last = snap();
  renderAll();
  setStatus('保存済み');
})();
