# Art style guide

**Status:** ratified by the author, 2026-08-15. The seven questions this document was
drafted with are settled; the answers and what each one changed are recorded in
*Ratified decisions* at the end.

`RUBRIC.md` grades output after the fact. This document constrains input: it is the gate
every asset search, every generated mesh and every new icon in the art milestone is
checked against **before** the content lands. `ART-ASSETS.md` names the artefact — "a
style guide that new content is checked against before it lands" — and this is it.

Everything below is a rule the code already implies. Each rule carries the `file:line`
it was verified against, so a reader can refute it against source rather than believe it.

## Precedence

**`docs/art/ASSET-SPEC.md` governs.** Where this guide and the asset spec disagree, the
asset spec wins, and this document is the one that gets corrected. Ratified 2026-08-15
(question 7).

Two things that does *not* mean. Source still outranks both on any transcribed fact: the
palette lives at `src/world/Materials.js:23-69` and the Void constants at
`src/shaders/BlightMask.js:88-89`, and a document disagreeing with those is simply wrong,
whichever document it is. And precedence is not licence to let the two drift — **when a
decision is made, the agent updates `ASSET-SPEC.md` first**, then reconciles this guide to
it in the same change.

---

## Rule 1 — One palette

**Rule.** Every colour in new content comes from `PALETTE` in `src/world/Materials.js`,
or is derived from a `PALETTE` entry by a stated relationship (a shade, a tint, a
roughness sibling). No new content introduces a hue that is not already in the table
below, and no content is colour-matched against a hex copied from any other document —
`src/world/Materials.js:23-69` is the only source of truth, and a transcription anywhere
else, including this one, is a convenience that can go stale.

Verified verbatim at `src/world/Materials.js:23-69`, with the file header's colour-script
statement at `src/world/Materials.js:4-22`:

```js
export const PALETTE = {
  sky: {
    zenith: 0x2f7fb2,   // 203°  saturated, so the mix toward the horizon reads
    horizon: 0xf2a44f,  //  31°  as blue->amber and not as grey
    haze: 0xffd08a,     //  35°  hot band hugging the horizon line itself
    ground: 0x39344a,   // 254°  below the horizon goes cool, never brown
    sun: 0xffe0ad,
    cloud: 0xb9bed8,    // 231°  cloud bodies are cool; only their lit tops warm
  },
  // 214°, the sky's own blue, and deliberately *light* (V 78%). Aerial
  // perspective goes pale and cool, never dark: this is the value the far
  // massif resolves to, and it has to sit above the terrain's mid-tones so the
  // background separates upward while the foreground stays dark and warm.
  fog: 0x9fb0c6,
  terrain: {
    rock: 0xb58248,     //  32°
    // 275°, but at 12% saturation rather than 17%. Vertical faces still read
    // as shadow-side by hue; they just stop *shouting* it. At the old
    // saturation a single mis-classified facet in an ochre field was a 245°
    // hue jump, which is why the foreground measured as warm/cool confetti.
    cliff: 0x5b5460,
    moss: 0x6f8f43,     //  85°
    sand: 0xead093,     //  42°
  },
  accent: {
    // Value, not hue. Measured at luma 224 in a mean-luma-62 combat frame the
    // accent was the brightest non-VFX object on screen — brighter than the
    // sentinels that wear the same teal as their species colour, and brighter than
    // the subject of the prop shot. Scenery may not out-value the things the
    // player has to read. Same hue (178 / 185 deg), ~0.8x the albedo and a
    // dimmer glow; see `crystal`'s emissiveIntensity for the other half.
    crystal: 0x2fb3af,
    crystalGlow: 0x17828c,
    metal: 0x8d9199,    // cool metal so it catches the blue sky as specular
    wood: 0x33272f,
    wet: 0x43555f,
  },
  light: {
    key: 0xffd2a0,
    // The key is the only warm light. Everything filling the shadow side is
    // cool, so a shadow is a hue change and not just a darker version of the
    // lit colour — which is the whole point of the complementary split.
    hemiSky: 0x79aeeb,
    hemiGround: 0x6b4638, // a little warm bounce off the ground, kept dim
    rim: 0x9a86f0,
  },
};
```

