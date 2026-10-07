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
import { PART_DEFS, buildPartMesh, buildControlSurfaces, partFeatures, partMass } from '../build/parts.js';
import { RigidBody, solveWing, airDensity, resolveSphereBox, acOffset } from './physics.js';
import { clamp, clamp01, lerp, damp, DEG, RAD2DEG, TAU } from '../core/util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3();
// 地面接触专用（与 _v1.._v7 隔离，保证热路径零分配且互不踩踏）
const _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _g3 = new THREE.Vector3();
const _g4 = new THREE.Vector3(), _g5 = new THREE.Vector3();
const _bv = new THREE.Vector3();   // 翼面局部气流速度（每帧复用）
const _vTrim = new THREE.Vector3(); // 配平速度求解用的气流方向临时量
const _wind = new THREE.Vector3(), _wind2 = new THREE.Vector3(); // 风场采样 / 本机当前风
/** 螺旋桨反扭矩系数（N·m，油门 1 / rpm 1 时）。配平计算必须用同一个常量。 */
const PROP_TORQUE = 260;
/**
 * 上反角“侧滑->滚转”耦合强度系数（1 = 教科书公式）。
 * 真实值会让飞机有 2~5°/s 的螺旋不稳定性（真机靠飞行员/自动驾驶不停修正），
 * 这里取 0.6 让「松手飞」也能保持大致平直，同时保留上反角的稳定手感。
 */
const DIHEDRAL_SCALE = 0.6;
/**
 * 短周期/荷兰滚目标阻尼比。面元模型只算出了尾翼那一份阻尼，
 * 机翼/机身/非定常附着流那一份缺失，导致真实测量到的 ζ 只有 0.03~0.08
 * （现象：抬轮后俯仰角来回振荡、机头一上一下、跟着侧滑甩滚转）。
 * 这里在构造时测出固有刚度与固有阻尼，再补足到目标 ζ 的“阻尼增稳”力矩。
 */
