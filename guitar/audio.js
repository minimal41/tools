/*
 * 再生：アコースティックギターの音を作って鳴らす（音源ファイルは使わない）
 *
 *   弦 … Karplus-Strong（物理モデルの弦）。小数の遅延でピッチを正しく合わせ、
 *         ピックで弾く位置・明るさ・音の減衰を弦ごとに変える。左右で少しだけ音程をずらして広がりを出す。
 *   胴 … ボディの共鳴（低い「胴鳴り」と中域の響き）を短いインパルス応答で畳み込む。
 *   部屋 … 小さめの部屋の残響を少し足す。
 */
let ctx = null;
let input = null; // 弦の音を入れるところ
const buffers = new Map();

function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    build();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/* ---------- 音の通り道 ---------- */

function build() {
  input = ctx.createGain();
  input.gain.value = 0.55;

  // ボディの共鳴
  const body = ctx.createConvolver();
  body.normalize = false;
  body.buffer = bodyImpulse();

  // 音色の仕上げ：低域の豊かさ、中低域のこもりを少し抜く、高域のきらびやかさ
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 140; low.gain.value = 3;
  const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 420; mud.Q.value = 1.1; mud.gain.value = -2.5;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 5200; air.gain.value = 3;
  const top = ctx.createBiquadFilter(); top.type = 'lowpass'; top.frequency.value = 12000; top.Q.value = 0.5;

  // 部屋の残響
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(1.7);
  const wet = ctx.createGain(); wet.gain.value = 0.22;
  const dry = ctx.createGain(); dry.gain.value = 1;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.25;
  const out = ctx.createGain(); out.gain.value = 0.9;

  input.connect(body).connect(low).connect(mud).connect(air).connect(top);
  top.connect(dry).connect(comp);
  top.connect(room).connect(wet).connect(comp);
  comp.connect(out).connect(ctx.destination);
}

/** ボディの共鳴：胴の固有の響き（ヘルムホルツ共鳴と表板の振動）を減衰する正弦波の和で作る */
function bodyImpulse() {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.25);
  const buf = ctx.createBuffer(2, len, sr);
  // [周波数, 強さ, 減衰の時間(秒)]
  const modes = [
    [102, 0.9, 0.09], [118, 0.35, 0.07], [196, 0.75, 0.06], [232, 0.4, 0.05], [288, 0.35, 0.045],
    [395, 0.28, 0.035], [520, 0.22, 0.03], [690, 0.18, 0.025], [920, 0.15, 0.02], [1250, 0.12, 0.016],
    [1720, 0.1, 0.012], [2450, 0.09, 0.009], [3300, 0.07, 0.007],
  ];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    d[0] = 1; // 弦の音そのもの
    for (const [f0, a, tau] of modes) {
      const f = f0 * (ch ? 1.012 : 0.994);
      const ph = ch ? 0.7 : 0;
      const w = 2 * Math.PI * f / sr;
      for (let i = 1; i < len; i++) d[i] += a * 0.045 * Math.exp(-i / (sr * tau)) * Math.sin(w * i + ph);
    }
  }
  return buf;
}

/** 部屋の残響：左右で別々の、なめらかに減衰するノイズ */
function roomImpulse(sec) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * sec);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // 時間がたつほど高い音から消える
      const k = Math.min(0.95, 0.25 + t * 0.6);
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      const pre = t < 0.012 ? 0 : 1;
      d[i] = pre * lp * Math.exp(-t * 6.9 / sec) * 1.6;
    }
  }
  return buf;
}

/* ---------- 弦 ---------- */

/** 1本の弦（Karplus-Strong）。detune は半音の何分の1かのずれ */
function string(out, freq, sr, opts) {
  const { t60, bright, pickPos, gain } = opts;
  const N = sr / freq;
  // 損失フィルタ（2点の重み付き平均）。S が小さいほど高い倍音が残って明るく、長く響く。S サンプル遅れる
  const S = 0.32;
  const L = Math.max(2, Math.floor(N - S));
  const frac = N - S - L;
  const C = (1 - frac) / (1 + frac); // 小数の遅延（オールパス）
  const rho = Math.pow(0.001, 1 / (freq * t60)); // 1周ごとの減衰

  // ピックで弾いた形：ノイズ → 明るさ（ローパス）→ 弾く位置（くし形フィルタ）
  const exc = new Float32Array(L);
  let lp = 0;
  for (let i = 0; i < L; i++) {
    lp += bright * ((Math.random() * 2 - 1) - lp);
    exc[i] = lp;
  }
  const p = Math.max(1, Math.round(pickPos * L));
  const line = new Float32Array(L);
  let mean = 0;
  for (let i = 0; i < L; i++) { line[i] = exc[i] - (i >= p ? exc[i - p] : 0); mean += line[i]; }
  mean /= L;
  let peak = 0;
  for (let i = 0; i < L; i++) { line[i] -= mean; peak = Math.max(peak, Math.abs(line[i])); }
  const norm = peak ? 1 / peak : 1;
  for (let i = 0; i < L; i++) line[i] *= norm;

  let idx = 0, prev = 0, apX = 0, apY = 0;
  for (let n = 0; n < out.length; n++) {
    const v = line[idx];
    const f = rho * ((1 - S) * v + S * prev);
    const ap = C * f + apX - C * apY;
    apX = f; apY = ap;
    prev = v;
    line[idx] = ap;
    idx = idx + 1 === L ? 0 : idx + 1;
    out[n] += v * gain;
  }
}

