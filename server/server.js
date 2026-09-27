/* 吞吞大乱斗 · 联机服务器
 * - 静态托管 public/ 目录（index.html、sim.js）
 * - WebSocket（/ws）：服务器权威模拟，20Hz 二进制快照，豆子增量同步
 * - 人少时自动补 AI，人多时减少 AI
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const S = require('../public/sim.js');
const VERSION = require('../package.json').version;

const PORT = Number(process.env.PORT) || 8080;
const PUB = path.join(__dirname, '..', 'public');
const MAX_HUMANS = Number(process.env.MAX_HUMANS) || 40;
const TOTAL_TARGET = 22;     // 真人 + AI 的目标总数
const MIN_BOTS = 6;          // 至少保留的 AI 数量
const PER_IP = Number(process.env.PER_IP) || 6; // 单个 IP 最多连接数
const TICK_MS = 25;          // 物理 40Hz
const SNAP_EVERY = 2;        // 快照 20Hz
const LB_EVERY = 40;         // 排行榜 1Hz
const WORLD = S.C.WORLD;

/* ---------------- 世界与事件 ---------------- */
const pendingPlayers = new Map();
const pendingDels = [];
const clients = new Set();

const world = S.createWorld({
  bots: TOTAL_TARGET,
  trackFood: true,
  hooks: {
    playerAdded(p) { pendingPlayers.set(p.id, p); },
    playerChanged(p) { pendingPlayers.set(p.id, p); },
    playerRemoved(p) { pendingPlayers.delete(p.id); pendingDels.push(p.id); },
    died(v, k) {
      if (v.conn) {
        sendJSON(v.conn, { t: 'dead', k: k && k !== v ? k.name : '', max: Math.floor(v.maxMass), kills: v.kills, secs: Math.floor(world.T - v.bornAt), best: v.bestRank < 99 ? v.bestRank : 0 });
      }
      if (k && k !== v && k.conn) sendJSON(k.conn, { t: 'feed', m: '你吞掉了「' + v.name + '」', k: 'good' });
    }
  }
});

function humansCount() { let n = 0; for (const p of world.players) if (!p.isBot) n++; return n; }
function updateBots() { world.setBotTarget(Math.max(MIN_BOTS, TOTAL_TARGET - humansCount())); }
function playerRow(p) { return [p.id, p.name, p.skin, p.isBot ? 1 : 0]; }

/* ---------------- 发送工具 ---------------- */
function sendJSON(cl, obj) { if (cl.ws.readyState === 1) cl.ws.send(JSON.stringify(obj)); }
const u16 = v => Math.max(0, Math.min(65535, Math.round(v)));

function foodDeltaBuffer() {
  const adds = world.foodAdds, dels = world.foodDels;
  const na = Math.min(adds.length, 65535), nd = Math.min(dels.length, 65535);
  const buf = Buffer.allocUnsafe(4 + na * 10 + nd * 4);
  let o = buf.writeUInt16LE(na, 0);
  for (let i = 0; i < na; i++) {
    const f = adds[i];
    o = buf.writeUInt32LE(f.id, o); o = buf.writeUInt16LE(u16(f.x * 10), o); o = buf.writeUInt16LE(u16(f.y * 10), o);
    o = buf.writeUInt8(f.ci, o); o = buf.writeUInt8(f.mass, o);
  }
  o = buf.writeUInt16LE(nd, o);
  for (let i = 0; i < nd; i++) o = buf.writeUInt32LE(dels[i], o);
  adds.length = 0; dels.length = 0;
  return buf;
}

