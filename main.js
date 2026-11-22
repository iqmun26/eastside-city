// main.js - game loop, player controller, third-person camera, combat, dialogue, story, HUD, audio, saves.
import * as THREE from 'three';
import { CharacterLibrary, CHARACTERS } from './characters.js';
import { buildCity } from './city.js';
import { NPC, angLerp } from './npc.js';

const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = THREE.MathUtils.clamp;
const angDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const SAVE_KEY = 'eastgate_save_v1';

// ---------------------------------------------------------------- renderer / scene
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 700);
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

// ---------------------------------------------------------------- procedural audio (no external files)
class AudioSys {
  constructor() { this.ctx = null; this.vol = 0.6; this.beat = 0; }
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = this.vol; this.master.connect(this.ctx.destination);
    const n = this.ctx.sampleRate * 2; this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const amb = this.ctx.createBufferSource(); amb.buffer = this.noiseBuf; amb.loop = true;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240; const g = this.ctx.createGain(); g.gain.value = 0.07;
    amb.connect(lp).connect(g).connect(this.master); amb.start();
    setInterval(() => { if (Math.random() < 0.5) this.tone(rnd(380, 440), 0.35, 'sawtooth', 0.025); }, 22000);   // distant horn
    const prog = [[57, 60, 64, 67], [53, 57, 60, 64], [50, 53, 57, 60], [52, 56, 59, 62]], m = (x) => 440 * 2 ** ((x - 69) / 12);
    setInterval(() => {
      const b = this.beat++, ch = prog[Math.floor(b / 8) % 4];
      if (b % 8 === 0) ch.forEach((x) => this.tone(m(x), 3, 'triangle', 0.03));
      if (b % 4 === 0) this.tone(m(ch[0] - 24), 0.6, 'sine', 0.1);
      if (b % 2 === 1) this.noise(0.04, 7000, 1, 0.025, 'highpass');
    }, 60000 / 92 / 2);
  }
  setVol(v) { this.vol = v; if (this.master) this.master.gain.value = v; }
  noise(dur, f, q, gain, type = 'lowpass') {
    const c = this.ctx; if (!c) return; const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(gain, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    s.connect(fl).connect(g).connect(this.master); s.start(c.currentTime, Math.random()); s.stop(c.currentTime + dur + 0.02);
  }
  tone(f, dur, type = 'sine', gain = 0.15, when = 0) {
    const c = this.ctx; if (!c) return; const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f;
    const t = c.currentTime + when; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  step(run) { this.noise(0.08, run ? 900 : 600, 1, run ? 0.3 : 0.18); }
  hit() { this.noise(0.18, 500, 1, 0.6); this.tone(90, 0.15, 'square', 0.15); }
  whoosh() { this.noise(0.15, 2200, 2, 0.12, 'bandpass'); }
  block() { this.tone(220, 0.08, 'triangle', 0.2); this.noise(0.08, 1500, 3, 0.15, 'bandpass'); }
  ui() { this.tone(660, 0.06, 'square', 0.06); }
  pickup() { this.tone(880, 0.1, 'sine', 0.12); this.tone(1320, 0.15, 'sine', 0.1, 0.08); }
}
const audio = new AudioSys();

// ---------------------------------------------------------------- world + models
const city = buildCity(scene);
const lib = new CharacterLibrary('./assets/characters/');
let selected = 0, previewCh = null, previewAngle = 0;
let appMode = 'loading';                 // loading | menu | play
let gm = 'free';                         // story | free
let paused = false;

const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, vy: 0, grounded: true, hp: 100, maxHp: 100, stamina: 100, exhausted: false,
  money: 250, state: 'free', ch: null, stepDist: 0, comboIdx: 0, comboT: 0, atk: null, stateT: 0, invuln: false };
const SPAWN = new THREE.Vector3(-10, 0, 47);
let npcs = [], orbs = [], benchSat = null, lockTarget = null, lastEnemy = null, enemyShowT = 0, camShake = 0, hourAcc = 0;
let hour = 18.6, camYaw = Math.PI, camPitch = 0.22, camDist = 4.6, sens = 1;
const keys = {}, mouse = { l: false, r: false };
let beacon = null;

const game = {
  audio,
  caption(name, text) { const el = $('caption'); el.innerHTML = `<b style="color:var(--amber)">${name}:</b> ${text}`; clearTimeout(game._c); game._c = setTimeout(() => (el.textContent = ''), 3200); },
  onKO(n) { if (!n.hostile) return; n.hostile = false; player.money += 60; notify('KNOCKED OUT  +$60'); storyEvent('beat', n); },
  onYield(n) { player.money += 40; game.caption(n.name, pick(['Alright, alright — you win!', 'Good fight. You earned that.'])); notify('VICTORY  +$40'); storyEvent('beat', n); },
  playerHit(dmg, src) {
    const p = player; if (p.invuln || p.state === 'ko') return;
    const toSrc = Math.atan2(src.pos.x - p.pos.x, src.pos.z - p.pos.z);
    if (p.state === 'block' && Math.abs(angDiff(p.yaw, toSrc)) < 1.3 && p.stamina > 0) { audio.block(); p.stamina = Math.max(0, p.stamina - dmg * 1.2); dmg *= 0.15; }
    else { audio.hit(); if (p.state !== 'attack') { p.state = 'hit'; p.stateT = 0.45; p.ch.play('hit', { fade: 0.05, restart: true }); p.vel.set(Math.sin(toSrc + Math.PI) * 2.5, 0, Math.cos(toSrc + Math.PI) * 2.5); } camShake = 0.25; }
    p.hp -= dmg; if (p.hp <= 0) defeat();
  },
};

