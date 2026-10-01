/**
 * 网络传输层
 * ------------------------------------------------------------------
 * NetClient  —— 与信令/中继服务器（/ws）的 WebSocket 连接
 * PeerLink   —— 与单个玩家的 WebRTC DataChannel；失败时自动退回服务器中继
 *
 * 设计原则：
 *  1) 优先 P2P（延迟最低）；
 *  2) 打洞失败（对称 NAT / 运营商 CGNAT）时自动退回「公网中继」——由服务器转发，
 *     玩法完全一致，只是延迟略高；
 *  3) 服务器不可用时整个联机模块安全降级（单机照常玩）。
 */
import { Emitter } from '../core/util.js';

/** 默认 STUN 服务器（公共、免费）。用户可在设置里追加自建 TURN。 */
export const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export function defaultServerUrl() {
  if (typeof location === 'undefined') return 'ws://localhost:8080/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/* ================================================================== 信令客户端 */
export class NetClient extends Emitter {
  /** @param {string} [url] WebSocket 地址，默认同源 /ws */
  constructor(url) {
    super();
    this.url = url || defaultServerUrl();
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.id = null;
    this.latency = 0;
    this._pingTimer = null;
    this._queue = [];
    this._retry = 0;
    this._closedByUser = false;
    this.iceServers = DEFAULT_ICE.slice();
  }

  /** 允许追加自建 TURN（例如 {urls:'turn:host:3478', username, credential}） */
  setIceServers(list) { if (Array.isArray(list) && list.length) this.iceServers = list; }

  connect() {
    if (this.connected || this.connecting) return Promise.resolve();
    if (typeof WebSocket === 'undefined') return Promise.reject(new Error('当前环境不支持 WebSocket'));
    this.connecting = true;
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this.connecting = false; return reject(e); }
      this.ws = ws;
      const fail = (e) => { this.connecting = false; reject(e instanceof Error ? e : new Error(String(e))); };
      const timer = setTimeout(() => { try { ws.close(); } catch { } fail(new Error('连接服务器超时')); }, 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.connected = true; this.connecting = false; this._retry = 0;
        this.emit('open');
        for (const m of this._queue.splice(0)) this.send(m);
        this._startPing();
        resolve();
      };
      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'welcome') this.id = msg.id;
        else if (msg.t === 'pong') { this.latency = Math.max(0, Date.now() - (msg.ts || Date.now())); this.emit('latency', this.latency); }
        this.emit('message', msg);
        if (msg.t) this.emit(msg.t, msg);
      };
      ws.onerror = (e) => { this.emit('error', e); if (!this.connected) { clearTimeout(timer); fail(new Error('无法连接联机服务器')); } };
      ws.onclose = () => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        this.connected = false; this.connecting = false;
        this._stopPing();
        this.emit('close', { wasConnected });
        if (!this._closedByUser) this._scheduleRetry();
      };
    });
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => { if (this.connected) this.send({ t: 'ping', ts: Date.now() }); }, 2000);
  }
  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }

  _scheduleRetry() {
    if (this._retry > 4) return;
    const delay = Math.min(8000, 600 * Math.pow(2, this._retry++));
    setTimeout(() => { if (!this._closedByUser) this.connect().catch(() => { }); }, delay);
  }

  send(msg) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) { if (this._queue.length < 60) this._queue.push(msg); return false; }
    try { this.ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
  }

  close() {
    this._closedByUser = true;
    this._stopPing();
    try { this.ws?.close(); } catch { }
    this.ws = null; this.connected = false;
  }
}

/* ================================================================== 单点连接 */
let _linkSeq = 0;

/**
 * 与某个玩家的连接。内部自动选择 P2P 或中继。
 * 事件：'open' | 'close' | 'data' | 'mode'（'p2p' | 'relay'）
 */
export class PeerLink extends Emitter {
  /**
   * @param {NetClient} net
   * @param {string} peerId
   * @param {boolean} initiator 由 id 较小的一方发起，避免 glare
   */
  constructor(net, peerId, initiator) {
    super();
    this.net = net;
    this.peerId = peerId;
    this.initiator = initiator;
    this.pc = null;
    this.channel = null;
    this.open = false;
    this.mode = 'relay';
    this.lastSeen = Date.now();
    this._relayTimer = null;
    this._iceCandidateQueue = [];
    this.uid = ++_linkSeq;

    net.on('signal', (m) => { if (m.from === this.peerId) this._onSignal(m.data); });
    net.on('relay', (m) => { if (m.from === this.peerId) { this.lastSeen = Date.now(); this.emit('data', m.data); } });

    if (initiator) this._createPeer(true);
    // 若 4 秒内没有建立 P2P，就用中继（保证一定能玩）
    this._p2pTimer = setTimeout(() => { if (!this.open) this._useRelay(); }, 4000);
  }

