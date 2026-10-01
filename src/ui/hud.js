// @ts-check
/**
 * src/ui/hud.js —— 飞行 HUD（平视显示器）叠加层。
 *
 * 设计要点（给集成者）：
 *  - 构造时传入一个铺满屏幕的容器 div；HUD 自己创建全部子节点：
 *      <canvas>            —— 所有仪表 / 世界标记（2D，devicePixelRatio 感知）
 *      .sp-hud__mission    —— 左上：任务名/目标/进度/计时/分数（DOM）
 *      .sp-hud__right      —— 右上：排行榜 + 右侧通知流（DOM）
 *  - 整个 HUD 默认 `pointer-events:none`，不会抢鼠标；容器需要 `position:relative|absolute` 且铺满视口。
 *  - 模块顶层不触碰 document / window，可在 Node 下 import（仅 `node --check`/单测安全）。
 *  - 每帧只做少量 DOM 文本 diff（值不变则不写 DOM），Canvas 侧使用对象池与路径复用，目标 60fps。
 *  - 所有字段读取都是防御式的：state 为 null、字段缺失、mission 为 null 都不会抛异常。
 *  - 单位：内部一律公制（m、m/s）；`ctx.units === 'imperial'` 时速度显示节、高度显示英尺。
 */

import * as THREE from 'three';
import { el, THEME, injectStyles } from './widgets.js';

/* ============================================================================
 * 常量与工具
 * ========================================================================== */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
/** 数值用等宽字体（与任务要求的字形列表一致）。 */
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';
const EMPTY_DASH = /** @type {number[]} */ ([]);
const DASH = /** @type {number[]} */ ([5, 4]);
const RING_DASH = /** @type {number[]} */ ([6, 8]);
const MPS_TO_KT = 1.943844;
const M_TO_FT = 3.280840;

/** 主题色（与 widgets.js 保持一致）。 */
const COL = Object.freeze({
  accent: THEME.accent,
  accentSoft: 'rgba(0,208,255,.30)',
  accentMid: 'rgba(0,208,255,.60)',
  accentFaint: 'rgba(0,208,255,.16)',
  ok: THEME.success,
  warn: THEME.warning,
  danger: THEME.danger,
  text: THEME.text,
  dim: THEME.textDim,
  faint: 'rgba(143,166,184,.45)',
  panel: 'rgba(8,14,22,.55)',
  panelSolid: 'rgba(6,11,18,.88)',
});

/**
 * 秒 → `M:SS` / `H:MM:SS`。
 * @param {number} sec
 * @returns {string}
 */
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (/** @type {number} */ v) => (v < 10 ? '0' + v : String(v));
  return h > 0 ? h + ':' + p2(m) + ':' + p2(ss) : m + ':' + p2(ss);
}

/**
 * 千分位整数（不依赖 locale）。
 * @param {number} v
 * @returns {string}
 */
function fmtInt(v) {
  const n = Math.round(Math.abs(v));
  let s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (v < 0 ? '-' : '') + out;
}

/**
 * 距离格式化（按单位制）。
 * @param {number} m 米
 * @param {boolean} imperial
 * @returns {string}
 */
function fmtDist(m, imperial) {
  if (!Number.isFinite(m)) return '--';
  if (imperial) {
    const ft = m * M_TO_FT;
    return ft < 5280 ? Math.round(ft) + ' ft' : (ft / 5280).toFixed(1) + ' mi';
  }
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}

/**
 * 数值安全读取。
 * @param {any} v @param {number} [d] @returns {number}
 */
function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : (d === undefined ? 0 : d);
}

/**
 * 布尔安全读取（兼容 0/1/字符串）。
 * @param {any} v @returns {boolean}
 */
function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * 钳制。
 * @param {number} v @param {number} a @param {number} b @returns {number}
 */
function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}

/**
 * 与帧率无关的平滑系数。
 * @param {number} dt @param {number} rate @returns {number}
 */
function smoothK(dt, rate) {
  return 1 - Math.exp(-dt * rate);
}

/**
 * 在数组中查找是否存在匹配某个正则的字符串（避免每帧创建闭包）。
 * @param {any} arr @param {RegExp} re @returns {boolean}
 */
function listHas(arr, re) {
  if (!Array.isArray(arr)) return false;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (typeof s === 'string' && re.test(s)) return true;
    if (s && typeof s.text === 'string' && re.test(s.text)) return true;
  }
  return false;
}

/**
 * 世界坐标 -> 屏幕坐标（复用模块级向量，零分配）。
 * @param {THREE.Camera} camera
 * @param {number} px @param {number} py @param {number} pz
 * @param {number} w @param {number} h
 * @returns {{x:number,y:number,ndcX:number,ndcY:number,front:boolean,dist:number}}
 */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _out = { x: 0, y: 0, ndcX: 0, ndcY: 0, front: false, dist: 0 };
function projectToScreen(camera, px, py, pz, w, h) {
  _v1.set(px, py, pz).applyMatrix4(camera.matrixWorldInverse);
  _out.front = _v1.z < -1e-4;
  _out.dist = Math.sqrt(_v1.x * _v1.x + _v1.y * _v1.y + _v1.z * _v1.z);
  _v2.set(px, py, pz).project(camera);
  _out.ndcX = _v2.x;
  _out.ndcY = _v2.y;
  _out.x = (_v2.x * 0.5 + 0.5) * w;
  _out.y = (-_v2.y * 0.5 + 0.5) * h;
  return _out;
}

/**
 * 距离升序（用于屏幕外标记排序，模块级函数避免每帧闭包）。
 * @param {{distance:number}} a @param {{distance:number}} b @returns {number}
 */
function byDistance(a, b) { return a.distance - b.distance; }

/**
 * 排行榜降序。
 * @param {{score:number}} a @param {{score:number}} b @returns {number}
 */
function byScoreDesc(a, b) { return num(b && b.score, 0) - num(a && a.score, 0); }

/**
 * @typedef {object} HudContext
 * @property {any} state         飞机状态（见 ARCH.md 的 AircraftState；spawn 之前可能为 null）
 * @property {THREE.Camera} camera
 * @property {any} mission       任务数据（可为 null）
 * @property {'metric'|'imperial'} [units]
 * @property {number} [fps]
 */

/* ============================================================================
 * 注入样式（HUD 专用；在构造时注入，模块顶层不触碰 document）
 * ========================================================================== */

const HUD_CSS = `
.sp-hud{
  position:absolute; inset:0; overflow:hidden;
  pointer-events:none; user-select:none;
  font-family:${THEME.font}; color:${THEME.text};
  z-index:30;
}
.sp-hud__canvas{ position:absolute; inset:0; width:100%; height:100%; display:block; }

.sp-hud__panel{
  position:absolute;
  padding:8px 10px;
  background:rgba(10,16,24,.62);
  border:1px solid ${THEME.border};
  border-radius:${THEME.radius}px;
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
  box-shadow:0 6px 20px rgba(0,0,0,.35);
  font-size:${THEME.fontSmall};
  line-height:1.35;
}

/* ---------- 左上：任务面板 ---------- */
.sp-hud__mission{ top:12px; left:12px; min-width:186px; max-width:min(40vw,340px); }
.sp-hud__mname{
  color:${THEME.accent}; font-weight:700; letter-spacing:.6px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  text-shadow:0 0 10px rgba(0,208,255,.35);
}
.sp-hud__mobj{
  margin-top:2px; color:${THEME.textDim};
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
}
.sp-hud__mrow{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-top:5px; }
.sp-hud__mprog,.sp-hud__mtimer,.sp-hud__mscore,.sp-hud__mmoney{
  font-family:${THEME.fontMono}; font-variant-numeric:tabular-nums; letter-spacing:.4px;
}
.sp-hud__mprog{ color:${THEME.text}; }
.sp-hud__mtimer{ color:${THEME.textDim}; }
.sp-hud__mtimer--danger{ color:${THEME.danger}; animation:sp-hud-blink .8s steps(2,end) infinite; }
.sp-hud__mscore{ color:${THEME.success}; }
.sp-hud__mmoney{ color:${THEME.warning}; }

/* ---------- 右上：排行榜 + 通知 ---------- */
.sp-hud__right{
  position:absolute; top:12px; right:12px;
  display:flex; flex-direction:column; align-items:flex-end; gap:8px;
  max-width:min(40vw,300px); max-height:calc(100% - 24px);
}
.sp-hud__lb{ position:relative; top:auto; left:auto; right:auto; min-width:172px; }
.sp-hud__lbtitle{
  color:${THEME.accent}; font-weight:700; letter-spacing:.8px; font-size:11px;
  text-shadow:0 0 10px rgba(0,208,255,.3); margin-bottom:4px;
}
.sp-hud__lbrow{
  display:flex; align-items:baseline; gap:6px;
  padding:2px 4px; border-radius:4px;
  font-size:${THEME.fontSmall};
}
.sp-hud__lbrow--me{
  background:rgba(0,208,255,.16);
  box-shadow:inset 0 0 0 1px rgba(0,208,255,.45);
}
.sp-hud__lbrank{ width:14px; color:${THEME.textDim}; font-family:${THEME.fontMono}; font-size:11px; }
.sp-hud__lbname{ flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sp-hud__lbrow--me .sp-hud__lbname{ color:${THEME.accent}; font-weight:700; }
.sp-hud__lbscore{
  font-family:${THEME.fontMono}; font-variant-numeric:tabular-nums; color:${THEME.text};
}

.sp-hud__notes{
  display:flex; flex-direction:column; align-items:flex-end; gap:6px;
  max-width:min(40vw,300px); overflow:hidden;
}
.sp-hud__note{
  display:flex; align-items:center; gap:7px;
  max-width:100%; padding:6px 10px;
  background:rgba(10,16,24,.72);
  border:1px solid ${THEME.border};
  border-left-width:3px;
  border-radius:${THEME.radiusSm}px;
  font-size:${THEME.fontSmall};
  animation:sp-hud-note-in .22s ease-out;
}
.sp-hud__notedot{ flex:0 0 auto; width:6px; height:6px; border-radius:50%; background:${THEME.accent}; box-shadow:0 0 8px currentColor; }
.sp-hud__notetext{ min-width:0; word-break:break-word; }
.sp-hud__note--info{ border-left-color:${THEME.accent}; }
.sp-hud__note--warn{ border-left-color:${THEME.warning}; color:#ffe6c7; }
.sp-hud__note--warn .sp-hud__notedot{ background:${THEME.warning}; }
.sp-hud__note--success{ border-left-color:${THEME.success}; color:#d8ffe9; }
.sp-hud__note--success .sp-hud__notedot{ background:${THEME.success}; }
.sp-hud__note--error{ border-left-color:${THEME.danger}; color:#ffdfe3; }
.sp-hud__note--error .sp-hud__notedot{ background:${THEME.danger}; }

@keyframes sp-hud-note-in{ from{ opacity:0; transform:translateX(26px); } to{ opacity:1; transform:none; } }
@keyframes sp-hud-blink{ 50%{ opacity:.25; } }
@media (prefers-reduced-motion: reduce){
  .sp-hud__note, .sp-hud__mtimer--danger{ animation:none !important; }
}
@media (max-width:720px){
  .sp-hud__mission{ max-width:min(52vw,260px); padding:6px 8px; }
  .sp-hud__right{ max-width:min(46vw,220px); }
}
`;

