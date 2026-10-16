// game.js — rendering, input, HUD and game flow. Physics/AI live in sim.js.
import * as THREE from 'three';
import * as S from './sim.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TOTAL = 12;
const TIME_LIMIT = 120;       // seconds before the round is called
const COLORS = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#7bd72b', '#2ec4b6', '#3a86ff', '#8338ec', '#ff5db1', '#00bbf9', '#fb5607'];
const BOT_NAMES = ['Bean Machine', 'Jelly Roll', 'Waddles', 'Sir Bounce', 'Cap’n Wobble', 'Pudding', 'Noodle', 'Gizmo', 'Sprout', 'Biscuit', 'Pickles', 'Mochi', 'Zigzag', 'Tater Tot', 'Muffin'];
const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10 < 4 ? n % 10 : 0]);

/* ------------------------------------------------------------------ */
/* Audio (tiny synth, no assets)                                       */
/* ------------------------------------------------------------------ */
let actx = null, muted = false;
function audioInit() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { /* audio is optional */ }
}
function tone(f1, f2, dur, type = 'sine', vol = 0.1, delay = 0) {
  if (!actx || muted) return;
  const t = actx.currentTime + delay;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f1, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.03);
}
const sfx = {
  jump: () => tone(300, 700, 0.16, 'square', 0.05),
  land: () => tone(160, 70, 0.1, 'sine', 0.12),
  dive: () => tone(500, 150, 0.3, 'sawtooth', 0.05),
  bonk: () => { tone(220, 60, 0.22, 'square', 0.08); tone(900, 300, 0.08, 'triangle', 0.06); },
  fall: () => tone(520, 60, 0.7, 'sawtooth', 0.07),
  count: () => tone(520, 520, 0.18, 'sine', 0.14),
  go: () => { tone(880, 880, 0.45, 'sine', 0.16); tone(1320, 1320, 0.45, 'triangle', 0.08); },
  win: () => [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, f, 0.22, 'triangle', 0.12, i * 0.09)),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, f * 0.95, 0.3, 'triangle', 0.1, i * 0.18)),
};

/* ------------------------------------------------------------------ */
/* Three.js scene                                                      */
/* ------------------------------------------------------------------ */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  $('loading').hidden = true;
  $('fatalMsg').textContent = 'Your browser couldn’t start WebGL, which the game needs.';
  $('fatal').hidden = false;
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffd3ea, 90, 420);

function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Sky gradient
scene.background = canvasTex(2, 512, (g, w, h) => {
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#5fc3ff'); grad.addColorStop(0.55, '#b9e6ff'); grad.addColorStop(1, '#ffd9ec');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
});

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
scene.add(new THREE.HemisphereLight(0xffffff, 0xffb8d9, 1.6));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 160 });
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 78 : 60;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ---------- textures ---------- */
const texCache = new Map();
function checkerTex(c1, c2, rx, ry) {
  const key = `c${c1}${c2}${rx.toFixed(2)}${ry.toFixed(2)}`;
  if (!texCache.has(key)) {
    const t = canvasTex(128, 128, (g) => {
      g.fillStyle = c1; g.fillRect(0, 0, 128, 128);
      g.fillStyle = c2; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(Math.max(1, rx), Math.max(1, ry));
    t.anisotropy = 4;
    texCache.set(key, t);
  }
  return texCache.get(key);
}
function stripeTex(c1, c2, rx) {
  const key = `s${c1}${c2}${rx.toFixed(2)}`;
  if (!texCache.has(key)) {
    const t = canvasTex(128, 128, (g) => {
      g.fillStyle = c1; g.fillRect(0, 0, 128, 128);
      g.fillStyle = c2;
      for (let i = -2; i < 4; i++) {
        g.beginPath();
        g.moveTo(i * 64, 128); g.lineTo(i * 64 + 32, 128); g.lineTo(i * 64 + 96, 0); g.lineTo(i * 64 + 64, 0);
        g.fill();
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(Math.max(1, rx), 1);
    texCache.set(key, t);
  }
  return texCache.get(key);
}
function darker(hex, k = 0.82) { return new THREE.Color(hex).multiplyScalar(k); }

/* ------------------------------------------------------------------ */
/* World + course meshes                                               */
/* ------------------------------------------------------------------ */
const world = S.createWorld();
const visuals = [];   // { mesh, c }

function buildCourse() {
  for (const c of world.colliders) {
    const w2 = c.hx * 2, h2 = c.hy * 2, d2 = c.hz * 2;
    let mesh;
    switch (c.kind) {
      case 'platform': case 'mover': case 'step': {
        const [c1, c2] = c.pal;
        const side = new THREE.MeshStandardMaterial({ color: darker(c2), roughness: 0.7 });
        const top = new THREE.MeshStandardMaterial({ map: checkerTex(c1, c2, w2 / 4, d2 / 4), roughness: 0.6 });
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2), [side, side, top, side, side, side]);
        break;
      }
      case 'bar':
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2),
          new THREE.MeshStandardMaterial({ map: stripeTex(c.color, '#ffffff', w2 / 1.8), roughness: 0.4 }));
        break;
      case 'pillar':
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.hx, c.hx, h2, 24),
          new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.35 }));
        break;
      case 'piston':
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2),
          new THREE.MeshStandardMaterial({ map: stripeTex('#3a2a63', '#ffd23f', 2), roughness: 0.45 }));
        break;
      case 'tile':
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2),
          new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.45 }));
        break;
      case 'gate':
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2),
          new THREE.MeshStandardMaterial({ map: stripeTex('#ff4fa3', '#ffffff', 10), transparent: true, opacity: 0.55, roughness: 0.3 }));
        break;
      default: continue;
    }
    mesh.position.set(c.cx, c.cy, c.cz);
    mesh.rotation.y = c.yaw;
    if (c.kind !== 'gate') { mesh.castShadow = c.kind !== 'tile'; mesh.receiveShadow = true; }
    if (!c.dynamic && c.kind !== 'gate') { mesh.updateMatrix(); mesh.matrixAutoUpdate = false; }
    scene.add(mesh);
    visuals.push({ mesh, c });
  }
}
buildCourse();

