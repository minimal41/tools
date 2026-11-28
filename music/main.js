/*
 * Music — 端末の音楽（MP3 など）をオフラインで再生する
 *
 * ■ Android アプリ（Tools の APK）で開いたとき
 *   端末に入っている音楽ファイルをすべて一覧にする（MediaStore。曲名・アーティスト・アルバムは ID3 タグから）。
 *   再生はアプリの中の再生サービス（MusicPlayer プラグイン）が行うので、画面を消しても・ほかのアプリに
 *   切り替えても止まらず、通知・ロック画面・イヤホンのボタンで操作できる。
 *
 * ■ ブラウザで開いたとき
 *   「曲を追加」で選んだファイル・フォルダを、このブラウザの中（IndexedDB）に保存して再生する。
 *   タグはこのページ（id3.js）で読む。通信がなくても再生できる。
 */
import { readTags } from './id3.js';

const $ = (id) => document.getElementById(id);
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a || '', b || '');

/* ------------------------------------------------------------------ */
/* ネイティブ（Android アプリ）かどうか                                    */
/* ------------------------------------------------------------------ */

function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
}

async function nativePlugins() {
  const looksNative = !!(window.androidBridge || window.webkit?.messageHandlers?.bridge);
  if (!looksNative) return null;
  if (!window.Capacitor?.registerPlugin) await loadScript('../capacitor.js');
  const Cap = window.Capacitor;
  if (!Cap?.registerPlugin || !Cap.isNativePlatform?.() || !Cap.isPluginAvailable?.('MusicPlayer')) return null;
  return {
    Cap,
    Library: Cap.registerPlugin('MusicLibrary'),
    Player: Cap.registerPlugin('MusicPlayer'),
  };
}

/* ------------------------------------------------------------------ */
/* 表示用の小物                                                          */
/* ------------------------------------------------------------------ */

const UNKNOWN_ARTIST = '不明なアーティスト';
const UNKNOWN_ALBUM = '不明なアルバム';

