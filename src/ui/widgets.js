// @ts-check
/**
 * src/ui/widgets.js —— SimplePlanes 2 的 DOM 组件库。
 *
 * 设计约定（对集成者）：
 *  - 纯原生 ES Module，**不依赖 three.js**，也不依赖项目内任何其他文件。
 *  - 所有样式由 `injectStyles()` 注入到唯一一个 `<style id="sp2-widgets">`，幂等、可重复调用。
 *  - 模块顶层**不触碰 document / window**，因此 `node --check` 与 Node 端导入均安全。
 *  - 类名命名规范：`sp-<block>` + `sp-<block>__<element>` + `sp-<block>--<modifier>`（BEM 风格，统一 `sp-` 前缀）。
 *  - 每个组件构造后即可直接插入 DOM；`el` 是其根元素。
 */

/* ============================================================================
 * 主题常量
 * ========================================================================== */

/**
 * 主题色板与尺寸常量（供 HUD / 菜单复用，保证与注入的 CSS 一致）。
 * @type {Readonly<{
 *   accent:string, warning:string, danger:string, success:string, info:string,
 *   bg:string, bgSolid:string, bgElevated:string, border:string, borderStrong:string,
 *   text:string, textDim:string, textFaint:string,
 *   radius:number, radiusSm:number, gap:number, gapLg:number,
 *   font:string, fontMono:string,
 *   fontBase:string, fontSmall:string, fontLarge:string,
 *   blur:string, shadow:string,
 *   zPanel:number, zModal:number, zToast:number, zLoading:number,
 *   kind: Readonly<{info:string, warn:string, success:string, error:string}>
 * }>}
 */
export const THEME = Object.freeze({
  // 颜色
  accent: '#00d0ff',
  warning: '#ff9f43',
  danger: '#ff4d5e',
  success: '#3ddc84',
  info: '#00d0ff',

  // 背景 / 边框
  bg: 'rgba(10,16,24,.78)',
  bgSolid: '#0a1018',
  bgElevated: 'rgba(18,28,40,.86)',
  border: 'rgba(0,208,255,.28)',
  borderStrong: 'rgba(0,208,255,.65)',

  // 文字
  text: '#dbe9f4',
  textDim: '#8fa6b8',
  textFaint: 'rgba(143,166,184,.55)',

  // 尺寸
  radius: 8,
  radiusSm: 6,
  gap: 8,
  gapLg: 12,

  // 字体（禁止外部字体）
  font: 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif',
  fontMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontBase: '13px',
  fontSmall: '12px',
  fontLarge: '15px',

  // 视觉效果
  blur: '10px',
  shadow: '0 8px 28px rgba(0,0,0,.45)',

  // 层级
  zPanel: 40,
  zModal: 90,
  zToast: 100,
  zLoading: 120,

  // Toast / 语义色映射
  kind: Object.freeze({
    info: '#00d0ff',
    warn: '#ff9f43',
    success: '#3ddc84',
    error: '#ff4d5e',
  }),
});

/* ============================================================================
 * 样式注入
 * ========================================================================== */

/** 样式元素 id（全局唯一）。 */
const STYLE_ID = 'sp2-widgets';

