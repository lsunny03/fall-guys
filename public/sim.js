// sim.js — headless game logic: the course, bean physics and bot AI.
// No rendering/DOM dependencies, so it can be unit-tested in Node and driven by game.js.

export const R = 0.42;            // bean collision radius
export const H = 1.4;             // bean collision height
export const DIVE_H = 0.6;        // height while diving: slides under low bars
export const GRAVITY = 32;
export const JUMP_V = 11.5;
export const DIVE_V = 13.5;
export const RUN = 8.3;
export const FALL_Y = -12;        // below this a bean respawns at its checkpoint
export const STEP = 1 / 120;      // fixed simulation step
export const QUALIFY = 8;         // finishers that make the cut
export const START_Z = 14;

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

// Every solid thing is a yaw-rotatable box ("collider"). Courses run toward -Z from the shared start pad.
// A level only has to say what lies beyond the pad (see LEVELS below); physics and rendering are generic.
export function createWorld(levelIdx = 0) {
  const lv = LEVELS[levelIdx] || LEVELS[0];
  const w = {
    t: 0, raceT: 0, racing: false, lobby: false, mirror: false, raceOver: false, finishers: [],
    colliders: [], movers: [], tiles: [], checkpoints: [{ x: 0, y: 0, z: START_Z }], gate: null,
    levelIdx: LEVELS.indexOf(lv), level: lv,
    onEvent: null,
  };

  const add = (o) => {
    const c = {
      id: w.colliders.length, kind: 'platform', pal: ['#ffffff', '#d9d2ff'],
      cx: 0, cy: 0, cz: 0, hx: 1, hy: 1, hz: 1, yaw: 0,
      vx: 0, vy: 0, vz: 0, dx: 0, dy: 0, dz: 0, omega: 0,
      active: true, hazard: false, dynamic: false, cp: undefined, update: null,
      belt: null, ice: false, bounce: 0,
      ...o,
    };
    c.ext = Math.hypot(c.hx, c.hz);
    w.colliders.push(c);
    return c;
  };
  // Slab whose top surface sits at `top`.
  const plat = (cx, top, cz, wd, dp, extra = {}) =>
    add({ cx, cy: top - 1, cz, hx: wd / 2, hy: 1, hz: dp / 2, ...extra });
  // Register a respawn point and get its index (use it as a platform's `cp`).
  // `spread` is how wide the respawn scatter is (default 12); narrow it for checkpoints on thin decks.
  const cp = (y, z, x = 0, spread) => { w.checkpoints.push({ x, y, z, spread }); return w.checkpoints.length - 1; };
  // A rotating sweeper on a pillar.
  // `high` is a single taller bar (0.9–2.4 high, dive-only to pass); `tall` makes the pillar 50% taller.
  const bar = (z, omega, phase, color, { y = 0, len = 11, high = false, tall = false } = {}) => {
    const ph = tall ? 2.1 : 1.4;
    add({ kind: 'pillar', cx: 0, cy: y + ph, cz: z, hx: 0.9, hy: ph, hz: 0.9, color: '#ffffff' });
    const b = add({
      kind: 'bar', cx: 0, cy: y + (high ? 1.65 : 0.75), cz: z, hx: len, hy: high ? 0.75 : 0.4, hz: 0.45,
      hazard: true, omega, dynamic: true, color,
    });
    b.update = (c, world) => { c.yaw = omega * world.t + phase; };
    return b;
  };
  // Move a collider back and forth along one axis: cx/cy/cz are the centre of travel, `amp` the half-travel.
  const osc = (c, axis, amp, f, ph, base = c['c' + axis]) => {
    c.dynamic = true;
    c.update = (m, world, dt) => {
      const n = base + amp * Math.sin(world.t * f + ph), key = 'c' + axis, d = 'd' + axis, v = 'v' + axis;
      m[d] = n - m[key]; m[key] = n; m[v] = dt > 0 ? m[d] / dt : 0;
    };
    return c;
  };
  // One falling tile whose top surface sits at `top`.
  const tile = (x, top, z, color, ice = false) => {
    const t = add({
      kind: 'tile', cx: x, cy: top - 0.4, cz: z, hx: 1.75, hy: 0.4, hz: 1.75,
      dynamic: true, color, ice,
    });
    t.baseY = top - 0.4; t.state = 'idle'; t.timer = 0; t.fv = 0; t.pop = 1;
    t.update = tileUpdate;
    w.tiles.push(t);
    return t;
  };
  // Rows of falling tiles across six columns; one or two holes per row.
  // opts: y = height of the tile tops, holes(k, rnd) = holes in row k, skip(k) = columns left out for something else.
  const tileField = (z0, rows, seed, colors, ice = false, { y = 0, holes, skip } = {}) => {
    const rnd = mulberry(seed);
    const cols = [-9.5, -5.7, -1.9, 1.9, 5.7, 9.5];
    for (let k = 0; k < rows; k++) {
      const missing = new Set(skip ? skip(k) : []);
      const target = missing.size + (holes ? holes(k, rnd) : 1 + (rnd() < 0.5 ? 1 : 0));
      while (missing.size < target) missing.add(Math.floor(rnd() * cols.length));
      cols.forEach((x, i) => {
        if (!missing.has(i)) tile(x, y, z0 - 4 * k, colors[(i + k) % colors.length], ice);
      });
    }
  };
  // A side piston that slides along X: `from` is its centre at rest, `to` its centre fully out (both signed by `side`).
  const piston = (z, side, f, ph, { from, to, hx = 4, y = 0, amp = 0.75, hy = 1.6 }) => {
    const p = add({ kind: 'piston', cx: side * from, cy: y + hy, cz: z, hx, hy, hz: 1.3, hazard: true, dynamic: true });
    p.update = (c, world, dt) => {
      const s = clamp(0.5 + amp * Math.sin(world.t * f + ph), 0, 1);
      const nx = side * (from + (to - from) * s);
      c.dx = nx - c.cx; c.cx = nx; c.vx = dt > 0 ? c.dx / dt : 0;
    };
    return p;
  };
  // A platform that slides sideways over the void (bots chase these through w.movers).
  const slider = (z, amp, f, ph, pal, { wd = 7, dp = 7, x = 0, top = 0 } = {}) => {
    const c = osc(plat(x, top, z, wd, dp, { kind: 'mover', pal }), 'x', amp, f, ph);
    w.movers.push(c);
    return c;
  };

  // Shared start pad (+ the gate that drops on GO). Every level starts here, so the lobby is the same everywhere.
  plat(0, 0, 8, 30, 32, { cp: 0, pal: ['#ffffff', '#ffc2dc'], label: 'start' });
  w.gate = add({ kind: 'gate', cx: 0, cy: 1.5, cz: 12.5, hx: 15, hy: 1.5, hz: 0.4 });

  lv.build(w, { add, plat, cp, bar, osc, tileField, tile, piston, slider });

  resetWorld(w);
  return w;
}

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */
// build(w, kit)  lays out everything beyond the start pad (kit = add, plat, cp, bar, osc, tileField, tile, piston, slider).
// finish         {z, y}: crossing z while standing at height >= y-1 qualifies (y is the summit's top).
// ai(w, ch, b)   optional steering hint for bots: {tx, tz?} = where to aim instead of their usual lane.
// theme          colours and scenery style for the renderer.
const lanes = (b, k) => b.lane * k;

