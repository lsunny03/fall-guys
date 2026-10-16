// Fall Beans server: static files + authoritative multiplayer rooms over WebSocket.
// The physics is the same public/sim.js the browsers run for prediction.
import * as S from './public/sim.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = `${import.meta.dir}/public`;

const TOTAL = 12;            // beans per race (humans + bots)
const MAX_ROOMS = 40;
const LOBBY_WAIT = 12;       // seconds a public lobby waits before racing
const COUNTDOWN = 3;
const TIME_LIMIT = 120;
const OVER_DELAY = 2.2;      // freeze time between "race over" and the results screen
const RESULTS_TIME = 10;
const SNAP_HZ = 30;

const COLORS = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#7bd72b', '#2ec4b6', '#3a86ff', '#8338ec', '#ff5db1', '#00bbf9', '#fb5607'];
const BOT_NAMES = ['Bean Machine', 'Jelly Roll', 'Waddles', 'Sir Bounce', 'Cap’n Wobble', 'Pudding', 'Noodle', 'Gizmo', 'Sprout', 'Biscuit', 'Pickles', 'Mochi', 'Zigzag', 'Tater Tot', 'Muffin'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const STATE_CODE: Record<string, number> = { run: 0, dive: 1, stun: 2, done: 3 };
const EVENT_CODE: Record<string, string> = { bonk: 'b', respawn: 'r', fall: 'f', finish: 'F', jump: 'j', dive: 'd', land: 'l' };

const r2 = (v: number) => Math.round(v * 100) / 100;
const shuffle = <T>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function cleanName(raw: unknown) {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N} _\-.!?']/gu, '').trim().slice(0, 14);
  return s || 'Player';
}
function cleanColor(raw: unknown) {
  const s = String(raw ?? '').toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : COLORS[5];
}

interface Conn {
  id: number;
  ws: any;
  name: string;
  color: string;
  room: Room | null;
  ch: any | null;               // the bean (null while spectating)
  ct: number | null;            // client-clock stamp of the newest input
  recvAt: number;               // server ms when that input arrived
}

let connSeq = 1;
const rooms = new Map<string, Room>();

class Room {
  code: string;
  pub: boolean;
  conns = new Set<Conn>();
  host: Conn | null = null;
  world = S.createWorld();
  chars: any[] = [];
  phase = 0;                    // 0 lobby, 1 countdown, 2 racing, 3 results
  pt = -1;                      // seconds left on the current phase timer (-1 = none)
  overT = -1;
  overHandled = false;
  nextId = 1;
  acc = 0;
  snapAcc = 0;
  events: any[] = [];
  autoStart = false;

  constructor(code: string, pub: boolean) {
    this.code = code;
    this.pub = pub;
    this.world.lobby = true;
    this.world.onEvent = (type: string, ch: any, data: any) => {
      const code = EVENT_CODE[type];
      if (code) this.events.push(data === undefined ? [code, ch.id] : [code, ch.id, r2(data)]);
    };
  }

  humans() { return [...this.conns].filter((c) => c.ch); }

  join(conn: Conn) {
    conn.room = this;
    this.conns.add(conn);
    if (!this.host && !this.pub) this.host = conn;
    if (this.phase === 0) this.spawnHuman(conn);        // otherwise spectate until the next lobby
    if (this.phase === 0 && this.pub && this.pt < 0) this.pt = LOBBY_WAIT;
    send(conn, { t: 'joined', code: this.code, pub: this.pub });
    this.sendRosters();
    if (this.autoStart && this.phase === 0) { this.autoStart = false; this.startRound(); }
  }

  leave(conn: Conn) {
    this.conns.delete(conn);
    if (conn.ch) this.chars = this.chars.filter((c) => c !== conn.ch);
    conn.ch = null; conn.room = null;
    if (this.host === conn) this.host = this.conns.values().next().value ?? null;
    if (this.conns.size === 0) { rooms.delete(this.code); return; }
    this.sendRosters();
  }

  spawnHuman(conn: Conn) {
    const ch = S.createChar({ id: this.nextId++, name: conn.name, color: conn.color, isPlayer: true });
    ch.human = true;
    this.placeInLobby(ch);
    conn.ch = ch; conn.ct = null;
    this.chars.push(ch);
  }

  placeInLobby(ch: any) {
    S.resetChar(ch, (Math.random() - 0.5) * 24, 15.5 + Math.random() * 6);
    ch.maxSpeed = S.RUN;
  }

