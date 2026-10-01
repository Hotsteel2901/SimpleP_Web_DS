// @ts-check
/**
 * src/ui/touch.js —— 移动端触摸控制层（对齐原版 SimplePlanes 手机版的精简布局）
 * ==================================================================================
 * 职责：只“采集”触摸输入，不直接驱动飞机。主循环每帧把它接进 core/input.js：
 *
 *   Object.assign(input.axes, touch.axes);          // pitch/roll/yaw/throttle/brake/flaps/airbrake
 *   const e = touch.consumeEdges();                 // gear/camera/reset/fire1/fire2/bomb/flare/
 *   for (const k in e) if (k in input.edges) input.edges[k] = e[k];   // chute/pause/autolevel/boost(+brake/airbrake)
 *   touch.update(dt);                               // 摇杆回中 + 开火连发节奏
 *
 * 布局（向原版靠拢：屏幕上长期可见的控件很少，中央大片留空）
 * ------------------------------------------------------------------
 *   左手：俯仰/滚转浮动摇杆（按到哪就从哪开始，不用挪拇指）
 *   右手：略小的方向舵浮动摇杆（水平轴 = yaw；上推 = 减速板、下拉 = 刹车）
 *         窄屏 / 竖屏自动改用「左舵 / 右舵」两个 44px 按钮（二选一，不同时占位）
 *   右边缘：竖直油门滑条（值持久，带百分比与 0/50/100 刻度）
 *   右下：大号开火按钮（≥76px，按住连发）+ 武器选择器（机炮/导弹/炸弹/干扰弹，显示余量，
 *         无余量置灰）——把原来的「武器 4 按钮」压成 2 个控件
 *   开关行：6 个小号 44px 开关（起落架 / 襟翼 / 减速板 / 视角 / 伞 / 重置），横屏贴顶、竖屏贴右
 *   右上：暂停；顶部右列：极简仪表读数（油门% / 当前武器+余量 / GEAR / FLAP）
 *
 * 与原版 12 按钮簇的对应关系（功能不丢）
 * ------------------------------------------------------------------
 *   机炮/导弹/炸弹/干扰弹 → 武器选择器 + 开火按钮（机炮与导弹按住连发）
 *   襟翼+ / 襟翼−          → 一个「襟翼」开关，循环 0 → 1/3 → 2/3 → 1 → 0
 *   刹车                   → 方向舵摇杆下拉（按住即刹车，仍进 axes.brake / consumeEdges().brake）
 *   减速板                 → 「减速板」开关（锁定式）+ 方向舵摇杆上推（按住）
 *   起落架/视角/伞/重置     → 开关行（起落架带点亮状态，进 consumeEdges() 边沿）
 *
 * 其它约定
 * ------------------------------------------------------------------
 *  - 模块顶层不触碰 document / window；纯 Node 可安全导入（`node --check` 通过）。
 *  - 所有几何由 JS 按视口/安全区/缩放算出并写成 inline px（浏览器中 inline 覆盖样式表，
 *    因此 jsdom 里读到的几何就是浏览器最终几何），从而「中央留空 / 互不重叠 / ≥44px」可程序化验证。
 *  - 尺寸用等价的 clamp(min, vmin*比例, max) 计算；安全区用 env(safe-area-inset-*) 探针读取。
 *  - 图标全部 Unicode + CSS 形状，无外部字体/图片；样式经 injectStyles() 只注入一次。
 */

import { clamp, clamp01, damp, store } from '../core/util.js';
import { el, THEME, injectStyles } from './widgets.js';

/* ============================================================================
 * 常量
 * ========================================================================== */

/** 摇杆死区（归一化半径占比）。 */
const STICK_DEADZONE = 0.08;
/** 摇杆回中阻尼系数（λ≈24 时约 0.18 s 收敛到 <1.5%）。 */
const STICK_RETURN_LAMBDA = 24;
/** 非「按住电平」类武器按住开火时的连发间隔（秒）。 */
const FIRE_REPEAT_SEC = 0.5;
/** 位移小于该值直接吸附为 0。 */
const SNAP = 0.012;
/** 最小可点区域（CSS px，硬下限）。 */
const MIN_TOUCH = 44;
/** 开火按钮直径硬下限。 */
const MIN_FIRE = 76;
/** 屏幕中心 ±15% 必须留空。 */
const CENTER_FRACTION = 0.15;
/** 控件与中心留空区之间的额外余量（px）。 */
const CENTER_MARGIN = 6;
/** 襟翼档位（单个开关循环）。 */
const FLAP_DETENTS = [0, 1 / 3, 2 / 3, 1];
/** 默认摇杆满舵行程（px，实际由摇杆环尺寸换算）。 */
const DEFAULT_RADIUS = 68;
/** 无法测量布局时的滑条退化行程（px，供 jsdom 等无布局环境使用）。 */
const FALLBACK_SLIDER_PX = 200;
/** 油门 ± 微调步长。 */
const THROTTLE_STEP = 0.05;
const THROTTLE_KEY = 'sp2.touch.throttle';
const OPACITY_KEY = 'sp2.touch.opacity';
const SCALE_KEY = 'sp2.touch.scale';

/** consumeEdges() 的稳定键形状（宿主 input.js 依赖，不可增删）。 */
const EDGE_KEYS = [
  'gear', 'camera', 'reset', 'pause', 'fire2', 'bomb', 'flare', 'chute',
  'autolevel', 'boost', 'fire1', 'brake', 'airbrake',
];

/** 可选武器：机炮 / 导弹（按住电平），炸弹 / 干扰弹（边沿 + 节奏连发）。 */
const WEAPONS = [
  { id: 'fire1', name: '机炮', icon: '\u{1F52B}', hold: true },
  { id: 'fire2', name: '导弹', icon: '\u{1F680}', hold: true },
  { id: 'bomb', name: '炸弹', icon: '\u{1F4A3}' },
  { id: 'flare', name: '干扰弹', icon: '\u2728' },
];

/** 开关行：低频操作，做小、靠边。 */
const SWITCHES = [
  { id: 'gear', label: '起落架', icon: '\u{1F6EC}', kind: 'gear' },
  { id: 'flap', label: '襟翼', icon: '\u{1F4D0}', kind: 'flap' },
  { id: 'airbrake', label: '减速板', icon: '\u{1F6E1}', kind: 'latch' },
  { id: 'camera', label: '视角', icon: '\u{1F3A5}', kind: 'edge' },
  { id: 'chute', label: '伞', icon: '\u{1FA82}', kind: 'edge' },
  { id: 'reset', label: '重置', icon: '\u267B', kind: 'edge' },
];

/* ============================================================================
 * 样式（只注入一次；几何由 JS 写 inline，这里只负责皮肤）
 * ========================================================================== */

