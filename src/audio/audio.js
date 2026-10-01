/**
 * audio.js —— WebAudio 音效引擎（纯程序化合成，无任何外部音频文件 / 网络 / 依赖）
 *
 * 设计要点：
 *  1. 总线：source -> sfxGain / musicGain -> masterGain -> DynamicsCompressor -> destination；
 *     另有一条共享卷积混响支路（程序化脉冲响应）：source -> reverbSend -> ConvolverNode -> masterGain。
 *  2. 构造时绝不创建 AudioContext，只在 init()（必须由用户手势触发）里创建并 resume。
 *  3. 所有公共方法都做了 ready 检查 + try/catch：AudioContext 不可用或抛错时全部退化为安全 no-op。
 *  4. 引擎连续音按 id 复用同一路 voice，参数用 setTargetAtTime 平滑过渡（无爆音）；
 *     update()/engineSet() 是热路径，除首次创建 voice 外不做对象分配。
 *  5. 3D 定位：PannerNode（HRTF 优先） + setListener 设置听者位置/朝向。
 *  6. 音乐由 music.js 的前视步伐调度器生成（见该文件）。
 *  7. 逐零件损毁类音效（scrape/metal_break/...）可能每帧被触发多次：
 *     sfx() 内部对这批音效做 60ms 节流 + 并发实例上限，避免爆音与 CPU 飙高。
 */

import { MusicPlayer, TRACKS } from './music.js';

/* ================================================================== 小工具 */

const EMPTY_OPTS = Object.freeze({});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);

/** 程序化白噪声缓冲（供噪声类音色复用） */
export function makeNoiseBuffer(ctx, seconds = 1) {
  const rate = ctx.sampleRate || 44100;
  const len = Math.max(1, Math.floor(rate * clamp(seconds, 0.05, 8)));
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** 程序化混响脉冲响应：指数衰减噪声 + 少量早期反射 + 单极点柔化 */
function makeImpulseResponse(ctx, seconds = 2.4, decay = 2.6) {
  const rate = ctx.sampleRate || 44100;
  const len = Math.max(1, Math.floor(rate * clamp(seconds, 0.2, 6)));
  const buf = ctx.createBuffer(2, len, rate);
  const taps = [0.011, 0.019, 0.028, 0.041, 0.057];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * 0.42;                       // 柔化高频，避免金属味
      d[i] = lp * Math.pow(1 - x, decay);
    }
    for (let k = 0; k < taps.length; k++) {
      const idx = Math.floor(taps[k] * (ch ? 1.07 : 0.93) * rate);
      if (idx < len) d[idx] += (k % 2 ? -1 : 1) * 0.45 * Math.pow(0.7, k);
    }
  }
  return buf;
}

/**
 * 噪声脉冲：白噪声 -> BiquadFilter -> 指数包络
 * @returns {{src:AudioBufferSourceNode, nodes:AudioNode[], end:number}}
 */
function noiseHit(ctx, noise, t, o) {
  const dur = o.dur ?? 0.2;
  const lvl = o.level ?? 0.4;
  const src = ctx.createBufferSource();
  src.buffer = noise(Math.min(3, dur + 0.12));
  src.loop = true;
  if (o.rate && o.rate !== 1) src.playbackRate.value = clamp(o.rate, 0.25, 4);
  const f = ctx.createBiquadFilter();
  f.type = o.type || 'lowpass';
  f.frequency.setValueAtTime(Math.max(20, o.freq ?? 1200), t);
  f.Q.value = o.q ?? 0.9;
  if (o.freqEnd) {
    try { f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t + dur * (o.sweep ?? 1)); } catch (e) { /* 忽略 */ }
  }
  const g = ctx.createGain();
  const atk = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0001, lvl), t + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(o.dest);
  src.start(t);
  src.stop(t + dur + 0.05);
  return { src, nodes: [f, g], end: t + dur + 0.05 };
}

/**
 * 振荡器脉冲：支持频率扫掠 / 保持段 / 颤音
 * @returns {{src:OscillatorNode, nodes:AudioNode[], end:number}}
 */
function oscHit(ctx, t, o) {
  const dur = o.dur ?? 0.2;
  const lvl = o.level ?? 0.3;
  const atk = o.attack ?? 0.004;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(Math.max(8, o.freq), t);
  if (o.freqEnd) {
    try { osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.freqEnd), t + (o.sweep ?? dur)); } catch (e) { /* 忽略 */ }
  }
  if (o.detune) osc.detune.value = o.detune;
  let lfo = null;
  let lg = null;
  if (o.vibrato) {
    lfo = ctx.createOscillator();
    lfo.frequency.value = o.vibratoRate ?? 6;
    lg = ctx.createGain();
    lg.gain.value = o.vibrato;
    lfo.connect(lg);
    lg.connect(osc.detune);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0001, lvl), t + atk);
  if (o.hold && atk + o.hold < dur * 0.9) g.gain.setValueAtTime(Math.max(0.0001, lvl), t + atk + o.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(o.dest);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  return { src: osc, nodes: lfo ? [g, lg] : [g], end: t + dur + 0.05 };
}

/* ================================================================== 单次音效表 */

/**
 * 每个音效函数收到一个 api 对象：
 *   ctx  AudioContext | t 起始时间 | rate 变调系数 | out 该音效的输出节点
 *   noise(sec) 取噪声缓冲 | add(hit) 登记节点（用于播完自动断开）| send 混响送出（可能为 null）
 */
