/**
 * The worked example for the mesh-import seam (issue #59).
 *
 * `src/world/ModelKit.js` claims that an externally-authored, palette-atlas mesh
 * can be brought into this game's material pipeline without re-UVing it, and
 * that what arrives is not merely a flat-shaded silhouette. This probe is the
 * evidence for that claim, or against it. It drives the *real* game — real
 * Stage, real material library, real lights, real `RenderPipeline` post chain —
 * and puts three objects side by side in one frame under one light:
 *
 *   centre    a hand-built interactable from `src/world/Interactables.js` — the
 *             subject the harness's own scenario framed, lit and cleared
 *   one flank KayKit's `chest.glb`, imported through the seam
 *   other     the same glTF through a stock `GLTFLoader`, authored atlas and
 *             all, which is what rule 3 of the style guide forbids
 *
 * The authored copy is a **control, not a proposal**. It is in the frame because
 * "what does discarding the authored material actually cost" is the question
 * issue #59 asks, and it cannot be answered from a marketplace render
 * (style-guide rule 4: "a marketplace render is not evidence about this game").
 *
 * The trio is the picture. The *measurement* is the paired arm that follows it,
 * which puts both imported copies at one world transform and toggles them one at
 * a time, so the two crops differ in the material and in nothing else.
 *
 * Shots land in `--out` (default `shots-modelkit`), with a JSON record beside
 * them carrying the per-subject unique-luma counts — the same measure
 * `ART-ASSETS.md` used to state the detail-starvation defect ("the chest in
 * 07-interactables carries 67 unique luma values over 117,000 px").
 *
 *   node tools/kitprobe.mjs [--seed 1337] [--port 5233] [--out shots-modelkit]
 *                           [--model /assets/kit/chest.glb]
 *
 * The model is NOT in git (see `.gitignore`); issue #26 forbids committing any
 * binary asset until it closes. Fetch it first:
 *
 *   curl -L -o assets/kit/chest.glb https://raw.githubusercontent.com/\
 *   KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0/main/addons/\
 *   kaykit_dungeon_remastered/Assets/gltf/chest.glb
 *
 * Exit 1 if any check fails; the record is written either way, because a failed
 * arm is evidence too.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5233);
const OUT = path.resolve(args.out ?? 'shots-modelkit');
const MODEL = String(args.model ?? '/assets/kit/chest.glb');
const W = 1600, H = 900;

// KayKit Dungeon Remastered ships one glTF material per model and encodes the
// part material in the UV: an 8x4 grid of gradient swatches. Surveyed on this
// file with `surveyKitGeometry`: cell (1,0) on 416 faces, cell (4,0) on 312.
const MANIFEST = {
  route: 'atlas',
  atlas: {
    cols: 8, rows: 4,
    cells: { '1,0': 'kitIron', '4,0': 'kitWood' },
  },
};

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : `  - ${JSON.stringify(detail)}`}`);
};

try {
  await access(path.resolve('.' + MODEL));
} catch {
  console.error(`kitprobe: ${MODEL} is not on disk. See the header of this file for the fetch command.`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [], consoleErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

/**
 * Unique-luma count over a screen rectangle.
 *
 * The screenshot is taken by playwright and decoded back inside the same
 * browser, which is the idiom `tools/shotdiff.mjs` already uses: "the repo has
 * no image library, and the browser is already a dependency".
 *
 * **What this number is and is not.** The clip is the inner 56% of the subject's
 * projected bounding box, not a silhouette mask, so a few per cent of it is the
 * terrain behind the subject's outline, and the grade's animated film grain
 * (`GradeShader.js:158`) puts a floor under the count. It is therefore a
 * *comparative* measure between three subjects photographed in the same frame,
 * under the same key, at the same magnification — not a figure to put beside
 * `ART-ASSETS.md`'s "67 unique luma values over 117,000 px", which was measured
 * a different way on a different crop.
 */
const INSET = 0.22;

