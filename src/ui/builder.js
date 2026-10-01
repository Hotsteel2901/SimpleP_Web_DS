// @ts-check
/**
 * src/ui/builder.js —— 机库 / 建造器（Hangar / Craft Builder）
 * ==================================================================
 * SimplePlanes 的招牌功能：在机库里用零件拼装飞机、调整参数、查看性能并试飞。
 *
 * 设计要点：
 *  - **自带 3D 预览**：独立的 `THREE.WebGLRenderer` + 轨道相机 + 网格地板 + 程序化天空 + 三点布光。
 *    仅在 `open()` 期间、且"画面有变化"时渲染（螺旋桨怠速动画会持续标脏）。
 *  - **预览模型复用 `buildCraftVisual()`**：与真正飞行的飞机完全一致（含可动控制面）。
 *    由于它以质心为原点，这里把 `group.position` 设为质心，使子网格世界坐标 == `part.pos`，
 *    于是选中/拖拽/吸附都能直接用零件坐标，无需换算。
 *  - **零件实例格式**（不可改）：{ uid, def, pos:[x,y,z], rot:[rx,ry,rz](度), size:[w,h,l], color, props, attachedTo }
 *  - **镜像对称**：`symmetry: 'none'|'x'|'xy'`，放置/移动/旋转/删除都会同步到镜像伙伴。
 *  - **撤销栈**：深拷贝 `craft.parts` 的快照，最多 80 步。
 *  - 所有危险操作都包在 try/catch 里，坏数据/缺零件/统计抛错都不会让界面崩溃。
 *
 * 宿主用法：
 *   const b = new Builder({ container, onExit, onFly, onSave, getCrafts });
 *   b.open(craft);                 // 或 b.open() 新建
 *   主循环里： if (打开中) b.update(dt);
 *   窗口尺寸变化： b.resize();
 *   离开机库： b.close();          // 释放 GPU，DOM 保留
 *   彻底不再使用： b.dispose();
 *
 * 模块顶层不触碰 document / window。
 */
import * as THREE from 'three';
import {
  CATEGORIES, PART_DEFS, makePart, defaultProps, partMass, partCost, buildPartMesh,
} from '../build/parts.js';
import { stockCrafts, autoBalance } from '../build/crafts.js';
import { buildCraftVisual, computeCraftStats } from '../flight/aircraft.js';
import {
  el, clear, injectStyles, THEME, isModalOpen,
  Panel, Slider, Button, Select, Tabs, ListBox, Toast, Modal,
} from './widgets.js';
import { clamp, DEG, RAD2DEG, fmt, formatMass, formatMoney, deepClone, store, makeSkyTexture } from '../core/util.js';

/* ================================================================== 常量 */
/** 位置容差（米）：判定镜像伙伴 */
const POS_EPS = 0.08;
/** 角度容差（度） */
const ROT_EPS = 2;
/** 旋转吸附步长（度） */
const ROT_SNAP = 15;
/** 微调面板可选的旋转步长（度） */
const ROT_STEPS = [15, 5, 1];
/** 微调面板可选的位置步长（米） */
const NUDGE_STEPS = [0.05, 0.25, 1];
/** 长按连点：按住多久开始重复、重复间隔（ms） */
const REPEAT_DELAY = 400;
const REPEAT_EVERY = 80;
/** 撤销栈深度 */
const HISTORY_MAX = 80;
/** 步长选项 */
const STEP_OPTIONS = [0.05, 0.1, 0.25, 0.5, 1];
/** 存储键 */
const LS_SYM = 'sp2.builder.symmetry';
const LS_STEP = 'sp2.builder.step';
const LS_TOUCH_HINT = 'sp2.builder.touchHintSeen';
const LS_ROT_STEP = 'sp2.builder.rotStep';
const LS_NUDGE_OPEN = 'sp2.builder.nudgeOpen';

/* ---- 触屏/指针判定阈值 ---- */
/** 点按最大位移（CSS px）：超过即视为拖动 */
const TAP_MOVE = 10;
/** 点按最长时长（ms） */
const TAP_MS = 350;
/** 长按时长（ms）：弹出零件小菜单 */
const LONG_PRESS_MS = 500;
/** 手柄命中半径（CSS px）：鼠标 / 触屏 */
const HIT_PX_MOUSE = 14;
const HIT_PX_TOUCH = 28;
/** 触屏可点区域下限（CSS px） */
const TOUCH_MIN_PX = 44;
/** 底部面板高度（vh） */
const SHEET_COLLAPSED_VH = 38;
const SHEET_EXPANDED_VH = 82;
/** 交互模式 */
const MODES = ['move', 'rotate', 'view'];

/**
 * 是否触屏设备（`(pointer:coarse)` / 触摸点 / ontouchstart）。
 * 在 Node（无 window）下安全返回 false。
 * @returns {boolean}
 */
export function isTouchDevice() {
  try {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer:coarse)')?.matches) return true;
    if (typeof navigator !== 'undefined' && toNum(navigator.maxTouchPoints, 0) > 0) return true;
    if ('ontouchstart' in window) return true;
  } catch (e) { /* 忽略 */ }
  return false;
}

/** 点到线段的距离（屏幕像素） */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t, cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/* ================================================================== 样式 */
/**
 * 建造器专属样式（`sp2-builder-` 前缀）。
 * 只注入一次（injectStyles 本身也按内容去重）。
 */
const EXTRA_CSS = /* css */ `
.sp2-builder{
  position:fixed; inset:0; z-index:60;
  background:#05080c; color:var(--sp-text);
  font-family:var(--sp-font); font-size:${THEME.fontBase};
  overflow:hidden; user-select:none; -webkit-user-select:none;
}
.sp2-builder.sp-hidden{ display:none !important; }

.sp2-builder__stage{ position:absolute; inset:0; touch-action:none; cursor:crosshair; }
.sp2-builder__canvas{ display:block; width:100%; height:100%; outline:none; }
.sp2-builder__broken{
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  text-align:center; padding:24px; color:var(--sp-text-dim); pointer-events:none;
}

/* ---------------- 顶部工具栏 ---------------- */
.sp2-builder__toolbar{
  position:absolute; left:12px; right:12px; top:10px; z-index:6;
  display:flex; flex-wrap:wrap; align-items:center; gap:6px;
  padding:8px 10px;
  background:rgba(10,16,24,.78);
  border:1px solid rgba(0,208,255,.28);
  border-radius:8px;
  backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  box-shadow:var(--sp-shadow);
}
.sp2-builder__toolbar .sp-btn{ padding:7px 10px; }
.sp2-builder__spacer{ flex:1 1 24px; }
.sp2-builder__name{
  width:170px; padding:7px 10px;
  font:inherit; color:var(--sp-text);
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.14); border-radius:var(--sp-radius-sm);
}
.sp2-builder__name:hover{ border-color:rgba(0,208,255,.45); }
.sp2-builder__name:focus-visible{ outline:none; border-color:var(--sp-accent); box-shadow:0 0 0 2px rgba(0,208,255,.25); }

/* ---------------- 左右两侧 ---------------- */
.sp2-builder__left{
  position:absolute; left:12px; top:66px; bottom:12px; width:272px; z-index:5;
  display:flex; flex-direction:column; min-height:0;
}
.sp2-builder__right{
  position:absolute; right:12px; top:66px; bottom:12px; width:322px; z-index:5;
  display:flex; flex-direction:column; gap:10px;
  overflow-y:auto; overflow-x:hidden;
  scrollbar-width:thin; scrollbar-color:rgba(0,208,255,.35) transparent;
}
.sp2-builder__right::-webkit-scrollbar{ width:8px; }
.sp2-builder__right::-webkit-scrollbar-thumb{ background:rgba(0,208,255,.3); border-radius:4px; }

.sp2-builder .sp-panel{
  position:relative; top:auto; left:auto; right:auto; bottom:auto;
  width:100%; min-width:0; max-width:none; max-height:none;
}
.sp2-builder__left .sp-panel{ flex:1 1 auto; min-height:0; }
.sp2-builder__right .sp-panel{ flex:0 0 auto; }
.sp2-builder__right .sp-panel__body{ max-height:44vh; }
.sp2-builder__right .sp-panel__bar{ padding:7px 10px; }

.sp2-builder__palette-inner{
  display:flex; flex-direction:column; gap:8px; min-height:0; height:100%;
}
.sp2-builder__palette .sp-panel__body{ display:flex; flex-direction:column; min-height:0; }
.sp2-builder__palette .sp-listbox{ flex:1 1 auto; max-height:none; min-height:80px; }
.sp2-builder__search{
  width:100%; padding:8px 10px;
  font:inherit; color:var(--sp-text);
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.14); border-radius:var(--sp-radius-sm);
}
.sp2-builder__search:hover{ border-color:rgba(0,208,255,.45); }
.sp2-builder__search:focus-visible{ outline:none; border-color:var(--sp-accent); box-shadow:0 0 0 2px rgba(0,208,255,.25); }
.sp2-builder .sp-tabs__strip{ margin-bottom:2px; }
.sp2-builder .sp-tab{ padding:6px 8px; font-size:12px; }

/* ---------------- 通用小块 ---------------- */
.sp2-builder__col{ display:flex; flex-direction:column; gap:8px; }
.sp2-builder__sub{ color:var(--sp-text-dim); font-size:${THEME.fontSmall}; line-height:1.5; }
.sp2-builder__empty{ color:var(--sp-text-faint, var(--sp-text-dim)); font-size:${THEME.fontSmall}; padding:6px 0; }
.sp2-builder__hr{ height:1px; background:rgba(0,208,255,.16); margin:2px 0; }
.sp2-builder__caption{
  color:var(--sp-accent); font-size:${THEME.fontSmall}; letter-spacing:.4px;
  text-shadow:0 0 8px rgba(0,208,255,.3);
}
.sp2-builder__readout{
  display:flex; flex-wrap:wrap; gap:4px 12px;
  font-variant-numeric:tabular-nums;
  font-family:${THEME.fontMono};
  font-size:${THEME.fontSmall}; color:var(--sp-text);
}
.sp2-builder__nudgerow{ display:flex; align-items:center; gap:6px; }
.sp2-builder__axislabel{
  flex:0 0 54px; color:var(--sp-text-dim); font-size:${THEME.fontSmall};
}
.sp2-builder__nudgerow .sp-btn{ flex:1 1 0; padding:6px 0; font-size:12px; }
.sp2-builder__actions{ display:flex; flex-wrap:wrap; gap:6px; }
.sp2-builder__actions .sp-btn{ flex:1 1 auto; padding:7px 10px; font-size:12px; }
.sp2-builder__colorrow{ display:flex; align-items:center; gap:8px; }
.sp2-builder__color{
  width:44px; height:26px; padding:0;
  background:transparent; border:1px solid rgba(0,208,255,.35); border-radius:4px; cursor:pointer;
}
.sp2-builder__color::-webkit-color-swatch-wrapper{ padding:2px; }
.sp2-builder__color::-webkit-color-swatch{ border:none; border-radius:2px; }

/* ---------------- 统计 ---------------- */
.sp2-builder__statrow{
  display:flex; align-items:baseline; justify-content:space-between; gap:10px;
  padding:2px 0; font-size:${THEME.fontSmall};
}
.sp2-builder__statrow > span:first-child{ color:var(--sp-text-dim); }
.sp2-builder__statrow > span:last-child{ color:var(--sp-text); font-variant-numeric:tabular-nums; }
.sp2-builder__warn{
  margin-top:5px; padding:6px 8px;
  border-left:3px solid var(--sp-accent);
  border-radius:0 4px 4px 0;
  background:rgba(0,208,255,.07);
  font-size:${THEME.fontSmall}; line-height:1.45; color:var(--sp-text);
}
.sp2-builder__warn--error{ border-left-color:var(--sp-danger); background:rgba(255,77,94,.10); color:#ffdfe3; }
.sp2-builder__warn--warn{ border-left-color:var(--sp-warning); background:rgba(255,159,67,.10); color:#ffe6c7; }
.sp2-builder__warn--ok{ border-left-color:var(--sp-success); background:rgba(61,220,132,.10); color:#d8ffe9; }

/* ---------------- JSON 文本域 ---------------- */
.sp2-builder__json{
  width:100%; min-height:38vh; resize:vertical;
  padding:10px;
  font-family:${THEME.fontMono}; font-size:12px; line-height:1.45;
  color:var(--sp-text); background:rgba(0,0,0,.35);
  border:1px solid rgba(0,208,255,.28); border-radius:var(--sp-radius-sm);
}
.sp2-builder__json:focus-visible{ outline:none; border-color:var(--sp-accent); box-shadow:0 0 0 2px rgba(0,208,255,.22); }

/* ---------------- 底部提示 ---------------- */
.sp2-builder__hint{
  position:absolute; left:50%; bottom:10px; transform:translateX(-50%);
  z-index:5; max-width:min(92vw,900px); text-align:center;
  padding:6px 12px;
  color:var(--sp-text-dim); font-size:${THEME.fontSmall}; line-height:1.4;
  background:rgba(10,16,24,.7);
  border:1px solid rgba(0,208,255,.18); border-radius:8px;
  backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  pointer-events:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.sp2-builder__hint b{ color:var(--sp-accent); font-weight:600; }

/* ---------------- 微调（扳手）面板 ---------------- */
.sp2-builder__nrow{ display:flex; align-items:center; gap:6px; padding:2px 0; }
.sp2-builder__nlabel{ flex:0 0 64px; color:var(--sp-text-dim); font-size:${THEME.fontSmall}; }
.sp2-builder__nval{
  flex:1 1 auto; text-align:center; min-width:56px;
  font-family:${THEME.fontMono}; font-size:${THEME.fontSmall}; color:var(--sp-text);
  font-variant-numeric:tabular-nums; white-space:nowrap;
}
.sp2-builder__nbtn{
  flex:0 0 auto; min-width:38px; min-height:34px; padding:4px 9px;
  font:inherit; font-size:17px; line-height:1; color:var(--sp-text);
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.14); border-radius:${THEME.radiusSm}px;
  cursor:pointer; touch-action:none; user-select:none; -webkit-user-select:none;
}
.sp2-builder__nbtn:hover{ border-color:rgba(0,208,255,.5); background:rgba(255,255,255,.12); }
.sp2-builder__nbtn:active{ background:rgba(0,208,255,.24); border-color:var(--sp-accent); }
.sp2-builder__nbtn:focus-visible{ outline:2px solid var(--sp-accent); outline-offset:1px; }
.sp2-builder__ngroup{ display:flex; flex-direction:column; gap:2px; }

/* ---------------- 响应式 ---------------- */
@media (max-width:1080px){
  .sp2-builder__left{ width:224px; }
  .sp2-builder__right{ width:276px; }
  .sp2-builder__name{ width:120px; }
}
@media (max-width:820px){
  .sp2-builder__left{ top:104px; bottom:auto; height:38vh; width:210px; }
  .sp2-builder__right{ top:104px; height:52vh; width:240px; }
  .sp2-builder__hint{ display:none; }
}

/* ==================================================================
 * 触屏布局（.sp2-builder--touch）
 * 顶部紧凑工具栏 + 底部可折叠面板；左右侧栏隐藏，内容并入底部面板。
 * ================================================================== */
.sp2-builder__sheet,
.sp2-builder__selbar,
.sp2-builder__addbtn,
.sp2-builder__touchhint,
.sp2-builder__portrait,
.sp2-builder__ctxmenu,
.sp2-builder__chips,
.sp2-builder__grid,
.sp2-builder__modes{ display:none; }

/* ---------------- 底部面板 ---------------- */
.sp2-builder--touch .sp2-builder__sheet{
  display:flex; flex-direction:column;
  position:absolute; left:0; right:0; bottom:0; z-index:8;
  height:${SHEET_COLLAPSED_VH}vh; min-height:180px;
  background:rgba(8,14,22,.94);
  border-top:1px solid rgba(0,208,255,.32);
  border-radius:14px 14px 0 0;
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  box-shadow:0 -10px 30px rgba(0,0,0,.5);
  padding-bottom:env(safe-area-inset-bottom, 0px);
  transition:height .18s ease-out;
  touch-action:none;
}
.sp2-builder--touch .sp2-builder__sheet--expanded{ height:${SHEET_EXPANDED_VH}vh; }
.sp2-builder__sheet-handle{
  flex:0 0 auto; display:flex; align-items:center; justify-content:center;
  height:26px; cursor:grab; touch-action:none;
}
.sp2-builder__sheet-grip{
  width:46px; height:5px; border-radius:3px; background:rgba(0,208,255,.45);
  box-shadow:0 0 10px rgba(0,208,255,.35);
}
.sp2-builder__sheet-tabs{
  flex:0 0 auto; display:flex; gap:4px; padding:0 8px 6px;
}
.sp2-builder__sheet-tab{
  flex:1 1 0; min-height:${TOUCH_MIN_PX}px;
  font:inherit; font-size:14px; color:var(--sp-text-dim);
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.12); border-radius:8px;
  cursor:pointer; touch-action:manipulation;
}
.sp2-builder__sheet-tab--active{
  color:#eaf9ff; border-color:rgba(0,208,255,.7);
  background:linear-gradient(180deg, rgba(0,208,255,.28), rgba(0,208,255,.12));
  box-shadow:0 0 12px rgba(0,208,255,.3);
}
.sp2-builder__sheet-body{
  flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden;
  padding:4px 10px 10px;
  -webkit-overflow-scrolling:touch;
  touch-action:pan-y;
  scrollbar-width:thin;
}
.sp2-builder__pane{ display:block; }
.sp2-builder__pane[hidden]{ display:none; }
/* 底部面板里复用 Panel 的 body：去掉面板痕迹 */
.sp2-builder__sheet-body .sp-panel__body{ padding:0; overflow:visible; max-height:none; background:none; }

/* ---------------- 触屏：隐藏左右栏与桌面控件 ---------------- */
.sp2-builder--touch .sp2-builder__left,
.sp2-builder--touch .sp2-builder__right{ display:none; }
.sp2-builder--touch .sp2-builder__hint{ display:none; }
.sp2-builder--touch .sp-tabs{ display:none; }
.sp2-builder--touch .sp-listbox{ display:none; }
.sp2-builder--touch .sp2-builder__touchhide{ display:none !important; }

/* ---------------- 触屏：顶部工具栏（≥48px） ---------------- */
.sp2-builder--touch .sp2-builder__toolbar{
  left:0; right:0; top:0; border-radius:0;
  padding:calc(6px + env(safe-area-inset-top, 0px)) 8px 6px;
  gap:6px; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden;
  -webkit-overflow-scrolling:touch;
}
.sp2-builder__toolbar::-webkit-scrollbar{ height:0; }
.sp2-builder--touch .sp2-builder__toolbar .sp-btn{
  min-width:48px; min-height:48px; padding:6px 10px;
  font-size:13px; flex:0 0 auto;
}
.sp2-builder--touch .sp2-builder__toolbar .sp-btn__icon{ font-size:18px; }
.sp2-builder--touch .sp2-builder__toolbar .sp-btn__label{ display:none; }
.sp2-builder--touch .sp2-builder__toolbar .sp2-builder__btn-labeled .sp-btn__label{ display:inline; }

/* ---------------- 触屏：模式切换 ---------------- */
.sp2-builder__touchonly{ display:none !important; }
.sp2-builder--touch .sp2-builder__touchonly{ display:inline-flex !important; }
.sp2-builder--touch .sp2-builder__modes{
  display:flex; flex:0 0 auto; gap:4px; padding:2px;
  background:rgba(255,255,255,.06); border:1px solid rgba(0,208,255,.24); border-radius:10px;
}
.sp2-builder__mode{
  min-width:56px; min-height:44px; padding:4px 8px;
  font:inherit; font-size:12px; color:var(--sp-text-dim);
  background:transparent; border:1px solid transparent; border-radius:8px;
  cursor:pointer; touch-action:manipulation;
}
.sp2-builder__mode--active{
  color:#eaf9ff; border-color:rgba(0,208,255,.7);
  background:linear-gradient(180deg, rgba(0,208,255,.3), rgba(0,208,255,.12));
  box-shadow:0 0 12px rgba(0,208,255,.35);
}

/* ---------------- 触屏：分类 chip（横向滚动） ---------------- */
.sp2-builder--touch .sp2-builder__chips{
  display:flex; gap:6px; overflow-x:auto; padding:2px 0 8px;
  -webkit-overflow-scrolling:touch; scrollbar-width:none;
}
.sp2-builder__chip{
  flex:0 0 auto; min-height:${TOUCH_MIN_PX}px; padding:8px 14px;
  font:inherit; font-size:13px; color:var(--sp-text-dim);
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.14); border-radius:999px;
  cursor:pointer; touch-action:manipulation; white-space:nowrap;
}
.sp2-builder__chip--active{
  color:#eaf9ff; border-color:rgba(0,208,255,.7);
  background:linear-gradient(180deg, rgba(0,208,255,.28), rgba(0,208,255,.12));
}

/* ---------------- 触屏：两列大图标零件网格 ---------------- */
.sp2-builder--touch .sp2-builder__grid{
  display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px;
}
.sp2-builder__card{
  display:flex; align-items:center; gap:10px;
  min-height:64px; padding:8px 10px; text-align:left;
  font:inherit; color:var(--sp-text);
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.12); border-radius:10px;
  cursor:pointer; touch-action:manipulation;
}
.sp2-builder__card:active{ border-color:rgba(0,208,255,.7); background:rgba(0,208,255,.14); }
.sp2-builder__card--active{ border-color:rgba(0,208,255,.8); box-shadow:inset 0 0 14px rgba(0,208,255,.18); }
.sp2-builder__card-icon{ flex:0 0 auto; font-size:26px; line-height:1; }
.sp2-builder__card-texts{ display:flex; flex-direction:column; gap:2px; min-width:0; }
.sp2-builder__card-name{ font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sp2-builder__card-sub{ font-size:11px; color:var(--sp-text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ---------------- 触屏：选中提示条 ---------------- */
.sp2-builder--touch .sp2-builder__selbar{
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  position:absolute; left:8px; right:8px; z-index:9;
  bottom:calc(${SHEET_COLLAPSED_VH}vh + 8px + env(safe-area-inset-bottom, 0px));
  padding:8px 10px;
  background:rgba(10,16,24,.9);
  border:1px solid rgba(0,208,255,.4); border-radius:10px;
  backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
}
.sp2-builder--touch .sp2-builder__sheet--expanded ~ .sp2-builder__selbar{ display:none; }
.sp2-builder__seltext{ flex:1 1 auto; min-width:0; font-size:12px; color:var(--sp-text); }
.sp2-builder__seltext b{ color:var(--sp-accent); }
.sp2-builder__selbar .sp-btn{ min-height:${TOUCH_MIN_PX}px; min-width:${TOUCH_MIN_PX}px; padding:8px 10px; font-size:12px; }

/* ---------------- 触屏：未展开时的“添加零件”大按钮 ---------------- */
.sp2-builder--touch .sp2-builder__addbtn{
  display:flex; align-items:center; justify-content:center; gap:8px;
  position:absolute; left:50%; transform:translateX(-50%); z-index:9;
  bottom:calc(${SHEET_COLLAPSED_VH}vh + 8px + env(safe-area-inset-bottom, 0px));
  min-height:52px; padding:12px 22px;
  font:inherit; font-size:15px; font-weight:600; color:#eaf9ff;
  background:linear-gradient(180deg, rgba(0,208,255,.34), rgba(0,208,255,.16));
  border:1px solid rgba(0,208,255,.7); border-radius:999px;
  box-shadow:0 6px 20px rgba(0,0,0,.45), 0 0 18px rgba(0,208,255,.35);
  cursor:pointer; touch-action:manipulation;
}

/* ---------------- 触屏：首次操作提示 / 竖屏提示 ---------------- */
.sp2-builder--touch .sp2-builder__touchhint{
  display:flex; align-items:center; justify-content:center; text-align:center;
  position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:11;
  max-width:min(88vw,420px); padding:16px 18px;
  background:rgba(8,14,22,.92);
  border:1px solid rgba(0,208,255,.5); border-radius:12px;
  box-shadow:var(--sp-shadow);
  font-size:14px; line-height:1.7; color:var(--sp-text);
  pointer-events:none;
  animation:sp2-builder-fade .25s ease-out;
}
.sp2-builder--touch .sp2-builder__portrait{
  display:block; position:absolute; left:8px; right:8px; z-index:7;
  top:calc(66px + env(safe-area-inset-top, 0px));
  padding:7px 10px; text-align:center;
  font-size:12px; color:#ffe6c7;
  background:rgba(255,159,67,.16);
  border:1px solid rgba(255,159,67,.5); border-radius:8px;
  pointer-events:none;
}
@keyframes sp2-builder-fade{ from{ opacity:0; transform:translate(-50%,-46%); } to{ opacity:1; transform:translate(-50%,-50%); } }

/* ---------------- 长按小菜单 ---------------- */
.sp2-builder__ctxmenu{
  position:fixed; z-index:${THEME.zModal - 5};
  flex-direction:column; gap:4px; padding:6px;
  background:rgba(10,16,24,.95);
  border:1px solid rgba(0,208,255,.45); border-radius:10px;
  box-shadow:var(--sp-shadow);
}
.sp2-builder__ctxmenu--open{ display:flex; }
.sp2-builder__ctxmenu .sp-btn{ min-height:${TOUCH_MIN_PX}px; min-width:120px; justify-content:flex-start; font-size:13px; }

/* ---------------- 触屏：属性/统计里的滑块加大 ---------------- */
.sp2-builder--touch .sp-slider__track{ height:34px; }
.sp2-builder--touch .sp-slider__thumb{ width:22px; height:22px; }
.sp2-builder--touch .sp-btn{ min-height:${TOUCH_MIN_PX}px; }
.sp2-builder--touch .sp-select{ min-height:${TOUCH_MIN_PX}px; }
/* 触屏：微调面板按钮 ≥44px（数值微调是手机端的主要精调手段） */
.sp2-builder--touch .sp2-builder__nbtn{ min-width:${TOUCH_MIN_PX}px; min-height:${TOUCH_MIN_PX}px; font-size:20px; }
.sp2-builder--touch .sp2-builder__nrow{ gap:8px; padding:4px 0; }
.sp2-builder--touch .sp2-builder__nlabel{ flex:0 0 56px; font-size:13px; }
.sp2-builder--touch .sp2-builder__nval{ font-size:14px; }
`;

