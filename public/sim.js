/* 吞吞大乱斗 · 共享游戏逻辑（浏览器单机模式与联机服务器共用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlobSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const WORLD = 6000, GS = 150, GN = Math.ceil(WORLD / GS), TAU = Math.PI * 2;
const C = {
  WORLD, START_MASS: 22, MAX_CELLS: 16, MIN_SPLIT: 36, MIN_EJECT: 32, EJECT_MASS: 13, EJECT_COST: 16,
  VIRUS_MASS: 100, VIRUS_FEED: 7, EAT_RATIO: 1.25, FOOD_TARGET: 1500, VIRUS_TARGET: 24, FOOD_COLORS: 8, SKINS: 16
};
const NAMES = ['小胖球','吃货本货','别吃我呀','佛系玩家','夜猫子','芝士球','大白','今天也要加油','旋风少年','柠檬精','一口一个','蛋黄派','摸鱼达人','汤圆','饭团','奶茶三分糖','快乐肥宅','无敌小可爱','路过的','南瓜头','咸鱼翻身','芒果布丁','不吃香菜','小笼包','北极熊','熬夜冠军','草莓味','猫猫拳','狗头保命','元气满满','Nomnom','Bubble','Pixel','Lucky','Mochi','Tofu','Boba','Pudding','打工人','追风','吞天','慢慢来','一只鹅','秋天的风','早睡早起','momo','嘟嘟','开心果','隔壁小王','小橘子','深海','阿飞'];

const rad = m => Math.sqrt(m) * 4.6 + 3;
const massFromR = r => { const s = (r - 3) / 4.6; return s > 0 ? s * s : 0; };
const speedFor = r => 1050 * Math.pow(r, -0.45);
const mergeDelay = m => 7 + Math.sqrt(m) * 0.32;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pick = a => a[(Math.random() * a.length) | 0];

function createWorld(opt) {
  opt = opt || {};
  const H = opt.hooks || {};
  const trackFood = !!opt.trackFood;
  let botTarget = opt.bots == null ? 26 : opt.bots;
  let players = [], cells = [], foods = [], ejects = [], viruses = [];
  let T = 0, pidSeq = 1, cidSeq = 1, fidSeq = 1, eidSeq = 1, vidSeq = 1, foodDirty = false, nextVirusAt = 0;
  const foodAdds = [], foodDels = [];
  const grid = Array.from({ length: GN * GN }, () => []);
  const emit = (n, a, b) => { const f = H[n]; if (f) f(a, b); };

  /* ---------- 创建 ---------- */
  function makeFood() {
    const m = Math.random() < .82 ? 1 : 2;
    const f = { id: fidSeq++, x: rand(15, WORLD - 15), y: rand(15, WORLD - 15), mass: m, r: m === 1 ? 5.5 : 7.5, ci: (Math.random() * C.FOOD_COLORS) | 0, e: false, dead: false };
    if (trackFood) foodAdds.push(f);
    return f;
  }
  function makeVirus(x, y) { const r = rad(C.VIRUS_MASS); return { id: vidSeq++, virus: true, x, y, mass: C.VIRUS_MASS, r, rd: r, vx: 0, vy: 0, feed: 0, rot: Math.random() * TAU, dead: false }; }
  function spawnVirus() {
    for (let k = 0; k < 20; k++) {
      const x = rand(250, WORLD - 250), y = rand(250, WORLD - 250); let ok = true;
      for (const c of cells) { if (Math.hypot(c.x - x, c.y - y) < c.r + 120) { ok = false; break; } }
      if (ok) for (const v of viruses) { if (Math.hypot(v.x - x, v.y - y) < 420) { ok = false; break; } }
      if (ok) { viruses.push(makeVirus(x, y)); return; }
    }
  }
  function freshName() { const used = new Set(players.map(p => p.name)); const pool = NAMES.filter(n => !used.has(n)); return pick(pool.length ? pool : NAMES); }
  function addPlayer(name, skin, isBot) {
    const p = {
      id: pidSeq++, name: name == null ? freshName() : name, skin: skin == null ? (Math.random() * C.SKINS) | 0 : skin, isBot: !!isBot,
      cells: [], tx: 0, ty: 0, alive: false, kills: 0, maxMass: 0, bestRank: 99, bornAt: 0, deathAt: 0, respawnAt: 0, thinkAt: 0,
      aggr: rand(.6, 1.5), caution: rand(.7, 1.3), speedMul: isBot ? rand(.93, 1) : 1, splitCd: 0, ejecting: false, ejectT: 0,
      wx: 0, wy: 0, wanderUntil: 0, lastDx: 1, lastDy: 0, killer: null
    };
    players.push(p); emit('playerAdded', p); return p;
  }
  function removePlayer(p) {
    for (const c of p.cells) c.dead = true;
    cells = cells.filter(c => !c.dead); p.cells = []; p.alive = false;
    players = players.filter(x => x !== p); emit('playerRemoved', p);
  }
  function makeCell(p, x, y, m) { const r = rad(m); return { id: cidSeq++, owner: p, x, y, mass: m, r, rd: r, bx: 0, by: 0, mergeAt: 0, ghostUntil: 0, dead: false, seed: Math.random() * TAU }; }
  function massOf(p) { let m = 0; for (const c of p.cells) if (!c.dead) m += c.mass; return m; }
  function centerOf(p) { let x = 0, y = 0, m = 0; for (const c of p.cells) { if (c.dead) continue; x += c.x * c.mass; y += c.y * c.mass; m += c.mass; } return m ? { x: x / m, y: y / m } : null; }
  function biggest(p) { let b = null; for (const c of p.cells) if (!c.dead && (!b || c.mass > b.mass)) b = c; return b; }
  function safeSpot(mass) {
    let best = { x: WORLD / 2, y: WORLD / 2 }, bestScore = -Infinity;
    for (let k = 0; k < 30; k++) {
      const x = rand(300, WORLD - 300), y = rand(300, WORLD - 300); let minD = 1e9;
      for (const c of cells) { if (c.dead || c.mass < mass * 1.1) continue; const d = Math.hypot(c.x - x, c.y - y) - c.r; if (d < minD) minD = d; }
      for (const v of viruses) { if (Math.hypot(v.x - x, v.y - y) < v.r + rad(mass) + 30) { minD = -1; break; } }
      if (minD > bestScore) { bestScore = minD; best = { x, y }; } if (minD > 1000) break;
    }
    return best;
  }
  function spawn(p, mass) {
    mass = mass || C.START_MASS;
    for (const c of p.cells) c.dead = true;
    const pos = safeSpot(mass), c = makeCell(p, pos.x, pos.y, mass);
    p.cells = [c]; cells.push(c); p.alive = true; p.bornAt = T; p.tx = pos.x; p.ty = pos.y; p.killer = null; p.ejecting = false;
    if (mass > p.maxMass) p.maxMass = mass;
    return c;
  }
  function respawnBot(p) {
    if (Math.random() < .5) p.name = freshName();
    p.skin = (Math.random() * C.SKINS) | 0; p.kills = 0; p.aggr = rand(.6, 1.5); p.caution = rand(.7, 1.3);
    emit('playerChanged', p);
    spawn(p, rand(20, 40) + (Math.random() < .15 ? rand(60, 200) : 0));
  }
  function ranking() { const list = []; for (const p of players) if (p.alive) list.push({ p, m: massOf(p) }); list.sort((a, b) => b.m - a.m); return list; }

  /* ---------- 动作 ---------- */
  function split(p) {
    if (!p.alive) return false;
    const list = p.cells.filter(c => !c.dead).sort((a, b) => b.mass - a.mass); let n = list.length, did = false;
    for (const c of list) {
      if (n >= C.MAX_CELLS) break; if (c.mass < C.MIN_SPLIT) continue;
      let dx = p.tx - c.x, dy = p.ty - c.y; const d = Math.hypot(dx, dy);
      if (d < 8) { dx = p.lastDx; dy = p.lastDy; } else { dx /= d; dy /= d; }
      const half = c.mass / 2; c.mass = half; c.r = rad(half);
      const nc = makeCell(p, c.x + dx * c.r * .3, c.y + dy * c.r * .3, half); nc.rd = c.rd * .72;
      const v = (230 + nc.r * 1.6) * 5.5; nc.bx = dx * v + c.bx * .3; nc.by = dy * v + c.by * .3;
      const md = T + mergeDelay(half); c.mergeAt = md; nc.mergeAt = md; c.ghostUntil = nc.ghostUntil = T + .3;
      p.cells.push(nc); cells.push(nc); n++; did = true;
    }
    if (did) emit('split', p);
    return did;
  }
  function eject(p) {
    let did = false;
    for (const c of p.cells) {
      if (c.dead || c.mass < C.MIN_EJECT) continue;
      let dx = p.tx - c.x, dy = p.ty - c.y; const d = Math.hypot(dx, dy);
      if (d < 8) { dx = p.lastDx; dy = p.lastDy; } else { dx /= d; dy /= d; }
      const a = Math.atan2(dy, dx) + (Math.random() - .5) * .18, ux = Math.cos(a), uy = Math.sin(a);
      c.mass -= C.EJECT_COST; c.r = rad(c.mass);
      ejects.push({ id: eidSeq++, x: c.x + ux * (c.r + 8), y: c.y + uy * (c.r + 8), vx: ux * 820, vy: uy * 820, mass: C.EJECT_MASS, r: 13, skin: p.skin, owner: p, born: T, e: true, dead: false });
      did = true;
    }
    if (did) emit('eject', p);
  }
  function popCell(c) {
    const p = c.owner; const slots = C.MAX_CELLS - p.cells.filter(x => !x.dead).length; if (slots <= 0) return;
    const n = Math.min(slots, Math.floor(c.mass / 16) - 1); if (n < 1) return;
    const piece = c.mass > 900 ? Math.max(16, c.mass * .45 / n) : c.mass / (n + 1);
    const off = Math.random() * TAU;
    for (let i = 0; i < n; i++) {
      const a = off + i / n * TAU; const nc = makeCell(p, c.x, c.y, piece); const v = (150 + nc.r * 1.4) * 5.5;
      nc.bx = Math.cos(a) * v; nc.by = Math.sin(a) * v; nc.mergeAt = T + mergeDelay(piece) + 2; nc.ghostUntil = T + .3; nc.rd = 4;
      p.cells.push(nc); cells.push(nc);
    }
    c.mass -= piece * n; c.r = rad(c.mass); c.mergeAt = T + mergeDelay(c.mass) + 2; c.ghostUntil = T + .3;
    emit('pop', c);
  }
  function died(v, k) {
    v.alive = false; v.ejecting = false; v.killer = k || null; v.deathAt = T;
    if (k && k !== v) k.kills++;
    if (v.isBot) v.respawnAt = T + 2 + Math.random() * 4;
    emit('died', v, k);
  }
  function consume(big, sm) {
    big.mass += sm.mass; big.r = rad(big.mass); sm.dead = true;
    emit('consume', big, sm);
    if (!sm.owner.cells.some(x => !x.dead)) died(sm.owner, big.owner);
  }

  /* ---------- AI ---------- */
  function nearestPellet(x, y, big) {
    const R = 420; let best = null, bd = R * R;
    const gx0 = clamp(((x - R) / GS) | 0, 0, GN - 1), gx1 = clamp(((x + R) / GS) | 0, 0, GN - 1), gy0 = clamp(((y - R) / GS) | 0, 0, GN - 1), gy1 = clamp(((y + R) / GS) | 0, 0, GN - 1);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const b = grid[gy * GN + gx];
      for (let i = 0; i < b.length; i++) { const f = b[i]; if (f.dead) continue; if (f.e && big.mass < f.mass * 1.15) continue; const dx = f.x - x, dy = f.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = f; } }
    }
    return best;
  }
  function think(p) {
    p.thinkAt = T + .12 + Math.random() * .14;
    let mx = 0, my = 0, tm = 0, big = null, small = null;
    for (const c of p.cells) { if (c.dead) continue; mx += c.x * c.mass; my += c.y * c.mass; tm += c.mass; if (!big || c.mass > big.mass) big = c; if (!small || c.mass < small.mass) small = c; }
    if (!tm) return; mx /= tm; my /= tm;
    const view = 520 + Math.sqrt(tm) * 20;
    let fx = 0, fy = 0, danger = 0, prey = null, preyScore = 0;
    for (const o of cells) {
      if (o.dead || o.owner === p) continue;
      const dx = o.x - mx, dy = o.y - my; if (dx > view || dx < -view || dy > view || dy < -view) continue;
      const d = Math.hypot(dx, dy) || 1;
      if (o.mass > small.mass * C.EAT_RATIO) {
        const reach = o.mass * .5 > small.mass * C.EAT_RATIO ? 230 + rad(o.mass * .5) * 1.6 : 0;
        const range = 160 + reach * .75, gap = d - o.r - big.r * .5;
        if (gap < range) { const w = (1 - Math.max(0, gap) / range) * (o.mass > big.mass * C.EAT_RATIO ? 1 : .45) * p.caution; fx -= dx / d * w; fy -= dy / d * w; if (w > danger) danger = w; }
      }
      if (big.mass > o.mass * C.EAT_RATIO) { const gap = Math.max(1, d - big.r); const sc = (o.mass + 15) / (gap + 80) * p.aggr; if (sc > preyScore) { preyScore = sc; prey = o; } }
    }
    const wm = 300;
    if (mx < wm) fx += (wm - mx) / wm * .6; if (mx > WORLD - wm) fx -= (mx - WORLD + wm) / wm * .6;
    if (my < wm) fy += (wm - my) / wm * .6; if (my > WORLD - wm) fy -= (my - WORLD + wm) / wm * .6;
    let vx = 0, vy = 0;
    if (big.mass > C.VIRUS_MASS * 1.15 && p.cells.length < C.MAX_CELLS) {
      for (const v of viruses) { const dx = v.x - mx, dy = v.y - my, d = Math.hypot(dx, dy) || 1, gap = d - big.r - v.r; if (gap < 90) { const w = 1 - Math.max(0, gap) / 90; vx -= dx / d * w; vy -= dy / d * w; } }
    }
    let tx, ty;
    if (danger > .14) { const l = Math.hypot(fx, fy) || 1; tx = mx + fx / l * 700; ty = my + fy / l * 700; }
    else if (prey && preyScore > .12) {
      tx = prey.x; ty = prey.y;
      const d = Math.hypot(prey.x - big.x, prey.y - big.y), reach = 230 + rad(big.mass / 2) * 1.6;
      if (p.cells.length <= 3 && T > p.splitCd && big.mass / 2 > prey.mass * C.EAT_RATIO * 1.08 && d - prey.r < reach * .9 && danger < .05 && Math.random() < .45 * p.aggr) {
        p.tx = tx; p.ty = ty; split(p); p.splitCd = T + 4 + Math.random() * 5;
      }
    } else {
      const f = nearestPellet(mx, my, big);
      if (f) { tx = f.x; ty = f.y; }
      else {
        if (!p.wx || T > p.wanderUntil || Math.hypot(p.wx - mx, p.wy - my) < 100) { p.wx = rand(400, WORLD - 400); p.wy = rand(400, WORLD - 400); p.wanderUntil = T + 8; }
        tx = p.wx; ty = p.wy;
      }
      if (danger > 0) { tx += fx * 300; ty += fy * 300; }
    }
    tx += vx * 260; ty += vy * 260;
    p.tx = clamp(tx, 0, WORLD); p.ty = clamp(ty, 0, WORLD);
  }

  /* ---------- 物理 ---------- */
  function moveCell(c, dt) {
    const p = c.owner, dx = p.tx - c.x, dy = p.ty - c.y, d = Math.hypot(dx, dy);
    if (d > 1) { const s = speedFor(c.r) * Math.min(1, d / (c.r * .5 + 35)) * p.speedMul; c.x += dx / d * s * dt; c.y += dy / d * s * dt; }
    if (c.bx || c.by) { c.x += c.bx * dt; c.y += c.by * dt; const k = Math.exp(-5.5 * dt); c.bx *= k; c.by *= k; if (Math.abs(c.bx) + Math.abs(c.by) < 5) c.bx = c.by = 0; }
    const m = c.r * .4; c.x = clamp(c.x, m, WORLD - m); c.y = clamp(c.y, m, WORLD - m);
  }
  function siblings(p, dt) {
    const cs = p.cells, n = cs.length;
    for (let i = 0; i < n; i++) {
      const a = cs[i]; if (a.dead) continue;
      for (let j = i + 1; j < n; j++) {
        const b = cs[j]; if (b.dead || a.dead) continue;
        let dx = b.x - a.x, dy = b.y - a.y; const rs = a.r + b.r;
        if (dx > rs || dx < -rs || dy > rs || dy < -rs) continue;
        let d = Math.hypot(dx, dy);
        if (T >= a.mergeAt && T >= b.mergeAt) {
          if (d < Math.max(a.r, b.r) - Math.min(a.r, b.r) * .35 + 2) { const bg = a.mass >= b.mass ? a : b, sm = bg === a ? b : a; bg.mass += sm.mass; bg.r = rad(bg.mass); sm.dead = true; }
          else if (d > .01) { const pull = Math.min(d, 90 * dt) * .5; a.x += dx / d * pull; a.y += dy / d * pull; b.x -= dx / d * pull; b.y -= dy / d * pull; }
        } else {
          if (T < a.ghostUntil || T < b.ghostUntil || d >= rs) continue;
          if (d < .01) { dx = Math.random() - .5; dy = Math.random() - .5; d = Math.hypot(dx, dy); }
          const ov = rs - d, tot = a.mass + b.mass, k = Math.min(1, dt * 14), ux = dx / d, uy = dy / d;
          a.x -= ux * ov * (b.mass / tot) * k; a.y -= uy * ov * (b.mass / tot) * k;
          b.x += ux * ov * (a.mass / tot) * k; b.y += uy * ov * (a.mass / tot) * k;
        }
      }
    }
  }
  function buildGrid() {
    for (let i = 0; i < grid.length; i++) grid[i].length = 0;
    for (const f of foods) { if (f.dead) continue; grid[clamp((f.y / GS) | 0, 0, GN - 1) * GN + clamp((f.x / GS) | 0, 0, GN - 1)].push(f); }
    for (const e of ejects) { if (e.dead) continue; grid[clamp((e.y / GS) | 0, 0, GN - 1) * GN + clamp((e.x / GS) | 0, 0, GN - 1)].push(e); }
  }
  function eatPellets() {
    for (let i = 0, n = cells.length; i < n; i++) {
      const c = cells[i]; if (c.dead) continue; const r = c.r;
      const gx0 = clamp(((c.x - r) / GS) | 0, 0, GN - 1), gx1 = clamp(((c.x + r) / GS) | 0, 0, GN - 1), gy0 = clamp(((c.y - r) / GS) | 0, 0, GN - 1), gy1 = clamp(((c.y + r) / GS) | 0, 0, GN - 1);
      let gain = 0;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const b = grid[gy * GN + gx];
        for (let k = 0; k < b.length; k++) {
          const f = b[k]; if (f.dead) continue; const dx = f.x - c.x, dy = f.y - c.y, d2 = dx * dx + dy * dy;
          if (f.e) { if (c.mass < f.mass * 1.15) continue; if (f.owner === c.owner && T - f.born < .25) continue; const lim = r - f.r * .3; if (lim > 0 && d2 < lim * lim) { f.dead = true; gain += f.mass; } }
          else if (d2 < r * r) { f.dead = true; gain += f.mass; foodDirty = true; if (trackFood) foodDels.push(f.id); }
        }
      }
      if (gain) { c.mass += gain; c.r = rad(c.mass); emit('eat', c, gain); }
    }
  }
  function virusStuff() {
    for (const v of viruses) {
      if (v.dead) continue;
      for (const e of ejects) {
        if (e.dead) continue; const dx = e.x - v.x, dy = e.y - v.y;
        if (dx * dx + dy * dy < v.r * v.r) {
          e.dead = true; v.feed++; v.mass += e.mass * .5; v.r = rad(v.mass);
          if (v.feed >= C.VIRUS_FEED) {
            let ux = e.vx, uy = e.vy, l = Math.hypot(ux, uy); if (l < 1) { ux = dx; uy = dy; l = Math.hypot(ux, uy) || 1; }
            const nv = makeVirus(v.x, v.y); nv.vx = ux / l * 900; nv.vy = uy / l * 900; viruses.push(nv);
            v.feed = 0; v.mass = C.VIRUS_MASS; v.r = rad(v.mass);
          }
        }
      }
    }
    for (let i = 0, n = cells.length; i < n; i++) {
      const c = cells[i]; if (c.dead || c.mass < C.VIRUS_MASS * 1.2) continue;
      for (const v of viruses) {
        if (v.dead || c.mass < v.mass * 1.2) continue; const dx = v.x - c.x, dy = v.y - c.y, lim = c.r - v.r * .35;
        if (lim > 0 && dx * dx + dy * dy < lim * lim) { v.dead = true; c.mass += v.mass; c.r = rad(c.mass); popCell(c); }
      }
    }
  }
  function cellVsCell() {
    const n = cells.length;
    for (let i = 0; i < n; i++) {
      const a = cells[i]; if (a.dead) continue;
      for (let j = i + 1; j < n; j++) {
        const b = cells[j]; if (b.dead || b.owner === a.owner) continue;
        const dx = b.x - a.x, dy = b.y - a.y, R = a.r > b.r ? a.r : b.r;
        if (dx > R || dx < -R || dy > R || dy < -R) continue;
        const bg = a.mass >= b.mass ? a : b, sm = bg === a ? b : a;
        if (bg.mass < sm.mass * C.EAT_RATIO) continue;
        if (Math.hypot(dx, dy) < bg.r - sm.r * .4) { consume(bg, sm); if (a.dead) break; }
      }
    }
  }
  function adjustBots() {
    let bots = 0; for (const p of players) if (p.isBot) bots++;
    if (bots < botTarget) { const p = addPlayer(null, null, true); spawn(p, rand(20, 40)); }
    else if (bots > botTarget) {
      let victim = null, vm = Infinity;
      for (const p of players) { if (!p.isBot) continue; const m = p.alive ? massOf(p) : -1; if (m < vm) { vm = m; victim = p; } }
      if (victim) removePlayer(victim);
    }
  }

  function step(dt) {
    T += dt;
    for (const p of players) {
      if (!p.alive) { if (p.isBot && T >= p.respawnAt) respawnBot(p); continue; }
      if (p.isBot && T >= p.thinkAt) think(p);
      if (p.ejecting) { p.ejectT -= dt; if (p.ejectT <= 0) { eject(p); p.ejectT = .085; } }
    }
    for (const c of cells) if (!c.dead) moveCell(c, dt);
    for (const p of players) if (p.alive && p.cells.length > 1) siblings(p, dt);
    const ke = Math.exp(-4 * dt);
    for (const e of ejects) { if (e.dead || (!e.vx && !e.vy)) continue; e.x += e.vx * dt; e.y += e.vy * dt; e.vx *= ke; e.vy *= ke; if (Math.abs(e.vx) + Math.abs(e.vy) < 4) e.vx = e.vy = 0; e.x = clamp(e.x, e.r, WORLD - e.r); e.y = clamp(e.y, e.r, WORLD - e.r); }
    const kv = Math.exp(-3.5 * dt);
    for (const v of viruses) { v.rot += dt * .15; if (v.vx || v.vy) { v.x += v.vx * dt; v.y += v.vy * dt; v.vx *= kv; v.vy *= kv; if (Math.abs(v.vx) + Math.abs(v.vy) < 4) v.vx = v.vy = 0; v.x = clamp(v.x, v.r, WORLD - v.r); v.y = clamp(v.y, v.r, WORLD - v.r); } }
    buildGrid(); eatPellets(); virusStuff(); cellVsCell();
    for (const c of cells) { if (c.dead) continue; if (c.mass > 120) { c.mass -= c.mass * .0016 * dt * (1 + c.mass / 6000); c.r = rad(c.mass); } c.rd += (c.r - c.rd) * Math.min(1, dt * 10); }
    cells = cells.filter(c => !c.dead);
    for (const p of players) if (p.cells.length) p.cells = p.cells.filter(c => !c.dead);
    if (foodDirty) { foods = foods.filter(f => !f.dead); foodDirty = false; }
    ejects = ejects.filter(e => !e.dead); viruses = viruses.filter(v => !v.dead);
    for (let i = 0, need = Math.min(30, C.FOOD_TARGET - foods.length); i < need; i++) foods.push(makeFood());
    if (viruses.length < C.VIRUS_TARGET && T > nextVirusAt) { spawnVirus(); nextVirusAt = T + 2; }
    if (ejects.length > 450) ejects.splice(0, ejects.length - 450);
    for (const p of players) if (!p.isBot && p.alive) { const m = massOf(p); if (m > p.maxMass) p.maxMass = m; }
    adjustBots();
  }

  const w = {
    C,
    get players() { return players; }, get cells() { return cells; }, get foods() { return foods; },
    get ejects() { return ejects; }, get viruses() { return viruses; }, get T() { return T; },
    get botTarget() { return botTarget; }, setBotTarget(n) { botTarget = Math.max(0, n | 0); },
    foodAdds, foodDels,
    addPlayer, removePlayer, spawn, split, eject, step, massOf, centerOf, biggest, ranking
  };
  for (let i = 0; i < C.FOOD_TARGET; i++) foods.push(makeFood());
  for (let i = 0; i < C.VIRUS_TARGET; i++) spawnVirus();
  for (let i = 0; i < botTarget; i++) { const p = addPlayer(null, null, true); spawn(p, 20 + Math.pow(Math.random(), 2.4) * 480); }
  foodAdds.length = 0;
  return w;
}

return { C, NAMES, rad, massFromR, clamp, createWorld };
});
