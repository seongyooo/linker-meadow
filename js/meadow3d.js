// Meadow islands (draft): two of chapter 7's grassy islands over the clouds, built as the game builds them (the stone
// blocks, the blades by the same rules and shader, the flowers and vines of Meadow.fbx). Linkers wander one island;
// bring the pointer near and they run from it; catch one (it hangs limp from its hood), carry it over and let it go
// on the other island. Dropped between the islands it falls into the clouds and comes down again on the island it
// was taken from. All across, the far island blooms.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { material, geometry } from './linker3d.js?v=5';
import { makeToys } from './toys.js?v=1';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
let skew = 0;
const nowMs = () => performance.now() + skew;
const damp = (a, b, rate, dt) => b + (a - b) * Math.exp(-rate * dt);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// The game's grass field (LevelBuilder.Meadow: GrassHash, GrassNoise, GrassField), for where the flowers drift.
const frac = (x) => x - Math.floor(x);
function grassHash(x, y, z) {
  x = frac(x * 0.3183099 + 0.1) * 17; y = frac(y * 0.3183099 + 0.1) * 17; z = frac(z * 0.3183099 + 0.1) * 17;
  return frac(x * y * z * (x + y + z));
}
function grassNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const H = (a, b, c) => grassHash(ix + a, iy + b, iz + c);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(lerp(lerp(H(0, 0, 0), H(1, 0, 0), fx), lerp(H(0, 1, 0), H(1, 1, 0), fx), fy),
              lerp(lerp(H(0, 0, 1), H(1, 0, 1), fx), lerp(H(0, 1, 1), H(1, 1, 1), fx), fy), fz);
}

const GRADE = /* glsl */ `
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 logc(vec3 x) { return mix(5.301883 * x + 0.092819, 0.244161 * log(max(5.555556 * x + 0.047996, 1e-9)) / log(10.0) + 0.386036, step(0.011361, x)); }
vec3 unlogc(vec3 x) { return mix((x - 0.092819) / 5.301883, (pow(vec3(10.0), (x - 0.386036) / 0.244161) - 0.047996) / 5.555556, step(5.301883 * 0.011361 + 0.092819, x)); }
vec3 grade(vec3 srgb) {
  vec3 c = toLin(srgb) * pow(2.0, -0.08);
  vec3 lms = vec3(dot(vec3(0.390405, 0.549941, 0.00892632), c), dot(vec3(0.0708416, 0.963172, 0.00135775), c),
                  dot(vec3(0.0231082, 0.128021, 0.936245), c)) * vec3(1.0122154, 0.9990822, 0.9428170);
  c = vec3(dot(vec3(2.8584705, -1.6287886, -0.0248911), lms), dot(vec3(-0.2101825, 1.1582006, 0.0003243), lms),
           dot(vec3(-0.0418121, -0.1181695, 1.0686665), lms));
  c = max(unlogc((logc(max(c, 0.0)) - 0.4135884) * 1.12 + 0.4135884), 0.0);
  float l = dot(c, vec3(0.2126729, 0.7151522, 0.0721750));
  return toSrgb(l + 1.14 * (c - l));
}
vec3 finish(vec3 c, float mini) {
  vec3 s = toSrgb(c);
  float luma = dot(s, vec3(0.299, 0.587, 0.114));
  s = mix(vec3(luma), s, 1.0 + 0.16 * mini);
  s = clamp((s - 0.5) * (1.0 + 0.06 * mini) + 0.5, 0.0, 1.0);
  return grade(s);
}`;