// Bot steering for rows of sliding platforms: aim at the one in the next row that sits closest to us.
function chaseMover(w, ch) {
  const from = ch.ground && ch.ground.kind === 'mover' ? ch.ground.cz - 1 : ch.z - 1;
  let nz = -Infinity;
  for (const p of w.movers) if (p.cz < from && p.cz > nz) nz = p.cz;
  if (nz < from - 8) return null;                     // nothing close enough: run on as usual
  let best = null;
  for (const p of w.movers) {
    if (Math.abs(p.cz - nz) < 0.5 && (!best || Math.abs(p.cx - ch.x) < Math.abs(best.cx - ch.x))) best = p;
  }
  return { tx: best.cx + best.vx * 0.3, tz: best.cz };
}

// Bot steering for a staircase whose steps come in pieces: aim at the nearest piece of the next step.
function chaseStep(w, ch) {
  let nz = -Infinity;
  for (const c of w.colliders) if (c.kind === 'step' && c.cz < ch.z - 1 && c.cz > nz) nz = c.cz;
  let best = null;
  for (const c of w.colliders) {
    if (c.kind === 'step' && Math.abs(c.cz - nz) < 0.5 && (!best || Math.abs(c.cx - ch.x) < Math.abs(best.cx - ch.x))) best = c;
  }
  return best ? { tx: best.cx, tz: best.cz } : null;
}