/** 基础主题 CSS。 */
const BASE_CSS = /* css */ `
:root{
  --sp-accent:${THEME.accent};
  --sp-warning:${THEME.warning};
  --sp-danger:${THEME.danger};
  --sp-success:${THEME.success};
  --sp-bg:${THEME.bg};
  --sp-bg-solid:${THEME.bgSolid};
  --sp-bg-elevated:${THEME.bgElevated};
  --sp-border-color:${THEME.border};
  --sp-border:1px solid var(--sp-border-color);
  --sp-border-strong:1px solid ${THEME.borderStrong};
  --sp-text:${THEME.text};
  --sp-text-dim:${THEME.textDim};
  --sp-radius:${THEME.radius}px;
  --sp-radius-sm:${THEME.radiusSm}px;
  --sp-gap:${THEME.gap}px;
  --sp-font:${THEME.font};
  --sp-blur:${THEME.blur};
  --sp-shadow:${THEME.shadow};
}

/* ---------- 通用 ---------- */
.sp-hidden{ display:none !important; }

.sp-scroll{ scrollbar-width:thin; scrollbar-color:rgba(0,208,255,.35) transparent; }
.sp-scroll::-webkit-scrollbar{ width:8px; height:8px; }
.sp-scroll::-webkit-scrollbar-track{ background:rgba(255,255,255,.04); border-radius:4px; }
.sp-scroll::-webkit-scrollbar-thumb{
  background:rgba(0,208,255,.3); border-radius:4px; border:2px solid transparent; background-clip:padding-box;
}
.sp-scroll::-webkit-scrollbar-thumb:hover{ background:rgba(0,208,255,.55); background-clip:padding-box; }
.sp-scroll::-webkit-scrollbar-corner{ background:transparent; }

/* ---------- 面板 Panel ---------- */
.sp-panel{
  position:fixed; top:72px; left:16px;
  z-index:${THEME.zPanel};
  display:flex; flex-direction:column;
  min-width:180px; max-width:min(92vw,440px); max-height:86vh;
  background:rgba(10,16,24,.78);
  border:1px solid rgba(0,208,255,.28);
  border-radius:8px;
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  box-shadow:var(--sp-shadow);
  color:var(--sp-text);
  font-family:var(--sp-font); font-size:${THEME.fontBase};
  overflow:hidden;
}
.sp-panel__bar{
  display:flex; align-items:center; gap:8px;
  flex:0 0 auto;
  padding:8px 10px;
  background:linear-gradient(180deg, rgba(0,208,255,.10), rgba(0,208,255,.02));
  border-bottom:1px solid rgba(0,208,255,.18);
  user-select:none;
}
.sp-panel--draggable .sp-panel__bar{ cursor:move; touch-action:none; }
.sp-panel__title{
  flex:1 1 auto; min-width:0;
  font-weight:600; letter-spacing:.4px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  color:var(--sp-accent);
  text-shadow:0 0 10px rgba(0,208,255,.35);
}
.sp-panel__close{
  flex:0 0 auto; width:22px; height:22px; padding:0;
  display:inline-flex; align-items:center; justify-content:center;
  font:inherit; font-size:15px; line-height:1;
  color:var(--sp-text-dim);
  background:transparent; border:1px solid transparent; border-radius:4px;
  cursor:pointer;
  transition:color .15s, background .15s, border-color .15s;
}
.sp-panel__close:hover{ color:var(--sp-danger); background:rgba(255,77,94,.12); border-color:rgba(255,77,94,.4); }
.sp-panel__close:focus-visible{ outline:2px solid var(--sp-accent); outline-offset:1px; }
.sp-panel__body{
  flex:1 1 auto; min-height:0;
  padding:10px;
  overflow:auto;
  scrollbar-width:thin; scrollbar-color:rgba(0,208,255,.35) transparent;
}
.sp-panel__body::-webkit-scrollbar{ width:8px; height:8px; }
.sp-panel__body::-webkit-scrollbar-track{ background:rgba(255,255,255,.04); }
.sp-panel__body::-webkit-scrollbar-thumb{ background:rgba(0,208,255,.3); border-radius:4px; border:2px solid transparent; background-clip:padding-box; }
.sp-panel__body::-webkit-scrollbar-thumb:hover{ background:rgba(0,208,255,.55); background-clip:padding-box; }

/* ---------- 按钮 Button ---------- */
.sp-btn{
  appearance:none; -webkit-appearance:none;
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  padding:8px 14px;
  font-family:var(--sp-font); font-size:${THEME.fontBase}; line-height:1;
  color:var(--sp-text);
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.14);
  border-radius:var(--sp-radius-sm);
  cursor:pointer;
  white-space:nowrap;
  transition:background .15s, border-color .15s, box-shadow .15s, color .15s, transform .06s;
}
.sp-btn:hover{ background:rgba(255,255,255,.12); border-color:rgba(0,208,255,.45); }
.sp-btn:active{ transform:translateY(1px); }
.sp-btn:focus-visible{ outline:2px solid var(--sp-accent); outline-offset:2px; }
.sp-btn__icon{ font-size:14px; line-height:1; }

.sp-btn--primary{
  color:#eaf9ff;
  background:linear-gradient(180deg, rgba(0,208,255,.30), rgba(0,208,255,.14));
  border-color:rgba(0,208,255,.65);
  box-shadow:0 0 12px rgba(0,208,255,.35), inset 0 1px 0 rgba(255,255,255,.16);
}
.sp-btn--primary:hover{
  background:linear-gradient(180deg, rgba(0,208,255,.42), rgba(0,208,255,.20));
  box-shadow:0 0 20px rgba(0,208,255,.55), inset 0 1px 0 rgba(255,255,255,.22);
}
.sp-btn--danger{
  color:#ffe3e6;
  background:linear-gradient(180deg, rgba(255,77,94,.28), rgba(255,77,94,.12));
  border-color:rgba(255,77,94,.6);
  box-shadow:0 0 12px rgba(255,77,94,.28), inset 0 1px 0 rgba(255,255,255,.12);
}
.sp-btn--danger:hover{
  background:linear-gradient(180deg, rgba(255,77,94,.42), rgba(255,77,94,.18));
  box-shadow:0 0 20px rgba(255,77,94,.5), inset 0 1px 0 rgba(255,255,255,.18);
}
.sp-btn--ghost{
  color:var(--sp-text-dim);
  background:transparent;
  border-color:transparent;
}
.sp-btn--ghost:hover{ color:var(--sp-text); background:rgba(255,255,255,.08); border-color:rgba(0,208,255,.28); box-shadow:none; }

.sp-btn[disabled], .sp-btn[aria-disabled="true"]{
  opacity:.42; cursor:not-allowed; pointer-events:none; box-shadow:none; transform:none;
}

/* ---------- 滑条 Slider ---------- */
.sp-slider{
  display:flex; flex-direction:column; gap:4px;
  padding:2px 0;
  font-family:var(--sp-font); font-size:${THEME.fontBase}; color:var(--sp-text);
}
.sp-slider__top{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.sp-slider__label{ color:var(--sp-text-dim); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sp-slider__value{
  color:var(--sp-accent);
  font-family:var(--sp-font); font-variant-numeric:tabular-nums;
  font-size:${THEME.fontSmall};
  text-shadow:0 0 8px rgba(0,208,255,.35);
}
.sp-slider__track{
  position:relative; display:flex; align-items:center;
  height:22px; border-radius:11px;
  cursor:pointer; touch-action:none;
}
.sp-slider__track:focus-visible{ outline:2px solid var(--sp-accent); outline-offset:2px; }
.sp-slider__rail{
  position:absolute; left:0; right:0; height:4px; border-radius:2px;
  background:rgba(255,255,255,.14);
}
.sp-slider__fill{
  position:absolute; left:0; height:4px; border-radius:2px;
  background:linear-gradient(90deg, rgba(0,208,255,.45), var(--sp-accent));
  box-shadow:0 0 8px rgba(0,208,255,.5);
}
.sp-slider__thumb{
  position:absolute; width:14px; height:14px; border-radius:50%;
  background:var(--sp-bg-solid);
  border:2px solid var(--sp-accent);
  box-shadow:0 0 10px rgba(0,208,255,.6);
  transform:translateX(-50%);
  transition:transform .1s;
  pointer-events:none;
}
.sp-slider--active .sp-slider__thumb,
.sp-slider__track:hover .sp-slider__thumb{ transform:translateX(-50%) scale(1.12); }

/* ---------- 开关 Toggle ---------- */
.sp-toggle{
  display:flex; align-items:center; gap:8px;
  padding:4px 0;
  font-family:var(--sp-font); font-size:${THEME.fontBase}; color:var(--sp-text);
  cursor:pointer; user-select:none;
}
.sp-toggle:focus-visible{ outline:2px solid var(--sp-accent); outline-offset:2px; border-radius:4px; }
.sp-toggle__box{
  position:relative; flex:0 0 auto;
  width:36px; height:20px; border-radius:10px;
  background:rgba(255,255,255,.12);
  border:1px solid rgba(255,255,255,.18);
  transition:background .16s, border-color .16s, box-shadow .16s;
}
.sp-toggle__dot{
  position:absolute; top:2px; left:2px;
  width:14px; height:14px; border-radius:50%;
  background:${THEME.textDim};
  transition:transform .16s, background .16s;
}
.sp-toggle__label{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sp-toggle--on .sp-toggle__box{
  background:rgba(0,208,255,.26);
  border-color:rgba(0,208,255,.7);
  box-shadow:0 0 12px rgba(0,208,255,.35);
}
.sp-toggle--on .sp-toggle__dot{ transform:translateX(16px); background:var(--sp-accent); }
.sp-toggle[aria-disabled="true"]{ opacity:.45; pointer-events:none; }

/* ---------- 表单域 / 下拉 Select ---------- */
.sp-field{ display:flex; flex-direction:column; gap:4px; font-family:var(--sp-font); font-size:${THEME.fontBase}; color:var(--sp-text); }
.sp-field__label{ color:var(--sp-text-dim); font-size:${THEME.fontSmall}; letter-spacing:.3px; }
.sp-select{
  appearance:none; -webkit-appearance:none;
  width:100%;
  padding:8px 30px 8px 10px;
  font-family:inherit; font-size:inherit; color:var(--sp-text);
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.14);
  border-radius:var(--sp-radius-sm);
  cursor:pointer;
  background-image:linear-gradient(45deg, transparent 50%, var(--sp-accent) 50%), linear-gradient(135deg, var(--sp-accent) 50%, transparent 50%);
  background-position:calc(100% - 16px) 50%, calc(100% - 11px) 50%;
  background-size:5px 5px, 5px 5px;
  background-repeat:no-repeat;
  transition:border-color .15s, background-color .15s, box-shadow .15s;
}
.sp-select:hover{ border-color:rgba(0,208,255,.45); }
.sp-select:focus-visible{ outline:none; border-color:var(--sp-accent); box-shadow:0 0 0 2px rgba(0,208,255,.25); }
.sp-select option{ background:${THEME.bgSolid}; color:var(--sp-text); }

/* ---------- 标签页 Tabs ---------- */
.sp-tabs{ display:flex; flex-direction:column; min-width:0; font-family:var(--sp-font); font-size:${THEME.fontBase}; color:var(--sp-text); }
.sp-tabs__strip{
  display:flex; gap:4px; flex:0 0 auto;
  border-bottom:1px solid rgba(0,208,255,.22);
  overflow-x:auto; scrollbar-width:none;
}
.sp-tabs__strip::-webkit-scrollbar{ height:0; }
.sp-tab{
  appearance:none; -webkit-appearance:none;
  padding:8px 12px;
  font:inherit; color:var(--sp-text-dim);
  background:transparent; border:0; border-bottom:2px solid transparent;
  cursor:pointer; white-space:nowrap;
  transition:color .15s, background .15s, border-color .15s;
}
.sp-tab:hover{ color:var(--sp-text); background:rgba(255,255,255,.05); }
.sp-tab--active{
  color:var(--sp-accent);
  border-bottom-color:var(--sp-accent);
  text-shadow:0 0 10px rgba(0,208,255,.4);
}
.sp-tab:focus-visible{ outline:2px solid var(--sp-accent); outline-offset:-2px; }
.sp-tabs__panels{ min-width:0; }
.sp-tabs__panel[hidden]{ display:none; }

/* ---------- 列表 ListBox ---------- */
.sp-listbox{
  display:flex; flex-direction:column; gap:2px;
  max-height:280px; min-height:36px;
  padding:4px; overflow-y:auto;
  background:rgba(10,16,24,.78);
  border:1px solid rgba(0,208,255,.28);
  border-radius:8px;
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  font-family:var(--sp-font); font-size:${THEME.fontBase}; color:var(--sp-text);
  outline:none;
  scrollbar-width:thin; scrollbar-color:rgba(0,208,255,.35) transparent;
}
.sp-listbox::-webkit-scrollbar{ width:8px; }
.sp-listbox::-webkit-scrollbar-track{ background:rgba(255,255,255,.04); }
.sp-listbox::-webkit-scrollbar-thumb{ background:rgba(0,208,255,.3); border-radius:4px; border:2px solid transparent; background-clip:padding-box; }
.sp-listbox::-webkit-scrollbar-thumb:hover{ background:rgba(0,208,255,.55); background-clip:padding-box; }
.sp-listbox:focus-visible{ outline:2px solid var(--sp-accent); outline-offset:2px; }

.sp-list__item{
  appearance:none; -webkit-appearance:none;
  display:flex; align-items:center; gap:10px;
  width:100%; padding:8px 10px;
  font:inherit; text-align:left; color:var(--sp-text);
  background:transparent; border:1px solid transparent; border-radius:var(--sp-radius-sm);
  cursor:pointer;
  transition:background .12s, border-color .12s, box-shadow .12s;
}
.sp-list__item:hover{ background:rgba(255,255,255,.06); }
.sp-list__item:focus-visible{ outline:none; }
.sp-list__item--active{ background:rgba(0,208,255,.10); border-color:rgba(0,208,255,.32); }
.sp-list__item--selected{
  background:rgba(0,208,255,.18);
  border-color:rgba(0,208,255,.65);
  box-shadow:inset 0 0 14px rgba(0,208,255,.14);
}
.sp-list__icon{
  flex:0 0 auto; width:22px;
  display:flex; align-items:center; justify-content:center;
  font-size:16px; line-height:1;
}
.sp-list__icon img{ width:20px; height:20px; object-fit:contain; display:block; border-radius:3px; }
.sp-list__texts{ display:flex; flex-direction:column; gap:2px; min-width:0; flex:1 1 auto; }
.sp-list__label{ font-size:${THEME.fontBase}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sp-list__sub{ font-size:${THEME.fontSmall}; color:var(--sp-text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sp-list__empty{ padding:10px; text-align:center; color:var(--sp-text-dim); font-size:${THEME.fontSmall}; }

/* ---------- 提示 Toast ---------- */
.sp-toasts{
  position:fixed; top:14px; left:50%; transform:translateX(-50%);
  z-index:${THEME.zToast};
  display:flex; flex-direction:column; align-items:center; gap:8px;
  max-width:92vw;
  pointer-events:none;
}
.sp-toast{
  pointer-events:auto;
  display:flex; align-items:center; gap:8px;
  max-width:min(90vw,520px);
  padding:9px 14px;
  background:rgba(10,16,24,.78);
  border:1px solid rgba(0,208,255,.28);
  border-radius:8px;
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  box-shadow:var(--sp-shadow);
  color:var(--sp-text);
  font-family:var(--sp-font); font-size:${THEME.fontBase};
  cursor:pointer;
  animation:sp-toast-in .22s ease-out;
}
.sp-toast__dot{ flex:0 0 auto; width:6px; height:6px; border-radius:50%; background:var(--sp-accent); box-shadow:0 0 8px currentColor; }
.sp-toast__msg{ min-width:0; word-break:break-word; }
.sp-toast--warn{ border-color:rgba(255,159,67,.55); color:#ffe6c7; }
.sp-toast--warn .sp-toast__dot{ background:var(--sp-warning); }
.sp-toast--success{ border-color:rgba(61,220,132,.55); color:#d8ffe9; }
.sp-toast--success .sp-toast__dot{ background:var(--sp-success); }
.sp-toast--error{ border-color:rgba(255,77,94,.6); color:#ffdfe3; }
.sp-toast--error .sp-toast__dot{ background:var(--sp-danger); }
.sp-toast--out{ animation:sp-toast-out .22s ease-in forwards; }
@keyframes sp-toast-in{ from{ opacity:0; transform:translateY(-10px) scale(.98); } to{ opacity:1; transform:none; } }
@keyframes sp-toast-out{ to{ opacity:0; transform:translateY(-8px) scale(.98); } }

/* ---------- 模态框 Modal ---------- */
.sp-modal{
  position:fixed; inset:0;
  z-index:${THEME.zModal};
  display:flex; align-items:center; justify-content:center;
  padding:16px;
}
.sp-modal__backdrop{
  position:absolute; inset:0;
  background:rgba(4,8,14,.62);
  backdrop-filter:blur(3px);
  -webkit-backdrop-filter:blur(3px);
  touch-action:none;
  overscroll-behavior:contain;
}
.sp-modal__box{
  position:relative; z-index:1;
  display:flex; flex-direction:column;
  width:min(560px,92vw); max-height:82vh;
  background:rgba(10,16,24,.78);
  border:1px solid rgba(0,208,255,.28);
  border-radius:8px;
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  box-shadow:var(--sp-shadow);
  color:var(--sp-text);
  font-family:var(--sp-font); font-size:${THEME.fontBase};
  overflow:hidden;
  animation:sp-modal-in .18s ease-out;
}
.sp-modal__bar{
  display:flex; align-items:center; gap:8px; flex:0 0 auto;
  padding:10px 12px;
  background:linear-gradient(180deg, rgba(0,208,255,.10), rgba(0,208,255,.02));
  border-bottom:1px solid rgba(0,208,255,.18);
}
.sp-modal__title{ flex:1 1 auto; min-width:0; font-weight:600; letter-spacing:.4px; color:var(--sp-accent); text-shadow:0 0 10px rgba(0,208,255,.35); }
.sp-modal__body{ flex:1 1 auto; min-height:0; padding:14px; overflow:auto; }
.sp-modal__footer{
  display:flex; align-items:center; justify-content:flex-end; gap:8px; flex:0 0 auto;
  padding:10px 12px;
  border-top:1px solid rgba(0,208,255,.16);
  background:rgba(0,0,0,.16);
}
@keyframes sp-modal-in{ from{ opacity:0; transform:translateY(8px) scale(.985); } to{ opacity:1; transform:none; } }

/* ---------- 加载遮罩 Loading ---------- */
.sp-loading{
  position:fixed; inset:0;
  z-index:${THEME.zLoading};
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
  background:rgba(6,10,16,.82);
  backdrop-filter:blur(8px);
  -webkit-backdrop-filter:blur(8px);
  color:var(--sp-text);
  font-family:var(--sp-font); font-size:${THEME.fontBase};
}
.sp-loading__spinner{
  width:34px; height:34px; border-radius:50%;
  border:3px solid rgba(0,208,255,.18);
  border-top-color:var(--sp-accent);
  box-shadow:0 0 16px rgba(0,208,255,.25);
  animation:sp-spin 1s linear infinite;
}
.sp-loading__text{ letter-spacing:.6px; }
.sp-loading__bar{
  width:min(320px,72vw); height:6px; padding:1px;
  background:rgba(255,255,255,.12);
  border:1px solid rgba(0,208,255,.22);
  border-radius:4px; overflow:hidden;
}
.sp-loading__fill{
  height:100%; width:0%;
  background:linear-gradient(90deg, rgba(0,208,255,.45), var(--sp-accent));
  box-shadow:0 0 12px rgba(0,208,255,.6);
  transition:width .18s ease-out;
}
.sp-loading--indeterminate .sp-loading__fill{ width:35%; animation:sp-loading-slide 1.1s ease-in-out infinite; }
@keyframes sp-spin{ to{ transform:rotate(360deg); } }
@keyframes sp-loading-slide{ from{ margin-left:-35%; } to{ margin-left:100%; } }

/* ---------- 无障碍：减少动效 ---------- */
@media (prefers-reduced-motion: reduce){
  .sp-toast, .sp-toast--out, .sp-modal__box, .sp-loading__spinner, .sp-loading__fill{ animation:none !important; transition:none !important; }
}

/* ---------- 移动端适配 ---------- */
@media (max-width:720px){
  .sp-panel{ max-width:calc(100vw - 16px); max-height:76vh; font-size:${THEME.fontBase}; }
  .sp-panel__body{ padding:8px; }
  .sp-panel__bar{ padding:10px; }
  .sp-btn{ padding:10px 14px; }
  .sp-modal{ padding:8px; }
  .sp-modal__box{ width:100%; max-height:88vh; }
  .sp-modal__footer{ flex-wrap:wrap; }
  .sp-modal__footer .sp-btn{ flex:1 1 auto; }
  .sp-toasts{ top:8px; width:94vw; max-width:none; }
  .sp-toast{ max-width:94vw; }
  .sp-listbox{ max-height:44vh; }
  .sp-list__item{ padding:10px; }
  .sp-slider__track{ height:28px; }
  .sp-slider__thumb{ width:18px; height:18px; }
  .sp-tab{ padding:10px 12px; }
  .sp-toggle{ padding:8px 0; }
  .sp-field{ gap:6px; }
  .sp-select{ padding:10px 30px 10px 10px; }
}
`;

