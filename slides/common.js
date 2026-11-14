/* スライド：ホームとエディタで共有する部分（保存・テンプレート・描画） */
'use strict';

const SW = 1280, SH = 720;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ---------- フォント ---------- */
const F = {
  gothic: "'Zen Kaku Gothic New', 'Hiragino Sans', 'Yu Gothic', sans-serif",
  mincho: "'Shippori Mincho', 'Hiragino Mincho ProN', 'Yu Mincho', serif",
  notoSans: "'Noto Sans JP', sans-serif",
  notoSerif: "'Noto Serif JP', serif",
  maru: "'Zen Maru Gothic', sans-serif",
  rounded: "'M PLUS Rounded 1c', sans-serif",
  klee: "'Klee One', cursive",
  yusei: "'Yusei Magic', sans-serif",
  dela: "'Dela Gothic One', sans-serif",
  roboto: "'Roboto', sans-serif",
  playfair: "'Playfair Display', serif",
  courier: "'Courier Prime', monospace",
  arial: "Arial, Helvetica, sans-serif",
  times: "'Times New Roman', Times, serif",
  georgia: "Georgia, serif",
};

const FONTS = [
  ['Zen 角ゴシック', F.gothic],
  ['しっぽり明朝', F.mincho],
  ['Noto Sans JP', F.notoSans],
  ['Noto Serif JP', F.notoSerif],
  ['Zen 丸ゴシック', F.maru],
  ['M PLUS Rounded 1c', F.rounded],
  ['クレー（手書き風）', F.klee],
  ['油性マジック', F.yusei],
  ['デラゴシック', F.dela],
  ['Roboto', F.roboto],
  ['Playfair Display', F.playfair],
  ['Courier Prime', F.courier],
  ['Arial', F.arial],
  ['Times New Roman', F.times],
  ['Georgia', F.georgia],
];

/* ---------- フォントの読み込み ----------
 * Google フォントは一覧（gfonts.js）だけ持っておき、使われたときに初めて読み込む。
 * 自分で追加したフォントは、このブラウザ（IndexedDB）に保存する。 */
const GF = new Map();
(typeof GFONTS === 'string' ? GFONTS : '').split(';').forEach(row => {
  const [name, f, spec] = row.split('|');
  if (name) GF.set(name, { cat: f[0], ja: f[1] === '1', spec });
});
const GF_CAT = { s: 'sans-serif', e: 'serif', m: 'monospace', h: 'cursive', d: 'sans-serif' };