/** 是否已注入过自定义样式（模块级，保证只注入一次）。 */
let _stylesInjected = false;

/** 注入基础 + 建造器样式（幂等）。 */
function ensureStyles() {
  if (_stylesInjected) return;
  injectStyles(EXTRA_CSS);
  _stylesInjected = true;
}

/* ================================================================== 小工具 */
/** 保留 3 位小数，消除浮点漂移 */
const r3 = (v) => Math.round(v * 1000) / 1000;
/** 角度规格化到 (-180, 180] */
function normDeg(a) {
  if (!Number.isFinite(a)) return 0;
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return Math.round(x * 100) / 100;
}
/** 分类图标 */
function catIcon(catId) {
  const c = CATEGORIES.find((x) => x.id === catId);
  return c?.icon || '🔧';
}
/** 三点共线：取与射线最近的轴参数（用于拖拽手柄） */
function closestTOnAxis(origin, axis, ray) {
  const d1 = axis;
  const d2 = ray.ray.direction;
  const w0 = new THREE.Vector3().subVectors(origin, ray.ray.origin);
  const a = d1.dot(d1), b = d1.dot(d2), c = d2.dot(d2);
  const d = d1.dot(w0), e = d2.dot(w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) return null;
  return (b * e - c * d) / denom;
}
/** 数字安全转换 */
function toNum(v, dv) { return Number.isFinite(v) ? Number(v) : dv; }
/** 三元数组安全转换 */
function toVec3(v, dv) {
  if (Array.isArray(v) && v.length >= 3) return [toNum(+v[0], dv[0]), toNum(+v[1], dv[1]), toNum(+v[2], dv[2])];
  return [dv[0], dv[1], dv[2]];
}

/* ================================================================== Builder */
/**
 * 机库 / 建造器。
 */
export class Builder {
  /**
   * @param {object} [opts]
   * @param {HTMLElement} [opts.container] 挂载容器（默认 document.body）
   * @param {()=>void} [opts.onExit] 点“返回”时调用
   * @param {(craft:object)=>void} [opts.onFly] 点“试飞”时调用
   * @param {(craft:object)=>void} [opts.onSave] 点“保存”时调用
   * @param {()=>object[]} [opts.getCrafts] 返回自建机型列表（供“载入”弹窗）
   */
  constructor(opts = {}) {
    ensureStyles();
    /** @type {object} */
    this.opts = opts || {};
    /** 全屏根元素 */
    this.el = /** @type {any} */ (null);

    /* ---- 生命周期状态 ---- */
    this._open = false;
    this._disposed = false;
    this._broken = false;          // WebGL 不可用（界面仍可用）
    this._dirty = true;            // 需要重绘
    this._time = 0;
    this._spin = 0;                // 螺旋桨相位

    /* ---- 渲染资源 ---- */
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._skyTex = null;
    this._floorGrid = null;        // 场景网格地板（DOM 零件网格是 this._grid）
    this._ground = null;

    /* ---- 预览 / 交互 ---- */
    this._preview = null;          // buildCraftVisual 结果
    this._helpers = [];            // [{ hb, obj }] 选中包围盒
    this._gizmo = null;            // 拖拽手柄组
    this._gizmoMode = 'move';      // 手柄形态：move | rotate
    /** @type {'move'|'rotate'|'view'} 交互模式（触屏可一键切换） */
    this._mode = 'move';
    this._ghost = null;            // { group, part }
    this._ghostDef = null;         // 手上拿着的零件 def id
    this._ghostPlacement = null;   // { pos, rot, attached }
    this._drag = null;             // 单指针手势（相机 / 手柄 / 零件 / 待选中）
    this._pointers = new Map();    // pointerId -> { x,y,x0,y0,t0,button,type,moved }
    this._longPress = null;        // { timer, pointerId, part, x, y }
    this._ctxMenu = null;          // 长按小菜单 DOM
    this._ctxOutside = null;       // 菜单外部点击监听
    this._touchHintTimer = 0;
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    /** 指针位置（NaN 表示"未在舞台上移动过"，放置取画面中心） */
    this._hover = { x: NaN, y: NaN, over: false };
    this._orbit = { target: new THREE.Vector3(0, 0.8, 0), yaw: 0.65, pitch: 0.3, dist: 14 };

    /* ---- 触屏布局 ---- */
    this._touchLayout = isTouchDevice();   // 当前是否触屏布局
    this._layoutForced = null;             // 宿主显式指定后不再自动判定
    this._sheetTab = 'parts';              // parts | nudge | props | stats
    this._sheetExpanded = false;
    this._rotAxis = 1;                     // 触屏旋转模式的轴（0=X,1=Y,2=Z）

    /* ---- 微调（数值）面板 ---- */
    this._rotStep = 15;                    // 旋转微调步长（度）
    const rs = toNum(store.get(LS_ROT_STEP, 15), 15);
    if (ROT_STEPS.includes(rs)) this._rotStep = rs;
    this._nudgeVisible = !!store.get(LS_NUDGE_OPEN, false);   // 桌面：是否展开微调面板
    this._hadSelection = false;

    /* ---- 编辑状态 ---- */
    this._uidSeq = 0;
    this._history = [];
    this._future = [];
    this._selUids = new Set();
    this._cat = CATEGORIES[0]?.id || 'misc';
    this._query = '';
    this._stockCache = null;
    let step = toNum(store.get(LS_STEP, 0.25), 0.25);
    if (!STEP_OPTIONS.includes(step)) step = 0.25;
    this._step = step;
    let sym = store.get(LS_SYM, 'none');
    if (sym !== 'none' && sym !== 'x' && sym !== 'xy') sym = 'none';
    /** @type {'none'|'x'|'xy'} */
    this._symmetry = sym;

    /* ---- 初始空机型（必须在建 UI 之前：面板会读取 craft） ---- */
    this._craft = this._blankCraft();

    /* ---- DOM ---- */
    this._buildUI();

    /* ---- 事件绑定（一次性；处理函数内部判断 _open） ---- */
    this._onKeyDownBound = (ev) => this._onKeyDown(ev);
    this._onResizeBound = () => this.resize();
    this._bindStageEvents();
    if (typeof ResizeObserver !== 'undefined') {
      try {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this._stage);
      } catch (e) { console.warn('[builder] ResizeObserver 失败', e); }
    }

    /* ---- 初始空机型 ---- */
    this._craft = this._craft || this._blankCraft();