/** 已追加过的自定义 CSS，避免重复注入。 */
const _extraCss = new Set();

/**
 * 注入全局样式（幂等）。若已注入则跳过；传入的 `css` 会追加到同一个 style 元素中（只追加一次）。
 * @param {string} [css] 追加的自定义 CSS 文本（可选）
 * @returns {void}
 */
export function injectStyles(css) {
  if (typeof document === 'undefined') return;

  /** @type {HTMLStyleElement|null} */
  let style = /** @type {HTMLStyleElement|null} */ (document.getElementById(STYLE_ID));
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  // 标记基础样式是否已写入（防止 id 冲突导致的重复/缺失）
  if (style.dataset.spBase !== '1') {
    style.dataset.spBase = '1';
    style.textContent = BASE_CSS;
  }
  if (typeof css === 'string' && css.length > 0 && !_extraCss.has(css)) {
    _extraCss.add(css);
    style.appendChild(document.createTextNode('\n' + css));
  }
}

/* ============================================================================
 * DOM 小工具
 * ========================================================================== */

/**
 * 轻量 DOM 构造器。
 * 支持：`class`/`className`、`text`/`textContent`、`html`/`innerHTML`、`style`(对象)、`dataset`(对象)、
 * `attrs`(对象，强制 setAttribute)、`for`、`on*`(事件名小写，如 `onclick`)，其余键优先作为 DOM 属性写入。
 * @param {string} tag 标签名
 * @param {Object<string, any>} [props] 属性/事件
 * @param {Array<Node|string|number|null|undefined>} [children] 子节点或文本
 * @returns {HTMLElement} 创建的元素
 */
