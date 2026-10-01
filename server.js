// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Hotsteel2901
/**
 * 极简静态服务器（零依赖）+ WebSocket 联机端点（/ws）
 * 用法：node server.js [port]
 * 说明：浏览器对 ES Module 有同源限制，直接双击 index.html 无法加载模块，
 *       必须通过 HTTP 打开。联机大厅挂在同一个 HTTP 服务器的 upgrade 事件上，
 *       客户端连接 ws://<host>:<port>/ws 即可（协议实现见 src/net/wsserver.js）。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WSServer, LobbyServer } from './src/net/wsserver.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ── 联机：WebSocket 服务器 + 大厅 ────────────────────────────────────────────
const log = (...args) => console.log(...args);
const wss = new WSServer({ maxPayload: 512 * 1024, heartbeatMs: 30000, log });
const lobby = new LobbyServer({ maxRooms: 200, maxPlayersPerRoom: 8, idleTimeoutMs: 120000, log });
lobby.attach(wss);

// 连接/断开日志（异常输入只记录并关闭该连接，绝不影响服务器）
wss.on('connection', (ws) => {
  log(`[ws] 连接 ${ws.id} (${ws.remoteAddress})  当前 ${lobby.stats.players} 名玩家 / ${lobby.stats.rooms} 个房间`);
});
wss.on('close', (ws) => {
  log(`[ws] 断开 ${ws.id}  剩余 ${lobby.stats.players} 名玩家 / ${lobby.stats.rooms} 个房间`);
});

// 大厅事件日志
lobby.on('room-created', (r) => log(`[大厅] 创建房间 ${r.id} "${r.name}" (${r.privacy}, ${r.players}/${r.maxPlayers})`));
lobby.on('room-joined', ({ room, player }) => log(`[大厅] 加入房间 ${room.id} "${room.name}" ← ${player.name} (${room.players}/${room.maxPlayers})`));
lobby.on('room-left', ({ roomId, name, reason }) => log(`[大厅] 离开房间 ${roomId} ← ${name} (${reason})`));
lobby.on('host-changed', ({ roomId, hostId }) => log(`[大厅] 房间 ${roomId} 主机迁移 → ${hostId}`));
lobby.on('room-closed', ({ roomId, reason }) => log(`[大厅] 关闭房间 ${roomId} (${reason})`));

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const target = normalize(join(ROOT, urlPath));
    if (!target.startsWith(ROOT + sep) && target !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const st = await stat(target).catch(() => null);
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + urlPath);
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
  }
});

// 只接管 /ws，其它 upgrade 请求直接拒绝
server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!wss.handleUpgrade(req, socket, head)) {
    log(`[ws] 握手失败 (${req.socket?.remoteAddress || '?'})`);
  }
});

// 任何未捕获异常都不应该让联机服务器崩掉
process.on('uncaughtException', (e) => log('[错误] 未捕获异常:', e?.stack || e));
process.on('unhandledRejection', (e) => log('[错误] 未处理的 Promise 拒绝:', e));

server.listen(PORT, () => {
  const { rooms, players } = lobby.stats;
  console.log(`\n  SimplePlanes 2 (three.js) 已启动`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
  console.log(`  静态根目录: ${ROOT}`);
  console.log(`  联机端点:   ws://localhost:${PORT}/ws`);
  console.log(`  在线大厅:   ${rooms} 个房间 / ${players} 名玩家\n`);
});
