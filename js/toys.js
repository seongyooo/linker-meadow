// The playground (?play): toys dragged out of the tray onto the meadow, and what the Linkers do with them. Nothing
// here hurts anyone: a butterfly to chase, hats to put on, a ball to kick about, bubbles to pop, fruit to share, an
// umbrella to carry, a little rain that brings flowers up, a slide, a swing and a seesaw. Every toy goes in time, or
// sooner (eaten, popped, blown away, rolled off into the clouds).
import * as THREE from 'three';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const damp = (a, b, rate, dt) => b + (a - b) * Math.exp(-rate * dt);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const turnTo = (h, want, max) => h + clamp(((want - h + Math.PI * 3) % (Math.PI * 2)) - Math.PI, -max, max);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const rgb = (h) => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];

export const TOOLS = ['linker', 'butterfly', 'hat', 'ball', 'bubbles', 'fruit', 'umbrella', 'rain', 'slide', 'swing', 'seesaw'];

// Where a toy hangs under the pointer while carried (how high over the ground under it), and how big.
const LIFT = { butterfly: 1.0, hat: 0.7, ball: 0.7, bubbles: 0.9, fruit: 0.7, umbrella: 0.5, rain: 2.3, slide: 1.2, swing: 1.0, seesaw: 0.9 };
const HELD_SIZE = { slide: 0.7, swing: 0.7, seesaw: 0.7, rain: 0.75 };

