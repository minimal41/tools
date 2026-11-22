/*
 * 再生：弦をはじいた音を Karplus-Strong で作って鳴らす（音源ファイルは使わない）
 */
let ctx = null;
let master = null;
const buffers = new Map();

function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function pluckBuffer(midi, muted) {
  const key = muted ? 'x' + midi : midi;
  if (buffers.has(key)) return buffers.get(key);
  const sr = ctx.sampleRate;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const len = Math.floor(sr * (muted ? 0.08 : 2.6));
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const period = Math.max(2, Math.round(sr / freq));
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
  // 少しなめらかにして耳ざわりを和らげる
  for (let i = 1; i < period; i++) ring[i] = (ring[i] + ring[i - 1]) / 2;
  const damp = muted ? 0.9 : 0.996 - Math.min(0.006, freq / 200000);
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const next = (idx + 1) % period;
    const v = ring[idx];
    out[i] = v;
    ring[idx] = (v + ring[next]) * 0.5 * damp;
    idx = next;
  }
  buffers.set(key, buf);
  return buf;
}

const ringing = new Array(6).fill(null);

/** string: 0=6弦 … 5=1弦。muted: ブラッシング */
export function pluck(string, midi, when, muted = false) {
  ensure();
  const prev = ringing[string];
  if (prev) {
    try {
      prev.g.gain.setTargetAtTime(0, when, 0.015);
      prev.src.stop(when + 0.1);
    } catch { /* もう止まっている */ }
  }
  const src = ctx.createBufferSource();
  src.buffer = pluckBuffer(midi, muted);
  const g = ctx.createGain();
  g.gain.value = muted ? 0.6 : 0.8;
  src.connect(g).connect(master);
  src.start(when);
  ringing[string] = { src, g };
}

export function now() { return ensure().currentTime; }

export function stopAll() {
  if (!ctx) return;
  const t = ctx.currentTime;
  ringing.forEach((r, i) => {
    if (!r) return;
    try { r.g.gain.setTargetAtTime(0, t, 0.02); r.src.stop(t + 0.2); } catch { /* 無視 */ }
    ringing[i] = null;
  });
}
