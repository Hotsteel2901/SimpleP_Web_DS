/**
 * 零依赖 WebSocket（RFC 6455）服务器 + 游戏大厅/中继层
 *
 * 本文件只使用 Node 内置模块（node:crypto / node:buffer），
 * 不引入任何 npm 依赖，也不 import 游戏 src/ 下的任何模块
 * （浏览器绝不能加载本文件，它只能在 Node 端运行）。
 *
 * 用法：
 *   import { WSServer, LobbyServer } from './src/net/wsserver.js';
 *   const wss = new WSServer({ maxPayload: 512 * 1024, heartbeatMs: 30000 });
 *   const lobby = new LobbyServer().attach(wss);
 *   httpServer.on('upgrade', (req, socket, head) => {
 *     if (!wss.handleUpgrade(req, socket, head)) { ... }
 *   });
 */

import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** RFC 6455 规定的握手魔术字符串 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 协议版本号（server → client 的 welcome.version） */
export const NET_VERSION = 1;

// ── 帧操作码 ────────────────────────────────────────────────────────────────
const OP_CONT = 0x0;   // 续帧
const OP_TEXT = 0x1;   // 文本
const OP_BIN = 0x2;    // 二进制
const OP_CLOSE = 0x8;  // 关闭
const OP_PING = 0x9;   // ping
const OP_PONG = 0xa;   // pong

// ── 关闭码 ──────────────────────────────────────────────────────────────────
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_BAD_UTF8 = 1007;
const CLOSE_TOO_BIG = 1009;

/** 极简事件发射器（避免依赖 node:events，保持零依赖风格） */
class Emitter {
  constructor() { this._handlers = new Map(); }
  on(event, fn) {
    if (typeof fn !== 'function') return this;
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  }
  off(event, fn) {
    const list = this._handlers.get(event);
    if (!list) return this;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }
  emit(event, ...args) {
    const list = this._handlers.get(event);
    if (!list) return;
    for (const fn of list.slice()) {
      try { fn(...args); } catch (e) { /* 监听器异常不能拖垮服务器 */ console.error('[wss] 监听器异常:', e?.message || e); }
    }
  }
}

/** 校验一段 Buffer 是否是合法的 UTF-8（RFC 6455 要求文本帧必须是） */
function isValidUtf8(buf) {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let need = 0, min = 0, cp = 0;
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
    else return false;
    if (i + need >= n) return false; // 后续字节没收全 → 非法
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min) return false;                       // 过长编码
    if (cp > 0x10ffff) return false;
    if (cp >= 0xd800 && cp <= 0xdfff) return false;   // 代理区
    i += need + 1;
  }
  return true;
}

/** 编码一个服务端 → 客户端的帧（服务端帧一律不掩码） */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1，无扩展/无 RSV
  return Buffer.concat([header, data]);
}

/**
 * 单个 WebSocket 连接的封装。
 * 对外暴露：id / data / send() / close() / on('message'|'close'|'error')
 */
class WSSocket extends Emitter {
  constructor(server, raw, req) {
    super();
    this._server = server;
    this._socket = raw;
    this._buf = Buffer.alloc(0);
    this._frag = null;                 // 分片重组状态
    this._closed = false;              // 是否已发出/收到 close
    this._ended = false;               // 是否已触发 close 事件
    this._closeSent = false;
    this.isAlive = true;
    this.id = randomBytes(8).toString('hex');
    this.data = {};                    // 用户自由状态（LobbyServer 用）
    this.remoteAddress = raw.remoteAddress || '';
    this.url = req?.url || '';
    this.openedAt = Date.now();

    raw.on('data', (chunk) => this._onData(chunk));
    raw.on('error', (err) => {
      this.emit('error', err);
      this._finalize();
    });
    // 注意：upgrade 之后的 socket 是半开状态，对端发 FIN 只会触发 'end'，
    // 不主动 destroy 的话永远等不到 'close'。这里把 'end' 也当作断开处理。
    raw.on('end', () => {
      this._finalize();
      try { raw.destroy(); } catch { /* ignore */ }
    });
    raw.on('close', () => this._finalize());
  }

