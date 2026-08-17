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

1. **Projectile/spell body art beyond a tracer streak and a lightning bolt.** There is no arcing
   fireball/orb-projectile mesh or a shaped beam/bolt sprite set — `tracer()` is a thin core+glow
   streak tuned for hitscan weapons, not a travelling spell projectile with its own silhouette.
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
| Kenney Particle Pack | Yes (flares, streaks, magic) | Yes (stars/sparkles) | Yes (smoke/explosion) | No | Sprite/flipbook |
| Brackeys' VFX Bundle | Yes (magic swirls, beams) | Yes (sparkle/star sheets) | Yes (fire/explosion flipbooks) | Partial (has purple/dark sheets, must be re-checked per rule 2) | Sprite/flipbook |
| CC0 Special Effects (Ragnar Random) | Yes (spell/magic-flame animations) | No | Yes (explosions, hit/blood) | Partial (disintegration/aura effects, generic — not blight-specific) | Sprite/flipbook |
| Curl-noise FBO technique (mattdesl / al-ro) | Yes (organic trail/aura shape) | No | No | Possible (world-space noise field could echo `BlightMask`'s triplanar approach for a corruption *VFX* companion, not a replacement) | Shader / source technique |

None of these fill gap 3 (corruption-specific gameplay feedback) directly — the closest is the
curl-noise technique repurposed, not an off-the-shelf asset. That gap is better closed by
hand-authoring inside `VFX.js`'s existing `STATUS`/`KILL_SIGNATURE` pattern than by an external
pack, since any purple/violet-toned bought asset risks the Void double-up `ASSET-SPEC.md`
explicitly warns against (own baked-in colour already violet -> mud under the overlay).

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
- **What it fills**: Gap 1 partially (generic magic-swirl/flare/beam sprites, not shaped spell
  projectiles) and could refresh/extend the existing `FRAME` atlas rather than add a new system.

### 2. Brackeys' VFX Bundle — sprite/flipbook
- **Link**: https://brackeysgames.itch.io/brackeys-vfx-bundle
- **Licence**: CC0, checked 2026-08-17 on the itch.io page (explicit: distribute/remix/adapt,
  including commercial, no attribution required). Compiled from Kenney, Picster, Thomas Iché and
  CodeManu — all attributed as CC0-compatible sources on the page itself.
- **Three.js/WebGL fit**: Same shape as Kenney's pack — flipbook PNG sheets, drop-in as sprite
  textures or atlas tiles.
- **Licensing**: Clean, commercial-safe.
- **Performance/payload**: Name-your-own-price download; size not stated on the page, budget as
  comparable to the Kenney pack (tens of KB-few MB range for a sprite sheet set) — must be
  measured against the 20 MiB shortlist-wide ceiling before any subset is imported.
- **Art-style cohesion/readability**: Broader stylistic range than Kenney alone (multiple original
  authors) — more variance to screen per rule 1/rule 4 (palette mapping, value cap) before use.
  Some magic/aura sheets in this bundle read dark-purple by design; per rule 2, anything with a
  baked-in violet/magenta must be excluded or re-graded, not shortlisted on the theory that it
  "already looks corrupted."
- **Customization**: High, same additive-tint model as above.
- **What it fills**: Gap 1 (magic beams/swirls) and gap 2 (star/sparkle sheets for proc escalation)
  best of the four, precisely because it aggregates several CC0 sources into one broader set.

### 3. "CC0 Special Effects" by Ragnar Random — sprite/flipbook
- **Link**: https://opengameart.org/content/cc0-special-effects
- **Licence**: CC0, checked 2026-08-17 on the OpenGameArt page.
- **Three.js/WebGL fit**: Same as above — flat PNG animation sheets, drop-in sprite/flipbook use.
- **Licensing**: Clean, commercial-safe.
- **Performance/payload**: 29 assets; size not confirmed on the page — must be measured, not
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
  - Write-up/live demo: https://al-ro.github.io/projects/embers/ ("3D Curl Noise", cites
    Bridson et al.'s "Curl-Noise for Procedural Fluid Flow") — a technique article, not a
    redistributable package; treat as reading material, not an importable asset.
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
  - **Licensing**: MIT gist is clean; the al-ro write-up is a technique description with demo
    source visible in-browser but no explicit repo/licence link was found — treat as reference
    only, re-derive rather than copy.
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

1. **Spell/projectile shape** (gap 1): pull a small, palette-remapped subset of Brackeys' VFX
   Bundle (CC0) for magic-beam/orb sprite tiles, added to `VFX.js`'s `FRAME` atlas the same way
   `FRAME.SPARK`/`FRAME.SHOCK` already work — no new rendering path needed.
2. **Rarity/proc escalation** (gap 2): same source, its star/sparkle sheets, layered into
   `itemPickupBurst`'s existing two-emitter shape as a third, tier-gated emitter rather than a
   new system.
3. **Corruption feedback** (gap 3) and **denser spell trails** (gap 4): no external asset closes
   these safely — recommend hand-authoring inside `VFX.js` using the curl-noise technique as
   read-only reference, keeping full control over palette/Void-overlay compliance (rule 2) rather
   than importing anything with baked-in violet.
- Flag **Magic Spell Effects 15**'s licence to the user explicitly; if they can clear it
  (e.g. contacting the author for a broader grant), it is otherwise the strongest content match
  found for gap 1.
