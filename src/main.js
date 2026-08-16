import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { RenderPipeline, QUALITY } from './core/RenderPipeline.js';
import { Input } from './core/Input.js';
import { Stage } from './world/Stage.js';
import { Environment } from './world/Environment.js';
import { Player } from './entities/Player.js';
import { CameraRig } from './core/CameraRig.js';
import { Combat } from './systems/Combat.js';
import { Corruption } from './systems/Corruption.js';
import { Blight } from './systems/Blight.js';
import { Roster } from './systems/Roster.js';
import { Revive } from './systems/Revive.js';
import { Items } from './systems/Items.js';
import { Artifacts } from './systems/Artifacts.js';
import { Director } from './systems/Director.js';
import { Progression } from './systems/Progression.js';
import { Realms } from './world/realms/Realms.js';
import { VFX } from './systems/VFX.js';
import { Audio } from './systems/Audio.js';
import { HUD } from './ui/HUD.js';
import { Coop } from './net/Coop.js';
import { Lobby } from './net/Lobby.js';
import { maybeShowGpuNotice } from './ui/GpuNotice.js';
import { initDesktopStore } from './core/DesktopStore.js';
import { showSaveFailure, clearSaveFailure } from './ui/SaveIndicator.js';

// Before anything reads storage: under the Electron shell this hydrates
// localStorage from the save file and installs the write mirror. In the
// browser there is no bridge and it returns inert.
//
// The status callback is the whole of the save-failure UI's wiring: the store
// knows when a write did not land, and the indicator is the only thing that
// tells the player. In the browser neither ever runs.
initDesktopStore(undefined, undefined, {
  onSaveStatus: ({ ok, reason }) => { if (ok) clearSaveFailure(); else showSaveFailure(reason); },
});

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
// No frame hooks of its own — it only has to exist before Items and
// Interactables charge a tithe against it, and before HUD polls `ctx.corruption`.
engine.add(new Corruption());
// Purely presentational, and it only reacts to events Corruption emits, so
// update order against it is irrelevant — it sits here because the pairing is
// the thing worth reading.
engine.add(new Blight());
// Before Player, which registers itself into it during `init` — the same
// ordering reason Combat sits above.
engine.add(new Roster());
engine.add(new Player());
// After Player, whose `fixedUpdate` writes this tick's command onto every pawn
// the host simulates (the hold Revive's scan reads) and moves them to the
// positions it measures. Before Progression, which pumps `Interactables` — the
// interact press has to be claimed as a revive before a chest can spend it.
engine.add(new Revive());
engine.add(new Director());
engine.add(new Progression());
// After Progression, which owns the stage flow it hooks into and the
// Interactables list its gateways and market stalls live in.
engine.add(new Realms());
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
  // The realm/finale scenarios hang off the same `__HARNESS__` object and are
  // driven by tools/capture-realms.mjs. They live in the realms directory
  // rather than in Harness.js so the two sets can be worked on independently.
  const { installRealmHarness } = await import('./world/realms/RealmHarness.js');
  installRealmHarness(ctx);
}
