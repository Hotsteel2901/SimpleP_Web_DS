/**
 * 联机会话（Multiplayer Session）
 * ------------------------------------------------------------------
 * · 大厅/房间状态（服务器权威的信令 + 中继）
 * · 本地飞机状态 15Hz 广播，远端玩家用 100ms 延迟做插值渲染（幽灵机）
 * · 命中由射击方本地判定，伤害事件发给目标宿主应用（避免作弊/回滚复杂化）
 * · 房主可设置 天气/时间/玩法/节拍率/零件上限，并踢人
 */
import * as THREE from 'three';
import { Emitter, clamp, clamp01, lerp } from '../core/util.js';
import { NetClient, PeerManager, defaultServerUrl, DEFAULT_ICE } from './net.js';
import { Aircraft } from '../flight/aircraft.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

const TEAM_COLORS = [
  { name: '蓝队', color: 0x00d0ff }, { name: '红队', color: 0xff4d5e },
  { name: '绿队', color: 0x3ddc84 }, { name: '黄队', color: 0xffd166 },
  { name: '紫队', color: 0xb388ff }, { name: '橙队', color: 0xff9f43 },
];

export class MultiplayerSession extends Emitter {
  /**
   * @param {object} game Game 实例
   * @param {object} opts { serverUrl, playerName, iceServers }
   */
  constructor(game, opts = {}) {
    super();
    this.game = game;
    this.opts = opts;
    this.playerName = opts.playerName || 'Pilot';
    this.net = new NetClient(opts.serverUrl || defaultServerUrl());
    if (opts.iceServers?.length) this.net.setIceServers(opts.iceServers);
    this.peers = null;
    this.room = null;
    this.self = null;
    this.players = new Map();     // id -> { id, name, isHost, craft, parts, ac, buffer, lastState }
    this.remotes = new Map();     // id -> Aircraft
    this.chat = [];
    this.killFeed = [];
    this.tickRate = 15;
    this.partLimit = 400;
    this._sendAccum = 0;
    this._connected = false;
    this._lastSentCraft = null;
    this.serverRooms = [];
    this.status = 'idle';         // idle | connecting | lobby | playing | error
    this.lastError = '';
    this._bindNet();
  }

  /* ------------------------------------------------------------ 连接 */
  get connected() { return this._connected; }
  get isHost() { return !!this.self?.isHost; }
  get playerCount() { return this.players.size + (this.self ? 1 : 0); }

  async connect(url) {
    if (url) this.net.url = url;
    this.status = 'connecting';
    this.emit('status', this.status);
    try {
      await this.net.connect();
      this._connected = true;
      this.net.send({ t: 'hello', name: this.playerName, version: 1 });
      this.status = 'lobby';
      this.emit('status', this.status);
      return true;
    } catch (e) {
      this._connected = false;
      this.status = 'error';
      this.lastError = e.message || String(e);
      this.emit('status', this.status);
      this.emit('error', this.lastError);
      return false;
    }
  }

  listRooms() { this.net.send({ t: 'list' }); return this.serverRooms; }

  /** 以房主身份创建房间 */
  async host(o = {}) {
    if (!this._connected) { const ok = await this.connect(); if (!ok) return false; }
    this.net.send({
      t: 'create',
      name: o.name || `${this.playerName} 的房间`,
      maxPlayers: o.maxPlayers ?? 10,
      privacy: o.privacy || 'public',
      mapId: o.mapId || this.game.mapDef?.id || 'archipelago',
      mode: o.mode || 'free',
      playerName: this.playerName,
      craft: this.game.player?.craft?.name || null,
      parts: this._craftPayload(),
      tickRate: o.tickRate ?? 15,
      partLimit: o.partLimit ?? 400,
    });
    return true;
  }

  async join(roomId, o = {}) {
    if (!this._connected) { const ok = await this.connect(); if (!ok) return false; }
    this.net.send({ t: 'join', roomId, playerName: this.playerName, craft: this.game.player?.craft?.name || null, parts: this._craftPayload() });
    return true;
  }

  leave() {
    this.net.send({ t: 'leave' });
    this._clearRemotes();
    this.players.clear();
    this.room = null; this.self = null;
    this.status = 'lobby';
    this.emit('status', this.status);
    this.emit('players', this.playerList);
  }

