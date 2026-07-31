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
import { Director } from './systems/Director.js';
import { Progression } from './systems/Progression.js';
import { VFX } from './systems/VFX.js';
import { Audio } from './systems/Audio.js';
import { HUD } from './ui/HUD.js';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || (Math.random() * 0xffffffff) >>> 0;
const quality = params.has('quality') ? Number(params.get('quality')) : QUALITY.HIGH;

const canvas = document.getElementById('viewport');
const engine = new Engine({ canvas, seed });
const ctx = engine.ctx;

ctx.input = new Input(canvas);
ctx.pipeline = new RenderPipeline(canvas, quality);

// Order matters: world before anything that queries it, presentation last.
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
engine.add(new HUD());

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

// Exposed for the Playwright screenshot harness (deterministic captures).
globalThis.__GAME__ = { engine, ctx, THREE, seed };

if (params.has('harness')) {
  const { installHarness } = await import('./core/Harness.js');
  installHarness(ctx);
}
