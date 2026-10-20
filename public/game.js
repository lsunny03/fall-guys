// game.js — rendering, input, HUD and game flow. Physics/AI live in sim.js.
import * as THREE from 'three';
import * as S from './sim.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TOTAL = 12;
const COLORS = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#7bd72b', '#2ec4b6', '#3a86ff', '#8338ec', '#ff5db1', '#00bbf9', '#fb5607'];
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

// Sky gradient (colours come from the level's theme)
function skyTex(stops) {
  return canvasTex(2, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, stops[0]); grad.addColorStop(0.55, stops[1]); grad.addColorStop(1, stops[2]);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
}
scene.background = skyTex(S.LEVELS[0].theme.sky);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
const hemi = new THREE.HemisphereLight(0xffffff, 0xffb8d9, 1.6);
scene.add(hemi);
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
// The room's level decides everything below. loadLevel() swaps the sim world, the meshes, the scenery
// and the colours in one go; nothing else in this file assumes a particular course.
let world = null;
let levelIdx = -1;
let crownBaseY = 6.9;
const visuals = [];                       // { mesh, c } for every collider that moves or toggles
const course = new THREE.Group();         // everything specific to the current level
scene.add(course);
const floaters = [];
const beltAnim = new Map();               // arrow texture -> belt velocity, scrolled every frame

// Chevron texture for conveyor belts. In the canvas "up" is -Z and "right" is +X on the deck's top face.
function arrowTex(dir, c1, c2, rx, ry) {
  const key = `a${dir}${c1}${c2}${rx.toFixed(2)}${ry.toFixed(2)}`;
  if (!texCache.has(key)) {
    const rot = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[dir];
    const t = canvasTex(128, 128, (g) => {
      g.fillStyle = c1; g.fillRect(0, 0, 128, 128);
      g.translate(64, 64); g.rotate(rot); g.translate(-64, -64);
      g.strokeStyle = c2; g.lineWidth = 14; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const oy of [-20, 44, 108]) {              // period 64 divides 128, so the pattern tiles seamlessly
        g.beginPath(); g.moveTo(28, oy + 40); g.lineTo(64, oy); g.lineTo(100, oy + 40); g.stroke();
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(Math.max(1, rx), Math.max(1, ry));
    t.anisotropy = 4;
    texCache.set(key, t);
  }
  return texCache.get(key);
}

function buildCourse(w) {
  for (const c of w.colliders) {
    const w2 = c.hx * 2, h2 = c.hy * 2, d2 = c.hz * 2;
    let mesh;
    switch (c.kind) {
      case 'platform': case 'mover': case 'step': {
        const [c1, c2] = c.pal;
        const side = new THREE.MeshStandardMaterial({ color: darker(c2), roughness: 0.7 });
        let top;
        if (c.belt) {
          const dir = Math.abs(c.belt.x) > Math.abs(c.belt.z) ? (c.belt.x > 0 ? 'right' : 'left') : (c.belt.z > 0 ? 'down' : 'up');
          const map = arrowTex(dir, c1, c2, w2 / 4, d2 / 4);
          beltAnim.set(map, c.belt);
          top = new THREE.MeshStandardMaterial({ map, roughness: 0.55 });
        } else if (c.ice) {
          top = new THREE.MeshStandardMaterial({ map: checkerTex(c1, c2, w2 / 5, d2 / 5), roughness: 0.06, metalness: 0.2 });
        } else if (c.bounce) {
          top = new THREE.MeshStandardMaterial({ map: checkerTex(c1, c2, w2 / 3, 1), roughness: 0.3, emissive: c2, emissiveIntensity: 0.55 });
        } else {
          top = new THREE.MeshStandardMaterial({ map: checkerTex(c1, c2, w2 / 4, d2 / 4), roughness: 0.6 });
        }
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
          new THREE.MeshStandardMaterial({ color: c.color, roughness: c.ice ? 0.08 : 0.45, metalness: c.ice ? 0.2 : 0 }));
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
    course.add(mesh);
    visuals.push({ mesh, c });
  }
}

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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  mesh.userData.ownMap = true;          // not in texCache, so clearCourse() frees it
  return mesh;
}

function buildArch(z, baseY, text, bg, fg, half = 11) {
  const pillarMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 });
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 10, 20), pillarMat);
    p.position.set(s * half, baseY + 5, z); p.castShadow = true; course.add(p);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshStandardMaterial({ color: bg, roughness: 0.3 }));
    cap.position.set(s * half, baseY + 10.2, z); course.add(cap);
  }
  const sign = textPlane(text, half * 2 + 2, 3.4, bg, fg);
  sign.position.set(0, baseY + 10.6, z);
  course.add(sign);
}

// Crown that hovers over the podium at the summit (the group lives for the whole session; loadLevel moves it).
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
  crown.scale.setScalar(1.8);
  scene.add(crown);
}

// Goo sea below the course (the theme recolours it)
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

