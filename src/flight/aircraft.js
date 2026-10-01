/**
 * 飞机（载具）装配与飞行动力学
 * ------------------------------------------------------------------
 * 由 Craft 定义（零件列表）装配出：
 *   - 视觉模型（含可动控制面、螺旋桨、起落架）
 *   - 刚体（质量/质心/惯性张量由零件累加得到）
 *   - 气动翼面、发动机、起落架、油箱、武器
 * 每帧 update() 完成：气动力 -> 发动机推力 -> 起落架/地面 -> 积水浮力 -> 积分 -> 损毁判定
 */
import * as THREE from 'three';
import { PART_DEFS, buildPartMesh, buildControlSurface, partFeatures, partMass } from '../build/parts.js';
import { RigidBody, solveWing, airDensity, resolveSphereBox } from './physics.js';
import { clamp, clamp01, lerp, damp, DEG, RAD2DEG, TAU } from '../core/util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/* ================================================================== 视觉装配 */
/**
 * 由 craft 定义生成视觉模型组（原点位于质心）。
 * @returns {{ group:THREE.Group, visual:THREE.Group, com:THREE.Vector3, controls:Array, props:Array, gears:Array }}
 */
export function buildCraftVisual(craft, opts = {}) {
  const group = new THREE.Group();
  group.name = 'aircraft:' + (craft.name || 'craft');
  const visual = new THREE.Group();
  group.add(visual);

  // 质心
  const com = new THREE.Vector3();
  let totalMass = 0;
  for (const p of craft.parts) { const m = partMass(p); totalMass += m; com.addScaledVector(new THREE.Vector3(...p.pos), m); }
  if (totalMass > 0) com.multiplyScalar(1 / totalMass);

  const controlSurfaces = [];
  const propellers = [];
  const gearGroups = [];
  const meshes = new Map();

  for (const part of craft.parts) {
    const mesh = buildPartMesh(part, opts);
    mesh.position.set(part.pos[0] - com.x, part.pos[1] - com.y, part.pos[2] - com.z);
    mesh.rotation.set(part.rot[0] * DEG, part.rot[1] * DEG, part.rot[2] * DEG);
    visual.add(mesh);
    meshes.set(part.uid, mesh);

    const def = PART_DEFS[part.def];
    // 可动控制面
    const cs = buildControlSurface(part);
    if (cs) {
      cs.position.set(0, 0, 0);
      mesh.add(cs);
      controlSurfaces.push({ part, hinge: cs, type: cs.userData.controlType });
    }
    // 螺旋桨：单独一个可旋转组
    if (def?.isPropeller) {
      propellers.push({ part, mesh, axis: new THREE.Vector3(1, 0, 0) });
    }
    // 起落架收放
    if (def?.gear) {
      const pivot = new THREE.Group();
      pivot.position.set(0, 0, 0);
      gearGroups.push({ part, mesh, pivot, extension: 1 });
    }
  }
  return { group, visual, com, controls: controlSurfaces, props: propellers, gears: gearGroups, meshes, totalMass };
}

/* ================================================================== 统计 */
/** 计算 craft 的统计信息（用于机库 UI / 平衡性检查） */
export function computeCraftStats(craft) {
  let mass = 0, cost = 0, thrust = 0, wingArea = 0, fuel = 0, hp = 0, guns = 0, missiles = 0;
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const com = new THREE.Vector3();
  for (const p of craft.parts) {
    const d = PART_DEFS[p.def]; if (!d) continue;
    const m = partMass(p);
    mass += m; cost += (d.cost || 0); hp += d.hp || 50;
    com.addScaledVector(new THREE.Vector3(...p.pos), m);
    const f = partFeatures(p);
    if (f.engine) thrust += f.engine.thrust || (f.engine.power ? f.engine.power / 40 : 0);
    if (f.fuel) fuel += f.fuel.capacity;
    if (f.weapon?.type === 'gun') guns++;
    if (f.weapon?.type === 'missile') missiles += f.weapon.count;
    if (f.aero?.type === 'wing') wingArea += f.aero.area;
    const [w, h, l] = p.size;
    minX = Math.min(minX, p.pos[0] - w / 2); maxX = Math.max(maxX, p.pos[0] + w / 2);
    minY = Math.min(minY, p.pos[1] - h / 2); maxY = Math.max(maxY, p.pos[1] + h / 2);
    minZ = Math.min(minZ, p.pos[2] - l / 2); maxZ = Math.max(maxZ, p.pos[2] + l / 2);
  }
  if (mass > 0) com.multiplyScalar(1 / mass);
  const size = craft.parts.length ? new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ) : new THREE.Vector3(3, 1, 4);
  const wingLoading = wingArea > 0.01 ? mass / wingArea : Infinity;
  return { mass, cost, thrust, wingArea, fuel, hp, guns, missiles, size, com, partCount: craft.parts.length, wingLoading, bounds: { minX, maxX, minY, maxY, minZ, maxZ } };
}

