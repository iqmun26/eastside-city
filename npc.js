// npc.js - pedestrians built on the GLB characters. Each NPC runs a small state machine whose states
// map directly onto animation clips (idle / walk / run / talk / wave / sit / guard / punch / kick / hit / ko).
import * as THREE from 'three';

const TAU = Math.PI * 2;
export const angLerp = (a, b, t) => { const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * Math.min(1, t); };
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const PERSONALITY = {
  friendly: { greet: ['Hey, how you doing?', 'Evening!', 'Welcome back, stranger!'], area: ['The park\'s real peaceful around sunset.', 'Best pickup games are at the court on the east side.', 'Beach is west, past the boardwalk.'] },
  chatty: { greet: ['Oh hey! You new around here?', 'Did you hear about the fights downtown?', 'Nice walk, right?'], area: ['Gas station on the south-east corner does a mean hot dog.', 'Rumour is there are hidden stashes around town. Glowing things.', 'Downtown\'s where the money is.'] },
  grumpy: { greet: ['What.', 'Mind the sidewalk.', 'Hmph.'], area: ['Ask somebody else.', 'Traffic\'s a nightmare. Always was.', 'Keep your noise down.'] },
  tough: { greet: ['You lost?', 'Watch where you walk.', 'You look like trouble.'], area: ['Fights happen when the sun goes down.', 'Think you\'re tough? Prove it.', 'Respect gets earned here.'] },
  aloof: { greet: ['...', '(They ignore you.)', '(Headphones on. No reaction.)'], area: ['...'], ignores: true },
};

export class NPC {
  constructor(lib, defId, name, personality) {
    this.ch = lib.spawn(defId); this.def = this.ch.def; this.group = this.ch.group;
    this.name = name || this.def.name; this.personality = personality; this.P = PERSONALITY[personality];
    this.pos = this.group.position; this.yaw = Math.random() * TAU; this.speed = rnd(1.1, 1.5);
    this.maxHp = 50 + Math.random() * 30; this.hp = this.maxHp;
    this.mode = 'stand'; this.timer = 0; this.way = []; this.wi = 0; this.vel = new THREE.Vector3();
    this.greetCool = rnd(0, 6); this.hostile = false; this.friendly = false; this.cool = 0; this.atkT = 0; this.atkDone = true;
    this.dmg = rnd(5, 9); this.accuracy = 0.7; this.talking = false; this.fighter = personality === 'tough';
    this.ch.onFinished = (n) => { if (n === 'hit' && this.mode === 'hit') this.afterHit(); };
  }
  // --- placement helpers
  walkRing(ring, dir) {
    const h = ring.half, c = [[-h, -h], [h, -h], [h, h], [-h, h]]; if (dir < 0) c.reverse();
    this.way = c.map(([x, z]) => new THREE.Vector3(ring.cx + x, 0, ring.cz + z)); this.wi = Math.floor(Math.random() * 4);
    const a = this.way[this.wi], b = this.way[(this.wi + 1) % 4]; this.pos.copy(a).lerp(b, Math.random()); this.mode = 'wander';
  }
  stand(x, z, yaw, anim = 'idle') { this.pos.set(x, 0, z); this.yaw = yaw; this.mode = 'stand'; this.standAnim = anim; this.faceYaw = yaw; this.ch.play(anim); }
  sit(bench) { bench.taken = true; this.pos.copy(bench.seat); this.yaw = bench.ry; this.mode = 'sit'; this.ch.play('sit'); }

  // --- dialogue
  dialogue(ctx) {
    this.talking = true; this.prevMode = this.mode === 'chat' ? this.prevMode : this.mode; this.mode = this.mode === 'sit' ? 'sit' : 'chat';
    const intro = this.P.ignores && Math.random() < 0.5 ? this.P.greet[0] : (ctx.night && Math.random() < 0.4 ? 'Late to be out. Stay sharp.' : pick(this.P.greet.concat(this.def.lines)));
    return { name: this.name, role: this.def.role, text: intro, npc: this };
  }
  reply(kind) {
    if (kind === 'area') return pick(this.P.area);
    if (kind === 'basketball') return pick(['Court\'s on the east side. First to 11?', 'I\'m rusty, but sure — find me at the hoops.']);
    return 'See you around.';
  }
  endTalk() { this.talking = false; if (this.mode === 'chat') { this.mode = this.prevMode === 'sit' ? 'sit' : (this.way.length ? 'wander' : 'stand'); this.timer = 0; } }
  startFight(friendly) { this.hostile = true; this.friendly = friendly; this.talking = false; this.mode = 'fight'; this.cool = 0.6; this.maxHp = Math.max(this.maxHp, 70); this.hp = this.maxHp; }

