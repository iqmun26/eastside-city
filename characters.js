// characters.js - loads the supplied GLB models and creates animated instances.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildRig, buildClips, NOMINAL_SPEED } from './animations.js';

// The GLBs ship with no names/bios, so these are our own. Model look (clothes, hair, skin) comes
// entirely from each GLB's own textures, which are left untouched.
export const CHARACTERS = [
  { id: 'm06', file: 'Male_Adult_06.glb', name: 'Marcus', role: 'Returning local', bio: 'Back in the neighbourhood after years away. Calm, observant, hits hard when pushed.', height: 1.80, lines: ['Yo, what\'s good?', 'Long time, huh? City ain\'t changed much.', 'Keep it moving, I got somewhere to be.'] },
  { id: 'f01', file: 'Female_Adult_01.glb', name: 'Tasha', role: 'Street racer', bio: 'Quick, sharp-tongued, knows every shortcut in town.', height: 1.72, lines: ['Hey you! Nice day for a walk.', 'Careful on these corners, traffic gets wild.', 'You seen the court down on 4th? Games all evening.'] },
  { id: 'm18', file: 'Male_Adult_18.glb', name: 'Dre', role: 'Corner-store regular', bio: 'Easy-going, always has a rumour to share.', height: 1.80, lines: ['Heard there\'s a tournament coming up...', 'You look like you can handle yourself.', 'The shop on the corner has the best snacks.'] },
  { id: 'f08', file: 'Female_Adult_08.glb', name: 'Simone', role: 'Fight promoter', bio: 'Organises the underground bouts. Respects confidence.', height: 1.72, lines: ['Fresh face. You fight?', 'Come find me when you want a real match.', 'People talk about you already.'] },
  { id: 'fire06', file: 'Fire_Male_06.glb', name: 'Big Mike', role: 'Firefighter', bio: 'Station-house legend. Steady, strong, protective.', height: 1.85, lines: ['Stay safe out here, alright?', 'Station\'s just down the road if you need anything.', 'Never seen anyone run that fast.'] },
];

// Measure the real skinned mesh (the GLB is quantised, so don't trust the file's numbers) and
// derive a uniform scale + vertical offset so every character is the intended height with feet on y=0.
function measureFit(scene, targetHeight) {
  try {
    scene.updateMatrixWorld(true);
    scene.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.update(); });
    const box = new THREE.Box3().setFromObject(scene, true), size = box.getSize(new THREE.Vector3());
    if (!(size.y > 0.3 && size.y < 6)) throw new Error('implausible bounds ' + size.y);
    const scale = targetHeight / size.y;
    return { scale, y: -box.min.y * scale, measured: size.y };
  } catch (e) { console.warn('Character fit fallback:', e); return { scale: 1, y: 0, measured: 0 }; }
}

export class CharacterLibrary {
  constructor(basePath = './assets/characters/') {
    this.loader = new GLTFLoader();
    this.loader.setMeshoptDecoder(MeshoptDecoder); // GLBs use EXT_meshopt_compression
    this.base = basePath; this.protos = {};
  }
  async loadAll(onProgress) {
    let done = 0;
    await Promise.all(CHARACTERS.map(async (c) => {
      const gltf = await this.loader.loadAsync(this.base + c.file);
      const scene = gltf.scene;
      const rig = buildRig(scene);                 // reads the real bind pose from the file
      const { clips, meta } = buildClips(rig);     // procedural clips: GLBs contain none
      this.protos[c.id] = { def: c, scene, clips, meta, fit: measureFit(scene, c.height) };
      onProgress && onProgress(++done / CHARACTERS.length, c);
    }));
  }
  spawn(id) { return new Character(this.protos[id]); }
}

export class Character {
  constructor(proto) {
    this.def = proto.def; this.meta = proto.meta;
    this.group = new THREE.Group();                         // gameplay transform: position + yaw (model faces +Z)
    this.model = SkeletonUtils.clone(proto.scene);          // shares textures/materials with the original GLB
    this.model.scale.setScalar(proto.fit.scale); this.model.position.y = proto.fit.y;
    this.group.add(this.model);
    this.model.traverse((o) => {
      if (o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; }
      if (o.isMesh && o.material && o.material.map) o.material.map.anisotropy = 4;
    });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [n, clip] of Object.entries(proto.clips)) {
      const a = this.mixer.clipAction(clip);
      if (proto.meta[n].once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; } else a.setLoop(THREE.LoopRepeat, Infinity);
      this.actions[n] = a;
    }
    this.current = null; this.currentName = '';
    this.onFinished = null;
    this.mixer.addEventListener('finished', (e) => { if (this.onFinished) this.onFinished(e.action.getClip().name); });
    this.mixer.update(Math.random() * 3);                   // de-sync crowds
  }
  play(name, { fade = 0.18, speed = 1, restart = false } = {}) {
    const next = this.actions[name]; if (!next) return;
    if (this.current === next && !restart) { next.setEffectiveTimeScale(speed); return; }
    next.reset().setEffectiveTimeScale(speed).setEffectiveWeight(1).play();
    if (this.current) this.current.crossFadeTo(next, fade, false);
    this.current = next; this.currentName = name;
  }
  // Pick locomotion clip + playback rate from real ground speed so feet match the motion.
  locomote(speed) {
    if (speed < 0.15) this.play('idle');
    else if (speed < 3.2) this.play('walk', { speed: THREE.MathUtils.clamp(speed / NOMINAL_SPEED.walk, 0.6, 1.8) });
    else this.play('run', { speed: THREE.MathUtils.clamp(speed / NOMINAL_SPEED.run, 0.7, 1.5) });
  }
  clipDuration(n) { return this.meta[n].duration; }
  update(dt) { this.mixer.update(dt); }
}
