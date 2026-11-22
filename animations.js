// animations.js
// The five supplied GLB characters share one 80-bone "Bip01" skeleton but contain NO animation clips.
// This module generates real THREE.AnimationClips (quaternion + root-position tracks) for that skeleton,
// so they can be driven by a normal THREE.AnimationMixer.
//
// Why the maths looks the way it does: Bip01 bones have unusual local axes, so we never rotate in
// bone-local space. Every pose is described as a *world-space* rotation (model faces +Z, up is +Y,
// character-left is +X) and converted into each bone's local quaternion using the bind pose.
import * as THREE from 'three';

const { Quaternion, Vector3 } = THREE;
const TAU = Math.PI * 2;
const AX = { S: new Vector3(1, 0, 0), U: new Vector3(0, 1, 0), F: new Vector3(0, 0, 1) };
const ID = new Quaternion();

const rot = (ax, a) => new Quaternion().setFromAxisAngle(ax, a);
const pitch = (a) => rot(AX.S, a);   // +: spine leans forward, hanging limb swings back, foot toe-down
const fwd = (a) => rot(AX.S, -a);    // +: hanging limb swings forward
const roll = (a) => rot(AX.F, a);    // +: left limb goes outward
const yaw = (a) => rot(AX.U, a);     // +: turn towards character's left
const mul = (...qs) => qs.reduce((a, b) => a.clone().multiply(b));
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sstep = (a, b, t) => { const x = clamp01((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;

export const MAIN_BONES = ['Root', 'Pelvis', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'L_Clavicle', 'L_UpperArm', 'L_Forearm', 'L_Hand', 'R_Clavicle', 'R_UpperArm', 'R_Forearm', 'R_Hand',
  'L_Thigh', 'L_Calf', 'L_Foot', 'L_Toe0', 'R_Thigh', 'R_Calf', 'R_Foot', 'R_Toe0'];

export const boneKey = (name) => (name === 'Bip01' ? 'Root' : name.replace(/ /g, '_').replace(/^Bip01_/, ''));

// ---------- rig extraction ----------
export function buildRig(root) {
  root.updateMatrixWorld(true);
  const list = [];
  root.traverse((o) => {
    if (!o.isBone) return;
    list.push({
      key: boneKey(o.name), name: o.name,
      parentKey: o.parent && o.parent.isBone ? boneKey(o.parent.name) : null,
      q0: o.quaternion.clone(), Qw: o.getWorldQuaternion(new Quaternion()), pos: o.position.clone(),
    });
  });
  return rigFromList(list);
}

// list must be parent-first. Exposed separately so the maths can be unit-tested without a scene graph.
export function rigFromList(list) {
  const rig = { list: [], parent: {}, Qw: {}, q0: {}, nodeName: {}, rootPos: new Vector3() };
  for (const b of list) {
    if (!MAIN_BONES.includes(b.key)) continue;
    rig.list.push(b.key); rig.parent[b.key] = b.parentKey; rig.Qw[b.key] = b.Qw; rig.q0[b.key] = b.q0;
    rig.nodeName[b.key] = b.name;
    if (b.key === 'Root') rig.rootPos.copy(b.pos);
  }
  const missing = MAIN_BONES.filter((k) => !rig.list.includes(k));
  if (missing.length) throw new Error('Skeleton is missing bones: ' + missing.join(', '));
  return rig;
}

// Convert per-bone *world-frame delta rotations* (applied after the parent's) into local quaternions.
export function solve(rig, rel) {
  const C = {}, out = {};
  for (const k of rig.list) {
    const p = rig.parent[k] && C[rig.parent[k]] ? rig.parent[k] : null;
    const Cp = p ? C[p] : ID;
    const Qp = p ? rig.Qw[p] : ID;
    const Ck = (rel[k] || ID).clone().multiply(Cp);
    C[k] = Ck;
    out[k] = Qp.clone().invert().multiply(Cp.clone().invert()).multiply(Ck).multiply(rig.Qw[k]);
  }
  return out;
}

// ---------- pose helpers ----------
const LEG_UP = 0.399, LEG_LO = 0.397, HIP_TO_ANKLE = LEG_UP + LEG_LO;
const ARM_BASE = 0.66; // bind pose has arms ~46 degrees out; this brings them to hang at the sides

class Pose {
  constructor() { this.rel = {}; this.x = 0; this.y = 0; this.z = 0; this.ext = []; this.ground = true; }
  r(key, ...qs) { const q = mul(...qs); this.rel[key] = this.rel[key] ? mul(q, this.rel[key]) : q; return this; }
}

function arm(p, side, a = {}) {
  const s = side === 'L' ? 1 : -1;
  p.r(side + '_UpperArm', fwd(a.f || 0), roll(-s * (ARM_BASE - (a.out || 0))));
  p.r(side + '_Forearm', fwd(a.flex ?? 0.2));
}
function leg(p, side, a = {}) {
  const s = side === 'L' ? 1 : -1;
  const t = a.t || 0, k = a.k || 0;
  p.r(side + '_Thigh', fwd(t), roll(s * (a.out || 0)));
  p.r(side + '_Calf', pitch(k));
  p.r(side + '_Foot', pitch(t - k + (a.toe || 0)));       // keeps the sole level with the ground
  p.ext.push(LEG_UP * Math.cos(t) + LEG_LO * Math.cos(t - k));
}
function torso(p, { lean = 0, twist = 0, head = 0, headYaw = 0 } = {}) {
  p.r('Spine', pitch(lean * 0.4), yaw(twist * 0.25));
  p.r('Spine1', pitch(lean * 0.3), yaw(twist * 0.35));
  p.r('Spine2', pitch(lean * 0.3), yaw(twist * 0.4));
  p.r('Neck', pitch(-lean * 0.35 + head * 0.5), yaw(headYaw * 0.5));
  p.r('Head', pitch(-lean * 0.4 + head * 0.5), yaw(headYaw * 0.5));
}

// Fighting stance with per-limb overrides
function stance(p, o = {}) {
  leg(p, 'L', { t: 0.35, k: 0.4, out: 0.1, ...o.legL });
  leg(p, 'R', { t: -0.2, k: 0.3, out: 0.12, ...o.legR });
  arm(p, 'L', { f: 0.55, flex: 1.9, out: -0.25, ...o.armL });
  arm(p, 'R', { f: 0.45, flex: 2.0, out: -0.3, ...o.armR });
  torso(p, { lean: 0.12, twist: 0, head: -0.1, ...o.torso });
  p.r('Pelvis', yaw(-0.3 + (o.pelvisYaw || 0)));
}

// ---------- clip definitions (each returns a Pose for normalised time t in [0,1]) ----------
const LOCO = {
  walk: { dur: 0.95, hip: 0.0, stride: 0.42, k0: 0.06, k1: 0.75, toe: 0.5, arm0: 0.05, arm: 0.45, e0: 0.25, e1: 0.25, lean: 0.04, twist: 1, hop: 0 },
  run: { dur: 0.64, hip: 0.1, stride: 0.85, k0: 0.25, k1: 1.4, toe: 0.6, arm0: 0.1, arm: 0.95, e0: 1.45, e1: 0.4, lean: 0.2, twist: 1.5, hop: 0.05 },
};
function loco(o, t) {
  const p = new Pose(), ph = t * TAU;
  for (const side of ['L', 'R']) {
    const q = ph + (side === 'R' ? Math.PI : 0), s = Math.sin(q);
    leg(p, side, { t: o.hip + o.stride * s, k: o.k0 + o.k1 * Math.max(0, Math.cos(q - 0.5)), toe: o.toe * Math.max(0, -s) });
    const as = (side === 'L' ? -1 : 1) * Math.sin(ph);
    arm(p, side, { f: o.arm0 + o.arm * as, flex: o.e0 + o.e1 * Math.max(0, as), out: 0.04 });
  }
  torso(p, { lean: o.lean, twist: o.twist * 0.3 * Math.sin(ph) });
  p.r('Pelvis', yaw(-o.twist * 0.15 * Math.sin(ph)), roll(0.03 * Math.sin(ph)));
  p.hopLift = o.hop * (1 - Math.cos(2 * ph)) / 2;
  return p;
}

function idle(t) {
  const p = new Pose(), ph = t * TAU, b = Math.sin(ph);
  leg(p, 'L', { t: 0.02, k: 0.04, out: 0.03 }); leg(p, 'R', { t: 0.0, k: 0.03, out: 0.03 });
  arm(p, 'L', { f: 0.04 + 0.02 * b, flex: 0.22 + 0.03 * b, out: 0.03 });
  arm(p, 'R', { f: 0.03 - 0.02 * b, flex: 0.2 - 0.03 * b, out: 0.03 });
  torso(p, { lean: 0.01 + 0.012 * b, head: 0.02 * Math.sin(ph + 1), headYaw: 0.06 * Math.sin(ph * 0.5 + 0.3) });
  p.r('Pelvis', roll(0.015 * Math.sin(ph)));
  return p;
}

function guard(t) {
  const p = new Pose(), b = Math.sin(t * TAU * 2);
  stance(p, { armL: { f: 0.55 + 0.03 * b }, armR: { f: 0.45 - 0.03 * b }, torso: { lean: 0.12 + 0.015 * b } });
  return p;
}

function jump(t) {
  const p = new Pose(), f = Math.sin(t * TAU);
  leg(p, 'L', { t: 0.75 + 0.05 * f, k: 1.1, out: 0.05 }); leg(p, 'R', { t: -0.15, k: 0.7 + 0.05 * f, out: 0.05 });
  arm(p, 'L', { f: 0.7, flex: 0.5, out: 0.8 + 0.1 * f }); arm(p, 'R', { f: 0.7, flex: 0.5, out: 0.8 - 0.1 * f });
  torso(p, { lean: 0.08 });
  p.ground = false;
  return p;
}

const punchEnv = (t, a, b, c) => ({ w: sstep(0, a, t) - sstep(a, b, t), e: sstep(a, b, t) - sstep(c, 1, t) });
function punch(side, heavy, t) {
  const p = new Pose();
  const { w, e } = heavy ? punchEnv(t, 0.4, 0.55, 0.7) : punchEnv(t, 0.22, 0.4, 0.55);
  const k = heavy ? 1.5 : 1, s = side === 'L' ? 1 : -1;
  const hit = { f: lerp(0.45, 1.5, e) - 0.4 * w * k, flex: 1.9 - 2.3 * e + 0.5 * w * k, out: -0.3 + 0.28 * e };
  const twist = -s * (0.55 * k * e - 0.35 * k * w);
  stance(p, {
    [side === 'L' ? 'armL' : 'armR']: hit,
    legL: { t: 0.35 + 0.25 * e * (side === 'L' ? 1 : 0.6), k: 0.4 + 0.15 * e },
    legR: { t: -0.2 - 0.1 * e, k: 0.3 - 0.1 * e },
    torso: { lean: 0.12 + 0.16 * e * k - 0.05 * w, twist },
    pelvisYaw: twist * 0.5,
  });
  return p;
}

function kick(t) {
  const p = new Pose();
  const { w, e } = punchEnv(t, 0.35, 0.5, 0.66);
  stance(p, {
    legL: { t: 0.1, k: 0.35 + 0.15 * (w + e), out: 0.08 },
    legR: { t: 0.2 + 0.75 * w + 1.25 * e, k: 0.3 + 1.3 * w - 0.2 * e, out: 0.1, toe: 0.45 * e },
    armL: { f: 0.45, flex: 1.5, out: -0.1 + 0.45 * e }, armR: { f: 0.45, flex: 1.5, out: -0.1 + 0.45 * e },
    torso: { lean: 0.05 * w - 0.22 * e, twist: 0.3 * e },
    pelvisYaw: 0.35 * e,
  });
  return p;
}

function block(t) {
  const p = new Pose(), b = Math.sin(t * TAU * 3);
  stance(p, {
    armL: { f: 1.0, flex: 2.35 + 0.03 * b, out: -0.45 }, armR: { f: 1.0, flex: 2.35 - 0.03 * b, out: -0.45 },
    legL: { t: 0.5, k: 0.6 }, legR: { t: -0.25, k: 0.55 }, torso: { lean: 0.2, head: -0.05 },
  });
  return p;
}

function dodge(t) {
  const p = new Pose(), h = Math.sin(Math.PI * t);
  stance(p, { legL: { t: 0.35 + 0.3 * h, k: 0.4 + 0.7 * h }, legR: { t: -0.2 + 0.3 * h, k: 0.3 + 0.8 * h },
    torso: { lean: 0.12 - 0.45 * h, head: -0.1 }, armL: { f: 0.55, flex: 1.9 }, armR: { f: 0.45, flex: 2.0 } });
  return p;
}

function hit(t) {
  const p = new Pose(), h = t < 0.2 ? t / 0.2 : 1 - sstep(0.2, 1, t);
  leg(p, 'L', { t: 0.15 * h, k: 0.2 * h, out: 0.05 }); leg(p, 'R', { t: -0.2 * h, k: 0.2 * h, out: 0.05 });
  arm(p, 'L', { f: -0.35 * h, flex: 0.5 + 0.5 * h, out: 0.4 * h }); arm(p, 'R', { f: -0.35 * h, flex: 0.5 + 0.5 * h, out: 0.4 * h });
  torso(p, { lean: -0.4 * h, head: -0.5 * h, twist: 0.2 * h });
  return p;
}

function ko(t) {
  const p = new Pose(), s = sstep(0.05, 0.75, t);
  p.r('Root', pitch(-Math.PI / 2 * s));
  leg(p, 'L', { t: 0.1 * s, k: 0.2 * s, out: 0.2 * s }); leg(p, 'R', { t: 0.0, k: 0.1 * s, out: 0.3 * s });
  arm(p, 'L', { f: 0, flex: 0.3, out: 0.5 * s }); arm(p, 'R', { f: 0, flex: 0.3, out: 0.6 * s });
  p.y = -0.74 * s; p.z = -0.05 * s; p.ground = false;
  return p;
}

function talk(t) {
  const p = new Pose(), ph = t * TAU;
  leg(p, 'L', { t: 0.03, k: 0.05, out: 0.04 }); leg(p, 'R', { t: -0.02, k: 0.03, out: 0.05 });
  arm(p, 'R', { f: 0.55 + 0.2 * Math.sin(2 * ph), flex: 1.5 + 0.35 * Math.sin(3 * ph), out: 0.15 });
  arm(p, 'L', { f: 0.3 + 0.1 * Math.sin(ph + 1), flex: 1.2 + 0.2 * Math.sin(2 * ph + 1), out: 0.1 });
  torso(p, { lean: 0.02, twist: 0.08 * Math.sin(ph), head: 0.07 * Math.sin(3 * ph), headYaw: 0.1 * Math.sin(ph) });
  return p;
}

function wave(t) {
  const p = new Pose(), ph = t * TAU;
  leg(p, 'L', { t: 0.03, k: 0.05, out: 0.04 }); leg(p, 'R', { t: -0.02, k: 0.03, out: 0.05 });
  arm(p, 'L', { f: 0.04, flex: 0.25, out: 0.03 });
  p.r('R_UpperArm', roll(0.8 - 2.5 + 0.1 * Math.sin(ph))); // right arm raised up and out (bind pose is 0.8 rad out)
  p.r('R_Forearm', roll(0.45 * Math.sin(4 * ph)));
  torso(p, { lean: 0.0, headYaw: 0.15, head: -0.05 });
  return p;
}

function sit(t) {
  const p = new Pose(), b = Math.sin(t * TAU);
  leg(p, 'L', { t: 1.5, k: 1.5, out: 0.06 }); leg(p, 'R', { t: 1.5, k: 1.5, out: 0.06 });
  arm(p, 'L', { f: 0.3, flex: 0.7 + 0.02 * b, out: 0.02 }); arm(p, 'R', { f: 0.3, flex: 0.7 - 0.02 * b, out: 0.02 });
  torso(p, { lean: 0.03 + 0.01 * b, head: 0.03, headYaw: 0.08 * Math.sin(t * TAU + 0.5) });
  p.y = -0.38; p.z = -0.06; p.ground = false;
  return p;
}

const DEFS = {
  idle: { dur: 4, frames: 16, fn: idle },
  walk: { dur: LOCO.walk.dur, frames: 20, fn: (t) => loco(LOCO.walk, t) },
  run: { dur: LOCO.run.dur, frames: 20, fn: (t) => loco(LOCO.run, t) },
  jump: { dur: 0.6, frames: 8, fn: jump },
  guard: { dur: 1.2, frames: 12, fn: guard },
  block: { dur: 1.0, frames: 12, fn: block },
  talk: { dur: 3, frames: 24, fn: talk },
  wave: { dur: 1.6, frames: 20, fn: wave },
  sit: { dur: 4, frames: 12, fn: sit },
  punchL: { dur: 0.45, frames: 14, fn: (t) => punch('L', false, t), once: true },
  punchR: { dur: 0.5, frames: 14, fn: (t) => punch('R', false, t), once: true },
  heavy: { dur: 0.95, frames: 22, fn: (t) => punch('R', true, t), once: true },
  kick: { dur: 0.7, frames: 18, fn: kick, once: true },
  dodge: { dur: 0.45, frames: 10, fn: dodge, once: true },
  hit: { dur: 0.5, frames: 10, fn: hit, once: true },
  ko: { dur: 1.2, frames: 16, fn: ko, once: true },
};

// Speeds (m/s) at which the walk/run clips play at timeScale 1 without visibly sliding the feet.
export const NOMINAL_SPEED = { walk: 1.5, run: 4.6 };

export function poseAt(rig, name, t) {
  const p = DEFS[name].fn(t);
  const y = (p.ground && p.ext.length === 2 ? Math.max(...p.ext) - HIP_TO_ANKLE : 0) + p.y + (p.hopLift || 0);
  return { local: solve(rig, p.rel), root: new Vector3(p.x, y, p.z), touched: Object.keys(p.rel) };
}

export function buildClips(rig) {
  const clips = {}, meta = {};
  for (const [name, d] of Object.entries(DEFS)) {
    const times = [], quats = {}, rootVals = [], used = new Set();
    for (let i = 0; i <= d.frames; i++) {
      const t = i / d.frames;
      const pose = poseAt(rig, name, d.once ? t : (i === d.frames ? 0 : t));
      times.push(t * d.dur);
      pose.touched.forEach((k) => used.add(k));
      for (const k of rig.list) {
        const arr = (quats[k] ||= []);
        const q = pose.local[k].clone();
        if (arr.length) { const prev = arr[arr.length - 1]; if (q.dot(prev) < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; } }
        arr.push(q);
      }
      const v = rig.rootPos.clone().add(pose.root);
      rootVals.push(v.x, v.y, v.z);
    }
    const tracks = [];
    for (const k of rig.list) {
      if (k === 'Root' || !used.has(k)) continue;
      tracks.push(new THREE.QuaternionKeyframeTrack(rig.nodeName[k] + '.quaternion', times, quats[k].flatMap((q) => [q.x, q.y, q.z, q.w])));
    }
    if (used.has('Root')) tracks.push(new THREE.QuaternionKeyframeTrack(rig.nodeName.Root + '.quaternion', times, quats.Root.flatMap((q) => [q.x, q.y, q.z, q.w])));
    tracks.push(new THREE.VectorKeyframeTrack(rig.nodeName.Root + '.position', times, rootVals));
    clips[name] = new THREE.AnimationClip(name, d.dur, tracks);
    meta[name] = { once: !!d.once, duration: d.dur };
  }
  return { clips, meta };
}