The comments are load-bearing and are transcribed with the hexes for that reason. Three
decisions that a bare hex list destroys, and that new content must not undo:

- **`cliff` sits at 12% saturation, not 17%** (`src/world/Materials.js:39-43`). The
  shadow-side hue is deliberately quiet. New content that reintroduces a strongly
  saturated cool at 275° puts the warm/cool confetti back.
- **The accent is capped on *value*, not on hue** (`src/world/Materials.js:48-53`, with
  the other half at `src/world/Materials.js:1040-1043` where `emissiveIntensity` is held
  at 0.85). Scenery may not out-value what the player has to read. An asset that arrives
  with a bright emissive is a readability regression regardless of its hue.
- **`fog` is deliberately *light* at V 78%** (`src/world/Materials.js:32-36`). Aerial
  perspective in this game goes pale and cool, never dark. Content authored to read
  against a dark haze will read wrong in the far band.

**Check before it lands.** Name, for each colour in the asset, which `PALETTE` entry it
maps to. An asset whose dominant colour maps to no entry is rejected, not adjusted later.

---

## Rule 2 — The Void is an overlay, not a palette

This is the single most misunderstandable thing about the look, and until now it was
legible only from shader source.

**Rule.** Corruption does not replace the biome's colours; it re-shades them. Nothing is
authored "in Void colours." Every asset must read correctly in the warm ochre palette of
rule 1 **and** survive being re-shaded violet on top of that. An asset whose own baked-in
colour is already violet or magenta doubles up under the overlay and reads as mud.

**Why, in source.** `attachBlightMask` injects one shader chunk into an existing material
rather than swapping the material (`src/shaders/BlightMask.js:131-152`). The chunk mixes a
tint into the diffuse colour the material already computed and *adds* a vein emissive on
top of it (`src/shaders/BlightMask.js:98-99`):

```glsl
diffuseColor.rgb = mix(diffuseColor.rgb, BM_TINT, bm * 0.80);
totalEmissiveRadiance += BM_VEIN * vein * (0.35 + 0.10 * uBlightBand);
```

The constants, in linear space, at `src/shaders/BlightMask.js:88-89`:

```glsl
const vec3 BM_TINT = vec3(0.0419, 0.0166, 0.0665);
const vec3 BM_VEIN = vec3(0.1522, 0.0640, 0.5040);
```

The file header states the intent directly — "nothing is duplicated, the biome palette
stays the base layer, and the corruption is a function applied on top of whatever the
biome put there" (`src/shaders/BlightMask.js:1-17`).

**The order is fixed: detail first, corruption last.** `attachWorldSurface` runs the
detail pass and then the mask, in that order and for that reason
(`src/world/Materials.js:830-849`, the doc comment at `:833-834` and the body at
`:846-849`). The material library applies the same ordering in bulk — the detail loop at
`src/world/Materials.js:1060-1065`, then the mask loop at `src/world/Materials.js:1067-1071`
whose comment says "After attachDetail, so the hook chain runs detail first and corruption
last — the mask re-shades the detailed fragment, not the other way round."
`attachBlightMask` chains rather than clobbers whatever hook is already installed
(`src/shaders/BlightMask.js:137-139`), which is the mechanism that keeps the order true.

So a chest standing in a blight patch is the ochre chest with the void's claim over it —
not a second, purple chest. Any asset that only works when it *is* the corruption has
misread the look.

**Check before it lands.** Two renders: the asset in a clean biome, and the asset inside a
blight patch. Both must read. Neither may be the asset's only good look.

---

## Rule 3 — One shader treatment

**Rule.** Incoming assets never ship their authored **materials**. Every world surface —
ground, rock, iron, brass, anything the player reads as part of the place they are
standing in — is bound to a material built by `src/world/Materials.js` and passed through
`attachWorldSurface(material, kind)` (`src/world/Materials.js:846-849`). Importing a mesh
whose material came with it is a rejection, not a follow-up cleanup.