// Arches, podium and the themed scenery that lines the course.
function buildDecor(lv) {
  const th = lv.theme, fz = lv.finish.z, fy = lv.finish.y;
  const len = S.START_Z - fz;
  buildArch(S.START_Z - 1.5, 0, 'START', '#ff4fa3', '#ffffff', 15.2);
  buildArch(fz, fy, 'FINISH', '#3a86ff', '#ffd23f', 10.5);

  const podium = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 1.6, 28), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 }));
  podium.position.set(0, fy + 0.8, fz - 5.5); podium.castShadow = true; podium.receiveShadow = true;
  course.add(podium);
  crownBaseY = fy + 2.4;
  crown.position.set(0, crownBaseY, fz - 5.5);
  goo.position.z = (S.START_Z + fz) / 2;

  const pastel = th.pastel;
  const count = Math.ceil((len + 80) / 7.5);
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (26 + Math.random() * 55), z = 50 - i * 7.5 - Math.random() * 4;
    const r = 2.5 + Math.random() * 4, h = 14 + Math.random() * 40;
    const m = new THREE.MeshStandardMaterial({ color: pastel[i % pastel.length], roughness: 0.55 });
    const parts = [];
    if (th.scenery === 'cone') {           // ice spires
      parts.push(new THREE.Mesh(new THREE.ConeGeometry(r * 1.3, h + 8, 6), m)); parts[0].position.set(x, h / 2 - 4, z);
    } else if (th.scenery === 'box') {      // factory silos
      parts.push(new THREE.Mesh(new THREE.BoxGeometry(r * 1.7, h + 8, r * 1.7), m)); parts[0].position.set(x, h / 2 - 4, z);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(r * 1.2, 2.5, r * 1.2), m); roof.position.set(x, h + 0.4, z); parts.push(roof);
    } else {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h + 8, 20), m); body.position.set(x, h / 2 - 4, z);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 20, 14), m); cap.position.set(x, h - 0.1, z);
      parts.push(body, cap);
    }
    for (const part of parts) { part.matrixAutoUpdate = false; part.updateMatrix(); course.add(part); }
  }
  const nBalls = Math.max(14, Math.round(26 * (len + 60) / 300));
  for (let i = 0; i < nBalls; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.2 + Math.random() * 2.2, 18, 12),
      new THREE.MeshStandardMaterial({ color: pastel[i % pastel.length], roughness: 0.3 }));
    m.position.set((Math.random() < 0.5 ? -1 : 1) * (22 + Math.random() * 30), 6 + Math.random() * 22, 40 - Math.random() * (len + 60));
    m.userData = { base: m.position.y, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 0.8 };
    course.add(m); floaters.push(m);
  }
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.35 });
  for (let i = 0; i < Math.max(12, Math.round(22 * (len + 60) / 300)); i++) {
    const g = new THREE.Group();
    for (let j = 0; j < 4; j++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(4 + Math.random() * 4, 12, 8), cloudMat);
      s.position.set(j * 6 - 9 + Math.random() * 2, Math.random() * 2, Math.random() * 3); g.add(s);
    }
    g.position.set((Math.random() - 0.5) * 360, 55 + Math.random() * 40, 60 - Math.random() * (len + 140));
    g.matrixAutoUpdate = false; g.updateMatrix();
    course.add(g);
  }
}

function applyTheme(th) {
  const old = scene.background;
  scene.background = skyTex(th.sky);
  if (old && old.dispose) old.dispose();
  scene.fog.color.set(th.fog);
  hemi.groundColor.set(th.ground);
  goo.material.color.set(th.goo);
  goo.material.emissive.set(th.gooGlow);
}

function clearCourse() {
  const cached = new Set(texCache.values());
  course.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.map && !cached.has(m.map) && o.userData.ownMap) m.map.dispose();
      m.dispose();
    }
  });
  course.clear();
  visuals.length = 0; floaters.length = 0; beltAnim.clear();
}

// Swap in course `idx`. Returns true when something changed (callers then re-sync the local sim).
function loadLevel(idx) {
  if (idx === levelIdx || !S.LEVELS[idx]) return false;
  levelIdx = idx;
  clearCourse();
  world = S.createWorld(idx);
  world.mirror = true;                  // this copy only predicts; the server is the authority
  world.onEvent = onWorldEvent;
  buildCourse(world);
  buildDecor(world.level);
  applyTheme(world.level.theme);
  return true;
}
loadLevel(0);

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

const BEAN_SCALE = 0.86;   // visual size only; collision radius/height live in sim.js
function makeBean(color, name, isPlayer) {
  const group = new THREE.Group();
  group.scale.setScalar(BEAN_SCALE);
  const rig = new THREE.Group(); rig.position.y = 0.7; group.add(rig);
  // `wob` pivots at foot level, so wobbling it moves the top of the bean far more than the bottom.
  const wob = new THREE.Group(); wob.position.y = -0.65; rig.add(wob);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.38 });
  const shoe = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.5, 6, 16), mat);
  body.castShadow = true; body.position.y = 0.65; wob.add(body);

  const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.2 });
  const black = new THREE.MeshStandardMaterial({ color: '#1b1230', roughness: 0.2 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), white);
    eye.position.set(s * 0.15, 1.01, 0.33);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), black);
    pupil.position.set(s * 0.15, 1.01, 0.44);
    wob.add(eye, pupil);
  }
  const mkLimb = (r, len, x, y, m, parent = rig) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), m);
    limb.position.y = -(len / 2 + r * 0.6); limb.castShadow = true;
    pivot.add(limb); parent.add(pivot);
    return pivot;
  };
  const armL = mkLimb(0.09, 0.2, -0.46, 0.77, mat, wob), armR = mkLimb(0.09, 0.2, 0.46, 0.77, mat, wob);
  const legL = mkLimb(0.12, 0.08, -0.17, -0.4, shoe), legR = mkLimb(0.12, 0.08, 0.17, -0.4, shoe);
  const tag = makeTag(name, isPlayer);
  tag.scale.multiplyScalar(1 / BEAN_SCALE);   // keep the name tag its original size
  group.add(tag);
  scene.add(group);
  return { group, rig, wob, mat, armL, armR, legL, legR, tag, phase: Math.random() * 6, squash: 0, ra: [0, 0, 0, 0] };
}

