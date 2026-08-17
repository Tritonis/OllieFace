# Asset spec

The shared brief every `asset-search` issue in the art milestone cites. Written so a
searching agent needs no source access and five parallel searches return one coherent
shortlist rather than five internally-fine ones. `RUBRIC.md` axis 10 (cohesion)
penalises exactly the failure mode of independent, uncoordinated shortlists; `ART-ASSETS.md`
names buying five unrelated packs as "the fastest way to score badly there."

## This document governs

Ratified 2026-08-15. Where this spec and `docs/ART-STYLE-GUIDE.md` disagree, **this
document wins** and the guide is corrected to match. Source still outranks both on any
transcribed fact — the palette at `src/world/Materials.js:23-69`, the Void constants at
`src/shaders/BlightMask.js:152-153` — and a document disagreeing with those is wrong,
whichever document it is.

**When a decision is made, it is written here first**, then reconciled into the guide in
the same change. That is what stops the two drifting.

## Ratified decisions bearing on search

Settled 2026-08-15. These change what a searching agent may shortlist, so they are stated
before the palette rather than after it.

- **Purchased and downloaded texture maps are permitted.** A **map** (albedo, normal,
  roughness, AO, height) may be bound into a material built by `src/world/Materials.js`.
  What remains forbidden is an asset shipping its own **material** — its own shader,
  grade, emissive decisions or bloom. This was the question that gated whether any texture
  shortlist was usable at all; the answer is yes.
- **Emissive content is permitted, and the accent is not exclusive.** New content may
  self-light, may use the accent hue `#2fb3af`, and may introduce further accent hues.
  **One cap survives, and it is a hard filter on shortlists:** nothing may out-value the
  objects the player has to read. The existing accent is held under the bloom knee because
  it was measured at luma 224 in a mean-luma-62 combat frame as the brightest non-VFX
  object on screen. **Do not shortlist bright polished or strongly self-lit material sets**
  — a candidate that is the brightest thing in a combat frame fails on value regardless of
  its hue.
- **Bought vector icon sets are admissible**, redrawn or imported as paths. Text glyphs,
  dingbats, emoji and icon fonts remain forbidden. An imported set must not introduce a
  font dependency to render.