function fmtTime(ms) {
  if (!ms || !isFinite(ms) || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtTotal(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}時間${min % 60 ? (min % 60) + '分' : ''}`;
}

const stripExt = (name) => (name || '').replace(/\.[^.]+$/, '');
const isUnknown = (s) => !s || s === '<unknown>';

function hue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ------------------------------------------------------------------ */
/* ライブラリ（曲・アルバム・アーティスト）                                 */
/* ------------------------------------------------------------------ */

const lib = {
  tracks: [],
  byId: new Map(),
  albums: [],
  albumByKey: new Map(),
  artists: [],
  artistByKey: new Map(),
};

/** ブラウザ版のアルバムの見分け方：アルバム名でまとめる（アルバム名が無い曲はアーティストごと） */
function webAlbumKey(album, artist) {
  return album ? 'w' + album.toLowerCase() : 'w\u0000' + (artist || '').toLowerCase();
}

/** 取り込んだ生の情報を、表示用の曲データにそろえる */
function normalize(raw) {
  const title = isUnknown(raw.title) ? stripExt(raw.fileName) : raw.title;
  const artist = isUnknown(raw.artist) ? '' : raw.artist;
  const albumArtist = isUnknown(raw.albumArtist) ? '' : raw.albumArtist;
  const album = isUnknown(raw.album) ? '' : raw.album;
  const albumKey = raw.albumId ? 'a' + raw.albumId : webAlbumKey(album, artist);
  return {
    ...raw,
    title: title || '（曲名なし）',
    artist,
    albumArtist,
    album,
    albumKey,
    track: raw.track || 0,
    disc: raw.disc || 0,
    duration: raw.duration || 0,
  };
}

function setLibrary(rawTracks) {
  lib.tracks = rawTracks.map(normalize).sort((a, b) => cmp(a.title, b.title));
  lib.byId = new Map(lib.tracks.map((t) => [t.id, t]));

  // アルバム
  const albums = new Map();
  for (const t of lib.tracks) {
    let a = albums.get(t.albumKey);
    if (!a) {
      a = { key: t.albumKey, title: t.album || UNKNOWN_ALBUM, tracks: [], artists: new Map(), albumArtist: '', year: 0, duration: 0 };
      albums.set(t.albumKey, a);
    }
    a.tracks.push(t);
    a.duration += t.duration || 0;
    if (t.albumArtist && !a.albumArtist) a.albumArtist = t.albumArtist;
    if (t.artist) a.artists.set(t.artist, (a.artists.get(t.artist) || 0) + 1);
    if (t.year && (!a.year || t.year < a.year)) a.year = t.year;
  }
  for (const a of albums.values()) {
    a.tracks.sort((x, y) => (x.disc || 0) - (y.disc || 0) || (x.track || 0) - (y.track || 0) || cmp(x.fileName, y.fileName) || cmp(x.title, y.title));
    if (a.albumArtist) a.artist = a.albumArtist;
    else if (a.artists.size === 1) a.artist = [...a.artists.keys()][0];
    else if (a.artists.size > 1) a.artist = 'さまざまなアーティスト';
    else a.artist = UNKNOWN_ARTIST;
    a.multiDisc = new Set(a.tracks.map((t) => t.disc || 0)).size > 1;
  }
  lib.albums = [...albums.values()].sort((x, y) => cmp(x.title, y.title));
  lib.albumByKey = albums;

  // アーティスト（曲のアーティスト）
  const artists = new Map();
  for (const t of lib.tracks) {
    const name = t.artist || UNKNOWN_ARTIST;
    const key = name.toLowerCase();
    let ar = artists.get(key);
    if (!ar) { ar = { key, name, tracks: [], albums: new Set() }; artists.set(key, ar); }
    ar.tracks.push(t);
    ar.albums.add(t.albumKey);
  }
  lib.artists = [...artists.values()].sort((x, y) => cmp(x.name, y.name));
  lib.artistByKey = artists;
}

/* ------------------------------------------------------------------ */
/* ジャケット画像                                                        */
/* ------------------------------------------------------------------ */

const artCache = new Map();   // albumKey → Promise<string | null>
let artBackend = null;        // (track) => Promise<string | null>
const artQueue = [];
let artRunning = 0;

function runArtQueue() {
  while (artRunning < 3 && artQueue.length) {
    const job = artQueue.shift();
    artRunning++;
    artBackend(job.track).then(job.resolve, () => job.resolve(null)).finally(() => { artRunning--; runArtQueue(); });
  }
}

function artFor(track) {
  if (!track || !artBackend) return Promise.resolve(null);
  const key = track.albumKey;
  if (!artCache.has(key)) {
    artCache.set(key, new Promise((resolve) => { artQueue.push({ track, resolve }); runArtQueue(); }));
  }
  return artCache.get(key);
}

/** ジャケットの枠。画像が無いときはアルバム名から色を決めた四角に音符 */
function artBox(track, cls = '') {
  const label = track ? (track.album || track.title) : '';
  const box = el('div', { class: 'art ' + cls });
  box.style.setProperty('--h', hue(label));
  box.append(icon('note'));
  if (track) box._track = track;
  lazyArt.observe(box);
  return box;
}

const lazyArt = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazyArt.unobserve(e.target);
    fillArt(e.target, e.target._track);
  }
}, { rootMargin: '300px' });

function fillArt(box, track) {
  if (!track) return;
  artFor(track).then((src) => {
    if (!src || box._track !== track) return;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => { if (box._track === track) { box.replaceChildren(img); box.classList.add('has-img'); } };
    img.src = src;
  });
}

function setArt(box, track) {
  box._track = track;
  box.classList.remove('has-img');
  box.style.setProperty('--h', hue(track ? (track.album || track.title) : ''));
  box.replaceChildren(icon('note'));
  fillArt(box, track);
}

/* ------------------------------------------------------------------ */
/* 再生エンジン                                                          */
/* ------------------------------------------------------------------ */

const listeners = new Set();
const state = { playing: false, id: null, index: -1, position: 0, duration: 0, shuffle: false, repeat: 'off', count: 0 };
function emit() { for (const fn of listeners) fn(state); }

/** Android アプリ：再生はネイティブの再生サービス */
class NativeEngine {
  constructor(P) {
    this.P = P;
    this.queue = [];
    P.addListener('state', (s) => this.apply(s));
    P.addListener('error', (e) => toast('再生できませんでした' + (e?.message ? '：' + e.message : '')));
  }
  apply(s) {
    if (!s) return;
    Object.assign(state, {
      playing: !!s.playing || (!!s.playWhenReady && !!s.buffering),
      id: s.id ?? null,
      index: s.index ?? -1,
      position: s.position || 0,
      duration: s.duration || state.duration,
      shuffle: !!s.shuffle,
      repeat: s.repeat || 'off',
      count: s.count || 0,
    });
    if (s.id && lib.byId.get(s.id)?.duration) state.duration = s.duration || lib.byId.get(s.id).duration;
    emit();
  }
  async restore() {
    const s = await this.P.getState({ queue: true }).catch(() => null);
    if (s?.count) {
      this.queue = (s.queue || []).map((id) => lib.byId.get(id)).filter(Boolean);
      this.apply(s);
      return true;
    }
    return false;
  }
  async setQueue(tracks, index, { play = true, position = 0 } = {}) {
    this.queue = tracks;
    const s = await this.P.setQueue({
      tracks: tracks.map((t) => ({
        id: t.id, uri: t.uri, title: t.title, artist: t.artist || UNKNOWN_ARTIST,
        album: t.album, albumArtist: t.albumArtist, albumId: t.albumId || '',
      })),
      index, position, play,
    });
    this.apply(s);
  }
  async play() { this.apply(await this.P.play()); }
  async pause() { this.apply(await this.P.pause()); }
  async next() { this.apply(await this.P.next()); }
  async prev() { this.apply(await this.P.previous()); }
  async seek(ms) { this.apply(await this.P.seek({ position: Math.round(ms) })); }
  async skipTo(i) { this.apply(await this.P.skipTo({ index: i })); }
  async setShuffle(on) { this.apply(await this.P.setShuffle({ on })); }
  async setRepeat(mode) { this.apply(await this.P.setRepeat({ mode })); }
  async poll() { this.apply(await this.P.getState().catch(() => null)); }
}

/** ブラウザ：<audio> で再生し、Media Session でロック画面・通知に出す */
class WebEngine {
  constructor(getUrl) {
    this.getUrl = getUrl;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];
    this.order = [];
    this.pos = 0;
    this.url = null;
    this.loadToken = 0;
    const a = this.audio;
    const sync = () => {
      state.playing = !a.paused && !a.ended;
      state.position = (a.currentTime || 0) * 1000;
      if (isFinite(a.duration) && a.duration > 0) state.duration = a.duration * 1000;
      emit();
      this.positionState();
    };
    for (const ev of ['play', 'pause', 'loadedmetadata', 'durationchange', 'seeked']) a.addEventListener(ev, sync);
    a.addEventListener('timeupdate', () => {
      state.position = (a.currentTime || 0) * 1000;
      emit();
    });
    a.addEventListener('loadedmetadata', () => {
      const t = this.current();
      if (t && isFinite(a.duration) && a.duration > 0 && !t.duration) {
        t.duration = Math.round(a.duration * 1000);
        webStore.updateDuration(t.id, t.duration);
      }
    });
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => { if (a.src) toast('この曲は再生できませんでした'); });

    const ms = navigator.mediaSession;
    if (ms) {
      const h = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* 未対応 */ } };
      h('play', () => this.play());
      h('pause', () => this.pause());
      h('previoustrack', () => this.prev());
      h('nexttrack', () => this.next());
      h('seekto', (d) => { if (d.seekTime != null) this.seek(d.seekTime * 1000); });
      h('seekbackward', (d) => this.seek(a.currentTime * 1000 - (d.seekOffset || 10) * 1000));
      h('seekforward', (d) => this.seek(a.currentTime * 1000 + (d.seekOffset || 10) * 1000));
    }
  }
  current() { return this.queue[this.order[this.pos]]; }
  buildOrder(start) {
    const n = this.queue.length;
    if (state.shuffle) {
      const rest = [];
      for (let i = 0; i < n; i++) if (i !== start) rest.push(i);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      this.order = n ? [start, ...rest] : [];
      this.pos = 0;
    } else {
      this.order = [...Array(n).keys()];
      this.pos = start;
    }
  }
  async load(play, position = 0) {
    const t = this.current();
    const token = ++this.loadToken;
    state.id = t ? t.id : null;
    state.index = t ? this.order[this.pos] : -1;
    state.count = this.queue.length;
    state.position = position;
    state.duration = t?.duration || 0;
    emit();
    if (!t) return;
    const url = await this.getUrl(t);
    if (token !== this.loadToken) return;
    if (!url) { toast('曲のファイルが見つかりません'); return; }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = url;
    this.audio.src = url;
    if (position) {
      const p = position / 1000;
      this.audio.addEventListener('loadedmetadata', () => { this.audio.currentTime = p; }, { once: true });
    }
    this.mediaSession(t);
    if (play) await this.audio.play().catch(() => {});
  }
  mediaSession(t) {
    if (!navigator.mediaSession || !window.MediaMetadata) return;
    const meta = { title: t.title, artist: t.artist || UNKNOWN_ARTIST, album: t.album || '' };
    navigator.mediaSession.metadata = new MediaMetadata(meta);
    artFor(t).then((src) => {
      if (src && this.current() === t) {
        navigator.mediaSession.metadata = new MediaMetadata({ ...meta, artwork: [{ src, sizes: '512x512' }] });
      }
    });
  }
  positionState() {
    const a = this.audio;
    if (!navigator.mediaSession?.setPositionState || !isFinite(a.duration) || a.duration <= 0) return;
    try { navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate || 1 }); } catch { /* なし */ }
  }
  onEnded() {
    if (state.repeat === 'one') { this.audio.currentTime = 0; this.audio.play(); return; }
    if (this.pos + 1 < this.order.length) { this.pos++; this.load(true); return; }
    if (state.repeat === 'all' && this.order.length) {
      if (state.shuffle) this.buildOrder(this.order[Math.floor(Math.random() * this.order.length)]);
      else this.pos = 0;
      this.load(true);
      return;
    }
    state.playing = false;
    emit();
  }
  async restore() { return false; }
  async setQueue(tracks, index, { play = true, position = 0 } = {}) {
    this.queue = tracks;
    this.buildOrder(Math.max(0, Math.min(index, tracks.length - 1)));
    await this.load(play, position);
  }
  async play() {
    if (!this.audio.src) { if (this.queue.length) await this.load(true, state.position); return; }
    if (this.audio.ended) this.audio.currentTime = 0;
    await this.audio.play().catch(() => {});
  }
  async pause() { this.audio.pause(); }
  async next() {
    if (this.pos + 1 < this.order.length) this.pos++;
    else if (state.repeat === 'all') this.pos = 0;
    else return;
    await this.load(!this.audio.paused || state.playing);
  }
  async prev() {
    if (this.audio.currentTime > 3 || this.pos === 0) { this.audio.currentTime = 0; return; }
    this.pos--;
    await this.load(!this.audio.paused || state.playing);
  }
  async seek(ms) {
    const s = Math.max(0, ms / 1000);
    if (isFinite(this.audio.duration)) this.audio.currentTime = Math.min(s, this.audio.duration);
  }
  async skipTo(i) {
    const p = this.order.indexOf(i);
    if (p < 0) return;
    this.pos = p;
    await this.load(true);
  }
  async setShuffle(on) {
    state.shuffle = on;
    const cur = this.order[this.pos] ?? 0;
    this.buildOrder(cur);
    emit();
  }
  async setRepeat(mode) { state.repeat = mode; emit(); }
  async poll() {}
}

/* ------------------------------------------------------------------ */
/* ブラウザ版の保存先（IndexedDB）                                          */
/* ------------------------------------------------------------------ */

const webStore = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('tools-music', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('tracks', { keyPath: 'id' });
        db.createObjectStore('files');
        db.createObjectStore('art');
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(stores, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  req(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); },
  async all() { return this.tx(['tracks'], 'readonly', (t) => this.req(t.objectStore('tracks').getAll())); },
  async file(id) { return this.tx(['files'], 'readonly', (t) => this.req(t.objectStore('files').get(id))); },
  async art(key) { return this.tx(['art'], 'readonly', (t) => this.req(t.objectStore('art').get(key))); },
  async add(track, blob, picture) {
    return this.tx(['tracks', 'files', 'art'], 'readwrite', (t) => {
      t.objectStore('tracks').put(track);
      t.objectStore('files').put(blob, track.id);
      if (picture) t.objectStore('art').put(picture, track.artKey);
    });
  },
  async updateDuration(id, duration) {
    return this.tx(['tracks'], 'readwrite', async (t) => {
      const s = t.objectStore('tracks');
      const rec = await this.req(s.get(id));
      if (rec) { rec.duration = duration; s.put(rec); }
    }).catch(() => {});
  },
  async remove(ids) {
    return this.tx(['tracks', 'files'], 'readwrite', (t) => {
      for (const id of ids) { t.objectStore('tracks').delete(id); t.objectStore('files').delete(id); }
    });
  },
  async clear() {
    return this.tx(['tracks', 'files', 'art'], 'readwrite', (t) => {
      t.objectStore('tracks').clear(); t.objectStore('files').clear(); t.objectStore('art').clear();
    });
  },
};

/** 音声ファイルの長さを調べる（ブラウザ版の取り込み時） */
function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(url); a.src = ''; resolve(v); };
    const timer = setTimeout(() => done(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { clearTimeout(timer); done(isFinite(a.duration) ? Math.round(a.duration * 1000) : 0); };
    a.onerror = () => { clearTimeout(timer); done(0); };
    a.src = url;
  });
}

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|weba|webm)$/i;

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name));
  if (!files.length) { toast('音楽ファイルが見つかりませんでした'); return; }
  try { await navigator.storage?.persist?.(); } catch { /* なし */ }
  const existing = new Set(lib.tracks.map((t) => t.fileName + '\u0000' + t.size));
  const prog = $('progress');
  prog.hidden = false;
  let added = 0, skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    prog.textContent = `取り込み中… ${i + 1} / ${files.length}　${f.name}`;
    if (existing.has(f.name + '\u0000' + f.size)) { skipped++; continue; }
    const tags = await readTags(f);
    const album = tags.album || '';
    const artKey = webAlbumKey(album, tags.artist);
    const rec = {
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      title: tags.title, artist: tags.artist, album, albumArtist: tags.albumArtist,
      track: tags.track, disc: tags.disc, year: tags.year,
      fileName: f.name, size: f.size, mime: f.type, added: Math.floor(Date.now() / 1000),
      path: f.webkitRelativePath || '', artKey, hasArt: !!tags.picture,
      duration: await probeDuration(f),
    };
    try {
      await webStore.add(rec, f, tags.picture);
      existing.add(f.name + '\u0000' + f.size);
      added++;
    } catch (e) {
      toast('保存できませんでした（ブラウザの保存容量が足りない可能性があります）');
      break;
    }
  }
  prog.hidden = true;
  await loadWebLibrary();
  render();
  toast(`${added} 曲を追加しました` + (skipped ? `（${skipped} 曲は追加済み）` : ''));
}

async function loadWebLibrary() {
  const recs = await webStore.all().catch(() => []);
  setLibrary(recs);
}

/* ------------------------------------------------------------------ */
/* 画面                                                                 */
/* ------------------------------------------------------------------ */

let engine;
let native = null;
let mode = 'web';
let permission = true;
let scanning = false;

const ui = {
  tab: localStorage.getItem('music.tab') || 'songs',
  query: '',
  sort: localStorage.getItem('music.sort') || 'title',
};

function routeState() {
  return history.state || {};
}

function go(st) {
  history.pushState(st, '');
  render();
  window.scrollTo(0, 0);
}

function matches(t, q) {
  if (!q) return true;
  return (t.title + '\u0000' + t.artist + '\u0000' + t.album + '\u0000' + t.albumArtist + '\u0000' + (t.fileName || '')).toLowerCase().includes(q);
}

function sortedSongs(list) {
  const arr = [...list];
  if (ui.sort === 'added') arr.sort((a, b) => (b.added || 0) - (a.added || 0) || cmp(a.title, b.title));
  else if (ui.sort === 'artist') arr.sort((a, b) => cmp(a.artist || '￿', b.artist || '￿') || cmp(a.album, b.album) || (a.disc - b.disc) || (a.track - b.track) || cmp(a.title, b.title));
  return arr;
}

async function playList(list, index = 0, { shuffle = false } = {}) {
  if (!list.length) return;
  if (shuffle !== state.shuffle) await engine.setShuffle(shuffle);
  const start = shuffle ? Math.floor(Math.random() * list.length) : index;
  try {
    await engine.setQueue(list, start, { play: true });
  } catch (e) {
    toast('再生できませんでした：' + (e?.message || e));
  }
  saveQueue();
}

function songRow(t, list, i, { showNumber = false, showArt = true } = {}) {
  const sub = showNumber
    ? (t.artist && list.album && t.artist !== list.album.artist ? t.artist : '')
    : [t.artist || UNKNOWN_ARTIST, t.album].filter(Boolean).join(' ・ ');
  const row = el('button', {
    type: 'button',
    class: 'song' + (state.id === t.id ? ' current' : ''),
    dataset: { id: t.id },
    onclick: () => playList(list.tracks, i),
  },
    showNumber ? el('span', { class: 'num', text: t.track ? String(t.track) : '–' }) : null,
    showArt && !showNumber ? artBox(t, 'sm') : null,
    el('span', { class: 'meta' },
      el('span', { class: 'name', text: t.title }),
      sub ? el('span', { class: 'sub', text: sub }) : null,
    ),
    el('span', { class: 'dur', text: t.duration ? fmtTime(t.duration) : '' }),
  );
  return row;
}

function playButtons(list) {
  return el('div', { class: 'play-btns' },
    el('button', { type: 'button', class: 'btn primary', onclick: () => playList(list, 0) }, icon('play'), '再生'),
    el('button', { type: 'button', class: 'btn', onclick: () => playList(list, 0, { shuffle: true }) }, icon('shuffle'), 'シャッフル'),
  );
}

function emptyState() {
  if (mode === 'native' && !permission) {
    return el('div', { class: 'empty' },
      el('p', { class: 'big', text: '端末の音楽を表示するには、音楽ファイルへのアクセスを許可してください。' }),
      el('button', { type: 'button', class: 'btn primary', onclick: requestPermission }, '許可する'),
    );
  }
  if (mode === 'native') {
    return el('div', { class: 'empty' },
      el('p', { class: 'big', text: scanning ? '曲を読み込んでいます…' : '端末に音楽ファイルが見つかりませんでした。' }),
      scanning ? null : el('p', { text: 'ダウンロードした MP3 などは、自動でここに並びます。' }),
      scanning ? null : el('button', { type: 'button', class: 'btn', onclick: () => scan(true) }, icon('refresh'), '読み込み直す'),
    );
  }
  return el('div', { class: 'empty' },
    el('p', { class: 'big', text: 'まだ曲がありません。' }),
    el('p', { text: '「曲を追加」から MP3 などのファイルやフォルダを選ぶと、このブラウザに保存され、通信がなくても再生できます。' }),
    el('div', { class: 'play-btns' },
      el('button', { type: 'button', class: 'btn primary', onclick: () => $('filePick').click() }, icon('plus'), 'ファイルを選ぶ'),
      el('button', { type: 'button', class: 'btn', onclick: () => $('dirPick').click() }, icon('folder'), 'フォルダを選ぶ'),
    ),
    el('p', { class: 'hint', text: 'Tools の Android アプリでは、スマホに入っている音楽がすべて自動で表示されます。' }),
  );
}

function viewSongs(q) {
  const list = sortedSongs(lib.tracks.filter((t) => matches(t, q)));
  const wrap = el('section', { class: 'view' });
  const ctx = { tracks: list };
  wrap.append(el('div', { class: 'list-head' },
    el('span', { class: 'count', text: `${list.length} 曲` }),
    el('label', { class: 'sort' }, '並び順',
      el('select', {
        onchange: (e) => { ui.sort = e.target.value; localStorage.setItem('music.sort', ui.sort); render(); },
      },
        ...[['title', '曲名'], ['artist', 'アーティスト'], ['added', '追加が新しい順']].map(([v, l]) => {
          const o = el('option', { value: v, text: l });
          if (ui.sort === v) o.selected = true;
          return o;
        }),
      ),
    ),
  ));
  if (list.length) wrap.append(playButtons(list));
  const ul = el('div', { class: 'songs' });
  list.forEach((t, i) => ul.append(songRow(t, ctx, i)));
  wrap.append(ul);
  return wrap;
}

function albumCard(a) {
  return el('button', { type: 'button', class: 'album-card', onclick: () => go({ view: 'album', key: a.key }) },
    artBox(a.tracks[0], 'lg'),
    el('span', { class: 'name', text: a.title }),
    el('span', { class: 'sub', text: a.artist }),
  );
}

function viewAlbums(q) {
  const list = lib.albums.filter((a) => !q || (a.title + '\u0000' + a.artist).toLowerCase().includes(q) || a.tracks.some((t) => matches(t, q)));
  const wrap = el('section', { class: 'view' });
  wrap.append(el('div', { class: 'list-head' }, el('span', { class: 'count', text: `${list.length} 枚` })));
  const grid = el('div', { class: 'album-grid' });
  for (const a of list) grid.append(albumCard(a));
  wrap.append(grid);
  return wrap;
}

function viewArtists(q) {
  const list = lib.artists.filter((ar) => !q || ar.name.toLowerCase().includes(q));
  const wrap = el('section', { class: 'view' });
  wrap.append(el('div', { class: 'list-head' }, el('span', { class: 'count', text: `${list.length} 人` })));
  const ul = el('div', { class: 'songs' });
  for (const ar of list) {
    ul.append(el('button', { type: 'button', class: 'song artist-row', onclick: () => go({ view: 'artist', key: ar.key }) },
      artBox(ar.tracks[0], 'sm round'),
      el('span', { class: 'meta' },
        el('span', { class: 'name', text: ar.name }),
        el('span', { class: 'sub', text: `${ar.albums.size} アルバム ・ ${ar.tracks.length} 曲` }),
      ),
      el('span', { class: 'chev' }, icon('chev')),
    ));
  }
  wrap.append(ul);
  return wrap;
}

function backBar(label) {
  return el('div', { class: 'back-bar' },
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': '戻る', onclick: () => history.back() }, icon('back')),
    el('span', { class: 'back-label', text: label }),
  );
}

function viewAlbum(key) {
  const a = lib.albumByKey.get(key);
  const wrap = el('section', { class: 'view detail' });
  if (!a) { wrap.append(backBar('アルバム'), el('p', { class: 'empty', text: 'アルバムが見つかりません。' })); return wrap; }
  const total = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  wrap.append(
    backBar('アルバム'),
    el('div', { class: 'album-hero' },
      artBox(a.tracks[0], 'hero'),
      el('div', { class: 'hero-text' },
        el('h2', { text: a.title }),
        el('button', {
          type: 'button', class: 'link',
          onclick: () => { const k = (a.artists.size === 1 ? [...a.artists.keys()][0] : a.artist).toLowerCase(); if (lib.artistByKey.has(k)) go({ view: 'artist', key: k }); },
        }, a.artist),
        el('p', { class: 'sub', text: [a.year || '', `${a.tracks.length} 曲`, total ? fmtTotal(total) : ''].filter(Boolean).join(' ・ ') }),
        playButtons(a.tracks),
      ),
    ),
  );
  const ul = el('div', { class: 'songs numbered' });
  const ctx = { tracks: a.tracks, album: a };
  let disc = null;
  a.tracks.forEach((t, i) => {
    if (a.multiDisc && t.disc !== disc) { disc = t.disc; ul.append(el('div', { class: 'disc', text: `ディスク ${disc || 1}` })); }
    ul.append(songRow(t, ctx, i, { showNumber: true }));
  });
  wrap.append(ul);
  return wrap;
}

function viewArtist(key) {
  const ar = lib.artistByKey.get(key);
  const wrap = el('section', { class: 'view detail' });
  if (!ar) { wrap.append(backBar('アーティスト'), el('p', { class: 'empty', text: 'アーティストが見つかりません。' })); return wrap; }
  const albums = [...ar.albums].map((k) => lib.albumByKey.get(k)).filter(Boolean).sort((x, y) => (x.year || 9999) - (y.year || 9999) || cmp(x.title, y.title));
  const tracks = albums.flatMap((a) => a.tracks.filter((t) => (t.artist || UNKNOWN_ARTIST).toLowerCase() === key));
  wrap.append(
    backBar('アーティスト'),
    el('div', { class: 'artist-hero' },
      el('h2', { text: ar.name }),
      el('p', { class: 'sub', text: `${albums.length} アルバム ・ ${tracks.length} 曲` }),
      playButtons(tracks),
    ),
    el('h3', { class: 'section-title', text: 'アルバム' }),
  );
  const grid = el('div', { class: 'album-grid' });
  for (const a of albums) grid.append(albumCard(a));
  wrap.append(grid, el('h3', { class: 'section-title', text: '曲' }));
  const ul = el('div', { class: 'songs' });
  const ctx = { tracks };
  tracks.forEach((t, i) => ul.append(songRow(t, ctx, i)));
  wrap.append(ul);
  return wrap;
}

function render() {
  const st = routeState();
  const main = $('view');
  const q = ui.query.trim().toLowerCase();
  const detail = st.view === 'album' || st.view === 'artist';
  document.body.classList.toggle('in-detail', detail);
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));

  let v;
  if (st.view === 'album') v = viewAlbum(st.key);
  else if (st.view === 'artist') v = viewArtist(st.key);
  else if (!lib.tracks.length) v = emptyState();
  else if (ui.tab === 'albums') v = viewAlbums(q);
  else if (ui.tab === 'artists') v = viewArtists(q);
  else v = viewSongs(q);
  main.replaceChildren(v);

  $('player').hidden = !st.player;
  document.body.classList.toggle('player-open', !!st.player);
  if (st.player) renderQueue();
}

/* ------------------------------------------------------------------ */
/* ミニプレーヤーと再生画面                                                */
/* ------------------------------------------------------------------ */

let shownId = undefined;
let seeking = false;

function currentTrack() {
  return state.id ? lib.byId.get(state.id) : null;
}

function updatePlayerUI() {
  const t = currentTrack();
  const has = !!t;
  $('mini').hidden = !has;
  document.body.classList.toggle('has-mini', has);
  if (!has) return;

  if (shownId !== t.id) {
    shownId = t.id;
    $('miniTitle').textContent = t.title;
    $('miniSub').textContent = t.artist || UNKNOWN_ARTIST;
    $('pTitle').textContent = t.title;
    $('pArtist').textContent = t.artist || UNKNOWN_ARTIST;
    $('pAlbum').textContent = t.album || '';
    setArt($('miniArt'), t);
    setArt($('pArt'), t);
    for (const row of document.querySelectorAll('.song.current')) row.classList.remove('current');
    for (const row of document.querySelectorAll(`.song[data-id="${CSS.escape(t.id)}"]`)) row.classList.add('current');
    if (!$('player').hidden) renderQueue();
    document.title = `${t.title} — Music`;
  }

  const playIcon = state.playing ? 'pause' : 'play';
  for (const id of ['miniPlay', 'pPlay']) {
    const b = $(id);
    if (b.dataset.icon !== playIcon) {
      b.dataset.icon = playIcon;
      b.replaceChildren(icon(playIcon));
      b.setAttribute('aria-label', state.playing ? '一時停止' : '再生');
    }
  }
  const dur = state.duration || t.duration || 0;
  const pos = Math.min(state.position, dur || state.position);
  $('miniBar').style.width = dur ? (pos / dur) * 100 + '%' : '0%';
  if (!seeking) {
    const seek = $('pSeek');
    seek.max = String(Math.max(1, Math.round(dur)));
    seek.value = String(Math.round(pos));
    seek.style.setProperty('--p', dur ? (pos / dur) * 100 + '%' : '0%');
    $('pPos').textContent = fmtTime(pos);
  }
  $('pDur').textContent = fmtTime(dur);
  $('pShuffle').setAttribute('aria-pressed', String(state.shuffle));
  const rep = $('pRepeat');
  rep.setAttribute('aria-pressed', String(state.repeat !== 'off'));
  if (rep.dataset.icon !== state.repeat) {
    rep.dataset.icon = state.repeat;
    rep.replaceChildren(icon(state.repeat === 'one' ? 'repeat1' : 'repeat'));
    rep.setAttribute('aria-label', { off: 'リピートなし', all: 'すべてリピート', one: '1曲リピート' }[state.repeat]);
  }
}

function renderQueue() {
  const box = $('pQueue');
  const q = engine.queue || [];
  const curIdx = q.findIndex((t) => t.id === state.id);
  box.replaceChildren();
  if (!q.length) return;
  const start = Math.max(0, curIdx);
  const end = Math.min(q.length, start + 60);
  for (let i = start; i < end; i++) {
    const t = q[i];
    box.append(el('button', {
      type: 'button', class: 'song' + (i === curIdx ? ' current' : ''),
      onclick: () => engine.skipTo(i),
    },
      artBox(t, 'sm'),
      el('span', { class: 'meta' }, el('span', { class: 'name', text: t.title }), el('span', { class: 'sub', text: t.artist || UNKNOWN_ARTIST })),
      el('span', { class: 'dur', text: t.duration ? fmtTime(t.duration) : '' }),
    ));
  }
  $('pQueueHead').textContent = state.shuffle ? '再生キュー（シャッフル中・元の並び）' : '再生キュー';
}

function openPlayer() {
  if (!routeState().player) go({ ...routeState(), player: true });
}

function saveQueue() {
  try {
    const q = engine.queue || [];
    if (q.length > 3000) { localStorage.removeItem('music.queue'); return; }
    localStorage.setItem('music.queue', JSON.stringify({ ids: q.map((t) => t.id), id: state.id, position: Math.round(state.position) }));
    localStorage.setItem('music.modes', JSON.stringify({ shuffle: state.shuffle, repeat: state.repeat }));
  } catch { /* 保存できなくても再生は続ける */ }
}

async function restoreQueue() {
  if (await engine.restore()) return;
  try {
    const modes = JSON.parse(localStorage.getItem('music.modes') || 'null');
    if (modes) { state.shuffle = !!modes.shuffle; state.repeat = modes.repeat || 'off'; }
    const saved = JSON.parse(localStorage.getItem('music.queue') || 'null');
    if (!saved?.ids?.length) { emit(); return; }
    const tracks = saved.ids.map((id) => lib.byId.get(id)).filter(Boolean);
    if (!tracks.length) return;
    const idx = Math.max(0, tracks.findIndex((t) => t.id === saved.id));
    if (mode === 'native') {
      if (modes) { await engine.setShuffle(state.shuffle); await engine.setRepeat(state.repeat); }
      await engine.setQueue(tracks, idx, { play: false, position: saved.position || 0 });
    } else {
      await engine.setQueue(tracks, idx, { play: false, position: saved.position || 0 });
    }
  } catch { /* 復元できなくてもよい */ }
}

/* ------------------------------------------------------------------ */
/* 端末の曲を読み込む（Android アプリ）                                     */
/* ------------------------------------------------------------------ */

let lastScan = 0;

async function scan(showToast = false) {
  if (!native || scanning) return;
  scanning = true;
  if (!lib.tracks.length) render();
  try {
    const { granted } = await native.Library.checkPermission();
    permission = granted;
    if (!granted) { setLibrary([]); return; }
    const { tracks } = await native.Library.scan();
    const before = lib.tracks.length;
    setLibrary(tracks);
    lastScan = Date.now();
    if (showToast) toast(`${lib.tracks.length} 曲を読み込みました` + (lib.tracks.length > before && before ? `（${lib.tracks.length - before} 曲 増えました）` : ''));
  } catch (e) {
    toast('曲を読み込めませんでした：' + (e?.message || e));
  } finally {
    scanning = false;
    render();
    shownId = undefined;
    updatePlayerUI();
  }
}

async function requestPermission() {
  try {
    const { granted } = await native.Library.requestPermission();
    permission = granted;
    if (granted) {
      await scan();
      await restoreQueue();
    } else {
      toast('許可されませんでした。端末の「設定」→「アプリ」→「Tools」→「権限」から「音楽とオーディオ」を許可できます。');
      render();
    }
  } catch (e) {
    toast('許可を確認できませんでした：' + (e?.message || e));
  }
}

/* ------------------------------------------------------------------ */
/* はじめに                                                              */
/* ------------------------------------------------------------------ */

function bindControls() {
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      ui.tab = b.dataset.tab;
      localStorage.setItem('music.tab', ui.tab);
      if (routeState().view) history.replaceState({}, '');
      render();
      window.scrollTo(0, 0);
    });
  }
  let qTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      ui.query = e.target.value;
      if (routeState().view) history.replaceState({}, '');
      render();
    }, 120);
  });

  const toggle = () => (state.playing ? engine.pause() : engine.play()).catch((e) => toast(String(e?.message || e)));
  $('miniPlay').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  $('miniNext').addEventListener('click', (e) => { e.stopPropagation(); engine.next(); });
  $('mini').addEventListener('click', openPlayer);
  $('pPlay').addEventListener('click', toggle);
  $('pNext').addEventListener('click', () => engine.next());
  $('pPrev').addEventListener('click', () => engine.prev());
  $('pClose').addEventListener('click', () => history.back());
  $('pShuffle').addEventListener('click', async () => { await engine.setShuffle(!state.shuffle); saveQueue(); renderQueue(); });
  $('pRepeat').addEventListener('click', async () => {
    const next = { off: 'all', all: 'one', one: 'off' }[state.repeat] || 'off';
    await engine.setRepeat(next);
    saveQueue();
  });
  $('pAlbum').addEventListener('click', () => {
    const t = currentTrack();
    if (t) { history.replaceState({ view: 'album', key: t.albumKey }, ''); render(); window.scrollTo(0, 0); }
  });
  $('pArtist').addEventListener('click', () => {
    const t = currentTrack();
    const k = (t?.artist || UNKNOWN_ARTIST).toLowerCase();
    if (t && lib.artistByKey.has(k)) { history.replaceState({ view: 'artist', key: k }, ''); render(); window.scrollTo(0, 0); }
  });

  const seek = $('pSeek');
  seek.addEventListener('input', () => {
    seeking = true;
    const dur = Number(seek.max) || 1;
    seek.style.setProperty('--p', (Number(seek.value) / dur) * 100 + '%');
    $('pPos').textContent = fmtTime(Number(seek.value));
  });
  seek.addEventListener('change', async () => {
    await engine.seek(Number(seek.value));
    seeking = false;
  });

  // 追加（ブラウザ版）・読み込み直し（アプリ版）
  $('addBtn').addEventListener('click', () => {
    if (mode === 'native') scan(true);
    else $('addMenu').hidden = !$('addMenu').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!$('addMenu').hidden && !e.target.closest('#addMenu, #addBtn')) $('addMenu').hidden = true;
  });
  $('addFiles').addEventListener('click', () => { $('addMenu').hidden = true; $('filePick').click(); });
  $('addDir').addEventListener('click', () => { $('addMenu').hidden = true; $('dirPick').click(); });
  $('clearLib').addEventListener('click', async () => {
    $('addMenu').hidden = true;
    if (!confirm('このブラウザに保存した曲をすべて削除しますか？（元のファイルは消えません）')) return;
    await engine.pause();
    await webStore.clear();
    artCache.clear();
    engine.queue = [];
    Object.assign(state, { id: null, index: -1, position: 0, duration: 0, playing: false });
    localStorage.removeItem('music.queue');
    await loadWebLibrary();
    render();
    emit();
  });
  for (const id of ['filePick', 'dirPick']) {
    $(id).addEventListener('change', async (e) => {
      const files = e.target.files;
      if (files?.length) await importFiles(files);
      e.target.value = '';
    });
  }

  addEventListener('popstate', render);

  // 定期的に再生位置を更新（アプリ版）・状態を保存
  setInterval(() => {
    if (document.hidden) return;
    if (state.playing) engine.poll();
  }, 500);
  setInterval(saveQueue, 5000);
  addEventListener('pagehide', saveQueue);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveQueue(); return; }
    engine.poll();
    // アプリに戻ったとき、しばらくぶりなら新しくダウンロードした曲を読み込む
    if (mode === 'native' && permission && Date.now() - lastScan > 30000) scan();
  });
}

async function start() {
  listeners.add(updatePlayerUI);
  native = await nativePlugins().catch(() => null);
  if (native) {
    mode = 'native';
    document.body.classList.add('native');
    engine = new NativeEngine(native.Player);
    artBackend = async (t) => {
      const { path } = await native.Library.artwork({ uri: t.uri, albumId: t.albumId || '', key: t.albumId ? undefined : 't' + t.id });
      return path ? native.Cap.convertFileSrc(path) : null;
    };
    $('addBtn').setAttribute('aria-label', '読み込み直す');
    $('addBtn').title = '読み込み直す';
    $('addBtn').replaceChildren(icon('refresh'));
  } else {
    mode = 'web';
    engine = new WebEngine(async (t) => {
      const blob = await webStore.file(t.id).catch(() => null);
      return blob ? URL.createObjectURL(blob) : null;
    });
    const urls = new Map();
    artBackend = async (t) => {
      if (!t.hasArt) {
        // 同じアルバムのほかの曲に画像があればそれを使う
        const a = lib.albumByKey.get(t.albumKey);
        if (!a?.tracks.some((x) => x.hasArt)) return null;
      }
      const key = t.artKey || t.albumKey;
      if (urls.has(key)) return urls.get(key);
      const blob = await webStore.art(key).catch(() => null);
      const url = blob ? URL.createObjectURL(blob) : null;
      urls.set(key, url);
      return url;
    };
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  bindControls();
  history.replaceState({ ...(history.state || {}), player: false }, '');

  if (mode === 'native') {
    await scan();
  } else {
    await loadWebLibrary();
    render();
  }
  await restoreQueue();
  updatePlayerUI();
}

start();