const lerpTo = (cur, target, k) => cur + (target - cur) * k;
function animateBean(ch, v, dt, time) {
  const sp = Math.hypot(ch.vx, ch.vz);
  const run = ch.grounded ? Math.min(1, sp / 7) : 0;
  v.phase += sp * dt * 1.1;   // slower stride
  v.squash = Math.max(0, v.squash - dt * 3.2);
  const k = 1 - Math.exp(-13 * dt);   // looser follow = jelly lag

  let rx = 0, y = 0.7, rz = 0, wx = 0, wz = 0, wj = 0, aL = 0, aR = 0, az = 0.12, lL = 0, lR = 0;
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
    wz = Math.sin(time * 8 + ch.id) * 0.14;
    // Arms flail overhead: they flap up and down together while swinging fore/aft out of step.
    const w = time * 11 + ch.id;
    az = 2.1 + Math.sin(w) * 0.55;
    aL = Math.sin(w * 0.5) * 0.9; aR = -aL;
  } else {
    const s = Math.sin(v.phase);
    rx = 0.15 * run;
    // Wobble (on the foot-pivoted `wob` group, so the head swings most): side-to-side waddle,
    // fore/aft bob, and a slow idle sway.
    wx = Math.sin(v.phase * 2 + 1) * 0.1 * run;
    wz = Math.sin(v.phase) * 0.26 * run + Math.sin(time * 2.4 + ch.id) * 0.07;
    wj = Math.sin(v.phase * 2) * 0.05 * run;
    lL = s * 0.95 * run; lR = -lL; aL = -s * 0.85 * run; aR = -aL;
    // Arms also flap out to the sides and swing wider while running, scaled by speed.
    aL *= 1.6; aR *= 1.6;
    az = 0.12 + run * (0.7 + Math.sin(v.phase * 2 + ch.id) * 0.35);
    y += Math.sin(time * 2.2 + ch.id) * 0.012 + Math.abs(s) * 0.05 * run;
  }
  const r = v.rig;
  r.rotation.x = lerpTo(r.rotation.x, rx, k);
  r.rotation.z = lerpTo(r.rotation.z, rz, k);
  r.position.y = lerpTo(r.position.y, y, k);
  const kw = 1 - Math.exp(-9 * dt);   // softer follow than the limbs: the top lags like jelly
  v.wob.rotation.x = lerpTo(v.wob.rotation.x, wx, kw);
  v.wob.rotation.z = lerpTo(v.wob.rotation.z, wz, kw);
  v.armL.rotation.x = lerpTo(v.armL.rotation.x, aL, k);
  v.armR.rotation.x = lerpTo(v.armR.rotation.x, aR, k);
  v.armL.rotation.z = lerpTo(v.armL.rotation.z, -az, k);
  v.armR.rotation.z = lerpTo(v.armR.rotation.z, az, k);
  v.legL.rotation.x = lerpTo(v.legL.rotation.x, lL, k);
  v.legR.rotation.x = lerpTo(v.legR.rotation.x, lR, k);

  const stretch = clamp(ch.vy * 0.012, -0.08, 0.14) - v.squash * 0.4;
  r.scale.set(1 - stretch * 0.5, 1 + stretch, 1 - stretch * 0.5);
  // Squishy jelly bounce, scaled from the feet so it is also strongest up top.
  v.wob.scale.set(1 + wj, 1 - wj, 1 + wj);

  if (ch.ox || ch.oy || ch.oz) {
    const bumped = ch.bumpAt != null && simMs - ch.bumpAt < 300;
    const d = Math.exp(-dt * (bumped ? 6 : 12));
    ch.ox *= d; ch.oy *= d; ch.oz *= d;
    if (Math.hypot(ch.ox, ch.oy, ch.oz) < 0.002) ch.ox = ch.oy = ch.oz = 0;
  }
  v.group.position.set(ch.x + (ch.ox || 0), ch.y + (ch.oy || 0), ch.z + (ch.oz || 0));
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
/* Room state                                                          */
/* ------------------------------------------------------------------ */
const chars = [];           // every bean in the room: humans and bots
const byId = new Map();
const vis = new Map();      // id -> bean visuals
let player = null;          // my bean (null in the menu, or while spectating)
const STATES = ['run', 'dive', 'stun', 'done'];
const dots = new Map();

// N: what the server last told us. G: purely local UI state.
const N = { lv: 0, pick: -1, rounds: 1, round: 0, mode: 'gp', out: 0, cup: null, phase: -1, pt: -1, rt: 0, rtAt: 0, over: false, fin: 0, code: '', pub: false, host: false, synced: false };
const G = { inRoom: false, shownN: 0, hintT: 0, now: 0 };

function addChar(c, isMe) {
  const ch = S.createChar({ id: c.i, name: c.n, color: c.c, isPlayer: isMe });
  ch.human = !!c.h; ch.placed = false;
  chars.push(ch); byId.set(ch.id, ch);
  vis.set(ch.id, makeBean(ch.color, ch.name, isMe));
  return ch;
}
function removeChar(ch) {
  const v = vis.get(ch.id);
  if (v) {
    scene.remove(v.group);
    v.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }
  vis.delete(ch.id); byId.delete(ch.id);
  chars.splice(chars.indexOf(ch), 1);
  const d = dots.get(ch.id);
  if (d) { d.remove(); dots.delete(ch.id); }
  if (ch === player) player = null;
}

/* ------------------------------------------------------------------ */
/* Networking: prediction for me, interpolation for everyone else      */
/* ------------------------------------------------------------------ */
let ws = null, wsReady = null;
let simMs = 0;              // my simulation clock (ms): inputs and the history below are stamped with it
let tOff = 0;               // world time = simMs/1000 + tOff, kept in step with the server's platforms
let needSnap = false;
const hist = [];            // my recent predicted positions, to compare against the server's state
const snapBuf = [];         // recent snapshots of the room, for interpolating other beans
const INTERP_MS = 70;       // ~4 snapshots at the server's 60 Hz; also the collision lead in applyRemote
const inp = { jump: false, dive: false };
let lastSent = { x: 9, z: 9, at: 0 };

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function connect() {
  if (ws && ws.readyState === 1) return Promise.resolve();
  if (ws && ws.readyState === 0) return wsReady;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  wsReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('timeout')); try { sock.close(); } catch { /* already closed */ } }, 7000);
    sock.onopen = () => { clearTimeout(timer); resolve(); };
    sock.onerror = () => { clearTimeout(timer); reject(new Error('socket')); };
  });
  sock.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (G.inRoom) { toMenu(); menuError('Connection lost. Press Play to reconnect.'); }
  };
  return wsReady;
}
setInterval(() => send({ t: 'p' }), 15000);       // keep-alive for idle menus

function onMessage(m) {
  switch (m.t) {
    case 's': onSnap(m); break;
    case 'roster': applyRoster(m); break;
    case 'joined': G.inRoom = true; $('menu').hidden = true; $('menuErr').hidden = true; N.code = m.code; N.pub = !!m.pub; break;
    case 'results': showResults(m); break;
    case 'err': menuError(m.msg); break;
    default: break;
  }
}

function applyRoster(m) {
  N.host = !!m.host; N.code = m.code; N.pub = !!m.pub; N.lv = m.lv ?? 0; N.pick = m.pick ?? -1;
  N.rounds = m.rounds ?? 1; N.round = m.rd ?? 0;
  N.mode = m.mode ?? 'gp'; N.out = m.out ?? 0; N.cup = m.cup ?? null;
  if (loadLevel(N.lv)) { resetLocalWorld(); snapBuf.length = 0; }     // the room moved to another course
  const ids = new Set(m.chars.map((c) => c.i));
  for (const ch of [...chars]) if (!ids.has(ch.id)) removeChar(ch);
  for (const c of m.chars) {
    let ch = byId.get(c.i);
    if (!ch) ch = addChar(c, c.i === m.you);
    S.resetChar(ch, ch.x, ch.z);      // fresh layout: snapshots place everyone
    ch.finishT = 0;
  }
  player = byId.get(m.you) || null;
  hist.length = 0; snapBuf.length = 0; needSnap = !!player;
  cam.lastId = null;
  renderLobby(m.chars);
}

