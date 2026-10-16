// sim.js — headless game logic: the course, bean physics and bot AI.
// No rendering/DOM dependencies, so it can be unit-tested in Node and driven by game.js.

export const R = 0.42;            // bean collision radius
export const H = 1.4;             // bean collision height
export const GRAVITY = 32;
export const JUMP_V = 11.5;
export const DIVE_V = 13.5;
export const RUN = 8.3;
export const FALL_Y = -12;        // below this a bean respawns at its checkpoint
export const STEP = 1 / 120;      // fixed simulation step
export const QUALIFY = 8;         // finishers that make the cut
export const START_Z = 14;
export const FINISH_Z = -244;
export const COURSE_LEN = START_Z - FINISH_Z;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// Small seeded PRNG so the tile layout is the same every race.
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const emit = (w, type, ch, data) => w.onEvent && w.onEvent(type, ch, data);

/* ------------------------------------------------------------------ */
/* Course                                                              */
/* ------------------------------------------------------------------ */

// Every solid thing is a yaw-rotatable box ("collider"). Course runs toward -Z.
export function createWorld() {
  const w = {
    t: 0, raceT: 0, racing: false, lobby: false, mirror: false, raceOver: false, finishers: [],
    colliders: [], movers: [], tiles: [], checkpoints: [], gate: null,
    onEvent: null,
  };

  const add = (o) => {
    const c = {
      id: w.colliders.length, kind: 'platform',
      cx: 0, cy: 0, cz: 0, hx: 1, hy: 1, hz: 1, yaw: 0,
      vx: 0, vy: 0, vz: 0, dx: 0, dy: 0, dz: 0, omega: 0,
      active: true, hazard: false, dynamic: false, cp: undefined, update: null,
      ...o,
    };
    c.ext = Math.hypot(c.hx, c.hz);
    w.colliders.push(c);
    return c;
  };
  // Slab whose top surface sits at `top`.
  const plat = (cx, top, cz, wd, dp, extra = {}) =>
    add({ cx, cy: top - 1, cz, hx: wd / 2, hy: 1, hz: dp / 2, ...extra });

  w.checkpoints = [
    { x: 0, y: 0, z: 14 }, { x: 0, y: 0, z: -16 }, { x: 0, y: 0, z: -96 },
    { x: 0, y: 0, z: -158 }, { x: 0, y: 0, z: -211 },
  ];

  // 1. Start pad (+ gate that drops on GO)
  plat(0, 0, 8, 30, 32, { cp: 0, pal: ['#ffffff', '#ffc2dc'], label: 'start' });
  w.gate = add({ kind: 'gate', cx: 0, cy: 1.5, cz: 12.5, hx: 15, hy: 1.5, hz: 0.4 });

  // 2. Sweeper bars
  plat(0, 0, -31.5, 30, 41, { cp: 1, pal: ['#ffffff', '#bfe6ff'] });
  const bar = (z, omega, phase, color) => {
    add({ kind: 'pillar', cx: 0, cy: 1.4, cz: z, hx: 0.9, hy: 1.4, hz: 0.9, color: '#ffffff' });
    const b = add({ kind: 'bar', cx: 0, cy: 0.75, cz: z, hx: 11, hy: 0.4, hz: 0.45, hazard: true, omega, dynamic: true, color });
    b.update = (c, world) => { c.yaw = omega * world.t + phase; };
  };
  bar(-24, 1.1, 0, '#ff5d73');
  bar(-40, -1.35, 1.2, '#ffb703');

  // 3. Sliding platforms over the void
  [[-58, 6, 0.9, 0], [-67, 6.5, 1.1, 1.7], [-76, 6, 0.8, 3.1], [-85, 6.5, 1.0, 4.4]]
    .forEach(([z, amp, f, ph], i) => {
      const c = add({
        kind: 'mover', cx: 0, cy: -0.75, cz: z, hx: 3.5, hy: 0.75, hz: 3.5, dynamic: true,
        pal: [['#ffffff', '#ff9ec7'], ['#ffffff', '#ffd166'], ['#ffffff', '#9be564'], ['#ffffff', '#8ecae6']][i],
      });
      c.update = (m, world, dt) => {
        const nx = amp * Math.sin(world.t * f + ph);
        m.dx = nx - m.cx; m.cx = nx; m.vx = dt > 0 ? m.dx / dt : 0;
      };
      w.movers.push(c);
    });

  // 4. Landing + falling tiles
  plat(0, 0, -99, 24, 16, { cp: 2, pal: ['#ffffff', '#c8f2a0'] });
  const rnd = mulberry(11);
  const cols = [-9.5, -5.7, -1.9, 1.9, 5.7, 9.5];
  const tileColors = ['#ff6b9d', '#ffd23f', '#3bceac', '#4ea8de'];
  for (let k = 0; k < 10; k++) {
    const missing = new Set();
    const nMiss = 1 + (rnd() < 0.5 ? 1 : 0);
    while (missing.size < nMiss) missing.add(Math.floor(rnd() * cols.length));
    cols.forEach((x, i) => {
      if (missing.has(i)) return;
      const t = add({
        kind: 'tile', cx: x, cy: -0.4, cz: -111 - 4 * k, hx: 1.75, hy: 0.4, hz: 1.75,
        dynamic: true, color: tileColors[(i + k) % 4],
      });
      t.baseY = -0.4; t.state = 'idle'; t.timer = 0; t.fv = 0; t.pop = 1;
      t.update = tileUpdate;
      w.tiles.push(t);
    });
  }

  // 5. Narrow bridge with side pistons
  plat(0, 0, -161, 24, 18, { cp: 3, pal: ['#ffffff', '#ffd6a5'] });
  plat(0, 0, -188, 6, 36, { pal: ['#ffffff', '#cdb4ff'] });
  [[-178, 1, 1.5, 0], [-188, -1, 1.6, 2.2], [-198, 1, 1.4, 4.1]].forEach(([z, side, f, ph]) => {
    const p = add({ kind: 'piston', cx: side * 7.5, cy: 0.8, cz: z, hx: 2, hy: 0.8, hz: 1.3, hazard: true, dynamic: true });
    p.update = (c, world, dt) => {
      const s = clamp(0.5 + 0.75 * Math.sin(world.t * f + ph), 0, 1);
      const nx = side * (7.5 - 4.5 * s);
      c.dx = nx - c.cx; c.cx = nx; c.vx = dt > 0 ? c.dx / dt : 0;
    };
  });

  // 6. Stairs and the summit
  plat(0, 0, -215, 24, 18, { cp: 4, pal: ['#ffffff', '#fff3a3'] });
  for (let i = 1; i <= 5; i++) {
    add({
      kind: 'step', cx: 0, cy: 0.45 * i, cz: -224 - 3 * (i - 1) - 1.5,
      hx: 7, hy: 0.45 * i, hz: 1.5, pal: ['#ffffff', ['#ff9ec7', '#ffd166', '#9be564', '#8ecae6', '#cdb4ff'][i - 1]],
    });
  }
  plat(0, 4.5, -247, 20, 16, { pal: ['#fff6bf', '#ffd23f'], label: 'summit' });

  resetWorld(w);
  return w;
}

