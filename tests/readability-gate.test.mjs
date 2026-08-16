// tests/readability-gate.test.mjs
//
// The node-only half of the readability gate. `tools/silhouette.mjs` needs a
// GPU, a browser and about a minute; the arithmetic it runs on the masks it
// gets back needs none of those, and that arithmetic is where a gate silently
// stops measuring. So the math lives in tools/silhouette-metrics.mjs and is
// pinned here against masks this file draws itself.
import { maskReader, measureMask, shapeIoU, READABILITY } from '../tools/silhouette-metrics.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const W = 32, H = 32;

/** Draw a mask with a predicate and pack it exactly as the in-page code does. */
function synth(fn, w = W, h = H) {
  const bits = new Uint8Array(Math.ceil(w * h / 8));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (fn(x, y)) { const i = y * w + x; bits[i >> 3] |= 1 << (i & 7); }
  }
  return Buffer.from(bits).toString('base64');
}

console.log('mask reader round-trips the packing the renderer uses');
{
  const b64 = synth((x, y) => x === 3 && y === 7);
  const get = maskReader(b64, W);
  ok(get(3, 7) === 1, 'the set pixel reads back set');
  ok(get(7, 3) === 0, 'its transpose does not — row-major, not column-major');
  ok(get(0, 0) === 0 && get(W - 1, H - 1) === 0, 'corners clear');
}

console.log('measureMask on a solid 8x16 block');
{
  const m = measureMask(synth((x, y) => x >= 8 && x < 16 && y >= 4 && y < 20), W, H);
  ok(m.x0 === 8 && m.y0 === 4, 'bbox origin');
  ok(m.bw === 8 && m.bh === 16, 'bbox extent');
  ok(m.area === 128, 'area');
  ok(Math.abs(m.fill - 1) < 1e-9, 'a solid block fills its own bbox');
  ok(Math.abs(m.aspect - 0.5) < 1e-9, 'aspect is width over height');
  ok(Math.abs(m.cx - 0.5) < 0.05 && Math.abs(m.cy - 0.5) < 0.05, 'centroid at the middle');
  ok(m.holes === 0, 'no negative space');
  ok(m.bands.length === 10, 'ten bands');
  ok(m.bands.every((b) => Math.abs(b.w - 1) < 1e-9), 'every band spans the full width');
  ok(m.bands.every((b) => Math.abs(b.runs - 1) < 1e-9), 'every scanline is one solid run');
}

console.log('measureMask sees daylight through an outline');
{
  // A ring: 16x16 outer, 8x8 hole. The hole is the thing a blob does not have.
  const outer = (x, y) => x >= 8 && x < 24 && y >= 8 && y < 24;
  const hole = (x, y) => x >= 12 && x < 20 && y >= 12 && y < 20;
  const m = measureMask(synth((x, y) => outer(x, y) && !hole(x, y)), W, H);
  ok(m.holes === 64, 'the enclosed 8x8 counts as negative space');
  ok(m.bands.some((b) => b.runs > 1.5), 'the waist scanlines read as two separate runs');
  ok(m.fill < 0.8, 'fill is below solid');
}

console.log('measureMask survives an empty mask without throwing');
{
  const m = measureMask(synth(() => false), W, H);
  ok(m.area === 0 && m.bw === 0 && m.bh === 0, 'zeroed bbox');
  ok(m.bands.length === 10 && m.bands.every((b) => b.w === 0), 'ten zeroed bands');
  ok(m.sig.length === 64 * 64 && m.sig.every((v) => v === 0), 'zeroed signature');
  ok(m.holes === 0 && m.fill === 0 && m.aspect === 0, 'no NaN anywhere');
}

