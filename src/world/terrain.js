/**
 * src/world/terrain.js — 程序化地形 + 海面 + 高度查询（SimplePlanes 2 复刻 / three.js r186）
 *
 * 设计要点
 * ------------------------------------------------------------------
 * 1. 噪声：自实现「整数哈希 + 值噪声(value noise) + fBm + ridged noise」，完全确定性，
 *    不使用 Math.random，不依赖任何外部包。所有层使用不同 seed 偏移。
 * 2. 一致性：网格顶点高度与 heightAt() 使用同一个 _heightRaw() 函数；网格顶点高度被缓存进
 *    一维 Float32Array，heightAt() 在该网格上按「与索引缓冲区完全相同的三角形」做重心插值。
 *    因此物理查询到的地表 == 渲染出来的三角面（不会陷入地面/悬空），并且是 O(1) 无分配。
 * 3. 岛屿遮罩：以切比雪夫距离 max(|x|,|z|)/(size/2) 为基础，叠加低频噪声扰动海岸线，
 *    边缘平滑沉入海面以下约 220m，形成视觉上的无尽海洋。
 * 4. 着色：顶点色（vertexColors）+ canvas 程序化细节贴图（RepeatWrapping，近似灰度，
 *    线性空间直接相乘）。按 高度 + 坡度 + biome 调色板混色；沙滩/岩壁/雪线/盐滩/冰湖。
 * 5. 海面：size*3 的半透明 MeshStandardMaterial 平面（低 roughness + 法线贴图 + 缓慢滚动），
 *    顶点做极低频涌浪位移（shader 内注入 uTime），掠射角混入天空色（菲涅尔感）；另加
 *    一张深海底色大平面，避免透过半透明水体直接看到天空。update(dt) 只更新几个 uniform。
 * 6. 朝向约定（重要）：
 *      heading 就是 new THREE.Euler(0, heading, 0) 的 Y 分量，作用在机头朝 -Z 的模型上。
 *      机头方向 = ( -sin(heading), 0, -cos(heading) )。
 *      heading = 0        -> 机头朝 -Z
 *      heading = +PI/2    -> 机头朝 -X（俯视逆时针）
 *      heading = -PI/2    -> 机头朝 +X
 *    若需要「罗盘方位角」（增大时朝 +X，即俯视顺时针），请使用 -heading。
 *    可用 headingDirection() / headingFromDirection() 辅助换算。
 *
 * 单位：米 / 秒 / 千克。Y 轴向上，X-Z 水平，1 单位 = 1 米，原点在世界中心。
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 基础数学工具（全部无分配）
// ---------------------------------------------------------------------------

/** 夹紧到 [lo, hi] */
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** 夹紧到 [0, 1] */
function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/** 线性插值 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 平滑阶跃：edge0 == edge1 时退化为阶跃；允许 edge0 > edge1（反向）。
 * 返回值域 [0,1]，C1 连续。
 */
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * (3 - 2 * t);
}

/** mulberry32 —— 确定性 32 位 PRNG，返回 [0,1)。供出生点/散点使用（高度函数不用它）。 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) * 2.3283064365386963e-10;
  };
}

// ---------------------------------------------------------------------------
// 噪声：整数哈希 -> 值噪声 -> fBm / ridged
// ---------------------------------------------------------------------------

/** 二维整数哈希，返回 [0,1)。纯整数运算，跨平台确定。 */
function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) * 2.3283064365386963e-10;
}

/** 二维值噪声，quintic 插值，返回 [0,1]。 */
function valueNoise2(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = hash2i(xi, yi, seed);
  const n10 = hash2i(xi + 1, yi, seed);
  const n01 = hash2i(xi, yi + 1, seed);
  const n11 = hash2i(xi + 1, yi + 1, seed);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

/** fBm（分形布朗运动），返回 [0,1]。无分配。 */
function fbm2(x, y, seed, octaves, lacunarity, gain) {
  const lac = lacunarity === undefined ? 2.0 : lacunarity;
  const g = gain === undefined ? 0.5 : gain;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= g;
    freq *= lac;
  }
  return sum / norm;
}

/** 脊状噪声（ridged），返回 [0,1]，用于山脊与沙丘。 */
function ridged2(x, y, seed, octaves, lacunarity, gain) {
  const lac = lacunarity === undefined ? 2.0 : lacunarity;
  const g = gain === undefined ? 0.5 : gain;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = valueNoise2(x * freq, y * freq, seed + i * 1013);
    n = 1 - Math.abs(n * 2 - 1);
    n *= n;
    sum += amp * n;
    norm += amp;
    amp *= g;
    freq *= lac;
  }
  return sum / norm;
}

/** 可平铺（周期性）值噪声：格点按 period 取模，保证贴图无缝。uv ∈ [0,1)。 */
function valueNoiseTile(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const su = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sv = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const n00 = hash2i(x0, y0, seed);
  const n10 = hash2i(x1, y0, seed);
  const n01 = hash2i(x0, y1, seed);
  const n11 = hash2i(x1, y1, seed);
  const a = n00 + (n10 - n00) * su;
  const b = n01 + (n11 - n01) * su;
  return a + (b - a) * sv;
}

