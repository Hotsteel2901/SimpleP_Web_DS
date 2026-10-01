/**
 * music.js —— 程序化音乐：曲目表 + 前视步伐调度器（lookahead step sequencer）
 *
 * 设计要点：
 *  1. 全部音色实时合成（振荡器 / 噪声 / FM / 滤波包络），不加载任何外部文件。
 *  2. 每个 MusicName 对应 TRACKS 里的一份编曲配置（tempo / 音阶 / 和弦进行 /
 *     pad / bass / 琶音 / 和弦 stab / 主旋律 / 鼓组 / 黑胶底噪），因此每首曲子在
 *     速度、调式、配器上都明显不同，听感可区分。
 *  3. 调度器按 16 分音符网格推进：update() 每帧把未来 LOOKAHEAD 秒内到期的音符
 *     排进 WebAudio 时间线，因此循环无缝、不受帧率抖动影响。
 *  4. MusicPlayer 负责切歌交叉淡入淡出；victory / failure 是一次性 jingle，
 *     播完自动淡回之前那首曲子。
 *  5. 音量总线与混响由 audio.js 提供，本文件只负责“把音符写进时间线”。
 */

/** 前视时间（秒）：每帧预排这么久之内的音符 */
const LOOKAHEAD = 0.12;

/* ================================================================== 乐理工具 */

/** 常用音阶（半音偏移） */
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  majorPent: [0, 2, 4, 7, 9],
};

/** 和弦类型（相对根音的半音堆叠） */
const CHORDS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
};

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** 音阶级数 -> MIDI 音高（可为负数 / 越八度） */
export function deg(key, scale, d) {
  const s = SCALES[scale] || SCALES.major;
  const n = s.length;
  const oct = Math.floor(d / n);
  const idx = ((d % n) + n) % n;
  return key + 12 * oct + s[idx];
}

/** 和弦音（MIDI 数组） */
function chordNotes(rootMidi, q, oct = 0) {
  const t = CHORDS[q] || CHORDS.maj;
  const out = new Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = rootMidi + t[i] + 12 * oct;
  return out;
}

/** 旋律生成：spec = [[起始步, 音阶级数, 时值(步)], ...] */
function melody(len, key, scale, spec) {
  const arr = new Array(len).fill(null);
  for (let i = 0; i < spec.length; i++) {
    const e = spec[i];
    if (e[0] >= 0 && e[0] < len) arr[e[0]] = { midi: deg(key, scale, e[1]), len: e[2] || 2 };
  }
  return arr;
}

/** 旋律生成（半音偏移版，用于 jingle） */
function melodyAbs(len, key, spec) {
  const arr = new Array(len).fill(null);
  for (let i = 0; i < spec.length; i++) {
    const e = spec[i];
    if (e[0] >= 0 && e[0] < len) arr[e[0]] = { midi: key + e[1], len: e[2] || 2 };
  }
  return arr;
}

/** 节奏型取字符：'.'=休止，'x'=普通，'X'=重音，'o'=轻音；支持按小节轮换的数组 */
function patAt(pat, step, bar) {
  if (!pat) return 0;
  const s = Array.isArray(pat) ? pat[bar % pat.length] : pat;
  if (!s) return 0;
  const c = s.charAt(step % 16);
  return c === 'X' ? 1 : c === 'x' ? 0.72 : c === 'o' ? 0.45 : 0;
}

const EMPTY = [];
/** 允许配置写单个对象或数组 */
const norm = (x) => (x ? (Array.isArray(x) ? x : [x]) : EMPTY);

/* ================================================================== 底层发声 */

/** 生成白噪声缓冲（若外部未提供） */
function localNoise(ctx, seconds) {
  const rate = ctx.sampleRate || 44100;
  const len = Math.max(1, Math.floor(rate * Math.min(4, Math.max(0.1, seconds))));
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** 音源结束后断开整条子图，避免长连接残留 */
function autoKill(sources, nodes) {
  const last = sources.length ? sources[sources.length - 1] : null;
  if (!last) {
    for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) { /* 忽略 */ } }
    return;
  }
  last.onended = () => {
    for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) { /* 忽略 */ } }
  };
}

/** pad：多个失谐振荡器 -> 低通 -> 慢起慢落，带立体声展开 */
function padChord(ctx, dest, time, freqs, dur, level, cfg) {
  const a = Math.min(cfg.attack ?? 0.8, dur * 0.8);
  const rel = cfg.release ?? 1.2;
  const end = time + dur;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cfg.cutoff ?? 1800, time);
  lp.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(Math.max(0.001, level), time + a);
  g.gain.setValueAtTime(Math.max(0.001, level), end);
  g.gain.exponentialRampToValueAtTime(0.0001, end + rel);
  g.connect(lp);
  lp.connect(dest);
  const srcs = [];
  const spread = cfg.spread ?? 0.5;
  const per = 1 / Math.max(1, freqs.length * 2.2);
  for (let i = 0; i < freqs.length; i++) {
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    let dst = g;
    if (pan) {
      const pos = freqs.length > 1 ? (i / (freqs.length - 1)) * 2 - 1 : 0;
      pan.pan.value = pos * spread;
      pan.connect(g);
      dst = pan;
    }
    for (let s = -1; s <= 1; s += 2) {
      const o = ctx.createOscillator();
      o.type = cfg.wave || 'sawtooth';
      o.frequency.value = freqs[i];
      o.detune.value = s * (cfg.detune ?? 7);
      const og = ctx.createGain();
      og.gain.value = per;
      o.connect(og);
      og.connect(dst);
      o.start(time);
      o.stop(end + rel + 0.05);
      srcs.push(o);
    }
  }
  autoKill(srcs, [g, lp]);
}

