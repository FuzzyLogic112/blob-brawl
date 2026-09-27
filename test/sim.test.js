/* 规则测试 + 长时间随机模拟稳定性测试：node test/sim.test.js */
'use strict';
const assert = require('node:assert/strict');
const S = require('../public/sim.js');
const C = S.C;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); }
}

/* 干净的对战场地：没有 AI，豆子和刺球都挪到角落，避免干扰 */
function arena(hooks) {
  const w = S.createWorld({ bots: 0, hooks });
  for (const v of w.viruses) { v.x = 150; v.y = 150; }
  for (const f of w.foods) { f.x = 5900; f.y = 5900; }
  return w;
}
function place(w, p, mass, x, y) {
  w.spawn(p, mass);
  const c = p.cells[0]; c.x = x; c.y = y; c.rd = c.r; p.tx = x; p.ty = y;
  return c;
}
const tick = (w, n = 1, dt = 0.001) => { for (let i = 0; i < n; i++) w.step(dt); };

console.log('吞噬规则');
test('大 18%：能吃掉对方，并记为击败', () => {
  const kills = [];
  const w = arena({ died: (v, k) => kills.push([v.name, k && k.name]) });
  const a = w.addPlayer('A', 0, false), b = w.addPlayer('B', 1, false);
  place(w, a, 118, 3000, 3000); place(w, b, 100, 3000, 3000);
  tick(w);
  assert.equal(b.alive, false);
  assert.ok(Math.abs(w.massOf(a) - 218) < 0.5);
  assert.deepEqual(kills, [['B', 'A']]);
  assert.equal(a.kills, 1);
});
test('只大 12%：吃不掉，两个都活着', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false), b = w.addPlayer('B', 1, false);
  place(w, a, 112, 3000, 3000); place(w, b, 100, 3000, 3000);
  tick(w, 5);
  assert.equal(a.alive, true); assert.equal(b.alive, true);
});
test('必须罩住对方大半个身子才算吃到', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false), b = w.addPlayer('B', 1, false);
  const ca = place(w, a, 400, 3000, 3000);
  const cb = place(w, b, 100, 3000, 3000);
  const limit = ca.r - cb.r * C.EAT_OVERLAP;
  cb.x = 3000 + limit + 6; b.tx = cb.x; tick(w);
  assert.equal(b.alive, true, '只碰到边缘时不应被吃');
  cb.x = 3000 + limit - 6; b.tx = cb.x; tick(w);
  assert.equal(b.alive, false, '罩住后应被吃');
});
test('分身后按单个球比较：总质量够但每块不够，吃不掉', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false), b = w.addPlayer('B', 1, false);
  place(w, a, 230, 3000, 3000);
  a.tx = 3500; a.ty = 3000; assert.ok(w.split(a));
  assert.equal(a.cells.length, 2);
  for (const c of a.cells) { c.bx = c.by = 0; }
  const piece = a.cells[1];
  place(w, b, 110, piece.x, piece.y);
  a.tx = piece.x; a.ty = piece.y;
  tick(w, 3);
  assert.equal(b.alive, true);
  assert.equal(a.alive, true);
});
test('被吃掉的最后一个球会让玩家死亡，其他球还在就不算死', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false), b = w.addPlayer('B', 1, false);
  place(w, b, 200, 2000, 3000);
  b.tx = 2600; b.ty = 3000; w.split(b);
  for (const c of b.cells) { c.bx = c.by = 0; }
  const [c1, c2] = b.cells; c2.x = 4000; c2.y = 3000;
  place(w, a, 300, c1.x, c1.y);
  tick(w);
  assert.equal(b.alive, true, '还剩一块，不算死');
  assert.equal(b.cells.length, 1);
});

console.log('刺球、吐球、合体');
test('大球撞上刺球会炸成多块', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false);
  const v = w.viruses[0]; v.x = 3000; v.y = 3000;
  place(w, a, 300, 3000, 3000);
  const before = w.viruses.length;
  tick(w);
  assert.ok(a.cells.length > 4, '应炸成多块，实际 ' + a.cells.length);
  assert.ok(w.viruses.length <= before, '刺球应被吃掉');
  assert.ok(Math.abs(w.massOf(a) - 400) < 1, '质量守恒');
});
test('小球可以躲在刺球下面', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false);
  const v = w.viruses[0]; v.x = 3000; v.y = 3000;
  place(w, a, 60, 3000, 3000);
  tick(w, 5);
  assert.equal(a.cells.length, 1);
  assert.ok(w.viruses.some(x => x.x === 3000 && x.y === 3000));
});
test('吐球扣质量，吐出的球能被别人吃掉', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false), b = w.addPlayer('B', 1, false);
  place(w, a, 100, 3000, 3000); a.tx = 3400; a.ty = 3000;
  w.eject(a);
  assert.equal(Math.round(w.massOf(a)), 100 - C.EJECT_COST);
  assert.equal(w.ejects.length, 1);
  const e = w.ejects[0]; e.vx = e.vy = 0;
  place(w, b, 60, e.x, e.y);
  tick(w);
  assert.equal(w.ejects.length, 0);
  assert.ok(w.massOf(b) > 60 + C.EJECT_MASS - 0.5);
});
test('往刺球里吐 7 次会射出新刺球', () => {
  const w = arena();
  const v = w.viruses[0]; v.x = 3000; v.y = 3000;
  const n0 = w.viruses.length;
  const a = w.addPlayer('A', 0, false); place(w, a, 50, 5000, 5000);
  for (let i = 0; i < C.VIRUS_FEED; i++) {
    w.ejects.push({ id: 90000 + i, x: 3000, y: 3000, vx: 500, vy: 0, mass: C.EJECT_MASS, r: 13, skin: 0, owner: a, born: 0, e: true, dead: false });
    tick(w);
  }
  assert.equal(w.viruses.length, n0 + 1);
});
test('分身后过一段时间会自动合体', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false);
  place(w, a, 200, 3000, 3000); a.tx = 3500; a.ty = 3000;
  w.split(a); assert.equal(a.cells.length, 2);
  for (let i = 0; i < 40 * 30; i++) { const c = w.centerOf(a); a.tx = c.x; a.ty = c.y; w.step(1 / 40); if (a.cells.length === 1) break; }
  assert.equal(a.cells.length, 1, '30 秒内应合体');
});
test('最多 16 块', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false);
  place(w, a, 20000, 3000, 3000); a.tx = 3500; a.ty = 3000;
  for (let i = 0; i < 6; i++) { w.split(a); tick(w); }
  assert.equal(a.cells.length, C.MAX_CELLS);
});

