import { Group, InstancedMesh, Mesh, Points, PointLight } from 'three';
import { REALM_BY_ID } from '../../data/realms.js';
import { RealmStage } from './RealmStage.js';
import { buildArena } from './RealmArena.js';
import { warmPropSet } from './RealmProps.js';

/**
 * Build a realm before anyone walks into it (#183).
 *
 * ## What the stall actually was
 *
 * Entering a realm cost ~4.7 s on the entry frame, and almost none of it was
 * the arena: `buildArena` measures 5 ms. The bill was in two places, both of
 * them the reflection probe.
 *
 *  - `Environment.bakeProbe` — six cube faces of a 4 km-distant arena plus the
 *    PMREM roughness chain, ~1.1 s.
 *  - The first *draw* of the arena's thirteen-odd programs. A lit material's
 *    GLSL is compiled and linked the first time it is drawn, synchronously, on
 *    the render thread, and the realm's own probe is part of what those
 *    programs are keyed to — so the boot prewarm, which ran under the world's
 *    probe and against a different bound target, never covered them. 3.6-4.7 s
 *    on ANGLE/D3D11.
 *
 * Entering the same realm a *second* time cost 32 ms, which is the proof that
 * there is nothing here but cold caches.
 *
 * ## What this does instead
 *
 * A realm announces itself long before it is taken: `realmOffer` fires when the
 * door spawns, and the party then has to walk to it. That walk is the budget.
 * On the offer we
 *
 *   1. build the arena **parked** — constructed but deliberately not in the
 *      scene graph, because an arena that is merely *drawable* at
 *      `REALM_ORIGIN_X` costs a measured fourteen-second frame;
 *   2. bake its probe in a scene of our own (`Environment.bakeDetachedProbe`),
 *      so the world never wears realm air for even one frame; and
 *   3. `compileAsync` the arena's materials against that probe, with the
 *      composer's target bound — the two things the boot prewarm got wrong.
 *
 * Each of those is its own frame's work, one step per frame.
 *
 * ## What was still cold afterwards (#192)
 *
 * That left 3-4 s and eight programs, and the eight were the giveaway: their
 * keys matched warmed ones except in the packed per-object booleans. They did
 * not belong to the arena at all. A realm hides two things — the terrain and
 * the world prop group — and goes on drawing everything else the player could
 * already see, at a point-light count the arena has just raised. The world's
 * own interactables were the cold ones, and no warm pointed at the arena could
 * ever have reached them. `WarmCatalogue` below is the answer: the posed live
 * scene goes into the compile alongside the arena, as the real objects rather
 * than as reconstructions of them. Measured on the entry frame's own render,
 * per realm: crucible 2896 -> 14 ms, vault 3799 -> 16, market 4019 -> 18,
 * fracture 4202 -> 20.
 *
 * ### What it costs, which is not nothing
 *
 * The warm now hands three materials the world is *currently drawing*, at a
 * light count the world is not drawing them at, and three's program cache does
 * not love that: a program acquired for the realm count and then not used can
 * be released and re-linked when the next real frame asks for the world count.
 * That surfaces as occasional long warm frames, and it is realm-shaped —
 * crucible and vault and market stay at or under 50 ms, but the fracture, which
 * is the heaviest VFX scene of the four, threw five frames up to 262 ms where
 * before it threw none over 22. Five dropped frames spread across the walk
 * against a four-second freeze on the frame the player presses E is the right
 * side of the trade, but it is a real cost and #192's follow-up is to stop the
 * cache thrashing rather than to spread it further: chunking the live half
 * across frames and overlapping the compiles were both tried and both made it
 * worse (588 ms at four chunks), because more passes in flight is more chances
 * for a walking frame to find a program mid-link.
 *
 * Entry then adopts what is standing: `attach()` the parked root, assign the
 * stored probe instead of baking one. Nothing else about entry moves — the
 * world still stays standing, entry is still deferred one fixed step, and
 * `realmEnter`/`realmExit` are unchanged.
 *
 * ## Host only, for now
 *
 * `realmOffer` is emitted host-side (see `NetHost`), so a client entering a
 * replicated realm still pays the cold price. Telling a client a door exists is
 * new protocol, so it is deliberately out of scope here.
 */