**Maps are not materials, and maps are allowed** (ratified 2026-08-15, question 2). A
purchased or downloaded **texture map** — albedo, normal, roughness, AO, height — may be
bound into a material that `Materials.js` builds. What is forbidden is an asset arriving
with its own *material*: its own shader, its own grade, its own emissive decisions, its own
bloom. The distinction is the whole rule, because `ART-ASSETS.md` names authored texel
variation as the fix for the detail-starvation half of axis 5, and that fix is
unreachable if maps are banned along with materials.

A bound map is still subject to every other rule: its dominant colour maps to a `PALETTE`
entry (rule 1), it must survive being re-shaded violet (rule 2), and it is judged through
the shipping post chain (rule 4). Binding a map does not exempt content from the seam —
it still passes through `attachWorldSurface`.

**The seam is named**, and it is `attachWorldSurface`. It exists precisely because the
world's surfaces are built in four files rather than one, and its doc comment states the
failure it prevents: "A chest standing inside a blight patch in untouched ochre iron while
the ground under it shades violet is the 'assets from visibly different styles' failure
arriving from the other direction, and the only durable fix is that every one of those
ladders calls the same function" (`src/world/Materials.js:830-845`). That is `RUBRIC.md`
axis 10 stated as a code rule.

The existing ladders that already obey it, and that a new one must look like:

- `src/world/Interactables.js:129`, `:134`, `:146`, `:151`, `:163`, `:168`
- `src/world/realms/RealmArena.js:36`
- `src/world/realms/RealmProps.js:37`, `:41`

Each of those constructs a plain `MeshStandardMaterial`, pulls its maps from the shared
texture sets via `getTextureSets()` / `withRepeat` (`src/world/Materials.js:1092`), and
hands the result to `attachWorldSurface`. New content joins that pattern or it does not
land.

**Check before it lands.** Point at the line where the new content calls
`attachWorldSurface`. If there is no such line, the content is not in the pipeline.

---

## Rule 4 — One post stack

**Rule.** Nothing is authored to look right on its own. Every asset is judged in a frame
that has been through the one post chain, and no content ships its own grade, its own
bloom, or its own grain. There is exactly one composer and it is built in
`src/core/RenderPipeline.js`.

**The chain**, stated in the class doc comment at `src/core/RenderPipeline.js:108-117`:

> scene -> GTAO -> bloom -> output(ACES + sRGB) -> grade -> SMAA

Built pass by pass in `RenderPipeline.build()` (`src/core/RenderPipeline.js:217-294`):

| Pass | Built at | What it fixes about incoming content |
|---|---|---|
| `RenderPass` | `:231-233` | Draws into a HalfFloat linear-sRGB target (`:221-228`); scene colour is HDR until `output`. |
| `GTAOPass` | `:243-259` | Contact darkening at radius 2.6 on a ~220-unit stage. Always constructed, toggled by quality (`:244`). |
| `UnrealBloomPass` | `:262-276` | Threshold 1.25 on genuinely HDR input, so bloom means "only emissives" (`src/core/RenderPipeline.js:17-23`). Bright-pass input is clamped at 8.0 (`:98-106`, `:265`) and `strength` is write-capped at 0.34 (`:269-274`). |
| `OutputPass` | `:279-281` | ACES tonemap plus sRGB encode; the only tonemapper. Everything after it is LDR (`:278`). Exposure is 1.10 (`:142`). |
| `GradeShader` `ShaderPass` | `:283-285` | Shake offset, chromatic aberration, filmic grade, vignette and grain (`src/shaders/GradeShader.js:5-14`), with the animated grain at `src/shaders/GradeShader.js:158`. Resting vignette 0.16 (`src/core/RenderPipeline.js:30`); aberration base 0.00042 (`:54`). |
| `SMAAPass` | `:288-291` | Last, so it antialiases the final graded image (`:116`). |

Two consequences for incoming content:

- **The grade already carries the mood.** Cool lift in the shadows and warm gain in the
  highlights are applied globally (`src/shaders/GradeShader.js:26-27`). An asset authored
  with its own cool shadows arrives pre-graded and doubles.