export function el(tag, props, children) {
  const node = /** @type {any} */ (document.createElement(tag));
  if (props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value === undefined || value === null) continue;

      if (key === 'class' || key === 'className') { node.className = String(value); continue; }
      if (key === 'text' || key === 'textContent') { node.textContent = String(value); continue; }
      if (key === 'html' || key === 'innerHTML') { node.innerHTML = String(value); continue; }
      if (key === 'for') { node.htmlFor = String(value); continue; }
      if (key === 'style' && typeof value === 'object') { Object.assign(node.style, value); continue; }
      if (key === 'dataset' && typeof value === 'object') { Object.assign(node.dataset, value); continue; }
      if (key === 'attrs' && typeof value === 'object') {
        for (const ak of Object.keys(value)) {
          if (value[ak] === undefined || value[ak] === null) continue;
          node.setAttribute(ak, String(value[ak]));
        }
        continue;
      }
      if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }
      // 真实属性优先（value/checked/disabled/tabIndex...），否则回退到 attribute
      if (key in node) {
        try { node[key] = value; continue; } catch (_) { /* 只读属性，退化为 setAttribute */ }
      }
      node.setAttribute(key, String(value));
    }
  }
  appendAll(node, children);
  return /** @type {HTMLElement} */ (node);
}

/**
 * 追加子节点（字符串自动转文本节点，null/undefined 跳过）。
 * @param {Node} parent
 * @param {Array<Node|string|number|null|undefined>|undefined} children
 * @returns {void}
 */