/**
 * How many point-light counts to warm, starting at the posed one.
 *
 * The count of visible point lights is in every lit program's cache key, and
 * the arena's are not all of them: `controller.enter` spawns the realm's own
 * props — an exit portal, a plinth, a chest — and those carry lights of their
 * own that go into the scene rather than under the arena's root, *after* the
 * warm has finished. Measured, the crucible poses at nine and draws at ten.
 *
 * Predicting that number means teaching this file what every controller
 * spawns, which is a coupling that would rot silently. Warming a short spread
 * above the posed count covers it instead: four is one program set per light a
 * controller might add, ~13 programs each, all compiled asynchronously while
 * the party is still walking. `VFX.LightPool` is what makes a *short* spread
 * enough — its lights live in the scene permanently at intensity zero rather
 * than being toggled, so the world's own count does not drift underneath us.
 */
const LIGHT_SPREAD = 4;

/**
 * Walk `root` and its descendants, stopping at anything not being drawn.
 *
 * `visible` is the pose: `_compile` hides the world's terrain and prop group
 * exactly as entry will, so a walk that honours it yields precisely the set of
 * objects the entry frame still draws — and, just as importantly, does not warm
 * the terrain at a realm light count no frame will ever ask for.
 */
function traverseDrawn(root, cb) {
  if (!root.visible) return;
  cb(root);
  for (const c of root.children) traverseDrawn(c, cb);
}

/**
 * The catalogue three is asked to compile: the arena and its props, *plus* the
 * live scene as the entry frame will still be drawing it.
 *
 * That second half is what #192 was. A realm does not replace the world's
 * contents, it hides two of them — the terrain mesh and the world prop group —
 * and everything else the player was looking at a moment ago is still drawn
 * inside the arena: the interactables root with its teleporter and its shrines,
 * the VFX roots, the sky. Every one of those is a lit material, the realm's
 * point-light count is in its program key, and the count goes up by the arena's
 * braziers the instant `attach` happens. So they are *cold*, all of them, and
 * no amount of warming aimed at the arena reaches them: measured, three world
 * surfaces and one double-sided one, 2.85 s of the 2.9 s entry frame, owned by
 * objects the warm had never heard of.
 *
 * Reaching them by hand is the trap. A reconstruction of a live object is only
 * ever a guess at the object parameters in its key — instancing, skinning,
 * morph counts, `receiveShadow` — and #192's whole diagnosis was warm keys that
 * missed by one packed boolean. So the warm hands three the real objects
 * instead, and the way it does that without moving a single one of them out of
 * the scene they belong to is this class: `compile` reaches a scene through
 * exactly two doors, `traverseVisible` for lights and `traverse` for materials,
 * and this is an ordinary `Group` that answers the second one for the live
 * scene as well as for itself.
 *
 * The asymmetry between the two overrides is deliberate and is the
 * double-count trap the file's `_compile` comment records: `compile` already
 * gathers lights from its *target* scene, which is the live scene, so a
 * `traverseVisible` that offered them again would count every world light
 * twice and warm a set of keys nothing will ever draw.
 */
class WarmCatalogue extends Group {
  constructor() {
    super();
    this.name = 'realm-warm-catalogue';
    /** The posed live scene, walked for materials only. */
    this.liveRoot = null;
  }

  traverse(cb) {
    super.traverse(cb);
    if (this.liveRoot) traverseDrawn(this.liveRoot, cb);
  }
}

export class RealmWarm {
  constructor(ctx) {
    this.ctx = ctx;
    /** id -> { def, stage, rt, step, error } */
    this.records = new Map();
    this._busy = false;
  }

  /** A door has spawned. Start warming, once. */
  offer(id) {
    if (this.records.has(id)) return;
    if (!REALM_BY_ID.has(id)) return;
    if (!this.ctx.pipeline?.renderer) return; // headless: nothing to warm
    this.records.set(id, {
      def: REALM_BY_ID.get(id), stage: null, rt: null, step: 'build',
      spread: 0,
    });
  }

  /** Whether `id` is fully warm. Diagnostics and tests read this. */
  ready(id) { return this.records.get(id)?.step === 'ready'; }

  /**
   * One unit of work, at most, per call. Driven from `Realms.update`, so the
   * cost lands on frames the player is spending walking rather than on the
   * frame they press E.
   */
  step() {
    if (this._busy || this.ctx.realms?.inRealm) return;
    for (const rec of this.records.values()) {
      if (rec.step === 'ready' || rec.step === 'failed') continue;
      this._advance(rec);
      return;
    }
  }