- **Bloom is a threshold, not a style.** Content only blooms by exceeding 1.25 in linear
  HDR. An asset that looks correct only with a bloom it brought with it is rejected.

### Emissive and accent hues — permitted, under one cap

Ratified 2026-08-15 (questions 4 and 5). **New content may self-light, and may use the
accent hue or introduce further accent hues, as the content warrants.** The accent is no
longer exclusive and self-illumination is no longer implicitly reserved to it.

**The cap that survives, because it was measured rather than preferred:** no scenery,
emissive or otherwise, may **out-value the objects the player has to read**. The existing
accent is held at emissive 0.85, under the 1.25 bloom knee
(`src/world/Materials.js:1040-1043`, `src/core/RenderPipeline.js:23`), and the `PALETTE`
comment records why: measured at **luma 224 in a mean-luma-62 combat frame**, the accent
was the brightest non-VFX object on screen — brighter than the sentinels wearing the same
teal as their species colour, and brighter than the subject of the prop shot
(`src/world/Materials.js:47-55`).

So the permission is on hue and on self-illumination; the constraint is on **value**, and
it is the same constraint that pulled the accent down in the first place. A second accent
that repeats that defect is rejected under this rule, not admitted under question 5.

**Check before it lands.** Screenshot the asset through the shipping pipeline, not through
a viewer. A marketplace render is not evidence about this game. For anything emissive,
capture it in a **combat frame** rather than in isolation, and confirm it is not the
brightest non-VFX object in that frame.

---

## Rule 5 — A silhouette rule

Round 5 scored `RUBRIC.md` axis 4 at 3/10: RANGER (`src/data/survivors.js:35-42`) and
ANVIL (`src/data/survivors.js:70`, mesh at `src/entities/CharacterMesh.js:550`, geometry
at `:881`) thresholded to the same shape. `ART-ASSETS.md` states the consequence: "No
texture fixes that; only structural difference does."

**Rule.** Any new character, enemy, or gameplay-critical prop must be distinguishable from
every existing member of its comparison set **as a pure black silhouette**, at the
distance the player actually reads it. The distinguishing feature must be structural — an
outline, a proportion, a protrusion, a stance — never colour, never texture, never an
emissive marking. If an asset needs its albedo to be told apart from something already in
the game, it fails this rule and no shader or palette work rescues it.

**The comparison set, stated explicitly**, because "its roster" was ambiguous in the first
draft and both thresholds that ship today are enemy-centric — which is the wrong way to be
vague about a rule that exists because two *survivors* share a shape:

| New content | Compared against |
|---|---|
| A player character (survivor) | **Every other player character**, and every enemy |
| An enemy | Every other enemy, and every player character |
| A gameplay-critical prop | Every other gameplay-critical prop |

Both directions of the character/enemy comparison are required, and they fail for
different reasons. Two survivors that share a shape means the player cannot tell their own
roster apart when choosing or when watching a teammate. A survivor and an enemy that share
one costs the fight — which is why the shipped friend/foe bar (`maxFoeFriendIoU: 0.72`) is
held tighter than the family bar (`maxFamilyIoU: 0.78`).

Note that of the three rows above, only enemy-vs-enemy and enemy-vs-player are gated in
code today. Player-vs-player is the row this rule was written for and the row nothing
enforces; see *The measure* below and **#61**.

The structural work of fixing the existing roster is issue #20's, not this document's.
This rule governs what is allowed to *arrive* while that work happens: nothing may be
added that makes axis 4 worse.

### The measure

Ratified 2026-08-15 (question 1). **Correction to this document's first draft:** it
claimed there is no silhouette test anywhere in the codebase. That is wrong. There is one,
it is a gate, and it already ratchets:

- `tools/silhouette.mjs` renders every rig in `CharacterMesh` alone, in its idle pose,
  flat black on white, through one shared orthographic box, so masks come back at true
  relative scale.
- `tools/silhouette-metrics.mjs` is the pure arithmetic half — `shapeIoU` at `:113`,
  thresholds in `READABILITY` at `:124`, grading in `gradeRoster` at `:254`.
- `tests/readability-gate.test.mjs` pins the arithmetic against masks it draws itself, so
  the measurement is exercised without a GPU.

