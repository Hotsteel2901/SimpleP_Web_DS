/**
 * 界面流程：主菜单 / 地图选择 / 任务选择 / 设置 / 暂停 / 结算
 * 全部基于 widgets.js 构建，纯 DOM 覆盖层。
 */
import * as THREE from 'three';
import { el, clear, Panel, Slider, Toggle, Button, Select, Tabs, ListBox, Toast, Modal, Loading, injectStyles, THEME } from './widgets.js';
import { MAPS, GAME_MODES, getMap } from '../world/maps.js';
import { stockCrafts } from '../build/crafts.js';
import { audio } from '../audio/audio.js';
import { fmt, fmtTime, formatMoney, clamp } from '../core/util.js';

/** 源代码仓库地址（AGPL 第 13 条要求向网络使用者提供） */
export const SOURCE_URL = 'https://github.com/Hotsteel2901/SimpleP_Web_DS';

const EXTRA_CSS = `
.sp2-card--action .sp2-card__icon { font-size: 20px; margin-right: 8px; }
.sp2-card--action .sp2-card__text { display: block; }
.sp2-card--action .sp2-card__chev { display: none; }
.sp2-card--action { display: flex; align-items: center; }
.sp2-card--action .sp2-card__text { flex: 1 1 auto; }
/* ---------------- 移动端：单列大按钮列表（对齐原版手机版观感） ---------------- */
body.sp2-touch-device .sp2-menu { align-items: flex-start; overflow-y: auto; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
body.sp2-touch-device .sp2-menu__inner { width: 100%; max-width: 720px; margin: 0 auto; padding: calc(12px + env(safe-area-inset-top)) 14px calc(20px + env(safe-area-inset-bottom)); }
body.sp2-touch-device .sp2-title { font-size: 26px !important; margin-bottom: 2px; }
body.sp2-touch-device .sp2-sub { font-size: 11px; margin-bottom: 14px; }
body.sp2-touch-device .sp2-grid { grid-template-columns: 1fr !important; gap: 10px; }
body.sp2-touch-device .sp2-card {
  border-radius: 14px; min-height: 60px; padding: 14px 16px;
  background: linear-gradient(180deg, rgba(16,30,46,.92), rgba(10,18,28,.92));
}
body.sp2-touch-device .sp2-card--action {
  display: flex; align-items: center; gap: 14px; min-height: 72px;
}
body.sp2-touch-device .sp2-card--action:active { transform: scale(.98); border-color: #00d0ff; background: rgba(0,208,255,.14); }
body.sp2-touch-device .sp2-card__icon { font-size: 26px; width: 42px; text-align: center; flex: 0 0 42px; }
body.sp2-touch-device .sp2-card__text { flex: 1 1 auto; min-width: 0; }
body.sp2-touch-device .sp2-card__chev { color: #4d7288; font-size: 26px; line-height: 1; flex: 0 0 auto; }
body.sp2-touch-device .sp2-card__title { font-size: 16px; margin-bottom: 2px; }
body.sp2-touch-device .sp2-card__desc { font-size: 12px; line-height: 1.45; }
body.sp2-touch-device .sp2-card__tags { margin-top: 6px; }
body.sp2-touch-device .sp2-tag { font-size: 10px; padding: 3px 8px; }
/* 底部操作条：主按钮固定在拇指可及处 */
body.sp2-touch-device .sp2-row { gap: 10px; }
body.sp2-touch-device .sp-btn { min-height: 46px; font-size: 15px; padding: 12px 18px; border-radius: 12px; }
body.sp2-touch-device .sp-btn--primary { flex: 1 1 100%; }
body.sp2-touch-device .sp-slider__track { height: 30px; }
body.sp2-touch-device .sp-slider input[type=range]::-webkit-slider-thumb { width: 26px; height: 26px; }
body.sp2-touch-device .sp-panel { border-radius: 14px; }
body.sp2-touch-device .sp-panel__bar { min-height: 44px; font-size: 15px; }
body.sp2-touch-device .sp-list__item { min-height: 52px; font-size: 15px; }
body.sp2-touch-device .sp-modal__body { max-height: 62vh; }
body.sp2-touch-device input[type=text], body.sp2-touch-device input[type=number], body.sp2-touch-device input[type=password], body.sp2-touch-device select {
  min-height: 44px; font-size: 16px;   /* 16px 可避免 iOS 聚焦时自动放大 */
}

.sp2-menu { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; z-index:40;
  background: radial-gradient(120% 90% at 50% 10%, rgba(10,26,44,.72) 0%, rgba(4,8,14,.92) 60%, rgba(2,4,8,.98) 100%); }
.sp2-menu__inner { width:min(1080px, 94vw); max-height:92vh; overflow:auto; }
.sp2-title { font-size: clamp(28px, 5vw, 56px); font-weight: 800; letter-spacing:.06em; margin:0 0 4px; color:#eaf6ff;
  text-shadow: 0 0 26px rgba(0,208,255,.5), 0 2px 0 rgba(0,0,0,.6); }
.sp2-sub { color:#8fb6cc; margin:0 0 22px; letter-spacing:.18em; text-transform:uppercase; font-size:12px; }
.sp2-row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
.sp2-col { display:flex; flex-direction:column; gap:10px; }
.sp2-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(230px,1fr)); gap:12px; }
.sp2-card { background:rgba(10,16,24,.72); border:1px solid rgba(0,208,255,.22); border-radius:10px; padding:12px 14px;
  cursor:pointer; transition:.15s; position:relative; overflow:hidden; }
.sp2-card:hover { border-color:rgba(0,208,255,.7); transform:translateY(-2px); background:rgba(14,26,40,.82); }
.sp2-card--sel { border-color:#00d0ff; box-shadow:0 0 0 1px rgba(0,208,255,.5), 0 0 24px rgba(0,208,255,.2) inset; }
.sp2-card--locked { opacity:.5; cursor:not-allowed; }
.sp2-card__title { font-weight:700; font-size:15px; color:#eaf6ff; margin-bottom:4px; display:flex; justify-content:space-between; gap:8px; }
.sp2-card__desc { font-size:12px; color:#9bb6c8; line-height:1.5; }
.sp2-card__tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.sp2-tag { font-size:10px; padding:2px 7px; border-radius:20px; background:rgba(0,208,255,.14); color:#8fdfff; border:1px solid rgba(0,208,255,.25); }
.sp2-big-btn { font-size:16px; padding:12px 26px; }
.sp2-hero { display:flex; gap:20px; align-items:flex-start; }
.sp2-kv { font-size:12px; color:#9bb6c8; display:flex; gap:8px; }
.sp2-kv b { color:#eaf6ff; font-weight:600; }
.sp2-hint { font-size:12px; color:#7fa0b4; margin-top:12px; }
.sp2-logo-plane { font-size:40px; filter: drop-shadow(0 0 12px rgba(0,208,255,.6)); }
.sp2-best { color:#ffd166; font-size:12px; }
`;