async function measure(name, clip) {
  const rect = {
    x: Math.max(0, Math.round(clip.x + clip.width * INSET)),
    y: Math.max(0, Math.round(clip.y + clip.height * INSET)),
    width: Math.round(clip.width * (1 - 2 * INSET)),
    height: Math.round(clip.height * (1 - 2 * INSET)),
  };
  rect.width = Math.min(rect.width, W - rect.x);
  rect.height = Math.min(rect.height, H - rect.y);
  if (rect.width < 8 || rect.height < 8) return { name, error: 'degenerate clip', rect };
  const buf = await page.screenshot({ clip: rect });
  await writeFile(path.join(OUT, `crop-${name}.png`), buf);
  const stats = await page.evaluate(async (dataURL) => {
    const img = new Image();
    img.src = dataURL;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      // Rec.709 luma on the graded, tonemapped, sRGB-encoded frame, which is
      // the frame the player sees and the one ART-ASSETS.md measured.
      hist[Math.min(255, Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]))]++;
    }
    let unique = 0, sum = 0, n = 0;
    for (let l = 0; l < 256; l++) if (hist[l]) { unique++; sum += l * hist[l]; n += hist[l]; }
    return { unique, pixels: n, meanLuma: +(sum / n).toFixed(1) };
  }, `data:image/png;base64,${buf.toString('base64')}`);
  return { name, rect, ...stats };
}

