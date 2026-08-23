import { Group, InstancedMesh, Mesh, PointLight } from 'three';
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
 * Each of those is its own frame's work: three steps, one per frame, never two
 * at once.
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
    this.records.set(id, { def: REALM_BY_ID.get(id), stage: null, rt: null, step: 'build', spread: 0 });
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
   * Three things go in, and the third is the one that is easy to miss:
   *
   *  - the arena root, borrowed from wherever it is parked;
   *  - one of every realm prop (`warmPropSet`), because `controller.enter`
   *    allocates its props at the moment of entry and their programs were
   *    still being compiled on the entry frame after the arena's were warm;
   *  - a proxy for every distinct geometry wearing GTAO's **normal-pass
   *    override material**. `compile` only ever warms an object's *own*
   *    material, and the ambient-occlusion pass draws the whole scene again
   *    through `scene.overrideMaterial` — so those programs are invisible to
   *    any amount of warming aimed at the arena's materials, and they showed up
   *    at entry as `normal,...` keys nothing had asked for.
   *
   * The group is parentless: `compile` walks its first argument *and* the
   * target scene for lights, so putting this in the scene would count the
   * arena's braziers twice, and drawing it at `REALM_ORIGIN_X` is the
   * fourteen-second frame this whole file exists to avoid.
   */
  _catalogue(rec) {
    const cat = new Group();
    cat.name = 'realm-warm-catalogue';
    rec.catParent = rec.stage.root.parent;
    cat.add(rec.stage.root);
    for (const p of this._props ?? []) cat.add(p.group);

    const normalMat = this.ctx.pipeline?.passes?.gtao?.normalMaterial;
    if (normalMat) {
      const seen = new Set();
      const proxy = (o) => {
        if (!o.isMesh || !o.geometry) return;
        // `receiveShadow` is an *object* parameter and it is in the cache key,
        // so one proxy per geometry is not enough — the same geometry drawn
        // shadowed and unshadowed is two programs. Keyed on both.
        const tag = `${o.geometry.uuid}|${o.receiveShadow ? 1 : 0}|${o.castShadow ? 1 : 0}`;
        if (seen.has(tag)) return;
        seen.add(tag);
        // Instancing is a define, so an InstancedMesh needs an instanced proxy
        // or the warmed program is the one the pass will not use.
        const m = o.isInstancedMesh
          ? new InstancedMesh(o.geometry, normalMat, 1)
          : new Mesh(o.geometry, normalMat);
        m.receiveShadow = o.receiveShadow;
        m.castShadow = o.castShadow;
        m.frustumCulled = false;
        cat.add(m);
      };
      for (const child of [...cat.children]) child.traverse(proxy);
    }
    return cat;
  }

  /** Put the borrowed roots back and drop the proxies. */
  _releaseCatalogue(cat, rec) {
    cat.remove(rec.stage.root);
    if (rec.catParent) rec.catParent.add(rec.stage.root);
    for (const p of this._props ?? []) cat.remove(p.group);
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
