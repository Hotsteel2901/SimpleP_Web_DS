/**
 * 输入系统：键盘 / 鼠标（指针锁定）/ 手柄
 * ------------------------------------------------------------------
 * 输出统一的 control 结构给 Aircraft.inputTarget。
 * 支持两种操纵方式：
 *   'mouse' —— SimplePlanes 标志性的鼠标瞄准（光标在哪飞机就指向哪）
 *   'keys'  —— 传统键位
 */
import { clamp, clamp01, damp, store } from './util.js';

export const DEFAULT_BINDINGS = {
  pitchUp: ['KeyS', 'ArrowDown'],
  pitchDown: ['KeyW', 'ArrowUp'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'Equal'],
  throttleDown: ['ControlLeft', 'Minus'],
  brake: ['Space'],
  gear: ['KeyG'],
  flapsUp: ['BracketLeft'],
  flapsDown: ['BracketRight'],
  airbrake: ['KeyB'],
  fire1: ['KeyF', 'Mouse0'],
  fire2: ['KeyR', 'Mouse2'],
  bomb: ['KeyV'],
  flare: ['KeyZ'],
  chute: ['KeyX'],
  camera: ['KeyC'],
  reset: ['KeyY'],
  pause: ['Escape'],
  autolevel: ['KeyL'],
  boost: ['KeyH'],
};

export class Input {
  constructor(domElement = document.body, opts = {}) {
    // 容错：允许传入 null / 尚未挂载的元素
    this.dom = domElement || (typeof document !== 'undefined' ? document.body : null);
    if (!this.dom && typeof document !== 'undefined') this.dom = document.createElement('div');
    this.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
    this.loadBindings();
    this.keys = new Set();
    this.justPressed = new Set();
    this.mouse = { x: 0, y: 0, nx: 0, ny: 0, down: [false, false, false], wheel: 0, locked: false };
    this.pointerLockEnabled = opts.pointerLock !== false;
    this.mode = store.get('sp2.controlMode', 'mouse');
    this.sensitivity = store.get('sp2.sensitivity', 1.0);
    this.invertPitch = store.get('sp2.invertPitch', false);
    this.enabled = true;
    this.gamepadIndex = null;
    this.gamepad = { pitch: 0, roll: 0, yaw: 0, throttle: null, buttons: [] };
    this.axes = { pitch: 0, roll: 0, yaw: 0, throttle: 0, throttleDelta: 0, brake: 0, flapsDelta: 0, airbrake: 0 };
    this.edges = { gear: false, camera: false, reset: false, fire1: false, fire2: false, bomb: false, flare: false, chute: false, pause: false, autolevel: false, boost: false };
    this.throttle = 0;
    this.flaps = 0;
    this.autoThrottle = false;
    this._listeners = new Map();
    this._bind();
  }

  loadBindings() {
    const saved = store.get('sp2.bindings', null);
    if (saved) for (const k in saved) if (this.bindings[k]) this.bindings[k] = saved[k];
  }
  saveBindings() { store.set('sp2.bindings', this.bindings); }

  on(ev, fn) { if (!this._listeners.has(ev)) this._listeners.set(ev, new Set()); this._listeners.get(ev).add(fn); return () => this._listeners.get(ev).delete(fn); }
  emit(ev, data) { const s = this._listeners.get(ev); if (s) for (const f of s) f(data); }