function appendAll(parent, children) {
  if (!children) return;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/**
 * 清空节点的所有子元素。
 * @param {HTMLElement} node
 * @returns {void}
 */
export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 数值钳制。
 * @param {number} v @param {number} min @param {number} max @returns {number}
 */
function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * 块类名：`sp-<block>`。
 * @param {string} block @returns {string}
 */
function b(block) { return `sp-${block}`; }

/**
 * 元素类名：`sp-<block>__<element>`。
 * @param {string} block @param {string} element @returns {string}
 */
function e(block, element) { return `sp-${block}__${element}`; }

/**
 * 块修饰符类名：`sp-<block>--<modifier>`。
 * @param {string} block @param {string} modifier @returns {string}
 */
function m(block, modifier) { return `sp-${block}--${modifier}`; }

/**
 * 元素修饰符类名：`sp-<block>__<element>--<modifier>`。
 * @param {string} block @param {string} element @param {string} modifier @returns {string}
 */
function em(block, element, modifier) { return `${e(block, element)}--${modifier}`; }

/**
 * 生成带 `sp-` 前缀的类名字符串（构造时使用）。
 * @param {string} block 块名（如 `panel`）
 * @param {string} [element] 元素名（如 `bar`）
 * @param {string[]} [modifiers] 修饰符（如 `draggable`）
 * @returns {string}
 */
function cls(block, element, modifiers) {
  let out = element ? e(block, element) : b(block);
  if (modifiers) {
    for (const mod of modifiers) {
      if (mod) out += ' ' + (element ? em(block, element, mod) : m(block, mod));
    }
  }
  return out;
}

/* ============================================================================
 * Panel —— 浮动面板（可选拖动 / 关闭）
 * ========================================================================== */

/**
 * 浮动面板。默认插入 `document.body`，`position:fixed`，可通过标题栏拖动。
 */
export class Panel {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.title] 标题
   * @param {string} [opts.className] 追加的类名
   * @param {boolean} [opts.draggable] 是否可拖动（标题栏）
   * @param {boolean} [opts.closable] 是否显示关闭按钮
   * @param {number} [opts.x] 初始 left（px）
   * @param {number} [opts.y] 初始 top（px）
   * @param {boolean} [opts.mounted] 是否立即插入 body，默认 true
   */
  constructor(opts = {}) {
    injectStyles();
    this.opts = opts;

    /** 根元素 @type {HTMLElement} */
    this.el = el('div', { class: b('panel') + (opts.className ? ' ' + opts.className : '') });
    /** 标题栏 @type {HTMLElement} */
    this.bar = el('div', { class: cls('panel', 'bar') });
    /** 标题文字 @type {HTMLElement} */
    this.titleEl = el('span', { class: cls('panel', 'title'), text: opts.title || '' });
    this.bar.appendChild(this.titleEl);

    /** 关闭回调（点击关闭按钮时触发） @type {(() => void)|undefined} */
    this.onClose = undefined;

    if (opts.closable) {
      this.closeBtn = el('button', {
        class: cls('panel', 'close'),
        type: 'button',
        title: '关闭',
        'aria-label': '关闭',
        onclick: () => { this.hide(); if (typeof this.onClose === 'function') this.onClose(); },
      }, ['\u00d7']);
      this.bar.appendChild(this.closeBtn);
    }

    /** 内容容器 @type {HTMLElement} */
    this.body = el('div', { class: cls('panel', 'body') + ' sp-scroll' });

    this.el.appendChild(this.bar);
    this.el.appendChild(this.body);

    if (typeof opts.x === 'number') this.el.style.left = opts.x + 'px';
    if (typeof opts.y === 'number') this.el.style.top = opts.y + 'px';

    /** 拖动资源清理函数 @type {(()=>void)|null} */
    this._dragCleanup = null;
    if (opts.draggable) {
      this.el.classList.add(m('panel', 'draggable'));
      this._dragCleanup = this._makeDraggable(this.bar);
    }

    if (opts.mounted !== false && typeof document !== 'undefined' && document.body) {
      document.body.appendChild(this.el);
    }
  }

  /**
   * 让面板可拖动：pointerdown/move/up + setPointerCapture，并钳制在视口内。
   * @param {HTMLElement} handle 拖动把手（标题栏）
   * @returns {()=>void} 清理函数
   * @private
   */
  _makeDraggable(handle) {
    const root = this.el;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false, pointerId = -1;

    /** @param {PointerEvent} ev */
    const onDown = (ev) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      if (ev.target instanceof Element && ev.target.closest('button, a, input, select, textarea')) return;
      const rect = root.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      // 固定成 left/top 定位，避免 auto 造成跳动
      root.style.left = originLeft + 'px';
      root.style.top = originTop + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      startX = ev.clientX;
      startY = ev.clientY;
      dragging = true;
      pointerId = ev.pointerId;
      try { handle.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
      ev.preventDefault();
    };

    /** @param {PointerEvent} ev */
    const onMove = (ev) => {
      if (!dragging || ev.pointerId !== pointerId) return;
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      const maxLeft = Math.max(0, (window.innerWidth || 0) - w);
      const maxTop = Math.max(0, (window.innerHeight || 0) - h);
      const left = clamp(originLeft + (ev.clientX - startX), 0, maxLeft);
      const top = clamp(originTop + (ev.clientY - startY), 0, maxTop);
      root.style.left = left + 'px';
      root.style.top = top + 'px';
    };

    /** @param {PointerEvent} ev */
    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointerdown', onDown);

    /** 视口变化后重新钳制位置 */
    const onResize = () => {
      if (!root.isConnected) return;
      const rect = root.getBoundingClientRect();
      const maxLeft = Math.max(0, (window.innerWidth || 0) - rect.width);
      const maxTop = Math.max(0, (window.innerHeight || 0) - rect.height);
      const left = clamp(rect.left, 0, maxLeft);
      const top = clamp(rect.top, 0, maxTop);
      root.style.left = left + 'px';
      root.style.top = top + 'px';
    };
    window.addEventListener('resize', onResize);

    return () => {
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      window.removeEventListener('resize', onResize);
    };
  }

  /** 是否可见 @returns {boolean} */
  get visible() { return !this.el.classList.contains('sp-hidden'); }

  /**
   * 设置标题。
   * @param {string} t
   * @returns {void}
   */
  setTitle(t) {
    this.titleEl.textContent = t == null ? '' : String(t);
  }

  /** 显示（必要时重新挂载到 body）。 @returns {void} */
  show() {
    this.el.classList.remove('sp-hidden');
    if (!this.el.isConnected && typeof document !== 'undefined' && document.body) {
      document.body.appendChild(this.el);
    }
  }

  /** 隐藏。 @returns {void} */
  hide() { this.el.classList.add('sp-hidden'); }

  /** 显示/隐藏切换。 @returns {void} */
  toggle() { if (this.visible) this.hide(); else this.show(); }

  /** 卸载面板并释放事件。 @returns {void} */
  dispose() {
    if (this._dragCleanup) { this._dragCleanup(); this._dragCleanup = null; }
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

/* ============================================================================
 * Slider —— 滑条（拖动 / 键盘 / 实时数值）
 * ========================================================================== */

/**
 * 带数值显示的滑条。单击或拖动轨道即可调整，聚焦后支持方向键 / Home / End / PageUp / PageDown。
 */
export class Slider {
  /**
   * @param {Object} opts
   * @param {string} opts.label 标签
   * @param {number} opts.min 最小值
   * @param {number} opts.max 最大值
   * @param {number} [opts.step] 步长（<=0 或不给表示连续）
   * @param {number} opts.value 初始值
   * @param {(v:number)=>string} [opts.format] 数值格式化
   * @param {(v:number)=>void} [opts.onInput] 用户输入回调
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    injectStyles();

    this.min = Number.isFinite(o.min) ? o.min : 0;
    this.max = Number.isFinite(o.max) ? o.max : 1;
    if (this.max < this.min) { const t = this.min; this.min = this.max; this.max = t; }
    this.step = Number.isFinite(o.step) && o.step > 0 ? o.step : 0;
    /** 用户输入回调 @type {((v:number)=>void)|undefined} */
    this.onInput = typeof o.onInput === 'function' ? o.onInput : undefined;
    /** 数值格式化 @type {(v:number)=>string} */
    this.format = typeof o.format === 'function'
      ? o.format
      : /** @param {number} v */ (v) => String(Math.round(v * 100) / 100);

    this.el = el('div', { class: cls('slider') });
    this.labelEl = el('span', { class: cls('slider', 'label'), text: o.label || '' });
    this.valueEl = el('span', { class: cls('slider', 'value') });
    this.top = el('div', { class: cls('slider', 'top') }, [this.labelEl, this.valueEl]);

    this.rail = el('div', { class: cls('slider', 'rail') });
    this.fill = el('div', { class: cls('slider', 'fill') });
    this.thumb = el('div', { class: cls('slider', 'thumb') });
    this.track = el('div', {
      class: cls('slider', 'track'),
      tabIndex: 0,
      role: 'slider',
      'aria-label': o.label || 'slider',
    }, [this.rail, this.fill, this.thumb]);

    this.el.appendChild(this.top);
    this.el.appendChild(this.track);

    /** 当前值 @type {number} */
    this._value = this._quantize(Number.isFinite(o.value) ? o.value : this.min);
    this._dragging = false;

    this.track.addEventListener('pointerdown', (ev) => this._onPointerDown(ev));
    this.track.addEventListener('pointermove', (ev) => this._onPointerMove(ev));
    this.track.addEventListener('pointerup', (ev) => this._onPointerUp(ev));
    this.track.addEventListener('pointercancel', (ev) => this._onPointerUp(ev));
    this.track.addEventListener('keydown', (ev) => this._onKeyDown(ev));

    this._render();
  }

  /** 当前值 @returns {number} */
  get value() { return this._value; }
  /** 设置当前值（不触发 onInput） @param {number} v */
  set value(v) { this.set(v); }

  /**
   * 量化到步长（修复浮点误差）。
   * @param {number} v
   * @returns {number}
   * @private
   */
  _quantize(v) {
    let out = Number.isFinite(v) ? clamp(v, this.min, this.max) : this.min;
    if (this.step > 0) {
      out = this.min + Math.round((out - this.min) / this.step) * this.step;
      out = Number(out.toFixed(10));
    }
    return clamp(out, this.min, this.max);
  }

  /**
   * 编程式设值。
   * @param {number} v 新值
   * @param {boolean} [emit] 是否触发 onInput，默认 false
   * @returns {void}
   */
  set(v, emit) {
    const next = this._quantize(Number(v));
    const changed = next !== this._value;
    this._value = next;
    this._render();
    if (emit && changed && this.onInput) this.onInput(this._value);
  }

  /** 刷新 DOM（位置/数值/ARIA）。 @returns {void} @private */
  _render() {
    const span = this.max - this.min;
    const ratio = span > 0 ? (this._value - this.min) / span : 0;
    const pct = clamp(ratio, 0, 1) * 100;
    this.fill.style.width = pct + '%';
    this.thumb.style.left = pct + '%';
    this.valueEl.textContent = this.format(this._value);
    this.track.setAttribute('aria-valuemin', String(this.min));
    this.track.setAttribute('aria-valuemax', String(this.max));
    this.track.setAttribute('aria-valuenow', String(this._value));
    this.track.setAttribute('aria-valuetext', this.valueEl.textContent || '');
  }

  /**
   * 根据鼠标 X 计算并应用数值。
   * @param {PointerEvent|MouseEvent} ev
   * @returns {void}
   * @private
   */
  _applyClientX(ev) {
    const rect = this.track.getBoundingClientRect();
    const ratio = rect.width > 0 ? (ev.clientX - rect.left) / rect.width : 0;
    const raw = this.min + clamp(ratio, 0, 1) * (this.max - this.min);
    this.set(raw, true);
  }

  /** @param {PointerEvent} ev @private */
  _onPointerDown(ev) {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    this._dragging = true;
    this.el.classList.add(m('slider', 'active'));
    try { this.track.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
    this.track.focus({ preventScroll: true });
    this._applyClientX(ev);
    ev.preventDefault();
  }

  /** @param {PointerEvent} ev @private */
  _onPointerMove(ev) {
    if (!this._dragging) return;
    this._applyClientX(ev);
  }

  /** @param {PointerEvent} ev @private */
  _onPointerUp(ev) {
    if (!this._dragging) return;
    this._dragging = false;
    this.el.classList.remove(m('slider', 'active'));
    try { this.track.releasePointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
  }

  /** @param {KeyboardEvent} ev @private */
  _onKeyDown(ev) {
    const big = this.step > 0 ? this.step : (this.max - this.min) / 100;
    let handled = true;
    switch (ev.key) {
      case 'ArrowRight': case 'ArrowUp': this.set(this._value + big, true); break;
      case 'ArrowLeft': case 'ArrowDown': this.set(this._value - big, true); break;
      case 'PageUp': this.set(this._value + big * 10, true); break;
      case 'PageDown': this.set(this._value - big * 10, true); break;
      case 'Home': this.set(this.min, true); break;
      case 'End': this.set(this.max, true); break;
      default: handled = false;
    }
    if (handled) ev.preventDefault();
  }
}

/* ============================================================================
 * Toggle —— 开关
 * ========================================================================== */

/**
 * 开关（role="switch"），支持鼠标点击与 Space / Enter 切换。
 */
export class Toggle {
  /**
   * @param {Object} opts
   * @param {string} opts.label 标签
   * @param {boolean} [opts.value] 初始值
   * @param {(v:boolean)=>void} [opts.onChange] 变化回调
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    injectStyles();

    /** 变化回调 @type {((v:boolean)=>void)|undefined} */
    this.onChange = typeof o.onChange === 'function' ? o.onChange : undefined;
    /** 当前值 @type {boolean} */
    this._value = !!o.value;

    this.el = el('div', {
      class: cls('toggle'),
      tabIndex: 0,
      role: 'switch',
      'aria-checked': String(this._value),
      'aria-label': o.label || 'toggle',
      onclick: () => this.setValue(!this._value, true),
      onkeydown: (/** @type {KeyboardEvent} */ ev) => {
        if (ev.key === ' ' || ev.key === 'Enter' || ev.key === 'Spacebar') {
          ev.preventDefault();
          this.setValue(!this._value, true);
        }
      },
    });

    this.box = el('span', { class: cls('toggle', 'box') }, [el('span', { class: cls('toggle', 'dot') })]);
    this.labelEl = el('span', { class: cls('toggle', 'label'), text: o.label || '' });
    this.el.appendChild(this.box);
    this.el.appendChild(this.labelEl);

    this._render();
  }

  /** 当前值 @returns {boolean} */
  get value() { return this._value; }
  /** 设置当前值（不触发 onChange） @param {boolean} v */
  set value(v) { this.setValue(!!v, false); }

  /**
   * 设置开关状态。
   * @param {boolean} v 新状态
   * @param {boolean} [emit] 是否触发 onChange，默认 false
   * @returns {void}
   */
  setValue(v, emit) {
    const next = !!v;
    const changed = next !== this._value;
    this._value = next;
    this._render();
    if (emit && changed && this.onChange) this.onChange(this._value);
  }

  /** @returns {void} @private */
  _render() {
    this.el.classList.toggle(m('toggle', 'on'), this._value);
    this.el.setAttribute('aria-checked', String(this._value));
  }
}

/* ============================================================================
 * Button —— 按钮
 * ========================================================================== */

/**
 * 按钮。kind: `'primary' | 'ghost' | 'danger'`（不传为基础样式）。
 */
export class Button {
  /**
   * @param {Object} opts
   * @param {string} opts.label 文本
   * @param {()=>void} [opts.onClick] 点击回调
   * @param {'primary'|'ghost'|'danger'} [opts.kind] 样式类型
   * @param {string} [opts.icon] 图标（emoji 或短文本）
   * @param {string} [opts.title] 悬浮提示
   * @param {string} [opts.className] 追加类名
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    injectStyles();

    /** 点击回调 @type {(()=>void)|undefined} */
    this.onClick = typeof o.onClick === 'function' ? o.onClick : undefined;

    /** 根元素（按钮本身） @type {HTMLButtonElement} */
    this.el = /** @type {HTMLButtonElement} */ (el('button', {
      class: b('btn') + (o.kind ? ' ' + m('btn', o.kind) : '') + (o.className ? ' ' + o.className : ''),
      type: 'button',
      title: o.title || o.label || '',
      onclick: (/** @type {Event} */ ev) => {
        ev.stopPropagation();
        if (this.el.disabled) return;
        if (this.onClick) this.onClick();
      },
    }));

    /** 图标元素（若有） @type {HTMLElement|null} */
    this.iconEl = o.icon ? el('span', { class: cls('btn', 'icon'), text: o.icon, 'aria-hidden': 'true' }) : null;
    /** 文本元素 @type {HTMLElement} */
    this.labelEl = el('span', { class: cls('btn', 'label'), text: o.label == null ? '' : String(o.label) });

    if (this.iconEl) this.el.appendChild(this.iconEl);
    this.el.appendChild(this.labelEl);
  }

  /** 是否可用 @returns {boolean} */
  get enabled() { return !this.el.disabled; }

  /**
   * 设置可用状态。
   * @param {boolean} b
   * @returns {void}
   */
  setEnabled(b) {
    const on = !!b;
    this.el.disabled = !on;
    this.el.setAttribute('aria-disabled', String(!on));
  }

  /**
   * 更新文本。
   * @param {string} label
   * @returns {void}
   */
  setLabel(label) {
    this.labelEl.textContent = label == null ? '' : String(label);
  }
}

/* ============================================================================
 * Select —— 下拉选择
 * ========================================================================== */

/**
 * 下拉选择（原生 `<select>`，已套用 HUD 主题）。
 */
export class Select {
  /**
   * @param {Object} opts
   * @param {string} [opts.label] 标签
   * @param {Array<{value:string,label:string}>} opts.options 选项
   * @param {string} [opts.value] 初始值
   * @param {(v:string)=>void} [opts.onChange] 变化回调
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    injectStyles();

    /** 变化回调 @type {((v:string)=>void)|undefined} */
    this.onChange = typeof o.onChange === 'function' ? o.onChange : undefined;
    /** 当前值 @type {string} */
    this._value = o.value == null ? '' : String(o.value);

    this.el = el('div', { class: cls('field') });
    if (o.label) this.el.appendChild(el('span', { class: cls('field', 'label'), text: String(o.label) }));

    /** 原生 select 元素 @type {HTMLSelectElement} */
    this.select = /** @type {HTMLSelectElement} */ (el('select', {
      class: cls('select'),
      onchange: () => {
        this._value = this.select.value;
        if (this.onChange) this.onChange(this._value);
      },
    }));
    this.el.appendChild(this.select);

    this.setOptions(Array.isArray(o.options) ? o.options : []);
  }

  /** 当前值 @returns {string} */
  get value() { return this._value; }
  /** 设置当前值（不触发 onChange） @param {string} v */
  set value(v) { this.setValue(v, false); }

  /**
   * 重设选项列表。
   * @param {Array<{value:string,label:string}>} options
   * @param {boolean} [keepValue] 是否保留当前值，默认 true
   * @returns {void}
   */
  setOptions(options, keepValue) {
    const keep = keepValue !== false ? this._value : '';
    clear(this.select);
    for (const opt of (options || [])) {
      if (!opt) continue;
      this.select.appendChild(el('option', {
        value: opt.value == null ? '' : String(opt.value),
        text: opt.label == null ? String(opt.value) : String(opt.label),
      }));
    }
    let found = false;
    for (let i = 0; i < this.select.options.length; i++) {
      if (this.select.options[i].value === keep) { found = true; break; }
    }
    if (keep && found) this.select.value = keep;
    this._value = this.select.value;
  }

  /**
   * 设值。
   * @param {string} v
   * @param {boolean} [emit] 是否触发 onChange，默认 false
   * @returns {void}
   */
  setValue(v, emit) {
    const next = v == null ? '' : String(v);
    this.select.value = next;
    if (this.select.value !== next && this.select.options.length > 0) {
      // 值不存在时回退到第一项，保证 value 与 DOM 一致
      this.select.selectedIndex = 0;
    }
    const resolved = this.select.value;
    const changed = resolved !== this._value;
    this._value = resolved;
    if (emit && changed && this.onChange) this.onChange(resolved);
  }
}

