/*
 * コードの音と押さえ方（ギター・標準チューニング）
 *
 * 押さえ方は決め打ちの表ではなく、指板の上で「コードの音だけを使い、最低音がルート（オンコードなら指定のベース音）、
 * 4フレットの幅に収まり、指4本（セーハは1本）で押さえられる」形を探して、押さえやすい順に並べる。
 *
 * 弦の並び：配列の 0 = 6弦（低いE）… 5 = 1弦（高いE）
 * フレット：数字（0 = 開放）か 'x'（弾かない）
 */

export const TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4

export const ROOTS = ['C', 'C#', 'D', 'E♭', 'E', 'F', 'F#', 'G', 'A♭', 'A', 'B♭', 'B'];
export const ROOT_LABELS = ['C', 'C# / D♭', 'D', 'D# / E♭', 'E', 'F', 'F# / G♭', 'G', 'G# / A♭', 'A', 'A# / B♭', 'B'];

// intervals: 半音。optional: 省いてよい音（5度）
export const QUALITIES = [
  { id: '', label: 'メジャー', iv: [0, 4, 7] },
  { id: 'm', label: 'マイナー', iv: [0, 3, 7] },
  { id: '7', label: 'セブンス', iv: [0, 4, 7, 10], optional: [7] },
  { id: 'M7', label: 'メジャーセブンス', iv: [0, 4, 7, 11], optional: [7] },
  { id: 'm7', label: 'マイナーセブンス', iv: [0, 3, 7, 10], optional: [7] },
  { id: 'sus4', label: 'サスフォー', iv: [0, 5, 7] },
  { id: '7sus4', label: 'セブンス・サスフォー', iv: [0, 5, 7, 10], optional: [7] },
  { id: 'sus2', label: 'サスツー', iv: [0, 2, 7] },
  { id: 'add9', label: 'アドナインス', iv: [0, 2, 4, 7], optional: [7] },
  { id: '6', label: 'シックス', iv: [0, 4, 7, 9], optional: [7] },
  { id: 'm6', label: 'マイナーシックス', iv: [0, 3, 7, 9], optional: [7] },
  { id: '9', label: 'ナインス', iv: [0, 2, 4, 7, 10], optional: [7] },
  { id: 'mM7', label: 'マイナー・メジャーセブンス', iv: [0, 3, 7, 11], optional: [7] },
  { id: 'm7-5', label: 'マイナーセブンス・フラットファイブ', iv: [0, 3, 6, 10] },
  { id: 'dim', label: 'ディミニッシュ', iv: [0, 3, 6] },
  { id: 'dim7', label: 'ディミニッシュセブンス', iv: [0, 3, 6, 9] },
  { id: 'aug', label: 'オーギュメント', iv: [0, 4, 8] },
];

const qualityById = Object.fromEntries(QUALITIES.map((q) => [q.id, q]));

/** コード名。bass は null かルートと別の音 */
export function chordName(root, quality, bass, transpose = 0) {
  const r = ROOTS[(root + transpose + 1200) % 12];
  const b = bass == null || bass === root ? '' : '/' + ROOTS[(bass + transpose + 1200) % 12];
  return r + quality + b;
}

const cache = new Map();

/** 押さえ方の候補（押さえやすい順）。各要素は 6本分のフレットの配列 */
export function voicings(root, quality, bass = null, limit = 10) {
  const key = `${root}|${quality}|${bass}`;
  if (!cache.has(key)) cache.set(key, withEasyShapes(search(root, quality, bass == null ? root : bass), root, quality, bass));
  return cache.get(key).slice(0, limit);
}

