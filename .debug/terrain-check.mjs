import { Terrain } from '../src/world/terrain.js';
import { terrainOptions, MAPS } from '../src/world/maps.js';

for (const map of MAPS) {
  const opts = terrainOptions(map, 1);
  const t = new Terrain(opts);
  // 注意：未 build 时 heightAt 走噪声直算（含平整区）
  const rows = [];
  for (const r of map.flatRegions || []) {
    // 找一块"没有平整区影响"的对照：用另一个 Terrain 实例（同样的种子但去掉平整区）
    const t2 = new Terrain({ ...opts, flatRegions: [] });
    const natural = t2.heightAt(r.x, r.z);
    const edge = t2.heightAt(r.x + r.radius, r.z);
    const edge2 = t2.heightAt(r.x - r.radius, r.z);
    const edge3 = t2.heightAt(r.x, r.z + r.radius);
    const edge4 = t2.heightAt(r.x, r.z - r.radius);
    rows.push({ name: r.name, set: r.height, natural: +natural.toFixed(1), edges: [edge, edge2, edge3, edge4].map(v => +v.toFixed(0)).join('/') });
  }
  console.log(`\n== ${map.id} (${map.name}) size=${map.size} seg=${opts.segments} biome=${map.biome}`);
  for (const r of rows) {
    const d = r.natural - r.set;
    console.log(`   ${r.name}: 设定高度=${r.set}  自然地形=${r.natural}  偏差=${d > 0 ? '+' : ''}${d.toFixed(1)}m  四周地形=[${r.edges}]`);
  }
  // 出生点
  t.build(null);
  const sps = t.spawnPoints;
  console.log('   出生点:', sps.map(s => `${s.name}(${s.position.x.toFixed(0)},${s.position.y.toFixed(0)},${s.position.z.toFixed(0)}) h=${(s.heading * 57.3).toFixed(0)}°`).join('  '));
}