const TOUCH_CSS = /* css */ `
.sp2-touch-root{
  position:absolute; left:0; top:0; right:0; bottom:0;
  z-index:60;
  pointer-events:none;
  overflow:hidden;
  font-family:${THEME.font};
  color:${THEME.text};
  user-select:none; -webkit-user-select:none;
  -webkit-tap-highlight-color:transparent;
  touch-action:none;
  overscroll-behavior:none;
  transition:opacity .16s ease-out;
}
.sp2-touch-root.sp2-touch-hidden{ display:none !important; }
.sp2-touch-root [hidden]{ display:none !important; }
.sp2-touch-ctl{ position:absolute; box-sizing:border-box; margin:0; padding:0; }

/* ---------- 摇杆感应区（不可见，仅接事件） ---------- */
.sp2-touch-zone{ position:absolute; pointer-events:auto; touch-action:none; }

/* ---------- 摇杆环 / 旋钮 ---------- */
.sp2-touch-stick{
  position:absolute; border-radius:50%;
  border:2px solid ${THEME.border};
  background:radial-gradient(circle at 50% 50%, rgba(10,16,24,.30), rgba(10,16,24,.14) 68%, rgba(10,16,24,.05));
  box-shadow:0 0 22px rgba(0,208,255,.12), inset 0 0 24px rgba(0,208,255,.10);
  opacity:.42;
  pointer-events:none;
  transition:opacity .14s ease-out;
}
.sp2-touch-stick--on{ opacity:1; }
.sp2-touch-knob{
  position:absolute; left:50%; top:50%;
  width:46%; height:46%;
  transform:translate(-50%, -50%);
  border-radius:50%;
  background:radial-gradient(circle at 40% 34%, rgba(0,208,255,.55), rgba(0,208,255,.22) 62%, rgba(10,16,24,.55));
  border:2px solid rgba(0,208,255,.75);
  box-shadow:0 0 16px rgba(0,208,255,.40), inset 0 1px 0 rgba(255,255,255,.18);
  pointer-events:none;
}

/* ---------- 通用圆形按钮 ---------- */
.sp2-touch-btn{
  appearance:none; -webkit-appearance:none;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
  min-width:${MIN_TOUCH}px; min-height:${MIN_TOUCH}px;
  font-family:inherit; line-height:1; color:${THEME.text};
  background:radial-gradient(circle at 50% 34%, rgba(0,208,255,.16), rgba(10,16,24,.62) 72%);
  border:1px solid ${THEME.border};
  border-radius:50%;
  box-shadow:0 4px 12px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.08);
  overflow:hidden;
  pointer-events:auto; touch-action:none;
  transition:transform .07s ease-out, background .12s, border-color .12s, box-shadow .12s, opacity .12s, color .12s;
}
.sp2-touch-btn:hover{ border-color:rgba(0,208,255,.45); }
.sp2-touch-btn--on{
  transform:scale(.92);
  background:radial-gradient(circle at 50% 34%, rgba(0,208,255,.46), rgba(0,208,255,.20) 76%);
  border-color:${THEME.borderStrong};
  color:#eaf9ff;
  box-shadow:0 0 16px rgba(0,208,255,.55), inset 0 1px 0 rgba(255,255,255,.18);
}
.sp2-touch-btn--off{ opacity:.34; filter:grayscale(1); }
.sp2-touch-icon{ font-size:clamp(11px, 2.5vmin, 17px); line-height:1; }
.sp2-touch-label{ font-size:clamp(8px, 1.8vmin, 11px); line-height:1; white-space:nowrap; color:${THEME.textDim}; }
.sp2-touch-btn--on .sp2-touch-label{ color:#eaf9ff; }

/* ---------- 开火按钮 ---------- */
.sp2-touch-fire{
  min-width:${MIN_FIRE}px; min-height:${MIN_FIRE}px;
  background:radial-gradient(circle at 50% 32%, rgba(255,77,94,.38), rgba(10,16,24,.66) 74%);
  border:2px solid rgba(255,77,94,.6);
  box-shadow:0 6px 18px rgba(0,0,0,.36), 0 0 16px rgba(255,77,94,.22), inset 0 1px 0 rgba(255,255,255,.10);
}
.sp2-touch-fire .sp2-touch-icon{ font-size:clamp(18px, 4.6vmin, 30px); }
.sp2-touch-fire.sp2-touch-btn--on{
  background:radial-gradient(circle at 50% 32%, rgba(255,77,94,.72), rgba(255,77,94,.30) 76%);
  border-color:#ff8a96;
  box-shadow:0 0 24px rgba(255,77,94,.65), inset 0 1px 0 rgba(255,255,255,.2);
}
.sp2-touch-fire.sp2-touch-btn--off{ background:radial-gradient(circle at 50% 32%, rgba(120,130,140,.18), rgba(10,16,24,.62) 74%); border-color:rgba(255,255,255,.16); }

/* ---------- 武器选择器 + 弹出列表 ---------- */
.sp2-touch-selector{
  border-color:rgba(0,208,255,.4);
  background:radial-gradient(circle at 50% 34%, rgba(0,208,255,.26), rgba(10,16,24,.66) 74%);
}
.sp2-touch-menu{
  display:flex; align-items:stretch; gap:3px;
  padding:3px;
  background:rgba(10,16,24,.86);
  border:1px solid ${THEME.border};
  border-radius:12px;
  box-shadow:${THEME.shadow};
  backdrop-filter:blur(${THEME.blur}); -webkit-backdrop-filter:blur(${THEME.blur});
  pointer-events:auto;
}
.sp2-touch-menu .sp2-touch-btn{ flex:1 1 0; width:auto; height:auto; border-radius:9px; }
.sp2-touch-menu .sp2-touch-label{ font-size:clamp(8px, 1.7vmin, 10px); }
.sp2-touch-ammo{ font-size:clamp(8px, 1.6vmin, 10px); color:${THEME.textDim}; font-variant-numeric:tabular-nums; }

/* ---------- 油门 ---------- */
.sp2-touch-throttle{
  display:flex; flex-direction:column; align-items:center;
  gap:clamp(2px, .8vmin, 6px);
  padding:clamp(4px, 1vmin, 8px) 0;
  border-radius:999px;
  background:linear-gradient(180deg, rgba(10,16,24,.62), rgba(10,16,24,.40));
  border:1px solid ${THEME.border};
  box-shadow:${THEME.shadow};
  backdrop-filter:blur(${THEME.blur}); -webkit-backdrop-filter:blur(${THEME.blur});
  pointer-events:auto; touch-action:none;
}
.sp2-touch-throttle-value{
  flex:0 0 auto;
  font-size:clamp(10px, 2.2vmin, 13px); line-height:1;
  color:${THEME.accent};
  font-variant-numeric:tabular-nums;
  text-shadow:0 0 8px rgba(0,208,255,.40);
}
.sp2-touch-step{
  appearance:none; -webkit-appearance:none;
  flex:0 0 auto;
  width:calc(100% - 8px); height:clamp(44px, 6.2vmin, 52px);
  display:flex; align-items:center; justify-content:center;
  padding:0;
  font-family:inherit; font-size:clamp(13px, 2.8vmin, 17px); line-height:1;
  color:${THEME.textDim};
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.14); border-radius:999px;
  cursor:pointer;
  pointer-events:auto; touch-action:none;
  transition:background .12s, color .12s, transform .07s;
}
.sp2-touch-step--on{ transform:scale(.94); background:rgba(0,208,255,.34); color:#eaf9ff; }
.sp2-touch-track{
  position:relative; flex:1 1 auto; min-height:48px;
  width:max(44px, clamp(32px, 6vmin, 46px));
  border-radius:999px;
  pointer-events:auto; touch-action:none;
}
.sp2-touch-rail{ position:absolute; left:50%; top:0; bottom:0; width:6px; margin-left:-3px; border-radius:3px; background:rgba(255,255,255,.14); }
.sp2-touch-fill{
  position:absolute; left:50%; bottom:0; width:6px; margin-left:-3px; border-radius:3px;
  background:linear-gradient(0deg, rgba(0,208,255,.40), ${THEME.accent});
  box-shadow:0 0 10px rgba(0,208,255,.50);
}
.sp2-touch-thumb{
  position:absolute; left:50%; bottom:0;
  width:clamp(18px, 4vmin, 24px); height:clamp(18px, 4vmin, 24px);
  margin-left:calc(clamp(18px, 4vmin, 24px) / -2);
  margin-bottom:calc(clamp(18px, 4vmin, 24px) / -2);
  border-radius:50%;
  background:${THEME.bgSolid};
  border:2px solid ${THEME.accent};
  box-shadow:0 0 12px rgba(0,208,255,.60);
  pointer-events:none;
}
.sp2-touch-tick{ position:absolute; left:50%; width:12px; margin-left:-6px; height:1px; background:rgba(0,208,255,.38); pointer-events:none; }
.sp2-touch-tick::after{
  content:attr(data-label);
  position:absolute; right:calc(100% + 3px); top:-5px;
  font-family:${THEME.fontMono}; font-size:9px; color:${THEME.textFaint}; white-space:nowrap;
}

/* ---------- 仪表读数（文字，尽量小） ---------- */
.sp2-touch-readout{
  display:flex; align-items:center; justify-content:space-between; gap:6px;
  padding:0 6px;
  font-family:${THEME.fontMono};
  font-size:clamp(9px, 1.9vmin, 12px);
  line-height:1;
  color:${THEME.textDim};
  background:rgba(10,16,24,.52);
  border:1px solid ${THEME.border};
  border-radius:6px;
  white-space:nowrap; overflow:hidden;
  pointer-events:none;
}
.sp2-touch-readout b{ color:${THEME.accent}; font-weight:600; }
.sp2-touch-readout .sp2-touch-on b{ color:${THEME.success}; }
.sp2-touch-readout .sp2-touch-warn b{ color:${THEME.warning}; }

/* ---------- 竖屏提示（非控件，不挡操作） ---------- */
.sp2-touch-hint{
  position:absolute;
  display:flex; align-items:center; justify-content:center; gap:6px;
  padding:0 10px;
  font-size:clamp(10px, 2.2vmin, 13px);
  color:${THEME.textDim};
  background:rgba(10,16,24,.62);
  border:1px solid ${THEME.border};
  border-radius:999px;
  backdrop-filter:blur(${THEME.blur}); -webkit-backdrop-filter:blur(${THEME.blur});
  white-space:nowrap; overflow:hidden;
  pointer-events:none;
}
.sp2-touch-hint-icon{ font-size:clamp(13px, 3vmin, 18px); line-height:1; animation:sp2-touch-rotate 2.6s ease-in-out infinite; }
.sp2-touch-hint b{ color:${THEME.accent}; font-weight:600; }
@keyframes sp2-touch-rotate{ 0%,35%{ transform:rotate(0deg); } 65%,100%{ transform:rotate(90deg); } }

/* ---------- 安全区探针（0 尺寸，仅供 JS 读取 env()） ---------- */
.sp2-touch-probe{
  position:absolute; left:0; top:0; width:0; height:0; overflow:hidden;
  visibility:hidden; pointer-events:none;
  padding:env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}

/* ---------- 减少动效 ---------- */
@media (prefers-reduced-motion: reduce){
  .sp2-touch-root .sp2-touch-btn,
  .sp2-touch-root .sp2-touch-step,
  .sp2-touch-root .sp2-touch-stick,
  .sp2-touch-root .sp2-touch-hint-icon{ transition:none !important; animation:none !important; }
  .sp2-touch-root .sp2-touch-btn--on{ transform:none; }
}
`;

/* ============================================================================
 * 小工具
 * ========================================================================== */

/** 是否处于“减少动效”偏好（无 matchMedia 时返回 false）。 */
function detectReducedMotion() {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

/**
 * 归一化 + 死区：|v| <= 0.08 视为 0，之后线性重映射到 0..1。
 * @param {number} v
 * @returns {number}
 */
function applyDeadzone(v) {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= STICK_DEADZONE) return 0;
  return Math.sign(v) * clamp((a - STICK_DEADZONE) / (1 - STICK_DEADZONE), 0, 1);
}

/**
 * 从各类事件里取出统一的触点信息（pointer / touch / mouse 均可）。
 * @param {any} ev
 * @returns {{x:number, y:number, id:number}|null}
 */
function pointOf(ev) {
  if (!ev) return null;
  if (typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
    return { x: ev.clientX, y: ev.clientY, id: typeof ev.pointerId === 'number' ? ev.pointerId : 1 };
  }
  const list = ev.changedTouches || ev.touches;
  if (list && list.length) {
    const t = list[0];
    if (t && typeof t.clientX === 'number') return { x: t.clientX, y: t.clientY, id: t.identifier ?? 1 };
  }
  return null;
}