/** 低音：sub / pluck / drive / sync */
function bassNote(ctx, dest, time, freq, durIn, level, inst) {
  const dur = Math.max(0.12, durIn);
  const end = time + dur;
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = inst === 'drive' ? 7 : 3;
  g.connect(lp);
  lp.connect(dest);
  const oscs = [];
  const add = (type, f, amp, det) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (det) o.detune.value = det;
    const og = ctx.createGain();
    og.gain.value = amp;
    o.connect(og);
    og.connect(g);
    oscs.push(o);
  };
  let cutoff = Math.min(2400, freq * 8);
  if (inst === 'sub') {
    add('sine', freq, 0.9);
    add('triangle', freq, 0.22);
    cutoff = 260;
  } else if (inst === 'pluck') {
    add('triangle', freq, 0.7);
    add('sawtooth', freq, 0.3, 7);
    cutoff = Math.min(3400, freq * 10);
  } else if (inst === 'drive') {
    add('sawtooth', freq, 0.8);
    add('square', freq * 0.5, 0.3);
    cutoff = Math.min(2600, freq * 13);
  } else {
    add('sawtooth', freq, 0.7);
    add('triangle', freq, 0.28, -9);
    cutoff = Math.min(2000, freq * 7);
  }
  lp.frequency.setValueAtTime(cutoff, time);
  if (inst === 'pluck') {
    try { lp.frequency.exponentialRampToValueAtTime(Math.max(110, freq * 2), time + Math.min(dur, 0.35)); } catch (e) { /* 忽略 */ }
  }
  const atk = inst === 'sub' ? 0.03 : 0.008;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(Math.max(0.001, level), time + atk);
  g.gain.setValueAtTime(Math.max(0.001, level), Math.max(time + atk + 0.01, end - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, end + 0.06);
  const stop = end + 0.1;
  for (let i = 0; i < oscs.length; i++) { oscs[i].start(time); oscs[i].stop(stop); }
  autoKill(oscs, [g, lp]);
}

/** 拨弦 / 拨奏（琶音常用） */
function pluckNote(ctx, dest, time, freq, durIn, level, cfg) {
  const dur = Math.max(0.12, durIn);
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 5;
  const o = ctx.createOscillator();
  o.type = (cfg && cfg.wave) || 'sawtooth';
  o.frequency.value = freq;
  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.value = freq * 2.005;
  const g2 = ctx.createGain();
  g2.gain.value = 0.25;
  o.connect(lp);
  o2.connect(g2);
  g2.connect(lp);
  lp.connect(g);
  g.connect(dest);
  lp.frequency.setValueAtTime(Math.min(6500, freq * 11), time);
  try { lp.frequency.exponentialRampToValueAtTime(Math.max(180, freq * 1.4), time + dur); } catch (e) { /* 忽略 */ }
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(Math.max(0.001, level), time + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur + 0.05);
  o.start(time);
  o2.start(time);
  o.stop(time + dur + 0.09);
  o2.stop(time + dur + 0.09);
  autoKill([o, o2], [g, lp, g2]);
}

