/**
 * 集成冒烟测试：真实地形 + 地标 + 飞机 + 武器，在 Node 下跑物理（无 WebGL）。
 * 用法： node tests/integration.mjs [mapId] [kit]
 */
import * as THREE from 'three';
import { Terrain } from '../src/world/terrain.js';
import { Landmarks } from '../src/world/landmarks.js';
import { Aircraft, computeCraftStats } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';
import { MAPS, terrainOptions, getMap } from '../src/world/maps.js';

const onlyMap = process.argv[2];
const t0 = Date.now();
const maps = onlyMap ? [getMap(onlyMap)] : MAPS;
let failures = 0;

for (const map of maps) {
  const tag = `${map.id}(${map.kit})`;
  try {
    const scene = new THREE.Scene();
    const opts = terrainOptions(map, 0);      // 低分辨率加速
    opts.segments = Math.min(opts.segments, 160);
    const terrain = new Terrain(opts).build(scene);
    const sps = terrain.spawnPoints;
    if (!sps.length) throw new Error('没有出生点');
    const sp = sps[0];
    const lm = new Landmarks(terrain, { kit: map.kit, seed: map.size + map.id.length, density: 0.4, water: map.water !== false }).build(scene);
    const cols = lm.colliders;
    const solid = cols.filter((c) => !c.sensor);
    if (solid.length > 800) throw new Error(`碰撞体过多: ${solid.length}`);

    // 出生点是否在地面之上（不在水里）
    const gy = terrain.heightAt(sp.position.x, sp.position.z);
    const onWater = terrain.isWater(sp.position.x, sp.position.z);

    // 放一架飞机，跑 6 秒物理
    const craft = stockCrafts()[0];
    const ac = new Aircraft(craft, { position: sp.position.clone(), heading: sp.heading, isPlayer: true, assist: 0.5 });
    ac.placeOnGround(terrain, sp.position.x, sp.position.z, sp.heading);
    ac.inputTarget.throttle = 1;
    const env = { terrain, landmarks: lm, gravity: 9.81, wind: new THREE.Vector3(), projectiles: null, targets: [] };
    const dt = 1 / 120;
    let nan = false, maxPen = 0;
    for (let i = 0; i < 720; i++) {
      ac.update(dt, env);
      if (Number.isNaN(ac.body.position.x + ac.body.position.y + ac.body.position.z)) { nan = true; break; }
      const agl = ac.body.position.y - terrain.heightAt(ac.body.position.x, ac.body.position.z);
      maxPen = Math.min(maxPen, agl);
    }

    const rings = lm.raceRings.length, items = lm.collectibles.length, anch = Object.keys(lm.anchors).length;
    const ok = !nan && solid.length > 0 && rings + items > 0;
    if (!ok) failures++;
    console.log(`${ok ? '✅' : '❌'} ${tag.padEnd(26)} 三角≈${((terrain.mesh?.geometry?.index?.count ?? 0) / 3 | 0)} 碰撞体${String(solid.length).padStart(4)} 传感器${String(cols.length - solid.length).padStart(3)} 光环${String(rings).padStart(3)} 收集物${String(items).padStart(3)} 锚点${anch} 出生${onWater ? '水面' : '陆地'}@${gy.toFixed(0)}m 6秒后高度${(ac.body.position.y - gy).toFixed(1)}m 最低AGL${maxPen.toFixed(1)}m 健康${ac.health.toFixed(2)}${nan ? ' NaN!' : ''}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${tag}: ${e.message}`);
    console.log('   ', e.stack?.split('\n').slice(1, 4).join('\n    '));
  }
}

console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