function tileUpdate(c, w, dt) {
  c.dx = c.dy = c.dz = 0;
  if (w.mirror) {                        // client copy: the server owns tile states
    if (c.state === 'fall') {
      c.fv -= 22 * dt;
      const ny = c.cy + c.fv * dt;
      c.dy = ny - c.cy; c.cy = ny;
    }
    return;
  }
  if (c.state === 'shake') {
    c.timer -= dt;
    if (c.timer <= 0) { c.state = 'fall'; c.fv = 0; }
  } else if (c.state === 'fall') {
    c.fv -= 22 * dt;
    const ny = c.cy + c.fv * dt;
    c.dy = ny - c.cy; c.cy = ny;
    if (c.cy < -14) { c.active = false; c.state = 'gone'; c.timer = 2.0; }
  } else if (c.state === 'gone') {
    c.timer -= dt;                       // tiles regrow so the pack behind still has a path
    if (c.timer <= 0) { c.state = 'idle'; c.cy = c.baseY; c.active = true; c.fv = 0; c.pop = 0; }
  }
  if (c.pop !== undefined && c.pop < 1) c.pop = Math.min(1, c.pop + dt * 3);
}

export function resetWorld(w) {
  w.t = 0; w.raceT = 0; w.racing = false; w.raceOver = false; w.finishers = [];
  w.gate.active = true;
  for (const t of w.tiles) { t.cy = t.baseY; t.state = 'idle'; t.active = true; t.dy = 0; t.fv = 0; t.pop = 1; }
  for (const c of w.colliders) {
    if (c.update) c.update(c, w, 0);
    c.dx = c.dy = c.dz = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Beans                                                               */
/* ------------------------------------------------------------------ */

export function createChar({ id, name, color, isPlayer = false }) {
  return {
    id, name, color, isPlayer, bot: null,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: Math.PI,
    grounded: false, ground: null, coyote: 0, jumpBuf: 0, landV: 0,
    state: 'run', stateT: 0, wishX: 0, wishZ: 0, jumpReq: false, diveReq: false,
    maxSpeed: RUN, cp: 0, finished: false, finishT: 0, finishOrder: -1,
    falls: 0, bonks: 0, invuln: 0, ghost: false, t: 0,
  };
}

export function resetChar(ch, x, z) {
  Object.assign(ch, {
    x, y: 0, z, vx: 0, vy: 0, vz: 0, heading: Math.PI, grounded: false, ground: null,
    coyote: 0, jumpBuf: 0, landV: 0, state: 'run', stateT: 0, wishX: 0, wishZ: 0,
    jumpReq: false, diveReq: false, cp: 0, finished: false, finishT: 0, finishOrder: -1,
    falls: 0, bonks: 0, invuln: 0, ghost: false,
  });
}

export function initBot(ch, rnd = Math.random) {
  const skill = rnd();
  ch.maxSpeed = 7.1 + skill * 1.4;   // scaled with RUN so bots keep pace
  ch.bot = {
    skill, lane: (rnd() - 0.5) * 16, reactT: 0.15 + rnd() * 0.55, wait: 0, stuckT: 0,
    seen: null, willJump: false, nf: 0.6 + rnd() * 1.2, np: rnd() * 6.28,
    sway: 0.05 + (1 - skill) * 0.22, jumpiness: 0.55 + skill * 0.4, think: rnd() / 30,
  };
}

export function stun(w, ch, time) {
  if (ch.finished || ch.state === 'done') return;
  ch.state = 'stun'; ch.stateT = time; ch.bonks++;
  emit(w, 'bonk', ch);
}

function respawn(w, ch) {
  const cp = w.checkpoints[ch.cp];
  ch.x = cp.x + (Math.random() - 0.5) * 12;
  ch.z = cp.z - 1 + Math.random() * 2;
  ch.y = cp.y + 1.5;
  ch.vx = ch.vy = ch.vz = 0;
  ch.state = 'run'; ch.stateT = 0; ch.invuln = 1.6; ch.ground = null; ch.grounded = false;
  ch.heading = Math.PI;
  ch.falls++;
  emit(w, 'respawn', ch);
}

// Resolve a bean (vertical cylinder) against one rotated box.
function collide(w, ch, c, dt) {
  const dx = ch.x - c.cx, dz = ch.z - c.cz;
  const reach = c.ext + R;
  if (dx * dx + dz * dz > reach * reach) return;
  const top = c.cy + c.hy, bot = c.cy - c.hy;
  if (ch.y >= top || ch.y + H <= bot) return;

  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;           // into box space
  const ox = lx - clamp(lx, -c.hx, c.hx), oz = lz - clamp(lz, -c.hz, c.hz);
  const d2 = ox * ox + oz * oz;
  if (d2 >= R * R) return;

  // Land on top when the feet are near the surface and we are not rising.
  const tol = 0.35 + Math.max(0, -ch.vy) * dt;
  if (ch.y >= top - tol && ch.vy <= 1) {
    if (ch.vy < 0) { ch.landV = Math.max(ch.landV, -ch.vy); ch.vy = 0; }
    ch.y = top; ch.grounded = true; ch.ground = c;
    if (c.cp !== undefined && c.cp > ch.cp) ch.cp = c.cp;
    if (c.kind === 'tile' && c.state === 'idle' && !w.mirror) { c.state = 'shake'; c.timer = 1.0; }
    return;
  }

  // Otherwise push out sideways along the shortest way.
  let lnx, lnz, pen;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2); lnx = ox / d; lnz = oz / d; pen = R - d;
  } else {
    const px = c.hx - Math.abs(lx), pz = c.hz - Math.abs(lz);
    if (px < pz) { lnx = Math.sign(lx) || 1; lnz = 0; pen = px + R; }
    else { lnx = 0; lnz = Math.sign(lz) || 1; pen = pz + R; }
  }
  const nx = lnx * cs + lnz * sn, nz = -lnx * sn + lnz * cs;      // back to world space
  ch.x += nx * pen; ch.z += nz * pen;

  // Match the surface velocity at the contact point (rotating bars fling beans).
  const svx = c.vx + c.omega * (ch.z - c.cz), svz = c.vz - c.omega * (ch.x - c.cx);
  const vn = (ch.vx - svx) * nx + (ch.vz - svz) * nz;
  if (vn < 0) {
    ch.vx -= nx * vn; ch.vz -= nz * vn;
    if (c.hazard && -vn > 6) {
      ch.vx += nx * 2; ch.vz += nz * 2; ch.vy = Math.max(ch.vy, 4.5);
      ch.grounded = false; ch.ground = null;
      stun(w, ch, 0.9);
    }
  }
}

