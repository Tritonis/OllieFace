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
- Textures: prefer PNG source, note KTX2/Basis as the shipping target.
- **Download/VRAM budget: PLACEHOLDER, pending issue #28 (open as of this writing).**
  The game currently carries essentially zero asset payload. No numeric ceiling exists
  yet — do not invent one. Issue #28 will set it as a ceiling on the **total shortlist**
  across all search issues combined, not a per-asset allowance. No search issue may be
  closed out against an unset budget; note the placeholder in the search report and move
  on rather than blocking on it.
- Performance: `combat-24`'s frame-time median sits in a **21-26 ms band**; any change
  that pushes it above that band is a regression. This bears on poly count / texture
  resolution choices, not just download size.

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