function snapshotFor(cl, foodPart) {
  const p = cl.p;
  if (p && p.alive) { const c = world.centerOf(p); if (c) { cl.cx = c.x; cl.cy = c.y; } }
  const hw = cl.vw + 250, hh = cl.vh + 250, cx = cl.cx, cy = cl.cy;
  const vc = [], ve = [], vv = [];
  for (const c of world.cells) { if (c.dead) continue; if (Math.abs(c.x - cx) < hw + c.r && Math.abs(c.y - cy) < hh + c.r) vc.push(c); }
  for (const e of world.ejects) { if (e.dead) continue; if (Math.abs(e.x - cx) < hw && Math.abs(e.y - cy) < hh) ve.push(e); }
  for (const v of world.viruses) { if (v.dead) continue; if (Math.abs(v.x - cx) < hw + v.r && Math.abs(v.y - cy) < hh + v.r) vv.push(v); }
  const nc = Math.min(vc.length, 65535), ne = Math.min(ve.length, 65535), nv = Math.min(vv.length, 65535);
  const buf = Buffer.allocUnsafe(1 + foodPart.length + 2 + nc * 14 + 2 + ne * 9 + 2 + nv * 11);
  let o = buf.writeUInt8(1, 0);
  o += foodPart.copy(buf, o);
  o = buf.writeUInt16LE(nc, o);
  for (let i = 0; i < nc; i++) {
    const c = vc[i];
    o = buf.writeUInt32LE(c.id, o); o = buf.writeUInt32LE(c.owner.id, o);
    o = buf.writeUInt16LE(u16(c.x * 10), o); o = buf.writeUInt16LE(u16(c.y * 10), o); o = buf.writeUInt16LE(u16(c.r * 10), o);
  }
  o = buf.writeUInt16LE(ne, o);
  for (let i = 0; i < ne; i++) {
    const e = ve[i];
    o = buf.writeUInt32LE(e.id, o); o = buf.writeUInt16LE(u16(e.x * 10), o); o = buf.writeUInt16LE(u16(e.y * 10), o); o = buf.writeUInt8(e.skin & 255, o);
  }
  o = buf.writeUInt16LE(nv, o);
  for (let i = 0; i < nv; i++) {
    const v = vv[i];
    o = buf.writeUInt32LE(v.id, o); o = buf.writeUInt16LE(u16(v.x * 10), o); o = buf.writeUInt16LE(u16(v.y * 10), o);
    o = buf.writeUInt16LE(u16(v.r * 10), o); o = buf.writeUInt8(Math.min(255, v.feed), o);
  }
  return buf;
}

function broadcast() {
  if (pendingPlayers.size || pendingDels.length) {
    const msg = JSON.stringify({ t: 'pl', a: [...pendingPlayers.values()].map(playerRow), d: pendingDels.splice(0) });
    pendingPlayers.clear();
    for (const cl of clients) if (cl.p && cl.ws.readyState === 1) cl.ws.send(msg);
  }
  const foodPart = foodDeltaBuffer();
  for (const cl of clients) {
    if (!cl.p || cl.ws.readyState !== 1) continue;
    if (cl.ws.bufferedAmount > 512 * 1024) continue; // 网络太慢的客户端跳过这一帧
    cl.ws.send(snapshotFor(cl, foodPart));
  }
}

function sendLeaderboards() {
  const rank = world.ranking();
  const top = rank.slice(0, 10).map(x => [x.p.id, Math.floor(x.m)]);
  const humans = humansCount();
  rank.forEach((x, i) => { if (!x.p.isBot && i + 1 < x.p.bestRank) x.p.bestRank = i + 1; });
  const pos = new Map(); rank.forEach((x, i) => pos.set(x.p, i + 1));
  for (const cl of clients) {
    if (!cl.p) continue;
    sendJSON(cl, { t: 'lb', top, r: pos.get(cl.p) || 0, n: rank.length, h: humans });
  }
}