function applyTiles(tl) {
  const seen = new Set();
  for (const [i, s, cy] of tl) {
    const c = world.tiles[i];
    if (!c) continue;
    seen.add(i);
    if (s === 1) { c.state = 'shake'; c.active = true; }
    else if (s === 2) {
      if (c.state !== 'fall') { c.fv = 0; c.cy = cy; } else if (Math.abs(c.cy - cy) > 1.5) c.cy = cy;
      c.state = 'fall'; c.active = true;
    } else { c.state = 'gone'; c.active = false; }
  }
  for (let i = 0; i < world.tiles.length; i++) {
    const c = world.tiles[i];
    if (seen.has(i) || c.state === 'idle') continue;
    if (c.state === 'gone') c.pop = 0;               // regrow with a little pop
    c.state = 'idle'; c.cy = c.baseY; c.active = true; c.fv = 0; c.dy = 0;
  }
}

// Move colliders to where the server's clock says they are, without dragging riders along.
function alignWorld() {
  world.t = simMs / 1000 + tOff;
  for (const c of world.colliders) if (c.update) { c.update(c, world, 0); c.dx = c.dy = c.dz = 0; }
}
function resetLocalWorld() {
  S.resetWorld(world);
  alignWorld();
  hist.length = 0;
}

function onSnap(m) {
  const at = performance.now();

  // Keep my clock aligned with the server's so moving platforms match.
  if (m.k != null) {
    const off = m.w - m.k / 1000;
    if (!N.synced || Math.abs(off - tOff) > 0.25) { tOff = off; N.synced = true; alignWorld(); }
    else tOff += (off - tOff) * 0.12;
  } else if (!N.synced) { tOff = m.w - simMs / 1000; alignWorld(); }

  setPhase(m, at);
  applyTiles(m.tl);
  N.fin = m.fo.length;
  m.fo.forEach((id, i) => { const ch = byId.get(id); if (ch) { ch.finishOrder = i; ch.finishT = m.ft[i]; } });

  const map = new Map();
  for (const a of m.c) map.set(a[0], { x: a[1], y: a[2], z: a[3], vx: a[4], vy: a[5], vz: a[6], h: a[7], st: a[8], fl: a[9] });
  snapBuf.push({ at, m: map });
  if (snapBuf.length > 40) snapBuf.shift();

  const mine = player ? map.get(player.id) : null;
  let adopted = false;
  for (const [type, id, val] of m.ev) {
    const ch = byId.get(id);
    if (!ch) continue;
    if (type === 'l' && ch !== player) { const v = vis.get(id); if (v) v.squash = Math.min(0.5, val / 35); }
    if (ch !== player || !mine) continue;
    if (type === 'r') { adopt(mine, 'r'); adopted = true; flash(); toast('Oops! Back to the checkpoint', 1500); }
    else if (type === 'b' && player.state !== 'stun') { adopt(mine, 'b'); adopted = true; sfx.bonk(); cam.shake = 0.5; toast('Bonk!', 900); }
    else if (type === 'f') sfx.fall();
    else if (type === 'F') onMeFinished();
  }
  if (mine) {
    if (mine.fl & 2) onMeFinished();
    if (!adopted) reconcile(mine, m.k);
  }
}

// Hide a correction: physics moves at once, but the drawn bean starts where it was and glides over.
// Right after a bump the glide is slower, since that is when server and client disagree most.
function easeOut(dx, dy, dz) {
  const P = player;
  P.ox = (P.ox || 0) + dx; P.oy = (P.oy || 0) + dy; P.oz = (P.oz || 0) + dz;
  const m = Math.hypot(P.ox, P.oy, P.oz);
  if (m > 2) { const s = 2 / m; P.ox *= s; P.oy *= s; P.oz *= s; }   // never drag the drawing far from the truth
}

function adopt(e, kind) {
  if (kind === 'b' && Math.hypot(e.x - player.x, e.z - player.z) < 2) easeOut(player.x - e.x, player.y - e.y, player.z - e.z);
  Object.assign(player, { x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz, ground: null, grounded: false });
  if (kind === 'r') { player.state = 'run'; player.stateT = 0; player.invuln = 1.6; player.heading = e.h; }
  else { player.state = 'stun'; player.stateT = 0.9; }
  hist.length = 0;
}

function onMeFinished() {
  if (player.finished) return;
  player.finished = true; player.state = 'done'; player.ghost = true; player.wishX = player.wishZ = 0;
  banner('QUALIFIED!', 'small stay'); sfx.win(); burstConfetti(player);
}

// Compare where the server put me with where I was when it processed the same input, and nudge.
function reconcile(e, ack) {
  if (needSnap) {
    Object.assign(player, { x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz, heading: e.h });
    needSnap = false; player.placed = true; hist.length = 0;
    return;
  }
  if (ack == null || hist.length < 2 || ack < hist[0].t) return;
  let j = hist.length - 1;
  while (j > 0 && hist[j - 1].t > ack) j--;
  let p = hist[j];
  if (j > 0 && ack < hist[j].t) {
    const a = hist[j - 1], f = (ack - a.t) / (hist[j].t - a.t);
    p = { x: a.x + (hist[j].x - a.x) * f, y: a.y + (hist[j].y - a.y) * f, z: a.z + (hist[j].z - a.z) * f };
  }
  const ex = e.x - p.x, ey = e.y - p.y, ez = e.z - p.z;
  N.err = Math.hypot(ex, ez);                                  // exposed for diagnostics
  if (Math.hypot(ex, ez) > 3 || Math.abs(ey) > 2.2) {          // way off (shoved, teleported): trust the server
    Object.assign(player, { x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz });
    hist.length = 0;
    return;
  }
  const k = 0.3, cx = ex * k, cz = ez * k, cy = Math.abs(ey) > 0.4 ? ey * k : 0;
  player.x += cx; player.y += cy; player.z += cz;
  easeOut(-cx, -cy, -cz);
  for (const h of hist) { h.x += cx; h.y += cy; h.z += cz; }   // keep history consistent with the correction
}

