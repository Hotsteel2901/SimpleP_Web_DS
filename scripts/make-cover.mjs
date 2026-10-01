/**
 * 程序化生成作品封面 scripts/../media/cover.png
 * ------------------------------------------------------------------
 * 不使用任何第三方图像服务或字体：直接调用本作品自己的世界生成器（terrain.heightAt）
 * 做一次高度场光线步进，再把本作品真实的飞机模型（buildCraftVisual 产出的三角面）
 * 用软件光栅化画上去。所以这张封面就是“用游戏自己的数据渲染出来的截图”。
 *
 * 用法： node scripts/make-cover.mjs [宽] [高]
 */
import * as THREE from 'three';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Terrain } from '../src/world/terrain.js';
import { getMap, terrainOptions } from '../src/world/maps.js';
import { stockCrafts } from '../src/build/crafts.js';
import { buildCraftVisual } from '../src/flight/aircraft.js';

const W = Number(process.argv[2] || 1600);
const H = Number(process.argv[3] || 900);
const OUT = resolve(new URL('../media/cover.png', import.meta.url).pathname);

/* ------------------------------------------------------------------ PNG */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(file, rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  return png.length;
}

/* ------------------------------------------------------------------ 画布 */
const img = Buffer.alloc(W * H * 3);
const put = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = Math.max(0, Math.min(255, r | 0));
  img[i + 1] = Math.max(0, Math.min(255, g | 0));
  img[i + 2] = Math.max(0, Math.min(255, b | 0));
};
const get = (x, y) => { const i = (y * W + x) * 3; return [img[i], img[i + 1], img[i + 2]]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ------------------------------------------------------------------ 世界 */
const map = getMap('archipelago');
const opts = terrainOptions(map, 0);
opts.segments = 96;
const terrain = new Terrain(opts);   // 不 build()：只取 heightAt 采样
const seaLevel = opts.seaLevel ?? 0;

/* ------------------------------------------------------------------ 取景：自动寻找最高峰 */
const size = opts.size || 16000;
let peak = { x: 0, z: 0, h: -1e9 };
for (let i = 0; i < 90; i++) {
  for (let j = 0; j < 90; j++) {
    const px = (i / 89 - 0.5) * size * 0.86, pz = (j / 89 - 0.5) * size * 0.86;
    const h = terrain.heightAt(px, pz);
    if (h > peak.h) { peak = { x: px, z: pz, h }; }
  }
}
// 海平面附近再找一个机场/低地作为前景
let flat = { x: peak.x, z: peak.z + 2600, h: 0 };
{
  let best = 1e9;
  for (let i = 0; i < 60; i++) {
    for (let j = 0; j < 60; j++) {
      const px = (i / 59 - 0.5) * size * 0.5, pz = (j / 59 - 0.5) * size * 0.5;
      const h = terrain.heightAt(px, pz);
      const d = Math.hypot(px - peak.x, pz - peak.z);
      if (d > 1800 && d < 5200 && h > seaLevel + 8 && h < seaLevel + 160) {
        const score = Math.abs(h - (seaLevel + 40)) + Math.abs(d - 3300) * 0.05;
        if (score < best) { best = score; flat = { x: px, z: pz, h }; }
      }
    }
  }
}

/* ------------------------------------------------------------------ 相机 */
// 站在前景低地上空回头望主峰，构图更有纵深
const camPos = new THREE.Vector3(
  flat.x - (peak.x - flat.x) * 0.12, seaLevel + 240 + peak.h * 0.10, flat.z - (peak.z - flat.z) * 0.12);
const camTarget = new THREE.Vector3(peak.x, peak.h * 0.55 + seaLevel, peak.z);
console.log(`   取景：主峰 (${peak.x.toFixed(0)}, ${peak.h.toFixed(0)}, ${peak.z.toFixed(0)})  前景 (${flat.x.toFixed(0)}, ${flat.h.toFixed(0)}, ${flat.z.toFixed(0)})`);
const fov = 58 * Math.PI / 180;
const forward = camTarget.clone().sub(camPos).normalize();
const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
const up = new THREE.Vector3().crossVectors(right, forward).normalize();
const tanHalf = Math.tan(fov / 2);
const aspect = W / H;

function rayDir(px, py) {
  const ndcX = (px / W) * 2 - 1;
  const ndcY = 1 - (py / H) * 2;
  return new THREE.Vector3()
    .addScaledVector(right, ndcX * tanHalf * aspect)
    .addScaledVector(up, ndcY * tanHalf)
    .add(forward).normalize();
}
function project(v) {                      // 世界点 -> 屏幕
  const rel = v.clone().sub(camPos);
  const z = rel.dot(forward);
  if (z < 1) return null;
  const sx = rel.dot(right) / (z * tanHalf * aspect);
  const sy = rel.dot(up) / (z * tanHalf);
  return { x: (sx * 0.5 + 0.5) * W, y: (0.5 - sy * 0.5) * H, z };
}

/* ------------------------------------------------------------------ 太阳 */
// 把太阳放在镜头前方，保证画面里可见
const sunDir = forward.clone().addScaledVector(right, 0.46).addScaledVector(up, 0.30).normalize();
const sunScreen = project(camPos.clone().addScaledVector(sunDir, 8000));

/* ------------------------------------------------------------------ 天空 + 海 */
const skyTop = [22, 56, 124], skyHorizon = [186, 220, 244];
const hazeCol = [178, 205, 226];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = rayDir(x, y);
    const t = Math.max(0, Math.min(1, d.y * 2.4 + 0.12));
    let c = mix(skyHorizon, skyTop, Math.pow(t, 0.8));
    const sd = Math.max(0, d.dot(sunDir));
    c = [c[0] + Math.pow(sd, 420) * 620 + Math.pow(sd, 26) * 60 + Math.pow(sd, 5) * 16,
         c[1] + Math.pow(sd, 420) * 560 + Math.pow(sd, 26) * 52 + Math.pow(sd, 5) * 14,
         c[2] + Math.pow(sd, 420) * 430 + Math.pow(sd, 26) * 34 + Math.pow(sd, 5) * 8];
    // 云：投影到水平面做噪声，形成一条横向云带（避免垂直光斑）
    const inv = 1 / Math.max(0.10, d.y);
    const u = d.x * inv, v = d.z * inv;
    const n = Math.sin(u * 0.55) * 0.5 + Math.sin(u * 1.9 + v * 0.7 + 1.7) * 0.30
            + Math.sin(v * 1.3 - u * 0.4 + 3.1) * 0.22;
    const band = Math.max(0, Math.min(1, (d.y - 0.045) * 7)) * Math.max(0, Math.min(1, (0.42 - d.y) * 5));
    const cloud = Math.max(0, n - 0.30) * 2.2 * band;
    if (cloud > 0) c = mix(c, [255, 252, 248], Math.min(0.85, cloud));
    put(x, y, c[0], c[1], c[2]);
  }
}