/* ============================================================================
 * Tabs —— 标签页
 * ========================================================================== */

/**
 * 标签页条。`onChange` 仅在用户点击/键盘切换时触发；`addTab` 也会创建对应的内容容器（`panelFor(id)`）。
 */
export class Tabs {
  /**
   * @param {Object} opts
   * @param {Array<{id:string,label:string}>} opts.tabs 标签
   * @param {(id:string)=>void} [opts.onChange] 切换回调
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    injectStyles();

    /** 切换回调 @type {((id:string)=>void)|undefined} */
    this.onChange = typeof o.onChange === 'function' ? o.onChange : undefined;
    /** 当前激活的标签 id @type {string} */
    this.active = '';

    this.el = el('div', { class: cls('tabs') });
    /** 标签按钮条 @type {HTMLElement} */
    this.strip = el('div', { class: cls('tabs', 'strip'), role: 'tablist' });
    /** 内容容器（可选使用） @type {HTMLElement} */
    this.panels = el('div', { class: cls('tabs', 'panels') });
    this.el.appendChild(this.strip);
    this.el.appendChild(this.panels);

    /** @type {Map<string, {btn:HTMLElement, panel:HTMLElement}>} @private */
    this._tabs = new Map();

    for (const t of (o.tabs || [])) if (t) this.addTab(t);
    if (this._tabs.size > 0) this.setActive(/** @type {string} */ (this._tabs.keys().next().value), false);
  }

  /**
   * 新增标签。
   * @param {{id:string,label:string}} t
   * @returns {void}
   */
  addTab(t) {
    if (!t || t.id == null) return;
    const id = String(t.id);
    if (this._tabs.has(id)) return;

    const btn = el('button', {
      class: cls('tab'),
      type: 'button',
      role: 'tab',
      'data-tab': id,
      text: t.label == null ? id : String(t.label),
      onclick: () => this.setActive(id, true),
      onkeydown: (/** @type {KeyboardEvent} */ ev) => this._onTabKey(ev, id),
    });
    const panel = el('div', { class: cls('tabs', 'panel'), 'data-tab': id, hidden: true });
    this.strip.appendChild(btn);
    this.panels.appendChild(panel);
    this._tabs.set(id, { btn, panel });

    if (!this.active) this.setActive(id, false);
  }

  /**
   * 取某个标签的内容容器（不存在返回 null）。
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  panelFor(id) {
    const entry = this._tabs.get(String(id));
    return entry ? entry.panel : null;
  }

  /**
   * 切换激活标签。
   * @param {string} id
   * @param {boolean} [emit] 是否触发 onChange，默认 false
   * @returns {void}
   */
  setActive(id, emit) {
    const key = String(id);
    if (!this._tabs.has(key)) return;
    const changed = this.active !== key;
    this.active = key;
    for (const [tid, entry] of this._tabs) {
      const on = tid === key;
      entry.btn.classList.toggle(m('tab', 'active'), on);
      entry.btn.setAttribute('aria-selected', String(on));
      entry.btn.tabIndex = on ? 0 : -1;
      entry.panel.hidden = !on;
    }
    if (emit && changed && this.onChange) this.onChange(key);
  }

  /**
   * 标签条键盘导航（左右 + Home/End）。
   * @param {KeyboardEvent} ev
   * @param {string} id
   * @returns {void}
   * @private
   */
  _onTabKey(ev, id) {
    const ids = Array.from(this._tabs.keys());
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    let next = -1;
    if (ev.key === 'ArrowRight') next = (idx + 1) % ids.length;
    else if (ev.key === 'ArrowLeft') next = (idx - 1 + ids.length) % ids.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = ids.length - 1;
    else return;
    ev.preventDefault();
    const target = ids[next];
    this.setActive(target, true);
    const entry = this._tabs.get(target);
    if (entry) entry.btn.focus();
  }
}

/* ============================================================================
 * ListBox —— 可滚动列表
 * ========================================================================== */

/**
 * 可滚动列表（机型 / 地图 / 任务选择）。
 * 每项：`{id, label, sub?, icon?}`；`icon` 为图片地址（http/data/以图片扩展名结尾）时渲染 `<img>`，否则按文本渲染。
 * 键盘：Up/Down 移动高亮，Enter/Space 选中，Home/End 跳转。
 */
export class ListBox {
  /**
   * @param {Object} opts
   * @param {Array<{id:string,label:string,sub?:string,icon?:string}>} opts.items 项目
   * @param {(id:string)=>void} [opts.onChange] 选中回调
   * @param {string} [opts.className] 追加类名
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    injectStyles();

    /** 选中回调 @type {((id:string)=>void)|undefined} */
    this.onChange = typeof o.onChange === 'function' ? o.onChange : undefined;
    /** 当前选中 id @type {string|null} */
    this.selected = null;
    /** 当前数据 @type {Array<{id:string,label:string,sub?:string,icon?:string}>} */
    this.items = [];
    /** 键盘高亮索引 @type {number} */
    this.activeIndex = -1;