export function makeToys(ctx) {
  const { world, linkers, tileAt, Y } = ctx;
  const HIP = ctx.HIP;                         // from a Linker's feet to where it sits, sitting
  const GRAVITY = 14;
  const toys = [];
  const t1 = V(), t2 = V(), t3 = V(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  let now = ctx.now();

  // ---- Looks: the game's stylized shading, each colour with its own lighter top and cooler shade.
  const looks = new Map();
  function paint(hex, o = {}) {
    const key = `${hex}|${o.unlit ? 1 : 0}|${o.double ? 1 : 0}`;
    if (!looks.has(key)) {
      const c = rgb(hex);
      const m = ctx.material(o.unlit ? { shader: 'unlit', BaseColor: c } : {
        shader: 'stylized', TopColor: c.map((x) => x + (1 - x) * 0.25), LitColor: c,
        ShadeColor: [c[0] * 0.66, c[1] * 0.68, c[2] * 0.8], EdgeLight: 0.12, Rim: 0.12,
      }, ctx.shared);
      if (o.double) m.side = THREE.DoubleSide;
      looks.set(key, m);
    }
    return looks.get(key);
  }
  const part = (g, hex, o) => new THREE.Mesh(g, paint(hex, o));
  function rod(a, b, r, hex) {
    const d = V().subVectors(b, a);
    const m = part(new THREE.CylinderGeometry(r, r, d.length(), 10), hex);
    m.position.addVectors(a, b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(Y, d.normalize());
    return m;
  }
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

  // ---- Toys: added, faded away, gone.
  function add(kind, obj, o = {}) {
    const t = { kind, obj, born: now, vel: V(), state: 'held', size: 1, gone: false, ...o };
    world.add(obj);
    if (t.shadow) t.shade = ctx.newShade();
    toys.push(t);
    return t;
  }
  function remove(t) {
    if (t.gone) return;
    t.gone = true;
    t.obj.removeFromParent();
    if (t.shade) t.shade.removeFromParent();
    if (t.lines) t.lines.removeFromParent();
    if (t.cells) for (const c of t.cells) { c.blocked = false; c.ride = null; }
    const i = toys.indexOf(t);
    if (i >= 0) toys.splice(i, 1);
  }
  // (Going away: shrinking to nothing over a moment.)
  const fadeOut = (t, ms = 700) => { if (!t.leaving) t.leaving = { at: now, ms }; };
  function shadeUnder(t, size, p = t.obj.getWorldPosition(t3)) {
    if (!t.shade) return;
    const g = tileAt(p.x, p.z);
    const h = g ? p.y - g.top : -1;
    if (!g || h < -0.05) { t.shade.visible = false; return; }
    const k = clamp(1 - h / 5, 0.25, 1);
    t.shade.visible = true;
    t.shade.position.set(p.x, g.top + 0.013, p.z);
    t.shade.scale.setScalar(size * (1 - clamp(h, 0, 5) * 0.06) * (t.obj.scale.x / t.size || 1));
    t.shade.material.uniforms.uAlpha.value = k * (t.shadowK || 0.8);
  }

  // ---- The ground: the island's cells a Linker may stand on.
  const freeCells = () => [...ctx.startIsland.cells.values()].filter((c) => !c.blocked);
  function freeNear(p) {
    let best = null, bd = Infinity;
    for (const c of freeCells()) { const w = ctx.cellWorld(c, t1); const d = flat(w, p); if (d < bd) { bd = d; best = w.clone(); } }
    return best || p.clone();
  }
  function randomPoint(lift = 0) {
    const c = pick(freeCells());
    return ctx.cellWorld(c).add(t1.set(rand(-0.3, 0.3), lift, rand(-0.3, 0.3)));
  }
  const groundAt = (p) => { const g = tileAt(p.x, p.z); return g ? g.top : ctx.startIsland.base.y; };

  // ---- The Linkers: free to take an interest, wanting a toy, busy with one.
  const onFoot = (l) => l.state === 'idle' || l.state === 'walk';
  const free = (l) => onFoot(l) && !l.want && !l.job && !l.perch && now >= (l.cool || 0);
  function nearestFree(p, most, ok = () => true) {
    const g = tileAt(p.x, p.z);
    return linkers.filter((l) => free(l) && ok(l) && (!g || l.island === g.island) && flat(l.pos, p) < most)
      .sort((a, b) => flat(a.pos, p) - flat(b.pos, p));
  }
  function want(l, toy, point, o = {}) {
    l.want = { toy, at: point, near: o.near ?? 0.3, run: !!o.run, until: now + (o.ms ?? 9000), alive: () => !toy.gone && !toy.leaving && (!o.alive || o.alive()), then: o.then || (() => {}), rain: !!o.rain };
    l.path = [];
  }
  const wanting = (toy) => linkers.filter((l) => l.want && l.want.toy === toy).length;
  const act = (l) => l.act || (l.act = { sit: 0, sitT: 0, gazeW: 0, gp: V(), climb: 0, climbW: 0, munch: 0, munchW: 0, kick: 0, sway: 0 });
  function clearAct(l) { const a = act(l); a.sitT = 0; a.climb = 0; a.munch = 0; a.kick = 0; a.sway = 0; l.gazeJob = null; }
  function busy(l, job) { l.state = 'busy'; l.job = { t0: now, ...job }; l.want = null; l.path = []; }
  function done(l, hop = 0) {
    l.job = null; l.state = 'idle'; l.until = now + rand(700, 1600); l.path = [];
    clearAct(l);
    const g = tileAt(l.pos.x, l.pos.z);
    if (!g || g.cell.blocked) l.pos.copy(freeNear(l.pos));
    const h = tileAt(l.pos.x, l.pos.z);
    if (h) { l.island = h.island; l.pos.y = h.top; }
    if (hop) { l.hopAt = now; l.hopH = hop; }
  }
  const hop = (l, h) => { l.hopAt = now; l.hopH = h; };
  // Placing a busy Linker: its feet (where its shadow goes) at pos, its body `drop` lower (sitting), turned to yaw,
  // tipped by tilt (on a swing, a seesaw, down a slide).
  function body(l, pos, yaw, dt, walk = 0, drop = 0, tilt = null) {
    l.pos.copy(pos);
    l.heading = yaw;
    l.holder.position.copy(pos).y -= drop;
    l.holder.quaternion.setFromAxisAngle(Y, yaw);
    if (tilt) l.holder.quaternion.premultiply(tilt);
    l.holder.scale.setScalar(ctx.S);
    l.walkW = damp(l.walkW, walk, 8, dt);
    l.walk.setEffectiveWeight(l.walkW);
    l.idle.setEffectiveWeight(1 - l.walkW);
    l.walk.timeScale = 1.4;
  }
  // A place on the Linker that turns with it: the top of its hood (on the head), the front of its chest (on the
  // body), made the first time one is needed.
  function slot(l, name) {
    l.slots = l.slots || {};
    if (!l.slots[name]) {
      const o = new THREE.Object3D();
      l.holder.updateMatrixWorld(true);
      const local = name === 'hat' ? t1.set(0, l.top, 0) : t1.set(0.11, 0.3, 0.16);
      o.position.copy(l.holder.localToWorld(local));
      o.quaternion.copy(l.holder.quaternion);
      world.add(o);
      (name === 'hat' ? l.bones.Head : l.bones.Body).attach(o);
      l.slots[name] = o;
    }
    return l.slots[name];
  }

  // ---- Carried under the pointer: over the ground under it, a toy's own height above it; let go, thrown as fast
  // as the hand went.
  const carry = { top: undefined };
  function overPointer(lift) {
    const o = ctx.ray(ctx.pointer.x, ctx.pointer.y), f = ctx.fwd;
    const on = (h) => o.clone().addScaledVector(f, (h - o.y) / Math.min(f.y, -0.05));
    if (carry.top === undefined) carry.top = ctx.startIsland.base.y;
    let p = on(carry.top + lift);
    for (let k = 0; k < 2; k++) {
      const g = tileAt(p.x, p.z);
      if (!g || g.top === carry.top) break;
      carry.top = g.top;
      p = on(carry.top + lift);
    }
    return p;
  }
  let held = null;

  // ================================================================ The butterfly.
  const WINGS = [[0xF6D365, 0xF29E4C], [0x9AD0F5, 0x5B8FD6], [0xF7B2C4, 0xE47A9A], [0xFFFFFF, 0xC9C0EC]];
  const wingUp = (() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.bezierCurveTo(0.15, 0.3, 0.95, 0.62, 0.92, 0.12); s.bezierCurveTo(0.9, -0.12, 0.35, -0.08, 0, 0);
    return new THREE.ShapeGeometry(s, 10).rotateX(Math.PI / 2);
  })();
  const wingLo = (() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.bezierCurveTo(0.4, -0.02, 0.75, -0.5, 0.45, -0.68); s.bezierCurveTo(0.22, -0.75, 0.04, -0.35, 0, 0);
    return new THREE.ShapeGeometry(s, 10).rotateX(Math.PI / 2);
  })();
  const bflyBody = new THREE.CylinderGeometry(0.06, 0.04, 0.8, 8).rotateX(Math.PI / 2);
  function makeButterfly() {
    const [a, b] = pick(WINGS);
    const obj = new THREE.Group(), inner = new THREE.Group();
    inner.scale.setScalar(0.13);
    obj.add(inner);
    inner.add(part(bflyBody, 0x4A3B5C));
    const hinges = [1, -1].map((side) => {
      const h = new THREE.Group();
      h.add(part(wingUp, a, { unlit: true, double: true }), part(wingLo, b, { unlit: true, double: true }));
      h.scale.x = side;
      inner.add(h);
      return h;
    });
    return add('butterfly', obj, { hinges, target: V(), life: 42000, nextPerch: now + rand(6000, 10000), phase: rand(0, 6), shadow: true, shadowK: 0.35, lookable: true });
  }
  function aimButterfly(t, dart = 0) {
    const p = t.obj.position;
    if (dart) {
      const away = t1.set(rand(-1, 1), 0, rand(-1, 1)).normalize();
      t.target.copy(p).addScaledVector(away, dart);
      if (!tileAt(t.target.x, t.target.z)) t.target.copy(randomPoint());
      t.dartUntil = now + 900;
    } else {
      t.target.copy(randomPoint());
    }
    t.target.y = groundAt(t.target) + rand(0.5, 1.35);
    t.retarget = now + rand(2500, 4500);
  }
  function leavePerch(t) {
    if (t.on) { t.on.perch = null; t.on.until = now + 400; }
    t.on = null;
    t.state = 'fly';
    aimButterfly(t, 1.5);
    t.nextPerch = now + rand(8000, 13000);
  }
  const perchOk = (l) => l && (onFoot(l) || l.state === 'busy');
  function butterflyFrame(t, dt) {
    const p = t.obj.position;
    if (t.state === 'fly' || t.state === 'toPerch' || t.state === 'leave') {
      if (t.state === 'fly' && (flat(p, t.target) < 0.2 || now > t.retarget)) aimButterfly(t);
      if (t.state === 'toPerch') {
        if (!perchOk(t.on)) leavePerch(t);
        else slot(t.on, 'hat').getWorldPosition(t.target).y += 0.02;
      }
      const speed = t.state === 'leave' ? 1.3 : now < (t.dartUntil || 0) ? 2.1 : t.state === 'toPerch' ? 1.1 : 0.85;
      const to = t1.subVectors(t.target, p), d = to.length();
      if (t.state === 'toPerch' && d < 0.06) {
        t.state = 'perch'; t.until = now + rand(3500, 5500);
      } else {
        to.multiplyScalar(speed / Math.max(d, 1e-3));
        t.vel.lerp(to, 1 - Math.exp(-3 * dt));
        p.addScaledVector(t.vel, dt);
        p.y += Math.sin(now / 160 + t.phase) * 0.004;
        if (t.vel.lengthSq() > 1e-4) t.obj.rotation.y = Math.atan2(t.vel.x, t.vel.z);
      }
      if (t.state === 'fly' && now > t.nextPerch) {
        const l = nearestFree(p, 3.5)[0];
        if (l) { t.state = 'toPerch'; t.on = l; l.perch = t; l.path = []; } else t.nextPerch = now + 2000;
      }
      if (t.state === 'fly' && now - t.born > t.life) {
        t.state = 'leave'; t.leaveAt = now;
        t.target.copy(p).add(t1.set(rand(-2, 2), 6, rand(-2, 2)));
      }
      if (t.state === 'leave' && now - t.leaveAt > 2200) fadeOut(t, 800);
    }
    if (t.state === 'perch') {
      if (!perchOk(t.on) || now > t.until) leavePerch(t);
      else {
        slot(t.on, 'hat').getWorldPosition(p).y += 0.02;
        if (onFoot(t.on)) { t.on.state = 'idle'; t.on.until = now + 600; t.on.path = []; }
        act(t.on).sway = 1;
      }
    }
    const open = t.state === 'perch' ? 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(now / 380)) : 0.2 + 1.2 * (0.5 + 0.5 * Math.sin(now / 42 + t.phase));
    t.hinges.forEach((h, i) => { h.rotation.z = (i ? -1 : 1) * open; });
    shadeUnder(t, 0.16);
  }
  function chaseButterfly(t) {
    if (t.state !== 'fly' || wanting(t) >= 3) return;
    for (const l of nearestFree(t.obj.position, 4.5).slice(0, 2)) {
      if (Math.random() > 0.5) continue;
      want(l, t, () => t.obj.position, {
        near: 0.5, run: true, ms: 6000, alive: () => t.state === 'fly',
        then: (l) => { hop(l, 0.3); l.cool = now + rand(1600, 2800); aimButterfly(t, 2.2); },
      });
    }
  }

  // ================================================================ Hats.
  const HAT = {
    brim: new THREE.CylinderGeometry(0.25, 0.25, 0.014, 40),
    dome: new THREE.SphereGeometry(0.15, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    band: new THREE.CylinderGeometry(0.153, 0.153, 0.036, 28, 1, true),
    cuff: new THREE.CylinderGeometry(0.168, 0.168, 0.06, 28),
    pom: new THREE.SphereGeometry(0.05, 16, 10),
    cone: new THREE.ConeGeometry(0.1, 0.27, 28),
  };
  const HATS = [
    (g) => {   // straw, with a ribbon
      g.add(at(part(HAT.brim, 0xE9C77B), 0, 0.007, 0));
      const d = at(part(HAT.dome, 0xE9C77B), 0, 0.01, 0); d.scale.y = 0.78; g.add(d);
      g.add(at(part(HAT.band, pick([0xE46F5A, 0x5B8FD6, 0x7FB77E]), { double: true }), 0, 0.03, 0));
      return 0.075;
    },
    (g) => {   // a knitted one, with a bobble
      const c = pick([0xE8735F, 0x6FA8DC, 0xF2C94C, 0x9B8BD6]);
      const d = at(part(HAT.dome, c), 0, 0.02, 0); d.scale.set(1.08, 1.1, 1.08); g.add(d);
      g.add(at(part(HAT.cuff, c), 0, 0.03, 0));
      g.add(at(part(HAT.pom, 0xFFF6E0), 0, 0.19, 0));
      return 0.085;
    },
    (g) => {   // a party cone, a little aslant
      const c = new THREE.Group();
      c.add(at(part(HAT.cone, pick([0xF7A6C0, 0x8FD3C1, 0xFFD36E])), 0, 0.135, 0));
      c.add(at(part(HAT.pom, 0xFFF6E0), 0, 0.28, 0));
      c.children[1].scale.setScalar(0.7);
      c.rotation.z = 0.18;
      g.add(c);
      return 0.03;
    },
  ];
  function makeHat() {
    const obj = new THREE.Group();
    const sink = pick(HATS)(obj);
    return add('hat', obj, { sink, shadow: true, shadowK: 0.7 });
  }
  function startDon(l, t) {
    if (t.state !== 'ground' || l.hat) return;
    t.state = 'taken';
    busy(l, { toy: t, from: t.obj.position.clone(), drive: driveDon, cancel: () => { t.state = 'air'; t.vel.set(0, 0, 0); } });
  }
  function driveDon(l, dt) {
    const j = l.job, t = j.toy, k = (now - j.t0) / 750;
    body(l, l.pos, turnTo(l.heading, yawTo(l.pos, j.from), dt * 10), dt);
    l.gazeJob = k < 0.5 ? j.from : null;
    if (k > 0.35) {
      const s = smooth((k - 0.35) / 0.55);
      const to = slot(l, 'hat').getWorldPosition(t2);
      t.obj.position.lerpVectors(j.from, to, s).y += Math.sin(Math.PI * s) * 0.35 - t.sink * s;
      t.obj.rotation.y += dt * 9 * (1 - s);
    }
    if (k >= 1) {
      const s = slot(l, 'hat');
      s.add(t.obj);
      t.obj.position.set(0, -t.sink, 0);
      t.obj.rotation.set(0, 0, 0);
      t.state = 'worn'; t.until = now + 45000; t.on = l; l.hat = t;
      t.shade.visible = false;
      done(l, 0.16);
    }
  }
  function hatOff(t) {
    const l = t.on;
    if (l) l.hat = null;
    t.on = null;
    world.attach(t.obj);
    t.vel.set(rand(-1, 1), 2.6, rand(-1, 1));
    t.spin = rand(-7, 7);
    t.state = 'off';
  }

  // ================================================================ The ball.
  const BALL_R = 0.16;
  const BALL = [0xE8574A, 0xFFF6E0, 0xF4C542, 0xFFF6E0, 0x4C8FD9, 0xFFF6E0];
  function makeBall() {
    const obj = new THREE.Group();
    BALL.forEach((c, k) => obj.add(part(new THREE.SphereGeometry(BALL_R, 5, 14, k * Math.PI / 3, Math.PI / 3), c)));
    return add('ball', obj, { shadow: true, life: 70000, lookable: true });
  }
  const cellKey = (x, z) => `${Math.round(x - ctx.startIsland.base.x)},${Math.round(z - ctx.startIsland.base.z)}`;
  function ballStep(t, h) {
    const p = t.obj.position, prev = t1.copy(p), r = BALL_R;
    t.vel.y -= GRAVITY * 0.75 * h;
    p.addScaledVector(t.vel, h);
    // Walls: a cell up a step (or under a ride) turns it back.
    const g = tileAt(p.x, p.z);
    if (g && (g.cell.blocked || g.top > prev.y - r + 0.12) && cellKey(p.x, p.z) !== cellKey(prev.x, prev.z)) {
      if (Math.round(p.x - ctx.startIsland.base.x) !== Math.round(prev.x - ctx.startIsland.base.x)) { p.x = prev.x; t.vel.x *= -0.55; }
      if (Math.round(p.z - ctx.startIsland.base.z) !== Math.round(prev.z - ctx.startIsland.base.z)) { p.z = prev.z; t.vel.z *= -0.55; }
    }
    const f = tileAt(p.x, p.z);
    t.onGround = false;
    if (f && p.y - r <= f.top && prev.y - r >= f.top - 0.2) {
      p.y = f.top + r;
      if (t.vel.y < -1.2) t.vel.y *= -0.5; else t.vel.y = 0;
      const k = Math.exp(-1.0 * h);
      t.vel.x *= k; t.vel.z *= k;
      t.onGround = true;
    }
    // Linkers in the way.
    for (const l of linkers) {
      if (!(onFoot(l) || l.state === 'flee')) continue;
      const d = flat(l.pos, p);
      if (d > r + 0.17 || d < 1e-4 || Math.abs(p.y - (l.pos.y + 0.2)) > 0.45) continue;
      const n = t2.set(p.x - l.pos.x, 0, p.z - l.pos.z).divideScalar(d);
      p.addScaledVector(n, r + 0.17 - d);
      const vn = t.vel.dot(n);
      if (vn < 0) t.vel.addScaledVector(n, -vn * 1.6);
    }
    // Rolling.
    const sp = Math.hypot(t.vel.x, t.vel.z);
    if (sp > 1e-3) t.obj.quaternion.premultiply(q1.setFromAxisAngle(t2.set(t.vel.z, 0, -t.vel.x).divideScalar(sp), sp * h / r));
    if (p.y < ctx.lowest - 8) remove(t);
  }
  function kickBall(t) {
    if (t.state !== 'loose' || wanting(t) >= 2) return;
    const p = t.obj.position;
    if (p.y - groundAt(p) > 0.6) return;
    for (const l of nearestFree(p, 6).slice(0, 2)) {
      if (Math.random() > 0.45) continue;
      want(l, t, () => p, {
        near: 0.36, run: true, ms: 7000, alive: () => t.state === 'loose',
        then: (l) => {
          const a = yawTo(l.pos, p) + rand(-0.5, 0.5), s = rand(2.2, 3.3);
          t.vel.set(Math.sin(a) * s, rand(1.4, 2.6), Math.cos(a) * s);
          l.heading = a;
          hop(l, 0.1);
          l.cool = now + rand(900, 1800);
          ctx.tell('kick');
        },
      });
    }
  }

  // ================================================================ Bubbles.
  const bubbleLook = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uView: ctx.shared.view, uAlpha: { value: 1 } },
    vertexShader: `varying vec3 vN; void main() { vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uView; uniform float uAlpha; varying vec3 vN;
      void main() {
        vec3 n = normalize(vN);
        float f = 1.0 - abs(dot(n, normalize(uView)));
        vec3 hue = 0.62 + 0.38 * cos(6.2831 * (f * 1.4 + vec3(0.0, 0.33, 0.67)));
        float spec = pow(max(dot(n, normalize(vec3(-0.45, 0.8, 0.4))), 0.0), 36.0);
        gl_FragColor = vec4(mix(vec3(1.0), hue, 0.6) + spec, (0.07 + 0.6 * pow(f, 2.4) + spec * 0.8) * uAlpha);
      }`,
  });
  const bubbleShape = new THREE.SphereGeometry(1, 24, 16);
  function bubbleMesh(r) {
    const m = bubbleLook.clone();
    m.uniforms.uView = ctx.shared.view;
    const b = new THREE.Mesh(bubbleShape, m);
    b.scale.setScalar(r);
    b.renderOrder = 4;
    return b;
  }
  function makeBubbles() {
    const obj = new THREE.Group();
    [[0, 0, 0, 0.09], [0.12, 0.08, 0.03, 0.06], [-0.1, 0.1, -0.02, 0.05]].forEach(([x, y, z, r]) => obj.add(at(bubbleMesh(r), x, y, z)));
    return add('bubbles', obj, { lookable: true });
  }
  function blowBubbles(t) {
    const from = t.obj.position.clone();
    remove(t);
    for (let k = 0; k < 8; k++) {
      const r = rand(0.07, 0.14);
      const obj = new THREE.Group();
      obj.add(bubbleMesh(1));
      obj.position.copy(from).add(t1.set(rand(-0.35, 0.35), rand(-0.15, 0.25), rand(-0.35, 0.35)));
      obj.scale.setScalar(0.01);
      add('bubble', obj, { r, size: r, state: 'float', life: rand(9000, 15000), phase: rand(0, 6), rise: rand(0.12, 0.28), lookable: true, grow: now + k * 90 });
    }
  }
  function pop(t) { if (t.state !== 'pop') { t.state = 'pop'; t.popAt = now; } }
  function bubbleFrame(t, dt) {
    const p = t.obj.position, m = t.obj.children[0].material;
    if (t.state === 'pop') {
      const k = (now - t.popAt) / 140;
      t.obj.scale.setScalar(t.r * (1 + 0.6 * k));
      m.uniforms.uAlpha.value = 1 - k;
      if (k >= 1) remove(t);
      return;
    }
    t.obj.scale.setScalar(t.r * smooth((now - t.grow) / 300));
    p.x += (ctx.windDir.x * 0.12 + Math.sin(now / 900 + t.phase) * 0.08) * dt;
    p.z += (ctx.windDir.z * 0.12 + Math.cos(now / 1100 + t.phase) * 0.08) * dt;
    p.y += (t.rise + Math.sin(now / 500 + t.phase) * 0.06) * dt;
    if (now - t.born > t.life || p.y - groundAt(p) > 3.6) pop(t);
    // Touching a Linker's head (one on the ground hopping for it, or one swung into it by hand): pop.
    for (const l of linkers) {
      l.bones.Head.getWorldPosition(t2).y += 0.12;
      if (t2.distanceTo(p) < t.r + 0.17) { pop(t); if (onFoot(l)) l.blinkAt = now; break; }
    }
  }
  function reachBubble(t) {
    if (t.state !== 'float' || wanting(t)) return;
    const p = t.obj.position;
    const l = nearestFree(p, 1.8, (l) => { const h = p.y - l.pos.y; return h > 0.45 && h < 1.25; })[0];
    if (!l || Math.random() > 0.6) return;
    want(l, t, () => p, { near: 0.22, run: true, ms: 2500, alive: () => t.state === 'float', then: (l) => { hop(l, 0.36); l.cool = now + 700; } });
  }

  // ================================================================ Fruit.
  const FRUIT = new THREE.SphereGeometry(0.11, 20, 14);
  const STEM = new THREE.CylinderGeometry(0.008, 0.011, 0.06, 6);
  const LEAF = new THREE.SphereGeometry(0.04, 10, 6);
  function makeFruit() {
    const obj = new THREE.Group(), inner = new THREE.Group();
    const f = part(FRUIT, pick([0xD9483B, 0xF0C04A, 0x9CC95A, 0xF4A47E]));
    f.scale.set(1, 0.92, 1);
    inner.add(at(f, 0, 0.1, 0));
    inner.add(at(part(STEM, 0x6B4E3D), 0, 0.21, 0));
    const leaf = at(part(LEAF, 0x6FA857), 0.035, 0.215, 0);
    leaf.scale.set(1, 0.25, 0.55); leaf.rotation.z = 0.5;
    inner.add(leaf);
    obj.add(inner);
    return add('fruit', obj, { inner, left: 1, eaters: new Set(), seats: [], shadow: true, shadowK: 0.7, base: rand(0, Math.PI * 2) });
  }
  function seatFruit(t) {
    if (t.state !== 'ground') return;
    const p = t.obj.position;
    for (let s = 0; s < 3; s++) {
      if (t.seats[s]) continue;
      const a = t.base + s * Math.PI * 2 / 3;
      const seat = V(p.x + Math.sin(a) * 0.36, 0, p.z + Math.cos(a) * 0.36);
      const g = tileAt(seat.x, seat.z), f = tileAt(p.x, p.z);
      if (!g || !f || g.cell.blocked || g.island !== f.island || Math.abs(g.top - f.top) > 0.01) continue;
      seat.y = g.top;
      const l = nearestFree(p, 7)[0];
      if (!l || Math.random() > 0.6) return;
      t.seats[s] = l;
      want(l, t, () => seat, {
        near: 0.1, ms: 9000, alive: () => t.state === 'ground',
        then: (l) => {
          if (t.state !== 'ground') return;
          t.eaters.add(l);
          busy(l, { toy: t, seat: s, drive: driveEat, cancel: () => { t.eaters.delete(l); t.seats[s] = null; } });
        },
      });
    }
  }
  function driveEat(l, dt) {
    const t = l.job.toy, a = act(l);
    a.sitT = 1; a.munch = 1;
    l.gazeJob = t.obj.position;
    body(l, l.pos, turnTo(l.heading, yawTo(l.pos, t.obj.position), dt * 8), dt, 0, HIP * a.sit);
  }
  function fruitFrame(t, dt) {
    for (const [s, l] of t.seats.entries()) if (l && !(l.want && l.want.toy === t) && !(l.job && l.job.toy === t)) t.seats[s] = null;
    if (t.state === 'ground' && t.eaters.size) {
      t.left -= dt * 0.075 * t.eaters.size;
      t.inner.scale.setScalar(0.2 + 0.8 * Math.cbrt(Math.max(0, t.left)));
      if (t.left <= 0) {
        for (const l of t.eaters) done(l, 0.2);
        t.eaters.clear();
        remove(t);
      }
    }
  }

  // ================================================================ The umbrella.
  const UMBRELLAS = [[0xF2B33D, 0xFFF6E0], [0xF7A6C0, 0xFFF6E0], [0x8FD3C1, 0xFFF6E0], [0x6FA8DC, 0xFFF6E0]];
  function makeUmbrella() {
    const [a, b] = pick(UMBRELLAS);
    const obj = new THREE.Group();
    obj.add(rod(V(0, 0.02, 0), V(0, 0.72, 0), 0.011, 0x6B4E3D));
    const hook = at(part(new THREE.TorusGeometry(0.035, 0.01, 6, 14, Math.PI), 0x6B4E3D), 0.035, 0.02, 0);
    hook.rotation.z = Math.PI;
    obj.add(hook);
    for (let k = 0; k < 8; k++) {
      const m = part(new THREE.SphereGeometry(0.44, 3, 5, k * Math.PI / 4, Math.PI / 4, 0, 1.12), k % 2 ? b : a, { double: true });
      m.scale.y = 0.6;
      m.position.y = 0.72 - 0.44 * 0.6;
      obj.add(m);
    }
    obj.add(at(part(new THREE.ConeGeometry(0.016, 0.07, 8), 0x6B4E3D), 0, 0.75, 0));
    return add('umbrella', obj, { shadow: true, shadowK: 0.6 });
  }
  function takeUmbrella(t) {
    if (t.state !== 'stand' || wanting(t)) return;
    const l = nearestFree(t.obj.position, 7, (l) => !l.umbrella)[0];
    if (!l) return;
    want(l, t, () => t.obj.position, {
      near: 0.3, alive: () => t.state === 'stand',
      then: (l) => {
        if (t.state !== 'stand' || l.umbrella) return;
        t.state = 'taken';
        busy(l, { toy: t, from: t.obj.position.clone(), fromQ: t.obj.quaternion.clone(), drive: driveTake, cancel: () => { t.state = 'air'; t.vel.set(0, 0, 0); } });
      },
    });
  }
  const UMB_TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.26, 0, 0.14));
  function driveTake(l, dt) {
    const j = l.job, t = j.toy, k = (now - j.t0) / 550;
    body(l, l.pos, turnTo(l.heading, yawTo(l.pos, j.from), dt * 10), dt);
    const s = slot(l, 'umbrella');
    const e = smooth(k);
    t.obj.position.lerpVectors(j.from, s.getWorldPosition(t2), e);
    t.obj.quaternion.slerpQuaternions(j.fromQ, s.getWorldQuaternion(q2).multiply(UMB_TILT), e);
    if (k >= 1) {
      s.add(t.obj);
      t.obj.position.set(0, 0, 0);
      t.obj.quaternion.copy(UMB_TILT);
      t.state = 'carried'; t.until = now + 40000; t.on = l; l.umbrella = t;
      t.shade.visible = false;
      done(l, 0.12);
    }
  }
  function umbrellaAway(t) {
    // A gust takes it: up and off on the wind, turning, away.
    if (t.on) t.on.umbrella = null;
    t.on = null;
    world.attach(t.obj);
    t.vel.set(ctx.windDir.x * 0.9, 1.5, ctx.windDir.z * 0.9);
    t.state = 'gust'; t.gustAt = now; t.lookable = true;
    if (t.shade) t.shade.visible = false;
  }

  // ================================================================ A little rain (a white cloud, not a grey one).
  const cloudLook = ctx.material({ shader: 'stylized', TopColor: [1, 1, 1], LitColor: [0.96, 0.97, 1], ShadeColor: [0.8, 0.86, 0.95], EdgeLight: 0.15, Rim: 0.25 }, ctx.shared);
  const PUFF = new THREE.SphereGeometry(1, 20, 14);
  const DROPS = 90, RAIN_R = 0.55;
  function makeRain() {
    const obj = new THREE.Group();
    for (const [x, y, z, r] of [[0, 0, 0, 0.3], [0.28, -0.05, 0.05, 0.22], [-0.27, -0.05, -0.02, 0.23], [0.1, 0.12, -0.12, 0.22], [-0.09, 0.1, 0.15, 0.2], [0.05, -0.08, 0.22, 0.18], [-0.05, -0.08, -0.22, 0.18]]) {
      const m = at(new THREE.Mesh(PUFF, cloudLook), x, y, z);
      m.scale.setScalar(r);
      obj.add(m);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DROPS * 6), 3));
    const lm = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false });
    lm.color.setRGB(0.86, 0.92, 1, THREE.LinearSRGBColorSpace);
    const lines = new THREE.LineSegments(geo, lm);
    lines.frustumCulled = false;
    world.add(lines);
    const drops = Array.from({ length: DROPS }, () => ({ x: 0, y: -1e4, z: 0, floor: 0 }));
    return add('rain', obj, { lines, drops, shadow: true, shadowK: 0.35, drift: V(rand(-1, 1), 0, rand(-1, 1)).setLength(0.22), lookable: true, sprouted: 0 });
  }
  let sprouts = 0;
  function rainFrame(t, dt) {
    const p = t.obj.position, raining = t.state === 'rain';
    if (raining) {
      p.addScaledVector(t.drift, dt);
      if (!tileAt(p.x + t.drift.x * 2, p.z + t.drift.z * 2)) t.drift.applyAxisAngle(Y, Math.PI * rand(0.6, 1.4));
      p.y = damp(p.y, groundAt(p) + 2.3, 2, dt);
      if (now > t.until) { t.state = 'ending'; fadeOut(t, 1400); }
      // Flowers come up where it rains.
      if (now > (t.nextSprout || 0) && sprouts < 160 && t.sprouted < 26) {
        t.nextSprout = now + 330;
        const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * RAIN_R;
        const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r, g = tileAt(x, z);
        if (g && !g.cell.blocked) {
          const isl = g.island, b = isl.group.position;
          ctx.plant(pick(ctx.FLOWERS), x - b.x, g.cell.top, z - b.z, rand(1.9, 2.6), rand(0, 6.3), 10, isl, 0, 0);
          sprouts++; t.sprouted++;
        }
      }
    }
    // The drops: from the cloud's foot down to the grass (or into the clouds below, off the island).
    const arr = t.lines.geometry.attributes.position.array;
    t.drops.forEach((d, i) => {
      if (d.y < d.floor) {
        if (raining && now > t.born + 300) {
          const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * RAIN_R;
          d.x = p.x + Math.sin(a) * r; d.z = p.z + Math.cos(a) * r;
          d.y = p.y - 0.15 - rand(0, 2.2);
          const g = tileAt(d.x, d.z);
          d.floor = g ? g.top : p.y - 7;
        } else d.y = -1e4;
      }
      d.y -= 5.5 * dt;
      arr.set([d.x, d.y, d.z, d.x, d.y + 0.13, d.z], i * 6);
    });
    t.lines.geometry.attributes.position.needsUpdate = true;
    shadeUnder(t, 1.4);
  }
  // Shelter from it: under an umbrella (standing, or one a friend holds); else out from under it. Those with an
  // umbrella go out into it.
  function rainThink(t) {
    if (t.state !== 'rain') return;
    const c = t.obj.position;
    const umbrellas = toys.filter((u) => u.kind === 'umbrella' && (u.state === 'stand' || u.state === 'carried'));
    for (const l of linkers) {
      if (!onFoot(l) || l.job || l.perch) continue;
      const d = flat(l.pos, c), inRain = d < RAIN_R + 0.2;
      if (l.umbrella) {
        if (!inRain && d < 5 && !l.want && Math.random() < 0.3) {
          const spot = c.clone().add(t1.set(rand(-0.3, 0.3), 0, rand(-0.3, 0.3)));
          want(l, t, () => spot, { near: 0.3, ms: 6000, then: (l) => { l.until = now + 4000; } });
        }
        continue;
      }
      if (!inRain || (l.want && l.want.rain)) continue;
      const u = umbrellas.map((u) => ({ u, w: u.obj.getWorldPosition(V()) })).filter(({ u, w }) => u.on !== l && flat(w, l.pos) < 5)
        .sort((a, b) => flat(a.w, l.pos) - flat(b.w, l.pos))[0];
      if (u) {
        const off = rand(0, Math.PI * 2);
        want(l, t, () => u.u.obj.getWorldPosition(t2).add(t3.set(Math.sin(off) * 0.26, 0, Math.cos(off) * 0.26)), {
          near: 0.18, run: true, rain: true, ms: 6000, alive: () => !u.u.gone && (u.u.state === 'stand' || u.u.state === 'carried'),
          then: (l) => { l.until = now + 3500; },
        });
      } else {
        const dir = t1.set(l.pos.x - c.x, 0, l.pos.z - c.z);
        if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
        for (let k = 0; k < 6; k++) {
          const out = c.clone().addScaledVector(dir.clone().normalize().applyAxisAngle(Y, k * 0.6 * (k % 2 ? 1 : -1)), 1.5);
          if (tileAt(out.x, out.z)) { want(l, t, () => out, { near: 0.25, run: true, rain: true, ms: 4000 }); break; }
        }
      }
    }
  }

  // ================================================================ Rides: a slide, a swing, a seesaw.
  // Each is laid on the island's cells (cells: what it stands on, not walked; access: for each seat, where a Linker
  // comes to it from, the first open one; exits: cells that must be open, where a ride lets them off). Local +z is
  // its run, turned a quarter at a time to lie across the view.
  const RIDES = {
    slide: { cells: [[0, -1], [0, 0], [0, 1]], access: [[[0, -2]], [[0, -2]]], exits: [[0, 2]], run: 'z' },
    swing: { cells: [[0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]], access: [[[-1, 0], [-1, -1], [-1, 1]], [[2, 0], [2, -1], [2, 1]]], run: 'z' },
    seesaw: { cells: [[-1, 0], [0, 0], [1, 0]], access: [[[-2, 0], [-1, -1], [-1, 1]], [[2, 0], [1, -1], [1, 1]]], allSeats: true, run: 'x' },
  };
  const quarter = (i, j, rot) => [[i, j], [j, -i], [-i, -j], [-j, i]][rot & 3];
  function fits(origin, rot, spec) {
    const isl = origin.island;
    const cellAt = ([i, j]) => { const [a, b] = quarter(i, j, rot); return isl.cells.get(`${origin.i + a},${origin.j + b}`); };
    const cells = spec.cells.map(cellAt);
    if (cells.some((c) => !c || c.blocked || c.lvl !== origin.lvl)) return null;
    const open = (c) => c && !c.blocked && Math.abs(c.lvl - origin.lvl) <= 1 && !cells.includes(c);
    const access = spec.access.map((list) => list.map(cellAt).find(open) || null);
    if (access.every((c) => !c) || (spec.allSeats && access.some((c) => !c))) return null;
    const exits = (spec.exits || []).map(cellAt);
    if (exits.some((c) => !open(c))) return null;
    return { cells, access, exits };
  }
  function place(t, near) {
    const spec = RIDES[t.kind];
    const across = (rot) => {
      const a = rot * Math.PI / 2, run = spec.run === 'z' ? t1.set(Math.sin(a), 0, Math.cos(a)) : t1.set(Math.cos(a), 0, -Math.sin(a));
      return Math.abs(run.dot(ctx.R));
    };
    const rots = [0, 1, 2, 3].sort((a, b) => across(b) - across(a));
    const cands = freeCells().sort((a, b) => flat(ctx.cellWorld(a, t1), near) - flat(ctx.cellWorld(b, t2), near)).slice(0, 40);
    for (const c of cands) for (const r of rots) {
      const f = fits(c, r, spec);
      if (f) return settle(t, c, r, f);
    }
    fadeOut(t, 500);
    t.state = 'poof';
  }
  function settle(t, origin, rot, f) {
    for (const c of f.cells) { c.blocked = true; c.ride = t; }
    t.cells = f.cells; t.rot = rot; t.yaw = rot * Math.PI / 2;
    t.access = f.access.map((c) => c && ctx.cellWorld(c).clone());
    t.exit = f.exits[0] && ctx.cellWorld(f.exits[0]).clone();
    t.seats = t.access.map(() => ({ l: null, wanted: null }));
    t.from = t.obj.position.clone(); t.to = ctx.cellWorld(origin).clone();
    t.obj.rotation.y = t.yaw;
    t.state = 'landing'; t.t0 = now; t.until = now + 90000;
    // Whoever stands where it comes down steps aside; every way is planned again.
    for (const l of linkers) {
      const g = tileAt(l.pos.x, l.pos.z);
      if (g && g.cell.ride === t && (onFoot(l) || l.state === 'busy' || l.state === 'flee')) {
        if (l.job) release(l);
        l.state = 'idle';
        l.pos.copy(freeNear(l.pos));
        hop(l, 0.2);
      }
      l.path = [];
    }
  }
  const L = (t, x, y, z, out = t2) => t.obj.localToWorld(out.set(x, y, z));
  function rideThink(t) {
    if (t.state !== 'ready' || now > t.until - 6000) return;
    t.seats.forEach((seat, s) => {
      if (seat.wanted && !(seat.wanted.want && seat.wanted.want.toy === t)) seat.wanted = null;
      if (seat.l || seat.wanted || !t.access[s]) return;
      const l = nearestFree(t.access[s], 8)[0];
      if (!l || Math.random() > 0.3) return;
      seat.wanted = l;
      want(l, t, () => t.access[s], { near: 0.16, ms: 12000, alive: () => t.state === 'ready', then: (l) => board(t, s, l) });
    });
  }
  function board(t, s, l) {
    const seat = t.seats[s];
    if (t.state !== 'ready' || seat.l) return;
    seat.l = l; seat.wanted = null;
    busy(l, { toy: t, seat: s, phase: 'start', p0: now, from: l.pos.clone(), drive: DRIVE[t.kind], cancel: () => { if (seat.l === l) seat.l = null; if (t.kind === 'seesaw') t.rideAt = 0; } });
  }
  const next = (j, phase) => { j.phase = phase; j.p0 = now; };
  const arc = (a, b, s, h, out = t3) => out.lerpVectors(a, b, s).addScaledVector(Y, Math.sin(Math.PI * s) * h);
  function getOff(l, t, to) { l.pos.copy(to); const seat = t.seats[l.job.seat]; if (seat.l === l) seat.l = null; done(l, 0.14); }

  // -- The slide: up the ladder, sit at the top, down the chute, hop off at its foot.
  const chuteAt = (u, out = V()) => out.set(0, 0.06 + 1.0 * (1 - smooth((u - 0.04) / 0.8)), -0.45 + 1.9 * u);
  function chuteGeometry() {
    const prof = [[-0.21, 0.1], [-0.21, -0.03], [0.21, -0.03], [0.21, 0.1], [0.17, 0.1], [0.17, 0.02], [-0.17, 0.02], [-0.17, 0.1]];
    const N = 40, pos = [], idx = [];
    for (let e = 0; e < prof.length; e++) {
      const [ax, ay] = prof[e], [bx, by] = prof[(e + 1) % prof.length];
      const base = pos.length / 3;
      for (let s = 0; s <= N; s++) {
        const u = s / N, c = chuteAt(u), d = chuteAt(Math.min(1, u + 0.01)).sub(chuteAt(Math.max(0, u - 0.01))).normalize();
        const up = V(0, d.z, -d.y);
        for (const [x, y] of [[ax, ay], [bx, by]]) pos.push(c.x + x, c.y + up.y * y, c.z + up.z * y);
        if (s) { const k = base + 2 * (s - 1); idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  const CHUTE = chuteGeometry();
  function makeSlide() {
    const obj = new THREE.Group(), frame = 0x6FA8DC, light = 0xFFF6E0;
    obj.add(part(CHUTE, 0xF2B33D, { double: true }));
    const foot = (x) => V(x, 0, -1.42), top = (x) => V(x, 1.12, -0.7);
    for (const x of [-0.19, 0.19]) {
      obj.add(rod(foot(x), top(x), 0.022, frame));
      obj.add(rod(V(x, 0, -0.5), V(x, 1.03, -0.5), 0.02, frame));
      obj.add(rod(V(x * 0.9, 0, 0.2), V(x * 0.9, chuteAt(0.342).y - 0.02, 0.2), 0.02, frame));
      obj.add(rod(V(x * 1.05, 1.05, -0.5), V(x * 1.05, 1.32, -0.5), 0.018, frame));
      obj.add(at(part(HAT.pom, light), x * 1.05, 1.33, -0.5));
    }
    for (let k = 1; k <= 5; k++) {
      const p = foot(0).lerp(top(0), k / 6);
      obj.add(rod(V(-0.19, p.y, p.z), V(0.19, p.y, p.z), 0.014, light));
    }
    return add('slide', obj, {});
  }
  function driveSlide(l, dt) {
    const j = l.job, t = j.toy, a = act(l), e = (now - j.p0) / 1000;
    const yaw = t.yaw;
    if (j.phase === 'start') {
      // (One at a time down the chute: the next starts up the ladder a moment after.)
      body(l, l.pos, turnTo(l.heading, yaw, dt * 8), dt);
      if (now >= (t.nextStart || 0)) { t.nextStart = now + 1600; next(j, 'walk'); j.from.copy(l.pos); }
      return;
    }
    if (j.phase === 'walk') {
      const s = smooth(e / 0.5);
      body(l, t3.lerpVectors(j.from, L(t, 0, 0, -1.55), s), yaw, dt, 1);
      if (e >= 0.5) next(j, 'climb');
    } else if (j.phase === 'climb') {
      const s = e / 1.5;
      a.climb = 1;
      body(l, t3.lerpVectors(L(t, 0, 0, -1.55, t1), L(t, 0, 1.1, -0.78), Math.min(1, s)), yaw, dt, 0.5);
      if (s >= 1) { next(j, 'sit'); a.climb = 0; }
    } else if (j.phase === 'sit') {
      const s = smooth(e / 0.4);
      a.sitT = 1;
      const seat = chuteAt(0, t1); seat.y += 0.02;
      body(l, t3.lerpVectors(L(t, 0, 1.1, -0.78, t2), L(t, seat.x, seat.y, seat.z, t1), s), yaw, dt, 0, HIP * a.sit);
      if (e >= 0.5) next(j, 'slide');
    } else if (j.phase === 'slide') {
      const u = Math.min(1, e / 1.25), w = 0.3 * u + 0.7 * u * u;
      const c = chuteAt(w, t1), d = chuteAt(Math.min(1, w + 0.02)).sub(chuteAt(Math.max(0, w - 0.02)));
      const pitch = Math.atan2(-d.y, d.z);
      const right = t3.set(Math.cos(yaw), 0, -Math.sin(yaw));
      a.sitT = 1;
      body(l, L(t, c.x, c.y + 0.02, c.z), yaw, dt, 0, HIP, q1.setFromAxisAngle(right, pitch * 0.7));
      if (u >= 1) { next(j, 'off'); j.from.copy(l.pos); }
    } else if (j.phase === 'off') {
      const s = Math.min(1, e / 0.4);
      a.sitT = 0;
      body(l, arc(j.from, t.exit, s, 0.28), yaw, dt, 0, HIP * a.sit);
      if (s >= 1) {
        getOff(l, t, t.exit);
        if (Math.random() < 0.55) want(l, t, () => t.access[0], { near: 0.16, ms: 12000, alive: () => t.state === 'ready' && now < t.until - 6000, then: (l) => board(t, t.seats[0].l ? 1 : 0, l) });
      }
    }
  }

  // -- The swing: two seats; hop on, swing higher, then lower, hop off.
  function makeSwing() {
    const obj = new THREE.Group(), frame = 0xE46F5A;
    for (const x of [-0.47, 1.47]) {
      obj.add(rod(V(x, 0, -0.5), V(x, 1.32, 0), 0.028, frame));
      obj.add(rod(V(x, 0, 0.5), V(x, 1.32, 0), 0.028, frame));
    }
    obj.add(rod(V(-0.53, 1.32, 0), V(1.53, 1.32, 0), 0.032, frame));
    const pivots = [0, 1].map((x) => {
      const p = new THREE.Group();
      p.position.set(x, 1.3, 0);
      for (const cx of [-0.12, 0.12]) p.add(rod(V(cx, 0, 0), V(cx, -0.93, 0), 0.008, 0xB8C0D0));
      p.add(at(part(new THREE.BoxGeometry(0.3, 0.035, 0.17), 0xC98A5B), 0, -0.93, 0));
      obj.add(p);
      return p;
    });
    return add('swing', obj, { pivots });
  }
  function driveSwing(l, dt) {
    const j = l.job, t = j.toy, a = act(l), e = (now - j.p0) / 1000, pv = t.pivots[j.seat];
    const seatAt = (out) => { pv.updateMatrixWorld(); return pv.localToWorld(out.set(0, -0.93 + 0.0175, 0)); };
    const right = t3.set(Math.cos(t.yaw), 0, -Math.sin(t.yaw));
    if (j.phase === 'start') {
      const s = Math.min(1, e / 0.45);
      a.sitT = smooth(s);
      body(l, arc(j.from, seatAt(t1), s, 0.3, t2), t.yaw, dt, 0, HIP * a.sit);
      if (s >= 1) { next(j, 'swing'); j.T = rand(8, 12); j.ph = rand(0, 1); }
    } else if (j.phase === 'swing') {
      const amp = 0.72 * Math.min(1, e / 2.5) * clamp((j.T - e) / 2, 0, 1);
      const ang = amp * Math.sin(Math.PI * 2 * (e / 2.0 + j.ph));
      pv.rotation.x = ang;
      a.sitT = 1; a.kick = 0.45 * Math.cos(Math.PI * 2 * (e / 2.0 + j.ph)) * amp / 0.72;
      body(l, seatAt(t1), t.yaw, dt, 0, HIP, q1.setFromAxisAngle(right, ang));
      if (e >= j.T) { next(j, 'off'); j.from.copy(seatAt(t1)); }
    } else if (j.phase === 'off') {
      const s = Math.min(1, e / 0.45);
      a.sitT = 0; a.kick = 0;
      body(l, arc(j.from, t.access[j.seat], s, 0.3, t2), t.yaw, dt, 0, HIP * a.sit);
      if (s >= 1) getOff(l, t, t.access[j.seat]);
    }
  }

  // -- The seesaw: two of them, one each end, up and down together; alone, one waits a while, then gives up.
  function makeSeesaw() {
    const obj = new THREE.Group();
    obj.add(at(part(new THREE.BoxGeometry(0.16, 0.3, 0.26), 0x7FB77E), 0, 0.15, 0));
    obj.add(rod(V(0, 0.33, -0.16), V(0, 0.33, 0.16), 0.03, 0x6B4E3D));
    const plank = new THREE.Group();
    plank.position.set(0, 0.36, 0);
    plank.add(part(new THREE.BoxGeometry(2.5, 0.05, 0.26), 0xF2B33D));
    for (const x of [-0.9, 0.9]) {
      plank.add(rod(V(x, 0.025, -0.1), V(x, 0.18, -0.1), 0.012, 0xE46F5A));
      plank.add(rod(V(x, 0.025, 0.1), V(x, 0.18, 0.1), 0.012, 0xE46F5A));
      plank.add(rod(V(x, 0.18, -0.12), V(x, 0.18, 0.12), 0.014, 0xE46F5A));
    }
    obj.add(plank);
    return add('seesaw', obj, { plank, rideAt: 0, tilt: 0 });
  }
  const SEESAW_X = [-1.1, 1.1];
  function driveSeesaw(l, dt) {
    const j = l.job, t = j.toy, a = act(l), e = (now - j.p0) / 1000;
    const sx = SEESAW_X[j.seat], yaw = t.yaw + (sx < 0 ? Math.PI / 2 : -Math.PI / 2);
    const seatAt = (out) => { t.plank.updateMatrixWorld(); return t.plank.localToWorld(out.set(sx, 0.025, 0)); };
    const along = t3.set(Math.sin(t.yaw), 0, Math.cos(t.yaw));
    if (j.phase === 'start') {
      const s = Math.min(1, e / 0.45);
      a.sitT = smooth(s);
      body(l, arc(j.from, seatAt(t1), s, 0.3, t2), yaw, dt, 0, HIP * a.sit);
      if (s >= 1) next(j, 'wait');
    } else if (j.phase === 'wait' || j.phase === 'ride') {
      a.sitT = 1;
      const other = t.seats[1 - j.seat].l;
      if (j.phase === 'wait' && other && other.job && other.job.phase === 'wait' && !t.rideAt) {
        t.rideAt = now; t.rideT = rand(8, 11);
        next(j, 'ride'); next(other.job, 'ride');
      }
      if (j.phase === 'wait' && e > 9) { next(j, 'off'); j.from.copy(seatAt(t1)); return; }
      if (j.phase === 'ride' && (!t.rideAt || (now - t.rideAt) / 1000 > t.rideT)) { t.rideAt = 0; next(j, 'off'); j.from.copy(seatAt(t1)); return; }
      a.kick = j.phase === 'ride' ? 0.3 * Math.sin(t.tilt * 6) : 0;
      body(l, seatAt(t1), yaw, dt, 0, HIP, q1.setFromAxisAngle(along, t.tilt));
    } else if (j.phase === 'off') {
      const s = Math.min(1, e / 0.45);
      a.sitT = 0; a.kick = 0;
      body(l, arc(j.from, t.access[j.seat], s, 0.3, t2), yaw, dt, 0, HIP * a.sit);
      if (s >= 1) getOff(l, t, t.access[j.seat]);
    }
  }
  function seesawFrame(t, dt) {
    // Riding: the ends rise and fall in turn; one sitting alone weighs its end down; nobody, level.
    const sat = t.seats.map((s) => s.l && s.l.job && (s.l.job.phase === 'wait' || s.l.job.phase === 'ride'));
    let want = 0;
    if (t.rideAt) {
      const e = (now - t.rideAt) / 1000;
      want = 0.27 * Math.sin(Math.PI * 2 * e / 1.7) * Math.min(1, e / 0.8) * clamp((t.rideT - e) / 0.8, 0, 1);
    } else if (sat[0] && !sat[1]) want = 0.27;
    else if (sat[1] && !sat[0]) want = -0.27;
    t.tilt = t.rideAt ? want : damp(t.tilt, want, 6, dt);
    t.plank.rotation.z = t.tilt;
  }
  function swingFrame(t, dt) {
    t.pivots.forEach((p, s) => { if (!t.seats[s].l || t.seats[s].l.job?.phase !== 'swing') p.rotation.x = damp(p.rotation.x, 0, 1.5, dt); });
  }
  const DRIVE = { slide: driveSlide, swing: driveSwing, seesaw: driveSeesaw };
  function rideFrame(t, dt) {
    if (t.state === 'held' || t.state === 'poof') return;
    if (t.state === 'landing') {
      const k = Math.min(1, (now - t.t0) / 450);
      t.obj.position.lerpVectors(t.from, t.to, smooth(k));
      t.obj.position.y = t.from.y + (t.to.y - t.from.y) * k * k;
      t.obj.scale.setScalar(0.7 + 0.3 * smooth(k));
      if (k >= 1) {
        t.state = 'ready';
        t.obj.position.copy(t.to);
        t.landAt = now;
        ctx.tell('ride');
      }
    }
    if (t.state === 'ready') {
      const lt = (now - t.landAt) / 1000;
      const sq = lt < 0.3 ? 1 - 0.1 * Math.sin(Math.PI * lt / 0.3) : 1;
      t.obj.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
      t.obj.updateMatrixWorld(true);
      if (now > t.until) {
        // Time to go: whoever is on it gets off; it shrinks away and the cells are free again.
        for (const l of linkers) if (l.job && l.job.toy === t) { const to = t.access[l.job.seat] || t.exit; l.pos.copy(to); release(l); done(l, 0.14); }
        t.state = 'going';
        fadeOut(t, 700);
      }
    }
    if (t.kind === 'seesaw') seesawFrame(t, dt);
    if (t.kind === 'swing') swingFrame(t, dt);
  }

  // ================================================================ Making, carrying, letting go.
  const MAKE = { butterfly: makeButterfly, hat: makeHat, ball: makeBall, bubbles: makeBubbles, fruit: makeFruit, umbrella: makeUmbrella, rain: makeRain, slide: makeSlide, swing: makeSwing, seesaw: makeSeesaw };
  function spawn(kind, e) {
    now = ctx.now();
    if (held) letGo({ pointerId: held.id, clientX: ctx.pointer.x, clientY: ctx.pointer.y, dropHere: true });
    const t = MAKE[kind]();
    t.size = 1;
    t.obj.scale.setScalar(HELD_SIZE[kind] || 1);
    Object.assign(ctx.pointer, { x: e.clientX, y: e.clientY, at: now, here: true });
    carry.top = undefined;
    t.obj.position.copy(overPointer(LIFT[kind]));
    held = { toy: t, id: e.pointerId, samples: [] };
  }
  function drop(kind) {
    now = ctx.now();
    const t = MAKE[kind]();
    t.size = 1;
    t.obj.scale.setScalar(HELD_SIZE[kind] || 1);
    t.obj.position.copy(randomPoint(LIFT[kind] + (['hat', 'ball', 'fruit', 'umbrella'].includes(kind) ? 1.5 : 0)));
    freeToy(t, false);
  }
  function freeToy(t, thrown) {
    const p = t.obj.position;
    ctx.tell('toy', { kind: t.kind });
    switch (t.kind) {
      case 'butterfly': t.state = 'fly'; aimButterfly(t); break;
      case 'bubbles': blowBubbles(t); break;
      case 'rain': t.state = 'rain'; t.until = now + 15000; t.obj.scale.setScalar(1); break;
      case 'slide': case 'swing': case 'seesaw': place(t, p.clone()); break;
      case 'ball': t.state = 'loose'; break;
      default: t.state = 'air'; t.obj.scale.setScalar(1);
    }
    if (!thrown) t.vel.set(0, 0, 0);
  }
  function letGo(e) {
    if (!held || e.pointerId !== held.id) return;
    const t = held.toy, s = held.samples;
    held = null;
    document.documentElement.style.cursor = '';
    // Let go over the tray itself (only a press, no drag), it goes somewhere on the island.
    const under = e.dropHere ? null : document.elementFromPoint(e.clientX, e.clientY);
    if (under && under.closest && under.closest('.tray')) {
      t.obj.position.copy(randomPoint(LIFT[t.kind] + (['hat', 'ball', 'fruit', 'umbrella'].includes(t.kind) ? 1.5 : 0)));
      freeToy(t, false);
      return;
    }
    const v = s.length ? s.reduce((a, x) => a.add(x), V()).divideScalar(s.length).multiplyScalar(0.7) : V();
    if (v.length() > 9) v.setLength(9);
    t.vel.copy(v);
    freeToy(t, true);
  }
  addEventListener('pointerup', letGo);
  addEventListener('pointercancel', letGo);
  // Catching a toy already out (the ball, a hat or fruit or an umbrella lying about); bubbles pop at a touch, a
  // butterfly flits off.
  function grab(e) {
    now = ctx.now();
    const px = ctx.pxPerUnit();
    let best = null, bd = Infinity;
    for (const t of toys) {
      if (t.gone || t.leaving) continue;
      const okKind = (t.kind === 'bubble' && t.state === 'float') || (t.kind === 'butterfly' && t.state === 'fly')
        || (['ball'].includes(t.kind) && t.state === 'loose') || (['hat', 'fruit', 'umbrella'].includes(t.kind) && ['ground', 'stand', 'air'].includes(t.state));
      if (!okKind) continue;
      const s = ctx.toScreen(t.obj.getWorldPosition(t1).add(t2.set(0, t.kind === 'umbrella' ? 0.4 : 0.08, 0)));
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY), reach = Math.max(22, (t.kind === 'umbrella' ? 0.45 : 0.25) * px);
      if (d < reach && d < bd) { best = t; bd = d; }
    }
    if (!best) return false;
    if (best.kind === 'bubble') { pop(best); return true; }
    if (best.kind === 'butterfly') { aimButterfly(best, 2); return true; }
    if (best.kind === 'fruit') { for (const l of best.eaters) done(l); best.eaters.clear(); best.seats = []; }
    for (const l of linkers) if (l.want && l.want.toy === best) { l.want = null; l.path = []; }
    best.state = 'held';
    best.obj.quaternion.identity();
    carry.top = undefined;
    held = { toy: best, id: e.pointerId, samples: [] };
    document.documentElement.style.cursor = 'grabbing';
    return true;
  }
  function release(l) {
    l.want = null;
    if (l.job) { l.job.cancel?.(); l.job = null; }
    if (l.perch) leavePerch(l.perch);
    clearAct(l);
  }

  // ================================================================ Each frame.
  let lastThink = 0;
  function update(nowMs, dt) {
    now = nowMs;
    if (now - lastThink > 200) {
      lastThink = now;
      for (const t of [...toys]) {
        if (t.gone || t.leaving) continue;
        if (t.kind === 'butterfly') chaseButterfly(t);
        else if (t.kind === 'hat' && t.state === 'ground' && !wanting(t)) {
          const l = nearestFree(t.obj.position, 7, (l) => !l.hat)[0];
          if (l) want(l, t, () => t.obj.position, { near: 0.3, alive: () => t.state === 'ground', then: (l) => startDon(l, t) });
        } else if (t.kind === 'ball') kickBall(t);
        else if (t.kind === 'bubble') reachBubble(t);
        else if (t.kind === 'fruit') seatFruit(t);
        else if (t.kind === 'umbrella') takeUmbrella(t);
        else if (t.kind === 'rain') rainThink(t);
        else if (RIDES[t.kind]) rideThink(t);
      }
    }
    // Held: under the pointer, its speed kept for the throw.
    if (held) {
      const t = held.toy, before = t1.copy(t.obj.position);
      t.obj.position.lerp(overPointer(LIFT[t.kind]), 1 - Math.exp(-22 * dt));
      held.samples.push(V().subVectors(t.obj.position, before).divideScalar(Math.max(dt, 1e-3)));
      while (held.samples.length > 8) held.samples.shift();
      if (t.kind === 'hat' || t.kind === 'fruit') t.obj.rotation.y += dt * 1.5;
    }
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    for (const t of [...toys]) {
      if (t.gone) continue;
      if (t.leaving) {
        const k = (now - t.leaving.at) / t.leaving.ms;
        t.obj.scale.setScalar(t.size * (1 - smooth(k)));
        if (t.lines) t.lines.material.opacity = 0.85 * (1 - k);
        if (k >= 1) { remove(t); continue; }
      }
      switch (t.kind) {
        case 'butterfly': if (t.state !== 'held') butterflyFrame(t, dt); else t.hinges.forEach((g, i) => { g.rotation.z = (i ? -1 : 1) * (0.2 + 1.2 * (0.5 + 0.5 * Math.sin(now / 42))); }); break;
        case 'bubble': bubbleFrame(t, dt); break;
        case 'rain': if (t.state !== 'held') rainFrame(t, dt); break;
        case 'ball':
          if (t.state === 'loose') {
            for (let k = 0; k < n && !t.gone; k++) ballStep(t, h);
            if (!t.leaving && now - t.born > t.life) fadeOut(t, 900);
          }
          if (!t.gone) shadeUnder(t, 0.36);
          break;
        case 'hat': case 'fruit': case 'umbrella': {
          const p = t.obj.position;
          if (t.state === 'air' || t.state === 'off') {
            for (let k = 0; k < n; k++) {
              const prevY = p.y;
              t.vel.y -= GRAVITY * h;
              p.addScaledVector(t.vel, h);
              if (t.state === 'off') t.obj.rotation.x += t.spin * h;
              const g = tileAt(p.x, p.z);
              if (g && prevY >= g.top - 0.02 && p.y <= g.top) {
                p.y = g.top;
                t.vel.set(0, 0, 0);
                if (g.cell.blocked) p.copy(freeNear(p));
                if (t.state === 'off') { t.state = 'dropped'; fadeOut(t, 900); }
                else if (t.kind === 'umbrella') { t.state = 'stand'; t.obj.quaternion.setFromEuler(new THREE.Euler(rand(-0.08, 0.08), rand(0, 6), rand(-0.08, 0.08))); p.y -= 0.06; t.until = now + 35000; }
                else { t.state = 'ground'; t.obj.rotation.set(0, t.obj.rotation.y, 0); t.until = now + (t.kind === 'hat' ? 30000 : 45000); }
                break;
              }
              if (p.y < ctx.lowest - 8) { remove(t); break; }
            }
          }
          if ((t.state === 'ground' || t.state === 'stand') && now > t.until) fadeOut(t);
          if (t.kind === 'hat' && t.state === 'worn' && (now > t.until || !t.on)) hatOff(t);
          if (t.kind === 'umbrella' && t.state === 'carried' && now > t.until) umbrellaAway(t);
          if (t.kind === 'umbrella' && t.state === 'gust') {
            t.vel.y = damp(t.vel.y, 0.9, 1, dt);
            p.addScaledVector(t.vel, dt);
            t.obj.rotation.y += dt * 2.5; t.obj.rotation.z = 0.4 * Math.sin(now / 400);
            if (now - t.gustAt > 3000) fadeOut(t, 900);
          }
          if (t.kind === 'fruit') fruitFrame(t, dt);
          if (!t.gone && t.state !== 'worn' && t.state !== 'carried' && t.state !== 'gust') shadeUnder(t, t.kind === 'umbrella' ? 0.9 : 0.34);
          break;
        }
        default: if (RIDES[t.kind]) rideFrame(t, dt);
      }
    }
    // Where each Linker looks: at what flies or floats or rolls nearby (or what is carried over it), the nearest.
    for (const l of linkers) {
      l.gaze = null;
      if (!(onFoot(l) || l.state === 'busy' || l.state === 'flee')) continue;
      if (l.gazeJob) { l.gaze = l.gazeJob; continue; }
      let best = null, bd = Infinity;
      for (const t of toys) {
        if (t.gone || !(t.lookable || t.state === 'held') || t.on === l) continue;
        if (t.kind === 'ball' && t.vel.lengthSq() < 0.3) continue;
        const p = t.obj.getWorldPosition(t1);
        const d = flat(p, l.pos), range = t.kind === 'rain' ? 2.8 : t.state === 'gust' ? 7 : 3.2;
        if (d < range && d < bd) { bd = d; best = p.clone(); }
      }
      l.gaze = best;
    }
  }
  function drive(l, nowMs, dt) {
    now = nowMs;
    if (l.job) l.job.drive(l, dt); else done(l);
  }
  // The body for what it does: sitting (legs forward), climbing (legs in turn), kicking on a swing, eating (the head
  // nodding), looking at something (the head turned to it, as far as a head turns), a butterfly on its head (a slow
  // happy sway).
  function pose(l, nowMs, dt) {
    now = nowMs;
    const a = act(l);
    if (l.gaze) a.gp.copy(l.gaze);
    a.gazeW = damp(a.gazeW, l.gaze ? 1 : 0, 6, dt);
    a.sit = damp(a.sit, a.sitT, 10, dt);
    a.climbW = damp(a.climbW, a.climb, 10, dt);
    a.munchW = damp(a.munchW, a.munch, 8, dt);
    const right = t1.set(1, 0, 0).applyQuaternion(l.holder.quaternion).normalize();
    if (a.sit > 0.01 || a.climbW > 0.01 || a.kick) {
      const legs = a.sit * 1.3 + a.kick;
      const step = a.climbW * 0.55 * Math.sin(now / 120);
      ctx.turnBone(l.bones.LeftLeg, q1.setFromAxisAngle(right, -(legs + step)));
      ctx.turnBone(l.bones.RightLeg, q1.setFromAxisAngle(right, -(legs - step)));
    }
    if (a.gazeW > 0.01) {
      const head = l.bones.Head.getWorldPosition(t2);
      const to = t3.copy(a.gp).sub(head).normalize();
      const facing = V(0, 0, 1).applyQuaternion(l.holder.quaternion).normalize();
      q1.setFromUnitVectors(facing, to);
      const ang = 2 * Math.acos(clamp(q1.w, -1, 1));
      q2.identity().slerp(q1, a.gazeW * Math.min(1, 1.0 / Math.max(ang, 1e-3)) * 0.85);
      ctx.turnBone(l.bones.Head, q2);
    }
    if (a.munchW > 0.01) ctx.turnBone(l.bones.Head, q1.setFromAxisAngle(right, a.munchW * (0.1 + 0.09 * Math.sin(now / 85))));
    if (a.sway) {
      const fwd = V(0, 0, 1).applyQuaternion(l.holder.quaternion);
      ctx.turnBone(l.bones.Head, q1.setFromAxisAngle(fwd, 0.16 * Math.sin(now / 500)));
      a.sway = 0;
    }
  }

  return { list: toys, spawn, drop, grab, update, drive, pose, release, looking: (l) => !!(l.act && l.act.gazeW > 0.3) };
}