test('自己的球挤在地图边上也不会被推出地图', () => {
  const w = arena();
  const a = w.addPlayer('A', 0, false);
  place(w, a, 4000, 30, 3000); a.tx = 0; a.ty = 3000;
  for (let i = 0; i < 4; i++) w.split(a);
  a.cells.forEach((c, i) => { c.x = c.r * .4 + i * 3; c.y = 3000; c.bx = c.by = 0; c.ghostUntil = 0; });
  a.tx = 0; a.ty = 3000; w.step(1 / 40);
  for (const c of a.cells) assert.ok(c.x >= 0 && c.x <= C.WORLD, '球被推出地图 x=' + c.x.toFixed(1));
});

console.log('AI 数量调整');
test('人多时 AI 只在死亡后移除，不会凭空消失；人少时逐个补回', () => {
  const died = new Set(); const removedAlive = [];
  const w = S.createWorld({ bots: 20, hooks: { died: v => died.add(v.id), playerRemoved: p => { if (!died.has(p.id)) removedAlive.push(p.name); } } });
  w.setBotTarget(6);
  for (let i = 0; i < 40 * 90; i++) w.step(1 / 40);
  assert.deepEqual(removedAlive, [], '有活着的 AI 被直接移除了');
  const bots = w.players.filter(p => p.isBot).length;
  assert.ok(bots < 20, '90 秒内应减少一些 AI，实际仍有 ' + bots);
  w.setBotTarget(20);
  for (let i = 0; i < 40; i++) w.step(1 / 40);
  assert.equal(w.players.filter(p => p.isBot).length, 20);
});

console.log('长时间随机模拟（3 分钟 × 3 局）');
test('坐标、质量、编号、归属始终合法', () => {
  let worst = 0;
  for (let round = 0; round < 3; round++) {
    const w = S.createWorld({ bots: 26 });
    const humans = [w.addPlayer('H1', 3, false), w.addPlayer('H2', 9, false)];
    for (const h of humans) w.spawn(h);
    for (let i = 0; i < 40 * 180; i++) {
      for (const h of humans) {
        if (!h.alive) { if (Math.random() < 0.02) w.spawn(h); continue; }
        if (i % 20 === 0) { h.tx = Math.random() * C.WORLD; h.ty = Math.random() * C.WORLD; }
        if (Math.random() < 0.004) w.split(h);
        h.ejecting = Math.random() < 0.05;
      }
      const t0 = process.hrtime.bigint();
      w.step(1 / 40);
      worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6);
      if (i % 100 !== 0) continue;
      const ids = new Set();
      for (const c of w.cells) {
        assert.ok(!c.dead, '列表里有已死亡的球');
        assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.mass), '出现非数字');
        assert.ok(c.x >= 0 && c.x <= C.WORLD && c.y >= 0 && c.y <= C.WORLD, '球跑出地图');
        assert.ok(c.mass > 0, '质量不为正');
        assert.ok(Math.abs(c.r - S.rad(c.mass)) < 1e-6, '半径与质量不一致');
        assert.ok(!ids.has(c.id), '球编号重复'); ids.add(c.id);
        assert.ok(c.owner.cells.includes(c), '球不在主人的列表里');
        assert.ok(w.players.includes(c.owner), '球的主人已不在场上');
      }
      for (const p of w.players) {
        assert.ok(p.cells.length <= C.MAX_CELLS, '超过 16 块');
        for (const c of p.cells) assert.ok(ids.has(c.id), '玩家列表里有不在场的球');
        assert.equal(p.alive, p.cells.length > 0, '存活状态与球数不一致');
      }
      assert.ok(w.foods.length >= C.FOOD_TARGET - 60 && w.foods.length <= C.FOOD_TARGET, '豆子数量异常 ' + w.foods.length);
      assert.ok(w.viruses.length <= 80, '刺球数量异常 ' + w.viruses.length);
      assert.ok(w.ejects.length <= 450);
      assert.equal(w.players.filter(p => p.isBot).length, 26);
    }
  }
  console.log('    单帧最慢 ' + worst.toFixed(2) + ' ms');
});

console.log('\n' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