export function stepChar(w, ch, dt) {
  // Ride whatever we were standing on.
  const g = ch.ground;
  if (g && g.active) { ch.x += g.dx; ch.y += g.dy; ch.z += g.dz; }

  ch.t += dt;
  if (ch.invuln > 0) ch.invuln -= dt;
  ch.stateT -= dt;
  if ((ch.state === 'dive' || ch.state === 'stun') && ch.stateT <= 0) ch.state = 'run';

  const canControl = ch.state === 'run' && (w.racing || w.lobby) && !ch.finished;
  let wx = ch.wishX, wz = ch.wishZ;
  let wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; wl = 1; }
  if (!canControl) { wx = wz = 0; wl = 0; }

  if (ch.jumpReq) { ch.jumpBuf = 0.12; ch.jumpReq = false; } else ch.jumpBuf -= dt;

  if (wl > 0.1) ch.heading += wrapPi(Math.atan2(wx, wz) - ch.heading) * Math.min(1, 16 * dt);

  if (ch.diveReq) {
    if (canControl) {
      ch.state = 'dive'; ch.stateT = 0.9;
      ch.vx = Math.sin(ch.heading) * DIVE_V; ch.vz = Math.cos(ch.heading) * DIVE_V;
      ch.vy = ch.grounded ? 4.5 : Math.max(ch.vy, 1.5);
      ch.grounded = false; ch.ground = null; ch.coyote = 0;
      emit(w, 'dive', ch);
    }
    ch.diveReq = false;
  }

  if (canControl) {
    let ax = wx * ch.maxSpeed - ch.vx, az = wz * ch.maxSpeed - ch.vz;
    const len = Math.hypot(ax, az), maxd = (ch.grounded ? 48 : 24) * dt;
    if (len > maxd) { ax *= maxd / len; az *= maxd / len; }
    ch.vx += ax; ch.vz += az;
  } else if (ch.grounded) {
    const fr = (ch.state === 'dive' ? 7 : ch.state === 'stun' ? 6 : 30) * dt;
    const sp = Math.hypot(ch.vx, ch.vz);
    if (sp > 0) { const k = Math.max(0, sp - fr) / sp; ch.vx *= k; ch.vz *= k; }
  }

  if (canControl && ch.jumpBuf > 0 && ch.coyote > 0) {
    ch.vy = JUMP_V; ch.coyote = 0; ch.jumpBuf = 0; ch.grounded = false; ch.ground = null;
    emit(w, 'jump', ch);
  }

  ch.vy = Math.max(ch.vy - GRAVITY * dt, -35);
  ch.x += ch.vx * dt; ch.y += ch.vy * dt; ch.z += ch.vz * dt;

  const was = ch.grounded;
  ch.grounded = false; ch.ground = null; ch.landV = 0;
  for (const c of w.colliders) if (c.active) collide(w, ch, c, dt);
  if (ch.grounded) {
    ch.coyote = 0.1;
    if (!was && ch.landV > 5) emit(w, 'land', ch, ch.landV);
  } else ch.coyote -= dt;
}