const firstFamily = css => String(css || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
const fontCss = name => `'${name}', ${GF.has(name) ? GF_CAT[GF.get(name).cat] : 'sans-serif'}`;
const cleanFontName = s => String(s || '').replace(/[^\p{L}\p{N} \-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

// ページの <link> で最初から読み込んでいるもの
const fontLoaded = new Set(['Courier Prime', 'Dela Gothic One', 'Klee One', 'M PLUS Rounded 1c', 'Noto Sans JP',
  'Noto Serif JP', 'Playfair Display', 'Roboto', 'Shippori Mincho', 'Yusei Magic', 'Zen Kaku Gothic New', 'Zen Maru Gothic']);

/* そのフォントがまだ読み込まれていなければ読み込む */
function useFont(css) {
  const name = firstFamily(css);
  if (!name || fontLoaded.has(name)) return;
  fontLoaded.add(name);
  const g = GF.get(name);
  if (!g) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css?family=' + encodeURIComponent(name).replace(/%20/g, '+') + ':' + g.spec + '&display=swap';
  document.head.append(l);
}

const FontStore = {
  open() {
    return this._p || (this._p = new Promise((res, rej) => {
      const r = indexedDB.open('slides-fonts', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fonts', { keyPath: 'name' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('fonts', mode);
      const rq = fn(t.objectStore('fonts'));
      t.oncomplete = () => res(rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  },
  all() { return this.run('readonly', s => s.getAll()); },
  put(f) { return this.run('readwrite', s => s.put(f)); },
  del(name) { return this.run('readwrite', s => s.delete(name)); },
};

/* 自分で追加したフォント：{ name, kind: 'file'（ファイル）| 'name'（端末にあるフォントの名前） } */
const customFonts = [];
const customFaces = new Map();

function registerCustom(f) {
  if (!customFonts.some(c => c.name === f.name)) customFonts.push({ name: f.name, kind: f.kind });
  if (f.kind !== 'file') return;
  fontLoaded.add(f.name);
  const face = new FontFace(f.name, f.data);
  customFaces.set(f.name, face);
  document.fonts.add(face);
  face.load().catch(() => { /* 壊れたファイルは既定の書体で表示される */ });
}

const customReady = FontStore.all()
  .then(list => list.sort((a, b) => (a.added || 0) - (b.added || 0)).forEach(registerCustom))
  .catch(() => { /* 保存領域が使えなくても他は動かす */ });

async function addCustomFont(f) {
  await FontStore.put({ ...f, added: Date.now() });
  registerCustom(f);
}

async function removeCustomFont(name) {
  await FontStore.del(name);
  const i = customFonts.findIndex(c => c.name === name);
  if (i >= 0) customFonts.splice(i, 1);
  const face = customFaces.get(name);
  if (face) { document.fonts.delete(face); customFaces.delete(name); fontLoaded.delete(name); }
}

/* ---------- 保存（IndexedDB） ---------- */
const DB = {
  open() {
    return this._p || (this._p = new Promise((res, rej) => {
      const r = indexedDB.open('slides-tool', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('decks', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('decks', mode);
      const rq = fn(t.objectStore('decks'));
      t.oncomplete = () => res(rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  },
  all() { return this.run('readonly', s => s.getAll()); },
  get(id) { return this.run('readonly', s => s.get(id)); },
  put(d) { return this.run('readwrite', s => s.put(d)); },
  del(id) { return this.run('readwrite', s => s.delete(id)); },
};

/* ---------- 保存先の切り替え ----------
 * Tools のアカウントでログインしていれば Vercel（/api/decks）に、
 * ログインしていなければ、これまでどおりこのブラウザ（IndexedDB）に保存する。 */
const Store = {
  ready() {
    return this._ready || (this._ready = import('../shared/account.js')
      .then(async account => ({ account, user: await account.waitForUser() }))
      .catch(e => {
        console.warn('アカウント機能を読み込めませんでした', e);
        return { account: null, user: null };
      }));
  },
  async remote() {
    const r = await this.ready();
    return r.user ? r.account : null;
  },
  /** 一覧：{ id, title, created, updated, count, first } */
  async list() {
    const a = await this.remote();
    if (a) return a.decks.list();
    return (await DB.all()).map(d => ({
      id: d.id, title: d.title, created: d.created, updated: d.updated,
      count: d.slides.length, first: d.slides[0],
    }));
  },
  async get(id) {
    const a = await this.remote();
    return a ? a.decks.get(id) : DB.get(id);
  },
  /* 保存は呼ばれた時点の内容を控えて、順番に送る。
     送る順番が来たときに、より新しい内容が控えられていれば古い方は飛ばす。 */
  put(deck) {
    const id = deck.id;
    const json = JSON.stringify(deck);
    this._latest = this._latest || {};
    this._latest[id] = json;
    const run = async () => {
      if (this._latest[id] !== json) return; // 後の保存がもっと新しい内容を送る
      const a = await this.remote();
      if (a) await a.decks.put(JSON.parse(json));
      else await DB.put(JSON.parse(json));
    };
    return (this._chain = (this._chain || Promise.resolve()).catch(() => {}).then(run));
  },
  async del(id) {
    const a = await this.remote();
    return a ? a.decks.remove(id) : DB.del(id);
  },
  errorText(e) {
    return e && e.message ? e.message : String(e);
  },
};

/* ---------- 部品 ---------- */
const tx = (x, y, w, h, html, o = {}) => ({
  id: uid(), type: 'text', x, y, w, h, html,
  font: F.gothic, size: 28, color: '#1d1d1b', align: 'left', va: 'top', lh: 1.4, ...o,
});
const box = (x, y, w, h, fill, o = {}) => ({
  id: uid(), type: 'shape', shape: 'rect', x, y, w, h, fill,
  stroke: '#1d1d1b', sw: 0, radius: 0, ...o,
});

/* ---------- テンプレート ---------- */
/* title(t, a, b): 表紙の部品。frame(t, kind): 表紙以外で毎ページ入る飾り。hx/hy: 見出しの位置 */
const THEMES = [
  {
    id: 'simple', name: 'シンプル', note: '飾りなし',
    bg: '#ffffff', ink: '#1d1d1b', sub: '#6e6c67', accent: '#1d1d1b',
    head: F.gothic, body: F.gothic, hx: 80, hy: 60,
    title: (t, a, b) => [
      tx(140, 240, 1000, 110, a, { font: t.head, size: 64, bold: true, align: 'center', va: 'middle', color: t.ink }),
      tx(140, 380, 1000, 50, b, { font: t.body, size: 26, align: 'center', color: t.sub }),
    ],
    frame: () => [],
  },
  {
    id: 'sumi', name: '墨と朱', note: '明朝・白地',
    bg: '#ffffff', ink: '#1d1d1b', sub: '#6e6c67', accent: '#c8462c',
    head: F.mincho, body: F.gothic, hx: 80, hy: 56,
    title: (t, a, b) => [
      box(110, 210, 56, 6, t.accent),
      tx(110, 240, 1060, 170, a, { font: t.head, size: 68, bold: true, color: t.ink, lh: 1.25 }),
      tx(110, 430, 1060, 50, b, { font: t.body, size: 26, color: t.sub }),
      box(110, 640, 1060, 1, t.ink),
    ],
    frame: t => [box(80, 132, 1120, 1, t.ink)],
  },
  {
    id: 'shinbun', name: '紙面', note: '新聞ふう・罫線',
    bg: '#f4f1ea', ink: '#141414', sub: '#55524c', accent: '#141414',
    head: F.notoSerif, body: F.notoSerif, hx: 80, hy: 72,
    title: (t, a, b) => [
      box(80, 70, 1120, 8, t.ink),
      box(80, 86, 1120, 2, t.ink),
      tx(80, 150, 1120, 220, a, { font: t.head, size: 76, bold: true, color: t.ink, lh: 1.2 }),
      box(80, 560, 1120, 1, t.ink),
      tx(80, 580, 1120, 50, b, { font: t.body, size: 24, color: t.sub }),
    ],
    frame: t => [box(80, 50, 1120, 6, t.ink), box(80, 150, 1120, 1, t.ink)],
  },
  {
    id: 'kokuban', name: '黒板', note: '手書き風・深緑',
    bg: '#2c4a3e', ink: '#f4f0e4', sub: '#c9d3c8', accent: '#f0d77b',
    head: F.klee, body: F.klee, hx: 90, hy: 60,
    title: (t, a, b) => [
      tx(140, 210, 1000, 150, a, { font: t.head, size: 70, bold: true, align: 'center', va: 'middle', color: t.ink }),
      box(460, 380, 360, 4, t.accent, { radius: 2 }),
      tx(140, 420, 1000, 50, b, { font: t.body, size: 28, align: 'center', color: t.sub }),
      box(0, 690, 1280, 30, '#7a5c3c'),
    ],
    frame: () => [box(0, 690, 1280, 30, '#7a5c3c')],
    headColor: '#f0d77b',
  },
  {
    id: 'kon', name: '紺', note: '帯つき・きっちり',
    bg: '#ffffff', ink: '#1c2b4a', sub: '#5d6880', accent: '#d9a441',
    head: F.notoSans, body: F.notoSans, hx: 90, hy: 56,
    title: (t, a, b) => [
      box(0, 0, 420, 720, t.ink),
      box(60, 96, 48, 8, t.accent),
      tx(490, 220, 710, 200, a, { font: t.head, size: 58, bold: true, color: t.ink, lh: 1.3 }),
      tx(490, 450, 710, 50, b, { font: t.body, size: 24, color: t.sub }),
    ],
    frame: t => [box(0, 0, 24, 720, t.ink), box(90, 134, 64, 6, t.accent)],
  },
  {
    id: 'kraft', name: 'クラフト紙', note: '丸ゴシック・生成り',
    bg: '#e8ddc8', ink: '#3b2f26', sub: '#75645a', accent: '#b5532f',
    head: F.maru, body: F.maru, hx: 120, hy: 60,
    title: (t, a, b) => [
      box(140, 150, 1000, 420, '#fbf8f1', { radius: 6 }),
      box(560, 128, 160, 44, '#d2b98a', { op: 0.85 }),
      tx(200, 240, 880, 150, a, { font: t.head, size: 62, bold: true, align: 'center', va: 'middle', color: t.ink }),
      tx(200, 420, 880, 50, b, { font: t.body, size: 26, align: 'center', color: t.sub }),
    ],
    frame: t => [box(80, 80, 22, 22, t.accent, { shape: 'ellipse' })],
  },
  {
    id: 'futoji', name: '太字', note: '黒と黄色・大きな文字',
    bg: '#ffffff', ink: '#111111', sub: '#111111', accent: '#ffd400',
    head: F.dela, body: F.gothic, hx: 116, hy: 56, headBold: false,
    title: (t, a, b) => [
      box(0, 440, 1280, 280, t.accent),
      tx(80, 110, 1120, 290, a, { font: t.head, size: 92, color: t.ink, lh: 1.15, va: 'bottom' }),
      tx(80, 500, 1120, 60, b, { font: t.body, size: 30, bold: true, color: t.ink }),
    ],
    frame: t => [box(80, 58, 16, 72, t.accent)],
  },
];

const themeOf = id => THEMES.find(t => t.id === id) || THEMES[0];

const LAYOUTS = [
  ['title', '表紙'],
  ['body', '見出しと本文'],
  ['two', '2段組'],
  ['section', '章の区切り'],
  ['quote', '大きな一文'],
  ['blank', '白紙'],
];

/* kind ごとにスライドを1枚つくる。c は差し込む文言（省略可） */
function buildSlide(t, kind, c = {}) {
  const bold = t.headBold !== false;
  const hw = SW - t.hx - 80;
  const head = s => tx(t.hx, t.hy, hw, 64, s, { font: t.head, size: 40, bold, color: t.headColor || t.ink, va: 'middle' });
  const body = (x, w, s) => tx(x, 190, w, 420, s, { font: t.body, size: 28, color: t.ink, lh: 1.7 });
  let els = [];
  if (kind === 'title') {
    els = t.title(t, c.a || 'タイトルを入力', c.b || '名前　／　日付');
  } else if (kind === 'body') {
    els = [...t.frame(t, kind), head(c.a || '見出し'), body(t.hx, hw, c.b || '本文を入力')];
  } else if (kind === 'two') {
    const w = (hw - 60) / 2;
    els = [...t.frame(t, kind), head(c.a || '見出し'), body(t.hx, w, c.b || '左の本文'), body(t.hx + w + 60, w, c.c || '右の本文')];
  } else if (kind === 'section') {
    els = [
      ...(t.id === 'kokuban' ? t.frame(t, kind) : []),
      tx(140, 250, 1000, 50, c.b || '1', { font: t.head, size: 30, color: t.id === 'futoji' ? t.ink : t.accent, align: 'center', bold }),
      tx(140, 310, 1000, 100, c.a || '章のタイトル', { font: t.head, size: 56, bold, color: t.ink, align: 'center', va: 'middle' }),
    ];
  } else if (kind === 'quote') {
    els = [
      ...(t.id === 'kokuban' ? t.frame(t, kind) : []),
      tx(160, 220, 960, 220, c.a || 'いちばん伝えたい一文', { font: t.head, size: 52, bold, color: t.ink, align: 'center', va: 'middle', lh: 1.5 }),
      tx(160, 470, 960, 44, c.b || '補足', { font: t.body, size: 22, color: t.sub, align: 'center' }),
    ];
  }
  return { id: uid(), bg: t.bg, els };
}

function newDeck(themeId) {
  const t = themeOf(themeId);
  const slides = t.id === 'simple'
    ? [buildSlide(t, 'title')]
    : [
      buildSlide(t, 'title'),
      buildSlide(t, 'body', { a: 'もくじ', b: '1.　はじめに<br>2.　調べたこと<br>3.　わかったこと<br>4.　まとめ' }),
      buildSlide(t, 'section', { a: 'はじめに', b: '1' }),
      buildSlide(t, 'body'),
      buildSlide(t, 'two'),
      buildSlide(t, 'quote', { a: 'まとめ', b: 'ご清聴ありがとうございました' }),
    ];
  const now = Date.now();
  return { id: uid(), title: '無題のスライド', theme: t.id, created: now, updated: now, slides };
}

/* 読み込んだファイルを安全な形に整える（描画時にも値は検査する） */
function normalizeDeck(d) {
  if (!d || !Array.isArray(d.slides) || !d.slides.length) throw new Error('スライドのファイルではありません');
  const now = Date.now();
  return {
    id: uid(),
    title: String(d.title || '無題のスライド').slice(0, 100),
    theme: themeOf(d.theme).id,
    created: now, updated: now,
    slides: d.slides.map(s => ({
      id: uid(),
      bg: safeColor(s && s.bg, '#ffffff'),
      els: (s && Array.isArray(s.els) ? s.els : [])
        .filter(e => e && ['text', 'shape', 'image'].includes(e.type))
        .map(e => ({ ...e, id: uid() })),
    })),
  };
}

/* ---------- 描画 ---------- */
const safeColor = (v, fb = 'transparent') =>
  (typeof v === 'string' && (/^#[0-9a-fA-F]{3,8}$/.test(v) || v === 'transparent')) ? v : fb;
const safeFont = v => (typeof v === 'string' && /^[\p{L}\p{N} ,'"\-]+$/u.test(v)) ? v : F.gothic;
const num = (v, fb = 0) => Number.isFinite(+v) ? +v : fb;

const OK_TAGS = new Set(['B', 'I', 'U', 'S', 'STRIKE', 'STRONG', 'EM', 'SPAN', 'FONT', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);
const OK_CSS = ['font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'color', 'font-family', 'font-size', 'text-align'];

/* 文字の装飾に必要なタグとスタイルだけ残す */
function sanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html == null ? '' : html);
  (function walk(n) {
    [...n.childNodes].forEach(c => {
      if (c.nodeType === 3) return;
      if (c.nodeType !== 1) { c.remove(); return; }
      const tag = c.tagName.toUpperCase();
      if (DROP_TAGS.has(tag)) { c.remove(); return; }
      if (!OK_TAGS.has(tag)) { walk(c); c.replaceWith(...c.childNodes); return; }
      const keep = {};
      OK_CSS.forEach(p => {
        const v = c.style.getPropertyValue(p);
        if (v && !/url|expression|[<>;]/i.test(v)) keep[p] = v;
      });
      const fa = tag === 'FONT' ? ['face', 'color', 'size'].map(k => [k, c.getAttribute(k)]) : [];
      [...c.attributes].forEach(a => c.removeAttribute(a.name));
      for (const p in keep) c.style.setProperty(p, keep[p]);
      if (keep['font-family']) useFont(keep['font-family']);
      fa.forEach(([k, v]) => {
        if (!v || !/^[\p{L}\p{N} #,'"\-]+$/u.test(v)) return;
        c.setAttribute(k, v);
        if (k === 'face') useFont(v);
      });
      walk(c);
    });
  })(t.content);
  return t.innerHTML;
}

function applyTextStyle(t, e) {
  const s = t.style;
  useFont(safeFont(e.font));
  s.fontFamily = safeFont(e.font);
  s.fontSize = Math.min(400, Math.max(6, num(e.size, 28))) + 'px';
  s.color = safeColor(e.color, '#1d1d1b');
  s.textAlign = ['left', 'center', 'right'].includes(e.align) ? e.align : 'left';
  s.fontWeight = e.bold ? '700' : '400';
  s.fontStyle = e.italic ? 'italic' : 'normal';
  s.textDecoration = [e.underline && 'underline', e.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
  s.lineHeight = Math.min(4, Math.max(0.8, num(e.lh, 1.4)));
}

function renderEl(e) {
  const d = document.createElement('div');
  d.className = 'el ' + e.type;
  d.dataset.id = e.id;
  d.style.left = num(e.x) + 'px';
  d.style.top = num(e.y) + 'px';
  d.style.width = Math.max(1, num(e.w, 100)) + 'px';
  const h = Math.max(1, num(e.h, 50));
  if (e.type === 'text') {
    d.style.minHeight = h + 'px';
    d.style.justifyContent = { middle: 'center', bottom: 'flex-end' }[e.va] || 'flex-start';
    const t = document.createElement('div');
    t.className = 'tx';
    t.innerHTML = sanitize(e.html);
    applyTextStyle(t, e);
    d.append(t);
  } else if (e.type === 'shape') {
    d.style.height = h + 'px';
    d.style.background = safeColor(e.fill);
    const sw = Math.max(0, num(e.sw));
    if (sw) d.style.border = sw + 'px solid ' + safeColor(e.stroke, '#1d1d1b');
    d.style.borderRadius = e.shape === 'ellipse' ? '50%' : Math.max(0, num(e.radius)) + 'px';
    if (e.op != null) d.style.opacity = Math.min(1, Math.max(0, num(e.op, 1)));
  } else if (e.type === 'image') {
    d.style.height = h + 'px';
    if (typeof e.src === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(e.src)) {
      const img = document.createElement('img');
      img.src = e.src;
      img.alt = '';
      img.draggable = false;
      d.append(img);
    }
  }
  return d;
}

function fillStage(stage, slide) {
  stage.style.background = safeColor(slide.bg, '#ffffff');
  stage.replaceChildren(...slide.els.map(renderEl));
}

/* 縮小表示。入れ物の幅に合わせて 1280x720 の舞台を縮める */
const thumbRO = new ResizeObserver(list => list.forEach(en => {
  const st = en.target.firstElementChild;
  if (st) st.style.transform = `scale(${en.contentRect.width / SW})`;
}));

function makeThumb(slide) {
  const w = document.createElement('div');
  w.className = 'thumb';
  const st = document.createElement('div');
  st.className = 'stage';
  fillStage(st, slide);
  w.append(st);
  thumbRO.observe(w);
  return w;
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileName = s => (String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'slides');
