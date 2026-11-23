/*
 * アコースティックギターの1音を作る（Web Audio を使わない計算だけの部分）
 *
 * 「コミューテッド合成」という、アコギの物理モデルでよく使われるやり方：
 *   1. ピックや指が弦をはじく、なめらかな力の形（パルス）を作り、弾く位置の分だけ打ち消し合わせる
 *   2. それにギターの胴の響き（ボディのインパルス応答）を先に畳み込む
 *   3. その信号で弦（遅延線のループ）を鳴らし続ける
 * 胴の響きを弦の前に入れるので、1音ごとに木の鳴りが乗り、音が自然になる。
 */

/* ---------- 乱数（毎回同じ音になるように種から作る） ---------- */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 胴の響き ---------- */

const bodyCache = new Map();

/**
 * ギターの胴のインパルス応答（左右で少し違う）。
 * 低い方は実際のアコギで目立つ共鳴（空気の共鳴 ≒ 100Hz、表板 ≒ 200Hz など）、
 * 高い方は細かい共鳴をたくさん重ね、最後に木の「カサッ」とした短い響きを足す
 */
export function bodyIR(sr, ch) {
  const key = `${sr}|${ch}`;
  if (bodyCache.has(key)) return bodyCache.get(key);
  const len = Math.floor(sr * 0.2);
  const ir = new Float32Array(len);
  ir[0] = 1;
  const rand = rng(1234 + ch * 77);
  // [周波数, 強さ, 減衰の時間(秒)]
  const modes = [
    [98, 1.0, 0.11], [114, 0.3, 0.08], [196, 0.85, 0.085], [226, 0.45, 0.065], [289, 0.38, 0.05],
    [384, 0.32, 0.042], [452, 0.26, 0.036],
  ];
  // 細かい共鳴（500Hz〜6kHz に約50本）
  for (let i = 0; i < 50; i++) {
    const f = 500 * Math.pow(12, (i + rand()) / 50);
    modes.push([f, 0.3 * Math.pow(500 / f, 0.45) * (0.5 + rand()), 0.03 * Math.pow(500 / f, 0.55) * (0.6 + 0.8 * rand())]);
  }
  for (const [f0, a, tau] of modes) {
    const f = f0 * (1 + (ch ? 0.008 : -0.005));
    const w = (2 * Math.PI * f) / sr;
    const ph = rand() * Math.PI * 2;
    const k = -1 / (sr * tau);
    const amp = a * 0.05;
    const n = Math.min(len, Math.ceil(sr * tau * 7));
    for (let i = 1; i < n; i++) ir[i] += amp * Math.exp(k * i) * Math.sin(w * i + ph);
  }
  // 木の短い響き（高い音のノイズがすぐ消える）
  let lp = 0;
  const nn = Math.floor(sr * 0.03);
  for (let i = 1; i < nn; i++) {
    lp += 0.55 * ((rand() * 2 - 1) - lp);
    ir[i] += lp * 0.09 * Math.exp(-i / (sr * 0.006));
  }
  bodyCache.set(key, ir);
  return ir;
}

/* ---------- 弦 ---------- */

/**
 * 1本の弦を鳴らして out に足す。
 * x：弦を鳴らす力（胴の響き込み）。t60：音が 1/1000 になるまでの秒数。loss：高い倍音の消えやすさ（0〜0.5）
 */