/* ------------------------------------------------------------------ 地形（逐列 voxel-space 步进） */
const beach = [226, 210, 168], grass = [104, 152, 86], forest = [48, 92, 56],
  rock = [124, 118, 108], snow = [244, 248, 252];
const waterShallow = [56, 122, 160], waterDeep = [16, 46, 82];
const H2 = H / 2;
// 地平线所在行（相机有俯角时在地平线以上）
let horizonRow = Math.round(H2);
for (let y = 0; y < H; y++) { if (rayDir(W * 0.5, y).y <= 0) { horizonRow = y; break; } }

const dirH = new THREE.Vector3();
const tanAspect = tanHalf * aspect;
for (let x = 0; x < W; x++) {
  const ndcX = (x / W) * 2 - 1;
  // 水平方向：把 forward 绕 Y 轴偏转（等价于该列中心的水平射线）
  dirH.set(forward.x + right.x * ndcX * tanAspect, 0, forward.z + right.z * ndcX * tanAspect);
  if (dirH.lengthSq() < 1e-9) continue;
  dirH.normalize();
  let bottom = H;
  let t = 24;
  while (t < 15000 && bottom > 1) {
    const wx = camPos.x + dirH.x * t, wz = camPos.z + dirH.z * t;
    let h = terrain.heightAt(wx, wz);
    const isWater = h <= seaLevel;
    if (isWater) h = seaLevel;
    // 该距离处地表在屏幕上的行（经典 voxel-space 高度投影）
    const sy = Math.round(horizonRow + ((camPos.y - h) / t) / tanHalf * H2);
    if (sy < bottom) {
      const from = Math.max(0, sy);
      const to = Math.min(H - 1, bottom - 1);
      if (to >= from) {
        let c;
        if (isWater) {
          const dpt = Math.min(1, t / 6000);
          c = mix(waterShallow, waterDeep, dpt);
          if (sunScreen) {
            const gl = Math.max(0, 1 - Math.abs(x - sunScreen.x) / (W * 0.10)) * Math.max(0, 1 - Math.abs(sy - sunScreen.y) / (H * 0.05));
            c = [c[0] + gl * 130, c[1] + gl * 120, c[2] + gl * 90];
          }
        } else {
          const hs = h - seaLevel;
          if (hs < 4) c = beach;
          else if (hs < 130) c = mix(grass, forest, Math.min(1, hs / 130));
          else if (hs < 400) c = mix(forest, rock, Math.min(1, (hs - 130) / 270));
          else c = mix(rock, snow, Math.min(1, (hs - 400) / 240));
          // 简易坡向光照：比较前后采样高度
          const h2 = terrain.heightAt(camPos.x + dirH.x * (t + 40), camPos.z + dirH.z * (t + 40));
          const slope = (h2 - h) / 40;
          const lit = 0.80 + 0.30 * Math.max(-1, Math.min(1, -slope)) + 0.10 * Math.max(0, Math.min(1, (h - seaLevel) / 500));
          c = [c[0] * lit, c[1] * lit, c[2] * lit];
        }
        const fog = Math.min(0.70, Math.pow(t / 11000, 0.9));
        c = mix(c, hazeCol, fog);
        const span = Math.max(1, bottom - from);
        for (let y = from; y <= to; y++) {
          const f = (y - from) / span;                 // 靠近镜头 -> 稍亮，形成纵深
          const k = 1 + 0.10 * f;
          put(x, y, c[0] * k, c[1] * k, c[2] * k);
        }
        bottom = from;
      }
    }
    t += Math.max(9, t * 0.012);   // 自适应步长
  }
}

