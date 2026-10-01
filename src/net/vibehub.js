/**
 * VibeHub SDK 传输层
 * ------------------------------------------------------------------
 * 平台规范要求作品使用 window.VibeHub（禁止自建后端/WebSocket）。
 * 这里把 SDK 的 Room API 适配成与本地 NetClient/PeerManager **同构**的接口，
 * 于是 MultiplayerSession 不需要改动就能在平台上跑 P2P + VibeNet 中继。
 *
 * 与本地 WebSocket 实现的关系：
 *   - 平台内（window.VibeHub 存在）→ 使用本文件；
 *   - 自建服务器 / 本地开发 → 回退到 src/net/net.js 的 WebSocket 实现。
 * 两条路径产出的消息格式完全一致（relay/chat/host/...），游戏逻辑共用。
 */
import { Emitter } from '../core/util.js';

/** SDK 是否可用 */
export function vibeHubAvailable() {
  return typeof window !== 'undefined' && !!window.VibeHub && typeof window.VibeHub.init === 'function';
}

/** 适配 NetClient 的接口（send/connect/on/emit） */
export class VibeHubNet extends Emitter {
  /**
   * @param {object} o { work, name, craft, parts, mapId, mode }
   */
  constructor(o = {}) {
    super();
    this.work = o.work || 'simpleplanes2';
    this.client = null;
    this.room = null;
    this.id = null;
    this.connected = false;
    this.latency = 0;
    this.iceServers = [];
    this._players = new Map();     // peerId -> { id, name, isHost, craft, parts }
    this._name = o.name || 'Pilot';
    this._craft = o.craft || null;
    this._parts = o.parts || null;
    this._settings = { tickRate: 15, partLimit: 400, timeOfDay: 0.4, weather: 'none', activity: 'free' };
    this._meta = null;
    this._closed = false;
  }

  /* ---------------------------------------------------------------- 连接 */
  async connect() {
    if (this.connected) return true;
    if (!vibeHubAvailable()) throw new Error('VibeHub SDK 不可用');
    this.client = await window.VibeHub.init({ work: this.work });
    this.connected = true;
    this.emit('open');
    return true;
  }

  async listRooms() {
    await this.connect();
    let list = [];
    try { list = await this.client.rooms.list(); } catch (e) { list = []; }
    const rooms = (Array.isArray(list) ? list : []).map((r) => {
      const m = (r && r.metadata) || {};
      return {
        id: r.roomId || r.id,
        name: m.name || r.roomId || r.id,
        hostName: m.hostName || '',
        players: m.players || 0,
        maxPlayers: m.maxPlayers || 10,
        privacy: m.privacy || 'public',
        mapId: m.mapId || 'archipelago',
        mode: m.mode || 'free',
        locked: !!m.locked, ping: 0,
      };
    });
    this.emit('rooms', { rooms });
    return rooms;
  }

  /** 与 NetClient.send 同构：接受协议消息，内部翻译到 SDK */
  send(msg) {
    if (!msg || !msg.t) return false;
    try {
      switch (msg.t) {
        case 'hello': this._name = msg.name || this._name; return true;
        case 'list': this.listRooms(); return true;
        case 'create': this._create(msg); return true;
        case 'join': this._join(msg); return true;
        case 'leave': this.leave(); return true;
        case 'relay': return this._sendData(msg.data, msg.to === 'all' ? null : msg.to);
        case 'chat': {
          this._sendData({ t: 'chat', text: msg.text }, null);
          this.emit('chat', { from: this.id, name: this._name, text: msg.text, ts: Date.now() });
          return true;
        }
        case 'host': {
          if (this._settings && msg.key in this._settings) this._settings[msg.key] = msg.value;
          this._sendData({ t: 'host', key: msg.key, value: msg.value }, null);
          return true;
        }
        case 'kick': {
          if (this.room && this.room.isHost) this._sendData({ t: '__kick' }, msg.playerId);
          return true;
        }
        case 'ping': this.emit('pong', { ts: msg.ts, players: this._players.size }); return true;
        case 'signal': return true;      // SDK 自带信令，无需转发
        default: return false;
      }
    } catch (e) {
      this.emit('error', { code: 'sdk_error', message: e.message || String(e) });
      return false;
    }
  }