function pluckBuffer(midi, muted) {
  const key = (muted ? 'x' : '') + midi;
  if (buffers.has(key)) return buffers.get(key);
  const sr = ctx.sampleRate;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const sec = muted ? 0.09 : 5;
  const len = Math.floor(sr * sec);
  const buf = ctx.createBuffer(2, len, sr);
  // 低い弦ほど長く響く。高い音ほど明るさを少し抑える
  const t60 = muted ? 0.05 : Math.min(8, Math.max(3.5, 8 - (midi - 40) * 0.1));
  const bright = muted ? 0.2 : Math.min(0.72, 0.4 + (76 - midi) * 0.007); // 低めにして出だしの硬さを抑える
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // 2本ぶんの振動を少しずらして重ね、弦とボディの複雑な揺れを出す
    const cents = ch ? 1.6 : -1.2;
    string(d, freq * Math.pow(2, cents / 1200), sr, { t60, bright, pickPos: 0.13 + ch * 0.02, gain: 0.75 });
    string(d, freq * Math.pow(2, (cents * -0.5 + 0.4) / 1200), sr, { t60: t60 * 0.85, bright: bright * 0.9, pickPos: 0.2, gain: 0.25 });
    // 最後はなめらかに消す
    const fade = Math.floor(sr * (muted ? 0.02 : 0.4));
    for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
  }
  buffers.set(key, buf);
  return buf;
}

const ringing = new Array(6).fill(null);

/**
 * string: 0=6弦 … 5=1弦。muted: ブラッシング。velocity: 0〜1。
 * attack: 音の出だしを何秒かけて立ち上げるか（大きいほど柔らかい）
 */
export function pluck(str, midi, when, muted = false, velocity = 0.85, attack = 0.008) {
  ensure();
  const prev = ringing[str];
  if (prev) {
    try {
      // 同じ弦を弾き直すと、前の音は指やピックで止まる
      prev.g.gain.setTargetAtTime(0, when, 0.012);
      prev.src.stop(when + 0.15);
    } catch { /* もう止まっている */ }
  }
  const src = ctx.createBufferSource();
  src.buffer = pluckBuffer(midi, muted);
  const g = ctx.createGain();
  const peak = (muted ? 0.5 : 0.7) * velocity;
  // 出だしを少しだけゆっくり立ち上げて、弦に指やピックが当たる硬さを丸める
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak * 0.85, when + attack);
  g.gain.setTargetAtTime(peak, when + attack, attack * 1.5);
  // 低い弦は少し左、高い弦は少し右に置く
  let node = g;
  if (ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = (str - 2.5) * 0.06;
    g.connect(pan);
    node = pan;
  }
  src.connect(g);
  node.connect(input);
  src.start(when);
  ringing[str] = { src, g };
}

/** 鳴らす前に音を作っておく。'x' で始まるものはブラッシングの音 */
export function prepare(keys) {
  ensure();
  for (const k of keys) {
    const muted = String(k).startsWith('x');
    pluckBuffer(Number(String(k).replace('x', '')), muted);
  }
}

/** when の時点で、鳴っている弦をすべて止める（スタッカート） */
export function damp(when) {
  ensure();
  ringing.forEach((r) => {
    if (!r) return;
    try { r.g.gain.setTargetAtTime(0, when, 0.018); } catch { /* 無視 */ }
  });
}

export function now() { return ensure().currentTime; }

export function stopAll() {
  if (!ctx) return;
  const t = ctx.currentTime;
  ringing.forEach((r, i) => {
    if (!r) return;
    try { r.g.gain.setTargetAtTime(0, t, 0.05); r.src.stop(t + 0.4); } catch { /* 無視 */ }
    ringing[i] = null;
  });
}