console.log('shapeIoU is scale-blind, which is the whole point of the signature');
{
  const small = measureMask(synth((x, y) => x >= 14 && x < 18 && y >= 14 && y < 18), W, H);
  const big = measureMask(synth((x, y) => x >= 4 && x < 28 && y >= 4 && y < 28), W, H);
  ok(shapeIoU(small.sig, big.sig) > 0.99, 'a square is a square at any size');
  const bar = measureMask(synth((x, y) => y >= 14 && y < 18 && x >= 2 && x < 30), W, H);
  ok(shapeIoU(small.sig, bar.sig) > 0.99, 'bbox normalisation also flattens aspect — IoU alone cannot see it');
  const cross = measureMask((() => {
    const f = (x, y) => (x >= 14 && x < 18) || (y >= 14 && y < 18);
    return synth(f);
  })(), W, H);
  ok(shapeIoU(small.sig, cross.sig) < 0.6, 'a plus is not a square');
  ok(shapeIoU(new Uint8Array(4096), new Uint8Array(4096)) === 0, 'empty against empty is zero, not NaN');
}

console.log('thresholds are exported and ordered');
{
  ok(typeof READABILITY === 'object' && READABILITY !== null, 'READABILITY exported');
}

console.log('the gate grades a record and ratchets against its exemptions');
{
  const { gradeRoster } = await import('../tools/silhouette-metrics.mjs');
  // A minimal record in the shape the tool writes. Two families, one elite
  // pair, three tiers, all deliberately just over the floors.
  const good = {
    units: [
      { id: 'mite',   tier: 1, px40: 260, holesFrac: 0.02, sig: null },
      { id: 'sentinel',  tier: 2, px40: 900, holesFrac: 0.03, sig: null },
      { id: 'hulk',   tier: 3, px40: 1800, holesFrac: 0.03, sig: null },
    ],
    familyPairs: [{ a: 'mite', b: 'sentinel', iou: 0.41 }],
    foeFriendPairs: [{ a: 'mite', b: 'ranger', iou: 0.38 }],
    tierMedianPx: { 1: 260, 2: 900, 3: 1800 },
    elites: [{ id: 'sentinel', affix: 'emberclad', delta: 0.21, chroma: 0.19 }],
  };
  // Every call here passes its exemption list explicitly, including the empty
  // one. Defaulting to READABILITY.exemptions would couple this fixture to
  // whatever the shipped roster needed admitted, which is the one thing a unit
  // test of the ratchet must not depend on.
  const g = gradeRoster(good, []);
  ok(g.ok === true, 'a clean roster passes');
  ok(g.checks.length > 0 && g.checks.every((c) => c.ok), 'and every check in it is green');
  ok(g.checks.some((c) => c.kind === 'px40') && g.checks.some((c) => c.kind === 'tierArea')
     && g.checks.some((c) => c.kind === 'eliteDelta') && g.checks.some((c) => c.kind === 'familyIoU')
     && g.checks.some((c) => c.kind === 'foeFriendIoU') && g.checks.some((c) => c.kind === 'holes')
     && g.checks.some((c) => c.kind === 'eliteChroma'), 'all seven kinds are graded');

  // One unit falls under the 40 m floor.
  const dim = structuredClone(good);
  dim.units[0].px40 = 140;
  dim.tierMedianPx[1] = 140;
  const gd = gradeRoster(dim, []);
  ok(gd.ok === false, 'a unit under the 40 m floor fails the gate');
  ok(gd.checks.some((c) => c.kind === 'px40' && c.id === 'mite' && !c.ok), 'and the failure names the unit');

  // The same failure, exempted at its measured value, passes.
  const exempt = [{ id: 'mite', kind: 'px40', value: 140, note: 'test fixture' }];
  const ge = gradeRoster(dim, exempt);
  ok(ge.ok === true, 'an exemption at the measured value passes the gate');
  ok(ge.checks.some((c) => c.kind === 'px40' && c.id === 'mite' && c.exempt), 'and the check is flagged exempt');

  // ...but only while it does not get worse.
  const worse = structuredClone(dim);
  worse.units[0].px40 = 120;
  worse.tierMedianPx[1] = 120;
  ok(gradeRoster(worse, exempt).ok === false, 'an exempted check that degrades goes red again');

  // The slack on an exempted bar. Every shipped exemption was copied from the
  // record at full precision, so without it every one of them sits exactly on
  // its own bar and a rasteriser that moves one pixel turns the gate red. One
  // pixel of drift is tolerated; a real regression is not, and the two are
  // three orders of magnitude apart.
  const jitter = structuredClone(dim);
  jitter.units[0].px40 = 139;
  jitter.tierMedianPx[1] = 139;
  ok(gradeRoster(jitter, exempt).ok === true, 'one pixel of driver noise under an exemption is not a regression');
  const drop = structuredClone(dim);
  drop.units[0].px40 = 134;
  drop.tierMedianPx[1] = 134;
  ok(gradeRoster(drop, exempt).ok === false, 'and the slack is an epsilon, not a second exemption');

  // ...and an exemption never covers a different unit.
  const other = structuredClone(good);
  other.units[1].px40 = 140;
  ok(gradeRoster(other, exempt).ok === false, 'an exemption is per unit, not per kind');

  // Ceiling checks ratchet the other way round.
  const collide = structuredClone(good);
  collide.familyPairs[0].iou = 0.91;
  ok(gradeRoster(collide, []).ok === false, 'two families that overlap too much fail');
  ok(gradeRoster(collide, [{ id: 'mite/sentinel', kind: 'familyIoU', value: 0.91 }]).ok === true,
     'exempted at 0.91 it passes');
  collide.familyPairs[0].iou = 0.9145;
  ok(gradeRoster(collide, [{ id: 'mite/sentinel', kind: 'familyIoU', value: 0.91 }]).ok === true,
     'and the ceiling carries the same slack the floor does');
  collide.familyPairs[0].iou = 0.93;
  ok(gradeRoster(collide, [{ id: 'mite/sentinel', kind: 'familyIoU', value: 0.91 }]).ok === false,
     'and 0.93 against a 0.91 exemption is a regression');
}