/** 钟声：FM（载波正弦 + 非整数比调制，调制指数快速衰减） */
function bellNote(ctx, dest, time, freq, durIn, level) {
  const dur = Math.max(0.5, durIn);
  const car = ctx.createOscillator();
  car.type = 'sine';
  car.frequency.value = freq;
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = freq * 3.53;
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(freq * 4, time);
  try { mg.gain.exponentialRampToValueAtTime(Math.max(1, freq * 0.05), time + Math.max(0.25, dur * 0.5)); } catch (e) { /* 忽略 */ }
  mod.connect(mg);
  mg.connect(car.frequency);
  const g = ctx.createGain();
  car.connect(g);
  g.connect(dest);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(Math.max(0.001, level), time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  car.start(time);
  mod.start(time);
  car.stop(time + dur + 0.05);
  mod.stop(time + dur + 0.05);
  autoKill([car, mod], [g, mg]);
}

/** 电钢琴：FM 快速衰减 + 轻微颤音 */
function epNote(ctx, dest, time, freq, durIn, level) {
  const dur = Math.max(0.28, durIn);
  const car = ctx.createOscillator();
  car.type = 'sine';
  car.frequency.value = freq;
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = freq * 2;
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(freq * 2.2, time);
  try { mg.gain.exponentialRampToValueAtTime(Math.max(1, freq * 0.05), time + 0.25); } catch (e) { /* 忽略 */ }
  mod.connect(mg);
  mg.connect(car.frequency);
  const trem = ctx.createGain();
  trem.gain.value = 0.94;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 5.2;
  const lg = ctx.createGain();
  lg.gain.value = 0.06;
  lfo.connect(lg);
  lg.connect(trem.gain);
  const g = ctx.createGain();
  car.connect(trem);
  trem.connect(g);
  g.connect(dest);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(Math.max(0.001, level), time + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  car.start(time);
  mod.start(time);
  lfo.start(time);
  const stop = time + dur + 0.06;
  car.stop(stop);
  mod.stop(stop);
  lfo.stop(stop);
  autoKill([car, mod], [g, mg, lg, trem]);
}

/** 锯齿主音（号角 / 弦乐 / 哀鸣），可选颤音 */
function sawLead(ctx, dest, time, freq, durIn, level, cfg) {
  const dur = Math.max(0.12, durIn);
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = cfg && cfg.q ? cfg.q : 1.2;
  const o = ctx.createOscillator();
  o.type = (cfg && cfg.wave) || 'sawtooth';
  o.frequency.value = freq;
  const o2 = ctx.createOscillator();
  o2.type = 'sawtooth';
  o2.frequency.value = freq;
  o2.detune.value = cfg && cfg.detune != null ? cfg.detune : 9;
  const og = ctx.createGain();
  og.gain.value = 0.55;
  o.connect(lp);
  o2.connect(og);
  og.connect(lp);
  lp.connect(g);
  g.connect(dest);
  let lfo = null;
  let lg = null;
  if (cfg && cfg.vib) {
    lfo = ctx.createOscillator();
    lfo.frequency.value = cfg.vibRate ?? 5.5;
    lg = ctx.createGain();
    lg.gain.value = cfg.vib;
    lfo.connect(lg);
    lg.connect(o.detune);
    lfo.connect(lg);
  }
  const cut = (cfg && cfg.cutoff) || Math.min(5200, freq * 6);
  const atk = Math.min(cfg && cfg.attack ? cfg.attack : 0.02, dur * 0.5);
  lp.frequency.setValueAtTime(cut * 0.55, time);
  lp.frequency.linearRampToValueAtTime(cut, time + Math.min(0.14, dur));
  lp.frequency.setValueAtTime(cut, time + dur * 0.7);
  try { lp.frequency.exponentialRampToValueAtTime(Math.max(180, cut * 0.4), time + dur + 0.12); } catch (e) { /* 忽略 */ }
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(Math.max(0.001, level), time + atk);
  g.gain.setValueAtTime(Math.max(0.001, level), time + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur + 0.16);
  const stop = time + dur + 0.22;
  o.start(time);
  o2.start(time);
  o.stop(stop);
  o2.stop(stop);
  if (lfo) { lfo.start(time); lfo.stop(stop); }
  autoKill([o, o2], [g, lp, og]);
}

/** 纯正弦长音（辽阔 pad 的旋律层） */
function sineNote(ctx, dest, time, freq, durIn, level) {
  const dur = Math.max(0.15, durIn);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = freq;
  const o2 = ctx.createOscillator();
  o2.type = 'sine';
  o2.frequency.value = freq * 2;
  const g2 = ctx.createGain();
  g2.gain.value = 0.12;
  const g = ctx.createGain();
  o.connect(g);
  o2.connect(g2);
  g2.connect(g);
  g.connect(dest);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(Math.max(0.001, level), time + 0.06);
  g.gain.setValueAtTime(Math.max(0.001, level), time + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur + 0.12);
  const stop = time + dur + 0.18;
  o.start(time);
  o2.start(time);
  o.stop(stop);
  o2.stop(stop);
  autoKill([o, o2], [g, g2]);
}

/** 按乐器名派发一个音符 */
function playNote(ctx, dest, inst, time, midi, dur, level, cfg) {
  const f = midiToFreq(midi);
  switch (inst) {
    case 'bell': bellNote(ctx, dest, time, f, dur, level); break;
    case 'ep': epNote(ctx, dest, time, f, dur, level); break;
    case 'pluck': pluckNote(ctx, dest, time, f, dur, level, cfg); break;
    case 'saw': sawLead(ctx, dest, time, f, dur, level, cfg); break;
    case 'sub':
    case 'drive': bassNote(ctx, dest, time, f, dur, level, inst); break;
    default: sineNote(ctx, dest, time, f, dur, level); break;
  }
}

/* ------------------------------------------------------------------ 鼓组 */
function kickDrum(ctx, dest, time, level) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, time);
  try { o.frequency.exponentialRampToValueAtTime(42, time + 0.16); } catch (e) { /* 忽略 */ }
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.001, level), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
  o.connect(g);
  g.connect(dest);
  o.start(time);
  o.stop(time + 0.34);
  autoKill([o], [g]);
}