// Everyone else: draw them slightly in the past, between the two snapshots around that moment.
function applyRemote(now) {
  if (!snapBuf.length) return;
  const rt = now - INTERP_MS;
  while (snapBuf.length > 2 && snapBuf[1].at <= rt) snapBuf.shift();
  const a = snapBuf[0], b = snapBuf.length > 1 ? snapBuf[1] : null;
  const f = b ? clamp((rt - a.at) / (b.at - a.at), 0, 1) : 0;
  for (const ch of chars) {
    if (ch === player) continue;
    const ea = a.m.get(ch.id);
    if (!ea) continue;
    const eb = (b && b.m.get(ch.id)) || ea;
    const jump = Math.hypot(eb.x - ea.x, eb.z - ea.z) > 6;      // respawn: don't slide across the course
    const ff = jump ? (f < 0.5 ? 0 : 1) : f;
    ch.x = ea.x + (eb.x - ea.x) * ff; ch.y = ea.y + (eb.y - ea.y) * ff; ch.z = ea.z + (eb.z - ea.z) * ff;
    let dh = eb.h - ea.h; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    ch.heading = ea.h + dh * ff;
    ch.vx = ea.vx; ch.vy = ea.vy; ch.vz = ea.vz;
    // Collision-only lead: the drawn bean lags INTERP_MS behind the newest snapshot, but the server
    // collides everyone at "now". Project along velocity, capped so a sudden turn can't throw it far.
    let lx = jump ? 0 : ea.vx * (INTERP_MS / 1000), lz = jump ? 0 : ea.vz * (INTERP_MS / 1000);
    const ll = Math.hypot(lx, lz);
    if (ll > 1.2) { lx *= 1.2 / ll; lz *= 1.2 / ll; }
    ch.px = ch.x + lx; ch.pz = ch.z + lz;
    ch.state = STATES[ea.st] || 'run';
    ch.grounded = !!(ea.fl & 1); ch.finished = !!(ea.fl & 2); ch.invuln = ea.fl & 4 ? 1 : 0;
    ch.placed = true;
  }
}

function sendInput(now, ct) {
  if (!player || !ws || ws.readyState !== 1) { inp.jump = inp.dive = false; return; }
  const x = Math.round(player.wishX * 1000) / 1000, z = Math.round(player.wishZ * 1000) / 1000;
  const changed = Math.abs(x - lastSent.x) > 0.01 || Math.abs(z - lastSent.z) > 0.01;
  const since = now - lastSent.at;
  if (inp.jump || inp.dive || (changed && since >= 25) || since >= 100) {
    send({ t: 'in', ct: Math.round(ct * 10) / 10, x, z, j: inp.jump ? 1 : 0, d: inp.dive ? 1 : 0 });
    lastSent = { x, z, at: now };
    inp.jump = inp.dive = false;
  }
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */
const keys = new Set();
let joy = { x: 0, y: 0 };
let touchJump = false;
const cam = { yaw: 0, pitch: 0.4, dist: 9.5, focus: new THREE.Vector3(0, 1, 15), pos: new THREE.Vector3(0, 6, 28), shake: 0, user: 0, lastId: null };
const typing = (e) => e.target instanceof HTMLInputElement;

window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'Space') inp.jump = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyF') inp.dive = true;
  if (e.code === 'KeyM') { muted = !muted; toast(muted ? 'Sound off' : 'Sound on'); audioInit(); }
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
  jb.addEventListener('pointerdown', (e) => { e.preventDefault(); touchJump = true; inp.jump = true; });
  const jUp = () => { touchJump = false; };
  jb.addEventListener('pointerup', jUp); jb.addEventListener('pointercancel', jUp); jb.addEventListener('pointerleave', jUp);
  db.addEventListener('pointerdown', (e) => { e.preventDefault(); inp.dive = true; });
}

function readInput() {
  if (!player) { inp.jump = inp.dive = false; return; }
  const k = (c) => keys.has(c);
  let ix = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
  let iy = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
  ix += joy.x; iy -= joy.y;
  const l = Math.hypot(ix, iy); if (l > 1) { ix /= l; iy /= l; }
  const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw);
  // camera forward = (-sin, -cos), right = (cos, -sin)
  player.wishX = -s * iy + c * ix;
  player.wishZ = -c * iy - s * ix;
  if ((k('Space') || touchJump) && player.grounded) inp.jump = true;   // hold to bunny-hop
  if (inp.jump) player.jumpReq = true;
  if (inp.dive) player.diveReq = true;
}

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */
const hud = {
  root: $('hud'), pos: $('posNum'), timer: $('timer'), qual: $('qualNum'), toast: $('toast'),
  banner: $('banner'), flash: $('flash'), track: $('track'), hint: $('hint'), spec: $('spec'),
};
$('posTotal').textContent = TOTAL; $('qualMax').textContent = S.QUALIFY;
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

function updateHud(now) {
  const ranked = S.rankings(chars);
  hud.pos.textContent = player ? ranked.indexOf(player) + 1 : '–';
  const rt = N.phase === 2 && !N.over ? N.rt + (now - N.rtAt) / 1000 : N.rt;
  hud.timer.textContent = Math.max(0, rt).toFixed(2);
  hud.qual.textContent = N.fin;
  hud.spec.hidden = !!player;
  hud.spec.textContent = N.out === 1 ? 'ELIMINATED · watch the rest, you rejoin the next series' : N.out === 2 ? 'SPECTATING · you join the next series' : 'SPECTATING · you join the next round';
  for (const ch of chars) {
    let d = dots.get(ch.id);
    if (!d) {
      d = document.createElement('div');
      d.className = 'track-dot' + (ch === player ? ' me' : '');
      d.style.background = ch.color;
      hud.track.append(d); dots.set(ch.id, d);
    }
    d.style.left = `${clamp((S.START_Z - ch.z) / (S.START_Z - world.level.finish.z), 0, 1) * 100}%`;
  }
}

/* ------------------------------------------------------------------ */
/* Lobby, results, menu                                                */
/* ------------------------------------------------------------------ */
function renderLobby(list) {
  $('roomCode').textContent = N.code;
  const ul = $('lobbyList'); ul.textContent = '';
  for (const c of list) {
    if (!c.h) continue;
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = c.c;
    const nm = document.createElement('span'); nm.textContent = c.n;
    li.append(dot, nm);
    if (player && c.i === player.id) li.className = 'me';
    ul.append(li);
  }
  $('startBtn').hidden = N.pub || !N.host;
  renderLevelPick();
  renderModePick();
  renderRoundPick();
  updateLobbyStatus();
}