export const LEVELS = [
  {
    id: 'summit',
    name: 'Sweeper Summit',
    blurb: 'Sweepers, sliding platforms, a tile field and a stair-climb to the crown.',
    finish: { z: -244, y: 4.5 },
    theme: {
      sky: ['#5fc3ff', '#b9e6ff', '#ffd9ec'], fog: '#ffd3ea', ground: '#ffb8d9', goo: '#ff4fa3', gooGlow: '#6a1240',
      pastel: ['#ffb3d1', '#b8e0ff', '#c8f2a0', '#ffe08a', '#d9c2ff', '#ffc8a2'], scenery: 'pillar',
    },
    build(w, { add, plat, cp, bar, tileField }) {
      cp(0, -16); cp(0, -96); cp(0, -158); cp(0, -211);

      // Sweeper bars
      plat(0, 0, -31.5, 30, 41, { cp: 1, pal: ['#ffffff', '#bfe6ff'] });
      bar(-24, 1.1, 0, '#ff5d73', { high: true, tall: true });
      bar(-40, -1.35, 1.2, '#ffb703', { tall: true });

      // Sliding platforms over the void
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

      // Landing + falling tiles
      plat(0, 0, -99, 24, 16, { cp: 2, pal: ['#ffffff', '#c8f2a0'] });
      tileField(-111, 10, 11, ['#ff6b9d', '#ffd23f', '#3bceac', '#4ea8de']);

      // Narrow bridge with side pistons
      plat(0, 0, -161, 24, 18, { cp: 3, pal: ['#ffffff', '#ffd6a5'] });
      plat(0, 0, -188, 6, 36, { pal: ['#ffffff', '#cdb4ff'] });
      [[-178, 1, 1.5, 0], [-188, -1, 1.6, 2.2], [-198, 1, 1.4, 4.1]].forEach(([z, side, f, ph]) => {
        const p = add({ kind: 'piston', cx: side * 7.5, cy: 1.6, cz: z, hx: 4, hy: 1.6, hz: 1.3, hazard: true, dynamic: true });
        p.update = (c, world, dt) => {
          const s = clamp(0.5 + 0.75 * Math.sin(world.t * f + ph), 0, 1);
          const nx = side * (7.5 - 7.5 * s);
          c.dx = nx - c.cx; c.cx = nx; c.vx = dt > 0 ? c.dx / dt : 0;
        };
      });

      // Stairs and the summit
      plat(0, 0, -215, 24, 18, { cp: 4, pal: ['#ffffff', '#fff3a3'] });
      bar(-208, 1.3, 0.5, '#ff5d73', { high: true, tall: true });
      bar(-222, -1.5, 2.0, '#ffb703', { tall: true });
      for (let i = 1; i <= 5; i++) {
        add({
          kind: 'step', cx: 0, cy: 0.45 * i, cz: -224 - 3 * (i - 1) - 1.5,
          hx: 7, hy: 0.45 * i, hz: 1.5, pal: ['#ffffff', ['#ff9ec7', '#ffd166', '#9be564', '#8ecae6', '#cdb4ff'][i - 1]],
        });
      }
      plat(0, 4.5, -247, 20, 16, { pal: ['#fff6bf', '#ffd23f'], label: 'summit' });
    },
    ai(w, ch, b) {
      const z = ch.z;
      if (z < -46 && z > -92 && ch.y > -3) {
        // Chase the next sliding platform.
        const from = ch.ground && ch.ground.kind === 'mover' ? ch.ground.cz - 1 : z - 1;
        const m = w.movers.find((p) => p.cz < from);
        return m ? { tx: m.cx + m.vx * 0.3, tz: m.cz } : { tx: 0 };
      }
      if (z < -112 && z > -150) return { tx: lanes(b, 0.55) };
      if (z < -166 && z > -208) return { tx: Math.sin(w.t * b.nf + b.np) * 0.4 };
      if (z < -222) return { tx: lanes(b, 0.4) };
      return null;
    },
  },

  {
    id: 'conveyor',
    name: 'Conveyor Crunch',
    blurb: 'Run against the belts, get shoved sideways, then bounce across the gaps.',
    finish: { z: -153, y: 4 },
    theme: {
      sky: ['#ff8a5c', '#ffc27a', '#ffe9b8'], fog: '#ffd9a8', ground: '#ffb07a', goo: '#2ec4b6', gooGlow: '#0a4a45',
      pastel: ['#ffd1a1', '#ffe0b3', '#f6a97a', '#9ad7cf', '#ffc2a2', '#ffeab0'], scenery: 'box',
    },
    build(w, { plat, cp, bar }) {
      const warm = (c) => ['#ffffff', c];
      // A: a belt running back toward the start, with two sweepers on it
      plat(0, 0, -28, 30, 40, { belt: { x: 0, z: 3 }, pal: warm('#ffb4a2') });
      bar(-22, 1.3, 0, '#ff5d73');
      bar(-38, -1.5, 1.2, '#ffb703');
      plat(0, 0, -55, 30, 14, { cp: cp(0, -52), pal: warm('#ffe3a3') });
      // C: three side belts that shove you toward the edge, alternating direction
      plat(0, 0, -67, 18, 10, { belt: { x: 4.5, z: 0 }, pal: warm('#a0e7e5') });
      plat(0, 0, -77, 18, 10, { belt: { x: -4.5, z: 0 }, pal: warm('#b4f8c8') });
      plat(0, 0, -87, 18, 10, { belt: { x: 4.5, z: 0 }, pal: warm('#a0e7e5') });
      plat(0, 0, -99, 30, 14, { cp: cp(0, -96), pal: warm('#ffe3a3') });
      // First launch: a 7 m gap that only the bounce pad gets you across. A pad launches you from its
      // front edge, so it is kept thin and the landing deck starts ~9 m beyond that edge.
      plat(0, 0, -107, 30, 2, { bounce: 22, pal: ['#ffffff', '#ff7ab6'] });
      plat(0, 0, -122, 30, 14, { cp: cp(0, -118), pal: warm('#ffd6a5') });
      bar(-124, 1.6, 0, '#ff5d73');
      bar(-124, 1.6, Math.PI / 2, '#ff5d73');
      // Second launch: up onto the summit (the deck is 4 m higher, so it sits closer)
      plat(0, 0, -130, 30, 2, { bounce: 24, pal: ['#ffffff', '#ff7ab6'] });
      plat(0, 4, -150, 30, 26, { cp: cp(4, -141), pal: ['#fff6bf', '#ffd23f'], label: 'summit' });
    },
    ai(w, ch, b) {
      const z = ch.z;
      if (z < -60 && z > -96) return { tx: 0 };               // stay centred while the side belts push
      return { tx: lanes(b, 0.45) };
    },
  },

  {
    id: 'ice',
    name: 'Slip & Slide',
    blurb: 'Everything is icy: steering is loose, sweepers send you skating, and the tiles are slick.',
    finish: { z: -208, y: 0 },
    theme: {
      sky: ['#7fb7ff', '#cfeaff', '#f2fbff'], fog: '#e3f4ff', ground: '#cfe9ff', goo: '#7fe3ff', gooGlow: '#134a63',
      pastel: ['#ffffff', '#d6efff', '#c4e3ff', '#e8f6ff', '#bfeaf5', '#ffffff'], scenery: 'cone',
    },
    build(w, { add, plat, cp, bar, tileField }) {
      const icy = (c) => ['#f4fcff', c];
      // A: an ice rink with two sweepers
      plat(0, 0, -28, 30, 40, { ice: true, pal: icy('#bfe8ff') });
      bar(-22, 1.0, 0, '#5dc8ff');
      bar(-38, -1.2, 1.2, '#7b8cff');
      plat(0, 0, -54, 30, 12, { cp: cp(0, -52), pal: icy('#cfe0ff') });
      // C: icy bridge with pistons that nudge you toward the edge
      plat(0, 0, -81, 12, 42, { ice: true, pal: icy('#a8d8ff') });
      [[-70, 1, 1.4, 0], [-82, -1, 1.5, 2.2], [-94, 1, 1.3, 4.1]].forEach(([z, side, f, ph]) => {
        const p = add({ kind: 'piston', cx: side * 8.5, cy: 1.6, cz: z, hx: 4, hy: 1.6, hz: 1.3, hazard: true, dynamic: true });
        p.update = (c, world, dt) => {
          const s = clamp(0.5 + 0.7 * Math.sin(world.t * f + ph), 0, 1);
          const nx = side * (8.5 - 8.5 * s);
          c.dx = nx - c.cx; c.cx = nx; c.vx = dt > 0 ? c.dx / dt : 0;
        };
      });
      plat(0, 0, -108, 30, 12, { cp: cp(0, -106), pal: icy('#cfe0ff') });
      // E: slippery falling tiles
      tileField(-116, 8, 23, ['#d6f1ff', '#bfe3ff', '#e9f8ff', '#aee0f2'], true);
      plat(0, 0, -158, 30, 16, { cp: cp(0, -154), pal: icy('#cfe0ff') });
      // G: the finale rink
      plat(0, 0, -192, 30, 52, { ice: true, pal: ['#fffdf2', '#ffe9a6'], label: 'summit' });
      bar(-180, 1.2, 0, '#ff9ec7');
      bar(-196, -1.4, 0.8, '#ffb703');
    },
    ai(w, ch, b) {
      const z = ch.z;
      if (z < -62 && z > -102) return { tx: Math.sin(w.t * b.nf + b.np) * 1.2 };   // stay on the bridge
      if (z < -114 && z > -150) return { tx: lanes(b, 0.55) };
      return { tx: lanes(b, 0.5) };
    },
  },

  {
    id: 'lifts',
    name: 'Sky Lifts',
    blurb: 'Time the elevators up into the clouds, then dash along a sky bridge of sweepers.',
    finish: { z: -148, y: 10 },
    theme: {
      sky: ['#3a2f8f', '#c36bb5', '#ffb677'], fog: '#e8a6b8', ground: '#8a6bd0', goo: '#ffe6f2', gooGlow: '#8a5a9a',
      pastel: ['#ff9ec7', '#ffd166', '#9be0ff', '#d9c2ff', '#ffb677', '#c8f2a0'], scenery: 'pillar',
    },
    build(w, { plat, cp, bar, osc }) {
      const sky = (c) => ['#ffffff', c];
      plat(0, 0, -24, 30, 32, { cp: cp(0, -37), pal: sky('#ffc2dc') });
      bar(-26, 1.2, 0, '#ff5d73');
      // Lift 1: surface at 0 <-> 5
      osc(plat(0, 0, -48, 10, 10, { kind: 'mover', pal: sky('#ffd166') }), 'y', 2.5, 0.95, 0, 1.5);
      plat(0, 5, -63, 30, 14, { cp: cp(5, -59), pal: sky('#9be564') });
      // Lift 2: surface at 5 <-> 10
      osc(plat(0, 5, -76, 10, 10, { kind: 'mover', pal: sky('#8ecae6') }), 'y', 2.5, 0.9, 1.7, 6.5);
      plat(0, 10, -91, 30, 14, { cp: cp(10, -87), pal: sky('#cdb4ff') });
      // The sky bridge
      plat(0, 10, -117, 8, 40, { pal: sky('#ffc2dc') });
      bar(-108, 1.8, 0, '#ff5d73', { y: 10, len: 7 });
      bar(-122, -2.0, 1.0, '#ffb703', { y: 10, len: 7 });
      plat(0, 10, -150, 26, 26, { cp: cp(10, -141), pal: ['#fff6bf', '#ffd23f'], label: 'summit' });
    },
    ai(w, ch, b) {
      if (ch.z < -40) return { tx: Math.sin(w.t * b.nf + b.np) * 0.6 };
      return { tx: lanes(b, 0.4) };
    },
  },

  {
    id: 'fallzone',
    name: 'Fall Zone',
    blurb: 'Dodge sweepers and pistons while the floor drops out from under you, then climb the stairs for a last tile run.',
    finish: { z: -204, y: 3.6 },
    theme: {
      sky: ['#2fc9a0', '#b4f2cf', '#fff1b0'], fog: '#d6f7c8', ground: '#a6e58c', goo: '#ff8a3d', gooGlow: '#7a2e08',
      pastel: ['#9be564', '#ffe08a', '#ff9ec7', '#8ecae6', '#d9c2ff', '#ffc8a2'], scenery: 'box',
    },
    build(w, { add, plat, cp, bar, tileField, piston }) {
      // A: sweepers over falling tiles. Each pillar stands on a solid block that replaces the two centre tiles of its row.
      const SWEEP_ROWS = [2, 5, 8, 11];
      tileField(-10, 14, 31, ['#ff6b9d', '#ffd23f', '#3bceac', '#4ea8de'], false, {
        holes: () => 0, skip: (k) => (SWEEP_ROWS.includes(k) ? [2, 3] : []),
      });
      const bars = [[1.1, 0, '#ff5d73', false], [-1.3, 1.2, '#ffb703', true], [1.4, 2.4, '#ff5d73', false], [-1.5, 0.7, '#ffb703', false]];
      SWEEP_ROWS.forEach((k, i) => {
        const z = -10 - 4 * k, [om, ph, col, high] = bars[i];
        plat(0, 0, z, 7.3, 3.5, { pal: ['#ffffff', '#bfe6ff'], cp: i % 2 ? cp(0, z) : undefined });
        bar(z, om, ph, col, { high, tall: high });
      });
      plat(0, 0, -70, 30, 12, { cp: cp(0, -69), pal: ['#ffffff', '#c8f2a0'] });

      // B: pistons shoving beans around on falling tiles (pistons sit on the odd rows, holes on the even ones)
      tileField(-78, 12, 47, ['#ffb3d1', '#b8e0ff', '#ffe08a', '#c8f2a0'], false, {
        holes: (k, rnd) => (k % 2 ? 0 : 1 + (rnd() < 0.3 ? 1 : 0)),
      });
      [1, 3, 5, 7, 9, 11].forEach((k, i) => {
        piston(-78 - 4 * k, i % 2 ? -1 : 1, 1.35 + (i % 3) * 0.12, i * 1.9, { from: 15.4, to: 5 });
      });
      plat(0, 0, -131, 30, 14, { cp: cp(0, -129), pal: ['#ffffff', '#ffd6a5'] });

      // C: stairs up, then a plain falling-tile run at the top
      for (let i = 1; i <= 4; i++) {
        add({
          kind: 'step', cx: 0, cy: 0.45 * i, cz: -138 - 3 * (i - 1) - 1.5,
          hx: 9, hy: 0.45 * i, hz: 1.5, pal: ['#ffffff', ['#ff9ec7', '#ffd166', '#9be564', '#8ecae6'][i - 1]],
        });
      }
      plat(0, 3.6, -156, 26, 12, { cp: cp(3.6, -153), pal: ['#ffffff', '#fff3a3'] });
      tileField(-164, 9, 59, ['#ff9e7a', '#ffd23f', '#9be564', '#6ec3ff'], false, { y: 3.6 });
      plat(0, 3.6, -206, 22, 16, { pal: ['#fff6bf', '#ffd23f'], label: 'summit' });
    },
    ai(w, ch, b) {
      const z = ch.z;
      if (z < -76 && z > -126) return { tx: Math.sin(w.t * b.nf + b.np) * 5 };   // weave between the pistons
      if (z < -138 && z > -152) return { tx: 0 };
      return { tx: lanes(b, 0.5) };
    },
  },

  {
    id: 'froggier',
    name: 'Froggier',
    blurb: 'Hop across lanes of sliding platforms, with piston gauntlets to survive in between.',
    finish: { z: -208, y: 0 },
    theme: {
      sky: ['#1fb6a6', '#9fe8c8', '#eaffc4'], fog: '#c9f2d3', ground: '#7fd69e', goo: '#4cc96a', gooGlow: '#0f4a2a',
      pastel: ['#b6f08a', '#8ee3c8', '#ffe27a', '#ffb3c7', '#bfe8ff', '#d9c2ff'], scenery: 'pillar',
    },
    build(w, { plat, cp, slider, piston }) {
      const pad = (c) => ['#ffffff', c];
      // `lanes` rows of platforms, 7 m apart, `n` per row sliding in opposite directions. The first row is centred at z.
      const road = (z, n, amp, wd, f0, seed, tint) => {
        for (let i = 0; i < n; i++) {
          const f = f0 + (i % 3) * 0.14, ph = i * 1.7 + seed;
          for (const half of [0, 1]) slider(z - 7 * i, amp, f * (i % 2 ? -1 : 1), ph + half * 2.5, pad(tint[(i + half) % tint.length]), { wd, dp: 4 });
        }
      };
      const bridge = (z, cpz, specs) => {
        plat(0, 0, z, 16, 40, { cp: cp(0, cpz), pal: pad('#ffe3a3') });
        specs.forEach(([pz, side, f, ph]) => piston(pz, side, f, ph, { from: 12.3, to: 4 }));
      };
      road(-13, 4, 8, 6, 0.75, 0, ['#ffd166', '#8ecae6', '#9be564', '#ff9ec7']);
      bridge(-59, -42, [[-47, 1, 1.4, 0], [-55, -1, 1.5, 2.2], [-63, 1, 1.45, 4.1], [-71, -1, 1.55, 1.0]]);
      road(-84, 5, 9, 5.5, 0.9, 1.1, ['#8ecae6', '#ffd166', '#ff9ec7', '#9be564']);
      bridge(-137, -120, [[-124, -1, 1.6, 0.5], [-131, 1, 1.7, 2.6], [-138, -1, 1.55, 4.4], [-145, 1, 1.75, 0.9], [-152, -1, 1.65, 3.3]]);
      road(-162, 6, 10, 5, 1.0, 2.3, ['#9be564', '#ff9ec7', '#ffd166', '#8ecae6']);
      plat(0, 0, -210, 24, 16, { pal: ['#fff6bf', '#ffd23f'], label: 'summit' });
    },
    ai(w, ch, b) {
      const z = ch.z;
      const lane = (z < -8 && z > -40) || (z < -80 && z > -118) || (z < -157 && z > -200);
      if (lane && ch.y > -3) return chaseMover(w, ch);
      if ((z < -40 && z > -80) || (z < -118 && z > -157)) return { tx: Math.sin(w.t * b.nf + b.np) * 6 };
      return { tx: lanes(b, 0.4) };
    },
  },

  {
    id: 'zigzags',
    name: 'Zigzags',
    blurb: 'Squeeze past a piston wall, ride the sliders, dash a thin sweeper bridge, then zigzag up a split staircase.',
    finish: { z: -253, y: 8.1 },
    theme: {
      sky: ['#2b2f8f', '#7d78e6', '#ffd0ee'], fog: '#d4cbf7', ground: '#8f9be8', goo: '#b56bff', gooGlow: '#3b1a6e',
      pastel: ['#ff9ec7', '#9be0ff', '#ffe08a', '#c8f2a0', '#d9c2ff', '#ffb677'], scenery: 'cone',
    },
    build(w, { add, plat, cp, bar, slider, piston }) {
      const sky = (c) => ['#ffffff', c];
      // A: the piston wall. No floor down the middle, just a strip on each side; the pistons slam out of the central void.
      [[23, -19.5, -12], [21, -41.5, -35]].forEach(([dp, cz, cpz]) => {
        for (const side of [-1, 1]) plat(side * 8, 0, cz, 7, dp, { cp: cp(0, cpz, side * 8, 5), pal: sky(side < 0 ? '#ffc2dc' : '#bfe6ff') });
      });
      [-18, -26, -34, -42, -50].forEach((z, i) => {
        const f = 1.25 + (i % 3) * 0.12, ph = i * 1.35;
        piston(z, 1, f, ph, { from: 0.7, to: 8, hx: 3.5, amp: 0.8 });
        piston(z, -1, f, ph, { from: 0.7, to: 8, hx: 3.5, amp: 0.8, hy: 1.55 });     // a hair lower so the two tops never z-fight
      });
      plat(0, 0, -57, 26, 10, { cp: cp(0, -54), pal: sky('#ffe3a3') });

      // B: sliders that cross over in the middle
      [0.8, 0.9, 0.85, 0.95].forEach((f, i) => {
        slider(-67.5 - 9 * i, 6.5, f, [0, 3.4, 0.6, 4.0][i], sky(['#ffd166', '#8ecae6', '#9be564', '#ff9ec7'][i]), { wd: 8, dp: 7 });
      });
      plat(0, 0, -105, 26, 10, { cp: cp(0, -103), pal: sky('#c8f2a0') });

      // C: thin sweeper bridge
      plat(0, 0, -134, 8, 48, { pal: sky('#ffc2dc') });
      bar(-123, 1.8, 0, '#ff5d73', { len: 7 });
      bar(-135, -2.0, 1.0, '#ffb703', { len: 7 });
      bar(-147, 2.2, 2.0, '#ff5d73', { len: 7 });
      plat(0, 0, -163, 26, 10, { cp: cp(0, -161), pal: sky('#cdb4ff') });

      // D: faster sliders
      [1.0, 1.15, 1.05, 1.2, 1.1].forEach((f, i) => {
        slider(-173 - 8 * i, 7, f, [0, 3.5, 1.0, 4.3, 2.0][i], sky(['#8ecae6', '#ffd166', '#ff9ec7', '#9be564', '#cdb4ff'][i]), { wd: 7, dp: 6 });
      });
      plat(0, 0, -216, 26, 12, { cp: cp(0, -213), pal: sky('#ffd6a5') });

      // E: the stairs start in the middle, split to the two sides (nothing in the centre), then merge again
      const gaps = [0, 0, 5, 9, 12, 9, 5, 0, 0];
      const tint = ['#ff9ec7', '#ffd166', '#9be564', '#8ecae6', '#cdb4ff'];
      gaps.forEach((g, k) => {
        const i = k + 1, cz = -222 - 3 * k - 1.5;
        const xs = g === 0 ? [[0, 4.9]] : [[-(g / 2 + 2.45), 2.45], [g / 2 + 2.45, 2.45]];
        for (const [x, hx] of xs) add({ kind: 'step', cx: x, cy: 0.45 * i, cz, hx, hy: 0.45 * i, hz: 1.5, pal: ['#ffffff', tint[k % tint.length]] });
      });
      plat(0, 8.1, -257, 22, 16, { pal: ['#fff6bf', '#ffd23f'], label: 'summit' });
    },
    ai(w, ch, b) {
      const z = ch.z;
      if (z < -8 && z > -54) return { tx: b.lane < 0 ? -8 : 8 };                       // stick to one strip
      if ((z < -60 && z > -102) || (z < -167 && z > -210)) return chaseMover(w, ch);
      if (z < -108 && z > -160) return { tx: Math.sin(w.t * b.nf + b.np) * 0.6 };
      if (z < -210 && z > -254) return chaseStep(w, ch);
      return { tx: lanes(b, 0.4) };
    },
  },

  {
    id: 'climb',
    name: 'The Great Climb',
    blurb: 'One long stairway to the sky: sweepers built into the steps, a staircase that splits and rejoins, then pistons on the stairs.',
    finish: { z: -294, y: 34.65 },
    theme: {
      sky: ['#ff9a5c', '#ffd07a', '#fff2c9'], fog: '#ffe2b0', ground: '#ffc98a', goo: '#ff6b6b', gooGlow: '#7a1f2e',
      pastel: ['#ffd1a1', '#ffb3c7', '#ffe08a', '#c8f2a0', '#bfe8ff', '#d9c2ff'], scenery: 'pillar',
    },
    build(w, { add, cp, bar, piston }) {
      // Everything is one stairway: `n` counts the rises so far, so the surface under us is always RISE * n high.
      const RISE = 0.45, DP = 3, W = 5.6, HALF = 2.8;
      const tints = ['#ff9ec7', '#ffd166', '#9be564', '#8ecae6', '#cdb4ff'];
      let z = -8, n = 0, tintI = 0;
      const top = () => RISE * n;
      // A solid block from the ground up to the current height, `dp` deep, starting at z.
      const box = (x, hx, dp, extra = {}) => add({
        kind: 'step', cx: x, cy: top() / 2, cz: z - dp / 2, hx, hy: top() / 2, hz: dp / 2,
        pal: ['#ffffff', tints[tintI % tints.length]], ...extra,
      });
      // One step up made of one or more pieces ([centre x, half width]).
      const rise = (pieces) => {
        n++;
        for (const [x, hx] of pieces) box(x, hx, DP);
        z -= DP; tintI++;
      };
      const flight = (count) => { for (let i = 0; i < count; i++) rise([[0, W]]); };
      // A flat landing as deep as `dp`; returns its centre z and the height it sits at.
      const landing = (dp, extra) => {
        n++;
        const c = { z: z - dp / 2, y: top() };
        box(0, W, dp, extra && extra(c));
        z -= dp; tintI++;
        return c;
      };
      const rest = () => landing(8, (c) => ({ cp: cp(c.y, c.z) }));
      const zones = (w.zones = {});

      // 1: a plain flight
      flight(14);
      rest();

      // 2: sweepers set into landings along the flight (the high one has to be dived under)
      zones.sweep = [z];
      [[1.3, 0, '#ff5d73', false], [-1.5, 1.2, '#ffb703', true], [1.7, 2.4, '#ff5d73', false]].forEach(([om, ph, col, high]) => {
        flight(4);
        const c = landing(14);
        bar(c.z, om, ph, col, { y: c.y, len: 7, high, tall: high });
      });
      flight(3);
      zones.sweep.push(z);
      rest();

      // 3: the stairs split into two halves with nothing between them, then come back together
      zones.split = [z];
      [0, 2.5, 5, 8, 10, 12, 12, 10, 8, 5, 2.5, 0].forEach((g) => {
        rise(g === 0 ? [[0, W]] : [[-(g / 2 + HALF), HALF], [g / 2 + HALF, HALF]]);
      });
      zones.split.push(z);
      rest();

      // 4: pistons on the stairs, alternating sides
      zones.piston = [z];
      for (let i = 0; i < 14; i++) {
        rise([[0, W]]);
        if (i % 2) {
          const k = (i - 1) / 2;
          piston(z + DP / 2, k % 2 ? -1 : 1, 1.3 + (k % 3) * 0.12, k * 1.9, { from: W + 4, to: 4, y: top() });
        }
      }
      zones.piston.push(z);
      rest();

      // 5: the last flight and the summit
      flight(14);
      n++;
      box(0, 11, 16, { pal: ['#fff6bf', '#ffd23f'], label: 'summit' });
    },
    ai(w, ch, b) {
      const z = ch.z, zn = w.zones;
      if (z < zn.split[0] && z > zn.split[1]) return chaseStep(w, ch);
      if (z < zn.piston[0] && z > zn.piston[1]) return { tx: Math.sin(w.t * b.nf + b.np) * 4 };
      return { tx: lanes(b, 0.5) };
    },
  },
];

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
  ch.x = cp.x + (Math.random() - 0.5) * (cp.spread ?? 12);
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
  if (ch.y >= top || ch.y + (ch.state === 'dive' ? DIVE_H : H) <= bot) return;

  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;           // into box space
  const ox = lx - clamp(lx, -c.hx, c.hx), oz = lz - clamp(lz, -c.hz, c.hz);
  const d2 = ox * ox + oz * oz;
  if (d2 >= R * R) return;

  // Land on top when the feet are near the surface and we are not rising.
  const tol = 0.35 + Math.max(0, -ch.vy) * dt;
  if (ch.y >= top - tol && ch.vy <= 1) {
    if (c.bounce) {                                    // bounce pad: launch instead of landing
      ch.y = top; ch.vy = c.bounce;
      emit(w, 'jump', ch);
      return;
    }
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
  if (g && g.active) {
    ch.x += g.dx; ch.y += g.dy; ch.z += g.dz;
    if (g.belt) { ch.x += g.belt.x * dt; ch.z += g.belt.z * dt; }       // conveyor
  }
  const ice = !!(g && g.ice);

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
    const len = Math.hypot(ax, az), maxd = (ch.grounded ? (ice ? 9 : 48) : 24) * dt;
    if (len > maxd) { ax *= maxd / len; az *= maxd / len; }
    ch.vx += ax; ch.vz += az;
  } else if (ch.grounded) {
    const fr = (ch.state === 'dive' ? 7 : ch.state === 'stun' ? 6 : 30) * (ice ? 0.14 : 1) * dt;
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
// Others are tested at b.px/b.pz when set: their drawn position is interpolated into the past, so
// the client projects it forward to roughly where the server has them now. Returns true on contact.
export function collideWithOthers(me, others) {
  if (me.ghost || me.invuln > 0) return false;
  const min = 2 * R;
  let hit = false;
  for (const b of others) {
    if (!b.placed || b.ghost || b.invuln > 0 || Math.abs(me.y - b.y) > 1.2) continue;
    let dx = me.x - (b.px ?? b.x), dz = me.z - (b.pz ?? b.z);
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2);
    if (d < 1e-4) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
    const pen = (min - d) / 2;                       // the server splits the push between the pair
    me.x += dx * pen; me.z += dz * pen;
    const rv = (me.vx - b.vx) * dx + (me.vz - b.vz) * dz;
    if (rv < 0) { const j2 = (-(1 + 0.35) * rv) / 2; me.vx += dx * j2; me.vz += dz * j2; }
    hit = true;
  }
  return hit;
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
    if (!ch.finished && w.racing && ch.z < w.level.finish.z && ch.y > w.level.finish.y - 1) {
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
  const aim = w.level.ai && w.level.ai(w, ch, b);        // each level steers its bots through its own set pieces
  if (aim) { tx = aim.tx; if (aim.tz !== undefined) tz = aim.tz; }

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