// The blades (Shaders/MeadowGrass.shader): dark at the root, light at the tip, each its own shade; bent with the wind
// from behind the view, more toward the tip; parted about the Linkers' feet.
const PUSHERS = 16;
const GRASS_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
uniform float uWindStrength;
uniform vec4 uPush[${PUSHERS}];
varying float vAlong;
varying float vShade;
varying vec3 vRoot;
float hash2(vec2 p) { p = fract(p * vec2(0.3183099, 0.3678794) + 0.1); p *= 17.0; return fract(p.x * p.y * (p.x + p.y)); }
void main() {
  vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 ws = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
  float rise = max(0.0, ws.y - root.y);
  vec2 wind = uWind.xz;
  float phase = dot(root.xz, vec2(1.7, 1.3));
  float gust = 0.75 + 0.18 * sin(uTime * 0.9 - dot(root.xz, wind) * 0.35) + 0.07 * sin(uTime * 2.3 + root.x);
  float sway = (gust + 0.14 * sin(uTime * 3.4 + phase)) * uWindStrength;
  float along = uv.y;
  float bend = sway * along * rise * 1.4;
  ws.xz += wind * bend;
  float part = 0.0;
  for (int i = 0; i < ${PUSHERS}; i++) {
    // (No early 'continue' here: some drivers translate it wrongly in an instanced draw and fling the blades.)
    vec4 p = uPush[i];
    vec2 away = root.xz - p.xz;
    float near = clamp(1.0 - length(away) / max(p.w, 1e-3), 0.0, 1.0) * step(abs(root.y - p.y), 0.6) * step(1e-4, p.w);
    near = near * near * (3.0 - 2.0 * near);
    float k = near * along * rise * 1.8;
    ws.xz += normalize(away + vec2(1e-4, 0.0)) * k;
    part = max(part, k);
  }
  ws.y -= min(bend * bend * 0.5 + part * 0.45, rise * 0.7);
  vAlong = uv.y;
  vShade = hash2(root.xz * 37.0);
  vRoot = root;
  gl_Position = projectionMatrix * viewMatrix * vec4(ws, 1.0);
}`;
const GRASS_FRAG = /* glsl */ `
uniform vec3 uRoot, uTip;
uniform float uMini;
uniform vec4 uShadow[${PUSHERS}];      // each Linker's shadow on the ground: xyz, w its radius (0: none)
uniform float uShadowK[${PUSHERS}];    // and how deep
varying float vAlong;
varying float vShade;
varying vec3 vRoot;
${GRADE}
void main() {
  vec3 c = mix(toLin(uRoot), toLin(uTip), smoothstep(0.0, 1.0, vAlong));
  c *= 0.92 + 0.16 * vShade;
  // In a Linker's shadow (the ContactShadow's soft round, in the grass that grows through it): darker, cooler.
  float dark = 0.0;
  for (int i = 0; i < ${PUSHERS}; i++) {
    vec4 sh = uShadow[i];
    float a = 1.0 - smoothstep(0.25, 1.0, length(vRoot.xz - sh.xz) / max(sh.w, 1e-3));
    dark = max(dark, a * a * uShadowK[i] * step(1e-4, sh.w) * step(abs(vRoot.y - sh.y), 0.3));
  }
  c = mix(c, c * vec3(0.38, 0.38, 0.55), dark);
  gl_FragColor = vec4(finish(c, uMini), 1.0);
}`;

// One blade a unit high (MeadowGrass.BladeMesh): wide at the root, tapering, curving a little forward.
function bladeGeometry() {
  const pos = [], uv = [], idx = [];
  const segments = 4, width = 0.05, curve = 0.18;
  for (let s = 0; s <= segments; s++) {
    const f = s / segments, w = width * (1 - f) * 0.5 + 0.0008, z = curve * f * f;
    pos.push(-w, f, z, w, f, z);
    uv.push(0, f, 1, f);
    if (s > 0) { const a = 2 * (s - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function signGeometry(kind, r, width, depth) {
  const shape = new THREE.Shape(), hole = new THREE.Path();
  if (kind === 'circle') {
    shape.absarc(0, 0, r, 0, Math.PI * 2, false);
    hole.absarc(0, 0, r - width, 0, Math.PI * 2, true);
  } else {
    const n = kind === 'triangle' ? 3 : 4;
    const start = kind === 'triangle' ? Math.PI / 2 : Math.PI / 4;
    // The inner outline drawn at the same width from each side (a triangle's corner reaches twice as far in).
    const inner = r - width / Math.cos(Math.PI / n);
    const pts = (rad) => Array.from({ length: n }, (_, i) => [Math.cos(start + i * 2 * Math.PI / n) * rad, Math.sin(start + i * 2 * Math.PI / n) * rad]);
    pts(r).forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
    pts(inner).reverse().forEach(([x, y], i) => (i ? hole.lineTo(x, y) : hole.moveTo(x, y)));
  }
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 40 });
  g.translate(0, 0, -depth / 2);
  return g;
}

function groupedGeometry(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.v, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.n, 3));
  const index = [];
  mesh.subs.forEach((s, i) => { g.addGroup(index.length, s.length, i); index.push(...s); });
  g.setIndex(index);
  return g;
}

// The stages, each with one new thing, its islands laid as the game's maps (rows along z, a digit a cell's height
// in half blocks, '.' none; at = where its first cell sits, [x, y, z]; props on cells, the cells under them not
// walked). 1: a tutorial; 2: two signs, the view turned; 3: an island hidden behind a tower; 4: an island that moves;
// 5: all of it.
const LEVELS = [
  { signs: { circle: 2 }, flee: 0, hint: '링커를 잡아 ○ 섬으로 옮겨 보세요', islands: [
    { start: true, at: [-4, 0, -1], map: ['000', '001', '00.'] },
    { sign: 'circle', at: [1, 0.5, 2], map: ['00', '00', '.0'], props: [{ piece: 'SignCircle', cell: [1, 0], yaw: 45, scale: 1.2 }] },
  ] },
  { signs: { circle: 2, triangle: 2 }, flee: 0.6, hint: '가슴의 문양과 같은 섬으로 옮겨 주세요', islands: [
    { start: true, at: [-2, 0, -2], map: ['1100', '1100', '0000', '.00.'] },
    { sign: 'circle', at: [-8, 0.5, -6], map: ['000', '0..', '0..'], props: [{ piece: 'SignCircle', cell: [0, 2], yaw: 45, scale: 1.2 }] },
    { sign: 'triangle', at: [3, 0, 3], map: ['012', '001', '000'], props: [{ piece: 'SignTriangle', cell: [2, 0], yaw: 45, scale: 1.2 }] },
  ] },
  { signs: { circle: 3, triangle: 3, square: 3 }, flee: 0.8, hint: '어딘가 숨은 섬이 있어요. 시점을 돌려 찾아보세요', islands: [
    { start: true, at: [-2, 0, -2], map: ['0000', '0000', '0000', '0000'] },
    // A tower of the meadow's blocks behind the start, the triangle's island out of sight behind it.
    { at: [3, 0, -4], map: ['86', '97'] },
    { sign: 'triangle', at: [6, -0.5, -9], map: ['000', '000', '00.'], props: [{ piece: 'SignTriangle', cell: [0, 0], yaw: 45, scale: 1.2 }] },
    { sign: 'circle', at: [-9, 0.5, -6], map: ['000', '000', '.00'], props: [{ piece: 'SignCircle', cell: [2, 2], yaw: 45, scale: 1.2 }] },
    { sign: 'square', at: [4, 0.5, 4], map: ['000', '00.', '000'], props: [{ piece: 'SignSquare', cell: [0, 2], yaw: 45, scale: 1.2 }] },
  ] },
  { signs: { circle: 3, triangle: 3, square: 3 }, flee: 0.9, hint: '움직이는 섬은 가까이 올 때를 노려 보세요', islands: [
    { start: true, at: [-2, 0, -2], map: ['00000', '00000', '00000', '00000', '00000'],
      props: [{ piece: 'RuneObelisk', cell: [2, 2], scale: 0.6 }] },
    { sign: 'circle', at: [-9, 0.5, -7], map: ['000', '000'], props: [{ piece: 'SignCircle', cell: [0, 0], yaw: 45, scale: 1.2 }] },
    { sign: 'triangle', at: [5, 1, -8], map: ['00', '00', '00'], props: [{ piece: 'SignTriangle', cell: [1, 0], yaw: 45, scale: 1.2 }] },
    { sign: 'square', at: [6, 0.5, 5], map: ['00', '00'], move: { dir: [1, 0, 1], amp: 2, period: 9 },
      props: [{ piece: 'SignSquare', cell: [0, 0], yaw: 45, scale: 1.2 }] },
  ] },
  { signs: { circle: 5, triangle: 5, square: 5 }, flee: 1, hint: '지금까지의 섬이 모두 모였어요. 모두 제자리를 찾아 주세요', islands: [
    { start: true, at: [-3, 0, -3], map: ['22100', '22100', '11000', '00000', '00000'],
      props: [{ piece: 'BrokenRing', cell: [3, 3], dx: 0.5, dz: 0.5, yaw: -45, scale: 0.6, block: [[3, 3], [4, 4]] }] },
    { at: [3, 0, -6], map: ['86', '97'] },
    { sign: 'triangle', at: [6, -0.5, -11], map: ['0000', '0011', '0011'], props: [{ piece: 'SignTriangle', cell: [0, 0], yaw: 45, scale: 1.2 }] },
    { sign: 'circle', at: [-11, 0.5, -8], map: ['0000', '0...', '0000'], props: [{ piece: 'SignCircle', cell: [3, 0], yaw: 45, scale: 1.2 }] },
    { sign: 'square', at: [6, 0.5, 6], map: ['000', '000'], move: { dir: [1, 0, 1], amp: 2.2, period: 10 },
      props: [{ piece: 'SignSquare', cell: [0, 0], yaw: 45, scale: 1.2 }] },
  ] },
];
const LEVEL = Math.min(LEVELS.length, Math.max(1, Math.floor(+new URLSearchParams(location.search).get('level') || 1)));
// The playground (?play): one wide meadow with a hill at one corner, a single Linker to begin with (more come from
// the tray), no signs to sort, nobody running from the pointer; the toys are in js/toys.js.
const PLAY = new URLSearchParams(location.search).has('play');
const PLAYGROUND = {
  signs: { [['circle', 'triangle', 'square'][Math.floor(Math.random() * 3)]]: 1 }, flee: 0, hint: '', islands: [
    { start: true, at: [-5, 0, -4], map: ['..000000..', '.00000000.', '0000000000', '0000000000', '0000000000', '0000000011', '.000000122', '..0000122.', '...00022..'],
      props: [{ piece: 'FallenPillar', cell: [8, 7], yaw: 30, scale: 0.8 }] },
  ],
};
const LV = PLAY ? PLAYGROUND : LEVELS[LEVEL - 1];
const MAX_LINKERS = 16;

export async function start(root, ui) {
  ui.level(PLAY ? 0 : LEVEL, LEVELS.length, LV.hint);
  let caughtOnce = false;
  const tell = (what, detail = {}) => { if (what === 'grab') caughtOnce = true; if (ui.event) ui.event(what, detail); };
  const here = new URL('../assets/', import.meta.url);
  const scene3 = await fetch(new URL('scene.json', here)).then((r) => r.json());
  const meadow = await fetch(new URL('meadow.json', here)).then((r) => r.json());
  const gltf = await new GLTFLoader().loadAsync(new URL('linker_meadow.glb', here).href);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  root.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.style.touchAction = 'none';

  const shared = {
    light: { value: new THREE.Vector3().fromArray(scene3.light).normalize() },
    view: { value: new THREE.Vector3() },
    mini: { value: scene3.miniature },
  };
  const world = new THREE.Scene();

  // The camera: the page's (pitch 13 degrees, turned 45), orthographic.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  // The view turns freely: yaw (from the page's 45 degrees), pitch (from its 13), zoom; fwd and R follow it.
  const look = { yaw: Math.PI / 4, pitch: 0.2269, zoom: 1, tyaw: Math.PI / 4, tpitch: 0.2269, tzoom: 1 };
  const fwd = new THREE.Vector3();
  const R = new THREE.Vector3();                                     // the screen's right, level
  const fwdLevel = new THREE.Vector3();                              // into the screen, level
  function aimView() {
    fwd.set(Math.sin(look.yaw) * Math.cos(look.pitch), -Math.sin(look.pitch), -Math.cos(look.yaw) * Math.cos(look.pitch)).normalize();
    R.set(-fwd.z, 0, fwd.x).normalize();
    fwdLevel.set(fwd.x, 0, fwd.z).normalize();
    shared.view.value.copy(fwd).negate();
  }
  aimView();
  const Y = new THREE.Vector3(0, 1, 0);
  const windDir = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();     // from behind the view (it comes round after it)

  // ---- The islands, laid as the game lays its maps: blocks a unit wide, each cell at its own height (half units:
  // '0' the island's foot, '1' half a block up, '8' four blocks up), '.' none. A Linker steps up or down half a block
  // at most; a cell under a prop is not walked. A moving island goes to and fro along its way; whoever stands on it
  // goes with it.
  const EDGES = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const islands = LV.islands.map((d, n) => {
    const isl = { name: d.sign || (d.start ? 'start' : `isle${n}`), sign: d.sign, start: !!d.start, base: new THREE.Vector3(...d.at),
      cells: new Map(), move: d.move || null, props: d.props || [] };
    d.map.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.' || ch === ' ') return;
      const lvl = parseInt(ch, 10);
      isl.cells.set(`${i},${j}`, { i, j, lvl, top: lvl * 0.5, blocked: false, island: isl });
    }));
    for (const p of isl.props) for (const [i, j] of p.block || [p.cell]) { const c = isl.cells.get(`${i},${j}`); if (c) c.blocked = true; }
    isl.group = new THREE.Group();
    isl.group.position.copy(isl.base);
    world.add(isl.group);
    return isl;
  });
  const startIsland = islands.find((i) => i.start);
  const signIslands = islands.filter((i) => i.sign);
  const cellOf = (isl, i, j) => isl.cells.get(`${i},${j}`);
  // The cell under a point of the world (and its top, in the world), on whichever island is there now.
  function tileAt(x, z) {
    for (const isl of islands) {
      const g = isl.group.position;
      const c = cellOf(isl, Math.round(x - g.x), Math.round(z - g.z));
      if (c) return { cell: c, island: isl, top: g.y + c.top };
    }
    return null;
  }
  const cellWorld = (c, out = new THREE.Vector3()) => out.set(c.island.group.position.x + c.i, c.island.group.position.y + c.top, c.island.group.position.z + c.j);
  const steps = (c) => EDGES.map(([dx, dz]) => cellOf(c.island, c.i + dx, c.j + dz)).filter((n) => n && !n.blocked && Math.abs(n.lvl - c.lvl) <= 1);
  // The cells walkable from one, nearest first (with how many steps), up to `most` steps.
  function reach(from, most = 99) {
    const seen = new Map([[from, 0]]), out = [from];
    for (let k = 0; k < out.length; k++) {
      const c = out[k], d = seen.get(c);
      if (d >= most) continue;
      for (const n of steps(c)) if (!seen.has(n)) { seen.set(n, d + 1); out.push(n); }
    }
    return { cells: out, dist: seen };
  }
  // The way from one cell to another, step by step (empty if there is none).
  function way(from, to) {
    const prev = new Map([[from, null]]), q = [from];
    for (let k = 0; k < q.length && !prev.has(to); k++) for (const n of steps(q[k])) if (!prev.has(n)) { prev.set(n, q[k]); q.push(n); }
    if (!prev.has(to)) return [];
    const path = [];
    for (let c = to; c && c !== from; c = prev.get(c)) path.unshift(c);
    return path;
  }

  // Stone: chapter 7's grassy block, its top the blades' root green (what shows between them reads as more grass),
  // faded below; a cell high up stands on a column of them down to the island's foot.
  const tileParts = meadow.tile.map((p) => ({ g: groupedGeometry(p.mesh), mat: p.mat }));
  const earth = () => meadow.mats.MeadowBlades.Root.map((v) => v * 0.92);
  for (const isl of islands) {
    const mats = tileParts.map((p) => material({ ...p.mat, TopColor: earth() }, shared, { objY: -(isl.base.y - 0.5) }));
    for (const c of isl.cells.values()) {
      const below = Math.ceil(c.top);
      for (let k = 0; k <= below; k++) {
        tileParts.forEach((p, n) => {
          if (n > 0 && k < below) return;                  // the underside only under the lowest
          const m = new THREE.Mesh(p.g, mats[n]);
          m.position.set(c.i, c.top - 0.5 - k, c.j);
          isl.group.add(m);
        });
      }
    }
  }

  // ---- The grass, by the game's rules (LevelBuilder.Meadow.GrowMeadow, the meadow covered all over): a 28 x 28
  // scatter on each top, a clump or two as tall as the Linker; where a top has nothing beside it, or a lower one,
  // the blades lean out over the edge and a few hang down the side.
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const DENSITY = matchMedia('(pointer: coarse)').matches ? 0.6 : 1;   // as the game's; lighter on a phone
  const grassUniforms = {
    uTime: { value: 0 },
    uWind: { value: windDir },
    uWindStrength: { value: meadow.wind },
    // (An unused place is parked far off, not at the world's middle.)
    uPush: { value: Array.from({ length: PUSHERS }, () => new THREE.Vector4(9999, -9999, 9999, 0)) },
    uShadow: { value: Array.from({ length: PUSHERS }, () => new THREE.Vector4(9999, -9999, 9999, 0)) },
    uShadowK: { value: new Array(PUSHERS).fill(0) },
    uRoot: { value: new THREE.Color().fromArray(meadow.mats.MeadowBlades.Root) },
    uTip: { value: new THREE.Color().fromArray(meadow.mats.MeadowBlades.Tip) },
    uMini: shared.mini,
  };
  const grassLook = new THREE.ShaderMaterial({ vertexShader: GRASS_VERT, fragmentShader: GRASS_FRAG, uniforms: grassUniforms, side: THREE.DoubleSide });
  const bladeShape = bladeGeometry();
  const openEdges = (c) => EDGES.filter(([dx, dz]) => { const n = cellOf(c.island, c.i + dx, c.j + dz); return !n || n.lvl < c.lvl; });
  for (const isl of islands) {
    const blades = [];
    for (const c of isl.cells.values()) {
      const open = openEdges(c);
      const tall = [];
      for (let k = 0; k < 2; k++) { const tx = rnd() - 0.5, tz = rnd() - 0.5; if (rnd() < 0.45) tall.push([tx, tz]); }
      const grid = 28;
      for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
        if (rnd() > 0.9 * DENSITY) continue;
        const lx = (i + rnd()) / grid - 0.5, lz = (j + rnd()) / grid - 0.5;
        let x = c.i + lx, z = c.j + lz;
        let h = (0.09 + 0.17 * Math.pow(rnd(), 1.5)) * 1.15;
        if (tall.some(([cx, cz]) => (cx - lx) ** 2 + (cz - lz) ** 2 < 0.13 * 0.13)) h = 0.34 + 0.3 * rnd();
        let lean = rnd() * 22, toward = rnd() * Math.PI * 2;
        const yaw = rnd() * Math.PI * 2;
        for (const [dx, dz] of open) {
          const d = 0.5 - (dx ? dx * lx : dz * lz);
          if (d > 0.14) continue;
          const k = 1 - d / 0.14;
          lean = lean + (35 + 40 * rnd() - lean) * k;
          toward = Math.atan2(dx, dz) + (rnd() - 0.5) * 0.9;
          x += dx * 0.03 * k; z += dz * 0.03 * k;
        }
        blades.push([x, c.top - 0.005, z, h, yaw, lean, toward]);
      }
      for (const [dx, dz] of open) {
        for (let k = 0; k < 18; k++) {
          const s = rnd() - 0.5;
          if (rnd() > 0.65 * DENSITY) continue;
          const x = c.i + dx * 0.505 + dz * s, z = c.j + dz * 0.505 - dx * s;
          blades.push([x, c.top - 0.01 - rnd() * 0.02, z, 0.1 + 0.18 * rnd(), rnd() * Math.PI * 2, 105 + 45 * rnd(), Math.atan2(dx, dz) + (rnd() - 0.5) * 0.7]);
        }
      }
    }
    const grass = new THREE.InstancedMesh(bladeShape, grassLook, blades.length);
    const m = new THREE.Matrix4(), qb = new THREE.Quaternion(), qy = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), dv = new THREE.Vector3();
    blades.forEach(([x, y, z, h, yaw, lean, toward], i) => {
      const a = THREE.MathUtils.degToRad(lean);
      dv.set(Math.sin(toward) * Math.sin(a), Math.cos(a), Math.cos(toward) * Math.sin(a)).normalize();
      qb.setFromUnitVectors(Y, dv).multiply(qy.setFromAxisAngle(Y, yaw));
      m.compose(pv.set(x, y, z), qb, sv.set(1, h, 1));
      grass.setMatrixAt(i, m);
    });
    grass.frustumCulled = false;
    isl.group.add(grass);
  }

  // ---- Flowers in drifts (one kind to a stretch), vines down the high open edges, and the props (the meadow's
  // ruins and sign stones), all swaying in the wind but the stones.
  const pieceMat = (name) => material(meadow.mats[name] || meadow.mats.MeadowStem, shared);
  const pieceMats = {};
  const pieces = {};
  for (const [name, p] of Object.entries(meadow.pieces)) {
    pieces[name] = groupedGeometry(p.mesh);
    pieceMats[name] = p.slots.map((s) => pieceMats[s] || (pieceMats[s] = pieceMat(s)));
  }
  const swayers = [];
  let bloomed = false;
  // (x, y, z in the island's own space.)
  function plant(name, x, y, z, scale, yaw, lean, island, grow = 1, after = 0) {
    const stem = new THREE.Group();
    stem.position.set(x, y, z);
    const mesh = new THREE.Mesh(pieces[name], pieceMats[name]);
    mesh.rotation.y = yaw;
    mesh.scale.setScalar(scale);
    stem.add(mesh);
    island.group.add(stem);
    const s = { stem, lean: THREE.MathUtils.degToRad(lean), phase: x * 1.7 + z * 1.3, island, grow, bloom: grow < 1, born: nowMs() + after, scale };
    if (grow < 1) stem.scale.setScalar(0.001);
    swayers.push(s);
    return s;
  }
  const FLOWERS = ['Daisy', 'PinkFlower', 'Buttercup'];
  const flowerPlan = [];
  const VINES = ['VineLong', 'VineMid', 'VineShort'];
  for (const isl of islands) {
    for (const c of isl.cells.values()) {
      for (const [dx, dz] of EDGES) {
        const n = cellOf(isl, c.i + dx, c.j + dz);
        if (n && c.lvl - n.lvl < 2) continue;                // vines only down a drop of a block or more
        for (let k = 0; k < 3; k++) {
          if (rnd() > 0.6) continue;
          const s = (k - 1) * 0.3 + (rnd() - 0.5) * 0.2;
          plant(VINES[Math.floor(rnd() * 3)], c.i + dx * 0.512 + dz * s, c.top - 0.015, c.j + dz * 0.512 - dx * s,
            0.85 + rnd() * 0.35, Math.atan2(dx, dz), 4, isl);
        }
      }
      if (c.blocked) continue;
      for (let k = 0; k < 7; k++) {
        const lx = rnd() - 0.5, lz = rnd() - 0.5;
        if (rnd() > 0.4) continue;
        const x = c.i + lx, z = c.j + lz;
        const kind = clamp(Math.floor(grassNoise(x * 0.7 + isl.base.x, z * 0.7 + isl.base.z, 12.5) * 3.4), 0, 2);
        // The islands the Linkers do not start on have no flowers until full of their own (see count()).
        const f = [FLOWERS[kind], x, c.top, z, 1.9 + rnd() * 0.7, rnd() * Math.PI * 2, isl];
        if (!isl.sign) plant(f[0], f[1], f[2], f[3], f[4], f[5], 10, f[6]);
        else flowerPlan.push(f);
      }
    }
    for (const p of isl.props) {
      const c = cellOf(isl, p.cell[0], p.cell[1]);
      const mesh = new THREE.Mesh(pieces[p.piece], pieceMats[p.piece]);
      mesh.position.set(p.cell[0] + (p.dx || 0), (c ? c.top : 0) + (p.dy || 0), p.cell[1] + (p.dz || 0));
      mesh.rotation.y = THREE.MathUtils.degToRad(p.yaw || 0);
      mesh.scale.setScalar(p.scale || 1);
      isl.group.add(mesh);
    }
  }

  // ---- The Linkers.
  // Their shadows (Shaders/ContactShadow.shader: _BaseColor (0.16, 0.13, 0.24, 0.45), _Softness 0.75).
  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  const SHADOW_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const SHADOW_FRAG = /* glsl */ `
    uniform float uAlpha;
    varying vec2 vUv;
    void main() {
      float d = length(vUv - 0.5) * 2.0;
      float a = 1.0 - smoothstep(0.25, 1.0, d);
      gl_FragColor = vec4(0.13, 0.1, 0.22, 0.72 * a * a * uAlpha);
    }`;
  const SHADOW_SIZE = 0.78;
  const L = scene3.linker;
  const SIGNS = ['circle', 'triangle', 'square'];
  // This stage's Linkers, their signs mixed.
  const linkerSigns = Object.entries(LV.signs).flatMap(([k, n]) => Array(n).fill(k)).sort(() => Math.random() - 0.5);
  const COUNT = linkerSigns.length;
  const signLook = material({ shader: 'unlit', BaseColor: [1, 0.86, 0.46] }, shared);
  const chestSign = Object.fromEntries(SIGNS.map((k) => [k, signGeometry(k, k === 'triangle' ? 0.06 : 0.05, 0.016, 0.01)]));
  const linkers = [];
  const S = 1;
  const H = 0.73 * S;
  const newShade = () => {
    const m = new THREE.Mesh(shadowGeometry, new THREE.ShaderMaterial({
      vertexShader: SHADOW_VERT, fragmentShader: SHADOW_FRAG, transparent: true, depthWrite: false,
      uniforms: { uAlpha: { value: 1 } },
    }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 2;
    world.add(m);
    return m;
  };
  function makeLinker(sign) {
    const model = SkeletonUtils.clone(gltf.scene);
    const blink = { value: 0 };
    const bones = {};
    model.traverse((o) => {
      if (o.isBone) bones[o.name] = o;
      if (o.isMesh) {
        const m = L.mats[o.material.name] || L.mats.Body;
        o.material = material(m, shared, o.material.name === 'Eyes' ? { blink, eyeY: 0.5147 } : {});
        o.frustumCulled = false;
      }
    });
    const holder = new THREE.Group();
    holder.add(model);
    world.add(holder);
    model.updateMatrixWorld(true);
    const top = new THREE.Box3().setFromObject(model).max.y;
    const emblem = new THREE.Mesh(chestSign[sign], signLook);
    emblem.position.set(0, 0.33, 0.132);              // the game's emblem's place on the chest, facing out
    model.add(emblem);
    bones.Body.attach(emblem);
    const mixer = new THREE.AnimationMixer(model);
    const idle = mixer.clipAction(gltf.animations.find((a) => a.name === 'Idle'));
    const walk = mixer.clipAction(gltf.animations.find((a) => a.name === 'Walk'));
    idle.play(); walk.play();
    walk.setEffectiveWeight(0);
    mixer.update(Math.random() * 2);
    const rest = {};
    for (const b of ['Head', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg']) rest[b] = bones[b].quaternion.clone();
    // Its shadow (the game's ContactShadow): a soft dark round on the ground under it.
    const shade = newShade();
    const l = {
      shade, sign, top, puzzledAt: -1e9,
      holder, model, bones, mixer, idle, walk, blink, rest,
      island: null, home: null, path: [],
      pos: new THREE.Vector3(), heading: Math.random() * Math.PI * 2, target: null,
      state: 'idle', until: 0, walkW: 0,
      anchor: new THREE.Vector3(), vel: new THREE.Vector3(), lastVel: new THREE.Vector3(), swing: 0, swingVel: 0,
      blinkAt: nowMs() + Math.random() * 4000, landAt: -1e9, hopAt: -1e9, fleeAt: 0, react: 0.05 + Math.random() * 0.17,
      tired: 0, scr: null,
    };
    linkers.push(l);
    return l;
  }
  for (let n = 0; n < COUNT; n++) makeLinker(linkerSigns[n]);
  function spot(isl, avoid) {
    const free = [...isl.cells.values()].filter((c) => !c.blocked);
    const home = isl === startIsland ? reach(free[0]).cells : free;
    for (let k = 0; k < 30; k++) {
      const c = home[Math.floor(Math.random() * home.length)];
      const p = cellWorld(c).add(tmp.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5));
      if (!avoid || linkers.every((o) => o === avoid || o.pos.distanceTo(p) > 0.5)) return p;
    }
    return cellWorld(home[0]);
  }
  function reset() {
    for (const l of linkers) {
      l.island = l.home = startIsland;
      l.pos.copy(spot(startIsland, l));
      l.path = [];
      l.state = 'idle'; l.until = nowMs() + Math.random() * 2000;
    }
    for (const s of swayers.filter((s) => s.bloom)) world.remove(s.stem);
    swayers.splice(0, swayers.length, ...swayers.filter((s) => !s.bloom));
    for (const isl of signIslands) isl.full = false;
    bloomed = false;
    count();
  }

  // ---- The first stage: a gold ring under one Linker, soft and slowly breathing, until one is caught.
  const ring = !PLAY && LEVEL === 1 ? new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 48), new THREE.MeshBasicMaterial({
    color: 0xffd36e, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })) : null;
  if (ring) { ring.rotation.x = -Math.PI / 2; ring.renderOrder = 3; world.add(ring); }

  // ---- The cores.
  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255, 214, 120, 0.55)');
    grad.addColorStop(0.4, 'rgba(255, 200, 90, 0.2)');
    grad.addColorStop(1, 'rgba(255, 190, 80, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const coreLook = material({ shader: 'unlit', BaseColor: [1, 0.84, 0.42] }, shared);
  for (const isl of signIslands) {
    const cs = [...isl.cells.values()];
    const mid = new THREE.Vector3(cs.reduce((a, c) => a + c.i, 0) / cs.length, Math.max(...cs.map((c) => c.top)) + 2.3, cs.reduce((a, c) => a + c.j, 0) / cs.length);
    const core = new THREE.Group();
    core.position.copy(mid);
    const body = new THREE.Mesh(signGeometry(isl.sign, isl.sign === 'triangle' ? 0.95 : 0.78, 0.16, 0.14), coreLook);
    core.add(body);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(3.2);
    core.add(glow);
    isl.group.add(core);
    const label = document.createElement('div');
    label.className = 'core-count';
    root.appendChild(label);
    Object.assign(isl, { core, body, glow, mid, label, spin: Math.random() * 6 });
  }

  // ---- The clouds: a sea of them under the islands (not a band across the screen), the colour of the sky's foot,
  // thinning out far off into the sky; the islands' roots and a dropped Linker go down into it.
  const lowest = Math.min(...islands.map((i) => i.base.y));
  // (Two layers of soft heaped cloud, white and lit warm from above, a pale sky blue in their hollows, drifting slowly.)
  // (A hash without sin, which some phones' GPUs compute too coarsely to make any cloud at all.)
  const CLOUD_FRAG = `precision highp float;
    uniform vec2 uCentre; uniform float uTime; uniform float uSeed; varying vec3 vW;
    float h(vec2 p) { vec3 p3 = fract(vec3(p.xyx + uSeed) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
    float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * n(p); p *= 2.03; a *= 0.5; } return s; }
    void main() {
      vec2 q = vW.xz * 0.16 + vec2(uTime * 0.012, uTime * 0.006);
      float c = fbm(q + fbm(q * 0.6) * 0.8);
      float puff = smoothstep(0.34, 0.66, c);
      vec3 col = mix(vec3(0.84, 0.89, 0.96), vec3(1.0, 0.99, 0.96), smoothstep(0.38, 0.72, c));
      float far = smoothstep(10.0, 30.0, length(vW.xz - uCentre));
      gl_FragColor = vec4(col, (0.3 + 0.65 * puff) * (1.0 - far));
    }`;
  const cloudLayers = [[1.9, 0.0], [3.0, 7.3]].map(([down, seed], k) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uCentre: { value: new THREE.Vector2() }, uTime: { value: 0 }, uSeed: { value: seed } },
      vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: CLOUD_FRAG,
    }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = lowest - down;
    m.renderOrder = 1 - k;
    world.add(m);
    return m;
  });

  // ---- The view.
  // Framed on this stage's islands: their middle, wide enough for all of them across the screen.
  let spanLo = Infinity, spanHi = -Infinity;
  const tmpV = new THREE.Vector3();
  const centre = new THREE.Vector3();
  let cellCount = 0;
  const lo = new THREE.Vector3(Infinity, 0, Infinity), hi = new THREE.Vector3(-Infinity, 0, -Infinity);
  for (const isl of islands) for (const c of isl.cells.values()) for (const k of isl.move ? [-1, 1] : [0]) {
    const x = isl.base.x + c.i + (isl.move ? isl.move.dir[0] * isl.move.amp * k / Math.hypot(...isl.move.dir) : 0);
    const z = isl.base.z + c.j + (isl.move ? isl.move.dir[2] * isl.move.amp * k / Math.hypot(...isl.move.dir) : 0);
    const u = x * R.x + z * R.z;
    spanLo = Math.min(spanLo, u); spanHi = Math.max(spanHi, u);
    lo.min(tmpV.set(x, 0, z)); hi.max(tmpV.set(x, 0, z));
    centre.x += x; centre.z += z; centre.y += isl.base.y + c.top;
    cellCount++;
  }
  centre.divideScalar(cellCount);
  centre.y += 1.1;                          // (looking a little higher: the cores above the islands, clear of the heading)
  const spanW = spanHi - spanLo + 3.2;
  const tcentre = centre.clone();
  let fitH = 11, viewH = 11;
  function frame() {
    const w = root.clientWidth, h = root.clientHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    fitH = Math.max(9, spanW * 0.55, spanW / (w / h));
  }
  function place() {
    const w = root.clientWidth, h = root.clientHeight;
    aimView();
    viewH = fitH * look.zoom;
    const half = viewH * (w / h) / 2;
    camera.left = -half; camera.right = half; camera.top = viewH / 2; camera.bottom = -viewH / 2;
    camera.updateProjectionMatrix();
    camera.position.copy(centre).addScaledVector(fwd, -60);
    camera.up.set(0, 1, 0);
    camera.lookAt(centre);
    camera.updateMatrixWorld();
  }
  frame();
  place();
  addEventListener('resize', frame);
  const pxPerUnit = () => canvas.clientHeight / viewH;
  const toScreen = (v) => {
    const p = v.clone().project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  };
  const ray = (x, y) => {
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector3((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1, -1).unproject(camera);
  };
  const onGround = (x, y, h) => { const o = ray(x, y); return o.addScaledVector(fwd, (h - o.y) / fwd.y); };
  const onPlane = (x, y, through) => { const o = ray(x, y); return o.addScaledVector(fwd, fwd.dot(through.clone().sub(o))); };

  // ---- The pointer.
  const pointer = { x: -1e4, y: -1e4, at: -1e9, here: false, touch: false };
  let held = null;
  const samples = [];
  const toys = PLAY ? makeToys({
    world, shared, material, linkers, Y, S, HIP: 0.1, tileAt, cellWorld, startIsland, lowest,
    plant: (...a) => plant(...a), FLOWERS, ray, fwd, R, windDir, pointer, pxPerUnit, toScreen,
    turnBone: (b, qq) => turnBone(b, qq), tell, newShade, now: nowMs,
  }) : null;
  const STANDING = PLAY ? ['idle', 'walk', 'flee', 'busy'] : ['idle', 'walk', 'flee'];
  // Turning the view while a Linker is held: with a mouse, the right button pressed as well (the Linker still
  // follows the pointer meanwhile); with fingers, a second finger on the empty sky.
  let chord = null;
  addEventListener('pointermove', (e) => {
    if (held && e.pointerType === 'mouse' && (e.buttons & 2)) {
      if (chord) {
        const dx = e.clientX - chord.x, dy = e.clientY - chord.y;
        look.tyaw += dx * 0.006;
        look.tpitch = clamp(look.tpitch + dy * 0.004, 0.12, 1.15);
        if (Math.abs(dx) + Math.abs(dy) > 2) tell('turn');
      }
      chord = { x: e.clientX, y: e.clientY };
    } else {
      chord = null;
    }
    // While a Linker is held, only the hand holding it moves it.
    if (held && e.pointerId !== held.pointerId) return;
    Object.assign(pointer, { x: e.clientX, y: e.clientY, at: nowMs(), here: true, touch: e.pointerType === 'touch' });
  });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) pointer.here = false; });
  canvas.addEventListener('pointerdown', (e) => {
    Object.assign(pointer, { x: e.clientX, y: e.clientY, at: nowMs(), here: true, touch: e.pointerType === 'touch' });
    // With a mouse the view is the right button's (turn; with Shift, or the middle button, move) and the left's
    // only catches Linkers; a finger does both, as before.
    if (e.pointerType === 'mouse' && e.button !== 0) { startView(e); return; }
    // A second finger while one holds a Linker turns the view.
    if (held) { startView(e); return; }
    // The nearest Linker under the pointer (its body on screen).
    let best = null, bestD = 0.42 * pxPerUnit();
    for (const l of linkers) {
      if (!STANDING.includes(l.state)) continue;
      const c = toScreen(l.holder.position.clone().addScaledVector(Y, H * 0.5));
      const d = Math.hypot(c.x - e.clientX, (c.y - e.clientY) * 0.7);
      if (d < bestD) { best = l; bestD = d; }
    }
    if (!best) {
      if (toys && e.pointerType === 'mouse' && toys.grab(e)) return;
      if (toys && e.pointerType !== 'mouse' && toys.grab(e)) { e.preventDefault(); return; }
      if (e.pointerType !== 'mouse') startView(e);
      return;
    }
    if (toys) toys.release(best);
    best.want = null;
    best.anchor.copy(best.holder.position).addScaledVector(Y, H);
    if (best.state === 'busy') best.pos.copy(best.holder.position);
    takeUp(best, e);
    e.preventDefault();
  });
  function takeUp(l, e) {
    held = l;
    held.state = 'held';
    held.pointerId = e.pointerId;
    // (Its island stays the one it was taken from until it lands elsewhere: dropped, it comes back there.)
    held.vel.set(0, 0, 0); held.lastVel.set(0, 0, 0);
    held.swing = 0; held.swingVel = 0;
    held.plane = held.anchor.clone();
    held.carryTop = held.pos.y;
    samples.length = 0;
    document.documentElement.style.cursor = 'grabbing';
    tell('grab');
  }
  // A new Linker from the tray: carried out under the pointer (let go, it comes down there), or, with only a press
  // (or a key), dropped from the sky somewhere on the island.
  function addLinker(e) {
    if (linkers.length >= MAX_LINKERS) return false;
    const l = makeLinker(['circle', 'triangle', 'square'][Math.floor(Math.random() * 3)]);
    l.island = l.home = startIsland;
    l.pos.copy(spot(startIsland, l));
    l.path = [];
    l.vel.set(0, 0, 0); l.lastVel.set(0, 0, 0); l.swing = 0; l.swingVel = 0;
    if (e) {
      Object.assign(pointer, { x: e.clientX, y: e.clientY, at: nowMs(), here: true });
      l.carryTop = undefined;
      takeUp(l, e);
      l.anchor.copy(carryPoint(l));
    } else {
      l.anchor.set(l.pos.x, l.pos.y + 9 + H, l.pos.z);
      l.state = 'drop';
    }
    l.holder.position.copy(l.anchor);
    if (ui.linkers) ui.linkers(linkers.length, MAX_LINKERS);
    tell('add');
    return true;
  }
  // Turning, moving and zooming the view by hand.
  const drags = new Map();          // pointer id -> { x, y, pan }
  let pinch = 0, twist = null;
  function startView(e) {
    drags.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.shiftKey });
    if (drags.size === 2) { const [a, b] = [...drags.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); twist = Math.atan2(b.y - a.y, b.x - a.x); }
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();          // (the middle button's page scrolling, the right's menu)
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointermove', (e) => {
    const d = drags.get(e.pointerId);
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (drags.size === 2) {
      // Two fingers: apart or together to zoom, round about each other to turn, both along to move.
      const [first, second] = [...drags.entries()];
      const a = first[0] === e.pointerId ? { x: e.clientX, y: e.clientY } : first[1];
      const b = second[0] === e.pointerId ? { x: e.clientX, y: e.clientY } : second[1];
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (pinch > 0) { look.tzoom = clamp(look.tzoom * pinch / span, 0.45, 1.8); tell('zoom'); }
      pinch = span;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (twist !== null) {
        const turn = ((angle - twist + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        if (Math.abs(turn) > 0.002) { look.tyaw += turn; tell('turn'); }
      }
      twist = angle;
      pan(dx / 2, dy / 2);
    } else if (d.pan) {
      pan(dx, dy);
      tell('pan');
    } else {
      look.tyaw += dx * 0.006;
      look.tpitch = clamp(look.tpitch + dy * 0.004, 0.12, 1.15);
      if (Math.abs(dx) + Math.abs(dy) > 2) tell('turn');
    }
    d.x = e.clientX; d.y = e.clientY;
  });
  const endView = (e) => { drags.delete(e.pointerId); pinch = 0; twist = null; };
  canvas.addEventListener('pointerup', endView);
  canvas.addEventListener('pointercancel', endView);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    look.tzoom = clamp(look.tzoom * Math.exp(e.deltaY * 0.0012), 0.45, 1.8);
    tell('zoom');
  }, { passive: false });
  function pan(dx, dy) {
    const k = viewH / canvas.clientHeight;
    // Across the screen along its right; up the screen into it along the ground.
    tcentre.addScaledVector(R, -dx * k).addScaledVector(fwdLevel, dy * k / Math.max(0.35, Math.sin(look.pitch)));
    tcentre.x = clamp(tcentre.x, lo.x - 2, hi.x + 2); tcentre.z = clamp(tcentre.z, lo.z - 2, hi.z + 2);
  }

  const letGo = (e) => {
    if (!held || (e && e.pointerId !== held.pointerId)) return;
    // Thrown, or only let go: how fast the hood was going.
    const v = samples.length ? samples.reduce((a, x) => a + x.v.length(), 0) / samples.length : 0;
    tell('drop', { thrown: v > 2.6 });
    held.state = 'fall';
    held.fallAt = nowMs();
    held = null;
    document.documentElement.style.cursor = '';
  };
  addEventListener('pointerup', letGo);
  addEventListener('pointercancel', letGo);

  // ---- Each Linker, each step.
  const GRAVITY = 14;
  const qBody = new THREE.Quaternion(), qParent = new THREE.Quaternion(), q = new THREE.Quaternion();
  const hang = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  function turnBone(bone, qq) {
    bone.parent.getWorldQuaternion(qParent);
    bone.quaternion.premultiply(qParent.clone().invert().multiply(qq).multiply(qParent));
  }
  function ground(l, now, dt) {
    const here = tileAt(l.pos.x, l.pos.z);
    const cell = here && here.island === l.island ? here.cell : null;
    // Running from the pointer: when it hovers near (a moment to notice), to the cell nearby that is most away from
    // it. (How near, as the reader sees it: on the screen, from the Linker's middle; turned into a way over the
    // ground: across the screen along its right, up the screen into it.)
    let away = null;
    if (LV.flee > 0 && pointer.here && !pointer.touch && now - pointer.at < 1500 && !held && !drags.size && l.scr) {
      const sx = l.scr.x - pointer.x, sy = l.scr.y - pointer.y;
      const near = Math.hypot(sx, sy) / pxPerUnit();
      if (near < 1.6) {
        away = tmp.copy(R).multiplyScalar(sx).addScaledVector(fwdLevel, -sy / Math.max(0.35, Math.sin(look.pitch)));
        away.y = 0;
        if (away.lengthSq() < 1e-6) away.set(Math.sin(l.heading), 0, Math.cos(l.heading));
        away.normalize();
      }
    }
    if (away && cell) {
      if (l.state !== 'flee' && !l.fleeAt) l.fleeAt = now + l.react * 1000;
      if (now >= l.fleeAt) {
        if (l.state !== 'flee') { l.hopAt = now; l.hopH = 0.12; }
        l.state = 'flee';
        if (!l.path.length || now - (l.fleeAim || 0) > 250) {
          l.fleeAim = now;
          let best = null, bestScore = 0.15;
          const { cells, dist } = reach(cell, 4);
          for (const c of cells) {
            const d = cellWorld(c, tmp2).sub(l.pos); d.y = 0;
            const len = d.length();
            if (len < 0.3) continue;
            const score = d.dot(away) / len * Math.min(len, 2.2) - dist.get(c) * 0.05;
            if (score > bestScore) { best = c; bestScore = score; }
          }
          if (best) l.path = way(cell, best);
        }
      }
    } else {
      l.fleeAt = 0;
      if (l.state === 'flee') { l.state = 'idle'; l.path = []; l.until = now + 500 + Math.random() * 1000; }
    }
    // Running tires it: a long chase slows it down; resting brings the breath back.
    l.tired = clamp((l.tired || 0) + (l.state === 'flee' ? dt / 3.5 : -dt / 2.5), 0, 1);
    // Something it wants (a toy, a seat, shelter from the rain): the way there cell by cell, then straight to the
    // very spot; there, what it came for.
    let aim = null;
    if (l.want && l.state !== 'flee') {
      const w = l.want;
      const p = w.alive() && now < w.until ? w.at() : null;
      const t = p && tileAt(p.x, p.z);
      if (!p || !cell || !t || t.island !== l.island || t.cell.blocked) {
        l.want = null; l.path = [];
        if (l.state === 'walk') { l.state = 'idle'; l.until = now + 600; }
      } else if (Math.hypot(p.x - l.pos.x, p.z - l.pos.z) < w.near) {
        l.want = null; l.path = [];
        l.state = 'idle'; l.until = now + 800 + Math.random() * 1200;
        w.then(l, now);
        if (l.state === 'busy') return;
      } else {
        if (!l.path.length || now - (l.wantAt || 0) > 350) {
          l.wantAt = now;
          l.path = t.cell === cell ? [] : way(cell, t.cell);
        }
        if (t.cell !== cell && !l.path.length) { l.want = null; if (l.state === 'walk') { l.state = 'idle'; l.until = now + 600; } }
        else { l.state = 'walk'; if (l.path.length <= 1) aim = p; }
      }
    }
    if (l.state === 'idle' && now > l.until && cell && !l.want) {
      const { cells } = reach(cell, 6);
      const to = cells[Math.floor(Math.random() * cells.length)];
      l.path = to === cell ? [] : way(cell, to);
      if (l.path.length) l.state = 'walk'; else l.until = now + 1200;
    }
    let speed = 0;
    if ((l.state === 'walk' || l.state === 'flee') && (l.path.length || aim)) {
      const next = aim ? tmp2.copy(aim) : cellWorld(l.path[0], tmp2);
      const to = tmp.set(next.x - l.pos.x, 0, next.z - l.pos.z);
      const d = to.length();
      if (d < 0.07) {
        if (l.path.length) l.path.shift();
        if (!l.path.length && l.state === 'walk' && !l.want) { l.state = 'idle'; l.until = now + 1500 + Math.random() * 2600; }
      } else {
        speed = l.state === 'flee' ? 2.6 * LV.flee * (1 - 0.55 * l.tired) : l.want ? (l.want.run ? 1.5 : 0.8) : 0.55;
        to.divideScalar(d);
        const want = Math.atan2(to.x, to.z);
        const turn = ((want - l.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const rate = l.state === 'flee' ? 16 : 9;
        l.heading += clamp(turn, -dt * rate, dt * rate);
        const step = Math.min(d, speed * dt * clamp(1 - Math.abs(turn) / 2.6, 0.45, 1));
        l.pos.x += Math.sin(l.heading) * step; l.pos.z += Math.cos(l.heading) * step;
      }
    } else if (l.state === 'walk' && !l.want) {
      l.state = 'idle'; l.until = now + 1000;
    }
    // Not into one another (but not pushed off where it may stand).
    for (const o of linkers) {
      if (o === l || o.island !== l.island || !['idle', 'walk', 'flee'].includes(o.state) || o.perch) continue;
      const dx = l.pos.x - o.pos.x, dz = l.pos.z - o.pos.z, d = Math.hypot(dx, dz);
      if (d > 0 && d < 0.42) {
        const nx = l.pos.x + dx / d * (0.42 - d) * 0.5, nz = l.pos.z + dz / d * (0.42 - d) * 0.5;
        const t = tileAt(nx, nz);
        if (t && t.island === l.island && !t.cell.blocked && cell && Math.abs(t.cell.lvl - cell.lvl) <= 1) { l.pos.x = nx; l.pos.z = nz; }
      }
    }
    // On the cell under its feet: stepping up or down half a block smoothly.
    const under = tileAt(l.pos.x, l.pos.z);
    if (under && under.island === l.island) l.pos.y = damp(l.pos.y, under.top, 16, dt);
    l.walkW = damp(l.walkW, speed > 0 ? 1 : 0, 8, dt);
    l.walk.setEffectiveWeight(l.walkW);
    l.idle.setEffectiveWeight(1 - l.walkW);
    l.walk.timeScale = l.state === 'flee' ? 2.6 * (1 - 0.45 * l.tired) : clamp(speed / 0.55, 1, 2.6);
    // A start's hop (or one for joy, or up at a bubble), a landing's squash.
    const ht = (now - l.hopAt) / 1000, lt = (now - l.landAt) / 1000;
    const hopH = l.hopH || 0.12, hopT = 0.3 * Math.sqrt(hopH / 0.12);
    const lift = ht >= 0 && ht < hopT ? hopH * Math.sin(Math.PI * ht / hopT) : 0;
    const sq = lt >= 0 && lt < 0.16 ? 1 - 0.24 * Math.sin(Math.PI * lt / 0.16) : lt >= 0.16 && lt < 0.42 ? 1 + 0.06 * Math.sin(Math.PI * (lt - 0.16) / 0.26) : 1;
    l.holder.position.copy(l.pos).addScaledVector(Y, lift);
    l.holder.quaternion.setFromAxisAngle(Y, l.heading);
    l.holder.scale.set(S / Math.sqrt(sq), S * sq, S / Math.sqrt(sq));
  }

  const CARRY = 0.75;                       // how high its feet hang over the ground while carried
  function carryPoint(l) {
    // The hood held at the pointer: on the pointer's line, at the height that hangs its feet CARRY over the island
    // below it (the island under its feet, where its shadow falls; over the gap, the last island's height).
    const o = ray(pointer.x, pointer.y);
    const on = (h) => o.clone().addScaledVector(fwd, (h - o.y) / Math.min(fwd.y, -0.05));
    if (l.carryTop === undefined) l.carryTop = l.island.base.y;
    let p = on(l.carryTop + CARRY + H);
    for (let k = 0; k < 2; k++) {
      const t = tileAt(p.x, p.z);
      if (!t || t.top === l.carryTop) break;
      l.carryTop = t.top;
      p = on(l.carryTop + CARRY + H);
    }
    return p;
  }

  function air(l, now, dt) {
    l.holder.scale.setScalar(S);
    const prevY = l.holder.position.y;
    if (l.state === 'held') {
      // Carried over the ground the pointer shows: the hood at a height above the island top under it (or, over
      // the gap, above the last one), so the Linker hangs over the very spot the pointer points at and its shadow
      // falls there; let go, it comes down there.
      const want = carryPoint(l);
      const before = tmp2.copy(l.anchor);
      l.anchor.lerp(want, 1 - Math.exp(-22 * dt));
      l.vel.copy(l.anchor).sub(before).divideScalar(Math.max(dt, 1e-3));
      const accel = tmp.copy(l.vel).sub(l.lastVel).divideScalar(Math.max(dt, 1e-3)).dot(R);
      l.lastVel.copy(l.vel);
      const len = H * 0.6;
      l.swingVel += (-(GRAVITY / len) * Math.sin(l.swing) - clamp(accel, -60, 60) / len * Math.cos(l.swing) - 2.6 * l.swingVel) * dt;
      samples.push({ v: l.vel.clone(), t: now });
      while (samples.length > 8) samples.shift();
    } else {
      if (l.state === 'fall' && now - l.fallAt < 20 && samples.length) {
        // The throw: the hood's speed over the last moment, softened and held to what a hand gives.
        const v = samples.reduce((a, s) => a.add(s.v), new THREE.Vector3()).divideScalar(samples.length).multiplyScalar(0.7);
        if (v.length() > 9) v.setLength(9);
        l.vel.copy(v);
      }
      l.vel.y -= GRAVITY * dt;
      l.anchor.addScaledVector(l.vel, dt);
      l.swingVel *= Math.exp(-0.8 * dt);
      if (l.state === 'drop') { l.swing = 0; l.swingVel = 0; }
    }
    l.swing = clamp(l.swing + l.swingVel * dt, -2.6, 2.6);
    hang.copy(R).multiplyScalar(Math.sin(l.swing)).addScaledVector(Y, -Math.cos(l.swing)).normalize();
    qBody.setFromUnitVectors(tmp.set(0, -1, 0), hang);
    // Held, it turns to face the viewer (its chest's sign in sight), whichever way the view has turned.
    if (l.state === 'held') {
      const toward = Math.atan2(-fwd.x, -fwd.z);
      l.heading += clamp(((toward - l.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI, -dt * 12, dt * 12);
    }
    l.holder.quaternion.copy(qBody).multiply(q.setFromAxisAngle(Y, l.heading));
    l.holder.position.copy(l.anchor).addScaledVector(hang, H);
    const feet = l.holder.position;
    const t = tileAt(feet.x, feet.z);
    if (l.state === 'held') {
      // Held over an island, its feet stay on or above the grass.
      if (t && feet.y < t.top && feet.y > t.top - 0.6) { l.anchor.y += t.top - feet.y; feet.y = t.top; }
      return;
    }
    // Down onto an island's top: on its feet, on that island now.
    if (t && prevY >= t.top - 1e-3 && feet.y <= t.top && l.vel.y < 0) {
      l.pos.set(feet.x, t.top, feet.z);
      if (t.cell.blocked) {
        const free = [...t.island.cells.values()].filter((c) => !c.blocked)
          .sort((a, b) => cellWorld(a, tmp).distanceTo(feet) - cellWorld(b, tmp2).distanceTo(feet))[0];
        if (free) cellWorld(free, l.pos);
      }
      l.island = t.island;
      l.path = []; l.want = null; l.job = null;
      l.state = 'idle'; l.until = now + 900 + Math.random() * 1200;
      l.landAt = now; l.blinkAt = now + 40; l.swing = 0; l.swingVel = 0; l.fleeAt = 0;
      if (t.island.sign && t.island.sign !== l.sign) { l.puzzledAt = now; l.until = now + 2200; }
      tell('land', { right: t.island.sign === l.sign, wrong: !!t.island.sign && t.island.sign !== l.sign });
      count();
      return;
    }
    // Into the clouds: down again from above, on the island it was taken from.
    if (feet.y < -9) {
      const p = spot(l.island, l);
      l.anchor.set(p.x, p.y + 9 + H, p.z);
      l.vel.set(0, 0, 0);
      l.state = 'drop';
    }
  }

  function count() {
    if (PLAY) return;
    const standing = (l) => ['idle', 'walk', 'flee'].includes(l.state);
    let total = 0;
    for (const isl of signIslands) {
      const n = linkers.filter((l) => l.island === isl && l.sign === isl.sign && standing(l)).length;
      const need = LV.signs[isl.sign];
      total += n;
      isl.label.textContent = `${n}/${need}`;
      isl.label.classList.toggle('full', n === need);
      if (n === need && !isl.full) {
        isl.full = true;
        // Full of its own: the island blooms, its flowers coming up in drifts from its middle.
        const later = (x, z) => Math.hypot(x - isl.mid.x, z - isl.mid.z) * 160 + Math.random() * 300;
        for (const [name, x, y, z, scale, yaw, island] of flowerPlan) if (island === isl) plant(name, x, y, z, scale, yaw, 10, island, 0, later(x, z));
        for (const c of isl.cells.values()) {
          if (c.blocked) continue;
          for (let k = 0; k < 3; k++) {
            const x = c.i + (Math.random() - 0.5) * 0.9, z = c.j + (Math.random() - 0.5) * 0.9;
            const kind = clamp(Math.floor(grassNoise(x * 0.7 + isl.base.x, z * 0.7 + isl.base.z, 12.5) * 3.4), 0, 2);
            plant(FLOWERS[kind], x, c.top, z, 2 + Math.random() * 0.8, Math.random() * 6.3, 10, isl, 0, later(x, z));
          }
        }
      }
    }
    ui.count(total, COUNT);
    if (total === COUNT && !bloomed) { bloomed = true; ui.done(LEVEL, LEVELS.length); }
  }

  function pose(l, now) {
    if (l.state === 'held' || l.state === 'fall') {
      const right = tmp.set(-1, 0, 0).applyQuaternion(l.holder.quaternion);
      turnBone(l.bones.Head, q.setFromAxisAngle(right, -0.5));
      const lag = clamp(-l.swingVel * 0.12, -0.5, 0.5);
      for (const n of ['LeftLeg', 'RightLeg']) turnBone(l.bones[n], q.setFromAxisAngle(fwd, lag));
      for (const n of ['LeftArm', 'RightArm']) turnBone(l.bones[n], q.setFromAxisAngle(fwd, lag * 0.2));
      l.blink.value = 0.55;
      return;
    }
    // Set down on another sign's island: the head tilts, puzzled, a moment.
    const pt = (now - l.puzzledAt) / 1000;
    if (pt >= 0 && pt < 2) {
      const tilt = 0.42 * Math.sin(Math.PI * Math.min(1, pt / 0.35) / 2) * (pt > 1.5 ? 1 - (pt - 1.5) / 0.5 : 1);
      turnBone(l.bones.Head, q.setFromAxisAngle(tmp.set(0, 0, 1).applyQuaternion(l.holder.quaternion), tilt));
    }
    // On the ground: a glance at the pointer when it is near, else ahead; blinking.
    if (pointer.here && !held && (l.state === 'idle' || l.state === 'flee') && !(toys && toys.looking(l))) {
      bonesLook(l);
    }
    const bt = now - l.blinkAt;
    if (bt > 170) l.blinkAt = now + 2200 + Math.random() * 3600;
    l.blink.value = bt < 0 || bt > 170 ? 0 : Math.sin(Math.PI * bt / 170) ** 0.6;
  }
  function bonesLook(l) {
    if (!l.scr) return;
    // Toward the pointer as seen on the screen (as the running away judges it).
    const sx = pointer.x - l.scr.x, sy = pointer.y - l.scr.y;
    if (Math.hypot(sx, sy) / pxPerUnit() > 3) return;
    const to = tmp.copy(R).multiplyScalar(sx).addScaledVector(fwdLevel, -sy / Math.max(0.35, Math.sin(look.pitch)));
    const want = Math.atan2(to.x, to.z);
    const turn = clamp(((want - l.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI, -1, 1);
    turnBone(l.bones.Head, q.setFromAxisAngle(Y, turn * 0.8));
  }

  // ---- Running.
  const clock = new THREE.Clock();
  const STEP = 1 / 120;
  let acc = 0;
  reset();
  function tick() {
    step(Math.min(clock.getDelta(), 0.25));
    renderer.render(world, camera);
    requestAnimationFrame(tick);
  }
  function step(dt) {
    const now = nowMs();
    grassUniforms.uTime.value = now / 1000;
    look.yaw = damp(look.yaw, look.tyaw, 12, dt);
    look.pitch = damp(look.pitch, look.tpitch, 12, dt);
    look.zoom = damp(look.zoom, look.tzoom, 10, dt);
    centre.lerp(tcentre, 1 - Math.exp(-12 * dt));
    for (const c of cloudLayers) { c.material.uniforms.uCentre.value.set(centre.x, centre.z); c.material.uniforms.uTime.value = now / 1000; }
    place();
    windDir.lerp(tmp.set(fwd.x, 0, fwd.z).normalize(), 1 - Math.exp(-3 * dt)).normalize();
    for (const isl of islands) {
      if (!isl.move) continue;
      const m = isl.move, len = Math.hypot(...m.dir);
      const s = Math.sin(now / 1000 * Math.PI * 2 / m.period) * m.amp / len;
      const before = tmpV.copy(isl.group.position);
      isl.group.position.set(isl.base.x + m.dir[0] * s, isl.base.y + m.dir[1] * s, isl.base.z + m.dir[2] * s);
      const delta = before.subVectors(isl.group.position, before);
      for (const l of linkers) if (l.island === isl && ['idle', 'walk', 'flee'].includes(l.state)) l.pos.add(delta);
    }
    for (const l of linkers) l.scr = toScreen(l.pos.clone().addScaledVector(Y, H * 0.5));
    if (toys) toys.update(now, dt);
    if (ring) {
      const l = linkers[0];
      const show = !caughtOnce && ['idle', 'walk', 'flee'].includes(l.state);
      ring.visible = show;
      if (show) {
        ring.position.set(l.pos.x, l.pos.y + 0.02, l.pos.z);
        ring.scale.setScalar(1 + 0.08 * Math.sin(now / 420));
        ring.material.opacity = 0.55 + 0.25 * Math.sin(now / 420);
      }
    }
    for (const isl of signIslands) {
      isl.core.position.copy(isl.mid).addScaledVector(Y, 0.08 * Math.sin(now / 900 + isl.spin));
      isl.body.rotation.y = isl.spin + now / 2600;
      isl.glow.material.opacity = isl.full ? 1 : 0.7;
      const p = toScreen(isl.core.getWorldPosition(tmp));
      isl.label.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    }
    acc += dt;
    for (const l of linkers) {
      for (const b in l.rest) l.bones[b].quaternion.copy(l.rest[b]);
      l.mixer.update(dt);
    }
    while (acc >= STEP) {
      for (const l of linkers) {
        if (l.state === 'busy') toys.drive(l, now, STEP);
        else (['idle', 'walk', 'flee'].includes(l.state) ? ground : air)(l, now, STEP);
      }
      acc -= STEP;
    }
    for (const l of linkers) {
      l.model.updateMatrixWorld(true);
      pose(l, now);
      if (toys && l.state !== 'held' && l.state !== 'fall' && l.state !== 'drop') toys.pose(l, now, dt);
    }
    // Each shadow on the ground below its Linker: under its feet as it walks (staying down through a hop); held or
    // falling, on whatever island is below it, smaller and fainter the higher it is; over the gap, none.
    for (const l of linkers) {
      const onGroundNow = ['idle', 'walk', 'flee', 'busy'].includes(l.state);
      const feet = onGroundNow ? l.pos : l.holder.position;
      const t = tileAt(feet.x, feet.z);
      const h = t ? feet.y - t.top : -1;
      const sh = grassUniforms.uShadow.value[linkers.indexOf(l)];
      if (!t || h < -0.05) { l.shade.visible = false; sh.set(9999, -9999, 9999, 0); continue; }
      const high = clamp(h, 0, 6);
      const size = SHADOW_SIZE * (1 - high * 0.07), k = clamp(1 - high / 6, 0.3, 1);
      l.shade.visible = true;
      l.shade.position.set(feet.x, t.top + 0.012, feet.z);
      l.shade.scale.setScalar(size);
      l.shade.material.uniforms.uAlpha.value = k;
      sh.set(feet.x, t.top, feet.z, size * 0.5);
      grassUniforms.uShadowK.value[linkers.indexOf(l)] = k;
    }
    // The grass parts about every Linker on the ground.
    linkers.forEach((l, i) => {
      const p = grassUniforms.uPush.value[i];
      if (['idle', 'walk', 'flee'].includes(l.state)) p.set(l.pos.x, l.pos.y, l.pos.z, 0.38); else p.set(9999, -9999, 9999, 0);
    });
    // Flowers and vines in the wind; new ones coming up.
    const time = now / 1000;
    for (const s of swayers) {
      const gust = 0.75 + 0.18 * Math.sin(time * 0.9 - (s.stem.position.x * windDir.x + s.stem.position.z * windDir.z) * 0.35);
      const a = s.lean * (gust + 0.14 * Math.sin(time * 3.4 + s.phase)) * meadow.wind;
      s.stem.rotation.set(windDir.z * a, 0, -windDir.x * a);
      if (s.grow < 1) { s.grow = smooth((now - s.born) / 900); s.stem.scale.setScalar(Math.max(0.001, s.grow)); }
    }
  }
  requestAnimationFrame(tick);
  ui.again(reset);
  if (PLAY && ui.play) {
    ui.play({
      take(kind, e) { return kind === 'linker' ? addLinker(e) : (toys.spawn(kind, e), true); },
      drop(kind) { return kind === 'linker' ? addLinker(null) : (toys.drop(kind), true); },
    });
    if (ui.linkers) ui.linkers(linkers.length, MAX_LINKERS);
  }
}