  async _create(msg) {
    await this.connect();
    // VibeNet 没有独立的“建房”接口：加入一个自定义 roomId 并广播元数据即为创建
    const slug = String(msg.name || 'room').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').slice(0, 24);
    const roomId = (msg.roomId || `${this.work}-${slug}-${Math.random().toString(36).slice(2, 6)}`).slice(0, 64);
    this._meta = {
      name: msg.name || '房间', hostName: this._name, maxPlayers: msg.maxPlayers || 10,
      privacy: msg.privacy || 'public', mapId: msg.mapId || 'archipelago', mode: msg.mode || 'free',
      locked: false, players: 1,
    };
    if (msg.tickRate) this._settings.tickRate = msg.tickRate;
    if (msg.partLimit) this._settings.partLimit = msg.partLimit;
    this._craft = msg.craft ?? this._craft;
    this._parts = msg.parts ?? this._parts;
    await this._joinRoom(roomId, true);
  }

  async _join(msg) {
    await this.connect();
    if (!msg.roomId) { this.emit('error', { code: 'not_found', message: '缺少房间号' }); return; }
    this._craft = msg.craft ?? this._craft;
    this._parts = msg.parts ?? this._parts;
    if (msg.playerName) this._name = msg.playerName;
    await this._joinRoom(msg.roomId, false);
  }

  async _joinRoom(roomId, isHost) {
    this.room = await this.client.room.join(roomId);
    this.id = this.room.peerId || 'me';
    this._wireRoom();
    if (isHost && typeof this.room.announce === 'function') {
      try { await this.room.announce(this._meta || { name: roomId }); } catch (e) { /* 元数据广播失败不影响联机 */ }
    }
    // 向房间广播自己（名字/机型），其它人据此生成幽灵机
    this._sendData({ t: '__hello', player: { id: this.id, name: this._name, craftName: this._craft, parts: this._parts, isHost: !!this.room.isHost } }, null);
    this._emitRoom();
  }

  _wireRoom() {
    const room = this.room;
    if (!room) return;
    if (typeof room.onMessage === 'function') {
      room.onMessage((msg, from) => this._onData(msg, from));
    }
    if (typeof room.onPeer === 'function') {
      room.onPeer((ev) => {
        if (!ev || ev.id === this.id) return;
        if (ev.type === 'join') {
          // 等对方发 __hello；先占位，收到后补齐信息
          if (!this._players.has(ev.id)) this._players.set(ev.id, { id: ev.id, name: '玩家', isHost: false });
        } else if (ev.type === 'leave') {
          this._players.delete(ev.id);
          this.emit('peer-leave', { playerId: ev.id, reason: 'left' });
        } else if (ev.type === 'error') {
          this.emit('error', { code: 'peer', message: ev.reason || 'p2p error' });
        }
      });
    }
  }

  _onData(msg, from) {
    if (!msg || typeof msg !== 'object' || !from) return;
    if (msg.t === '__hello') {
      const p = msg.player || {};
      const known = this._players.get(from);
      const player = { id: from, name: p.name || '玩家', isHost: !!p.isHost, craft: p.craftName || p.craft, parts: p.parts };
      this._players.set(from, player);
      this.emit('peer-update', { player });
      if (!known || !known.parts) this.emit('peer-join', { player });
      // 回礼：让对方也知道我
      this._sendData({ t: '__hello', player: { id: this.id, name: this._name, craftName: this._craft, parts: this._parts, isHost: !!this.room?.isHost } }, from);
      return;
    }
    if (msg.t === '__kick') { this.emit('kicked', { by: 'host', reason: '被房主移出房间' }); this.leave(); return; }
    if (msg.t === 'chat') { this.emit('chat', { from, name: this._players.get(from)?.name || '玩家', text: msg.text, ts: Date.now() }); return; }
    if (msg.t === 'host') {
      if (this._settings && msg.key in this._settings) this._settings[msg.key] = msg.value;
      this.emit('host', { from, key: msg.key, value: msg.value });
      return;
    }
    if (msg.t === '__hb') return;
    // 其它一律按游戏数据转发（与 WebSocket 中继语义一致）
    this.emit('relay', { from, data: msg });
  }