function snareDrum(ctx, dest, time, level, noise) {
  const src = ctx.createBufferSource();
  src.buffer = noise(0.4);
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.001, level), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.17);
  src.connect(bp);
  bp.connect(g);
  g.connect(dest);
  const tone = ctx.createOscillator();
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(215, time);
  try { tone.frequency.exponentialRampToValueAtTime(150, time + 0.1); } catch (e) { /* 忽略 */ }
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(Math.max(0.001, level * 0.5), time);
  tg.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
  tone.connect(tg);
  tg.connect(dest);
  src.start(time);
  tone.start(time);
  src.stop(time + 0.2);
  tone.stop(time + 0.13);
  // 噪声尾巴最长，放在最后作为回收信号
  autoKill([tone, src], [g, bp, tg]);
}

function hatDrum(ctx, dest, time, level, open, noise) {
  const src = ctx.createBufferSource();
  src.buffer = noise(0.3);
  src.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7400;
  const g = ctx.createGain();
  const d = open ? 0.2 : 0.042;
  g.gain.setValueAtTime(Math.max(0.001, level), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + d);
  src.connect(hp);
  hp.connect(g);
  g.connect(dest);
  src.start(time);
  src.stop(time + d + 0.03);
  autoKill([src], [g, hp]);
}

function clapDrum(ctx, dest, time, level, noise) {
  const offs = [0, 0.011, 0.023];
  for (let i = 0; i < offs.length; i++) {
    const t = time + offs[i];
    const src = ctx.createBufferSource();
    src.buffer = noise(0.2);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1350;
    bp.Q.value = 1.3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.001, level * 0.6), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + 0.12);
    autoKill([src], [bp, g]);
  }
}

function tomDrum(ctx, dest, time, level, freq) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, time);
  try { o.frequency.exponentialRampToValueAtTime(freq * 0.55, time + 0.2); } catch (e) { /* 忽略 */ }
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.001, level), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);
  o.connect(g);
  g.connect(dest);
  o.start(time);
  o.stop(time + 0.3);
  autoKill([o], [g]);
}

/** 黑胶杂音（单个爆点） */
function crackle(ctx, dest, time, level, noise) {
  const src = ctx.createBufferSource();
  src.buffer = noise(0.2);
  src.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2600;
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.0005, level), time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.014);
  src.connect(hp);
  hp.connect(g);
  g.connect(dest);
  src.start(time);
  src.stop(time + 0.04);
  autoKill([src], [g, hp]);
}

/* ================================================================== 曲目表 */