/* ------------------------------------------------------------------ 飞机（真实模型软件光栅化） */
const craft = stockCrafts()[0];
const vis = buildCraftVisual(craft, { shadows: false });
const tris = [];
vis.group.updateMatrixWorld(true);
vis.group.traverse((o) => {
  if (!o.isMesh || !o.geometry) return;
  const g = o.geometry;
  const pos = g.attributes.position;
  if (!pos) return;
  const idx = g.index;
  const col = (o.material && o.material.color) ? o.material.color : new THREE.Color(0xc9d3dd);
  const gp = (i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    tris.push({ a: gp(idx ? idx.getX(i) : i), b: gp(idx ? idx.getX(i + 1) : i + 1), c: gp(idx ? idx.getX(i + 2) : i + 2), col });
  }
});

// 摆位：镜头右前方、略微侧倾俯冲
const planePos = camPos.clone().addScaledVector(forward, 92).addScaledVector(right, 17).addScaledVector(up, 9);
const planeRot = new THREE.Euler(-0.10, Math.atan2(-forward.x, -forward.z) + 0.62, 0.42, 'YXZ');
const m4 = new THREE.Matrix4().makeRotationFromEuler(planeRot).setPosition(planePos);
for (const t of tris) { t.a.applyMatrix4(m4); t.b.applyMatrix4(m4); t.c.applyMatrix4(m4); }

const drawTris = [];
for (const t of tris) {
  const A = project(t.a), B = project(t.b), C = project(t.c);
  if (!A || !B || !C) continue;
  const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
  if (Math.abs(area) < 0.5) continue;
  const e1 = t.b.clone().sub(t.a), e2 = t.c.clone().sub(t.a);
  const nrm = new THREE.Vector3().crossVectors(e1, e2).normalize();
  const lam = 0.30 + 0.70 * Math.max(0, nrm.dot(sunDir));
  const amb = 0.34 + 0.16 * Math.max(0, nrm.y);
  const k = Math.min(1.3, lam + amb);
  drawTris.push({
    A, B, C, z: (A.z + B.z + C.z) / 3,
    col: [Math.min(255, t.col.r * 262 * k), Math.min(255, t.col.g * 262 * k), Math.min(255, t.col.b * 262 * k)],
  });
}
drawTris.sort((p, q) => q.z - p.z);
for (const t of drawTris) {
  const minX = Math.max(0, Math.floor(Math.min(t.A.x, t.B.x, t.C.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(t.A.x, t.B.x, t.C.x)));
  const minY = Math.max(0, Math.floor(Math.min(t.A.y, t.B.y, t.C.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(t.A.y, t.B.y, t.C.y)));
  const d = (t.B.y - t.C.y) * (t.A.x - t.C.x) + (t.C.x - t.B.x) * (t.A.y - t.C.y);
  if (Math.abs(d) < 1e-6) continue;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w1 = ((t.B.y - t.C.y) * (x - t.C.x) + (t.C.x - t.B.x) * (y - t.C.y)) / d;
      const w2 = ((t.C.y - t.A.y) * (x - t.C.x) + (t.A.x - t.C.x) * (y - t.C.y)) / d;
      const w3 = 1 - w1 - w2;
      if (w1 < -0.002 || w2 < -0.002 || w3 < -0.002) continue;
      put(x, y, t.col[0], t.col[1], t.col[2]);
    }
  }
}

/* ------------------------------------------------------------------ 后处理：暗角 + 轻微颗粒 */
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2;
    const v = 1 - 0.34 * Math.min(1, (dx * dx + dy * dy) * 0.85);
    const i = (y * W + x) * 3;
    const grain = ((x * 12.9898 + y * 78.233) % 1) * 6 - 3;
    img[i] = Math.max(0, Math.min(255, img[i] * v + grain));
    img[i + 1] = Math.max(0, Math.min(255, img[i + 1] * v + grain));
    img[i + 2] = Math.max(0, Math.min(255, img[i + 2] * v + grain));
  }
}

const bytes = writePng(OUT, img, W, H);
console.log(`✅ 封面已生成：${OUT}  ${W}x${H}  ${(bytes / 1024).toFixed(0)} KiB`);
console.log(`   用法：vibehub deploy --cover media/cover.png （媒体必须位于部署目录内）`);