  sendRosters() {
    const list = this.chars.map((c) => ({ i: c.id, n: c.name, c: c.color, h: c.human ? 1 : 0 }));
    for (const conn of this.conns) {
      send(conn, { t: 'roster', you: conn.ch ? conn.ch.id : null, host: conn === this.host, code: this.code, pub: this.pub, chars: list });
    }
  }

  startRound() {
    const w = this.world;
    for (const conn of this.conns) if (!conn.ch) this.spawnHuman(conn);
    this.chars = this.chars.filter((c) => c.human);
    S.resetWorld(w);
    w.lobby = false;

    // Fill the grid with bots, avoiding the colours humans already use.
    const used = new Set(this.chars.map((c) => c.color));
    const palette = shuffle(COLORS.filter((c) => !used.has(c)));
    const names = shuffle([...BOT_NAMES]);
    for (let i = 0; this.chars.length < TOTAL; i++) {
      const bot = S.createChar({ id: this.nextId++, name: names[i % names.length], color: palette[i % palette.length] ?? COLORS[i % COLORS.length] });
      S.initBot(bot);
      this.chars.push(bot);
    }
    const slots: number[][] = [];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) slots.push([-9 + col * 6 + (row % 2 ? 1.5 : -0.5), 15.6 + row * 2.9]);
    shuffle(slots);
    this.chars.forEach((ch, i) => {
      const keepBot = ch.bot;
      S.resetChar(ch, slots[i][0], slots[i][1]);
      ch.bot = keepBot;
      ch.maxSpeed = ch.bot ? ch.maxSpeed : S.RUN;
    });
    this.overHandled = false; this.overT = -1;
    this.phase = 1; this.pt = COUNTDOWN;
    this.sendRosters();
  }

  toLobby() {
    const w = this.world;
    for (const conn of this.conns) if (!conn.ch) this.spawnHuman(conn);
    this.chars = this.chars.filter((c) => c.human);
    S.resetWorld(w);
    w.lobby = true;
    for (const ch of this.chars) this.placeInLobby(ch);
    this.overHandled = false; this.overT = -1;
    this.phase = 0; this.pt = this.pub ? LOBBY_WAIT : -1;
    this.sendRosters();
  }

  sendResults() {
    const list = S.rankings(this.chars).map((c: any) => ({ i: c.id, n: c.name, c: c.color, f: c.finished ? 1 : 0, ft: c.finished ? r2(c.finishT) : 0, h: c.human ? 1 : 0, fl: c.falls }));
    this.broadcast({ t: 'results', list });
  }

  broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const conn of this.conns) conn.ws.send(s);
  }

  update(dt: number) {
    const w = this.world;
    this.acc += dt;
    while (this.acc >= S.STEP) { S.stepWorld(w, this.chars, S.STEP); this.acc -= S.STEP; }

    if (this.phase === 0) {
      if (this.pt >= 0) {
        if (this.humans().length >= TOTAL) this.pt = Math.min(this.pt, 1);
        this.pt -= dt;
        if (this.pt <= 0) this.startRound();
      }
    } else if (this.phase === 1) {
      this.pt -= dt;
      if (this.pt <= 0) { this.phase = 2; this.pt = -1; w.racing = true; w.gate.active = false; }
    } else if (this.phase === 2) {
      if (!this.overHandled) {
        const humans = this.chars.filter((c) => c.human);
        const everyoneIn = humans.length > 0 && humans.every((c) => c.finished);
        if (w.raceT > TIME_LIMIT || everyoneIn) w.raceOver = true;
        if (w.raceOver) { this.overHandled = true; w.racing = false; this.overT = OVER_DELAY; }
      } else {
        this.overT -= dt;
        if (this.overT <= 0) { this.phase = 3; this.pt = RESULTS_TIME; this.sendResults(); }
      }
    } else {
      this.pt -= dt;
      if (this.pt <= 0) this.toLobby();
    }

    this.snapAcc += dt;
    if (this.snapAcc >= 1 / SNAP_HZ) { this.snapAcc %= 1 / SNAP_HZ; this.sendSnapshot(); }
  }

  sendSnapshot() {
    const w = this.world;
    const c = this.chars.map((ch) => [
      ch.id, r2(ch.x), r2(ch.y), r2(ch.z), r2(ch.vx), r2(ch.vy), r2(ch.vz), r2(ch.heading),
      STATE_CODE[ch.state] ?? 0, (ch.grounded ? 1 : 0) | (ch.finished ? 2 : 0) | (ch.invuln > 0 ? 4 : 0),
    ]);
    const tl: number[][] = [];
    w.tiles.forEach((t: any, i: number) => {
      if (t.state === 'shake') tl.push([i, 1]);
      else if (t.state === 'fall') tl.push([i, 2, r2(t.cy)]);
      else if (t.state === 'gone') tl.push([i, 3]);
    });
    const shared = JSON.stringify({
      t: 's', ph: this.phase, pt: this.pt < 0 ? -1 : r2(this.pt), w: Math.round(w.t * 1000) / 1000, rt: r2(w.raceT),
      ov: this.overHandled ? 1 : 0, c, tl, fo: w.finishers.map((f: any) => f.id), ft: w.finishers.map((f: any) => r2(f.finishT)), ev: this.events,
    });
    this.events = [];
    const now = performance.now();
    for (const conn of this.conns) {
      // `k`: where the client's own timeline stands, so it can compare its prediction with this state.
      const k = conn.ct == null ? 'null' : (conn.ct + (now - conn.recvAt)).toFixed(1);
      conn.ws.send(`{"k":${k},${shared.slice(1)}`);
    }
  }
}