/* ============================================================================
 * HUD
 * ========================================================================== */

/**
 * 飞行 HUD。生命周期：`new HUD(container)` → 每帧 `update(dt, ctx)` → 卸载 `dispose()`。
 */
export class HUD {
  /**
   * @param {HTMLElement} container 铺满屏幕的容器（HUD 会往里塞自己的子节点）
   */
  constructor(container) {
    if (typeof document === 'undefined') throw new Error('HUD 需要 DOM 环境');
    injectStyles(HUD_CSS);

    /** @type {HTMLElement} */
    this._container = container;
    /** @type {boolean} @private */
    this._visible = true;
    /** @type {number} @private */
    this._t = 0;
    /** @type {number} @private */
    this._w = 1;
    /** @type {number} @private */
    this._h = 1;
    /** @type {number} @private */
    this._dpr = 1;
    /** @type {number} @private */
    this._lbT = 0;

    /* ---- 根节点 ---- */
    /** @type {HTMLElement} */
    this._root = el('div', { class: 'sp-hud', 'aria-hidden': 'true' });
    /** @type {HTMLCanvasElement} */
    this._canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'sp-hud__canvas' }));
    this._root.appendChild(this._canvas);
    /** @type {CanvasRenderingContext2D} */
    this._g = /** @type {CanvasRenderingContext2D} */ (this._canvas.getContext('2d'));

    /* ---- 左上任务面板 ---- */
    /** @type {HTMLElement} */
    this._dMission = el('div', { class: 'sp-hud__panel sp-hud__mission' });
    this._dMissionName = el('div', { class: 'sp-hud__mname' });
    this._dMissionObj = el('div', { class: 'sp-hud__mobj' });
    this._dMissionProg = el('span', { class: 'sp-hud__mprog' });
    this._dMissionTimer = el('span', { class: 'sp-hud__mtimer' });
    this._dScore = el('span', { class: 'sp-hud__mscore' });
    this._dMoney = el('span', { class: 'sp-hud__mmoney' });
    this._dMission.appendChild(this._dMissionName);
    this._dMission.appendChild(this._dMissionObj);
    this._dMission.appendChild(el('div', { class: 'sp-hud__mrow' }, [this._dMissionProg, this._dMissionTimer]));
    this._dMission.appendChild(el('div', { class: 'sp-hud__mrow' }, [this._dScore, this._dMoney]));
    this._root.appendChild(this._dMission);

    /* ---- 右上排行榜 + 通知 ---- */
    this._dRight = el('div', { class: 'sp-hud__right' });
    this._dLb = el('div', { class: 'sp-hud__panel sp-hud__lb' });
    this._dLbBody = el('div', {});
    this._dLb.appendChild(el('div', { class: 'sp-hud__lbtitle', text: 'LEADERBOARD' }));
    this._dLb.appendChild(this._dLbBody);
    this._dNotes = el('div', { class: 'sp-hud__notes' });
    this._dRight.appendChild(this._dLb);
    this._dRight.appendChild(this._dNotes);
    this._root.appendChild(this._dRight);

    if (container && container.appendChild) container.appendChild(this._root);

    /* ---- DOM 缓存（避免每帧写 DOM） ---- */
    /** @type {Record<string,string>} @private */
    this._c = {};
    /** @type {boolean} @private */
    this._missionShown = false;
    /** @type {boolean} @private */
    this._lbShown = false;
    /** @type {Map<number, {row:HTMLElement,rank:HTMLElement,name:HTMLElement,score:HTMLElement,r:string,n:string,s:string}>} @private */
    this._lbRows = new Map();

    /* ---- 通知 ---- */
    /** @type {Array<{node:HTMLElement,text:string,kind:string,ttl:number,age:number,_bound:boolean,_o:number,_gone?:boolean}>} @private */
    this._notes = [];
    /** 最近移除过的消息（防止任务侧未清理 messages 时反复弹出） @type {Map<string,number>} @private */
    this._recent = new Map();

    /* ---- 闪烁效果计时 ---- */
    /** @private */
    this._flash = { damage: 0, hit: 0, kill: 0, stall: 0, warning: 0 };

    /* ---- 平滑显示值（避免仪表抖动） ---- */
    /** @private */
    this._disp = {
      speed: 0, mach: 0, alt: 0, agl: 0, vs: 0, heading: 0,
      pitch: 0, roll: 0, throttle: 0, rpm: 0, fuel: 1, g: 1,
      aoa: 0, slip: 0, gear01: 0, flaps01: 0, airbrake01: 0,
    };
    /** @type {any} @private */
    this._state = null;
    /** @type {any} @private */
    this._hud = null;

    /* ---- 对象池：世界标记 ---- */
    /** @type {Array<any>} @private */
    this._pool = [];
    /** @type {number} @private */
    this._mc = 0;
    /** @type {Array<any>} @private */
    this._off = [];

    /* ---- 对象池：武器分组 ---- */
    /** @type {Array<any>} @private */
    this._weapons = [];
    /** @type {number} @private */
    this._weaponCount = 0;

    /* ---- 布局 ---- */
    /** @type {any} @private */
    this._L = {};

    /* ---- 暗角贴图（离屏 canvas，一次性生成，每帧一次 drawImage） ---- */
    this._vigDamage = this._makeVignette('255,60,80', .72);
    this._vigWarn = this._makeVignette('255,159,67', .55);
    this._vigOk = this._makeVignette('61,220,132', .45);

    this.resize();
    this.setVisible(true);
  }

  /* ==========================================================================
   * 公共 API
   * ======================================================================== */

  /** 当前是否可见。 @returns {boolean} */
  get visible() { return this._visible; }

  /**
   * 显示 / 隐藏（隐藏时 update() 直接返回，不绘制）。
   * @param {boolean} v
   * @returns {void}
   */
  setVisible(v) {
    this._visible = !!v;
    if (this._root) this._root.style.display = this._visible ? '' : 'none';
  }

  /**
   * 窗口 / 容器尺寸变化时调用：重算 canvas 像素尺寸与全部布局锚点。
   * @returns {void}
   */
  resize() {
    const c = this._container;
    const winW = typeof window !== 'undefined' ? (window.innerWidth || 1280) : 1280;
    const winH = typeof window !== 'undefined' ? (window.innerHeight || 720) : 720;
    const w = Math.max(240, Math.round((c && c.clientWidth) || winW));
    const h = Math.max(180, Math.round((c && c.clientHeight) || winH));

    const rawDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const dpr = clamp(rawDpr, 1, 2); // 上限 2，4K 屏也不至于填充率爆炸

    this._w = w;
    this._h = h;
    this._dpr = dpr;
    this._canvas.width = Math.max(1, Math.round(w * dpr));
    this._canvas.height = Math.max(1, Math.round(h * dpr));
    this._canvas.style.width = w + 'px';
    this._canvas.style.height = h + 'px';
    if (this._g) this._g.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._layout();
  }

  /**
   * 每帧更新并重绘。
   * @param {number} dt 秒
   * @param {HudContext} ctx
   * @returns {void}
   */
  /** 宿主可强制紧凑布局（移动端）。传 null 恢复自动判断。 */
  setCompact(v) { this.forceCompact = (v === null || v === undefined) ? null : !!v; this._layout(); }

  update(dt, ctx) {
    if (!this._visible || !this._g) return;
    const step = clamp(num(dt, 0), 0, 0.12);
    this._t += step;

    const hud = ctx || /** @type {any} */ ({});
    this._hud = hud;
    const st = hud.state && typeof hud.state === 'object' ? hud.state : null;
    this._state = st;

    this._smooth(step, st);
    this._ticks(step);
    this._updateNotes(step, hud);
    this._updateMission(step, hud);
    this._updateLeaderboard(step, hud);
    this._draw(hud, st);
  }

  /**
   * 弹出一条通知（进入右侧通知流，与 `mission.messages` 共用同一列表）。
   * @param {string} text
   * @param {number} [duration] `>30` 视为毫秒，否则视为秒；默认 3.5s
   * @param {'info'|'warn'|'success'|'error'} [kind]
   * @returns {void}
   */
  showMessage(text, duration, kind) {
    const s = text == null ? '' : String(text);
    if (!s) return;
    const k = this._normKind(kind);
    const ttl = duration === undefined || !Number.isFinite(duration)
      ? 3.5
      : (duration > 30 ? duration / 1000 : duration);
    this._addNote(s, k, Math.max(0.4, ttl));
  }

  /**
   * 触发短促的全屏效果。
   * @param {'damage'|'stall'|'warning'|'hit'|'kill'} kind
   * @returns {void}
   */
  flash(kind) {
    const f = this._flash;
    switch (kind) {
      case 'damage': f.damage = Math.min(1.2, f.damage + 0.6); break;
      case 'hit': f.hit = 0.4; break;
      case 'kill': f.kill = 1.8; break;
      case 'stall': f.stall = 1.2; break;
      case 'warning': f.warning = 1.0; break;
      default: f.warning = 0.8; break;
    }
  }

  /** 卸载：移除 DOM 与引用。 @returns {void} */
  dispose() {
    this._notes.length = 0;
    this._lbRows.clear();
    this._pool.length = 0;
    this._weapons.length = 0;
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._g = /** @type {any} */ (null);
    this._root = /** @type {any} */ (null);
    this._canvas = /** @type {any} */ (null);
    this._visible = false;
  }

  /* ==========================================================================
   * 内部：状态平滑 / 计时器
   * ======================================================================== */

  /**
   * 把 state 的原始值平滑成显示值（各仪表共用，避免抖动）。
   * @param {number} dt @param {any} st @private
   */
  _smooth(dt, st) {
    const d = this._disp;
    if (!st) {
      // 无飞机：仪表归零（保留燃料等中性值），仍然平滑过渡
      const k = smoothK(dt, 4);
      d.speed += (0 - d.speed) * k;
      d.mach += (0 - d.mach) * k;
      d.alt += (0 - d.alt) * k;
      d.agl += (0 - d.agl) * k;
      d.vs += (0 - d.vs) * k;
      d.throttle += (0 - d.throttle) * k;
      d.rpm += (0 - d.rpm) * k;
      d.g += (1 - d.g) * k;
      d.aoa += (0 - d.aoa) * k;
      d.slip += (0 - d.slip) * k;
      d.gear01 += (0 - d.gear01) * k;
      d.flaps01 += (0 - d.flaps01) * k;
      d.airbrake01 += (0 - d.airbrake01) * k;
      return;
    }

    const kFast = smoothK(dt, 14);
    const kMid = smoothK(dt, 9);
    const kSlow = smoothK(dt, 5);

    d.speed += (num(st.speed, 0) - d.speed) * kMid;
    d.mach += (num(st.mach, 0) - d.mach) * kMid;
    d.alt += (num(st.altitudeASL, 0) - d.alt) * kMid;
    d.agl += (num(st.altitudeAGL, 0) - d.agl) * kMid;
    d.vs += (num(st.verticalSpeed, 0) - d.vs) * kSlow;
    d.pitch += (num(st.pitch, 0) - d.pitch) * kFast;
    d.roll += (num(st.roll, 0) - d.roll) * kFast;

    // 航向按最短弧平滑
    const hTarget = num(st.heading, 0);
    let dh = ((hTarget - d.heading + 540) % 360) - 180;
    d.heading = (d.heading + dh * kMid + 360) % 360;

    d.throttle += (clamp(num(st.throttle, 0), 0, 1) - d.throttle) * kMid;
    d.rpm += (clamp(num(st.rpm01, 0), 0, 1) - d.rpm) * kMid;
    d.fuel += (clamp(num(st.fuel01, 1), 0, 1) - d.fuel) * kSlow;
    d.g += (num(st.gForce, 1) - d.g) * kMid;
    d.aoa += (num(st.aoa, 0) - d.aoa) * kMid;
    d.slip += (num(st.slip, 0) - d.slip) * kMid;
    d.gear01 += (clamp(num(st.gear01, st.gearDown ? 1 : 0), 0, 1) - d.gear01) * kSlow;
    d.flaps01 += (clamp(num(st.flaps01, 0), 0, 1) - d.flaps01) * kSlow;
    d.airbrake01 += (clamp(num(st.airbrake01, 0), 0, 1) - d.airbrake01) * kSlow;
  }

  /** 闪烁计时衰减。 @param {number} dt @private */
  _ticks(dt) {
    const f = this._flash;
    if (f.damage > 0) f.damage = Math.max(0, f.damage - dt);
    if (f.hit > 0) f.hit = Math.max(0, f.hit - dt);
    if (f.kill > 0) f.kill = Math.max(0, f.kill - dt);
    if (f.stall > 0) f.stall = Math.max(0, f.stall - dt);
    if (f.warning > 0) f.warning = Math.max(0, f.warning - dt);
  }

  /** 生成红色/琥珀色/绿色暗角贴图（只做一次）。 @param {string} rgb @param {number} a @returns {HTMLCanvasElement} @private */
  _makeVignette(rgb, a) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    if (!g) return c;
    const grd = g.createRadialGradient(128, 128, 42, 128, 128, 158);
    grd.addColorStop(0, 'rgba(' + rgb + ',0)');
    grd.addColorStop(0.55, 'rgba(' + rgb + ',' + (a * 0.12).toFixed(3) + ')');
    grd.addColorStop(1, 'rgba(' + rgb + ',' + a.toFixed(3) + ')');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    return c;
  }

  /* ==========================================================================
   * 内部：布局
   * ======================================================================== */

  /** 计算所有仪表锚点。 @private */
  _layout() {
    const w = this._w;
    const h = this._h;
    // 紧凑布局：窄屏 或 宿主显式要求（手机横屏宽度常常 >640，需要外部开关）
    const compact = this.forceCompact === true || w < 640;

    const r = clamp(Math.min(w * 0.15, (h - 210) / 2.2, 170), 46, 170);
    const cx = w * 0.5;
    const cy = h * 0.5;

    const gap = compact ? 14 : 40;
    const tapeW = compact ? 46 : clamp(w * 0.055, 52, 78);
    const tapeH = Math.min(r * 1.9, h * 0.52);

    const barW = clamp(w * 0.1, 70, 138);
    const aoaW = compact ? 84 : 106;
    const lightW = compact ? 126 : 154;
    const gW = 62;
    const row1W = barW * 3 + 28;
    const row2W = gW + aoaW + lightW + 18;
    const bottomY = cy + r + (compact ? 30 : 38);

    this._L = {
      w, h, compact, r, cx, cy,
      showTapes: w > 430,
      showRow2: bottomY + 62 < h,
      tapeW, tapeH, gap,
      spdX: cx - r - gap - tapeW,
      altX: cx + r + gap,
      headW: Math.min(w * (compact ? 0.46 : 0.38), 420),
      headH: 30,
      headY: Math.max(6, cy - r - (compact ? 48 : 66)),
      barW, aoaW, lightW, gW, row1W, row2W,
      groupX: cx - Math.max(row1W, row2W) * 0.5,
      bottomY,
      row2Y: bottomY + 34,
    };
  }

  /* ==========================================================================
   * 内部：DOM 更新（值不变则不写 DOM）
   * ======================================================================== */

  /**
   * 只在文本变化时写 DOM。
   * @param {HTMLElement} node @param {string} key @param {string} text @private
   */
  _set(node, key, text) {
    if (this._c[key] === text) return;
    this._c[key] = text;
    node.textContent = text;
  }

  /**
   * 任务面板。
   * @param {number} dt @param {any} hud @private
   */
  _updateMission(dt, hud) {
    const m = hud.mission;
    if (!m || typeof m !== 'object') {
      if (this._missionShown) { this._dMission.style.display = 'none'; this._missionShown = false; }
      return;
    }
    if (!this._missionShown) { this._dMission.style.display = ''; this._missionShown = true; }

    const name = (m.name ? String(m.name) : 'MISSION') + (m.mode ? ' \u00b7 ' + String(m.mode) : '');
    this._set(this._dMissionName, 'mname', name);
    this._set(this._dMissionObj, 'mobj', m.objective ? String(m.objective) : '');

    const p = m.progress;
    this._set(this._dMissionProg, 'mprog', p ? num(p.current, 0) + '/' + num(p.total, 0) : '');

    const hasTimer = Number.isFinite(m.timerSec);
    const tsec = hasTimer ? num(m.timerSec, 0) : num(m.timeElapsed, 0);
    this._set(this._dMissionTimer, 'mtimer', (hasTimer ? '\u23f1 ' : '\u23f1 ') + fmtTime(tsec));
    const danger = hasTimer && num(m.timerSec, 999) < 10;
    const cls = 'sp-hud__mtimer' + (danger ? ' sp-hud__mtimer--danger' : '');
    if (this._c['mtcls'] !== cls) { this._c['mtcls'] = cls; this._dMissionTimer.className = cls; }

    this._set(this._dScore, 'mscore', Number.isFinite(m.score) ? '\u2605 ' + fmtInt(num(m.score, 0)) : '');
    this._set(this._dMoney, 'mmoney', Number.isFinite(m.money) ? '$' + fmtInt(num(m.money, 0)) : '');
  }

  /**
   * 排行榜（10Hz 刷新，行元素复用）。
   * @param {number} dt @param {any} hud @private
   */
  _updateLeaderboard(dt, hud) {
    const m = hud.mission;
    const list = m && Array.isArray(m.competitors) ? m.competitors : null;
    if (!list || list.length === 0) {
      if (this._lbShown) { this._dLb.style.display = 'none'; this._lbShown = false; }
      return;
    }
    if (!this._lbShown) { this._dLb.style.display = ''; this._lbShown = true; }

    this._lbT += dt;
    if (this._lbT < 0.1) return;
    this._lbT = 0;

    const sorted = list.slice(0).sort(byScoreDesc);
    const n = Math.min(sorted.length, 10);
    for (let i = 0; i < n; i++) {
      const c = sorted[i] || {};
      let rec = this._lbRows.get(i);
      if (!rec) rec = this._mkLbRow(i);
      const rk = String(i + 1);
      const nm = c.name == null ? '---' : String(c.name);
      const sc = fmtInt(num(c.score, 0));
      if (rec.r !== rk) { rec.r = rk; rec.rank.textContent = rk; }
      if (rec.n !== nm) { rec.n = nm; rec.name.textContent = nm; }
      if (rec.s !== sc) { rec.s = sc; rec.score.textContent = sc; }
      const me = truthy(c.isPlayer);
      if (rec.row.dataset.me !== String(me)) {
        rec.row.dataset.me = String(me);
        rec.row.className = 'sp-hud__lbrow' + (me ? ' sp-hud__lbrow--me' : '');
      }
    }
    for (const [idx, rec] of this._lbRows) {
      const on = idx < n;
      if (rec.row.hidden === on) rec.row.hidden = !on;
    }
  }

  /**
   * 新建一行排行榜 DOM。
   * @param {number} idx @private
   */
  _mkLbRow(idx) {
    const rank = el('span', { class: 'sp-hud__lbrank' });
    const name = el('span', { class: 'sp-hud__lbname' });
    const score = el('span', { class: 'sp-hud__lbscore' });
    const row = el('div', { class: 'sp-hud__lbrow' }, [rank, name, score]);
    this._dLbBody.appendChild(row);
    const rec = { row, rank, name, score, r: '', n: '', s: '' };
    this._lbRows.set(idx, rec);
    return rec;
  }

  /* ==========================================================================
   * 内部：通知流
   * ======================================================================== */

  /** @param {any} kind @returns {'info'|'warn'|'success'|'error'} @private */
  _normKind(kind) {
    return kind === 'warn' || kind === 'success' || kind === 'error' ? kind : 'info';
  }

  /**
   * 新增一条通知 DOM。
   * @param {string} text @param {string} kind @param {number} ttl @private
   */
  _addNote(text, kind, ttl) {
    while (this._notes.length >= 6) this._removeNote(this._notes.shift());
    const node = el('div', { class: 'sp-hud__note sp-hud__note--' + kind });
    node.appendChild(el('span', { class: 'sp-hud__notedot' }));
    node.appendChild(el('span', { class: 'sp-hud__notetext', text }));
    this._dNotes.appendChild(node);
    const entry = { node, text, kind, ttl, age: 0, _bound: false, _o: 1 };
    this._notes.push(entry);
    return entry;
  }

  /** @param {any} entry @private */
  _removeNote(entry) {
    if (!entry) return;
    if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
  }

  /**
   * 同步 `mission.messages` 与本地 showMessage 通知；按 ttl 淡出。
   * @param {number} dt @param {any} hud @private
   */
  _updateNotes(dt, hud) {
    const m = hud.mission;
    const list = m && Array.isArray(m.messages) ? m.messages : null;
    const notes = this._notes;
    for (let i = 0; i < notes.length; i++) notes[i]._bound = false;

    if (list) {
      for (let i = 0; i < list.length && i < 24; i++) {
        const msg = list[i];
        if (!msg || typeof msg.text !== 'string' || !msg.text) continue;
        const kind = this._normKind(msg.kind);
        const key = kind + '\u0000' + msg.text;
        let entry = null;
        for (let j = 0; j < notes.length; j++) {
          const e = notes[j];
          if (!e._bound && !e._gone && e.text === msg.text && e.kind === kind) { entry = e; break; }
        }
        if (!entry) {
          // 刚因为 ttl 用尽而移除的同名消息在 1.5s 内不再重复弹出
          const goneAt = this._recent.get(key);
          if (goneAt !== undefined && this._t - goneAt < 1.5) continue;
          entry = this._addNote(msg.text, kind, Math.max(0.4, num(msg.ttl, 3.5)));
        }
        entry._bound = true;
        const t = num(msg.ttl, NaN);
        if (Number.isFinite(t)) entry.ttl = Math.min(entry.ttl, Math.max(0, t));
      }
    }

    for (let i = notes.length - 1; i >= 0; i--) {
      const e = notes[i];
      e.ttl -= dt;
      e.age += dt;
      if (e.ttl <= 0 || e.age > 20) {
        e._gone = true;
        this._removeNote(e);
        notes.splice(i, 1);
        if (e._bound) {
          this._recent.set(e.kind + '\u0000' + e.text, this._t);
          if (this._recent.size > 32) {
            for (const [k, when] of this._recent) {
              if (this._t - when > 3) this._recent.delete(k);
            }
          }
        }
        continue;
      }
      const o = Math.round(clamp(e.ttl / 0.5, 0, 1) * 20) / 20;
      if (o !== e._o) { e._o = o; e.node.style.opacity = String(o); }
    }
  }

  /* ==========================================================================
   * 内部：绘制
   * ======================================================================== */

  /**
   * 主绘制。
   * @param {any} hud @param {any} st @private
   */
  _draw(hud, st) {
    const g = this._g;
    if (!g) return;
    const L = this._L;
    const w = L.w;
    const h = L.h;
    g.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    g.setLineDash(EMPTY_DASH);

    const s = this._disp;
    const imperial = hud.units === 'imperial';

    // 1) 世界标记（压在仪表下方）
    this._drawMarkers(g, hud, w, h);

    // 2) 仪表
    if (st) {
      if (L.showTapes) {
        this._drawSpeedTape(g, L, s, imperial);
        this._drawAltTape(g, L, s, imperial);
      }
      this._drawHorizon(g, L, s);
      this._drawHeading(g, L, s);
      this._drawStatus(g, L, s, st);
      this._drawWeapons(g, L, st);
    } else {
      // 未出生：只画提示文字
      g.font = '600 13px ' + MONO;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = COL.dim;
      g.fillText('\u2014 NO AIRCRAFT \u2014', L.cx, L.cy);
    }

    // 3) 警示 / 闪烁 / 暗角
    this._drawWarnings(g, L, st, hud);
    this._drawFlash(g, w, h, L);
    this._drawVignette(g, w, h, st);

    // 4) FPS
    if (Number.isFinite(hud.fps)) {
      const f = num(hud.fps, 0);
      g.font = '600 11px ' + MONO;
      g.textAlign = 'right';
      g.textBaseline = 'bottom';
      g.fillStyle = f < 30 ? COL.warn : COL.faint;
      g.fillText(Math.round(f) + ' FPS', w - 12, h - 10);
    }
  }

  /* ---------------- 人工地平仪 ---------------- */

  /**
   * 人工地平仪：天地着色 + 俯仰梯（每 5°）+ 滚转刻度 + 侧滑球 + 固定基准。
   * @param {CanvasRenderingContext2D} g @param {any} L @param {any} s @private
   */
  _drawHorizon(g, L, s) {
    const cx = L.cx;
    const cy = L.cy;
    const r = L.r;
    const ppx = r / 24;            // 每度像素（可见约 ±24°）
    const hzY = s.pitch * ppx;     // 天地线在屏幕上的 y（机头向上 → 下移）

    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-s.roll * DEG);

    // 天空 / 地面
    const skyH = Math.max(0, hzY + r * 2);
    g.fillStyle = 'rgba(16,70,116,.40)';
    g.fillRect(-r * 2, -r * 2, r * 4, skyH);
    g.fillStyle = 'rgba(92,58,24,.42)';
    g.fillRect(-r * 2, hzY, r * 4, r * 4);

    // 天地线
    g.strokeStyle = COL.accent;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(-r * 1.6, hzY);
    g.lineTo(r * 1.6, hzY);
    g.stroke();

    // 俯仰梯：先画虚线（负角），再画实线（正角）—— 只切换一次线型，减少状态抖动
    const loY = -r * 1.4;
    const hiY = r * 1.4;
    g.lineWidth = 1;
    g.strokeStyle = COL.accentSoft;
    g.setLineDash(DASH);
    g.beginPath();
    for (let d = -90; d < 0; d += 5) {
      const y = hzY - d * ppx;
      if (y < loY || y > hiY) continue;
      const half = d % 10 === 0 ? r * 0.42 : r * 0.2;
      const gapHalf = half * 0.33;
      g.moveTo(-half, y); g.lineTo(-gapHalf, y);
      g.moveTo(gapHalf, y); g.lineTo(half, y);
    }
    g.stroke();
    g.setLineDash(EMPTY_DASH);
    g.beginPath();
    for (let d = 5; d <= 90; d += 5) {
      const y = hzY - d * ppx;
      if (y < loY || y > hiY) continue;
      const half = d % 10 === 0 ? r * 0.42 : r * 0.2;
      const gapHalf = half * 0.33;
      g.moveTo(-half, y); g.lineTo(-gapHalf, y);
      g.moveTo(gapHalf, y); g.lineTo(half, y);
    }
    g.stroke();

    // 俯仰数字（10° 整数倍）
    g.font = '600 11px ' + MONO;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = COL.text;
    for (let d = -90; d <= 90; d += 10) {
      if (d === 0) continue;
      const y = hzY - d * ppx;
      if (y < loY || y > hiY) continue;
      g.fillText(String(Math.abs(d)), 0, y);
    }

    // 滚转刻度（跟随机体旋转，顶部固定指针指向当前坡度）
    g.strokeStyle = COL.accentMid;
    g.lineWidth = 1.2;
    g.beginPath();
    for (let t = -60; t <= 60; t += 10) {
      const a = (-90 + t) * DEG;
      const long = t % 30 === 0;
      const r0 = r - (long ? 11 : 6);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      g.moveTo(ca * r0, sa * r0);
      g.lineTo(ca * (r - 1), sa * (r - 1));
    }
    g.stroke();
    g.font = '9px ' + MONO;
    g.fillStyle = COL.dim;
    for (let t = -60; t <= 60; t += 30) {
      if (t === 0) continue;
      const a = (-90 + t) * DEG;
      g.fillText(String(Math.abs(t)), Math.cos(a) * (r - 21), Math.sin(a) * (r - 21));
    }
    g.restore();

    // 外圈
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.strokeStyle = COL.accentMid;
    g.lineWidth = 2;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, r + 5, 0, TAU);
    g.strokeStyle = COL.accentFaint;
    g.lineWidth = 1;
    g.stroke();

    // 顶部固定滚转指针
    g.fillStyle = COL.accent;
    g.beginPath();
    g.moveTo(cx, cy - r + 6);
    g.lineTo(cx - 6, cy - r - 5);
    g.lineTo(cx + 6, cy - r - 5);
    g.closePath();
    g.fill();

    // 侧滑球（固定坐标系）
    const slip = clamp(s.slip * 6, -1, 1);
    const by = cy - r + 20;
    g.strokeStyle = COL.accentFaint;
    g.lineWidth = 1;
    g.strokeRect(cx - 22, by - 5, 44, 10);
    g.fillStyle = Math.abs(slip) > 0.6 ? COL.warn : COL.accent;
    g.beginPath();
    g.arc(cx + slip * 18, by, 3.6, 0, TAU);
    g.fill();

    // 机体基准（水线）
    g.strokeStyle = COL.accent;
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(cx - 34, cy);
    g.lineTo(cx - 12, cy);
    g.moveTo(cx + 12, cy);
    g.lineTo(cx + 34, cy);
    g.moveTo(cx, cy - 5);
    g.lineTo(cx, cy + 5);
    g.stroke();
  }

  /* ---------------- 航向带 ---------------- */

  /**
   * 顶部航向带（N/E/S/W + 数字 + 固定指针）。
   * @param {CanvasRenderingContext2D} g @param {any} L @param {any} s @private
   */
  _drawHeading(g, L, s) {
    const cx = L.cx;
    const w = L.headW;
    const x0 = cx - w * 0.5;
    const y = L.headY;
    const hh = L.headH;
    const halfRange = 55;
    const ppx = w / (2 * halfRange);
    const hd = s.heading;

    g.fillStyle = 'rgba(8,14,22,.45)';
    g.fillRect(x0, y, w, hh);
    g.strokeStyle = COL.accentSoft;
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y + 0.5, w - 1, hh - 1);

    g.save();
    g.beginPath();
    g.rect(x0, y, w, hh);
    g.clip();

    const yb = y + hh;
    const start = Math.floor((hd - halfRange) / 5) * 5;
    const end = hd + halfRange;
    g.font = '600 10px ' + MONO;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (let t = start; t <= end; t += 5) {
      const px = cx + (t - hd) * ppx;
      if (px < x0 - 2 || px > x0 + w + 2) continue;
      const norm = ((t % 360) + 360) % 360;
      const major = norm % 30 === 0;
      const len = major ? 11 : 6;
      g.strokeStyle = major ? COL.accentMid : COL.accentSoft;
      g.lineWidth = major ? 1.5 : 1;
      g.beginPath();
      g.moveTo(px, yb - 1);
      g.lineTo(px, yb - 1 - len);
      g.stroke();
      if (major) {
        const cardinal = norm === 0 ? 'N' : norm === 90 ? 'E' : norm === 180 ? 'S' : norm === 270 ? 'W' : null;
        g.fillStyle = cardinal ? COL.accent : COL.dim;
        g.fillText(cardinal || String(norm).padStart(3, '0'), px, yb - len - 4);
      }
    }
    g.restore();

    // 固定指针 + 当前航向读数
    g.fillStyle = COL.accent;
    g.beginPath();
    g.moveTo(cx, yb + 1);
    g.lineTo(cx - 5, yb - 7);
    g.lineTo(cx + 5, yb - 7);
    g.closePath();
    g.fill();
    g.font = '700 12px ' + MONO;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillStyle = COL.accent;
    g.fillText(String(((Math.round(hd) % 360) + 360) % 360).padStart(3, '0') + '\u00b0', x0 + w + 8, yb);
  }

  /* ---------------- 速度带 ---------------- */

  /**
   * 左侧空速带 + 马赫数。
   * @param {CanvasRenderingContext2D} g @param {any} L @param {any} s @param {boolean} imperial @private
   */
  _drawSpeedTape(g, L, s, imperial) {
    const x = L.spdX;
    const w = L.tapeW;
    const cy = L.cy;
    const hh = L.tapeH * 0.5;
    const raw = imperial ? s.speed * MPS_TO_KT : s.speed;
    const halfRange = imperial ? 80 : 50;
    const minor = imperial ? 10 : 10;
    const major = imperial ? 20 : 20;
    const ppx = L.tapeH / (2 * halfRange);

    g.fillStyle = 'rgba(8,14,22,.42)';
    g.fillRect(x, cy - hh, w, L.tapeH);
    g.strokeStyle = COL.accentSoft;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, cy - hh + 0.5, w - 1, L.tapeH - 1);

    g.save();
    g.beginPath();
    g.rect(x, cy - hh, w, L.tapeH);
    g.clip();
    g.font = '600 10px ' + MONO;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const start = Math.floor((raw - halfRange) / minor) * minor;
    const end = raw + halfRange;
    for (let v = start; v <= end; v += minor) {
      const py = cy - (v - raw) * ppx;
      const isMajor = Math.abs(v % major) < 1e-6;
      const len = isMajor ? w * 0.7 : w * 0.34;
      g.strokeStyle = isMajor ? COL.accentMid : COL.accentSoft;
      g.lineWidth = isMajor ? 1.4 : 1;
      g.beginPath();
      g.moveTo(x + w, py);
      g.lineTo(x + w - len, py);
      g.stroke();
      if (isMajor) {
        g.fillStyle = COL.dim;
        g.fillText(String(Math.round(v)), x + w - 5, py - 7);
      }
    }
    g.restore();

    // 数值框
    const bw = w - 2;
    const bh = 22;
    g.fillStyle = COL.panelSolid;
    g.fillRect(x + 1, cy - bh * 0.5, bw, bh);
    g.strokeStyle = COL.accent;
    g.lineWidth = 1.6;
    g.strokeRect(x + 1.5, cy - bh * 0.5 + 0.5, bw - 1, bh - 1);
    g.font = '700 13px ' + MONO;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillStyle = COL.text;
    g.fillText(String(Math.round(raw)), x + w - 6, cy);
    // 指针三角
    g.fillStyle = COL.accent;
    g.beginPath();
    g.moveTo(x + w + 1, cy);
    g.lineTo(x + w + 7, cy - 5);
    g.lineTo(x + w + 7, cy + 5);
    g.closePath();
    g.fill();

    // 单位标签 + 马赫
    g.font = '600 10px ' + MONO;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = COL.accent;
    g.fillText(imperial ? 'KIAS' : 'M/S', x + w * 0.5, cy - hh - 6);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = COL.dim;
    g.fillText('M ' + num(s.mach, 0).toFixed(2), x + w * 0.5, cy + hh + 6);
  }

  /* ---------------- 高度带 ---------------- */

  /**
   * 右侧高度带 + 雷达高度（AGL）+ 升降速率表（VSI）。
   * @param {CanvasRenderingContext2D} g @param {any} L @param {any} s @param {boolean} imperial @private
   */
  _drawAltTape(g, L, s, imperial) {
    const x = L.altX;
    const w = L.tapeW;
    const cy = L.cy;
    const hh = L.tapeH * 0.5;
    const raw = imperial ? s.alt * M_TO_FT : s.alt;
    const agl = imperial ? s.agl * M_TO_FT : s.agl;
    const halfRange = imperial ? 800 : 150;
    const minor = imperial ? 100 : 25;
    const major = imperial ? 200 : 50;
    const ppx = L.tapeH / (2 * halfRange);

    g.fillStyle = 'rgba(8,14,22,.42)';
    g.fillRect(x, cy - hh, w, L.tapeH);
    g.strokeStyle = COL.accentSoft;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, cy - hh + 0.5, w - 1, L.tapeH - 1);

    g.save();
    g.beginPath();
    g.rect(x, cy - hh, w, L.tapeH);
    g.clip();
    g.font = '600 10px ' + MONO;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const start = Math.floor((raw - halfRange) / minor) * minor;
    const end = raw + halfRange;
    for (let v = start; v <= end; v += minor) {
      const py = cy - (v - raw) * ppx;
      const isMajor = Math.abs(v % major) < 1e-6;
      const len = isMajor ? w * 0.7 : w * 0.34;
      g.strokeStyle = isMajor ? COL.accentMid : COL.accentSoft;
      g.lineWidth = isMajor ? 1.4 : 1;
      g.beginPath();
      g.moveTo(x, py);
      g.lineTo(x + len, py);
      g.stroke();
      if (isMajor) {
        g.fillStyle = COL.dim;
        g.fillText(String(Math.round(v)), x + 5, py - 7);
      }
    }
    g.restore();

    // 数值框
    const bw = w - 2;
    const bh = 22;
    g.fillStyle = COL.panelSolid;
    g.fillRect(x + 1, cy - bh * 0.5, bw, bh);
    g.strokeStyle = COL.accent;
    g.lineWidth = 1.6;
    g.strokeRect(x + 1.5, cy - bh * 0.5 + 0.5, bw - 1, bh - 1);
    g.font = '700 13px ' + MONO;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = COL.text;
    g.fillText(String(Math.round(raw)), x + 6, cy);
    g.fillStyle = COL.accent;
    g.beginPath();
    g.moveTo(x - 1, cy);
    g.lineTo(x - 7, cy - 5);
    g.lineTo(x - 7, cy + 5);
    g.closePath();
    g.fill();

    // 单位 + AGL
    g.font = '600 10px ' + MONO;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = COL.accent;
    g.fillText(imperial ? 'FT' : 'M', x + w * 0.5, cy - hh - 6);
    const lowAgl = agl >= 0 && s.agl < 150;
    g.textBaseline = 'top';
    g.fillStyle = lowAgl ? COL.warn : COL.dim;
    g.fillText('AGL ' + (imperial ? fmtInt(agl) + ' ft' : fmtInt(agl) + ' m'), x + w * 0.5, cy + hh + 6);

    /* --- VSI：磁带右侧的竖直小表 --- */
    const vx = x + w + 12;
    const vh = Math.min(96, L.tapeH * 0.5);
    const vw = 12;
    const vy0 = cy - vh * 0.5;
    const vsRange = 20; // ±20 m/s
    const vs = num(s.vs, 0);
    g.fillStyle = 'rgba(8,14,22,.42)';
    g.fillRect(vx, vy0, vw, vh);
    g.strokeStyle = COL.accentSoft;
    g.lineWidth = 1;
    g.strokeRect(vx + 0.5, vy0 + 0.5, vw - 1, vh - 1);
    g.strokeStyle = COL.accentFaint;
    g.beginPath();
    for (let i = -2; i <= 2; i++) {
      const py = cy - (i * 10 / vsRange) * (vh * 0.5);
      g.moveTo(vx, py);
      g.lineTo(vx + (i === 0 ? vw : vw * 0.55), py);
    }
    g.stroke();
    // 指针（从中心向上/下生长）
    const frac = clamp(vs / vsRange, -1, 1);
    const ph = frac * vh * 0.5;
    g.fillStyle = Math.abs(vs) < 0.5 ? COL.dim : (vs > 0 ? COL.ok : COL.warn);
    g.fillRect(vx + 2, cy, vw - 4, -ph);
    g.fillStyle = COL.text;
    g.fillRect(vx, cy - 1, vw, 2);

    // 数值
    g.font = '600 10px ' + MONO;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = COL.dim;
    g.fillText('V/S', vx - 2, vy0 - 14);
    const dir = vs > 0.2 ? '\u25b2' : (vs < -0.2 ? '\u25bc' : '\u25ac');
    g.textBaseline = 'alphabetic';
    g.fillStyle = vs > 0.2 ? COL.ok : (vs < -0.2 ? COL.warn : COL.dim);
    const vsTxt = imperial
      ? Math.round(Math.abs(vs) * M_TO_FT / 60) + ' fpm'
      : Math.abs(vs).toFixed(1) + ' m/s';
    g.fillText(dir + ' ' + vsTxt, vx - 2, cy + vh * 0.5 + 14);
  }

  /* ---------------- 底部状态区 ---------------- */

  /**
   * 油门 / 转速 / 燃油横条 + G 值 + 攻角（含失速区）+ 襟翼/起落架/减速板指示灯。
   * @param {CanvasRenderingContext2D} g @param {any} L @param {any} s @param {any} st @private
   */
  _drawStatus(g, L, s, st) {
    const y = L.bottomY;
    if (L.compact) {
      // 小屏：单行紧凑文本
      g.font = '600 11px ' + MONO;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = COL.dim;
      const txt = 'THR ' + Math.round(s.throttle * 100) + '%  RPM ' + Math.round(s.rpm * 100) +
        '%  FUEL ' + Math.round(s.fuel * 100) + '%  G ' + s.g.toFixed(1) +
        '  AOA ' + (s.aoa / DEG).toFixed(0) + '\u00b0';
      g.fillText(txt, L.cx, y + 8);
      this._drawLights(g, L.groupX, y + 26, L);
      return;
    }

    let x = L.groupX;
    x = this._bar(g, x, y, L.barW, 'THR %', s.throttle, COL.accent);
    x = this._bar(g, x, y, L.barW, 'RPM %', s.rpm, COL.ok);
    x = this._bar(g, x, y, L.barW, 'FUEL %', s.fuel,
      s.fuel < 0.15 ? COL.danger : (s.fuel < 0.3 ? COL.warn : COL.accent));

    if (!L.showRow2) return;

    /* --- 第二行：G / AOA / 灯 --- */
    let x2 = L.groupX;
    const y2 = L.row2Y;

    // G 值
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = '600 10px ' + MONO;
    g.fillStyle = COL.dim;
    g.fillText('G', x2, y2 - 6);
    g.font = '700 13px ' + MONO;
    const gAbs = Math.abs(s.g);
    g.fillStyle = gAbs > 7 ? COL.danger : (gAbs > 4.5 ? COL.warn : COL.ok);
    g.fillText(s.g.toFixed(1), x2 + 10, y2 - 6);
    x2 += L.gW;

    // AOA 横条（右侧 25% 为失速警戒区）
    const aoaDeg = s.aoa / DEG;
    const aoaMax = 20;
    const aw = L.aoaW;
    const ah = 9;
    g.font = '600 10px ' + MONO;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = COL.dim;
    g.fillText('AOA', x2, y2 - 16);
    g.textAlign = 'right';
    g.fillStyle = aoaDeg > 15 ? COL.danger : COL.text;
    g.fillText(aoaDeg.toFixed(1) + '\u00b0', x2 + aw, y2 - 16);
    g.fillStyle = 'rgba(255,255,255,.10)';
    g.fillRect(x2, y2 - 6, aw, ah);
    // 失速区
    const stallX = x2 + aw * (15 / aoaMax);
    g.fillStyle = 'rgba(255,77,94,.30)';
    g.fillRect(stallX, y2 - 6, x2 + aw - stallX, ah);
    g.strokeStyle = COL.danger;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(stallX, y2 - 6);
    g.lineTo(stallX, y2 + 3);
    g.stroke();
    // 当前值填充
    const af = clamp(aoaDeg / aoaMax, 0, 1);
    g.fillStyle = aoaDeg > 15 ? COL.danger : (aoaDeg > 11 ? COL.warn : COL.accent);
    g.fillRect(x2, y2 - 6, aw * af, ah);
    g.strokeStyle = COL.accentFaint;
    g.strokeRect(x2 + 0.5, y2 - 5.5, aw - 1, ah - 1);
    x2 += aw + 18;

    // 指示灯
    this._drawLights(g, x2, y2 - 14, L);
  }

  /**
   * 一个带标签/数值的水平条。
   * @param {CanvasRenderingContext2D} g @param {number} x @param {number} y
   * @param {number} w @param {string} label @param {number} p01 @param {string} color
   * @returns {number} 下一个 x @private
   */
  _bar(g, x, y, w, label, p01, color) {
    const p = clamp(num(p01, 0), 0, 1);
    g.font = '600 10px ' + MONO;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = COL.dim;
    g.fillText(label, x, y - 16);
    g.textAlign = 'right';
    g.fillStyle = color;
    g.fillText(String(Math.round(p * 100)), x + w, y - 16);

    const h = 9;
    g.fillStyle = 'rgba(255,255,255,.10)';
    g.fillRect(x, y - 8, w, h);
    g.fillStyle = color;
    g.fillRect(x, y - 8, w * p, h);
    g.strokeStyle = COL.accentFaint;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y - 7.5, w - 1, h - 1);
    return x + w + 14;
  }

  /**
   * 起落架 / 襟翼 / 减速板指示灯。
   * @param {CanvasRenderingContext2D} g @param {number} x @param {number} y @param {any} L @private
   */
  _drawLights(g, x, y, L) {
    const s = this._disp;
    const gearTxt = s.gear01 > 0.99 ? 'DN' : (s.gear01 < 0.01 ? 'UP' : Math.round(s.gear01 * 100) + '%');
    const gearCol = s.gear01 > 0.99 ? COL.ok : (s.gear01 < 0.01 ? COL.faint : COL.warn);
    const flapTxt = s.flaps01 < 0.01 ? 'UP' : Math.round(s.flaps01 * 100) + '%';
    const flapCol = s.flaps01 < 0.01 ? COL.faint : COL.warn;
    const brkTxt = s.airbrake01 > 0.05 ? Math.round(s.airbrake01 * 100) + '%' : 'OFF';
    const brkCol = s.airbrake01 > 0.05 ? COL.warn : COL.faint;

    const boxW = L.compact ? 38 : 46;
    const boxH = 18;
    g.font = '600 9px ' + MONO;
    const items = [
      ['GEAR', gearTxt, gearCol],
      ['FLAP', flapTxt, flapCol],
      ['BRK', brkTxt, brkCol],
    ];
    for (let i = 0; i < items.length; i++) {
      const bx = x + i * (boxW + 5);
      const col = items[i][2];
      g.fillStyle = 'rgba(255,255,255,.06)';
      g.fillRect(bx, y, boxW, boxH);
      g.strokeStyle = col;
      g.lineWidth = 1;
      g.strokeRect(bx + 0.5, y + 0.5, boxW - 1, boxH - 1);
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = col;
      g.fillText(items[i][0], bx + 4, y + boxH * 0.5);
      g.textAlign = 'right';
      g.fillStyle = COL.text;
      g.fillText(String(items[i][1]), bx + boxW - 4, y + boxH * 0.5);
    }
  }

  /* ---------------- 武器面板 ---------------- */

  /**
   * 从 state.weapons 读取武器分组（兼容数组 / 对象两种形状）。
   * @param {any} st @returns {number} 分组数量 @private
   */
  _readWeapons(st) {
    this._weaponCount = 0;
    if (!st || !st.weapons) return 0;
    const src = st.weapons;
    const sel = Number.isFinite(st.weaponIndex) ? st.weaponIndex
      : (Number.isFinite(st.selectedWeapon) ? st.selectedWeapon : -1);

    if (Array.isArray(src)) {
      for (let i = 0; i < src.length && this._weaponCount < 6; i++) {
        const it = src[i];
        if (it === null || it === undefined) continue;
        if (typeof it === 'number') {
          this._pushWeapon('W' + (i + 1), it, i === sel);
          continue;
        }
        if (typeof it !== 'object') continue;
        const label = it.name || it.label || it.id || ('W' + (i + 1));
        const ammo = this._firstNum(it.ammo, it.ammoCount, it.count, it.rounds, it.remaining, it.mag);
        this._pushWeapon(String(label), ammo, truthy(it.selected) || truthy(it.active) || i === sel);
      }
      return this._weaponCount;
    }

    if (typeof src === 'object') {
      const keys = Object.keys(src);
      for (let i = 0; i < keys.length && this._weaponCount < 6; i++) {
        const k = keys[i];
        const v = src[k];
        if (v === null || v === undefined) continue;
        if (typeof v === 'number') { this._pushWeapon(k, v, i === sel); continue; }
        if (typeof v !== 'object') continue;
        const ammo = this._firstNum(v.ammo, v.ammoCount, v.count, v.rounds, v.remaining, v.mag);
        this._pushWeapon(String(v.name || v.label || k), ammo, truthy(v.selected) || truthy(v.active) || i === sel);
      }
    }
    return this._weaponCount;
  }

  /** @param {...any} vals @returns {number|null} @private */
  _firstNum(...vals) {
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  }

  /**
   * 写入武器分组对象池。
   * @param {string} label @param {number|null} ammo @param {boolean} selected @private
   */
  _pushWeapon(label, ammo, selected) {
    const i = this._weaponCount++;
    let w = this._weapons[i];
    if (!w) w = this._weapons[i] = { label: '', ammo: null, selected: false };
    w.label = label;
    w.ammo = ammo;
    w.selected = !!selected;
  }

  /**
   * 左下角武器面板（无数据时自动隐藏）。
   * @param {CanvasRenderingContext2D} g @param {any} L @param {any} st @private
   */
  _drawWeapons(g, L, st) {
    const n = this._readWeapons(st);
    if (n === 0) return;
    const pw = 136;
    const lineH = 15;
    const ph = 24 + n * lineH;
    const x = 14;
    const y = L.h - ph - 14;

    g.fillStyle = 'rgba(8,14,22,.55)';
    g.fillRect(x, y, pw, ph);
    g.strokeStyle = COL.accentSoft;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);

    g.font = '600 10px ' + MONO;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = COL.accent;
    g.fillText('ARMAMENT', x + 9, y + 12);
    g.strokeStyle = COL.accentFaint;
    g.beginPath();
    g.moveTo(x + 6, y + 20);
    g.lineTo(x + pw - 6, y + 20);
    g.stroke();

    for (let i = 0; i < n; i++) {
      const wk = this._weapons[i];
      const yy = y + 30 + i * lineH;
      if (wk.selected) {
        g.fillStyle = 'rgba(0,208,255,.16)';
        g.fillRect(x + 3, yy - lineH * 0.5, pw - 6, lineH);
      }
      g.textAlign = 'left';
      g.fillStyle = wk.selected ? COL.accent : COL.text;
      g.fillText(wk.label.length > 12 ? wk.label.slice(0, 12) : wk.label, x + 9, yy);
      g.textAlign = 'right';
      const ammo = wk.ammo;
      g.fillStyle = ammo === null ? COL.dim : (ammo < 0 ? COL.accent : (ammo > 0 ? COL.text : COL.danger));
      g.fillText(ammo === null ? '--' : (ammo < 0 ? '\u221e' : String(ammo)), x + pw - 9, yy);
    }
  }

  /* ---------------- 警示 / 闪烁 / 暗角 ---------------- */

  /**
   * STALL / OVERSPEED / PULL UP / mission.warnings。
   * @param {CanvasRenderingContext2D} g @param {any} L @param {any} st @param {any} hud @private
   */
  _drawWarnings(g, L, st, hud) {
    const w = L.w;
    const h = L.h;
    const cx = L.cx;
    const cy = L.cy;
    const blink = (this._t * 3) % 1 < 0.55;
    const blinkFast = (this._t * 6) % 1 < 0.6;

    // 失速
    const stalling = !!(st && (truthy(st.stall) || truthy(st.stalled)));
    if (stalling || this._flash.stall > 0) {
      const on = this._flash.stall > 0.5 || blink;
      if (on) {
        g.save();
        g.font = '700 22px ' + MONO;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = COL.danger;
        g.shadowColor = 'rgba(255,77,94,.9)';
        g.shadowBlur = 14;
        g.fillText('STALL', cx, cy);
        g.restore();
      }
      // 闪烁红边
      const a = on ? 0.85 : 0.25;
      g.strokeStyle = 'rgba(255,77,94,' + a.toFixed(2) + ')';
      g.lineWidth = 3;
      g.strokeRect(2, 2, w - 4, h - 4);
    }

    // 超速
    const over = !!(st && (truthy(st.overspeed) || listHas(st.warnings, /OVERSPEED/i))) || num(this._disp.mach, 0) > 0.97;
    if (over) {
      if (blinkFast) {
        g.font = '700 16px ' + MONO;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = COL.warn;
        g.fillText('OVERSPEED', cx, cy + 30);
      }
    }

    // 拉起提示
    const agl = st ? num(st.altitudeAGL, 1e9) : 1e9;
    const vs = st ? num(st.verticalSpeed, 0) : 0;
    if (agl < 150 && vs < -8) {
      if (blinkFast) {
        const y0 = cy + L.r * 0.72;
        g.strokeStyle = COL.danger;
        g.lineWidth = 3;
        for (let i = 0; i < 2; i++) {
          const yy = y0 + i * 12;
          g.beginPath();
          g.moveTo(cx - 26, yy + 10);
          g.lineTo(cx, yy);
          g.lineTo(cx + 26, yy + 10);
          g.stroke();
        }
        g.font = '700 13px ' + MONO;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillStyle = COL.danger;
        g.fillText('PULL UP', cx, y0 + 26);
      }
    }

    // 任务 / 状态 warning 列表
    const warnList = [];
    const stW = st && Array.isArray(st.warnings) ? st.warnings : null;
    if (stW) for (let i = 0; i < stW.length && warnList.length < 3; i++) warnList.push(String(stW[i]));
    const msW = hud.mission && Array.isArray(hud.mission.warnings) ? hud.mission.warnings : null;
    if (msW) for (let i = 0; i < msW.length && warnList.length < 4; i++) warnList.push(String(msW[i]));
    if (warnList.length) {
      g.font = '600 11px ' + MONO;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      let wy = L.bottomY - 46;
      for (let i = warnList.length - 1; i >= 0; i--) {
        g.fillStyle = COL.warn;
        g.fillText('\u26a0 ' + warnList[i], L.groupX, wy);
        wy -= 14;
      }
    }
  }

  /**
   * flash(kind) 的全屏效果。
   * @param {CanvasRenderingContext2D} g @param {number} w @param {number} h @param {any} L @private
   */
  _drawFlash(g, w, h, L) {
    const f = this._flash;

    // 命中：白闪
    if (f.hit > 0) {
      g.fillStyle = 'rgba(255,255,255,' + (clamp(f.hit / 0.4, 0, 1) * 0.32).toFixed(3) + ')';
      g.fillRect(0, 0, w, h);
    }
    // 警告：琥珀边
    if (f.warning > 0) {
      const a = clamp(f.warning, 0, 1);
      g.globalAlpha = a * 0.9;
      g.drawImage(this._vigWarn, 0, 0, w, h);
      g.globalAlpha = 1;
    }
    // 击杀：绿边 + 勾 + 文本
    if (f.kill > 0) {
      const a = clamp(f.kill / 1.8, 0, 1);
      g.globalAlpha = a * 0.9;
      g.drawImage(this._vigOk, 0, 0, w, h);
      g.globalAlpha = 1;

      g.font = '700 20px ' + MONO;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(61,220,132,' + a.toFixed(3) + ')';
      g.fillText('\u2713 KILL', L.cx, h * 0.3);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(61,220,132,' + (a * 0.8).toFixed(3) + ')';
      g.beginPath();
      g.arc(L.cx, h * 0.3 - 34, 13, 0, TAU);
      g.stroke();
      g.beginPath();
      g.moveTo(L.cx - 6, h * 0.3 - 34);
      g.lineTo(L.cx - 1, h * 0.3 - 29);
      g.lineTo(L.cx + 7, h * 0.3 - 41);
      g.stroke();
    }
  }

  /**
   * 受损暗角（health01 < 0.5 时随血量增强并脉动）。
   * @param {CanvasRenderingContext2D} g @param {number} w @param {number} h @param {any} st @private
   */
  _drawVignette(g, w, h, st) {
    let a = 0;
    if (st && Number.isFinite(st.health01)) {
      const h01 = clamp(num(st.health01, 1), 0, 1);
      if (h01 < 0.5) {
        const dmg = 1 - h01 / 0.5;              // 0..1
        a = dmg * (0.62 + 0.38 * Math.sin(this._t * 6));
      }
    }
    if (this._flash.damage > 0) a = Math.max(a, clamp(this._flash.damage / 0.6, 0, 1));
    if (a <= 0.01) return;
    g.globalAlpha = clamp(a, 0, 1) * 0.9;
    g.drawImage(this._vigDamage, 0, 0, w, h);
    g.globalAlpha = 1;
  }

  /* ---------------- 世界空间标记 ---------------- */

  /**
   * 收集本帧全部标记到对象池（零分配）。
   * @param {any} hud @param {any} state @param {THREE.Camera} camera @returns {number} @private
   */
  _collect(hud, state, camera) {
    this._mc = 0;
    const m = hud.mission;
    if (!m) return 0;
    const anchor = state && state.position ? state.position : (camera ? camera.position : null);

    // 检查点圆环
    const cps = Array.isArray(m.checkpoints) ? m.checkpoints : null;
    if (cps) {
      for (let i = 0; i < cps.length; i++) {
        const cp = cps[i];
        if (!cp || !cp.position) continue;
        const next = truthy(cp.isNext);
        const passed = truthy(cp.passed);
        this._pushMarker(
          'cp', cp.position,
          'CP ' + (Number.isFinite(cp.index) ? cp.index + 1 : i + 1),
          passed ? COL.faint : (next ? COL.accent : COL.accentSoft),
          -1, num(cp.radius, 30), next, this._dist(anchor, cp.position), passed,
        );
      }
    }

    // 目标
    const tg = Array.isArray(m.targets) ? m.targets : null;
    if (tg) {
      for (let i = 0; i < tg.length; i++) {
        const t = tg[i];
        if (!t || !t.position) continue;
        const alive = t.alive !== false;
        const hostile = num(t.team, 1) !== 0;
        this._pushMarker(
          'target', t.position,
          t.label ? String(t.label) : '',
          alive ? (hostile ? COL.danger : COL.ok) : COL.faint,
          Number.isFinite(t.health01) ? clamp(num(t.health01, 1), 0, 1) : -1,
          9, false, this._dist(anchor, t.position), !alive,
        );
      }
    }

    // 对手
    const comps = Array.isArray(m.competitors) ? m.competitors : null;
    if (comps) {
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        if (!c || !c.worldPos) continue;
        const me = truthy(c.isPlayer);
        this._pushMarker(
          'comp', c.worldPos,
          c.name == null ? (me ? 'YOU' : '---') : String(c.name),
          me ? COL.ok : COL.accent,
          -1, 0, me, num(c.distance, 0) || this._dist(anchor, c.worldPos), false,
        );
      }
    }

    // 通用实体
    const ents = Array.isArray(m.entities) ? m.entities : null;
    if (ents) {
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (!e || !e.position || e.alive === false) continue;
        const hostile = truthy(e.hostile);
        this._pushMarker(
          'entity', e.position,
          e.label ? String(e.label) : '',
          hostile ? COL.danger : COL.ok,
          Number.isFinite(e.health01) ? clamp(num(e.health01, 1), 0, 1) : -1,
          8, false, num(e.distance, 0) || this._dist(anchor, e.position), false,
        );
      }
    }

    return this._mc;
  }

  /**
   * 两点距离（避免每帧创建闭包）。
   * @param {any} a @param {any} b @returns {number} @private
   */
  _dist(a, b) {
    if (!a || !b) return 0;
    const dx = num(b.x, 0) - num(a.x, 0);
    const dy = num(b.y, 0) - num(a.y, 0);
    const dz = num(b.z, 0) - num(a.z, 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * 写入标记对象池。
   * @param {string} kind @param {any} pos @param {string} label @param {string} color
   * @param {number} health01 @param {number} radius @param {boolean} isNext
   * @param {number} distance @param {boolean} passed @private
   */
  _pushMarker(kind, pos, label, color, health01, radius, isNext, distance, passed) {
    const i = this._mc;
    if (i >= 64) return;
    let m = this._pool[i];
    if (!m) {
      m = this._pool[i] = {
        kind: '', px: 0, py: 0, pz: 0, label: '', color: '',
        health01: -1, radius: 0, isNext: false, distance: 0, passed: false,
        sx: 0, sy: 0, front: false, dist: 0,
      };
    }
    m.kind = kind;
    m.px = num(pos.x, 0);
    m.py = num(pos.y, 0);
    m.pz = num(pos.z, 0);
    m.label = label;
    m.color = color;
    m.health01 = health01;
    m.radius = radius;
    m.isNext = isNext;
    m.distance = distance;
    m.passed = passed;
    this._mc = i + 1;
  }

  /**
   * 用相机投影绘制全部世界标记 + 屏幕外箭头。
   * @param {CanvasRenderingContext2D} g @param {any} hud @param {number} w @param {number} h @private
   */
  _drawMarkers(g, hud, w, h) {
    const camera = hud.camera;
    if (!camera || !camera.projectionMatrix || !camera.matrixWorldInverse) return;
    const n = this._collect(hud, hud.state, camera);
    if (n === 0) return;

    // 保证相机矩阵是当前的（主循环通常已更新，这里兜底）
    camera.updateMatrixWorld();
    if (camera.matrixWorld) camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    let focal = h * 0.5;
    if (camera.isPerspectiveCamera && Number.isFinite(camera.fov)) {
      const t = Math.tan(camera.fov * 0.5 * DEG);
      if (t > 1e-6) focal = (h * 0.5) / t;
    }

    const inset = 16;
    const offs = this._off;
    offs.length = 0;

    g.textAlign = 'center';
    g.textBaseline = 'middle';

    for (let i = 0; i < n; i++) {
      const m = this._pool[i];
      const p = projectToScreen(camera, m.px, m.py, m.pz, w, h);
      m.sx = p.x;
      m.sy = p.y;
      m.front = p.front;
      m.dist = p.dist;

      const onScreen = p.front && p.x >= inset && p.x <= w - inset && p.y >= inset && p.y <= h - inset;
      if (!onScreen) {
        // 只给最近的若干标记画边缘箭头
        if (p.dist < 20000) offs.push(m);
        continue;
      }
      if (m.dist > 20000) continue;

      switch (m.kind) {
        case 'cp': this._drawRing(g, m, focal); break;
        case 'target': this._drawBox(g, m, focal); break;
        case 'entity': this._drawBox(g, m, focal); break;
        case 'comp': this._drawDiamond(g, m); break;
        default: break;
      }
    }

    // 屏幕外箭头：最近的 8 个
    if (offs.length > 1) offs.sort(byDistance);
    const max = Math.min(8, offs.length);
    for (let i = 0; i < max; i++) this._drawEdgeArrow(g, offs[i], w, h);
  }

  /**
   * 检查点圆环。
   * @param {CanvasRenderingContext2D} g @param {any} m @param {number} focal @private
   */
  _drawRing(g, m, focal) {
    const rad = clamp(m.radius * focal / Math.max(1, m.dist), 6, 170);
    const x = m.sx;
    const y = m.sy;
    g.strokeStyle = m.color;
    g.lineWidth = m.isNext ? 3 : 2;
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.stroke();

    if (m.isNext) {
      g.save();
      g.translate(x, y);
      g.rotate(this._t * 1.1);
      g.setLineDash(RING_DASH);
      g.strokeStyle = COL.accent;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(0, 0, rad + 8, 0, TAU);
      g.stroke();
      g.restore();
      g.setLineDash(EMPTY_DASH);
      // 十字准心
      g.strokeStyle = COL.accentSoft;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x - rad - 14, y);
      g.lineTo(x - rad - 4, y);
      g.moveTo(x + rad + 4, y);
      g.lineTo(x + rad + 14, y);
      g.moveTo(x, y - rad - 14);
      g.lineTo(x, y - rad - 4);
      g.moveTo(x, y + rad + 4);
      g.lineTo(x, y + rad + 14);
      g.stroke();
    }

    if (m.label) {
      g.font = '600 11px ' + MONO;
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillStyle = m.color;
      g.fillText(m.label, x, y - rad - 4);
    }
    g.font = '600 10px ' + MONO;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = COL.dim;
    g.fillText(fmtDist(m.dist, this._imperial()), x, y + rad + 4);
  }

  /**
   * 目标 / 实体方框 + 血条。
   * @param {CanvasRenderingContext2D} g @param {any} m @param {number} focal @private
   */
  _drawBox(g, m, focal) {
    const sz = clamp(10 * focal / Math.max(1, m.dist), 10, 130);
    const x = m.sx;
    const y = m.sy;
    const half = sz * 0.5;
    g.strokeStyle = m.color;
    g.lineWidth = 2;
    // 四角括号（比方框更快更“HUD”）
    const c = half * 0.42;
    g.beginPath();
    g.moveTo(x - half, y - half + c); g.lineTo(x - half, y - half); g.lineTo(x - half + c, y - half);
    g.moveTo(x + half - c, y - half); g.lineTo(x + half, y - half); g.lineTo(x + half, y - half + c);
    g.moveTo(x + half, y + half - c); g.lineTo(x + half, y + half); g.lineTo(x + half - c, y + half);
    g.moveTo(x - half + c, y + half); g.lineTo(x - half, y + half); g.lineTo(x - half, y + half - c);
    g.stroke();

    if (m.health01 >= 0) {
      const bw = Math.max(18, sz * 1.05);
      const bh = 4;
      const by = y + half + 5;
      g.fillStyle = 'rgba(0,0,0,.5)';
      g.fillRect(x - bw * 0.5, by, bw, bh);
      g.fillStyle = m.health01 > 0.5 ? COL.ok : (m.health01 > 0.25 ? COL.warn : COL.danger);
      g.fillRect(x - bw * 0.5, by, bw * clamp(m.health01, 0, 1), bh);
    }

    if (m.label) {
      g.font = '600 10px ' + MONO;
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillStyle = m.color;
      g.fillText(m.label, x, y - half - 4);
    }
  }

  /**
   * 对手菱形标记。
   * @param {CanvasRenderingContext2D} g @param {any} m @private
   */
  _drawDiamond(g, m) {
    const x = m.sx;
    const y = m.sy;
    const s = m.isNext ? 9 : 7; // isNext 字段此处复用为“是否玩家”
    g.fillStyle = 'rgba(6,11,18,.55)';
    g.strokeStyle = m.color;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, y - s);
    g.lineTo(x + s, y);
    g.lineTo(x, y + s);
    g.lineTo(x - s, y);
    g.closePath();
    g.fill();
    g.stroke();

    g.font = '600 11px ' + MONO;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillStyle = m.color;
    g.fillText(m.label, x, y - s - 4);
    g.font = '600 10px ' + MONO;
    g.textBaseline = 'top';
    g.fillStyle = COL.dim;
    g.fillText(fmtDist(m.dist, this._imperial()), x, y + s + 4);
  }

  /**
   * 屏幕外标记：贴边箭头 + 距离。
   * @param {CanvasRenderingContext2D} g @param {any} m @param {number} w @param {number} h @private
   */
  _drawEdgeArrow(g, m, w, h) {
    const cx = w * 0.5;
    const cy = h * 0.5;
    let dx = m.sx - cx;
    let dy = m.sy - cy;
    if (!m.front) { dx = -dx; dy = -dy; }
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3)) {
      dx = 0;
      dy = m.front ? 1 : -1;
    }
    const maxX = Math.max(40, cx - 54);
    const maxY = Math.max(40, cy - 62);
    const t = Math.min(maxX / Math.max(1e-3, Math.abs(dx)), maxY / Math.max(1e-3, Math.abs(dy)));
    const ax = cx + dx * t;
    const ay = cy + dy * t;
    const ang = Math.atan2(dy, dx);
    const alpha = clamp(1 - m.dist / 20000, 0.25, 0.95);

    g.save();
    g.translate(ax, ay);
    g.rotate(ang);
    g.globalAlpha = alpha;
    g.fillStyle = m.color;
    g.beginPath();
    g.moveTo(9, 0);
    g.lineTo(-6, -6);
    g.lineTo(-6, 6);
    g.closePath();
    g.fill();
    g.restore();

    g.globalAlpha = alpha * 0.95;
    g.font = '600 10px ' + MONO;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = m.color;
    const label = m.label ? (m.label.length > 10 ? m.label.slice(0, 10) : m.label) : '';
    g.fillText(label, ax - Math.cos(ang) * 16, ay - Math.sin(ang) * 16 - 6);
    g.font = '600 9px ' + MONO;
    g.fillStyle = COL.dim;
    g.fillText(fmtDist(m.dist, this._imperial()), ax - Math.cos(ang) * 16, ay - Math.sin(ang) * 16 + 5);
    g.globalAlpha = 1;
  }

  /** 当前是否英制单位。 @returns {boolean} @private */
  _imperial() {
    return !!(this._hud && this._hud.units === 'imperial');
  }
}