// Private rooms only: the host picks a series of 1-4 races, scored Mario Kart style by finishing place.
function renderRoundPick() {
  $('roundRow').hidden = N.pub;
  $('roundBlurb').hidden = N.pub;
  if (N.pub) return;
  const box = $('roundPick'); box.textContent = '';
  const canPick = N.host;
  const items = canPick ? [1, 2, 3, 4] : [N.rounds];
  for (const n of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip-btn level-chip'; b.textContent = String(n);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(N.rounds === n));
    if (canPick) b.addEventListener('click', () => send({ t: 'rounds', n }));
    else b.disabled = true;
    box.append(b);
  }
  $('roundLabel').textContent = canPick ? 'ROUNDS' : (N.rounds === 1 ? 'ROUND' : 'ROUNDS');
  $('roundBlurb').textContent = N.rounds === 1 ? 'A single race. Add rounds to play a series.' : MODES.find((x) => x.id === N.mode).blurb;
}

const MODES = [
  { id: 'tt', label: 'Time trial', blurb: 'Your times add up across every round. Missing the cut costs the race clock plus 15s. Lowest total wins.' },
  { id: 'gp', label: 'Grand prix', blurb: 'Sweeper, Conveyor, Slip, Sky in that order. Points for every place, 15 for 1st down to 1 for 12th. Most points wins.' },
  { id: 'el', label: 'Elimination', blurb: 'After each race the four lowest scorers are knocked out and replaced by bots. Win the last round to win the series.' },
];
function renderModePick() {
  $('modeRow').hidden = N.pub;
  if (N.pub) return;
  const box = $('modePick'); box.textContent = '';
  const canPick = N.host;
  for (const it of canPick ? MODES : MODES.filter((x) => x.id === N.mode)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip-btn level-chip'; b.textContent = it.label;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(N.mode === it.id));
    if (canPick) b.addEventListener('click', () => send({ t: 'mode', m: it.id }));
    else b.disabled = true;
    box.append(b);
  }
}

// The host of a private room chooses the course (or leaves it on Random); everyone else just sees what's next.
function renderLevelPick() {
  const box = $('levelPick'); box.textContent = '';
  const lv = S.LEVELS[N.lv] || S.LEVELS[0];
  const cup = !N.pub && N.mode === 'gp' && N.cup;
  const canPick = !N.pub && N.host && !cup;
  if (cup) {
    for (const i of N.cup.slice(0, Math.max(1, N.rounds))) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip-btn level-chip'; b.textContent = S.LEVELS[i].name; b.disabled = true;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(i === N.lv));
      box.append(b);
    }
    $('levelLabel').textContent = 'CUP ORDER';
    $('levelBlurb').textContent = lv.blurb;
    return;
  }
  const items = canPick ? [{ i: -1, label: 'Random' }, ...S.LEVELS.map((l, i) => ({ i, label: l.name }))] : [{ i: N.lv, label: lv.name }];
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip-btn level-chip'; b.textContent = it.label;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(canPick ? N.pick === it.i : true));
    if (canPick) b.addEventListener('click', () => send({ t: 'level', i: it.i }));
    else b.disabled = true;
    box.append(b);
  }
  $('levelLabel').textContent = canPick ? 'COURSE' : 'NEXT COURSE';
  $('levelBlurb').textContent = lv.blurb;
}
function updateLobbyStatus() {
  let s;
  if (N.pub) s = N.pt >= 0 ? `Race starts in ${Math.ceil(N.pt)}s` : 'Waiting for players…';
  else s = N.host ? 'Share the code, then start when everyone is in.' : 'Waiting for the host to start…';
  $('lobbyStatus').textContent = s;
}

function showResults(m) {
  N.round = m.rd ?? 1; N.rounds = m.rounds ?? 1; N.mode = m.mode ?? N.mode;
  const series = N.rounds > 1;
  const finalRound = series && N.round >= N.rounds;
  const meIdx = player ? m.list.findIndex((x) => x.i === player.id) : -1;
  const me = meIdx >= 0 ? m.list[meIdx] : null;
  const made = !!(me && me.f);
  const title = $('resTitle');
  title.textContent = !me ? 'ROUND OVER' : made ? 'QUALIFIED!' : 'ELIMINATED';
  title.classList.toggle('out', !!me && !made);
  $('resSub').textContent = !me ? (N.out ? 'Thanks for watching — you join the next series.' : 'Thanks for watching — you race next round.')
    : made
      ? `You finished ${ord(m.list.filter((x) => x.f).findIndex((x) => x.i === me.i) + 1)} of ${TOTAL} in ${me.ft.toFixed(2)}s${me.fl ? ` · ${me.fl} fall${me.fl > 1 ? 's' : ''}` : ' · flawless run!'}`
      : `Only ${S.QUALIFY} beans can make the cut. You were ${ord(meIdx + 1)} on the course.`;

  // In a series the headline is about the series, not whether you made the top eight.
  const timed = N.mode === 'tt';
  const myRow = series && me ? m.st.findIndex((x) => x.i === me.i) : -1;
  if (myRow >= 0) {
    const row = m.st[myRow];
    const score = timed ? `${row.tt.toFixed(2)}s total` : `${row.p} pts`;
    const raceBit = timed ? `${me.f ? me.ft.toFixed(2) : `DNF (+${me.dt.toFixed(2)})`}s` : `+${me.p} pts`;
    let head = null, out = false, sub;
    if (finalRound) {
      const win = myRow === 0;
      head = win ? 'CHAMPION!' : 'FINAL RESULTS';
      sub = N.mode === 'el'
        ? (win ? 'You won the last round and the whole series!' : `You came ${ord(myRow + 1)} among the players in the last round.`)
        : `You placed ${ord(myRow + 1)} overall with ${score} after ${N.rounds} rounds.`;
    } else if (N.mode === 'el') {
      out = !!row.o;
      head = out ? 'KNOCKED OUT' : 'YOU’RE STILL IN';
      sub = out ? 'You’re out — you’ll watch the rest of the series and rejoin the next one.'
        : `You’re ${ord(myRow + 1)} on ${row.p} pts. ${m.st.filter((x) => x.o).length} knocked out.`;
    } else {
      head = `ROUND ${N.round} DONE`;
      sub = `${raceBit} · ${ord(myRow + 1)} overall on ${score}`;
    }
    title.textContent = head;
    title.classList.toggle('out', out);
    $('resSub').textContent = sub;
  }

  const list = $('resList'); list.textContent = '';
  m.list.forEach((x, i) => {
    const li = document.createElement('li');
    if (me && x.i === me.i) li.className = 'me';
    if (!x.f) li.classList.add('out');
    const n = document.createElement('span'); n.textContent = i + 1;
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = x.c;
    const nm = document.createElement('span'); nm.textContent = x.n + (x.h ? '' : ' · bot');
    const t = document.createElement('span'); t.className = 't';
    t.textContent = x.f ? `${x.ft.toFixed(2)}s` : timed && series ? `DNF · ${x.dt.toFixed(2)}s` : 'DNF';
    if (series && !timed) { const pb = document.createElement('b'); pb.textContent = `+${x.p}`; t.append(pb); }
    li.append(n, d, nm, t);
    list.append(li);
  });
  const stand = $('resStand'); stand.textContent = '';
  $('resStandTitle').hidden = stand.hidden = !series;
  $('resStandTitle').textContent = finalRound ? 'FINAL STANDINGS' : `STANDINGS AFTER ROUND ${N.round}/${N.rounds}`;
  if (series) m.st.forEach((x, i) => {
    const li = document.createElement('li');
    if (me && x.i === me.i) li.className = 'me';
    if (x.o) li.classList.add('out');
    const n = document.createElement('span'); n.textContent = i + 1;
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = x.c;
    const nm = document.createElement('span'); nm.textContent = x.n;
    const t = document.createElement('span'); t.className = 't';
    t.textContent = (timed ? `${x.tt.toFixed(2)}s` : `${x.p} pts`) + (x.o ? ' · OUT' : '');
    li.append(n, d, nm, t);
    stand.append(li);
  });
  updateResNext(m.pt ?? RESULTS_WAIT);
  $('results').hidden = false;
  $('touch').hidden = true;
}