function runString(out, x, freq, sr, t60, loss, gain) {
  const w0 = (2 * Math.PI * freq) / sr;
  const a = loss;
  // 損失フィルタ（1次のローパス）の、基音での位相の遅れと音量の下がり
  const lpDelay = Math.atan2(a * Math.sin(w0), 1 - a * Math.cos(w0)) / w0;
  const lpMag = (1 - a) / Math.sqrt(1 - 2 * a * Math.cos(w0) + a * a);
  const N = sr / freq;
  const L = Math.max(2, Math.floor(N - lpDelay - 0.5));
  const d = N - lpDelay - L; // 残りの小数の遅延（0.5〜1.5）をオールパスで作る
  const C = (1 - d) / (1 + d);
  const g = Math.pow(0.001, 1 / (freq * t60)) / lpMag;
  const line = new Float32Array(L);
  let idx = 0, lpS = 0, apX = 0, apY = 0;
  const xl = x.length;
  for (let n = 0; n < out.length; n++) {
    const old = line[idx];
    lpS = (1 - a) * old + a * lpS;
    const f = g * lpS;
    const ap = C * f + apX - C * apY;
    apX = f; apY = ap;
    const y = (n < xl ? x[n] : 0) + ap;
    line[idx] = y;
    idx = idx + 1 === L ? 0 : idx + 1;
    out[n] += y * gain;
  }
}

/** 弦をはじく力：なめらかな山形のパルスから、弾いた位置で跳ね返る分を引き、胴の響きを畳み込む */
function excitation(sr, freq, bright, pickPos, ir) {
  const width = Math.max(2, Math.round(sr * (0.00035 + (1 - bright) * 0.0016)));
  const p = Math.max(1, Math.round((pickPos * sr) / freq));
  const pulse = new Float32Array(width + p);
  for (let i = 0; i < width; i++) {
    const v = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / width);
    pulse[i] += v;
    pulse[i + p] -= v;
  }
  const out = new Float32Array(pulse.length + ir.length);
  for (let i = 0; i < pulse.length; i++) {
    const v = pulse[i];
    if (!v) continue;
    for (let j = 0; j < ir.length; j++) out[i + j] += v * ir[j];
  }
  return out;
}

/**
 * 1音（左右2チャンネル）。muted：ブラッシング（弦をミュートして弾く短い音）
 * 戻り値 [左, 右]
 */
export function renderNote(midi, sr, { muted = false, seconds } = {}) {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const sec = seconds ?? (muted ? 0.1 : 5);
  const len = Math.floor(sr * sec);
  // 低い弦ほど長く響く
  const t60 = muted ? 0.06 : Math.min(8, Math.max(3.5, 8 - (midi - 40) * 0.1));
  // 高い倍音の消えやすさ：高い音ほど小さく（1秒あたりのループ回数が多いので、同じ値だとすぐこもる）
  const loss = muted ? 0.6 : Math.min(0.3, Math.max(0.06, 0.3 - (midi - 40) * 0.006));
  const bright = muted ? 0.15 : Math.min(0.8, 0.5 + (76 - midi) * 0.005);
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const out = new Float32Array(len);
    const ir = bodyIR(sr, ch);
    const x = excitation(sr, freq, bright, ch ? 0.145 : 0.125, ir);
    // 弦の2方向の振動（わずかに音程と減衰が違う）を重ねて、自然なうねりを出す
    const c1 = ch ? 0.35 : -0.3;
    runString(out, x, freq * Math.pow(2, c1 / 1200), sr, t60, loss, 0.78);
    runString(out, x, freq * Math.pow(2, (c1 + 0.6) / 1200), sr, t60 * 0.75, Math.min(0.6, loss * 1.3), 0.26);
    chans.push(out);
  }
  // 音の大きさをそろえる（はじめの 0.15 秒の平均の大きさで合わせる）
  const m = Math.min(len, Math.floor(sr * 0.15));
  let e = 0;
  for (const c of chans) for (let i = 0; i < m; i++) e += c[i] * c[i];
  const rms = Math.sqrt(e / (m * 2)) || 1;
  let k = (muted ? 0.12 : 0.17) / rms;
  let peak = 0;
  for (const c of chans) for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(c[i] * k));
  if (peak > 0.95) k *= 0.95 / peak;
  const fade = Math.floor(sr * (muted ? 0.02 : 0.4));
  for (const c of chans) {
    for (let i = 0; i < len; i++) c[i] *= k;
    for (let i = 0; i < fade; i++) c[len - 1 - i] *= i / fade;
  }
  return chans;
}