  disconnect() {
    this.leave();
    this.net.close();
    this._connected = false;
    this.status = 'idle';
    this.emit('status', this.status);
  }

  _craftPayload() {
    const craft = this.game.player?.craft;
    if (!craft) return null;
    try {
      const json = JSON.stringify(craft.parts);
      // 太长的零件表不发送（避免超过信令服务器限制），远端会退化成默认机型
      if (json.length > 120 * 1024) return null;
      return { name: craft.name, type: craft.type, parts: craft.parts };
    } catch { return null; }
  }

  /* ------------------------------------------------------------ 信令 */
  _bindNet() {
    const net = this.net;
    net.on('room', (m) => {
      this.room = m.room;
      this.self = m.you;
      this.tickRate = clamp(m.room?.settings?.tickRate ?? 15, 5, 60);
      this.partLimit = m.room?.settings?.partLimit ?? 400;
      this.players.clear();
      for (const p of m.players || []) {
        if (p.id === this.self.id) continue;
        this.players.set(p.id, { ...p, buffer: [], ac: null });
      }
      this.peers = this.peers || new PeerManager(net, this.self.id);
      this.status = 'playing';
      this.emit('status', this.status);
      this.emit('room', this.room);
      this.emit('players', this.playerList);
      // 为房间里已有的玩家建立链路并生成幽灵机
      for (const id of this.players.keys()) {
        this._ensurePeer(id);
        this._spawnRemote(this.players.get(id));
      }
    });
    net.on('rooms', (m) => { this.serverRooms = m.rooms || []; this.emit('rooms', this.serverRooms); });
    net.on('peer-join', (m) => {
      const p = m.player;
      if (!p || p.id === this.self?.id) return;
      this.players.set(p.id, { ...p, buffer: [], ac: null });
      this._ensurePeer(p.id);
      this._spawnRemote(this.players.get(p.id));
      this._pushChat('系统', `${p.name} 加入了房间`);
      this.emit('players', this.playerList);
    });
    net.on('peer-leave', (m) => {
      const p = this.players.get(m.playerId);
      if (p) this._pushChat('系统', `${p.name} 离开了房间`);
      this._removeRemote(m.playerId);
      this.players.delete(m.playerId);
      this.peers?.drop(m.playerId);
      this.emit('players', this.playerList);
    });
    net.on('peer-update', (m) => {
      const p = this.players.get(m.player?.id);
      if (p && m.player) { Object.assign(p, m.player); this.emit('players', this.playerList); }
    });
    net.on('chat', (m) => { this._pushChat(m.name || '玩家', m.text); });
    net.on('kicked', (m) => { this.emit('kicked', m); this.leave(); });
    net.on('room-closed', (m) => { this.emit('room-closed', m); this._clearRemotes(); this.players.clear(); this.room = null; this.status = 'lobby'; this.emit('status', this.status); });
    net.on('host', (m) => { this._applyHostSetting(m.key, m.value); });
    net.on('relay', (m) => { this._onPeerData(m.from, m.data); });
    net.on('error', (m) => { this.lastError = m.message || m.code || 'error'; this.emit('error', this.lastError); });
    net.on('close', () => { this._connected = false; this.emit('status', 'idle'); });
  }

  _ensurePeer(id) {
    if (!this.peers) this.peers = new PeerManager(this.net, this.self.id);
    const link = this.peers.ensure(id);
    link.on('data', (d) => this._onPeerData(id, d));
    return link;
  }

  _onPeerData(fromId, data) {
    if (!data || typeof data !== 'object') return;
    const p = this.players.get(fromId);
    switch (data.t) {
      case '__hb': return;
      case 'state': if (p) this._onRemoteState(p, data); return;
      case 'craft': if (p) { p.parts = data.parts; p.craftName = data.name; this._spawnRemote(p); } return;
      case 'hit': {
        // 别人打我：在本地权威地扣血
        const me = this.game.player;
        if (me && data.target === this.self?.id) {
          me.applyDamage(data.dmg, data.point ? new THREE.Vector3(data.point[0], data.point[1], data.point[2]) : me.body.position, data.cause || 'pvp');
          if (me.destroyed) this._broadcast({ t: 'kill', victim: this.self.id, killer: fromId, name: this.playerName });
        }
        return;
      }
      case 'kill': {
        const killer = this.players.get(data.killer)?.name || '未知';
        this._pushKill(`${data.name || '玩家'} 被 ${killer} 击落`);
        this.emit('kill', data);
        return;
      }
      case 'chat': this._pushChat(this.players.get(fromId)?.name || '玩家', data.text); return;
      case 'mission': this.emit('mission', data); return;
      case 'respawn': {
        const p2 = this.players.get(data.id);
        if (p2?.ac) { p2.ac.reset(new THREE.Vector3(...data.p), data.heading || 0, data.speed || 0); }
        return;
      }
      default: this.emit('peer-data', { from: fromId, data });
    }
  }