// ---------------------------------------------------------------- UI helpers
const hide = (id) => $(id).classList.add('hidden'), show = (id) => $(id).classList.remove('hidden');
function notify(t) { const el = $('notify'); el.textContent = t; clearTimeout(notify._t); notify._t = setTimeout(() => (el.textContent = ''), 2600); }
function banner(big, small, ms = 2600, color = '#f2a33a') { $('bannerBig').textContent = big; $('bannerBig').style.color = color; $('bannerSmall').textContent = small || ''; show('banner'); clearTimeout(banner._t); banner._t = setTimeout(() => hide('banner'), ms); }

// ---------------------------------------------------------------- story
const STORY = [
  { kind: 'talk', npc: 'Dre', title: 'Welcome Home', obj: 'Find Dre at the basketball court (east side).', reward: 100, lines: [['Dre', '{me}?! Six years gone and you just stroll back like nothing happened?'], ['{me}', 'Needed to clear my head. Looks like the block never changed.'], ['Dre', 'It changed. There\'s an underground fight circuit now. Simone runs it — she\'s over at the park.']] },
  { kind: 'talk', npc: 'Simone', title: 'The Promoter', obj: 'Go and meet Simone in the park.', reward: 50, lines: [['Simone', 'So you\'re the one Dre keeps talking about.'], ['Simone', 'Before I put you in a ring, show me you know this city. Folks hide stashes around town — glowing things. Bring me three.']] },
  { kind: 'collect', n: 3, title: 'Know the Streets', obj: 'Find 3 hidden stashes (glowing orbs) around the city.', reward: 150, unlock: '+15 max health' },
  { kind: 'talk', npc: 'Simone', title: 'Report Back', obj: 'Return to Simone.', reward: 50, lines: [['Simone', 'Not bad. You\'ve got eyes.'], ['Simone', 'Big Mike guards the gate at the gas station on the south-east corner. Beat him in a friendly bout.']] },
  { kind: 'beat', npc: 'Big Mike', title: 'Gatekeeper', obj: 'Beat Big Mike at the gas station (south-east). Talk to him and challenge him.', reward: 300, unlock: '+15 max health' },
  { kind: 'talk', npc: 'Simone', title: 'Championship Night', obj: 'Meet Simone for the championship.', reward: 50, after: 'fight', lines: [['Simone', 'Tonight\'s the final. No more warm-ups.'], ['Simone', 'You\'re fighting me. Don\'t hold back.']] },
  { kind: 'beat', npc: 'Simone', title: 'Champion', obj: 'Win the championship bout against Simone!', reward: 500, final: true },
];
let storyStep = 0, stepProgress = 0;
const curStep = () => (gm === 'story' ? STORY[storyStep] : null);
const findNpc = (name) => npcs.find((n) => n.name === name);
function updateObjective() {
  const s = curStep(), el = $('objective');
  if (!s) { el.innerHTML = gm === 'story' ? '<b>STORY COMPLETE</b><br>The city is yours. Keep exploring.' : `<b>FREE ROAM</b><br>Stashes found: ${orbs.filter((o) => o.got).length}/${orbs.length}`; return; }
  el.innerHTML = `<b>${s.title.toUpperCase()}</b><br>${s.obj}${s.kind === 'collect' ? ` (${stepProgress}/${s.n})` : ''}`;
}
function completeStep() {
  const s = curStep(); if (!s) return;
  player.money += s.reward; if (s.unlock) { player.maxHp += 15; player.hp = player.maxHp; }
  audio.pickup();
  if (s.final) { storyStep++; banner('STORY COMPLETE', `Champion of Eastgate  ·  +$${s.reward}`, 6000); }
  else { banner('MISSION PASSED', `${s.title}  ·  +$${s.reward}${s.unlock ? '  ·  Unlocked: ' + s.unlock : ''}`, 3200); storyStep++; }
  stepProgress = 0; updateObjective();
}
function storyEvent(kind, npc) { const s = curStep(); if (s && s.kind === kind && s.npc === npc.name) completeStep(); }

// ---------------------------------------------------------------- dialogue
let dlg = null;
function openDialogue(npc) {
  const s = curStep();
  player.state = 'talk'; player.vel.set(0, 0, 0); player.ch.play('idle'); player.yaw = Math.atan2(npc.pos.x - player.pos.x, npc.pos.z - player.pos.z);
  if (s && s.kind === 'talk' && s.npc === npc.name) { npc.talking = true; npc.mode = npc.mode === 'sit' ? 'sit' : 'chat'; dlg = { npc, seq: s.lines, i: 0, story: s }; }
  else { const d = npc.dialogue({ night: city.isNight }); dlg = { npc, text: d.text }; }
  renderDialogue();
}
function renderDialogue() {
  const el = $('dialogue'), n = dlg.npc, me = player.ch.def.name; let html;
  if (dlg.seq) { const [who, text] = dlg.seq[dlg.i]; html = `<div class="who">${who.replace('{me}', me)}</div><div class="txt">${text.replace('{me}', me)}</div><button data-k="0">[E] Continue</button>`; }
  else html = `<div class="who">${n.name}<small>${n.def.role}</small></div><div class="txt">${dlg.text}</div>
    <button data-k="1">[1] Ask about the neighbourhood</button><button data-k="2">[2] Talk basketball</button>
    <button data-k="3">[3] Challenge to a friendly fight</button><button data-k="4">[4] Goodbye</button>`;
  el.innerHTML = html; show('dialogue'); hide('prompt');
  el.querySelectorAll('button').forEach((b) => (b.onclick = () => dialogueChoice(+b.dataset.k)));
}
function dialogueChoice(k) {
  audio.ui(); if (!dlg) return; const n = dlg.npc;
  if (dlg.seq) { if (k !== 0) return; dlg.i++; if (dlg.i >= dlg.seq.length) { const s = dlg.story; closeDialogue(); completeStep(); if (s.after === 'fight') n.startFight(false); } else renderDialogue(); return; }
  if (k === 1) dlg.text = n.reply('area'); else if (k === 2) dlg.text = n.reply('basketball');
  else if (k === 3) { closeDialogue(); n.startFight(true); game.caption(n.name, pick(['Let\'s go, then.', 'Don\'t cry when you lose.', 'Friendly, huh? Sure.'])); return; }
  else if (k === 4) { closeDialogue(); return; }
  else return;
  renderDialogue();
}
function closeDialogue() { if (!dlg) return; dlg.npc.endTalk(); dlg = null; hide('dialogue'); if (player.state === 'talk') player.state = 'free'; }