let record = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));

  // The harness's own interactables scenario does the work nobody should redo:
  // it picks a sunlit chest on a clear bearing and plants a 32 mm-equivalent
  // lens on it. Everything below is placed relative to what it chose.
  await page.evaluate(async () => {
    await globalThis.__HARNESS__.interactables({ settleFrames: 60 });
    // Clear any prompt the scenario left standing. The HUD itself stays: every
    // shot in `tools/capture.mjs` carries it, and a subject judged without it is
    // not judged in the frame the player sees.
    globalThis.__HARNESS__.dismiss();
  });

  // ------------------------------------------------------------------ import
  const imported = await page.evaluate(async ({ url, manifest }) => {
    const G = globalThis.__GAME__, THREE = G.THREE, ctx = G.ctx;
    const kit = await import('/src/world/ModelKit.js');
    // A stock loader for the control arm. Taken off the seam's own loader rather
    // than imported by bare specifier, because a dynamic import evaluated in the
    // page is not rewritten by vite -- and because "the same class, minus the
    // plugin" is exactly the comparison the control is supposed to make.
    const GLTFLoader = kit.kitLoader().constructor;

    // The subject the scenario framed: the interactable nearest the camera's aim.
    const cam = ctx.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    let subject = null, best = -Infinity;
    for (const o of ctx.interactables?.list ?? []) {
      if (!o?.position || !o.group) continue;
      const d = o.position.clone().sub(cam.position);
      const score = d.clone().normalize().dot(fwd) * 100 - d.length();
      if (score > best) { best = score; subject = o; }
    }
    if (!subject) throw new Error('kitprobe: no interactable to stand beside');

    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const at = (dist) => {
      const x = subject.position.x + right.x * dist, z = subject.position.z + right.z * dist;
      return new THREE.Vector3(x, ctx.stage.sampleHeight(x, z), z);
    };
    const facing = Math.atan2(-fwd.x, -fwd.z);

    // Middle: the seam.
    const seam = await kit.loadKitModel(url, manifest);
    const seamPos = at(2.6);
    seam.group.position.copy(seamPos);
    seam.group.rotation.y = facing;
    ctx.scene.add(seam.group);

    // Right: the same file through a stock loader, authored atlas intact. The
    // control for "what does rule 3 cost", and nothing else.
    const raw = await new GLTFLoader().loadAsync(url);
    const rawPos = at(-2.6);
    raw.scene.position.copy(rawPos);
    raw.scene.rotation.y = facing;
    raw.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    ctx.scene.add(raw.scene);

    globalThis.__KIT__ = { seam: seam.group, raw: raw.scene, subject, seamPos, rawPos, right, fwd, facing };

    const mats = [];
    seam.group.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) mats.push(m);
    });
    const rawMats = [];
    raw.scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) rawMats.push(m); });

    return {
      report: seam.report,
      seamMaterials: mats.map((m) => ({
        name: m.name,
        colour: '#' + m.color.getHexString(),
        hasMap: !!(m.map || m.normalMap || m.roughnessMap || m.aoMap || m.emissiveMap),
        detail: m.userData.detKind ?? null,
        blight: /blightmask/.test(m.customProgramCacheKey?.() ?? ''),
      })),
      seamHasUV: (() => { let any = false; seam.group.traverse((o) => { if (o.isMesh && o.geometry.attributes.uv) any = true; }); return any; })(),
      rawMaterials: rawMats.map((m) => ({
        name: m.name, hasMap: !!m.map,
        image: m.map?.image ? [m.map.image.width, m.map.image.height] : null,
      })),
      subject: { typeId: subject.typeId, pos: subject.position.toArray().map((v) => +v.toFixed(2)) },
    };
  }, { url: MODEL, manifest: MANIFEST });

  const r = imported.report;
  check('the seam bound both authored swatches to PALETTE surfaces',
    r.surfaces.join() === 'kitIron,kitWood', r.surfaces);
  check('every face in the model is grouped', r.faces === 728, r.faces);
  check('no kit material carries a UV-space map',
    imported.seamMaterials.length > 0 && imported.seamMaterials.every((m) => !m.hasMap),
    imported.seamMaterials);
  check('every kit material carries the metre-scale detail pass',
    imported.seamMaterials.every((m) => m.detail === 'ironPart' || m.detail === 'woodPart'),
    imported.seamMaterials.map((m) => m.detail));
  check('every kit material carries the corruption mask',
    imported.seamMaterials.every((m) => m.blight));
  check('the placeholder material never reaches the scene',
    imported.seamMaterials.every((m) => m.name !== 'kit-placeholder'));
  check('uv and tangent are gone, and the report says how many bytes',
    imported.seamHasUV === false && r.attributeBytesDropped > 0, r.attributeBytesDropped);
  // The control proves the suppression is real rather than incidental: the same
  // file through a stock loader DOES decode and upload the 1024x1024 atlas.
  check('the control loader does fetch and decode the authored atlas',
    imported.rawMaterials.some((m) => m.hasMap && m.image?.[0] === 1024), imported.rawMaterials);

  // -------------------------------------------------------------- framing
  const framing = await page.evaluate(() => {
    const G = globalThis.__GAME__, THREE = G.THREE, ctx = G.ctx, K = globalThis.__KIT__;
    const cam = ctx.camera;
    // Pull back along the lens axis and re-aim at the middle of the trio, so all
    // three subjects sit in one frame at the same magnification.
    const mid = K.subject.position.clone();
    const back = cam.position.clone().sub(mid).normalize();
    const eye = mid.clone().add(back.multiplyScalar(8.6)).setY(
      Math.max(ctx.stage.sampleHeight(mid.x, mid.z), mid.y) + 3.4);
    globalThis.__HARNESS__.freeCam(eye.x, eye.y, eye.z, mid.x, mid.y + 0.7, mid.z);
    cam.fov = 40;
    cam.updateProjectionMatrix();
    return { eye: eye.toArray().map((v) => +v.toFixed(2)), mid: mid.toArray().map((v) => +v.toFixed(2)) };
  });

  // Screen-space boxes for the three subjects, recomputed after every camera move.
  const boxes = async () => page.evaluate(() => {
    const G = globalThis.__GAME__, THREE = G.THREE, ctx = G.ctx, K = globalThis.__KIT__;
    const cam = ctx.camera;
    const w = window.innerWidth, h = window.innerHeight;
    const of = (root) => {
      const pts = [];
      root.updateWorldMatrix(true, true);
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        for (let i = 0; i < 8; i++) {
          const v = new THREE.Vector3(
            i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
          pts.push(v.applyMatrix4(o.matrixWorld).project(cam));
        }
      });
      if (!pts.length) return null;
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
      for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      return {
        x: (x0 * 0.5 + 0.5) * w, y: (0.5 - y1 * 0.5) * h,
        width: (x1 - x0) * 0.5 * w, height: (y1 - y0) * 0.5 * h,
      };
    };
    return { handbuilt: of(K.subject.group), seam: of(K.seam), authored: of(K.raw) };
  });

  await page.evaluate(async () => {
    const H = globalThis.__HARNESS__;
    H.thaw(); await H.frames(24); H.freeze();
  });
  await shot('10-kit-clean');
  const clean = await boxes();
  const cleanMeasures = [];
  for (const k of ['handbuilt', 'seam', 'authored']) {
    if (clean[k]) cleanMeasures.push(await measure(`clean-${k}`, clean[k]));
  }
  for (const m of cleanMeasures) console.log(`  MEASURE ${m.name}  unique luma ${m.unique} over ${m.pixels} px, mean ${m.meanLuma}`);

  const seamM = cleanMeasures.find((m) => m.name === 'clean-seam');
  const handM = cleanMeasures.find((m) => m.name === 'clean-handbuilt');
  check('the imported mesh is not a flat silhouette: it carries a real luma spread',
    seamM && seamM.unique >= 40, seamM);
  check('and it is in the same detail class as the hand-built prop beside it',
    seamM && handM && seamM.unique >= handM.unique * 0.5,
    { seam: seamM?.unique, handbuilt: handM?.unique });

  // ---------------------------------------------------------------- paired
  // The trio above is the picture; this is the measurement, and the two are not
  // the same thing. Three subjects standing in three places have three different
  // backdrops behind them, and a rectangle crop carries enough of that backdrop
  // to move a unique-luma count by tens of values — measured across two framings
  // of this very probe. So the two imported copies are now moved to the *same*
  // world transform and toggled one at a time, and both are measured through one
  // rectangle computed once. Same geometry, same pose, same pixels of terrain
  // behind it, same light, same post chain. The only difference left in the
  // frame is the material, which is the difference the question is about.
  const pair = { rect: null, seam: null, authored: null };
  await page.evaluate(async () => {
    const K = globalThis.__KIT__, H = globalThis.__HARNESS__;
    K.raw.position.copy(K.seamPos);
    K.raw.rotation.y = K.facing;
    K.raw.visible = false;
    H.thaw(); await H.frames(8); H.freeze();
  });
  await shot('13-pair-seam');
  pair.rect = (await boxes()).seam;
  pair.seam = await measure('pair-seam', pair.rect);
  await page.evaluate(async () => {
    const K = globalThis.__KIT__, H = globalThis.__HARNESS__;
    K.seam.visible = false;
    K.raw.visible = true;
    H.thaw(); await H.frames(8); H.freeze();
  });
  await shot('14-pair-authored');
  pair.authored = await measure('pair-authored', pair.rect);
  await page.evaluate(async () => {
    const K = globalThis.__KIT__, H = globalThis.__HARNESS__;
    K.seam.visible = true;
    K.raw.position.copy(K.rawPos);
    H.thaw(); await H.frames(8); H.freeze();
  });
  for (const m of [pair.seam, pair.authored]) {
    console.log(`  MEASURE ${m.name}  unique luma ${m.unique} over ${m.pixels} px, mean ${m.meanLuma}`);
  }
  check('through one identical crop, discarding the authored atlas does not cost luma spread',
    pair.seam.unique >= pair.authored.unique,
    { seam: pair.seam.unique, authored: pair.authored.unique });
  // Rule 4's cap is on value, and it is the one the atlas actually breaks: the
  // pack is authored high-key for a bright viewer, not for a mean-luma-62 frame.
  check('the authored atlas arrives brighter than the palette rebind',
    pair.authored.meanLuma > pair.seam.meanLuma,
    { seam: pair.seam.meanLuma, authored: pair.authored.meanLuma });

  // ----------------------------------------------------------------- far
  await page.evaluate(async () => {
    const G = globalThis.__GAME__, THREE = G.THREE, ctx = G.ctx, K = globalThis.__KIT__, H = globalThis.__HARNESS__;
    const cam = ctx.camera;
    const mid = K.subject.position.clone();
    const back = cam.position.clone().sub(mid).setY(0).normalize();
    const eye = mid.clone().add(back.multiplyScalar(46));
    eye.y = ctx.stage.sampleHeight(eye.x, eye.z) + 8;
    H.freeCam(eye.x, eye.y, eye.z, mid.x, mid.y + 0.6, mid.z);
    cam.fov = 20;
    cam.updateProjectionMatrix();
    H.thaw(); await H.frames(12); H.freeze();
  });
  await shot('11-kit-far');
  const farBoxes = await boxes();
  const farMeasures = [];
  for (const k of ['handbuilt', 'seam', 'authored']) {
    if (farBoxes[k]) farMeasures.push(await measure(`far-${k}`, farBoxes[k]));
  }
  for (const m of farMeasures) console.log(`  MEASURE ${m.name}  unique luma ${m.unique} over ${m.pixels} px, mean ${m.meanLuma}`);

  // -------------------------------------------------------------- blighted
  // Style-guide rule 2's own check-before-it-lands: two renders, clean and
  // blighted, and neither may be the asset's only good look. The corruption is
  // sampled triplanar in metres (#60), so it imposes no UV contract at all on an
  // imported mesh -- which is the half of this seam that cost nothing to build.
  const blight = await page.evaluate(async () => {
    const G = globalThis.__GAME__, ctx = G.ctx, K = globalThis.__KIT__, H = globalThis.__HARNESS__;
    const cam = ctx.camera;
    const mid = K.subject.position.clone();
    const back = cam.position.clone().sub(mid).setY(0).normalize();
    const eye = mid.clone().add(back.multiplyScalar(8.6));
    eye.y = Math.max(ctx.stage.sampleHeight(mid.x, mid.z), mid.y) + 3.4;
    H.freeCam(eye.x, eye.y, eye.z, mid.x, mid.y + 0.7, mid.z);
    cam.fov = 40;
    cam.updateProjectionMatrix();
    ctx.events.emit('blightSeed', { x: mid.x, z: mid.z, strength: 3 });
    ctx.corruption.feed(ctx.player, 260);
    H.thaw(); await H.frames(300); H.freeze();
    const bm = await import('/src/shaders/BlightMask.js');
    return {
      patches: ctx.blight?.patches?.length ?? 0,
      radius: +(bm.MASK_UNIFORMS.uBlightPatches.value[2] ?? 0).toFixed(2),
      band: ctx.corruption?.band ?? 0,
    };
  });
  await shot('12-kit-blighted');
  const blightBoxes = await boxes();
  const blightMeasures = [];
  for (const k of ['handbuilt', 'seam', 'authored']) {
    if (blightBoxes[k]) blightMeasures.push(await measure(`blight-${k}`, blightBoxes[k]));
  }
  for (const m of blightMeasures) console.log(`  MEASURE ${m.name}  unique luma ${m.unique} over ${m.pixels} px, mean ${m.meanLuma}`);

  check('a patch grew over the trio', blight.patches >= 1 && blight.radius > 3, blight);
  const bSeam = blightMeasures.find((m) => m.name === 'blight-seam');
  const bAuth = blightMeasures.find((m) => m.name === 'blight-authored');
  check('the imported mesh is re-shaded by the corruption, not replaced by it',
    bSeam && seamM && bSeam.meanLuma !== seamM.meanLuma && bSeam.unique >= 30,
    { clean: seamM, blighted: bSeam });
  // And the control is NOT re-shaded, to within the crop's own noise. This is
  // the check that says why rule 3 is a rule: `attachBlightMask` injects a chunk
  // into a material the library built, so a mesh that kept its authored material
  // never receives it and stands in untouched ochre while the ground under it
  // shades violet -- verbatim the failure `attachWorldSurface`'s doc comment at
  // `Materials.js:836-841` exists to prevent. It is visible in
  // `12-kit-blighted.png` without measuring anything.
  const cAuth = cleanMeasures.find((m) => m.name === 'clean-authored');
  check('the control is untouched by the corruption, having never gone through the seam',
    bAuth && cAuth && Math.abs(bAuth.meanLuma - cAuth.meanLuma) < 1.0,
    { clean: cAuth?.meanLuma, blighted: bAuth?.meanLuma });
  check('while the seam copy moves under it',
    bSeam && seamM && Math.abs(bSeam.meanLuma - seamM.meanLuma) > 5.0,
    { clean: seamM?.meanLuma, blighted: bSeam?.meanLuma });

  check('no page errors across the session', pageErrors.length === 0, pageErrors.slice(0, 3));
  check('no console errors across the session', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  record = {
    seed: SEED, model: MODEL, manifest: MANIFEST,
    framing, import: imported, blight, pair,
    measures: { clean: cleanMeasures, far: farMeasures, blighted: blightMeasures },
    checks,
  };
} catch (e) {
  console.error('kitprobe: ' + (e?.stack ?? e));
  check('probe ran to completion', false, String(e?.message ?? e));
  record = { seed: SEED, model: MODEL, error: String(e?.stack ?? e), checks };
} finally {
  await writeFile(path.join(OUT, 'record.json'), JSON.stringify(record, null, 2));
  await browser.close();
  await server.close();
}

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed  ->  ${OUT}`);
process.exit(failed ? 1 : 0);
