/* 服务器测试：起一个本地服务器，用 10 个模拟玩家连上去随机操作，
 * 同时检查快照格式、死亡复活、限流、异常输入和断线清理。
 * 运行：node test/server.test.js
 */
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT, WS_URL = 'ws://127.0.0.1:' + PORT + '/ws';
const MAX_HUMANS = 10, PER_IP = 13, WORLD = 6000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); }
}

/* ---------- 快照解码（与前端一致） ---------- */
function decodeSnap(buf) {
  let o = 0;
  assert.equal(buf.readUInt8(o), 1, '快照类型错误'); o += 1;
  const adds = [], dels = [], cells = [], ejects = [], viruses = [];
  let n = buf.readUInt16LE(o); o += 2;
  for (let i = 0; i < n; i++) { adds.push({ id: buf.readUInt32LE(o), x: buf.readUInt16LE(o + 4) / 10, y: buf.readUInt16LE(o + 6) / 10, ci: buf.readUInt8(o + 8), m: buf.readUInt8(o + 9) }); o += 10; }
  n = buf.readUInt16LE(o); o += 2;
  for (let i = 0; i < n; i++) { dels.push(buf.readUInt32LE(o)); o += 4; }
  n = buf.readUInt16LE(o); o += 2;
  for (let i = 0; i < n; i++) { cells.push({ id: buf.readUInt32LE(o), owner: buf.readUInt32LE(o + 4), x: buf.readUInt16LE(o + 8) / 10, y: buf.readUInt16LE(o + 10) / 10, r: buf.readUInt16LE(o + 12) / 10 }); o += 14; }
  n = buf.readUInt16LE(o); o += 2;
  for (let i = 0; i < n; i++) { ejects.push({ id: buf.readUInt32LE(o), x: buf.readUInt16LE(o + 4) / 10, y: buf.readUInt16LE(o + 6) / 10, skin: buf.readUInt8(o + 8) }); o += 9; }
  n = buf.readUInt16LE(o); o += 2;
  for (let i = 0; i < n; i++) { viruses.push({ id: buf.readUInt32LE(o), x: buf.readUInt16LE(o + 4) / 10, y: buf.readUInt16LE(o + 6) / 10, r: buf.readUInt16LE(o + 8) / 10, feed: buf.readUInt8(o + 10) }); o += 11; }
  assert.equal(o, buf.length, '快照长度对不上');
  return { adds, dels, cells, ejects, viruses };
}

