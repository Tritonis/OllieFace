// Deterministic RNG + small math helpers shared by every system.
// A single seeded stream keeps runs reproducible for screenshot regression.

export class RNG {
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  // xorshift32 — fast, good enough for gameplay, fully deterministic.
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  // Weighted pick over [{ weight }] entries.
  weighted(arr, weightOf = (e) => e.weight) {
    let total = 0;
    for (const e of arr) total += weightOf(e);
    let r = this.next() * total;
    for (const e of arr) {
      r -= weightOf(e);
      if (r <= 0) return e;
    }
    return arr[arr.length - 1];
  }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);

// Framerate-independent exponential smoothing. `rate` = how much of the gap
// closes per second (0.99 => 99% per second).
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.pow(1 - rate, dt));