const ZETA_PITCH = 0.5;
const ZETA_YAW = 0.45;
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
    // 可动控制面（副翼/升降副翼左右各一块，因此是数组）
    for (const hinge of buildControlSurfaces(part)) {
      mesh.add(hinge);
      controlSurfaces.push({ part, hinge, type: hinge.userData.controlType });
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
    // 一个翼类零件 = 一整片翼（展向关于零件原点对称）。位于机身中线的主翼会被拆成
    // 左右两个半翼面，这样滚转力矩/滚转阻尼才是自然产生的；副翼也按左右两块布置。
    this.surfaces = [];
    for (const p of craft.parts) {
      const f = partFeatures(p);
      if (!f.aero || (f.aero.type !== 'wing' && f.aero.type !== 'plate')) continue;
      const a = f.aero;
      const dih = (a.dihedral != null ? a.dihedral : (p.props.dihedral ?? 0)) * DEG;
      const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG));
      const base = new THREE.Vector3(p.pos[0] - stats.com.x, p.pos[1] - stats.com.y, p.pos[2] - stats.com.z);
      const normal = new THREE.Vector3(-Math.sin(dih) * DIHEDRAL_SCALE, Math.cos(dih), 0).applyQuaternion(rot).normalize();
      const normalL = new THREE.Vector3(-Math.sin(dih) * DIHEDRAL_SCALE, Math.cos(dih), 0).applyQuaternion(rot).normalize();
      normalL.x = -normalL.x;    // 左侧镜像（上反角方向相反）
      const chordDir = new THREE.Vector3(0, 0, 1).applyQuaternion(rot).normalize();
      const spanDir = new THREE.Vector3(Math.cos(dih), Math.sin(dih), 0).applyQuaternion(rot).normalize();
      const hp = PART_DEFS[p.def]?.hp ?? 100;
      const isMain = !!PART_DEFS[p.def]?.mainWing;
      const incidence = (a.incidence ?? 0) * DEG;      // 安装角（尾翼 -2° / 鸭翼 +1.5°）
      // 只有「水平放置」的翼面才吃机翼下洗（垂直尾翼吃的是侧洗，下洗是竖直速度分量，
      // 对法线水平的垂尾没有迎角贡献；旧实现给它加下洗 → 每次都要 0.1 的方向舵配平）
      const washable = Math.abs(normal.y) > 0.5;
      // 气动中心（1/4 MAC）相对零件原点的偏移。翼面力必须作用在这里而不是弦中点，
      // 否则俯仰力矩 / 中性点全错（三角翼能差出 1m 以上）
      const acZ = acOffset(a.chord, a.taper ?? 1, a.sweep ?? 0);
      const acZail = acOffset(a.chord * 0.3, 1, 0);
      // 俯仰方向：按舵面在重心之前/之后（鸭翼必须反向）；偏航方向：按垂尾法线朝向
      const pitchDir = (p.pos[2] - stats.com.z) >= 0 ? 1 : -1;
      const rudderDir = normal.x > 0 ? -1 : 1;
      // 仅当舵面零件本身时才有铰链偏移（气动中心略靠后）
      const hingeZ = a.control ? p.size[2] * 0.12 : 0;

      const mkAileron = (x, sgn) => ({
        part: p, area: a.area * 0.1, span: a.span * 0.175, chord: a.chord * 0.3, thick: a.thick ?? 0.12,
        cd0: 0.02, control: 'aileron', rollDir: sgn > 0 ? -1 : 1, controlDir: sgn > 0 ? -1 : 1, liftScale: 1, isAileron: true,
        normal: (sgn > 0 ? normal : normalL).clone(), chordDir: chordDir.clone(), spanDir: spanDir.clone(), incidence, washable,
        position: new THREE.Vector3(base.x + x, base.y, base.z + hingeZ + acZail), hp,
      });

      const centered = (a.type === 'wing' && !a.control && Math.abs(base.x) < Math.min(0.75, a.span * 0.3));
      if (centered) {
        for (const sgn of [-1, 1]) {
          this.surfaces.push({
            part: p, area: a.area * 0.5, span: a.span * 0.5, chord: a.chord, thick: a.thick ?? 0.12, cd0: a.cd0 ?? 0.012,
            control: null, controlDir: 1, liftScale: 1, isWing: true, halfWing: true, incidence,
            // 上反角法线左右镜像：否则两侧机翼的“侧滑→差动迎角”会互相抵消，失去滚转静稳定性
            normal: (sgn > 0 ? normal : normalL).clone(), chordDir: chordDir.clone(), spanDir: spanDir.clone(), washable,
            position: new THREE.Vector3(base.x + sgn * a.span * 0.25, base.y, base.z + acZ),
            rollDir: sgn > 0 ? -1 : 1, pitchDir, rudderDir, hp,
          });
          if (isMain) this.surfaces.push(mkAileron(sgn * a.span * 0.4125, sgn));
        }
      } else {
        const s = {
          part: p, area: a.area, span: a.span, chord: a.chord, thick: a.thick ?? 0.12, cd0: a.cd0 ?? 0.012,
          control: a.control || null, controlDir: 1, liftScale: 1, incidence, washable,
          normal: normal.clone(), chordDir: chordDir.clone(), spanDir: spanDir.clone(),
          position: new THREE.Vector3(base.x, base.y, base.z + hingeZ + acZ),
          hp,
        };
        s.rollDir = base.x >= 0 ? -1 : 1;
        s.pitchDir = pitchDir;
        s.rudderDir = rudderDir;
        s.controlDir = pitchDir;
        s.isWing = (a.type === 'wing' && !a.control && Math.abs(base.x) > 0.35);
        this.surfaces.push(s);
        // 偏离中线的主翼：自动附带外侧副翼（真实滚转力矩）
        if (s.isWing) {
          const sgn = base.x >= 0 ? 1 : -1;
          this.surfaces.push(mkAileron(sgn * (Math.abs(base.x) + a.span * 0.35), sgn));
        }
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
    // 机翼气动中心的 z：用来区分「机翼之后」的尾翼（下洗）与「机翼之前」的鸭翼（上洗）
    {
      let za = 0, aa = 0;
      for (const s of this.surfaces) if (s.isWing) { za += s.position.z * s.area; aa += s.area; }
      this.wingACz = aa > 0 ? za / aa : 0;
    }

    this._buildSystems();

    /* ---------------- 配平 / 阻尼增稳 ---------------- */
    // 巡航状态下三轴力矩为零所需的舵量 + 短周期/荷兰滚阻尼补足量。
    // 没有它，重心或尾翼稍有偏差就会「一松手就低头俯冲」，抬轮后还会持续振荡。
    const aero = this._analyzeAero();
    this.pitchTrim = aero.pitch;
    this.yawTrim = aero.yaw;
    this.rollTrim = aero.roll;
    this.dampPitch = aero.dampPitch || 0;
    this.dampYaw = aero.dampYaw || 0;
    this.dampRoll = aero.dampRoll || 0;
    this.rollSlope = aero.rollSlope || 0;
    this.qRef = aero.qRef || 0;
    /** 设计巡航速度（配平点）——速度/配平辅助的参考空速 */
    this.designV = aero.V || 0;
    /** 配平俯仰角（= 平飞迎角）——姿态保持的目标角，避免把飞机按成 0° 俯冲 */
    this.trimPitchAngle = aero.alpha || 0;
    /** 螺旋桨反扭矩在线配平：当前需要抵消的滚转力矩 / 舵面滚转力矩斜率 */
    this._propTorque = 0;

    /* ---------------- 其他 ---------------- */
    this.hasChute = craft.parts.some((p) => PART_DEFS[p.def]?.chute);
    this.chuteDeployed = false;
    this.hasPilot = craft.parts.some((p) => PART_DEFS[p.def]?.pilot);
    this.cargoParts = craft.parts.filter((p) => PART_DEFS[p.def]?.cargo).map((p) => p.uid);
    this.radius = Math.max(1.5, stats.size.length() * 0.42);
    this.collisionSpheres = this._buildCollisionSpheres(stats, 4);
    // 机腹/尾椎接触点：正常滑跑时离地，抬轮过度会“尾椎擦地”被压住，
    // 起落架全没了也能用肚子迫降（旧实现只有包围球，抬轮 20°+ 会直接翻过去）
    this.bellyPoints = this._buildBellyPoints(stats);

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
   * 气动分析（构造时只跑一次）：巡航配平舵量 + 阻尼增稳增益 + 操纵功率。
   * ------------------------------------------------------------------
   * 1) 配平：在巡航设计点（平飞迎角、设计动压）用真正的 solveWing 做差商，
   *    求俯仰/偏航/滚转三轴力矩归零所需的舵量。没有它，重心或尾翼稍有偏差就会
   *    「一松手就低头俯冲」；方向舵配平的侧力经垂尾高度还会产生滚转力矩。
   * 2) 阻尼：面元模型只算得出尾翼那一份俯仰/偏航阻尼，机翼+机身+非定常那部分缺失，
   *    实测 ζ 只有 0.03~0.08 —— 抬轮后就会出现持续的俯仰振荡与荷兰滚。这里测出
   *    固有刚度 K 与固有阻尼 D，补一块力矩把阻尼比抬到目标值。
   * 3) 操纵功率：记录舵面滚转力矩斜率，供螺旋桨反扭矩的在线配平使用。
   * @returns {{pitch:number,yaw:number,roll:number,dampPitch:number,dampYaw:number,rollSlope:number,qRef:number}}
   * @private
   */
  _analyzeAero() {
    const none = { pitch: 0, yaw: 0, roll: 0, dampPitch: 0, dampYaw: 0, rollSlope: 0, qRef: 0 };
    let wingArea = 0, wingCL = 0;
    for (const s of this.surfaces) if (s.isWing && !s.isAileron) wingArea += s.area;
    if (wingArea < 0.5 || this.surfaces.length < 2) return none;

    const W = this.body.mass * 9.81;
    // 配平分析用的空气密度：取 2000m 标准大气（0.90 × 海平面）。
    // 不能用海平面 1.225 —— 飞机绝大多数任务在数百到数千米高度飞行，那里密度
    // 低 5~15%，同样的速度需要更大迎角（升力 ∝ ρV²），诱导阻力随之变大，真实
    // 平衡速度比海平面解高约 5%。实测 Warhound 海平面解 143、实际稳定在 151，
    // 差 5.6% 就是这么来的（连带 30s 掉高 300m）。统一用 2000m 密度可让配平点
    // 落在常用飞行高度的中位，误差最小。
    const rhoCruise = 1.103;   // 2000m 标准大气密度 kg/m³
    const rho = rhoCruise;
    // 设计巡航速度：先按「升力=重量（CL≈0.5 的舒适巡航点）」估一个初值，
    // 再用真实推力曲线修正 ———— 见下方 solveTrimSpeed()。
    const V0 = clamp(Math.sqrt(2 * W / (rho * wingArea * 0.5)), 40, 160);
    let V = V0;
    let qRef = 0.5 * rho * V * V;
    const out = { forceLocal: new THREE.Vector3(), alpha: 0, cl: 0, cd: 0, stall: false, q: 0 };
    const bv = new THREE.Vector3(), vLoc = new THREE.Vector3(), rArm = new THREE.Vector3();
    const ctlA = { pitch: 0, roll: 0, yaw: 0, flap: 0, airbrake: 0 };

    /** 在给定迎角/侧滑/机体角速度下的气动力矩（与 update() 的下洗模型完全一致） */
    const moments = (ctl, alpha, beta = 0, wx = 0, wy = 0, wz = 0) => {
      const ca = Math.cos(alpha), sa = Math.sin(alpha), cb = Math.cos(beta), sb = Math.sin(beta);
      bv.set(sb * V, -sa * V * cb, -ca * V * cb);
      const downwash = -clamp(wingCL, -1.4, 1.4) * 0.11;
      let mx = 0, my = 0, mz = 0, lift = 0, side = 0;
      for (const s of this.surfaces) {
        if (s.detached) continue;
        const wash = (!s.washable || s.isWing || s.isAileron) ? 0 : (s.position.z >= this.wingACz ? downwash : -downwash * 0.5);
        s.alphaOffset = (s.incidence || 0) + wash;
        // v_local = v_body + ω × r（机体坐标，分析时姿态为单位四元数）
        rArm.copy(s.position);
        vLoc.set(
          bv.x + (wy * rArm.z - wz * rArm.y),
          bv.y + (wz * rArm.x - wx * rArm.z),
          bv.z + (wx * rArm.y - wy * rArm.x),
        );
        solveWing(s, vLoc, rho, ctl, out, beta);
        const f = out.forceLocal;
        mx += s.position.y * f.z - s.position.z * f.y;   // 机体 +X = 抬头
        my += s.position.z * f.x - s.position.x * f.z;   // 机体 +Y = 左偏航
        mz += s.position.x * f.y - s.position.y * f.x;   // 机体 +Z = 左滚
        lift += f.y; side += f.x;
      }
      return { mx, my, mz, lift, side };
    };

    /* ---------------- 0) 先定巡航速度，再定平飞迎角 ---------------- */
    // 顺序很重要：迎角迭代要用到 qRef，而 qRef 由 V 决定。必须先把 V 定下来
    // （推力=阻力平衡点），否则迎角是按错误的动压算出来的，配平点会整体偏移
    // （实测 Skyfreighter 配平迎角 8.15°、实际收敛迎角 4.5°，差值被误当成
    // 抬头力矩，表现为「松手后缓慢抬头减速直至失速」）。
    const dragAtV = (Vq) => {
      // 阻力对迎角不敏感（诱导阻力项是小量），用固定 4° 近似即可，
      // 避免在迎角尚未求解时形成循环依赖
      const aRef = 0.07;
      const ca = Math.cos(aRef), sa = Math.sin(aRef);
      bv.set(0, -sa * Vq, -ca * Vq);
      const flow = _vTrim.copy(bv).normalize();
      let drag = 0;
      for (const s of this.surfaces) {
        if (s.detached) continue;
        s.alphaOffset = (s.incidence || 0);
        solveWing(s, bv, rho, ctlA, out, 0);
        drag += -out.forceLocal.dot(flow);
      }
      // 机身寄生阻力（与 update() 的 cdBody 同口径）—— 漏掉这一项会让求解出的
      // 平衡速度偏小，实际飞到这个速度时 T/D < 1，飞机只能靠掉高来补偿推力缺口
      // （实测 Warhound 在 159.6m/s 稳态时 T/D=0.812、升力/重量=0.986，
      //  30s 掉高 400+m —— 就是这里少算了 0.13×前向面积的寄生阻力）。
      drag += 0.5 * rho * Vq * Vq * (this.frontalArea || 0) * 0.13;
      return Math.max(0, drag);
    };
    const trimV = this._solveTrimSpeed(dragAtV);
    if (Number.isFinite(trimV) && trimV > 30) V = trimV;
    qRef = 0.5 * rho * V * V;

    // 迭代求平飞迎角：整机（机翼+平尾+升降舵）竖向升力 ≈ 重量。
    // 留 4% 余量：面元模型没算机身升力，也没算机体-机翼干扰带来的升力损失，
    // 实测按「升力=重量」求出的配平迎角偏小，飞机稳态时升力只有重量的 98.6%，
    // 结果就是「速度锁住了、但一直缓慢掉高」（Warhound 60s 掉 700m）。
    // 纯火箭机（Comet）不适用：它靠燃烧时段飞，没有稳定的平飞配平点，
    // 加余量反而把迎角抬过头（实测 Δh 从 +80m 恶化到 +441m）。
    const isRocket = this.engines.length > 0 && !this.engines.some((e) => e.type !== 'rocket');
    const needLift = W * (isRocket ? 1.0 : 1.04);
    let alpha = 0.06;
    for (let it = 0; it < 14; it++) {
      const m = moments(ctlA, alpha);
      const err = (needLift - m.lift) / (qRef * wingArea);
      alpha = clamp(alpha + err * 0.16, -0.2, 0.5);
    }
    // 第二轮：用求得的迎角重算阻力，修正平衡速度。
    // 首轮 dragAtV 用的是固定 4° 近似，而真实配平迎角往往只有 1~2°，
    // 4° 的诱导阻力偏大，导致解出的 V 偏小约 8%，飞机实际会飞到比 designV
    // 更快的速度上（实测 Warhound 134 -> 146）。用真迎角再解一次即收敛。
    const dragAtAlpha = (Vq) => {
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      bv.set(0, -sa * Vq, -ca * Vq);
      const flow = _vTrim.copy(bv).normalize();
      // 下洗与 update() 同口径：平尾处在机翼洗流里，迎角被压低，
      // 漏掉这一项会让平尾阻力/升力算偏，平衡速度也就偏了。
      const dw = -clamp(wingCL, -1.4, 1.4) * 0.11;
      let drag = 0;
      for (const s of this.surfaces) {
        if (s.detached) continue;
        const wash = (!s.washable || s.isWing || s.isAileron) ? 0 : (s.position.z >= this.wingACz ? dw : -dw * 0.5);
        s.alphaOffset = (s.incidence || 0) + wash;
        solveWing(s, bv, rho, ctlA, out, 0);
        drag += -out.forceLocal.dot(flow);
      }
      drag += 0.5 * rho * Vq * Vq * (this.frontalArea || 0) * 0.13;
      return Math.max(0, drag);
    };
    const trimV2 = this._solveTrimSpeed(dragAtAlpha);
    if (Number.isFinite(trimV2) && trimV2 > 30) V = trimV2;
    qRef = 0.5 * rho * V * V;
    // 迎角再迭代一次（速度变了，动压变了）
    for (let it = 0; it < 8; it++) {
      const m = moments(ctlA, alpha);
      const err = (needLift - m.lift) / (qRef * wingArea);
      alpha = clamp(alpha + err * 0.16, -0.2, 0.5);
    }
    wingCL = (() => {
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      bv.set(0, -sa * V, -ca * V);
      let clSum = 0, areaSum = 0;
      for (const s of this.surfaces) {
        if (!s.isWing || s.detached) continue;
        solveWing(s, bv, rho, ctlA, out, 0);
        clSum += out.cl * s.area; areaSum += s.area;
      }
      return areaSum > 0 ? clSum / areaSum : 0;
    })();

    /* ---------------- 1) 配平 ---------------- */
    const m0 = moments(ctlA, alpha);
    const mP = moments({ pitch: 0.1, roll: 0, yaw: 0, flap: 0, airbrake: 0 }, alpha);
    const mY = moments({ pitch: 0, roll: 0, yaw: 0.1, flap: 0, airbrake: 0 }, alpha);
    const pitchSlope = (mP.mx - m0.mx) / 0.1;
    const yawSlope = (mY.my - m0.my) / 0.1;
    const pitch = Math.abs(pitchSlope) < 1 ? 0 : clamp(-m0.mx / pitchSlope, -0.6, 0.6);
    const yaw = Math.abs(yawSlope) < 1 ? 0 : clamp(-m0.my / yawSlope, -0.4, 0.4);
    // 滚转配平：带着俯仰/偏航配平再求一次（方向舵侧力经垂尾高度产生滚转力矩）。
    // 螺旋桨反扭矩不在这里配平 —— 它随油门变化，运行时用舵面在线配平（见 _propTorque）。
    const baseCtl = { pitch, roll: 0, yaw, flap: 0, airbrake: 0 };
    const mB = moments(baseCtl, alpha);
    const mR = moments({ pitch, roll: 0.1, yaw, flap: 0, airbrake: 0 }, alpha);
    const rollSlope = (mR.mz - mB.mz) / 0.1;
    const roll = Math.abs(rollSlope) < 1 ? 0 : clamp(-mB.mz / rollSlope, -0.3, 0.3);

    /* ---------------- 2) 阻尼增稳 ---------------- */
    // 固有刚度（恢复力矩斜率，正值 = 稳定）与固有阻尼
    const dp = moments(baseCtl, alpha + 0.04).mx - moments(baseCtl, alpha - 0.04).mx;
    const Kpitch = -dp / 0.08;
    const dy = moments(baseCtl, alpha, 0.06).my - moments(baseCtl, alpha, -0.06).my;
    const Kyaw = -dy / 0.12;
    const dq = moments(baseCtl, alpha, 0, 0.4).mx - moments(baseCtl, alpha, 0, -0.4).mx;
    const DpitchNat = -dq / 0.8;
    const dr = moments(baseCtl, alpha, 0, 0, 0.4).my - moments(baseCtl, alpha, 0, 0, -0.4).my;
    const DyawNat = -dr / 0.8;
    const I = this._baseInertia;
    const dPitchTarget = 2 * ZETA_PITCH * Math.sqrt(Math.max(4, Kpitch) * I.x);
    const dYawTarget = 2 * ZETA_YAW * Math.sqrt(Math.max(4, Kyaw) * I.y);
    // 只补差额，且不超过目标本身的 1.25 倍（避免玩家自建畸形机型出现“糊住”的手感）
    const dampPitch = clamp(dPitchTarget - Math.max(0, DpitchNat), 0, dPitchTarget * 1.25);
    const dampYaw = clamp(dYawTarget - Math.max(0, DyawNat), 0, dYawTarget * 1.25);
    // 滚转本身阻尼已经很大（面板展向流动），只做兜底：ζ 过低时补一点
    const droll = moments(baseCtl, alpha, 0, 0, 0, 0.5).mz - moments(baseCtl, alpha, 0, 0, 0, -0.5).mz;
    const DrollNat = -droll / 1.0;
    const dRollTarget = 2 * 0.5 * Math.sqrt(Math.max(4, Math.abs(rollSlope) * 2.5) * I.z);
    const dampRoll = clamp(dRollTarget - Math.max(0, DrollNat), 0, dRollTarget * 1.25);

    return {
      pitch: Math.abs(pitch) < 0.01 ? 0 : pitch,
      yaw: Math.abs(yaw) < 0.002 ? 0 : yaw,
      roll: Math.abs(roll) < 0.005 ? 0 : roll,
      dampPitch, dampYaw, dampRoll,
      rollSlope, qRef, alpha, V,
    };  }

  /**
   * 求解「满油门平飞时推力=阻力」的平衡速度（二分法）。
   * 只对「常规动力」（喷气/螺旋桨/涡桨/电动）生效；纯火箭机返回 NaN —— 它们靠燃料
   * 燃烧时段飞行，不存在气动平衡巡航点，沿用升力平衡速度即可。
   * @param {(V:number)=>number} dragAt 给定速度的整机平飞阻力计算回调
   * @returns {number} 平衡速度 m/s，无解时返回 NaN
   * @private
   */
  _solveTrimSpeed(dragAt) {
    if (!this.engines || !this.engines.length) return NaN;
    if (!this.engines.some((e) => e.type !== 'rocket')) return NaN;
    let T0 = 0, vMax = 300;
    for (const e of this.engines) {
      if (e.type === 'rocket') continue;
      T0 += e.spec.staticThrust || e.spec.thrust || ((e.spec.power || 90000) / 32);
      vMax = Math.max(vMax, e.spec.vMax || 300);
    }
    if (!(T0 > 0)) return NaN;
    // 给定速度下的可用推力（与 update() 同口径，含 2000m 巡航密度的 densRatio）
    const densRatio = 1.103 / 1.225;
    const thrustAt = (V) => {
      let T = 0;
      for (const e of this.engines) {
        if (e.type === 'rocket') continue;
        const vAlong = -V;                            // 推力沿 -Z
        if (e.type === 'jet') {
          T += (e.spec.staticThrust || e.spec.thrust || 20000) * densRatio
            * Math.max(0, 1 - clamp01(Math.abs(vAlong) / (e.spec.vMax || 330)) * 0.85);
        } else {
          const st0 = e.spec.staticThrust || (e.spec.power || 90000) / 32;
          T += st0 * densRatio * Math.max(0, 1 - Math.abs(vAlong) / (e.spec.vMax || 100));
        }
      }
      return T;
    };
    // 净推力 f(V) = T(V) - D(V)，在关注区间内单调递减
    let lo = 20, hi = Math.min(vMax * 1.2, 400);
    if (thrustAt(lo) - dragAt(lo) <= 0) return NaN;   // 推重比太低，地面都起不来
    if (thrustAt(hi) - dragAt(hi) > 0) return NaN;    // 到 hi 仍在加速，区间内无平衡点
    for (let i = 0; i < 36; i++) {
      const mid = 0.5 * (lo + hi);
      if (thrustAt(mid) - dragAt(mid) > 0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
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

  /**
   * 机腹轮廓接触点（沿机身纵轴取若干站点，取该处机身/座舱的最低点）。
   * 相对质心坐标，与刚体位置同系。用于尾椎擦地 / 机腹迫降。
   */
  _buildBellyPoints(stats, n = 6) {
    const out = [];
    const b = stats.bounds;
    for (let i = 0; i < n; i++) {
      const z = lerp(b.minZ, b.maxZ, n === 1 ? 0.5 : i / (n - 1));
      let y = Infinity;
      for (const p of this.craft.parts) {
        const d = PART_DEFS[p.def];
        if (!d || (d.cat !== 'fuselage' && d.cat !== 'cockpit')) continue;
        const half = p.size[2] * 0.5;
        if (z < p.pos[2] - half || z > p.pos[2] + half) continue;
        y = Math.min(y, p.pos[1] - p.size[1] * 0.5);
      }
      if (!Number.isFinite(y)) continue;
      out.push({ pos: new THREE.Vector3(0, y - stats.com.y, z - stats.com.z), r: 0.16 });
    }
    return out;
  }

  /** 碰撞球（沿机身纵轴分布）。中心为**相对质心**的坐标，与刚体位置同系。 */
  _buildCollisionSpheres(stats, n = 4) {
    const out = [];
    const b = stats.bounds;
    const len = Math.max(1, b.maxZ - b.minZ);
    const r = Math.max(0.8, Math.min(stats.size.x, stats.size.y) * 0.28 + len * 0.06);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      out.push({ center: new THREE.Vector3(0, 0, lerp(b.minZ, b.maxZ, t) - stats.com.z), radius: r });
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
    // 风：支持「随位置变化的风场」（高度梯度 / 地形爬坡气流 / 阵风湍流）
    const wind = env.windAt
      ? env.windAt(body.position.x, body.position.y, body.position.z, _wind)
      : (env.wind || _wind.set(0, 0, 0));
    _v.copy(body.velocity).sub(wind); // 相对气流
    this.windLocal = _wind2.copy(wind);

    body.clearForces();
    this.liftAccum = 0; this.dragAccum = 0; this.thrustAccum = 0;
    this.aoaAccum = 0; this.aoaWeight = 0;
    let stalled = false;

    /* --- 螺旋桨反扭矩：绕机体纵轴（真实的反作用扭矩轴），按油门/rpm 变化 --- */
    // 先算出本帧要施加的扭矩，再用副翼“在线配平”抵消它 —— 这样从滑跑到巡航、
    // 任意油门都不会残留滚转力矩（旧实现按满油门配平，小油门时留下一半反向力矩，
    // 飞机就会慢慢侧滑→上反角耦合甩滚转）。
    let propTorque = 0;
    for (const e of this.engines) {
      if (e.type !== 'prop' && e.type !== 'turboprop') { e.torqueNow = 0; continue; }
      e.torqueNow = PROP_TORQUE * (e.spec.propRadius || 1) * e.rpm01 * c.throttle;
      propTorque += e.torqueNow;
    }
    this.propTorqueNow = propTorque;
    const qNow = 0.5 * density * _v.lengthSq();
    // 动压不足（停放/推车）时不给舵面配平，避免地面上乱打副翼
    const propTrim = (propTorque > 0.5 && Math.abs(this.rollSlope) > 1 && qNow > 20)
      ? clamp(-propTorque / (this.rollSlope * (qNow / Math.max(1, this.qRef))), -0.4, 0.4)
      : 0;

    /* --- 气动 --- */
    const ctl = {
      pitch: clamp(c.pitch + this.pitchTrim, -1, 1),
      roll: clamp(c.roll + (this.rollTrim || 0) + propTrim, -1, 1),
      yaw: clamp(c.yaw + this.yawTrim, -1, 1),
      flap: c.flaps, airbrake: c.airbrake,
    };
    const bodyVel = _bv;
    // 机体真实侧滑角 β = atan2(横向分量, 前向分量)，由「气流速度相对机体」得出。
    // 垂尾的侧向力由它驱动 —— 不能用「翼面局部展向流」代替，否则正常抬头时
    // 机体 Y 方向的迎角分量会被当成侧滑，垂尾凭空产生竖直力（详见 physics.solveWing）。
    let betaNow = 0;
    {
      _bv.copy(_v).applyQuaternion(_q.copy(body.quaternion).invert());   // 气流 -> 机体轴
      if (Math.abs(_bv.z) > 1) betaNow = Math.atan2(_bv.x, Math.abs(_bv.z));
    }
    const solveOne = (s, downwash) => {
      if (s.detached) return null;
      s.alphaOffset = downwash + (s.incidence || 0);
      body.bodyVelocityAt(s.position, bodyVel);
      bodyVel.sub(_v5.copy(wind).applyQuaternion(_q.copy(body.quaternion).invert()));
      const res = solveWing(s, bodyVel, density, ctl, this._wingOut, betaNow);
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
    // 下洗只影响机翼**之后**的水平翼面（水平尾翼）；机翼之前的鸭翼受的是上洗；
    // 垂直尾翼不受下洗（竖直速度分量在它的法线方向上没有投影）
    const dw = -clamp(this.lastWingCL, -1.4, 1.4) * 0.11;
    const up = -dw * 0.5;
    for (const s of this.surfaces) {
      if (s.isWing || s.isAileron) continue;
      solveOne(s, s.washable ? (s.position.z >= this.wingACz ? dw : up) : 0);
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

    /* --- 阻尼增稳（俯仰/偏航/滚转） --- */
    // 面元模型天然只算得出尾翼/机翼那一份旋转阻尼，实测短周期 ζ≈0.05（真机 0.3~0.7）。
    // 这里补上机翼/机身/非定常附着流的缺失部分，随动压缩放：低速不糊手，高速能收敛。
    if (this.dampPitch > 0 || this.dampYaw > 0 || this.dampRoll > 0) {
      const qr = clamp(qNow / Math.max(1, this.qRef), 0, 8);
      _q.copy(body.quaternion).invert();
      _v6.copy(body.angularVelocity).applyQuaternion(_q);   // 机体角速度
      body.applyTorque(_v7.set(
        -this.dampPitch * _v6.x * qr,
        -this.dampYaw * _v6.y * qr,
        -this.dampRoll * _v6.z * qr,
      ).applyQuaternion(body.quaternion));
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
          // 涡喷/涡扇的可用推力随飞行速度明显下降：来流速度越高，进气道压缩比越高，
          // 喷嘴可用温比越小，推力衰减越快（真实涡扇在 Ma0.9 巡航时可用推力约为静态的
          // 40~55%）。旧模型 |v|/vMax*0.35 在 360m/s 只掉 35%，等于「空气越薄越有力」，
          // 结果满油门时飞机一路加速到设计速度的 2~3 倍，配平彻底失效（实测 Simple Jet
          // 平衡点 230m/s、Warhound 200m/s，而设计速度只有 88/73m/s）。
          // 现改为统一口径的「到 vMax 衰减到 0」模型，与螺旋桨保持一致直觉：
          //   T = T0 · ρ比 · (1 - k·V/Vmax)，k=0.85 → Vmax 时仅剩 15%
          const vMax = e.spec.vMax || 360;
          const fade = Math.max(0, 1 - clamp01(Math.abs(vAlong) / vMax) * 0.85);
          T = (e.spec.staticThrust || e.spec.thrust || 20000) * e.rpm01 * densRatio * fade * e.health01;
          break;
        }
        case 'rocket': {
          // 火箭发动机推力与速度几乎无关（自带氧化剂，无进气道损失），只做微弱修正
          T = (e.spec.thrust || 24000) * c.throttle * e.health01 * (1 - clamp01(Math.abs(vAlong) / (e.spec.vMax || 400)) * 0.1);
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
      // 螺旋桨反扭矩：绕机体纵轴（螺旋桨的旋转轴）→ 左滚趋势，由上面的 propTrim 抵消
      if (e.torqueNow) body.applyTorque(_v3.set(0, 0, e.torqueNow).applyQuaternion(body.quaternion));
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
    this._onPlatform = false;
    for (const g of this.gears) {
      if (g.retractable && c.gearT < 0.85) { g.contact = false; g.grounded = 0; continue; }
      const wp = _v3.copy(g.position).applyQuaternion(body.quaternion).add(body.position);
      let gh = terrain ? terrain.heightAt(wp.x, wp.z) : 0;
      // 平台支撑：屋顶停机坪 / 航母甲板 / 桥梁等
      const plat = this._platformAt(wp.x, wp.z, wp.y, env);
      const onPlatform = plat != null && plat > gh;
      if (onPlatform) { gh = plat; this._onPlatform = true; }
      // 桥/甲板位于水面上方时，按干燥平台处理，不套用水面浮力与低摩擦。
      const isWater = !onPlatform && terrain ? terrain.isWater(wp.x, wp.z) : false;
      const targetY = gh + g.radius;
      if (wp.y <= targetY) {
        const n = (terrain && !isWater && !onPlatform) ? terrain.normalAt(wp.x, wp.z, _g1) : _g1.set(0, 1, 0);
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
        body.applyForce(_v7.copy(n).multiplyScalar(Fn), wp);
        g.compression = clamp01(pen / Math.max(0.05, g.travel));
        g.contact = true; g.grounded = 1;
        this.groundContact = true;

        // 摩擦：沿地形切向（全部用复用向量，热路径零分配）
        const tangent = _g2.copy(vAt).addScaledVector(n, -vAt.dot(n));
        const tSpeed = tangent.length();
        const wheelFwd = _g3.set(0, 0, -1).applyQuaternion(body.quaternion);
        const wheelSide = _g4.crossVectors(n, wheelFwd);
        if (wheelSide.lengthSq() > 1e-6) wheelSide.normalize();
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
          body.applyForce(_g5.copy(wheelSide).multiplyScalar(clamp(desiredSide, -maxSide, maxSide)), wp);
          const maxRoll = Fn * (rollFriction + brakeF);
          const desiredRoll = -tSpeed * mEff / Math.max(1e-3, dt) * ((rollFriction + brakeF) / (rollFriction + brakeF + 2.5));
          body.applyForce(_g5.copy(tangent).multiplyScalar(clamp(desiredRoll, -maxRoll, maxRoll)), wp);
          g.spin += tSpeed * dt / Math.max(0.1, g.radius);
        }
        // 前轮转向
        if (g.steerable && !isWater && tSpeed > 1.5) {
          const authority = clamp(tSpeed / 25, 0.15, 1);
          body.applyForce(_g5.copy(wheelSide).multiplyScalar(-c.yaw * Fn * 0.75 * authority), wp);
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

    // 机腹 / 尾椎接地（抬轮过度、机腹迫降、起落架全毁）
    if (terrain && this.bellyPoints.length) {
      const gearDown = this.gears.length && c.gearT > 0.85;
      for (const bp of this.bellyPoints) {
        const wp = _v3.copy(bp.pos).applyQuaternion(body.quaternion).add(body.position);
        let gh = terrain.heightAt(wp.x, wp.z);
        const plat = this._platformAt(wp.x, wp.z, wp.y, env);
        const onPlatform = plat != null && plat > gh;
        if (onPlatform) gh = plat;
        const isWater = !onPlatform && terrain.isWater ? terrain.isWater(wp.x, wp.z) : false;
        const pen = gh + bp.r - wp.y;
        if (pen <= 0) continue;
        const n = (!isWater && !onPlatform && terrain.normalAt) ? terrain.normalAt(wp.x, wp.z, _g1) : _g1.set(0, 1, 0);
        const vAt = _v5.copy(body.velocity).add(_v6.crossVectors(body.angularVelocity, _v2.copy(wp).sub(body.position)));
        const vn = vAt.dot(n);
        let Fn = clamp(52000 * pen - 4200 * Math.min(0, vn), 0, (gearDown ? 22 : 30) * body.mass);
        if (isWater) Fn *= 0.18;
        body.applyForce(_v7.copy(n).multiplyScalar(Fn), wp);
        // 拖地摩擦：尾椎擦地时产生低头力矩，压住继续抬头；机腹迫降则是减速阻力
        const tangent = _g2.copy(vAt).addScaledVector(n, -vn);
        const ts = tangent.length();
        if (ts > 0.05 && !isWater) {
          tangent.multiplyScalar(1 / ts);
          const desired = -ts * (body.mass * 0.22) / Math.max(1e-3, dt) * 0.3;
          body.applyForce(_g5.copy(tangent).multiplyScalar(clamp(desired, -Fn * 0.7, Fn * 0.7)), wp);
        }
        this.groundContact = true;
        const scrape = Math.abs(vn);
        if (scrape > 3 && !isWater) this.applyImpact(scrape * 0.45, wp, 'ground');
        else if (scrape > 1.0 && this.onEvent && this._lastScrapeSfx + 0.4 < this.time) {
          this._lastScrapeSfx = this.time;
          this.onEvent('scrape', { aircraft: this, point: wp, speed: scrape });
        }
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
      if (c.shape !== 'box' || c.sensor || c.destroyed) continue;
      const he = c.localHalfExtents || c.halfExtents; if (!he) continue;
      let localX = x - c.center.x, localZ = z - c.center.z;
      if (c.localHalfExtents) {
        // 反旋转到平台局部坐标，避免斜向跑道/桥面只按世界 AABB 判定。
        const dx = localX, dz = localZ;
        localX = c.platformCos * dx - c.platformSin * dz;
        localZ = c.platformSin * dx + c.platformCos * dz;
      }
      if (Math.abs(localX) > he.x + 1 || Math.abs(localZ) > he.z + 1) continue;
      const top = Number.isFinite(c.surfaceY)
        ? c.surfaceY + c.surfaceSlope * localZ
        : c.center.y + he.y;
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
    const s = this.state;
    /* --- 起飞/低速阶段：飞行员拥有完全俯仰权限（真实电传的起飞直接律） --- */
    // 现象：抬轮瞬间飞机离地后 groundContact 立刻变 false，辅助恢复到全强度，
    // 16° 以上的俯仰被当成「超限」强行压回，飞机刚离地就被砸回跑道，随后
    // 再也抬不起头、只能贴地无限加速（实测 Warhound 抬到 20° 后 2s 内被压到 -12°）。
    // 真实飞机的起飞阶段由飞行员直接操纵，增稳系统不干预俯仰通道。
    const agl = s.altitudeAGL ?? (s.altitudeASL || 0);
    const lowAlt = agl < 60;
    const takeoffPhase = lowAlt && s.speed > 8 && (this.controls.pitch > 0.2 || e.x > 0.12);
    let level = a * 0.9;
    // 姿态稳定（把机翼放平）
    if (this.groundContact) level = a * 0.2;
    else if (lowAlt) level = a * 0.45;                 // 低空渐进，避免起飞瞬间硬介入
    if (takeoffPhase) level *= 0.25;                   // 起飞抬轮：只留 25% 滚转保持
    const rollErr = e.z; // 期望 0
    const wl = body.angularVelocity.clone().applyQuaternion(_q.copy(body.quaternion).invert());
    // 只在玩家没有主动输入对应通道时介入（俯仰输入不应关掉滚转保持）
    const freeRoll = 1 - Math.min(1, Math.abs(this.controls.roll));
    const freePitch = takeoffPhase ? 0 : 1 - Math.min(1, Math.abs(this.controls.pitch));
    const I = body.inertia;

    /* --- 姿态保持 + 长周期(phugoid)抑制 --- */
    // 现象：固定 pitchTrim 只在该机型设计速度下力矩为零。油量/推力/重量一变，
    // 飞机就自己加速或减速，长周期(phugoid)上表现为松手后持续爬升或掉高
    // （实测 Simple Jet 松手 20s 爬 364m、Warhound 爬 1235m 并翻转）。
    // 静稳定只保证「迎角扰动会恢复」，管不了长周期；这里补两路反馈：
    //   1) 姿态保持：俯仰角偏离「配平俯仰角」超过包线时柔和回中
    //   2) 长周期阻尼：走能量法（见下方注释），抑制速度/高度的缓慢交换
    // 注意 pitchErr 的符号语义：**正值 = 需要低头**（沿用旧实现的约定，
    // 因为 tx 前面有负号）。俯仰回中的目标不是「水平 0°」而是「当前配平俯仰角」
    // ——平飞时机头本就带着迎角（低速机可达 8~12°），以 0° 为目标会把飞机按成俯冲。
    // 低空/起飞阶段豁免：那段完全交给飞行员。
    const trimPitch = this.trimPitchAngle || 0;
    const limit = takeoffPhase ? 1.2 : (lowAlt ? 0.62 : 0.09);
    const dev = e.x - trimPitch;
    const over = Math.abs(dev) - limit;
    const softErr = over > 0 ? Math.tanh(over / 0.18) * Math.sign(dev) * 0.22 : 0;
    // 长周期(phugoid)抑制 —— 「能量法」，注意符号：
    //   phugoid 下降段 = 掉高 + 加速（动能增加、势能减少）；上升段 = 爬升 + 减速。
    // 要抑制振荡必须「把动能换回势能」：空速高于配平 -> 抬头（用速度换高度），
    // 空速低于配平 -> 低头。这与「速度高就低头」的直觉相反，但后者恰好是 phugoid
    // 的正反馈（低头 -> 更掉高 -> 更加速 -> 更低头）。同时叠加垂直速度阻尼：
    // 下沉时抬头、上冲时低头，让残余振荡更快衰减。
    let pitchBiasLow = 0;
    if (!takeoffPhase && !lowAlt && s.speed > 12 && this.designV > 20 && !this.groundContact && !s.stalled) {
      const thr = clamp01(this.controls.throttle);
      // 参考速度：满油门时为 designV（推力=阻力平衡点），收油门时按平方律下调
      // （真实飞机阻力 ∝ V²，油门减半后平衡速度 ≈ 0.55~0.7 倍）。用 0.62 常数，
      // 比线性的 0.55 更贴近平方律，收油门后不会把飞机逼得太慢。
      const vRef = this.designV * (0.62 + 0.38 * thr);
      const err = clamp((s.speed - vRef) / Math.max(14, vRef * 0.5), -1, 1);
      const vs = clamp((s.verticalSpeed ?? 0) / 30, -1, 1);
      // 垂速积分项：消除「速度锁死但一直缓慢下沉」的稳态误差。
      // 纯比例项下，飞机可以停在一个「垂速恒定、比例出力刚好抵消」的悬停点上
      // （实测 Warhound 稳定在 -4.4° / 12m/s 下沉率，怎么都不回平）。积分把这段
      // 残余垂速慢慢累积成抬头偏置，直到真正回到水平。限幅 ±1，避免积分饱和。
      this._vsInteg = clamp((this._vsInteg || 0) + vs * dt * 0.6, -1, 1);
      const upBias = err * 0.9 - vs * 2.2 - this._vsInteg * 1.1;
      pitchBiasLow = -upBias * 0.90 * freePitch;
    } else {
      this._vsInteg = 0;
    }
    const pitchErr = softErr + Math.tanh(pitchBiasLow / 0.16) * 0.16;
    // 辅助增益：直接按「期望闭环固有频率 ωn / 阻尼比 ζ」标定，而不是拍脑袋系数。
    // 旧实现 tx = -(pitchErr*kp*I.x*0.9 + wl.x*kd*I.x*1.2)，实际只有 ~700 N·m，
    // 而短周期阻尼力矩在 ω=0.1rad/s 时就有上万 N·m，辅助被彻底淹没
    // （实测松手后俯仰一路漂到 -15.7°、掉高 900m，辅助形同虚设）。
    // 取 ωn = 1.3 rad/s、ζ = 0.85 —— 比短周期(2~6 rad/s)慢一档，不抢手感，
    // 但足以把长周期(phugoid)的俯仰漂移拉回来。
    const wn = 1.3, zeta = 0.85;
    const kP = wn * wn * I.x, kD = 2 * zeta * wn * I.x;
    const tx = -(pitchErr * kP + wl.x * kD) * level * freePitch;
    const tz = -(rollErr * wn * wn * I.z + wl.z * 1.8 * wn * I.z) * level * freeRoll;
    // 机体坐标 -> 世界坐标（刚体力矩是世界系的，直接给机体系分量会随姿态跑偏）
    body.applyTorque(_v4.set(tx, 0, tz).applyQuaternion(body.quaternion));
    // 迎角保护：明显超过限制时给一个低头力矩（真实电传的 α 限制器）。
    // 只在离地足够高、且玩家没有主动拉杆时介入 —— 起飞/着陆阶段飞行员权限优先，
    // 否则抬轮瞬间的大迎角会被立刻压掉，飞机永远离不了地。
    const aoaLimit = 0.34;
    if (a > 0.3 && !lowAlt && !takeoffPhase && s.aoa > aoaLimit && s.speed > 25) {
      const excess = clamp01((s.aoa - aoaLimit) / 0.3);
      body.applyTorque(_v4.set(-excess * I.x * 0.6 * a, 0, 0).applyQuaternion(body.quaternion));
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
        if (col.kind === 'runway') continue;         // 承载面由单向平台支撑处理，避免落地时把机身弹开
        // 浮空岛等厚实体的顶面同样由起落架平台支撑；飞机已经在顶面附近时，
        // 不再让机身包围球与盒体重复解算，否则出生瞬间会被“顶面 + 实体”两套
        // 碰撞同时向上弹，造成虚假的致命撞击。侧面和下方仍保留实体碰撞。
        if (col.oneWayTop && Number.isFinite(col.surfaceY) && wp.y >= col.surfaceY - sp.radius) continue;
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
            center: col.center,
            halfExtents: col.localHalfExtents || col.halfExtents,
            quaternion: col.quaternion || null,
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
    // 控制面偏转（铰链在控制面前缘；右滚 = 右副翼上偏）
    for (const cs of this.controlMeshes) {
      let defl = 0;
      const right = cs.hinge.position.x >= 0;
      switch (cs.type) {
        case 'elevator': defl = -c.pitch * 0.42; break;
        case 'aileron': defl = -c.roll * 0.36 * (right ? 1 : -1); break;
        case 'rudder': defl = c.yaw * 0.42; break;
        case 'flap': defl = c.flaps * 0.55; break;
        case 'elevon': defl = -c.pitch * 0.32 - c.roll * 0.28 * (right ? 1 : -1); break;
      }
      if (cs.type === 'rudder') cs.hinge.rotation.y = defl; else cs.hinge.rotation.x = defl;
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

  /**
   * 出生点正上方的可停放平台高度。
   *
   * 出生点通常由 Terrain 提供，机场跑道却会比地形面高几厘米到数十厘米；若仍按
   * 地形高度摆放，起落架会在首个物理帧深深插进跑道，弹簧反冲会被误判为撞击。
   * 浮空岛也属于这个情况：地形只提供出生区域，真正可站立的表面在岛顶。
   * 只接受明确的承载面（runway / oneWayTop），并限制其相对地形的高度，避免把
   * 出生点附近恰好重叠的高楼屋顶误当作起飞平台。
   * @private
   */
  _spawnSurfaceAt(x, z, terrainY, landmarks) {
    let surface = terrainY;
    const cols = landmarks?.colliders;
    if (!cols || !cols.length) return surface;
    const maxRise = 80;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.shape !== 'box' || c.sensor || c.destroyed || (c.kind !== 'runway' && !c.oneWayTop)) continue;
      const he = c.localHalfExtents || c.halfExtents;
      if (!he) continue;
      let localX = x - c.center.x, localZ = z - c.center.z;
      if (c.localHalfExtents) {
        const dx = localX, dz = localZ;
        localX = c.platformCos * dx - c.platformSin * dz;
        localZ = c.platformSin * dx + c.platformCos * dz;
      }
      if (Math.abs(localX) > he.x + 1 || Math.abs(localZ) > he.z + 1) continue;
      const top = Number.isFinite(c.surfaceY)
        ? c.surfaceY + (c.surfaceSlope || 0) * localZ
        : c.center.y + he.y;
      if (top >= terrainY - 1 && top <= terrainY + maxRise) surface = Math.max(surface, top);
    }
    return surface;
  }

  /** 把飞机平稳地放到地面或出生平台上（避免出生穿透/弹飞） */
  placeOnGround(terrain, x, z, heading = 0, landmarks = null) {
    const pose = this.computeStaticPose();
    const terrainY = terrain ? terrain.heightAt(x, z) : 0;
    const gy = this._spawnSurfaceAt(x, z, terrainY, landmarks);
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
    // 掉件时翼面会被标记 detached（不再产生气动力）。重置必须清掉，
    // 否则「修好的飞机」仍然缺一侧升力 —— 滑跑就开始滚转、拉不起来
    for (const s of this.surfaces) s.detached = false;
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
