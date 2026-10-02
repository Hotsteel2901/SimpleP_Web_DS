/**
 * 天空、太阳/月亮、昼夜循环、云层、雾与光照
 * ------------------------------------------------------------------
 * 全部程序化：天空用一个反面球体 + 自定义 shader（渐变 + 太阳光晕 + 星空），
 * 云层用一层平面贴图 + 若干广告牌云团。零外部资源。
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, makeRng, makeSkyTexture } from '../core/util.js';

/* ---------------------------------------------------------------- 色彩预设 */
const KEYFRAMES = [
  // t,      天顶,     地平,     地面反照,  太阳色,    太阳强度, 环境光, 星空
  { t: 0.00, top: 0x05080f, hor: 0x0a1020, bot: 0x04060c, sun: 0x9fb6ff, sunI: 0.10, amb: 0.09, star: 1.0 },
  { t: 0.18, top: 0x0b1430, hor: 0x2a2f52, bot: 0x12172b, sun: 0xffb066, sunI: 0.35, amb: 0.16, star: 0.55 },
  { t: 0.26, top: 0x2a4a86, hor: 0xff9a5c, bot: 0x3a3550, sun: 0xffc17a, sunI: 1.15, amb: 0.34, star: 0.10 },
  { t: 0.38, top: 0x2f6fd0, hor: 0x9fd0f0, bot: 0x6f8a9c, sun: 0xfff4e0, sunI: 1.85, amb: 0.52, star: 0.0 },
  { t: 0.50, top: 0x2f7ff0, hor: 0xbfe2ff, bot: 0x8fa6b4, sun: 0xffffff, sunI: 2.05, amb: 0.58, star: 0.0 },
  { t: 0.68, top: 0x3a76d8, hor: 0xd6dff0, bot: 0x7d8b96, sun: 0xfff0d8, sunI: 1.70, amb: 0.50, star: 0.0 },
  { t: 0.78, top: 0x28457e, hor: 0xffa055, bot: 0x39364a, sun: 0xffb070, sunI: 1.00, amb: 0.30, star: 0.08 },
  { t: 0.86, top: 0x101a3a, hor: 0x8a4a5a, bot: 0x1a1c30, sun: 0xff8f5a, sunI: 0.35, amb: 0.16, star: 0.5 },
  { t: 1.00, top: 0x05080f, hor: 0x0a1020, bot: 0x04060c, sun: 0x9fb6ff, sunI: 0.10, amb: 0.09, star: 1.0 },
];

function lerpKey(t) {
  t = clamp01(t);
  let a = KEYFRAMES[0], b = KEYFRAMES[KEYFRAMES.length - 1];
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (t >= KEYFRAMES[i].t && t <= KEYFRAMES[i + 1].t) { a = KEYFRAMES[i]; b = KEYFRAMES[i + 1]; break; }
  }
  const f = smoothstep(a.t, b.t, t);
  const cA = new THREE.Color(a.top), cB = new THREE.Color(b.top);
  const hA = new THREE.Color(a.hor), hB = new THREE.Color(b.hor);
  const bA = new THREE.Color(a.bot), bB = new THREE.Color(b.bot);
  const sA = new THREE.Color(a.sun), sB = new THREE.Color(b.sun);
  return {
    top: cA.lerp(cB, f), hor: hA.lerp(hB, f), bot: bA.lerp(bB, f), sun: sA.lerp(sB, f),
    sunI: lerp(a.sunI, b.sunI, f), amb: lerp(a.amb, b.amb, f), star: lerp(a.star, b.star, f),
  };
}