  /* ------------------------------------------------------------ 远端飞机 */
  /** 若飞机还没生成（例如缺少零件数据），稍后重试 */
  _scheduleSpawn(p, delay = 800) {
    if (p._spawnTimer) return;
    p._spawnTimer = setTimeout(() => {
      p._spawnTimer = null;
      if (!p.ac && this.status === 'playing' && this.players.has(p.id)) this._spawnRemote(p);
    }, delay);
  }

  _spawnRemote(p) {
    if (!this.game.terrain) return;
    if (p.ac) { this._removeRemote(p.id); }
    let craft = null;
    try {
      if (p.parts && Array.isArray(p.parts.parts) && p.parts.parts.length) {
        craft = { id: 'mp_' + p.id, name: p.parts.name || p.name, type: p.parts.type || 'plane', parts: p.parts.parts };
      }
    } catch { craft = null; }
    if (!craft) {
      const list = this.game.opts.enemyCrafts || [];
      craft = list[0] || this.game.player?.craft;
      // 对方还没把零件发过来：先用默认机型占位，收到 craft 消息后重建
      if (p.parts === undefined || p.parts === null) this._scheduleSpawn(p, 1200);
    }
    if (!craft) return;
    const idx = [...this.players.keys()].indexOf(p.id) + 1;
    const ac = this.game.spawnAircraft(craft, {
      position: this.game.player ? this.game.player.body.position.clone().add(new THREE.Vector3(60, 0, 60)) : new THREE.Vector3(0, 400, 0),
      heading: 0, team: 10 + (idx % 6), callsign: p.name || 'Player', speed: 0, assist: 1,
    });
    ac.remote = true;
    ac.netId = p.id;
    ac.remoteDamageHook = (amount, point, cause) => this.reportHit(p.id, amount, cause, point);
    p.ac = ac;
    p.buffer = [];
    this.remotes.set(p.id, ac);
    this.emit('players', this.playerList);
  }

  _removeRemote(id) {
    const p = this.players.get(id);
    if (p?.ac) { this.game.removeAircraft(p.ac); p.ac = null; }
    this.remotes.delete(id);
  }

  _clearRemotes() { for (const id of [...this.remotes.keys()]) this._removeRemote(id); }

  _onRemoteState(p, d) {
    const buf = p.buffer;
    buf.push({ t: performance.now() / 1000, p: d.p, q: d.q, v: d.v, rpm: d.rpm || 0, gear: d.gear !== false, h: d.h01, name: d.name });
    if (buf.length > 24) buf.shift();
    p.lastState = d;
  }

  /* ------------------------------------------------------------ 主循环 */
  update(dt) {
    if (this.status !== 'playing') return;
    // 发送本地状态
    this._sendAccum += dt;
    const interval = 1 / clamp(this.tickRate, 5, 60);
    const me = this.game.player;
    if (me && this._sendAccum >= interval) {
      this._sendAccum = 0;
      this._broadcast({
        t: 'state',
        id: this.self?.id,
        p: [round(me.body.position.x), round(me.body.position.y), round(me.body.position.z)],
        q: [round(me.body.quaternion.x, 4), round(me.body.quaternion.y, 4), round(me.body.quaternion.z, 4), round(me.body.quaternion.w, 4)],
        v: [round(me.body.velocity.x), round(me.body.velocity.y), round(me.body.velocity.z)],
        rpm: round(me.state.rpm01, 2), gear: me.controls.gear, h01: round(me.health, 2), name: this.playerName,
      });
      if (me.craft && this._lastSentCraft !== me.craft.id) { this._lastSentCraft = me.craft.id; }
    }
    // 远端插值
    const renderTime = performance.now() / 1000 - 0.1;
    for (const p of this.players.values()) {
      const ac = p.ac;
      if (!ac || !p.buffer.length) continue;
      const buf = p.buffer;
      while (buf.length >= 2 && buf[1].t <= renderTime) buf.shift();
      const a = buf[0];
      const b = buf[Math.min(1, buf.length - 1)];
      const span = Math.max(1e-3, b.t - a.t);
      const f = clamp01((renderTime - a.t) / span);
      _v.set(a.p[0], a.p[1], a.p[2]);
      _v2.set(b.p[0], b.p[1], b.p[2]);
      ac.body.position.lerpVectors(_v, _v2, f);
      _q.set(a.q[0], a.q[1], a.q[2], a.q[3]);
      _q2.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      ac.body.quaternion.copy(_q).slerp(_q2, f);
      ac.body.velocity.set(a.v[0], a.v[1], a.v[2]);
      if (p.lastState) ac.health = p.lastState.h01 ?? ac.health;
      ac.controls.gear = a.gear !== false;
      for (const e of ac.engines) e.rpm01 = a.rpm || 0;
      ac.updateVisualTransform(dt);
      ac.state.speed = ac.body.velocity.length();
      ac.state.altitudeASL = ac.body.position.y;
      ac.state.health01 = ac.health;
      ac.state.pos = ac.body.position;
    }
  }