/* ---------- 模拟玩家 ---------- */
class Client {
  constructor(name) { this.name = name; this.msgs = []; this.snaps = 0; this.errors = []; this.foods = new Map(); this.players = new Map(); this.myCells = []; this.alive = false; this.closedCode = null; this.missingOwner = 0; }
  connect() {
    return new Promise(res => {
      const ws = new WebSocket(WS_URL); this.ws = ws;
      ws.on('open', () => res(this));
      ws.on('error', e => this.errors.push('socket: ' + e.message));
      ws.on('close', code => { this.closedCode = code; res(this); });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return this.onSnap(data);
        let m; try { m = JSON.parse(data.toString()); } catch (e) { this.errors.push('bad json'); return; }
        this.msgs.push(m);
        if (m.t === 'w') { this.id = m.id; this.alive = true; for (let i = 0; i < m.f.length; i += 5) this.foods.set(m.f[i], 1); for (const r of m.pl) this.players.set(r[0], r); }
        if (m.t === 'pl') { for (const r of m.a) this.players.set(r[0], r); for (const id of m.d) this.players.delete(id); }
        if (m.t === 'dead') this.alive = false;
        if (m.t === 'sp') this.alive = true;
        if (m.t === 'lb') this.lb = m;
      });
    });
  }
  onSnap(buf) {
    try {
      const s = decodeSnap(buf); this.snaps++;
      for (const a of s.adds) this.foods.set(a.id, 1);
      for (const d of s.dels) this.foods.delete(d);
      for (const c of s.cells) {
        if (!(c.x >= 0 && c.x <= WORLD && c.y >= 0 && c.y <= WORLD && c.r > 0)) this.errors.push('坐标异常 ' + JSON.stringify(c));
        if (!this.players.has(c.owner)) this.missingOwner++;
      }
      this.myCells = s.cells.filter(c => c.owner === this.id);
    } catch (e) { this.errors.push('解码失败: ' + e.message); }
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  waitMsg(pred, ms = 5000, since) {
    const start = since == null ? this.msgs.length : since;
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = this.msgs.slice(start).find(pred);
        if (m) { clearInterval(iv); res(m); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(this.name + ' 等待消息超时')); }
      }, 20);
    });
  }
  waitClose(ms = 3000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => { if (this.closedCode !== null) { clearInterval(iv); res(this.closedCode); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(this.name + ' 没有被断开')); } }, 20);
    });
  }
  center() { let x = 0, y = 0, m = 0; for (const c of this.myCells) { const w = c.r * c.r; x += c.x * w; y += c.y * w; m += w; } return m ? { x: x / m, y: y / m } : null; }
  close() { try { this.ws.close(); } catch (e) {} }
}
const status = async () => (await fetch(BASE + '/status')).json();

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TEST_HOOKS: '1', MAX_HUMANS: String(MAX_HUMANS), PER_IP: String(PER_IP) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvErr = '', exited = null;
  srv.stderr.on('data', d => { srvErr += d; });
  srv.on('exit', c => { exited = c; });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch (e) {} await sleep(100); }

  console.log('HTTP');
  await test('健康检查、状态接口、静态文件、跨域头', async () => {
    const h = await fetch(BASE + '/healthz');
    assert.equal(h.status, 200); assert.equal(await h.text(), 'ok'); assert.equal(h.headers.get('access-control-allow-origin'), '*');
    const s = await status(); assert.equal(s.humans, 0); assert.ok(s.v);
    const i = await fetch(BASE + '/'); assert.equal(i.status, 200); assert.match(i.headers.get('content-type'), /text\/html/);
    assert.match(await i.text(), /吞吞大乱斗/);
    const j = await fetch(BASE + '/sim.js'); assert.equal(j.status, 200); assert.match(j.headers.get('content-type'), /javascript/);
  });
  await test('不能越权读取服务器文件，不接受 POST', async () => {
    for (const u of ['/%2e%2e/package.json', '/..%2fserver/server.js', '/%2e%2e%2f%2e%2e%2fetc/passwd']) {
      const r = await fetch(BASE + u); assert.notEqual(r.status, 200, u + ' 不应返回 200');
    }
    const p = await fetch(BASE + '/', { method: 'POST' }); assert.equal(p.status, 405);
  });

  console.log('加入大厅');
  const cs = [];
  await test('10 个玩家同时加入，都收到完整的初始数据', async () => {
    for (let i = 0; i < MAX_HUMANS; i++) cs.push(await new Client('玩家' + i).connect());
    cs.forEach((c, i) => c.send({ t: 'join', name: i === 0 ? '<b>坏人</b>\u0007名字特别特别长长长长' : '玩家' + i, skin: i }));
    await Promise.all(cs.map(c => c.waitMsg(m => m.t === 'w')));
    for (const c of cs) {
      assert.ok(c.id > 0);
      assert.ok(c.foods.size >= 1400 && c.foods.size <= 1500, '初始豆子数量 ' + c.foods.size);
    }
    await sleep(300); // 比你晚加入的玩家会在下一次推送（约 50ms 内）送达
    const last = cs[cs.length - 1];
    for (const c of cs) assert.ok(last.players.has(c.id), '玩家列表里缺少 ' + c.name);
    const bots = [...last.players.values()].filter(r => r[3]).length;
    assert.ok(bots >= 6, 'AI 数量不应低于 6，实际 ' + bots);
    assert.equal((await status()).humans, MAX_HUMANS);
  });
  await test('昵称里的尖括号、控制字符被去掉，长度不超过 12', async () => {
    const row = cs[1].players.get(cs[0].id);
    assert.ok(row, '找不到玩家 0');
    assert.ok(!/[<>\u0000-\u001f]/.test(row[1]), '昵称未过滤: ' + row[1]);
    assert.ok([...row[1]].length <= 12);
  });
  await test('排行榜显示 10 个真人', async () => {
    await cs[0].waitMsg(m => m.t === 'lb', 2500);
    assert.equal(cs[0].lb.h, MAX_HUMANS);
  });

  console.log('吃人、死亡、复活');
  await test('大的真人吃掉小的真人：被吃方收到死亡信息，吃方记一次击败', async () => {
    const [a, b] = cs;
    const sinceA = a.msgs.length;
    a.send({ t: 'dbg', mass: 3000, x: 3000, y: 3000 });
    // 等大球就位后再放小球，避免小球先到被附近的 AI 抢先吃掉
    for (let i = 0; i < 100 && !a.myCells.some(c => c.r > 200); i++) await sleep(20);
    b.send({ t: 'dbg', mass: 20, x: 3000, y: 3000 });
    const dead = await b.waitMsg(m => m.t === 'dead', 3000);
    assert.ok(dead.k.length > 0, '应包含吃掉你的人的名字');
    const f = await a.waitMsg(m => m.t === 'feed' && m.k === 'good', 3000, sinceA);
    assert.match(f.m, /玩家1/);
  });
  await test('被吃后点再来一局能复活，并重新看到自己的球', async () => {
    const b = cs[1];
    b.send({ t: 're' });
    await b.waitMsg(m => m.t === 'sp', 3000);
    await sleep(300);
    assert.equal(b.alive, true);
    assert.equal(b.myCells.length, 1);
  });

  console.log('连接限制与异常输入');
  await test('人满后新玩家收到"已满"，同一 IP 连接数有上限', async () => {
    const idle = [];
    for (let i = 0; i < PER_IP - MAX_HUMANS; i++) idle.push(await new Client('旁观' + i).connect());
    await sleep(200);
    assert.ok(idle.every(c => c.closedCode === null), '上限以内的连接不应被断开');
    const over = await new Client('超出').connect();
    assert.equal(await over.waitClose(), 1008);
    idle[0].send({ t: 'join', name: '迟到的人', skin: 0 });
    const m = await idle[0].waitMsg(x => x.t === 'full', 2000);
    assert.equal(m.max, MAX_HUMANS);
    for (const c of idle) c.close();
    await sleep(300);
  });
  await test('乱发的消息不会让服务器出错，连接照常工作', async () => {
    const c = cs[2], before = c.snaps;
    c.send('这不是 JSON'); c.send('{"t":5}'); c.send('null'); c.send('[]');
    c.send({ t: 'in', x: 'abc', y: null, vw: 1e9, vh: -5, e: 'yes' });
    c.send({ t: 'in', x: 1e12, y: -1e12 }); c.send({ t: 'sp' }); c.send({ t: 'unknown' }); c.send({ t: 'join', name: '二次加入' });
    await sleep(600);
    assert.equal(c.closedCode, null);
    assert.ok(c.snaps > before + 5, '快照应继续推送');
    assert.equal(exited, null, '服务器不应退出');
  });
  await test('超大消息会被断开', async () => {
    const c = await new Client('大包').connect();
    c.send('x'.repeat(5000));
    assert.equal(await c.waitClose(), 1009);
  });
  await test('刷消息会被断开', async () => {
    const c = await new Client('刷屏').connect();
    for (let i = 0; i < 200; i++) c.send({ t: 'ping', c: i });
    assert.equal(await c.waitClose(), 1008);
    await sleep(200);
  });

  console.log('10 人随机混战 25 秒');
  await test('快照格式始终正确、豆子同步一致、没有未知玩家', async () => {
    for (const c of cs) { c.snaps = 0; c.errors.length = 0; c.missingOwner = 0; }
    const t0 = Date.now();
    let tick = 0;
    while (Date.now() - t0 < 25000) {
      tick++;
      for (const c of cs) {
        if (!c.alive) { if (Math.random() < 0.05) c.send({ t: 're' }); continue; }
        const ctr = c.center() || { x: 3000, y: 3000 };
        if (!c.goal || tick % 40 === 0) c.goal = { x: Math.random() * WORLD, y: Math.random() * WORLD };
        c.send({ t: 'in', x: Math.round(c.goal.x), y: Math.round(c.goal.y), vw: 900 + Math.round(Math.random() * 600), vh: 600, e: Math.random() < 0.06 ? 1 : 0 });
        if (Math.random() < 0.01) c.send({ t: 'sp' });
        void ctr;
      }
      await sleep(50);
    }
    const st = await status();
    for (const c of cs) {
      assert.deepEqual(c.errors, [], c.name + ' 出错');
      assert.equal(c.closedCode, null, c.name + ' 被意外断开');
      assert.ok(c.snaps >= 25 * 20 * 0.8, c.name + ' 只收到 ' + c.snaps + ' 个快照（应约 500）');
      assert.equal(c.missingOwner, 0, c.name + ' 收到未知玩家的球');
      assert.ok(c.foods.size >= 1400 && c.foods.size <= 1500, c.name + ' 豆子数量漂移到 ' + c.foods.size);
    }
    const sizes = cs.map(c => c.foods.size);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 40, '各客户端豆子数量不一致 ' + sizes.join(','));
    assert.equal(st.humans, MAX_HUMANS);
  });

  console.log('断线清理与资源');
  await test('玩家离开后人数正确减少，AI 会补回', async () => {
    for (const c of cs.slice(5)) c.close();
    await sleep(600);
    assert.equal((await status()).humans, 5);
    await cs[0].waitMsg(m => m.t === 'lb', 2500);
    await sleep(1100);
    assert.equal(cs[0].lb.h, 5);
  });
  await test('服务器没有报错、没有退出，内存正常', async () => {
    const rss = Number((fs.readFileSync('/proc/' + srv.pid + '/status', 'utf8').match(/VmRSS:\s+(\d+)/) || [])[1] || 0) / 1024;
    console.log('    服务器内存 ' + rss.toFixed(0) + ' MB');
    assert.equal(exited, null);
    assert.equal(srvErr.trim(), '', '服务器输出了错误: ' + srvErr);
    assert.ok(rss < 200, '内存占用过高');
  });
  await test('所有人离开后大厅清空', async () => {
    for (const c of cs.slice(0, 5)) c.close();
    await sleep(600);
    assert.equal((await status()).humans, 0);
  });

  srv.kill();
  console.log('\n' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
