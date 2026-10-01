/**
 * 联机服务器测试（零依赖）：自己实现一个最小 WebSocket 客户端，
 * 启动 server.js（随机端口），跑完大厅协议的所有关键路径。
 *
 * 用法： node tests/net-server.mjs
 * 失败时以非 0 退出码结束，并打印逐条 ✅/❌ 汇总。
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WSServer } from '../src/net/wsserver.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
/** 逐条断言：打印 ✅/❌ 并累计 */
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${extra ? '  → ' + extra : ''}`); }
}

// ── 手写的最小 WebSocket 客户端（握手 + 掩码帧 + 分片解析）───────────────────
class WSClient {
  constructor(port, tag) { this.port = port; this.tag = tag; this.messages = []; this.texts = []; this.pongs = []; this._waiters = []; this._buf = Buffer.alloc(0); this._frag = null; this.closed = false; this.closeCode = null; this.closeReason = ''; this.pings = 0; this.autoPong = false; }
  get id() { return this._id; }

  connect() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1', port: this.port, path: '/ws',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket, head) => {
        const expect = createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== expect) return reject(new Error('Sec-WebSocket-Accept 不匹配'));
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (c) => this._onData(c));
        socket.on('close', () => { this.closed = true; this._wake(); });
        socket.on('error', () => {});
        if (head && head.length) this._onData(head);
        resolve(this);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** fin=false 可发分片起始帧；mask=false 用于故意违反协议 */
  sendFrame(opcode, payload, opts = {}) {
    const { fin = true, mask = true } = opts;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
    const len = data.length;
    const maskKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    let header;
    if (len < 126) { header = Buffer.allocUnsafe(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.allocUnsafe(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    const out = [header];
    if (mask) {
      header[1] |= 0x80;
      out.push(maskKey);
      const masked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i & 3];
      out.push(masked);
    } else {
      out.push(data);
    }
    this.socket.write(Buffer.concat(out));
  }
  send(obj) { this.sendFrame(0x1, JSON.stringify(obj)); }
  sendRaw(text) { this.sendFrame(0x1, text); }
  /** 发送分片文本消息 */
  sendFragments(parts) {
    parts.forEach((part, i) => this.sendFrame(i === 0 ? 0x1 : 0x0, part, { fin: i === parts.length - 1 }));
  }
  sendClose(code = 1000, reason = '') {
    const r = Buffer.from(reason, 'utf8');
    const body = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), r]);
    this.sendFrame(0x8, body);
  }
  terminate() { try { this.socket.destroy(); } catch { /* ignore */ } }
  close() { this.terminate(); }
  /** 等待 TCP 断开 */
  waitClosed(ms = 2000) {
    if (this.closed) return Promise.resolve(true);
    return new Promise((res) => {
      const t = setTimeout(() => res(this.closed), ms);
      this.socket.once('close', () => { clearTimeout(t); res(true); });
    });
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4; // 服务端帧不应掩码，但解析到也不崩
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      this._buf = buf.subarray(off + len);

      if (opcode === 0x8) {
        if (payload.length >= 2) this.closeCode = payload.readUInt16BE(0);
        this.closeReason = payload.subarray(2).toString('utf8');
        this.closed = true; this.terminate(); return;
      }
      if (opcode === 0x9) { this.pings++; if (this.autoPong) this.sendFrame(0xa, payload); continue; }
      if (opcode === 0xa) { this.pongs.push(Buffer.from(payload)); this._wake(); continue; }
      if (opcode === 0x0) { if (this._frag) { this._frag.chunks.push(payload); this._frag.size += payload.length; if (fin) this._deliver(); } continue; }
      this._frag = { opcode, chunks: [payload], size: payload.length };
      if (fin) this._deliver();
    }
  }

  _deliver() {
    const f = this._frag; this._frag = null;
    const full = f.chunks.length === 1 ? f.chunks[0] : Buffer.concat(f.chunks, f.size);
    if (f.opcode !== 0x1) return;
    const text = full.toString('utf8');
    this.texts.push(text);
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.messages.push(msg);
    this._wake();
  }

  _wake() {
    for (const w of [...this._waiters]) {
      const hit = this.messages.findIndex(w.pred);
      if (hit >= 0) {
        const [m] = this.messages.splice(hit, 1);
        clearTimeout(w.timer);
        this._waiters.splice(this._waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  }

  /** 等待一条满足条件的消息，超时返回 null */
  waitFor(pred, label, timeoutMs = 1500) {
    const hit = this.messages.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.messages.splice(hit, 1)[0]);
    return new Promise((resolve) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this._waiters.push(w);
    });
  }
  /** 等待并断言某条消息到达 */
  async expect(pred, label, timeoutMs = 1500) {
    const m = await this.waitFor(pred, label, timeoutMs);
    check(label, !!m, m ? '' : '超时未收到消息');
    return m;
  }
}

// ── 启动真实 server.js ───────────────────────────────────────────────────────
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server.js', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (out.includes('ws://localhost:' + port + '/ws')) return { child, getOut: () => out, getErr: () => err };
    if (child.exitCode !== null) throw new Error('server.js 提前退出: ' + err);
    await sleep(50);
  }
  throw new Error('server.js 启动超时: ' + out + err);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const t0 = Date.now();
const port = await freePort();
const srv = await startServer(port);
console.log(`\n联机测试 server.js:${port}\n`);
const DEBUG_LOG = process.env.NET_TEST_DEBUG === '1';
const kids = [];
const newClient = async (tag) => {
  const c = new WSClient(port, tag);
  await c.connect();
  const w = await c.expect((m) => m.t === 'welcome', `${tag} 收到 welcome`);
  if (w) {
    c._id = w.id;
    check(`${tag} welcome.id 是非空字符串`, typeof w.id === 'string' && w.id.length > 0, String(w.id));
    check(`${tag} welcome.version 是数字`, typeof w.version === 'number');
  }
  kids.push(c);
  return c;
};

try {
  // ── A. hello / list / create ───────────────────────────────────────────────
  const c1 = await newClient('c1');
  c1.send({ t: 'hello', name: 'Alice', version: 1 });
  await sleep(80);
  check('c1 hello 不产生错误', !c1.messages.some((m) => m.t === 'error'));

  c1.send({ t: 'list' });
  const list0 = await c1.expect((m) => m.t === 'rooms', 'c1 空列表');
  check('c1 初始房间列表为空', !!list0 && Array.isArray(list0.rooms) && list0.rooms.length === 0);

  c1.send({
    t: 'create', name: 'Sky Arena', maxPlayers: 3, privacy: 'public', mapId: 'archipelago',
    mode: 'combat', playerName: 'Alice', craft: { id: 'craft-a' }, parts: { p: 1 }, tickRate: 45,
  });
  const roomA = await c1.expect((m) => m.t === 'room', 'c1 create 收到 room');
  const A = roomA?.room;
  check('create: 房间名/地图/模式正确', A?.name === 'Sky Arena' && A?.mapId === 'archipelago' && A?.mode === 'combat', JSON.stringify(A));
  check('create: 创建者是房主', roomA?.you?.isHost === true && A?.hostId === c1.id);
  check('create: 设置 tickRate 生效', A?.settings?.tickRate === 45, JSON.stringify(A?.settings));
  check('create: players 含 1 人且带 craft', roomA?.players?.length === 1 && roomA.players[0].craft?.id === 'craft-a');

  // ── B. 隐私过滤 ────────────────────────────────────────────────────────────
  const c2 = await newClient('c2');
  c2.send({ t: 'create', name: 'Hidden Base', privacy: 'private', playerName: 'Bob', maxPlayers: 4 });
  const roomB = await c2.expect((m) => m.t === 'room', 'c2 创建私有房间');
  const B = roomB?.room;

  c1.send({ t: 'list' });
  const list1 = await c1.expect((m) => m.t === 'rooms', 'c1 再取列表');
  const ids1 = (list1?.rooms || []).map((r) => r.id);
  check('list: 公开房间可见', ids1.includes(A.id));
  check('list: 他人私有房间不可见', !ids1.includes(B.id), ids1.join(','));

  c2.send({ t: 'list' });
  const list2 = await c2.expect((m) => m.t === 'rooms', 'c2 取列表');
  const ids2 = (list2?.rooms || []).map((r) => r.id);
  check('list: 自己的私有房间可见', ids2.includes(B.id));
  check('list: 房间摘要字段完整', (() => {
    const s = (list2?.rooms || []).find((r) => r.id === B.id);
    return !!s && typeof s.name === 'string' && typeof s.hostName === 'string'
      && typeof s.players === 'number' && typeof s.maxPlayers === 'number'
      && typeof s.privacy === 'string' && typeof s.locked === 'boolean' && 'ping' in s;
  })());

  c2.send({ t: 'leave' });
  await sleep(100);

  // ── C. join / peer-join / locked / room_full ───────────────────────────────
  const c3 = await newClient('c3');
  c3.send({ t: 'hello', name: 'Carol' });
  c3.send({ t: 'join', roomId: A.id, playerName: 'Carol', craft: { id: 'craft-c' }, parts: { p: 3 } });
  const r3 = await c3.expect((m) => m.t === 'room', 'c3 join 收到 room');
  check('join: 房间里有 2 名玩家', r3?.players?.length === 2, String(r3?.players?.length));
  check('join: 加入者不是房主', r3?.you?.isHost === false);

  const pj = await c1.expect((m) => m.t === 'peer-join', 'c1 收到 peer-join');
  check('peer-join: 携带新玩家信息', pj?.player?.id === c3.id && pj?.player?.name === 'Carol' && pj?.player?.craft?.id === 'craft-c');

  // 重复 join 同一房间 → peer-update（craft/parts 变更）
  c3.send({ t: 'join', roomId: A.id, craft: { id: 'craft-c2' } });
  const pu = await c1.expect((m) => m.t === 'peer-update', 'c1 收到 peer-update');
  check('peer-update: 携带新的 craft', pu?.player?.id === c3.id && pu?.player?.craft?.id === 'craft-c2', JSON.stringify(pu?.player?.craft));
  await c3.expect((m) => m.t === 'room', 'c3 重新 join 后收到 room 同步');

  // 锁房
  c1.send({ t: 'host', key: 'locked', value: true });
  await c1.expect((m) => m.t === 'host' && m.key === 'locked', 'c1 收到自身 host 广播');
  await c3.expect((m) => m.t === 'host' && m.key === 'locked', 'c3 收到 locked 广播');
  c2.send({ t: 'join', roomId: A.id, playerName: 'Bob' });
  const errLocked = await c2.expect((m) => m.t === 'error', 'c2 加入被锁房间报错');
  check('join: 锁定房间返回 locked', errLocked?.code === 'locked', errLocked?.code);

  c1.send({ t: 'host', key: 'locked', value: false });
  await c1.expect((m) => m.t === 'host' && m.key === 'locked' && m.value === false, 'c1 解锁房间');

  const c4 = await newClient('c4');
  c4.send({ t: 'join', roomId: A.id, playerName: 'Dave' });
  const room4 = await c4.expect((m) => m.t === 'room', 'c4 join 收到 room');
  check('join: 第 3 人进入后满员', room4?.players?.length === 3, String(room4?.players?.length));

  await c1.expect((m) => m.t === 'peer-join' && m.player.id === c4.id, 'c1 收到 c4 的 peer-join');
  await c3.expect((m) => m.t === 'peer-join' && m.player.id === c4.id, 'c3 收到 c4 的 peer-join');

  c2.send({ t: 'join', roomId: A.id, playerName: 'Bob' });
  const errFull = await c2.expect((m) => m.t === 'error', 'c2 加入满员房间报错');
  check('join: 满员返回 room_full', errFull?.code === 'room_full', errFull?.code);

  c2.send({ t: 'join', roomId: 'zzzzzz', playerName: 'Bob' });
  const errNF = await c2.expect((m) => m.t === 'error', 'c2 加入不存在房间报错');
  check('join: 不存在的房间返回 not_found', errNF?.code === 'not_found', errNF?.code);

  // ── D. signal / relay / chat / 坏消息 / ping ──────────────────────────────
  c1.send({ t: 'signal', to: c3.id, data: { kind: 'offer', sdp: 'v=0' } });
  const sig = await c3.expect((m) => m.t === 'signal', 'c3 收到 signal');
  check('signal: from/data 原样转发', sig?.from === c1.id && sig?.data?.kind === 'offer' && sig?.data?.sdp === 'v=0');

  c3.send({ t: 'signal', to: 'nobody', data: { kind: 'ice' } });
  const sigErr = await c3.expect((m) => m.t === 'error', 'signal 给房外玩家报错');
  check('signal: 目标不在房间返回 not_found', sigErr?.code === 'not_found', sigErr?.code);

  c1.send({ t: 'relay', to: c4.id, data: { x: 1 } });
  const rel = await c4.expect((m) => m.t === 'relay', 'c4 收到定向 relay');
  check('relay: 定向转发正确', rel?.from === c1.id && rel?.data?.x === 1);

  c3.messages.length = 0;
  c1.messages.length = 0;
  c4.messages.length = 0;
  c3.send({ t: 'relay', to: 'all', data: { y: 2 } });
  const r1 = await c1.expect((m) => m.t === 'relay', 'c1 收到 relay all');
  const r4 = await c4.expect((m) => m.t === 'relay', 'c4 收到 relay all');
  check('relay all: from/data 正确', r1?.from === c3.id && r1?.data?.y === 2 && r4?.from === c3.id);
  await sleep(100);
  check('relay all: 不回显给发送者', !c3.messages.some((m) => m.t === 'relay'));

  c3.send({ t: 'chat', text: 'hello everyone' });
  const ch1 = await c1.expect((m) => m.t === 'chat', 'c1 收到 chat');
  const ch3 = await c3.expect((m) => m.t === 'chat', 'c3 收到自己的 chat');
  const ch4 = await c4.expect((m) => m.t === 'chat', 'c4 收到 chat');
  check('chat: 广播字段 from/name/text/ts', ch1?.from === c3.id && ch1?.name === 'Carol'
    && ch1?.text === 'hello everyone' && typeof ch1?.ts === 'number'
    && ch3?.text === 'hello everyone' && ch4?.text === 'hello everyone');

  c1.sendRaw('{ this is not json');
  const bad1 = await c1.expect((m) => m.t === 'error', 'c1 非 JSON 报错');
  check('bad_message: 非 JSON 返回 bad_message', bad1?.code === 'bad_message', bad1?.code);
  c1.send({ t: 'definitely-unknown' });
  const bad2 = await c1.expect((m) => m.t === 'error', 'c1 未知类型报错');
  check('bad_message: 未知 t 返回 bad_message', bad2?.code === 'bad_message', bad2?.code);

  c1.send({ t: 'ping', ts: 777 });
  const pong = await c1.expect((m) => m.t === 'pong', 'c1 收到 pong');
  check('ping/pong: ts 回显且带人数', pong?.ts === 777 && pong?.players === 3, JSON.stringify(pong));

  // ── E. 房主权限 ────────────────────────────────────────────────────────────
  c3.send({ t: 'kick', playerId: c4.id });
  const noHostKick = await c3.expect((m) => m.t === 'error', '非房主 kick 被拒绝');
  check('host-only: 非房主 kick → not_host', noHostKick?.code === 'not_host', noHostKick?.code);

  c3.send({ t: 'host', key: 'tickRate', value: 60 });
  const noHostSet = await c3.expect((m) => m.t === 'error', '非房主改设置被拒绝');
  check('host-only: 非房主 host → not_host', noHostSet?.code === 'not_host', noHostSet?.code);

  c1.send({ t: 'host', key: 'tickRate', value: 60 });
  const hset = await c3.expect((m) => m.t === 'host' && m.key === 'tickRate', 'c3 收到设置广播');
  check('host: 设置广播 from/key/value 正确', hset?.from === c1.id && hset?.value === 60, JSON.stringify(hset));

  // ── F. kick ────────────────────────────────────────────────────────────────
  c1.send({ t: 'kick', playerId: c4.id, reason: 'afk' });
  const kicked = await c4.expect((m) => m.t === 'kicked', 'c4 收到 kicked');
  check('kick: 被踢者收到 kicked(by/reason)', kicked?.by === c1.id && kicked?.reason === 'afk');
  const pl4 = await c3.expect((m) => m.t === 'peer-leave' && m.playerId === c4.id, 'c3 收到 c4 的 peer-leave');
  check('kick: peer-leave 原因正确', pl4?.reason === 'kicked', pl4?.reason);
  await c1.expect((m) => m.t === 'peer-leave' && m.playerId === c4.id, 'c1 收到 c4 的 peer-leave');

  // ── G. 主机迁移 ────────────────────────────────────────────────────────────
  c1.terminate(); // 房主断线
  const pl1 = await c3.expect((m) => m.t === 'peer-leave' && m.playerId === c1.id, 'c3 收到房主 peer-leave', 2500);
  check('主机迁移: 房主断线以 disconnect 广播', pl1?.reason === 'disconnect', pl1?.reason);
  const migrated = await c3.expect((m) => m.t === 'room', 'c3 收到迁移后的 room', 2500);
  check('主机迁移: 最老玩家成为新房主', migrated?.you?.isHost === true && migrated?.room?.hostId === c3.id, JSON.stringify(migrated?.you));
  check('主机迁移: 房间只剩 1 人', migrated?.players?.length === 1, String(migrated?.players?.length));

  c3.send({ t: 'host', key: 'weather', value: 'storm' });
  const hAfter = await c3.expect((m) => m.t === 'host' && m.key === 'weather', '新房主可以改设置');
  check('主机迁移: 新主机拥有房主权限', hAfter?.value === 'storm', JSON.stringify(hAfter));

  c3.send({ t: 'list' });
  const list3 = await c3.expect((m) => m.t === 'rooms', 'c3 取列表');
  check('list: 迁移后房间仍在列表中', (list3?.rooms || []).some((r) => r.id === A.id && r.players === 1));

  // ── H. parts 体积限制 ──────────────────────────────────────────────────────
  c2.send({ t: 'create', name: 'TooBig', privacy: 'private', playerName: 'Bob', parts: { blob: 'a'.repeat(300 * 1024) } });
  const bigErr = await c2.expect((m) => m.t === 'error', '300KB parts 被拒绝', 2500);
  check('parts: 300KB 返回 parts_too_large', bigErr?.code === 'parts_too_large', bigErr?.code);

  const okBlob = 'b'.repeat(100 * 1024);
  c2.send({ t: 'create', name: 'Ok', privacy: 'private', playerName: 'Bob', parts: { blob: okBlob } });
  const okRoom = await c2.expect((m) => m.t === 'room', '100KB parts 被接受', 2500);
  check('parts: 100KB 被接受且原样保存', okRoom?.players?.[0]?.parts?.blob?.length === okBlob.length,
    String(okRoom?.players?.[0]?.parts?.blob?.length));
  // 300KB 的请求应该只报错、不建房：用列表确认不存在名为 TooBig 的公开房间也不影响私有房
  c2.send({ t: 'list' });
  const listBig = await c2.expect((m) => m.t === 'rooms', 'c2 校验超限请求未建房');
  check('parts: 超限请求未创建房间', !(listBig?.rooms || []).some((r) => r.name === 'TooBig'));

  // ── I. 最后一人离开 → 删除房间 ─────────────────────────────────────────────
  const okId = okRoom?.room?.id;
  c2.send({ t: 'leave' });
  await sleep(150);
  c2.send({ t: 'list' });
  const list4 = await c2.expect((m) => m.t === 'rooms', 'c2 离开后取列表');
  const ids4 = (list4?.rooms || []).map((r) => r.id);
  check('房间删除: 最后一人离开后私有房间消失', !ids4.includes(okId), ids4.join(','));
  check('房间删除: 仍能看到他人的公开房间', ids4.includes(A.id), ids4.join(','));

  c3.send({ t: 'leave' });
  await sleep(150);
  c2.send({ t: 'list' });
  const list5 = await c2.expect((m) => m.t === 'rooms', 'c3 离开后取列表');
  check('房间删除: 最后一个房间被清理', (list5?.rooms || []).length === 0, JSON.stringify(list5?.rooms));

  // ── J. 服务器依然健在 ──────────────────────────────────────────────────────
  const c5 = await newClient('c5');
  c5.send({ t: 'ping', ts: 1 });
  const pong5 = await c5.expect((m) => m.t === 'pong', 'c5 仍可正常通信');
  check('健壮性: 各类坏消息后服务器仍可服务', pong5?.players === 0);

  const out = srv.getOut();
  check('日志: 打印了创建/加入/离开事件', out.includes('创建房间') && out.includes('加入房间') && out.includes('离开房间'));
  check('日志: 打印了主机迁移', out.includes('主机迁移'));
  check('stderr 无异常输出', srv.getErr().trim() === '', srv.getErr().slice(0, 200));

  // ── J2. hello 显示名 + 限速 ────────────────────────────────────────────────
  const c6 = await newClient('c6');
  c6.send({ t: 'hello', name: 'Eve' });
  c6.send({ t: 'create', name: 'EveRoom', privacy: 'private' });
  const eveRoom = await c6.expect((m) => m.t === 'room', 'c6 建房');
  check('hello: 显示名成为默认玩家名', eveRoom?.you?.name === 'Eve', JSON.stringify(eveRoom?.you));

  c6.messages.length = 0;
  for (let i = 0; i < 400; i++) c6.send({ t: 'ping', ts: i });
  await sleep(800);
  const pongs = c6.messages.filter((m) => m.t === 'pong').length;
  check('限速: 约 160 条/秒之外的请求被丢弃', pongs >= 100 && pongs < 400, `pong=${pongs}`);
  check('限速: 服务器打印了限速警告', srv.getOut().includes('消息速率超过'));
  c6.terminate();

  // ── K. 原始 RFC6455 细节（用进程内 WSServer，配小 maxPayload / 快心跳）────
  const http2 = http.createServer((req, res) => res.writeHead(404).end());
  const wss2 = new WSServer({ maxPayload: 1024, heartbeatMs: 200 });
  wss2.on('connection', (ws) => { ws.on('message', (m) => ws.send(JSON.stringify({ echo: m }))); });
  http2.on('upgrade', (req, socket, head) => { wss2.handleUpgrade(req, socket, head); });
  await new Promise((r) => http2.listen(0, '127.0.0.1', r));
  const p2 = http2.address().port;
  const raw = async (tag) => { const c = new WSClient(p2, tag); await c.connect(); return c; };

  // 分片文本
  const f1 = await raw('frag');
  f1.sendFragments(['he', 'll', 'o 分片']);
  await sleep(120);
  check('RFC6455: 分片文本帧正确重组', f1.texts.some((t) => t.includes('hello 分片')), JSON.stringify(f1.texts));
  f1.sendClose();
  await sleep(100);
  check('RFC6455: 客户端 close 帧被回显', f1.closeCode === 1000, String(f1.closeCode));
  f1.terminate();

  // ping → pong
  const pg = await raw('ping');
  pg.sendFrame(0x9, Buffer.from('hb'));
  await sleep(120);
  check('RFC6455: ping 收到同载荷 pong', pg.pongs.length === 1 && pg.pongs[0].toString() === 'hb', JSON.stringify(pg.pongs.map((b) => b.toString())));
  pg.terminate();

  // 未掩码的客户端帧 → 1002
  const nm = await raw('nomask');
  nm.sendFrame(0x1, 'bad', { mask: false });
  const nmClosed = await nm.waitClosed(1500);
  check('RFC6455: 未掩码客户端帧被拒 (1002)', nmClosed && nm.closeCode === 1002, `closed=${nmClosed} code=${nm.closeCode}`);
  nm.terminate();

  // 非法 UTF-8 文本帧 → 1007
  const u8 = await raw('badutf8');
  u8.sendFrame(0x1, Buffer.from([0x68, 0x69, 0xff, 0xfe]));
  const u8Closed = await u8.waitClosed(1500);
  check('RFC6455: 非法 UTF-8 被拒 (1007)', u8Closed && u8.closeCode === 1007, `closed=${u8Closed} code=${u8.closeCode}`);
  u8.terminate();

  // 超过 maxPayload(1024) → 1009
  const big = await raw('toobig');
  big.sendFrame(0x1, 'x'.repeat(2048));
  const bigClosed = await big.waitClosed(1500);
  check('RFC6455: 超过 maxPayload 被拒 (1009)', bigClosed && big.closeCode === 1009, `closed=${bigClosed} code=${big.closeCode}`);
  big.terminate();

  // 心跳：客户端收到服务端 ping，沉默不应答则被服务端断开
  const silent = await raw('silent');
  await sleep(1300);
  check('RFC6455: 服务端按 heartbeatMs 发送 ping', silent.pings >= 1, String(silent.pings));
  check('RFC6455: 心跳无响应连接被终止', silent.closed === true || silent.closeCode !== null, `closed=${silent.closed} code=${silent.closeCode}`);
  silent.terminate();

  // 会回 pong 的客户端应存活超过多个心跳周期
  const alive = await raw('alive');
  alive.autoPong = true;
  await sleep(1300);
  check('RFC6455: 正常回 pong 的连接保持存活', !alive.closed && alive.pings >= 2, `closed=${alive.closed} pings=${alive.pings}`);

  // 服务端不掩码：客户端解析器对 masked 标志为 false 的帧正常工作
  alive.send({ t: 'probe' });
  await sleep(120);
  check('RFC6455: 服务端帧不掩码（客户端可解析）', alive.texts.some((t) => t.includes('probe')), JSON.stringify(alive.texts));
  alive.terminate();

  // 非法握手：版本错误 → 400 且 handleUpgrade 返回 false
  const badHandshake = await new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: p2, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'x', 'Sec-WebSocket-Version': '8' } });
    r.on('response', (resp) => { resp.resume(); res(resp.statusCode); });
    r.on('upgrade', () => res('upgraded'));
    r.on('error', () => res('error'));
    r.end();
  });
  check('握手: Sec-WebSocket-Version 非 13 被拒 (400)', badHandshake === 400, String(badHandshake));

  wss2.close();
  await new Promise((r) => http2.close(r));
} catch (e) {
  fail++;
  console.log('❌ 测试流程异常中断:', e?.stack || e);
} finally {
  for (const c of kids) c.terminate();
  srv.child.kill('SIGKILL');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败  (${Date.now() - t0} ms)`);
if (fail > 0 || DEBUG_LOG) {
  console.log('\n--- server.js stdout ---\n' + srv.getOut());
  const e = srv.getErr();
  if (e.trim()) console.log('--- server.js stderr ---\n' + e);
}
console.log();
process.exit(fail ? 1 : 0);