/**
 * 触摸事件的 changedTouches 里是否包含指定 identifier。
 * @param {any} ev @param {number} id
 * @returns {boolean}
 */
function hasTouch(ev, id) {
  const list = ev && ev.changedTouches;
  if (!list) return false;
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return true;
  return false;
}

/**
 * 设备是否具备触摸能力（安全特性探测；Node/无 window 环境返回 false）。
 * @returns {boolean}
 */
export function isTouchDevice() {
  try {
    if (typeof window === 'undefined') return false;
    if ('ontouchstart' in window) return true;
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav) {
      if (typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 0) return true;
      // @ts-ignore 旧版 IE/Edge
      if (typeof nav.msMaxTouchPoints === 'number' && nav.msMaxTouchPoints > 0) return true;
    }
  } catch (_) { /* 探测失败按“非触摸”处理 */ }
  return false;
}

/* ============================================================================
 * 布局计算（纯函数：可预测、可测试）
 * ========================================================================== */

/**
 * 构造一块矩形（保留两位小数，避免浮点噪声）。
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @returns {{x:number, y:number, w:number, h:number}}
 */
function rect(x, y, w, h) {
  const r2 = (v) => Math.round(v * 100) / 100;
  return { x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
}

/**
 * 两个矩形是否相交（接触不算）。
 * @param {{x:number,y:number,w:number,h:number}} a @param {{x:number,y:number,w:number,h:number}} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  return a.x < b.x + b.w - 1e-6 && a.x + a.w > b.x + 1e-6 && a.y < b.y + b.h - 1e-6 && a.y + a.h > b.y + 1e-6;
}

/**
 * 横/竖屏布局：返回每个控件的绝对像素矩形（左上角 + 尺寸）。
 * 保证：可见控件互不重叠、不进入中央 ±15% 区域、按钮 ≥44px、开火 ≥76px。
 * @param {number} W 视口宽 @param {number} H 视口高
 * @param {{t:number,r:number,b:number,l:number}} safe 安全区（px）
 * @param {number} scale 控件缩放 0.8..1.3
 * @returns {any}
 */
function computeTouchLayout(W, H, safe, scale) {
  const portrait = H > W;
  const vm = Math.min(W, H);
  const gap = clamp(vm * 0.02, 6, 12);
  const base = clamp(vm * 0.02, 8, 16);
  const padL = (safe.l || 0) + base;
  const padR = (safe.r || 0) + base;
  const padT = (safe.t || 0) + base;
  const padB = (safe.b || 0) + base;

  // 中央留空区（±15%）与底部条带 / 右侧列的边界
  const center = rect(W * (0.5 - CENTER_FRACTION), H * (0.5 - CENTER_FRACTION), W * CENTER_FRACTION * 2, H * CENTER_FRACTION * 2);
  const bandTop = center.y + center.h + CENTER_MARGIN;
  const bandRight = center.x + center.w + CENTER_MARGIN;

  // 尺寸：clamp(min, vmin*比例, max) * scale，并遵守触控硬下限
  const c = (ratio, lo, hi) => clamp(vm * ratio, lo, hi) * scale;
  const pauseD = Math.max(MIN_TOUCH, c(0.086, MIN_TOUCH, 54));
  const fireD = Math.max(MIN_FIRE, c(0.21, MIN_FIRE, 112));
  const selD = Math.max(MIN_TOUCH, c(0.12, MIN_TOUCH, 58));
  const thW = Math.max(52, c(0.085, 52, 72));
  const thH = Math.max(172, c(0.42, 180, 260));
  const readH = Math.max(14, Math.round(c(0.04, 14, 20)));
  let btn = Math.max(MIN_TOUCH, c(0.086, MIN_TOUCH, 58));
  // 竖屏：开关块（两列）必须整体待在中心留空区右侧，必要时把按钮压到 44px 下限
  if (portrait) {
    const roomRight = W * (0.5 + CENTER_FRACTION) + CENTER_MARGIN;
    const maxBtn = (W - padR - roomRight - gap) / 2;
    if (maxBtn >= MIN_TOUCH) btn = Math.min(btn, maxBtn);
  }

  // 摇杆环：左侧环若整体位于中心留空区左侧，则不受「中心区下沿」高度限制（可以更大更趁手）
  const ringRoom = Math.max(80, H - padB - 6 - bandTop);
  const stickWant = c(0.24, 130, 168);
  const stickLeftClear = padL + 4 + stickWant <= center.x - CENTER_MARGIN;
  const stickD = stickLeftClear ? stickWant : Math.min(stickWant, ringRoom);
  const rudderD = Math.min(c(0.19, 96, 148), stickD * 0.88, ringRoom);

  const boxes = /** @type {Record<string, {x:number,y:number,w:number,h:number}>} */ ({});
  const zones = /** @type {Record<string, {x:number,y:number,w:number,h:number}>} */ ({});
  const zoneTop = Math.max(padT + btn + gap, H * 0.16);
  const useRudderStick = !portrait && W >= 620;

  // 右上角：暂停
  boxes.pause = rect(W - padR - pauseD, padT, pauseD, pauseD);

  // 读数（仪表行）在暂停/开关块下方，右对齐
  const readW = Math.min(clamp(W * 0.30, 104, 210), Math.max(88, W - padR - padL));
  const blocksH = portrait ? pauseD + gap : Math.max(pauseD, btn) + gap;
  boxes.readout = rect(W - padR - readW, padT + blocksH, readW, readH);

  // 开关行
  const nSw = SWITCHES.length;
  let swBlockBottom = 0;
  if (portrait) {
    const cols = 2;
    const rows = Math.ceil(nSw / cols);
    const swW = cols * btn + (cols - 1) * gap;
    const swX = W - padR - swW;
    const swY = boxes.readout.y + readH + gap;
    SWITCHES.forEach((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      boxes['sw' + i] = rect(swX + col * (btn + gap), swY + row * (btn + gap), btn, btn);
    });
    swBlockBottom = swY + rows * btn + (rows - 1) * gap;
  } else {
    const swW = nSw * btn + (nSw - 1) * gap;
    const swX = Math.max(padL, W - padR - pauseD - gap - swW);
    SWITCHES.forEach((s, i) => {
      boxes['sw' + i] = rect(swX + i * (btn + gap), padT, btn, btn);
    });
  }

  // 右边缘：竖直油门（贴右下，但不得顶到读数 / 开关块）
  const thTopLimit = Math.max(boxes.readout.y + readH + gap, portrait ? swBlockBottom + gap : padT + btn + gap);
  const thHeight = (H - padB - thH < thTopLimit) ? Math.max(120, H - padB - thTopLimit) : thH;

  // 左手摇杆（左下）
  boxes.stickL = rect(padL + 4, H - padB - 6 - stickD, stickD, stickD);

  if (!portrait) {
    // 右边缘竖直油门 → 开火（油门左侧，底对齐）→ 选择器 → 弹出列表
    boxes.throttle = rect(W - padR - thW, H - padB - thHeight, thW, thHeight);
    boxes.fire = rect(boxes.throttle.x - gap - fireD, H - padB - fireD, fireD, fireD);
    boxes.selector = rect(boxes.fire.x - gap - selD, boxes.fire.y + (fireD - selD) / 2, selD, selD);
    const menuW = WEAPONS.length * btn + (WEAPONS.length - 1) * gap;
    boxes.menu = rect(Math.max(padL, boxes.selector.x - gap - menuW), boxes.selector.y + (selD - btn) / 2, menuW, btn);
    // 右手：宽屏用浮动方向舵摇杆，窄屏改用两个 44px 方向舵按钮（二选一）
    if (useRudderStick) {
      boxes.stickR = rect(
        boxes.selector.x - gap - rudderD,
        Math.max(H - padB - 6 - rudderD, bandTop),
        rudderD, rudderD,
      );
    } else {
      const rbW = 2 * btn + gap;
      const rbX = Math.max(padL, boxes.selector.x - gap - rbW);
      const rbY = Math.max(H - padB - 6 - btn, bandTop);
      boxes.rudderL = rect(rbX, rbY, btn, btn);
      boxes.rudderR = rect(rbX + btn + gap, rbY, btn, btn);
    }
    // 感应区（不可见）：只覆盖左右两侧 35%，中央永不误触
    zones.zoneL = rect(0, zoneTop, W * (0.5 - CENTER_FRACTION), H - zoneTop);
    zones.zoneR = useRudderStick ? rect(W * (0.5 + CENTER_FRACTION), zoneTop, W * (0.5 - CENTER_FRACTION), H - zoneTop) : null;
  } else {
    // 竖屏：摇杆左下、油门右下、开火在油门上方、选择器贴开火左下（下移到中心区之下）、
    //       开关两列贴右边缘、方向舵按钮竖排贴左边缘（在摇杆上方）
    boxes.throttle = rect(W - padR - thW, H - padB - thHeight, thW, thHeight);
    boxes.fire = rect(W - padR - fireD, boxes.throttle.y - gap - fireD, fireD, fireD);
    const selX = clamp(boxes.fire.x - gap - selD, boxes.stickL.x + boxes.stickL.w + gap, Math.max(padL, W - padR - selD));
    const selY = Math.max(boxes.fire.y + (fireD - selD) / 2, bandTop);
    boxes.selector = rect(selX, selY, selD, selD);
    const menuW = WEAPONS.length * btn + (WEAPONS.length - 1) * gap;
    boxes.menu = rect(Math.max(padL, boxes.selector.x - gap - menuW), boxes.selector.y, menuW, btn);
    const rbY = Math.max(padT + btn, boxes.stickL.y - gap - (2 * btn + gap));
    boxes.rudderL = rect(padL + 4, rbY, btn, btn);
    boxes.rudderR = rect(padL + 4, rbY + btn + gap, btn, btn);
    zones.zoneL = rect(0, zoneTop, W * (0.5 - CENTER_FRACTION), H - zoneTop);
    zones.zoneR = null;
  }

  // 竖屏提示（非控件，只是一个小小的胶囊条，摆在左上角，不挡中央也不压开关）
  if (portrait) {
    const swW = 2 * btn + gap;
    const avail = W - padR - swW - gap - (padL + 4) - gap;
    const hintW = Math.max(80, Math.min(W * 0.52, avail));
    boxes.hint = rect(padL + 4, padT, hintW, Math.max(26, readH + 12));
  }

  // 兜底：任何与中央留空区相交的可见控件，优先右移、其次下移（都不行才缩小）
  for (const k in boxes) {
    const b = boxes[k];
    if (!overlaps(b, center)) continue;
    const needRight = center.x + center.w + CENTER_MARGIN - b.x;
    const needDown = center.y + center.h + CENTER_MARGIN - b.y;
    const canRight = b.x + needRight + b.w <= W - padR + 0.01;
    const canDown = b.y + needDown + b.h <= H - padB + 0.01;
    if (canRight && (!canDown || needRight <= needDown)) {
      b.x = Math.round((b.x + needRight) * 100) / 100;
    } else if (canDown) {
      b.y = Math.round((b.y + needDown) * 100) / 100;
    } else {
      b.h = Math.max(MIN_TOUCH, H - padB - bandTop);
      b.y = Math.round((H - padB - b.h) * 100) / 100;
    }
  }
  void bandRight;

  return {
    portrait, scale, vmin: vm, gap, center, boxes, zones, useRudderStick,
    ringRadius: (boxes.stickL ? boxes.stickL.w : stickD) * 0.52,
    viewport: { w: W, h: H },
  };
}

/* ============================================================================
 * TouchControls
 * ========================================================================== */

export class TouchControls {
  /**
   * @param {object} [o]
   * @param {HTMLElement} [o.container] 挂载容器（缺省不挂载，仅创建 DOM）
   * @param {() => void} [o.onChange] 任何输入变化时的回调
   * @param {number} [o.radius] 摇杆满舵行程（px），缺省按摇杆环尺寸换算
   * @param {number} [o.throttle] 初始油门 0..1
   * @param {number} [o.flaps] 初始襟翼 0..1
   * @param {boolean} [o.rememberThrottle] 是否用 store 记住上次油门（默认 false）
   */
  constructor(o = {}) {
    const opt = o || /** @type {any} */ ({});
    /** @type {HTMLElement|null} */
    this.container = opt.container && typeof opt.container.appendChild === 'function' ? opt.container : null;
    /** @type {(() => void)|null} */
    this.onChange = typeof opt.onChange === 'function' ? opt.onChange : null;
    /** 摇杆行程（px）：显式传入优先，否则随摇杆环尺寸变化 */
    this._radiusOverride = Number.isFinite(opt.radius) ? clamp(Number(opt.radius), 24, 220) : 0;
    this.radius = this._radiusOverride || DEFAULT_RADIUS;
    this.travel = this.radius * 0.6;
    this.rememberThrottle = opt.rememberThrottle === true;
    this.reducedMotion = detectReducedMotion();

    /** @type {Document|null} */
    this._doc = typeof document !== 'undefined' ? document : null;
    /** @type {Window|null} */
    this._win = /** @type {any} */ (typeof window !== 'undefined' ? window : null);
    /** 优先 pointer 事件（支持 setPointerCapture），否则回退 touch 事件 */
    this._pointerMode = !!(this._win && typeof this._win.PointerEvent === 'function');

    /* ---------- 状态 ---------- */
    this._visible = true;
    this._disposed = false;
    const storedThrottle = this.rememberThrottle ? Number(store.get(THROTTLE_KEY, 0)) : 0;
    this._throttle = clamp01(Number.isFinite(opt.throttle) ? Number(opt.throttle)
      : (Number.isFinite(storedThrottle) ? storedThrottle : 0));
    this._flaps = clamp01(Number.isFinite(opt.flaps) ? Number(opt.flaps) : 0);
    this._scale = clamp(Number(store.get(SCALE_KEY, 1)) || 1, 0.8, 1.3);
    this._opacity = clamp(Number(store.get(OPACITY_KEY, 1)) || 1, 0.3, 1);
    /** @type {{x:number,y:number}} 左摇杆原始量（屏幕坐标：x 右为正、y 下为正） */
    this._stickL = { x: 0, y: 0 };
    this._stickLActive = false;
    this._stickLId = /** @type {number|null} */ (null);
    this._stickLOrg = { x: 0, y: 0 };
    this._stickLFloating = false;
    /** @type {{x:number,y:number}} 右（方向舵）摇杆原始量 */
    this._stickR = { x: 0, y: 0 };
    this._stickRActive = false;
    this._stickRId = /** @type {number|null} */ (null);
    this._stickROrg = { x: 0, y: 0 };
    this._stickRFloating = false;
    /** 方向舵按钮（窄屏备用）按下顺序（最后按下的方向生效） @type {number[]} */
    this._yawDirs = [];
    /** 开火按钮状态 */
    this._fireOn = false;
    this._fireId = /** @type {string|null} */ (null);
    this._fireT = 0;
    /** 武器 / 余量 / 减速板锁 / 起落架灯 */
    this._weapon = 0;
    this._menuOpen = false;
    this._ammo = /** @type {Record<string, number|null>} */ ({ fire1: null, fire2: null, bomb: null, flare: null });
    this._airbrakeOn = false;
    this._gearOn = false;
    /** 一次待消费边沿 */
    this._edges = /** @type {Record<string, boolean>} */ ({});
    for (const k of EDGE_KEYS) this._edges[k] = false;
    /** @type {Array<() => void>} */
    this._disposers = [];
    /** 按压高亮定时器 @type {Map<HTMLElement, any>} */
    this._pulseTimers = new Map();
    /** @type {Record<string, any>} */
    this._nodes = {};
    /** 无 document 时这些引用保持空值，所有渲染函数都可安全 no-op */
    /** @type {HTMLElement[]} */
    this._switchBtns = [];
    /** @type {HTMLElement[]} */
    this._menuItems = [];
    /** @type {{ring:HTMLElement,knob:HTMLElement}|null} */
    this._stickNodes = null;
    /** @type {{ring:HTMLElement,knob:HTMLElement}|null} */
    this._rudderNodes = null;
    /** @type {any} 布局快照 */
    this.layout = null;
    this.viewport = { w: 0, h: 0 };
    /** @type {HTMLElement|null} 根元素（无 document 环境为 null） */
    this.el = null;

    // 纯 Node（无 document）：安全降级，只保留数据 API，绝不抛异常
    if (!this._doc) return;

    this._build();
    this.setOpacity(this._opacity, false);
    this.setLayout();

    if (this._win) {
      this._onResize = () => this.setLayout();
      this._win.addEventListener('resize', this._onResize);
      this._win.addEventListener('orientationchange', this._onResize);
      this._disposers.push(() => {
        this._win.removeEventListener('resize', this._onResize);
        this._win.removeEventListener('orientationchange', this._onResize);
      });
    }
  }

  /* ========================================================================
   * 构建 DOM
   * ====================================================================== */

  /**
   * 创建一个受几何管理的元素。
   * @param {string} tag @param {string} name @param {string} role
   * @param {object} [props] @param {any[]} [children]
   * @private
   */
  _ctl(tag, name, role, props, children) {
    const p = Object.assign({
      class: 'sp2-touch-ctl',
      dataset: { ctl: name, role: role || 'ctl' },
    }, props || {});
    const node = el(tag, p, children);
    this._nodes[name] = node;
    return node;
  }

  /**
   * 创建按钮（图标 + 中文标签）。
   * @param {string} name @param {string} label @param {string} icon @param {string} [extraClass]
   * @private
   */
  _button(name, label, icon, extraClass) {
    return this._ctl('button', name, 'ctl', {
      class: 'sp2-touch-ctl sp2-touch-btn' + (extraClass ? ' ' + extraClass : ''),
      type: 'button',
      dataset: { ctl: name, role: 'ctl', action: name },
      attrs: { 'aria-label': label, title: label },
    }, [
      el('span', { class: 'sp2-touch-icon', text: icon, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'sp2-touch-label', text: label }),
    ]);
  }

  /** 创建全部子元素并绑定事件。 @private */
  _build() {
    injectStyles(TOUCH_CSS);
    const root = el('div', {
      class: 'sp2-touch-root',
      attrs: { role: 'group', 'aria-label': '触摸飞行控制' },
      style: { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none' },
    });
    this.el = root;

    /* --- 安全区探针（0 尺寸，不可点、不可见） --- */
    this._probe = el('div', { class: 'sp2-touch-probe', attrs: { 'aria-hidden': 'true' } });
    root.appendChild(this._probe);

    /* --- 竖屏提示（非控件） --- */
    const hint = this._ctl('div', 'hint', 'hint', { class: 'sp2-touch-ctl sp2-touch-hint', attrs: { 'aria-hidden': 'true' } }, [
      el('span', { class: 'sp2-touch-hint-icon', text: '\u{1F4F1}' }),
      el('span', {}, ['建议横屏，操控更舒适']),
    ]);
    hint.hidden = true;

    /* --- 左右摇杆感应区 --- */
    const zoneL = this._ctl('div', 'zoneL', 'zone', { class: 'sp2-touch-ctl sp2-touch-zone', attrs: { 'aria-hidden': 'true' } });
    const zoneR = this._ctl('div', 'zoneR', 'zone', { class: 'sp2-touch-ctl sp2-touch-zone', attrs: { 'aria-hidden': 'true' } });
    this._bindDrag(zoneL, {
      start: (ev) => this._stickStart('L', ev),
      move: (ev) => this._stickMove('L', ev),
      end: () => this._stickEnd('L'),
    });
    this._bindDrag(zoneR, {
      start: (ev) => this._stickStart('R', ev),
      move: (ev) => this._stickMove('R', ev),
      end: () => this._stickEnd('R'),
    });

    /* --- 摇杆环 --- */
    for (const name of ['stickL', 'stickR']) {
      const ring = this._ctl('div', name, 'ring', { class: 'sp2-touch-ctl sp2-touch-stick', attrs: { 'aria-hidden': 'true' } });
      const knob = el('div', { class: 'sp2-touch-knob', attrs: { 'aria-hidden': 'true' } });
      ring.appendChild(knob);
      this._nodes[name + 'Knob'] = knob;
      if (name === 'stickL') this._stickNodes = { ring, knob }; else this._rudderNodes = { ring, knob };
    }

    /* --- 方向舵备用按钮（窄屏 / 竖屏） --- */
    const rl = this._button('rudderL', '左舵', '\u25C0');
    const rr = this._button('rudderR', '右舵', '\u25B6');
    this._bindPress(rl, () => this._yawDown(-1), () => this._yawUp(-1));
    this._bindPress(rr, () => this._yawDown(1), () => this._yawUp(1));

    /* --- 开关行 --- */
    this._switchBtns = [];
    SWITCHES.forEach((s, i) => {
      const b = this._button('sw' + i, s.label, s.icon);
      b.dataset.switch = s.id;
      this._bindPress(b, () => this._switchDown(s, b), () => this._switchUp(s, b));
      this._switchBtns.push(b);
    });

    /* --- 大号开火按钮 + 武器选择器 + 弹出列表 --- */
    const fire = this._button('fire', '开火', WEAPONS[0].icon, 'sp2-touch-fire');
    this._bindPress(fire, () => this._fireDown(), () => this._fireUp());
    const selector = this._button('selector', WEAPONS[0].name, WEAPONS[0].icon, 'sp2-touch-selector');
    this._bindPress(selector, () => this._toggleMenu(), () => { });
    const menu = this._ctl('div', 'menu', 'menu', { class: 'sp2-touch-ctl sp2-touch-menu', attrs: { role: 'menu', 'aria-label': '武器选择' } });
    this._menuItems = WEAPONS.map((w, i) => {
      const b = this._ctl('button', 'wpn' + i, 'menu-item', {
        class: 'sp2-touch-ctl sp2-touch-btn',
        type: 'button',
        dataset: { ctl: 'wpn' + i, role: 'menu-item', weapon: w.id },
        attrs: { role: 'menuitemradio', 'aria-label': w.name },
      }, [
        el('span', { class: 'sp2-touch-icon', text: w.icon, attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'sp2-touch-label', text: w.name }),
        el('span', { class: 'sp2-touch-ammo' }),
      ]);
      this._bindPress(b, () => this._selectWeapon(i, true), () => { });
      menu.appendChild(b);
      return b;
    });
    menu.hidden = true;

    /* --- 油门 --- */
    const throttle = this._ctl('div', 'throttle', 'ctl', { class: 'sp2-touch-ctl sp2-touch-throttle', attrs: { role: 'group', 'aria-label': '油门' } });
    const value = el('div', { class: 'sp2-touch-throttle-value', text: '0%' });
    // ＋/− 是油门两端的“微调触区”：用 role=button 的 div（不是簇按钮，避免把长期可见按钮数顶上去）
    const plus = el('div', {
      class: 'sp2-touch-step',
      attrs: { role: 'button', tabindex: '-1', 'aria-label': '油门 +5%' },
      text: '\uFF0B',
    });
    const minus = el('div', {
      class: 'sp2-touch-step',
      attrs: { role: 'button', tabindex: '-1', 'aria-label': '油门 −5%' },
      text: '\uFF0D',
    });
    const rail = el('div', { class: 'sp2-touch-rail' });
    const fill = el('div', { class: 'sp2-touch-fill' });
    const thumb = el('div', { class: 'sp2-touch-thumb' });
    const track = el('div', {
      class: 'sp2-touch-track',
      attrs: { role: 'slider', 'aria-label': '油门', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' },
    }, [rail, fill]);
    for (const pct of [0, 50, 100]) {
      const tick = el('div', { class: 'sp2-touch-tick', dataset: { label: pct + '%' } });
      tick.style.top = (100 - pct) + '%';
      track.appendChild(tick);
    }
    track.appendChild(thumb);
    throttle.appendChild(value);
    throttle.appendChild(plus);
    throttle.appendChild(track);
    throttle.appendChild(minus);
    this._trackEl = track;
    this._fillEl = fill;
    this._thumbEl = thumb;
    this._valueEl = value;
    this._bindDrag(track, {
      start: (ev) => this._throttleStart(ev),
      move: (ev) => this._throttleMove(ev),
      end: () => { /* 油门不回弹：值保持 */ },
    });
    this._bindPress(plus, () => { this._stepThrottle(THROTTLE_STEP); plus.classList.add('sp2-touch-step--on'); this._buzz(); },
      () => plus.classList.remove('sp2-touch-step--on'));
    this._bindPress(minus, () => { this._stepThrottle(-THROTTLE_STEP); minus.classList.add('sp2-touch-step--on'); this._buzz(); },
      () => minus.classList.remove('sp2-touch-step--on'));
    this._stepNodes = [plus, minus];

    /* --- 暂停 --- */
    const pause = this._button('pause', '暂停', '\u23F8');
    this._bindPress(pause, () => this._edge('pause'), () => { });

    /* --- 仪表读数（非控件） --- */
    this._ro = {
      thr: el('span', {}, ['油门 ', el('b', { text: '0%' })]),
      wpn: el('span', {}, ['-']),
      gear: el('span', {}, ['GEAR ', el('b', { text: '▲' })]),
      flap: el('span', {}, ['FLAP ', el('b', { text: '0%' })]),
    };
    this._roThr = this._ro.thr.querySelector('b');
    this._roGear = this._ro.gear.querySelector('b');
    this._roFlap = this._ro.flap.querySelector('b');
    const readout = this._ctl('div', 'readout', 'readout', { class: 'sp2-touch-ctl sp2-touch-readout', attrs: { 'aria-hidden': 'true' } },
      [this._ro.thr, this._ro.wpn, this._ro.gear, this._ro.flap]);

    /* --- 装配（DOM 顺序 = 层叠顺序） --- */
    root.appendChild(hint);
    root.appendChild(zoneL);
    root.appendChild(zoneR);
    root.appendChild(this._stickNodes.ring);
    root.appendChild(this._rudderNodes.ring);
    root.appendChild(rl);
    root.appendChild(rr);
    for (const b of this._switchBtns) root.appendChild(b);
    root.appendChild(menu);
    root.appendChild(fire);
    root.appendChild(selector);
    root.appendChild(throttle);
    root.appendChild(pause);
    root.appendChild(readout);

    if (this.container) this.container.appendChild(root);
    this._renderThrottle();
    this._renderWeapon();
    this._renderSwitches();
    this._renderReadout();
    this._renderKnobs();
  }

  /* ========================================================================
   * 事件绑定（pointer 优先，回退 touch）
   * ====================================================================== */

  /**
   * 绑定“按下 / 松开”语义（按钮）。多指各自独立。
   * @param {HTMLElement} node @param {(ev:any) => void} onDown @param {(ev:any) => void} onUp
   * @private
   */
  _bindPress(node, onDown, onUp) {
    if (!node || !this._win) return;
    const win = this._win;
    if (this._pointerMode) {
      /** @type {number|null} */
      let id = null;
      const up = (/** @type {any} */ ev) => {
        if (id === null || ev.pointerId !== id) return;
        const pid = id;
        id = null;
        win.removeEventListener('pointerup', up);
        win.removeEventListener('pointercancel', up);
        onUp(pid);
      };
      const down = (/** @type {any} */ ev) => {
        if (id !== null) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        id = ev.pointerId;
        try { node.setPointerCapture?.(id); } catch (_) { /* 忽略 */ }
        win.addEventListener('pointerup', up);
        win.addEventListener('pointercancel', up);
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        onDown(ev);
      };
      node.addEventListener('pointerdown', down);
      this._disposers.push(() => {
        node.removeEventListener('pointerdown', down);
        win.removeEventListener('pointerup', up);
        win.removeEventListener('pointercancel', up);
      });
    } else {
      /** @type {number|null} */
      let id = null;
      const down = (/** @type {any} */ ev) => {
        if (id !== null) return;
        const p = pointOf(ev);
        if (!p) return;
        id = p.id;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        onDown(ev);
      };
      const end = (/** @type {any} */ ev) => {
        if (id === null || !hasTouch(ev, id)) return;
        const pid = id;
        id = null;
        onUp(pid);
      };
      node.addEventListener('touchstart', down, { passive: false });
      node.addEventListener('touchend', end);
      node.addEventListener('touchcancel', end);
      this._disposers.push(() => {
        node.removeEventListener('touchstart', down);
        node.removeEventListener('touchend', end);
        node.removeEventListener('touchcancel', end);
      });
    }
  }

  /**
   * 绑定拖拽语义（摇杆、油门滑条）。
   * @param {HTMLElement} node
   * @param {{start:(ev:any)=>void, move:(ev:any)=>void, end:(ev:any)=>void}} h
   * @private
   */
  _bindDrag(node, h) {
    if (!node || !this._win) return;
    const win = this._win;
    if (this._pointerMode) {
      /** @type {number|null} */
      let id = null;
      const move = (/** @type {any} */ ev) => {
        if (id === null || ev.pointerId !== id) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        h.move(ev);
      };
      const up = (/** @type {any} */ ev) => {
        if (id === null || ev.pointerId !== id) return;
        id = null;
        win.removeEventListener('pointermove', move);
        win.removeEventListener('pointerup', up);
        win.removeEventListener('pointercancel', up);
        h.end(ev);
      };
      const down = (/** @type {any} */ ev) => {
        if (id !== null) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        id = ev.pointerId;
        try { node.setPointerCapture?.(id); } catch (_) { /* 忽略 */ }
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', up);
        win.addEventListener('pointercancel', up);
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        h.start(ev);
      };
      node.addEventListener('pointerdown', down);
      this._disposers.push(() => {
        node.removeEventListener('pointerdown', down);
        win.removeEventListener('pointermove', move);
        win.removeEventListener('pointerup', up);
        win.removeEventListener('pointercancel', up);
      });
    } else {
      /** @type {number|null} */
      let id = null;
      const move = (/** @type {any} */ ev) => {
        if (id === null || !hasTouch(ev, id)) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        h.move(ev);
      };
      const end = (/** @type {any} */ ev) => {
        if (id === null || !hasTouch(ev, id)) return;
        id = null;
        node.removeEventListener('touchmove', move);
        node.removeEventListener('touchend', end);
        node.removeEventListener('touchcancel', end);
        h.end(ev);
      };
      const down = (/** @type {any} */ ev) => {
        if (id !== null) return;
        const p = pointOf(ev);
        if (!p) return;
        id = p.id;
        node.addEventListener('touchmove', move, { passive: false });
        node.addEventListener('touchend', end);
        node.addEventListener('touchcancel', end);
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        h.start(ev);
      };
      node.addEventListener('touchstart', down, { passive: false });
      this._disposers.push(() => {
        node.removeEventListener('touchstart', down);
        node.removeEventListener('touchmove', move);
        node.removeEventListener('touchend', end);
        node.removeEventListener('touchcancel', end);
      });
    }
  }

  /* ========================================================================
   * 摇杆（L = 俯仰/滚转，R = 方向舵 + 刹车/减速板）
   * ====================================================================== */

  /** @param {'L'|'R'} side @param {any} ev @private */
  _stickStart(side, ev) {
    const p = pointOf(ev);
    if (!p) return;
    if (side === 'L') {
      this._stickLActive = true;
      this._stickLId = p.id;
      this._stickLOrg = { x: p.x, y: p.y };
      this._stickL.x = 0; this._stickL.y = 0;
      this._stickLFloating = true;
    } else {
      this._stickRActive = true;
      this._stickRId = p.id;
      this._stickROrg = { x: p.x, y: p.y };
      this._stickR.x = 0; this._stickR.y = 0;
      this._stickRFloating = true;
      this._blurMenu();
    }
    this._placeRing(side, p.x, p.y);
    this._renderKnobs();
    this._changed();
  }

  /** @param {'L'|'R'} side @param {any} ev @private */
  _stickMove(side, ev) {
    const active = side === 'L' ? this._stickLActive : this._stickRActive;
    if (!active) return;
    const p = pointOf(ev);
    if (!p) return;
    const id = side === 'L' ? this._stickLId : this._stickRId;
    if (id !== null && p.id !== id) return;
    const org = side === 'L' ? this._stickLOrg : this._stickROrg;
    let dx = (p.x - org.x) / this.radius;
    let dy = (p.y - org.y) / this.radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    const st = side === 'L' ? this._stickL : this._stickR;
    st.x = clamp(dx, -1, 1);
    st.y = clamp(dy, -1, 1);
    this._renderKnobs();
    this._changed();
  }

  /** @param {'L'|'R'} side @private */
  _stickEnd(side) {
    if (side === 'L') { this._stickLActive = false; this._stickLId = null; }
    else { this._stickRActive = false; this._stickRId = null; }
    this._renderKnobs();
    this._renderReadout();
    this._changed();
  }

  /**
   * 浮动摇杆：环跟随手指落点。
   * @param {'L'|'R'} side @param {number} cx @param {number} cy @private
   */
  _placeRing(side, cx, cy) {
    const name = side === 'L' ? 'stickL' : 'stickR';
    const node = this._nodes[name];
    if (!node) return;
    const box = this.layout && this.layout.boxes[name];
    const w = node.offsetWidth || (box ? box.w : 130);
    const h = node.offsetHeight || (box ? box.h : 130);
    node.style.left = (cx - w / 2) + 'px';
    node.style.top = (cy - h / 2) + 'px';
    node.style.width = w + 'px';
    node.style.height = h + 'px';
    node.classList.add('sp2-touch-stick--float', 'sp2-touch-stick--on');
  }

  /** 刷新两个摇杆的旋钮与点亮状态。 @private */
  _renderKnobs() {
    const t = this.travel;
    if (this._stickNodes) {
      this._stickNodes.knob.style.transform =
        `translate(-50%, -50%) translate(${(this._stickL.x * t).toFixed(2)}px, ${(this._stickL.y * t).toFixed(2)}px)`;
      this._stickNodes.ring.classList.toggle('sp2-touch-stick--on', this._stickLActive);
    }
    if (this._rudderNodes) {
      this._rudderNodes.knob.style.transform =
        `translate(-50%, -50%) translate(${(this._stickR.x * t).toFixed(2)}px, ${(this._stickR.y * t).toFixed(2)}px)`;
      this._rudderNodes.ring.classList.toggle('sp2-touch-stick--on', this._stickRActive);
    }
  }

  /** 把摇杆环放回布局算出的待命位。 @private */
  _resetRingPos(side) {
    const name = side === 'L' ? 'stickL' : 'stickR';
    const node = this._nodes[name];
    const box = this.layout && this.layout.boxes[name];
    if (!node || !box) return;
    node.style.left = box.x + 'px';
    node.style.top = box.y + 'px';
    node.style.width = box.w + 'px';
    node.style.height = box.h + 'px';
    node.classList.remove('sp2-touch-stick--float', 'sp2-touch-stick--on');
  }

  /* ========================================================================
   * 方向舵按钮（窄屏备用）
   * ====================================================================== */

  /** @param {number} dir @private */
  _yawDown(dir) {
    const i = this._yawDirs.indexOf(dir);
    if (i >= 0) this._yawDirs.splice(i, 1);
    this._yawDirs.push(dir);                 // 最后按下的方向生效
    const node = this._nodes[dir > 0 ? 'rudderR' : 'rudderL'];
    if (node) node.classList.add('sp2-touch-btn--on');
    this._buzz();
    this._changed();
  }

  /** @param {number} dir @private */
  _yawUp(dir) {
    const i = this._yawDirs.indexOf(dir);
    if (i >= 0) this._yawDirs.splice(i, 1);
    const node = this._nodes[dir > 0 ? 'rudderR' : 'rudderL'];
    if (node) node.classList.remove('sp2-touch-btn--on');
    this._changed();
  }

  /* ========================================================================
   * 开关行（起落架 / 襟翼 / 减速板 / 视角 / 伞 / 重置）
   * ====================================================================== */

  /**
   * @param {{id:string,label:string,icon:string,kind:string}} s @param {HTMLElement} node
   * @private
   */
  _switchDown(s, node) {
    this._pulse(node);
    switch (s.kind) {
      case 'gear':
        this._gearOn = !this._gearOn;
        this._edges.gear = true;
        this._buzz();
        break;
      case 'flap': {
        let i = 0;
        for (let k = 0; k < FLAP_DETENTS.length; k++) if (Math.abs(FLAP_DETENTS[k] - this._flaps) < 0.02) i = k;
        this._flaps = FLAP_DETENTS[(i + 1) % FLAP_DETENTS.length];
        this._buzz();
        break;
      }
      case 'latch':
        this._airbrakeOn = !this._airbrakeOn;
        this._buzz();
        break;
      default:
        this._edge(s.id, node);
        return;
    }
    this._renderSwitches();
    this._renderReadout();
    this._changed();
  }

  /**
   * @param {{id:string,kind:string}} s @param {HTMLElement} node
   * @private
   */
  _switchUp(s, node) {
    if (s.kind === 'latch' || s.kind === 'gear' || s.kind === 'flap') return;
    node.classList.remove('sp2-touch-btn--on');
  }

  /** 开关行的常亮状态（起落架 / 襟翼 / 减速板）。 @private */
  _renderSwitches() {
    if (!this._switchBtns) return;
    SWITCHES.forEach((s, i) => {
      const node = this._switchBtns[i];
      if (!node) return;
      let on = false;
      if (s.kind === 'gear') on = this._gearOn;
      else if (s.kind === 'flap') on = this._flaps > 0.01;
      else if (s.kind === 'latch') on = this._airbrakeOn;
      node.classList.toggle('sp2-touch-btn--on', on);
    });
  }

  /* ========================================================================
   * 开火 / 武器选择
   * ====================================================================== */

  /** 当前武器定义 @private */
  get _weaponDef() { return WEAPONS[this._weapon]; }

  /** @param {string} id @returns {boolean} 余量是否可用 @private */
  _ammoOk(id) {
    const n = this._ammo[id];
    return n == null || n > 0;
  }

  /** @private */
  _fireDown() {
    const w = this._weaponDef;
    if (!this._ammoOk(w.id)) return;      // 无余量：置灰不可用
    this._fireOn = true;
    this._fireId = w.id;
    this._fireT = 0;
    this._edges[w.id] = true;
    this._pulse(this._nodes.fire);
    this._buzz();
    this._changed();
  }

  /** @private */
  _fireUp() {
    this._fireOn = false;
    this._fireId = null;
    this._fireT = 0;
    const node = this._nodes.fire;
    if (node) node.classList.remove('sp2-touch-btn--on');
    this._changed();
  }

  /** @private */
  _toggleMenu() {
    this._menuOpen = !this._menuOpen;
    this._buzz();
    this._applyMenu();
  }

  /** @private */
  _blurMenu() {
    if (!this._menuOpen) return;
    this._menuOpen = false;
    this._applyMenu();
  }

  /**
   * 选择武器。
   * @param {number} i @param {boolean} [close] 是否收起列表
   * @private
   */
  _selectWeapon(i, close) {
    if (i < 0 || i >= WEAPONS.length) return;
    this._weapon = i;
    if (close) this._menuOpen = false;
    if (this._fireOn) this._fireUp();      // 换弹先松开，避免错发
    this._buzz();
    this._renderWeapon();
    this._renderReadout();
    this._applyMenu();
    this._changed();
  }

  /** 刷新开火按钮 / 选择器 / 列表项。 @private */
  _renderWeapon() {
    const w = this._weaponDef;
    const fire = this._nodes.fire;
    if (fire) {
      const icon = fire.querySelector('.sp2-touch-icon');
      if (icon) icon.textContent = w.icon;
      fire.classList.toggle('sp2-touch-btn--off', !this._ammoOk(w.id));
    }
    const sel = this._nodes.selector;
    if (sel) {
      const icon = sel.querySelector('.sp2-touch-icon');
      const label = sel.querySelector('.sp2-touch-label');
      if (icon) icon.textContent = w.icon;
      if (label) label.textContent = w.name;
      sel.classList.toggle('sp2-touch-btn--off', !this._ammoOk(w.id));
    }
    if (this._menuItems) this._menuItems.forEach((b, i) => {
      const def = WEAPONS[i];
      const ammo = b.querySelector('.sp2-touch-ammo');
      const n = this._ammo[def.id];
      if (ammo) ammo.textContent = n == null ? '--' : String(n);
      b.classList.toggle('sp2-touch-btn--off', !this._ammoOk(def.id));
      b.classList.toggle('sp2-touch-btn--on', i === this._weapon);
      b.setAttribute('aria-checked', String(i === this._weapon));
    });
  }

  /** 展开 / 收起武器列表。 @private */
  _applyMenu() {
    const menu = this._nodes.menu;
    if (!menu) return;
    menu.hidden = !this._menuOpen;
    const sel = this._nodes.selector;
    if (sel) sel.classList.toggle('sp2-touch-btn--on', this._menuOpen);
  }

  /* ========================================================================
   * 边沿 / 反馈
   * ====================================================================== */

  /**
   * 记录一个一次性边沿（含震动/高亮反馈）。
   * @param {string} id @param {HTMLElement} [node] @private
   */
  _edge(id, node) {
    if (!EDGE_KEYS.includes(id)) return;
    this._edges[id] = true;
    this._pulse(node || this._nodes[id]);
    this._buzz();
    this._changed();
  }

  /**
   * 短暂点亮按键（一次性动作的按压反馈）。
   * @param {HTMLElement|undefined|null} node @private
   */
  _pulse(node) {
    if (!node) return;
    node.classList.add('sp2-touch-btn--on');
    const timers = this._pulseTimers;
    const old = timers.get(node);
    if (old !== undefined) clearTimeout(old);
    const t = setTimeout(() => {
      timers.delete(node);
      const sw = node.dataset ? node.dataset.switch : null;
      if (!sw || !this._switchIsOn(sw)) node.classList.remove('sp2-touch-btn--on');
    }, this.reducedMotion ? 40 : 150);
    timers.set(node, t);
  }

  /** @param {string} id @returns {boolean} @private */
  _switchIsOn(id) {
    if (id === 'gear') return this._gearOn;
    if (id === 'airbrake') return this._airbrakeOn;
    if (id === 'flap') return this._flaps > 0.01;
    return false;
  }

  /** 按下震动反馈（可用时）。 @private */
  _buzz() {
    if (this.reducedMotion) return;
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      if (nav && typeof nav.vibrate === 'function') nav.vibrate(10);
    } catch (_) { /* 忽略 */ }
  }

  /* ========================================================================
   * 油门
   * ====================================================================== */

  /** @param {any} ev @private */
  _throttleStart(ev) {
    const p = pointOf(ev);
    if (!p) return;
    this._throttleStartV = this._throttle;
    this._throttleStartY = p.y;
    this._applyThrottleY(p.y);
  }

  /** @param {any} ev @private */
  _throttleMove(ev) {
    const p = pointOf(ev);
    if (!p) return;
    this._applyThrottleY(p.y);
  }

  /**
   * 根据触点 y 计算油门（优先用轨道真实高度；无布局时退化为相对位移）。
   * @param {number} y @private
   */
  _applyThrottleY(y) {
    if (!Number.isFinite(y)) return;
    let v;
    const r = this._trackEl && typeof this._trackEl.getBoundingClientRect === 'function'
      ? this._trackEl.getBoundingClientRect() : null;
    const h = r && Number.isFinite(r.height) ? r.height : 0;
    if (h > 0) v = 1 - (y - r.top) / h;
    else v = (this._throttleStartV ?? this._throttle) - (y - (this._throttleStartY ?? y)) / FALLBACK_SLIDER_PX;
    this._setThrottle(v);
  }

  /** @param {number} d @private */
  _stepThrottle(d) { this._setThrottle(this._throttle + d); }

  /** @param {number} v @private */
  _setThrottle(v) {
    const next = clamp01(Number.isFinite(v) ? v : 0);
    if (Math.abs(next - this._throttle) < 1e-4) return;
    this._throttle = next;
    if (this.rememberThrottle) store.set(THROTTLE_KEY, next);
    this._renderThrottle();
    this._changed();
  }

  /** 刷新油门滑条视觉。 @private */
  _renderThrottle() {
    const pct = Math.round(this._throttle * 100);
    if (this._fillEl) this._fillEl.style.height = (this._throttle * 100).toFixed(2) + '%';
    if (this._thumbEl) this._thumbEl.style.bottom = (this._throttle * 100).toFixed(2) + '%';
    if (this._valueEl) this._valueEl.textContent = pct + '%';
    if (this._trackEl) this._trackEl.setAttribute('aria-valuenow', String(pct));
    this._renderReadout();
  }

  /* ========================================================================
   * 仪表读数
   * ====================================================================== */

  /** 刷新极简仪表行：油门% / 武器+余量 / GEAR 灯 / FLAP。 @private */
  _renderReadout() {
    if (!this._roThr) return;
    const w = this._weaponDef;
    const n = this._ammo[w.id];
    this._roThr.textContent = Math.round(this._throttle * 100) + '%';
    this._ro.wpn.textContent = `${w.icon}${w.name} ${n == null ? '--' : n}`;
    this._roGear.textContent = this._gearOn ? '▼' : '▲';
    if (this._ro.gear) this._ro.gear.classList.toggle('sp2-touch-on', this._gearOn);
    this._roFlap.textContent = Math.round(this._flaps * 100) + '%';
    if (this._ro.flap) this._ro.flap.classList.toggle('sp2-touch-warn', this.axes.airbrake > 0);
  }

  /* ========================================================================
   * 布局
   * ====================================================================== */

  /** 读取安全区（通过 0 尺寸探针的 env() 计算值）。 @private */
  _safeInsets() {
    const out = { t: 0, r: 0, b: 0, l: 0 };
    if (!this._win || !this._probe || typeof this._win.getComputedStyle !== 'function') return out;
    try {
      const cs = this._win.getComputedStyle(this._probe);
      const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
      out.t = num(cs.paddingTop);
      out.r = num(cs.paddingRight);
      out.b = num(cs.paddingBottom);
      out.l = num(cs.paddingLeft);
    } catch (_) { /* 忽略 */ }
    return out;
  }

  /**
   * 视口变化时重排（横竖屏、缩放、安全区）。
   * @returns {void}
   */
  setLayout() {
    if (!this.el) return;
    const win = this._win;
    const W = win && Number.isFinite(win.innerWidth) ? win.innerWidth : 1024;
    const H = win && Number.isFinite(win.innerHeight) ? win.innerHeight : 768;
    this.viewport = { w: W, h: H };
    const L = computeTouchLayout(W, H, this._safeInsets(), this._scale);
    this.layout = L;

    if (!this._radiusOverride) {
      this.radius = clamp(L.ringRadius, 34, 120);
      this.travel = this.radius * 0.6;
    }

    for (const k in L.boxes) {
      const node = this._nodes[k];
      const b = L.boxes[k];
      if (!node || !b) continue;
      node.style.left = b.x + 'px';
      node.style.top = b.y + 'px';
      node.style.width = b.w + 'px';
      node.style.height = b.h + 'px';
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    }
    for (const k of ['zoneL', 'zoneR']) {
      const node = this._nodes[k];
      const b = L.zones[k];
      if (!node || !b) continue;
      node.style.left = b.x + 'px';
      node.style.top = b.y + 'px';
      node.style.width = b.w + 'px';
      node.style.height = b.h + 'px';
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    }

    // 提示只出现在竖屏
    if (this._nodes.hint) this._nodes.hint.hidden = !L.portrait;
    // 方向舵：摇杆 / 按钮二选一
    const useStick = !!L.useRudderStick;
    if (this._nodes.stickR) this._nodes.stickR.hidden = !useStick;
    if (this._nodes.rudderL) this._nodes.rudderL.hidden = useStick;
    if (this._nodes.rudderR) this._nodes.rudderR.hidden = useStick;
    if (this._nodes.zoneR) this._nodes.zoneR.hidden = !useStick;
    if (!useStick) { this._stickRActive = false; this._stickRId = null; }

    this._resetRingPos('L');
    if (!this._stickRActive) this._resetRingPos('R');
    this._applyMenu();
    this._renderThrottle();
    this._renderReadout();
  }

  /**
   * 当前布局快照（调试/测试用：每个控件的像素矩形）。
   * @returns {any}
   */
  getLayout() { return this.layout; }

  /* ========================================================================
   * 公共 API
   * ====================================================================== */

  /**
   * 显示 / 隐藏（隐藏时会松开所有瞬时输入，油门 / 襟翼 / 减速板锁保持）。
   * @param {boolean} v @returns {void}
   */
  setVisible(v) {
    const on = !!v;
    this._visible = on;
    if (this.el) {
      this.el.classList.toggle('sp2-touch-hidden', !on);
      this.el.setAttribute('aria-hidden', String(!on));
    }
    if (!on) this._releaseAll();
  }

  /** @returns {boolean} */
  get visible() { return this._visible; }

  /**
   * 控件整体透明度（0.3–1，走 store 记忆）。
   * @param {number} v @param {boolean} [save] 是否写入 store（默认 true）
   * @returns {void}
   */
  setOpacity(v, save) {
    const next = clamp(Number.isFinite(v) ? Number(v) : 1, 0.3, 1);
    this._opacity = next;
    if (this.el) this.el.style.opacity = String(next);
    if (save !== false) store.set(OPACITY_KEY, next);
  }

  /** 当前透明度 @returns {number} */
  get opacity() { return this._opacity; }

  /**
   * 控件整体缩放（0.8–1.3，走 store 记忆；受 44px / 76px 触控下限保护）。
   * @param {number} v @returns {void}
   */
  setScale(v) {
    const next = clamp(Number.isFinite(v) ? Number(v) : 1, 0.8, 1.3);
    this._scale = next;
    store.set(SCALE_KEY, next);
    this.setLayout();
  }

  /** 当前缩放 @returns {number} */
  get scale() { return this._scale; }

  /**
   * 同步武器余量（null/undefined = 未知，不置灰）。
   * @param {Record<string, number|null>} map @returns {void}
   */
  setAmmo(map) {
    if (!map) return;
    for (const w of WEAPONS) {
      if (!(w.id in map)) continue;
      const v = map[w.id];
      this._ammo[w.id] = Number.isFinite(v) ? Math.max(0, Number(v)) : null;
    }
    this._renderWeapon();
    this._renderReadout();
  }

  /** 同步起落架指示灯。 @param {boolean} on @returns {void} */
  setGear(on) {
    this._gearOn = !!on;
    this._renderSwitches();
    this._renderReadout();
  }

  /** 直接选择武器（'fire1' | 'fire2' | 'bomb' | 'flare'）。 @param {string} id @returns {void} */
  setWeapon(id) {
    const i = WEAPONS.findIndex((w) => w.id === id);
    if (i >= 0) this._selectWeapon(i, false);
  }

  /** 当前武器 id @returns {string} */
  get weapon() { return this._weaponDef.id; }

  /**
   * 本帧轴量（直接喂给 input.axes）。
   * @returns {{pitch:number, roll:number, yaw:number, throttle:number, brake:number, flaps:number, airbrake:number}}
   */
  get axes() {
    const yawBtn = this._yawDirs.length ? this._yawDirs[this._yawDirs.length - 1] : 0;
    const yawStick = applyDeadzone(this._stickR.x);
    // 方向舵摇杆：上推 = 减速板，下拉 = 刹车
    const rv = this._stickRActive ? this._stickR.y : 0;
    const brake = rv > STICK_DEADZONE;
    const airbrake = this._airbrakeOn || rv < -STICK_DEADZONE;
    return {
      // 上推 = 低头：y 以向下为正，故 pitch = y（等价于「向上为正时的 -y」）
      pitch: applyDeadzone(this._stickL.y),
      roll: applyDeadzone(this._stickL.x),
      yaw: clamp(yawStick !== 0 ? yawStick : yawBtn, -1, 1),
      throttle: this._throttle,
      brake: brake ? 1 : 0,
      flaps: this._flaps,
      airbrake: airbrake ? 1 : 0,
    };
  }

  /**
   * 取出并清空本帧的边沿动作。键集合固定（宿主 input.js 依赖，不可增删）：
   * gear/camera/reset/pause/fire2/bomb/flare/chute/autolevel/boost/fire1/brake/airbrake。
   * fire1/fire2/brake/airbrake 为「按住电平」，每帧汇报；其余为一次性边沿。
   * @returns {{gear:boolean, camera:boolean, reset:boolean, fire1:boolean, fire2:boolean, bomb:boolean,
   *   flare:boolean, chute:boolean, pause:boolean, autolevel:boolean, boost:boolean,
   *   brake:boolean, airbrake:boolean}}
   */
  consumeEdges() {
    const a = this.axes;
    const firing = this._fireOn ? this._fireId : null;
    const out = {
      gear: !!this._edges.gear,
      camera: !!this._edges.camera,
      reset: !!this._edges.reset,
      pause: !!this._edges.pause,
      fire2: !!this._edges.fire2 || firing === 'fire2',
      bomb: !!this._edges.bomb,
      flare: !!this._edges.flare,
      chute: !!this._edges.chute,
      autolevel: !!this._edges.autolevel,
      boost: !!this._edges.boost,
      fire1: firing === 'fire1',
      brake: a.brake === 1,
      airbrake: a.airbrake === 1,
    };
    for (const k of EDGE_KEYS) this._edges[k] = false;
    return out;
  }

  /**
   * 设置油门（0..1，自动钳制，不经过动画）。
   * @param {number} v01 @returns {void}
   */
  setThrottle(v01) {
    const next = clamp01(Number.isFinite(v01) ? Number(v01) : 0);
    this._throttle = next;
    if (this.rememberThrottle) store.set(THROTTLE_KEY, next);
    this._renderThrottle();
    this._changed();
  }

  /** 当前油门 0..1 @returns {number} */
  get throttle() { return this._throttle; }

  /**
   * 每帧调用：摇杆回中、开火连发节奏、视觉刷新。
   * @param {number} dt 秒 @returns {void}
   */
  update(dt) {
    if (this._disposed) return;
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;

    // 左右摇杆回中（临界阻尼，约 0.18s）
    const lambda = this.reducedMotion ? 1e6 : STICK_RETURN_LAMBDA;
    if (!this._stickLActive && d > 0) {
      this._stickL.x = damp(this._stickL.x, 0, lambda, d);
      this._stickL.y = damp(this._stickL.y, 0, lambda, d);
      if (Math.abs(this._stickL.x) < SNAP) this._stickL.x = 0;
      if (Math.abs(this._stickL.y) < SNAP) this._stickL.y = 0;
    }
    if (!this._stickRActive && d > 0) {
      this._stickR.x = damp(this._stickR.x, 0, lambda, d);
      this._stickR.y = damp(this._stickR.y, 0, lambda, d);
      if (Math.abs(this._stickR.x) < SNAP) this._stickR.x = 0;
      if (Math.abs(this._stickR.y) < SNAP) this._stickR.y = 0;
    }
    // 归零后摇杆环回到待命位
    if (!this._stickLActive && this._stickL.x === 0 && this._stickL.y === 0 && this._stickLFloating) {
      this._stickLFloating = false;
      this._resetRingPos('L');
    }
    if (!this._stickRActive && this._stickR.x === 0 && this._stickR.y === 0 && this._stickRFloating) {
      this._stickRFloating = false;
      this._resetRingPos('R');
    }
    this._renderKnobs();

    // 按住开火：炸弹 / 干扰弹按固定节奏补边沿（机炮 / 导弹为按住电平，由宿主节流）
    if (this._fireOn && this._fireId && d > 0) {
      const def = WEAPONS.find((w) => w.id === this._fireId);
      if (def && !def.hold) {
        this._fireT += d;
        if (this._fireT >= FIRE_REPEAT_SEC) {
          this._fireT = 0;
          if (this._ammoOk(this._fireId)) {
            this._edges[this._fireId] = true;
            this._changed();
          }
        }
      }
    }
  }

  /** 释放所有瞬时输入（油门 / 襟翼 / 减速板锁保持）。 @private */
  _releaseAll() {
    this._stickLActive = false; this._stickLId = null;
    this._stickRActive = false; this._stickRId = null;
    this._stickL.x = 0; this._stickL.y = 0;
    this._stickR.x = 0; this._stickR.y = 0;
    this._stickLFloating = false;
    this._stickRFloating = false;
    this._yawDirs.length = 0;
    this._fireOn = false;
    this._fireId = null;
    this._fireT = 0;
    this._menuOpen = false;
    for (const k of EDGE_KEYS) this._edges[k] = false;
    for (const key in this._nodes) {
      const n = this._nodes[key];
      if (n && n.classList && n.classList.contains('sp2-touch-btn')) n.classList.remove('sp2-touch-btn--on');
    }
    for (const n of (this._stepNodes || [])) n.classList.remove('sp2-touch-step--on');
    this._resetRingPos('L');
    this._resetRingPos('R');
    this._renderKnobs();
    this._renderSwitches();
    this._applyMenu();
    this._renderReadout();
  }

  /** 输入变化通知（回调异常不影响输入采集）。 @private */
  _changed() {
    if (!this.onChange) return;
    try { this.onChange(); } catch (_) { /* 用户回调异常忽略 */ }
  }

  /** 卸载：解绑事件、移除 DOM。 @returns {void} */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._releaseAll();
    for (const t of this._pulseTimers.values()) clearTimeout(t);
    this._pulseTimers.clear();
    for (const d of this._disposers) { try { d(); } catch (_) { /* 忽略 */ } }
    this._disposers.length = 0;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
