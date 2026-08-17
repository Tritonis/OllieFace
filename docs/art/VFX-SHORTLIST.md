# VFX shortlist

Follow-up to #26, researched under #105. Research only — nothing here has been downloaded,
purchased, or integrated. Governed by `docs/art/ASSET-SPEC.md` (licence, palette, budget rules)
and `docs/ART-STYLE-GUIDE.md` (rules 1-6). Where this document and those disagree, they govern
and this document is wrong.

## What `src/systems/VFX.js` already covers

Before shortlisting anything, the gap has to be stated against what ships today. `VFX.js` is a
mature, pooled, additive/alpha two-layer particle system (`ParticleSystem`, capacity 20480
additive / 10240 alpha) plus `Trails`, `Decals`, `LightPool`, `BeamPool`, `RingPool`, and
`DamageNumbers`. It is hand-authored GLSL/JS, not imported sprites or meshes.

- **Impacts/hits**: `muzzleFlash`, `tracer`, `impact` (material-aware sparks/dust/decal via
  `MAT_PRESETS`), `hitSpark`, `bloodHit` — all fully implemented, material-typed, and following
  the "at least three simultaneous elements" design rule.
- **Explosions**: `explosion()` is an 8-layer effect (flash core, hot pip, heat glow, fireball
  blobs, shockwave ring, fireball rim, debris, trailing embers, smoke column, dust skirt) plus
  screen-space `shockwave()` distortion, shake, hitstop, decal and light. This is the deepest,
  most heavily-tuned effect in the file (lines ~510-775) and is not a gap.
- **Elemental kill signatures**: `KILL_SIGNATURE` (fire/ice/shock/nature/void/blast/kinetic) gives
  each damage type a distinct death read — motion first, colour second, keyed off `ELEMENT_HUE`.
- **Status VFX**: `STATUS` table (burn/bleed/slow/freeze/shock) — ongoing looping emitters
  attached to an afflicted entity.
- **Item pickup**: `itemPickupBurst(pos, tierColour)` — an upward spark cone plus a shock ring,
  tier-coloured. Implemented and simple.
- **Progression/spell-adjacent**: `levelUp`, `teleporterAura`, `lightning` (chained jagged bolt
  with branch sparks), corpse launch/dissolve (`deathDissolve` — the RoR2-style burn-away rig
  dissolve via `DissolveShader`).
- **Corruption**: `void` kill signature (inward, no ring) and `cloneCharacterBlightMaterial` /
  `CharacterBlight.js` — a *character*-mesh blight material distinct from the world-surface
  `BlightMask.js` overlay described in the style guide. The world-space Void overlay itself
  (rule 2) is a shader term on `Materials.js`-built materials, not a VFX-layer effect at all —
  it costs zero VFX assets per `ASSET-SPEC.md`.

### The actual gaps

1. **Corrected — a shaped spell projectile already ships, outside `VFX.js`.**
   `src/entities/Projectile.js:27-30` builds two shared geometries — a cone `body` and an
   icosahedron `orb` — with an emissive `MeshStandardMaterial` and a ribbon trail, spawned by
   `src/data/abilities.js:1117-1129` (`kind:'arc'`, the fireball-flask splash spell) and
   `:384-389` (`kind:'homing'`). The original survey read only `VFX.js` and concluded a
   whole-codebase absence from a single-file read — wrong. **The real, narrower gap:** the
   `orb` geometry is dead code — no ability spawn site passes `orb:true`, every projectile in
   the game currently renders as the same cone regardless of spell school — and projectile art
   is otherwise undifferentiated: one shape, one material bucket per colour, no per-element
   silhouette (contrast `KILL_SIGNATURE`'s deliberate per-element *death* differentiation with
   projectile *flight*, which has none). A shortlist for "spell/projectile art" should target
   this gap — activating/varying the existing `orb` and adding shape variety around it — not a
   from-scratch projectile mesh, which would duplicate what already ships.
2. **Rarity/proc feedback beyond one burst-and-ring.** `itemPickupBurst` is a single shape for
   every tier, distinguished only by `tierColour`. There is no escalating flipbook/shape language
   for higher-rarity procs (RoR2-style "this is a big deal" reads).
3. **Corruption-specific *player-visible gameplay feedback*** beyond the character blight material
   and the `void` kill signature — no dedicated ability-telegraph, ground-hazard-spread, or
   affliction-stack VFX keyed to blight specifically. (Whether corruption extends further over
   character/enemy meshes is tracked as an open engineering question, issue #62 — out of scope
   for this shortlist per `ASSET-SPEC.md`.)
4. **Technique gap, not an asset gap, for spells**: nothing in `VFX.js` uses GPU-computed
   particles (FBO/curl-noise) — every emitter is CPU-driven through the shared `ParticleSystem`
   ring buffer. A curl-noise technique reference is useful for a denser, more organic spell-trail
   look than the existing straight-drag-and-gravity emitters produce, without needing new assets.