// ---------------------------------------------------------------- world population
function clearWorld() {
  npcs.forEach((n) => scene.remove(n.group)); npcs = []; orbs.forEach((o) => scene.remove(o.mesh)); orbs = [];
  if (player.ch) scene.remove(player.ch.group); if (beacon) scene.remove(beacon); beacon = null; city.benches.forEach((b) => (b.taken = false));
}
const MALE_NAMES = ['Jamal', 'Kenny', 'Omar', 'Vic', 'Teo', 'Eli', 'Rafi', 'Cole'], FEMALE_NAMES = ['Rosa', 'Lena', 'Nia', 'Dana', 'Marta', 'Pat', 'Ivy', 'Cass'];
const isFemale = (id) => id === 'f01' || id === 'f08';
function makeNpc(defId, name, pers) {
  const g = isFemale(defId) ? FEMALE_NAMES : MALE_NAMES;
  const npc = new NPC(lib, defId, name || (g.length ? g.splice(Math.floor(Math.random() * g.length), 1)[0] : 'Local'), pers); scene.add(npc.group); npcs.push(npc); return npc;
}
function populate() {
  const ids = CHARACTERS.map((c) => c.id), pers = ['friendly', 'chatty', 'grumpy', 'tough', 'aloof', 'friendly', 'chatty'];
  const MN = MALE_NAMES.slice(), FN = FEMALE_NAMES.slice();
  const nm = (id) => { const a = isFemale(id) ? FN : MN; return a.length ? a.splice(Math.floor(Math.random() * a.length), 1)[0] : 'Local'; };
  const rings = city.rings;
  for (let k = 0; k < (gm === 'free' ? 12 : 9); k++) { const id = pick(ids), n = makeNpc(id, nm(id), pick(pers)); n.walkRing(pick(rings), Math.random() < 0.5 ? 1 : -1); }
  for (let k = 0; k < 2; k++) {                                   // two chatting pairs
    const r = pick(rings), x = r.cx - r.half, z = r.cz - 6 + k * 14, a = makeNpc(pick(ids), null, 'chatty'), b = makeNpc(pick(ids), null, 'friendly');
    a.stand(x, z, Math.PI / 2, 'talk'); b.stand(x + 1.7, z, -Math.PI / 2, 'talk');
  }
  city.benches.filter(() => Math.random() < 0.6).slice(0, 4).forEach((b) => { const n = makeNpc(pick(ids), null, pick(['friendly', 'aloof', 'grumpy'])); n.sit(b); });
  const dre = makeNpc('m18', 'Dre', 'chatty'); dre.stand(64, -59, -Math.PI / 2, 'idle'); dre.special = true;
  const sim = makeNpc('f08', 'Simone', 'friendly'); sim.stand(-70, 77, Math.PI, 'idle'); sim.special = true; sim.maxHp = sim.hp = 120; sim.dmg = 10;
  const mike = makeNpc('fire06', 'Big Mike', 'tough'); mike.stand(136, 142, Math.PI, 'idle'); mike.special = true; mike.maxHp = mike.hp = 100; mike.dmg = 8;
  // hidden collectibles
  const geo = new THREE.OctahedronGeometry(0.4), mat = new THREE.MeshBasicMaterial({ color: 0x66ffcc });
  for (let k = 0; k < 10; k++) {
    const r = city.rings[(k * 7 + 3) % city.rings.length], c = [[-1, -1], [1, -1], [1, 1], [-1, 1]][k % 4];
    const m = new THREE.Mesh(geo, mat); m.position.set(r.cx + c[0] * r.half, 1.1, r.cz + c[1] * r.half); scene.add(m); orbs.push({ mesh: m, got: false });
  }
}
function createPlayer(idx) {
  player.ch = lib.spawn(CHARACTERS[idx].id); scene.add(player.ch.group);
  Object.assign(player, { hp: 100, maxHp: 100, stamina: 100, state: 'free', vy: 0, grounded: true, atk: null, comboIdx: 0, invuln: false });
  player.vel.set(0, 0, 0); player.pos.copy(SPAWN); player.yaw = 0; camYaw = Math.PI; camPitch = 0.22; lockTarget = null;
}