function charVsChar(w, chars) {
  const min = 2 * R;
  for (let i = 0; i < chars.length; i++) {
    const a = chars[i];
    if (a.ghost || a.invuln > 0) continue;
    for (let j = i + 1; j < chars.length; j++) {
      const b = chars[j];
      if (b.ghost || b.invuln > 0 || Math.abs(a.y - b.y) > 1.2) continue;
      let dx = a.x - b.x, dz = a.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-4) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
      const pen = (min - d) / 2;
      a.x += dx * pen; a.z += dz * pen; b.x -= dx * pen; b.z -= dz * pen;
      const rv = (a.vx - b.vx) * dx + (a.vz - b.vz) * dz;
      if (rv < 0) {
        const j2 = (-(1 + 0.35) * rv) / 2;
        a.vx += dx * j2; a.vz += dz * j2; b.vx -= dx * j2; b.vz -= dz * j2;
        if (-rv > 4) {                      // a diving bean flattens whoever it hits
          if (a.state === 'dive' && b.state === 'run') { stun(w, b, 0.9); b.vx -= dx * 4; b.vz -= dz * 4; }
          else if (b.state === 'dive' && a.state === 'run') { stun(w, a, 0.9); a.vx += dx * 4; a.vz += dz * 4; }
        }
      }
    }
  }
}