const SFX = {
  /* ---------------------------------------------------------- 界面 */
  click(a) {
    a.add(oscHit(a.ctx, a.t, { type: 'square', freq: 1150 * a.rate, freqEnd: 720 * a.rate, dur: 0.05, level: 0.2, attack: 0.001, dest: a.out }));
    a.add(noiseHit(a.ctx, a.noise, a.t, { dur: 0.02, level: 0.09, type: 'highpass', freq: 3200, dest: a.out }));
  },
  hover(a) {
    a.add(oscHit(a.ctx, a.t, { type: 'sine', freq: 760 * a.rate, freqEnd: 990 * a.rate, dur: 0.06, level: 0.07, attack: 0.006, dest: a.out }));
  },
  confirm(a) {
    a.add(oscHit(a.ctx, a.t, { type: 'triangle', freq: 660 * a.rate, dur: 0.09, level: 0.16, dest: a.out }));
    a.add(oscHit(a.ctx, a.t + 0.08, { type: 'triangle', freq: 990 * a.rate, dur: 0.2, level: 0.15, attack: 0.006, dest: a.out }));
  },
  cancel(a) {
    a.add(oscHit(a.ctx, a.t, { type: 'triangle', freq: 620 * a.rate, dur: 0.09, level: 0.15, dest: a.out }));
    a.add(oscHit(a.ctx, a.t + 0.08, { type: 'triangle', freq: 430 * a.rate, dur: 0.18, level: 0.14, dest: a.out }));
  },
  error(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(oscHit(c, t, { type: 'square', freq: 200 * r, dur: 0.13, level: 0.15, dest: a.out }));
    a.add(oscHit(c, t, { type: 'square', freq: 213 * r, dur: 0.13, level: 0.11, dest: a.out }));
    a.add(oscHit(c, t + 0.17, { type: 'square', freq: 158 * r, dur: 0.24, level: 0.15, dest: a.out }));
    a.add(oscHit(c, t + 0.17, { type: 'square', freq: 167 * r, dur: 0.24, level: 0.1, dest: a.out }));
  },

  /* ---------------------------------------------------------- 爆炸 / 撞击 */
  explosion(a) {
    const c = a.ctx, t = a.t;
    if (a.send) a.send.gain.value = 0.3;
    a.add(noiseHit(c, a.noise, t, { dur: 0.1, level: 0.5, type: 'highpass', freq: 1800, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 1.1, level: 0.7, type: 'lowpass', freq: 2600, freqEnd: 110, q: 0.7, attack: 0.006, dest: a.out }));
    a.add(oscHit(c, t, { type: 'sine', freq: 130, freqEnd: 30, dur: 0.85, level: 0.5, sweep: 0.7, dest: a.out }));
    a.add(oscHit(c, t, { type: 'sine', freq: 68, freqEnd: 24, dur: 1.2, level: 0.32, sweep: 1, dest: a.out }));
  },
  explosion_big(a) {
    const c = a.ctx, t = a.t;
    if (a.send) a.send.gain.value = 0.55;
    // 初始爆裂
    a.add(noiseHit(c, a.noise, t, { dur: 0.2, level: 0.65, type: 'highpass', freq: 1200, dest: a.out }));
    // 主体：更深、更长的低通下扫（比 explosion 厚重）
    a.add(noiseHit(c, a.noise, t, { dur: 2.6, level: 0.9, type: 'lowpass', freq: 2600, freqEnd: 55, q: 0.55, attack: 0.01, dest: a.out }));
    // 次声冲击：失谐正弦对 + 一层中低冲击
    a.add(oscHit(c, t, { type: 'sine', freq: 105, freqEnd: 19, dur: 1.9, level: 0.7, sweep: 1.2, dest: a.out }));
    a.add(oscHit(c, t + 0.04, { type: 'sine', freq: 48, freqEnd: 15, dur: 2.5, level: 0.5, sweep: 1.9, dest: a.out }));
    a.add(oscHit(c, t + 0.08, { type: 'sine', freq: 72, freqEnd: 21, dur: 1.4, level: 0.22, sweep: 0.9, dest: a.out }));
    // 低频轰鸣尾巴 + 碎片洒落
    a.add(noiseHit(c, a.noise, t + 0.4, { dur: 2.0, level: 0.2, type: 'lowpass', freq: 320, freqEnd: 110, q: 0.7, attack: 0.35, dest: a.out }));
    a.add(noiseHit(c, a.noise, t + 0.5, { dur: 1.2, level: 0.08, type: 'bandpass', freq: 2200, freqEnd: 900, q: 0.9, attack: 0.1, dest: a.out }));
  },
  crash(a) {
    const c = a.ctx, t = a.t;
    if (a.send) a.send.gain.value = 0.34;
    // 撞击瞬间：高频脆响 + 带通噪声
    a.add(noiseHit(c, a.noise, t, { dur: 0.08, level: 0.5, type: 'highpass', freq: 2600, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.5, level: 0.42, type: 'bandpass', freq: 1500, freqEnd: 700, q: 0.8, dest: a.out }));
    // 失谐金属谐振（成对，产生拍频的“金属味”）
    const parts = [183, 271, 397, 521, 733, 967];
    for (let i = 0; i < parts.length; i++) {
      const f = parts[i] * a.rate;
      a.add(oscHit(c, t + i * 0.01, { type: 'square', freq: f, dur: 0.75 - i * 0.09, level: 0.075 - i * 0.009, hold: 0.012, dest: a.out }));
      a.add(oscHit(c, t + i * 0.01, { type: 'square', freq: f * 1.006, dur: 0.6 - i * 0.07, level: 0.045 - i * 0.006, hold: 0.01, dest: a.out }));
    }
    // 碎裂散落
    a.add(noiseHit(c, a.noise, t + 0.12, { dur: 0.7, level: 0.18, type: 'highpass', freq: 3200, attack: 0.01, dest: a.out }));
    // 低频撞击体
    a.add(oscHit(c, t, { type: 'sine', freq: 120, freqEnd: 38, dur: 0.45, level: 0.42, dest: a.out }));
    a.add(oscHit(c, t, { type: 'triangle', freq: 92, freqEnd: 30, dur: 0.3, level: 0.22, dest: a.out }));
  },

  /* ---------------------------------------------------------- 武器 */
  gun(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(oscHit(c, t, { type: 'square', freq: 320 * r, freqEnd: 110 * r, dur: 0.055, level: 0.24, attack: 0.001, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.05, level: 0.34, type: 'highpass', freq: 1600, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.15, level: 0.18, type: 'lowpass', freq: 900, freqEnd: 240, dest: a.out }));
  },
  cannon(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    if (a.send) a.send.gain.value = 0.24;
    a.add(oscHit(c, t, { type: 'sine', freq: 165 * r, freqEnd: 38, dur: 0.42, level: 0.5, sweep: 0.35, dest: a.out }));
    a.add(oscHit(c, t, { type: 'square', freq: 240 * r, freqEnd: 70, dur: 0.09, level: 0.2, attack: 0.001, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.65, level: 0.45, type: 'lowpass', freq: 2200, freqEnd: 160, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.06, level: 0.3, type: 'highpass', freq: 2200, dest: a.out }));
  },
  missile_launch(a) {
    const c = a.ctx, t = a.t;
    if (a.send) a.send.gain.value = 0.28;
    a.add(noiseHit(c, a.noise, t, { dur: 1.25, level: 0.42, type: 'bandpass', freq: 180, freqEnd: 2600, q: 0.8, attack: 0.25, sweep: 0.85, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 1.4, level: 0.2, type: 'lowpass', freq: 520, freqEnd: 160, attack: 0.12, dest: a.out }));
    a.add(oscHit(c, t, { type: 'sawtooth', freq: 55, freqEnd: 190, dur: 1.15, level: 0.15, attack: 0.1, dest: a.out }));
  },
  thruster(a) {
    const c = a.ctx, t = a.t;
    a.add(noiseHit(c, a.noise, t, { dur: 0.7, level: 0.4, type: 'bandpass', freq: 1500, freqEnd: 320, q: 0.7, attack: 0.02, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.85, level: 0.18, type: 'highpass', freq: 2400, dest: a.out, attack: 0.03 }));
    a.add(oscHit(c, t, { type: 'sawtooth', freq: 95, freqEnd: 58, dur: 0.7, level: 0.16, attack: 0.03, dest: a.out }));
  },

  /* ---------------------------------------------------------- 告警 / 锁定 */
  lock(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(oscHit(c, t, { type: 'square', freq: 1050 * r, dur: 0.07, level: 0.12, dest: a.out }));
    a.add(oscHit(c, t + 0.1, { type: 'square', freq: 1400 * r, dur: 0.1, level: 0.13, dest: a.out }));
  },
  beep(a) {
    a.add(oscHit(a.ctx, a.t, { type: 'sine', freq: 900 * a.rate, dur: 0.1, level: 0.15, attack: 0.004, dest: a.out }));
  },
  stall_warn(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    for (let i = 0; i < 5; i++) {
      const s = t + i * 0.13;
      a.add(oscHit(c, s, { type: 'square', freq: 415 * r, dur: 0.085, level: 0.13, attack: 0.004, dest: a.out }));
      a.add(oscHit(c, s, { type: 'sawtooth', freq: 207 * r, dur: 0.085, level: 0.085, attack: 0.004, dest: a.out }));
    }
  },
  alarm(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    for (let i = 0; i < 6; i++) {
      const s = t + i * 0.21;
      const f = i % 2 ? 620 * r : 452 * r;
      a.add(oscHit(c, s, { type: 'triangle', freq: f, dur: 0.18, level: 0.14, attack: 0.01, dest: a.out }));
      a.add(oscHit(c, s, { type: 'square', freq: f * 0.5, dur: 0.18, level: 0.05, attack: 0.01, dest: a.out }));
    }
  },
  pull_up(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    const notes = [700, 900, 1150];
    for (let i = 0; i < notes.length; i++) {
      const s = t + i * 0.19;
      a.add(oscHit(c, s, { type: 'triangle', freq: notes[i] * r, dur: 0.15, level: 0.16, attack: 0.01, dest: a.out }));
      a.add(oscHit(c, s, { type: 'square', freq: notes[i] * 0.5 * r, dur: 0.15, level: 0.07, attack: 0.01, dest: a.out }));
    }
    a.add(noiseHit(c, a.noise, t, { dur: 0.55, level: 0.05, type: 'bandpass', freq: 1200, q: 1.2, dest: a.out, attack: 0.1 }));
  },

  /* ---------------------------------------------------------- 机械 / 落地 */
  gear(a) {
    const c = a.ctx, t = a.t;
    a.add(noiseHit(c, a.noise, t, { dur: 0.95, level: 0.14, type: 'bandpass', freq: 620, freqEnd: 1350, q: 2.5, attack: 0.1, dest: a.out }));
    a.add(oscHit(c, t, { type: 'sawtooth', freq: 92, freqEnd: 148, dur: 0.9, level: 0.1, attack: 0.08, sweep: 0.8, dest: a.out }));
    a.add(oscHit(c, t + 0.92, { type: 'sine', freq: 150, freqEnd: 58, dur: 0.22, level: 0.3, hold: 0.01, dest: a.out }));
    a.add(noiseHit(c, a.noise, t + 0.92, { dur: 0.14, level: 0.16, type: 'lowpass', freq: 900, dest: a.out }));
  },
  touchdown(a) {
    const c = a.ctx, t = a.t;
    a.add(noiseHit(c, a.noise, t, { dur: 0.34, level: 0.34, type: 'bandpass', freq: 2100, freqEnd: 1250, q: 5, dest: a.out, attack: 0.006 }));
    a.add(oscHit(c, t, { type: 'sawtooth', freq: 1450, freqEnd: 900, dur: 0.28, level: 0.07, attack: 0.01, dest: a.out }));
    a.add(oscHit(c, t + 0.03, { type: 'sine', freq: 105, freqEnd: 42, dur: 0.3, level: 0.45, dest: a.out }));
    a.add(noiseHit(c, a.noise, t + 0.02, { dur: 0.2, level: 0.2, type: 'lowpass', freq: 700, freqEnd: 200, dest: a.out }));
  },
  squeal(a) {
    const c = a.ctx, t = a.t;
    a.add(noiseHit(c, a.noise, t, { dur: 0.85, level: 0.3, type: 'bandpass', freq: 1700, freqEnd: 1150, q: 8, attack: 0.05, dest: a.out }));
    a.add(oscHit(c, t, { type: 'sawtooth', freq: 1120, freqEnd: 780, dur: 0.8, level: 0.06, attack: 0.08, vibrato: 26, vibratoRate: 5.5, dest: a.out }));
  },
  splash(a) {
    const c = a.ctx, t = a.t;
    a.add(noiseHit(c, a.noise, t, { dur: 0.55, level: 0.4, type: 'bandpass', freq: 900, freqEnd: 350, q: 1.1, attack: 0.008, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.4, level: 0.2, type: 'lowpass', freq: 1400, freqEnd: 400, dest: a.out }));
    const offs = [0.03, 0.08, 0.13, 0.18, 0.24, 0.3, 0.36];
    for (let i = 0; i < offs.length; i++) {
      // 气泡：短促的正弦上滑，断续出现
      a.add(oscHit(c, t + offs[i], { type: 'sine', freq: 260 + i * 120, freqEnd: 520 + i * 150, dur: 0.055, level: 0.1, attack: 0.004, dest: a.out }));
    }
  },
  whoosh(a) {
    const c = a.ctx, t = a.t;
    a.add(noiseHit(c, a.noise, t, { dur: 0.32, level: 0.3, type: 'bandpass', freq: 260, freqEnd: 2300, q: 0.7, attack: 0.08, sweep: 1, dest: a.out }));
    a.add(noiseHit(c, a.noise, t + 0.3, { dur: 0.3, level: 0.26, type: 'bandpass', freq: 2300, freqEnd: 400, q: 0.7, attack: 0.005, dest: a.out }));
  },
  thud(a) {
    const c = a.ctx, t = a.t;
    a.add(oscHit(c, t, { type: 'sine', freq: 130, freqEnd: 45, dur: 0.24, level: 0.45, sweep: 0.2, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.12, level: 0.18, type: 'lowpass', freq: 500, freqEnd: 160, dest: a.out }));
  },
  parachute(a) {
    const c = a.ctx, t = a.t;
    const offs = [0, 0.12, 0.25, 0.38, 0.52];
    for (let i = 0; i < offs.length; i++) {
      a.add(noiseHit(c, a.noise, t + offs[i], { dur: 0.11, level: 0.24, type: 'lowpass', freq: 900, freqEnd: 500, q: 1.4, attack: 0.012, dest: a.out }));
    }
    a.add(noiseHit(c, a.noise, t, { dur: 0.75, level: 0.1, type: 'bandpass', freq: 500, freqEnd: 900, q: 0.8, attack: 0.15, dest: a.out }));
  },
  wind_gust(a) {
    const c = a.ctx, t = a.t;
    a.add(noiseHit(c, a.noise, t, { dur: 1.6, level: 0.24, type: 'bandpass', freq: 300, freqEnd: 950, q: 0.6, attack: 0.55, sweep: 0.75, dest: a.out }));
    a.add(noiseHit(c, a.noise, t + 0.9, { dur: 0.9, level: 0.12, type: 'highpass', freq: 1500, attack: 0.3, dest: a.out }));
  },

  /* ---------------------------------------------------------- 发动机 / 载具 */
  engine_start(a) {
    const c = a.ctx, t = a.t;
    // 起动机：低频连续敲击
    for (let i = 0; i < 4; i++) {
      const s = t + i * 0.15;
      a.add(oscHit(c, s, { type: 'sine', freq: 58, freqEnd: 46, dur: 0.12, level: 0.34, dest: a.out }));
      a.add(noiseHit(c, a.noise, s, { dur: 0.1, level: 0.12, type: 'lowpass', freq: 700, dest: a.out }));
    }
    a.add(oscHit(c, t, { type: 'sawtooth', freq: 60, freqEnd: 175, dur: 0.85, level: 0.12, sweep: 0.7, attack: 0.05, dest: a.out }));
    // 点火后转速爬升
    a.add(noiseHit(c, a.noise, t + 0.55, { dur: 1.1, level: 0.3, type: 'lowpass', freq: 400, freqEnd: 1500, attack: 0.2, dest: a.out }));
    a.add(oscHit(c, t + 0.55, { type: 'sawtooth', freq: 55, freqEnd: 135, dur: 1.0, level: 0.2, attack: 0.15, dest: a.out }));
  },
  engine_stop(a) {
    const c = a.ctx, t = a.t;
    a.add(oscHit(c, t, { type: 'sawtooth', freq: 165, freqEnd: 34, dur: 1.25, level: 0.22, sweep: 1.05, attack: 0.02, vibrato: 40, vibratoRate: 7, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 1.2, level: 0.24, type: 'lowpass', freq: 1500, freqEnd: 220, attack: 0.03, dest: a.out }));
    a.add(oscHit(c, t + 1.15, { type: 'sine', freq: 95, freqEnd: 40, dur: 0.25, level: 0.26, dest: a.out }));
  },

  /* ---------------------------------------------------------- 奖励 / 收集 */
  ring_pass(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    if (a.send) a.send.gain.value = 0.3;
    const notes = [880, 1320, 1760, 2640];
    for (let i = 0; i < notes.length; i++) {
      a.add(oscHit(c, t + i * 0.055, { type: 'sine', freq: notes[i] * r, dur: 0.45 - i * 0.05, level: 0.16 - i * 0.02, attack: 0.004, dest: a.out }));
    }
    a.add(noiseHit(c, a.noise, t, { dur: 0.5, level: 0.07, type: 'highpass', freq: 5000, attack: 0.02, dest: a.out }));
  },
  collect(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(oscHit(c, t, { type: 'triangle', freq: 1318 * r, dur: 0.11, level: 0.16, dest: a.out }));
    a.add(oscHit(c, t + 0.075, { type: 'triangle', freq: 1760 * r, dur: 0.3, level: 0.15, dest: a.out }));
    a.add(oscHit(c, t + 0.075, { type: 'sine', freq: 3520 * r, dur: 0.25, level: 0.05, dest: a.out }));
  },
  level_up(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    if (a.send) a.send.gain.value = 0.28;
    const notes = [523, 659, 784, 1047];
    for (let i = 0; i < notes.length; i++) {
      a.add(oscHit(c, t + i * 0.1, { type: 'triangle', freq: notes[i] * r, dur: i === 3 ? 0.55 : 0.14, level: 0.16, attack: 0.008, dest: a.out }));
    }
    a.add(noiseHit(c, a.noise, t + 0.3, { dur: 0.6, level: 0.08, type: 'highpass', freq: 4200, attack: 0.03, dest: a.out }));
  },
  money(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(oscHit(c, t, { type: 'square', freq: 1980 * r, dur: 0.09, level: 0.1, dest: a.out }));
    a.add(oscHit(c, t + 0.02, { type: 'square', freq: 2640 * r, dur: 0.14, level: 0.08, dest: a.out }));
    a.add(oscHit(c, t + 0.11, { type: 'sine', freq: 1320 * r, dur: 0.4, level: 0.12, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.05, level: 0.12, type: 'highpass', freq: 3600, dest: a.out }));
  },

  /* ---------------------------------------------------------- 逐零件损毁
   * 这一组都可能被高频触发（每帧多次），在 sfx() 里统一做 60ms 节流 +
   * 并发实例上限（同名 ≤6，合计 ≤20），见文件下方 DAMAGE_SFX。 */
  /* 机腹 / 零件蹭地：带通摩擦噪声 + 缓慢上滑的金属吱嘎 */
  scrape(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(noiseHit(c, a.noise, t, {
      dur: 0.5, level: 0.3, type: 'bandpass', freq: 1000, freqEnd: 1550, q: 1.7,
      attack: 0.03, sweep: 1, dest: a.out,
    }));
    a.add(noiseHit(c, a.noise, t + 0.04, {
      dur: 0.44, level: 0.16, type: 'lowpass', freq: 2400, freqEnd: 900, attack: 0.06, dest: a.out,
    }));
    // 金属吱嘎：两条失谐锯齿，缓慢上滑 + 颤音
    a.add(oscHit(c, t, {
      type: 'sawtooth', freq: 760 * r, freqEnd: 1140 * r, dur: 0.48, level: 0.05,
      attack: 0.07, vibrato: 30, vibratoRate: 11, sweep: 0.9, dest: a.out,
    }));
    a.add(oscHit(c, t + 0.03, {
      type: 'sawtooth', freq: 1150 * r, freqEnd: 1610 * r, dur: 0.42, level: 0.035,
      attack: 0.09, vibrato: 45, vibratoRate: 8, sweep: 0.9, dest: a.out,
    }));
  },
  /* 零件断裂脱落：宽频金属爆裂 + 失谐高频谐振 + 碎屑抖动 */
  metal_break(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(noiseHit(c, a.noise, t, { dur: 0.16, level: 0.42, type: 'highpass', freq: 2200, dest: a.out }));
    const res = [620, 1180, 1930, 2870, 4100];
    for (let i = 0; i < res.length; i++) {
      a.add(oscHit(c, t + i * 0.006, {
        type: 'triangle', freq: res[i] * r * (1 + i * 0.013), dur: 0.42 - i * 0.05,
        level: 0.075 - i * 0.011, attack: 0.002, hold: 0.01, dest: a.out,
      }));
    }
    a.add(noiseHit(c, a.noise, t + 0.1, {
      dur: 0.45, level: 0.14, type: 'bandpass', freq: 3400, freqEnd: 1800, q: 1.1, attack: 0.01, dest: a.out,
    }));
    // 碎屑抖动
    for (let i = 0; i < 4; i++) {
      a.add(noiseHit(c, a.noise, t + 0.18 + i * 0.09, { dur: 0.05, level: 0.08, type: 'highpass', freq: 4200, dest: a.out }));
    }
  },
  /* 碎片落地：3~5 次随机间隔的小金属敲击 + 轻噪声尾 */
  debris_fall(a) {
    const c = a.ctx, t = a.t;
    const n = 3 + ((Math.random() * 3) | 0);
    let pt = 0;
    for (let i = 0; i < n; i++) {
      pt += 0.15 + Math.random() * 0.2;
      const f = 300 + Math.random() * 900;
      a.add(oscHit(c, t + pt, { type: 'triangle', freq: f, freqEnd: f * 0.6, dur: 0.13, level: 0.11, attack: 0.002, dest: a.out }));
      a.add(noiseHit(c, a.noise, t + pt, {
        dur: 0.06, level: 0.09, type: 'bandpass', freq: 1800 + Math.random() * 1600, q: 1.4, dest: a.out,
      }));
    }
    a.add(noiseHit(c, a.noise, t, { dur: 1.15, level: 0.05, type: 'lowpass', freq: 800, freqEnd: 300, attack: 0.1, dest: a.out }));
  },
  /* 子弹打在机身上：极短的金属 ping + 噪声（音量小） */
  hull_hit(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    a.add(oscHit(c, t, { type: 'triangle', freq: 2350 * r, freqEnd: 1650 * r, dur: 0.07, level: 0.09, attack: 0.001, dest: a.out }));
    a.add(oscHit(c, t, { type: 'square', freq: 3760 * r, dur: 0.035, level: 0.03, attack: 0.001, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.045, level: 0.13, type: 'highpass', freq: 2600, dest: a.out }));
  },
  /* 导弹 / 大口径命中：低频冲击 + 金属破裂 + 短促碎片 */
  hull_hit_big(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    if (a.send) a.send.gain.value = 0.28;
    a.add(oscHit(c, t, { type: 'sine', freq: 150, freqEnd: 38, dur: 0.45, level: 0.5, sweep: 0.3, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.3, level: 0.4, type: 'lowpass', freq: 1800, freqEnd: 200, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, { dur: 0.1, level: 0.3, type: 'highpass', freq: 2400, dest: a.out }));
    const res = [740, 1390, 2260, 3350];
    for (let i = 0; i < res.length; i++) {
      a.add(oscHit(c, t + 0.02 + i * 0.008, {
        type: 'triangle', freq: res[i] * r, dur: 0.4 - i * 0.06, level: 0.06, hold: 0.008, dest: a.out,
      }));
    }
    a.add(noiseHit(c, a.noise, t + 0.35, {
      dur: 0.4, level: 0.1, type: 'bandpass', freq: 2600, freqEnd: 1400, q: 1.2, attack: 0.02, dest: a.out,
    }));
  },
  /* 发动机受损：不规则的断续喘振（低频脉冲 + 噪声爆发） */
  engine_sputter(a) {
    const c = a.ctx, t = a.t;
    const offs = [0, 0.09, 0.2, 0.26, 0.42, 0.47, 0.66, 0.72, 0.86];
    for (let i = 0; i < offs.length; i++) {
      const s = t + offs[i];
      const f = 62 - i * 2.5;
      a.add(oscHit(c, s, { type: 'sawtooth', freq: f, freqEnd: f * 0.62, dur: 0.1, level: 0.16, attack: 0.006, dest: a.out }));
      a.add(noiseHit(c, a.noise, s, { dur: 0.08, level: 0.1 + (i % 3) * 0.02, type: 'lowpass', freq: 900, freqEnd: 300, dest: a.out }));
    }
    a.add(noiseHit(c, a.noise, t, { dur: 1.0, level: 0.06, type: 'bandpass', freq: 500, q: 0.8, attack: 0.2, dest: a.out }));
  },
  /* 结构受损告警：两声短促方波警示（区别于 stall_warn / alarm） */
  damage_alarm(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    for (let i = 0; i < 2; i++) {
      const s = t + i * 0.24;
      a.add(oscHit(c, s, { type: 'square', freq: 1480 * r, dur: 0.13, level: 0.13, attack: 0.003, dest: a.out }));
      a.add(oscHit(c, s, { type: 'square', freq: 990 * r, dur: 0.15, level: 0.1, attack: 0.003, dest: a.out }));
      a.add(noiseHit(c, a.noise, s, { dur: 0.1, level: 0.03, type: 'bandpass', freq: 2600, q: 2, dest: a.out }));
    }
  },
  /* 机翼撕裂：低频撕裂噪声 + 上升的金属尖啸 */
  wing_tear(a) {
    const c = a.ctx, t = a.t, r = a.rate;
    if (a.send) a.send.gain.value = 0.22;
    a.add(noiseHit(c, a.noise, t, { dur: 0.65, level: 0.36, type: 'lowpass', freq: 900, freqEnd: 260, q: 0.9, attack: 0.004, dest: a.out }));
    a.add(noiseHit(c, a.noise, t, {
      dur: 0.6, level: 0.2, type: 'bandpass', freq: 700, freqEnd: 2200, q: 1.3, attack: 0.08, sweep: 0.9, dest: a.out,
    }));
    a.add(oscHit(c, t + 0.06, {
      type: 'sawtooth', freq: 720 * r, freqEnd: 2600 * r, dur: 0.55, level: 0.07,
      attack: 0.12, vibrato: 55, vibratoRate: 14, sweep: 0.85, dest: a.out,
    }));
    a.add(oscHit(c, t, { type: 'sine', freq: 120, freqEnd: 45, dur: 0.3, level: 0.3, dest: a.out }));
  },
};

/** 全部音效名（供 UI / 测试使用） */
export const SFX_NAMES = Object.keys(SFX);

/* 逐零件损毁音效集合：这些音效可能每帧被触发多次，需要节流与并发上限保护 */
const DAMAGE_SFX = {
  scrape: 1,
  metal_break: 1,
  debris_fall: 1,
  hull_hit: 1,
  hull_hit_big: 1,
  engine_sputter: 1,
  damage_alarm: 1,
  wing_tear: 1,
};
/** 同一音效最小触发间隔（秒） */
const SFX_THROTTLE = 0.06;
/** 同一音效同时播放的实例上限 */
const SFX_MAX_PER_NAME = 6;
/** 全部受保护音效的合计实例上限 */
const SFX_MAX_TOTAL = 20;

/* 引擎热路径的平滑斜坡工具（模块级函数：每帧调用不产生闭包/垃圾） */
function pOscFreq(o, f, now, tc) { o.frequency.setTargetAtTime(f > 1 ? f : 1, now, tc); }
function pFiltFreq(f, hz, now, tc) { f.frequency.setTargetAtTime(hz > 20 ? hz : 20, now, tc); }
function pGain(g, val, now, tc) { g.gain.setTargetAtTime(val > 0.0001 ? val : 0.0001, now, tc); }

/* ================================================================== 引擎 */

export class AudioEngine {
  constructor() {
    this._ctx = null;
    this._ready = false;
    this._master = null;
    this._sfxBus = null;
    this._musicBus = null;
    this._comp = null;
    this._reverbIn = null;
    this._musicPlayer = null;
    this._volMaster = 0.9;
    this._volMusic = 0.7;
    this._volSfx = 1;
    this._muted = false;
    this._voices = new Map();       // 引擎连续音：id -> voice
    this._releasing = [];           // 待回收的 voice（避免每帧遍历 Map）
    this._noiseCache = new Map();
    this._wind = null;
    this._time = 0;
    // 高频音效节流状态（普通对象，热路径查表无分配）
    this._sfxCd = Object.create(null);      // 音效名 -> 下次可用时间（ctx.currentTime）
    this._sfxCount = Object.create(null);   // 音效名 -> 正在播放的实例数
    this._sfxCountTotal = 0;                // 受保护音效的合计实例数
  }

  /** 音频是否可用 */
  get ready() {
    return this._ready;
  }

  /**
   * 初始化（必须由用户手势调用）：创建 AudioContext、总线、混响与音乐播放器。
   * 失败时静默降级为 no-op。
   * @returns {Promise<void>}
   */
  async init() {
    if (this._ready) return this.resume();
    try {
      const AC = typeof globalThis !== 'undefined' ? (globalThis.AudioContext || globalThis.webkitAudioContext) : null;
      if (!AC) return;
      const ctx = new AC({ latencyHint: 'interactive' });
      this._ctx = ctx;

      // 主总线：master -> 压缩器 -> 输出
      const master = ctx.createGain();
      master.gain.value = this._muted ? 0 : this._volMaster;
      let tail = master;
      if (typeof ctx.createDynamicsCompressor === 'function') {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -12;
        comp.knee.value = 16;
        comp.ratio.value = 3.5;
        comp.attack.value = 0.004;
        comp.release.value = 0.25;
        master.connect(comp);
        comp.connect(ctx.destination);
        this._comp = comp;
        tail = comp;
      } else {
        master.connect(ctx.destination);
      }
      this._master = master;

      const sfxBus = ctx.createGain();
      sfxBus.gain.value = this._volSfx;
      sfxBus.connect(master);
      this._sfxBus = sfxBus;

      const musicBus = ctx.createGain();
      musicBus.gain.value = this._volMusic;
      musicBus.connect(master);
      this._musicBus = musicBus;

      // 共享卷积混响（程序化脉冲响应）
      if (typeof ctx.createConvolver === 'function') {
        const conv = ctx.createConvolver();
        conv.buffer = makeImpulseResponse(ctx, 2.6, 2.6);
        const ret = ctx.createGain();
        ret.gain.value = 0.85;
        const send = ctx.createGain();
        send.gain.value = 1;
        send.connect(conv);
        conv.connect(ret);
        ret.connect(master);
        this._reverbIn = send;
      }

      this._musicPlayer = new MusicPlayer(ctx, musicBus, {
        noise: (sec) => this._noiseBuffer(sec),
        reverbIn: this._reverbIn,
      });
      this._ready = true;
      await this.resume();
    } catch (e) {
      this._ready = false;
      this._ctx = null;
    }
  }

  /** 恢复被浏览器挂起的 AudioContext（用户手势后可再次调用） */
  async resume() {
    try {
      if (this._ctx && this._ctx.state === 'suspended' && this._ctx.resume) await this._ctx.resume();
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------ 音量 */
  setMasterVolume(v01) {
    this._volMaster = clamp01(v01);
    this._applyGains();
  }

  setMusicVolume(v01) {
    this._volMusic = clamp01(v01);
    this._applyGains();
  }

  setSfxVolume(v01) {
    this._volSfx = clamp01(v01);
    this._applyGains();
  }

  /** 主音量（0..1，未乘静音） */
  getMasterVolume() {
    return this._volMaster;
  }

  getMusicVolume() {
    return this._volMusic;
  }

  getSfxVolume() {
    return this._volSfx;
  }

  setMuted(muted) {
    this._muted = !!muted;
    this._applyGains();
  }

  isMuted() {
    return this._muted;
  }

  _applyGains() {
    if (!this._ready || !this._ctx) return;
    try {
      const t = this._ctx.currentTime;
      const m = this._muted ? 0 : this._volMaster;
      this._master.gain.setTargetAtTime(m, t, 0.02);
      this._sfxBus.gain.setTargetAtTime(this._volSfx, t, 0.02);
      this._musicBus.gain.setTargetAtTime(this._volMusic, t, 0.02);
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------ 音乐 */
  /**
   * 播放音乐
   * @param {string} name MusicName
   * @param {{fade?:number, restart?:boolean}} [opts]
   */
  playMusic(name, opts) {
    if (!this._ready || !TRACKS[name]) return;
    try { this._musicPlayer.play(name, opts || EMPTY_OPTS); } catch (e) { /* 忽略 */ }
  }

  /** 停止音乐 */
  stopMusic(fade) {
    if (!this._ready) return;
    try { this._musicPlayer.stop(fade != null ? fade : 1.2); } catch (e) { /* 忽略 */ }
  }

  /** 当前曲目名（MusicName | null） */
  get currentMusic() {
    return this._ready && this._musicPlayer ? this._musicPlayer.current : null;
  }

  /* ------------------------------------------------------------ 单次音效 */
  /**
   * 播放一次性音效。
   * 逐零件损毁类音效（DAMAGE_SFX）会被高频触发，这里统一做保护：
   * 同名 60ms 内只响一次；同名并发实例 ≤6；全部受保护音效合计 ≤20。
   * @param {string} name SfxName
   * @param {{position?:{x:number,y:number,z:number}, volume?:number, rate?:number, distance?:number}} [opts]
   */
  sfx(name, opts) {
    if (!this._ready) return;
    const fn = SFX[name];
    if (!fn) return;
    const guarded = DAMAGE_SFX[name] === 1;
    if (guarded) {
      const now = this._ctx.currentTime;
      if (now < (this._sfxCd[name] || 0)) return;                                    // 节流
      if ((this._sfxCount[name] || 0) >= SFX_MAX_PER_NAME) return;                   // 同名实例上限
      if (this._sfxCountTotal >= SFX_MAX_TOTAL) return;                              // 合计实例上限
      this._sfxCd[name] = now + SFX_THROTTLE;
      this._sfxCount[name] = (this._sfxCount[name] || 0) + 1;
      this._sfxCountTotal++;
    }
    try {
      const a = this._sfxApi(opts || EMPTY_OPTS, guarded ? name : null);
      fn(a);
      this._sfxFinish(a);
    } catch (e) {
      if (guarded) this._releaseSfx(name);   // 异常时归还配额
    }
  }

  /** 归还一个受保护音效的实例配额 */
  _releaseSfx(name) {
    if (name == null) return;
    const n = this._sfxCount[name] || 0;
    if (n > 0) {
      this._sfxCount[name] = n - 1;
      if (this._sfxCountTotal > 0) this._sfxCountTotal--;
    }
  }

  /** 构造单次音效的 api（含输出节点、3D 声像、混响送出） */
  _sfxApi(o, release) {
    const ctx = this._ctx;
    const out = ctx.createGain();
    const vol = Number.isFinite(o.volume) ? Math.max(0, o.volume) : 1;
    out.gain.value = vol;
    const a = {
      ctx,
      t: ctx.currentTime + 0.002,
      rate: Number.isFinite(o.rate) ? clamp(o.rate, 0.25, 4) : 1,
      out,
      parts: [out],
      hits: [],       // {src, end}：用于在所有声部结束后统一断开
      end: 0,
      send: null,
      release: release || null,   // 需要回收配额的音效名
      noise: (sec) => this._noiseBuffer(sec),
      add: (hit) => {
        if (!hit) return hit;
        if (hit.src) a.hits.push(hit);
        if (hit.nodes) for (let i = 0; i < hit.nodes.length; i++) a.parts.push(hit.nodes[i]);
        if (hit.end > a.end) a.end = hit.end;
        return hit;
      },
    };
    let tail = out;
    if (o.position) {
      const pan = this._makePanner(o.position);
      if (pan) { out.connect(pan); a.parts.push(pan); tail = pan; }
    } else if (Number.isFinite(o.distance)) {
      out.gain.value = vol / (1 + Math.max(0, o.distance) / 90);
    }
    tail.connect(this._sfxBus);
    if (this._reverbIn) {
      const send = ctx.createGain();
      send.gain.value = Number.isFinite(o.reverb) ? clamp01(o.reverb) : 0.1;
      tail.connect(send);
      send.connect(this._reverbIn);
      a.parts.push(send);
      a.send = send;
    }
    return a;
  }

  /** 所有声部结束后自动断开该音效的全部节点，避免长连接残留 */
  _sfxFinish(a) {
    const parts = a.parts;
    const release = a.release;
    // 取“结束最晚”的那一路音源作为回收信号，避免掐掉较长的尾音
    let best = null;
    for (let i = 0; i < a.hits.length; i++) {
      if (!best || a.hits[i].end > best.end) best = a.hits[i];
    }
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      for (let i = 0; i < parts.length; i++) {
        try { parts[i].disconnect(); } catch (e) { /* 忽略 */ }
      }
      if (release) this._releaseSfx(release);
    };
    if (best) best.src.onended = cleanup;
    else cleanup();
  }

  /* ------------------------------------------------------------ 连续音（引擎/风） */
  /**
   * 创建 / 更新一路引擎音（按 id 复用）
   * @param {string|number} id
   * @param {{active:boolean, type?:string, rpm01?:number, throttle01?:number, position?:{x,y,z}, listenerDistance?:number}} params
   */
  engineSet(id, params) {
    if (!this._ready || !params) return;
    try {
      const now = this._ctx.currentTime;
      let v = this._voices.get(id);
      if (!params.active) {
        if (v) this._releaseEngine(v);
        return;
      }
      const type = params.type || 'prop';
      if (v && type !== v.type) { this._releaseEngine(v); v = null; }
      if (!v) {
        v = this._createEngineVoice(id, params);
        this._voices.set(id, v);
      }
      if (params.position && v.panner) this._setPannerPos(v.panner, params.position, now, 0.06);
      const rpm = clamp01(params.rpm01);
      const thr = clamp01(params.throttle01);
      this._applyEngine(v, rpm, thr, now);
      let lvl = 0.14 + 0.46 * thr * (0.3 + 0.7 * rpm);
      if (Number.isFinite(params.listenerDistance)) lvl /= 1 + Math.max(0, params.listenerDistance) / 70;
      v.out.gain.setTargetAtTime(Math.max(0.0001, lvl), now, 0.08);
      v.stopAt = 0;
    } catch (e) { /* 忽略 */ }
  }

  /** 座舱 / 机体风噪，0..1 */
  windSet(gain01) {
    if (!this._ready) return;
    try {
      const g = clamp01(gain01);
      if (!this._wind) {
        if (g <= 0.002) return;
        this._createWind();
      }
      const now = this._ctx.currentTime;
      this._wind.gain.gain.setTargetAtTime(Math.max(0.0001, g * 0.42), now, 0.15);
      this._wind.bp.frequency.setTargetAtTime(280 + g * 1600, now, 0.2);
      this._wind.lp.frequency.setTargetAtTime(1400 + g * 4200, now, 0.2);
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 设置听者位置/朝向（朝向缺省取速度方向，无速度则朝 -Z）
   * @param {{x:number,y:number,z:number}} pos
   * @param {{x:number,y:number,z:number}} [vel]
   */
  setListener(pos, vel) {
    if (!this._ready || !pos || !this._ctx) return;
    try {
      const l = this._ctx.listener;
      if (!l) return;
      const now = this._ctx.currentTime;
      const x = pos.x || 0, y = pos.y || 0, z = pos.z || 0;
      if (l.positionX) {
        l.positionX.setTargetAtTime(x, now, 0.02);
        l.positionY.setTargetAtTime(y, now, 0.02);
        l.positionZ.setTargetAtTime(z, now, 0.02);
      } else if (l.setPosition) {
        l.setPosition(x, y, z);
      }
      let fx = 0, fy = 0, fz = -1;
      if (vel && (vel.x || vel.y || vel.z)) {
        const len = Math.hypot(vel.x, vel.y, vel.z) || 1;
        fx = vel.x / len; fy = vel.y / len; fz = vel.z / len;
      }
      if (l.forwardX) {
        l.forwardX.setTargetAtTime(fx, now, 0.06);
        l.forwardY.setTargetAtTime(fy, now, 0.06);
        l.forwardZ.setTargetAtTime(fz, now, 0.06);
        l.upX.setTargetAtTime(0, now, 0.06);
        l.upY.setTargetAtTime(1, now, 0.06);
        l.upZ.setTargetAtTime(0, now, 0.06);
      } else if (l.setOrientation) {
        l.setOrientation(fx, fy, fz, 0, 1, 0);
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 每帧调用：推进音乐调度，回收已释放的引擎音（热路径，尽量零分配） */
  update(dt) {
    if (!this._ready) return;
    this._time += Number.isFinite(dt) ? dt : 0;
    try { this._musicPlayer.update(dt); } catch (e) { /* 忽略 */ }
    const rel = this._releasing;
    if (rel.length) {
      const now = this._ctx.currentTime;
      for (let i = rel.length - 1; i >= 0; i--) {
        if (now >= rel[i].stopAt) {
          this._destroyEngine(rel[i]);
          rel.splice(i, 1);
        }
      }
    }
  }

  /** 释放全部资源 */
  dispose() {
    try {
      if (this._musicPlayer) this._musicPlayer.dispose();
    } catch (e) { /* 忽略 */ }
    try {
      for (const v of this._voices.values()) this._destroyEngine(v);
    } catch (e) { /* 忽略 */ }
    this._voices.clear();
    try {
      for (let i = 0; i < this._releasing.length; i++) this._destroyEngine(this._releasing[i]);
    } catch (e) { /* 忽略 */ }
    this._releasing.length = 0;
    if (this._wind) {
      try { this._wind.src.stop(); } catch (e) { /* 忽略 */ }
      try { this._wind.gain.disconnect(); } catch (e) { /* 忽略 */ }
      this._wind = null;
    }
    try { if (this._ctx && this._ctx.state !== 'closed' && this._ctx.close) this._ctx.close(); } catch (e) { /* 忽略 */ }
    this._ctx = null;
    this._ready = false;
    // 清空节流状态
    this._sfxCd = Object.create(null);
    this._sfxCount = Object.create(null);
    this._sfxCountTotal = 0;
  }

  /* ------------------------------------------------------------ 内部实现 */

  /** 噪声缓冲缓存（按秒数取整复用） */
  _noiseBuffer(seconds) {
    const key = Math.max(0.1, Math.min(3, Number.isFinite(seconds) ? seconds : 1)).toFixed(1);
    let buf = this._noiseCache.get(key);
    if (!buf) {
      buf = makeNoiseBuffer(this._ctx, parseFloat(key));
      this._noiseCache.set(key, buf);
    }
    return buf;
  }

  /** 创建 3D 声像节点（失败返回 null，退化为普通连接） */
  _makePanner(pos) {
    const ctx = this._ctx;
    let p = null;
    try { p = ctx.createPanner(); } catch (e) { return null; }
    try { p.panningModel = 'HRTF'; } catch (e) { try { p.panningModel = 'equalpower'; } catch (e2) { /* 忽略 */ } }
    try {
      p.distanceModel = 'inverse';
      p.refDistance = 25;
      p.maxDistance = 15000;
      p.rolloffFactor = 1.1;
      p.coneInnerAngle = 360;
    } catch (e) { /* 忽略 */ }
    this._setPannerPos(p, pos, ctx.currentTime);
    return p;
  }

  _setPannerPos(p, pos, t, tc) {
    const x = pos.x || 0, y = pos.y || 0, z = pos.z || 0;
    if (p.positionX) {
      try {
        if (tc) {
          p.positionX.setTargetAtTime(x, t, tc);
          p.positionY.setTargetAtTime(y, t, tc);
          p.positionZ.setTargetAtTime(z, t, tc);
        } else {
          p.positionX.setValueAtTime(x, t);
          p.positionY.setValueAtTime(y, t);
          p.positionZ.setValueAtTime(z, t);
        }
        return;
      } catch (e) { /* 回退到 setPosition */ }
    }
    try { p.setPosition(x, y, z); } catch (e) { /* 忽略 */ }
  }

  /** 建立一路引擎 voice（只在 voice 不存在时调用，允许分配） */
  _createEngineVoice(id, p) {
    const ctx = this._ctx;
    const t = ctx.currentTime;
    const type = p.type || 'prop';
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    const v = {
      id, type, out, panner: null, sources: [], nodes: [out],
      filters: {}, parts: {}, stopAt: 0,
    };
    let tail = out;
    if (p.position) {
      const pan = this._makePanner(p.position);
      if (pan) {
        out.connect(pan);
        pan.connect(this._sfxBus);
        v.panner = pan;
        v.nodes.push(pan);
        tail = null;
      }
    }
    if (tail) tail.connect(this._sfxBus);

    // 音调总线：低通滤波后进入输出（螺旋桨/活塞的“机体”感）
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    lp.Q.value = 0.8;
    const toneBus = ctx.createGain();
    toneBus.gain.value = 1;
    toneBus.connect(lp);
    lp.connect(out);
    v.filters.lp = lp;
    v.nodes.push(lp, toneBus);

    // 振荡器（bus 缺省走音调总线；喷气/电动的高频啸叫直连输出）
    const mkOsc = (w, f, gain, det, bus) => {
      const o = ctx.createOscillator();
      o.type = w;
      o.frequency.value = f;
      if (det) o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(bus || toneBus);
      o.start(t);
      v.sources.push(o);
      v.nodes.push(g);
      return o;
    };
    // 循环噪声（滤波后直连输出）
    const mkNoise = (ft, f, q, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(2);
      src.loop = true;
      src.playbackRate.value = 1;
      const flt = ctx.createBiquadFilter();
      flt.type = ft;
      flt.frequency.value = f;
      flt.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(flt);
      flt.connect(g);
      g.connect(out);
      src.start(t);
      v.sources.push(src);
      v.nodes.push(flt, g);
      return { src, f: flt, g };
    };

    const P = v.parts;
    if (type === 'jet') {
      // 喷气：低频 rumble + 高频啸叫 + 宽带喷流噪声
      P.rumble = mkOsc('sine', 32, 0.9, 0, out);
      P.whine = mkOsc('sine', 900, 0.1, 0, out);
      P.whine2 = mkOsc('sine', 1230, 0.05, 9, out);
      P.air = mkNoise('bandpass', 1500, 0.6, 0.2);
      P.hiss = mkNoise('highpass', 900, 0.7, 0.05);
      lp.frequency.value = 260;
    } else if (type === 'turboprop') {
      // 涡桨：螺旋桨脉冲 + 涡轮啸叫 + 中频噪声
      P.pulse = mkOsc('sawtooth', 60, 0.36);
      P.pulse2 = mkOsc('square', 30, 0.22, -6);
      P.whine = mkOsc('sine', 700, 0.07, 0, out);
      P.wash = mkNoise('bandpass', 1200, 0.7, 0.16);
    } else if (type === 'car') {
      // 汽车：低转活塞脉冲 + 进气噪声
      P.pulse = mkOsc('sawtooth', 45, 0.5);
      P.pulse2 = mkOsc('square', 90, 0.22);
      P.rumble = mkOsc('sine', 28, 0.3);
      P.intake = mkNoise('lowpass', 700, 1.2, 0.13);
    } else if (type === 'electric') {
      // 电动：纯净高频电机啸叫 + 极轻气流
      P.whine = mkOsc('triangle', 400, 0.16, 0, out);
      P.whine2 = mkOsc('sine', 1600, 0.05, 6, out);
      P.air = mkNoise('highpass', 3000, 0.6, 0.03);
    } else {
      // 螺旋桨：锯齿 + 方波（基频 ∝ rpm × 桨叶脉冲）+ 带通噪声
      P.pulse = mkOsc('sawtooth', 70, 0.5);
      P.pulse2 = mkOsc('square', 35, 0.28, -8);
      P.harm = mkOsc('sawtooth', 140, 0.1);
      P.wash = mkNoise('bandpass', 900, 0.8, 0.16);
    }
    return v;
  }

  /** 引擎参数 -> 平滑斜坡（热路径：不做任何分配） */
  _applyEngine(v, rpm, thr, now) {
    const P = v.parts;
    switch (v.type) {
      case 'jet': {
        pOscFreq(P.rumble, 24 + rpm * 44, now, 0.15);
        pOscFreq(P.whine, 480 + rpm * 2300, now, 0.12);
        pOscFreq(P.whine2, 700 + rpm * 3200, now, 0.12);
        if (P.air) { pGain(P.air.g, 0.04 + 0.32 * thr * (0.25 + 0.75 * rpm), now, 0.1); pFiltFreq(P.air.f, 900 + rpm * 2600, now, 0.12); }
        if (P.hiss) { pGain(P.hiss.g, 0.015 + 0.1 * thr * (0.3 + 0.7 * rpm), now, 0.12); pFiltFreq(P.hiss.f, 300 + rpm * 900, now, 0.15); }
        break;
      }
      case 'turboprop': {
        const f0 = 40 + rpm * 95;
        pOscFreq(P.pulse, f0, now, 0.08);
        pOscFreq(P.pulse2, f0 * 0.5, now, 0.08);
        pOscFreq(P.whine, 380 + rpm * 900, now, 0.12);
        pFiltFreq(v.filters.lp, 200 + f0 * 6 + thr * 1500, now, 0.1);
        if (P.wash) { pGain(P.wash.g, 0.03 + 0.2 * thr * (0.3 + 0.7 * rpm), now, 0.12); pFiltFreq(P.wash.f, 700 + rpm * 1400, now, 0.14); }
        break;
      }
      case 'car': {
        const f0 = 26 + rpm * 120;
        pOscFreq(P.pulse, f0, now, 0.07);
        pOscFreq(P.pulse2, f0 * 2, now, 0.07);
        pOscFreq(P.rumble, f0 * 0.5, now, 0.1);
        pFiltFreq(v.filters.lp, 220 + f0 * 9 + thr * 2200, now, 0.09);
        if (P.intake) { pGain(P.intake.g, 0.02 + 0.16 * thr * (0.3 + 0.7 * rpm), now, 0.12); pFiltFreq(P.intake.f, 500 + rpm * 1400, now, 0.14); }
        break;
      }
      case 'electric': {
        pOscFreq(P.whine, 280 + rpm * 2600, now, 0.07);
        pOscFreq(P.whine2, 900 + rpm * 5200, now, 0.07);
        if (P.air) pGain(P.air.g, 0.008 + 0.05 * thr, now, 0.15);
        break;
      }
      default: {
        const f0 = 22 + rpm * 118;
        pOscFreq(P.pulse, f0, now, 0.08);
        pOscFreq(P.pulse2, f0 * 0.5, now, 0.08);
        pOscFreq(P.harm, f0 * 2, now, 0.08);
        pFiltFreq(v.filters.lp, 180 + f0 * 6 + thr * 1500, now, 0.1);
        if (P.wash) { pGain(P.wash.g, 0.025 + 0.24 * thr * (0.35 + 0.65 * rpm), now, 0.12); pFiltFreq(P.wash.f, 520 + rpm * 1500, now, 0.14); }
        break;
      }
    }
  }

  /** 淡出并登记回收 */
  _releaseEngine(v) {
    try {
      const now = this._ctx.currentTime;
      v.out.gain.setTargetAtTime(0.0001, now, 0.12);
      v.stopAt = now + 0.55;
    } catch (e) { /* 忽略 */ }
    this._voices.delete(v.id);
    this._releasing.push(v);
  }

  /** 停止音源并断开节点 */
  _destroyEngine(v) {
    try {
      const now = this._ctx ? this._ctx.currentTime : 0;
      for (let i = 0; i < v.sources.length; i++) {
        try { v.sources[i].stop(now + 0.02); } catch (e) { /* 忽略 */ }
      }
      for (let i = 0; i < v.nodes.length; i++) {
        try { v.nodes[i].disconnect(); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
    v.sources.length = 0;
    v.nodes.length = 0;
  }

  /** 风噪（持续循环） */
  _createWind() {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(2.5);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    g.connect(this._sfxBus);
    src.start();
    this._wind = { src, bp, lp, gain: g };
  }
}

/** 全局单例（主程序只应使用它） */
export const audio = new AudioEngine();