  /** 发送游戏数据；state 走低延迟不可靠通道，其余走可靠通道 */
  _sendData(data, to) {
    if (!this.room) return false;
    try {
      const realtime = data && data.t === 'state';
      if (realtime && typeof this.room.sendRealtime === 'function') {
        if (to) this.room.sendRealtime(data, to); else this.room.sendRealtime(data);
      } else if (to) {
        this.room.send(data, to);
      } else {
        this.room.send(data);
      }
      return true;
    } catch (e) { return false; }
  }

  _emitRoom() {
    const players = [];
    for (const p of this._players.values()) {
      if (p.id === this.id) continue;
      players.push({ id: p.id, name: p.name, isHost: !!p.isHost, craft: p.craft, parts: p.parts });
    }
    if (this._meta) this._meta.players = players.length + 1;
    this.emit('room', {
      room: {
        id: this.room?.roomId || 'room', name: this._meta?.name || this.room?.roomId || '房间',
        hostId: this.room?.hostId || this.id, mapId: this._meta?.mapId || 'archipelago',
        mode: this._meta?.mode || 'free', privacy: this._meta?.privacy || 'public',
        maxPlayers: this._meta?.maxPlayers || 10, locked: false, settings: { ...this._settings },
      },
      you: { id: this.id, name: this._name, isHost: !!this.room?.isHost },
      players: [{ id: this.id, name: this._name, isHost: !!this.room?.isHost }, ...players],
    });
    // 房间人数变化后刷新一下元数据，方便服务器列表显示
    if (this.room && this.room.isHost && typeof this.room.announce === 'function' && this._meta) {
      this.room.announce(this._meta).catch(() => { });
    }
  }

  /** 定期刷新延迟与在线人数 */
  update() {
    if (!this.room) return;
    try {
      const peers = typeof this.room.peers === 'function' ? this.room.peers() : [];
      let best = 0;
      for (const p of peers) if (p && p.latency) best = Math.max(best, p.latency);
      this.latency = Math.round(best);
    } catch (e) { /* 忽略 */ }
  }

  leave() {
    try { this._sendData({ t: '__leave' }, null); } catch (e) { /* 忽略 */ }
    try { this.room?.leave?.(); } catch (e) { /* 忽略 */ }
    this.room = null;
    this._players.clear();
  }

  close() {
    this._closed = true;
    try { this.room?.leave?.(); } catch (e) { /* 忽略 */ }
    this.room = null;
    this.connected = false;
    this.emit('close', { wasConnected: true });
  }
}

/** 适配 PeerManager 的接口，底层直接用 SDK Room 的定向发送 */
export class VibeHubPeers extends Emitter {
  constructor(net) {
    super();
    this.net = net;
    this.links = new Map();
  }
  ensure(peerId) {
    let link = this.links.get(peerId);
    if (!link) {
      const net = this.net;
      link = {
        peerId, mode: 'p2p', open: true, initiator: false,
        send: (data) => net._sendData(data, peerId),
        close: () => { },
        on: () => link,
      };
      this.links.set(peerId, link);
    }
    return link;
  }
  send(peerId, data) { return this.net._sendData(data, peerId); }
  broadcast(data) {
    if (!this.net.room) return 0;
    let n = 0;
    for (const id of this.net._players.keys()) { if (this.net._sendData(data, id)) n++; }
    return n;
  }
  drop(peerId) { this.links.delete(peerId); }
  close() { this.links.clear(); }
  get modes() { const o = {}; for (const [id] of this.links) o[id] = 'p2p'; return o; }
}

/**
 * 创建 VibeHub 传输层。
 * @returns {{net: VibeHubNet, peers: VibeHubPeers}}
 */
export function createVibeTransport(opts = {}) {
  const net = new VibeHubNet(opts);
  const peers = new VibeHubPeers(net);
  return { net, peers };
}