const RESULTS_WAIT = 10;
function updateResNext(pt) {
  const s = Math.max(0, Math.ceil(pt));
  $('resNext').textContent = N.round < N.rounds ? `Round ${N.round + 1} of ${N.rounds} starts in ${s}s` : `Back to the lobby in ${s}s`;
}

function menuError(msg) {
  const el = $('menuErr');
  el.textContent = msg; el.hidden = false;
  $('menu').hidden = false;
  setMenuBusy(false);
}
function setMenuBusy(busy) {
  for (const id of ['playBtn', 'soloBtn', 'createBtn', 'joinBtn']) $(id).disabled = busy;
}

function toMenu() {
  for (const ch of [...chars]) removeChar(ch);
  player = null; G.inRoom = false; N.phase = -1; N.synced = false; N.over = false; N.fin = 0;
  snapBuf.length = 0; hist.length = 0; needSnap = false; cam.lastId = null; tOff = 0;
  world.racing = false; world.lobby = false; world.gate.active = true;
  resetLocalWorld();
  $('menu').hidden = false; $('results').hidden = true; $('lobby').hidden = true; $('touch').hidden = true;
  hud.root.hidden = true; hud.banner.className = 'banner';
  setMenuBusy(false);
}

async function joinRoom(mode, code) {
  audioInit();
  $('menuErr').hidden = true;
  setMenuBusy(true);
  try { await connect(); } catch {
    menuError('Couldn’t reach the game server. Check your connection and try again.');
    return;
  }
  send({ t: 'join', mode, code, name: cleanName(), color: chosenColor });
  setTimeout(() => { if (!G.inRoom) setMenuBusy(false); }, 1500);
}

/* ---------- phases ---------- */
function setPhase(m, at) {
  const ph = m.ph;
  N.pt = m.pt; N.rt = m.rt; N.rtAt = at;
  if (ph !== N.phase) { const prev = N.phase; N.phase = ph; enterPhase(ph, prev); }
  if (ph === 1) {
    const n = Math.ceil(m.pt);
    if (n > 0 && n !== G.shownN) { G.shownN = n; banner(String(n)); sfx.count(); }
  }
  if (m.ov && !N.over) {
    N.over = true;
    if (player && !player.finished) {
      banner(N.fin >= S.QUALIFY ? 'ELIMINATED' : 'TIME’S UP', 'bad small stay'); sfx.lose();
    }
  } else if (!m.ov) N.over = false;
  world.racing = ph === 2 && !m.ov;
  world.lobby = ph === 0;
  world.gate.active = ph < 2;
  if (ph === 0) updateLobbyStatus();
  if (ph === 3) updateResNext(m.pt);
}

function enterPhase(ph, prev) {
  if (ph === 0 || ph === 1) {
    resetLocalWorld();
    cam.lastId = null; cam.yaw = 0; cam.pitch = 0.4; cam.user = 0;
    if (confetti) { scene.remove(confetti.pts); confetti.pts.geometry.dispose(); confetti = null; }
    hud.banner.className = 'banner';
  }
  $('lobby').hidden = ph !== 0;
  if (ph !== 3) $('results').hidden = true;
  hud.root.hidden = ph === 0;
  $('touch').hidden = !isTouch || ph === 3;
  if (ph === 0) renderLobby(chars.filter((c) => c.human).map((c) => ({ i: c.id, n: c.name, c: c.color, h: 1 })));
  if (ph === 1) { G.shownN = 0; G.hintT = 0; hud.hint.classList.remove('fade'); toast(N.rounds > 1 ? `Round ${N.round}/${N.rounds} · ${world.level.name}` : world.level.name, 2800); }
  if (ph === 2 && prev === 1) { banner('GO!', 'go'); sfx.go(); }
}

// Local events from my own predicted bean (sounds and feedback)
function onWorldEvent(type, ch, data) {
  const v = vis.get(ch.id);
  if (type === 'land' && v) v.squash = Math.min(0.5, data / 35);
  if (ch !== player) return;
  switch (type) {
    case 'jump': sfx.jump(); break;
    case 'land': sfx.land(); break;
    case 'dive': sfx.dive(); break;
    case 'bonk': sfx.bonk(); cam.shake = 0.5; toast('Bonk!', 900); break;
    default: break;
  }
}