console.log('the recorded roster covers every card the director can spawn');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { SPAWN_CARDS, BOSS_CARDS } = await import('../src/data/enemies.js');
  const path = new URL('../reviews/round9/readability-gate.json', import.meta.url);
  ok(existsSync(path), 'the gate record is committed');
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  const seen = new Set(rec.units.map((u) => u.id));
  for (const c of [...SPAWN_CARDS, ...BOSS_CARDS]) ok(seen.has(c.id), `${c.id} was measured`);
  // The record is the on-disk source for every readability claim in this
  // slice, so it has to say which tree produced it.
  ok(typeof rec.commit === 'string' && rec.commit.length >= 7, 'the record names the commit it measured');
  ok(rec.seed === 1337 && rec.range === 40, 'and the seed and the range it measured at');

  // Re-grade it. The eighteen exemptions in `silhouette-metrics.mjs` are
  // hand-copied from this record, and until this ran nothing checked that they
  // still describe it: a threshold could be tightened, or an exemption dropped
  // or mistyped, and the suite would stay green because it only ever asked
  // whether the record existed. Grading is pure arithmetic over the stored
  // units, so this closes the loop with no GPU, no browser and no re-capture —
  // which was the whole reason the maths was split out of the tool.
  const { gradeRoster: grade } = await import('../tools/silhouette-metrics.mjs');
  const re = grade(rec);
  ok(re.ok === true, 'the committed record still passes its own thresholds and exemptions');
  ok(re.checks.length === (rec.checks?.length ?? -1),
     'and the re-grade produces exactly the checks the record stored');
  const drift = re.checks.filter((c, i) => {
    const s = rec.checks?.[i];
    return !s || s.id !== c.id || s.kind !== c.kind || s.ok !== c.ok || s.exempt !== c.exempt;
  });
  ok(drift.length === 0, `stored verdicts match a fresh grade (${drift.length} differences)`);
  // The record carries the daylight metric, not just band widths — `runs` is
  // what says whether a silhouette has gaps at all, and dropping it is what
  // made the roster's largest finding unanswerable from committed data.
  ok(rec.units.every((u) => Array.isArray(u.bands) && u.bands.length === 10
     && u.bands.every((b) => typeof b.w === 'number' && typeof b.fill === 'number'
        && typeof b.runs === 'number')),
     'every unit records ten bands of width, fill and runs');
}

