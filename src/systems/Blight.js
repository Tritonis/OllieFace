// src/systems/Blight.js
import * as THREE from 'three';

/**
 * Blight fields — the visible consequence of greed. Corruption records where
 * greed happened (`blightSeed`); this system grows a corrupted ground patch
 * at each seed, sized by the seed's strength and the party's World Corruption.
 *
 * Strictly presentation. Gameplay never reads blight; Corruption never knows
 * it is drawn. All variation comes off ctx.fxRng — a patch is cosmetic, and a
 * cosmetic draw on the shared stream would desync every later loot roll.
 */
export const MAX_PATCHES = 48;
export const RADIUS = { base: 2.0, perStrength: 1.5, perWorld: 0.04, cap: 14 };

export function radiusOf(strength, world) {
  return Math.min(RADIUS.base + RADIUS.perStrength * strength + RADIUS.perWorld * world, RADIUS.cap);
}

export class Blight {
  constructor() {
    this.patches = [];
    this.band = 0;
    this.ctx = null;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.blight = this;
    ctx.events.on('blightSeed', (s) => this._addPatch(s));
    ctx.events.on('corruptionBand', ({ band }) => { this.band = band; });
    ctx.events.on('stageStart', () => this._clear());
  }

  _addPatch({ x, z, strength }) {
    const patch = {
      x, z, strength,
      // Phase offset for the crawl shader — per-patch so a field of patches
      // never pulses in unison. Cosmetic, so fxRng.
      seedNoise: this.ctx.fxRng.range(0, 100),
      maxR: RADIUS.cap,
      mesh: null,
    };
    this.patches.push(patch);
    if (this.patches.length > MAX_PATCHES) this._recycle(this.patches.shift());
    this._build(patch);
  }

  _clear() {
    for (const p of this.patches) this._recycle(p);
    this.patches.length = 0;
  }

  // Mesh lifecycle lands in Task 2 — the registry is real either way.
  _build(patch) {}
  _recycle(patch) {}
}