// Client prediction: my bean vs. everyone else as the client sees them. Same push-apart and bounce
// as charVsChar, but one-sided (the others are snapshots, overwritten every frame) and it never
// stuns: the server decides bonks and tells me, so a local stun would only pre-empt that.
export function collideWithOthers(me, others) {
  if (me.ghost || me.invuln > 0) return;
  const min = 2 * R;
  for (const b of others) {
    if (!b.placed || b.ghost || b.invuln > 0 || Math.abs(me.y - b.y) > 1.2) continue;
    let dx = me.x - b.x, dz = me.z - b.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2);
    if (d < 1e-4) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
    const pen = (min - d) / 2;                       // the server splits the push between the pair
    me.x += dx * pen; me.z += dz * pen;
    const rv = (me.vx - b.vx) * dx + (me.vz - b.vz) * dz;
    if (rv < 0) { const j2 = (-(1 + 0.35) * rv) / 2; me.vx += dx * j2; me.vz += dz * j2; }
  }
}

export function stepWorld(w, chars, dt) {
  w.t += dt;
  if (w.racing) w.raceT += dt;
  for (const c of w.colliders) if (c.update) c.update(c, w, dt);

  for (const ch of chars) {
    if (ch.bot) {
      ch.bot.think -= dt;
      if (ch.bot.think <= 0) { ch.bot.think += 1 / 30; botThink(w, ch, 1 / 30); }
    }
    stepChar(w, ch, dt);
  }
  charVsChar(w, chars);
  if (w.mirror) return;                  // client copy: the server decides falls and finishes

  for (const ch of chars) {
    if (ch.y < FALL_Y && !ch.finished) { emit(w, 'fall', ch); respawn(w, ch); continue; }
    if (!ch.finished && w.racing && ch.z < FINISH_Z && ch.y > 3.5) {
      ch.finished = true; ch.finishT = w.raceT; ch.finishOrder = w.finishers.length;
      ch.state = 'done'; ch.ghost = true; ch.wishX = ch.wishZ = 0;
      w.finishers.push(ch);
      emit(w, 'finish', ch);
      if (w.finishers.length >= QUALIFY && !w.raceOver) { w.raceOver = true; emit(w, 'raceover', ch); }
    }
  }
}

// Finishers first (by order), everyone else by distance travelled.
export function rankings(chars) {
  return [...chars].sort((a, b) => {
    if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return a.z - b.z;
  });
}

/* ------------------------------------------------------------------ */
/* Bot AI                                                              */
/* ------------------------------------------------------------------ */

function insideXZ(c, x, z, m = 0) {
  const dx = x - c.cx, dz = z - c.cz;
  const r = c.ext + m;
  if (dx * dx + dz * dz > r * r) return false;
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  return Math.abs(dx * cs - dz * sn) <= c.hx + m && Math.abs(dx * sn + dz * cs) <= c.hz + m;
}