// ---------------------------------------------------------------- input
addEventListener('keydown', (e) => {
  if (appMode !== 'play') return;
  if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  if (e.repeat) return; keys[e.code] = true;
  if (intro) { if (['Enter', 'Space', 'KeyE'].includes(e.code)) endIntro(); return; }
  if (paused) return;
  if (dlg) { if (e.code === 'KeyE') dialogueChoice(0); const k = +e.key; if (k >= 1 && k <= 4) dialogueChoice(k); return; }
  if (e.code === 'KeyE') interact();
  if (e.code === 'KeyV') tryAttack('heavy');
  if (e.code === 'KeyC' || e.code === 'ControlLeft') tryDodge();
  if (e.code === 'Tab') toggleLock();
  if (e.code === 'Space' && player.state === 'sit') standUp();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('mousemove', (e) => { if (document.pointerLockElement !== canvas || paused || dlg || appMode !== 'play') return; camYaw -= e.movementX * 0.0024 * sens; camPitch = clamp(camPitch + e.movementY * 0.0024 * sens, -0.3, 1.15); });
addEventListener('mousedown', (e) => {
  if (appMode !== 'play' || paused || intro) return;
  if (document.pointerLockElement !== canvas) { if (!dlg && e.target === canvas) canvas.requestPointerLock(); return; }
  if (e.button === 0) { mouse.l = true; tryAttack('light'); } if (e.button === 2) mouse.r = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouse.l = false; if (e.button === 2) mouse.r = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', (e) => { if (appMode === 'play') camDist = clamp(camDist + e.deltaY * 0.003, 2.5, 8); });
document.addEventListener('pointerlockchange', () => { if (appMode === 'play' && !document.pointerLockElement && !dlg && !intro && !paused) setPaused(true); });

// ---------------------------------------------------------------- player actions
function nearestNpc(r) { let best = null, bd = r * r; for (const n of npcs) { if (n.mode === 'ko' || !n.group.visible) continue; const d = n.pos.distanceToSquared(player.pos); if (d < bd) { bd = d; best = n; } } return best; }
function nearestBench(r) { let best = null, bd = r * r; for (const b of city.benches) { if (b.taken) continue; const d = b.pos.distanceToSquared(player.pos); if (d < bd) { bd = d; best = b; } } return best; }
function nearestHoop(r) { return (city.hoops || []).find((h) => Math.hypot(h.x - player.pos.x, h.z - player.pos.z) < r); }
function interact() {
  const p = player; if (p.state === 'sit') { standUp(); return; } if (p.state !== 'free') return;
  const n = nearestNpc(2.7); if (n && n.mode !== 'fight') { openDialogue(n); return; }
  const b = nearestBench(2); if (b) { p.state = 'sit'; benchSat = b; b.taken = true; p.pos.copy(b.seat); p.yaw = b.ry; p.vel.set(0, 0, 0); p.ch.play('sit'); return; }
  const h = nearestHoop(4); if (h) shoot(h);
}
function standUp() { const p = player; if (benchSat) { benchSat.taken = false; p.pos.addScaledVector(new THREE.Vector3(Math.sin(benchSat.ry), 0, Math.cos(benchSat.ry)), 0.9); } benchSat = null; p.state = 'free'; }
let ball = null;
function shoot(h) {
  const p = player; p.state = 'shoot'; p.stateT = 1.1; p.vel.set(0, 0, 0); p.yaw = Math.atan2(h.x - p.pos.x, h.z - p.pos.z); p.ch.play('jump');
  const m = ball || (ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshLambertMaterial({ color: 0xd8601a }))); scene.add(m);
  ball.userData = { t: 0, from: p.pos.clone().setY(2.1), to: h.clone(), good: Math.random() < 0.5 };
}
function toggleLock() { if (lockTarget) { lockTarget = null; return; } let best = null, bd = 14 * 14; for (const n of npcs) { if (n.mode === 'ko' || !n.group.visible) continue; const d = n.pos.distanceToSquared(player.pos); if (d < bd) { bd = d; best = n; } } lockTarget = best; if (best) { lastEnemy = best; enemyShowT = 99; } }
const ATTACKS = { light: ['punchL', 'punchR', 'kick'], heavy: ['heavy'] };
const ATK_DEF = { punchL: { dmg: 7, hitAt: 0.38, range: 1.9, cost: 6 }, punchR: { dmg: 9, hitAt: 0.4, range: 1.9, cost: 7 }, kick: { dmg: 13, hitAt: 0.5, range: 2.3, cost: 10 }, heavy: { dmg: 24, hitAt: 0.55, range: 2.1, cost: 18 } };
function tryAttack(kind) {
  const p = player; if (p.stamina < 5) return;
  if (p.state === 'free' || p.state === 'block') startAttack(kind === 'heavy' ? 'heavy' : ATTACKS.light[p.comboT > 0 ? p.comboIdx % 3 : 0], kind);
  else if (p.state === 'attack' && p.atk.t > p.atk.dur * 0.5 && !p.atk.queued) p.atk.queued = kind;
}
function startAttack(name, kind) {
  const p = player, d = ATK_DEF[name]; p.state = 'attack'; p.stamina -= d.cost;
  const target = lockTarget || nearestNpc(3.2); if (target && target.mode !== 'ko') p.yaw = Math.atan2(target.pos.x - p.pos.x, target.pos.z - p.pos.z);
  p.atk = { name, kind, ...d, t: 0, dur: p.ch.clipDuration(name), done: false, queued: null };
  p.comboIdx = kind === 'light' ? (p.comboT > 0 ? p.comboIdx + 1 : 1) : 0; p.comboT = 0;
  p.ch.play(name, { fade: 0.06, restart: true });
}
function doHit(a) {
  const p = player; let any = false;
  for (const n of npcs) {
    if (n.mode === 'ko') continue; const dx = n.pos.x - p.pos.x, dz = n.pos.z - p.pos.z, dist = Math.hypot(dx, dz);
    if (dist > a.range + 0.2 || (Math.abs(angDiff(p.yaw, Math.atan2(dx, dz))) > 1.1 && n !== lockTarget)) continue;
    if (n.damage(a.dmg * rnd(0.9, 1.1), p.pos, game)) { any = true; lastEnemy = n; enemyShowT = 5; if (n.mode !== 'fight' && !n.friendly && !n.hostile && n.hp > 0) game.caption(n.name, pick(['Hey! What\'s your problem?!', 'Are you crazy?!', 'Back off!'])); }
  }
  if (any) camShake = 0.18; else audio.whoosh();
}
function tryDodge() {
  const p = player; if (p.state !== 'free' || p.stamina < 12) return; p.stamina -= 14; p.state = 'dodge'; p.stateT = 0.45; p.invuln = true;
  const mv = moveInput(); const dir = mv.len > 0 ? mv.dir : new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
  p.vel.copy(dir).multiplyScalar(6.5); p.ch.play('dodge', { fade: 0.05, restart: true });
}
function defeat() {
  const p = player; p.state = 'ko'; p.ch.play('ko', { fade: 0.08, restart: true }); closeDialogue(); lockTarget = null;
  banner('DEFEATED', 'You wake up outside the clinic…', 3200, '#c8372d'); setTimeout(() => {
    p.hp = p.maxHp; p.stamina = 100; p.pos.copy(SPAWN); p.vel.set(0, 0, 0); p.money = Math.max(0, p.money - 50); p.state = 'free'; p.invuln = false; p.ch.play('idle', { fade: 0.3 });
    npcs.forEach((n) => { if (n.hostile) { n.hostile = false; n.mode = n.way.length ? 'wander' : 'stand'; } });
  }, 3200);
}
function moveInput() {
  const f = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw)), r = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
  const ix = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), iz = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), dir = new THREE.Vector3().addScaledVector(f, iz).addScaledVector(r, ix);
  const len = dir.length(); if (len > 0) dir.divideScalar(len); return { dir, len };
}