## Licensing gate (read first)

Per `ASSET-SPEC.md`: **agent-findable means CC0 only.** Anything commercial or attribution-bearing
is a user decision, surfaced but not agent-usable. This project ships commercially on Steam, so a
licence that forbids commercial use is disqualifying outright, not a matrix cell.

| Candidate | Licence as checked (2026-08-17) | Commercial-safe | Agent-usable |
|---|---|---|---|
| Kenney Particle Pack | CC0 | Yes | Yes |
| Brackeys' VFX Bundle | CC0 (page states explicitly, incl. commercial use, no attribution) | Yes | Yes |
| "CC0 Special Effects" (Ragnar Random, OpenGameArt) | CC0 | Yes | Yes |
| curl-noise FBO particle techniques (mattdesl gist, al-ro writeup) | MIT / open write-up, code only | Yes (technique, not asset) | Yes |
| juniorxsound/Particle-Curl-Noise (GitHub) | **No LICENSE file found in repo** | Unknown | **No — flag, do not use as-is** |
| Magic Spell Effects 15 (creativekind, itch.io) | Custom commercial: use permitted, **redistribution/resale prohibited**, no CC0 | Conditionally (no redistribution) | **No — user decision** |

## Coverage matrix

| Candidate | Spells/projectiles | Pickup/rarity/proc | Impacts/explosions | Corruption feedback | Type |
|---|---|---|---|---|---|
| Kenney Particle Pack | Yes (flares, streaks, magic — as glow/trail dressing for `Projectile.js`) | Yes (stars/sparkles) | Yes (smoke/explosion) | No | Sprite/flipbook |
| Brackeys' VFX Bundle | Yes (magic swirls, beams — same role) | Yes (sparkle/star sheets) | Yes (fire/explosion flipbooks) | Partial (has purple/dark sheets, must be re-checked per rule 2) | Sprite/flipbook — **26 MB wholesale, over budget; subset only** |
| CC0 Special Effects (curated, 31 items) | Yes (spell/magic-flame animations) | No | Yes (explosions, hit/blood) | Partial (disintegration/aura effects, generic — not blight-specific) | Sprite/flipbook — **licence per-item, not blanket** |
| Curl-noise FBO technique (mattdesl / al-ro) | Yes (organic trail/aura shape) | No | No | Possible (world-space noise field could echo `BlightMask`'s triplanar approach for a corruption *VFX* companion, not a replacement) | Shader / source technique |

None of these fill gap 3 (corruption-specific gameplay feedback) directly — the closest is the
curl-noise technique repurposed, not an off-the-shelf asset. That gap is better closed by
hand-authoring inside `VFX.js`'s existing `STATUS`/`KILL_SIGNATURE` pattern than by an external
pack, since any purple/violet-toned bought asset risks the Void double-up `ASSET-SPEC.md`
explicitly warns against (own baked-in colour already violet -> mud under the overlay). Likewise
none replaces `Projectile.js`'s mesh — they would dress the shape that already exists (glow
billboards, trail textures) rather than provide a new one.

## Per-candidate assessment

### 1. Kenney Particle Pack — sprite/flipbook
- **Link**: https://kenney.nl/assets/particle-pack (mirrored at
  https://opengameart.org/content/particle-pack-80-sprites)
- **Licence**: CC0, checked 2026-08-17 on the Kenney page. No attribution required.
- **Three.js/WebGL fit**: Plain PNG sprite sheet, 512x512 source tiles — trivially usable as
  `THREE.Sprite`/billboard textures or as new `FRAME.*` tiles alongside the existing atlas
  (`GlyphAtlasLayout.js`-adjacent pattern), or re-baked into `ParticleSystem`'s own frame atlas.
- **Licensing**: Clean, commercial-safe, no gate issue.
- **Performance/payload**: 80 tiles at 512x512 RGBA before compression is well inside the 20 MiB
  asset ceiling (`ASSET-SPEC.md` budget table) if only a subset is imported and re-packed to a
  smaller atlas; importing the whole PNG set uncompressed would be wasteful and should be trimmed.