function send(conn: Conn, msg: unknown) {
  conn.ws.send(JSON.stringify(msg));
}

function newCode() {
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
}

function createRoom(pub: boolean) {
  const room = new Room(newCode(), pub);
  rooms.set(room.code, room);
  return room;
}

function findPublic() {
  let best: Room | null = null;
  for (const r of rooms.values()) {
    if (!r.pub || r.phase !== 0 || r.conns.size >= TOTAL) continue;
    if (!best || r.conns.size > best.conns.size) best = r;
  }
  return best;
}

function handleJoin(conn: Conn, m: any) {
  if (conn.room) return;
  conn.name = cleanName(m.name);
  conn.color = cleanColor(m.color);
  let room: Room | null = null;
  if (m.mode === 'code') {
    room = rooms.get(String(m.code ?? '').toUpperCase().trim()) ?? null;
    if (!room) return send(conn, { t: 'err', msg: 'No room with that code.' });
    if (room.conns.size >= TOTAL) return send(conn, { t: 'err', msg: 'That room is full.' });
  } else {
    if (m.mode === 'public') room = findPublic();
    if (!room) {
      if (rooms.size >= MAX_ROOMS) return send(conn, { t: 'err', msg: 'The servers are busy right now. Try again in a minute.' });
      room = createRoom(m.mode === 'public');
      if (m.mode === 'solo') room.autoStart = true;
    }
  }
  room.join(conn);
}

function handleInput(conn: Conn, m: any) {
  const ch = conn.ch;
  if (!ch) return;
  ch.wishX = Math.max(-1, Math.min(1, finite(m.x)));
  ch.wishZ = Math.max(-1, Math.min(1, finite(m.z)));
  if (m.j) ch.jumpReq = true;
  if (m.d) ch.diveReq = true;
  conn.ct = finite(m.ct);
  conn.recvAt = performance.now();
}

const server = {
  port: PORT,
  async fetch(req: Request, srv: any) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const conn: Conn = { id: connSeq++, ws: null, name: 'Player', color: COLORS[5], room: null, ch: null, ct: null, recvAt: 0 };
      return srv.upgrade(req, { data: conn }) ? undefined : new Response('Expected a WebSocket', { status: 426 });
    }
    if (url.pathname === '/healthz') return new Response('ok');

    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    if (path.includes('..') || path.includes('\0')) return new Response('Not found', { status: 404 });
    const file = Bun.file(PUBLIC_DIR + path);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file, { headers: { 'cache-control': 'no-cache' } });
  },
  websocket: {
    maxPayloadLength: 4096,
    open(ws: any) { ws.data.ws = ws; },
    message(ws: any, raw: string | Buffer) {
      const conn: Conn = ws.data;
      let m: any;
      try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'in': handleInput(conn, m); break;
        case 'join': handleJoin(conn, m); break;
        case 'start':
          if (conn.room && conn.room.host === conn && conn.room.phase === 0) conn.room.startRound();
          break;
        case 'leave': conn.room?.leave(conn); break;
        default: break;                  // 'p' keep-alive and anything unknown
      }
    },
    close(ws: any) { ws.data.room?.leave(ws.data); },
  },
};

// One loop drives every room.
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const room of rooms.values()) {
    try { room.update(dt); } catch (err) { console.error('room error', room.code, err); }
  }
}, 1000 / 60);

export default server;
console.log(`Fall Beans listening on :${PORT}`);
