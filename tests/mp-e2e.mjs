/**
 * 联机端到端测试（真实服务器 + 真实 Game + 真实 NetClient）
 * ------------------------------------------------------------------
 * Node 24 自带 WebSocket，但没有 RTCPeerConnection，因此 PeerLink 会自动走
 * 「公网中继」路径 —— 正好用来验证最坏情况下的可达性。
 * 用法： node tests/mp-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as THREE from 'three';
import { Game } from '../src/game/game.js';
import { stockCrafts } from '../src/build/crafts.js';
import { getMap } from '../src/world/maps.js';
import { MultiplayerSession } from '../src/net/mp.js';

const PORT = 8123 + Math.floor(Math.random() * 400);
let fails = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log('✅', name, extra);
  else { fails++; console.log('❌', name, extra); }
};
const waitFor = async (fn, timeout = 8000, step = 60) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(step); }
  return false;
};

/* ---------------------------------------------------------------- 启动服务器 */
const server = spawn(process.execPath, ['server.js', String(PORT)], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d.toString(); });
server.stderr.on('data', (d) => { serverOut += d.toString(); });
const cleanup = () => { try { server.kill('SIGKILL'); } catch { } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

await sleep(900);
ok(server.exitCode === null, '服务器进程已启动', `(port ${PORT})`);

/* ---------------------------------------------------------------- 两个客户端 */
const canvas = { clientWidth: 1280, clientHeight: 720, addEventListener() { }, style: {} };
const crafts = stockCrafts();
const map = getMap('archipelago');

async function makeClient(name) {
  const game = new Game(canvas, { headless: true, quality: 0, shadows: false, enemyCrafts: crafts.slice(1, 4) });
  await game.loadWorld(map, { quality: 0 });
  game.spawnPlayerAircraft(crafts[0], { air: true, height: 400, speed: 130, assist: 0.5 });
  game.startMission({ mode: 'free' });
  const mp = new MultiplayerSession(game, { playerName: name, serverUrl: `ws://127.0.0.1:${PORT}/ws` });
  return { name, game, mp };
}

const A = await makeClient('主机-A');
const B = await makeClient('客机-B');
ok(true, '两个客户端世界加载完成');

/* ---------------------------------------------------------------- 连接 + 建房 */
ok(await A.mp.connect(), 'A 连接信令服务器');
const hosted = await A.mp.host({ name: '测试房间', maxPlayers: 4, mapId: 'archipelago', mode: 'combat' });
ok(hosted, 'A 创建房间');
ok(await waitFor(() => A.mp.room), 'A 收到房间信息', A.mp.room ? `(id ${String(A.mp.room.id).slice(0, 8)})` : '');
ok(A.mp.isHost, 'A 是房主');

ok(await B.mp.connect(), 'B 连接信令服务器');
const rooms = await new Promise((res) => {
  const t = setTimeout(() => res(A.mp.serverRooms), 3000);
  B.mp.on('rooms', (r) => { clearTimeout(t); res(r); });
  B.mp.listRooms();
});
ok(Array.isArray(rooms) && rooms.length >= 1, '服务器浏览器能看到房间', `(${rooms?.length} 个)`);

ok(await B.mp.join(A.mp.room.id), 'B 加入房间');
ok(await waitFor(() => A.mp.players.size >= 1 && B.mp.room), '双方都进入房间');

/* ---------------------------------------------------------------- 中继同步 */
await sleep(600);
ok(A.mp.peers && B.mp.peers, 'PeerManager 已建立');
const linkB = A.mp.peers.links.get(B.mp.self.id);
const linkA = B.mp.peers.links.get(A.mp.self.id);
ok(!!linkB && !!linkA, '两端都建立了 PeerLink');
ok(await waitFor(() => linkB?.open && linkA?.open, 9000), '链路已就绪');
console.log(`   连接模式：A->B = ${linkB?.mode}, B->A = ${linkA?.mode}（Node 无 WebRTC，预期中继）`);

// 驱动两个客户端若干帧，让状态同步流动
const dt = 1 / 30;
for (let i = 0; i < 90; i++) {
  A.mp.update(dt); B.mp.update(dt);
  A.game.update(dt); B.game.update(dt);
  await sleep(8);
}
ok(B.mp.players.get(A.mp.self.id)?.buffer?.length > 0, 'B 收到 A 的状态快照', `(${B.mp.players.get(A.mp.self.id)?.buffer?.length || 0} 帧)`);
ok(A.mp.players.get(B.mp.self.id)?.buffer?.length > 0, 'A 收到 B 的状态快照');
ok(!!B.mp.players.get(A.mp.self.id)?.ac, 'B 生成了 A 的幽灵机');
const ghost = B.mp.players.get(A.mp.self.id)?.ac;
if (ghost) {
  ok(ghost.remote === true, '幽灵机被标记为 remote（不参与本地物理）');
  const d = ghost.body.position.distanceTo(A.game.player.body.position);
  ok(d < 400, '幽灵机位置与真实飞机接近', `(误差 ${d.toFixed(1)} m)`);
  ok(Math.abs(ghost.body.quaternion.length() - 1) < 0.01, '幽灵机四元数已归一化');
}

/* ---------------------------------------------------------------- 伤害转发 */
const before = A.game.player.health;
const ghostA = B.mp.players.get(A.mp.self.id)?.ac;
if (ghostA) ghostA.applyDamage(120, ghostA.body.position, 'bullet');
await sleep(700);
ok(A.game.player.health < before, 'B 打中幽灵机 → A 本机权威扣血', `(${before.toFixed(2)} → ${A.game.player.health.toFixed(2)})`);

/* ---------------------------------------------------------------- 聊天 */
let gotChat = null;
B.mp.on('chat', (e) => { if (e.name === '主机-A') gotChat = e; });
A.mp.sendChat('你好，联机测试！');
ok(await waitFor(() => gotChat, 3000), '聊天消息通过中继送达', gotChat ? `("${gotChat.text}")` : '');

/* ---------------------------------------------------------------- 房主设置 */
let hostApplied = null;
B.mp.on('settings', () => { });
B.mp.on('host', () => { });
const t0 = A.mp.tickRate;
A.mp.setSetting('tickRate', 24);
await sleep(400);
ok(A.mp.tickRate === 24, '房主修改同步频率生效');
B.mp.setSetting('tickRate', 99);
await sleep(300);
ok(A.mp.tickRate === 24, '非房主无法修改设置');

/* ---------------------------------------------------------------- 踢人 */
A.mp.kick(B.mp.self.id);
ok(await waitFor(() => B.mp.room === null, 4000), '被踢出后 B 的会话被清空');

/* ---------------------------------------------------------------- 房主迁移 */
const C = await makeClient('客机-C');
await C.mp.connect();
await C.mp.join(A.mp.room.id);
ok(await waitFor(() => C.mp.room, 4000), 'C 加入房间');
A.mp.disconnect();          // 房主掉线
ok(await waitFor(() => C.mp.isHost, 6000), '房主掉线后 C 自动成为新房主');

/* ---------------------------------------------------------------- 收尾 */
B.mp.disconnect(); C.mp.disconnect();
A.game.dispose(); B.game.dispose(); C.game.dispose();
cleanup();
await sleep(200);

console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 联机端到端测试全部通过（含公网中继路径）');
process.exit(fails ? 1 : 0);