  get isOpen() { return !this._closed && !this._ended && this._socket.writable !== false; }

  /** 发送 JSON 对象或字符串（文本帧） */
  send(obj) {
    if (!this.isOpen) return false;
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return this._write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  /** 发送二进制帧（本游戏的协议不使用，但保留通用能力） */
  sendBinary(buf) {
    if (!this.isOpen) return false;
    return this._write(encodeFrame(OP_BIN, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)));
  }

  /** 发送 ping */
  ping(payload = Buffer.alloc(0)) {
    if (!this.isOpen) return false;
    return this._write(encodeFrame(OP_PING, payload));
  }

  /** 正常关闭：发 close 帧后结束 TCP 连接 */
  close(code = CLOSE_NORMAL, reason = '') {
    if (this._closeSent || this._ended) return;
    this._closeSent = true;
    const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const body = Buffer.allocUnsafe(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this._write(encodeFrame(OP_CLOSE, body));
    try { this._socket.end(); } catch { /* ignore */ }
  }

  /** 强制断开（不发 close 帧） */
  terminate() {
    try { this._socket.destroy(); } catch { /* ignore */ }
    this._finalize();
  }

  _write(buf) {
    if (!this._socket.writable) return false;
    try { this._socket.write(buf); return true; }
    catch (e) { this.emit('error', e); this.terminate(); return false; }
  }

  _fail(code, reason) {
    // 违规输入：记录日志并关闭这条连接，绝不影响其它连接
    this._server.log(`[wss] ${this.id} 协议错误 ${code}: ${reason} → 关闭连接`);
    try { this.close(code, reason); } catch { /* ignore */ }
    // 给 close 帧一点时间冲刷，然后强制销毁
    setTimeout(() => this.terminate(), 30).unref?.();
  }

  _onData(chunk) {
    if (this._ended) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      this._parse();
    } catch (e) {
      // 任何解析异常都不允许拖垮服务器：记录并关闭该连接
      this.emit('error', e);
      this._fail(CLOSE_PROTOCOL, 'protocol error');
    }
  }

  /** 从缓冲区里尽可能多地取出完整帧 */
  _parse() {
    for (;;) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) { this._fail(CLOSE_PROTOCOL, 'RSV 必须为 0'); return; }
      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        offset += 8;
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) { this._fail(CLOSE_TOO_BIG, '帧过大'); return; }
        len = Number(big);
      }

      // 控制帧必须 ≤125 字节且不能分片
      const isControl = (opcode & 0x8) !== 0;
      if (isControl && (!fin || len > 125)) { this._fail(CLOSE_PROTOCOL, '非法控制帧'); return; }

      // 客户端 → 服务端的帧必须掩码
      if (!masked) { this._fail(CLOSE_PROTOCOL, '客户端帧必须掩码'); return; }

      if (len > this._server.maxPayload && !isControl) {
        this._fail(CLOSE_TOO_BIG, '超过 maxPayload');
        return;
      }

      const total = offset + 4 + len;
      if (buf.length < total) return; // 数据还没收全，等下一个 chunk

      const mask = buf.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];

      // 消费掉这一帧
      this._buf = buf.subarray(total);
      this.isAlive = true;

      if (!this._handleFrame(fin, opcode, payload)) return;
    }
  }

  /** 返回 false 表示应当停止继续解析（连接已关闭） */
  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_PING:
        this._write(encodeFrame(OP_PONG, payload));
        return true;
      case OP_PONG:
        this.isAlive = true; // 心跳存活标记
        return true;
      case OP_CLOSE: {
        let code = CLOSE_NORMAL;
        if (payload.length >= 2) code = payload.readUInt16BE(0);
        if (payload.length > 2 && !isValidUtf8(payload.subarray(2))) code = CLOSE_BAD_UTF8;
        if (!this._closeSent) {
          this._closeSent = true;
          const r = payload.subarray(2, Math.min(payload.length, 125));
          this._write(encodeFrame(OP_CLOSE, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), r])));
        }
        try { this._socket.end(); } catch { /* ignore */ }
        this._finalize();
        return false;
      }
      case OP_TEXT:
      case OP_BIN:
      case OP_CONT: {
        if (opcode === OP_CONT) {
          if (!this._frag) { this._fail(CLOSE_PROTOCOL, '意外的续帧'); return false; }
          this._frag.size += payload.length;
        } else {
          if (this._frag) { this._fail(CLOSE_PROTOCOL, '分片未结束时收到新数据帧'); return false; }
          this._frag = { opcode, chunks: [], size: 0 };
          this._frag.size += payload.length;
        }
        if (this._frag.size > this._server.maxPayload) {
          this._frag = null;
          this._fail(CLOSE_TOO_BIG, '分片后超过 maxPayload');
          return false;
        }
        this._frag.chunks.push(payload);
        if (!fin) return true;

        const frag = this._frag;
        this._frag = null;
        const full = frag.chunks.length === 1 ? frag.chunks[0] : Buffer.concat(frag.chunks, frag.size);
        if (frag.opcode === OP_BIN) {
          this.emit('message', full);
        } else {
          if (!isValidUtf8(full)) { this._fail(CLOSE_BAD_UTF8, '非法 UTF-8'); return false; }
          this.emit('message', full.toString('utf8'));
        }
        return true;
      }
      default:
        this._fail(CLOSE_UNSUPPORTED, '不支持的操作码');
        return false;
    }
  }

  /** 只触发一次 close 事件 */
  _finalize() {
    if (this._ended) return;
    this._ended = true;
    this._closed = true;
    this._frag = null;
    this._buf = Buffer.alloc(0);
    this.emit('close');
    this._server._dropSocket(this);
  }
}