function search(root, quality, bassPc) {
  const q = qualityById[quality] || QUALITIES[0];
  const tones = new Set(q.iv.map((i) => (root + i) % 12));
  const required = new Set(q.iv.filter((i) => !(q.optional || []).includes(i)).map((i) => (root + i) % 12));
  const allowed = new Set([...tones, bassPc]);
  const found = new Map();

  // 4フレットの窓をずらしながら全部の組み合わせを試す
  for (let pos = 1; pos <= 12; pos++) {
    const options = [['x', 0, pos, pos + 1, pos + 2, pos + 3]];
    const frets = new Array(6);
    const walk = (s) => {
      if (s === 6) { check(frets.slice()); return; }
      for (const f of options[0]) {
        if (f === 'x') {
          // 弾かない弦は低い側から続けてだけ（最大2本）
          if (s > 1 || (s === 1 && frets[0] !== 'x')) continue;
        } else if (allowed.has((TUNING[s] + f) % 12) === false) continue;
        frets[s] = f;
        walk(s + 1);
      }
    };
    walk(0);
  }

  function check(fr) {
    const played = [];
    fr.forEach((f, s) => { if (f !== 'x') played.push({ s, f, pc: (TUNING[s] + f) % 12 }); });
    if (played.length < 4) return;
    if (played[0].pc !== bassPc) return;
    const pcs = new Set(played.map((n) => n.pc));
    for (const r of required) if (!pcs.has(r)) return;
    // オンコードのベース音（コードの音でないもの）はいちばん下だけ
    if (!tones.has(bassPc) && played.slice(1).some((n) => n.pc === bassPc)) return;
    const fretted = played.filter((n) => n.f > 0);
    const opens = played.length - fretted.length;
    let min = 0, max = 0;
    if (fretted.length) {
      min = Math.min(...fretted.map((n) => n.f));
      max = Math.max(...fretted.map((n) => n.f));
    }
    if (max - min > 3) return;
    if (opens && max > 7) return;
    const fingers = fingerCount(fr, fretted, min);
    if (fingers.count > 4) return;

    const mutes = 6 - played.length;
    const missing = tones.size - [...tones].filter((t) => pcs.has(t)).length;
    let score = min * 0.9 + fingers.count * 0.8 + mutes * 1.3 + (max - min) * 0.4 + missing * 1.2;
    if (fingers.barre) score += 1.5;
    if (opens && min > 3) score += 3 + opens;
    if (opens && min <= 3) score -= opens * 0.3;
    // 開放弦と高いフレットが混ざる形は押さえにくい
    if (opens && max >= 4) score += (max - 3) * 1.5;
    // 1弦がルートか3度だと響きが落ち着く（少しだけ優先）
    const top = played[played.length - 1].pc;
    if (top === root) score -= 0.2;
    if (isBarreTemplate(fr, root, quality)) score -= 2.5;
    const k = fr.join(',');
    if (!found.has(k) || found.get(k).score > score) found.set(k, { frets: fr, score, barre: fingers.barre });
  }

  const sorted = [...found.values()].sort((a, b) => a.score - b.score).map((v) => v.frets);
  // 1本だけ違う「ほぼ同じ形」は後ろへ回して、いろいろな位置の押さえ方が先に並ぶようにする
  const first = [], later = [];
  for (const fr of sorted) {
    const near = first.some((g) => g.reduce((n, f, i) => n + (f !== fr[i] ? 1 : 0), 0) <= 1);
    (near ? later : first).push(fr);
  }
  return first.concat(later);
}

// よく使うセーハの形（6弦ルート・5弦ルート）。ルートのフレットだけずらす
const TEMPLATES = {
  '': [[0, 2, 2, 1, 0, 0], ['x', 0, 2, 2, 2, 0]],
  m: [[0, 2, 2, 0, 0, 0], ['x', 0, 2, 2, 1, 0]],
  '7': [[0, 2, 0, 1, 0, 0], ['x', 0, 2, 0, 2, 0]],
  m7: [[0, 2, 0, 0, 0, 0], ['x', 0, 2, 0, 1, 0]],
  M7: [['x', 0, 2, 1, 2, 0]],
  sus4: [[0, 2, 2, 2, 0, 0], ['x', 0, 2, 2, 3, 0]],
  '7sus4': [[0, 2, 0, 2, 0, 0], ['x', 0, 2, 0, 3, 0]],
};
/*
 * よく使われる「簡単な押さえ方」。上の探し方ではベースがルートでなかったり、
 * 1弦を弾かなかったりして出てこないので、ここで足す（2番目あたりに並べる）。
 * キーは「ルートの音（C=0）|種類」
 */