// ---------------------------------------------------------------- per-frame player update
function updatePlayer(dt) {
  const p = player, ch = p.ch; let speed = 0;
  p.comboT = Math.max(0, p.comboT - dt); p.stateT -= dt;
  if (p.state === 'free' || p.state === 'block') {
    const wantBlock = mouse.r && p.stamina > 0;
    if (wantBlock && p.state === 'free') { p.state = 'block'; } if (!wantBlock && p.state === 'block') p.state = 'free';
  }
  if (p.state === 'free') {
    const mv = moveInput(), canSprint = keys.ShiftLeft || keys.ShiftRight;
    if (p.stamina <= 0.5) p.exhausted = true; if (p.stamina > 25) p.exhausted = false;
    const sprint = canSprint && mv.len > 0 && !p.exhausted && p.grounded, target = mv.len > 0 ? (sprint ? 5.8 : 2.2) : 0;
    const tv = mv.dir.clone().multiplyScalar(target), k = Math.min(1, dt * (p.grounded ? 11 : 3));
    p.vel.x += (tv.x - p.vel.x) * k; p.vel.z += (tv.z - p.vel.z) * k;
    if (sprint) p.stamina -= 20 * dt; else p.stamina = Math.min(100, p.stamina + 16 * dt);
    if (mv.len > 0) p.yaw = angLerp(p.yaw, Math.atan2(mv.dir.x, mv.dir.z), dt * 13);
    else if (lockTarget) p.yaw = angLerp(p.yaw, Math.atan2(lockTarget.pos.x - p.pos.x, lockTarget.pos.z - p.pos.z), dt * 8);
    if (keys.Space && p.grounded && p.stamina > 6) { p.vy = 7.4; p.grounded = false; p.stamina -= 6; keys.Space = false; }
    speed = Math.hypot(p.vel.x, p.vel.z);
    if (!p.grounded) ch.play('jump', { fade: 0.1 });
    else if (lockTarget && speed < 0.2) ch.play('guard'); else ch.locomote(speed);
    if (p.grounded && speed > 0.6) { p.stepDist += speed * dt; const stride = speed > 3.5 ? 2.0 : 1.4; if (p.stepDist > stride) { p.stepDist = 0; audio.step(speed > 3.5); } }
  } else if (p.state === 'block') {
    p.vel.multiplyScalar(Math.max(0, 1 - dt * 12)); p.stamina -= 5 * dt; ch.play('block');
    if (lockTarget) p.yaw = angLerp(p.yaw, Math.atan2(lockTarget.pos.x - p.pos.x, lockTarget.pos.z - p.pos.z), dt * 8);
    if (p.stamina <= 0) p.state = 'free';
  } else if (p.state === 'attack') {
    const a = p.atk; a.t += dt; const f = a.t / a.dur;
    p.vel.set(Math.sin(p.yaw), 0, Math.cos(p.yaw)).multiplyScalar(f < 0.55 ? 1.6 : 0);
    if (!a.done && f >= a.hitAt) { a.done = true; doHit(a); }
    if (a.t >= a.dur) { p.comboT = 0.7; if (a.queued && p.stamina >= 5) startAttack(a.kind === 'heavy' || a.queued === 'heavy' ? 'heavy' : ATTACKS.light[p.comboIdx % 3], a.queued); else { p.state = 'free'; p.atk = null; } }
  } else if (p.state === 'dodge') { p.vel.multiplyScalar(Math.max(0, 1 - dt * 5)); if (p.stateT <= 0) { p.state = 'free'; p.invuln = false; } }
  else if (p.state === 'hit') { p.vel.multiplyScalar(Math.max(0, 1 - dt * 6)); if (p.stateT <= 0) p.state = 'free'; }
  else if (p.state === 'shoot') { p.vel.set(0, 0, 0); if (p.stateT <= 0) { p.state = 'free'; } }
  else if (p.state === 'ko' || p.state === 'talk' || p.state === 'sit') { p.vel.set(0, 0, 0); if (p.state === 'talk') ch.play('idle'); }
  if (p.state !== 'free' && p.state !== 'block') p.stamina = Math.min(100, p.stamina + 10 * dt);
  p.stamina = clamp(p.stamina, 0, 100);

  if (p.state !== 'sit') {
    p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt;
    p.vy -= 22 * dt; p.pos.y += p.vy * dt; if (p.pos.y <= 0) { p.pos.y = 0; p.vy = 0; p.grounded = true; }
    city.resolve(p.pos, 0.38, p.pos.y);
    for (const n of npcs) if (n.mode !== 'ko' && n.group.visible) {
      const dx = p.pos.x - n.pos.x, dz = p.pos.z - n.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.7 && d > 1e-4) { const push = (0.7 - d) * 0.5; p.pos.x += dx / d * push; p.pos.z += dz / d * push; n.pos.x -= dx / d * push; n.pos.z -= dz / d * push; }
    }
    p.pos.x = clamp(p.pos.x, -174, 196); p.pos.z = clamp(p.pos.z, -196, 196);
  }
  p.ch.group.position.copy(p.pos); p.ch.group.rotation.y = p.yaw; ch.update(dt);
}