Two thresholds already ship: `maxFamilyIoU: 0.78` (enemy vs enemy) and
`maxFoeFriendIoU: 0.72` (enemy vs survivor), with an 18-entry exemption ratchet.

**The gap this rule actually has** is narrower and worse than "no test exists":
`tools/silhouette.mjs:356-366` builds `familyPairs` (enemy x enemy) and `foeFriendPairs`
(enemy x survivor). **Survivor-versus-survivor pairs are never constructed at all**, and
the file's own header calls the survivor pass "a report" rather than a gate. RANGER and
ANVIL are both survivors — so the exact defect this rule exists for is the one case the
gate structurally cannot see.

**The ratified metric**, to be added as a survivor threshold rather than built as a
parallel system:

1. Render both subjects as solid black binary masks, same canonical gameplay camera angle
   and standardized pose. Centre each and scale to the same bounding-box height,
   **preserving aspect ratio**.
2. `IoU = |A n B| / |A u B|`.
3. Contour term: average bidirectional Chamfer distance between the outlines, normalised
   by the bounding-box diagonal `D`, as `ContourSimilarity = max(0, 1 - d_chamfer / D)`.
4. `Similarity = 0.6 * IoU + 0.4 * ContourSimilarity`.
5. Interpretation: `>= 0.85` fail; `0.75-0.85` fail or review; `0.60-0.75` meaningfully
   distinct; `< 0.60` strongly distinct.
6. **Calibrate the pass threshold against the existing roster** — above the highest-scoring
   pair currently considered acceptably distinct, below the known-bad RANGER/ANVIL pair.
7. With multiple canonical views, take the **worst case**:
   `FinalSimilarity = max(Similarity_view1, ...)`.

Note that step 1 deliberately **preserves aspect ratio**, where the existing `sig` is
normalised to a square 64x64 (`tools/silhouette.mjs:59`) and therefore discards it. For
RANGER/ANVIL specifically, proportion may be the main separating feature, so the existing
normalisation throws away exactly the axis in question. The new threshold uses the
aspect-preserving form.