  _advance(rec) {
    try {
      if (rec.step === 'build') {
        rec.stage = new RealmStage(this.ctx, rec.def, { parked: true });
        buildArena(rec.stage);
        rec.step = 'bake';
        return;
      }
      if (rec.step === 'bake') {
        rec.rt = this.ctx.environment?.bakeDetachedProbe?.(
          rec.def.air, rec.stage.root, rec.stage.origin);
        rec.step = rec.rt ? 'props' : 'ready';
        return;
      }
      if (rec.step === 'props') {
        // One set for the whole stage, not one per door: the prop classes are
        // shared across realms and their programs are shared by cache key.
        this._props ??= warmPropSet(this.ctx, rec.stage.origin);
        rec.step = 'compile';
        return;
      }
      if (rec.step === 'compile') {
        const extra = rec.spread;
        rec.spread++;
        rec.step = 'compiling';
        this._busy = true;
        this._compile(rec, extra).finally(() => {
          this._busy = false;
          if (rec.step !== 'compiling') return;
          rec.step = rec.spread < LIGHT_SPREAD ? 'compile' : 'ready';
        });
      }
    } catch (e) {
      // A cold entry is slow, not broken. Warming is an optimisation and is
      // never allowed to be the reason a realm cannot be entered.
      rec.step = 'failed';
      rec.error = e;
      console.warn('[realm-warm] gave up warming', rec.def.id, e);
    }
  }

  /**
   * Compile the arena's programs under the conditions the entry frame will
   * actually draw them in.
   *
   * Two of those conditions are easy to get wrong and both were:
   *
   *  - **the probe.** `scene.environment` is read while the program is keyed,
   *    so compiling under the world's probe warms a set the realm never uses.
   *    It is swapped in and straight back out around the *synchronous* half of
   *    `compileAsync` — the half that creates the programs — with no render in
   *    between, so no frame is ever presented under a probe the world does not
   *    own.
   *  - **the bound target.** Its colour space and tonemapping are in the cache
   *    key too, and scene geometry is only ever drawn into the composer's
   *    linear-HDR target. `RenderPipeline` does the same dance around the boot
   *    prewarm and for the same reason.
   *  - **the light count.** This is the one that cost two rounds, and the trap
   *    in it is worth writing down: `compile` gathers lights from the *target*
   *    scene **and again** from its first argument whenever the two differ. So
   *    putting the arena root into the scene "to get its braziers counted"
   *    counts them twice — measured `3,12` against the `3,10` entry draws —
   *    and every warmed program was thrown away. The root must stay out.
   *
   * So the compile is run with the scene *posed* as the entry frame will find
   * it — world terrain and props hidden, realm probe assigned, composer target
   * bound, arena left out for three's own double walk to find — and every one
   * of those is put back in the `finally`. No render happens in between, so no
   * frame is ever presented showing a world with its terrain missing, and the
   * arena is never in the scene at all until `attach` (a drawable arena at
   * `REALM_ORIGIN_X` is a measured fourteen-second frame).
   */
  _compile(rec, extraLights = 0) {
    const ctx = this.ctx;
    const pipe = ctx.pipeline;
    const renderer = pipe?.renderer;
    const scene = ctx.scene;
    const camera = ctx.camera;
    if (!renderer || !camera || !rec.rt) return Promise.resolve();

    const world = ctx.stage;
    let cat = null;
    const prevTarget = renderer.getRenderTarget();
    const prevEnv = scene.environment;
    const prevTerrain = world?.terrainMesh?.visible;
    const prevProps = world?.propsGroup?.visible;
    let promise;
    try {
      if (pipe.composer?.renderTarget1) renderer.setRenderTarget(pipe.composer.renderTarget1);
      scene.environment = rec.rt.texture;
      if (world?.terrainMesh) world.terrainMesh.visible = false;
      if (world?.propsGroup) world.propsGroup.visible = false;
      for (let i = 0; i < extraLights; i++) scene.add(this._stand(i));
      cat = this._catalogue(rec);
      cat.updateMatrixWorld(true);
      promise = renderer.compileAsync(cat, camera, scene);
    } finally {
      if (cat) this._releaseCatalogue(cat, rec);
      for (let i = 0; i < extraLights; i++) scene.remove(this._stand(i));
      if (world?.terrainMesh) world.terrainMesh.visible = prevTerrain;
      if (world?.propsGroup) world.propsGroup.visible = prevProps;
      scene.environment = prevEnv;
      renderer.setRenderTarget(prevTarget);
    }
    return promise;
  }