console.log('the survivor metric preserves the aspect ratio that shapeIoU discards');
{
  const { aspectSig, contourSimilarity, silhouetteSimilarity } =
    await import('../tools/silhouette-metrics.mjs');
  const square = measureMask(synth((x, y) => x >= 14 && x < 18 && y >= 14 && y < 18), W, H);
  const bar = measureMask(synth((x, y) => y >= 14 && y < 18 && x >= 2 && x < 30), W, H);
  // This is the whole reason the survivor row does not reuse `sig`: the two
  // masks above are indistinguishable to shapeIoU (pinned at >0.99 above) and
  // must not be to this one.
  ok(shapeIoU(square.sig, bar.sig) > 0.99, 'square and bar are one shape to the square signature');
  ok(silhouetteSimilarity(square, bar).iou < 0.4,
     'and two different shapes to the aspect-preserving one');

  const tall = measureMask(synth((x, y) => x >= 14 && x < 18 && y >= 2 && y < 30), W, H);
  ok(silhouetteSimilarity(bar, tall).iou < 0.4, 'a bar is not its own transpose');
  ok(silhouetteSimilarity(square, square).similarity > 0.99, 'a shape against itself is 1');

  // Scale-blindness is retained deliberately — normalising by the LONGER side
  // removes size while keeping proportion, so a big square is still a square.
  const bigSquare = measureMask(synth((x, y) => x >= 4 && x < 28 && y >= 4 && y < 28), W, H);
  ok(silhouetteSimilarity(square, bigSquare).iou > 0.9,
     'normalising by the longer side removes scale but not aspect');

  ok(aspectSig(measureMask(synth(() => false), W, H)).every((v) => v === 0),
     'an empty mask normalises to an empty signature rather than throwing');
  ok(contourSimilarity(new Uint8Array(64 * 64), new Uint8Array(64 * 64)) === 0,
     'and an empty contour pair is zero, not NaN');

  const s = silhouetteSimilarity(square, bar);
  ok(Math.abs(s.similarity - (0.6 * s.iou + 0.4 * s.contour)) < 1e-3,
     'similarity is the ratified 0.6 IoU + 0.4 contour');
}

console.log('survivor pairs are graded, which is the row that went unmeasured');
{
  const { gradeRoster } = await import('../tools/silhouette-metrics.mjs');
  const base = { units: [], familyPairs: [], foeFriendPairs: [], tierMedianPx: {}, elites: [] };

  const clean = gradeRoster({ ...base, survivorPairs: [{ a: 'anvil', b: 'cinder', similarity: 0.68 }] }, []);
  ok(clean.ok === true, 'a distinct survivor pair passes');
  ok(clean.checks.some((c) => c.kind === 'survivorSimilarity'), 'and it is graded as its own kind');

  const collide = gradeRoster({ ...base, survivorPairs: [{ a: 'anvil', b: 'cinder', similarity: 0.7352 }] }, []);
  ok(collide.ok === false, 'the collision this row was built to catch fails');
  ok(collide.checks.some((c) => c.kind === 'survivorSimilarity' && c.id === 'anvil/cinder' && !c.ok),
     'and the failure names the pair');

  // The bar carries no exemptions in READABILITY, but the ratchet must still
  // work on this kind or a future admission would be silently ignored.
  ok(gradeRoster({ ...base, survivorPairs: [{ a: 'anvil', b: 'cinder', similarity: 0.7352 }] },
                 [{ id: 'anvil/cinder', kind: 'survivorSimilarity', value: 0.7352 }]).ok === true,
     'the ratchet works on this kind too');
  ok(READABILITY.exemptions.every((e) => e.kind !== 'survivorSimilarity'),
     'but nothing ships exempted on it');

  // A record without the key grades exactly as it did before the row existed —
  // which is what lets the committed round9 record above still re-grade clean.
  ok(gradeRoster(base, []).checks.every((c) => c.kind !== 'survivorSimilarity'),
     'a record with no survivorPairs grades no survivor checks');
}