    this.el = el('div', {
      class: cls('listbox') + (o.className ? ' ' + o.className : ''),
      tabIndex: 0,
      role: 'listbox',
      'aria-label': o.label || 'list',
      onkeydown: (/** @type {KeyboardEvent} */ ev) => this._onKeyDown(ev),
    });

    this._setItems(Array.isArray(o.items) ? o.items : []);
  }

  /**
   * 重设项目列表（保留当前选中项，若仍存在）。
   * @param {Array<{id:string,label:string,sub?:string,icon?:string}>} items
   * @returns {void}
   */
  setItems(items) { this._setItems(Array.isArray(items) ? items : []); }

  /**
   * 选中某项。**可在 setItems 之前调用**（选中状态会保留，待列表渲染后自动生效）。
   * @param {string} id
   * @param {boolean} [emit] 是否触发 onChange，默认 false
   * @returns {void}
   */
  select(id, emit) {
    const key = id == null ? null : String(id);
    const changed = key !== this.selected;
    this.selected = key;
    if (key !== null) {
      const idx = this.items.findIndex((it) => String(it.id) === key);
      if (idx >= 0) this.activeIndex = idx;
    } else {
      this.activeIndex = -1;
    }
    this._syncSelection();
    if (emit && changed && key !== null && this.onChange) this.onChange(key);
  }

  /**
   * @param {Array<object>} items
   * @returns {void}
   * @private
   */
  _setItems(items) {
    /** @type {Array<{id:string,label:string,sub?:string,icon?:string}>} */
    const normalized = [];
    for (const it of items) {
      if (!it || it.id === undefined || it.id === null) continue;
      // 保留调用方附加的字段（便于用 id 反查业务数据），同时规范化展示字段
      normalized.push(Object.assign({}, it, {
        id: String(it.id),
        label: it.label == null ? String(it.id) : String(it.label),
        sub: it.sub == null ? undefined : String(it.sub),
        icon: it.icon == null ? undefined : String(it.icon),
      }));
    }
    this.items = normalized;

    // 保留仍然存在的选中项
    if (this.selected !== null && !normalized.some((it) => it.id === this.selected)) {
      this.selected = null;
    }
    this.activeIndex = this.selected !== null
      ? normalized.findIndex((it) => it.id === this.selected)
      : (normalized.length > 0 ? 0 : -1);

    clear(this.el);
    if (normalized.length === 0) {
      this.el.appendChild(el('div', { class: cls('list', 'empty'), text: '（暂无可选项）' }));
      return;
    }
    for (const it of normalized) {
      this.el.appendChild(this._buildItem(it));
    }
    this._syncSelection();
  }

  /**
   * 构建单个列表项。
   * @param {{id:string,label:string,sub?:string,icon?:string}} it
   * @returns {HTMLElement}
   * @private
   */
  _buildItem(it) {
    const kids = [];
    if (it.icon) {
      const isImg = /^(https?:|data:|blob:|\/|\.\/|\.\.\/)/.test(it.icon) || /\.(png|jpe?g|gif|webp|svg)$/i.test(it.icon);
      kids.push(el('span', { class: cls('list', 'icon'), 'aria-hidden': 'true' },
        [isImg ? el('img', { src: it.icon, alt: '' }) : it.icon]));
    }
    const texts = [el('span', { class: cls('list', 'label'), text: it.label })];
    if (it.sub) texts.push(el('span', { class: cls('list', 'sub'), text: it.sub }));
    kids.push(el('span', { class: cls('list', 'texts') }, texts));

    return el('button', {
      class: e('list', 'item'),
      type: 'button',
      role: 'option',
      'data-id': it.id,
      'aria-selected': 'false',
      onclick: () => this.select(it.id, true),
    }, kids);
  }

  /**
   * 同步选中/高亮样式（幂等）。
   * @returns {void}
   * @private
   */
  _syncSelection() {
    const itemEls = this.el.querySelectorAll('.' + e('list', 'item'));
    itemEls.forEach((node, i) => {
      const n = /** @type {HTMLElement} */ (node);
      const id = n.getAttribute('data-id');
      const isSel = this.selected !== null && id === this.selected;
      const isActive = i === this.activeIndex;
      n.classList.toggle(em('list', 'item', 'selected'), isSel);
      n.classList.toggle(em('list', 'item', 'active'), isActive && !isSel);
      n.setAttribute('aria-selected', String(isSel));
    });
  }

  /**
   * 键盘导航。
   * @param {KeyboardEvent} ev
   * @returns {void}
   * @private
   */
  _onKeyDown(ev) {
    const count = this.items.length;
    if (count === 0) return;
    let handled = true;
    switch (ev.key) {
      case 'ArrowDown': this._moveActive(1); break;
      case 'ArrowUp': this._moveActive(-1); break;
      case 'Home': this._setActive(0); break;
      case 'End': this._setActive(count - 1); break;
      case 'Enter': case ' ':
      case 'Spacebar': {
        const it = this.items[this.activeIndex] || this.items[0];
        if (it) this.select(it.id, true);
        break;
      }
      default: handled = false;
    }
    if (handled) ev.preventDefault();
  }

  /**
   * 相对移动高亮（在首尾之间环绕，方便连续浏览）。
   * @param {number} delta
   * @returns {void}
   * @private
   */
  _moveActive(delta) {
    const count = this.items.length;
    let next = this.activeIndex < 0 ? 0 : this.activeIndex + delta;
    if (next < 0) next = count - 1;
    if (next >= count) next = 0;
    this._setActive(next);
  }

  /**
   * 设置高亮索引并滚动到可见区域。
   * @param {number} index
   * @returns {void}
   * @private
   */
  _setActive(index) {
    const count = this.items.length;
    if (count === 0) return;
    this.activeIndex = clamp(index, 0, count - 1);
    this._syncSelection();
    const itemEls = this.el.querySelectorAll('.' + e('list', 'item'));
    const node = /** @type {HTMLElement|undefined} */ (itemEls[this.activeIndex]);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }
}

/* ============================================================================
 * Toast —— 顶部提示（静态）
 * ========================================================================== */

/**
 * 屏幕顶部提示。容器懒创建、单例，弹层纵向堆叠（flex + gap）不会互相遮挡。
 */
export class Toast {
  /**
   * 懒创建的单例容器（`position:fixed`，顶部居中）。
   * @returns {HTMLElement}
   */
  static get container() {
    let node = Toast._container;
    if (!node || !node.isConnected) {
      injectStyles();
      node = el('div', {
        class: cls('toasts'),
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'false',
      });
      Toast._container = node;
      if (typeof document !== 'undefined' && document.body) document.body.appendChild(node);
    }
    return node;
  }

  /**
   * 推送一条提示，自动消失，点击可立即关闭。
   * @param {string} message 文本
   * @param {Object} [opts]
   * @param {'info'|'warn'|'success'|'error'} [opts.kind] 类型，默认 'info'
   * @param {number} [opts.duration] 持续毫秒；<=0 表示不自动消失。默认 error 5200，其余 3200
   * @returns {void}
   */
  static push(message, opts) {
    const o = opts || {};
    const kind = o.kind || 'info';
    const duration = typeof o.duration === 'number'
      ? o.duration
      : (kind === 'error' ? 5200 : 3200);

    const node = el('div', {
      class: b('toast') + (kind ? ' ' + m('toast', kind) : ''),
      role: kind === 'error' ? 'alert' : 'status',
    }, [
      el('span', { class: e('toast', 'dot'), 'aria-hidden': 'true' }),
      el('span', { class: e('toast', 'msg'), text: message == null ? '' : String(message) }),
    ]);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      node.classList.add(m('toast', 'out'));
      window.setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 240);
    };

    node.addEventListener('click', dismiss);
    Toast.container.appendChild(node);
    if (duration > 0) window.setTimeout(dismiss, duration);
  }

  /** 清空所有提示。 @returns {void} */
  static clear() {
    if (Toast._container) clear(Toast._container);
  }
}

/** @type {HTMLElement|null} @private */
Toast._container = null;

/* ============================================================================
 * Modal —— 模态对话框
 * ========================================================================== */

/**
 * 当前打开的模态框栈（后进先出，Escape 只关最上层）。
 * @type {Modal[]}
 */
const _modalStack = [];

/**
 * 是否有任意模态框处于打开状态（供 HUD / 输入层判断是否需要屏蔽按键）。
 * @returns {boolean}
 */
export function isModalOpen() {
  return _modalStack.length > 0;
}

/**
 * 文档级键盘处理：Escape 关闭最上层，Tab 做焦点循环。
 * @param {KeyboardEvent} ev
 * @returns {void}
 */
