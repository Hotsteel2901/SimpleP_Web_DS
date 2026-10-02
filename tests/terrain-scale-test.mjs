/**
 * 地形尺度自洽性回归测试
 * ------------------------------------------------------------------
 * 背景：曾出现一个「无头测试全绿、但实际地貌完全不对」的问题 ——
 * 多张地图声明的 heightScale 与其 biome 的 ridgeAmp 尺度不自洽，导致：
 *   maywar   heightScale=520 → 实测最高峰仅 42m（k=0.08），陆地占比 4.8%
 *   vetusta  heightScale=260 → 实测最高仅 24m（k=0.09），陆地 9.8%
 *   skypark  heightScale=320 → 实测最高仅 98m（k=0.31），陆地 12%
 *   boneyard heightScale=300 → 实测最高仅 106m（k=0.35）
 * 表现为：整张沙漠/城市图塌成浅海，机场被迫由 _reconcileRegions 抬成
 * 「海面上一座规则的圆形人工孤岛」。
 *
 * 为什么旧的 headless 测试发现不了：它只验证「世界能加载、飞机能飞」，
 * 从不检查地形的统计特征。地图参数写错时一切照常运行，只是地貌变得荒谬。
 *
 * 本测试直接对每张地图采样，断言：
 *   ① 峰高自洽：k = 实测最高 / heightScale ∈ [0.55, 1.45]
 *   ② 陆地充足：陆地占比 >= 15%
 *   ③ 机场可用：非 fixed 的机场，其自然地形干地占比 >= 50%
 *      （避免再次出现"机场泡在水下、靠硬抬变孤岛"）
 *
 * 用法： node tests/terrain-scale-test.mjs
 */
import { MAPS, getMap, terrainOptions } from '../src/world/maps.js';
import { Terrain } from '../src/world/terrain.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n       ' + e.message); }
};

const K_MIN = 0.55, K_MAX = 1.45;      // 峰高自洽区间（软削顶会略微超出 1.0）
const LAND_MIN = 15;                    // 全图陆地占比下限 %
const AIRPORT_DRY_MIN = 0.50;           // 机场区自然干地下限

function survey(map) {
  const terrain = new Terrain(terrainOptions(map, 1));
  const half = map.size / 2;
  const sea = terrain._seaLevel;

  let maxH = -1e9, land = 0, n = 0;
  for (let x = -half; x <= half; x += 80) {
    for (let z = -half; z <= half; z += 80) {
      const h = terrain._heightRaw(x, z);
      n++;
      if (h > sea + 5) land++;
      if (h > maxH) maxH = h;
    }
  }

  // 机场区（跳过 fixed：浮空平台的坐标是设计好的，不代表地貌）
  const airports = (terrain._regions || []).filter((r) => !r.fixed).map((r) => {
    let dry = 0, tot = 0;
    for (let dx = -r.radius; dx <= r.radius; dx += 55) {
      for (let dz = -r.radius; dz <= r.radius; dz += 55) {
        const h = terrain._heightRaw(r.x + dx, r.z + dz);
        tot++;
        if (h > sea + 5) dry++;
      }
    }
    return { name: r.name, dry: tot ? dry / tot : 0, authored: r.authored, final: r.height };
  });

  return { k: maxH / heightScaleOf(map), maxH, land: land / n, airports, sea };
}

const heightScaleOf = (map) => new Terrain(terrainOptions(map, 1))._heightScale;

console.log('地形尺度自洽性（9 张地图）\n');

const summary = [];
for (const map of MAPS) {
  const s = survey(map);
  summary.push({ id: map.id, ...s });
}

console.log('地图            k     最高m   陆地%   机场干地%');
console.log('-'.repeat(52));
for (const s of summary) {
  const ap = s.airports.map((a) => `${a.name}:${(a.dry * 100).toFixed(0)}`).join(' ') || '—';
  console.log(
    `${s.id.padEnd(14)} ${s.k.toFixed(2).padStart(5)} ${s.maxH.toFixed(0).padStart(6)} ` +
    `${(s.land * 100).toFixed(0).padStart(6)}   ${ap}`
  );
}
console.log('');

for (const s of summary) {
  t(`${s.id}: 峰高自洽 k=${s.k.toFixed(2)} ∈ [${K_MIN}, ${K_MAX}]`, () => {
    if (!(s.k >= K_MIN && s.k <= K_MAX)) {
      throw new Error(
        `k=${s.k.toFixed(2)} 越界。biome 的 ridgeAmp 与声明的 heightScale 尺度不自洽，` +
        `地图会塌成平面/浅海。请给该地图加 biomeOverrides 校正 ridgeAmp/ridgeBase。`
      );
    }
  });

  t(`${s.id}: 陆地占比 ${(s.land * 100).toFixed(0)}% >= ${LAND_MIN}%`, () => {
    if (!(s.land * 100 >= LAND_MIN)) {
      throw new Error(`陆地仅 ${(s.land * 100).toFixed(1)}%，地图几乎全是水。`);
    }
  });

  for (const a of s.airports) {
    t(`${s.id}: 机场[${a.name}] 自然干地 ${(a.dry * 100).toFixed(0)}% >= ${AIRPORT_DRY_MIN * 100}%`, () => {
      if (!(a.dry >= AIRPORT_DRY_MIN)) {
        throw new Error(
          `机场区自然干地仅 ${(a.dry * 100).toFixed(1)}%（authored=${a.authored}m，` +
          `经 _reconcileRegions 后 ${a.final.toFixed(0)}m）。说明选址落在水下低洼，` +
          `会被硬抬成人工孤岛 —— 请调整选址或校正该图形态参数。`
        );
      }
    });
  }
}

console.log(`\n地形尺度测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