/** 可平铺 fBm，uv ∈ [0,1)，返回 [0,1]。 */
function fbmTile(u, v, period, octaves, seed, gain) {
  const g = gain === undefined ? 0.5 : gain;
  let amp = 1;
  let per = period;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoiseTile(u, v, per, seed + i * 1013);
    norm += amp;
    amp *= g;
    per *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// biome 参数表：调色板 + 地形/着色参数
// ---------------------------------------------------------------------------

/**
 * biome 配置。每个 biome 拥有一套地形噪声参数（频率/幅度）与一套调色板。
 * palette 内的颜色均为 sRGB 十六进制，构造时转成 THREE.Color（线性工作空间）。
 */
export const BIOMES = {
  green: {
    label: '温带',
    contFreq: 0.00030, contBase: 0.38, contAmp: 185,
    hillFreq: 0.00115, hillAmp: 90,
    ridgeFreq: 0.00078, ridgeBase: 0.34, ridgeK: 1.7, ridgeMaskK: 2.6, ridgeAmp: 0.85,
    detFreq: 0.0075, detAmp: 9,
    duneFreq: 0, duneAmp: 0,
    lakeAmp: 0, lakeDepth: 0,
    floor: -260,
    snowLine: 560, beachBand: 7, beachMix: 0.9,
    rockStart: 0.30, rockEnd: 0.62, rockMix: 0.95,
    waterColor: 0x2b6cb0, skyTint: 0xa9cdea, underwaterFog: 0x0b2c47,
    colors: {
      low: 0x4a7830, mid: 0x5d8a3a, high: 0x7e8a58, peak: 0x93998a,
      rock: 0x6a6157, sand: 0xd8c79a, snow: 0xf4f8ff, ice: 0xcfe3ef,
      urban: 0x8a8a80, deep: 0x22455e,
    },
  },
  tropical: {
    label: '热带',
    contFreq: 0.00032, contBase: 0.40, contAmp: 155,
    hillFreq: 0.00130, hillAmp: 80,
    ridgeFreq: 0.00082, ridgeBase: 0.36, ridgeK: 1.7, ridgeMaskK: 2.6, ridgeAmp: 0.90,
    detFreq: 0.0080, detAmp: 10,
    duneFreq: 0, duneAmp: 0,
    lakeAmp: 0, lakeDepth: 0,
    floor: -260,
    snowLine: 800, beachBand: 5, beachMix: 1.0,
    rockStart: 0.32, rockEnd: 0.66, rockMix: 0.9,
    waterColor: 0x1f8fb5, skyTint: 0xaee3f2, underwaterFog: 0x0d4a5c,
    colors: {
      low: 0x338a48, mid: 0x429c55, high: 0x6a9450, peak: 0x8c9c78,
      rock: 0x7a6a58, sand: 0xf2e6bd, snow: 0xffffff, ice: 0xbfe3ea,
      urban: 0x8f8a78, deep: 0x1d4a63,
    },
  },
  desert: {
    label: '沙漠',
    contFreq: 0.00026, contBase: 0.45, contAmp: 132,
    hillFreq: 0.00095, hillAmp: 42,
    ridgeFreq: 0.00070, ridgeBase: 0.42, ridgeK: 1.4, ridgeMaskK: 2.2, ridgeAmp: 0.30,
    detFreq: 0.0060, detAmp: 6,
    duneFreq: 0.0022, duneAmp: 60,
    lakeAmp: 0, lakeDepth: 0,
    floor: -260,
    snowLine: 1150, beachBand: 3, beachMix: 0.5,
    rockStart: 0.24, rockEnd: 0.52, rockMix: 0.85,
    waterColor: 0x2f7fa8, skyTint: 0xe8d9b8, underwaterFog: 0x2a4a52,
    colors: {
      low: 0xd6ab63, mid: 0xe0c286, high: 0xc9a463, peak: 0xae8a55,
      rock: 0x9a6a44, sand: 0xe6dcc0, snow: 0xf2f2f6, ice: 0xd8ecef,
      urban: 0xa89a80, deep: 0x2a4a55,
    },
  },
  snow: {
    label: '雪原',
    contFreq: 0.00030, contBase: 0.42, contAmp: 205,
    hillFreq: 0.00110, hillAmp: 70,
    ridgeFreq: 0.00080, ridgeBase: 0.30, ridgeK: 1.8, ridgeMaskK: 2.2, ridgeAmp: 1.10,
    detFreq: 0.0070, detAmp: 10,
    duneFreq: 0, duneAmp: 0,
    lakeAmp: 1, lakeDepth: 9,
    floor: -260,
    snowLine: 40, beachBand: 4, beachMix: 0.6,
    rockStart: 0.34, rockEnd: 0.70, rockMix: 0.8,
    waterColor: 0x9fc9dd, skyTint: 0xdff0ff, underwaterFog: 0x27506b,
    colors: {
      low: 0xd9e6f2, mid: 0xe9f1f8, high: 0xf7fbff, peak: 0xffffff,
      rock: 0x8b93a1, sand: 0xc3d4e2, snow: 0xffffff, ice: 0xbcd9e8,
      urban: 0xa8b0b8, deep: 0x1e3a52,
    },
  },
  rocky: {
    label: '岩石',
    contFreq: 0.00030, contBase: 0.44, contAmp: 155,
    hillFreq: 0.00140, hillAmp: 115,
    ridgeFreq: 0.00085, ridgeBase: 0.32, ridgeK: 1.8, ridgeMaskK: 2.4, ridgeAmp: 1.0,
    detFreq: 0.0085, detAmp: 12,
    duneFreq: 0, duneAmp: 0,
    lakeAmp: 0, lakeDepth: 0,
    floor: -260,
    snowLine: 640, beachBand: 5, beachMix: 0.7,
    rockStart: 0.16, rockEnd: 0.46, rockMix: 1.0,
    waterColor: 0x2c5f86, skyTint: 0x9fbcd6, underwaterFog: 0x14283c,
    colors: {
      low: 0x6b6558, mid: 0x7b7468, high: 0x8a837a, peak: 0x9d978d,
      rock: 0x585149, sand: 0xbdb09a, snow: 0xe8eff5, ice: 0xc2d6e2,
      urban: 0x8a8378, deep: 0x223f55,
    },
  },
  city: {
    label: '城市',
    contFreq: 0.00026, contBase: 0.46, contAmp: 62,
    hillFreq: 0.00100, hillAmp: 40,
    ridgeFreq: 0.00070, ridgeBase: 0.44, ridgeK: 1.2, ridgeMaskK: 2.0, ridgeAmp: 0.18,
    detFreq: 0.0055, detAmp: 5,
    duneFreq: 0, duneAmp: 0,
    lakeAmp: 0, lakeDepth: 0,
    floor: -260,
    snowLine: 760, beachBand: 8, beachMix: 0.8,
    rockStart: 0.30, rockEnd: 0.60, rockMix: 0.8,
    waterColor: 0x3a6f96, skyTint: 0xa8c4dc, underwaterFog: 0x1b3247,
    colors: {
      low: 0x66744f, mid: 0x767e60, high: 0x8a8b7d, peak: 0x9a9a92,
      rock: 0x74706a, sand: 0xc9bda0, snow: 0xecf0f4, ice: 0xc6dae6,
      urban: 0x9a9a95, deep: 0x24425a,
    },
  },
};

/** 默认的 biome（未知名字时回退） */
const DEFAULT_BIOME = 'green';

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export class Terrain {
  /**
   * @param {object} [opts]
   *   seed:number           默认 1337
   *   size:number           世界边长（米）默认 16000
   *   segments:number       网格分段（默认 320，自动取偶）
   *   biome:string          'green'|'snow'|'desert'|'rocky'|'city'|'tropical'
   *   seaLevel:number       默认 0
   *   heightScale:number    山峰高度上限，默认 900
   *   water:boolean         是否生成海面，默认 true
   *   waterColor:number     默认取 biome.waterColor
   *   flatRegions:Array     平整区（跑道/城市）
   *   roughness:number      0..1
   *   islands:boolean       默认 true
   *   roads:boolean         默认 false
   *   detail:number         附加细节噪声强度，默认 1
   */
  constructor(opts) {
    const o = opts || {};

    // ---- 基础参数 ----
    this._seed = Number.isFinite(o.seed) ? (o.seed | 0) : 1337;
    this._size = Number.isFinite(o.size) && o.size > 64 ? o.size : 16000;
    let seg = Number.isFinite(o.segments) ? Math.round(o.segments) : 320;
    seg = Math.max(8, Math.min(400, seg));
    if (seg % 2 !== 0) seg += 1; // 必须为偶数
    this._segments = seg;

    this._biome = Object.prototype.hasOwnProperty.call(BIOMES, o.biome) ? o.biome : DEFAULT_BIOME;
    this._cfg = BIOMES[this._biome];

    this._seaLevel = Number.isFinite(o.seaLevel) ? o.seaLevel : 0;
    this._heightScale = Number.isFinite(o.heightScale) && o.heightScale > 0 ? o.heightScale : 900;
    this._water = o.water !== false;
    this._islands = o.islands !== false;
    this._roads = o.roads === true;
    this._detail = Number.isFinite(o.detail) ? o.detail : 1;
    this._rough = clamp01(Number.isFinite(o.roughness) ? o.roughness : 0.5);

    this._half = this._size * 0.5;
    this._step = this._size / this._segments;
    this._oceanFloor = this._seaLevel - 220; // 远洋海底基准（约 -200m 级别）

    // ---- 调色板（sRGB -> 线性） ----
    const P = this._cfg.colors;
    this._pal = {
      low: new THREE.Color(P.low),
      mid: new THREE.Color(P.mid),
      high: new THREE.Color(P.high),
      peak: new THREE.Color(P.peak),
      rock: new THREE.Color(P.rock),
      sand: new THREE.Color(P.sand),
      snow: new THREE.Color(P.snow),
      ice: new THREE.Color(P.ice),
      urban: new THREE.Color(P.urban),
      deep: new THREE.Color(P.deep),
    };

    this._waterColor = new THREE.Color(Number.isFinite(o.waterColor) ? o.waterColor : this._cfg.waterColor);
    /** 水下雾提示色：主循环可在相机低于 seaLevel 时用它插值 scene.fog.color / 叠加屏幕滤镜 */
    this.underwaterFogColor = new THREE.Color(this._cfg.underwaterFog);
    /** 建议的水下雾密度（供主循环使用，本模块不主动修改 scene.fog） */
    this.underwaterFogDensity = 0.014;

    // ---- 平整区 ----
    this._regions = this._normalizeRegions(o.flatRegions);
    if (this._regions.length === 0) this._regions = this._makeDefaultRegions();

    // ---- 缓存/状态 ----
    this._heights = null;        // Float32Array((segments+1)^2) 网格顶点高度（与渲染完全一致）
    this._geom = null;
    this._mat = null;
    this._detailTex = null;
    this._mesh = null;
    this._waterGeom = null;
    this._waterMat = null;
    this._waterTex = null;
    this._waterMesh = null;
    this._waterUniforms = null;
    this._floorGeom = null;
    this._floorMat = null;
    this._floorMesh = null;
    this._root = new THREE.Group();
    this._root.name = 'terrain';
    this._built = false;
    this._time = 0;
    this._spawns = null;
    this._random = mulberry32(this._seed ^ 0x5f3759df);
    this._cA = new THREE.Color();   // 着色临时色
    /** 原始构造参数（只读用途，方便其它模块读取地图配置） */
    this.opts = o;
  }

  // =========================================================================
  // 对外只读属性
  // =========================================================================

  /** 是否已 build */
  get built() {
    return this._built;
  }

  /** 世界边长（米） */
  get size() {
    return this._size;
  }

  /** 海平面高度（米，ASL） */
  get seaLevel() {
    return this._seaLevel;
  }

  /** 当前 biome 名 */
  get biome() {
    return this._biome;
  }

  /** 山峰高度上限 */
  get heightScale() {
    return this._heightScale;
  }

  /** 归一化后的平整区数组（landmarks 可直接使用：x,z,radius,height,blend,heading,name） */
  get flatRegions() {
    return this._regions;
  }

  /** 地形 mesh（未 build 时为 null） */
  get mesh() {
    return this._mesh;
  }

  /** 海面 mesh（未 build / water=false 时为 null） */
  get waterMesh() {
    return this._waterMesh;
  }

  /** 所有地形对象的根 Group（未 build 时为空 Group） */
  get root() {
    return this._root;
  }

  // =========================================================================
  // 构建
  // =========================================================================

  /**
   * 构建地形 mesh 与海面并加入场景。返回 this。
   * 只使用 THREE 内置几何/材质 + canvas 程序化贴图；重复调用是安全的（第二次直接返回）。
   * @param {THREE.Scene} scene
   */
  build(scene) {
    if (this._built) return this;

    this._geom = this._buildGeometry();
    this._detailTex = this._makeDetailTexture();
    this._mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this._detailTex || null,
      roughness: 0.94,
      metalness: 0.02,
      dithering: true,
      side: THREE.FrontSide,
    });
    this._mat.name = 'terrain-material';

    this._mesh = new THREE.Mesh(this._geom, this._mat);
    this._mesh.name = 'terrain-surface';
    this._mesh.receiveShadow = true;
    this._mesh.castShadow = false;
    this._mesh.matrixAutoUpdate = false;
    this._mesh.updateMatrix();
    this._root.add(this._mesh);

    if (this._water) this._buildWater();

    if (scene && typeof scene.add === 'function') scene.add(this._root);

    this._built = true;
    return this;
  }

  /** 构建地形 BufferGeometry（位置/UV/顶点色/索引），并回填 _heights 供 heightAt 使用。 */
  _buildGeometry() {
    const seg = this._segments;
    const n = seg + 1;
    const half = this._half;
    const step = this._size / seg;
    this._step = step;

    const count = n * n;
    const heights = new Float32Array(count);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);

    // ---- 顶点：高度使用唯一的 _heightRaw()（与 heightAt 完全同源） ----
    for (let iz = 0; iz < n; iz++) {
      const z = -half + iz * step;
      const row = iz * n;
      for (let ix = 0; ix < n; ix++) {
        const x = -half + ix * step;
        const i = row + ix;
        let h = this._heightRaw(x, z);
        h = this._applyFlatRegions(x, z, h);
        heights[i] = h;
        positions[i * 3] = x;
        positions[i * 3 + 1] = h;
        positions[i * 3 + 2] = z;
        uvs[i * 2] = ix / seg;
        uvs[i * 2 + 1] = iz / seg;
      }
    }
    this._heights = heights;

    // ---- 索引：每个格子拆成 a-c-b / a-d-c 两个三角（对角线 a-c，与 heightAt 的插值一致） ----
    const cells = seg * seg;
    const indices = count > 65535 ? new Uint32Array(cells * 6) : new Uint16Array(cells * 6);
    let p = 0;
    for (let iz = 0; iz < seg; iz++) {
      for (let ix = 0; ix < seg; ix++) {
        const i0 = iz * n + ix;      // a(ix,iz)
        const i1 = i0 + 1;           // b(ix+1,iz)
        const i2 = i0 + n;           // d(ix,iz+1)
        const i3 = i2 + 1;           // c(ix+1,iz+1)
        indices[p++] = i0; indices[p++] = i3; indices[p++] = i1; // (a,c,b) 朝上
        indices[p++] = i0; indices[p++] = i2; indices[p++] = i3; // (a,d,c) 朝上
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    // ---- 顶点色：需要法线（坡度），故在 computeVertexNormals 之后 ----
    const nrm = geom.getAttribute('normal').array;
    this._paint(colors, positions, nrm, count);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    return geom;
  }

  /** 程序化细节贴图（256×256，可平铺，近似灰度；roads=true 时叠加道路网格）。 */
  _makeDetailTexture() {
    if (typeof document === 'undefined') return null;
    const S = 256;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const img = ctx.createImageData(S, S);
    const d = img.data;
    const seed = this._seed + 131;
    const roads = this._roads;

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        // 多层可平铺噪声（周期均为 2 的幂，保证无缝）
        const a = fbmTile(u, v, 8, 4, seed, 0.55);
        const b = fbmTile(u, v, 32, 3, seed + 71, 0.5);
        let bright = 0.88 + 0.12 * (a * 0.7 + b * 0.3);

        // 轻微色偏：让地表不是纯灰
        let r = bright;
        let g = bright * 0.995;
        let bl = bright * 0.985;

        // 道路：贴图重复尺度被设为 size/256（每格 256m），沿格边画柏油带 + 虚线
        if (roads) {
          const roadHalf = 3 / 256;   // 约 3m 半宽 => 6m 路面
          const inRoadY = v < roadHalf || v > 1 - roadHalf;
          const inRoadX = u < roadHalf || u > 1 - roadHalf;
          if (inRoadY || inRoadX) {
            r = 0.42; g = 0.43; bl = 0.45;
            // 中心虚线
            const along = inRoadY ? u : v;
            const center = inRoadY ? Math.abs(v - 0.5) : Math.abs(u - 0.5);
            if (center < 1.5 / 256 && (along * 64) % 1 < 0.55) { r = 0.95; g = 0.95; bl = 0.9; }
          }
        }

        const o = (y * S + x) * 4;
        d[o] = clamp01(r) * 255;
        d[o + 1] = clamp01(g) * 255;
        d[o + 2] = clamp01(bl) * 255;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.name = 'terrain-detail';
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // UV 为 0..1，repeat 决定实际瓦片尺寸：默认每 64m 一次
    const rep = this._roads ? this._size / 256 : this._size / 64;
    tex.repeat.set(rep, rep);
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /** 海面 + 深海底色平面 */
  _buildWater() {
    const ws = this._size * 3;

    const geo = new THREE.PlaneGeometry(ws, ws, 48, 48);   // 低分辨率即可：涌浪波长约 17km
    geo.rotateX(-Math.PI / 2);   // 让法线朝 +Y，局部 y 轴即为高度方向
    geo.computeBoundingSphere();

    this._waterTex = this._makeWaterNormalTexture();

    this._waterUniforms = {
      uTime: { value: 0 },
      uWaveAmp: { value: 1.5 },
      uWaveScale: { value: 0.00022 },
      uSkyTint: { value: new THREE.Color(this._cfg.skyTint) },
    };

    const mat = new THREE.MeshStandardMaterial({
      color: this._waterColor,
      transparent: true,
      opacity: 0.84,
      roughness: 0.22,
      metalness: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
      normalMap: this._waterTex || null,
    });
    mat.name = 'terrain-water-material';
    if (this._waterTex) mat.normalScale = new THREE.Vector2(0.45, 0.45);

    const uniforms = this._waterUniforms;
    mat.onBeforeCompile = (shader) => {
      // 注入：时间 uniform + 低频涌浪顶点位移 + 逐像素掠射角天空反射（菲涅尔）
      // 注意：菲涅尔必须在片元里算，水面网格格子约 1km，逐顶点算会出现明显的三角形色块。
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWaveAmp = uniforms.uWaveAmp;
      shader.uniforms.uWaveScale = uniforms.uWaveScale;
      shader.uniforms.uSkyTint = uniforms.uSkyTint;

      let vs = 'uniform float uTime;\nuniform float uWaveAmp;\nuniform float uWaveScale;\n'
        + shader.vertexShader;
      if (vs.indexOf('#include <begin_vertex>') >= 0) {
        vs = vs.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n'
          + '\tfloat wvx = transformed.x * uWaveScale;\n'
          + '\tfloat wvz = transformed.z * uWaveScale;\n'
          + '\tfloat wvh = sin( wvx * 1.70 + uTime * 0.55 ) * 0.50\n'
          + '\t         + sin( wvz * 2.30 - uTime * 0.42 ) * 0.32\n'
          + '\t         + sin( ( wvx + wvz ) * 1.13 + uTime * 0.83 ) * 0.18;\n'
          + '\ttransformed.y += wvh * uWaveAmp;'
        );
      }
      shader.vertexShader = vs;

      let fs = 'uniform vec3 uSkyTint;\n' + shader.fragmentShader;
      // normal 是 normal_fragment_begin 定义、normal_fragment_maps 用法线贴图修正后的视空间法线
      let fresOK = false;
      if (fs.indexOf('#include <normal_fragment_maps>') >= 0) {
        fs = fs.replace(
          '#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n'
          + '\tfloat wFres = pow( 1.0 - clamp( dot( normalize( vViewPosition ), normal ), 0.0, 1.0 ), 3.0 );'
        );
        fresOK = true;
      }
      if (fresOK && fs.indexOf('#include <dithering_fragment>') >= 0) {
        fs = fs.replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n'
          + '\tgl_FragColor.rgb = mix( gl_FragColor.rgb, uSkyTint, wFres * 0.55 );'
        );
      }
      shader.fragmentShader = fs;
    };
    mat.customProgramCacheKey = () => 'sp2-water-v2';

    this._waterMat = mat;
    this._waterGeom = geo;
    const water = new THREE.Mesh(geo, mat);
    water.name = 'terrain-water';
    water.position.y = this._seaLevel;
    water.renderOrder = 1;
    water.matrixAutoUpdate = false;
    water.updateMatrix();
    this._waterMesh = water;
    this._root.add(water);

    // 深海底色：防止透过半透明水面直接看到天空（2 个三角形，几乎零成本）
    const fgeo = new THREE.PlaneGeometry(this._size * 6, this._size * 6, 1, 1);
    fgeo.rotateX(-Math.PI / 2);
    const fmat = new THREE.MeshBasicMaterial({
      color: this._waterColor.clone().multiplyScalar(0.35),
      fog: true,
    });
    fmat.name = 'terrain-ocean-floor-material';
    const floor = new THREE.Mesh(fgeo, fmat);
    floor.name = 'terrain-ocean-floor';
    floor.position.y = this._oceanFloor - 40;
    floor.renderOrder = -1;
    floor.matrixAutoUpdate = false;
    floor.updateMatrix();
    this._floorGeom = fgeo;
    this._floorMat = fmat;
    this._floorMesh = floor;
    this._root.add(floor);
  }

  /** 可平铺的水面法线贴图（128×128，切线空间）。 */
  _makeWaterNormalTexture() {
    if (typeof document === 'undefined') return null;
    const S = 128;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const H = new Float32Array(S * S);
    const seed = this._seed + 211;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        H[y * S + x] = fbmTile(x / S, y / S, 4, 4, seed, 0.55);
      }
    }

    const img = ctx.createImageData(S, S);
    const d = img.data;
    const strength = 3.0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const xl = (x - 1 + S) % S;
        const xr = (x + 1) % S;
        const yd = (y - 1 + S) % S;
        const yu = (y + 1) % S;
        const dhdu = (H[y * S + xr] - H[y * S + xl]) * strength;
        const dhdv = (H[yu * S + x] - H[yd * S + x]) * strength;
        let nx = -dhdu;
        let ny = -dhdv;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= inv;
        ny *= inv;
        const nz = inv;
        const o = (y * S + x) * 4;
        d[o] = (nx * 0.5 + 0.5) * 255;
        d[o + 1] = (ny * 0.5 + 0.5) * 255;
        d[o + 2] = (nz * 0.5 + 0.5) * 255;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.name = 'terrain-water-normal';
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    const rep = (this._size * 3) / 220;   // 每 220m 一次波纹瓦片
    tex.repeat.set(rep, rep);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  // =========================================================================
  // 高度 / 法线 / 查询（物理热路径：无分配）
  // =========================================================================

  /**
   * 世界坐标处的地形高度（米，ASL）。
   * 与渲染网格完全一致：在网格顶点高度上按索引缓冲区的三角剖分做平面插值。
   * 无分配，O(1)。网格之外（|x| > size/2 或 |z| > size/2）夹紧到边界值。
   * 若尚未 build()，退化为直接噪声采样（含平整区），仍与网格近似一致。
   * @param {number} x
   * @param {number} z
   * @returns {number}
   */
  heightAt(x, z) {
    const g = this._heights;
    if (g === null) return this._heightDirect(x, z);

    const seg = this._segments;
    const n = seg + 1;
    const step = this._step;
    const half = this._half;

    let fx = (x + half) / step;
    let fz = (z + half) / step;
    if (!(fx > 0)) fx = 0; else if (fx > seg) fx = seg;       // 同时吃掉 NaN
    if (!(fz > 0)) fz = 0; else if (fz > seg) fz = seg;

    let ix = fx | 0;
    let iz = fz | 0;
    if (ix >= seg) ix = seg - 1;
    if (iz >= seg) iz = seg - 1;

    const u = fx - ix;
    const v = fz - iz;
    const i0 = iz * n + ix;
    const i1 = i0 + 1;        // b(ix+1,iz)
    const i2 = i0 + n;        // d(ix,iz+1)
    const i3 = i2 + 1;        // c(ix+1,iz+1)
    const ha = g[i0];
    if (u >= v) {
      const hb = g[i1];
      const hc = g[i3];
      // 三角 (a,b,c)：h = ha + u*(hb-ha) + v*(hc-hb)
      return ha + u * (hb - ha) + v * (hc - hb);
    }
    const hc = g[i3];
    const hd = g[i2];
    // 三角 (a,c,d)：h = ha + u*(hc-ha) + (v-u)*(hd-ha)
    return ha + u * (hc - ha) + (v - u) * (hd - ha);
  }

  /**
   * 地表法线（单位向量）。使用与渲染三角面完全一致的平面法线（每个三角面内恒定）。
   * 未 build 时退化为噪声有限差分。默认返回新对象；传入 target 可做到零分配。
   * @param {number} x
   * @param {number} z
   * @param {THREE.Vector3} [target]
   * @returns {THREE.Vector3}
   */
  normalAt(x, z, target) {
    const out = target && target.isVector3 ? target : new THREE.Vector3();
    const g = this._heights;
    if (g === null) {
      const e = Math.max(1, this._step * 0.25);
      const gx = (this._heightDirect(x + e, z) - this._heightDirect(x - e, z)) / (2 * e);
      const gz = (this._heightDirect(x, z + e) - this._heightDirect(x, z - e)) / (2 * e);
      return out.set(-gx, 1, -gz).normalize();
    }

    const seg = this._segments;
    const n = seg + 1;
    const step = this._step;
    const half = this._half;

    let fx = (x + half) / step;
    let fz = (z + half) / step;
    if (!(fx > 0)) fx = 0; else if (fx > seg) fx = seg;
    if (!(fz > 0)) fz = 0; else if (fz > seg) fz = seg;
    let ix = fx | 0;
    let iz = fz | 0;
    if (ix >= seg) ix = seg - 1;
    if (iz >= seg) iz = seg - 1;

    const u = fx - ix;
    const v = fz - iz;
    const i0 = iz * n + ix;
    const i1 = i0 + 1;
    const i2 = i0 + n;
    const i3 = i2 + 1;

    let dhdx;
    let dhdz;
    if (u >= v) {
      const ha = g[i0];
      dhdx = (g[i1] - ha) / step;
      dhdz = (g[i3] - g[i1]) / step;
    } else {
      dhdx = (g[i3] - g[i2]) / step;
      dhdz = (g[i2] - g[i0]) / step;
    }
    return out.set(-dhdx, 1, -dhdz).normalize();
  }

  /** 该点是否为水面（heightAt < seaLevel）。 */
  isWater(x, z) {
    return this.heightAt(x, z) < this._seaLevel;
  }

  /** 若点在 flatRegion 内返回该 region，否则 null。 */
  regionAt(x, z) {
    const rs = this._regions;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      const dx = x - r.x;
      const dz = z - r.z;
      if (dx * dx + dz * dz <= r.radius * r.radius) return r;
    }
    return null;
  }

  /**
   * 机头方向单位向量（XZ 平面）：heading=0 → (0,0,-1)。
   * 与 new THREE.Euler(0, heading, 0) 作用于 -Z 朝向模型完全一致。
   * @param {number} heading 弧度
   * @param {THREE.Vector3} [target]
   */
  headingDirection(heading, target) {
    const out = target && target.isVector3 ? target : new THREE.Vector3();
    return out.set(-Math.sin(heading), 0, -Math.cos(heading));
  }

  /** 由 XZ 方向求 heading（与 headingDirection 互逆）。 */
  headingFromDirection(dx, dz) {
    return Math.atan2(-dx, -dz);
  }

  // =========================================================================
  // 出生点
  // =========================================================================

  /**
   * 建议出生点（缓存）。至少 3 个：'main'、'alt'、'outpost'，water=true 时再加 'sea'。
   * 位置取平整区中心（因此地面是绝对平的），heading 见文件头约定。
   * @returns {Array<{name:string, position:THREE.Vector3, heading:number, runwayLength:number}>}
   */
  get spawnPoints() {
    if (this._spawns) return this._spawns;

    const list = [];
    const names = ['main', 'alt', 'outpost', 'field4', 'field5', 'field6'];
    const regions = this._regions;

    for (let i = 0; i < regions.length && i < names.length; i++) {
      const r = regions[i];
      list.push({
        name: names[i],
        position: new THREE.Vector3(r.x, r.height, r.z),
        heading: r.heading,
        runwayLength: Math.max(40, r.radius * 2),
      });
    }

    // 平整区不足 3 个时，用网格找出额外的平坦地点补齐
    if (list.length < 3) {
      const spots = this._findFlatSpots(3 - list.length);
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        list.push({
          name: names[list.length] || ('spare' + list.length),
          position: new THREE.Vector3(s.x, s.y, s.z),
          heading: 0,
          runwayLength: 440,
        });
      }
    }

    // 兜底：极端情况下（未 build 且无可用户地平区）用固定偏移保证数量
    while (list.length < 3) {
      const i = list.length;
      const x = (i - 1) * this._size * 0.12;
      const z = this._size * 0.10;
      list.push({
        name: names[i],
        position: new THREE.Vector3(x, this.heightAt(x, z), z),
        heading: 0,
        runwayLength: 440,
      });
    }

    // 水上出生点（水上飞机）
    if (this._water) {
      const sea = this._findSeaSpawn();
      if (sea) {
        list.push({
          name: 'sea',
          position: new THREE.Vector3(sea.x, this._seaLevel, sea.z),
          heading: sea.heading,
          runwayLength: 1200,
        });
      }
    }

    this._spawns = list;
    return list;
  }

  // =========================================================================
  // 随机散点
  // =========================================================================

  /**
   * 随机陆地点（放树/建筑/收集物用）。返回 {x,y,z}，80 次尝试仍失败则返回 null。
   * y 为 heightAt 结果（贴合渲染地表）；会避开水面与坡度大于约 31° 的陡坡。
   * @param {() => number} [rng] 0..1 的随机源（默认使用本实例的确定性 PRNG）
   * @returns {{x:number,y:number,z:number}|null}
   */
  randomLandPoint(rng) {
    const r = typeof rng === 'function' ? rng : this._random;
    const lim = this._half * 0.86;
    const e = this._step * 0.5;
    for (let i = 0; i < 80; i++) {
      const x = (r() * 2 - 1) * lim;
      const z = (r() * 2 - 1) * lim;
      const y = this.heightAt(x, z);
      if (y < this._seaLevel + 1.5) continue;
      const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
      const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
      if (gx * gx + gz * gz > 0.36) continue;   // 约 31°
      return { x: x, y: y, z: z };
    }
    return null;
  }

  // =========================================================================
  // 每帧更新 / 释放
  // =========================================================================

  /** 每帧：只推进水面动画（uniform 更新 + 法线贴图滚动）。dt 秒。 */
  update(dt) {
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    this._time += d;
    if (this._waterUniforms) this._waterUniforms.uTime.value = this._time;
    if (this._waterTex) {
      // 两层不同速度的滚动叠加由贴图自身重复实现，这里只做匀速漂移
      this._waterTex.offset.x = (this._time * 0.0032) % 1;
      this._waterTex.offset.y = (1 - (this._time * 0.0024) % 1) % 1;
    }
  }

  /** 从场景移除并释放所有 GPU 资源。 */
  dispose() {
    if (this._root.parent) this._root.parent.remove(this._root);
    if (this._geom) this._geom.dispose();
    if (this._mat) this._mat.dispose();
    if (this._detailTex) this._detailTex.dispose();
    if (this._waterGeom) this._waterGeom.dispose();
    if (this._waterMat) this._waterMat.dispose();
    if (this._waterTex) this._waterTex.dispose();
    if (this._floorGeom) this._floorGeom.dispose();
    if (this._floorMat) this._floorMat.dispose();

    this._root.clear();
    this._geom = null;
    this._mat = null;
    this._detailTex = null;
    this._waterGeom = null;
    this._waterMat = null;
    this._waterTex = null;
    this._waterMesh = null;
    this._floorGeom = null;
    this._floorMat = null;
    this._floorMesh = null;
    this._mesh = null;
    this._waterUniforms = null;
    this._heights = null;
    this._built = false;
  }

  // =========================================================================
  // 内部：地形形状
  // =========================================================================

  /**
   * 未 build 时的查询路径：基础噪声 + 平整区（无网格缓存，O(6 个八度)）。
   * @param {number} x
   * @param {number} z
   * @returns {number}
   */
  _heightDirect(x, z) {
    return this._applyFlatRegions(x, z, this._heightRaw(x, z));
  }

  /**
   * 基础高度函数（不含平整区）：biome 形态 + 岛屿遮罩。
   * 网格顶点与 heightAt（未 build 时）都用它，保证同源。
   * @param {number} x
   * @param {number} z
   * @returns {number}
   */
  _heightRaw(x, z) {
    const cfg = this._cfg;
    const s = this._seed;
    const rough = 0.55 + 0.75 * this._rough;   // 中高频幅度系数

    // 多尺度噪声层（每层 seed 偏移不同，互不相关）
    const cont = fbm2(x * cfg.contFreq, z * cfg.contFreq, s + 11, 4, 2.0, 0.5);
    const hill = fbm2(x * cfg.hillFreq, z * cfg.hillFreq, s + 23, 5, 2.0, 0.5);
    const ridge = ridged2(x * cfg.ridgeFreq, z * cfg.ridgeFreq, s + 37, 5, 2.0, 0.5);
    const det = fbm2(x * cfg.detFreq, z * cfg.detFreq, s + 53, 3, 2.0, 0.5);

    let h = (cont - cfg.contBase) * cfg.contAmp;
    h += (hill - 0.5) * cfg.hillAmp * rough;

    // 山脊：只在大陆噪声较高的区域抬升，形成山脉而不是全图尖刺
    const mtnMask = clamp01((cont - cfg.ridgeBase) * cfg.ridgeMaskK);
    const mtn = clamp01((ridge - 0.30) * cfg.ridgeK);
    h += mtn * mtnMask * cfg.ridgeAmp * this._heightScale;

    // 沙漠沙丘（ridged）与盐滩
    if (cfg.duneAmp > 0) {
      const dune = ridged2(x * cfg.duneFreq, z * cfg.duneFreq, s + 67, 4, 2.0, 0.55);
      const salt = this._saltMask(x, z);
      h += (dune - 0.45) * cfg.duneAmp * rough * (1 - salt);
      h = lerp(h, this._seaLevel + 2.5, salt);      // 盐滩几乎绝对平，略高于海面
    }

    // 雪原低海拔冰湖
    if (cfg.lakeAmp > 0) {
      const lake = this._lakeMask(x, z);
      h = lerp(h, this._seaLevel - cfg.lakeDepth, lake);
    }

    // 细节噪声
    h += (det - 0.5) * this._detail * cfg.detAmp * rough;

    // 软削顶：让山峰不超过 heightScale 太多
    const lim = this._heightScale;
    if (h > lim) h = lim + (h - lim) * 0.3;
    if (h < cfg.floor) h = cfg.floor;

    // 岛屿遮罩：远边缘平滑沉入水下
    const m = this._islandMask(x, z);
    if (m > 0) {
      const deep = this._oceanFloor + (fbm2(x * 0.0006, z * 0.0006, s + 83, 2, 2.0, 0.5) - 0.5) * 40;
      h = lerp(h, deep, m);
    }
    return h;
  }

  /**
   * 岛屿遮罩，0 = 内陆，1 = 远洋。
   * 基础度量按约定使用切比雪夫距离 max(|x|,|z|)/(size/2)，再混入少量欧氏距离让
   * 方形地图的四个角更早沉没（轮廓更圆润），最后叠加低频噪声扰动海岸线。
   */
  _islandMask(x, z) {
    const half = this._half;
    const cheb = Math.max(Math.abs(x), Math.abs(z)) / half;   // 0 中心 → 1 边缘
    if (!this._islands) return smoothstep(0.90, 1.0, cheb);
    const euclid = Math.sqrt(x * x + z * z) / half;
    const base = cheb * 0.85 + euclid * 0.15;
    const n = fbm2(x * 0.00021, z * 0.00021, this._seed + 71, 3, 2.0, 0.5);
    const dd = base + (n - 0.5) * 0.16;
    return smoothstep(0.66, 0.97, dd);
  }

  /** 沙漠盐滩权重（低洼 + 特定噪声区域），用于 flatten 与上色。 */
  _saltMask(x, z) {
    const s = this._seed;
    const n = fbm2(x * 0.00050, z * 0.00050, s + 101, 3, 2.0, 0.5);
    const c = fbm2(x * 0.00030, z * 0.00030, s + 11, 3, 2.0, 0.5);
    return smoothstep(0.52, 0.66, n) * smoothstep(0.62, 0.42, c);
  }

  /** 雪原冰湖权重（低洼 + 平坦），湖面低于海平面，由水面平面呈现为冰湖。 */
  _lakeMask(x, z) {
    const s = this._seed;
    const n = fbm2(x * 0.00060, z * 0.00060, s + 107, 3, 2.0, 0.5);
    const c = fbm2(x * 0.00030, z * 0.00030, s + 11, 3, 2.0, 0.5);
    return smoothstep(0.50, 0.62, n) * smoothstep(0.50, 0.30, c);
  }

  /** 把平整区混合进高度（内核完全水平，blend 宽度内平滑过渡）。 */
  _applyFlatRegions(x, z, h) {
    const rs = this._regions;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      const dx = x - r.x;
      const dz = z - r.z;
      const lim = r.radius + r.blend;
      const d2 = dx * dx + dz * dz;
      if (d2 > lim * lim) continue;
      const d = Math.sqrt(d2);
      if (d <= r.radius) return r.height;         // 内核：绝对平
      const t = (d - r.radius) / r.blend;
      const k = 1 - t * t * (3 - 2 * t);          // 平滑权重
      h = h + (r.height - h) * k;
    }
    return h;
  }

  // =========================================================================
  // 内部：顶点着色
  // =========================================================================

  /** 调色板海拔渐变（low → mid → high → peak）。 */
  _ramp(out, t) {
    const p = this._pal;
    if (t < 0.34) out.copy(p.low).lerp(p.mid, t / 0.34);
    else if (t < 0.72) out.copy(p.mid).lerp(p.high, (t - 0.34) / 0.38);
    else out.copy(p.high).lerp(p.peak, (t - 0.72) / 0.28);
  }

  /** 逐顶点上色：海拔渐变 + 水下压暗 + 沙滩/盐滩/冰面 + 陡坡露岩 + 雪线 + 专属 biome 细节。 */
  _paint(colors, pos, nrm, count) {
    const pal = this._pal;
    const cfg = this._cfg;
    const sea = this._seaLevel;
    const hs = this._heightScale;
    const seed = this._seed;
    const biome = this._biome;
    const snowLine = cfg.snowLine * (hs / 900);
    const c = this._cA;
    const band = cfg.beachBand;

    for (let i = 0; i < count; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const ny = nrm[i * 3 + 1];
      const slope = 1 - clamp01(ny);          // 0 平坦 → 1 垂直
      const hRel = y - sea;

      // 1) 海拔基色
      this._ramp(c, clamp01(hRel / (hs * 0.62)));

      // 2) 浅滩沙色（接近海平面且平坦）
      if (band > 0 && hRel > -band && hRel < band) {
        const nb = 1 - Math.abs(hRel) / band;
        const flat = 1 - slope * 3;
        if (flat > 0) c.lerp(pal.sand, nb * nb * (3 - 2 * nb) * flat * cfg.beachMix);
      }

      // 3) 水下压暗（越深越暗，透过半透明海面形成深海感）
      if (hRel < 0) c.lerp(pal.deep, 0.72 * smoothstep(0, 30, -hRel));

      // 4) 陡坡露岩
      const rockT = smoothstep(cfg.rockStart, cfg.rockEnd, slope) * cfg.rockMix;
      if (rockT > 0) c.lerp(pal.rock, rockT);

      // 5) 雪线（按 heightScale 缩放）
      const snowT = smoothstep(snowLine - 60, snowLine + 120, hRel) * (1 - 0.45 * rockT);
      if (snowT > 0) c.lerp(pal.snow, clamp01(snowT));

      // 6) biome 专属
      if (biome === 'snow') {
        const lk = this._lakeMask(x, z);
        if (lk > 0) c.lerp(pal.ice, lk * 0.85);
      } else if (biome === 'desert') {
        const st = this._saltMask(x, z);
        if (st > 0) c.lerp(pal.sand, st * 0.75);
      } else if (biome === 'city') {
        const ur = smoothstep(0.52, 0.72, fbm2(x * 0.0016, z * 0.0016, seed + 113, 2, 2.0, 0.5));
        if (ur > 0) c.lerp(pal.urban, ur * 0.5);
      }

      // 7) 颜色噪声扰动（打散色块）+ 细节贴图的亮度补偿
      const nv = fbm2(x * 0.0032, z * 0.0032, seed + 97, 2, 2.0, 0.5);
      const mul = (0.90 + 0.20 * nv) * 1.05;
      const r = c.r * mul;
      const g = c.g * mul;
      const b = c.b * mul;
      colors[i * 3] = r > 1 ? 1 : r;
      colors[i * 3 + 1] = g > 1 ? 1 : g;
      colors[i * 3 + 2] = b > 1 ? 1 : b;
    }
  }

  // =========================================================================
  // 内部：平整区 / 出生点辅助
  // =========================================================================

  /** 归一化传入的 flatRegions（补默认 blend/height/heading/name）。 */
  _normalizeRegions(input) {
    const out = [];
    if (!Array.isArray(input)) return out;
    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const radius = Number.isFinite(r.radius) && r.radius > 0 ? r.radius : 120;
      const blend = Number.isFinite(r.blend) && r.blend > 0 ? r.blend : radius * 0.6;
      const height = Number.isFinite(r.height) ? r.height : this._seaLevel + 40;
      out.push({
        name: typeof r.name === 'string' ? r.name : ('region' + (i + 1)),
        x: Number.isFinite(r.x) ? r.x : 0,
        z: Number.isFinite(r.z) ? r.z : 0,
        radius: radius,
        height: height,
        blend: blend,
        heading: Number.isFinite(r.heading) ? r.heading : 0,
      });
    }
    return out;
  }

  /** 未提供 flatRegions 时自动生成 3 个机场平地（保证 spawnPoints 一定有 3 个平坦出生点）。 */
  _makeDefaultRegions() {
    const R = clamp(this._size * 0.022, 120, 420);
    const mk = (name, fx, fz, radius, hMin, hMax) => {
      const x = this._size * fx;
      const z = this._size * fz;
      // 取自然地形高度并夹紧到合理区间，避免在山顶挖坑或在海里造孤岛
      const natural = this._heightRaw(x, z);
      const height = clamp(natural, this._seaLevel + hMin, this._seaLevel + hMax);
      return { name: name, x: x, z: z, radius: radius, height: height, blend: radius * 0.7, heading: 0 };
    };
    return [
      mk('main', 0.0, 0.10, R, 25, 260),
      mk('alt', -0.22, -0.17, R * 0.8, 30, 300),
      mk('outpost', 0.23, 0.20, R * 0.55, 35, 320),
    ];
  }

  /** 在高度网格里寻找最平坦的若干点（不与其他平整区重叠）。 */
  _findFlatSpots(count) {
    const g = this._heights;
    const out = [];
    if (!g) return out;
    const n = this._segments + 1;
    const seg = this._segments;
    const step = this._step;
    const stride = Math.max(2, Math.round(seg / 40));
    const cands = [];
    for (let iz = stride; iz < n - stride; iz += stride) {
      for (let ix = stride; ix < n - stride; ix += stride) {
        const i = iz * n + ix;
        const h = g[i];
        if (h < this._seaLevel + 12) continue;
        const gx = (g[i + 1] - g[i - 1]) / (2 * step);
        const gz = (g[i + n] - g[i - n]) / (2 * step);
        const slope = Math.sqrt(gx * gx + gz * gz);
        if (slope > 0.06) continue;
        cands.push({ x: -this._half + ix * step, z: -this._half + iz * step, y: h, slope: slope });
      }
    }
    cands.sort((a, b) => a.slope - b.slope);
    const sep = this._size * 0.12;
    const sep2 = sep * sep;
    for (let i = 0; i < cands.length && out.length < count; i++) {
      const cd = cands[i];
      let ok = true;
      for (let j = 0; j < this._regions.length; j++) {
        const r = this._regions[j];
        const dx = cd.x - r.x;
        const dz = cd.z - r.z;
        const lim = r.radius * 1.5;
        if (dx * dx + dz * dz < lim * lim) { ok = false; break; }
      }
      if (!ok) continue;
      for (let j = 0; j < out.length; j++) {
        const dx = cd.x - out[j].x;
        const dz = cd.z - out[j].z;
        if (dx * dx + dz * dz < sep2) { ok = false; break; }
      }
      if (ok) out.push(cd);
    }
    return out;
  }

  /** 找一处足够深的海面作为水上出生点（朝岛屿中心）。 */
  _findSeaSpawn() {
    const radii = [0.70, 0.80, 0.90];
    for (let k = 0; k < radii.length; k++) {
      const R = this._half * radii[k];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + 0.31;
        const x = Math.cos(a) * R;
        const z = Math.sin(a) * R;
        if (this.heightAt(x, z) < this._seaLevel - 12) {
          return { x: x, z: z, heading: this.headingFromDirection(-x, -z) };
        }
      }
    }
    return null;
  }
}

export default Terrain;