- **Art-style cohesion/readability**: Generic painterly particle look (soft glows, sparks, smoke,
  magic swirls) — none pre-tinted to a specific palette, so every sprite needs its dominant colour
  re-mapped to a `PALETTE` row (rule 1) before use; several are white/neutral cores that already
  match how `VFX.js` starts hot-tinted, not white, cores (see `impact()`'s comment on this).
- **Customization**: High — raw greyscale-ish alpha shapes are colour-multiplied at runtime
  exactly like `FRAME.SPARK`/`FRAME.SMOKE` already are, so no re-authoring needed to retint.
- **What it fills**: Gap 1 as corrected — generic magic-swirl/flare sprites could supply the
  per-element visual variety `Projectile.js` currently lacks (attached to the mesh as a glow
  billboard or trail texture, alongside activating the existing unused `orb` geometry), not a
  from-scratch projectile.

### 2. Brackeys' VFX Bundle — sprite/flipbook
- **Link**: https://brackeysgames.itch.io/brackeys-vfx-bundle
- **Licence**: CC0, checked 2026-08-17 on the itch.io page (explicit: distribute/remix/adapt,
  including commercial, no attribution required). Compiled from Kenney, Picster, Thomas Iché and
  CodeManu — all attributed as CC0-compatible sources on the page itself.
- **Three.js/WebGL fit**: Same shape as Kenney's pack — flipbook PNG sheets, drop-in as sprite
  textures or atlas tiles.
- **Licensing**: Clean, commercial-safe.
- **Performance/payload**: Page states **"Brackeys VFX Bundle v1  26 MB"** explicitly — the
  original document's "size not stated" was wrong. 26 MB is over the entire **20 MiB**
  shortlist-wide asset ceiling (`ASSET-SPEC.md`) on its own, before any other candidate is
  counted. Not usable wholesale; only a hand-picked subset (re-exported at reduced resolution
  and re-packed to a smaller atlas, as already recommended below) can fit, and that subset's
  own size must be measured before it is counted against the ceiling — no number for it exists
  yet.
- **Art-style cohesion/readability**: Broader stylistic range than Kenney alone (multiple original
  authors) — more variance to screen per rule 1/rule 4 (palette mapping, value cap) before use.
  Some magic/aura sheets in this bundle read dark-purple by design; per rule 2, anything with a
  baked-in violet/magenta must be excluded or re-graded, not shortlisted on the theory that it
  "already looks corrupted."
- **Customization**: High, same additive-tint model as above.
- **What it fills**: Gap 1 (magic beams/swirls) and gap 2 (star/sparkle sheets for proc escalation)
  best of the four, precisely because it aggregates several CC0 sources into one broader set.

### 3. "CC0 Special Effects" — curated OpenGameArt collection — sprite/flipbook
- **Link**: https://opengameart.org/content/cc0-special-effects
- **Licence**: **Corrected.** This is an OpenGameArt *Collection* page, not a licensable asset in
  its own right — it has no licence field of its own. It aggregates **31** (not 29) separately
  authored OpenGameArt submissions from multiple creators (CodeManu, Mikodrak, rubberduck,
  Cethiel, and others); Ragnar Random curated the collection but authored none of it. A 4-of-31
  spot check found every sampled sub-item independently marked "License(s): CC0" on its own
  page, so the practical conclusion likely holds, but the collection page itself cannot be
  licence-checked and this document previously claimed it had been. **Treat as: curated
  aggregate, licence must be confirmed per sub-item before use, 4/31 spot-checked CC0 as of
  2026-08-17** — not a blanket CC0 grant.
- **Three.js/WebGL fit**: Same as above — flat PNG animation sheets, drop-in sprite/flipbook use,
  per sub-item.
- **Licensing**: Provisionally clean per the spot check, but each of the 31 items needs its own
  licence line recorded before any one of them is used — do not import the collection wholesale
  on the strength of four checks.
- **Performance/payload**: 31 assets; size not confirmed on the page — must be measured, not
  assumed, before counting toward the 20 MiB ceiling.
- **Art-style cohesion/readability**: Pixel-art-leaning per the page description, which is a
  stylistic mismatch with this project's rendered-3D, post-processed look (rule 4's shipping post
  chain grades everything through GTAO/bloom/ACES/grade/SMAA) — pixel-art sprites read as a
  foreign asset class inside that pipeline unless heavily reworked. Flag as lower cohesion than
  candidates 1-2.
- **Customization**: Moderate — pixel art tiles retint less cleanly than soft painterly ones.
- **What it fills**: Gap 3's adjacent territory (has "disintegration" and generic "aura" effects)
  but none of it is blight/Void-specific, and the pixel-art mismatch makes it the weakest of the
  three sprite candidates for this project specifically.

### 4. Curl-noise GPU/FBO particle technique — source project (technique reference)
- **Links** (two references, cross-checked):
  - GLSL/JS gist: https://gist.github.com/mattdesl/2cd4e19150862dd5d923f4456fd245e1 — states MIT
    licence in the gist header, verified 2026-08-17.
  - Write-up/live demo: https://al-ro.github.io/projects/particles/ ("3D Curl Noise", cites
    Bridson et al.'s "Curl-Noise for Procedural Fluid Flow"; the originally-cited
    `/projects/embers/` meta-refresh-redirects here — corrected to the destination URL) — a
    technique article, not a redistributable package; treat as reading material, not an
    importable asset.
  - **Not shortlisted**: https://github.com/juniorxsound/Particle-Curl-Noise — no LICENSE file
    found in the repository as of 2026-08-17 (checked `LICENSE` at the default branch path,
    404). Code with no stated licence is not agent-usable per `ASSET-SPEC.md`'s CC0-only rule,
    and "no licence" is legally closer to all-rights-reserved than to permissive. Flagged, not
    shortlisted.