export const TRACKS = {
  /* 主菜单：温暖大调 pad + 琶音 */
  menu: {
    bpm: 84, key: 60, scale: 'major', bars: 4, gain: 1, reverb: 0.3,
    chords: [{ r: 0, q: 'maj7' }, { r: 7, q: 'maj' }, { r: 9, q: 'min7' }, { r: 5, q: 'maj7' }],
    pad: { level: 0.13, wave: 'sawtooth', detune: 8, attack: 1.2, release: 1.6, cutoff: 2000, spread: 0.6 },
    arp: { div: 2, inst: 'pluck', oct: 1, level: 0.075, order: [0, 2, 1, 3, 2, 4, 1, 3], dur: 3 },
    bass: { pat: 'X.......x.......', inst: 'sub', oct: -2, level: 0.15, dur: 14 },
    lead: { inst: 'sine', level: 0.06, notes: melody(64, 60, 'major', [[8, 4, 4], [16, 6, 4], [24, 7, 8], [40, 2, 4], [48, 4, 12]]) },
    drums: { kick: 'x.......x.......', hat: '..x...x...x...x.', level: 0.3, hatGain: 0.5 },
  },

  /* 机库：轻松 lo-fi，摇摆 + 黑胶底噪 */
  hangar: {
    bpm: 74, key: 53, scale: 'dorian', bars: 4, swing: 0.32, gain: 0.95, reverb: 0.22, vinyl: 0.6,
    chords: [{ r: 0, q: 'min7' }, { r: 5, q: 'dom7' }, { r: -2, q: 'maj7' }, { r: -4, q: 'dom7' }],
    pad: { level: 0.08, wave: 'triangle', detune: 6, attack: 1.4, release: 1.5, cutoff: 1400, spread: 0.7 },
    keys: { inst: 'ep', pat: '..x...x...x...x.', oct: 0, level: 0.075, dur: 5 },
    bass: { pat: 'x..x..x...x..x..', inst: 'pluck', oct: -2, level: 0.11, dur: 2 },
    lead: { inst: 'ep', level: 0.055, notes: melody(64, 53, 'dorian', [[18, 4, 3], [22, 6, 3], [26, 7, 3], [30, 5, 6], [50, 4, 3], [54, 2, 6]]) },
    drums: { kick: 'X.....x.X.......', snare: '....x.......x...', hat: '..x..xx...x..xx.', level: 0.26, hatGain: 0.4 },
  },

  /* 自由飞行：辽阔、缓慢、无鼓 */
  flight: {
    bpm: 56, key: 62, scale: 'lydian', bars: 4, gain: 1, reverb: 0.55,
    chords: [{ r: 0, q: 'maj7' }, { r: 9, q: 'min7' }, { r: 5, q: 'maj9' }, { r: 7, q: 'maj' }],
    pad: [
      { level: 0.14, wave: 'sawtooth', detune: 14, attack: 2.6, release: 3, cutoff: 1300, spread: 0.95 },
      { level: 0.04, wave: 'triangle', detune: 5, attack: 3, release: 3, oct: 2, cutoff: 3000, spread: 1 },
    ],
    bass: { pat: 'X...............', inst: 'sub', oct: -2, level: 0.13, dur: 15 },
    arp: { div: 8, inst: 'sine', oct: 2, level: 0.04, order: [0, 2, 1], dur: 8 },
    lead: { inst: 'sine', level: 0.045, notes: melody(64, 62, 'lydian', [[12, 4, 8], [28, 7, 8], [44, 5, 12]]) },
  },

  /* 竞速：快速 16 分琶音 + 四踩底鼓 */
  race: {
    bpm: 152, key: 57, scale: 'minor', bars: 4, gain: 1, reverb: 0.14,
    chords: [{ r: 0, q: 'min' }, { r: -4, q: 'maj' }, { r: 3, q: 'maj' }, { r: -2, q: 'maj' }],
    pad: { level: 0.06, wave: 'sawtooth', detune: 10, attack: 0.5, release: 0.4, cutoff: 1300 },
    arp: { div: 1, inst: 'pluck', oct: 1, level: 0.06, order: [0, 1, 2, 3, 2, 1], dur: 1.6 },
    bass: { pat: 'x.x.x.x.x.x.x.x.', inst: 'drive', oct: -2, level: 0.13, dur: 0.9 },
    lead: { inst: 'saw', level: 0.045, notes: melody(64, 57, 'minor', [[0, 0, 4], [8, 2, 4], [16, 4, 4], [24, 2, 4], [32, 0, 4], [40, 7, 4], [48, 4, 8], [56, 2, 8]]) },
    drums: {
      kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
      clap: '....x.......x...', level: 0.4, hatGain: 0.34,
    },
  },

  /* 空战：紧张小调 + 打击乐 */
  combat: {
    bpm: 138, key: 52, scale: 'minor', bars: 4, gain: 1, reverb: 0.2,
    chords: [{ r: 0, q: 'min' }, { r: -4, q: 'maj' }, { r: -2, q: 'maj' }, { r: -5, q: 'dom7' }],
    pad: { level: 0.055, wave: 'sawtooth', detune: 12, attack: 0.35, release: 0.3, cutoff: 900 },
    keys: { inst: 'saw', pat: 'x...x...x...x..x', oct: 0, level: 0.045, dur: 2 },
    arp: { div: 1, inst: 'pluck', oct: 1, level: 0.05, order: [0, 2, 1, 2], dur: 1.2 },
    bass: { pat: 'x.xxx.x.x.xxx.x.', inst: 'drive', oct: -2, level: 0.16, dur: 1.2 },
    lead: { inst: 'saw', level: 0.055, notes: melody(64, 52, 'minor', [[0, 0, 2], [4, 3, 2], [8, 4, 2], [12, 3, 2], [16, 5, 2], [20, 4, 2], [24, 2, 4], [32, 0, 2], [36, 6, 2], [40, 7, 4], [48, 4, 6], [56, 0, 8]]) },
    drums: {
      kick: ['x..x..x...x.x...', 'x..x..x...x.x...', 'x..x..x...x.x...', 'x..x..x.x.x.x.x.'],
      snare: '....x..x....x.x.',
      hat: 'x.xxx.xxx.xxx.xx',
      tom: '.......x......x.',
      level: 0.46, hatGain: 0.28,
    },
  },

  /* 雪原：空灵 FM 钟声，稀疏 */
  snow: {
    bpm: 66, key: 55, scale: 'major', bars: 4, gain: 1, reverb: 0.6, vinyl: 0.2,
    chords: [{ r: 0, q: 'maj7' }, { r: 5, q: 'maj7' }, { r: 2, q: 'min7' }, { r: 4, q: 'min7' }],
    pad: { level: 0.09, wave: 'triangle', detune: 7, attack: 2.2, release: 2.6, cutoff: 2200, spread: 0.8, oct: 1 },
    arp: { div: 2, inst: 'bell', oct: 2, level: 0.06, order: [0, 2, 3, 4, 3, 2, 1, 0], dur: 6 },
    bass: { pat: 'X...............', inst: 'sub', oct: -1, level: 0.1, dur: 15 },
    lead: { inst: 'bell', level: 0.06, notes: melody(64, 55, 'major', [[6, 7, 5], [20, 9, 5], [36, 4, 8], [52, 2, 8]]) },
  },

  /* 沙漠：弗里吉亚主导音阶，拨弦 + 手鼓 */
  desert: {
    bpm: 104, key: 50, scale: 'phrygianDominant', bars: 4, gain: 1, reverb: 0.3,
    chords: [{ r: 0, q: 'min' }, { r: 0, q: 'min' }, { r: -2, q: 'maj' }, { r: 1, q: 'maj' }],
    arp: { div: 2, inst: 'pluck', oct: 1, level: 0.05, order: [0, 1, 2, 1], dur: 3 },
    bass: { pat: 'x.......x..x....', inst: 'pluck', oct: -2, level: 0.14, dur: 8 },
    lead: {
      inst: 'pluck', level: 0.09,
      notes: melody(64, 50, 'phrygianDominant', [
        [0, 0, 2], [2, 1, 1], [3, 2, 1], [4, 3, 2], [7, 4, 2], [10, 5, 2], [12, 4, 2], [14, 3, 2],
        [16, 6, 4], [20, 7, 2], [22, 6, 2], [24, 5, 2], [26, 4, 2], [28, 2, 2], [30, 1, 2],
        [32, 0, 4], [38, 4, 2], [40, 5, 2], [42, 6, 2], [44, 7, 4], [48, 4, 4], [54, 2, 4], [58, 1, 2], [60, 0, 4],
      ]),
    },
    drums: { kick: 'x...x.x.x...x.x.', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', level: 0.34, hatGain: 0.22 },
  },

  /* 城市：切分贝斯 + 电钢 */
  city: {
    bpm: 94, key: 53, scale: 'dorian', bars: 4, swing: 0.18, gain: 1, reverb: 0.2, vinyl: 0.22,
    chords: [{ r: 0, q: 'min9' }, { r: 5, q: 'dom7' }, { r: -2, q: 'maj7' }, { r: -5, q: 'min7' }],
    keys: [
      { inst: 'ep', pat: 'x..x..x...x..x..', oct: 0, level: 0.07, dur: 4 },
      { inst: 'ep', pat: '....x.......x...', oct: 1, level: 0.035, dur: 3 },
    ],
    arp: { div: 2, inst: 'ep', oct: 2, level: 0.03, order: [0, 2, 3, 1], dur: 2 },
    bass: { pat: 'x..x.x....x.x...', inst: 'drive', oct: -2, level: 0.14, dur: 2 },
    lead: { inst: 'sine', level: 0.045, notes: melody(64, 53, 'dorian', [[6, 4, 3], [12, 6, 3], [22, 7, 4], [36, 4, 4], [44, 2, 6]]) },
    drums: { kick: 'x.....x...x.....', snare: '....x.......x...', hat: '..x...x...x...x.', clap: '....x.......x..x', level: 0.32, hatGain: 0.42 },
  },

  /* 胜利：一次性大调号角（约 3.8s），播完自动切回 */
  victory: {
    bpm: 126, key: 60, scale: 'major', bars: 2, gain: 1.05, reverb: 0.32, loop: false,
    chords: [{ r: 0, q: 'maj' }, { r: 0, q: 'maj' }],
    pad: { level: 0.08, wave: 'sawtooth', detune: 8, attack: 0.06, release: 0.6, cutoff: 2600, spread: 0.5 },
    keys: { inst: 'saw', pat: 'x.......x.......', oct: -1, level: 0.06, dur: 3 },
    bass: { pat: 'x...x...x...x...', inst: 'drive', oct: -2, level: 0.15, dur: 2 },
    lead: {
      inst: 'saw', level: 0.14,
      notes: melodyAbs(32, 60, [[0, 7, 2], [2, 12, 2], [4, 16, 2], [6, 19, 2], [8, 24, 4], [12, 19, 2], [16, 12, 4], [20, 16, 4], [24, 19, 8]]),
    },
    drums: {
      kick: 'x...x...x...x...', snare: ['x.......x.......', '....x.x.x.x.x.x.'],
      hat: 'x.x.x.x.x.x.x.x.', level: 0.42, hatGain: 0.5,
    },
  },

  /* 失败：一次性下行小调（约 3.5s） */
  failure: {
    bpm: 132, key: 57, scale: 'minor', bars: 2, gain: 1, reverb: 0.38, loop: false,
    chords: [{ r: 0, q: 'min' }, { r: 0, q: 'min' }],
    pad: { level: 0.06, wave: 'sawtooth', detune: 10, attack: 0.3, release: 0.9, cutoff: 900 },
    bass: { pat: 'x.......x.......', inst: 'sub', oct: -2, level: 0.13, dur: 10 },
    lead: {
      inst: 'saw', level: 0.13, vib: 22, vibRate: 5.2,
      notes: melodyAbs(32, 57, [[0, 12, 3], [3, 10, 3], [6, 8, 3], [9, 7, 4], [13, 5, 3], [16, 4, 3], [19, 3, 3], [22, 2, 4], [26, -12, 6]]),
    },
    drums: { kick: 'x.......x.......', level: 0.2, hat: '................' },
  },
};

/** 所有曲目名（供 UI 使用） */
export const MUSIC_NAMES = Object.keys(TRACKS);

/* ================================================================== 播放器 */

/**
 * 单首曲目的运行实例：持有一条独立 gain（用于交叉淡入淡出），
 * 按 16 分音符网格把自己往后排。
 */
class TrackVoice {
  constructor(player, name, def, ctx, dest, t0, fade) {
    this.player = player;
    this.name = name;
    this.def = def;
    this.ctx = ctx;
    this.noise = player.noise;
    this.stepDur = 60 / def.bpm / 4;
    this.barDur = this.stepDur * 16;
    this.total = def.bars * 16;
    this.startTime = t0;
    this.endTime = t0 + this.total * this.stepDur;
    this.step = 0;
    this.t = t0;
    this.dead = false;
    this.finished = false;
    this.cleanupAt = Infinity;
    this.beds = [];
    this.bedNodes = [];
    this.seed = (name.length * 2654435761 + def.bpm * 131) >>> 0;
    this.rngState = this.seed || 1;
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0.0001, t0);
    this.gain.gain.linearRampToValueAtTime(Math.max(0.001, def.gain ?? 1), t0 + Math.max(0.02, fade));
    const rev = def.reverb ?? 0.2;
    if (player.reverbIn) {
      this.send = ctx.createGain();
      this.send.gain.value = rev;
      this.gain.connect(this.send);
      this.send.connect(player.reverbIn);
    }
    this.gain.connect(dest);
    if (def.vinyl) this._startVinyl(def.vinyl);
  }

  /** 简单 LCG：用于黑胶杂音/随机点缀，避免 Math.random 影响可复现性 */
  _rand() {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  /** 黑胶 / 空气底噪（整曲持续，断开时随 gain 一起停） */
  _startVinyl(level) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(3);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.012 * level;
    src.connect(lp);
    lp.connect(hp);
    hp.connect(g);
    g.connect(this.gain);
    src.start(this.startTime);
    this.beds.push(src);
    this.bedNodes.push(lp, hp, g);
  }

  /** 每帧推进：把 LOOKAHEAD 之内的步排进时间线 */
  update(now) {
    if (this.dead || this.finished) return;
    const horizon = now + LOOKAHEAD;
    const loop = this.def.loop !== false;
    while (this.t < horizon) {
      if (!loop && this.step >= this.total) {
        this.finished = true;
        return;
      }
      const swing = this.def.swing ? (this.step % 2 ? this.def.swing * this.stepDur : 0) : 0;
      this._scheduleStep(this.step, this.t + swing);
      this.step = loop ? (this.step + 1) % this.total : this.step + 1;
      this.t += this.stepDur;
    }
  }

  /** 排出第 s 步所有声部 */
  _scheduleStep(s, time) {
    const ctx = this.ctx;
    const dest = this.gain;
    const def = this.def;
    const sd = this.stepDur;
    const bar = Math.floor(s / 16);
    const bstep = s % 16;
    const ch = def.chords[bar % def.chords.length];
    const root = def.key + ch.r;
    const tones = chordNotes(root, ch.q);

    /* --- 鼓组 --- */
    const d = def.drums;
    if (d) {
      const lv = d.level ?? 0.4;
      const k = patAt(d.kick, bstep, bar);
      if (k) kickDrum(ctx, dest, time, lv * k * (d.kickGain ?? 1));
      const sn = patAt(d.snare, bstep, bar);
      if (sn) snareDrum(ctx, dest, time, lv * sn * (d.snareGain ?? 0.85), this.noise);
      const h = patAt(d.hat, bstep, bar);
      if (h) hatDrum(ctx, dest, time, lv * h * (d.hatGain ?? 0.34), false, this.noise);
      const c = patAt(d.clap, bstep, bar);
      if (c) clapDrum(ctx, dest, time, lv * c * 0.5, this.noise);
      const tm = patAt(d.tom, bstep, bar);
      if (tm) tomDrum(ctx, dest, time, lv * tm * 0.55, 96 + (bstep % 4) * 26);
    }

    /* --- 低音 --- */
    const b = def.bass;
    if (b) {
      const l = patAt(b.pat, bstep, bar);
      if (l) {
        let midi = b.notes ? b.notes[s % b.notes.length] : tones[0];
        if (midi != null) {
          midi += 12 * (b.oct || 0);
          bassNote(ctx, dest, time, midiToFreq(midi), (b.dur || 2) * sd, (b.level ?? 0.12) * (0.72 + 0.28 * l), b.inst || 'sub');
        }
      }
    }

    /* --- pad：每小节头一次长音 --- */
    if (bstep === 0) {
      const pads = norm(def.pad);
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        const freqs = new Array(tones.length);
        for (let j = 0; j < tones.length; j++) freqs[j] = midiToFreq(tones[j] + 12 * (p.oct || 0));
        padChord(ctx, dest, time, freqs, this.barDur, p.level ?? 0.1, p);
      }
    }

    /* --- 和弦 stab --- */
    const keys = norm(def.keys);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const l = patAt(k.pat, bstep, bar);
      if (!l) continue;
      const dur = (k.dur || 3) * sd;
      for (let j = 0; j < tones.length; j++) {
        playNote(ctx, dest, k.inst || 'ep', time, tones[j] + 12 * (k.oct || 0), dur, (k.level ?? 0.08) * l, k);
      }
    }

    /* --- 琶音层 --- */
    const arps = norm(def.arp);
    for (let i = 0; i < arps.length; i++) {
      const ar = arps[i];
      const div = Math.max(1, ar.div | 0);
      if (s % div) continue;
      const order = ar.order || [0, 1, 2];
      const idx = Math.floor(s / div);
      const toneIdx = order[idx % order.length] % tones.length;
      const midi = tones[toneIdx] + 12 * (ar.oct || 0);
      playNote(ctx, dest, ar.inst || 'pluck', time, midi, (ar.dur || 2) * sd, ar.level ?? 0.07, ar);
    }

    /* --- 主旋律 --- */
    const ld = def.lead;
    if (ld && ld.notes) {
      const ev = ld.notes[s % ld.notes.length];
      if (ev) {
        const midi = typeof ev === 'object' ? ev.midi : ev;
        const len = (typeof ev === 'object' && ev.len ? ev.len : 2) * sd;
        playNote(ctx, dest, ld.inst || 'sine', time, midi, len, ld.level ?? 0.07, ld);
      }
    }

    /* --- 黑胶杂音点缀 --- */
    if (def.vinyl && this._rand() < 0.05) crackle(ctx, dest, time, def.vinyl * 0.04, this.noise);
  }

  /** 淡出并安排回收 */
  stop(fade) {
    if (this.dead) return;
    this.dead = true;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    try {
      // 优先“保持当前自动化值”，避免淡出时跳变
      if (this.gain.gain.cancelAndHoldAtTime) this.gain.gain.cancelAndHoldAtTime(t);
      else {
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setValueAtTime(Math.max(0.0001, this.gain.gain.value), t);
      }
      this.gain.gain.linearRampToValueAtTime(0.0001, t + Math.max(0.02, fade));
    } catch (e) { /* 忽略 */ }
    const at = t + Math.max(0.02, fade) + 0.1;
    this.cleanupAt = at;
    for (let i = 0; i < this.beds.length; i++) {
      try { this.beds[i].stop(at); } catch (e) { /* 忽略 */ }
    }
  }

  /** 断开全部节点 */
  kill() {
    for (let i = 0; i < this.beds.length; i++) { try { this.beds[i].disconnect(); } catch (e) { /* 忽略 */ } }
    for (let i = 0; i < this.bedNodes.length; i++) { try { this.bedNodes[i].disconnect(); } catch (e) { /* 忽略 */ } }
    try { this.gain.disconnect(); } catch (e) { /* 忽略 */ }
    if (this.send) { try { this.send.disconnect(); } catch (e) { /* 忽略 */ } }
  }
}

