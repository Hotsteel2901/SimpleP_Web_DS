import * as THREE from 'three';
import { Terrain } from '../src/world/terrain.js';
import { Landmarks } from '../src/world/landmarks.js';
import { MAPS, terrainOptions, getMap } from '../src/world/maps.js';
import { Aircraft } from '../src/flight/aircraft.js';
import { stockCrafts } from '../src/build/crafts.js';
for (const id of ['archipelago','naval','boneyard','vetusta','raceway']) {
  const map = getMap(id);
  const scene = new THREE.Scene();
  const o = terrainOptions(map,0); o.segments=160;
  const terrain = new Terrain(o).build(scene);
  const lm = new Landmarks(terrain,{kit:map.kit,seed:map.id.length*7919+map.size,density:0.7,water:true}).build(scene);
  const sp = terrain.spawnPoints[0];
  const ac = new Aircraft(stockCrafts()[0],{position:sp.position.clone(),heading:sp.heading,isPlayer:true,assist:0});
  ac.placeOnGround(terrain,sp.position.x,sp.position.z,sp.heading);
  const p0 = ac.body.position.clone();
  // 沿跑道方向找出 400m 内的碰撞体
  const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0,sp.heading,0)));
  const hits = [];
  for (const c of lm.colliders) {
    if (c.sensor) continue;
    const rel = c.center.clone().sub(p0);
    const along = rel.dot(fwd);
    const lateral = rel.clone().addScaledVector(fwd,-along).length();
    if (along > -40 && along < 420 && lateral < 60) hits.push(`${c.kind}@${along.toFixed(0)}m lat${lateral.toFixed(0)} h${(c.halfExtents?.y*2||c.radius*2||0).toFixed(0)}`);
  }
  console.log(`${id}: spawn=(${p0.x.toFixed(0)},${p0.y.toFixed(0)},${p0.z.toFixed(0)}) hdg=${sp.heading.toFixed(2)} 前方障碍: ${hits.slice(0,8).join(', ') || '无'}`);
  const env={terrain,landmarks:lm,gravity:9.81,wind:new THREE.Vector3(),projectiles:null,onImpact:(a,pt,s,col)=>console.log('   撞击',col.kind,'强度',s.toFixed(1))};
  ac.inputTarget.throttle=1;
  for(let i=0;i<720;i++) ac.update(1/120,env);
  console.log(`   6s 后 位移=${ac.body.position.distanceTo(p0).toFixed(1)}m 健康=${ac.health.toFixed(2)}`);
}