  // --- combat
  damage(amount, src, game) {
    if (this.mode === 'ko') return false;
    this.hp -= amount; game.audio.hit(); this.talking = false;
    const dir = this.pos.clone().sub(src).setY(0).normalize(); this.vel.copy(dir).multiplyScalar(2.2);
    if (this.hp <= 0) { this.mode = 'ko'; this.timer = 9; this.ch.play('ko', { fade: 0.08, restart: true }); game.onKO(this); return true; }
    if (this.friendly && this.hp < this.maxHp * 0.3) { this.hostile = false; this.friendly = false; this.mode = 'stand'; this.standAnim = 'idle'; this.ch.play('hit', { restart: true }); game.onYield(this); return true; }
    this.prev2 = this.mode === 'hit' ? this.prev2 : this.mode; this.mode = 'hit'; this.ch.play('hit', { fade: 0.05, restart: true }); this.timer = 0.5; return true;
  }
  afterHit() {
    if (this.hostile) this.mode = 'fight';
    else if (this.personality === 'tough') { this.startFight(false); }
    else { this.mode = 'flee'; this.timer = 4; }
  }

  update(dt, ctx) {
    const { player, city, game } = ctx, g = this.group, d2 = this.pos.distanceToSquared(player.pos);
    g.visible = d2 < 110 * 110; if (!g.visible && this.mode !== 'fight') return;
    this.greetCool -= dt;
    const toP = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z), dist = Math.sqrt(d2);
    switch (this.mode) {
      case 'wander': {
        if (this.timer > 0) { this.timer -= dt; this.ch.play(this.pauseAnim || 'idle'); break; }
        if (dist < 5 && this.greetCool <= 0 && !this.P.ignores) { this.mode = 'greet'; this.timer = 1.8; this.greetCool = rnd(18, 35); game.caption(this.name, pick(this.P.greet)); break; }
        const w = this.way[this.wi % this.way.length], dx = w.x - this.pos.x, dz = w.z - this.pos.z, l = Math.hypot(dx, dz);
        if (l < 0.7) { this.wi = (this.wi + 1) % this.way.length; if (Math.random() < 0.3) { this.timer = rnd(2, 7); this.pauseAnim = pick(['idle', 'talk', 'idle']); } break; }
        this.yaw = angLerp(this.yaw, Math.atan2(dx, dz), dt * 6);
        this.pos.x += Math.sin(this.yaw) * this.speed * dt; this.pos.z += Math.cos(this.yaw) * this.speed * dt;
        this.ch.locomote(this.speed); break;
      }
      case 'greet': this.yaw = angLerp(this.yaw, toP, dt * 5); this.ch.play('wave'); if ((this.timer -= dt) <= 0) this.mode = this.way.length ? 'wander' : 'stand'; break;
      case 'stand': this.ch.play(this.standAnim || 'idle'); if (this.faceYaw !== undefined) this.yaw = angLerp(this.yaw, this.faceYaw, dt * 4); break;
      case 'sit': this.ch.play('sit'); break;
      case 'chat': this.yaw = angLerp(this.yaw, toP, dt * 6); this.ch.play('talk'); break;
      case 'flee': {
        this.yaw = angLerp(this.yaw, toP + Math.PI, dt * 8); this.pos.x += Math.sin(this.yaw) * 4.6 * dt; this.pos.z += Math.cos(this.yaw) * 4.6 * dt; this.ch.locomote(4.6);
        if ((this.timer -= dt) <= 0) this.mode = this.way.length ? 'wander' : 'stand'; break;
      }
      case 'hit': this.pos.addScaledVector(this.vel, dt); this.vel.multiplyScalar(Math.max(0, 1 - dt * 6)); if ((this.timer -= dt) <= -0.1) this.afterHit(); break;
      case 'ko': if ((this.timer -= dt) <= 0) { this.hp = this.maxHp * 0.6; this.hostile = false; this.mode = this.way.length ? 'wander' : 'stand'; this.ch.play('idle', { fade: 0.4 }); } break;
      case 'fight': this.fight(dt, toP, dist, game); break;
    }
    city.resolve(this.pos, 0.4);
    g.rotation.y = this.yaw; this.ch.update(dt);
  }
  fight(dt, toP, dist, game) {
    this.yaw = angLerp(this.yaw, toP, dt * 8);
    if (this.atkT > 0) {
      this.atkT -= dt;
      if (!this.atkDone && this.atkT <= this.atkLen * 0.5) { this.atkDone = true; if (dist < 2.1) game.playerHit(this.dmg * (this.friendly ? 0.6 : 1), this); }
      if (this.atkT <= 0) { this.cool = rnd(0.5, 1.3); this.ch.play('guard', { fade: 0.1 }); }
      return;
    }
    this.cool -= dt;
    if (dist > 1.7) { this.pos.x += Math.sin(this.yaw) * 3 * dt; this.pos.z += Math.cos(this.yaw) * 3 * dt; this.ch.locomote(3); }
    else {
      this.ch.play('guard');
      if (this.cool <= 0) { const a = pick(['punchL', 'punchR', 'punchR', 'kick']); this.ch.play(a, { fade: 0.06, restart: true }); this.atkLen = this.atkT = this.ch.clipDuration(a); this.atkDone = false; }
    }
  }
}
