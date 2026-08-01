import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { RenderPipeline, QUALITY } from './core/RenderPipeline.js';
import { Input } from './core/Input.js';
import { Stage } from './world/Stage.js';
import { Environment } from './world/Environment.js';
import { Player } from './entities/Player.js';
import { CameraRig } from './core/CameraRig.js';
import { Combat } from './systems/Combat.js';
import { Items } from './systems/Items.js';
import { Artifacts } from './systems/Artifacts.js';
import { Director } from './systems/Director.js';
import { Progression } from './systems/Progression.js';
import { VFX } from './systems/VFX.js';
import { Audio } from './systems/Audio.js';
import { HUD } from './ui/HUD.js';
import { Coop } from './net/Coop.js';
import { Lobby } from './net/Lobby.js';
import { maybeShowGpuNotice } from './ui/GpuNotice.js';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || (Math.random() * 0xffffffff) >>> 0;
const pinnedQuality = params.has('quality');
const quality = pinnedQuality ? Number(params.get('quality')) : QUALITY.HIGH;

const canvas = document.getElementById('viewport');
const engine = new Engine({ canvas, seed });
const ctx = engine.ctx;

ctx.input = new Input(canvas);
ctx.pipeline = new RenderPipeline(canvas, quality);
// The pipeline reads `settings` and, on a quality change, reaches Environment
// and the particle system through here. Nothing ever assigned it, so its own
// `settings` getter had been falling through to the `globalThis.__GAME__`
// escape hatch for its entire life.
ctx.pipeline.ctx = ctx;

// Ask the adapter what it is before any system reads `pipeline.quality` —
// Environment sizes its shadow map off it during init, and that is the most
// expensive single decision in the frame.
ctx.gpu = ctx.pipeline.detect({ pinned: pinnedQuality });

// Order matters: world before anything that queries it, presentation last.
// Artifacts is first of all: it owns no frame time, but Items, Director and
// Interactables all consult it and `ctx.difficulty` has to exist before the
// Director derives its first coefficient in `init`.
engine.add(new Artifacts());
engine.add(new Environment());
engine.add(new Stage());
engine.add(new Items());
engine.add(new Combat());
engine.add(new Player());
engine.add(new Director());
engine.add(new Progression());
engine.add(new VFX());
engine.add(new Audio());
engine.add(new CameraRig());
// Co-op glue before the UI: Menus reads `ctx.lobby` the moment someone opens
// the co-op screen, and Coop must be able to answer NetHost's pawn request
// from the first peer that connects.
engine.add(new Coop());
engine.add(new HUD());

// The lobby is not a system — it owns no frame time and only exists so the UI
// has something to drive. Single-player never touches it.
ctx.lobby = new Lobby(engine, ctx);

ctx.pipeline.build(ctx.scene, ctx.camera);

// Renderer runs as the final "system" so it sees the fully updated frame.
engine.add({
  lateUpdate(c, dt) {
    ctx.pipeline.render(c.scene, c.camera, dt);
    c.input.endFrame();
  },
});

addEventListener('resize', () => {
  ctx.camera.aspect = innerWidth / innerHeight;
  ctx.camera.updateProjectionMatrix();
  ctx.pipeline.resize();
});
ctx.camera.aspect = innerWidth / innerHeight;
ctx.camera.updateProjectionMatrix();

engine.start();

// Only after the first frame is scheduled — the banner is advice, not a gate.
// Suppressed under the harness so it can never land in a capture.
if (!params.has('harness')) maybeShowGpuNotice(ctx.gpu);

// Exposed for the Playwright screenshot harness (deterministic captures).
globalThis.__GAME__ = { engine, ctx, THREE, seed };

if (params.has('harness')) {
  const { installHarness } = await import('./core/Harness.js');
  installHarness(ctx);
}