/* ---------------- HTTP ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (pathname === '/healthz') { res.writeHead(200, { ...cors, 'content-type': 'text/plain' }); return res.end('ok'); }
  if (pathname === '/status') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ humans: humansCount(), max: MAX_HUMANS, players: world.players.length, v: VERSION }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUB, rel);
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });
const ipCount = new Map();
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if ((ipCount.get(ip) || 0) >= PER_IP) { ws.close(1008, 'too many connections'); return; }
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  const cl = { ws, ip, p: null, vw: 1000, vh: 700, cx: WORLD / 2, cy: WORLD / 2, msgs: 0, winStart: Date.now(), alive: true };
  clients.add(cl);
  ws.on('pong', () => { cl.alive = true; });

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - cl.winStart > 1000) { cl.winStart = now; cl.msgs = 0; }
    if (++cl.msgs > 120) { ws.close(1008, 'rate limit'); return; }
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const p = cl.p;
    switch (m.t) {
      case 'join': {
        if (p) return;
        if (humansCount() >= MAX_HUMANS) { sendJSON(cl, { t: 'full', max: MAX_HUMANS }); ws.close(); return; }
        const name = String(m.name || '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').trim().slice(0, 12) || '无名小球';
        const skin = Math.max(0, Math.min(S.C.SKINS - 1, num(m.skin, 0) | 0));
        const np = world.addPlayer(name, skin, false);
        np.conn = cl; cl.p = np;
        world.spawn(np, S.C.START_MASS); np.maxMass = S.C.START_MASS; np.bestRank = 99;
        const c = np.cells[0]; cl.cx = c.x; cl.cy = c.y;
        const f = []; for (const fd of world.foods) if (!fd.dead) f.push(fd.id, Math.round(fd.x * 10), Math.round(fd.y * 10), fd.ci, fd.mass);
        sendJSON(cl, { t: 'w', id: np.id, world: WORLD, f, pl: world.players.map(playerRow) });
        updateBots();
        break;
      }
      case 'in': {
        if (!p) return;
        cl.vw = Math.max(300, Math.min(2600, num(m.vw, cl.vw)));
        cl.vh = Math.max(300, Math.min(2600, num(m.vh, cl.vh)));
        if (!p.alive) return;
        p.tx = Math.max(0, Math.min(WORLD, num(m.x, p.tx)));
        p.ty = Math.max(0, Math.min(WORLD, num(m.y, p.ty)));
        const c = world.centerOf(p);
        if (c) { const dx = p.tx - c.x, dy = p.ty - c.y, d = Math.hypot(dx, dy); if (d > 6) { p.lastDx = dx / d; p.lastDy = dy / d; } }
        const e = !!m.e; if (e !== p.ejecting) { p.ejecting = e; p.ejectT = 0; }
        break;
      }
      case 'sp': if (p && p.alive) world.split(p); break;
      case 're': {
        if (!p || p.alive) return;
        p.kills = 0; p.maxMass = S.C.START_MASS; p.bestRank = 99;
        world.spawn(p, S.C.START_MASS);
        const c = p.cells[0]; cl.cx = c.x; cl.cy = c.y;
        sendJSON(cl, { t: 'sp' });
        break;
      }
      case 'ping': sendJSON(cl, { t: 'pong', c: num(m.c, 0) }); break;
      case 'dbg': // 仅本地测试用（TEST_HOOKS=1），线上不会开启
        if (process.env.TEST_HOOKS === '1' && p && p.alive) {
          const c = world.biggest(p);
          if (c) { c.mass = num(m.mass, c.mass); c.r = S.rad(c.mass); c.x = num(m.x, c.x); c.y = num(m.y, c.y); }
        }
        break;
    }
  });

  const cleanup = () => {
    if (!clients.has(cl)) return;
    clients.delete(cl);
    const n = (ipCount.get(ip) || 1) - 1; if (n > 0) ipCount.set(ip, n); else ipCount.delete(ip);
    if (cl.p) { world.removePlayer(cl.p); cl.p.conn = null; cl.p = null; updateBots(); }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// 心跳：清理掉线的连接
setInterval(() => {
  for (const cl of clients) {
    if (!cl.alive) { cl.ws.terminate(); continue; }
    cl.alive = false; try { cl.ws.ping(); } catch (e) {}
  }
}, 20000);

/* ---------------- 主循环 ---------------- */
let last = process.hrtime.bigint(), tick = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9; last = now;
  if (dt > 0.1) dt = 0.1;
  if (clients.size === 0) { world.foodAdds.length = 0; world.foodDels.length = 0; return; } // 没人时暂停，省资源
  world.step(dt);
  tick++;
  if (tick % SNAP_EVERY === 0) broadcast();
  if (tick % LB_EVERY === 0) sendLeaderboards();
}, TICK_MS);

server.listen(PORT, () => console.log('吞吞大乱斗服务器已启动，端口 ' + PORT));