const EASY = {
  '5|': [['x', 3, 3, 2, 1, 'x'], ['x', 3, 3, 2, 1, 1], ['x', 'x', 3, 2, 1, 'x']], // 簡単F（5弦はC）、その1弦も押さえる形
  '5|M7': [['x', 'x', 3, 2, 1, 0]],
  '5|m': [['x', 3, 3, 1, 1, 'x'], ['x', 'x', 3, 1, 1, 1]],
  '5|7': [['x', 3, 1, 2, 1, 'x']],
};

/** 簡単な押さえ方と、5弦ルートのセーハで1弦を弾かない形（B♭ x1333x など）を足す */
function withEasyShapes(list, root, quality, bass) {
  if (bass != null && bass !== root) return list;
  const out = list.slice();
  const has = (f) => out.some((g) => g.join(',') === f.join(','));
  const insertAt = (i, f) => { if (!has(f)) out.splice(Math.min(i, out.length), 0, f); };
  // 5弦ルートのセーハ（A の形）から1弦を外した形を、元の形のすぐ後ろへ
  for (const t of TEMPLATES[quality] || []) {
    if (t[0] !== 'x') continue;
    const r = (root - TUNING[1] % 12 + 12) % 12;
    if (r < 1 || r > 9) continue;
    const full = t.map((f) => (f === 'x' ? 'x' : f + r));
    const muted = full.slice(0, 5).concat('x');
    const i = out.findIndex((g) => g.join(',') === full.join(','));
    insertAt(i >= 0 ? i + 1 : out.length, muted);
  }
  (EASY[`${root}|${quality}`] || []).forEach((f, k) => insertAt(1 + k, f));
  return out;
}

function isBarreTemplate(fr, root, quality) {
  for (const t of TEMPLATES[quality] || []) {
    const string = t[0] === 'x' ? 1 : 0;
    const r = (root - TUNING[string] % 12 + 12) % 12;
    if (r < 1 || r > 9) continue;
    if (t.every((f, i) => (f === 'x' ? fr[i] === 'x' : fr[i] === f + r))) return true;
  }
  return false;
}

/** 指の数。いちばん低いフレットをセーハできるならセーハで数える */
function fingerCount(fr, fretted, min) {
  const plain = fretted.length;
  if (!fretted.length) return { count: 0, barre: false };
  const atMin = fretted.filter((n) => n.f === min);
  if (atMin.length < 2) return { count: plain, barre: false };
  const lo = atMin[0].s, hi = atMin[atMin.length - 1].s;
  for (let s = lo; s <= hi; s++) {
    const f = fr[s];
    if (f === 'x' || f < min) return { count: plain, barre: false };
  }
  const count = 1 + fretted.filter((n) => n.f > min).length;
  return count < plain ? { count, barre: true } : { count: plain, barre: false };
}

/** ダイアグラムに描くための情報：表示を始めるフレット、セーハ */
export function diagramInfo(frets) {
  const fretted = frets.filter((f) => f !== 'x' && f > 0);
  const max = fretted.length ? Math.max(...fretted) : 0;
  const min = fretted.length ? Math.min(...fretted) : 0;
  const start = max <= 4 ? 1 : min;
  let barre = null;
  if (fretted.length) {
    const idx = frets.map((f, s) => (f === min ? s : -1)).filter((s) => s >= 0);
    if (idx.length >= 2) {
      const lo = idx[0], hi = idx[idx.length - 1];
      let ok = true;
      for (let s = lo; s <= hi; s++) if (frets[s] === 'x' || frets[s] < min) ok = false;
      const plain = fretted.length;
      const withBarre = 1 + fretted.filter((f) => f > min).length;
      if (ok && withBarre < plain && (plain > 4 || hi - lo >= 3)) barre = { fret: min, from: lo, to: hi };
    }
  }
  return { start, barre };
}

/** 弦とフレット（カポからの数）から MIDI ノート番号 */
export function midiOf(string, fret, capo = 0) {
  return TUNING[string] + capo + fret;
}