/**
 * 极简 RFC 6455 WebSocket 服务器。
 * 不持有 http.Server，只负责 upgrade 握手与连接管理。
 */
export class WSServer extends Emitter {
  /**
   * @param {{maxPayload?:number, heartbeatMs?:number, log?:(...a:any[])=>void}} [opts]
   */
  constructor(opts = {}) {
    super();
    this.maxPayload = Number.isFinite(opts.maxPayload) ? opts.maxPayload : 512 * 1024; // 默认 512 KB
    this.heartbeatMs = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : 30000;   // 默认 30 秒
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    /** @type {Set<WSSocket>} */
    this.sockets = new Set();
    this._timer = null;
    if (this.heartbeatMs > 0) {
      this._timer = setInterval(() => this._heartbeat(), this.heartbeatMs);
      this._timer.unref?.();
    }
  }

  /**
   * 处理 HTTP upgrade 请求。握手失败时回写 400 并销毁连接，返回 false。
   * @returns {boolean} 是否握手成功
   */
  handleUpgrade(req, socket, head) {
    try {
      if (!req || !socket) return false;
      const h = req.headers || {};
      const key = h['sec-websocket-key'];
      const version = String(h['sec-websocket-version'] || '');
      const upgrade = String(h.upgrade || '').toLowerCase();
      const connection = String(h.connection || '').toLowerCase();

      if (String(req.method || '').toUpperCase() !== 'GET'
        || upgrade !== 'websocket'
        || !connection.includes('upgrade')
        || !key
        || version !== '13') {
        this._reject(socket, 400, 'Bad Request');
        return false;
      }

      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      try { socket.setNoDelay(true); } catch { /* ignore */ }

      const ws = new WSSocket(this, socket, req);
      this.sockets.add(ws);
      this.emit('connection', ws);
      if (head && head.length) ws._onData(head);
      return true;
    } catch (e) {
      this.log('[wss] 握手异常:', e?.message || e);
      try { socket.destroy(); } catch { /* ignore */ }
      return false;
    }
  }

