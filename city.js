// city.js - procedural open-world city (5x5 blocks) with colliders, props, traffic and time-of-day.
import * as THREE from 'three';

export const PITCH = 72, BLOCK = 56, N = 5;
const SIDEWALK = 4;                       // pavement depth from block edge
const bc = (i) => (i - 2) * PITCH;        // block centre coordinate
const roadLines = [-108, -36, 36, 108, 180];   // road centre lines (x: west road replaced by beach, so no -180)
const roadLinesZ = [-180, -108, -36, 36, 108, 180];
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  return t;
}
const noise = (g, w, h, n, a) => { for (let i = 0; i < n; i++) { const v = Math.random() * 255 | 0; g.fillStyle = `rgba(${v},${v},${v},${a})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); } };

function facadeTex(base, trim, lit) {   // one tile = 8m wide x 6m tall: two floors of windows
  return canvasTex(256, 192, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h); noise(g, w, h, 1500, 0.07);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
      const x = 22 + c * 78, y = 18 + r * 92;
      g.fillStyle = trim; g.fillRect(x - 4, y - 4, 48, 66);
      g.fillStyle = lit && Math.random() < 0.5 ? '#ffd88a' : '#3b4a5c'; g.fillRect(x, y, 40, 58);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x, y, 40, 8);
      g.fillStyle = trim; g.fillRect(x + 19, y, 2, 58); g.fillRect(x, y + 28, 40, 2);
    }
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, h - 4, w, 4);
  });
}
function sprayTex(text, col) {
  return canvasTex(256, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.font = 'bold 74px Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = '#111'; g.strokeText(text, w / 2, h / 2); g.fillStyle = col; g.fillText(text, w / 2, h / 2);
    g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); g.moveTo(30, 108); g.bezierCurveTo(90, 90, 160, 124, 226, 100); g.stroke();
  });
}

export function buildCity(scene) {
  const city = { colliders: [], benches: [], rings: [], cars: [], statics: new THREE.Group() };
  scene.add(city.statics);
  const add = (o) => { city.statics.add(o); return o; };

  // ---------- collision grid (2D AABBs, full height) ----------
  const CELL = 16, grid = new Map(), key = (x, z) => x + ',' + z;
  function addCollider(minX, maxX, minZ, maxZ, h = 10) {
    const c = { minX, maxX, minZ, maxZ, h }; city.colliders.push(c);
    for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++) for (let z = Math.floor(minZ / CELL); z <= Math.floor(maxZ / CELL); z++) {
      const k = key(x, z); (grid.get(k) || grid.set(k, []).get(k)).push(c);
    }
  }
  city.nearColliders = (x, z) => grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || [];
  // push circle out of boxes; returns true if touched
  city.resolve = (p, r, y = 0) => {
    let hit = false;
    for (const c of city.nearColliders(p.x, p.z)) {
      if (y > c.h) continue;
      const cx = Math.max(c.minX, Math.min(p.x, c.maxX)), cz = Math.max(c.minZ, Math.min(p.z, c.maxZ));
      let dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue; hit = true;
      if (d2 > 1e-8) { const d = Math.sqrt(d2), s = (r - d) / d; p.x += dx * s; p.z += dz * s; }
      else { const l = p.x - c.minX, rr = c.maxX - p.x, t = p.z - c.minZ, b = c.maxZ - p.z, m = Math.min(l, rr, t, b);
        if (m === l) p.x = c.minX - r; else if (m === rr) p.x = c.maxX + r; else if (m === t) p.z = c.minZ - r; else p.z = c.maxZ + r; }
    }
    return hit;
  };
  city.blocked = (x, z, y) => city.nearColliders(x, z).some((c) => y < c.h && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ);

  // ---------- materials ----------
  const asphalt = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#34353a'; g.fillRect(0, 0, w, h); noise(g, w, h, 4000, 0.12); }, [90, 90]);
  const paving = canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#9a958a'; g.fillRect(0, 0, w, h); noise(g, w, h, 900, 0.1); g.strokeStyle = 'rgba(0,0,0,.28)'; g.strokeRect(0, 0, w, h); g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke(); }, [30, 30]);
  const grass = canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#5b7f3a'; g.fillRect(0, 0, w, h); noise(g, w, h, 1800, 0.18); }, [14, 14]);
  const sand = canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#d9c08a'; g.fillRect(0, 0, w, h); noise(g, w, h, 1500, 0.15); }, [20, 40]);
  const courtTex = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#b5532f'; g.fillRect(0, 0, w, h); g.strokeStyle = '#f5f0e6'; g.lineWidth = 4;
    g.strokeRect(12, 12, w - 24, h - 24); g.beginPath(); g.moveTo(12, h / 2); g.lineTo(w - 12, h / 2); g.stroke();
    g.beginPath(); g.arc(w / 2, h / 2, 42, 0, 7); g.stroke(); g.strokeRect(w / 2 - 48, 12, 96, 110); g.strokeRect(w / 2 - 48, h - 122, 96, 110); noise(g, w, h, 1500, 0.1);
  });
  const palettes = [['#b9794f', '#e8d9bf'], ['#8e5a46', '#d8c7ad'], ['#c8b79a', '#7b6a55'], ['#7d8a95', '#d6dde3'], ['#a8523f', '#e6cfae'], ['#9aa58a', '#ece4cf']];
  const facadeMats = palettes.map(([b, t]) => new THREE.MeshLambertMaterial({ map: facadeTex(b, t, true) }));
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x4b4540 });
  const matBox = (c) => new THREE.MeshLambertMaterial({ color: c });

  // ---------- ground, water, roads ----------
  const ground = add(new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ map: asphalt })));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  const water = add(new THREE.Mesh(new THREE.PlaneGeometry(800, 900), new THREE.MeshPhongMaterial({ color: 0x2f5f86, shininess: 90, transparent: true, opacity: 0.92 })));
  water.rotation.x = -Math.PI / 2; water.position.set(-176 - 400, 0.05, 0); city.water = water;
  const dash = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.02, 2.2), new THREE.MeshBasicMaterial({ color: 0xe8d36a }), 800);
  const zebra = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.02, 4), new THREE.MeshBasicMaterial({ color: 0xf0f0f0 }), 900);
  let di = 0, zi = 0; const m4 = new THREE.Matrix4(), rq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const put = (im, i, x, y, z, ry = 0) => { rq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry); im.setMatrixAt(i, m4.compose(new THREE.Vector3(x, y, z), rq, one)); };
  for (const x of roadLines) for (let z = -190; z < 190; z += 6) if (di < 800 && !roadLinesZ.some((rz) => Math.abs(z - rz) < 12)) put(dash, di++, x, 0.02, z);
  for (const z of roadLinesZ) for (let x = -170; x < 190; x += 6) if (di < 800 && !roadLines.some((rx) => Math.abs(x - rx) < 12)) put(dash, di++, x, 0.02, z, Math.PI / 2);
  for (const x of roadLines) for (const z of roadLinesZ) for (const s of [-1, 1]) for (let k = -5; k <= 5; k += 1.6) {
    if (zi < 880) put(zebra, zi++, x + k, 0.02, z + s * 9.5, 0); if (zi < 880) put(zebra, zi++, x + s * 9.5, 0.02, z + k, Math.PI / 2);
  }
  dash.count = di; zebra.count = zi; add(dash); add(zebra);

  // ---------- helpers: buildings, props ----------
  function building(cx, cz, w, d, h, pal = Math.floor(rnd() * palettes.length), { gable = false, graffiti = true } = {}) {
    const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv;
    for (let f = 0; f < 6; f++) { const sx = f < 2 ? d / 8 : w / 8; for (let v = 0; v < 4; v++) { const i = f * 4 + v; if (f === 2 || f === 3) uv.setXY(i, uv.getX(i) * w / 8, uv.getY(i) * d / 8); else uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * h / 6); } }
    const mesh = add(new THREE.Mesh(g, facadeMats[pal])); mesh.position.set(cx, h / 2, cz); mesh.castShadow = mesh.receiveShadow = true;
    if (gable) { const r = add(new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, 3, 4), roofMat)); r.position.set(cx, h + 1.5, cz); r.rotation.y = Math.PI / 4; r.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d)); r.castShadow = true; }
    else { const r = add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.6, d + 0.6), roofMat)); r.position.set(cx, h + 0.3, cz); }
    addCollider(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, h + 1);
    if (graffiti && rnd() < 0.5) {
      const t = sprayTex(pick(['KING', 'SA', 'EASTSIDE', 'RAW', '2K3', 'LOCO', 'HOOD']), pick(['#ff5a3c', '#40e0ff', '#ffd23c', '#9cff4a', '#ff59d6']));
      const m = add(new THREE.Mesh(new THREE.PlaneGeometry(4.5, 2.25), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false })));
      const face = Math.floor(rnd() * 4), off = 0.05;
      const hw = face % 2 === 0 ? w : d;
      m.position.set(cx + (face === 1 ? w / 2 + off : face === 3 ? -w / 2 - off : (rnd() - .5) * w * 0.4), 2 + rnd() * 1.2, cz + (face === 0 ? d / 2 + off : face === 2 ? -d / 2 - off : (rnd() - .5) * d * 0.4));
      m.rotation.y = [0, Math.PI / 2, Math.PI, -Math.PI / 2][face]; if (hw < 6) m.visible = false;
    }
    return mesh;
  }
  const poles = [], trees = [], lamps = [];
  const bench = (x, z, ry) => { // seat + back, with low collider
    const g = new THREE.Group(), wood = matBox(0x7a5233);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2, 0.12, 0.6), wood); seat.position.y = 0.42;
    const back = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 0.08), wood); back.position.set(0, 0.75, -0.28);
    g.add(seat, back); for (const s of [-0.85, 0.85]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.55), matBox(0x222222)); l.position.set(s, 0.21, 0); g.add(l); }
    g.position.set(x, 0, z); g.rotation.y = ry; g.traverse((o) => { o.castShadow = true; }); add(g);
    const fwdv = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
    city.benches.push({ pos: new THREE.Vector3(x, 0, z), ry, taken: false, seat: new THREE.Vector3(x - fwdv.x * 0.05, 0, z - fwdv.z * 0.05) });
    const c = Math.abs(Math.cos(ry)) > 0.5; addCollider(x - (c ? 1 : 0.35), x + (c ? 1 : 0.35), z - (c ? 0.35 : 1), z + (c ? 0.35 : 1), 0.6);
  };
  const lamp = (x, z) => lamps.push([x, z]);
  const tree = (x, z, s = 1) => { trees.push([x, z, s]); addCollider(x - 0.3, x + 0.3, z - 0.3, z + 0.3, 6); };

  // ---------- blocks ----------
  const ringInset = 3;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const cx = bc(i), cz = bc(j), h2 = BLOCK / 2;
    const slab = add(new THREE.Mesh(new THREE.BoxGeometry(BLOCK, 0.18, BLOCK), new THREE.MeshLambertMaterial({ map: i === 0 ? sand : paving })));
    slab.position.set(cx, 0.09, cz); slab.receiveShadow = true;
    city.rings.push({ i, j, cx, cz, half: h2 - ringInset });
    for (const [lx, lz] of [[-h2 + 1.5, -h2 + 1.5], [h2 - 1.5, -h2 + 1.5], [-h2 + 1.5, h2 - 1.5], [h2 - 1.5, h2 - 1.5], [0, -h2 + 1.5], [0, h2 - 1.5]]) if (i !== 0 || lx > 0) lamp(cx + lx, cz + lz);
    const inner = h2 - SIDEWALK;
    if (i === 2 && j === 2) {           // downtown
      for (const [dx, dz, w, d, h] of [[-12, -12, 18, 18, 62], [12, -12, 16, 18, 44], [-12, 12, 16, 16, 38], [12, 12, 18, 16, 74]]) building(cx + dx, cz + dz, w, d, h, 3, { graffiti: false });
    } else if (i === 1 && j === 3) {    // park
      const park = add(new THREE.Mesh(new THREE.PlaneGeometry(BLOCK - 8, BLOCK - 8), new THREE.MeshLambertMaterial({ map: grass }))); park.rotation.x = -Math.PI / 2; park.position.set(cx, 0.2, cz); park.receiveShadow = true;
      for (let k = 0; k < 14; k++) tree(cx + (rnd() - .5) * 40, cz + (rnd() - .5) * 40, 0.8 + rnd() * 0.6);
      bench(cx - 6, cz - 3, 0); bench(cx + 6, cz - 3, 0); bench(cx - 6, cz + 6, Math.PI); bench(cx + 12, cz + 6, Math.PI);
      const pond = add(new THREE.Mesh(new THREE.CircleGeometry(5, 24), new THREE.MeshPhongMaterial({ color: 0x3a6f8f, shininess: 80 }))); pond.rotation.x = -Math.PI / 2; pond.position.set(cx - 12, 0.22, cz + 14); addCollider(cx - 16.5, cx - 7.5, cz + 9.5, cz + 18.5, 0.5);
    } else if (i === 3 && j === 1) {    // basketball court + corner store
      const court = add(new THREE.Mesh(new THREE.PlaneGeometry(16, 30), new THREE.MeshLambertMaterial({ map: courtTex }))); court.rotation.x = -Math.PI / 2; court.rotation.z = Math.PI / 2; court.position.set(cx - 4, 0.2, cz + 2); court.receiveShadow = true;
      for (const s of [-1, 1]) { // hoops at both ends of the long axis (x)
        const px = cx - 4 + s * 15.5; (city.hoops ||= []).push(new THREE.Vector3(px, 3.05, cz + 2)); const pole = add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.4, 8), matBox(0x333333))); pole.position.set(px, 1.7, cz + 2); pole.castShadow = true;
        const bb = add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 1.8), matBox(0xe8e8e8))); bb.position.set(px - s * 0.6, 3.3, cz + 2);
        const ring = add(new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.025, 6, 16), matBox(0xff6a1a))); ring.rotation.x = Math.PI / 2; ring.position.set(px - s * 1.0, 3.05, cz + 2);
        addCollider(px - 0.15, px + 0.15, cz + 1.85, cz + 2.15, 4);
      }
      const fence = (x0, z0, x1, z1) => { const m = add(new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0) || 0.05, 2.4, Math.abs(z1 - z0) || 0.05), new THREE.MeshLambertMaterial({ color: 0x555a60, transparent: true, opacity: 0.35 }))); m.position.set((x0 + x1) / 2, 1.2, (z0 + z1) / 2); };
      bench(cx - 4, cz - 15, Math.PI);
      building(cx + 6, cz - 20, 16, 12, 5, 4, { graffiti: true });  // corner store
      const sign = add(new THREE.Mesh(new THREE.BoxGeometry(8, 1.2, 0.2), new THREE.MeshBasicMaterial({ color: 0xff4040 }))); sign.position.set(cx + 6, 3.4, cz - 13.9);
      building(cx - 18, cz - 20, 10, 12, 9, 1);
    } else if (i === 4 && j === 4) {    // gas station + dealership
      const canopy = add(new THREE.Mesh(new THREE.BoxGeometry(18, 0.5, 10), matBox(0xd9302f))); canopy.position.set(cx - 8, 5.2, cz - 8); canopy.castShadow = true;
      for (const [px, pz] of [[-15, -12], [-1, -12], [-15, -4], [-1, -4]]) { const c = add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 5, 8), matBox(0xdddddd))); c.position.set(cx + px, 2.5, cz + pz); addCollider(cx + px - 0.3, cx + px + 0.3, cz + pz - 0.3, cz + pz + 0.3, 6); }
      for (const px of [-12, -4]) { const pump = add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.6), matBox(0xc02020))); pump.position.set(cx + px, 0.8, cz - 8); addCollider(cx + px - 0.4, cx + px + 0.4, cz - 8.3, cz - 7.7, 1.5); }
      building(cx + 14, cz - 10, 12, 10, 4.5, 5, { graffiti: false });
      building(cx - 4, cz + 16, 30, 14, 7, 3, { graffiti: false });
      const dsign = add(new THREE.Mesh(new THREE.BoxGeometry(12, 1.6, 0.3), new THREE.MeshBasicMaterial({ color: 0x2a6fd6 }))); dsign.position.set(cx - 4, 7.8, cz + 8.8);
    } else if (i === 0) {               // beach boardwalk
      for (let k = 0; k < 6; k++) tree(cx - 6 + rnd() * 20, cz - 22 + k * 8 + rnd() * 3, 1.1);
      bench(cx + 14, cz - 10, Math.PI / 2); bench(cx + 14, cz + 10, Math.PI / 2);
      if (j === 2) building(cx + 12, cz, 10, 14, 5, 4);
    } else {                            // residential / commercial
      const commercial = (i + j) % 2 === 0;
      const lots = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      for (const [sx, sz] of lots) {
        const w = 18 + rnd() * 4, d = 16 + rnd() * 4, h = commercial ? 9 + rnd() * 16 : 5 + rnd() * 4;
        const bx = cx + sx * (inner / 2 - 0.5) * (commercial ? 0.55 : 0.6), bz = cz + sz * (inner / 2 - 0.5) * (commercial ? 0.55 : 0.6);
        building(bx, bz, Math.min(w, inner - 1), Math.min(d, inner - 1), h, undefined, { gable: !commercial });
      }
      if (!commercial) for (let k = 0; k < 4; k++) tree(cx + (rnd() - .5) * 8, cz + (rnd() - .5) * 8 + 0.01, 0.8);
    }
  }
  // ---------- instanced props: street lamps, trees, traffic lights ----------
  const lampPole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.12, 6, 6), matBox(0x2c2c2c), lamps.length);
  const lampHead = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe0a0 }), lamps.length);
  lamps.forEach(([x, z], i) => { put(lampPole, i, x, 3, z); put(lampHead, i, x, 6.1, z); addCollider(x - 0.15, x + 0.15, z - 0.15, z + 0.15, 7); });
  lampPole.castShadow = true; add(lampPole); add(lampHead); city.lampHead = lampHead;
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.28, 3, 6), matBox(0x5a3d26), trees.length);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.9, 1), matBox(0x3f6b2f), trees.length);
  trees.forEach(([x, z, s], i) => { m4.compose(new THREE.Vector3(x, 1.5 * s, z), rq.identity(), new THREE.Vector3(s, s, s)); trunk.setMatrixAt(i, m4); m4.compose(new THREE.Vector3(x, 4 * s, z), rq.identity(), new THREE.Vector3(s, s * 1.1, s)); crown.setMatrixAt(i, m4); });
  trunk.castShadow = crown.castShadow = true; add(trunk); add(crown);
  const tl = []; for (const x of roadLines) for (const z of roadLinesZ) for (const [sx, sz] of [[1, 1], [-1, -1]]) tl.push([x + sx * 9, z + sz * 9]);
  const tlPole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.1, 5, 6), matBox(0x2c2c2c), tl.length);
  const tlHead = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 1.3, 0.4), new THREE.MeshBasicMaterial({ color: 0x2cff6b }), tl.length);
  tl.forEach(([x, z], i) => { put(tlPole, i, x, 2.5, z); put(tlHead, i, x, 5.2, z); }); add(tlPole); add(tlHead);

  // ---------- ambient traffic (simple vehicles; full driving comes in the vehicle stage) ----------
  const carCols = [0xb02020, 0x1f4f9c, 0xd8d8d0, 0x222428, 0xc9a227, 0x2f6b3a];
  function makeCar(col) {
    const g = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.7, 4.4), matBox(col)); body.position.y = 0.7;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 2.2), new THREE.MeshLambertMaterial({ color: 0x1a2733 })); cab.position.set(0, 1.28, -0.2);
    g.add(body, cab); for (const [x, z] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.25, 12), matBox(0x111111)); w.rotation.z = Math.PI / 2; w.position.set(x, 0.36, z); g.add(w); }
    g.traverse((o) => { o.castShadow = true; }); return g;
  }
  for (let k = 0; k < 10; k++) {
    const horiz = k % 2 === 0, line = horiz ? pick(roadLinesZ.slice(1, 5)) : pick(roadLines), dir = rnd() < 0.5 ? 1 : -1;
    const car = makeCar(pick(carCols)); scene.add(car);
    city.cars.push({ obj: car, horiz, line, dir, t: -100 + rnd() * 200, speed: 7 + rnd() * 4, base: 0 });
  }
  city.updateCars = (dt, playerPos) => {
    for (const c of city.cars) {
      const lane = c.line + c.dir * (c.horiz ? -3.5 : 3.5) * (c.horiz ? 1 : -1);
      const px = c.horiz ? c.t : lane, pz = c.horiz ? lane : c.t;
      const ahead = (playerPos.x - px) * (c.horiz ? c.dir : 0) + (playerPos.z - pz) * (c.horiz ? 0 : c.dir);
      const lat = c.horiz ? Math.abs(playerPos.z - pz) : Math.abs(playerPos.x - px);
      const stop = ahead > 0 && ahead < 9 && lat < 2.5;
      c.cur = THREE.MathUtils.lerp(c.cur ?? c.speed, stop ? 0 : c.speed, Math.min(1, dt * 3));
      const lo = c.horiz ? -112 : -185, hi = c.horiz ? 188 : 185;
      c.t += c.dir * c.cur * dt; if (c.t > hi) c.t = lo; if (c.t < lo) c.t = hi;
      c.obj.position.set(c.horiz ? c.t : lane, 0, c.horiz ? lane : c.t);
      c.obj.rotation.y = c.horiz ? (c.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (c.dir > 0 ? 0 : Math.PI);
    }
  };

  // ---------- sky, sun and time of day ----------
  const sun = new THREE.DirectionalLight(0xffb070, 2.2); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 220 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
  const hemi = new THREE.HemisphereLight(0xffc89a, 0x4a3b30, 0.9); scene.add(sun, sun.target, hemi);
  scene.fog = new THREE.Fog(0xe0a070, 60, 330);
  const keys = [ // hour, sky top, horizon/fog, sun colour, sun intensity, hemi intensity
    [0, 0x050818, 0x141a33, 0x6677aa, 0.15, 0.35], [5.5, 0x1b2448, 0xd98a5a, 0xff9a5a, 0.9, 0.55], [8, 0x4f8fd8, 0xbcd8ea, 0xfff0d8, 2.4, 1.0],
    [13, 0x3f88e0, 0xcfe4f2, 0xffffff, 2.8, 1.1], [17, 0x5a86c4, 0xf0c090, 0xffcf90, 2.4, 1.0], [18.7, 0x4a3a6a, 0xff9a55, 0xff8a40, 2.0, 0.85],
    [20, 0x141836, 0x6a4a5a, 0x7080b0, 0.35, 0.45], [24, 0x050818, 0x141a33, 0x6677aa, 0.15, 0.35]];
  const skyGeo = new THREE.SphereGeometry(600, 24, 16), cols = new Float32Array(skyGeo.attributes.position.count * 3); skyGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })); scene.add(skyMesh);
  const cA = new THREE.Color(), cB = new THREE.Color(), top = new THREE.Color(), hor = new THREE.Color();
  city.setHour = (hr) => {
    let k = 0; while (k < keys.length - 2 && hr > keys[k + 1][0]) k++;
    const a = keys[k], b = keys[k + 1], f = THREE.MathUtils.clamp((hr - a[0]) / (b[0] - a[0]), 0, 1);
    top.set(a[1]).lerp(cB.set(b[1]), f); hor.set(a[2]).lerp(cB.set(b[2]), f);
    sun.color.set(a[3]).lerp(cB.set(b[3]), f); sun.intensity = THREE.MathUtils.lerp(a[4], b[4], f); hemi.intensity = THREE.MathUtils.lerp(a[5], b[5], f);
    hemi.color.copy(hor).lerp(cA.set(0xffffff), 0.3); scene.fog.color.copy(hor);
    const pos = skyGeo.attributes.position;
    for (let v = 0; v < pos.count; v++) { const y = Math.max(0, pos.getY(v) / 600); cA.copy(hor).lerp(top, Math.pow(y, 0.6)); cols[v * 3] = cA.r; cols[v * 3 + 1] = cA.g; cols[v * 3 + 2] = cA.b; }
    skyGeo.attributes.color.needsUpdate = true;
    const ang = ((hr - 6) / 12) * Math.PI;   // sun path east->west
    city.sunDir = new THREE.Vector3(Math.cos(ang) * 0.8, Math.max(0.12, Math.sin(ang)), 0.5).normalize();
    const night = hr < 5.5 || hr > 19.5; city.lampHead.material.color.set(night ? 0xffe0a0 : 0x6b6040); city.isNight = night;
    if (night) { city.sunDir.set(-0.3, 0.8, 0.4).normalize(); }
  };
  city.followSun = (p) => { sun.position.copy(p).addScaledVector(city.sunDir, 120); sun.target.position.copy(p); };
  city.setHour(18.6);
  return city;
}