- **Three.js/WebGL fit**: Native — both references are three.js-specific GLSL techniques (FBO
  ping-pong textures for GPU-resident particle position/velocity, or an analytic curl-noise
  velocity field sampled per-particle). `VFX.js`'s current particles are CPU-updated through
  `ParticleSystem`'s shared ring buffer; adopting this would be a second, GPU-resident particle
  path alongside it, not a drop-in extension of the existing one.
  - **Licensing**: MIT gist is clean. **Corrected**: the al-ro write-up itself states no
    licence, but the destination page *does* link a GitHub source
    (`github.com/al-ro/al-ro.github.io/tree/master/projects/particles`) — that repo was checked
    and carries no LICENSE file (404 on both `master` and `main`), so the reference-only
    conclusion holds, but "no repo link was found" was imprecise; a link exists and was checked.
- **Performance/payload**: Zero download payload (it is code, not an asset) but a real cost in
  build/runtime complexity — a second GPUComputationRenderer-style pass, extra render targets,
  and a shader author's time. Runs against the `combat-24` frame-time ceiling
  (median <= 26.0 ms) like anything else touching the render loop; would need its own perf pass.
- **Art-style cohesion/readability**: Neutral — it is a motion technique, not a texture or
  colour, so it inherits whatever `FRAME`/colour values are fed into it and is exactly as
  compliant with rules 1/2/4 as the emitter authoring it.
- **Customization**: Maximum — it is source, so every parameter is exposed.
- **What it fills**: Gap 4 directly (organic, denser spell-trail motion beyond straight
  drag+gravity), and is the best-fit *technique* candidate for gap 1's "shaped spell projectile"
  if paired with new authored colour/shape rather than an imported texture.

## Flagged, not shortlisted (licence gate failed or unverifiable)

- **Magic Spell Effects 15** (creativekind, itch.io) — https://creativekind.itch.io/magic-spell-effects-15
  — commercial use permitted but redistribution/resale explicitly prohibited and no CC0 grant;
  per `ASSET-SPEC.md` this is a **user decision**, not agent-usable. Contains 7 spell-projectile
  flipbook sets (16-30 frames, 96px-325px) that would otherwise directly fill gap 1 — worth the
  user's attention specifically because it is the best content-fit found and the licence is the
  only blocker.
- **juniorxsound/Particle-Curl-Noise** — see above, no LICENSE file found, not agent-usable.
- **Synty Studios** — deliberately not re-surfaced here; tracked separately at issue #27 per
  `ASSET-SPEC.md`'s explicit instruction not to re-surface it in a general search.

## Recommendation

For the two gaps worth spending budget on now:

1. **Spell/projectile shape** (gap 1, corrected): the mesh already exists —
   `src/entities/Projectile.js:27-30`. The actionable work is (a) wire `orb:true` into a subset
   of `abilities.js` spawn sites so the geometry that already ships actually renders, and
   (b) pull a **small, individually-sized and palette-remapped** subset of Brackeys' VFX Bundle
   (CC0) for magic-beam/glow sprite tiles applied to the projectile mesh/trail, added to
   `VFX.js`'s `FRAME` atlas the same way `FRAME.SPARK`/`FRAME.SHOCK` already work. **Not the
   26 MB bundle wholesale** — it alone exceeds the 20 MiB shortlist ceiling; budget a specific
   handful of exported/re-compressed tiles (target: comparable to the ~80-tile Kenney pack's
   footprint) and measure the actual export size before committing it.
2. **Rarity/proc escalation** (gap 2): same source, its star/sparkle sheets, layered into
   `itemPickupBurst`'s existing two-emitter shape as a third, tier-gated emitter rather than a
   new system. Counts against the same trimmed-subset budget as (1) above, not an additional
   26 MB.
3. **Corruption feedback** (gap 3) and **denser spell trails** (gap 4): no external asset closes
   these safely — recommend hand-authoring inside `VFX.js` using the curl-noise technique as
   read-only reference, keeping full control over palette/Void-overlay compliance (rule 2) rather
   than importing anything with baked-in violet.
- Flag **Magic Spell Effects 15**'s licence to the user explicitly; if they can clear it
  (e.g. contacting the author for a broader grant), it remains the strongest content match found
  for dressing spell projectiles, though it is now secondary to activating the existing `orb`.
- Flag the **CC0 Special Effects** collection's per-item licence status to whoever picks specific
  assets from it — do not treat the 4/31 spot check as a blanket clearance for all 31.