  _reject(socket, code, text) {
    try {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch { /* ignore */ }
    try { socket.destroy(); } catch { /* ignore */ }
  }

  _dropSocket(ws) {
    if (!this.sockets.delete(ws)) return;
    this.emit('close', ws);
  }

  /** 心跳：上一轮没回 pong 的连接直接干掉 */
  _heartbeat() {
    for (const ws of this.sockets) {
      if (!ws.isAlive) {
        this.log(`[wss] 心跳超时，断开 ${ws.id}`);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  /** 关闭服务器：停止心跳并断开所有连接 */
  close() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const ws of [...this.sockets]) {
      try { ws.close(1001, 'server shutdown'); } catch { /* ignore */ }
      setTimeout(() => ws.terminate(), 30).unref?.();
    }
    this.sockets.clear();
  }
}

// ── 游戏大厅 / 中继层 ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = { tickRate: 30, partLimit: 300, timeOfDay: 12, weather: 'clear', activity: 'freeflight' };
const MAX_PARTS_BYTES = 200 * 1024; // parts 载荷上限 ~200 KB
const RATE_LIMIT = 160;             // 每个 socket 每秒最多 160 条消息

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * 大厅层：房间、玩家、聊天、信令中继、主机迁移。
 * 所有消息都是 JSON 文本帧。
 */
export class LobbyServer extends Emitter {
  /**
   * @param {{maxRooms?:number, maxPlayersPerRoom?:number, idleTimeoutMs?:number, log?:(...a:any[])=>void}} [opts]
   */
  constructor(opts = {}) {
    super();
    this.maxRooms = Number.isFinite(opts.maxRooms) ? opts.maxRooms : 200;
    this.maxPlayersPerRoom = Number.isFinite(opts.maxPlayersPerRoom) ? opts.maxPlayersPerRoom : 8;
    this.idleTimeoutMs = Number.isFinite(opts.idleTimeoutMs) ? opts.idleTimeoutMs : 120000;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    /** @type {Map<string, object>} roomId → room */
    this.rooms = new Map();
    this._sweeper = null;
    if (this.idleTimeoutMs > 0) {
      const every = Math.max(5000, Math.min(30000, this.idleTimeoutMs / 2));
      this._sweeper = setInterval(() => this._sweepIdle(), every);
      this._sweeper.unref?.();
    }
  }

  /** 把大厅挂到一个 WSServer 上 */
  attach(wss) {
    this._wss = wss;
    wss.on('connection', (ws) => this._onConnection(ws));
    return this;
  }

  get stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.players.size;
    return { rooms: this.rooms.size, players };
  }

  /** 房间列表摘要（只含公开房间；内部按调用者过滤用 _listFor） */
  listRooms() {
    return [...this.rooms.values()]
      .filter((r) => r.privacy === 'public')
      .map((r) => this._summary(r));
  }

  close() {
    if (this._sweeper) { clearInterval(this._sweeper); this._sweeper = null; }
    for (const room of this.rooms.values()) {
      for (const p of room.players.values()) {
        p.socket.send({ t: 'room-closed', reason: 'server shutdown' });
        try { p.socket.close(1001, 'server shutdown'); } catch { /* ignore */ }
      }
    }
    this.rooms.clear();
    this._handlers.clear();
  }

  // ── 连接生命周期 ──────────────────────────────────────────────────────────

  _onConnection(ws) {
    const now = Date.now();
    ws.data.name = '飞行员';
    ws.data.version = 0;
    ws.data.roomId = null;
    ws.data.lastActive = now;
    ws.data._rl = { start: now, count: 0, warned: false };
    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('error', (e) => this.log(`[lobby] socket ${ws.id} 出错: ${e?.message || e}`));
    // 连接断开（含网络掉线）→ 移出房间；若房主掉线则触发主机迁移
    ws.on('close', () => {
      const room = this._roomOf(ws);
      if (room) this._removePlayer(room, ws, 'disconnect');
    });
    ws.send({ t: 'welcome', id: ws.id, version: NET_VERSION });
  }

  /** 新连接默认没有房间，只有显式 create/join 才进房 */
  _onMessage(ws, raw) {
    ws.data.lastActive = Date.now();
    if (!this._rateOk(ws)) return;
    if (typeof raw !== 'string') return this._err(ws, 'bad_message', '只接受文本帧');

    let msg;
    try { msg = JSON.parse(raw); }
    catch {
      this.log(`[lobby] ${ws.id} 收到非法 JSON：${raw.slice(0, 120)}`);
      return this._err(ws, 'bad_message', '不是合法 JSON');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      this.log(`[lobby] ${ws.id} 消息缺少 t 字段`);
      return this._err(ws, 'bad_message', '缺少消息类型 t');
    }

    try {
      switch (msg.t) {
        case 'hello': return this._hello(ws, msg);
        case 'list': return this._list(ws);
        case 'create': return this._create(ws, msg);
        case 'join': return this._join(ws, msg);
        case 'leave': return this._leave(ws);
        case 'signal': return this._signal(ws, msg);
        case 'relay': return this._relay(ws, msg);
        case 'host': return this._host(ws, msg);
        case 'kick': return this._kick(ws, msg);
        case 'chat': return this._chat(ws, msg);
        case 'ping': return this._ping(ws, msg);
        default:
          this.log(`[lobby] ${ws.id} 未知消息类型：${msg.t}`);
          return this._err(ws, 'bad_message', `未知消息类型: ${msg.t}`);
      }
    } catch (e) {
      // 任何单条消息的异常只影响该连接
      this.log(`[lobby] 处理 ${msg.t} 失败 (${ws.id}): ${e?.message || e}`);
      this._err(ws, 'internal_error', e?.message || '内部错误');
    }
  }

  /** 令牌桶式限速：每秒 160 条，超出的直接丢弃并警告 */
  _rateOk(ws) {
    const rl = ws.data._rl;
    const now = Date.now();
    if (now - rl.start >= 1000) { rl.start = now; rl.count = 0; rl.warned = false; }
    rl.count++;
    if (rl.count > RATE_LIMIT) {
      if (!rl.warned) {
        rl.warned = true;
        this.log(`[lobby] ${ws.id} 消息速率超过 ${RATE_LIMIT}/s，开始丢弃`);
      }
      return false;
    }
    return true;
  }

  // ── 消息处理 ──────────────────────────────────────────────────────────────

  _hello(ws, msg) {
    const changed = typeof msg.name === 'string' && msg.name.trim() && msg.name.trim().slice(0, 32) !== ws.data.name;
    if (typeof msg.name === 'string' && msg.name.trim()) ws.data.name = msg.name.trim().slice(0, 32);
    if (msg.version !== undefined) ws.data.version = msg.version;
    const room = this._roomOf(ws);
    if (room && changed) {
      const p = room.players.get(ws.id);
      if (p) {
        p.name = ws.data.name;
        // 改名属于玩家状态变化 → 广播 peer-update
        room.players.forEach((other) => {
          if (other.id !== ws.id) other.socket.send({ t: 'peer-update', player: this._publicPlayer(p) });
        });
      }
    }
  }

  _list(ws) {
    ws.send({ t: 'rooms', rooms: this._listFor(ws) });
  }

  _create(ws, msg) {
    if (this.rooms.size >= this.maxRooms) return this._err(ws, 'too_many_rooms', '房间数量已达上限');

    const parts = this._sanitizeParts(ws, msg.parts);
    if (parts === false) return; // parts 超限：直接拒绝，不改变当前状态

    this._leave(ws, 'replaced'); // 建房前先退出旧房间
    const id = randomBytes(3).toString('hex');
    const maxPlayers = clamp(msg.maxPlayers, 2, 32, this.maxPlayersPerRoom);
    const room = {
      id,
      name: (typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : `${ws.data.name} 的房间`).slice(0, 48),
      hostId: ws.id,
      mapId: typeof msg.mapId === 'string' ? msg.mapId : 'archipelago',
      mode: typeof msg.mode === 'string' ? msg.mode : 'freeflight',
      privacy: msg.privacy === 'private' ? 'private' : 'public',
      maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom),
      locked: false,
      settings: {
        ...DEFAULT_SETTINGS,
        tickRate: clamp(msg.tickRate, 5, 120, DEFAULT_SETTINGS.tickRate),
        partLimit: clamp(msg.partLimit, 0, 5000, DEFAULT_SETTINGS.partLimit),
      },
      players: new Map(),
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    this._addPlayer(room, ws, { name: msg.playerName, craft: msg.craft, parts });
    this.log(`[lobby] 房间创建 ${id} "${room.name}" 房主=${ws.id} 隐私=${room.privacy}`);
    this.emit('room-created', this._summary(room));
    this._sendRoomState(room, ws);
  }

  _join(ws, msg) {
    const room = this.rooms.get(String(msg.roomId || ''));
    if (!room) return this._err(ws, 'not_found', '房间不存在');
    if (ws.data.roomId === room.id) {
      // 重复 join 同一房间 → 视为更新 craft/parts/名字，并广播 peer-update
      const p = room.players.get(ws.id);
      if (p) {
        const parts = this._sanitizeParts(ws, msg.parts);
        if (parts === false) return;
        if (msg.craft !== undefined) p.craft = msg.craft;
        if (parts !== null) p.parts = parts;
        if (typeof msg.playerName === 'string' && msg.playerName.trim()) {
          p.name = msg.playerName.trim().slice(0, 32);
          ws.data.name = p.name;
        }
        room.players.forEach((other) => {
          if (other.id !== ws.id) other.socket.send({ t: 'peer-update', player: this._publicPlayer(p) });
        });
      }
      return this._sendRoomState(room, ws);
    }
    if (room.locked) return this._err(ws, 'locked', '房间已锁定');
    if (room.players.size >= room.maxPlayers) return this._err(ws, 'room_full', '房间已满');

    const parts = this._sanitizeParts(ws, msg.parts);
    if (parts === false) return;

    this._leave(ws, 'replaced'); // 先退出旧房间
    const p = this._addPlayer(room, ws, { name: msg.playerName, craft: msg.craft, parts });
    this.log(`[lobby] 加入 ${room.id} 玩家=${ws.id} "${p.name}" (${room.players.size}/${room.maxPlayers})`);
    this.emit('room-joined', { room: this._summary(room), player: this._publicPlayer(p) });

    // 通知房里其他玩家，然后给新玩家完整房间状态
    room.players.forEach((other) => {
      if (other.id !== ws.id) other.socket.send({ t: 'peer-join', player: this._publicPlayer(p) });
    });
    this._sendRoomState(room, ws);
  }

  _leave(ws, reason = 'leave') {
    const room = this._roomOf(ws);
    if (!room) return;
    this._removePlayer(room, ws, reason);
  }

  _signal(ws, msg) {
    const room = this._roomOf(ws);
    if (!room) return this._err(ws, 'not_in_room', '尚未加入房间');
    const target = room.players.get(String(msg.to || ''));
    if (!target) return this._err(ws, 'not_found', '目标玩家不在同一房间');
    target.socket.send({ t: 'signal', from: ws.id, data: msg.data });
  }

  _relay(ws, msg) {
    const room = this._roomOf(ws);
    if (!room) return this._err(ws, 'not_in_room', '尚未加入房间');
    if (msg.to === 'all') {
      room.players.forEach((p) => {
        if (p.id !== ws.id) p.socket.send({ t: 'relay', from: ws.id, data: msg.data });
      });
      return;
    }
    const target = room.players.get(String(msg.to || ''));
    if (!target) return this._err(ws, 'not_found', '目标玩家不在同一房间');
    if (target.id === ws.id) return; // 自己发给自己，忽略
    target.socket.send({ t: 'relay', from: ws.id, data: msg.data });
  }

  _host(ws, msg) {
    const room = this._roomOf(ws);
    if (!room) return this._err(ws, 'not_in_room', '尚未加入房间');
    if (room.hostId !== ws.id) return this._err(ws, 'not_host', '只有房主可以修改设置');

    const key = String(msg.key || '');
    const value = msg.value;
    switch (key) {
      case 'tickRate': room.settings.tickRate = clamp(value, 5, 120, room.settings.tickRate); break;
      case 'partLimit': room.settings.partLimit = clamp(value, 0, 5000, room.settings.partLimit); break;
      case 'timeOfDay': room.settings.timeOfDay = clamp(value, 0, 24, room.settings.timeOfDay); break;
      case 'weather': room.settings.weather = String(value ?? 'clear').slice(0, 24); break;
      case 'activity': room.settings.activity = String(value ?? 'freeflight').slice(0, 32); break;
      case 'privacy': room.privacy = value === 'private' ? 'private' : 'public'; break;
      case 'maxPlayers': room.maxPlayers = clamp(value, 2, this.maxPlayersPerRoom, room.maxPlayers); break;
      case 'locked': room.locked = value === true || value === 'true' || value === 1; break;
      default: return this._err(ws, 'bad_message', `不允许的设置项: ${key}`);
    }
    const out = { t: 'host', from: ws.id, key, value: this._hostValue(room, key) };
    room.players.forEach((p) => p.socket.send(out));
  }

  _hostValue(room, key) {
    if (key === 'privacy') return room.privacy;
    if (key === 'maxPlayers') return room.maxPlayers;
    if (key === 'locked') return room.locked;
    return room.settings[key];
  }

  _kick(ws, msg) {
    const room = this._roomOf(ws);
    if (!room) return this._err(ws, 'not_in_room', '尚未加入房间');
    if (room.hostId !== ws.id) return this._err(ws, 'not_host', '只有房主可以踢人');
    const target = room.players.get(String(msg.playerId || ''));
    if (!target) return this._err(ws, 'not_found', '目标玩家不存在');
    if (target.id === ws.id) return this._err(ws, 'bad_message', '房主不能踢自己');

    target.socket.send({ t: 'kicked', by: ws.id, reason: String(msg.reason || 'host kick') });
    this._removePlayer(room, target.socket, 'kicked');
  }

  _chat(ws, msg) {
    const room = this._roomOf(ws);
    if (!room) return this._err(ws, 'not_in_room', '尚未加入房间');
    const text = String(msg.text ?? '').slice(0, 2000);
    if (!text) return this._err(ws, 'bad_message', '聊天内容为空');
    const p = room.players.get(ws.id);
    const out = { t: 'chat', from: ws.id, name: p ? p.name : ws.data.name, text, ts: Date.now() };
    room.players.forEach((other) => other.socket.send(out));
  }

  _ping(ws, msg) {
    const room = this._roomOf(ws);
    ws.send({ t: 'pong', ts: msg.ts ?? null, players: room ? room.players.size : 0 });
  }

  // ── 房间/玩家内部操作 ─────────────────────────────────────────────────────

  _addPlayer(room, ws, info = {}) {
    const p = {
      id: ws.id,
      name: (typeof info.name === 'string' && info.name.trim() ? info.name.trim() : ws.data.name).slice(0, 32),
      isHost: room.hostId === ws.id || room.players.size === 0,
      craft: info.craft ?? null,
      parts: info.parts ?? null,
      joinedAt: Date.now(),
      socket: ws,
    };
    if (p.isHost) room.hostId = ws.id;
    room.players.set(ws.id, p);
    ws.data.roomId = room.id;
    ws.data.name = p.name;
    return p;
  }

  _removePlayer(room, target, reason) {
    const ws = target && target.socket ? target.socket : target; // 兼容传入 player 对象
    const p = room.players.get(ws.id);
    if (!p) return;
    room.players.delete(ws.id);
    ws.data.roomId = null;

    const wasHost = room.hostId === ws.id;
    this.log(`[lobby] 离开 ${room.id} 玩家=${ws.id} "${p.name}" 原因=${reason} 剩余=${room.players.size}`);
    this.emit('room-left', { roomId: room.id, playerId: ws.id, name: p.name, reason });

    // 通知剩余玩家
    room.players.forEach((other) => other.socket.send({ t: 'peer-leave', playerId: ws.id, reason }));

    if (room.players.size === 0) {
      this.rooms.delete(room.id);
      this.log(`[lobby] 房间关闭 ${room.id}（无玩家）`);
      this.emit('room-closed', { roomId: room.id, reason: 'empty' });
      return;
    }

    // 主机迁移：最老的剩余玩家成为新房主
    if (wasHost) {
      let oldest = null;
      for (const other of room.players.values()) {
        if (!oldest || other.joinedAt < oldest.joinedAt) oldest = other;
      }
      if (oldest) {
        room.hostId = oldest.id;
        for (const other of room.players.values()) other.isHost = other.id === oldest.id;
        this.log(`[lobby] 主机迁移 ${room.id} → ${oldest.id} "${oldest.name}"`);
        this.emit('host-changed', { roomId: room.id, hostId: oldest.id });
        this._broadcastRoom(room);
      }
    }
  }

  /** 给房间内每个玩家发送各自的完整房间状态（you 字段因人而异） */
  _broadcastRoom(room) {
    room.players.forEach((p) => this._sendRoomState(room, p.socket));
  }

  _sendRoomState(room, ws) {
    const you = room.players.get(ws.id);
    if (!you) return;
    ws.send({
      t: 'room',
      room: {
        id: room.id,
        name: room.name,
        hostId: room.hostId,
        mapId: room.mapId,
        mode: room.mode,
        privacy: room.privacy,
        maxPlayers: room.maxPlayers,
        locked: room.locked,
        settings: { ...room.settings },
      },
      you: { id: you.id, name: you.name, isHost: room.hostId === you.id },
      players: [...room.players.values()].map((p) => this._publicPlayer(p)),
    });
  }

  _publicPlayer(p) {
    return { id: p.id, name: p.name, isHost: p.isHost, craft: p.craft, parts: p.parts, joinedAt: p.joinedAt };
  }

  _summary(room) {
    const host = room.players.get(room.hostId);
    return {
      id: room.id,
      name: room.name,
      hostName: host ? host.name : '',
      maxPlayers: room.maxPlayers,
      players: room.players.size,
      privacy: room.privacy,
      mapId: room.mapId,
      mode: room.mode,
      locked: room.locked,
      ping: 0,
    };
  }

  /** 公开房间 + 调用者自己所在的房间 */
  _listFor(ws) {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.privacy === 'public' || room.players.has(ws.id)) out.push(this._summary(room));
    }
    return out;
  }

  _roomOf(ws) {
    const id = ws.data.roomId;
    if (!id) return null;
    const room = this.rooms.get(id);
    if (!room || !room.players.has(ws.id)) { ws.data.roomId = null; return null; }
    return room;
  }

  _err(ws, code, message) {
    ws.send({ t: 'error', code, message });
  }

  /** parts 是任意 JSON，但体积超过 ~200 KB 直接拒绝 */
  _sanitizeParts(ws, parts) {
    if (parts === undefined || parts === null) return null;
    let size = 0;
    try { size = JSON.stringify(parts).length; }
    catch { this._err(ws, 'bad_message', 'parts 无法序列化'); return false; }
    if (size > MAX_PARTS_BYTES) {
      this._err(ws, 'parts_too_large', `parts 超过 ${Math.round(MAX_PARTS_BYTES / 1024)} KB`);
      return false;
    }
    return parts;
  }

  /** 空闲清理：太久没说话的连接回收 */
  _sweepIdle() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      for (const p of [...room.players.values()]) {
        const ws = p.socket;
        const roomAlive = this.rooms.has(room.id) && room.players.has(p.id);
        if (!roomAlive) continue;
        if (ws._ended) { this._removePlayer(room, ws, 'disconnect'); continue; }
        if (this.idleTimeoutMs > 0 && now - (ws.data.lastActive || now) > this.idleTimeoutMs) {
          this.log(`[lobby] ${ws.id} 空闲超时，回收`);
          this._removePlayer(room, ws, 'idle');
          try { ws.close(1001, 'idle timeout'); } catch { /* ignore */ }
        }
      }
    }
  }
}