function textPlane(text, w, h, bg, fg) {
  const tex = canvasTex(1024, Math.round(1024 * h / w), (g, cw, ch) => {
    g.fillStyle = bg; g.fillRect(0, 0, cw, ch);
    g.fillStyle = 'rgba(255,255,255,.18)';
    const s = ch / 6;
    for (let x = 0; x < cw; x += s * 2) { g.fillRect(x, 0, s, s); g.fillRect(x + s, ch - s, s, s); }
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${ch * 0.6}px Fredoka, "Trebuchet MS", sans-serif`;
    g.lineWidth = ch * 0.07; g.strokeStyle = '#2b1b4a'; g.lineJoin = 'round';
    g.strokeText(text, cw / 2, ch / 2 + 4); g.fillText(text, cw / 2, ch / 2 + 4);
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
}

function buildArch(z, baseY, text, bg, fg, half = 11) {
  const pillarMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 });
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 10, 20), pillarMat);
    p.position.set(s * half, baseY + 5, z); p.castShadow = true; scene.add(p);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshStandardMaterial({ color: bg, roughness: 0.3 }));
    cap.position.set(s * half, baseY + 10.2, z); scene.add(cap);
  }
  const sign = textPlane(text, half * 2 + 2, 3.4, bg, fg);
  sign.position.set(0, baseY + 10.6, z);
  scene.add(sign);
}
buildArch(S.START_Z - 1.5, 0, 'START', '#ff4fa3', '#ffffff', 15.2);
buildArch(S.FINISH_Z, 4.5, 'FINISH', '#3a86ff', '#ffd23f', 10.5);

// Crown on a podium at the summit
const crown = new THREE.Group();
{
  const gold = new THREE.MeshStandardMaterial({ color: '#ffc928', metalness: 0.7, roughness: 0.25, emissive: '#7a4a00', emissiveIntensity: 0.5, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.5, 0.4, 28, 1, true), gold);
  crown.add(ring);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.55, 10), gold);
    spike.position.set(Math.cos(a) * 0.55, 0.45, Math.sin(a) * 0.55);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), gold);
    ball.position.set(Math.cos(a) * 0.55, 0.78, Math.sin(a) * 0.55);
    crown.add(spike, ball);
  }
  crown.position.set(0, 4.5 + 2.4, -249.5);
  crown.scale.setScalar(1.8);
  scene.add(crown);
  const podium = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 1.6, 28), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 }));
  podium.position.set(0, 4.5 + 0.8, -249.5); podium.castShadow = true; podium.receiveShadow = true;
  scene.add(podium);
}

// Goo sea below the course
const goo = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 900, 90, 90).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: '#ff4fa3', emissive: '#6a1240', roughness: 0.25, metalness: 0.05 }),
);
goo.position.set(0, -7, -110);
scene.add(goo);
const gooBase = Float32Array.from(goo.geometry.attributes.position.array);
function animateGoo(t) {
  const pos = goo.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = gooBase[i * 3], z = gooBase[i * 3 + 2];
    pos.setY(i, Math.sin(x * 0.07 + t * 1.1) * 0.35 + Math.cos(z * 0.06 + t * 1.4) * 0.3);
  }
  pos.needsUpdate = true;
}

// Scenery: pastel pillars, floating balls, clouds
const floaters = [];
{
  const pastel = ['#ffb3d1', '#b8e0ff', '#c8f2a0', '#ffe08a', '#d9c2ff', '#ffc8a2'];
  for (let i = 0; i < 38; i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (26 + Math.random() * 55), z = 50 - i * 7.5 - Math.random() * 4;
    const r = 2.5 + Math.random() * 4, h = 14 + Math.random() * 40;
    const col = pastel[i % pastel.length];
    const m = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h + 8, 20), m);
    body.position.set(x, h / 2 - 4, z);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 20, 14), m);
    cap.position.set(x, h - 0.1, z);
    body.matrixAutoUpdate = cap.matrixAutoUpdate = false; body.updateMatrix(); cap.updateMatrix();
    scene.add(body, cap);
  }
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.2 + Math.random() * 2.2, 18, 12),
      new THREE.MeshStandardMaterial({ color: pastel[i % pastel.length], roughness: 0.3 }));
    m.position.set((Math.random() < 0.5 ? -1 : 1) * (22 + Math.random() * 30), 6 + Math.random() * 22, 40 - Math.random() * 300);
    m.userData = { base: m.position.y, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 0.8 };
    scene.add(m); floaters.push(m);
  }
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.35 });
  for (let i = 0; i < 22; i++) {
    const g = new THREE.Group();
    for (let j = 0; j < 4; j++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(4 + Math.random() * 4, 12, 8), cloudMat);
      s.position.set(j * 6 - 9 + Math.random() * 2, Math.random() * 2, Math.random() * 3); g.add(s);
    }
    g.position.set((Math.random() - 0.5) * 360, 55 + Math.random() * 40, 60 - Math.random() * 380);
    g.matrixAutoUpdate = false; g.updateMatrix();
    scene.add(g);
  }
}

/* ------------------------------------------------------------------ */
/* Beans                                                               */
/* ------------------------------------------------------------------ */
function makeTag(name, isPlayer) {
  const tex = canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = isPlayer ? 'rgba(255,210,63,.95)' : 'rgba(43,27,74,.62)';
    g.beginPath();
    if (g.roundRect) g.roundRect(6, 8, w - 12, h - 16, 34); else g.rect(6, 8, w - 12, h - 16);
    g.fill();
    g.font = '700 50px Fredoka, "Trebuchet MS", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = isPlayer ? '#2b1b4a' : '#ffffff';
    g.fillText(name, w / 2, h / 2 + 3, w - 50);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, fog: false, depthWrite: false }));
  sp.scale.set(2.5, 0.47, 1);
  sp.position.y = 2.15;
  return sp;
}

function makeBean(color, name, isPlayer) {
  const group = new THREE.Group();
  const rig = new THREE.Group(); rig.position.y = 0.7; group.add(rig);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.38 });
  const shoe = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.5, 6, 16), mat);
  body.castShadow = true; rig.add(body);

  const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.2 });
  const black = new THREE.MeshStandardMaterial({ color: '#1b1230', roughness: 0.2 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), white);
    eye.position.set(s * 0.15, 0.36, 0.33);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), black);
    pupil.position.set(s * 0.15, 0.36, 0.44);
    rig.add(eye, pupil);
  }
  const mkLimb = (r, len, x, y, m) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), m);
    limb.position.y = -(len / 2 + r * 0.6); limb.castShadow = true;
    pivot.add(limb); rig.add(pivot);
    return pivot;
  };
  const armL = mkLimb(0.09, 0.2, -0.46, 0.12, mat), armR = mkLimb(0.09, 0.2, 0.46, 0.12, mat);
  const legL = mkLimb(0.12, 0.08, -0.17, -0.4, shoe), legR = mkLimb(0.12, 0.08, 0.17, -0.4, shoe);
  const tag = makeTag(name, isPlayer);
  group.add(tag);
  scene.add(group);
  return { group, rig, mat, armL, armR, legL, legR, tag, phase: Math.random() * 6, squash: 0, ra: [0, 0, 0, 0] };
}

const chars = [];     // chars[0] is the player
const vis = new Map();
let player;

function populate(playerName, playerColor) {
  const others = COLORS.filter((c) => c.toLowerCase() !== playerColor.toLowerCase())
    .sort(() => Math.random() - 0.5);
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < TOTAL; i++) {
    const isP = i === 0;
    const ch = S.createChar({
      id: i, name: isP ? playerName : names[i - 1], color: isP ? playerColor : others[(i - 1) % others.length], isPlayer: isP,
    });
    chars.push(ch);
    vis.set(ch.id, makeBean(ch.color, ch.name, isP));
  }
  player = chars[0];
}

function setPlayerLook(name, color) {
  player.name = name; player.color = color;
  const v = vis.get(player.id);
  v.mat.color.set(color);
  v.group.remove(v.tag);
  v.tag.material.map.dispose(); v.tag.material.dispose();
  v.tag = makeTag(name, true);
  v.group.add(v.tag);
}

const lerpTo = (cur, target, k) => cur + (target - cur) * k;
function animateBean(ch, v, dt, time) {
  const sp = Math.hypot(ch.vx, ch.vz);
  const run = ch.grounded ? Math.min(1, sp / 7) : 0;
  v.phase += sp * dt * 1.5;
  v.squash = Math.max(0, v.squash - dt * 3.2);
  const k = 1 - Math.exp(-20 * dt);

  let rx = 0, y = 0.7, rz = 0, aL = 0, aR = 0, az = 0.12, lL = 0, lR = 0;
  if (ch.state === 'dive') {
    rx = 1.3; y = 0.42; aL = aR = Math.PI * 0.92; az = 0.05; lL = 0.2; lR = -0.1;
  } else if (ch.state === 'stun') {
    rx = -1.35; y = 0.4; rz = Math.sin(time * 18) * 0.2;
    aL = Math.sin(time * 20) * 1.1; aR = -aL; az = 0.8; lL = Math.sin(time * 16) * 0.6; lR = -lL;
  } else if (ch.state === 'done') {
    y = 0.7 + Math.abs(Math.sin(time * 7 + ch.id)) * 0.3; az = 2.5; aL = aR = 0;
    lL = Math.sin(time * 14) * 0.5; lR = -lL;
  } else if (!ch.grounded) {
    rx = 0.12; az = 2.1; lL = 0.55; lR = -0.35;
  } else {
    rx = 0.15 * run;
    const s = Math.sin(v.phase);
    lL = s * 0.95 * run; lR = -lL; aL = -s * 0.85 * run; aR = -aL;
    y += Math.sin(time * 2.2 + ch.id) * 0.012 + Math.abs(s) * 0.05 * run;
  }
  const r = v.rig;
  r.rotation.x = lerpTo(r.rotation.x, rx, k);
  r.rotation.z = lerpTo(r.rotation.z, rz, k);
  r.position.y = lerpTo(r.position.y, y, k);
  v.armL.rotation.x = lerpTo(v.armL.rotation.x, aL, k);
  v.armR.rotation.x = lerpTo(v.armR.rotation.x, aR, k);
  v.armL.rotation.z = lerpTo(v.armL.rotation.z, -az, k);
  v.armR.rotation.z = lerpTo(v.armR.rotation.z, az, k);
  v.legL.rotation.x = lerpTo(v.legL.rotation.x, lL, k);
  v.legR.rotation.x = lerpTo(v.legR.rotation.x, lR, k);

  const stretch = clamp(ch.vy * 0.012, -0.08, 0.14) - v.squash * 0.4;
  r.scale.set(1 - stretch * 0.5, 1 + stretch, 1 - stretch * 0.5);

  v.group.position.set(ch.x, ch.y, ch.z);
  v.group.rotation.y = ch.heading + (ch.state === 'done' ? time * 4 : 0);
  v.tag.position.y = 2.15;
  // Keep the (rotated) group's name tag readable: sprites ignore rotation, so nothing to do.
  v.group.visible = ch.invuln <= 0 || Math.floor(time * 14) % 2 === 0;
}

/* ---------- confetti ---------- */
let confetti = null;
function burstConfetti(at) {
  if (confetti) { scene.remove(confetti.pts); confetti.pts.geometry.dispose(); }
  const N = 260;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), vel = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    pos.set([at.x, at.y + 1.5, at.z], i * 3);
    const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 7;
    vel.set([Math.cos(a) * s, 6 + Math.random() * 8, Math.sin(a) * s], i * 3);
    c.set(COLORS[i % COLORS.length]); col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.38, vertexColors: true, depthWrite: false, fog: false }));
  pts.frustumCulled = false;
  scene.add(pts);
  confetti = { pts, vel, life: 4 };
}
function updateConfetti(dt) {
  if (!confetti) return;
  const p = confetti.pts.geometry.attributes.position, v = confetti.vel;
  for (let i = 0; i < p.count; i++) {
    v[i * 3 + 1] -= 11 * dt;
    p.array[i * 3] += v[i * 3] * dt; p.array[i * 3 + 1] += v[i * 3 + 1] * dt; p.array[i * 3 + 2] += v[i * 3 + 2] * dt;
    v[i * 3] *= 1 - 0.6 * dt; v[i * 3 + 2] *= 1 - 0.6 * dt;
  }
  p.needsUpdate = true;
  confetti.life -= dt;
  if (confetti.life <= 0) { scene.remove(confetti.pts); confetti.pts.geometry.dispose(); confetti = null; }
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */
const keys = new Set();
let joy = { x: 0, y: 0 };
let touchJump = false;
const cam = { yaw: 0, pitch: 0.4, dist: 9.5, focus: new THREE.Vector3(0, 1, 15), pos: new THREE.Vector3(0, 6, 28), shake: 0, user: 0 };
const typing = (e) => e.target instanceof HTMLInputElement;

window.addEventListener('keydown', (e) => {
  if (typing(e)) { if (e.code === 'Enter' && G.phase === 'menu') playNow(); return; }
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'Space') player.jumpReq = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyF') player.diveReq = true;
  if (e.code === 'KeyM') { muted = !muted; toast(muted ? 'Sound off' : 'Sound on'); audioInit(); }
  if (e.code === 'KeyR' && G.phase !== 'menu') startRace();
  if (e.code === 'Enter' && G.phase === 'results') { e.preventDefault(); startRace(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// Drag to orbit the camera
const canvasEl = $('c');
let drag = null;
canvasEl.addEventListener('pointerdown', (e) => {
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  canvasEl.setPointerCapture(e.pointerId);
});
canvasEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  cam.yaw -= (e.clientX - drag.x) * 0.006;
  cam.pitch = clamp(cam.pitch + (e.clientY - drag.y) * 0.004, 0.08, 1.25);
  drag.x = e.clientX; drag.y = e.clientY; cam.user = 3;
});
const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
canvasEl.addEventListener('pointerup', endDrag);
canvasEl.addEventListener('pointercancel', endDrag);
canvasEl.addEventListener('wheel', (e) => { cam.dist = clamp(cam.dist + e.deltaY * 0.01, 5, 16); }, { passive: true });

// Touch controls
const isTouch = window.matchMedia('(pointer: coarse)').matches;
{
  const joyEl = $('joy'), knob = $('knob');
  let jid = null;
  const move = (e) => {
    const r = joyEl.getBoundingClientRect(), R = r.width / 2;
    let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    joy = { x: dx, y: dy };
    knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
  };
  joyEl.addEventListener('pointerdown', (e) => { jid = e.pointerId; joyEl.setPointerCapture(jid); move(e); });
  joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === jid) move(e); });
  const up = (e) => { if (e.pointerId !== jid) return; jid = null; joy = { x: 0, y: 0 }; knob.style.transform = ''; };
  joyEl.addEventListener('pointerup', up); joyEl.addEventListener('pointercancel', up);
  const jb = $('btnJump'), db = $('btnDive');
  jb.addEventListener('pointerdown', (e) => { e.preventDefault(); touchJump = true; player.jumpReq = true; });
  const jUp = () => { touchJump = false; };
  jb.addEventListener('pointerup', jUp); jb.addEventListener('pointercancel', jUp); jb.addEventListener('pointerleave', jUp);
  db.addEventListener('pointerdown', (e) => { e.preventDefault(); player.diveReq = true; });
}

function readInput() {
  const k = (c) => keys.has(c);
  let ix = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
  let iy = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
  ix += joy.x; iy -= joy.y;
  const l = Math.hypot(ix, iy); if (l > 1) { ix /= l; iy /= l; }
  const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw);
  // camera forward = (-sin, -cos), right = (cos, -sin)
  player.wishX = -s * iy + c * ix;
  player.wishZ = -c * iy - s * ix;
  if ((k('Space') || touchJump) && player.grounded) player.jumpReq = true;   // hold to bunny-hop
}

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */
const hud = {
  root: $('hud'), pos: $('posNum'), timer: $('timer'), qual: $('qualNum'), toast: $('toast'),
  banner: $('banner'), flash: $('flash'), track: $('track'), hint: $('hint'),
};
$('posTotal').textContent = TOTAL; $('qualMax').textContent = S.QUALIFY;
const dots = new Map();
let toastT = 0;
function toast(msg, ms = 1600) {
  hud.toast.textContent = msg; hud.toast.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => hud.toast.classList.remove('show'), ms);
}
function banner(text, cls = '') {
  const b = hud.banner;
  b.className = 'banner'; void b.offsetWidth;
  b.textContent = text; b.className = `banner ${cls}`;
  b.classList.add(cls.includes('stay') ? 'stay' : 'show');
}
function flash() { hud.flash.classList.remove('on'); void hud.flash.offsetWidth; hud.flash.classList.add('on'); }

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */
const G = { phase: 'menu', now: 0, t: 0, shownN: 0, resultsAt: 0, pFin: false, overHandled: false, hintT: 0 };

function layoutGrid() {
  S.resetWorld(world);
  const slots = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) slots.push([-9 + col * 6 + (row % 2 ? 1.5 : -0.5), 15.6 + row * 2.9]);
  slots.sort(() => Math.random() - 0.5);
  chars.forEach((ch, i) => {
    S.resetChar(ch, slots[i][0], slots[i][1]);
    if (!ch.isPlayer) S.initBot(ch);
    const v = vis.get(ch.id);
    v.squash = 0;
    v.group.position.set(ch.x, ch.y, ch.z);
  });
  player.maxSpeed = S.RUN;
  G.pFin = false; G.overHandled = false; G.resultsAt = 0;
  if (confetti) { scene.remove(confetti.pts); confetti = null; }
}

function startRace() {
  audioInit();
  layoutGrid();
  $('menu').hidden = true; $('results').hidden = true; hud.root.hidden = false;
  $('touch').hidden = !isTouch;
  hud.hint.classList.remove('fade'); G.hintT = 0;
  hud.banner.className = 'banner';
  G.phase = 'countdown'; G.t = 0; G.shownN = 0;
  cam.yaw = 0; cam.pitch = 0.4; cam.user = 0;
  cam.focus.set(player.x, player.y + 1.1, player.z);
}

function goMenu() {
  layoutGrid();
  G.phase = 'menu';
  $('menu').hidden = false; $('results').hidden = true; hud.root.hidden = true; $('touch').hidden = true;
}

function showResults() {
  G.phase = 'results';
  const ranked = S.rankings(chars);
  const myRank = ranked.indexOf(player) + 1;
  const made = player.finished;
  const title = $('resTitle');
  title.textContent = made ? 'QUALIFIED!' : 'ELIMINATED';
  title.classList.toggle('out', !made);
  $('resSub').textContent = made
    ? `You finished ${ord(player.finishOrder + 1)} of ${TOTAL} in ${player.finishT.toFixed(2)}s${player.falls ? ` · ${player.falls} fall${player.falls > 1 ? 's' : ''}` : ' · flawless run!'}`
    : `Only ${S.QUALIFY} beans can make the cut. You were ${ord(myRank)} on the course.`;
  const list = $('resList'); list.textContent = '';
  ranked.forEach((ch, i) => {
    const li = document.createElement('li');
    if (ch === player) li.className = 'me';
    if (!ch.finished) li.classList.add('out');
    const n = document.createElement('span'); n.textContent = i + 1;
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = ch.color;
    const nm = document.createElement('span'); nm.textContent = ch.name;
    const t = document.createElement('span'); t.className = 't';
    t.textContent = ch.finished ? `${ch.finishT.toFixed(2)}s` : 'DNF';
    li.append(n, d, nm, t);
    list.append(li);
  });
  $('results').hidden = false;
  $('touch').hidden = true;
  (made ? sfx.win : sfx.lose)();
  setTimeout(() => $('againBtn').focus({ preventScroll: true }), 50);
}

world.onEvent = (type, ch, data) => {
  const v = vis.get(ch.id);
  if (type === 'land' && v) v.squash = Math.min(0.5, data / 35);
  if (!ch.isPlayer) return;
  switch (type) {
    case 'jump': sfx.jump(); break;
    case 'land': sfx.land(); break;
    case 'dive': sfx.dive(); break;
    case 'bonk': sfx.bonk(); cam.shake = 0.5; toast('Bonk!', 900); break;
    case 'fall': sfx.fall(); break;
    case 'respawn': flash(); toast('Oops! Back to the checkpoint', 1500); break;
    case 'finish':
      G.pFin = true; G.resultsAt = G.now + 3.6;
      banner('QUALIFIED!', 'small stay'); sfx.win(); burstConfetti({ x: ch.x, y: ch.y, z: ch.z });
      break;
  }
};

function updateFlow(dt) {
  G.now += dt;
  if (G.phase === 'countdown') {
    G.t += dt;
    const n = 3 - Math.floor(G.t);
    if (G.t < 3 && n !== G.shownN) { G.shownN = n; banner(String(n)); sfx.count(); }
    if (G.t >= 3) {
      world.racing = true; world.gate.active = false;
      banner('GO!', 'go'); sfx.go();
      G.phase = 'racing';
    }
  } else if (G.phase === 'racing') {
    G.hintT += dt;
    if (G.hintT > 9) hud.hint.classList.add('fade');
    if (world.raceT > TIME_LIMIT && !world.raceOver) world.raceOver = true;
    if (world.raceOver && !G.overHandled) {
      G.overHandled = true;
      world.racing = false;
      if (!player.finished) {
        banner(world.finishers.length >= S.QUALIFY ? 'ELIMINATED' : 'TIME’S UP', 'bad small stay');
        sfx.lose(); G.resultsAt = G.now + 2.4;
      } else G.resultsAt = Math.min(G.resultsAt, G.now + 1.4);
    }
    if (G.resultsAt && G.now >= G.resultsAt) showResults();
  }
}

function updateHud() {
  const ranked = S.rankings(chars);
  hud.pos.textContent = ranked.indexOf(player) + 1;
  hud.timer.textContent = world.raceT.toFixed(2);
  hud.qual.textContent = world.finishers.length;
  for (const ch of chars) {
    let d = dots.get(ch.id);
    if (!d) {
      d = document.createElement('div');
      d.className = 'track-dot' + (ch.isPlayer ? ' me' : '');
      d.style.background = ch.color;
      hud.track.append(d); dots.set(ch.id, d);
    }
    d.style.background = ch.color;
    d.style.left = `${clamp((S.START_Z - ch.z) / S.COURSE_LEN, 0, 1) * 100}%`;
  }
}

/* ------------------------------------------------------------------ */
/* Camera + per-frame visuals                                          */
/* ------------------------------------------------------------------ */
const tmp = new THREE.Vector3();
function updateCamera(dt, time) {
  const look = new THREE.Vector3();
  if (G.phase === 'menu') {
    // Slow orbit around the starting grid so the lineup shows behind the menu.
    const a = time * 0.22;
    tmp.set(Math.sin(a) * 16, 5.5, 18 + Math.cos(a) * 14);
    cam.pos.lerp(tmp, 1 - Math.exp(-4 * dt));
    camera.position.copy(cam.pos);
    camera.lookAt(0, 1.4, 18);
    return;
  }
  // Follow the player; drift around them once they have finished.
  if (player.finished && cam.user <= 0) cam.yaw += dt * 0.35;
  if (cam.user > 0) cam.user -= dt;
  const f = cam.focus, k = 1 - Math.exp(-18 * dt), ky = 1 - Math.exp(-6 * dt);
  f.x += (player.x - f.x) * k; f.z += (player.z - f.z) * k; f.y += (player.y + 1.1 - f.y) * ky;
  const cp = Math.cos(cam.pitch), dist = cam.dist + (G.phase === 'countdown' ? (3 - G.t) * 1.4 : 0);
  tmp.set(f.x + Math.sin(cam.yaw) * cp * dist, f.y + Math.sin(cam.pitch) * dist, f.z + Math.cos(cam.yaw) * cp * dist);
  cam.pos.lerp(tmp, 1 - Math.exp(-14 * dt));
  camera.position.copy(cam.pos);
  if (cam.shake > 0) {
    cam.shake -= dt * 2.5;
    camera.position.x += (Math.random() - 0.5) * cam.shake * 0.4;
    camera.position.y += (Math.random() - 0.5) * cam.shake * 0.4;
  }
  look.copy(f);
  camera.lookAt(look);
}

function updateVisuals(dt, time) {
  for (const { mesh, c } of visuals) {
    if (!c.dynamic && c.kind !== 'gate') continue;
    mesh.visible = c.active;
    mesh.position.set(c.cx, c.cy, c.cz);
    mesh.rotation.y = c.yaw;
    if (c.kind === 'tile') {
      const shaking = c.state === 'shake';
      if (shaking) mesh.position.x += Math.sin(time * 90 + c.id) * 0.07;
      mesh.material.emissive.set(shaking ? '#ff3b1f' : '#000000');
      mesh.material.emissiveIntensity = shaking ? 0.55 : 0;
      const p = c.pop === undefined ? 1 : c.pop;
      mesh.scale.setScalar(Math.max(0.01, p));
    }
  }
  for (const ch of chars) animateBean(ch, vis.get(ch.id), dt, time);
  for (const m of floaters) m.position.y = m.userData.base + Math.sin(time * m.userData.sp + m.userData.ph) * 1.4;
  crown.rotation.y = time * 1.6;
  crown.position.y = 4.5 + 2.4 + Math.sin(time * 2) * 0.18;
  // sun follows the action so shadows stay crisp
  sun.position.set(cam.focus.x + 22, cam.focus.y + 42, cam.focus.z + 16);
  sun.target.position.copy(cam.focus);
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */
let acc = 0, lastT = performance.now(), gooT = 0;
function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (nowMs - lastT) / 1000);
  lastT = nowMs;
  const time = nowMs / 1000;

  if (G.phase !== 'menu') {
    readInput();
    updateFlow(dt);
  } else { player.wishX = player.wishZ = 0; player.jumpReq = player.diveReq = false; }

  acc += dt;
  while (acc >= S.STEP) { S.stepWorld(world, chars, S.STEP); acc -= S.STEP; }

  updateConfetti(dt);
  updateVisuals(dt, time);
  updateCamera(dt, time);
  if (!hud.root.hidden) updateHud();
  gooT += dt;
  if ((frameCount++ & 1) === 0) animateGoo(gooT);
  renderer.render(scene, camera);
}
let frameCount = 0;

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
const swatchBox = $('swatches');
let chosenColor = COLORS[5];
COLORS.forEach((col) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'swatch'; b.style.background = col;
  b.setAttribute('role', 'radio'); b.setAttribute('aria-label', `Color ${col}`);
  b.setAttribute('aria-checked', String(col === chosenColor));
  b.addEventListener('click', () => {
    chosenColor = col;
    swatchBox.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === b)));
    vis.get(player.id).mat.color.set(col);
    player.color = col;
  });
  swatchBox.append(b);
});

const cleanName = () => ($('nameInput').value.trim() || 'Player').slice(0, 14);
function playNow() {
  setPlayerLook(cleanName(), chosenColor);
  startRace();
}

async function boot() {
  // Let the web font load so the name tags render in it (don't wait forever).
  await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 1200))]);
  populate(cleanName(), chosenColor);
  layoutGrid();
  $('playBtn').addEventListener('click', playNow);
  $('againBtn').addEventListener('click', startRace);
  $('menuBtn').addEventListener('click', goMenu);
  window.__fallBeansReady = true;
  window.__fb = { world, chars, G, cam };   // debugging handle
  $('loading').classList.add('done');
  setTimeout(() => ($('loading').hidden = true), 600);
  requestAnimationFrame(frame);
}
boot();