/* ------------------------------------------------------------------ */
/* Camera + per-frame visuals                                          */
/* ------------------------------------------------------------------ */
const tmp = new THREE.Vector3();
function camTarget() {
  if (player) return player.placed ? player : null;
  const placed = chars.filter((c) => c.placed);
  return placed.length ? S.rankings(placed)[0] : null;      // spectators follow the leader
}
function updateCamera(dt, time) {
  const target = G.inRoom ? camTarget() : null;
  if (!target) {
    // Slow orbit around the starting grid behind the menu.
    const a = time * 0.22;
    tmp.set(Math.sin(a) * 16, 5.5, 18 + Math.cos(a) * 14);
    cam.pos.lerp(tmp, 1 - Math.exp(-4 * dt));
    camera.position.copy(cam.pos);
    camera.lookAt(0, 1.4, 18);
    return;
  }
  const f = cam.focus;
  const fresh = cam.lastId == null;
  if (fresh) f.set(target.x, target.y + 1.1, target.z);
  cam.lastId = target.id;
  if (target.finished && cam.user <= 0) cam.yaw += dt * 0.35;     // drift around the winner
  if (cam.user > 0) cam.user -= dt;
  const k = 1 - Math.exp(-18 * dt), ky = 1 - Math.exp(-6 * dt);
  f.x += (target.x - f.x) * k; f.z += (target.z - f.z) * k; f.y += (target.y + 1.1 - f.y) * ky;
  const cp = Math.cos(cam.pitch), dist = cam.dist + (N.phase === 1 ? clamp(N.pt, 0, 3) * 1.4 : 0);
  tmp.set(f.x + Math.sin(cam.yaw) * cp * dist, f.y + Math.sin(cam.pitch) * dist, f.z + Math.cos(cam.yaw) * cp * dist);
  if (fresh) cam.pos.copy(tmp); else cam.pos.lerp(tmp, 1 - Math.exp(-14 * dt));
  camera.position.copy(cam.pos);
  if (cam.shake > 0) {
    cam.shake -= dt * 2.5;
    camera.position.x += (Math.random() - 0.5) * cam.shake * 0.4;
    camera.position.y += (Math.random() - 0.5) * cam.shake * 0.4;
  }
  camera.lookAt(f);
}

function updateVisuals(dt, time) {
  for (const [tex, b] of beltAnim) {                  // scroll the chevrons the way the belt carries you (4 m per pattern)
    tex.offset.x = -(b.x / 4) * time;
    tex.offset.y = (b.z / 4) * time;
  }
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
      if (c.pop !== undefined && c.pop < 1) c.pop = Math.min(1, c.pop + dt * 3);
      mesh.scale.setScalar(Math.max(0.01, c.pop === undefined ? 1 : c.pop));
    }
  }
  for (const ch of chars) {
    const v = vis.get(ch.id);
    animateBean(ch, v, dt, time);
    if (!ch.placed) v.group.visible = false;
  }
  for (const m of floaters) m.position.y = m.userData.base + Math.sin(time * m.userData.sp + m.userData.ph) * 1.4;
  crown.rotation.y = time * 1.6;
  crown.position.y = crownBaseY + Math.sin(time * 2) * 0.18;
  // sun follows the action so shadows stay crisp
  sun.position.set(cam.focus.x + 22, cam.focus.y + 42, cam.focus.z + 16);
  sun.target.position.copy(cam.focus);
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */
let acc = 0, lastT = performance.now(), gooT = 0, frameCount = 0;
function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (nowMs - lastT) / 1000);
  lastT = nowMs;
  const time = nowMs / 1000;
  G.now += dt;

  readInput();
  sendInput(nowMs, simMs);

  // Predict my own bean with the same physics the server runs; the world (platforms, bars) follows server time.
  acc += dt;
  const others = player ? chars.filter((c) => c !== player) : [];
  while (acc >= S.STEP) {
    simMs += S.STEP * 1000;
    world.t = simMs / 1000 + tOff - S.STEP;
    S.stepWorld(world, player ? [player] : [], S.STEP);
    if (player && S.collideWithOthers(player, others)) player.bumpAt = simMs;   // bump into beans instead of ghosting through
    if (player) hist.push({ t: simMs, x: player.x, y: player.y, z: player.z });
    acc -= S.STEP;
  }
  const cut = hist.findIndex((h) => h.t >= simMs - 2500);
  if (cut > 0) hist.splice(0, cut);

  applyRemote(nowMs);
  if (G.inRoom && N.phase === 2) { G.hintT += dt; if (G.hintT > 9) hud.hint.classList.add('fade'); }
  updateConfetti(dt);
  updateVisuals(dt, time);
  updateCamera(dt, time);
  if (!hud.root.hidden) updateHud(nowMs);
  gooT += dt;
  if ((frameCount++ & 1) === 0) animateGoo(gooT);
  renderer.render(scene, camera);
}

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
  });
  swatchBox.append(b);
});

const cleanName = () => ($('nameInput').value.trim() || 'Player').slice(0, 14);
const cleanCode = () => $('codeInput').value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4);

async function boot() {
  // Let the web font load so the name tags render in it (don't wait forever).
  await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 1200))]);
  resetLocalWorld();
  $('tagline').textContent = `${TOTAL} beans. ${S.LEVELS.length} courses. ${S.QUALIFY} make it to the crown.`;
  $('playBtn').addEventListener('click', () => joinRoom('public'));
  $('soloBtn').addEventListener('click', () => joinRoom('solo'));
  $('createBtn').addEventListener('click', () => joinRoom('create'));
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = cleanCode();
    if (code.length !== 4) { menuError('Room codes are 4 characters.'); return; }
    joinRoom('code', code);
  });
  $('nameInput').addEventListener('keydown', (e) => { if (e.code === 'Enter') joinRoom('public'); });
  $('startBtn').addEventListener('click', () => send({ t: 'start' }));
  $('leaveBtn').addEventListener('click', () => { send({ t: 'leave' }); toMenu(); });
  $('lobbyLeave').addEventListener('click', () => { send({ t: 'leave' }); toMenu(); });
  $('copyBtn').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?room=${N.code}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied', 1400); }
    catch { toast(`Room code: ${N.code}`, 2500); }
  });
  const invited = new URLSearchParams(location.search).get('room');
  if (invited) {
    $('codeInput').value = invited.toUpperCase().slice(0, 4);
    $('menuErr').textContent = `You’re invited to room ${$('codeInput').value}. Press Join to enter.`;
    $('menuErr').hidden = false;
  }
  window.__fallBeansReady = true;
  window.__fb = { get world() { return world; }, chars, N, G, cam, hist, get player() { return player; }, get simMs() { return simMs; } };   // debugging handle
  $('loading').classList.add('done');
  setTimeout(() => ($('loading').hidden = true), 600);
  requestAnimationFrame(frame);
}
boot();