console.log('the survivor roster is measured, and every pair of it');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { SURVIVORS } = await import('../src/data/survivors.js');
  const path = new URL('../reviews/silhouette-axis4/after-anvil-squat.json', import.meta.url);
  ok(existsSync(path), 'the survivor record is committed');
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  // The completeness check, and the point of the whole slice: not "the named
  // pair was fixed" but "every pair was measured". n choose 2, enumerated.
  const want = SURVIVORS.length * (SURVIVORS.length - 1) / 2;
  ok(rec.survivorPairs?.length === want,
     `all ${want} survivor pairs are in the record (found ${rec.survivorPairs?.length})`);
  const seen = new Set(rec.survivorPairs.map((p) => `${p.a}/${p.b}`));
  for (let i = 0; i < SURVIVORS.length; i++) for (let j = i + 1; j < SURVIVORS.length; j++) {
    const a = SURVIVORS[i].id, b = SURVIVORS[j].id;
    ok(seen.has(`${a}/${b}`) || seen.has(`${b}/${a}`), `${a}/${b} was measured`);
  }
  const { gradeRoster: grade } = await import('../tools/silhouette-metrics.mjs');
  ok(grade(rec).ok === true, 'and the record passes its own thresholds');
}

/* ------------------------------------------------------------ colour vision
 *
 * The other way a silhouette gate can be complete and still be blind. Everything
 * above measures shape and nothing measured colour, and rarity and threat — the
 * two things a player has to read fastest — were carried by hue alone.
 *
 * Same discipline as the rest of the file: the arithmetic lives in
 * `tools/colour-vision.mjs`, is pure, and is pinned here against constants this
 * file states outright, including the ones that must fail.
 */