  _bind() {
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.justPressed.add(e.code);
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyB'].includes(e.code)) {
        if (!(e.code === 'Tab')) e.preventDefault();
      }
      this.emit('keydown', e);
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); this.emit('keyup', e); };
    this._onBlur = () => { this.keys.clear(); this.mouse.down = [false, false, false]; };
    this._onMouseMove = (e) => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      this.mouse.nx = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.ny = (e.clientY / window.innerHeight) * 2 - 1;
    };
    this._onMouseDown = (e) => { this.mouse.down[e.button] = true; this.justPressed.add('Mouse' + e.button); };
    this._onMouseUp = (e) => { this.mouse.down[e.button] = false; };
    this._onWheel = (e) => { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); };
    this._onContext = (e) => e.preventDefault();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    this.dom?.addEventListener('contextmenu', this._onContext);
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    this.dom?.removeEventListener('contextmenu', this._onContext);
  }

  requestPointerLock() {
    if (!this.pointerLockEnabled || this.mode === 'touch') return;
    this.dom?.requestPointerLock?.();
  }
  exitPointerLock() { document.exitPointerLock?.(); }

  /** 某一动作是否按下 */
  action(name) {
    const codes = this.bindings[name] || [];
    for (const c of codes) {
      if (c.startsWith('Mouse')) { if (this.mouse.down[Number(c.slice(5))]) return true; }
      else if (this.keys.has(c)) return true;
    }
    return false;
  }
  /** 是否本帧刚按下 */
  actionPressed(name) {
    const codes = this.bindings[name] || [];
    for (const c of codes) {
      if (c.startsWith('Mouse')) { if (this.justPressed.has(c)) return true; }
      else if (this.justPressed.has(c)) return true;
    }
    return false;
  }

  pollGamepad() {
    if (this.gamepadIndex == null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;
    const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
    this.gamepad.pitch = dz(gp.axes[1] ?? 0);
    this.gamepad.roll = dz(gp.axes[0] ?? 0);
    this.gamepad.yaw = dz(gp.axes[2] ?? 0);
    const t = gp.buttons[7]?.value, b = gp.buttons[6]?.value;
    this.gamepad.throttle = t != null ? (t - b) : null;
    this.gamepad.buttons = gp.buttons.map((x) => x.pressed);
  }

  /**
   * 每帧更新，返回控制输出。
   * @param {number} dt
   * @param {object} ctx { aimAssist:boolean, speed:number }
   */
  update(dt, ctx = {}) {
    this.pollGamepad();
    const inv = this.invertPitch ? -1 : 1;
    const a = this.axes;
    const edge = this.edges;
    for (const k in edge) edge[k] = false;
    if (!this.enabled) {
      a.pitch = a.roll = a.yaw = 0; a.brake = 0;
      for (const k in edge) edge[k] = false;
      try { this.touch?.consumeEdges?.(); } catch (e) { /* 忽略 */ }
      this.justPressed.clear();
      return a;
    }

    const gp = this.gamepad;
    const kbdPitch = (this.action('pitchUp') ? 1 : 0) - (this.action('pitchDown') ? 1 : 0);
    const kbdRoll = (this.action('rollRight') ? 1 : 0) - (this.action('rollLeft') ? 1 : 0);
    const kbdYaw = (this.action('yawRight') ? 1 : 0) - (this.action('yawLeft') ? 1 : 0);

    let pitch = kbdPitch * inv, roll = kbdRoll, yaw = kbdYaw;
    if (gp.pitch || gp.roll || gp.yaw) {
      pitch = clamp(pitch - gp.pitch * inv, -1, 1);
      roll = clamp(roll + gp.roll, -1, 1);
      yaw = clamp(yaw + gp.yaw, -1, 1);
    }

    // 鼠标瞄准：把光标偏移映射为目标滚转率/俯仰
    this.aim = { x: 0, y: 0 };
    if (this.mode === 'mouse' && ctx.aimAssist !== false) {
      const nx = clamp(this.mouse.nx, -1, 1), ny = clamp(this.mouse.ny, -1, 1);
      const dead = 0.06;
      const ax = Math.abs(nx) < dead ? 0 : (nx - Math.sign(nx) * dead) / (1 - dead);
      const ay = Math.abs(ny) < dead ? 0 : (ny - Math.sign(ny) * dead) / (1 - dead);
      const s = 1.35 * this.sensitivity;
      this.aim.x = clamp(ax * s, -1, 1);
      this.aim.y = clamp(ay * s, -1, 1);
      roll = clamp(roll + this.aim.x, -1, 1);
      pitch = clamp(pitch - this.aim.y * inv, -1, 1);
    }

    // ---------------- 触屏（与桌面共用同一条输入管线，行为一致） ----------------
    // 触屏操纵方式下摇杆全权接管；其它方式（比如平板接了鼠标）只有摇杆真的被推动时才接管，
    // 这样不会把鼠标瞄准的值抹成 0。
    if (this.touch && this.touch.visible !== false) {
      const t = this.touch.axes || {};
      const moved = Math.abs(t.pitch || 0) > 0.02 || Math.abs(t.roll || 0) > 0.02 || Math.abs(t.yaw || 0) > 0.02;
      if (this.mode === 'touch' || moved) {
        pitch = clamp(t.pitch || 0, -1, 1);
        roll = clamp(t.roll || 0, -1, 1);
        yaw = clamp(t.yaw || 0, -1, 1);
      }
    }

    a.pitch = clamp(pitch, -1, 1);
    a.roll = clamp(roll, -1, 1);
    a.yaw = clamp(yaw, -1, 1);
    a.brake = this.action('brake') ? 1 : 0;
    a.airbrake = this.action('airbrake') ? 1 : 0;

    // 油门（增量式 + 手柄直控）
    const rate = 0.85;
    if (gp.throttle != null && Math.abs(gp.throttle) > 0.05) this.throttle = clamp01(this.throttle + gp.throttle * dt * rate);
    if (this.action('throttleUp')) this.throttle = clamp01(this.throttle + dt * rate);
    if (this.action('throttleDown')) this.throttle = clamp01(this.throttle - dt * rate);
    if (this.mouse.wheel) { this.throttle = clamp01(this.throttle - this.mouse.wheel * 0.06); this.mouse.wheel = 0; }
    if (edge.autolevel) { /* 由外部处理 */ }
    if (this.actionPressed('autolevel')) edge.autolevel = true;
    if (this.actionPressed('boost')) edge.boost = true;
    // 襟翼
    if (this.action('flapsDown')) this.flaps = clamp01(this.flaps + dt * 0.9);
    if (this.action('flapsUp')) this.flaps = clamp01(this.flaps - dt * 0.9);

    if (this.touch && this.touch.visible !== false) {
      const t = this.touch.axes || {};
      if (t.throttle != null) this.throttle = clamp01(t.throttle);
      if (t.brake != null) a.brake = Math.max(a.brake, clamp01(t.brake));
      if (t.airbrake != null) a.airbrake = Math.max(a.airbrake, clamp01(t.airbrake));
      if (t.flaps != null) this.flaps = clamp01(t.flaps);
    }
    a.throttle = this.throttle;
    a.flaps = this.flaps;

    // 边沿触发
    for (const name of ['gear', 'camera', 'reset', 'pause']) {
      if (this.actionPressed(name)) edge[name] = true;
    }
    edge.fire1 = this.action('fire1');
    edge.fire2 = this.action('fire2');
    edge.bomb = this.actionPressed('bomb') || this.action('bomb');
    edge.flare = this.action('flare');
    edge.chute = this.action('chute');
    if (gp.buttons[0]) edge.fire1 = true;
    if (gp.buttons[1]) edge.fire2 = true;
    if (gp.buttons[2]) edge.chute = true;
    if (gp.buttons[3]) { edge.gear = true; }

    // 触屏边沿（最后合并：持续按住类用 OR，单次触发类直接置位）
    if (this.touch && this.touch.visible !== false) {
      let te = {};
      try { te = this.touch.consumeEdges() || {}; } catch (e) { te = {}; }
      const HELD = { fire1: 1, fire2: 1, brake: 1 };
      for (const k in te) {
        const v = te[k];
        if (!v) continue;
        if (HELD[k]) { edge[k] = true; if (k === 'brake') a.brake = 1; }
        else if (k in edge) edge[k] = true;
      }
    }

    this.justPressed.clear();
    return a;
  }

  /** 把输入映射到飞机 */
  applyTo(aircraft) {
    if (!aircraft || aircraft.destroyed) return;
    const a = this.axes, e = this.edges;
    aircraft.inputTarget.pitch = a.pitch;
    aircraft.inputTarget.roll = a.roll;
    aircraft.inputTarget.yaw = a.yaw;
    aircraft.inputTarget.throttle = a.throttle;
    aircraft.inputTarget.brake = a.brake;
    aircraft.inputTarget.flaps = a.flaps;
    aircraft.inputTarget.airbrake = a.airbrake;
    aircraft.controls.fire1 = !!e.fire1;
    aircraft.controls.fire2 = !!e.fire2;
    aircraft.controls.dropBomb = !!e.bomb;
    aircraft.controls.flare = !!e.flare;
    if (e.chute) aircraft.controls.chute = true;
    if (e.gear) aircraft.controls.gear = !aircraft.controls.gear;
    return e;
  }

  /** 触屏支持（简化的虚拟摇杆） */
  attachTouch(root) {
    const stick = document.createElement('div');
    stick.className = 'sp-touch-stick';
    stick.style.cssText = 'position:fixed;left:24px;bottom:24px;width:140px;height:140px;border-radius:70px;border:2px solid rgba(0,208,255,.35);background:rgba(10,16,24,.35);touch-action:none;z-index:60;display:none';
    const knob = document.createElement('div');
    knob.style.cssText = 'position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:28px;background:rgba(0,208,255,.45)';
    stick.appendChild(knob);
    root?.appendChild(stick);
    let touchId = null, cx = 0, cy = 0;
    const isTouch = ('ontouchstart' in window);
    if (!isTouch) return () => { };
    stick.style.display = 'block';
    const onStart = (ev) => { const t = ev.changedTouches[0]; touchId = t.identifier; const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; onMove(ev); };
    const onMove = (ev) => {
      for (const t of ev.changedTouches) {
        if (t.identifier !== touchId) continue;
        const dx = clamp((t.clientX - cx) / 60, -1, 1), dy = clamp((t.clientY - cy) / 60, -1, 1);
        this.mouse.nx = dx; this.mouse.ny = dy;
        knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      }
      ev.preventDefault();
    };
    const onEnd = () => { touchId = null; this.mouse.nx = 0; this.mouse.ny = 0; knob.style.transform = ''; };
    stick.addEventListener('touchstart', onStart, { passive: false });
    stick.addEventListener('touchmove', onMove, { passive: false });
    stick.addEventListener('touchend', onEnd);
    stick.addEventListener('touchcancel', onEnd);
    return () => { stick.remove(); };
  }
}