  _broadcast(data) { this.peers?.broadcast(data); }

  reportHit(targetId, dmg, cause, point) {
    this.peers?.send(targetId, {
      t: 'hit', target: targetId, dmg: Math.round(dmg), cause,
      point: point ? [round(point.x), round(point.y), round(point.z)] : null,
    });
  }

  reportKill(victimId) {
    this._broadcast({ t: 'kill', victim: victimId, killer: this.self?.id, name: this.playerName });
  }

  /** 广播本地机型（换机后调用） */
  broadcastCraft() {
    const payload = this._craftPayload();
    if (!payload) return;
    this._lastSentCraft = this.game.player?.craft?.id;
    this._broadcast({ t: 'craft', parts: payload, name: payload.name });
  }

  respawn(position, heading, speed) {
    const me = this.game.player;
    if (me) me.reset(position, heading, speed);
    this._broadcast({ t: 'respawn', id: this.self?.id, p: [position.x, position.y, position.z], heading, speed });
  }

  /* ------------------------------------------------------------ 房主设置 */
  setSetting(key, value) {
    if (!this.isHost) return false;
    this.net.send({ t: 'host', key, value });
    this._applyHostSetting(key, value);
    return true;
  }
  _applyHostSetting(key, value) {
    const s = this.room?.settings || (this.room ? (this.room.settings = {}) : null);
    if (s) s[key] = value;
    switch (key) {
      case 'tickRate': this.tickRate = clamp(Number(value) || 15, 5, 60); break;
      case 'partLimit': this.partLimit = Number(value) || 400; break;
      case 'timeOfDay': this.game.sky?.setTimeOfDay(Number(value)); break;
      case 'weather': this.game.setWeather?.(value); break;
      case 'activity': this.emit('activity', value); break;
      default: break;
    }
    this.emit('settings', this.room?.settings);
  }
  kick(id) { if (this.isHost) this.net.send({ t: 'kick', playerId: id }); }

  /* ------------------------------------------------------------ 聊天 */
  sendChat(text) {
    if (!text) return;
    this.net.send({ t: 'chat', text: String(text).slice(0, 240) });
    this._pushChat(this.playerName, text);
  }
  _pushChat(name, text) {
    const entry = { name, text, ts: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > 60) this.chat.shift();
    this.emit('chat', entry);
  }
  _pushKill(text) {
    this.killFeed.push({ text, ts: Date.now() });
    if (this.killFeed.length > 30) this.killFeed.shift();
    this.emit('killfeed', text);
  }

  get playerList() {
    const list = [];
    if (this.self) list.push({ id: this.self.id, name: this.playerName, isHost: !!this.self.isHost, me: true, mode: 'self', ping: this.net.latency });
    for (const p of this.players.values()) {
      list.push({ id: p.id, name: p.name || '玩家', isHost: !!p.isHost, me: false, mode: this.peers?.links.get(p.id)?.mode || 'relay', ping: null });
    }
    return list;
  }

  get teamColors() { return TEAM_COLORS; }
}

function round(v, d = 2) { const m = Math.pow(10, d); return Math.round((Number(v) || 0) * m) / m; }