/** 云层贴图（可平铺的 fBm alpha） */
function makeCloudTexture(seed = 5, size = 512) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  let c, ctx;
  try {
    c = document.createElement('canvas'); c.width = c.height = size;
    ctx = c.getContext('2d');
  } catch { return null; }
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  const rng = makeRng(seed);
  const grid = 64;
  const noise = new Float32Array((grid + 1) * (grid + 1));
  for (let i = 0; i < noise.length; i++) noise[i] = rng();
  const sample = (x, y) => {
    x = ((x % 1) + 1) % 1; y = ((y % 1) + 1) % 1;
    const gx = x * grid, gy = y * grid;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const g = (a, b) => noise[(((b % grid) + grid) % grid) * (grid + 1) + (((a % grid) + grid) % grid)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const n00 = g(x0, y0), n10 = g(x0 + 1, y0), n01 = g(x0, y0 + 1), n11 = g(x0 + 1, y0 + 1);
    return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let n = 0, amp = 1, f = 3;
      for (let o = 0; o < 5; o++) { n += amp * sample(u * f, v * f); amp *= 0.5; f *= 2; }
      n /= 1.9375;
      const a = clamp01((n - 0.48) * 3.4);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------------------------------------------------------- 天空球 */
const SKY_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKY_FRAG = /* glsl */`
uniform vec3 uTop, uHor, uBot, uSun, uSunDir;
uniform float uSunI, uStar, uTime;
varying vec3 vWorld;
float hash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.1,0.2,0.3)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
void main() {
  vec3 dir = normalize(vWorld);
  float h = clamp(dir.y, -1.0, 1.0);
  vec3 col;
  if (h > 0.0) col = mix(uHor, uTop, pow(h, 0.55));
  else col = mix(uHor, uBot, pow(-h, 0.5));
  float sd = max(dot(dir, normalize(uSunDir)), 0.0);
  // 太阳盘 + 大气光晕
  col += uSun * uSunI * (pow(sd, 900.0) * 8.0 + pow(sd, 24.0) * 0.35 + pow(sd, 4.0) * 0.08);
  // 星空
  if (uStar > 0.01 && h > -0.05) {
    vec3 g = floor(dir * 340.0);
    float s = hash(g);
    float star = smoothstep(0.9975, 1.0, s);
    float tw = 0.7 + 0.3 * sin(uTime * 3.0 + s * 90.0);
    col += vec3(star) * uStar * tw * smoothstep(-0.05, 0.25, h) * 2.2;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class SkyDome {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { timeOfDay:0..1, cloudiness:0..1, radius, sunAzimuth }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.timeOfDay = opts.timeOfDay ?? 0.42;
    this.cloudiness = clamp01(opts.cloudiness ?? 0.4);
    this.radius = opts.radius ?? 12000;
    this.root = new THREE.Group();
    this.root.name = 'sky';
    scene.add(this.root);
    this._tmp = new THREE.Vector3();

    // 天空球
    this.uniforms = {
      uTop: { value: new THREE.Color(0x2f7ff0) },
      uHor: { value: new THREE.Color(0xbfe2ff) },
      uBot: { value: new THREE.Color(0x8fa6b4) },
      uSun: { value: new THREE.Color(0xffffff) },
      uSunDir: { value: new THREE.Vector3(0.3, 0.7, 0.4) },
      uSunI: { value: 2.0 },
      uStar: { value: 0 },
      uTime: { value: 0 },
    };
    const skyGeo = new THREE.SphereGeometry(this.radius, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.frustumCulled = false;
    this.root.add(this.skyMesh);

    // 光照
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(0xbcd9ff, 0x4a5a45, 0.6);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sun.castShadow = !!opts.shadows;
    if (this.sun.castShadow) {
      // 阴影范围贴合跟随目标：范围越小，单位面积的阴影贴图分辨率越高（边缘越干净）
      const quality = opts.quality ?? 1;
      const res = quality >= 2 ? 4096 : quality >= 1 ? 2048 : 1024;
      this.sun.shadow.mapSize.set(res, res);
      const d = opts.shadowDistance ?? 260;
      this.sun.shadow.camera.left = -d; this.sun.shadow.camera.right = d;
      this.sun.shadow.camera.top = d; this.sun.shadow.camera.bottom = -d;
      this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = d * 4;
      this.sun.shadow.bias = -0.00035;
      this.sun.shadow.normalBias = 0.35;
    }
    scene.add(this.sun);
    scene.add(this.sun.target);

    // 环境贴图（IBL）：由天空渐变生成 PMREM，金属/玻璃才有真实反射
    // —— 这是“材质清晰度”提升最明显的一步：没有它，金属反射只能用纯色近似
    this.pmrem = (typeof THREE.PMREMGenerator === 'function' && opts.pmrem !== false)
      ? new THREE.PMREMGenerator(opts.renderer || null)
      : null;
    this.envRT = null;
    this._envT = -1;

    // 环境光（微弱补光，避免背光面纯黑）
    this.fill = new THREE.DirectionalLight(0x9fc4ff, 0.22);
    this.fill.position.set(-0.6, 0.45, -0.7);
    scene.add(this.fill);

    // 云层
    this.cloudTex = makeCloudTexture(7);
    if (this.cloudTex) {
      this.cloudLayer = new THREE.Mesh(
        new THREE.PlaneGeometry(this.radius * 2.4, this.radius * 2.4, 1, 1),
        new THREE.MeshBasicMaterial({ map: this.cloudTex, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, fog: false })
      );
      this.cloudTex.repeat.set(9, 9);
      this.cloudLayer.rotation.x = -Math.PI / 2;
      this.cloudLayer.position.y = opts.cloudHeight ?? 2200;
      this.cloudLayer.renderOrder = -1;
      this.root.add(this.cloudLayer);
      // 第二层
      this.cloudTex2 = makeCloudTexture(19);
      this.cloudTex2.repeat.set(5, 5);
      this.cloudLayer2 = new THREE.Mesh(
        new THREE.PlaneGeometry(this.radius * 2.6, this.radius * 2.6),
        new THREE.MeshBasicMaterial({ map: this.cloudTex2, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, fog: false })
      );
      this.cloudLayer2.rotation.x = -Math.PI / 2;
      this.cloudLayer2.position.y = (opts.cloudHeight ?? 2200) + 900;
      this.root.add(this.cloudLayer2);
    }

    // 雾
    this.fog = new THREE.FogExp2(0xbcd0e0, 0.00012);
    scene.fog = this.fog;

    scene.background = null;
    this.applyTimeOfDay();
  }

  /** 设置一天中的时间 0..1（0=午夜，0.25=日出，0.5=正午，0.75=日落） */
  setTimeOfDay(t) { this.timeOfDay = clamp01(t); this.applyTimeOfDay(); }

  applyTimeOfDay() {
    const k = lerpKey(this.timeOfDay);
    // 太阳方向：t=0.25 东方地平线，t=0.5 天顶偏南
    const ang = (this.timeOfDay - 0.25) * Math.PI * 2;
    const elev = Math.sin(ang);
    const az = Math.cos(ang);
    const dir = new THREE.Vector3(az * 0.75, elev, -0.55).normalize();
    this.uniforms.uTop.value.copy(k.top);
    this.uniforms.uHor.value.copy(k.hor);
    this.uniforms.uBot.value.copy(k.bot);
    this.uniforms.uSun.value.copy(k.sun);
    this.uniforms.uSunI.value = k.sunI;
    this.uniforms.uStar.value = k.star;
    this.uniforms.uSunDir.value.copy(dir);
    this.sunDirection = dir.clone();
    this.sun.color.copy(k.sun);
    this.sun.intensity = k.sunI;
    this.sun.position.copy(dir).multiplyScalar(1600);
    this.sun.target.position.set(0, 0, 0);
    this.hemi.intensity = k.amb * 0.7 + 0.08;
    this.hemi.color.copy(k.hor);
    this.fill.intensity = 0.1 + k.amb * 0.16;
    // IBL 是可选的锦上添花：即使生成失败（canvas/PMREM 不可用、贴图异常），
    // 也绝不能让整个 loadWorld 挂掉 —— 否则游戏直接进不去。
    try { this._updateEnv(k); } catch (e) { console.warn('[sky] 环境贴图生成失败，已跳过 IBL', e); this.pmrem = null; }
    // 雾颜色跟随地平线
    this.fog.color.copy(k.hor).lerp(k.bot, 0.25);
    this.fog.density = 0.000075 + (1 - Math.max(0, elev)) * 0.00007;
    this.isNight = k.star > 0.35;
    return k;
  }

  /**
   * 依据当前天空配色重建环境贴图（IBL）。
   * 用一张等距柱状（equirect）渐变贴图过 PMREM，得到粗糙度预滤的辐射环境：
   * 金属/玻璃才有方向性的反射，而不是靠纯色硬凑。
   * 时间变化不大时跳过（阈值 0.01），避免拖时间滑块时每帧重建。
   */
  _updateEnv(k) {
    if (!this.pmrem) return;
    if (this._envT >= 0 && Math.abs(this.timeOfDay - this._envT) < 0.01) return;
    // 注意：makeSkyTexture 的入参是 CSS 颜色字符串（内部走 canvas addColorStop）。
    // k.top/hor/bot 是 THREE.Color，必须用 getStyle()（'rgb(r,g,b)'）而不是
    // getHex()（十进制数字，传给 addColorStop 会抛 SyntaxError 并中断整个世界加载）。
    const tex = makeSkyTexture(k.top.getStyle(), k.hor.getStyle(), k.bot.getStyle());
    if (!tex) return;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    let rt = null;
    try {
      rt = this.pmrem.fromEquirectangular(tex);
    } catch {
      rt = null;
    }
    tex.dispose();
    if (!rt) return;
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = 0.35 + k.amb * 0.65;
    this._envT = this.timeOfDay;
  }

  /** 每帧：太阳阴影跟随相机、云层漂移 */
  update(dt, camera, focus) {
    this.uniforms.uTime.value += dt;
    const c = focus || camera?.position;
    if (c) {
      this.skyMesh.position.set(c.x, 0, c.z);
      // 让天空球足够大以覆盖远裁剪面
      if (this.cloudLayer) this.cloudLayer.position.set(c.x, this.cloudLayer.position.y, c.z);
      if (this.cloudLayer2) this.cloudLayer2.position.set(c.x, this.cloudLayer2.position.y, c.z);
      if (this.sun.castShadow) {
        this.sun.position.copy(c).addScaledVector(this.sunDirection, 900);
        this.sun.target.position.copy(c);
        this.sun.target.updateMatrixWorld();
      }
    }
    if (this.cloudTex) this.cloudTex.offset.x = (this.cloudTex.offset.x + dt * 0.0016) % 1;
    if (this.cloudTex2) this.cloudTex2.offset.x = (this.cloudTex2.offset.x + dt * 0.0009) % 1;
  }

  /** 供地形/水面使用的环境色 */
  get ambientColor() { return this.hemi.color; }
  get horizonColor() { return this.uniforms.uHor.value; }

  dispose() {
    this.root.removeFromParent();
    this.skyMesh.geometry.dispose(); this.skyMesh.material.dispose();
    this.cloudLayer?.geometry.dispose(); this.cloudLayer?.material.dispose();
    this.cloudLayer2?.geometry.dispose(); this.cloudLayer2?.material.dispose();
    this.cloudTex?.dispose(); this.cloudTex2?.dispose();
    this.hemi.removeFromParent(); this.sun.removeFromParent(); this.fill.removeFromParent();
    if (this.scene?.environment === this.envRT?.texture) this.scene.environment = null;
    this.envRT?.dispose();
    this.pmrem?.dispose();
  }
}

/** 简易天气：雨/雪粒子（跟随相机的循环粒子域） */
export class Weather {
  constructor(scene, opts = {}) {
    this.type = opts.type || 'none';
    this.count = opts.count ?? 2600;
    this.extent = opts.extent ?? 900;
    this.root = new THREE.Group(); this.root.name = 'weather';
    scene.add(this.root);
    this.speeds = new Float32Array(this.count);
    this.geo = new THREE.BufferGeometry();
    const pos = new Float32Array(this.count * 3);
    const rng = makeRng(opts.seed ?? 3);
    for (let i = 0; i < this.count; i++) {
      pos[i * 3] = (rng() - 0.5) * this.extent;
      pos[i * 3 + 1] = rng() * 400;
      pos[i * 3 + 2] = (rng() - 0.5) * this.extent;
      this.speeds[i] = 0.6 + rng() * 0.8;
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const isSnow = this.type === 'snow';
    this.mat = new THREE.PointsMaterial({
      color: isSnow ? 0xffffff : 0xaaccee, size: isSnow ? 1.6 : 0.7,
      transparent: true, opacity: isSnow ? 0.85 : 0.55, depthWrite: false, sizeAttenuation: true, fog: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.root.add(this.points);
    this.root.visible = this.type !== 'none';
    this.fallSpeed = isSnow ? 9 : 42;
    this.center = new THREE.Vector3();
  }
  update(dt, cameraPos) {
    if (!this.root.visible) return;
    this.center.copy(cameraPos);
    const arr = this.geo.attributes.position.array;
    const h = this.extent * 0.5;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      arr[i3 + 1] -= this.fallSpeed * this.speeds[i] * dt;
      if (this.type === 'rain') arr[i3] += dt * 6;
      if (arr[i3 + 1] < -40) {
        arr[i3 + 1] = 380;
        arr[i3] = (Math.random() - 0.5) * this.extent;
        arr[i3 + 2] = (Math.random() - 0.5) * this.extent;
      }
      // 相对相机循环（只对 x/z 做包裹）
      let dx = arr[i3] - 0, dz = arr[i3 + 2] - 0;
      if (dx > h) arr[i3] -= this.extent; else if (dx < -h) arr[i3] += this.extent;
      if (dz > h) arr[i3 + 2] -= this.extent; else if (dz < -h) arr[i3 + 2] += this.extent;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.root.position.set(this.center.x, this.center.y - 150, this.center.z);
  }
  dispose() { this.root.removeFromParent(); this.geo.dispose(); this.mat.dispose(); }
}