  _createPeer(createOffer) {
    if (typeof RTCPeerConnection === 'undefined') { this._useRelay(); return; }
    try {
      this.pc = new RTCPeerConnection({ iceServers: this.net.iceServers });
    } catch (e) { this._useRelay(); return; }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.net.send({ t: 'signal', to: this.peerId, data: { ice: ev.candidate } });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        if (this.open) { this.open = false; this.emit('close'); }
        this._useRelay();
      }
    };
    this.pc.ondatachannel = (ev) => { this._bindChannel(ev.channel); };
    if (createOffer) {
      const dc = this.pc.createDataChannel('sp2', { ordered: false, maxRetransmits: 0 });
      this._bindChannel(dc);
      this.pc.onnegotiationneeded = async () => {
        try {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this.net.send({ t: 'signal', to: this.peerId, data: { sdp: this.pc.localDescription } });
        } catch (e) { this._useRelay(); }
      };
    }
  }

  _bindChannel(dc) {
    this.channel = dc;
    try { dc.binaryType = 'arraybuffer'; } catch { }
    dc.onopen = () => {
      this.open = true;
      this.mode = 'p2p';
      clearTimeout(this._p2pTimer);
      this._stopRelayLoop();
      // 把等待中继期间的消息补发出去
      for (const m of this._pendingOut || []) this.send(m);
      this._pendingOut = [];
      this.emit('mode', 'p2p');
      this.emit('open');
    };
    dc.onmessage = (ev) => {
      this.lastSeen = Date.now();
      let data = ev.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* 保留原样 */ } }
      this.emit('data', data);
    };
    dc.onclose = () => { if (this.open) { this.open = false; this.emit('close'); } this._useRelay(); };
    dc.onerror = () => { };
  }

  async _onSignal(data) {
    if (!data) return;
    if (!this.pc && (data.sdp || data.ice)) this._createPeer(false);
    if (!this.pc) return;
    try {
      if (data.sdp) {
        const desc = data.sdp;
        if (desc.type === 'offer') {
          if (this.pc.signalingState !== 'stable') return;
          await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.net.send({ t: 'signal', to: this.peerId, data: { sdp: this.pc.localDescription } });
        } else if (desc.type === 'answer') {
          if (this.pc.signalingState === 'have-local-offer') await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
        }
      } else if (data.ice) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(new RTCIceCandidate(data.ice));
        else this._iceCandidateQueue.push(data.ice);
      }
      while (this._iceCandidateQueue.length && this.pc.remoteDescription) {
        await this.pc.addIceCandidate(new RTCIceCandidate(this._iceCandidateQueue.shift()));
      }
    } catch (e) { /* 单个候选失败不影响整体 */ }
  }

  _useRelay() {
    if (this.mode === 'relay' && this._relayActive) return;
    this._relayActive = true;
    this.mode = 'relay';
    this.open = true;
    clearTimeout(this._p2pTimer);
    this.emit('mode', 'relay');
    this.emit('open');
    for (const m of this._pendingOut || []) this.send(m);
    this._pendingOut = [];
    // 中继心跳
    this._stopRelayLoop();
    this._relayTimer = setInterval(() => { this.net.send({ t: 'relay', to: this.peerId, data: { t: '__hb', ts: Date.now() } }); }, 4000);
    this._relayTimeoutCheck = setInterval(() => {
      if (Date.now() - this.lastSeen > 15000) { this.open = false; this.emit('close'); this.close(); }
    }, 5000);
  }
  _stopRelayLoop() {
    if (this._relayTimer) { clearInterval(this._relayTimer); this._relayTimer = null; }
    if (this._relayTimeoutCheck) { clearInterval(this._relayTimeoutCheck); this._relayTimeoutCheck = null; }
  }

  send(data) {
    if (!this.open) { (this._pendingOut = this._pendingOut || []).push(data); return false; }
    if (this.mode === 'p2p' && this.channel && this.channel.readyState === 'open') {
      try { this.channel.send(JSON.stringify(data)); return true; } catch { this._useRelay(); }
    }
    return this.net.send({ t: 'relay', to: this.peerId, data });
  }

  close() {
    this.open = false;
    this._stopRelayLoop();
    clearTimeout(this._p2pTimer);
    try { this.channel?.close(); } catch { }
    try { this.pc?.close(); } catch { }
    this.channel = null; this.pc = null;
  }
}

/* ================================================================== 连接管理 */
/** 按需建立/回收与各玩家的 PeerLink */
export class PeerManager extends Emitter {
  constructor(net, selfId) {
    super();
    this.net = net;
    this.selfId = selfId;
    this.links = new Map();
  }
  /** 确保存在到 peerId 的连接（id 小的一方发起） */
  ensure(peerId) {
    let link = this.links.get(peerId);
    if (link) return link;
    const initiator = String(this.selfId) < String(peerId);
    link = new PeerLink(this.net, peerId, initiator);
    this.links.set(peerId, link);
    link.on('data', (d) => this.emit('data', { from: peerId, data: d }));
    link.on('open', () => this.emit('open', peerId));
    link.on('close', () => this.emit('close', peerId));
    link.on('mode', (m) => this.emit('mode', { peerId, mode: m }));
    return link;
  }
  send(peerId, data) { return this.ensure(peerId).send(data); }
  broadcast(data) {
    let n = 0;
    for (const [id, link] of this.links) { if (link.send(data)) n++; }
    return n;
  }
  drop(peerId) {
    const l = this.links.get(peerId);
    if (l) { l.close(); this.links.delete(peerId); this.emit('close', peerId); }
  }
  close() { for (const id of [...this.links.keys()]) this.drop(id); }
  get modes() { const o = {}; for (const [id, l] of this.links) o[id] = l.mode; return o; }
}