export class UI {
  /**
   * @param {object} app 主程序（提供 startFlight / openBuilder / quitToMenu 等）
   */
  constructor(app) {
    this.app = app;
    injectStyles(EXTRA_CSS);
    this.root = el('div', { class: 'sp2-menu', style: { display: 'none' } });
    // 挂到 #ui 内（而不是 body）：这样与建造器同处一个层叠上下文，
    // 建造器 z-index 60 > 菜单 40 时能正常盖住菜单，不会互相打架
    const host = document.getElementById('ui') || document.body;
    host.appendChild(this.root);
    this.inner = el('div', { class: 'sp2-menu__inner' });
    this.root.appendChild(this.inner);
    this.screen = null;
    this.selectedMap = 'archipelago';
    this.selectedMission = 0;
    this.selectedCraft = null;
    this.settingsPanel = null;
  }

  hide() { this.root.style.display = 'none'; this.screen = null; this._hidden = true; }
  get currentScreen() { return this.screen; }
  get visible() { return this.root.style.display !== 'none'; }
  isVisible() { return this.visible; }
  show(name) {
    this.root.style.display = 'flex';
    this.root.style.touchAction = 'pan-y';
    this.screen = name;
    clear(this.inner);
    // 移动端：切屏后回到顶部，否则新界面会停在上一屏的滚动位置
    try { this.root.scrollTop = 0; this.inner.scrollTop = 0; } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------ 主菜单 */
  mainMenu() {
    this.show('main');
    const prof = this.app.save.profile;
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { alignItems: 'center', gap: '18px' } }, [
      el('div', { class: 'sp2-logo-plane', text: '✈' }),
      el('div', {}, [
        el('h1', { class: 'sp2-title', text: 'SIMPLEPLANES 2' }),
        el('p', { class: 'sp2-sub', text: 'THREE.JS EDITION · 建造 · 飞行 · 探索' }),
      ]),
    ]));
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginBottom: '8px' } }, [
      el('span', { class: 'sp2-kv', html: `<span>💰</span><b>${formatMoney(prof.money)}</b>` }),
      el('span', { class: 'sp2-kv', html: `<span>⭐</span><b>等级 ${prof.level}</b>` }),
      el('span', { class: 'sp2-kv', html: `<span>🛩</span><b>${prof.customCrafts.length} 架自建机型</b>` }),
      el('span', { class: 'sp2-kv', html: `<span>🕒</span><b>飞行 ${Math.round(prof.stats.flightTime / 60)} 分钟</b>` }),
    ]));

    const grid = el('div', { class: 'sp2-grid', style: { marginTop: '18px' } });
    const mk = (icon, title, desc, fn, kind) => {
      const c = el('div', { class: 'sp2-card sp2-card--action' }, [
        el('div', { class: 'sp2-card__icon', text: icon }),
        el('div', { class: 'sp2-card__text' }, [
          el('div', { class: 'sp2-card__title', text: title }),
          el('div', { class: 'sp2-card__desc', text: desc }),
        ]),
        el('div', { class: 'sp2-card__chev', text: '›' }),
      ]);
      c.onclick = () => { audio.sfx('click'); fn(); };
      c.onmouseenter = () => audio.sfx('hover', { volume: 0.35 });
      return c;
    };
    grid.appendChild(mk('▶', '开始飞行', '选择地图与任务，驾驶你的飞机出发。', () => this.mapSelect()));
    grid.appendChild(mk('🔧', '机库 / 建造', '用程序化零件拼出任何能飞的东西。', () => this.app.openBuilder()));
    grid.appendChild(mk('⚙', '设置', '画质、音量、操纵方式与单位。', () => this.settings()));
    grid.appendChild(mk('📖', '操作说明', '键位表与飞行小贴士。', () => this.help()));
    grid.appendChild(mk('📦', '载具库', '浏览库存机型与自建机型。', () => this.craftLibrary()));
    grid.appendChild(mk('🌐', '联机对战', 'P2P 直连（打洞失败自动走公网中继），最多 15 人同乐。', () => this.multiplayer()));
    this.inner.appendChild(grid);

    this.inner.appendChild(el('p', { class: 'sp2-hint', text: '提示：鼠标瞄准模式下，把光标拖离中心即可操纵飞机；机库中可随时改装。' }));
    this.inner.appendChild(el('p', { class: 'sp2-hint', style: { opacity: '.6' }, text: '这是一个用 three.js 从零复刻的粉丝作品：全部地形、模型、音乐与音效均为程序化生成，无任何外部资源。' }));
    // AGPL 第 13 条：网络交互作品必须让使用者能找到源代码
    this.inner.appendChild(el('p', { class: 'sp2-hint', style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('a', {
        href: SOURCE_URL, target: '_blank', rel: 'noopener',
        style: { color: '#8fdfff', textDecoration: 'underline', pointerEvents: 'auto' },
        text: '源代码（AGPL-3.0-or-later）',
      }),
      el('span', { text: 'Copyright (C) 2026 Hotsteel2901 · 本程序不提供任何担保' }),
    ]));
  }

  /* ------------------------------------------------------------ 地图选择 */
  mapSelect() {
    this.show('maps');
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '32px' }, text: '选择地图' }));
    this.inner.appendChild(el('p', { class: 'sp2-sub', text: '每张地图都有独立地形、地标与可用玩法' }));
    const grid = el('div', { class: 'sp2-grid' });
    for (const m of MAPS) {
      const owned = this.app.save.profile.unlockedMaps.includes(m.id);
      const card = el('div', { class: `sp2-card${this.selectedMap === m.id ? ' sp2-card--sel' : ''}${owned ? '' : ' sp2-card--locked'}` }, [
        el('div', { class: 'sp2-card__title' }, [el('span', { text: m.name }), el('span', { style: { fontSize: '11px', color: '#7fa0b4' }, text: m.nameEn })]),
        el('div', { class: 'sp2-card__desc', text: m.desc }),
        el('div', { class: 'sp2-card__tags' }, m.tags.map((t) => el('span', { class: 'sp2-tag', text: t }))),
        el('div', { class: 'sp2-card__tags' }, m.missions.map((ms) => el('span', { class: 'sp2-tag', style: { background: 'rgba(255,159,67,.14)', color: '#ffc48a', borderColor: 'rgba(255,159,67,.3)' }, text: (GAME_MODES[ms.mode]?.icon || '') + ' ' + (GAME_MODES[ms.mode]?.name || ms.mode) }))),
      ]);
      card.onclick = () => {
        audio.sfx('click');
        if (!owned) { Toast.push(`需要 ${formatMoney(m.unlockCost)} 解锁（当前为演示版，可直接进入）`, { kind: 'warn' }); }
        this.selectedMap = m.id;
        this.mapSelect();
      };
      card.ondblclick = () => { this.selectedMap = m.id; this.missionSelect(); };
      card.onmouseenter = () => audio.sfx('hover', { volume: 0.3 });
      grid.appendChild(card);
    }
    this.inner.appendChild(grid);
    const map = getMap(this.selectedMap);
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '18px' } }, [
      new Button({ label: '下一步：选择任务 →', kind: 'primary', onClick: () => this.missionSelect() }).el,
      new Button({ label: '← 返回', kind: 'ghost', onClick: () => this.mainMenu() }).el,
    ]));
  }

  /* ------------------------------------------------------------ 任务与机型 */
  missionSelect() {
    this.show('mission');
    const map = getMap(this.selectedMap);
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '30px' }, text: `${map.name} · 选择玩法` }));
    this.inner.appendChild(el('p', { class: 'sp2-sub', text: map.desc }));

    const list = el('div', { class: 'sp2-grid', style: { marginBottom: '18px' } });
    map.missions.forEach((ms, i) => {
      const info = GAME_MODES[ms.mode] || {};
      const best = this.app.save.getBest(map.id, ms.mode);
      const card = el('div', { class: `sp2-card${this.selectedMission === i ? ' sp2-card--sel' : ''}` }, [
        el('div', { class: 'sp2-card__title' }, [el('span', { text: `${info.icon || ''} ${info.name || ms.mode}` })]),
        el('div', { class: 'sp2-card__desc', text: info.desc || '' }),
        best ? el('div', { class: 'sp2-best', text: `最佳：${best.time != null ? fmtTime(best.time) : ''} ${best.score != null ? best.score + ' 分' : ''}` }) : el('div', { class: 'sp2-card__desc', style: { opacity: .5 }, text: '尚无记录' }),
      ]);
      card.onclick = () => { audio.sfx('click'); this.selectedMission = i; this.missionSelect(); };
      card.onmouseenter = () => audio.sfx('hover', { volume: 0.3 });
      list.appendChild(card);
    });
    this.inner.appendChild(list);

    // 机型选择
    const crafts = this.app.allCrafts();
    if (!this.selectedCraft || !crafts.find((c) => c.id === this.selectedCraft)) this.selectedCraft = crafts[0]?.id;
    this.inner.appendChild(el('h3', { style: { color: '#eaf6ff', margin: '6px 0' }, text: '选择机型' }));
    const cl = new ListBox({
      items: crafts.map((c) => ({ id: c.id, label: c.name, sub: `${c.parts.length} 个零件 · ${c.builtin ? '库存' : '自建'}`, craft: c })),
      onChange: (id) => { this.selectedCraft = id; audio.sfx('click'); this._updateCraftInfo(); },
      className: 'sp-scroll',
    });
    cl.select(this.selectedCraft);
    cl.el.style.maxHeight = '230px';
    this.inner.appendChild(cl.el);
    this.craftInfo = el('div', { class: 'sp2-card__desc', style: { marginTop: '10px', minHeight: '40px' } });
    this.inner.appendChild(this.craftInfo);
    this._updateCraftInfo();

    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '16px' } }, [
      new Button({ label: '🛫 起飞！', kind: 'primary', onClick: () => this.app.startFlight(this.selectedCraft, this.selectedMap, map.missions[this.selectedMission]) }).el,
      new Button({ label: '🔧 先在机库里改装', kind: 'ghost', onClick: () => this.app.openBuilder(crafts.find((c) => c.id === this.selectedCraft)) }).el,
      new Button({ label: '← 返回', kind: 'ghost', onClick: () => this.mapSelect() }).el,
      new Toggle({ label: '空中出生', value: this.app.airStart, onChange: (v) => { this.app.airStart = v; } }).el,
    ]));
  }

  _updateCraftInfo() {
    if (!this.craftInfo) return;
    const c = this.app.allCrafts().find((x) => x.id === this.selectedCraft);
    if (!c) { this.craftInfo.textContent = '未选择机型'; return; }
    const s = this.app.craftStats(c);
    this.craftInfo.innerHTML = `<b style="color:#eaf6ff">${c.name}</b> — ${c.desc || ''}<br>
      质量 ${s.mass.toFixed(0)} kg · 翼载 ${s.wingLoading === Infinity ? '--' : s.wingLoading.toFixed(1) + ' kg/m²'} · 推重比 ${(s.thrust / Math.max(1, s.mass * 9.81)).toFixed(2)} ·
      推力 ${s.thrust.toFixed(0)} N · 燃油 ${s.fuel.toFixed(0)} L · 零件 ${s.partCount}`;
  }

  /* ------------------------------------------------------------ 载具库 */
  craftLibrary() {
    this.show('library');
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '30px' }, text: '载具库' }));
    const crafts = this.app.allCrafts();
    const grid = el('div', { class: 'sp2-grid' });
    for (const c of crafts) {
      const s = this.app.craftStats(c);
      const card = el('div', { class: 'sp2-card' }, [
        el('div', { class: 'sp2-card__title' }, [el('span', { text: c.name }), el('span', { style: { fontSize: '11px', color: '#7fa0b4' }, text: c.builtin ? '库存' : '自建' })]),
        el('div', { class: 'sp2-card__desc', text: c.desc || '' }),
        el('div', { class: 'sp2-card__tags' }, [
          el('span', { class: 'sp2-tag', text: `${s.partCount} 零件` }),
          el('span', { class: 'sp2-tag', text: `${s.mass.toFixed(0)} kg` }),
          el('span', { class: 'sp2-tag', text: `${s.thrust.toFixed(0)} N` }),
        ]),
      ]);
      card.onclick = () => { audio.sfx('click'); this.app.openBuilder(c); };
      grid.appendChild(card);
    }
    this.inner.appendChild(grid);
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '16px' } }, [
      new Button({ label: '＋ 新建机型', kind: 'primary', onClick: () => this.app.openBuilder() }).el,
      new Button({ label: '← 返回', kind: 'ghost', onClick: () => this.mainMenu() }).el,
    ]));
  }

  /* ------------------------------------------------------------ 设置 */
  settings() {
    this.show('settings');
    const st = this.app.save.settings;
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '30px' }, text: '设置' }));
    const grid = el('div', { class: 'sp2-grid' });
    const col1 = el('div', { class: 'sp2-col' });
    col1.appendChild(new Select({
      label: '画质', value: String(st.quality),
      options: [{ value: '0', label: '低（省电）' }, { value: '1', label: '中（推荐）' }, { value: '2', label: '高（阴影+更多细节）' }],
      onChange: (v) => { st.quality = Number(v); this.app.save.save(); this.app.applySettings(); },
    }).el);
    col1.appendChild(new Toggle({ label: '阴影', value: st.shadows, onChange: (v) => { st.shadows = v; this.app.save.save(); this.app.applySettings(); } }).el);
    col1.appendChild(new Toggle({ label: '显示 HUD', value: st.showHud, onChange: (v) => { st.showHud = v; this.app.save.save(); } }).el);
    col1.appendChild(new Toggle({ label: '显示 FPS', value: st.showFps, onChange: (v) => { st.showFps = v; this.app.save.save(); } }).el);
    col1.appendChild(new Toggle({ label: '反转俯仰', value: st.invertPitch, onChange: (v) => { st.invertPitch = v; this.app.input.invertPitch = v; this.app.save.save(); } }).el);
    const col2 = el('div', { class: 'sp2-col' });
    col2.appendChild(new Select({
      label: '操纵方式', value: st.controlMode,
      options: [
        { value: 'mouse', label: '鼠标瞄准（推荐）' },
        { value: 'keys', label: '键盘' },
        { value: 'touch', label: '触屏（移动端）' },
      ],
      onChange: (v) => { st.controlMode = v; this.app.input.mode = v; this.app.save.save(); this.app.showTouchControls?.(v === 'touch' && this.app.state === 'flight'); },
    }).el);
    col2.appendChild(new Slider({ label: '鼠标灵敏度', min: 0.2, max: 2.5, step: 0.05, value: st.sensitivity, format: (v) => v.toFixed(2), onInput: (v) => { st.sensitivity = v; this.app.input.sensitivity = v; this.app.save.save(); } }).el);
    col2.appendChild(new Slider({ label: '飞行辅助', min: 0, max: 1, step: 0.05, value: st.assist, format: (v) => (v * 100).toFixed(0) + '%', onInput: (v) => { st.assist = v; this.app.save.save(); if (this.app.game?.player) this.app.game.player.assist = v; } }).el);
    col2.appendChild(new Select({
      label: '单位', value: st.units, options: [{ value: 'metric', label: '公制 (km/h, m)' }, { value: 'imperial', label: '英制 (kt, ft)' }],
      onChange: (v) => { st.units = v; this.app.save.save(); },
    }).el);
    const col3 = el('div', { class: 'sp2-col' });
    col3.appendChild(new Slider({ label: '主音量', min: 0, max: 1, step: 0.02, value: st.masterVolume, format: (v) => (v * 100).toFixed(0) + '%', onInput: (v) => { st.masterVolume = v; audio.setMasterVolume(v); this.app.save.save(); } }).el);
    col3.appendChild(new Slider({ label: '音乐音量', min: 0, max: 1, step: 0.02, value: st.musicVolume, format: (v) => (v * 100).toFixed(0) + '%', onInput: (v) => { st.musicVolume = v; audio.setMusicVolume(v); this.app.save.save(); } }).el);
    col3.appendChild(new Slider({ label: '音效音量', min: 0, max: 1, step: 0.02, value: st.sfxVolume, format: (v) => (v * 100).toFixed(0) + '%', onInput: (v) => { st.sfxVolume = v; audio.setSfxVolume(v); this.app.save.save(); } }).el);
    col3.appendChild(new Toggle({ label: '静音', value: st.muted, onChange: (v) => { st.muted = v; audio.setMuted(v); this.app.save.save(); } }).el);
    const col4 = el('div', { class: 'sp2-col' });
    col4.appendChild(new Button({ label: '重置全部进度', kind: 'danger', onClick: () => { new Modal({ title: '确认重置？', content: '所有金钱、自建机型与最佳成绩都会被清除。', buttons: [{ label: '取消', kind: 'ghost' }, { label: '确认重置', kind: 'danger', onClick: () => { this.app.save.reset(); this.app.applySettings(); Toast.push('已重置', { kind: 'success' }); this.mainMenu(); } }] }).open(); } }).el);
    col4.appendChild(new Button({ label: '恢复默认键位', kind: 'ghost', onClick: () => { this.app.input.bindings = JSON.parse(JSON.stringify(this.app.input.bindings)); this.app.input.saveBindings(); } }).el);
    // 联机服务器地址（留空 = 同源 /ws）
    const srv = el('input', {
      type: 'text', value: st.serverUrl || '', placeholder: 'wss://你的服务器/ws（留空=同源）',
      style: { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff', fontSize: '12px' },
    });
    srv.addEventListener('change', () => { st.serverUrl = srv.value.trim(); this.app.save.save(); Toast.push('联机服务器地址已保存', { kind: 'success' }); });
    col4.appendChild(el('label', { class: 'sp2-card__desc', text: '联机服务器（信令 + 公网中继）' }));
    col4.appendChild(srv);
    // 自建 TURN（可选，用于对称 NAT 下也走 P2P）
    const turn = el('input', {
      type: 'text', value: st.turnUrl || '', placeholder: 'turn:host:3478（可选）',
      style: { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff', fontSize: '12px' },
    });
    const turnUser = el('input', {
      type: 'text', value: st.turnUser || '', placeholder: 'TURN 用户名',
      style: { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff', fontSize: '12px' },
    });
    const turnPass = el('input', {
      type: 'password', value: st.turnCred || '', placeholder: 'TURN 密码',
      style: { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff', fontSize: '12px' },
    });
    const saveTurn = () => {
      st.turnUrl = turn.value.trim(); st.turnUser = turnUser.value.trim(); st.turnCred = turnCred0();
      this.app.save.save();
      if (st.turnUrl) this.app.mp?.net?.setIceServers([{ urls: st.turnUrl, username: st.turnUser, credential: st.turnCred }]);
      Toast.push('TURN 设置已保存', { kind: 'success' });
    };
    const turnCred0 = () => turnPass.value;
    for (const inp of [turn, turnUser, turnPass]) inp.addEventListener('change', saveTurn);
    col4.appendChild(el('label', { class: 'sp2-card__desc', text: '自建 TURN（可选）' }));
    col4.appendChild(turn); col4.appendChild(turnUser); col4.appendChild(turnPass);
    grid.append(col1, col2, col3, col4);
    this.inner.appendChild(grid);
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '18px' } }, [
      new Button({ label: '← 返回', kind: 'primary', onClick: () => (this.app.state === 'flight' ? this.pause() : this.mainMenu()) }).el,
    ]));
  }

  /* ------------------------------------------------------------ 帮助 */
  help() {
    this.show('help');
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '30px' }, text: '操作说明' }));
    const rows = [
      ['W / S / ↑ / ↓', '俯仰（低头 / 抬头）'],
      ['A / D / ← / →', '滚转（左 / 右）'],
      ['Q / E', '方向舵（偏航）'],
      ['Shift / Ctrl', '加 / 减油门（滚轮也可以）'],
      ['空格', '刹车'],
      ['G', '起落架收放'],
      ['[ / ]', '襟翼收放'],
      ['B', '减速板'],
      ['F / 左键', '机炮'],
      ['R / 右键', '发射导弹'],
      ['V', '投弹'],
      ['Z', '干扰弹'],
      ['X', '开伞'],
      ['C', '切换视角（追尾 / 座舱 / 环绕）'],
      ['Y', '回到出生点'],
      ['Esc', '暂停菜单'],
      ['L', '飞行辅助开关'],
    ];
    const tbl = el('div', { class: 'sp2-grid' });
    for (const [k, v] of rows) tbl.appendChild(el('div', { class: 'sp2-card' }, [
      el('div', { class: 'sp2-card__title', text: k }), el('div', { class: 'sp2-card__desc', text: v }),
    ]));
    this.inner.appendChild(tbl);
    this.inner.appendChild(el('p', { class: 'sp2-hint', html: '<b>飞行小贴士</b>：起飞前把油门推满，速度接近失速速度的 1.2 倍时轻拉杆抬轮；转弯时先滚转再拉杆；失速时松杆、推头、加油门恢复速度。' }));
    this.inner.appendChild(el('p', { class: 'sp2-hint', html: '<b>建造小贴士</b>：机翼气动中心要在重心之后，否则飞机不稳定；机库里有“自动配平”按钮。翼载越低越容易飞，推重比 > 0.3 才能顺畅起飞。' }));
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '16px' } }, [
      new Button({ label: '← 返回', kind: 'primary', onClick: () => this.mainMenu() }).el,
    ]));
  }

  /* ------------------------------------------------------------ 暂停 */
  pause(game) {
    this.show('pause');
    this.app.input.enabled = false;
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '34px' }, text: '已暂停' }));
    const m = game?.mission;
    if (m) {
      this.inner.appendChild(el('p', { class: 'sp2-sub', text: `${m.name} · ${m.objective}` }));
    }
    const col = el('div', { class: 'sp2-row' });
    col.appendChild(new Button({ label: '▶ 继续飞行', kind: 'primary', onClick: () => this.resume() }).el);
    col.appendChild(new Button({ label: '🔧 机库', kind: 'ghost', onClick: () => this.app.openBuilder(this.app.currentCraft, true) }).el);
    col.appendChild(new Button({ label: '↻ 重新开始', kind: 'ghost', onClick: () => this.app.restartFlight() }).el);
    col.appendChild(new Button({ label: '⚙ 设置', kind: 'ghost', onClick: () => this.settings() }).el);
    col.appendChild(new Button({ label: '⌂ 返回主菜单', kind: 'ghost', onClick: () => this.app.quitToMenu() }).el);
    this.inner.appendChild(col);
  }
  resume() { this.hide(); this.app.resumeGame?.(); }

  /* ------------------------------------------------------------ 结算 */
  result(game, mission) {
    this.show('result');
    const ok = mission.success;
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '38px', color: ok ? '#3ddc84' : '#ff4d5e' }, text: ok ? '任务完成' : '任务失败' }));
    if (mission.failReason) this.inner.appendChild(el('p', { class: 'sp2-sub', text: mission.failReason }));
    const rows = [
      ['玩法', mission.name],
      ['得分', String(Math.round(mission.score))],
      ['奖励', formatMoney(mission.money)],
      ['用时', fmtTime(mission.timeElapsed)],
      ['进度', `${mission.progress.current} / ${mission.progress.total}`],
    ];
    const tbl = el('div', { class: 'sp2-grid', style: { marginTop: '14px' } });
    for (const [k, v] of rows) tbl.appendChild(el('div', { class: 'sp2-card' }, [
      el('div', { class: 'sp2-card__desc', text: k }), el('div', { class: 'sp2-card__title', text: v }),
    ]));
    this.inner.appendChild(tbl);
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '20px' } }, [
      new Button({ label: '↻ 再来一次', kind: 'primary', onClick: () => this.app.restartFlight() }).el,
      new Button({ label: '▶ 继续自由飞行', kind: 'ghost', onClick: () => { this.hide(); this.app.enterFlightFree(); } }).el,
      new Button({ label: '🛩 换机型', kind: 'ghost', onClick: () => this.missionSelect() }).el,
      new Button({ label: '⌂ 主菜单', kind: 'ghost', onClick: () => this.app.quitToMenu() }).el,
    ]));
  }


  /* ------------------------------------------------------------ 联机：服务器浏览器 */
  multiplayer() {
    this.show('mp');
    const mp = this.app.mp;
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '30px' }, text: '联机对战' }));
    const state = mp?.status || 'idle';
    const badge = { idle: ['未连接', '#7fa0b4'], connecting: ['连接中…', '#ff9f43'], lobby: ['已连接', '#3ddc84'], playing: ['在房间中', '#00d0ff'], error: ['连接失败', '#ff4d5e'] }[state] || ['未知', '#7fa0b4'];
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginBottom: '10px' } }, [
      el('span', { class: 'sp2-tag', style: { background: 'rgba(255,255,255,.06)', color: badge[1], borderColor: badge[1] }, text: '● ' + badge[0] }),
      el('span', { class: 'sp2-kv', html: `<span>玩家</span><b>${this.app.save.profile.name || 'Pilot'}</b>` }),
      mp?.net?.latency ? el('span', { class: 'sp2-kv', html: `<span>延迟</span><b>${mp.net.latency} ms</b>` }) : null,
      el('span', { class: 'sp2-kv', html: `<span>服务器</span><b>${mp?.net?.url || '-'}</b>` }),
    ].filter(Boolean)));
    if (mp?.lastError && state === 'error') this.inner.appendChild(el('p', { class: 'sp2-card__desc', style: { color: '#ff8f9a' }, text: '错误：' + mp.lastError }));

    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginBottom: '12px' } }, [
      new Button({ label: '＋ 创建服务器', kind: 'primary', onClick: () => this.createServerDialog() }).el,
      new Button({ label: '↻ 刷新列表', kind: 'ghost', onClick: () => { mp?.connect().then(() => mp?.listRooms()); this.multiplayer(); } }).el,
      new Button({ label: '🔌 用房间号加入', kind: 'ghost', onClick: () => this.joinByCodeDialog() }).el,
      new Button({ label: '← 返回', kind: 'ghost', onClick: () => this.mainMenu() }).el,
    ]));

    const rooms = mp?.serverRooms || [];
    this.inner.appendChild(el('h3', { style: { color: '#eaf6ff', margin: '6px 0' }, text: `公开房间（${rooms.length}）` }));
    if (!rooms.length) {
      this.inner.appendChild(el('div', { class: 'sp2-card' }, [
        el('div', { class: 'sp2-card__desc', text: state === 'lobby' ? '暂无公开房间，创建一个吧！' : '尚未连接服务器。点击“刷新列表”连接。' }),
      ]));
    } else {
      const grid = el('div', { class: 'sp2-grid' });
      for (const r of rooms) {
        const card = el('div', { class: 'sp2-card' }, [
          el('div', { class: 'sp2-card__title' }, [el('span', { text: r.name }), el('span', { style: { fontSize: '11px', color: '#7fa0b4' }, text: `${r.players}/${r.maxPlayers}` })]),
          el('div', { class: 'sp2-card__desc', text: `房主 ${r.hostName || '?'} · ${r.mapId || 'archipelago'} · ${GAME_MODES[r.mode]?.name || r.mode || '自由飞行'}${r.locked ? ' · 🔒' : ''}` }),
          el('div', { class: 'sp2-card__tags' }, [
            el('span', { class: 'sp2-tag', text: `ID ${String(r.id).slice(0, 8)}` }),
            el('span', { class: 'sp2-tag', text: r.privacy === 'private' ? '私人' : '公开' }),
          ]),
        ]);
        card.onclick = () => { audio.sfx('click'); this.app.joinRoom(r.id); };
        card.onmouseenter = () => audio.sfx('hover', { volume: 0.3 });
        grid.appendChild(card);
      }
      this.inner.appendChild(grid);
    }
    this.inner.appendChild(el('p', { class: 'sp2-hint', text: '提示：优先使用 P2P 直连；如果双方都在对称 NAT 后面，会自动退回服务器中继，玩法完全一致，只是延迟略高。' }));
  }

  createServerDialog() {
    const nameIn = el('input', { type: 'text', value: `${this.app.save.profile.name || 'Pilot'} 的房间`, style: { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff' } });
    const maxIn = el('input', { type: 'number', value: '10', min: '2', max: '16', style: { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff' } });
    const priv = new Select({ label: '可见性', value: 'public', options: [{ value: 'public', label: '公开（出现在列表）' }, { value: 'private', label: '私人（仅房间号）' }] });
    const tick = new Slider({ label: '同步频率 (Hz)', min: 5, max: 30, step: 1, value: 15, format: (v) => v + ' Hz' });
    const limit = new Slider({ label: '零件数上限', min: 20, max: 800, step: 10, value: 400, format: (v) => v + ' 个' });
    const mapSel = new Select({ label: '地图', value: this.selectedMap, options: MAPS.map((m) => ({ value: m.id, label: m.name })) });
    const modeSel = new Select({ label: '玩法', value: 'free', options: Object.values(GAME_MODES).map((m) => ({ value: m.id, label: m.name })) });
    const content = el('div', { class: 'sp2-col', style: { gap: '10px', minWidth: '320px' } }, [
      el('label', { class: 'sp2-card__desc', text: '房间名称' }), nameIn,
      el('label', { class: 'sp2-card__desc', text: '最大玩家数（含自己，最多 16）' }), maxIn,
      priv.el, mapSel.el, modeSel.el, tick.el, limit.el,
    ]);
    new Modal({
      title: '创建服务器', content,
      buttons: [
        { label: '取消', kind: 'ghost' },
        {
          label: '创建并进入', kind: 'primary', close: true, onClick: () => {
            this.selectedMap = mapSel.value;
            this.app.hostRoom({
              name: nameIn.value, maxPlayers: Number(maxIn.value) || 10, privacy: priv.value,
              tickRate: Number(tick.value), partLimit: Number(limit.value),
              mapId: mapSel.value, mode: modeSel.value,
            });
          },
        },
      ],
    }).open();
  }

  joinByCodeDialog() {
    const inp = el('input', { type: 'text', placeholder: '粘贴房间号 / 房间 ID', style: { width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff' } });
    new Modal({
      title: '用房间号加入', content: inp,
      buttons: [{ label: '取消', kind: 'ghost' }, { label: '加入', kind: 'primary', close: true, onClick: () => this.app.joinRoom(inp.value.trim()) }],
    }).open();
  }

  /* ------------------------------------------------------------ 联机：房间界面 */
  lobby() {
    this.show('lobby');
    const mp = this.app.mp;
    const room = mp?.room;
    if (!room) { this.multiplayer(); return; }
    this.inner.appendChild(el('h1', { class: 'sp2-title', style: { fontSize: '28px' }, text: room.name || '房间' }));
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginBottom: '10px' } }, [
      el('span', { class: 'sp2-tag', text: `房间号 ${String(room.id).slice(0, 8)}` }),
      el('span', { class: 'sp2-tag', text: (getMap(room.mapId).name) }),
      el('span', { class: 'sp2-tag', text: GAME_MODES[room.mode]?.name || room.mode }),
      el('span', { class: 'sp2-tag', text: `${mp.playerCount}/${room.maxPlayers}` }),
      mp.isHost ? el('span', { class: 'sp2-tag', style: { color: '#3ddc84', borderColor: '#3ddc84' }, text: '你是房主' }) : null,
    ].filter(Boolean)));

    // 玩家列表
    const list = el('div', { class: 'sp2-col', style: { gap: '6px', maxHeight: '190px', overflow: 'auto' } });
    for (const p of mp.playerList) {
      const row = el('div', { class: 'sp2-card', style: { padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
        el('span', {}, [
          el('b', { style: { color: p.me ? '#00d0ff' : '#eaf6ff' }, text: p.name }),
          p.isHost ? el('span', { class: 'sp2-tag', style: { marginLeft: '8px' }, text: '房主' }) : null,
        ].filter(Boolean)),
        el('span', { class: 'sp2-row', style: { gap: '6px' } }, [
          el('span', { class: 'sp2-tag', style: { opacity: .8 }, text: p.mode === 'p2p' ? 'P2P' : '中继' }),
          p.ping != null ? el('span', { class: 'sp2-tag', text: p.ping + ' ms' }) : null,
          (mp.isHost && !p.me) ? new Button({ label: '踢出', kind: 'danger', onClick: () => mp.kick(p.id) }).el : null,
          (!p.me) ? new Button({ label: '复制机型', kind: 'ghost', onClick: () => this.app.copyPlayerCraft(p.id) }).el : null,
        ].filter(Boolean)),
      ]);
      list.appendChild(row);
    }
    this.inner.appendChild(list);

    // 房主设置
    if (mp.isHost) {
      const s = room.settings || {};
      const grid = el('div', { class: 'sp2-grid', style: { marginTop: '12px' } });
      grid.appendChild(new Slider({ label: '同步频率', min: 5, max: 30, step: 1, value: s.tickRate ?? 15, format: (v) => v + ' Hz', onInput: (v) => mp.setSetting('tickRate', v) }).el);
      grid.appendChild(new Slider({ label: '时间', min: 0, max: 1, step: 0.02, value: s.timeOfDay ?? 0.4, format: (v) => (v < 0.25 ? '夜晚/黎明' : v < 0.5 ? '上午' : v < 0.75 ? '下午' : '黄昏/夜'), onInput: (v) => mp.setSetting('timeOfDay', v) }).el);
      grid.appendChild(new Select({ label: '天气', value: s.weather || 'none', options: [{ value: 'none', label: '晴' }, { value: 'rain', label: '雨' }, { value: 'snow', label: '雪' }], onChange: (v) => mp.setSetting('weather', v) }).el);
      grid.appendChild(new Slider({ label: '零件上限', min: 20, max: 800, step: 10, value: s.partLimit ?? 400, format: (v) => v + ' 个', onInput: (v) => mp.setSetting('partLimit', v) }).el);
      this.inner.appendChild(grid);
    }

    // 聊天
    this.inner.appendChild(el('h3', { style: { color: '#eaf6ff', margin: '14px 0 6px' }, text: '聊天' }));
    const chatBox = el('div', { class: 'sp2-scroll', style: { height: '150px', overflow: 'auto', background: 'rgba(0,0,0,.28)', borderRadius: '8px', padding: '8px', fontSize: '13px', lineHeight: '1.6' } });
    this.chatBox = chatBox;
    for (const c of (mp.chat || [])) chatBox.appendChild(el('div', { html: `<b style="color:#00d0ff">${escapeHtml(c.name)}</b> ${escapeHtml(c.text)}` }));
    setTimeout(() => { chatBox.scrollTop = chatBox.scrollHeight; }, 0);
    this.inner.appendChild(chatBox);
    const inp = el('input', { type: 'text', placeholder: '按回车发送…', style: { flex: '1', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(0,208,255,.3)', background: 'rgba(0,0,0,.35)', color: '#eaf6ff' } });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && inp.value.trim()) { mp.sendChat(inp.value.trim()); inp.value = ''; e.stopPropagation(); }
      e.stopPropagation();
    });
    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '8px' } }, [inp, new Button({ label: '发送', kind: 'ghost', onClick: () => { if (inp.value.trim()) { mp.sendChat(inp.value.trim()); inp.value = ''; } } }).el]));

    this.inner.appendChild(el('div', { class: 'sp2-row', style: { marginTop: '16px' } }, [
      new Button({ label: '🛫 进入战场', kind: 'primary', onClick: () => this.app.startMultiplayerFlight(room.mapId, { mode: room.mode || 'free' }) }).el,
      new Button({ label: '🚪 离开房间', kind: 'ghost', onClick: () => { mp.leave(); this.multiplayer(); } }).el,
      new Button({ label: '← 服务器列表', kind: 'ghost', onClick: () => this.multiplayer() }).el,
    ]));
  }

  /** 联机状态变化时（外部调用）刷新房间界面 */
  refreshLobby() { if (this.screen === 'lobby') this.lobby(); }

  appendChat(entry) {
    if (!this.chatBox) return;
    this.chatBox.appendChild(el('div', { html: `<b style="color:#00d0ff">${escapeHtml(entry.name)}</b> ${escapeHtml(entry.text)}` }));
    while (this.chatBox.childNodes.length > 80) this.chatBox.removeChild(this.chatBox.firstChild);
    this.chatBox.scrollTop = this.chatBox.scrollHeight;
  }

  /** 联机中的简易 HUD 提示（kill feed） */
  killFeed(text) { Toast.push(text, { kind: 'warn', duration: 4 }); }

  /* ------------------------------------------------------------ 加载 */
  loading(text, p) { Loading.show(text); if (p != null) Loading.progress(p); }
  loadingDone() { Loading.hide(); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