/* ================================================================== 飞机 */
export class Aircraft {
  /**
   * @param {object} craft 机型定义 { name, parts:[], paint? }
   * @param {object} opts { isPlayer, callsign, team, position, heading, assist, fuel01, health }
   */
  constructor(craft, opts = {}) {
    this.craft = craft;
    this.isPlayer = !!opts.isPlayer;
    this.callsign = opts.callsign || 'Pilot';
    this.team = opts.team ?? 0;
    this.alive = true;
    this.assist = opts.assist ?? (this.isPlayer ? 0.5 : 1);
    this.crashed = false;
    this.destroyed = false;
    this.uid = Aircraft._n = (Aircraft._n || 0) + 1;

    const vis = buildCraftVisual(craft, { shadows: opts.shadows !== false });
    this.group = vis.group;
    this.visual = vis.visual;
    this.com = vis.com;
    this.controlMeshes = vis.controls;
    this.propMeshes = vis.props;
    this.gearVisuals = vis.gears;
    this.partMeshes = vis.meshes;

    const stats = computeCraftStats(craft);
    this.stats = stats;
    this.dryMass = stats.mass;
    this.fuelCapacity = Math.max(1, stats.fuel);
    this.fuel = this.fuelCapacity * clamp01(opts.fuel01 ?? 1);

    /* ---------------- 刚体 ---------------- */
    // 惯性张量：点质量 + 自身转动惯量（在机体坐标系）
    const I = new THREE.Vector3(0, 0, 0);
    for (const p of craft.parts) {
      const m = partMass(p);
      const [px, py, pz] = [p.pos[0] - stats.com.x, p.pos[1] - stats.com.y, p.pos[2] - stats.com.z];
      const [w, h, l] = p.size;
      const own = m / 12;
      I.x += m * (py * py + pz * pz) + own * (h * h + l * l);
      I.y += m * (px * px + pz * pz) + own * (w * w + l * l);
      I.z += m * (px * px + py * py) + own * (w * w + h * h);
    }
    I.multiplyScalar(1.15); // 结构质量修正
    const baseInertia = new THREE.Vector3(Math.max(50, I.x), Math.max(50, I.y), Math.max(50, I.z));
    this._baseInertia = baseInertia.clone();
    const mass = stats.mass + this.fuel * 0.8;
    this.body = new RigidBody({
      mass, position: opts.position ? opts.position.clone() : new THREE.Vector3(0, 400, 0),
      inertia: baseInertia.clone(),
      angularDamping: 0.12, linearDamping: 0.0,
    });
    if (opts.heading) this.body.quaternion.setFromEuler(new THREE.Euler(0, opts.heading, 0));
    if (opts.velocity) this.body.velocity.copy(opts.velocity);

    /* ---------------- 气动翼面 ---------------- */
    this.surfaces = [];
    for (const p of craft.parts) {
      const f = partFeatures(p);
      if (!f.aero || (f.aero.type !== 'wing' && f.aero.type !== 'plate')) continue;
      const a = f.aero;
      const dih = (a.dihedral != null ? a.dihedral : (p.props.dihedral ?? 0)) * DEG;
      const localNormal = new THREE.Vector3(-Math.sin(dih), Math.cos(dih), 0);
      const localChord = new THREE.Vector3(0, 0, 1);
      const localSpan = new THREE.Vector3(Math.cos(dih), Math.sin(dih), 0);
      const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG));
      const pos = new THREE.Vector3(p.pos[0] - stats.com.x, p.pos[1] - stats.com.y, p.pos[2] - stats.com.z);
      // 气动中心略在几何中心之后
      const hingeOffset = new THREE.Vector3(0, 0, p.size[2] * (a.control ? 0.12 : 0));
      const s = {
        part: p, area: a.area, span: a.span, chord: a.chord, thick: a.thick ?? 0.12, cd0: a.cd0 ?? 0.012,
        control: a.control || null, controlDir: 1, liftScale: 1,
        normal: localNormal.clone().applyQuaternion(rot).normalize(),
        chordDir: localChord.clone().applyQuaternion(rot).normalize(),
        spanDir: localSpan.clone().applyQuaternion(rot).normalize(),
        position: pos.add(hingeOffset.applyQuaternion(rot)),
        hp: PART_DEFS[p.def]?.hp ?? 100,
      };
      // 舵面方向映射：
      //  滚转 -> 按左右（+X 侧副翼上偏 => 右滚）
      //  俯仰 -> 按舵面在重心之前/之后（鸭翼必须反向）
      //  偏航 -> 按垂尾法线朝向
      s.rollDir = p.pos[0] >= 0 ? -1 : 1;
      s.pitchDir = (p.pos[2] - stats.com.z) >= 0 ? 1 : -1;
      s.rudderDir = s.normal.x > 0 ? -1 : 1;
      s.controlDir = s.pitchDir;
      s.isWing = (a.type === 'wing' && !a.control && Math.abs(p.pos[0]) > 0.35);
      this.surfaces.push(s);
      // 主翼自动附带副翼（外侧 30% 展长）：独立气动面，产生真实滚转力矩
      if (s.isWing) {
        const outer = Math.abs(p.pos[0]) + a.span * 0.35;
        this.surfaces.push({
          part: p, area: a.area * 0.22, span: a.span * 0.3, chord: a.chord * 0.3, thick: a.thick ?? 0.12,
          cd0: 0.02, control: 'aileron', rollDir: s.rollDir, controlDir: s.rollDir, liftScale: 1, isAileron: true,
          normal: s.normal.clone(), chordDir: s.chordDir.clone(), spanDir: s.spanDir.clone(),
          position: new THREE.Vector3(outer * Math.sign(p.pos[0]), s.position.y, s.position.z),
          hp: s.hp,
        });
      }
    }

    /* ---------------- 迎风面积 ---------------- */
    {
      let maxA = 0.3, sumA = 0;
      for (const p of craft.parts) {
        const f = partFeatures(p);
        if (f.aero && f.aero.type === 'body') { maxA = Math.max(maxA, f.aero.area); sumA += f.aero.area; }
      }
      this.frontalArea = Math.max(0.3, maxA * 1.15 + Math.max(0, sumA - maxA) * 0.22);
    }

    this._buildSystems();

    /* ---------------- 其他 ---------------- */
    this.hasChute = craft.parts.some((p) => PART_DEFS[p.def]?.chute);
    this.chuteDeployed = false;
    this.hasPilot = craft.parts.some((p) => PART_DEFS[p.def]?.pilot);
    this.cargoParts = craft.parts.filter((p) => PART_DEFS[p.def]?.cargo).map((p) => p.uid);
    this.radius = Math.max(1.5, stats.size.length() * 0.42);
    this.collisionSpheres = this._buildCollisionSpheres(stats, 4);

    /* ---------------- 控制 ---------------- */
    this.controls = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, flaps: 0, airbrake: 0,
      gear: true, gearT: 1, fire1: false, fire2: false, dropBomb: false, flare: false, chute: false, trim: 0, assist: this.assist,
    };
    this.inputTarget = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, flaps: 0, airbrake: 0 };
    this.rpmSmooth = 0;

    /* ---------------- 状态（HUD/音频约定） ---------------- */
    this.state = {
      callsign: this.callsign, position: this.body.position, quaternion: this.body.quaternion, velocity: this.body.velocity,
      speed: 0, mach: 0, altitudeASL: 0, altitudeAGL: 0, verticalSpeed: 0,
      heading: 0, pitch: 0, roll: 0, throttle: 0, rpm01: 0, aoa: 0, slip: 0, gForce: 1,
      stall: false, stalled: false, fuel01: 1, health01: 1,
      gearDown: true, gear01: 1, flaps01: 0, airbrake01: 0,
      mass, thrust: 0, lift: 0, drag: 0, engines: [], warnings: [], crashed: false, destroyed: false,
    };
    /* ---------------- 逐零件损毁表（对齐原版：掉血的是「被撞到的那个零件」） ---------------- */
    this.partState = [];
    for (const p of craft.parts) {
      const d = PART_DEFS[p.def];
      if (!d) continue;
      const vol = Math.max(0.05, p.size[0] * p.size[1] * p.size[2]);
      // 大零件更耐撞（体积开立方），但差距不夸张
      const maxHp = (d.hp ?? 60) * (0.8 + 0.55 * Math.cbrt(vol));
      this.partState.push({
        uid: p.uid, part: p, def: d, defId: p.def,
        maxHp, hp: maxHp, mass: Math.max(1, partMass(p)),
        local: new THREE.Vector3(p.pos[0] - stats.com.x, p.pos[1] - stats.com.y, p.pos[2] - stats.com.z),
        radius: Math.max(0.45, Math.max(p.size[0], p.size[1], p.size[2]) * 0.5),
        critical: /^(cockpit|seat|pilot)/.test(p.def),
        structural: (d.cat === 'wing' || d.cat === 'fuselage' || d.cat === 'cockpit'),
        dead: false, tinted: false,
      });
    }
    this.partByUid = new Map(this.partState.map((ps) => [ps.uid, ps]));
    this._hpMassTotal = this.partState.reduce((a, ps) => a + ps.maxHp * ps.mass, 0) || 1;
    this._lastScrapeSfx = 0;
    this._smokeAccum = 0;

    this.health = opts.health ?? 1;
    this.warnings = new Set();
    this.time = 0;
    this.groundContact = false;
    this.onWater = false;
    this.lastCrashSpeed = 0;
    this.engineStarted = false;
    this._wingOut = { forceLocal: new THREE.Vector3(), alpha: 0, cl: 0, cd: 0, stall: false, q: 0 };
    this.fx = opts.fx || null; // 特效管理器
    this.onEvent = opts.onEvent || null;   // 音效/计分回调（由 Game 注入）
    this.pendingDetach = [];
    this.gForce = 1;
    this.updateVisualTransform();
  }

  /**
   * 从机型定义构建动力/起落架/油箱/武器子系统。
   * 构造函数与 reset() 共用，保证「重置 = 换一架完好的飞机」。
   * @private
   */
  _buildSystems() {
    /* ---------------- 发动机 ---------------- */
    this.engines = [];
    for (const p of this.craft.parts) {
      const f = partFeatures(p);
      if (!f.engine) continue;
      this.engines.push({
        id: `e${p.uid}`, part: p, spec: f.engine, type: f.engine.type,
        position: new THREE.Vector3(p.pos[0] - this.stats.com.x, p.pos[1] - this.stats.com.y, p.pos[2] - this.stats.com.z),
        rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG)),
        rpm01: 0, throttle01: 0, active: false, hp: PART_DEFS[p.def]?.hp ?? 120, health01: 1,
        heat: 0, afterburner: 0,
      });
      // 螺旋桨零件跟随发动机
      const prop = this.propMeshes.find((pr) => !pr.linked && Math.abs(pr.part.pos[2] - p.pos[2]) < 1.6 && Math.abs(pr.part.pos[0] - p.pos[0]) < 1.2);
      if (prop && (f.engine.type === 'prop' || f.engine.type === 'turboprop' || f.engine.type === 'electric')) { prop.linked = this.engines[this.engines.length - 1]; prop.angle = 0; }
    }

    /* ---------------- 起落架 ---------------- */
    this.gears = [];
    for (const p of this.craft.parts) {
      const f = partFeatures(p);
      if (!f.gear) continue;
      const base = {
        part: p, radius: f.gear.radius, travel: f.gear.travel, damping: f.gear.damping,
        retractable: f.gear.retractable, float: !!f.gear.float, ski: !!f.gear.ski, powered: !!f.gear.powered,
        compression: 0, contact: false, spin: 0, grounded: 0,
      };
      // 浮筒/雪橇是长条形，拆成前后两个接触点，否则无法抵抗俯仰
      if (f.gear.float || f.gear.ski) {
        const half = p.size[2] * 0.33;
        for (const dz of [-half, half]) {
          this.gears.push({ ...base, stiffness: f.gear.stiffness / 2, steerable: p.pos[2] < -0.3 && dz < 0,
            position: new THREE.Vector3(p.pos[0] - this.stats.com.x, p.pos[1] - this.stats.com.y, p.pos[2] - this.stats.com.z + dz) });
        }
      } else {
        this.gears.push({ ...base, stiffness: f.gear.stiffness, steerable: p.pos[2] < -0.3,
          position: new THREE.Vector3(p.pos[0] - this.stats.com.x, p.pos[1] - this.stats.com.y, p.pos[2] - this.stats.com.z) });
      }
    }

    /* ---------------- 油箱 ---------------- */
    this.tanks = [];
    for (const p of this.craft.parts) {
      const f = partFeatures(p);
      if (f.fuel) this.tanks.push({ part: p, capacity: f.fuel.capacity, electric: !!f.fuel.electric });
    }
    if (!this.tanks.length && this.engines.length) {
      this.tanks.push({ part: null, capacity: 120, electric: false });
      this.fuelCapacity = Math.max(this.fuelCapacity, 120);
    }

    /* ---------------- 武器 ---------------- */
    this.weapons = [];
    for (const p of this.craft.parts) {
      const f = partFeatures(p);
      if (!f.weapon) continue;
      this.weapons.push({
        part: p, spec: f.weapon, ammo: f.weapon.ammo ?? f.weapon.count ?? 1, cooldown: 0,
        position: new THREE.Vector3(p.pos[0] - this.stats.com.x + p.size[0] * 0.6, p.pos[1] - this.stats.com.y - p.size[1] * 0.4, p.pos[2] - this.stats.com.z - p.size[2] * 0.5),
        dir: new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG))),
        side: p.pos[0] >= 0 ? 1 : -1,
      });
    }

  }

  _buildCollisionSpheres(stats, n = 4) {
    const out = [];
    const b = stats.bounds;
    const len = Math.max(1, b.maxZ - b.minZ);
    const r = Math.max(0.8, Math.min(stats.size.x, stats.size.y) * 0.28 + len * 0.06);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      out.push({ center: new THREE.Vector3(stats.com.x, stats.com.y, lerp(b.minZ, b.maxZ, t)), radius: r });
    }
    return out;
  }

  /** 是否已启动（有发动机 => 需要节流阀；无发动机 => 视为滑翔机，直接可控） */
  get hasEngine() { return this.engines.length > 0; }
  get speed() { return this.body.velocity.length(); }

  /* ================================================================ 主更新 */
  /**
   * @param {number} dt 秒
   * @param {object} env { terrain, landmarks, gravity, wind:THREE.Vector3, airDensityScale, projectiles, onEvent }
   */
  update(dt, env) {
    if (this.destroyed) { this.updateVisualTransform(); return; }
    this.time += dt;
    const body = this.body;
    const terrain = env.terrain;
    const gravity = env.gravity ?? 9.81;

    /* --- 平滑控制输入（模拟舵面速率限制） --- */
    const c = this.controls;
    const rate = 3.4, returnRate = 5.0;
    for (const k of ['pitch', 'roll', 'yaw', 'airbrake']) {
      const target = this.inputTarget[k] ?? 0;
      const r = Math.abs(target) > 0.01 ? rate : returnRate;
      c[k] = damp(c[k], clamp(target, -1, 1), r, dt);
    }
    // 油门 / 襟翼 / 刹车
    c.throttle = damp(c.throttle, clamp01(this.inputTarget.throttle ?? 0), 2.6, dt);
    c.flaps = damp(c.flaps, clamp01(this.inputTarget.flaps ?? 0), 1.4, dt);
    c.brake = damp(c.brake, clamp01(this.inputTarget.brake ?? 0), 6, dt);
    // 起落架
    const gearTarget = c.gear ? 1 : 0;
    c.gearT = damp(c.gearT, gearTarget, 1.1, dt);

    /* --- 环境 --- */
    const altASL = body.position.y;
    const density = airDensity(altASL) * (env.airDensityScale ?? 1);
    const wind = env.wind || _v4.set(0, 0, 0);
    _v.copy(body.velocity).sub(wind); // 相对气流

    body.clearForces();
    this.liftAccum = 0; this.dragAccum = 0; this.thrustAccum = 0;
    this.aoaAccum = 0; this.aoaWeight = 0;
    let stalled = false;

    /* --- 气动 --- */
    const ctl = { pitch: c.pitch, roll: c.roll, yaw: c.yaw, flap: c.flaps, airbrake: c.airbrake };
    const bodyVel = new THREE.Vector3();
    const solveOne = (s, downwash) => {
      if (s.detached) return null;
      s.alphaOffset = downwash;
      body.bodyVelocityAt(s.position, bodyVel);
      bodyVel.sub(_v5.copy(wind).applyQuaternion(_q.copy(body.quaternion).invert()));
      const res = solveWing(s, bodyVel, density, ctl, this._wingOut);
      if (res.stall) stalled = true;
      const fw = _v2.copy(res.forceLocal).applyQuaternion(body.quaternion);
      const wp = _v3.copy(s.position).applyQuaternion(body.quaternion).add(body.position);
      body.applyForce(fw, wp);
      this.liftAccum += Math.max(0, res.cl) * res.q * s.area;
      this.dragAccum += res.cd * res.q * s.area;
      if (s.area > 1) { this.aoaAccum += res.alpha * s.area; this.aoaWeight += s.area; }
      return res;
    };
    // 第一趟：主翼（用于求下洗角）
    let wingCLSum = 0, wingAreaSum = 0;
    for (const s of this.surfaces) {
      if (!s.isWing && !s.isAileron) continue;
      const res = solveOne(s, 0);
      if (res && s.isWing) { wingCLSum += res.cl * s.area; wingAreaSum += s.area; }
    }
    this.lastWingCL = wingAreaSum > 0 ? wingCLSum / wingAreaSum : 0;
    // 下洗：主翼后方的尾翼有效迎角降低（缺此项会导致飞机持续低头）
    const downwash = -clamp(this.lastWingCL, -1.4, 1.4) * 0.11;
    for (const s of this.surfaces) {
      if (s.isWing || s.isAileron) continue;
      solveOne(s, downwash);
    }

    /* --- 机身寄生阻力 + 侧滑 --- */
    const speedRel = _v.length();
    if (speedRel > 0.5) {
      _v2.copy(_v).normalize();
      const frontal = this.frontalArea;
      const cdBody = 0.13 + (c.airbrake ?? 0) * 1.1 + (c.gearT < 0.9 ? 0.05 : 0);
      const mag = 0.5 * density * speedRel * speedRel * frontal * cdBody;
      const dragF = _v2.multiplyScalar(-mag);
      body.applyForce(dragF, body.position);
      this.dragAccum += mag;
    }

    /* --- 发动机 --- */
    let fuelRate = 0;
    for (const e of this.engines) {
      const spool = e.type === 'jet' ? 2.2 : 1.4;
      const hasFuel = this.fuel > 0.01 && e.health01 > 0;
      e.throttle01 = hasFuel ? c.throttle : 0;
      e.rpm01 = damp(e.rpm01, hasFuel ? lerp(0.12, 1, c.throttle) : 0, spool, dt);
      e.active = hasFuel && c.throttle > 0.02;
      if (e.active) fuelRate += (e.spec.fuelRate ?? 0.01) * 60 * (0.25 + 0.75 * c.throttle);
      const thrustDir = _v2.set(0, 0, -1).applyQuaternion(e.rot).applyQuaternion(body.quaternion);
      let T = 0;
      const vAlong = body.velocity.dot(thrustDir);
      const densRatio = density / 1.225;
      switch (e.type) {
        case 'jet': {
          const ram = 1 + clamp(vAlong / 340, -0.15, 0.6) * 0.30;
          const fade = 1 - clamp01(Math.abs(vAlong) / (e.spec.vMax || 360)) * 0.35;
          T = (e.spec.staticThrust || e.spec.thrust || 20000) * e.rpm01 * densRatio * ram * fade * e.health01;
          break;
        }
        case 'rocket': {
          T = (e.spec.thrust || 24000) * c.throttle * e.health01 * (1 - clamp01(Math.abs(vAlong) / (e.spec.vMax || 400)) * 0.2);
          break;
        }
        case 'prop': case 'turboprop': case 'electric': {
          const st0 = e.spec.staticThrust || (e.spec.power || 90000) / 32;
          const vMax = e.spec.vMax || 100;
          T = st0 * e.rpm01 * densRatio * Math.max(0, 1 - Math.abs(vAlong) / vMax) * e.health01;
          if (c.throttle < 0.03 && Math.abs(vAlong) > 5) T = -Math.min(st0 * 0.10, 0.5 * density * vAlong * vAlong * (e.spec.propRadius || 1) ** 2 * 0.05);
          break;
        }
        default: T = (e.spec.staticThrust || 0) * e.rpm01;
      }
      if (T !== 0) {
        body.applyForce(_v3.copy(thrustDir).multiplyScalar(T), _v4.copy(e.position).applyQuaternion(body.quaternion).add(body.position));
        this.thrustAccum += T;
      }
      // 螺旋桨扭矩效应（真实存在的偏转倾向）
      if (e.active && (e.type === 'prop' || e.type === 'turboprop')) {
        body.applyTorque(_v3.set(0, -c.throttle * 260 * e.rpm01 * (e.spec.propRadius || 1), 0));
      }
    }
    if (fuelRate > 0 && this.fuel > 0) this.fuel = Math.max(0, this.fuel - fuelRate * dt);
    if (this.fuel <= 0 && this.hasEngine) this.warnings.add('FUEL');

    /* --- 降落伞 --- */
    if (this.chuteDeployed) {
      const q = 0.5 * density * body.velocity.lengthSq();
      _v2.copy(body.velocity).normalize().multiplyScalar(-q * 8.5);
      if (body.velocity.lengthSq() > 1e-4) body.applyForce(_v2, body.position);
    }

    /* --- 地面 / 水面 --- */
    this.groundContact = false;
    let onWater = false;
    let maxPen = 0;
    for (const g of this.gears) {
      if (g.retractable && c.gearT < 0.85) { g.contact = false; g.grounded = 0; continue; }
      const wp = _v3.copy(g.position).applyQuaternion(body.quaternion).add(body.position);
      let gh = terrain ? terrain.heightAt(wp.x, wp.z) : 0;
      // 平台支撑：屋顶停机坪 / 航母甲板 / 桥梁等
      const plat = this._platformAt(wp.x, wp.z, wp.y, env);
      if (plat != null && plat > gh) { gh = plat; this._onPlatform = true; }
      const isWater = terrain ? terrain.isWater(wp.x, wp.z) : false;
      const targetY = gh + g.radius;
      if (wp.y <= targetY) {
        const n = (terrain && !isWater) ? terrain.normalAt(wp.x, wp.z) : _v4.set(0, 1, 0);
        // 限制最大穿透，防止初速穿透造成爆炸性弹力
        const pen = Math.min(targetY - wp.y, Math.max(g.travel * 2.2, 0.5));
        maxPen = Math.max(maxPen, pen);
        const vAt = _v5.copy(body.velocity).add(_v6.crossVectors(body.angularVelocity, _v2.copy(wp).sub(body.position)));
        const vn = vAt.dot(n);
        // 对称阻尼（真实减振器对压缩与回弹都做功，避免抽能振荡）
        let Fn = g.stiffness * pen - g.damping * vn;
        if (isWater) { Fn = Math.max(0, Fn) * (g.float ? 1 : 0.2); onWater = true; }
        Fn = clamp(Fn, 0, 14 * body.mass * 9.81 / Math.max(1, this.gears.length));
        if (pen > g.travel) Fn += (pen - g.travel) * g.stiffness * 3; // 渐进式缓冲
        const normalForce = _v7.copy(n).multiplyScalar(Fn);
        body.applyForce(normalForce, wp);
        g.compression = clamp01(pen / Math.max(0.05, g.travel));
        g.contact = true; g.grounded = 1;
        this.groundContact = true;

        // 摩擦：沿地形切向
        const tangent = new THREE.Vector3().copy(vAt).addScaledVector(n, -vAt.dot(n));
        const tSpeed = tangent.length();
        const wheelFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(body.quaternion);
        const wheelSide = new THREE.Vector3().crossVectors(n, wheelFwd).normalize();
        if (tSpeed > 0.03) {
          tangent.multiplyScalar(1 / tSpeed);
          const rollFriction = isWater ? 0.015 : (g.ski ? 0.05 : 0.022);
          const brakeF = c.brake * (isWater ? 0.08 : 0.85);
          const sideFriction = isWater ? 0.08 : 1.0;
          // 静摩擦模型：求“打死滑”所需力并按 μ·N 截断，避免低速持续侧滑漂移
          const mEff = body.mass / Math.max(1, this.gears.length);
          const sideSpeed = vAt.dot(wheelSide);
          const desiredSide = -sideSpeed * mEff / Math.max(1e-3, dt);
          const maxSide = Fn * sideFriction;
          body.applyForce(new THREE.Vector3().copy(wheelSide).multiplyScalar(clamp(desiredSide, -maxSide, maxSide)), wp);
          const maxRoll = Fn * (rollFriction + brakeF);
          const desiredRoll = -tSpeed * mEff / Math.max(1e-3, dt) * ((rollFriction + brakeF) / (rollFriction + brakeF + 2.5));
          body.applyForce(new THREE.Vector3().copy(tangent).multiplyScalar(clamp(desiredRoll, -maxRoll, maxRoll)), wp);
          g.spin += tSpeed * dt / Math.max(0.1, g.radius);
        }
        // 前轮转向
        if (g.steerable && !isWater && tSpeed > 1.5) {
          const authority = clamp(tSpeed / 25, 0.15, 1);
          const steerDir = wheelSide.clone().multiplyScalar(-1); // 指向机体右侧
          body.applyForce(steerDir.multiplyScalar(c.yaw * Fn * 0.75 * authority), wp);
        }
        // 用「接触点沿地面法线的速度」结算 —— 正常着陆只掉极少血，砸地才会断零件
        if (!isWater && Math.abs(vn) > 1.2) {
          this.applyImpact(Math.abs(vn), wp, 'ground');
        }
      } else {
        g.contact = false; g.compression = damp(g.compression, 0, 6, dt); g.grounded = 0;
      }
    }
    this.onWater = onWater;

    // 机体（无起落架时用包围球直接撞地）
    if (!this.gears.length && terrain) {
      const belly = _v3.copy(this.collisionSpheres[Math.floor(this.collisionSpheres.length / 2)]?.center || new THREE.Vector3()).applyQuaternion(body.quaternion).add(body.position);
      const gh = terrain.heightAt(belly.x, belly.z);
      const r = this.collisionSpheres[Math.floor(this.collisionSpheres.length / 2)]?.radius || 1.2;
      if (belly.y - r < gh) {
        const n = terrain.normalAt(belly.x, belly.z);
        const pen = (gh + r) - belly.y;
        const vn = body.velocity.dot(n);
        const Fn = clamp(60000 * pen - 5000 * Math.min(0, vn), 0, 40 * body.mass);
        body.applyForce(_v2.copy(n).multiplyScalar(Fn), belly);
        body.applyForce(_v4.copy(body.velocity).multiplyScalar(-0.8 * Math.abs(Fn) / Math.max(1, body.velocity.length())), belly);
        this.groundContact = true;
        if (Math.abs(body.velocity.dot(n)) > 1.2) this.applyImpact(Math.abs(body.velocity.dot(n)), belly, 'ground');
      }
    }

    /* --- 地标碰撞（建筑/船只等） --- */
    if (env.landmarks && speedRel > 1) {
      this.checkLandmarkCollisions(env, dt);
    }

    /* --- 飞行辅助（Fly-by-wire / 稳定性增强） --- */
    if (c.assist > 0.01 && !this.crashed) this.applyAssist(dt, env);

    /* --- 积分 --- */
    body.addGravity(gravity, dt);
    // 高速气动加热提示
    if (speedRel > 320) this.warnings.add('OVERSPEED');
    body.integrate(dt);
    if (body.position.y < -1200) { this.destroy('水深过深'); }

    /* --- 视觉更新 --- */
    this.updateVisualTransform(dt);
    this.updateHUDState(dt, env);
    this.updateWeaponState(dt, env);
    this.applyPendingDetach();
  }

  /**
   * 查询某个 (x,z) 处可供起落架停放的“平台”高度（屋顶、甲板、桥梁等）。
   * 只接受顶面不高于机轮当前高度太多的盒体，避免把墙面当成地面。
   */
  _platformAt(x, z, wheelY, env) {
    const lm = env?.landmarks;
    if (!lm) return null;
    const cols = lm.colliders;
    if (!cols || !cols.length) return null;
    let best = null;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.shape !== 'box' || c.sensor || c.destroyed || c.kind === 'runway') continue;
      const he = c.halfExtents; if (!he) continue;
      if (x < c.center.x - he.x - 1 || x > c.center.x + he.x + 1) continue;
      if (z < c.center.z - he.z - 1 || z > c.center.z + he.z + 1) continue;
      const top = c.center.y + he.y;
      if (top > wheelY + 1.2) continue;          // 高于机轮 -> 是墙不是地板
      if (top < wheelY - 30) continue;           // 太远的下方
      if (best == null || top > best) best = top;
    }
    return best;
  }

  /* ---------------------------------------------------------------- 辅助 */
  applyAssist(dt, env) {
    const body = this.body;
    const a = this.assist;
    const e = _e.setFromQuaternion(body.quaternion, 'YXZ');
    let level = a * 0.9;
    // 姿态稳定（把机翼放平）
    if (this.groundContact) level = a * 0.2;
    const rollErr = e.z; // 期望 0
    const pitchErr = e.x - clamp(e.x, -0.28, 0.28); // 允许 ±16° 自由俯仰
    const wl = body.angularVelocity.clone().applyQuaternion(_q.copy(body.quaternion).invert());
    // 只在玩家没有主动输入时介入
    const free = (1 - Math.min(1, Math.abs(this.controls.roll) + Math.abs(this.controls.pitch)));
    const kp = 1.2 * level * free, kd = 0.55 * level * free;
    const I = body.inertia;
    const tx = -(pitchErr * kp * I.x * 0.55 + wl.x * kd * I.x);
    const tz = -(rollErr * kp * I.z * 0.5 + wl.z * kd * I.z);
    body.applyTorque(new THREE.Vector3(tx, 0, tz));
    // 迎角保护
    const s = this.state;
    if (s.aoa > 0.30 && a > 0.3 && this.controls.pitch > -0.1) {
      body.applyTorque(_v.set(this.controls.pitch * I.x * 3.0 * a, 0, 0));
    }
    // 自动油门（可选，保持空速）
    if (this.inputTarget.autoThrottle && this.hasEngine) {
      const targetSpeed = 130;
      const err = targetSpeed - this.speed;
      this.inputTarget.throttle = clamp01(this.controls.throttle + err * 0.02);
    }
  }

  checkLandmarkCollisions(env, dt) {
    const body = this.body;
    const cols = env.landmarks.colliders;
    if (!cols || !cols.length) return;
    for (const sp of this.collisionSpheres) {
      const wp = _v.copy(sp.center).applyQuaternion(body.quaternion).add(body.position);
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        if (col.destroyed || col.sensor) continue;   // 传感器（光环/触发器）不参与碰撞
        if (col.kind === 'runway') continue;         // 跑道由地形支撑，不做实体碰撞
        if (col.shape === 'sphere') {
          const d = wp.distanceTo(col.center);
          const rr = sp.radius + col.radius;
          if (d < rr && d > 1e-4) {
            const n = _v2.copy(wp).sub(col.center).multiplyScalar(1 / d);
            this.hitWorld(n, rr - d, wp, col, env);
          }
        } else {
          // 粗筛：距离中心过远则跳过
          if (Math.abs(wp.x - col.center.x) > col.halfExtents.x + sp.radius + 1) continue;
          if (Math.abs(wp.y - col.center.y) > col.halfExtents.y + sp.radius + 1) continue;
          if (Math.abs(wp.z - col.center.z) > col.halfExtents.z + sp.radius + 1) continue;
          const impulse = resolveSphereBox(body, wp, sp.radius, {
            center: col.center, halfExtents: col.halfExtents, quaternion: col.quaternion || null,
          }, 0.25, 0.5);
          if (impulse > 0.5) {
            const strength = impulse * body.mass * 0.5;
            this.applyImpact(Math.abs(impulse), wp, 'impact');
            if (env.onImpact) env.onImpact(this, wp, impulse, col);
            if (col.destructible && strength > 400) env.landmarks.damage(col, strength * 0.02);
          }
        }
      }
    }
  }
  hitWorld(n, depth, point, col, env) {
    const body = this.body;
    const vn = body.velocity.dot(n);
    const dv = -(1.3) * Math.min(0, vn);
    body.velocity.addScaledVector(n, dv);
    body.position.addScaledVector(n, depth * 0.8);
    this.applyImpact(Math.abs(vn), point, 'impact');
    if (env.onImpact) env.onImpact(this, point, Math.abs(vn), col);
  }

  updateVisualTransform(dt = 0.016) {
    this.group.position.copy(this.body.position);
    this.group.quaternion.copy(this.body.quaternion);
    const c = this.controls;
    // 控制面偏转
    for (const cs of this.controlMeshes) {
      let defl = 0;
      switch (cs.type) {
        case 'elevator': defl = -c.pitch * 0.42; break;
        case 'aileron': defl = c.roll * 0.36 * (cs.part.pos[0] >= 0 ? 1 : -1); break;
        case 'rudder': defl = c.yaw * 0.42; break;
        case 'flap': defl = c.flaps * 0.55; break;
        case 'elevon': defl = -c.pitch * 0.32 + c.roll * 0.28 * (cs.part.pos[0] >= 0 ? 1 : -1); break;
      }
      const axis = cs.type === 'rudder' ? 'y' : 'x';
      if (axis === 'y') cs.hinge.rotation.y = Math.PI / 2 + defl; else cs.hinge.rotation.x = defl;
    }
    // 螺旋桨旋转
    for (const p of this.propMeshes) {
      const rpm = p.linked ? p.linked.rpm01 : this.controls.throttle * 0.8;
      p.mesh.rotation.z = (p.mesh.rotation.z + rpm * 60 * (this.propMeshes.length > 1 ? 0.35 : 1)) % TAU;
    }
    // 起落架收放
    for (const g of this.gearVisuals) {
      g.mesh.rotation.x = (1 - c.gearT) * 1.4;
      g.mesh.position.y = (1 - c.gearT) * g.part.size[1] * 0.6;
    }
  }

  updateHUDState(dt, env) {
    const s = this.state, body = this.body;
    const terrain = env.terrain;
    s.position = body.position; s.quaternion = body.quaternion; s.velocity = body.velocity;
    s.speed = body.velocity.length();
    s.mach = s.speed / 340.29;
    s.altitudeASL = body.position.y;
    s.altitudeAGL = terrain ? body.position.y - terrain.heightAt(body.position.x, body.position.z) : body.position.y;
    s.verticalSpeed = body.velocity.y;
    const e = _e.setFromQuaternion(body.quaternion, 'YXZ');
    s.pitch = e.x * RAD2DEG; s.roll = e.z * RAD2DEG;
    let hdg = (-e.y) * RAD2DEG; hdg = ((hdg % 360) + 360) % 360;
    s.heading = hdg;
    s.throttle = this.controls.throttle;
    s.rpm01 = this.engines.length ? this.engines.reduce((a, x) => a + x.rpm01, 0) / this.engines.length : 0;
    s.aoa = this.aoaWeight > 0 ? this.aoaAccum / this.aoaWeight : 0;
    s.stall = Math.abs(s.aoa) > 0.30 && s.speed > 8;
    s.stalled = s.stall && s.speed > 8;
    s.fuel01 = this.fuel / this.fuelCapacity;
    s.health01 = this.health;
    s.gearDown = this.controls.gear; s.gear01 = this.controls.gearT;
    s.flaps01 = this.controls.flaps; s.airbrake01 = this.controls.airbrake;
    s.mass = body.mass;
    s.thrust = this.thrustAccum; s.lift = this.liftAccum; s.drag = this.dragAccum;
    // 过载
    const accel = (this.thrustAccum + this.liftAccum) / Math.max(1, body.mass) / 9.81;
    this.gForce = damp(this.gForce, clamp(accel, -4, 12), 5, dt);
    s.gForce = this.gForce;
    s.crashed = this.crashed; s.destroyed = this.destroyed;
    s.engines = this.engines.map((en) => ({
      id: en.id, type: en.type, rpm01: en.rpm01, throttle01: en.throttle01, position: en.position, active: en.active,
    }));
    // 武器（HUD 显示）
    s.weapons = this.weapons.map((w) => ({
      name: { gun: '机炮', missile: '导弹', bomb: '炸弹', flare: '干扰弹' }[w.spec.type] || w.spec.type,
      ammo: w.ammo, active: w.cooldown <= 0,
    }));
    this.warnings.clear();
    if (s.stall) this.warnings.add('STALL');
    if (s.altitudeAGL < 150 && s.verticalSpeed < -8 && !this.controls.gear) this.warnings.add('PULL UP');
    if (this.fuel / this.fuelCapacity < 0.12) this.warnings.add('LOW FUEL');
    if (this.health < 0.35) this.warnings.add('DAMAGE');
    if (this.gForce > 8) this.warnings.add('G-LOAD');
    s.warnings = [...this.warnings];
  }

  /* ---------------------------------------------------------------- 武器 */
  updateWeaponState(dt, env) {
    const pm = env.projectiles;
    for (const w of this.weapons) {
      w.cooldown = Math.max(0, w.cooldown - dt);
    }
    if (!pm || this.crashed) return;
    const c = this.controls;
    const gun = this.weapons.filter((w) => w.spec.type === 'gun');
    if (c.fire1 && gun.length) {
      for (const w of gun) {
        if (w.cooldown > 0 || w.ammo <= 0) continue;
        w.cooldown = 60 / w.spec.rpm;
        w.ammo--;
        const wp = _v.copy(w.position).applyQuaternion(this.body.quaternion).add(this.body.position);
        const dir = _v2.copy(w.dir).applyQuaternion(this.body.quaternion).normalize();
        pm.spawnBullet(wp, dir, this.body.velocity, 900, w.spec.damage, this);
        if (env.onEvent) env.onEvent('gun', { position: wp, aircraft: this });
      }
    }
    const rails = this.weapons.filter((w) => w.spec.type === 'missile');
    if (c.fire2 && rails.length) {
      const w = rails.find((x) => x.cooldown <= 0 && x.ammo > 0);
      if (w) {
        w.cooldown = 1.2; w.ammo--;
        const wp = _v.copy(w.position).applyQuaternion(this.body.quaternion).add(this.body.position);
        const dir = _v2.copy(w.dir).applyQuaternion(this.body.quaternion).normalize();
        pm.spawnMissile(wp, dir, this.body.velocity, this, env.targets || []);
        if (env.onEvent) env.onEvent('missile', { position: wp, aircraft: this });
      }
    }
    const bombs = this.weapons.filter((w) => w.spec.type === 'bomb');
    if (c.dropBomb && bombs.length) {
      const w = bombs.find((x) => x.cooldown <= 0 && x.ammo > 0);
      if (w) {
        w.cooldown = 0.4; w.ammo--;
        const wp = _v.copy(w.position).applyQuaternion(this.body.quaternion).add(this.body.position);
        pm.spawnBomb(wp, this.body.velocity, this, w.spec.damage);
      }
    }
    if (c.flare) {
      const fl = this.weapons.find((w) => w.spec.type === 'flare' && w.ammo > 0);
      if (fl && Math.random() < 0.4) { fl.ammo--; pm.spawnFlare(this.body.position, this.body.velocity); }
    }
    if (c.chute && this.hasChute && !this.chuteDeployed && this.body.position.y > 3) {
      this.chuteDeployed = true;
      if (env.onEvent) env.onEvent('chute', { aircraft: this });
    }
  }

  /* ---------------------------------------------------------------- 损毁 */
  /**
   * 施加伤害（对齐原版：伤害落在**撞击点附近的零件**上，零件血量归零就脱落）。
   * @param {number} amount 伤害值（零件血量量级：常见零件 40–200）
   * @param {THREE.Vector3} point 世界坐标撞击点
   * @param {string} cause 'ground'|'impact'|'bullet'|'missile'|'bomb'|'pvp'|...
   * @returns {{broke:number, killed:boolean}}
   */
  applyDamage(amount, point, cause = 'damage') {
    if (this.destroyed || amount <= 0) return { broke: 0, killed: false };
    // 联机：远端玩家受到的伤害由他本机权威结算
    if (this.remote && this.remoteDamageHook) { this.remoteDamageHook(amount, point, cause); return { broke: 0, killed: false }; }
    const p = point || this.body.position;
    // 命中音效（子弹/导弹/炸弹）
    if (cause === 'bullet' || cause === 'missile' || cause === 'bomb' || cause === 'pvp') {
      if (this.onEvent) this.onEvent('hullHit', { aircraft: this, cause, position: p, amount });
    }
    // 子弹/破片只打到一个零件上，撞地/爆炸影响一片
    const spread = (cause === 'bullet') ? 0.35 : (cause === 'ground' || cause === 'impact') ? 1.0 : 0.75;
    const res = this._damagePartsAt(p, amount, cause, spread);
    this._recomputeHealth();
    // ---- 结构化判定（原版：关键件没了 / 结构散架 / 单次巨力直接炸） ----
    if (res.criticalLost) { this.destroy('cockpit'); return { broke: res.broke, killed: true }; }
    // 只有「撞地/撞物」这种一次性能量才会直接炸；武器伤害走零件脱落逻辑（不然一发导弹就秒杀）
    if (amount >= 300 && (cause === 'impact' || cause === 'ground')) {
      this.destroy('impact'); return { broke: res.broke, killed: true };
    }
    if (this.health <= 0.22) { this.destroy('structural'); return { broke: res.broke, killed: true }; }
    return { broke: res.broke, killed: false };
  }

  /**
   * 把伤害分配到撞击点附近的零件上。
   * @returns {{broke:number, criticalLost:boolean}}
   */
  _damagePartsAt(worldPoint, amount, cause, spread = 1) {
    const hits = [];
    for (const ps of this.partState) {
      if (ps.dead || ps.hp <= 0) continue;
      _v.copy(ps.local).applyQuaternion(this.body.quaternion).add(this.body.position);
      const d = _v.distanceTo(worldPoint);
      const r = ps.radius * 1.15 * spread + 0.8;
      if (d > r) continue;
      const t = clamp01(1 - d / r);
      hits.push({ ps, w: t * t + 0.05, d });   // 平方衰减：越近的零件吃到的伤害越多
    }
    if (!hits.length) {
      // 兜底：伤害落到最近的零件，绝不"打空"
      let best = null, bd = Infinity;
      for (const ps of this.partState) {
        if (ps.dead || ps.hp <= 0) continue;
        _v.copy(ps.local).applyQuaternion(this.body.quaternion).add(this.body.position);
        const d = _v.distanceTo(worldPoint);
        if (d < bd) { bd = d; best = ps; }
      }
      if (!best) return { broke: 0, criticalLost: false };
      hits.push({ ps: best, w: 1, d: bd });
    }
    hits.sort((a, b) => a.d - b.d);
    const wsum = hits.reduce((a, h) => a + h.w, 0) || 1;
    let broke = 0, criticalLost = false;
    for (const h of hits) {
      const ps = h.ps;
      const dmg = amount * (h.w / wsum);
      ps.hp -= dmg;
      this._applyDamageTint(ps);
      if (ps.hp <= 0) {
        ps.dead = true; ps.hp = 0;
        broke++;
        if (ps.critical) criticalLost = true;
        this.pendingDetach.push(ps.uid);
      }
    }
    // 只处理最近的一批，避免一次撞地刷屏
    if (this.pendingDetach.length > 12) this.pendingDetach.length = 12;
    return { broke, criticalLost };
  }

  /** 全局健康度 = 按质量加权的剩余零件血量 */
  _recomputeHealth() {
    let cur = 0;
    for (const ps of this.partState) cur += Math.max(0, ps.hp) * ps.mass;
    this.health = clamp01(cur / this._hpMassTotal);
  }

  /** 受损零件外观：先变暗，重伤再发光（材质按需克隆，没受伤的零件共用材质） */
  _applyDamageTint(ps) {
    const ratio = ps.hp / ps.maxHp;
    if (ratio > 0.6 && ps.tinted) return;
    const mesh = this.partMeshes.get(ps.uid);
    if (!mesh) return;
    if (!ps.tinted) {
      ps.tinted = true;
      mesh.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        o.material = o.material.clone();
        o.material.color.multiplyScalar(0.78);
      });
    }
    // 重伤：自发光红热
    const heavy = ratio <= 0.25;
    mesh.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.emissive) return;
      if (heavy) { o.material.emissive.setHex(0xff3300); o.material.emissiveIntensity = 0.45 + 0.3 * (1 - ratio); }
      else if (ratio <= 0.6) { o.material.emissive.setHex(0x000000); o.material.emissiveIntensity = 0; }
    });
  }

  destroy(cause = 'destroyed') {
    if (this.destroyed) return;
    this.destroyed = true;
    this.health = 0;
    this.destroyCause = cause;
    if (this.fx && this.fx.explosion) this.fx.explosion(this.body.position, 3.2);
    if (this.onEvent) this.onEvent('destroyed', { aircraft: this, cause, position: this.body.position });
    // 碎片：把每个零件变成一个简单碎片，抛飞
    this.debris = [];
    const root = this.group.parent;   // 场景（没有就退化成局部坐标）
    const parts = [...this.craft.parts];
    for (const p of parts) {
      const mesh = this.partMeshes.get(p.uid);
      if (!mesh) continue;
      const worldPos = new THREE.Vector3(...p.pos).sub(this.com).applyQuaternion(this.body.quaternion).add(this.body.position);
      const worldQuat = this.body.quaternion.clone();
      if (root) {
        mesh.removeFromParent();
        root.add(mesh);
        mesh.position.copy(worldPos);
        mesh.quaternion.copy(worldQuat);
      }
      this.debris.push({
        mesh, worldPos, worldQuat,
        vel: this.body.velocity.clone().add(new THREE.Vector3((Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14)),
        rot: new THREE.Euler().setFromQuaternion(worldQuat),
        rvel: new THREE.Vector3((Math.random() - .5) * 4, (Math.random() - .5) * 4, (Math.random() - .5) * 4),
        landed: false,
      });
    }
    this.group.visible = false;   // 机体本体藏起来，只剩碎片
  }

  updateDebris(dt, terrain, onGone) {
    if (!this.debris) return;
    for (const d of this.debris) {
      d.vel.y -= 9.81 * dt;
      d.worldPos.addScaledVector(d.vel, dt);
      d.rot.x += d.rvel.x * dt; d.rot.y += d.rvel.y * dt; d.rot.z += d.rvel.z * dt;
      const gh = terrain ? terrain.heightAt(d.worldPos.x, d.worldPos.z) : 0;
      if (d.worldPos.y < gh + 0.2) {
        if (!d.landed && d.vel.lengthSq() > 4) {
          d.landed = true;
          if (this.onEvent) this.onEvent('debris', { aircraft: this, position: d.worldPos.clone() });
        }
        d.worldPos.y = gh + 0.2; d.vel.multiplyScalar(0.25); d.vel.y = Math.abs(d.vel.y) * 0.2; d.rvel.multiplyScalar(0.6);
      }
      d.mesh.position.copy(d.worldPos); d.mesh.rotation.copy(d.rot);
    }
  }

  /** 引擎/结构过载导致零件脱落 */
  applyPendingDetach() {
    if (!this.pendingDetach.length) return;
    for (const uid of this.pendingDetach) this.detachPart(uid);
    this.pendingDetach.length = 0;
  }

  /**
   * 让一个零件脱落：移除外观 + 变成碎片 + 连带失效（动力/武器/起落架/油箱/翼面）。
   * 对齐原版：掉了发动机就没推力，掉了机翼就没升力，掉了座舱就完蛋。
   */
  detachPart(uid) {
    const craft = this.craft;
    const idx = craft.parts.findIndex((p) => p.uid === uid);
    if (idx < 0) return;
    const p = craft.parts[idx];
    const def = PART_DEFS[p.def] || {};
    const mesh = this.partMeshes.get(uid);
    const s = this.surfaces.find((x) => x.part.uid === uid);
    if (s) s.detached = true;
    if (mesh) {
      const wp = new THREE.Vector3(...p.pos).sub(this.com).applyQuaternion(this.body.quaternion).add(this.body.position);
      const wq = this.body.quaternion.clone();
      const root = this.group.parent;
      mesh.removeFromParent();
      if (root) { root.add(mesh); mesh.position.copy(wp); mesh.quaternion.copy(wq); }
      this.debris = this.debris || [];
      this.debris.push({
        mesh, worldPos: wp, worldQuat: wq,
        vel: this.body.velocity.clone().addScaledVector(new THREE.Vector3((Math.random() - .5), Math.random() * 0.5, (Math.random() - .5)), 6),
        rot: new THREE.Euler().setFromQuaternion(this.body.quaternion),
        rvel: new THREE.Vector3((Math.random() - .5) * 5, (Math.random() - .5) * 5, (Math.random() - .5) * 5),
        landed: false,
      });
    }
    // 连带失效
    const eng = this.engines.find((e) => e.part.uid === uid);
    if (eng) { eng.health01 = 0; eng.rpm01 = 0; eng.active = false; }
    this.weapons = this.weapons.filter((w) => w.part.uid !== uid);
    this.gears = this.gears.filter((g) => g.part.uid !== uid);
    const tank = this.tanks.find((t) => t.part && t.part.uid === uid);
    if (tank) {
      this.tanks = this.tanks.filter((t) => t !== tank);
      const cap = this.tanks.reduce((a, t) => a + t.capacity, 0) || 1;
      this.fuel = Math.min(this.fuel, cap);
      this.fuelCapacity = cap;
    }
    // 重新计算质量与惯性（保持简单：按比例缩小）
    const m = Math.max(1, partMass(p));
    const frac = Math.max(0, (this.body.mass - m) / Math.max(1, this.body.mass));
    this.body.setMass(Math.max(20, this.body.mass - m));
    this.body.setInertia(new THREE.Vector3(
      Math.max(20, this.body.inertia.x * frac), Math.max(20, this.body.inertia.y * frac), Math.max(20, this.body.inertia.z * frac)));
    // 事件（音效/计分）
    if (this.onEvent) {
      this.onEvent('partLost', {
        aircraft: this, part: p, defId: p.def,
        kind: def.cat === 'wing' ? 'wing' : def.engine ? 'engine' : 'part',
        position: new THREE.Vector3(...p.pos).sub(this.com).applyQuaternion(this.body.quaternion).add(this.body.position),
        remaining: this.partState.filter((ps) => !ps.dead).length,
      });
    }
  }

  /**
   * 撞击：按动能扣零件血（原版手感——轻擦掉一点血，重撞断零件）。
   * @param {number} speed 撞击速度 m/s
   * @param {THREE.Vector3} point 撞击点
   * @param {string} cause
   */
  applyImpact(speed, point, cause = 'impact') {
    if (this.destroyed || speed <= 0) return { broke: 0 };
    // 标定：dmg ≈ v²·0.55·(0.6+0.4·min(1,m/1500))
    //   v=2  → ~2     正常着陆：不掉血
    //   v=6  → ~17    轻擦：撞击点零件掉一点血
    //   v=15 → ~109   重着陆：撞到的零件基本报废
    //   v=26 → ~327   砸地：断好几个零件/直接炸
    const massFactor = 0.6 + 0.4 * Math.min(1, this.body.mass / 1500);
    const dmg = speed * speed * 0.8 * massFactor;
    if (dmg < 3) return { broke: 0 };                     // 轻微接触不掉血、不变色
    const res = this.applyDamage(dmg, point, cause);
    // 蹭地音效（高频调用做节流）
    const now = this.time;
    if (cause === 'ground' && speed > 3 && now - this._lastScrapeSfx > 0.12) {
      this._lastScrapeSfx = now;
      if (this.onEvent) this.onEvent('scrape', { aircraft: this, position: point, speed });
    }
    return res;
  }

  /* ---------------------------------------------------------------- 工具 */
  /** 停机时质心距地面的高度（用于出生点定位，避免穿地弹飞） */
  getRestHeight() {
    let h = 0.6;
    for (const g of this.gears) { h = Math.max(h, g.radius - g.position.y); }
    if (!this.gears.length) h = (this.collisionSpheres[Math.floor(this.collisionSpheres.length / 2)]?.radius + 0.1) || 1;
    return h;
  }

  /**
   * 求解静止姿态：弹簧-质量系统在重力下的平衡俯仰角与机体高度。
   * 消除出生瞬间的“砸地”振荡。
   * @returns {{ y:number, pitch:number }} pitch 为绕 +X 的弧度（正 = 抬头）
   */
  computeStaticPose() {
    let Sk = 0, SkB = 0, SkA = 0, SkBB = 0, SkBA = 0;
    for (const g of this.gears) {
      const A = g.radius - g.position.y, B = g.position.z, k = g.stiffness;
      Sk += k; SkB += k * B; SkA += k * A; SkBB += k * B * B; SkBA += k * B * A;
    }
    if (Sk <= 0) return { y: this.getRestHeight(), pitch: 0 };
    const W = this.body.mass * 9.81;
    const r1 = SkA - W, r2 = SkBA;
    const det = -Sk * SkBB + SkB * SkB;
    if (Math.abs(det) < 1e-3) return { y: Math.max(0.2, (SkA - W) / Sk), pitch: 0 };
    const h = (-r1 * SkBB + SkB * r2) / det;
    const th = (Sk * r2 - SkB * r1) / det;
    return { y: clamp(h, 0.3, 1e5), pitch: clamp(th, -0.22, 0.22) };
  }

  /** 把飞机平稳地放到地面上（避免出生穿透） */
  placeOnGround(terrain, x, z, heading = 0) {
    const pose = this.computeStaticPose();
    const gy = terrain ? terrain.heightAt(x, z) : 0;
    this.body.position.set(x, gy + pose.y, z);
    this.body.quaternion.setFromEuler(new THREE.Euler(pose.pitch, heading, 0, 'YXZ'));
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.updateVisualTransform(0.016);
    return this;
  }

  reset(position, heading = 0, speed = 0) {
    this.body.position.copy(position);
    this.body.quaternion.setFromEuler(new THREE.Euler(0, heading, 0));
    this.body.velocity.set(0, 0, 0).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(this.body.quaternion), speed);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.clearForces();
    // 恢复所有零件（对齐原版：重置等于换一架新飞机）
    for (const ps of this.partState) {
      ps.hp = ps.maxHp; ps.dead = false; ps.tinted = false;
      const mesh = this.partMeshes.get(ps.uid);
      const pp = ps.part;
      if (mesh) {
        // 从碎片状态归位：放回机体、恢复零件的局部位置与姿态、重置材质
        if (mesh.parent !== this.visual) this.visual.add(mesh);
        mesh.position.set(pp.pos[0] - this.com.x, pp.pos[1] - this.com.y, pp.pos[2] - this.com.z);
        mesh.rotation.set(pp.rot[0] * DEG, pp.rot[1] * DEG, pp.rot[2] * DEG);
      }
      if (mesh) {
        mesh.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          if (o.material.emissive) { o.material.emissive.setHex(0x000000); o.material.emissiveIntensity = 0; }
          o.material.color.multiplyScalar(1 / 0.78);
        });
      }
    }
    this.group.visible = true;   // 机体重新出现
    this.pendingDetach.length = 0;
    if (this.debris) { for (const d of this.debris) d.mesh.removeFromParent(); this.debris = []; }
    // ---- 完整修复：动力/起落架/油箱/武器全部重建，质量与惯性回到初始值 ----
    this._buildSystems();
    this.body.setMass(Math.max(20, this.dryMass + this.fuelCapacity * 0.8));
    this.body.setInertia(this._baseInertia.clone());
    this.frontalArea = this.frontalArea;   // 保持不变
    this.health = 1; this.destroyed = false; this.crashed = false; this.destroyCause = null;
    this.chuteDeployed = false;
    this.controls.throttle = 0; this.controls.gear = true; this.controls.gearT = 1;
    this.controls.fire1 = false; this.controls.fire2 = false; this.controls.flare = false;
    this.controls.flaps = 0; this.controls.airbrake = 0; this.controls.brake = 0;
    this.inputTarget.pitch = 0; this.inputTarget.roll = 0; this.inputTarget.yaw = 0;
    this.inputTarget.throttle = 0; this.inputTarget.brake = 0; this.inputTarget.flaps = 0; this.inputTarget.airbrake = 0;
    for (const e of this.engines) { e.rpm01 = 0; e.health01 = 1; e.active = false; }
    for (const w of this.weapons) { w.ammo = w.spec.ammo ?? w.spec.count ?? 1; w.cooldown = 0; }
    this.fuel = this.fuelCapacity;
    this.warnings.clear();
    this._lastScrapeSfx = 0;
    this.updateVisualTransform(0.016);
  }

  /** 相机跟随点 */
  getCameraAnchor(out = new THREE.Vector3()) { return out.copy(this.body.position).addScaledVector(this.body.velocity, 0.05); }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { if (o.isMesh) { o.geometry?.dispose?.(); } });
  }
}