function _onDocumentKeyDown(ev) {
  const top = _modalStack[_modalStack.length - 1];
  if (!top) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    top.close();
  } else if (ev.key === 'Tab') {
    _trapFocus(top.box, ev);
  }
}

/**
 * 简易焦点陷阱：让 Tab 在对话框内部循环。
 * @param {HTMLElement} box
 * @param {KeyboardEvent} ev
 * @returns {void}
 */
function _trapFocus(box, ev) {
  const focusables = box.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusables.length === 0) { ev.preventDefault(); return; }
  const first = /** @type {HTMLElement} */ (focusables[0]);
  const last = /** @type {HTMLElement} */ (focusables[focusables.length - 1]);
  const active = document.activeElement;
  if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  else if (ev.shiftKey && (active === first || !box.contains(active))) { ev.preventDefault(); last.focus(); }
}

/**
 * 模态对话框。自带遮罩（阻断背景交互），Escape 与点击遮罩关闭。
 */
export class Modal {
  /**
   * @param {Object} opts
   * @param {string} opts.title 标题
   * @param {Node|string} opts.content 内容（字符串按纯文本插入；富文本请用 `el()` 构造节点）
   * @param {Array<{label:string,kind?:string,onClick?:()=>void,close?:boolean}>} [opts.buttons] 底部按钮
   * @param {string} [opts.className] 追加到对话框的类名
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    injectStyles();

    /** 关闭回调 @type {(()=>void)|undefined} */
    this.onClose = undefined;
    /** 是否已打开 @type {boolean} */
    this.opened = false;

    /** 根元素（遮罩 + 对话框） @type {HTMLElement} */
    this.root = el('div', { class: cls('modal'), role: 'presentation' });
    this.backdrop = el('div', {
      class: cls('modal', 'backdrop'),
      onclick: () => this.close(),
      // 阻断背景滚动（滚轮只允许在对话框内部生效）
      onwheel: (/** @type {WheelEvent} */ ev) => ev.preventDefault(),
    });

    /** 对话框本体 @type {HTMLElement} */
    this.box = el('div', {
      class: cls('modal', 'box') + (o.className ? ' ' + o.className : ''),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': o.title || '对话框',
    });

    this.bar = el('div', { class: cls('modal', 'bar') }, [
      el('span', { class: cls('modal', 'title'), text: o.title || '' }),
      el('button', {
        class: cls('panel', 'close'),
        type: 'button',
        title: '关闭',
        'aria-label': '关闭',
        onclick: () => this.close(),
      }, ['\u00d7']),
    ]);

    /** 内容容器 @type {HTMLElement} */
    this.body = el('div', { class: cls('modal', 'body') + ' sp-scroll' });

    this.root.appendChild(this.backdrop);
    this.root.appendChild(this.box);
    this.box.appendChild(this.bar);
    this.box.appendChild(this.body);

    // 内容
    const content = o.content;
    if (content instanceof Node) this.body.appendChild(content);
    else if (content !== undefined && content !== null) this.body.appendChild(document.createTextNode(String(content)));

    // 底部按钮
    /** @type {Button[]} */
    this.buttons = [];
    const specs = Array.isArray(o.buttons) ? o.buttons : [];
    if (specs.length > 0) {
      this.footer = el('div', { class: cls('modal', 'footer') });
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i] || { label: '' };
        const kind = spec.kind || (specs.length > 1 ? 'ghost' : 'primary');
        const btn = new Button({
          label: spec.label == null ? '' : String(spec.label),
          kind: /** @type {any} */ (kind),
          onClick: () => {
            if (typeof spec.onClick === 'function') spec.onClick();
            if (spec.close !== false) this.close();
          },
        });
        this.buttons.push(btn);
        this.footer.appendChild(btn.el);
      }
      this.box.appendChild(this.footer);
    } else {
      this.footer = null;
    }

    /** 打开前获得焦点的元素 @type {HTMLElement|null} @private */
    this._prevFocus = null;
  }

  /**
   * 是否有任意模态框打开（等价于 `isModalOpen()`）。
   * @returns {boolean}
   */
  static get isOpen() { return _modalStack.length > 0; }

  /** 打开（插入 body，挂载键盘处理，聚焦首个可聚焦元素）。 @returns {void} */
  open() {
    if (this.opened) return;
    this.opened = true;
    this._prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    document.body.appendChild(this.root);
    this.root.style.zIndex = String(THEME.zModal + _modalStack.length);
    _modalStack.push(this);
    if (_modalStack.length === 1) {
      document.addEventListener('keydown', _onDocumentKeyDown, true);
    }
    const target = this.footer && this.buttons.length > 0
      ? this.buttons[this.buttons.length - 1].el
      : /** @type {HTMLElement|null} */ (this.box.querySelector('[tabindex], button, input, select, textarea'));
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  /** 关闭（移除 DOM，恢复焦点，触发 onClose）。 @returns {void} */
  close() {
    if (!this.opened) return;
    this.opened = false;
    const idx = _modalStack.indexOf(this);
    if (idx >= 0) _modalStack.splice(idx, 1);
    if (_modalStack.length === 0) {
      document.removeEventListener('keydown', _onDocumentKeyDown, true);
    }
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (this._prevFocus && this._prevFocus.isConnected && typeof this._prevFocus.focus === 'function') {
      this._prevFocus.focus({ preventScroll: true });
    }
    this._prevFocus = null;
    if (typeof this.onClose === 'function') this.onClose();
  }
}

/* ============================================================================
 * Loading —— 全屏加载遮罩
 * ========================================================================== */

/**
 * 全屏加载遮罩。可先于任何其他组件调用（自身懒创建 DOM 与样式）。
 */
export class Loading {
  /**
   * 懒创建遮罩 DOM。
   * @returns {void}
   * @private
   */
  static _ensure() {
    if (Loading._root && Loading._root.isConnected) return;
    injectStyles();

    Loading._textEl = el('div', { class: e('loading', 'text'), text: '' });
    Loading._fill = el('div', { class: e('loading', 'fill') });
    Loading._bar = el('div', { class: e('loading', 'bar') }, [Loading._fill]);
    Loading._root = el('div', { class: b('loading') + ' sp-hidden', role: 'progressbar', 'aria-label': '加载中' }, [
      el('div', { class: e('loading', 'spinner'), 'aria-hidden': 'true' }),
      Loading._textEl,
      Loading._bar,
    ]);
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(Loading._root);
  }

  /**
   * 显示遮罩（不确定进度动画）。
   * @param {string} [text] 文本，默认 "加载中…"
   * @returns {void}
   */
  static show(text) {
    Loading._ensure();
    const root = /** @type {HTMLElement} */ (Loading._root);
    root.classList.remove('sp-hidden');
    root.classList.add(m('loading', 'indeterminate'));
    if (Loading._textEl) Loading._textEl.textContent = text == null ? '加载中…' : String(text);
    if (Loading._fill) Loading._fill.style.width = '0%';
    Loading._pct = 0;
  }

  /**
   * 更新进度（0..1）。自动切换到确定进度条并显示百分比。
   * @param {number} p01 进度 0..1
   * @param {string} [text] 同时更新文本
   * @returns {void}
   */
  static progress(p01, text) {
    Loading._ensure();
    const root = /** @type {HTMLElement} */ (Loading._root);
    root.classList.remove('sp-hidden');
    root.classList.remove(m('loading', 'indeterminate'));
    const p = clamp(Number.isFinite(p01) ? p01 : 0, 0, 1);
    Loading._pct = p;
    if (Loading._fill) Loading._fill.style.width = (p * 100).toFixed(1) + '%';
    if (text !== undefined && Loading._textEl) Loading._textEl.textContent = String(text);
    root.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  }

  /** 隐藏遮罩（DOM 保留，复用）。 @returns {void} */
  static hide() {
    if (!Loading._root) return;
    /** @type {HTMLElement} */ (Loading._root).classList.add('sp-hidden');
  }

  /** 是否正在显示 @returns {boolean} */
  static get visible() {
    return !!Loading._root && Loading._root.isConnected && !Loading._root.classList.contains('sp-hidden');
  }

  /** 当前进度（0..1，最后一次 progress 的值） @returns {number} */
  static get percent() { return Loading._pct; }
}

/** @type {HTMLElement|null} @private */
Loading._root = null;
/** @type {HTMLElement|null} @private */
Loading._bar = null;
/** @type {HTMLElement|null} @private */
Loading._fill = null;
/** @type {HTMLElement|null} @private */
Loading._textEl = null;
/** @type {number} @private */
Loading._pct = 0;

/* ============================================================================
 * 默认导出（方便整体使用）
 * ========================================================================== */

export default {
  injectStyles,
  THEME,
  el,
  clear,
  isModalOpen,
  Panel,
  Slider,
  Toggle,
  Button,
  Select,
  Tabs,
  ListBox,
  Toast,
  Modal,
  Loading,
};
