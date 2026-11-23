/*
 * 再生：アコースティックギターの音を作って鳴らす（音源ファイルは使わない）
 *
 *   1音 … synth.js（胴の響きを弦の前に入れる「コミューテッド合成」の物理モデル）
 *   仕上げ … 軽い音色の調整と、小さめの部屋の残響（はじめの反射＋なめらかな残り）
 */
import { renderNote } from './synth.js';
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
  input.gain.value = 1.1; // 1音は平均の大きさでそろえてある（山の高さは 0.3〜0.6 くらい）

  // 音色の仕上げ（胴の響きは1音ずつに入っているので、ここは軽く）
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 120; low.gain.value = 1.5;
  const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 380; mud.Q.value = 1; mud.gain.value = -1.5;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 7000; air.gain.value = 1.5;
  const top = ctx.createBiquadFilter(); top.type = 'lowpass'; top.frequency.value = 14000; top.Q.value = 0.5;

  // 部屋の残響
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(1.7);
  const wet = ctx.createGain(); wet.gain.value = 0.22;
  const dry = ctx.createGain(); dry.gain.value = 1;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.25;
  const out = ctx.createGain(); out.gain.value = 0.9;

  input.connect(low).connect(mud).connect(air).connect(top);
  top.connect(dry).connect(comp);
  top.connect(room).connect(wet).connect(comp);
  comp.connect(out).connect(ctx.destination);
}

/** 部屋の残響：左右で別々の、なめらかに減衰するノイズ */
function roomImpulse(sec) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * sec);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // はじめの反射（壁や床からの数本の跳ね返り）
    const taps = ch ? [[0.011, 0.32], [0.019, 0.22], [0.027, 0.18], [0.041, 0.12]] : [[0.009, 0.3], [0.016, 0.24], [0.031, 0.16], [0.037, 0.13]];
    for (const [t, a] of taps) d[Math.floor(t * sr)] += a;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // 時間がたつほど高い音から消える
      const k = Math.min(0.95, 0.25 + t * 0.6);
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      const pre = t < 0.012 ? 0 : 1;
      d[i] += pre * lp * Math.exp(-t * 6.9 / sec) * 1.6;
    }
  }
  return buf;
}

/* ---------- 1音 ---------- */

function pluckBuffer(midi, muted) {
  const key = (muted ? 'x' : '') + midi;
  if (buffers.has(key)) return buffers.get(key);
  const sr = ctx.sampleRate;
  const [l, r] = renderNote(midi, sr, { muted });
  const buf = ctx.createBuffer(2, l.length, sr);
  buf.copyToChannel(l, 0);
  buf.copyToChannel(r, 1);
  buffers.set(key, buf);
  return buf;
}

// 鳴っている弦。キーは「パートの番号:弦」（パートが違えば同じ弦でも止め合わない）
const ringing = new Map();
const keyOf = (voice, str) => `${voice}:${str}`;
// パートごとの左右の位置（1つ目は真ん中、2つ目は右、3つ目は左…）
const VOICE_PAN = [0, 0.32, -0.32, 0.18, -0.18];

/**
 * string: 0=6弦 … 5=1弦。muted: ブラッシング。velocity: 0〜1。
 * attack: 音の出だしを何秒かけて立ち上げるか（大きいほど柔らかい）
 */
export function pluck(str, midi, when, muted = false, velocity = 0.85, attack = 0.008, gliss = null, voice = 0) {
  ensure();
  const prev = ringing.get(keyOf(voice, str));
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
    pan.pan.value = Math.max(-1, Math.min(1, (str - 2.5) * 0.06 + VOICE_PAN[voice % VOICE_PAN.length]));
    g.connect(pan);
    node = pan;
  }
  src.connect(g);
  node.connect(input);
  let rate = 1;
  if (gliss) {
    // グリッサンド（下から入る）：低いところから目的の音まで音程を上げる
    src.playbackRate.setValueAtTime(Math.pow(2, gliss.from / 12), when);
    src.playbackRate.exponentialRampToValueAtTime(1, when + gliss.time);
  }
  src.start(when);
  ringing.set(keyOf(voice, str), { src, g, rate });
}

/**
 * 鳴っている弦の音程を、start から end までに semis 半音ずらす（スライド・グリッサンド）。
 * fade なら、ずらしながら消していく。鳴っている音がなければ false
 */
export function slide(str, semis, start, end, fade = false, voice = 0) {
  ensure();
  const r = ringing.get(keyOf(voice, str));
  if (!r) return false;
  const next = r.rate * Math.pow(2, semis / 12);
  try {
    r.src.playbackRate.setValueAtTime(r.rate, start);
    r.src.playbackRate.exponentialRampToValueAtTime(next, end);
    if (fade) r.g.gain.setTargetAtTime(0, start, (end - start) / 2.5);
  } catch { return false; }
  r.rate = next;
  return true;
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
export function damp(when, voice = 0) {
  ensure();
  ringing.forEach((r, key) => {
    if (!r || !key.startsWith(`${voice}:`)) return;
    try { r.g.gain.setTargetAtTime(0, when, 0.018); } catch { /* 無視 */ }
  });
}

export function now() { return ensure().currentTime; }

export function stopAll() {
  if (!ctx) return;
  const t = ctx.currentTime;
  ringing.forEach((r) => {
    try { r.g.gain.setTargetAtTime(0, t, 0.05); r.src.stop(t + 0.4); } catch { /* 無視 */ }
  });
  ringing.clear();
}