// ---------------------------------------------------------------- camera
let intro = null;
function updateCamera(dt) {
  const p = player;
  if (lockTarget && lockTarget.mode !== 'ko' && !dlg) camYaw = angLerp(camYaw, Math.atan2(-(lockTarget.pos.x - p.pos.x), -(lockTarget.pos.z - p.pos.z)), dt * 3);
  const head = new THREE.Vector3(p.pos.x, p.pos.y + 1.55, p.pos.z), right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
  head.addScaledVector(right, 0.55);
  const dir = new THREE.Vector3(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch));
  let dist = camDist; for (let d = camDist; d > 0.8; d -= 0.35) { const q = head.clone().addScaledVector(dir, d); if (!city.blocked(q.x, q.z, q.y) && q.y > 0.25) { dist = d; break; } dist = d - 0.35; }
  const want = head.clone().addScaledVector(dir, Math.max(0.9, dist)); want.y = Math.max(0.3, want.y);
  camera.position.lerp(want, 1 - Math.exp(-dt * 16));
  if (camShake > 0) { camera.position.x += rnd(-1, 1) * camShake * 0.1; camera.position.y += rnd(-1, 1) * camShake * 0.1; camShake = Math.max(0, camShake - dt); }
  camera.lookAt(head.x - right.x * 0.2, head.y - 0.1, head.z - right.z * 0.2);
}