/**
 * 音乐播放器：管理当前曲目、交叉淡入淡出、一次性 jingle 的自动返回。
 * 由 audio.js 创建并每帧 update()。
 */
export class MusicPlayer {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} dest 音乐总线（musicGain）
   * @param {{noise?:(sec:number)=>AudioBuffer, reverbIn?:AudioNode|null}} [opts]
   */
  constructor(ctx, dest, opts = {}) {
    this.ctx = ctx;
    this.dest = dest;
    this.noise = opts.noise || ((sec) => localNoise(ctx, sec));
    this.reverbIn = opts.reverbIn || null;
    this._active = null;
    this._dying = [];
    this._last = null;
    this._returnTo = null;
  }

  /** 当前曲目名（含正在播放的 jingle），无则 null */
  get current() {
    return this._active ? this._active.name : null;
  }

  /** 上一首“常规”曲目（jingle 播完后回切的目标） */
  get previous() {
    return this._last;
  }

  /**
   * 播放曲目
   * @param {string} name MusicName
   * @param {{fade?:number, restart?:boolean}} [opts]
   */
  play(name, opts = {}) {
    const def = TRACKS[name];
    if (!def) return;
    const oneShot = def.loop === false;
    const fade = opts.fade != null ? Math.max(0.02, opts.fade) : oneShot ? 0.18 : 1.5;
    if (!oneShot && this._active && this._active.name === name && !opts.restart) return;
    if (oneShot) {
      this._returnTo = this._last;
    } else {
      this._last = name;
      this._returnTo = null;
    }
    const old = this._active;
    this._active = null;
    if (old) this._retire(old, fade);
    const t0 = this.ctx.currentTime + 0.03;
    this._active = new TrackVoice(this, name, def, this.ctx, this.dest, t0, fade);
  }

  /** 停止音乐 */
  stop(fade = 1.2) {
    this._returnTo = null;
    if (this._active) {
      this._retire(this._active, Math.max(0.02, fade));
      this._active = null;
    }
  }

  /** 每帧调用（dt 秒，本实现以 ctx.currentTime 为准） */
  update() {
    const now = this.ctx.currentTime;
    const act = this._active;
    if (act) {
      act.update(now);
      if (act.def.loop === false && (act.finished || now >= act.endTime)) {
        const back = this._returnTo;
        this._returnTo = null;
        if (back && TRACKS[back]) this.play(back, { fade: 1.1 });
        else this.stop(0.8);
      }
    }
    for (let i = this._dying.length - 1; i >= 0; i--) {
      if (now >= this._dying[i].cleanupAt) {
        this._dying[i].kill();
        this._dying.splice(i, 1);
      }
    }
  }

  /** 停掉所有曲目并断开 */
  dispose() {
    this._returnTo = null;
    if (this._active) { this._active.stop(0.05); this._active.kill(); this._active = null; }
    for (let i = 0; i < this._dying.length; i++) { this._dying[i].stop(0.05); this._dying[i].kill(); }
    this._dying.length = 0;
  }

  _retire(track, fade) {
    track.stop(fade);
    this._dying.push(track);
  }
}