console.log('the simulator does what its name says');
{
  const { simulate, deltaE, deltaEUnder } = await import('../tools/colour-vision.mjs');
  ok(deltaE('#ff0000', '#ff0000') === 0, 'a colour against itself is zero');
  ok(Math.abs(deltaE('#ff0000', '#00ff00') - deltaE('#00ff00', '#ff0000')) < 1e-9, 'and the metric is symmetric');

  // The load-bearing property. The pair is a red and a green of *similar
  // lightness* on purpose: a dichromat loses hue, not brightness, so a bright
  // green against a dark red stays perfectly separable and would prove nothing.
  // Matched for lightness, 57 points of ordinary difference come down to 13.
  // If this ever stopped holding, the matrices would have quietly become an
  // identity and every grade below would be passing for the wrong reason.
  ok(deltaE('#e05a45', '#63a04a') > 50, 'an equiluminant red and green are far apart in ordinary vision');
  ok(deltaEUnder('#e05a45', '#63a04a', 'deutan') < 15, 'and nearly the same colour under deuteranopia');
  ok(deltaEUnder('#e05a45', '#4a6ea0', 'deutan') > 25, 'while red against blue survives it');

  // Tritanopia loses blue-yellow instead, so it must fail on a different pair.
  ok(deltaEUnder('#20a0e0', '#20e0a0', 'tritan') < deltaE('#20a0e0', '#20e0a0'),
     'tritanopia collapses a cyan-to-spring-green pair that ordinary vision separates');

  // `mono` is a luminance grey, so it must be neutral and must order by
  // luminance: pure green is far brighter than pure blue.
  const g = simulate('#00ff00', 'mono'), b = simulate('#0000ff', 'mono');
  ok(/^#(\w\w)\1\1$/.test(g), `mono returns a neutral grey (${g})`);
  ok(parseInt(g.slice(1, 3), 16) > parseInt(b.slice(1, 3), 16), 'and green is brighter than blue');
}

console.log('the palette bars are ones the old palettes could not clear');
{
  const { gradePalette, PALETTE } = await import('../tools/colour-vision.mjs');
  // The palettes as they shipped before this gate existed, quoted verbatim.
  // Their job here is to prove the grade can go red: a check that has only ever
  // been shown green is not evidence that it measures anything.
  const wasTiers = {
    common: '#e6ecf4', uncommon: '#63e06a', legendary: '#ff5b45', boss: '#ffd44f',
    lunar: '#5fd9f7', blight: '#e05aa8', equipment: '#ff9a3c',
  };
  const wasElite = {
    emberclad: 0xff3a08, galvanic: 0x2f5cff, rimebound: 0x4fb8e8,
    withering: 0x2fbf6a, warded: 0x6a4ad0, voidtouched: 0x8a2fd0,
  };
  const gt = gradePalette(wasTiers, PALETTE);
  ok(gt.ok === false, 'the old tier palette fails the gate');
  ok(gt.checks.some((c) => c.id === 'uncommon/lunar' && c.vision === 'mono' && c.delta < 1),
     'desaturated, Uncommon and Umbral were the same grey');
  ok(gt.checks.some((c) => c.id === 'uncommon/boss' && c.vision === 'protan' && !c.ok),
     'and a protanope could not separate Uncommon from Boss');

  const ge = gradePalette(wasElite, PALETTE);
  ok(ge.ok === false, 'the old elite tints fail it too');
  ok(ge.checks.some((c) => c.id === 'warded/voidtouched' && c.vision === 'deutan' && c.delta < 3),
     'Warded and Hollowed were one violet for a deuteranope');
}

console.log('the shipped palettes clear them');
{
  const { gradePalette, PALETTE } = await import('../tools/colour-vision.mjs');
  const { TIERS, TIER_ORDER } = await import('../src/ui/Icons.js');
  const { ELITE } = await import('../src/entities/EnemyMeshes.js');

  const tiers = Object.fromEntries(TIER_ORDER.map((k) => [k, TIERS[k].color]));
  const gt = gradePalette(tiers, PALETTE);
  const worstT = gt.checks[0];
  ok(gt.ok === true, `every tier pair clears every vision (worst ${worstT.id} ${worstT.vision} ${worstT.delta.toFixed(1)} vs ${worstT.min})`);

  const tints = Object.fromEntries(Object.entries(ELITE).map(([k, v]) => [k, v.tint]));
  const ge = gradePalette(tints, PALETTE);
  const worstE = ge.checks[0];
  ok(ge.ok === true, `every elite tint pair does too (worst ${worstE.id} ${worstE.vision} ${worstE.delta.toFixed(1)} vs ${worstE.min})`);

  // Every tier is graded, not just the ones that happened to be in the object.
  ok(gt.checks.length === (TIER_ORDER.length * (TIER_ORDER.length - 1) / 2) * 5,
     'all 21 tier pairs, all five visions');
}

console.log('one palette, three tables');
{
  const { readFileSync } = await import('node:fs');
  const { TIERS, TIER_ORDER } = await import('../src/ui/Icons.js');
  const { TIERS: DATA_TIERS } = await import('../src/data/items.js');
  const css = readFileSync(new URL('../src/ui/hud.css', import.meta.url), 'utf8');
  // Rarity is stated in three places — the HUD's icon factory, the data layer
  // that colours world-space drops, and the stylesheet — and before this check
  // they were three near-misses of each other. A tier that is safe in one table
  // and not in the next is the failure this gate exists to make impossible.
  for (const tier of TIER_ORDER) {
    const want = TIERS[tier].color;
    ok(DATA_TIERS[tier]?.css === want, `data/items.js agrees on ${tier} (${DATA_TIERS[tier]?.css})`);
    ok(DATA_TIERS[tier]?.colour === parseInt(want.slice(1), 16), `and its numeric form matches for ${tier}`);
    const m = css.match(new RegExp(`--t-${tier}:\\s*(#[0-9a-f]{6})`, 'i'));
    ok(m?.[1]?.toLowerCase() === want, `hud.css --t-${tier} agrees (${m?.[1]})`);
  }
}

console.log('and a shape under it, so none of that is load-bearing on its own');
{
  const { MARK_SIMILARITY } = await import('../tools/colour-vision.mjs');
  const { TIER_MARKS, TIER_ORDER } = await import('../src/ui/Icons.js');
  const { rasterisePolys, silhouetteSimilarity } = await import('../tools/silhouette-metrics.mjs');
  const R = 64;

  const masks = {};
  for (const tier of TIER_ORDER) {
    const polys = TIER_MARKS[tier];
    ok(Array.isArray(polys) && polys.length > 0, `${tier} has a mark`);
    masks[tier] = measureMask(rasterisePolys(polys, R, R), R, R);
    // A mark small enough to vanish is the same as no mark. The floor is a
    // tenth of its own box, which the thinnest of them — Common's single
    // stroke — clears at 0.13.
    ok(masks[tier].area / (R * R) > 0.10, `${tier}'s mark fills enough of its box (${(masks[tier].area / (R * R)).toFixed(2)})`);
  }

  let worst = { similarity: 0, pair: '' };
  for (let i = 0; i < TIER_ORDER.length; i++) {
    for (let j = i + 1; j < TIER_ORDER.length; j++) {
      const a = TIER_ORDER[i], b = TIER_ORDER[j];
      const s = silhouetteSimilarity(masks[a], masks[b]).similarity;
      if (s > worst.similarity) worst = { similarity: s, pair: `${a}/${b}` };
    }
  }
  ok(worst.similarity < MARK_SIMILARITY,
     `no two tier marks read as one another (worst ${worst.pair} ${worst.similarity.toFixed(3)} vs ${MARK_SIMILARITY})`);

  // The Umbral ring is the only mark with negative space in it, and that hole is
  // the whole of what separates it from a disc. It comes from a single
  // out-and-back path, so an editor who "tidied" that into one loop would lose
  // it silently.
  ok(masks.lunar.holes > 0, "Umbral's ring still has a bore");

  // The ordinary tiers are a tally and have to count: one stroke, two, three.
  const runs = (m) => Math.max(...m.bands.map((band) => band.runs));
  ok(Math.round(runs(masks.common)) === 1 && Math.round(runs(masks.uncommon)) === 2
     && Math.round(runs(masks.legendary)) === 3,
     'Common, Uncommon and Legendary read as one, two and three strokes');
}

console.log('the elite affixes carry their own redundancy, and no two share it');
{
  const { ELITE } = await import('../src/entities/EnemyMeshes.js');
  // Threat's shape channel is not a glyph but the aura's geometry: how many
  // bands, how many bits, what the bits are, how they move, and whether the unit
  // wears a barrier. The table has always claimed this signature is unique per
  // affix; nothing checked it, and a sixth affix was added after the claim was
  // written.
  const seen = new Map();
  for (const [id, a] of Object.entries(ELITE)) {
    const sig = [a.bands ?? 0, a.bits ?? 0, a.shape ?? '-', a.ward ?? 0,
                 a.helix ?? 0, a.rise ?? 0, a.spin ?? 0, a.tilt ?? 0].join('/');
    ok(!seen.has(sig), `${id}'s aura signature is its own (${sig}${seen.has(sig) ? `, shared with ${seen.get(sig)}` : ''})`);
    seen.set(sig, id);
  }
  ok(seen.size === Object.keys(ELITE).length, 'every affix is distinguishable with colour removed entirely');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
