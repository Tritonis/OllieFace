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
import { Codex } from './systems/Codex.js';
import { Realms } from './world/realms/Realms.js';
import { VFX } from './systems/VFX.js';
import { Audio } from './systems/Audio.js';
import { HUD } from './ui/HUD.js';
import { Menus } from './ui/Menus.js';
import { Coop } from './net/Coop.js';
import { Lobby } from './net/Lobby.js';
import { maybeShowGpuNotice } from './ui/GpuNotice.js';
import { installFatalOverlay } from './ui/FatalOverlay.js';
import { installSystemNotice } from './ui/SystemNotice.js';
import { installTelemetry } from './systems/Telemetry.js';
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

// First thing after the bus exists, and before anything that can fail is asked
// to run. This used to sit below the registrations, which made it true but
// useless for the failure it most needed to catch: a system throwing in `init`
// aborted module evaluation right here, so the subscription was never made and
// the player got a blank page rather than an account of it. Everything below is
// now inside the overlay's reach.
installFatalOverlay(ctx);
// Its noncritical counterpart, and subscribed in the same breath for the same
// reason: a system whose `init` fails repeatedly, or which wedges on frame one,
// must find a listener already there. A disabled system is survivable but never
// invisible — the player is told which one went and that the run continues.
installSystemNotice(ctx);

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
// After Progression, which owns `ctx.profile` — the codex writes its pages
// there and has nowhere to put them until it exists. Owns no frame time and
// changes nothing about the run: it only watches the bus and records what the
// player has already been shown.
engine.add(new Codex());
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
// Before HUD, and that ordering is load-bearing in both directions. The Menus
// *constructor* publishes `ctx.settings`, which HUD's Announcer and Tutorial
// read during HUD's own `init` — so Menus has to be built first. It reaches no
// further forward than that: it owns `#overlay` rather than anything HUD's init
// writes, and it consults `ctx.lobby` (created below) only when someone opens
// the co-op screen. Registered rather than owned by HUD since #118, so a menu
// that throws is billed to Menus and disabling it leaves the HUD drawing.
engine.add(new Menus(ctx));
engine.add(new HUD());

// The lobby is not a system — it owns no frame time and only exists so the UI
// has something to drive. Single-player never touches it.
ctx.lobby = new Lobby(engine, ctx);

// Assembling the passes is boot work that belongs to no system, so neither
// `Engine.add` nor `_call` covers it — but it fails in the same window as an
// `init` does and deserves the same account of itself. Critical: a pipeline
// that never assembled draws nothing, ever, which is not a degraded frame.
try {
  ctx.pipeline.build(ctx.scene, ctx.camera);
} catch (e) {
  engine.fail('RenderPipeline.build', e);
}

// Renderer runs as the final "system" so it sees the fully updated frame.
engine.add({
  // Drawing the frame, and only that. A lost frame is not a lost run, so this
  // stays on the continue-through-it side of the rule.
  //
  // Closing out input used to happen here too, in a `finally` so a throw from
  // `render` could not skip it. It now belongs to the Engine's frame epilogue
  // (`Engine._endFrame`), because a `finally` only protects `endFrame` from an
  // exception and not from this whole system being dropped: the renderer is
  // noncritical and registered, so six wedged frames disable it, and the only
  // call to `endFrame` in `src/` went with it — every key held since reading as
  // pressed for the rest of the run.
  critical: false,
  lateUpdate(c, dt) {
    ctx.pipeline.render(c.scene, c.camera, dt);
  },
});

addEventListener('resize', () => {
  ctx.camera.aspect = innerWidth / innerHeight;
  ctx.camera.updateProjectionMatrix();
  ctx.pipeline.resize();
});
ctx.camera.aspect = innerWidth / innerHeight;
ctx.camera.updateProjectionMatrix();

// The run record (issue #29). Deliberately not `engine.add`ed: it owns no frame
// time and, more to the point, a system is a thing `Engine._call` can halt the
// run over. As a plain event subscriber it stands nowhere that path can reach.
// Off unless the player has turned it on in Settings, in which case this
// returns having subscribed to nothing at all.
installTelemetry(ctx);

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