    /* ---- 挂载 ---- */
    const host = this.opts.container || (typeof document !== 'undefined' ? document.body : null);
    if (host && host.appendChild) host.appendChild(this.el);
  }

  /* ================================================================ 对外 API */

  /** 当前机型定义（永远有效） @returns {object} */
  get craft() { return this._craft; }

  /** 当前镜像对称模式 @returns {'none'|'x'|'xy'} */
  get symmetry() { return this._symmetry; }

  /** 设置镜像对称模式（同步界面与本地存储） */
  set symmetry(v) {
    this._symmetry = (v === 'x' || v === 'xy') ? v : 'none';
    try { store.set(LS_SYM, this._symmetry); } catch (e) { /* 忽略 */ }
    try { this._symSelect?.setValue?.(this._symmetry, false); } catch (e) { /* 忽略 */ }
    this._refreshHint();
  }

  /** 当前移动步长（米） @returns {number} */
  get step() { return this._step; }

  /** 设置移动步长（米） */
  set step(v) {
    const n = toNum(v, 0.25);
    this._step = n > 0 ? n : 0.25;
    try { store.set(LS_STEP, this._step); } catch (e) { /* 忽略 */ }
    try { this._stepSelect?.setValue?.(String(this._step), false); } catch (e) { /* 忽略 */ }
    this._refreshHint();
  }

  /** 当前交互模式 @returns {'move'|'rotate'|'view'} */
  get mode() { return this._mode; }

  /**
   * 切换交互模式。
   *  - `move`：拖动已选零件 = 平移；手柄=箭头
   *  - `rotate`：拖动已选零件 = 绕轴旋转（15° 吸附）；手柄=圆环
   *  - `view`：拖动任何位置都只旋转相机（纯视角）
   * @param {'move'|'rotate'|'view'} mode
   * @returns {void}
   */
  setMode(mode, silent) {
    const m = MODES.includes(mode) ? mode : 'move';
    const changed = m !== this._mode;
    this._mode = m;
    this._gizmoMode = m === 'rotate' ? 'rotate' : 'move';
    this._applyGizmoMode(true);
    this._refreshModeButtons();
    this._refreshHint();
    this._syncSelBar();
    this._dirty = true;
    if (changed && !silent) {
      const name = m === 'move' ? '移动零件' : (m === 'rotate' ? '旋转零件' : '仅视角');
      Toast.push('模式：' + name, { kind: 'info', duration: 1400 });
    }
  }

  /** 是否处于触屏布局 @returns {boolean} */
  get touchLayout() { return !!this._touchLayout; }

  /**
   * 显式指定触屏布局（传 `undefined`/`null` 恢复自动判定）。
   * @param {boolean} [on]
   * @returns {void}
   */
  setTouchLayout(on) {
    this._layoutForced = (on === undefined || on === null) ? null : !!on;
    this._applyLayout();
  }

  /**
   * 展开/收起底部面板（触屏布局）。
   * @param {boolean} on
   * @returns {void}
   */
  setSheetExpanded(on) {
    this._sheetExpanded = !!on;
    this._syncSheet();
  }

  /**
   * 切换底部面板的标签页（触屏布局）。
   * @param {'parts'|'nudge'|'props'|'stats'} tab
   * @returns {void}
   */
  setSheetTab(tab) {
    this._sheetTab = (tab === 'props' || tab === 'stats' || tab === 'nudge') ? tab : 'parts';
    this._syncSheet();
  }

  /**
   * 打开建造器。传入 craft 会克隆并载入，否则新建空机型。会清空撤销栈。
   * @param {object} [craft]
   * @returns {void}
   */
  open(craft) {
    if (this._disposed) { console.warn('[builder] 已 dispose，忽略 open'); return; }
    this._open = true;
    this.el.classList.remove('sp-hidden');

    // 双保险：隐藏可能盖住建造器的主菜单（宿主 main.js 自行恢复）
    try {
      const menu = (typeof document !== 'undefined' && document.querySelector) ? document.querySelector('.sp2-menu') : null;
      if (menu && menu.style) menu.style.display = 'none';
    } catch (e) { /* 忽略 */ }

    this._ensureRenderer();
    this._loadCraftInternal(craft);
    this._history.length = 0;
    this._future.length = 0;
    this._refreshHistoryButtons();

    // 键盘 / 尺寸监听
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDownBound, false);
      window.addEventListener('keydown', this._onKeyDownBound, false);
      window.removeEventListener('resize', this._onResizeBound, false);
      window.addEventListener('resize', this._onResizeBound, false);
    }
    this._sheetTab = 'parts';
    this._sheetExpanded = false;
    this._hadSelection = false;
    this._applyLayout();
    this.resize();
    this._frameCraft();
    this._refreshPanels();
    this._refreshStats();
    this._refreshHint();
    this._syncSelBar();
    this.setMode(this._mode, true);
    this._maybeShowTouchHint();
    this._dirty = true;
  }

  /** 关闭：停止渲染并释放 GPU 资源（DOM 保留，可再次 open）。 @returns {void} */
  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.add('sp-hidden');
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDownBound, false);
      window.removeEventListener('resize', this._onResizeBound, false);
    }
    this._drag = null;
    this._pointers.clear();
    this._cancelLongPress();
    this._closeContextMenu();
    this._cancelTouchHint();
    this._brokenNote?.classList.add('sp-hidden');
    this._clearGhost();
    this._disposeSceneResources();
    if (this._renderer) {
      try { this._renderer.dispose(); } catch (e) { console.warn('[builder] renderer.dispose', e); }
      try { this._renderer.forceContextLoss?.(); } catch (e) { /* 忽略 */ }
    }
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._broken = false;
    this._replaceCanvas();
  }

  /** 视口尺寸变化。 @returns {void} */
  resize() {
    this._updatePortraitHint();
    if (!this._renderer || !this._camera) return;
    try {
      const w = Math.max(1, this._stage.clientWidth || 1);
      const h = Math.max(1, this._stage.clientHeight || 1);
      this._renderer.setSize(w, h, false);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
      this._dirty = true;
    } catch (e) { console.warn('[builder] resize 失败', e); }
  }

  /**
   * 主循环每帧调用（仅在打开时有效）：驱动螺旋桨怠速动画与按需重绘。
   * @param {number} dt 秒
   * @returns {void}
   */
  update(dt) {
    if (!this._open || this._disposed || this._broken || !this._renderer) return;
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 1 / 60;
    this._time += d;

    // 螺旋桨怠速转动（小动画：让"没变化就不渲染"仍有生气）
    const props = this._preview?.props;
    if (props && props.length) {
      this._spin = (this._spin + d * 7.5) % (Math.PI * 2);
      for (const p of props) {
        if (p.mesh) p.mesh.rotation.z = (p.baseRotZ || 0) + this._spin;
      }
      this._dirty = true;
    }
    if (this._dirty) {
      this._dirty = false;
      this._render();
    }
  }

  /**
   * 直接设置当前机型（不重置相机；会记录可撤销快照）。
   * @param {object} craft
   * @returns {void}
   */
  setCraft(craft) {
    if (this._disposed) return;
    const clean = this._sanitizeCraft(craft);
    if (!clean) { Toast.push('机型数据无效，已忽略。', { kind: 'warn' }); return; }
    this._pushHistory();
    this._adoptCraft(clean);
    this._refreshHistoryButtons();
  }

  /** 彻底销毁：close + 卸载 DOM + 释放监听。 @returns {void} */
  dispose() {
    if (this._disposed) return;
    this.close();
    this._disposed = true;
    try { this._ro?.disconnect?.(); } catch (e) { /* 忽略 */ }
    this._ro = null;
    this._unbindStageEvents();
    for (const p of [this.palettePanel, this.transformPanel, this.propsPanel, this.statsPanel]) {
      try { p?.dispose?.(); } catch (e) { /* 忽略 */ }
    }
    try { if (this.el?.parentNode) this.el.parentNode.removeChild(this.el); } catch (e) { /* 忽略 */ }
  }

  /* ================================================================ 撤销 / 重做 */

  /** 记录一次撤销快照（必须在改动前调用） @private */
  _pushHistory() {
    try {
      this._history.push(JSON.stringify(this._craft.parts || []));
      if (this._history.length > HISTORY_MAX) this._history.shift();
      this._future.length = 0;
    } catch (e) { console.warn('[builder] 快照失败', e); }
    this._refreshHistoryButtons();
  }

  /**
   * 连续拖动（滑块）时的快照会话：同一 key 且在 700ms 内只记录一次快照。
   * @param {'_propSession'|'_scaleSession'} name
   * @param {string} key
   * @private
   */
  _touchSession(name, key) {
    const now = Date.now();
    let s = this[name];
    if (!s || s.key !== key || (now - toNum(s.t, 0)) > 700) { s = { key, t: now, pushed: false }; this[name] = s; }
    s.t = now;
    if (!s.pushed) { this._pushHistory(); s.pushed = true; }
  }

  /** 撤销 @returns {void} */
  undo() {
    if (!this._history.length) { Toast.push('没有可撤销的操作', { kind: 'info', duration: 1400 }); return; }
    try {
      this._future.push(JSON.stringify(this._craft.parts || []));
      const snap = this._history.pop();
      this._craft.parts = Array.isArray(JSON.parse(snap)) ? JSON.parse(snap) : [];
      this._afterExternalPartsChange();
      Toast.push('已撤销', { kind: 'info', duration: 1200 });
    } catch (e) {
      console.warn('[builder] 撤销失败', e);
      Toast.push('撤销失败', { kind: 'error' });
    }
  }

  /** 重做 @returns {void} */
  redo() {
    if (!this._future.length) { Toast.push('没有可重做的操作', { kind: 'info', duration: 1400 }); return; }
    try {
      this._history.push(JSON.stringify(this._craft.parts || []));
      const snap = this._future.pop();
      this._craft.parts = Array.isArray(JSON.parse(snap)) ? JSON.parse(snap) : [];
      this._afterExternalPartsChange();
      Toast.push('已重做', { kind: 'info', duration: 1200 });
    } catch (e) {
      console.warn('[builder] 重做失败', e);
      Toast.push('重做失败', { kind: 'error' });
    }
  }

  /** parts 被整体替换后（撤销/重做/载入）的收尾 @private */
  _afterExternalPartsChange() {
    // 清理已不存在的选中 uid
    const alive = new Set((this._craft.parts || []).map((p) => p.uid));
    for (const uid of [...this._selUids]) if (!alive.has(uid)) this._selUids.delete(uid);
    this._resyncUidSeq();
    this._rebuildPreview();
    this._refreshPanels();
    this._refreshHistoryButtons();
    this._dirty = true;
  }

  /** 刷新撤销/重做按钮可用状态 @private */
  _refreshHistoryButtons() {
    try {
      this.undoBtn?.setEnabled(this._history.length > 0);
      this.redoBtn?.setEnabled(this._future.length > 0);
    } catch (e) { /* 忽略 */ }
  }

  /* ================================================================ DOM 构建 */

  /** 构建全部界面 @private */
  _buildUI() {
    this.el = el('div', { class: 'sp2-builder sp-hidden', tabIndex: -1, 'aria-label': '机库建造器' });

    // 3D 舞台（canvas 会被整体替换，事件挂在 stage 上）
    this._stage = el('div', { class: 'sp2-builder__stage' });
    this._canvasHolder = el('div', {
      class: 'sp2-builder__canvas-holder',
      style: { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%' },
    });
    this.canvas = this._newCanvas();
    this._canvasHolder.appendChild(this.canvas);
    this._stage.appendChild(this._canvasHolder);
    this._brokenNote = el('div', {
      class: 'sp2-builder__broken sp-hidden',
      text: '3D 预览不可用（WebGL 初始化失败）。你仍然可以编辑零件与查看性能。',
    });
    this._stage.appendChild(this._brokenNote);
    this.el.appendChild(this._stage);

    // 顶部工具栏
    this.toolbar = el('div', { class: 'sp2-builder__toolbar' });
    this.el.appendChild(this.toolbar);
    this._buildToolbar();

    // 左侧：零件库
    this.palettePanel = new Panel({
      title: '零件库', mounted: false,
      className: 'sp2-builder__panel sp2-builder__palette',
    });
    this.palettePanel.body.appendChild(this._buildPalette());
    this.leftCol = el('div', { class: 'sp2-builder__left' }, [this.palettePanel.el]);
    this.el.appendChild(this.leftCol);

    // 右侧：变换 / 微调 / 属性 / 统计
    this.transformPanel = new Panel({ title: '变换', mounted: false, className: 'sp2-builder__panel' });
    this.nudgePanel = new Panel({ title: '微调（数值）', mounted: false, className: 'sp2-builder__panel sp2-builder__nudgepanel' });
    this.propsPanel = new Panel({ title: '零件属性', mounted: false, className: 'sp2-builder__panel' });
    this.statsPanel = new Panel({ title: '性能统计', mounted: false, className: 'sp2-builder__panel' });

    this._tfBody = this.transformPanel.body;
    this._nudgeBody = this.nudgePanel.body;
    this.propsBody = this.propsPanel.body;
    this._statsBody = el('div', { class: 'sp2-builder__stats' });
    this.statsPanel.body.appendChild(this._statsBody);
    this._autoBtn = new Button({ label: '自动配平', icon: '⚖', kind: 'primary', onClick: () => this._autoBalance() });
    this.statsPanel.body.appendChild(el('div', { class: 'sp2-builder__hr' }));
    this.statsPanel.body.appendChild(el('div', { class: 'sp2-builder__actions' }, [this._autoBtn.el]));

    this.rightCol = el('div', { class: 'sp2-builder__right' },
      [this.transformPanel.el, this.nudgePanel.el, this.propsPanel.el, this.statsPanel.el]);
    this.el.appendChild(this.rightCol);

    // 底部提示（桌面）
    this.hintEl = el('div', { class: 'sp2-builder__hint' });
    this.el.appendChild(this.hintEl);

    // ---- 触屏专用 ----
    this._buildTouchUi();
  }

  /**
   * 触屏专用 DOM：底部可折叠面板（零件库/属性/统计）、选中提示条、
   * “＋ 添加零件”大按钮、竖屏提示、首次操作提示、长按小菜单容器。
   * 桌面布局下这些都隐藏（CSS 控制），面板 body 会被搬回左右侧栏。
   * @private
   */
  _buildTouchUi() {
    // 底部面板
    this._sheet = el('div', { class: 'sp2-builder__sheet' });
    this._sheetHandle = el('div', { class: 'sp2-builder__sheet-handle', 'aria-label': '拖动展开或收起' },
      [el('span', { class: 'sp2-builder__sheet-grip' })]);
    this._sheetTabs = el('div', { class: 'sp2-builder__sheet-tabs' });
    this._sheetTabEls = {};
    for (const t of [
      { id: 'parts', label: '零件库' },
      { id: 'nudge', label: '微调' },
      { id: 'props', label: '属性' },
      { id: 'stats', label: '统计' },
    ]) {
      const btn = el('button', {
        class: 'sp2-builder__sheet-tab', type: 'button', text: t.label,
        onclick: () => { this._sheetTab = t.id; this._syncSheet(); },
      });
      this._sheetTabEls[t.id] = btn;
      this._sheetTabs.appendChild(btn);
    }
    this._sheetBody = el('div', { class: 'sp2-builder__sheet-body sp-scroll' });
    this._sheetPanes = {
      parts: el('div', { class: 'sp2-builder__pane' }),
      nudge: el('div', { class: 'sp2-builder__pane', hidden: true }),
      props: el('div', { class: 'sp2-builder__pane', hidden: true }),
      stats: el('div', { class: 'sp2-builder__pane', hidden: true }),
    };
    this._sheetBody.appendChild(this._sheetPanes.parts);
    this._sheetBody.appendChild(this._sheetPanes.nudge);
    this._sheetBody.appendChild(this._sheetPanes.props);
    this._sheetBody.appendChild(this._sheetPanes.stats);
    this._sheet.appendChild(this._sheetHandle);
    this._sheet.appendChild(this._sheetTabs);
    this._sheet.appendChild(this._sheetBody);
    this.el.appendChild(this._sheet);

    // “＋ 添加零件”大按钮（面板收起时显示）
    this._addBtn = el('button', {
      class: 'sp2-builder__addbtn', type: 'button',
      text: '＋ 添加零件',
      onclick: () => { this._sheetTab = 'parts'; this._sheetExpanded = true; this._syncSheet(); },
    });
    this.el.appendChild(this._addBtn);

    // 选中提示条
    this._selBar = el('div', { class: 'sp2-builder__selbar' });
    this._selText = el('span', { class: 'sp2-builder__seltext' });
    this._selAxisWrap = el('div', { class: 'sp2-builder__actions' });
    this._selAxisEls = [];
    const axisNames = ['X', 'Y', 'Z'];
    for (let i = 0; i < 3; i++) {
      const btn = el('button', {
        class: 'sp2-builder__mode', type: 'button', text: axisNames[i],
        onclick: () => { this._rotAxis = i; this._syncSelBar(); },
      });
      this._selAxisEls.push(btn);
      this._selAxisWrap.appendChild(btn);
    }
    this._selDelete = new Button({ label: '删除', icon: '🗑', kind: 'danger', onClick: () => this.deleteSelected() });
    this._selDone = new Button({ label: '取消选择', kind: 'ghost', onClick: () => this.clearSelection() });
    this._selBar.appendChild(this._selText);
    this._selBar.appendChild(this._selAxisWrap);
    this._selBar.appendChild(this._selDelete.el);
    this._selBar.appendChild(this._selDone.el);
    this.el.appendChild(this._selBar);

    // 竖屏提示
    this._portraitHint = el('div', {
      class: 'sp2-builder__portrait', hidden: true,
      text: '横屏操作更舒适（竖屏同样可以放置与移动零件）',
    });
    this.el.appendChild(this._portraitHint);

    // 首次操作提示（3 秒后自动消失）
    this._touchHint = el('div', {
      class: 'sp2-builder__touchhint', hidden: true,
      text: '单指点选 · 拖动零件移动 · 双指旋转/缩放视角 · 长按删除',
    });
    this.el.appendChild(this._touchHint);

    this._bindSheetEvents();
    this._syncSheet();
  }

  /** 底部面板：拖动把手 / 滑动展开收起 @private */
  _bindSheetEvents() {
    const handle = this._sheetHandle;
    if (!handle) return;
    let startY = 0, startH = 0, dragging = false, pointerId = -1, moved = 0;
    const h = () => (this._stage?.clientHeight || 600);
    const onDown = (ev) => {
      dragging = true; pointerId = ev.pointerId;
      startY = ev.clientY;
      startH = this._sheetExpanded ? h() * SHEET_EXPANDED_VH / 100 : h() * SHEET_COLLAPSED_VH / 100;
      moved = 0;
      this._sheet.style.transition = 'none';
      try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      ev.preventDefault();
    };
    const onMove = (ev) => {
      if (!dragging || ev.pointerId !== pointerId) return;
      const dy = ev.clientY - startY;
      moved = Math.max(moved, Math.abs(dy));
      const px = clamp(startH - dy, h() * 0.18, h() * 0.92);
      this._sheet.style.height = px + 'px';
    };
    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      this._sheet.style.transition = '';
      this._sheet.style.height = '';
      const dy = ev.clientY - startY;
      if (moved < 8) this._sheetExpanded = !this._sheetExpanded;            // 轻点 = 切换
      else if (dy < -30) this._sheetExpanded = true;                        // 上滑 = 展开
      else if (dy > 30) this._sheetExpanded = false;                        // 下滑 = 收起
      this._syncSheet();
    };
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  /** 同步底部面板状态（高度 / 标签页 / 大按钮 / 选中条） @private */
  _syncSheet() {
    try {
      if (this._sheet) this._sheet.classList.toggle('sp2-builder__sheet--expanded', !!this._sheetExpanded);
      for (const id of Object.keys(this._sheetTabEls || {})) {
        const on = this._sheetTab === id;
        this._sheetTabEls[id].classList.toggle('sp2-builder__sheet-tab--active', on);
        this._sheetTabEls[id].setAttribute('aria-selected', String(on));
        const pane = this._sheetPanes?.[id];
        if (pane) pane.hidden = !on;
      }
      if (this._addBtn) this._addBtn.hidden = this._touchLayout ? !!this._sheetExpanded : true;
    } catch (e) { console.warn('[builder] 同步底部面板失败', e); }
    this._syncSelBar();
  }

  /** 同步“选中零件”提示条 @private */
  _syncSelBar() {
    if (!this._selBar) return;
    try {
      const sel = this.selectedParts();
      this._selBar.hidden = sel.length === 0;
      if (!sel.length) return;
      const d = PART_DEFS[sel[0].def];
      const name = d?.name || sel[0].def;
      const extra = sel.length > 1 ? `（共 ${sel.length} 个）` : '';
      const p = sel[0];
      const hint = this._mode === 'move'
        ? '拖动移动'
        : (this._mode === 'rotate' ? '拖动旋转 · 选择轴' : '视角模式：拖动旋转相机');
      const pos = `X ${fmt(p.pos?.[0], 2)} · Y ${fmt(p.pos?.[1], 2)} · Z ${fmt(p.pos?.[2], 2)}`;
      this._selText.textContent = `选中：${name}${extra} · ${hint} · ${pos}`;
      const showAxes = this._mode === 'rotate';
      this._selAxisWrap.hidden = !showAxes;
      for (let i = 0; i < this._selAxisEls.length; i++) {
        this._selAxisEls[i].classList.toggle('sp2-builder__mode--active', showAxes && this._rotAxis === i);
      }
    } catch (e) { console.warn('[builder] 同步选中条失败', e); }
  }

  /** 同步模式按钮高亮 @private */
  _refreshModeButtons() {
    try {
      for (const [m, btn] of Object.entries(this._modeEls || {})) {
        btn?.classList?.toggle('sp2-builder__mode--active', m === this._mode);
      }
      this._syncSelBar();
    } catch (e) { /* 忽略 */ }
  }

  /** 竖屏提示 @private */
  _updatePortraitHint() {
    if (!this._portraitHint) return;
    try {
      const portrait = typeof window !== 'undefined' && toNum(window.innerHeight, 0) > toNum(window.innerWidth, 0);
      this._portraitHint.hidden = !(this._touchLayout && portrait);
    } catch (e) { /* 忽略 */ }
  }

  /** 首次（触屏）打开时的操作提示浮层 @private */
  _maybeShowTouchHint() {
    try {
      if (!this._touchLayout || !this._touchHint) return;
      if (store.get(LS_TOUCH_HINT, false)) return;
      store.set(LS_TOUCH_HINT, true);
      // 清掉旧计时（注意：不能调用 _cancelTouchHint，它会把浮层隐藏掉）
      if (this._touchHintTimer) { window.clearTimeout(this._touchHintTimer); this._touchHintTimer = 0; }
      this._touchHint.hidden = false;
      this._touchHintTimer = window.setTimeout(() => {
        this._touchHintTimer = 0;
        if (this._touchHint) this._touchHint.hidden = true;
      }, 3000);
    } catch (e) { /* 忽略 */ }
  }

  /** 取消首次提示计时 @private */
  _cancelTouchHint() {
    try {
      if (this._touchHintTimer) window.clearTimeout(this._touchHintTimer);
    } catch (e) { /* 忽略 */ }
    this._touchHintTimer = 0;
    if (this._touchHint) this._touchHint.hidden = true;
  }

  /**
   * 应用布局：触屏布局把面板 body 搬进底部面板，桌面布局搬回侧栏。
   * @private
   */
  _applyLayout() {
    const touch = this._layoutForced === null ? isTouchDevice() : !!this._layoutForced;
    this._touchLayout = touch;
    try {
      this.el.classList.toggle('sp2-builder--touch', touch);
      const moves = [
        [this.palettePanel, this._sheetPanes?.parts],
        [this.nudgePanel, this._sheetPanes?.nudge],
        [this.propsPanel, this._sheetPanes?.props],
        [this.statsPanel, this._sheetPanes?.stats],
      ];
      for (const [panel, pane] of moves) {
        if (!panel || !panel.body) continue;
        if (touch) {
          if (pane && panel.body.parentNode !== pane) pane.appendChild(panel.body);
        } else if (panel.body.parentNode !== panel.el) {
          panel.el.appendChild(panel.body);
        }
      }
      // 桌面：微调面板默认收起，由工具栏扳手按钮切换
      if (!touch) this.nudgePanel?.el?.classList.toggle('sp-hidden', !this._nudgeVisible);
    } catch (e) { console.warn('[builder] 应用布局失败', e); }
    this._syncSheet();
    this._updatePortraitHint();
    this._refreshHint();
    this._dirty = true;
  }

  /** 新建 canvas 元素 @private */
  _newCanvas() {
    return el('canvas', { class: 'sp2-builder__canvas', 'aria-hidden': 'true' });
  }

  /** close 后换一块干净 canvas（旧 WebGL 上下文已强制丢失） @private */
  _replaceCanvas() {
    try {
      const fresh = this._newCanvas();
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.replaceChild(fresh, this.canvas);
      else this._canvasHolder.appendChild(fresh);
      this.canvas = fresh;
    } catch (e) { console.warn('[builder] 替换 canvas 失败', e); }
  }

  /** 顶部工具栏 @private */
  _buildToolbar() {
    const add = (n) => this.toolbar.appendChild(n);
    this._toolbarBtns = [];
    const mk = (opts) => {
      const b = new Button(opts);
      this._toolbarBtns.push(b);
      return b.el;
    };

    this.nameInput = el('input', {
      class: 'sp2-builder__name sp2-builder__touchhide', type: 'text',
      placeholder: '机型名称', title: '机型名称', maxLength: 40,
      oninput: (ev) => { this._craft.name = String(ev.target.value || '').slice(0, 40); },
    });
    add(this.nameInput);

    // 触屏：模式切换（一眼可见当前模式）
    this._modeEls = {};
    const modeWrap = el('div', { class: 'sp2-builder__modes' });
    for (const [m, label] of [['move', '移动'], ['rotate', '旋转'], ['view', '视角']]) {
      const btn = el('button', {
        class: 'sp2-builder__mode', type: 'button', text: label,
        onclick: () => this.setMode(m),
      });
      this._modeEls[m] = btn;
      modeWrap.appendChild(btn);
    }
    add(modeWrap);

    add(mk({ label: '返回', icon: '↩', kind: 'ghost', title: '返回', onClick: () => this._exit() }));
    add(mk({ label: '新建', icon: '📄', kind: 'ghost', title: '新建空机型', onClick: () => this._newCraft() }));
    add(mk({ label: '载入', icon: '📂', kind: 'ghost', title: '载入库存 / 自建机型', onClick: () => this._openLoadModal() }));
    add(mk({ label: '保存', icon: '💾', kind: 'primary', title: '保存机型 (Ctrl+S)', onClick: () => this._save() }));
    // 扳手：数值微调面板（手机端精调的主要入口）
    add(mk({
      label: '微调', icon: '🔧', kind: 'ghost', className: 'sp2-builder__btn-labeled',
      title: '数值微调面板（N）', onClick: () => this.toggleNudgePanel(),
    }));
    add(mk({
      label: '复制', icon: '⧉', kind: 'ghost', className: 'sp2-builder__touchhide',
      title: '复制选中零件；未选中则复制整机 (Ctrl+D)', onClick: () => this._duplicate(),
    }));

    this.undoBtn = new Button({ label: '撤销', icon: '↶', kind: 'ghost', title: '撤销 (Ctrl+Z)', onClick: () => this.undo() });
    this.redoBtn = new Button({ label: '重做', icon: '↷', kind: 'ghost', title: '重做 (Ctrl+Shift+Z / Ctrl+Y)', onClick: () => this.redo() });
    add(this.undoBtn.el);
    add(this.redoBtn.el);

    add(el('div', { class: 'sp2-builder__spacer' }));
    add(mk({ label: '导出 JSON', icon: '⬆', kind: 'ghost', className: 'sp2-builder__touchhide', title: '导出当前机型 JSON', onClick: () => this._exportJSON() }));
    add(mk({ label: '导入 JSON', icon: '⬇', kind: 'ghost', className: 'sp2-builder__touchhide', title: '从 JSON 导入机型', onClick: () => this._importJSON() }));
    add(mk({ label: '试飞', icon: '🛫', kind: 'primary', className: 'sp2-builder__btn-labeled', title: '用当前机型试飞', onClick: () => this._fly() }));

    // 触屏：最右侧“零件”按钮（展开底部面板）
    this._moreBtn = el('button', {
      class: 'sp-btn sp-btn--ghost sp2-builder__btn-labeled sp2-builder__touchonly', type: 'button', title: '零件库',
      onclick: () => { this._sheetTab = 'parts'; this._sheetExpanded = true; this._syncSheet(); },
    }, [el('span', { class: 'sp-btn__icon', text: '🧰' }), el('span', { class: 'sp-btn__label', text: '零件' })]);
    add(this._moreBtn);

    this._refreshModeButtons();
  }

  /** 左侧零件库内容（桌面列表 + 触屏 chip/网格共用同一份数据） @private */
  _buildPalette() {
    const wrap = el('div', { class: 'sp2-builder__palette-inner' });

    // 桌面：分类标签页
    this.tabs = new Tabs({
      tabs: CATEGORIES.map((c) => ({ id: c.id, label: `${c.icon}${c.name}` })),
      onChange: (id) => { this._cat = id; this._refreshPalette(); },
    });
    wrap.appendChild(this.tabs.el);

    // 触屏：横向滚动 chip
    this._chips = el('div', { class: 'sp2-builder__chips sp-scroll' });
    this._chipEls = [];
    for (const c of CATEGORIES) {
      const chip = el('button', {
        class: 'sp2-builder__chip', type: 'button', text: `${c.icon} ${c.name}`,
        onclick: () => { this._cat = c.id; this._refreshPalette(); },
      });
      this._chipEls.push({ id: c.id, el: chip });
      this._chips.appendChild(chip);
    }
    wrap.appendChild(this._chips);

    this.searchInput = el('input', {
      class: 'sp2-builder__search', type: 'search', placeholder: '搜索零件…', spellcheck: 'false',
      oninput: (ev) => {
        this._query = String(ev.target.value || '').trim().toLowerCase();
        this._refreshPalette();
      },
    });
    wrap.appendChild(this.searchInput);

    // 桌面：列表
    this.list = new ListBox({ items: [], onChange: (id) => this._setInHand(id) });
    wrap.appendChild(this.list.el);

    // 触屏：两列大图标网格
    this._grid = el('div', { class: 'sp2-builder__grid' });
    wrap.appendChild(this._grid);

    this._refreshPalette();
    return wrap;
  }

  /** 按分类 + 搜索词刷新零件列表（同时刷新桌面列表与触屏网格） @private */
  _refreshPalette() {
    const q = this._query || '';
    const items = [];
    try {
      for (const id of Object.keys(PART_DEFS)) {
        const d = PART_DEFS[id];
        if (!d) continue;
        if (!q && this._cat && d.cat !== this._cat) continue;   // 搜索时跨分类
        if (q && !(id.toLowerCase().includes(q) || String(d.name || '').toLowerCase().includes(q))) continue;
        const s = Array.isArray(d.size) ? d.size : [1, 1, 1];
        items.push({
          id,
          label: d.name || id,
          sub: `${fmt(s[0], 1)}×${fmt(s[1], 1)}×${fmt(s[2], 1)} m · ${formatMass(toNum(d.mass, 0))} · ${formatMoney(toNum(d.cost, 0))}`,
          icon: catIcon(d.cat),
        });
      }
    } catch (e) { console.warn('[builder] 零件列表失败', e); }

    try { this.list?.setItems(items); } catch (e) { console.warn('[builder] 列表刷新失败', e); }

    // chip 高亮
    try {
      for (const c of (this._chipEls || [])) c.el.classList.toggle('sp2-builder__chip--active', !q && c.id === this._cat);
    } catch (e) { /* 忽略 */ }

    // 触屏网格
    try {
      if (this._grid) {
        this._grid.textContent = '';
        for (const it of items) {
          const card = el('button', {
            class: 'sp2-builder__card', type: 'button', 'data-def': it.id,
            onclick: () => {
              this._setInHand(it.id);
              // 拿起零件后收起面板，方便在 3D 视图里点按放置
              this._sheetExpanded = false;
              this._syncSheet();
            },
          }, [
            el('span', { class: 'sp2-builder__card-icon', text: it.icon, 'aria-hidden': 'true' }),
            el('span', { class: 'sp2-builder__card-texts' }, [
              el('span', { class: 'sp2-builder__card-name', text: it.label }),
              el('span', { class: 'sp2-builder__card-sub', text: it.sub }),
            ]),
          ]);
          this._grid.appendChild(card);
        }
      }
    } catch (e) { console.warn('[builder] 网格刷新失败', e); }
  }

  /** 刷新右侧各面板（选择变化时调用） @private */
  _refreshPanels() {
    this._refreshTransformPanel();
    this._refreshNudgePanel();
    this._refreshPropsPanel();
    this._syncTransform();
    this._refreshStats();
    this._syncSelBar();
    try { this.nameInput.value = this._craft.name || ''; } catch (e) { /* 忽略 */ }
  }

  /* ================================================================ 变换面板 */

  /** 重建变换面板 @private */
  _refreshTransformPanel() {
    const body = this._tfBody;
    if (!body) return;
    clear(body);
    this._tf = { sizeSliders: [], posVal: null, rotVal: null, info: null, color: null };

    const parts = this.selectedParts();
    if (!parts.length) {
      body.appendChild(el('div', { class: 'sp2-builder__empty', text: '未选中零件。在预览中单击零件即可选中（Shift 加选）。' }));
      body.appendChild(this._buildModeRow());
      body.appendChild(this._buildStepRow());
      return;
    }

    const p = parts[0];
    const d = PART_DEFS[p.def];

    // 概览
    this._tf.info = el('div', { class: 'sp2-builder__sub' });
    body.appendChild(this._tf.info);

    // 位置读数 + 微调
    body.appendChild(el('div', { class: 'sp2-builder__caption', text: '位置（米）' }));
    this._tf.posVal = el('div', { class: 'sp2-builder__readout' });
    body.appendChild(this._tf.posVal);
    const nudge = (label, dx, dy, dz) => new Button({
      label, kind: 'ghost', className: 'sp2-builder__nudge',
      onClick: () => this._nudgeSelection(dx, dy, dz),
    }).el;
    body.appendChild(el('div', { class: 'sp2-builder__nudgerow' }, [
      el('span', { class: 'sp2-builder__axislabel', text: 'X 左右' }),
      nudge('−', -this._step, 0, 0), nudge('+', this._step, 0, 0),
    ]));
    body.appendChild(el('div', { class: 'sp2-builder__nudgerow' }, [
      el('span', { class: 'sp2-builder__axislabel', text: 'Y 上下' }),
      nudge('−', 0, -this._step, 0), nudge('+', 0, this._step, 0),
    ]));
    body.appendChild(el('div', { class: 'sp2-builder__nudgerow' }, [
      el('span', { class: 'sp2-builder__axislabel', text: 'Z 前后' }),
      nudge('−', 0, 0, -this._step), nudge('+', 0, 0, this._step),
    ]));

    // 旋转
    body.appendChild(el('div', { class: 'sp2-builder__hr' }));
    body.appendChild(el('div', { class: 'sp2-builder__caption', text: `旋转（${ROT_SNAP}° 步进）` }));
    this._tf.rotVal = el('div', { class: 'sp2-builder__readout' });
    body.appendChild(this._tf.rotVal);
    const axisName = ['X 俯仰', 'Y 偏航', 'Z 滚转'];
    for (let i = 0; i < 3; i++) {
      body.appendChild(el('div', { class: 'sp2-builder__nudgerow' }, [
        el('span', { class: 'sp2-builder__axislabel', text: axisName[i] }),
        new Button({ label: `−${ROT_SNAP}°`, kind: 'ghost', onClick: () => this._rotateSelection(i, -ROT_SNAP) }).el,
        new Button({ label: `+${ROT_SNAP}°`, kind: 'ghost', onClick: () => this._rotateSelection(i, ROT_SNAP) }).el,
      ]));
    }
    body.appendChild(el('div', { class: 'sp2-builder__nudgerow' }, [
      el('span', { class: 'sp2-builder__axislabel', text: '' }),
      new Button({ label: '旋转归零', kind: 'ghost', onClick: () => this._resetRotation() }).el,
    ]));

    // 尺寸缩放
    body.appendChild(el('div', { class: 'sp2-builder__hr' }));
    body.appendChild(el('div', { class: 'sp2-builder__caption', text: '尺寸缩放（相对基准）' }));
    const base = Array.isArray(d?.size) ? d.size : (Array.isArray(p.size) ? p.size : [1, 1, 1]);
    const sizeLabels = ['宽 X', '高 Y', '长 Z'];
    for (let i = 0; i < 3; i++) {
      const ratio = clamp(toNum(p.size[i], base[i]) / Math.max(1e-3, base[i]), 0.2, 3);
      const s = new Slider({
        label: `${sizeLabels[i]}（${fmt(toNum(p.size[i], base[i]), 2)} m）`,
        min: 0.2, max: 3, step: 0.05, value: ratio,
        format: (v) => `${fmt(v * base[i], 2)} m`,
        onInput: (v) => this._scaleSelection(i, v, base[i]),
      });
      this._tf.sizeSliders.push(s);
      body.appendChild(s.el);
    }

    // 操作按钮
    body.appendChild(el('div', { class: 'sp2-builder__hr' }));
    body.appendChild(el('div', { class: 'sp2-builder__actions' }, [
      new Button({ label: '复制', icon: '⧉', kind: 'ghost', onClick: () => this._duplicate() }).el,
      new Button({ label: '落地', icon: '⬇', kind: 'ghost', title: '把选中零件放到网格地面上', onClick: () => this._dropSelection() }).el,
      new Button({ label: '删除', icon: '🗑', kind: 'danger', title: '删除选中零件 (Delete)', onClick: () => this.deleteSelected() }).el,
    ]));

    body.appendChild(this._buildModeRow());
    body.appendChild(this._buildStepRow());
  }

  /** 移动/旋转/视角模式 + 对称选择 @private */
  _buildModeRow() {
    const wrap = el('div', { class: 'sp2-builder__col' });
    wrap.appendChild(el('div', { class: 'sp2-builder__caption', text: '交互模式（触屏有独立大按钮）' }));
    wrap.appendChild(el('div', { class: 'sp2-builder__actions' }, [
      new Button({
        label: '移动 (G)', kind: this._mode === 'move' ? 'primary' : 'ghost',
        onClick: () => this.setMode('move'),
      }).el,
      new Button({
        label: '旋转 (R)', kind: this._mode === 'rotate' ? 'primary' : 'ghost',
        onClick: () => this.setMode('rotate'),
      }).el,
      new Button({
        label: '视角 (V)', kind: this._mode === 'view' ? 'primary' : 'ghost',
        title: '只旋转相机，不移动零件',
        onClick: () => this.setMode('view'),
      }).el,
    ]));
    return wrap;
  }

  /** 步长 + 对称 @private */
  _buildStepRow() {
    const wrap = el('div', { class: 'sp2-builder__col' });
    this._stepSelect = new Select({
      label: '移动步长（米）',
      options: STEP_OPTIONS.map((v) => ({ value: String(v), label: `${v} m` })),
      value: String(this._step),
      onChange: (v) => {
        const n = toNum(parseFloat(v), 0.25);
        this._step = n > 0 ? n : 0.25;
        store.set(LS_STEP, this._step);
        this._refreshTransformPanel();
        this._syncTransform();
        this._refreshHint();
      },
    });
    wrap.appendChild(this._stepSelect.el);

    this._symSelect = new Select({
      label: '镜像对称',
      options: [
        { value: 'none', label: '关闭' },
        { value: 'x', label: '左右镜像（X）' },
        { value: 'xy', label: '左右 + 上下（XY）' },
      ],
      value: this._symmetry,
      onChange: (v) => {
        this._symmetry = (v === 'x' || v === 'xy') ? v : 'none';
        store.set(LS_SYM, this._symmetry);
        this._refreshHint();
        Toast.push(
          this._symmetry === 'none' ? '镜像对称：关闭' : (this._symmetry === 'x' ? '镜像对称：左右（X）' : '镜像对称：左右 + 上下（XY）'),
          { kind: 'info', duration: 1400 },
        );
      },
    });
    wrap.appendChild(this._symSelect.el);
    return wrap;
  }

  /* ================================================================ 微调（扳手）面板
   * 移动端手指拖动精度不足（原版 SimplePlanes 也是这个思路），
   * 因此提供一个纯数值的精调面板：−/＋ 按钮 + 实时数值。
   * 长按 −/＋ 会以 400ms/80ms 连续微调，整段按压只入栈一条撤销。
   * ============================================================== */

  /** 重建微调面板 @private */
  _refreshNudgePanel() {
    const body = this._nudgeBody;
    if (!body) return;
    clear(body);
    this._nudge = { pos: [], rot: [], size: [], posStep: null, rotStep: null };

    const info = el('div', { class: 'sp2-builder__sub' });
    body.appendChild(info);
    const parts = this.selectedParts();

    // 步长（顶部下拉）
    const stepWrap = el('div', { class: 'sp2-builder__col' });
    const posSteps = [...new Set([...NUDGE_STEPS, this._step])].sort((a, b) => a - b);
    this._nudge.posStep = new Select({
      label: '位置步长（米）',
      options: posSteps.map((v) => ({ value: String(v), label: `${v} m` })),
      value: String(this._step),
      onChange: (v) => {
        const n = toNum(parseFloat(v), 0.25);
        this._step = n > 0 ? n : 0.25;
        try { store.set(LS_STEP, this._step); } catch (e) { /* 忽略 */ }
        this._syncTransform();
        this._refreshHint();
      },
    });
    stepWrap.appendChild(this._nudge.posStep.el);
    this._nudge.rotStep = new Select({
      label: '旋转步长（度）',
      options: ROT_STEPS.map((v) => ({ value: String(v), label: `${v}°` })),
      value: String(this._rotStep),
      onChange: (v) => {
        const n = toNum(parseFloat(v), 15);
        this._rotStep = ROT_STEPS.includes(n) ? n : 15;
        try { store.set(LS_ROT_STEP, this._rotStep); } catch (e) { /* 忽略 */ }
      },
    });
    stepWrap.appendChild(this._nudge.rotStep.el);
    body.appendChild(stepWrap);

    if (!parts.length) {
      info.textContent = '未选中零件：先点选一个零件，然后用下面的 −/＋ 精确调整。';
      return;
    }

    const p = parts[0];
    const d = PART_DEFS[p.def];
    info.textContent = `${d?.name || p.def}（${parts.length} 个选中）· 长按 −/＋ 可连续微调`;

    // 位置 / 旋转 / 尺寸
    const rows = (title, labels, kind, fmtFn) => {
      body.appendChild(el('div', { class: 'sp2-builder__caption', text: title }));
      const group = el('div', { class: 'sp2-builder__ngroup' });
      for (let i = 0; i < 3; i++) {
        const val = el('span', { class: 'sp2-builder__nval', text: fmtFn(i) });
        const minus = this._makeNudgeBtn('−', `减少${labels[i]}`, () => this._nudgeBy(kind, i, -1));
        const plus = this._makeNudgeBtn('＋', `增加${labels[i]}`, () => this._nudgeBy(kind, i, 1));
        group.appendChild(el('div', { class: 'sp2-builder__nrow' }, [
          el('span', { class: 'sp2-builder__nlabel', text: labels[i] }), minus, val, plus,
        ]));
        this._nudge[kind].push(val);
      }
      body.appendChild(group);
    };
    rows('位置（米）', ['X 左右', 'Y 上下', 'Z 前后'], 'pos', (i) => `${fmt(p.pos?.[i], 2)} m`);
    rows(`旋转（${this._rotStep}° 步进）`, ['X 俯仰', 'Y 偏航', 'Z 滚转'], 'rot', (i) => `${fmt(p.rot?.[i], 1)}°`);
    rows('尺寸（米）', ['宽 W', '高 H', '长 L'], 'size', (i) => `${fmt(p.size?.[i], 2)} m`);

    // 操作行
    body.appendChild(el('div', { class: 'sp2-builder__hr' }));
    body.appendChild(el('div', { class: 'sp2-builder__actions' }, [
      new Button({ label: '镜像到另一侧', icon: '⇋', kind: 'ghost', onClick: () => this._mirrorSelected() }).el,
      new Button({ label: '复制', icon: '⧉', kind: 'ghost', onClick: () => this._duplicate() }).el,
      new Button({ label: '删除', icon: '🗑', kind: 'danger', onClick: () => this.deleteSelected() }).el,
    ]));
    body.appendChild(el('div', {
      class: 'sp2-builder__sub',
      text: '提示：拖动零件做粗定位，这里做精确对齐；每次连续按压只记一条撤销。',
    }));
  }

  /** 更新微调面板的实时读数（不重建 DOM） @private */
  _syncNudgePanel() {
    const n = this._nudge;
    if (!n) return;
    const parts = this.selectedParts();
    if (!parts.length) return;
    const p = parts[0];
    try {
      for (let i = 0; i < 3; i++) {
        if (n.pos[i]) n.pos[i].textContent = `${fmt(p.pos?.[i], 2)} m`;
        if (n.rot[i]) n.rot[i].textContent = `${fmt(p.rot?.[i], 1)}°`;
        if (n.size[i]) n.size[i].textContent = `${fmt(p.size?.[i], 2)} m`;
      }
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 创建带长按连点的 −/＋ 按钮（400ms 后每 80ms 重复，整段只入栈一条撤销）。
   * @private
   */
  _makeNudgeBtn(label, title, action) {
    const btn = el('button', {
      class: 'sp2-builder__nbtn', type: 'button', text: label, title: `${title}（可长按连续微调）`,
      'aria-label': title,
    });
    this._bindRepeat(btn, action);
    return btn;
  }

  /** 长按连点绑定 @private */
  _bindRepeat(btn, action) {
    let delayTimer = 0;
    let repeatTimer = 0;
    const stop = () => {
      if (delayTimer) { try { clearTimeout(delayTimer); } catch (e) { /* 忽略 */ } delayTimer = 0; }
      if (repeatTimer) { try { clearInterval(repeatTimer); } catch (e) { /* 忽略 */ } repeatTimer = 0; }
      try {
        if (typeof window !== 'undefined') {
          window.removeEventListener('pointerup', stop, true);
          window.removeEventListener('pointercancel', stop, true);
        }
      } catch (e) { /* 忽略 */ }
    };
    const start = (ev) => {
      if (ev && typeof ev.button === 'number' && ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (delayTimer || repeatTimer) return;
      this._cancelLongPress();
      try { action(); } catch (e) { console.warn('[builder] 微调失败', e); }
      delayTimer = setTimeout(() => {
        delayTimer = 0;
        repeatTimer = setInterval(() => {
          try { action(); } catch (e) { /* 忽略 */ }
        }, REPEAT_EVERY);
      }, REPEAT_DELAY);
      try {
        if (typeof window !== 'undefined') {
          window.addEventListener('pointerup', stop, true);
          window.addEventListener('pointercancel', stop, true);
        }
      } catch (e) { /* 忽略 */ }
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        try { action(); } catch (e) { /* 忽略 */ }
      }
    });
  }

  /** 微调一步：kind = pos | rot | size @private */
  _nudgeBy(kind, axis, sign) {
    const sel = this.selectedParts();
    if (!sel.length) {
      Toast.push('先选中零件再微调', { kind: 'info', duration: 1400 });
      return;
    }
    // 同一段按压（同名 key，700ms 内）只入栈一条撤销
    this._touchSession('_nudgeSession', `${kind}:${axis}:${sign > 0 ? '+' : '-'}`);
    try {
      if (kind === 'pos') {
        const d = [0, 0, 0];
        d[axis] = this._step * sign;
        if (this._applyNudge(d)) { this._reanchorPreview(); this._afterEdit(); }
      } else if (kind === 'rot') {
        if (this._applyRotate(axis, this._rotStep * sign)) this._afterEdit();
      } else {
        for (const p of sel) {
          const d = PART_DEFS[p.def];
          const base = (Array.isArray(d?.size) ? d.size[axis] : p.size[axis]) || 1;
          const delta = Math.max(0.02, base * 0.05);
          p.size[axis] = Math.max(0.02, r3(toNum(p.size[axis], base) + delta * sign));
        }
        this._rebuildPreview();
        this._afterEdit();
      }
    } catch (e) {
      console.warn('[builder] 微调失败', e);
    }
    this._syncNudgePanel();
  }

  /** 展开/收起微调面板（触屏：切到“微调”标签页） @returns {void} */
  toggleNudgePanel(on) {
    const next = on === undefined ? !this.nudgePanelVisible : !!on;
    if (this._touchLayout) {
      if (next && !this.selectedParts().length) {
        Toast.push('先选中零件，再用微调面板精确调整', { kind: 'warn' });
        return;
      }
      this._sheetTab = next ? 'nudge' : 'parts';
      if (next) this._sheetExpanded = true;
      this._syncSheet();
    } else {
      this._nudgeVisible = next;
      try { store.set(LS_NUDGE_OPEN, next); } catch (e) { /* 忽略 */ }
      this.nudgePanel?.el?.classList.toggle('sp-hidden', !next);
      if (next) this._refreshNudgePanel();
    }
    this._dirty = true;
  }

  /** 微调面板是否可见 @returns {boolean} */
  get nudgePanelVisible() {
    if (this._touchLayout) return this._sheetTab === 'nudge';
    return !!this._nudgeVisible;
  }

  /** 同步变换面板里的读数与滑块（不重建 DOM，避免打断拖动） @private */
  _syncTransform() {
    const t = this._tf;
    if (!t) return;
    const parts = this.selectedParts();
    if (!parts.length || !t.posVal) return;
    const p = parts[0];
    const d = PART_DEFS[p.def];
    try {
      t.posVal.textContent = `X ${fmt(p.pos[0], 2)}   Y ${fmt(p.pos[1], 2)}   Z ${fmt(p.pos[2], 2)}`;
      if (t.rotVal) t.rotVal.textContent = `X ${fmt(p.rot[0], 0)}°   Y ${fmt(p.rot[1], 0)}°   Z ${fmt(p.rot[2], 0)}°`;
      if (t.info) {
        t.info.textContent = `${d?.name || p.def} · ${formatMass(partMass(p))} · ${formatMoney(partCost(p))}`
          + ` · 共选中 ${parts.length} 个`;
      }
      const base = Array.isArray(d?.size) ? d.size : p.size;
      for (let i = 0; i < t.sizeSliders.length; i++) {
        t.sizeSliders[i]?.set(clamp(toNum(p.size[i], base[i]) / Math.max(1e-3, base[i]), 0.2, 3));
      }
    } catch (e) { console.warn('[builder] 同步变换面板失败', e); }
    this._syncNudgePanel();
  }

  /* ================================================================ 属性面板 */

  /** 重建属性面板（零件参数 + 颜色） @private */
  _refreshPropsPanel() {
    const body = this.propsBody;
    if (!body) return;
    clear(body);
    const parts = this.selectedParts();
    const wrap = el('div', { class: 'sp2-builder__col' });

    if (parts.length) {
      const p = parts[0];
      const d = PART_DEFS[p.def];
      wrap.appendChild(el('div', {
        class: 'sp2-builder__sub',
        text: `${d?.name || p.def}（${parts.length} 个选中）`,
      }));

      const specs = Array.isArray(d?.props) ? d.props : [];
      if (specs.length) {
        for (const spec of specs) {
          if (!spec || !spec.key) continue;
          const cur = Number.isFinite(p.props?.[spec.key]) ? p.props[spec.key] : spec.default;
          const s = new Slider({
            label: spec.label || spec.key,
            min: toNum(spec.min, 0),
            max: toNum(spec.max, 1),
            step: toNum(spec.step, 0),
            value: toNum(cur, toNum(spec.default, 0)),
            onInput: (v) => this._setPropForSelection(p.def, spec.key, v),
          });
          wrap.appendChild(s.el);
        }
      } else {
        wrap.appendChild(el('div', { class: 'sp2-builder__empty', text: '该零件没有可调参数。' }));
      }

      wrap.appendChild(el('div', { class: 'sp2-builder__hr' }));
      wrap.appendChild(this._buildColorRow(p.color, '选中零件颜色', (c) => this._paintSelection(c)));
    } else {
      wrap.appendChild(el('div', {
        class: 'sp2-builder__sub',
        text: '未选中零件：下面的颜色会应用到整机所有零件；选中零件后可编辑其参数。',
      }));
      const anyPart = this._craft.parts[0];
      wrap.appendChild(el('div', { class: 'sp2-builder__hr' }));
      wrap.appendChild(this._buildColorRow(anyPart?.color || '#c9d3dd', '整机颜色（全部零件）', (c) => this._paintAll(c)));
    }

    body.appendChild(wrap);
  }

  /** 颜色行 @private */
  _buildColorRow(value, label, onPick) {
    const input = el('input', {
      class: 'sp2-builder__color', type: 'color',
      value: this._safeColor(value), title: label,
      oninput: (ev) => onPick(String(ev.target.value || '')),
    });
    return el('div', { class: 'sp2-builder__col' }, [
      el('div', { class: 'sp2-builder__caption', text: label }),
      el('div', { class: 'sp2-builder__colorrow' }, [input, el('span', { class: 'sp2-builder__sub', text: '点击色块选择颜色' })]),
    ]);
  }

  /** 合法化颜色（非法返回 null） @private */
  _validColor(c) {
    const s = String(c || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^[0-9a-f]{6}$/i.test(s)) return ('#' + s).toLowerCase();
    return null;
  }

  /** 合法化颜色（非法时回退到默认色） @private */
  _safeColor(c) {
    return this._validColor(c) || '#c9d3dd';
  }

  /* ================================================================ 统计面板 */

  /** 刷新性能统计 + 平衡警告 @private */
  _refreshStats() {
    const box = this._statsBody;
    if (!box) return;
    clear(box);

    let s = null;
    try { s = computeCraftStats(this._craft); } catch (e) { console.warn('[builder] computeCraftStats 失败', e); s = null; }
    if (!s) {
      box.appendChild(el('div', { class: 'sp2-builder__warn sp2-builder__warn--error', text: '统计计算失败（零件数据可能异常）。' }));
      return;
    }

    const size = s.size || { x: 0, y: 0, z: 0 };
    const com = s.com || { x: 0, y: 0, z: 0 };
    const rows = [
      ['零件数', String(toNum(s.partCount, 0))],
      ['总质量', formatMass(toNum(s.mass, 0))],
      ['总价', formatMoney(toNum(s.cost, 0))],
      ['总推力', `${fmt(toNum(s.thrust, 0) / 1000, 1)} kN`],
      ['机翼面积', `${fmt(toNum(s.wingArea, 0), 1)} m²`],
      ['翼载', Number.isFinite(s.wingLoading) ? `${fmt(s.wingLoading, 1)} kg/m²` : '--'],
      ['燃油', `${fmt(toNum(s.fuel, 0), 0)} L`],
      ['耐久', fmt(toNum(s.hp, 0), 0)],
      ['武器', `机炮 ${toNum(s.guns, 0)} · 导弹 ${toNum(s.missiles, 0)}`],
      ['尺寸', `${fmt(toNum(size.x, 0), 1)} × ${fmt(toNum(size.y, 0), 1)} × ${fmt(toNum(size.z, 0), 1)} m`],
      ['重心', `X ${fmt(toNum(com.x, 0), 2)} · Y ${fmt(toNum(com.y, 0), 2)} · Z ${fmt(toNum(com.z, 0), 2)}`],
    ];
    for (const [k, v] of rows) {
      box.appendChild(el('div', { class: 'sp2-builder__statrow' }, [
        el('span', { text: k }), el('span', { text: v }),
      ]));
    }

    box.appendChild(el('div', { class: 'sp2-builder__hr' }));
    box.appendChild(el('div', { class: 'sp2-builder__caption', text: '平衡性检查' }));
    let warns = [];
    try { warns = this._balanceWarnings(s); } catch (e) { console.warn('[builder] 平衡检查失败', e); }
    for (const w of warns) {
      box.appendChild(el('div', {
        class: `sp2-builder__warn sp2-builder__warn--${w.kind === 'error' ? 'error' : w.kind === 'warn' ? 'warn' : 'ok'}`,
        text: w.text,
      }));
    }
  }

  /**
   * 依据统计结果给出中文平衡建议。
   * @param {object} s computeCraftStats 结果
   * @returns {Array<{kind:'error'|'warn'|'ok', text:string}>}
   * @private
   */
  _balanceWarnings(s) {
    const out = [];
    const parts = this._craft.parts || [];
    if (!parts.length) {
      out.push({ kind: 'ok', text: '空机型：从左侧零件库点选零件，再在网格上单击放置。' });
      return out;
    }

    const mass = Math.max(1, toNum(s.mass, 1));
    const comZ = toNum(s.com?.z, 0);
    const wings = parts.filter((p) => PART_DEFS[p.def]?.mainWing);

    // 1) 纵向静稳定：主翼气动中心应在重心之后
    if (!wings.length) {
      out.push({ kind: 'error', text: '缺少主翼，无法产生升力。' });
    } else {
      const wingZ = wings.reduce((a, w) => a + toNum(w.pos?.[2], 0), 0) / wings.length;
      const margin = wingZ - comZ;
      if (margin < 0.05) {
        out.push({ kind: 'error', text: `重心过于靠后（静稳定余量 ${fmt(margin, 2)} m），飞机将不稳定。` });
      } else if (margin < 0.15) {
        out.push({ kind: 'warn', text: `静稳定余量偏小（${fmt(margin, 2)} m），建议点“自动配平”。` });
      } else if (margin > 1.2) {
        out.push({ kind: 'warn', text: `重心过于靠前（余量 ${fmt(margin, 2)} m），抬轮困难、机动性差。` });
      }
    }

    // 2) 翼载 / 失速速度
    const wingArea = toNum(s.wingArea, 0);
    if (wingArea > 0.01) {
      const stall = Math.sqrt((2 * mass * 9.81) / (1.225 * wingArea * 1.4));
      if (stall > 60) out.push({ kind: 'error', text: `翼载过高，失速速度 ${fmt(stall, 0)} m/s，几乎无法起飞。` });
      else if (stall > 42) out.push({ kind: 'warn', text: `翼载偏高，失速速度 ${fmt(stall, 0)} m/s，注意进场速度。` });
    }

    // 3) 推重比
    const thrust = toNum(s.thrust, 0);
    const twr = thrust / (mass * 9.81);
    if (thrust <= 0) {
      out.push({ kind: 'error', text: '没有发动机，无法自主起飞。' });
    } else if (twr < 0.16) {
      out.push({ kind: 'error', text: `推重比不足（${fmt(twr, 2)}），可能无法起飞。` });
    } else if (twr < 0.28) {
      out.push({ kind: 'warn', text: `推重比偏低（${fmt(twr, 2)}），起飞距离较长。` });
    }

    // 4) 燃料 / 起落架 / 座舱
    const hasEngine = parts.some((p) => PART_DEFS[p.def]?.engine);
    if (hasEngine && toNum(s.fuel, 0) <= 0) {
      out.push({ kind: 'warn', text: '有发动机但没有油箱，只能滑翔。' });
    }
    const hasGear = parts.some((p) => PART_DEFS[p.def]?.gear);
    if (!hasGear) out.push({ kind: 'warn', text: '没有起落架 / 浮筒，只能机腹迫降。' });
    const hasPilot = parts.some((p) => PART_DEFS[p.def]?.pilot || String(p.def).startsWith('cockpit'));
    if (!hasPilot) out.push({ kind: 'warn', text: '没有座舱或飞行员座位。' });

    // 5) 结构 / 性能
    const len = toNum(s.size?.z, 0);
    if (len > 40) out.push({ kind: 'warn', text: `机身过长（${fmt(len, 1)} m），结构可能脆弱。` });
    if (toNum(s.partCount, 0) > 220) out.push({ kind: 'warn', text: `零件过多（${toNum(s.partCount, 0)} 个），可能影响性能。` });

    if (!out.length) out.push({ kind: 'ok', text: '配置良好，可以试飞。' });
    return out;
  }

  /** 自动配平 @private */
  _autoBalance() {
    const parts = this._craft.parts;
    if (!parts || !parts.length) { Toast.push('空机型无需配平', { kind: 'info' }); return; }
    this._pushHistory();
    try {
      autoBalance(parts);
      this._refreshHistoryButtons();
      this._rebuildPreview();
      this._refreshPanels();
      this._dirty = true;
      Toast.push('已自动配平：主翼与主起落架已相对重心调整。', { kind: 'success' });
    } catch (e) {
      console.warn('[builder] 自动配平失败', e);
      Toast.push('自动配平失败', { kind: 'error' });
    }
  }

  /* ================================================================ 底部提示 */

  /** 更新底部操作提示 @private */
  _refreshHint() {
    if (!this.hintEl) return;
    const symText = this._symmetry === 'none' ? '对称关' : (this._symmetry === 'x' ? '对称 X' : '对称 XY');
    const hand = this._ghostDef ? ` · 手上：${PART_DEFS[this._ghostDef]?.name || this._ghostDef}（单击放置 / Esc 取消）` : '';
    const modeText = this._mode === 'move' ? '移动' : (this._mode === 'rotate' ? '旋转' : '仅视角');
    this.hintEl.textContent = '';
    const put = (t, strong) => {
      this.hintEl.appendChild(el(strong ? 'b' : 'span', { text: t }));
    };
    if (this._touchLayout) {
      put('单指点选 · 拖动零件' + (this._mode === 'rotate' ? '旋转' : '移动') + ' · 双指缩放/平移/绕圈转视角 · 长按更多');
      put(` · 模式：${modeText} · 步长 ${this._step} m · ` + symText + hand, true);
      return;
    }
    put('左键拖动旋转 · 滚轮缩放 · 中/右键拖动平移 · 单击选中 · 拖动已选零件=移动 · ');
    put(`模式 ${modeText}（G 移动 / R 旋转 / V 视角）`, true);
    put(` · 手柄或方向键微调（步长 ${this._step} m，Shift+↑↓ 改高度，Alt 精细） · Delete 删除 · Ctrl+Z 撤销 · `);
    put(symText + hand, true);
  }

  /* ================================================================ 渲染器 / 场景 */

  /** 懒创建渲染器与场景 @private */
  _ensureRenderer() {
    if (this._renderer || this._broken || this._disposed) return;
    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
      });
    } catch (e) {
      console.warn('[builder] WebGL 初始化失败', e);
      this._broken = true;
      this._brokenNote?.classList.remove('sp-hidden');
      Toast.push('3D 预览不可用（WebGL 初始化失败），仍可编辑零件。', { kind: 'error', duration: 6000 });
      return;
    }
    try {
      const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
      renderer.setPixelRatio(Math.min(dpr, 2));
      renderer.setSize(Math.max(1, this._stage.clientWidth || 800), Math.max(1, this._stage.clientHeight || 450), false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
    } catch (e) { console.warn('[builder] 渲染器配置失败', e); }

    this._renderer = renderer;
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 4000);
    this._buildSceneStatics();
    this._buildGizmo();
    this._dirty = true;
  }

  /** 天空 / 灯光 / 网格地面 @private */
  _buildSceneStatics() {
    const scene = this._scene;
    if (!scene) return;

    // 程序化天空渐变（canvas 等距柱状贴图；无 document 时降级为纯色）
    try {
      const tex = makeSkyTexture('#0c2033', '#15455f', '#05090e', 1024);
      if (tex) { scene.background = tex; this._skyTex = tex; }
      else scene.background = new THREE.Color(0x0a1420);
    } catch (e) {
      console.warn('[builder] 天空贴图失败', e);
      scene.background = new THREE.Color(0x0a1420);
    }

    // 三点布光：主光（投影）+ 侧补光 + 轮廓光
    try {
      const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x18202a, 1.0);
      scene.add(hemi);

      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(7, 11, 7);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.near = 0.5;
      key.shadow.camera.far = 120;
      key.shadow.camera.left = -22;
      key.shadow.camera.right = 22;
      key.shadow.camera.top = 22;
      key.shadow.camera.bottom = -22;
      key.shadow.bias = -0.0006;
      scene.add(key);
      scene.add(key.target);
      this._keyLight = key;

      const fill = new THREE.DirectionalLight(0x8fc6ff, 0.8);
      fill.position.set(-9, 5, -4);
      scene.add(fill);

      const rim = new THREE.DirectionalLight(0xffd9a0, 1.0);
      rim.position.set(-3, 4, -13);
      scene.add(rim);
    } catch (e) { console.warn('[builder] 灯光失败', e); }

    // 地板 + 网格
    try {
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(320, 320),
        new THREE.MeshStandardMaterial({ color: 0x0a1219, roughness: 0.96, metalness: 0.02 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.02;
      ground.receiveShadow = true;
      scene.add(ground);
      this._ground = ground;

      const grid = new THREE.GridHelper(120, 120, 0x00d0ff, 0x1b3a4a);
      if (grid.material) {
        grid.material.transparent = true;
        grid.material.opacity = 0.42;
        grid.material.depthWrite = false;
      }
      grid.position.y = 0;
      scene.add(grid);
      this._floorGrid = grid;
    } catch (e) { console.warn('[builder] 网格地面失败', e); }
  }

  /** 构建移动/旋转手柄 @private */
  _buildGizmo() {
    const g = new THREE.Group();
    g.name = 'builder:gizmo';
    g.visible = false;
    this._gizmoAxes = [];
    const colors = [0xff4d5e, 0x3ddc84, 0x00d0ff];

    const mkMat = (color) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.96, depthTest: false, depthWrite: false, toneMapped: false,
    });

    for (let i = 0; i < 3; i++) {
      const axisGroup = new THREE.Group();
      axisGroup.userData.gizmoAxis = i;
      axisGroup.userData.gizmoKind = 'move';
      axisGroup.renderOrder = 999;

      // 移动箭头：杆 + 锥
      const shaftGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.82, 8);
      const headGeo = new THREE.ConeGeometry(0.105, 0.26, 10);
      const shaft = new THREE.Mesh(shaftGeo, mkMat(colors[i]));
      const head = new THREE.Mesh(headGeo, mkMat(colors[i]));
      shaft.userData.gizmoAxis = i; shaft.userData.gizmoKind = 'move';
      head.userData.gizmoAxis = i; head.userData.gizmoKind = 'move';
      shaft.renderOrder = 999; head.renderOrder = 999;

      // 旋转圆环
      const ringGeo = new THREE.TorusGeometry(0.72, 0.034, 8, 44);
      const ring = new THREE.Mesh(ringGeo, mkMat(colors[i]));
      ring.userData.gizmoAxis = i; ring.userData.gizmoKind = 'rotate';
      ring.renderOrder = 999;

      if (i === 0) {           // X 轴
        shaft.rotation.z = -Math.PI / 2; shaft.position.x = 0.41;
        head.rotation.z = -Math.PI / 2; head.position.x = 0.94;
        ring.rotation.y = Math.PI / 2;
      } else if (i === 1) {    // Y 轴
        shaft.position.y = 0.41;
        head.position.y = 0.94;
        ring.rotation.x = Math.PI / 2;
      } else {                 // Z 轴
        shaft.rotation.x = Math.PI / 2; shaft.position.z = 0.41;
        head.rotation.x = Math.PI / 2; head.position.z = 0.94;
      }

      axisGroup.add(shaft); axisGroup.add(head); axisGroup.add(ring);
      g.add(axisGroup);
      this._gizmoAxes.push({ group: axisGroup, move: [shaft, head], rotate: [ring] });
    }

    this._gizmo = g;
    this._applyGizmoMode(true);
    this._scene?.add(g);
  }

  /** 按当前模式显示/隐藏手柄（move=箭头，rotate=圆环，view=都不显示） @private */
  _applyGizmoMode(silent) {
    if (this._gizmoAxes) {
      for (const a of this._gizmoAxes) {
        for (const m of a.move) m.visible = this._gizmoMode === 'move';
        for (const m of a.rotate) m.visible = this._gizmoMode === 'rotate';
      }
    }
    if (this._gizmo) this._gizmo.visible = this._mode !== 'view' && this.selectedParts().length > 0;
    if (!silent) this._dirty = true;
  }

  /** 兼容旧调用：切换手柄/交互模式 @private */
  _setGizmoMode(mode, silent) {
    this.setMode(mode === 'rotate' ? 'rotate' : (mode === 'view' ? 'view' : 'move'));
    if (!silent) this._refreshTransformPanel();
  }

  /** 释放场景内所有自建 GPU 资源 @private */
  _disposeSceneResources() {
    this._disposeHelpers();
    this._disposeGroupGeometries(this._gizmo);       // 手柄几何
    try {
      this._gizmo?.traverse?.((o) => { if (o.material) o.material.dispose?.(); });
      if (this._gizmo?.parent) this._gizmo.parent.remove(this._gizmo);
    } catch (e) { /* 忽略 */ }
    this._gizmo = null;
    this._gizmoAxes = null;

    this._disposePreview();

    try {
      if (this._floorGrid) {
        this._floorGrid.geometry?.dispose?.();
        this._floorGrid.material?.dispose?.();
        this._floorGrid.parent?.remove(this._floorGrid);
      }
    } catch (e) { /* 忽略 */ }
    this._floorGrid = null;

    try {
      if (this._ground) {
        this._ground.geometry?.dispose?.();
        this._ground.material?.dispose?.();
        this._ground.parent?.remove(this._ground);
      }
    } catch (e) { /* 忽略 */ }
    this._ground = null;

    try {
      if (this._skyTex) { this._skyTex.dispose?.(); if (this._scene) this._scene.background = null; }
    } catch (e) { /* 忽略 */ }
    this._skyTex = null;
    this._keyLight = null;
  }

  /** 释放预览模型 @private */
  _disposePreview() {
    const pv = this._preview;
    if (!pv) return;
    try {
      pv.group?.parent?.remove(pv.group);
      this._disposeGroupGeometries(pv.group);
    } catch (e) { console.warn('[builder] 释放预览失败', e); }
    this._preview = null;
  }

  /**
   * 递归释放网格几何（**不**释放材质：材质来自 parts.js 的全局缓存，共享使用）。
   * @param {THREE.Object3D|null} root
   * @private
   */
  _disposeGroupGeometries(root) {
    if (!root) return;
    try {
      root.traverse((o) => {
        if (o.isMesh || o.isLine || o.isLineSegments || o.isPoints) {
          o.geometry?.dispose?.();
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ================================================================ 预览模型 */

  /** 重建预览模型（几何/拓扑变化后调用） @private */
  _rebuildPreview() {
    this._disposeHelpers();
    this._disposePreview();

    const craft = this._craft;
    let pv = null;
    try {
      pv = buildCraftVisual(craft, { shadows: true, painted: true });
    } catch (e) {
      console.warn('[builder] buildCraftVisual 失败，降级为空模型', e);
      pv = { group: new THREE.Group(), visual: new THREE.Group(), com: new THREE.Vector3(), props: [], controls: [], meshes: new Map() };
      pv.group.add(pv.visual);
    }
    if (!pv.visual) { pv.visual = new THREE.Group(); pv.group.add(pv.visual); }
    if (!pv.com) pv.com = new THREE.Vector3();

    // 以质心为原点的模型：把 group 放到质心处，子网格世界坐标 == part.pos
    try { pv.group.position.copy(pv.com); } catch (e) { /* 忽略 */ }

    // 螺旋桨基准角（怠速动画用）
    for (const p of (pv.props || [])) {
      p.baseRotZ = toNum(p.part?.rot?.[2], 0) * DEG;
    }

    this._preview = pv;
    this._scene?.add(pv.group);
    this._syncPreviewTransforms(craft.parts);
    this._rebuildHelpers();
    this._dirty = true;
  }

  /**
   * 重新锚定预览组（质心变化后调用，无需重建几何）。
   * @private
   */
  _reanchorPreview() {
    const pv = this._preview;
    if (!pv) return;
    try {
      const com = new THREE.Vector3();
      let mt = 0;
      for (const p of this._craft.parts) {
        const m = partMass(p);
        mt += m;
        com.x += toNum(p.pos?.[0], 0) * m;
        com.y += toNum(p.pos?.[1], 0) * m;
        com.z += toNum(p.pos?.[2], 0) * m;
      }
      if (mt > 0) com.multiplyScalar(1 / mt); else com.set(0, 0, 0);
      pv.com.copy(com);
      pv.group.position.copy(com);
    } catch (e) { console.warn('[builder] 重锚定失败', e); }
    this._syncPreviewTransforms(this._craft.parts);
  }

  /**
   * 把零件变换同步到预览网格（拖拽时每帧调用，避免重建几何）。
   * @param {Array<object>} parts
   * @private
   */
  _syncPreviewTransforms(parts) {
    const pv = this._preview;
    if (!pv || !Array.isArray(parts)) return;
    const com = pv.com || { x: 0, y: 0, z: 0 };
    for (const p of parts) {
      const m = pv.meshes?.get?.(p.uid);
      if (!m) continue;
      m.position.set(toNum(p.pos?.[0], 0) - com.x, toNum(p.pos?.[1], 0) - com.y, toNum(p.pos?.[2], 0) - com.z);
      m.rotation.set(toNum(p.rot?.[0], 0) * DEG, toNum(p.rot?.[1], 0) * DEG, toNum(p.rot?.[2], 0) * DEG);
    }
    try { pv.group?.updateMatrixWorld?.(true); } catch (e) { /* 忽略 */ }
  }

  /** 让相机框住整机 @private */
  _frameCraft() {
    if (!this._preview || !this._camera) return;
    try {
      const box = new THREE.Box3().setFromObject(this._preview.group);
      if (box.isEmpty()) {
        this._orbit.target.set(0, 0.8, 0);
        this._orbit.dist = 14;
      } else {
        box.getCenter(this._orbit.target);
        const size = box.getSize(new THREE.Vector3());
        const r = Math.max(1.2, size.length() * 0.5);
        this._orbit.dist = clamp(r * 2.4, 4, 300);
        this._orbit.target.y = Math.max(this._orbit.target.y, 0.4);
      }
    } catch (e) {
      console.warn('[builder] 取景失败', e);
      this._orbit.target.set(0, 0.8, 0);
      this._orbit.dist = 14;
    }
    this._orbit.yaw = 0.65;
    this._orbit.pitch = 0.3;
    this._dirty = true;
  }

  /* ================================================================ 选中 / 手柄 */

  /** 当前选中的零件列表 @returns {Array<object>} */
  selectedParts() {
    if (!this._selUids || !this._selUids.size) return [];
    const parts = this._craft?.parts;
    if (!Array.isArray(parts)) return [];
    return parts.filter((p) => this._selUids.has(p.uid));
  }

  /** 选中/取消选中一个零件 @private */
  _toggleSelect(part, additive) {
    if (!part) return;
    if (additive) {
      if (this._selUids.has(part.uid)) this._selUids.delete(part.uid);
      else this._selUids.add(part.uid);
    } else {
      this._selUids = new Set([part.uid]);
    }
    this._onSelectionChanged();
  }

  /** 清空选择 @returns {void} */
  clearSelection() {
    if (!this._selUids.size) return;
    this._selUids.clear();
    this._onSelectionChanged();
  }

  /** 选择变化后的收尾 @private */
  _onSelectionChanged() {
    this._rebuildHelpers();
    this._refreshTransformPanel();
    this._refreshNudgePanel();
    this._refreshPropsPanel();
    this._syncTransform();
    // 触屏：选中零件时自动切到「微调」标签（数值精调是手机端主要手段），取消选中回到零件库
    try {
      const has = this._selUids.size > 0;
      if (this._touchLayout && has !== this._hadSelection) {
        if (has) { this._sheetTab = 'nudge'; this._sheetExpanded = true; }
        else if (this._sheetTab === 'nudge') this._sheetTab = 'parts';
        this._syncSheet();
      }
      this._hadSelection = has;
    } catch (e) { /* 忽略 */ }
    this._syncSelBar();
    this._dirty = true;
  }

  /** 重建选中包围盒 @private */
  _rebuildHelpers() {
    this._disposeHelpers();
    const pv = this._preview;
    if (!pv || !this._scene) return;
    const parts = this.selectedParts();
    for (const p of parts) {
      const obj = pv.meshes?.get?.(p.uid);
      if (!obj) continue;
      try {
        const hb = new THREE.BoxHelper(obj, 0x00d0ff);
        if (hb.material) {
          hb.material.depthTest = false;
          hb.material.transparent = true;
          hb.material.opacity = 0.95;
        }
        hb.renderOrder = 998;
        this._scene.add(hb);
        this._helpers.push({ hb, obj });
      } catch (e) { console.warn('[builder] 包围盒失败', e); }
    }
    if (this._helpers.length) this._updateHelpers();
  }

  /** 释放包围盒 @private */
  _disposeHelpers() {
    for (const h of this._helpers) {
      try {
        h.hb.parent?.remove(h.hb);
        h.hb.geometry?.dispose?.();
        h.hb.material?.dispose?.();
      } catch (e) { /* 忽略 */ }
    }
    this._helpers = [];
  }

  /** 更新包围盒 @private */
  _updateHelpers() {
    for (const h of this._helpers) {
      try {
        h.obj.updateWorldMatrix?.(true, true);
        h.hb.setFromObject?.(h.obj);
      } catch (e) { /* 忽略 */ }
    }
  }

  /** 更新手柄位置/缩放 @private */
  _updateGizmoTransform() {
    const g = this._gizmo;
    if (!g) return;
    const parts = this.selectedParts();
    if (!parts.length || this._mode === 'view') { g.visible = false; return; }
    g.visible = true;
    let x = 0, y = 0, z = 0;
    for (const p of parts) { x += toNum(p.pos?.[0], 0); y += toNum(p.pos?.[1], 0); z += toNum(p.pos?.[2], 0); }
    const n = Math.max(1, parts.length);
    g.position.set(x / n, y / n, z / n);
    // 手柄按"屏幕像素"恒定大小：触屏 90px 箭头（命中半径 28px 才够用），鼠标 30px。
    // 这样无论机型多大/相机多远，手指都能稳定点到。
    const hRaw = toNum(this._stage?.clientHeight, 0);
    const h = hRaw > 40 ? hRaw : 450;      // 布局未就绪时退化为 450
    const fov = toNum(this._camera?.fov, 55) * DEG;
    const pxPerM = h / (2 * Math.max(0.5, this._orbit.dist) * Math.tan(fov / 2));
    const desiredArrowPx = this._touchLayout ? 96 : 40;
    g.scale.setScalar(clamp(desiredArrowPx / 1.06 / Math.max(1e-3, pxPerM), 0.15, 60));
  }

  /**
   * 屏幕空间拾取手柄（不依赖细长网格的射线命中，触屏更容易点中）。
   * @param {number} px 屏幕 x（CSS px）
   * @param {number} py 屏幕 y
   * @returns {{axis:number, kind:'move'|'rotate'}|null}
   * @private
   */
  _pickGizmoHandle(px, py) {
    const g = this._gizmo;
    const cam = this._camera;
    if (!g || !cam || this._mode === 'view') return null;
    this._updateGizmoTransform();
    if (!g.visible) return null;

    const radius = this._touchLayout ? HIT_PX_TOUCH : HIT_PX_MOUSE;
    let rect;
    try { rect = this._stage.getBoundingClientRect(); } catch (e) { return null; }
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    const scale = g.scale.x || 1;
    const origin = g.position;

    const proj = (v) => {
      const p = v.clone().project(cam);
      return { x: rect.left + (p.x * 0.5 + 0.5) * w, y: rect.top + (-p.y * 0.5 + 0.5) * h, z: p.z };
    };
    const o2 = proj(origin);
    if (!Number.isFinite(o2.x) || o2.z > 1) return null;

    // 零件中心留"死区"：直接按住零件拖动不应该被手柄抢走。
    // （正交视角下的圆环会投影成穿过中心的扁椭圆，没有死区就会抢占中心点。）
    const deadCenter = this._touchLayout ? 34 : 18;
    if (Math.hypot(px - o2.x, py - o2.y) < deadCenter) return null;

    for (let i = 0; i < 3; i++) {
      if (this._gizmoMode === 'move') {
        // 箭头：只取"外侧一段"参与命中（中心留死区，方便直接拖动零件本身）
        const tip = origin.clone();
        tip.setComponent(i, tip.getComponent(i) + 1.06 * scale);
        const t2 = proj(tip);
        if (t2.z > 1 || !Number.isFinite(t2.x)) continue;
        const segLen = Math.hypot(t2.x - o2.x, t2.y - o2.y);
        const dead = segLen * (this._touchLayout ? 0.45 : 0.2);
        if (segLen - dead < 6) continue;
        const ux = (t2.x - o2.x) / (segLen || 1), uy = (t2.y - o2.y) / (segLen || 1);
        const sx = o2.x + ux * dead, sy = o2.y + uy * dead;
        if (distToSegment(px, py, sx, sy, t2.x, t2.y) <= radius) return { axis: i, kind: 'move' };
      } else {
        // 圆环：采样折线取最小屏幕距离
        const R = 0.72 * scale;
        const u = new THREE.Vector3(); u.setComponent((i + 1) % 3, 1);
        const vv = new THREE.Vector3(); vv.setComponent((i + 2) % 3, 1);
        let prev = null;
        let best = Infinity;
        for (let k = 0; k <= 32; k++) {
          const a = (k / 32) * Math.PI * 2;
          const p3 = origin.clone().addScaledVector(u, Math.cos(a) * R).addScaledVector(vv, Math.sin(a) * R);
          const p2 = proj(p3);
          if (p2.z > 1 || !Number.isFinite(p2.x)) { prev = null; continue; }
          if (prev) best = Math.min(best, distToSegment(px, py, prev.x, prev.y, p2.x, p2.y));
          prev = p2;
        }
        if (best <= radius) return { axis: i, kind: 'rotate' };
      }
    }
    return null;
  }

  /** 开始手柄拖拽 @private */
  _beginGizmoDrag(handle, ev) {
    const targets = this._mirrorTargets();
    if (!targets.length) return;
    const origin = this._gizmo ? this._gizmo.position.clone() : new THREE.Vector3();
    this._drag = {
      kind: 'gizmo', axis: handle.axis, mode: handle.kind,
      startX: ev.clientX, startY: ev.clientY,
      lastX: ev.clientX, lastY: ev.clientY,
      button: 0, pointerId: ev.pointerId, moved: false, pushed: false,
      targets, origin, startT: null, startAngle: null, delta: [0, 0, 0],
    };
    this._updateNDC(ev.clientX, ev.clientY);
    this._raycaster.setFromCamera(this._ndc, this._camera);
    if (handle.kind === 'move') {
      const axis = new THREE.Vector3(); axis.setComponent(handle.axis, 1);
      this._drag.startT = closestTOnAxis(origin, axis, this._raycaster);
    } else {
      this._drag.startAngle = this._planeAngle(origin, handle.axis);
    }
    this._dirty = true;
  }

  /** 平面内角度（用于旋转手柄） @private */
  _planeAngle(origin, axisIdx) {
    try {
      const n = new THREE.Vector3(); n.setComponent(axisIdx, 1);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin);
      const hit = new THREE.Vector3();
      if (!this._raycaster.ray.intersectPlane(plane, hit)) return null;
      const v = hit.sub(origin);
      const u = new THREE.Vector3(); u.setComponent((axisIdx + 1) % 3, 1);
      const w = new THREE.Vector3(); w.setComponent((axisIdx + 2) % 3, 1);
      return Math.atan2(v.dot(w), v.dot(u));
    } catch (e) { return null; }
  }

  /** 拖拽中 @private */
  _updateGizmoDrag(ev) {
    const drag = this._drag;
    if (!drag || drag.kind !== 'gizmo') return;
    this._updateNDC(ev.clientX, ev.clientY);
    this._raycaster.setFromCamera(this._ndc, this._camera);

    const axis = new THREE.Vector3(); axis.setComponent(drag.axis, 1);
    const deltaDeg = [0, 0, 0];
    let deltaPos = [0, 0, 0];

    if (drag.mode === 'move') {
      const t = closestTOnAxis(drag.origin, axis, this._raycaster);
      if (t == null || drag.startT == null) return;
      let d = t - drag.startT;
      const step = this._step > 0 ? this._step : 0.25;
      d = Math.round(d / step) * step;
      deltaPos[drag.axis] = d;
    } else {
      const a = this._planeAngle(drag.origin, drag.axis);
      if (a == null || drag.startAngle == null) return;
      let d = a - drag.startAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      let deg = d * RAD2DEG;
      deg = Math.round(deg / ROT_SNAP) * ROT_SNAP;
      deltaDeg[drag.axis] = deg;
    }

    if (!drag.pushed) { this._pushHistory(); drag.pushed = true; this._refreshHistoryButtons(); }

    const touched = [];
    for (const t of drag.targets) {
      const p = t.part;
      if (!p) continue;
      if (drag.mode === 'move') {
        for (let i = 0; i < 3; i++) {
          p.pos[i] = r3(toNum(t.startPos[i], 0) + deltaPos[i] * t.posSign[i]);
        }
      } else {
        const i = drag.axis;
        p.rot[i] = normDeg(toNum(t.startRot[i], 0) + deltaDeg[i] * t.rotSign[i]);
      }
      touched.push(p);
    }
    this._syncPreviewTransforms(touched);
    drag.moved = true;
    drag.delta = drag.mode === 'move' ? deltaPos : deltaDeg;
    this._dirty = true;
    this._refreshStats();
    this._syncTransform();
  }

  /** 结束手柄拖拽 @private */
  _endGizmoDrag(drag) {
    if (!drag || drag.kind !== 'gizmo') return;
    if (drag.moved) {
      this._reanchorPreview();
      this._rebuildHelpers();
      this._refreshStats();
      this._syncTransform();
      this._refreshHistoryButtons();
      this._dirty = true;
    }
  }

  /* ================================================================ 镜像对称 */

  /** 查找某个零件在指定轴上的镜像伙伴 @private */
  _mirrorPartner(part, axis) {
    try {
      const parts = this._craft.parts || [];
      if (axis === 'x' && Math.abs(toNum(part.pos?.[0], 0)) < 0.02) return null;
      if (axis === 'y' && Math.abs(toNum(part.pos?.[1], 0)) < 0.02) return null;
      const px = toNum(part.pos?.[0], 0), py = toNum(part.pos?.[1], 0), pz = toNum(part.pos?.[2], 0);
      for (const q of parts) {
        if (q === part || q.def !== part.def) continue;
        const qx = toNum(q.pos?.[0], 0), qy = toNum(q.pos?.[1], 0), qz = toNum(q.pos?.[2], 0);
        if (Math.abs(qz - pz) > POS_EPS) continue;
        if (axis === 'x') {
          if (Math.abs(qx + px) > POS_EPS || Math.abs(qy - py) > POS_EPS) continue;
          if (Math.abs(toNum(q.rot?.[0], 0) - toNum(part.rot?.[0], 0)) > ROT_EPS) continue;
          if (Math.abs(toNum(q.rot?.[1], 0) + toNum(part.rot?.[1], 0)) > ROT_EPS) continue;
          if (Math.abs(toNum(q.rot?.[2], 0) + toNum(part.rot?.[2], 0)) > ROT_EPS) continue;
        } else {
          if (Math.abs(qy + py) > POS_EPS || Math.abs(qx - px) > POS_EPS) continue;
          if (Math.abs(toNum(q.rot?.[0], 0) + toNum(part.rot?.[0], 0)) > ROT_EPS) continue;
          if (Math.abs(toNum(q.rot?.[1], 0) - toNum(part.rot?.[1], 0)) > ROT_EPS) continue;
          if (Math.abs(toNum(q.rot?.[2], 0) + toNum(part.rot?.[2], 0)) > ROT_EPS) continue;
        }
        return q;
      }
    } catch (e) { console.warn('[builder] 镜像查找失败', e); }
    return null;
  }

  /** 开启的镜像轴 @private */
  _mirrorAxes() {
    const out = [];
    if (this._symmetry === 'x' || this._symmetry === 'xy') out.push('x');
    if (this._symmetry === 'y' || this._symmetry === 'xy') out.push('y');
    return out;
  }

  /**
   * 为当前选中零件（含镜像闭包）建立"起始状态 + 符号"表。
   * posSign[i] / rotSign[i] 表示该零件的第 i 个分量跟随主零件增量的符号。
   * @private
   */
  _mirrorTargets() {
    const out = new Map();
    const sel = this.selectedParts();
    const mk = (part, posSign, rotSign) => ({
      part,
      startPos: [
        toNum(part.pos?.[0], 0), toNum(part.pos?.[1], 0), toNum(part.pos?.[2], 0),
      ],
      startRot: [
        toNum(part.rot?.[0], 0), toNum(part.rot?.[1], 0), toNum(part.rot?.[2], 0),
      ],
      posSign, rotSign,
    });
    const queue = [];
    for (const p of sel) { out.set(p, mk(p, [1, 1, 1], [1, 1, 1])); queue.push(p); }

    const axes = this._mirrorAxes();
    while (queue.length) {
      const p = queue.pop();
      const cur = out.get(p);
      if (!cur) continue;
      for (const ax of axes) {
        const q = this._mirrorPartner(p, ax);
        if (!q || out.has(q)) continue;
        const fp = ax === 'x' ? [-1, 1, 1] : [1, -1, 1];
        const fr = ax === 'x' ? [1, -1, -1] : [-1, 1, -1];
        out.set(q, mk(q, cur.posSign.map((v, i) => v * fp[i]), cur.rotSign.map((v, i) => v * fr[i])));
        queue.push(q);
      }
    }
    return [...out.values()];
  }

  /** 收集选中零件 + 镜像伙伴（删除用） @private */
  _collectMirrorClosure(seed) {
    const found = new Set(seed);
    const queue = [...seed];
    const axes = this._mirrorAxes();
    while (queue.length) {
      const p = queue.pop();
      for (const ax of axes) {
        const q = this._mirrorPartner(p, ax);
        if (q && !found.has(q)) { found.add(q); queue.push(q); }
      }
    }
    return found;
  }

  /** 新零件的镜像副本（放置用） @private */
  _symmetryCopies(part) {
    const out = [];
    if (this._symmetry === 'none') return out;
    const signs = [];
    if (this._symmetry === 'x' || this._symmetry === 'xy') signs.push([[-1, 1, 1], [1, -1, -1]]);
    if (this._symmetry === 'y' || this._symmetry === 'xy') signs.push([[1, -1, 1], [-1, 1, -1]]);
    if (this._symmetry === 'xy') signs.push([[-1, -1, 1], [-1, -1, 1]]);
    for (const [ps, rs] of signs) {
      if (ps[0] === -1 && Math.abs(toNum(part.pos?.[0], 0)) < 1e-3) continue;
      if (ps[1] === -1 && Math.abs(toNum(part.pos?.[1], 0)) < 1e-3) continue;
      try {
        const c = deepClone(part);
        c.uid = this._allocUid();
        for (let i = 0; i < 3; i++) {
          c.pos[i] = r3(toNum(part.pos[i], 0) * ps[i]);
          c.rot[i] = normDeg(toNum(part.rot[i], 0) * rs[i]);
        }
        out.push(c);
      } catch (e) { console.warn('[builder] 镜像副本失败', e); }
    }
    return out;
  }

  /* ================================================================ 编辑操作 */

  /** 一次性平移选中（含镜像） @private */
  _applyNudge(dPos) {
    const targets = this._mirrorTargets();
    if (!targets.length) return false;
    for (const t of targets) {
      for (let i = 0; i < 3; i++) {
        t.part.pos[i] = r3(toNum(t.startPos[i], 0) + dPos[i] * t.posSign[i]);
      }
    }
    this._syncPreviewTransforms(targets.map((t) => t.part));
    return true;
  }

  /** 一次性旋转选中（含镜像） @private */
  _applyRotate(axis, deg) {
    const targets = this._mirrorTargets();
    if (!targets.length) return false;
    for (const t of targets) {
      const d = [0, 0, 0]; d[axis] = deg;
      for (let i = 0; i < 3; i++) {
        t.part.rot[i] = normDeg(toNum(t.startRot[i], 0) + d[i] * t.rotSign[i]);
      }
    }
    this._syncPreviewTransforms(targets.map((t) => t.part));
    return true;
  }

  /** 按键/按钮微调位置 @private */
  _nudgeSelection(dx, dy, dz) {
    if (!this.selectedParts().length) { Toast.push('先选中零件', { kind: 'info', duration: 1400 }); return; }
    this._pushHistory();
    try {
      if (this._applyNudge([dx, dy, dz])) {
        this._reanchorPreview();
        this._afterEdit();
      }
    } catch (e) { console.warn('[builder] 微调失败', e); }
  }

  /** 按钮旋转 @private */
  _rotateSelection(axis, deg) {
    if (!this.selectedParts().length) { Toast.push('先选中零件', { kind: 'info', duration: 1400 }); return; }
    this._pushHistory();
    try {
      if (this._applyRotate(axis, deg)) this._afterEdit();
    } catch (e) { console.warn('[builder] 旋转失败', e); }
  }

  /** 旋转归零 @private */
  _resetRotation() {
    const sel = this.selectedParts();
    if (!sel.length) return;
    this._pushHistory();
    try {
      const targets = this._mirrorTargets();
      for (const t of targets) t.part.rot = [0, 0, 0];
      this._syncPreviewTransforms(targets.map((t) => t.part));
      this._afterEdit();
    } catch (e) { console.warn('[builder] 归零失败', e); }
  }

  /** 缩放某个轴 @private */
  _scaleSelection(axis, ratio, baseLen) {
    const sel = this.selectedParts();
    if (!sel.length) return;
    this._touchSession('_scaleSession', `sel:${axis}`);
    try {
      for (const p of sel) {
        const d = PART_DEFS[p.def];
        const b = (Array.isArray(d?.size) ? d.size[axis] : baseLen) || 1;
        p.size[axis] = Math.max(0.02, r3(b * ratio));
      }
      this._syncTransform();
      this._refreshStats();
      this._rebuildPreview();
    } catch (e) { console.warn('[builder] 缩放失败', e); }
  }

  /** 把选中零件放到地面 @private */
  _dropSelection() {
    const sel = this.selectedParts();
    if (!sel.length) return;
    this._pushHistory();
    try {
      for (const p of sel) p.pos[1] = r3(Math.max(0.02, toNum(p.size?.[1], 0.2) / 2));
      this._reanchorPreview();
      this._afterEdit();
    } catch (e) { console.warn('[builder] 落地失败', e); }
  }

  /** 修改属性（选中零件中同 def 的全部） @private */
  _setPropForSelection(defId, key, value) {
    const sel = this.selectedParts();
    if (!sel.length) return;
    this._touchSession('_propSession', `${defId}:${key}`);
    try {
      for (const p of sel) {
        if (p.def !== defId) continue;
        if (!p.props || typeof p.props !== 'object') p.props = defaultProps(p.def);
        p.props[key] = value;
      }
      this._rebuildPreview();
      this._refreshStats();
      this._syncTransform();
    } catch (e) { console.warn('[builder] 属性修改失败', e); }
  }

  /** 给选中零件上色 @private */
  _paintSelection(color) {
    const sel = this.selectedParts();
    if (!sel.length) return;
    const c = this._safeColor(color);
    this._pushHistory();
    try {
      const targets = this._mirrorTargets();
      for (const t of targets) t.part.color = c;
      this._rebuildPreview();
    } catch (e) { console.warn('[builder] 上色失败', e); }
  }

  /** 整机上色 @private */
  _paintAll(color) {
    const c = this._safeColor(color);
    this._pushHistory();
    try {
      for (const p of this._craft.parts) p.color = c;
      this._rebuildPreview();
      this._refreshPropsPanel();
    } catch (e) { console.warn('[builder] 整机上色失败', e); }
  }

  /** 删除选中零件（含镜像伙伴） @returns {void} */
  deleteSelected() {
    const sel = this.selectedParts();
    if (!sel.length) { Toast.push('没有选中的零件', { kind: 'info', duration: 1400 }); return; }
    this._pushHistory();
    try {
      const doomed = this._collectMirrorClosure(sel);
      this._craft.parts = this._craft.parts.filter((p) => !doomed.has(p));
      this._selUids.clear();
      this._refreshHistoryButtons();
      this._rebuildPreview();
      this._refreshPanels();
      Toast.push(`已删除 ${doomed.size} 个零件`, { kind: 'success', duration: 1500 });
    } catch (e) {
      console.warn('[builder] 删除失败', e);
      Toast.push('删除失败', { kind: 'error' });
    }
  }

  /** 编辑后的通用收尾（不重建面板 DOM） @private */
  _afterEdit() {
    this._rebuildHelpers();
    this._syncTransform();
    this._refreshStats();
    this._refreshHistoryButtons();
    this._dirty = true;
  }

  /* ================================================================ 幽灵预览 / 放置 */

  /** 从零件库拿起一个零件 @private */
  _setInHand(defId) {
    if (!PART_DEFS[defId]) { Toast.push('未知零件：' + defId, { kind: 'error' }); return; }
    if (this._ghostDef === defId) {
      // 再次点击同一零件：直接放到视野中央
      this._ghostPlacement = this._computePlacement(NaN, NaN);
      this._placeInHand();
      return;
    }
    this._ghostDef = defId;
    this._buildGhost();
    this._updateGhostAt(this._hover.x, this._hover.y);
    this._refreshHint();
    this._dirty = true;
  }

  /** 构建半透明幽灵 @private */
  _buildGhost() {
    const defId = this._ghostDef;   // 必须在 _clearGhost 之前取出
    this._clearGhost();
    if (!defId) return;
    this._ghostDef = defId;
    const d = PART_DEFS[defId];
    if (!d || !this._scene) return;
    try {
      const part = {
        uid: -1, def: defId, pos: [0, 0, 0], rot: [0, 0, 0],
        size: Array.isArray(d.size) ? d.size.slice() : [1, 1, 1],
        color: '#' + new THREE.Color(d.color ?? 0xc9d3dd).getHexString(),
        props: defaultProps(defId), attachedTo: null,
      };
      const g = buildPartMesh(part, { shadows: false, painted: true });
      g.traverse((o) => {
        if (!o.isMesh) return;
        try {
          const m = o.material?.clone?.();
          if (m) {
            m.transparent = true;
            m.opacity = 0.42;
            m.depthWrite = false;
            m.toneMapped = false;
            o.material = m;
          }
        } catch (e) { /* 忽略 */ }
        o.castShadow = false;
        o.receiveShadow = false;
        o.renderOrder = 6;
      });
      this._ghost = { group: g, part };
      this._scene.add(g);
    } catch (e) {
      console.warn('[builder] 幽灵预览构建失败', e);
      this._ghost = null;
    }
  }

  /** 清除幽灵 @private */
  _clearGhost() {
    const g = this._ghost;
    this._ghost = null;
    this._ghostDef = null;
    this._ghostPlacement = null;
    if (!g) return;
    try {
      g.group.parent?.remove(g.group);
      g.group.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
    } catch (e) { /* 忽略 */ }
  }

  /** 更新幽灵到指定屏幕位置 @private */
  _updateGhostAt(cx, cy) {
    if (!this._ghost) return;
    const place = this._computePlacement(cx, cy);
    if (!place) { this._ghost.group.visible = false; this._ghostPlacement = null; return; }
    this._ghost.group.visible = true;
    this._ghost.group.position.set(place.pos[0], place.pos[1], place.pos[2]);
    this._ghost.group.rotation.set(place.rot[0] * DEG, place.rot[1] * DEG, place.rot[2] * DEG);
    this._ghostPlacement = place;
    this._dirty = true;
  }

  /**
   * 计算放置位置：优先吸附到已有零件表面，否则落到网格地面。
   * @param {number} cx 屏幕 x（NaN 表示取画面中心）
   * @param {number} cy 屏幕 y
   * @returns {{pos:number[], rot:number[], attached:number|null}|null}
   * @private
   */
  _computePlacement(cx, cy) {
    if (!this._camera) return null;
    const defId = this._ghostDef;
    const d = defId ? PART_DEFS[defId] : null;
    const size = Array.isArray(d?.size) ? d.size : [1, 1, 1];
    const step = this._step > 0 ? this._step : 0.25;
    const snap = (v) => Math.round(v / step) * step;

    let x = cx, y = cy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const r = this._stage.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    this._updateNDC(x, y);
    this._raycaster.setFromCamera(this._ndc, this._camera);

    let pos = null;
    let attached = null;
    let attachedPart = null;

    // 1) 与现有零件求交，沿命中面法线（主轴化）外移半个新零件尺寸
    if (this._preview) {
      let hits = [];
      try { hits = this._raycaster.intersectObject(this._preview.visual, true); } catch (e) { hits = []; }
      // 过滤掉不可见对象（控制面铰链/辅助体等），避免拾取到隐藏图元
      hits = hits.filter((h) => {
        let o = h.object;
        while (o) { if (o.visible === false) return false; o = o.parent; }
        return true;
      });
      if (hits.length) {
        const h = hits[0];
        let n = new THREE.Vector3(0, 1, 0);
        try {
          if (h.face) n = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
        } catch (e) { /* 忽略 */ }
        const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
        const out = new THREE.Vector3();
        let half = size[1] / 2;
        if (ax >= ay && ax >= az) { out.set(n.x >= 0 ? 1 : -1, 0, 0); half = size[0] / 2; }
        else if (ay >= az) { out.set(0, n.y >= 0 ? 1 : -1, 0); half = size[1] / 2; }
        else { out.set(0, 0, n.z >= 0 ? 1 : -1); half = size[2] / 2; }
        pos = h.point.clone().addScaledVector(out, half + 0.002);
        let o = h.object;
        while (o && !o.userData?.part) o = o.parent;
        attachedPart = o?.userData?.part ?? null;
        attached = attachedPart?.uid ?? null;
      }
    }

    // 2) 网格地面
    if (!pos) {
      this._plane.set(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      if (this._raycaster.ray.intersectPlane(this._plane, hit)) pos = hit;
    }

    // 3) 兜底：相机前方
    if (!pos) {
      const dir = new THREE.Vector3();
      this._camera.getWorldDirection(dir);
      pos = this._camera.position.clone().addScaledVector(dir, Math.max(6, this._orbit.dist * 0.6));
    }

    // ---- 吸附 ----
    // 贴着已有零件放置时，吸附到「那个零件」的坐标网格上（三轴都对），
    // 这样新零件和它严丝合缝对齐；否则吸附到世界网格。
    if (attachedPart && Array.isArray(attachedPart.pos)) {
      const b = attachedPart.pos;
      pos.x = b[0] + Math.round((pos.x - b[0]) / step) * step;
      pos.y = b[1] + Math.round((pos.y - b[1]) / step) * step;
      pos.z = b[2] + Math.round((pos.z - b[2]) / step) * step;
    } else {
      pos.x = snap(pos.x);
      pos.z = snap(pos.z);
      pos.y = snap(pos.y);
    }
    // 吸附到镜像平面（保证左右对称可精确对齐）
    if (Math.abs(pos.x) < step * 0.49) pos.x = 0;

    const outPos = [r3(pos.x), 0, r3(pos.z)];
    const groundY = size[1] / 2;
    outPos[1] = attached != null ? r3(Math.max(step * 0.25, pos.y)) : r3(Math.max(groundY, pos.y));
    return { pos: outPos, rot: [0, 0, 0], attached };
  }

  /** 放置手上的零件 @private */
  _placeInHand() {
    if (!this._ghostDef) return;
    const place = this._ghostPlacement || this._computePlacement(NaN, NaN);
    if (!place) { Toast.push('无法确定放置位置', { kind: 'warn' }); return; }
    this._pushHistory();
    try {
      const created = this._createPart(this._ghostDef, place.pos, place.rot, { attachedTo: place.attached });
      if (!created) return;
      const extras = this._symmetryCopies(created);
      this._craft.parts.push(created, ...extras);
      this._selUids = new Set([created.uid]);
      this._refreshHistoryButtons();
      this._rebuildPreview();
      this._refreshPanels();
      this._dirty = true;
    } catch (e) {
      console.warn('[builder] 放置失败', e);
      Toast.push('放置失败', { kind: 'error' });
    }
  }

  /* ================================================================ 指针 / 相机 */

  /** 绑定舞台事件（一次性） @private */
  _bindStageEvents() {
    const s = this._stage;
    this._pdBound = (ev) => this._onPointerDown(ev);
    this._pmBound = (ev) => this._onPointerMove(ev);
    this._puBound = (ev) => this._onPointerUp(ev);
    this._pcBound = (ev) => this._onPointerUp(ev);
    this._wheelBound = (ev) => this._onWheel(ev);
    this._ctxBound = (ev) => ev.preventDefault();
    this._enterBound = () => { this._hover.over = true; };
    this._leaveBound = () => { this._hover.over = false; };
    s.addEventListener('pointerdown', this._pdBound);
    s.addEventListener('pointermove', this._pmBound);
    s.addEventListener('pointerup', this._puBound);
    s.addEventListener('pointercancel', this._pcBound);
    s.addEventListener('wheel', this._wheelBound, { passive: false });
    s.addEventListener('contextmenu', this._ctxBound);
    s.addEventListener('pointerenter', this._enterBound);
    s.addEventListener('pointerleave', this._leaveBound);
    // 移动端：双指捏合缩放 / 平移（把触摸手势翻译成等价的相机操作）
    this._touchState = null;
    this._touchBound = (ev) => this._onTouchGesture(ev);
    s.addEventListener('touchstart', this._touchBound, { passive: false });
    s.addEventListener('touchmove', this._touchBound, { passive: false });
    s.addEventListener('touchend', this._touchBound, { passive: false });
    s.addEventListener('touchcancel', this._touchBound, { passive: false });
  }

  /** 平移相机（双指拖动 / 中键拖动） @private */
  _panCamera(dx, dy) {
    const cam = this._camera;
    if (!cam) return;
    const k = this._orbit.dist * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    this._orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    this._dirty = true;
  }

  /**
   * 双指手势：捏合 = 缩放，整体拖动 = 平移，两指绕圈 = 旋转视角（yaw/pitch）。
   * 单指交给 pointer 事件（点选 / 拖动零件 / 旋转相机），互不冲突。
   * @private
   */
  _onTouchGesture(ev) {
    const t = ev.touches;
    if (t && t.length === 2) {
      try { ev.preventDefault(); } catch (e) { /* 忽略 */ }
      const [a, b] = [t[0], t[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      const ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
      const prev = this._touchState;
      if (prev) {
        // 捏合 -> 缩放
        const zoom = (prev.dist - dist) * 6;
        if (Math.abs(zoom) > 0.5) {
          try { this._onWheel({ deltaY: zoom, clientX: cx, clientY: cy, preventDefault() { } }); } catch (e) { /* 忽略 */ }
        }
        // 整体平移
        const dx = cx - prev.cx, dy = cy - prev.cy;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) {
          try { this._panCamera(dx, dy); } catch (e) { /* 忽略 */ }
        }
        // 两指绕圈 -> 视角 yaw / pitch
        if (Number.isFinite(prev.ang)) {
          let dAng = ang - prev.ang;
          while (dAng > Math.PI) dAng -= Math.PI * 2;
          while (dAng < -Math.PI) dAng += Math.PI * 2;
          if (Math.abs(dAng) > 0.004) {
            this._orbit.yaw -= dAng * 1.15;
            this._orbit.pitch = clamp(this._orbit.pitch + dAng * 0.45, -1.45, 1.45);
            this._dirty = true;
          }
        }
      }
      this._touchState = { dist, cx, cy, ang };
    } else if (t && t.length < 2) {
      this._touchState = null;
    }
  }

  /** 解绑舞台事件 @private */
  _unbindStageEvents() {
    const s = this._stage;
    if (!s) return;
    try {
      s.removeEventListener('pointerdown', this._pdBound);
      s.removeEventListener('pointermove', this._pmBound);
      s.removeEventListener('pointerup', this._puBound);
      s.removeEventListener('pointercancel', this._pcBound);
      s.removeEventListener('wheel', this._wheelBound);
      s.removeEventListener('contextmenu', this._ctxBound);
      s.removeEventListener('pointerenter', this._enterBound);
      s.removeEventListener('pointerleave', this._leaveBound);
      s.removeEventListener('touchstart', this._touchBound);
      s.removeEventListener('touchmove', this._touchBound);
      s.removeEventListener('touchend', this._touchBound);
      s.removeEventListener('touchcancel', this._touchBound);
    } catch (e) { /* 忽略 */ }
  }

  /** @private */
  _updateNDC(cx, cy) {
    const r = this._stage.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this._ndc.set(((cx - r.left) / w) * 2 - 1, -((cy - r.top) / h) * 2 + 1);
  }

  /* ---------------------------------------------------------------- 指针手势
   * 单指/鼠标：
   *   - 点按（位移 < TAP_MOVE 且时长 < TAP_MS）= 选择零件 / 放置手上零件；
   *   - 拖动已选零件（移动模式）= 沿"与相机平行"的平面平移，按 step 吸附；
   *   - 拖动已选零件（旋转模式）= 绕当前轴旋转，15° 吸附；
   *   - 拖动未选零件第一次只做选中（避免误拖）；
   *   - 拖动空白 = 旋转相机；中/右键拖动 = 平移；滚轮 = 缩放；
   *   - 长按（> LONG_PRESS_MS）触屏零件 = 小菜单（删除/复制/镜像）。
   * 双指：由 touch 事件处理（捏合缩放 + 平移 + 绕圈旋转视角）。
   * ---------------------------------------------------------------- */

  /** @private */
  _onPointerDown(ev) {
    if (!this._open || this._broken || !this._renderer) return;
    this._closeContextMenu();
    this._hover.x = ev.clientX; this._hover.y = ev.clientY; this._hover.over = true;

    this._pointers.set(ev.pointerId, {
      x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY,
      t0: Date.now(), button: ev.button, type: ev.pointerType || 'mouse', moved: false,
    });
    try { this._stage.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }

    // 双指：交给 touch 手势（捏合 / 平移 / 绕圈），单指手势让位
    if (this._pointers.size >= 2) { this._cancelGesture(); return; }

    const isMouse = (ev.pointerType || 'mouse') === 'mouse';
    if (isMouse && ev.button !== 0) {
      // 中/右键 = 平移；右键"点按"（未拖动）会在 pointerup 打开小菜单
      this._drag = {
        kind: 'camera', mode: 'pan', button: ev.button, pointerId: ev.pointerId,
        lastX: ev.clientX, lastY: ev.clientY, startX: ev.clientX, startY: ev.clientY, moved: false,
      };
      ev.preventDefault();
      return;
    }

    // 1) 变换手柄（屏幕空间命中，触屏半径 ≥ 28px）
    const handle = this._pickGizmoHandle(ev.clientX, ev.clientY);
    if (handle) {
      try { this._beginGizmoDrag(handle, ev); } catch (e) { console.warn('[builder] 手柄拖拽开始失败', e); }
      ev.preventDefault();
      return;
    }

    // 2) 零件（手上有零件时不抢：此时拖动=转视角、点按=放置）
    const part = this._ghostDef ? null : this._pickPart(ev.clientX, ev.clientY);
    if (part && this._mode !== 'view') {
      this._startLongPress(part, ev);
      if (this._selUids.has(part.uid)) {
        // 已选中：直接拖动（移动 / 旋转）
        try {
          if (this._mode === 'rotate') this._beginPartRotate(part, ev);
          else this._beginPartDrag(part, ev);
        } catch (e) { console.warn('[builder] 零件拖拽开始失败', e); }
      } else {
        // 未选中：第一次拖动只做选中
        this._drag = {
          kind: 'armSelect', part, button: 0, pointerId: ev.pointerId,
          lastX: ev.clientX, lastY: ev.clientY, startX: ev.clientX, startY: ev.clientY, moved: false,
        };
      }
      ev.preventDefault();
      return;
    }

    // 3) 空白（或视角模式）= 旋转相机
    this._drag = {
      kind: 'camera', mode: 'orbit', button: ev.button, pointerId: ev.pointerId,
      lastX: ev.clientX, lastY: ev.clientY, startX: ev.clientX, startY: ev.clientY, moved: false,
    };
    ev.preventDefault();
  }

  /** @private */
  _onPointerMove(ev) {
    if (!this._open) return;
    this._hover.x = ev.clientX; this._hover.y = ev.clientY; this._hover.over = true;

    const p = this._pointers.get(ev.pointerId);
    if (p) {
      p.x = ev.clientX; p.y = ev.clientY;
      if (Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) > 3) p.moved = true;
      if (this._longPress && Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) > TAP_MOVE) this._cancelLongPress();
    }
    if (this._pointers.size >= 2) return;   // 双指：交给 touch 手势

    const drag = this._drag;
    if (!drag) {
      if (this._ghost) this._updateGhostAt(ev.clientX, ev.clientY);
      return;
    }
    const dx = ev.clientX - drag.lastX;
    const dy = ev.clientY - drag.lastY;
    drag.lastX = ev.clientX; drag.lastY = ev.clientY;
    const total = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY);
    if (total > 3) drag.moved = true;

    switch (drag.kind) {
      case 'camera':
        if (drag.mode === 'orbit') {
          this._orbit.yaw -= dx * 0.0075;
          this._orbit.pitch = clamp(this._orbit.pitch + dy * 0.0075, -1.45, 1.45);
        } else {
          this._panCamera(dx, dy);
        }
        this._dirty = true;
        break;
      case 'gizmo':
        try { this._updateGizmoDrag(ev); } catch (e) { console.warn('[builder] 手柄拖拽失败', e); }
        break;
      case 'part':
        try { this._updatePartDrag(ev); } catch (e) { console.warn('[builder] 零件拖拽失败', e); }
        break;
      case 'partRotate':
        try { this._updatePartRotate(ev); } catch (e) { console.warn('[builder] 零件旋转失败', e); }
        break;
      case 'armSelect':
        if (total > TAP_MOVE) {
          this._cancelLongPress();
          this._toggleSelect(drag.part, false);   // 第一次拖动只做选中
          drag.kind = 'armed';
        }
        break;
      default:
        break;
    }
  }

  /** @private */
  _onPointerUp(ev) {
    if (!this._open) return;
    const p = this._pointers.get(ev.pointerId);
    this._pointers.delete(ev.pointerId);
    try { this._stage.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    this._cancelLongPress();

    // 还有别的手指按着（双指手势进行中）：吞掉这次抬起
    if (this._pointers.size >= 1) { this._drag = null; return; }

    const drag = this._drag;
    this._drag = null;
    if (!drag) return;

    const dist = p ? Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) : 999;
    const dt = p ? (Date.now() - p.t0) : 9999;
    const isTap = dist < TAP_MOVE && dt < TAP_MS;

    if (drag.kind === 'camera') {
      if (isTap && drag.button === 0) this._handleClick(ev);
      else if (isTap && drag.button === 2) this._contextMenuForPointer(ev);
      return;
    }
    if (drag.kind === 'gizmo') {
      try { this._endGizmoDrag(drag); } catch (e) { console.warn('[builder] 手柄拖拽结束失败', e); }
      this._propSession = null;
      this._scaleSession = null;
      return;
    }
    if (drag.kind === 'part' || drag.kind === 'partRotate') {
      try { this._endPartDrag(drag); } catch (e) { console.warn('[builder] 零件拖拽结束失败', e); }
      return;
    }
    if (drag.kind === 'armSelect' || drag.kind === 'armed') {
      if (isTap) this._handleClick(ev);
    }
  }

  /** 中断当前单指手势（双指介入时） @private */
  _cancelGesture() {
    const drag = this._drag;
    this._drag = null;
    this._cancelLongPress();
    if (!drag) return;
    try {
      if (drag.kind === 'gizmo') this._endGizmoDrag(drag);
      else if (drag.kind === 'part' || drag.kind === 'partRotate') this._endPartDrag(drag);
    } catch (e) { /* 忽略 */ }
  }

  /** @private */
  _onWheel(ev) {
    if (!this._open || !this._renderer) return;
    try { ev.preventDefault(); } catch (e) { /* 忽略 */ }
    const d = toNum(ev.deltaY, 0);
    this._orbit.dist = clamp(this._orbit.dist * Math.exp(d * 0.0012), 1.2, 500);
    this._dirty = true;
  }

  /** 点按（未拖动） @private */
  _handleClick(ev) {
    if (this._ghostDef) {
      this._updateGhostAt(ev.clientX, ev.clientY);
      this._placeInHand();
      return;
    }
    const part = this._pickPart(ev.clientX, ev.clientY);
    if (part) this._toggleSelect(part, !!ev.shiftKey);
    else if (!ev.shiftKey) this.clearSelection();
  }

  /** 射线拾取零件 @private */
  _pickPart(cx, cy) {
    if (!this._preview || !this._camera) return null;
    try {
      this._updateNDC(cx, cy);
      this._raycaster.setFromCamera(this._ndc, this._camera);
      const hits = this._raycaster.intersectObject(this._preview.visual, true);
      for (const h of hits) {
        let o = h.object;
        while (o) {
          if (o.userData && o.userData.part) return o.userData.part;
          o = o.parent;
        }
      }
    } catch (e) { console.warn('[builder] 拾取失败', e); }
    return null;
  }

  /* ---------------------------------------------------------------- 零件拖动 */

  /** 射线与平面交点 @private */
  _rayPointOnPlane(plane, cx, cy) {
    try {
      if (!this._camera) return null;
      this._updateNDC(cx, cy);
      this._raycaster.setFromCamera(this._ndc, this._camera);
      const hit = new THREE.Vector3();
      return this._raycaster.ray.intersectPlane(plane, hit) ? hit : null;
    } catch (e) { return null; }
  }

  /**
   * 开始"移动零件"拖拽：投影到过零件、与相机平行的平面。
   * @private
   */
  _beginPartDrag(part, ev) {
    const cam = this._camera;
    if (!cam) return;
    const targets = this._mirrorTargets();
    if (!targets.length) return;
    const origin = new THREE.Vector3(toNum(part.pos?.[0], 0), toNum(part.pos?.[1], 0), toNum(part.pos?.[2], 0));
    const n = new THREE.Vector3();
    cam.getWorldDirection(n);                       // 法线朝视线方向 => 平面与相机平行
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin);
    const start = this._rayPointOnPlane(plane, ev.clientX, ev.clientY);
    this._drag = {
      kind: 'part', targets, plane, start, origin,
      button: 0, pointerId: ev.pointerId,
      lastX: ev.clientX, lastY: ev.clientY, startX: ev.clientX, startY: ev.clientY,
      moved: false, pushed: false, started: false,
    };
  }

  /** 拖动中：屏幕位移 -> 世界位移（按 step 吸附） @private */
  _updatePartDrag(ev) {
    const drag = this._drag;
    if (!drag || drag.kind !== 'part') return;
    // 用独立的 started 标记：_onPointerMove 会为了判定"点按"而提前置位 drag.moved，
    // 若用它做判断，第一次位移就不会入栈撤销（撤不回来）。
    if (!drag.started) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 4) return;
      drag.started = true;
      drag.moved = true;
      this._cancelLongPress();
      if (!drag.pushed) { this._pushHistory(); drag.pushed = true; }
    }
    const world = this._rayPointOnPlane(drag.plane, ev.clientX, ev.clientY);
    if (!world || !drag.start) return;
    const step = this._step > 0 ? this._step : 0.25;
    const d = world.sub(drag.start);
    const dPos = [
      Math.round(d.x / step) * step,
      Math.round(d.y / step) * step,
      Math.round(d.z / step) * step,
    ];
    for (const t of drag.targets) {
      if (!t.part) continue;
      for (let i = 0; i < 3; i++) {
        t.part.pos[i] = r3(toNum(t.startPos[i], 0) + dPos[i] * t.posSign[i]);
      }
    }
    this._syncPreviewTransforms(drag.targets.map((t) => t.part));
    this._syncTransform();
    this._syncSelBar();
    this._refreshStats();
    this._dirty = true;
  }

  /** 开始"旋转零件"拖拽（触屏/旋转模式） @private */
  _beginPartRotate(part, ev) {
    const targets = this._mirrorTargets();
    if (!targets.length) return;
    this._drag = {
      kind: 'partRotate', targets, axis: clamp(this._rotAxis, 0, 2),
      button: 0, pointerId: ev.pointerId,
      lastX: ev.clientX, lastY: ev.clientY, startX: ev.clientX, startY: ev.clientY,
      moved: false, pushed: false, started: false,
    };
  }

  /** 旋转拖动中：屏幕拖动距离 -> 角度（15° 吸附） @private */
  _updatePartRotate(ev) {
    const drag = this._drag;
    if (!drag || drag.kind !== 'partRotate') return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.started = true;
      drag.moved = true;
      this._cancelLongPress();
      if (!drag.pushed) { this._pushHistory(); drag.pushed = true; }
    }
    const primary = drag.axis === 0 ? dy : dx;      // 俯仰用竖拖，偏航/滚转用横拖
    const deg = Math.round((primary * 0.7) / ROT_SNAP) * ROT_SNAP;
    for (const t of drag.targets) {
      if (!t.part) continue;
      for (let i = 0; i < 3; i++) {
        const d = i === drag.axis ? deg : 0;
        t.part.rot[i] = normDeg(toNum(t.startRot[i], 0) + d * t.rotSign[i]);
      }
    }
    this._syncPreviewTransforms(drag.targets.map((t) => t.part));
    this._syncTransform();
    this._syncSelBar();
    this._refreshStats();
    this._dirty = true;
  }

  /** 结束零件拖拽 @private */
  _endPartDrag(drag) {
    if (!drag || !drag.moved) return;
    this._reanchorPreview();
    this._rebuildHelpers();
    this._syncTransform();
    this._syncSelBar();
    this._refreshStats();
    this._refreshHistoryButtons();
    this._dirty = true;
  }

  /* ---------------------------------------------------------------- 长按 / 小菜单 */

  /** 开始长按计时（触屏/笔） @private */
  _startLongPress(part, ev) {
    this._cancelLongPress();
    if ((ev.pointerType || 'mouse') === 'mouse') return;   // 桌面用右键
    if (typeof window === 'undefined' || !window.setTimeout) return;
    const pointerId = ev.pointerId;
    const x = ev.clientX, y = ev.clientY;
    let timer = 0;
    timer = window.setTimeout(() => {
      this._longPress = null;
      try {
        this._selUids = new Set([part.uid]);
        this._onSelectionChanged();
        this._drag = null;               // 阻止后续拖动/点按
        this._openContextMenu(x, y);
      } catch (e) { console.warn('[builder] 长按菜单失败', e); }
    }, LONG_PRESS_MS);
    this._longPress = { pointerId, x, y, part, timer };
  }

  /** 取消长按计时 @private */
  _cancelLongPress() {
    const lp = this._longPress;
    this._longPress = null;
    if (lp && lp.timer) { try { window.clearTimeout(lp.timer); } catch (e) { /* 忽略 */ } }
  }

  /** 右键点按：对指针下的零件打开小菜单 @private */
  _contextMenuForPointer(ev) {
    const part = this._pickPart(ev.clientX, ev.clientY);
    if (!part) { this.clearSelection(); return; }
    this._selUids = new Set([part.uid]);
    this._onSelectionChanged();
    this._openContextMenu(ev.clientX, ev.clientY);
  }

  /** 打开零件小菜单 @private */
  _openContextMenu(x, y) {
    this._closeContextMenu();
    const item = (label, icon, kind, fn) => new Button({
      label, icon, kind,
      onClick: () => { this._closeContextMenu(); try { fn(); } catch (e) { console.warn('[builder] 菜单动作失败', e); } },
    }).el;
    const menu = el('div', { class: 'sp2-builder__ctxmenu sp2-builder__ctxmenu--open' }, [
      item('删除', '🗑', 'danger', () => this.deleteSelected()),
      item('复制', '⧉', 'ghost', () => this._duplicate()),
      item('镜像', '⇋', 'ghost', () => this._mirrorSelected()),
      item('取消选择', '✕', 'ghost', () => this.clearSelection()),
    ]);
    // 避免超出视口
    const vw = toNum(typeof window !== 'undefined' ? window.innerWidth : 0, 1024);
    const vh = toNum(typeof window !== 'undefined' ? window.innerHeight : 0, 768);
    menu.style.left = clamp(x, 8, Math.max(8, vw - 180)) + 'px';
    menu.style.top = clamp(y, 8, Math.max(8, vh - 230)) + 'px';
    this.el.appendChild(menu);
    this._ctxMenu = menu;

    // 点击菜单外部关闭
    this._ctxOutside = (ev) => {
      try {
        if (this._ctxMenu && this._ctxMenu.contains && this._ctxMenu.contains(ev.target)) return;
      } catch (e) { /* 忽略 */ }
      this._closeContextMenu();
    };
    try { window.addEventListener('pointerdown', this._ctxOutside, true); } catch (e) { /* 忽略 */ }
    this._dirty = true;
  }

  /** 关闭零件小菜单 @private */
  _closeContextMenu() {
    if (this._ctxOutside) {
      try { window.removeEventListener('pointerdown', this._ctxOutside, true); } catch (e) { /* 忽略 */ }
      this._ctxOutside = null;
    }
    if (this._ctxMenu) {
      try { this._ctxMenu.parentNode?.removeChild(this._ctxMenu); } catch (e) { /* 忽略 */ }
      this._ctxMenu = null;
    }
  }

  /** 为选中零件生成一个 X 轴镜像副本 @private */
  _makeMirrorX(part) {
    try {
      const c = deepClone(part);
      c.uid = this._allocUid();
      c.pos[0] = r3(-toNum(part.pos?.[0], 0));
      c.rot[1] = normDeg(-toNum(part.rot?.[1], 0));
      c.rot[2] = normDeg(-toNum(part.rot?.[2], 0));
      c.attachedTo = null;
      return c;
    } catch (e) { return null; }
  }

  /** 小菜单“镜像”：为选中零件补上 / 移除左右镜像 @private */
  _mirrorSelected() {
    const sel = this.selectedParts();
    if (!sel.length) { Toast.push('先选中零件', { kind: 'info', duration: 1400 }); return; }
    this._pushHistory();
    try {
      const allMirrored = sel.every((p) => !!this._mirrorPartner(p, 'x'));
      if (allMirrored) {
        const doomed = new Set();
        for (const p of sel) {
          const m = this._mirrorPartner(p, 'x');
          if (m && !this._selUids.has(m.uid)) doomed.add(m);
        }
        this._craft.parts = this._craft.parts.filter((p) => !doomed.has(p));
        Toast.push(`已移除 ${doomed.size} 个镜像零件`, { kind: 'success', duration: 1500 });
      } else {
        const created = [];
        for (const p of sel) {
          if (this._mirrorPartner(p, 'x')) continue;
          const c = this._makeMirrorX(p);
          if (c) created.push(c);
        }
        this._craft.parts.push(...created);
        Toast.push(`已镜像 ${created.length} 个零件`, { kind: 'success', duration: 1500 });
      }
      this._refreshHistoryButtons();
      this._rebuildPreview();
      this._refreshPanels();
      this._dirty = true;
    } catch (e) {
      console.warn('[builder] 镜像失败', e);
      Toast.push('镜像失败', { kind: 'error' });
    }
  }

  /* ================================================================ 键盘 */

  /** 全局按键 @private */
  _onKeyDown(ev) {
    if (!this._open || this._disposed) return;
    const t = /** @type {any} */ (ev.target);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    try { if (typeof isModalOpen === 'function' && isModalOpen()) return; } catch (e) { /* 忽略 */ }

    const ctrl = !!(ev.ctrlKey || ev.metaKey);
    const k = String(ev.key || '');
    const lower = k.toLowerCase();

    if (ctrl) {
      if (lower === 'z') { ev.preventDefault(); if (ev.shiftKey) this.redo(); else this.undo(); return; }
      if (lower === 'y') { ev.preventDefault(); this.redo(); return; }
      if (lower === 's') { ev.preventDefault(); this._save(); return; }
      if (lower === 'd') { ev.preventDefault(); this._duplicate(); return; }
      return;
    }

    switch (k) {
      case 'Delete': case 'Backspace':
        if (this.selectedParts().length) { ev.preventDefault(); this.deleteSelected(); }
        return;
      case 'Escape':
        ev.preventDefault();
        if (this._ghostDef) { this._clearGhost(); this._refreshHint(); this._dirty = true; }
        else this.clearSelection();
        return;
      case 'r': case 'R':
        ev.preventDefault(); this.setMode('rotate'); return;
      case 'g': case 'G':
        ev.preventDefault(); this.setMode('move'); return;
      case 'v': case 'V':
        ev.preventDefault(); this.setMode('view'); return;
      case 'n': case 'N':
        ev.preventDefault(); this.toggleNudgePanel(); return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!this.selectedParts().length) return;
        ev.preventDefault();
        const s = ev.altKey ? this._step / 5 : this._step;
        let dx = 0, dy = 0, dz = 0;
        if (k === 'ArrowLeft') dx = -s;
        else if (k === 'ArrowRight') dx = s;
        else if (ev.shiftKey) dy = (k === 'ArrowUp' ? s : -s);   // Shift + ↑↓ 调高度
        else dz = (k === 'ArrowUp' ? -s : s);                     // 机头朝 -Z
        this._nudgeSelection(dx, dy, dz);
        return;
      }
      default:
        return;
    }
  }

  /* ================================================================ 工具栏动作 */

  /** 载入/克隆机型（内部） @private */
  _loadCraftInternal(craft) {
    const clean = craft ? this._sanitizeCraft(craft) : this._blankCraft();
    this._adoptCraft(clean || this._blankCraft());
  }

  /** 接管一份净化后的机型 @private */
  _adoptCraft(clean) {
    this._craft = clean;
    this._selUids = new Set();
    this._hadSelection = false;
    this._tf = null;
    this._propSession = null;
    this._scaleSession = null;
    this._clearGhost();
    this._resyncUidSeq();
    this._rebuildPreview();
    try { this.nameInput.value = this._craft.name || ''; } catch (e) { /* 忽略 */ }
    this._dirty = true;
  }

  /** 根据现有零件同步 uid 计数器 @private */
  _resyncUidSeq() {
    let max = 0;
    for (const p of (this._craft.parts || [])) if (Number.isFinite(p.uid)) max = Math.max(max, p.uid);
    this._uidSeq = Math.max(this._uidSeq, max);
  }

  /** 分配新 uid @private */
  _allocUid() { this._uidSeq += 1; return this._uidSeq; }

  /** 新建空机型对象 @private */
  _blankCraft() {
    return { id: this._newId(), name: '新机型', desc: '', parts: [], type: 'plane', builtin: false, paint: null, unlockCost: 0 };
  }

  /** 新机型 id @private */
  _newId() {
    return 'craft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /** 用 makePart 创建零件实例（uid 由本地序列分配） @private */
  _createPart(defId, pos, rot, opts = {}) {
    try {
      const p = makePart(defId, pos, rot, opts);
      p.uid = this._allocUid();
      p.pos = toVec3(pos, [0, 0, 0]);
      p.rot = toVec3(rot, [0, 0, 0]);
      return p;
    } catch (e) {
      console.warn('[builder] 创建零件失败', defId, e);
      Toast.push('未知零件：' + defId, { kind: 'error' });
      return null;
    }
  }

  /**
   * 净化一份机型数据（缺字段补默认、丢弃未知零件、uid 去重）。
   * @param {object} src
   * @returns {object|null}
   * @private
   */
  _sanitizeCraft(src) {
    if (!src || typeof src !== 'object') return null;
    const out = {};
    try {
      out.id = (typeof src.id === 'string' && src.id) ? src.id : this._newId();
      out.name = (typeof src.name === 'string' && src.name.trim()) ? src.name.slice(0, 40) : '未命名机型';
      out.desc = typeof src.desc === 'string' ? src.desc : '';
      out.type = typeof src.type === 'string' ? src.type : 'plane';
      out.paint = src.paint ?? null;
      out.unlockCost = toNum(src.unlockCost, 0);
      out.builtin = false;   // 机库里载入的机型一律另存为自建

      const raw = Array.isArray(src.parts) ? src.parts : [];
      // 先确定 uid 上限，避免净化过程中分配冲突
      let maxUid = 0;
      for (const p of raw) if (p && Number.isFinite(p.uid)) maxUid = Math.max(maxUid, Math.floor(p.uid));
      this._uidSeq = Math.max(this._uidSeq, maxUid);

      const seen = new Set();
      const parts = [];
      let dropped = 0;
      for (const p of raw) {
        const sp = this._sanitizePart(p, seen);
        if (sp) parts.push(sp); else dropped++;
      }
      out.parts = parts;
      if (dropped > 0) {
        console.warn('[builder] 忽略无效零件数量：', dropped);
        Toast.push(`已忽略 ${dropped} 个无效零件`, { kind: 'warn' });
      }
      return out;
    } catch (e) {
      console.warn('[builder] 机型净化失败', e);
      return null;
    }
  }

  /**
   * 净化单个零件。
   * @param {object} p
   * @param {Set<number>} seen 已用 uid
   * @returns {object|null} 无效返回 null
   * @private
   */
  _sanitizePart(p, seen) {
    if (!p || typeof p !== 'object') return null;
    const def = String(p.def ?? '');
    const d = PART_DEFS[def];
    if (!d) return null;
    let uid = Number.isFinite(p.uid) ? Math.floor(p.uid) : 0;
    if (uid <= 0 || seen.has(uid)) uid = this._allocUid();
    seen.add(uid);
    const size = toVec3(p.size, d.size).map((v) => Math.max(0.02, Math.abs(v)));
    let color = this._validColor(p.color);
    if (!color) color = '#' + new THREE.Color(d.color ?? 0xc9d3dd).getHexString();
    let props = {};
    try {
      props = { ...defaultProps(def), ...(p.props && typeof p.props === 'object' ? p.props : {}) };
    } catch (e) { props = {}; }
    return {
      uid,
      def,
      pos: toVec3(p.pos, [0, 0, 0]).map(r3),
      rot: toVec3(p.rot, [0, 0, 0]).map(normDeg),
      size,
      color,
      props,
      attachedTo: Number.isFinite(p.attachedTo) ? p.attachedTo : null,
    };
  }

  /** 新建（清空） @private */
  _newCraft() {
    const modal = new Modal({
      title: '新建机型',
      content: el('div', { class: 'sp2-builder__sub', text: '新建将清空当前机型的全部零件（可以用 Ctrl+Z 撤销）。确定继续吗？' }),
      buttons: [
        { label: '新建', kind: 'primary', onClick: () => { this._pushHistory(); this._adoptCraft(this._blankCraft()); this._refreshPanels(); this._dirty = true; } },
        { label: '取消', kind: 'ghost' },
      ],
    });
    modal.open();
  }

  /** 载入弹窗 @private */
  _openLoadModal() {
    const items = [];
    /** 列表项 id -> 机型对象（避免依赖机型自身的 id 字段） */
    const byItemId = new Map();

    let stocks = [];
    try {
      if (!this._stockCache) this._stockCache = stockCrafts();
      stocks = this._stockCache || [];
    } catch (e) { console.warn('[builder] stockCrafts 失败', e); stocks = []; }
    let i = 0;
    for (const c of stocks) {
      if (!c) continue;
      const itemId = `stock:${i++}`;
      byItemId.set(itemId, c);
      items.push({
        id: itemId,
        label: c.name || '库存机型',
        sub: `库存 · ${Array.isArray(c.parts) ? c.parts.length : 0} 零件${c.desc ? ' · ' + c.desc : ''}`,
        icon: '🛩',
      });
    }

    let customs = [];
    try { customs = this.opts.getCrafts?.() || []; } catch (e) { console.warn('[builder] getCrafts 失败', e); customs = []; }
    let j = 0;
    for (const c of (Array.isArray(customs) ? customs : [])) {
      if (!c) continue;
      const itemId = `custom:${j++}`;
      byItemId.set(itemId, c);
      items.push({
        id: itemId,
        label: c.name || '自建机型',
        sub: `自建 · ${Array.isArray(c.parts) ? c.parts.length : 0} 零件`,
        icon: '🔧',
      });
    }

    let picked = items[0]?.id || null;
    const list = new ListBox({
      items,
      onChange: (id) => { picked = id; },
    });
    if (picked) list.select(picked, false);

    let modal = null;
    const doLoad = () => {
      if (!picked) { Toast.push('请先选择机型', { kind: 'warn' }); return; }
      const found = byItemId.get(picked);
      if (!found) { Toast.push('找不到该机型', { kind: 'error' }); return; }
      const clean = this._sanitizeCraft(deepClone(found));
      if (!clean) { Toast.push('机型数据无效', { kind: 'error' }); return; }
      this.open(clean);   // open 会重置撤销栈并重新取景
      Toast.push('已载入：' + clean.name, { kind: 'success' });
      modal?.close();
    };

    modal = new Modal({
      title: '载入机型',
      content: el('div', { class: 'sp2-builder__col' }, [
        el('div', { class: 'sp2-builder__sub', text: '选择库存机型或自建机型（会替换当前机型，可用 Ctrl+Z 撤销零件改动）。' }),
        list.el,
      ]),
      buttons: [
        { label: '载入', kind: 'primary', close: false, onClick: doLoad },
        { label: '取消', kind: 'ghost' },
      ],
    });
    modal.open();
  }

  /** 保存 @private */
  _save() {
    try {
      if (typeof this.opts.onSave !== 'function') {
        Toast.push('宿主未提供 onSave，机型未保存。', { kind: 'warn' });
        return;
      }
      this.opts.onSave(this._craft);
      Toast.push('已保存：' + (this._craft.name || '未命名机型'), { kind: 'success' });
    } catch (e) {
      console.warn('[builder] 保存失败', e);
      Toast.push('保存失败', { kind: 'error' });
    }
  }

  /** 复制：有选中则复制零件，否则复制整机 @private */
  _duplicate() {
    const sel = this.selectedParts();
    if (sel.length) {
      this._pushHistory();
      try {
        const offset = Math.max(this._step, 0.25) * 4;
        const created = [];
        for (const p of sel) {
          const c = deepClone(p);
          c.uid = this._allocUid();
          c.pos[0] = r3(toNum(c.pos[0], 0) + offset);
          c.attachedTo = null;
          created.push(c);
          for (const m of this._symmetryCopies(c)) created.push(m);
        }
        this._craft.parts.push(...created);
        this._selUids = new Set(created.map((p) => p.uid));
        this._refreshHistoryButtons();
        this._rebuildPreview();
        this._refreshPanels();
        this._dirty = true;
        Toast.push(`已复制 ${created.length} 个零件`, { kind: 'success', duration: 1500 });
      } catch (e) {
        console.warn('[builder] 复制零件失败', e);
        Toast.push('复制失败', { kind: 'error' });
      }
      return;
    }
    // 整机复制
    try {
      const c = deepClone(this._craft);
      c.id = this._newId();
      c.name = (this._craft.name || '机型') + ' 副本';
      c.builtin = false;
      this._pushHistory();
      this._adoptCraft(this._sanitizeCraft(c) || this._blankCraft());
      this._refreshPanels();
      this._refreshHistoryButtons();
      this._dirty = true;
      Toast.push('已复制整机：' + this._craft.name, { kind: 'success' });
    } catch (e) {
      console.warn('[builder] 复制整机失败', e);
      Toast.push('复制失败', { kind: 'error' });
    }
  }

  /** 试飞 @private */
  _fly() {
    try {
      if (typeof this.opts.onFly !== 'function') { Toast.push('宿主未提供 onFly。', { kind: 'warn' }); return; }
      if (!this._craft.parts.length) { Toast.push('空机型无法试飞', { kind: 'warn' }); return; }
      this.opts.onFly(this._craft);
    } catch (e) {
      console.warn('[builder] 试飞回调失败', e);
      Toast.push('试飞失败', { kind: 'error' });
    }
  }

  /** 返回 @private */
  _exit() {
    try { this.opts.onExit?.(); } catch (e) { console.warn('[builder] onExit 回调失败', e); }
  }

  /** 导出 JSON @private */
  _exportJSON() {
    let text = '';
    try { text = JSON.stringify(this._craft, null, 2); } catch (e) { text = '{}'; }
    const ta = el('textarea', { class: 'sp2-builder__json sp-scroll', readOnly: true, spellcheck: 'false' });
    ta.value = text;
    const modal = new Modal({
      title: '导出机型 JSON',
      content: el('div', { class: 'sp2-builder__col' }, [
        el('div', { class: 'sp2-builder__sub', text: '复制下面的 JSON 保存到文件或分享（可用“导入 JSON”还原）。' }),
        ta,
      ]),
      buttons: [
        {
          label: '复制到剪贴板', kind: 'primary', close: false,
          onClick: () => {
            const ok = this._copyText(text);
            Toast.push(ok ? '已复制到剪贴板' : '复制失败，请手动选中复制', { kind: ok ? 'success' : 'warn' });
          },
        },
        { label: '关闭', kind: 'ghost' },
      ],
    });
    modal.open();
    try { window.setTimeout(() => { ta.focus(); ta.select(); }, 30); } catch (e) { /* 忽略 */ }
  }

  /** 导入 JSON @private */
  _importJSON() {
    const ta = el('textarea', { class: 'sp2-builder__json sp-scroll', placeholder: '在此粘贴机型 JSON…', spellcheck: 'false' });
    let modal = null;
    const doImport = () => {
      const txt = String(ta.value || '').trim();
      if (!txt) { Toast.push('请先粘贴机型 JSON', { kind: 'warn' }); return; }
      let obj = null;
      try { obj = JSON.parse(txt); } catch (e) {
        Toast.push('JSON 解析失败：' + (e?.message || e), { kind: 'error' });
        return;
      }
      const clean = this._sanitizeCraft(obj);
      if (!clean) { Toast.push('机型数据无效', { kind: 'error' }); return; }
      try {
        this._pushHistory();
        this._adoptCraft(clean);
        this._frameCraft();
        this._refreshPanels();
        this._refreshHistoryButtons();
        Toast.push('已导入：' + clean.name, { kind: 'success' });
        modal?.close();
      } catch (e) {
        console.warn('[builder] 导入失败', e);
        Toast.push('导入失败', { kind: 'error' });
      }
    };
    modal = new Modal({
      title: '导入机型 JSON',
      content: el('div', { class: 'sp2-builder__col' }, [
        el('div', { class: 'sp2-builder__sub', text: '粘贴由“导出 JSON”得到的文本，然后点击导入。' }),
        ta,
      ]),
      buttons: [
        { label: '导入', kind: 'primary', close: false, onClick: doImport },
        { label: '取消', kind: 'ghost' },
      ],
    });
    modal.open();
  }

  /** 复制文本（带降级） @private */
  _copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => { /* 降级 */ });
        return true;
      }
    } catch (e) { /* 继续降级 */ }
    try {
      const tmp = el('textarea', { style: { position: 'fixed', opacity: '0' } });
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      const ok = document.execCommand?.('copy');
      tmp.parentNode?.removeChild(tmp);
      return !!ok;
    } catch (e) { return false; }
  }

  /* ================================================================ 渲染 */

  /** 渲染一帧 @private */
  _render() {
    const r = this._renderer, s = this._scene, c = this._camera;
    if (!r || !s || !c) return;
    try {
      this._updateCamera();
      this._preview?.group?.updateMatrixWorld?.(true);
      this._updateHelpers();
      this._updateGizmoTransform();
      r.render(s, c);
    } catch (e) {
      console.warn('[builder] 渲染失败', e);
      this._broken = true;
      this._brokenNote?.classList.remove('sp-hidden');
    }
  }

  /** 按轨道参数摆放相机 @private */
  _updateCamera() {
    const c = this._camera;
    if (!c) return;
    const o = this._orbit;
    const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    c.position.set(
      o.target.x + o.dist * cp * Math.sin(o.yaw),
      o.target.y + o.dist * sp,
      o.target.z + o.dist * cp * Math.cos(o.yaw),
    );
    c.lookAt(o.target);
    c.updateMatrixWorld(true);
  }
}

export default Builder;