- **The corruption layer costs zero maps per asset and imposes no UV contract (#60).**
  This is stated here because it is the decision most likely to be mis-priced into a
  purchase. A bought asset does **not** need to ship, and must not be shortlisted for, a
  blight mask, a corruption variant, a second UV set, a spare texture channel, or any
  authored allowance for the Void at all. The overlay is generated at runtime from the
  fragment's world position — see *The Void overlay* below for the mechanism — so it
  applies to any surface bound through `attachWorldSurface` regardless of how, or whether,
  that surface is unwrapped. **Do not pay for corruption-ready anything**, and do not
  reject a pack for lacking it. The same is true of the metre-scale detail field.
  The counterweight, which belongs to the *same* decision and must be read with it: what
  the mesh seam does not deliver is the **near-field UV map**. See *Format and budget*.

Two decisions that deliberately do **not** change search: whether corruption should extend
over character and enemy models is an open engineering question (#62), and the survivor
silhouette threshold is being implemented rather than applied by hand (#61). Neither gates
a texture or audio shortlist.

## The palette agents match against

Source of truth: `src/world/Materials.js:23-69` (`PALETTE`). Verified against that file
as of this writing — every hex below is what is actually in source, unchanged from the
issue's stated values.

| Role | Hex | Note |
|---|---|---|
| terrain rock | `#b58248` | 32 deg, the dominant warm |
| terrain cliff | `#5b5460` | 275 deg at 12% sat - shadow-side by hue, quietly |
| terrain moss | `#6f8f43` | 85 deg |
| terrain sand | `#ead093` | 42 deg |
| accent crystal | `#2fb3af` | the one accent; **value-capped**, may not out-value gameplay-critical objects |
| accent metal | `#8d9199` | cool, so it catches the blue sky as specular |
| accent wood | `#33272f` | |
| accent wet | `#43555f` | |
| fog | `#9fb0c6` | 214 deg, light (V 78%) - aerial perspective goes pale and cool, never dark |

Do not colour-match against any other hex in `PALETTE` (sky, light) for asset search —
those drive lighting and environment, not the material/prop palette above.

## The Void overlay

Source of truth: `src/shaders/BlightMask.js:152-153` (`MASK_APPLY`), linear-space GLSL
constants. Verified against that file as of this writing:

```glsl
const vec3 BM_TINT = vec3(0.0419, 0.0166, 0.0665);
const vec3 BM_VEIN = vec3(0.1522, 0.0640, 0.5040);
```

For an agent eyeballing thumbnails, these convert to `#3a2349` (deep desaturated violet,
fill) and `#6d48bc` (saturated violet, vein glow), applying the sRGB transfer function to
each linear component. These are **derived sRGB values for search guidance only** — the
shader constants above are authoritative.

> The comment beside those constants used to state `#2b1340` and `#7a46c8`, neither of
> which is reachable from the constants under the sRGB transfer function or under a plain
> 2.2 gamma. That comment (`BlightMask.js:146-151`) has since been corrected and now names
> the same `#3a2349` / `#6d48bc` this section computes, so the two no longer disagree.
Nothing should be colour-matched against the hex approximations in any code path; they
exist purely so a human or agent can recognize "is this roughly the right family of
violet" while browsing a marketplace thumbnail.

**How it is sampled, and what that costs a bought asset: nothing (#60).** The coverage
term `claim` is sampled **triplanar, in world-space metres** — `bmTri`,
`src/shaders/BlightMask.js:81-90`, whose blend weights come from the fragment's world
normal and whose three lookups are keyed on world position. It never reads the material's
UVs, and `attachBlightMask` binds no texture: the field is arithmetic noise octaves, not a
fetch. Two consequences a purchase decision depends on, and neither is a promise about
future work — both are properties of the shipped shader:

- **Zero maps per asset.** No blight texture, no mask channel, no lightmap-style second UV
  set, no per-asset authoring of any kind. The corruption's whole cost is already paid, once,
  in the shader.
- **No UV contract.** A pack's unwrap can be anything, including nothing. The mesh seam
  (`src/world/ModelKit.js`) in fact deletes `uv` and `tangent` outright once faces are
  classified, and the corruption is unaffected — which is the strongest available statement
  of the claim, since a mask with any UV dependency would break on a mesh that has no UVs left.

The route was chosen over a UV-locked mask for a reason that also survives distance: the
near-field detail pass fades out by 20-60 m (`uv` 0.5, `uvFade`, `src/world/Materials.js:303`),
so a UV-locked corruption would strand a blighted object past 60 m as a flat violet
silhouette — exactly what rule 2 forbids. A world-space field shrinks on screen instead and
is still legible at 200 m.

**Consequence for search strategy, stated explicitly because it inverts the obvious
approach:** the Void is applied *over* the base palette (the terrain/accent table
above), not searched for separately. `BlightMask.js`'s `MASK_APPLY` mixes `BM_TINT` into
`diffuseColor` and adds `BM_VEIN`-tinted emissive on top of whatever material is already
bound — it re-shades material that already exists in the warm ochre palette, applied at
runtime as blight patches spread. An asset must therefore read correctly in warm ochre
**and** survive being re-shaded violet. Assets whose own baked-in colour is already
purple, magenta, or violet will double up under the overlay and read as mud — do not
shortlist a purple- or violet-toned asset on the theory that it "already matches the
corruption."

## Licence rules

- **Agent-findable: CC0 only.** No exceptions, no CC-BY, no "free with attribution", no
  account-walled downloads. An agent cannot accept terms on the user's behalf and must
  not try to.
- Anything commercial or attribution-bearing is a **user decision** — surface the link
  and the terms, do not shortlist it as agent-usable. Synty Studios specifically is
  tracked separately as issue #27; do not re-surface Synty in a general search issue.
- Per `ART-ASSETS.md`: "Verify licences per pack... Do not trust a summary — including
  this one." Every shortlisted entry records the licence **as stated on the asset page
  on the day it was checked**, with the date, not as remembered from the site's general
  policy or a prior search's notes.

## Format and budget

- three.js wants glTF/GLB; kits commonly ship FBX. Budget a conversion pass, and verify
  that generated normals and material bindings survive the conversion before counting an
  asset as usable.
- **A mesh import seam now exists: `src/world/ModelKit.js` (#59).** Two things a mesh
  search must now screen for, because they are what the seam needs and nothing else is:
  **glTF/GLB natively**, and a **regular swatch grid** in the palette atlas. The seam reads
  a face's UV as an index into that grid — `atlasCell` — and binds one `Materials.js`
  material per swatch through `attachWorldSurface`, so the pack's own per-part material
  split survives without any re-UVing. A pack whose atlas is *not* a regular grid has no
  route through the seam today and must be reported as such rather than assumed convertible.
- **The bookkeeping per model is smaller than `model-kits.md` estimated, and the loader
  leg is spent.** Measured on KayKit `chest.glb`: one glTF material, 728 faces, exactly two
  swatch cells, so the whole manifest for the model is two lines. `surveyKitGeometry`
  reports the cells; an unmapped cell throws rather than defaulting, which is rule 1's
  "name which `PALETTE` entry each colour maps to" enforced mechanically.
- **Authored textures are never fetched, decoded or uploaded**, so a pack's atlas does not
  enter the download budget at all — the loader answers glTF's `loadMaterial` hook before
  the parser can resolve a texture. The seam also drops `uv` and `tangent` once the faces
  are classified (28,896 bytes on that one chest), because no kit material samples them.
  For #28 this means a mesh pack's payload is **geometry only**.
- **What the seam does not deliver: the near-field UV map.** Read this bullet with the one
  above, never on its own — together they are the whole trade, and the one above alone reads
  as "the seam is complete and free", which it is not. Dropping the authored atlas costs no
  *luma spread* — measured through one identical 195x143 crop, 27,885 px, the palette-rebound
  KayKit chest carries **209** unique luma values against the same mesh's **195** with its
  atlas intact, and the authored copy arrives at mean luma **93.8** against the rebind's
  **67.0** (`reviews/modelkit-seam/record.json`, key `pair`; crops beside it). A gradient
  atlas has no surface detail to lose, so what the rebind removes is a value problem, not
  information. But it also means the bought pack's **authored texel variation is discarded,
  not adapted** — and that variation is precisely what `ART-ASSETS.md` names as the fix for
  axis 5's detail-starvation half. The metre-scale detail field and the corruption both
  reach an imported mesh for free; near-field texel detail does not, and is the one thing
  that would need re-UVing on top of the purchase.
  **What this changes about shortlisting:** judge a mesh pack on **silhouette, proportion
  and topology**, because that is what actually arrives. Do not pay a premium for the
  quality of a pack's texture work on meshes routed through this seam — it is answered away
  before the parser resolves it. A pack whose value is mostly in its atlas is worth less
  here than its price implies.
- Textures: prefer PNG source, note KTX2/Basis as the shipping target.
- **Download/VRAM budget: SET (issue #28).** See *The budget* below. The numbers live
  machine-readably in `docs/art/asset-budget.json` and are enforced by
  `tests/asset-budget.test.mjs` in the cheap tier; this prose and that file are checked
  against each other, so neither can drift alone.

## The budget

Measured at commit `e702ba4` with `npm run build` (`node tools/asset-budget.mjs` reproduces
it): `dist/` totals 9.17 MiB, of which **7.32 MiB is sourcemaps that are never shipped**
(`package.json` `build.files` carries `!dist/**/*.map`). The shipped payload is
**1.85 MiB, all of it code** — 1.79 MiB JS, 59 KiB CSS, 1.6 KiB HTML — and **zero bytes of
art assets**, which is the "essentially zero asset payload" claim made numeric.

| Ceiling | Value | Why |
|---|---|---|
| Total shipped | **24 MiB** | The 1.85 MiB code baseline plus the asset allowance plus slack; a 24 MiB cold download is ~20 s on a 10 Mbit line, the longest first-launch wait this game's scope justifies. |
| Code | **2.25 MiB** | Baseline plus ~22% growth headroom: feature work will not trip it, a doubling or an accidentally-bundled dependency will. |
| Assets | **20 MiB** | A ceiling on the **total shortlist across all search issues combined**, not a per-asset allowance: one 2K HDRI (~4 MB KTX2), a small PBR set (~8 MB), and a few meshes (~4 MB) fit with room. |
| VRAM | **512 MiB, provisional** | No atlas-scale VRAM reasoning exists in this repo to derive from. 512 MiB is the resident-texture headroom that keeps the game inside a 2 GB shared-memory integrated adapter alongside the framebuffer and post stack. Replace it with a measured figure when one exists. |
| GPU proxies | **96 textures, 900 geometries** | The only committed VRAM-adjacent measurements that exist are the capture manifest's `perf` block (baseline 53 / 700, `reviews/survivor-sep/integrated-shots/manifest.json`). +80% / +29% makes an asset pack landing wholesale visible before a VRAM measurement exists. |
| `combat-24` frame time | **median 26.0 ms, p95 32.0 ms** | See below. |

- Performance: the frame-time budget is a **ceiling, not a band**. The older "21-26 ms band"
  does not survive contact with the record — the committed perf write-ups report `combat-24`
  medians of 16.9 (`reviews/round5/FIX-stages.md:124`), 18.6 (`FIX-materials.md:316`), 20.0
  (`FIX-vfx2.md:288`), 20.5 and 21.8 (`FIX-character.md:337`), 24.5 (`FIX-harness2.md:9`) and
  20.5 ms (`reviews/round6/FIX-world.md:137`). Five of the seven sit *below* the band's lower
  bound, and a lower bound would fail a change that made the game faster. So: **median at or
  under 26.0 ms, p95 at or under 32.0 ms**. Those medians span 16.9-24.5 ms on one machine
  across one tree family (about +/-19% around the midpoint), so a ceiling tighter than roughly
  +25% over the latest recorded median would flap on run noise instead of catching regressions;
  26.0 ms is +27%. This bears on poly count and texture resolution, not just download size.
- The frame-time record the gate reads is `reviews/asset-budget/perf-combat24.json`. It is
  currently **transcribed from `reviews/round6/FIX-world.md:137`**, because `tools/perf.mjs`
  only ever printed to stdout and no machine-written perf record was ever committed. Refresh
  it with a hand-run: `node tools/perf.mjs --out reviews/asset-budget/perf-combat24.json`,
  then `node tools/gates.mjs status --record perf`. It is a headed GPU run and never part of
  a tier.

## Report format every search issue must follow

Reports land in `.superpowers/sdd/art-assets/<topic>.md` (gitignored working material,
per `CLAUDE.md`). Searching agents write files only — **no downloads, no commits of
binary assets, no `gh` calls.**

Each candidate entry must carry all of the following fields, so five independent search
issues produce directly comparable files:

- **Direct URL** to the specific asset/pack page.
- **Source site** (e.g. Poly Haven, Kenney, Quaternius, ambientCG).
- **Licence as stated on the page, and the date checked** (not a remembered summary —
  see Licence rules above).
- **Resolution / poly count** as applicable to the asset type.
- **Why it matches the palette** — reference the specific table row(s) above (terrain
  rock, accent crystal, etc.) it aligns or conflicts with, and note whether its own
  baked-in colour risks the Void double-up described above.
- **Which specific defect it addresses** — cite the source (e.g. a named axis in
  `RUBRIC.md`, a specific gap in `ART-ASSETS.md`, or the issue that requested the search).