  /**
   * Everything the entry frame will draw for the first time, gathered into one
   * parentless group for `compileAsync` to harvest.
   *
   * Four things go in, and the last two are the ones that were missed:
   *
   *  - the arena root, borrowed from wherever it is parked;
   *  - one of every realm prop (`warmPropSet`), because `controller.enter`
   *    allocates its props at the moment of entry and their programs were
   *    still being compiled on the entry frame after the arena's were warm;
   *  - the posed live scene (`liveRoot`), which is everything the player was
   *    already looking at and will go on looking at from inside the arena. See
   *    `WarmCatalogue`: this was #192, and it was four fifths of the bill;
   *  - a proxy for every distinct geometry wearing GTAO's **normal-pass
   *    override material**, from both halves. `compile` only ever warms an
   *    object's *own* material, and the ambient-occlusion pass draws the whole
   *    scene again through `scene.overrideMaterial` — so those programs are
   *    invisible to any amount of warming aimed at materials, and they showed
   *    up at entry as `normal,...` keys nothing had asked for.
   *
   * The group is parentless: `compile` walks its first argument *and* the
   * target scene for lights, so putting this in the scene would count the
   * arena's braziers twice, and drawing it at `REALM_ORIGIN_X` is the
   * fourteen-second frame this whole file exists to avoid.
   */
  _catalogue(rec) {
    const cat = new WarmCatalogue();
    rec.catParent = rec.stage.root.parent;
    cat.add(rec.stage.root);
    for (const p of this._props ?? []) cat.add(p.group);
    // Everything the entry frame keeps drawing. See `WarmCatalogue`.
    cat.liveRoot = this.ctx.scene ?? null;


    const normalMat = this.ctx.pipeline?.passes?.gtao?.normalMaterial;
    if (normalMat) {
      const seen = new Set();
      const proxy = (o) => {
        if (!o.geometry || !(o.isMesh || o.isPoints)) return;
        // `receiveShadow` is an *object* parameter and it is in the cache key,
        // so one proxy per geometry is not enough — the same geometry drawn
        // shadowed and unshadowed is two programs. Keyed on both.
        const tag = `${o.geometry.uuid}|${o.receiveShadow ? 1 : 0}|${o.castShadow ? 1 : 0}|${o.isPoints ? 'p' : 'm'}`;
        if (seen.has(tag)) return;
        seen.add(tag);
        // Instancing is a define, so an InstancedMesh needs an instanced proxy
        // or the warmed program is the one the pass will not use. So is being
        // a point cloud: the override pass draws `Points` too, and a `Mesh`
        // proxy over the same geometry warms the wrong program.
        const m = o.isPoints
          ? new Points(o.geometry, normalMat)
          : o.isInstancedMesh
            ? new InstancedMesh(o.geometry, normalMat, 1)
            : new Mesh(o.geometry, normalMat);
        m.receiveShadow = o.receiveShadow;
        m.castShadow = o.castShadow;
        m.frustumCulled = false;
        cat.add(m);
      };
      // Both halves: the arena's own meshes, and the live ones that stay drawn.
      // The override pass redraws the *whole* scene, so a live object is as
      // cold in it as an arena one.
      for (const child of [...cat.children]) child.traverse(proxy);
      if (cat.liveRoot) traverseDrawn(cat.liveRoot, proxy);
    }
    return cat;
  }

  /** Put the borrowed roots back and drop the proxies. */
  _releaseCatalogue(cat, rec) {
    cat.remove(rec.stage.root);
    if (rec.catParent) rec.catParent.add(rec.stage.root);
    for (const p of this._props ?? []) cat.remove(p.group);
    cat.liveRoot = null;
    cat.clear();
  }

  /**
   * A stand-in for one light a realm controller has not spawned yet. Zero
   * intensity and no position: only its *existence* is in the cache key, and
   * it is only ever in the scene for the length of one synchronous compile.
   */
  _stand(i) {
    this._stands ??= [];
    if (!this._stands[i]) {
      const l = new PointLight(0xffffff, 0, 20, 2);
      l.castShadow = false;
      l.name = 'realm-warm-stand-in';
      this._stands[i] = l;
    }
    return this._stands[i];
  }

  /**
   * Hand the warm arena over to `_enter`, and forget it: from here the stage
   * and its probe belong to the realm, and disposing them is the exit's job.
   */
  take(id) {
    const rec = this.records.get(id);
    if (!rec || rec.step === 'failed' || !rec.stage) return null;
    this.records.delete(id);
    return rec;
  }

  /**
   * Throw away anything still standing — a new stage, or the run ending.
   *
   * The prop set outlives `take()` on purpose and is only released here. Its
   * whole job is to hold the entry frame's programs in three's cache until the
   * real props exist to reference them; disposing it at entry would free the
   * program a moment before the thing it was warmed for asks for it. A stage is
   * the right bound — #137's warning about realm materials pinning 4K maps for
   * the session applies to anything kept longer.
   */
  clear() {
    for (const rec of this.records.values()) {
      rec.stage?.dispose();
      rec.rt?.dispose();
    }
    this.records.clear();
    for (const p of this._props ?? []) p.dispose?.();
    this._props = null;
  }
}
