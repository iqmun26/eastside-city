# EASTGATE — Street Stories (Three.js, vanilla JS)

## Run it
Browsers block GLB/module loading from `file://`, so serve the folder:

    cd city
    python3 -m http.server 8000      # or: npx serve
    # open http://localhost:8000

First load needs internet (three.js r160 comes from the jsDelivr CDN via the import map in `index.html`).
To go fully offline, download `three@0.160.0` and point the import map at local copies of
`build/three.module.js` and `examples/jsm/`.

## Controls
WASD move · Shift sprint · Space jump · Mouse look (click to capture) · E interact / sit / shoot hoops ·
LMB light combo (jab → cross → kick) · V heavy · RMB block · C or Ctrl dodge · Tab lock-on · Wheel zoom · Esc pause

## How the supplied GLB characters are used
* `src/characters.js` loads the 5 GLBs with `GLTFLoader` + `MeshoptDecoder` (the files use
  `EXT_meshopt_compression`, `EXT_texture_webp`, `KHR_mesh_quantization`). Meshes, textures, materials, hair cards
  (alpha-masked) are used exactly as shipped — nothing is rebuilt from primitives.
* **The GLBs contain no animation clips** (verified: `animations: []` in all five). `src/animations.js` therefore
  generates real `THREE.AnimationClip`s for their shared 80-bone `Bip01` skeleton, and `AnimationMixer` plays them:
  idle, walk, run, jump, guard, block, punchL/punchR, heavy, kick, dodge, hit, ko, talk, wave, sit.
  Poses are authored in world space and converted to each bone's local quaternion from the bind pose, so Bip01's odd
  bone axes don't matter. Walk/run playback rate is driven by real ground speed.
* Each character is measured at load (skinned bounding box) and scaled to its target height with feet on y = 0.
* Player and every NPC use the same `Character` class; skinned meshes have frustum culling disabled (they animate
  outside their bind-pose bounds) and distant NPCs are hidden/not updated.

## Files
    index.html         UI shell + import map
    src/main.js        loop, input, player, camera, combat, dialogue, story, HUD, audio, save/load
    src/characters.js  GLB loading, fitting, Character wrapper (AnimationMixer)
    src/animations.js  procedural clip generator for the Bip01 rig
    src/npc.js         NPC state machine (wander, chat, sit, greet, flee, fight, ko)
    src/city.js        5x5-block city, colliders, instanced props, traffic, time of day
    assets/characters/ the five supplied .glb files