// ---------------------------------------------------------------- HUD, minimap
const mm = $('minimap').getContext('2d');
function objectiveTarget() {
  const s = curStep(); if (!s) return null;
  if (s.kind === 'collect') { let best = null, bd = 1e9; for (const o of orbs) if (!o.got) { const d = o.mesh.position.distanceToSquared(player.pos); if (d < bd) { bd = d; best = o.mesh.position; } } return best; }
  const n = findNpc(s.npc); return n ? n.pos : null;
}
function drawMinimap() {
  const S = 170, sc = 0.9, c = Math.cos(camYaw) * sc, s = Math.sin(camYaw) * sc, px = player.pos.x, pz = player.pos.z;
  mm.setTransform(1, 0, 0, 1, 0, 0); mm.fillStyle = '#2f2c2a'; mm.fillRect(0, 0, S, S);
  mm.setTransform(c, s, -s, c, S / 2 - (c * px - s * pz), S / 2 - (s * px + c * pz));
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    mm.fillStyle = i === 0 ? '#d9c08a' : (i === 1 && j === 3) ? '#5b7f3a' : (i === 3 && j === 1) ? '#b5532f' : '#6b6258'; mm.fillRect((i - 2) * 72 - 28, (j - 2) * 72 - 28, 56, 56);
  }
  mm.fillStyle = '#2d6a99'; mm.fillRect(-400 - 176, -300, 400, 600);
  for (const n of npcs) { if (!n.group.visible) continue; mm.fillStyle = n.hostile ? '#ff3030' : '#e8e0c8'; mm.beginPath(); mm.arc(n.pos.x, n.pos.z, 2.2, 0, 7); mm.fill(); }
  for (const o of orbs) if (!o.got && gm === 'free') { mm.fillStyle = '#66ffcc'; mm.fillRect(o.mesh.position.x - 1.6, o.mesh.position.z - 1.6, 3.2, 3.2); }
  const t = objectiveTarget(); if (t) { mm.fillStyle = '#ffd23c'; mm.beginPath(); mm.arc(t.x, t.z, 5, 0, 7); mm.fill(); mm.strokeStyle = '#000'; mm.lineWidth = 1.2; mm.stroke(); }
  mm.setTransform(1, 0, 0, 1, S / 2, S / 2);
  const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw), sx = fx * Math.cos(camYaw) - fz * Math.sin(camYaw), sy = Math.sin(camYaw) * fx + Math.cos(camYaw) * fz, ang = Math.atan2(sx, -sy);
  mm.rotate(ang); mm.fillStyle = '#fff'; mm.strokeStyle = '#000'; mm.lineWidth = 2; mm.beginPath(); mm.moveTo(0, -8); mm.lineTo(6, 7); mm.lineTo(0, 3); mm.lineTo(-6, 7); mm.closePath(); mm.fill(); mm.stroke();
}
function updateHud(dt) {
  const p = player; $('hpbar').style.width = clamp(p.hp / p.maxHp * 100, 0, 100) + '%'; $('stbar').style.width = p.stamina + '%';
  $('money').textContent = '$' + p.money.toLocaleString();
  const hh = Math.floor(hour) % 24, mmn = Math.floor((hour % 1) * 60); $('clock').textContent = `${((hh + 11) % 12) + 1}:${String(mmn).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  const pr = $('prompt'); let txt = '';
  if (document.pointerLockElement !== canvas && !intro) txt = 'Click to capture the mouse';
  else if (!dlg && p.state === 'free') { const n = nearestNpc(2.7); if (n && n.mode !== 'fight') txt = `[E] Talk to ${n.name}`; else if (nearestBench(2)) txt = '[E] Sit down'; else if (nearestHoop(4)) txt = '[E] Shoot hoops'; }
  else if (p.state === 'sit') txt = '[E] Stand up';
  pr.textContent = txt; pr.classList.toggle('hidden', !txt);
  enemyShowT -= dt; const fighter = npcs.find((n) => n.mode === 'fight'), en = fighter || (enemyShowT > 0 ? lastEnemy : null);
  $('enemy').classList.toggle('hidden', !en); if (en) { $('enemyName').textContent = en.name + (lockTarget === en ? '  ◉' : ''); $('enemyHp').style.width = clamp(en.hp / en.maxHp * 100, 0, 100) + '%'; }
}

// ---------------------------------------------------------------- game flow
function startGame(mode, save) {
  appMode = 'play'; gm = mode; audio.init(); hide('menu'); show('hud'); hide('pause'); paused = false;
  if (previewCh) { scene.remove(previewCh.group); previewCh = null; }
  clearWorld(); createPlayer(selected); storyStep = 0; stepProgress = 0; populate(); hour = 18.6;
  if (save) applySave(save);
  updateObjective();
  if (gm === 'story' && !save) startIntro(); else canvas.requestPointerLock();
}
const INTRO_LINES = ['Eastgate. Six years since I last walked these streets.', 'Same corners. Same sunsets. Different me.', 'Time to find out who\'s still around.'];
function startIntro() {
  intro = { t: 0 }; show('intro'); player.state = 'talk'; hide('hud');
}
function endIntro() { intro = null; hide('intro'); show('hud'); player.state = 'free'; canvas.requestPointerLock(); notify('STORY MODE'); }
function setPaused(v) { paused = v; if (v) { show('pause'); for (const k in keys) keys[k] = false; mouse.l = mouse.r = false; } else { hide('pause'); canvas.requestPointerLock(); } }
function saveGame() {
  const d = { gm, selected, pos: player.pos.toArray(), hp: player.hp, maxHp: player.maxHp, money: player.money, hour, storyStep, stepProgress, orbs: orbs.map((o) => o.got) };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(d)); notify('GAME SAVED'); } catch (e) { notify('SAVE FAILED'); }
}
function readSave() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return null; } }
function applySave(d) {
  player.pos.fromArray(d.pos); player.hp = d.hp; player.maxHp = d.maxHp; player.money = d.money; hour = d.hour; storyStep = d.storyStep; stepProgress = d.stepProgress;
  (d.orbs || []).forEach((g, i) => { if (g && orbs[i]) { orbs[i].got = true; orbs[i].mesh.visible = false; } });
}

// ---------------------------------------------------------------- tick
const clock = { last: performance.now() };
function tick(dt) {
  hourAcc += dt; hour = (hour + dt / 25) % 24; if (hourAcc > 0.5) { hourAcc = 0; city.setHour(hour); }
  city.followSun(player.pos); city.updateCars(dt, player.pos); city.water.position.y = 0.05 + Math.sin(performance.now() / 900) * 0.04;
  if (intro) {
    intro.t += dt; const T = 11, f = Math.min(1, intro.t / T), e = f * f * (3 - 2 * f), look = player.pos.clone().setY(1.5);
    const a = new THREE.Vector3(player.pos.x + 46, 52, player.pos.z + 46), b = new THREE.Vector3(player.pos.x + Math.sin(camYaw) * 4.6, 2.6, player.pos.z + Math.cos(camYaw) * 4.6);
    camera.position.lerpVectors(a, b, e); camera.lookAt(look); $('introTxt').textContent = INTRO_LINES[Math.min(2, Math.floor(intro.t / 3.6))];
    player.ch.play('idle'); player.ch.update(dt); player.ch.group.position.copy(player.pos);
    if (intro.t > T) endIntro();
    for (const n of npcs) n.update(dt, { player, city, game });
    return;
  }
  updatePlayer(dt);
  for (const n of npcs) n.update(dt, { player, city, game });
  for (let i = 0; i < npcs.length; i++) for (let j = i + 1; j < npcs.length; j++) {
    const a = npcs[i], b = npcs[j]; if (!a.group.visible || !b.group.visible || a.mode === 'sit' || b.mode === 'sit') continue;
    const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z, d = Math.hypot(dx, dz); if (d < 0.6 && d > 1e-4) { const k = (0.6 - d) * 0.5 / d; a.pos.x += dx * k; a.pos.z += dz * k; b.pos.x -= dx * k; b.pos.z -= dz * k; }
  }
  if (lockTarget && (lockTarget.mode === 'ko' || lockTarget.pos.distanceTo(player.pos) > 20)) lockTarget = null;
  if (ball && ball.parent) { const u = ball.userData; u.t += dt / 0.9; const t = Math.min(1, u.t); ball.position.lerpVectors(u.from, u.to, t); ball.position.y += Math.sin(t * Math.PI) * 2.2;
    if (u.t >= 1) { scene.remove(ball); if (u.good) { player.money += 20; notify('SWISH!  +$20'); audio.pickup(); } else notify('Miss!'); } }
  const now = performance.now() / 1000;
  for (const o of orbs) if (!o.got) { o.mesh.rotation.y = now * 2; o.mesh.position.y = 1.1 + Math.sin(now * 2 + o.mesh.position.x) * 0.15;
    if (o.mesh.position.distanceTo(player.pos.clone().setY(1)) < 1.6) { o.got = true; scene.remove(o.mesh); player.money += 100; audio.pickup(); notify('STASH FOUND  +$100');
      const s = curStep(); if (s && s.kind === 'collect') { stepProgress++; if (stepProgress >= s.n) completeStep(); else updateObjective(); } else updateObjective(); } }
  const t = objectiveTarget();
  if (t && gm === 'story') { if (!beacon) { beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 40, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd23c, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })); scene.add(beacon); } beacon.position.set(t.x, 20, t.z); } else if (beacon) { scene.remove(beacon); beacon = null; }
  updateCamera(dt); updateHud(dt); drawMinimap();
}

// ---------------------------------------------------------------- menu
function buildMenu() {
  const list = $('charList'); list.innerHTML = '';
  CHARACTERS.forEach((c, i) => { const b = document.createElement('div'); b.className = 'chip' + (i === selected ? ' sel' : ''); b.textContent = c.name; b.onclick = () => { selected = i; audio.init(); audio.ui(); buildMenu(); }; list.appendChild(b); });
  const c = CHARACTERS[selected]; $('charInfo').innerHTML = `<b>${c.name}</b> <span style="opacity:.7">· ${c.role}</span><p>${c.bio}</p>`;
  if (previewCh) scene.remove(previewCh.group); previewCh = lib.spawn(c.id); previewCh.group.position.copy(SPAWN); previewCh.play(Math.random() < 0.5 ? 'idle' : 'wave'); scene.add(previewCh.group);
}
function showMenu() {
  appMode = 'menu'; show('menu'); hide('hud'); hide('pause'); hide('banner'); document.exitPointerLock?.(); buildMenu(); $('btnContinue').disabled = !readSave();
  clearWorld(); city.setHour(18.6);
}
function menuTick(dt) {
  previewAngle += dt * 0.25; city.followSun(SPAWN); city.updateCars(dt, new THREE.Vector3(9999, 0, 9999));
  if (previewCh) { previewCh.update(dt); camera.position.set(SPAWN.x + Math.sin(previewAngle) * 3.4 + 0.8, 1.5, SPAWN.z + Math.cos(previewAngle) * 3.4); camera.lookAt(SPAWN.x - 0.6, 1.15, SPAWN.z); }
}
$('btnStory').onclick = () => startGame('story');
$('btnFree').onclick = () => startGame('free');
$('btnContinue').onclick = () => { const s = readSave(); if (s) { selected = s.selected; startGame(s.gm, s); } };
$('btnSettings').onclick = () => { show('pause'); $('pResume').textContent = 'Back'; $('pResume').onclick = () => { hide('pause'); $('pResume').textContent = 'Resume'; $('pResume').onclick = () => setPaused(false); }; };
$('pResume').onclick = () => setPaused(false);
$('pSave').onclick = () => saveGame();
$('pLoad').onclick = () => { const s = readSave(); if (!s) return notify('NO SAVE FOUND'); selected = s.selected; setPaused(false); startGame(s.gm, s); };
$('pQuit').onclick = () => { paused = false; intro = null; showMenu(); };
$('setVol').oninput = (e) => audio.setVol(+e.target.value);
$('setSens').oninput = (e) => (sens = +e.target.value);
$('setShadow').onchange = (e) => { renderer.shadowMap.enabled = e.target.checked; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); };

// ---------------------------------------------------------------- boot
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - clock.last) / 1000); clock.last = now;
  if (appMode === 'menu') menuTick(dt); else if (appMode === 'play' && !paused) tick(dt);
  renderer.render(scene, camera);
}
lib.loadAll((p, c) => { $('loadBar').style.width = (p * 100) + '%'; $('loadMsg').textContent = `Loaded ${c.name}`; })
  .then(() => { hide('loading'); showMenu(); })
  .catch((e) => { console.error(e); $('loadMsg').textContent = 'Failed to load character models.'; $('loadErr').textContent = `${e.message || e}. Serve this folder over HTTP (e.g. "npx serve" or "python3 -m http.server 8000") instead of opening index.html directly, and make sure you are online for the three.js CDN.`; });
requestAnimationFrame(frame);
window.__eastgate = { player, city, lib, get npcs() { return npcs; }, camera, scene };