Two things to establish during implementation rather than assume, tracked in **#61**:
whether the Chamfer term retains useful spread after normalisation
(it may compress toward 1.0 and leave the score mostly IoU), and whether the calibration
window in step 6 exists at all — if an acceptable pair scores above RANGER/ANVIL, no
threshold separates them and the answer is geometry work (#20), not a number.

**Check before it lands.** Until the survivor threshold ships, render the candidate and
each member of its comparison set above filled solid black at gameplay framing and compare
pairwise;
a pair a reader cannot tell apart is a rejection. Once it ships, the gate is the check.

---

## Rule 6 — No text glyph is ever an icon

Round-5 critics caught two failures of the same kind: a Unicode-dingbat icon set, and an
emoji-presentation difficulty icon that Windows renders in colour, breaking the palette
outright (`ART-ASSETS.md`, "The actual answer on 'a defined feel'").

**Rule.** No icon is ever a character drawn by a font. Not a dingbat, not an emoji, not a
symbol from an icon font, not a letterform standing in for a picture. Every icon in the
game is drawn as vector geometry in `src/ui/Icons.js`, into an offscreen canvas, and
cached — "the build ships zero image assets and makes zero network requests"
(`src/ui/Icons.js:1-9`).

Both failures come from the same root: a text glyph's appearance is chosen by the
platform's font stack, not by us. It is therefore outside the palette (rule 1), outside
the shader treatment (rule 3), and outside the post stack (rule 4) simultaneously. That is
why the rule is absolute rather than a preference.

**What the code already looks like**, and what a new icon must match:

- Glyph bodies are drawing functions taking a canvas context, not strings:
  `src/ui/Icons.js:166-188` (`GLYPHS`), `:304` (`ABILITY_GLYPHS`), and the rule marks at
  `:846-857` (`markIcon`).
- Where an item declares a `glyph`, the value is a **name key** selecting a drawing
  routine, never a character to render: `src/data/items.js:258`, `:268`, `:281`, and the
  routine it selects at `src/data/items.js:1961` (`drawGlyph`), called from
  `src/data/items.js:1905`.
- Tier colour comes from the icon module's own table (`src/ui/Icons.js:30-44`), so an icon
  cannot introduce a colour by accident.

**Bought vector icons are admissible** (ratified 2026-08-15, question 6). "Every icon is
drawn in `src/ui/Icons.js`" is not a permanent architectural commitment. A purchased or
downloaded vector set may be brought in, redrawn or imported **as paths**.

This changes nothing about the rule itself, because a vector path was never a text glyph.
The rule's target is content whose appearance is chosen by the platform's font stack, and
a path is not that. An imported set still has to satisfy rule 1 (its colours map to
`PALETTE`, and tier colour keeps coming from `src/ui/Icons.js:30-44` rather than from the
set) and must not reintroduce a font dependency to render.

**Check before it lands.** Search the diff for string literals passed to `fillText` /
`strokeText`, for characters above U+007F in any UI data table, and for any new font
dependency. Any hit is a rejection. Text remains text — labels, numbers and names are not
covered by this rule; pictures are.

---

## The gate, in short

New art content lands only when all six answers exist in writing:

1. Which `PALETTE` entry each colour maps to.
2. Renders proving it reads both clean and blighted.
3. The line where it calls `attachWorldSurface`.
4. A screenshot through the shipping post chain, not a viewer.
5. A pairwise black-silhouette comparison against its comparison set — for a player
   character, that means every other player character.
6. No text glyph, no font dependency, no character above U+007F used as a picture.

---

## Ratified decisions

Settled by the author on 2026-08-15. These are the seven questions this document was
drafted with; each entry records the answer and what it changed, so a later reader can
tell which rules are measured findings and which are decisions.

**1. What makes two silhouettes "different enough"?** A combined score,
`0.6 * IoU + 0.4 * ContourSimilarity`, on aspect-ratio-preserving masks, worst case across
canonical views, with the pass threshold calibrated against the existing roster. Written
into rule 5. The draft's claim that no silhouette test exists anywhere in the codebase was
**wrong** and is corrected there: `tools/silhouette.mjs` and `tools/silhouette-metrics.mjs`
already gate enemy-vs-enemy and enemy-vs-survivor. The real gap is that
survivor-vs-survivor pairs are never constructed, which is why RANGER/ANVIL is ungated.
Implementation is **#61**.

**2. May a purchased asset supply texture maps?** Yes. Rule 3 now distinguishes a **map**
(permitted, bound into a `Materials.js`-built material) from a **material** (still
rejected). This turned out to be an ambiguity in one word rather than a conflict between
rules.

**3. Does rule 3 extend past world surfaces?** Corruption should visibly affect characters
and enemies; whether that means extending the shader over those models is undecided and is
an engineering question rather than a style rule. Deliberately **not** written into rule 3
— it is tracked at **#62**, and rule 3 stays scoped to world surfaces until that lands.

**4. What may new content be emissive?** New content may self-light. The **value cap
survives**: no scenery may out-value what the player has to read. Written into rule 4.

**5. Is the accent exclusive?** No. New content may use the accent hue, and further accent
hues may exist as the content warrants — under the same value cap as question 4. Written
into rule 4 alongside it, because the two answers share one constraint.

**6. Must icons stay procedural forever?** No. A bought vector set, redrawn or imported as
paths, is admissible. Rule 6 is materially unchanged, because a path was never a text
glyph — the rule targets content whose appearance the platform's font stack chooses.

**7. Which document governs a divergence?** `docs/art/ASSET-SPEC.md` governs, and the
agent updates it when decisions are made. Written into *Precedence* at the top.

### On questions 4 and 5

Both loosen rules that came from a measured defect rather than from taste, so the
reasoning is recorded rather than left implicit. The author's answers granted the
permission; the value cap was retained on the recommendation that "as appropriate" is not
a checkable criterion, and that the accent's cap exists because it was **measured** — luma
224 in a mean-luma-62 combat frame, the brightest non-VFX object on screen. The permission
is therefore on **hue and self-illumination**; the constraint is on **value**.
