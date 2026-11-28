/*
 * MP3 の ID3 タグを読む（ブラウザ版で使う。Android アプリでは端末が読み取った情報を使う）
 *
 * readTags(file) → { title, artist, album, albumArtist, track, disc, year, picture: Blob | null }
 *
 * - ID3v2.2 / 2.3 / 2.4（文字コード ISO-8859-1・UTF-16・UTF-8）と、末尾の ID3v1 に対応
 * - 日本の古いソフトで書かれた「Shift_JIS のまま ISO-8859-1 扱い」のタグも読めるようにする
 * - ジャケットは APIC（v2.2 は PIC）。表紙（種類 3）を優先する
 */

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');
let sjis = null;
try { sjis = new TextDecoder('shift_jis', { fatal: true }); } catch { /* 対応していないブラウザ */ }

/** ISO-8859-1 と書かれた文字列。ASCII 以外を含むなら Shift_JIS か UTF-8 として読めるか試す */
function decodeLegacy(bytes) {
  let high = false;
  for (const b of bytes) if (b >= 0x80) { high = true; break; }
  if (!high) return latin1.decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* UTF-8 ではない */ }
  if (sjis) { try { return sjis.decode(bytes); } catch { /* Shift_JIS でもない */ } }
  return latin1.decode(bytes);
}

function decodeText(enc, bytes) {
  switch (enc) {
    case 1: { // UTF-16（BOM つき）
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be.decode(bytes.subarray(2));
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le.decode(bytes.subarray(2));
      return utf16le.decode(bytes);
    }
    case 2: return utf16be.decode(bytes);
    case 3: return utf8.decode(bytes);
    default: return decodeLegacy(bytes);
  }
}

/** 終端（UTF-16 は 00 00）までの長さ */
function termIndex(bytes, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    return bytes.length;
  }
  for (let i = start; i < bytes.length; i++) if (bytes[i] === 0) return i;
  return bytes.length;
}

const clean = (s) => s.replace(/\u0000+$/g, '').split('\u0000').filter(Boolean).join(' / ').trim();

function textFrame(data) {
  if (!data.length) return '';
  return clean(decodeText(data[0], data.subarray(1)));
}

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}
const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

/** 「非同期化」（FF 00 → FF）を戻す */
function unsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[j++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function picture(data, v2) {
  const enc = data[0];
  let p = 1, mime;
  if (v2) { // PIC: 形式 3 文字
    const fmt = latin1.decode(data.subarray(1, 4)).toLowerCase();
    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const end = termIndex(data, 1, 0);
    mime = latin1.decode(data.subarray(1, end)).toLowerCase() || 'image/jpeg';
    p = end + 1;
  }
  const type = data[p];
  p += 1;
  const dEnd = termIndex(data, p, enc);
  p = dEnd + (enc === 1 || enc === 2 ? 2 : 1);
  const img = data.subarray(p);
  if (!img.length) return null;
  if (!mime.includes('/')) mime = 'image/' + (mime === 'jpg' ? 'jpeg' : mime);
  // 中身から形式を確かめる（間違った MIME が書かれていることがある）
  if (img[0] === 0x89 && img[1] === 0x50) mime = 'image/png';
  else if (img[0] === 0xff && img[1] === 0xd8) mime = 'image/jpeg';
  return { type, blob: new Blob([img], { type: mime }) };
}

const firstNumber = (s) => { const m = /\d+/.exec(s || ''); return m ? parseInt(m[0], 10) : 0; };

function parseV2(buf) {
  const b = new Uint8Array(buf);
  const ver = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  let body = b.subarray(10, Math.min(b.length, 10 + size));
  if ((flags & 0x80) && ver < 4) body = unsync(body);
  let p = 0;
  if (flags & 0x40) { // 拡張ヘッダー
    p = ver === 4 ? syncsafe(body, 0) : be32(body, 0) + 4;
  }

  const tags = {};
  const pics = [];
  const idLen = ver === 2 ? 3 : 4;
  const headLen = ver === 2 ? 6 : 10;
  const validId = (o) => {
    for (let i = 0; i < idLen; i++) {
      const c = body[o + i];
      if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
    }
    return true;
  };

  while (p + headLen <= body.length && validId(p)) {
    const id = latin1.decode(body.subarray(p, p + idLen));
    let fsize;
    let fflags = 0;
    if (ver === 2) fsize = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5];
    else if (ver === 3) fsize = be32(body, p + 4);
    else {
      fsize = syncsafe(body, p + 4);
      // 2.4 なのに普通の数で大きさを書くソフトがある：次のフレームの位置で見分ける
      const plain = be32(body, p + 4);
      if (plain !== fsize && !validId(p + headLen + fsize) && validId(p + headLen + plain)) fsize = plain;
    }
    if (ver !== 2) fflags = body[p + 9];
    const start = p + headLen;
    if (fsize <= 0 || start + fsize > body.length) break;
    let data = body.subarray(start, start + fsize);
    p = start + fsize;

    if (ver === 3 && (fflags & 0xc0)) continue;          // 圧縮・暗号化は読まない
    if (ver === 4) {
      if (fflags & 0x0c) continue;
      if (fflags & 0x01) data = data.subarray(4);          // データ長の表示
      if (fflags & 0x02) data = unsync(data);
    }

    try {
      if (id === 'APIC' || id === 'PIC') {
        const pic = picture(data, id === 'PIC');
        if (pic) pics.push(pic);
      } else if (id[0] === 'T' && id !== 'TXXX' && id !== 'TXX') {
        const v = textFrame(data);
        if (v && !tags[id]) tags[id] = v;
      }
    } catch { /* 壊れたフレームは飛ばす */ }
  }

  const pick = (...ids) => { for (const i of ids) if (tags[i]) return tags[i]; return ''; };
  const cover = pics.find((x) => x.type === 3) || pics[0];
  return {
    title: pick('TIT2', 'TT2'),
    artist: pick('TPE1', 'TP1'),
    album: pick('TALB', 'TAL'),
    albumArtist: pick('TPE2', 'TP2'),
    track: firstNumber(pick('TRCK', 'TRK')),
    disc: firstNumber(pick('TPOS', 'TPA')),
    year: firstNumber(pick('TDRC', 'TYER', 'TYE', 'TDOR')),
    picture: cover ? cover.blob : null,
  };
}

function parseV1(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 128 || b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return null; // "TAG"
  const field = (o, n) => {
    let end = o;
    while (end < o + n && b[end] !== 0) end++;
    return decodeLegacy(b.subarray(o, end)).trim();
  };
  return {
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    year: firstNumber(field(93, 4)),
    track: b[125] === 0 && b[126] ? b[126] : 0,
  };
}

export async function readTags(file) {
  const out = { title: '', artist: '', album: '', albumArtist: '', track: 0, disc: 0, year: 0, picture: null };
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 && head[3] >= 2 && head[3] <= 4) { // "ID3"
      const size = syncsafe(head, 6);
      Object.assign(out, parseV2(await file.slice(0, 10 + size).arrayBuffer()));
    }
  } catch { /* タグが読めなくてもファイル名で並べる */ }
  if (!out.title || !out.artist || !out.album) {
    try {
      const v1 = file.size > 128 ? parseV1(await file.slice(file.size - 128).arrayBuffer()) : null;
      if (v1) for (const k of ['title', 'artist', 'album', 'year', 'track']) if (!out[k] && v1[k]) out[k] = v1[k];
    } catch { /* なし */ }
  }
  return out;
}