// Height of the walkable surface under (x,z) near `refY`, or null for a gap.
export function groundAt(w, x, z, refY) {
  let best = null;
  for (const c of w.colliders) {
    if (!c.active || c.kind === 'gate' || c.state === 'fall' || c.state === 'shake') continue;
    const top = c.cy + c.hy;
    if (top > refY + 1.4 || top < refY - 2.5) continue;
    if (insideXZ(c, x, z) && (best === null || top > best)) best = top;
  }
  return best;
}

function obstacleAhead(w, ch, dirx, dirz) {
  for (const c of w.colliders) {
    if (!c.active || c.kind === 'gate') continue;
    const rel = c.cy + c.hy - ch.y;
    if (rel < 0.2 || rel > 1.9) continue;
    for (const d of [1.2, 2.2]) if (insideXZ(c, ch.x + dirx * d, ch.z + dirz * d, 0.15)) return c;
  }
  return null;
}

export function botThink(w, ch, dt) {
  const b = ch.bot;
  ch.wishX = ch.wishZ = 0;
  if (!w.racing || ch.finished || ch.state !== 'run') return;
  if (b.reactT > 0) { b.reactT -= dt; return; }

  const z = ch.z;
  let tx = b.lane, tz = z - 8;
  if (z < -46 && z > -92 && ch.y > -3) {
    // Chase the next sliding platform.
    const from = ch.ground && ch.ground.kind === 'mover' ? ch.ground.cz - 1 : z - 1;
    const m = w.movers.find((p) => p.cz < from);
    if (m) { tx = m.cx + m.vx * 0.3; tz = m.cz; } else { tx = 0; }
  } else if (z < -112 && z > -150) tx = b.lane * 0.55;
  else if (z < -166 && z > -208) tx = Math.sin(w.t * b.nf + b.np) * 0.4;
  else if (z < -222) tx = b.lane * 0.4;

  let dx = tx - ch.x, dz = tz - ch.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const ang = Math.sin(w.t * b.nf + b.np) * b.sway;       // a little human-like wobble
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let wx = dx * ca - dz * sa, wz = dx * sa + dz * ca;

  if (ch.grounded) {
    // Gap ahead? Jump if there is somewhere to land, otherwise wait at the edge.
    if (groundAt(w, ch.x + wx * 1.1, ch.z + wz * 1.1, ch.y) === null) {
      let found = false;
      for (const d of [2.4, 3.4, 4.4, 5.4]) {
        if (groundAt(w, ch.x + wx * d, ch.z + wz * d, ch.y) !== null) { found = true; break; }
      }
      if (found || b.wait > 8) { ch.jumpReq = true; b.wait = 0; }
      else {
        // Nothing straight ahead: shuffle along the edge toward the nearest spot that has ground.
        let strafe = 0;
        search: for (const off of [2, -2, 4, -4, 6, -6, 8, -8]) {
          for (const d of [2.4, 3.4, 4.4]) {
            if (groundAt(w, ch.x + wx * d - wz * off, ch.z + wz * d + wx * off, ch.y) !== null) { strafe = off; break search; }
          }
        }
        if (strafe) {
          const s = Math.sign(strafe), px = -wz * s, pz = wx * s;
          wx = px; wz = pz; b.wait = 0;
        }
        else { b.wait += dt; wx = wz = 0; }
      }
    } else b.wait = 0;

    // Low obstacle (stairs, bars, pistons): decide once per obstacle whether to hop it.
    const ob = obstacleAhead(w, ch, wx, wz);
    if (ob) {
      if (b.seen !== ob) { b.seen = ob; b.willJump = ob.kind === 'step' || Math.random() < b.jumpiness; }
      if (b.willJump) ch.jumpReq = true;
    } else b.seen = null;

    // Wedged against something? Hop and sidestep.
    if (Math.hypot(ch.vx, ch.vz) < 1 && b.wait === 0) {
      b.stuckT += dt;
      if (b.stuckT > 0.7) { ch.jumpReq = true; b.lane = (Math.random() - 0.5) * 14; b.stuckT = 0; }
    } else b.stuckT = 0;
  }
  ch.wishX = wx; ch.wishZ = wz;
}
