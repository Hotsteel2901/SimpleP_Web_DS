/** 回归：道路面朝上可见，跑道/桥面/斜坡可被起落架识别为平台。 */
import assert from 'node:assert/strict';
import { Aircraft } from '../src/flight/aircraft.js';
import { Landmarks } from '../src/world/landmarks.js';

function platformAt(landmarks, x, z, wheelY) {
  return Aircraft.prototype._platformAt.call({}, x, z, wheelY, { landmarks });
}

function localToWorld(x, z, heading, lx, lz) {
  const c = Math.cos(heading), s = Math.sin(heading);
  return { x: x + lx * c + lz * s, z: z - lx * s + lz * c };
}

function assertRenderable(mesh, name) {
  assert.ok(mesh?.isMesh, `${name} mesh should exist`);
  assert.equal(mesh.visible, true, `${name} should be visible`);
  const position = mesh.geometry?.getAttribute('position');
  assert.ok(position?.count > 0, `${name} should contain vertices`);
  for (let i = 0; i < Math.min(position.count, 12); i++) {
    assert.ok(Number.isFinite(position.getX(i) + position.getY(i) + position.getZ(i)), `${name} has invalid vertex`);
  }
}

// 正面材质从上方只能看到向上的三角面；同时覆盖 X/Z 两种路段方向。
{
  const lm = new Landmarks(null, { density: 0 });
  for (const [label, points] of [
    ['east-west', [[0, 0], [100, 0]]],
    ['north-south', [[0, 0], [0, 100]]],
    ['closed-track', [[0, 0], [100, 0], [100, 100], [0, 100]]],
  ]) {
    const geometry = lm.ribbonGeometry(points, 12, { altitude: 7, closed: label === 'closed-track' });
    const normals = geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) {
      assert.ok(normals.getY(i) > 0.99, `${label} road normal ${i} should face up`);
    }
    geometry.dispose();
  }
  lm.dispose();
}

// 斜向机场：runway 类碰撞体不再被平台查询排除，且返回真实沥青面高度。
{
  const heading = Math.PI / 4;
  const lm = new Landmarks(null, { seed: 11, density: 0, maxColliders: 128 });
  const airport = lm.buildAirport(2400, -1800, heading, {
    name: 'Regression airport', y: 30, length: 420, width: 38, apron: 90,
    taxiway: true,
  });
  const runway = lm.colliders.find((c) => c.name === 'Regression airport runway');
  assert.ok(runway, 'airport should register a runway collider');
  assert.ok(runway.localHalfExtents, 'rotated runway should retain local platform dimensions');
  assert.ok(runway.halfExtents.x > runway.localHalfExtents.x, 'broad phase should use rotated world bounds');
  const runwayPoint = localToWorld(airport.x, airport.z, heading, 0, 130);
  assert.equal(platformAt(lm, runwayPoint.x, runwayPoint.z, runway.surfaceY + 1), runway.surfaceY);
  const nearby = lm.queryColliders(runwayPoint.x, runwayPoint.z, 2, []);
  assert.ok(nearby.includes(runway), '空间索引应返回脚下跑道');
  assert.equal(new Set(nearby).size, nearby.length, '跨多个网格的碰撞体在查询结果中不得重复');

  const taxiway = lm.colliders.find((c) => c.name === 'Taxiway');
  assert.ok(taxiway, 'taxiway should have a collider');
  assert.equal(platformAt(lm, taxiway.center.x, taxiway.center.z, taxiway.surfaceY + 1), taxiway.surfaceY);
  lm.dispose();
}

// 斜向悬索桥：桥面与两侧斜坡都应能支撑起落架。
{
  const heading = Math.PI / 4;
  const lm = new Landmarks(null, { seed: 17, density: 0, maxColliders: 128 });
  lm.buildSuspensionBridge(0, 0, heading, {
    span: 500, side: 160, width: 30, deck: 50, towerHeight: 170,
  });
  const deck = lm.colliders.find((c) => c.name === 'Bridge deck segment');
  assert.ok(deck, 'diagonal bridge should register deck segments');
  const deckPoint = localToWorld(0, 0, heading, 0, 0);
  assert.equal(platformAt(lm, deckPoint.x, deckPoint.z, deck.surfaceY + 1), deck.surfaceY);

  const ramp = lm.colliders.find((c) => c.name === 'Bridge ramp' && Math.abs(c.surfaceSlope) > 1e-5);
  assert.ok(ramp, 'bridge approach ramps should have sloped support colliders');
  assert.equal(platformAt(lm, ramp.center.x, ramp.center.z, ramp.surfaceY + 1), ramp.surfaceY);
  lm.dispose();
}

// 建筑网格及其碰撞数据仍挂在场景根节点中。
{
  const lm = new Landmarks(null, { seed: 23, density: 0, maxColliders: 128 });
  lm.buildControlTower(500, 20, 700, 32);
  lm.buildCastle(1000, 20, 25, { size: 90, depth: 76, wallHeight: 12, ry: Math.PI / 4 });
  assertRenderable(lm.root.getObjectByName('tower_shaft'), 'control tower');
  assertRenderable(lm.root.getObjectByName('castle_walls'), 'castle walls');
  assert.ok(lm.colliders.some((c) => c.name === 'Control tower'), 'control tower should have collision');
  const walls = lm.colliders.filter((c) => c.name === 'Castle wall');
  assert.ok(walls.length >= 4, 'castle walls should have collision');
  assert.ok(walls.every((c) => c.localHalfExtents && c.quaternion), 'rotated castle walls should use oriented collision');
  lm.dispose();
}

console.log('地面/平台回归：通过');
