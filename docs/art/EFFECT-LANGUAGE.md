# The Effect Language

**Adopted 2026-08-22** (grill session, #145): shock split, re-elementings, reserved
hues, proc-grammar floor all confirmed; geometric-primitive expansion deliberately
parked to a backlog ticket until a re-authored build has been judged by eye.

Issue #145, Legible Effects milestone. Scoping document:
`.superpowers/sdd/legible-effects/audit.md` (159 rows, 10 co-occurring Collisions,
86 fittingness gaps, Capability Gaps G1-G4). Vocabulary is `CONTEXT.md`'s:
**Effect Language**, **Collision**, **Capability Gap**, used exactly.

This is the skeleton. It says what each dimension of an effect *means*, so that
two effects that are different things cannot land on the same point. It does not
say what any single effect looks like — hero effects are authored beyond it
(§8), and per-entry specs belong to the post-adoption re-authoring waves, not
here. A language that made every effect the same shape in eight colours would be
a new uniformity defect and a failure of this document.

Bar, in priority order, inherited from the audit: **noticeable → attributable →
discriminable → fitting**. A dimension may only be spent on discriminability
after noticeability is paid; that is why §4's silent families are resolved by
*adding a voice*, never by re-tinting one that is already there.

---

## 1. The dimensions

Four dimensions, each carrying one kind of meaning. Every effect is a point in
their product. All four are expressible in today's primitives — the 16-frame
`FRAME` atlas (`src/fx/ParticleSystem.js`) and `MAT_PRESETS`, beams / rings /
decals / lights / screenshake (all `src/systems/VFX.js`), and `Audio._tone` +
`Audio._noise` (`src/systems/Audio.js`) — except where a use is marked
**[#146]**, **[#147]** or **[#148]**.

| dimension | carries | mechanism |
|---|---|---|
| **Colour** | *element* (hue) and *source* (core/rim polarity) | particle `color0`/`color1` ramps, beam/ring tint, light colour |
| **Shape family** | *effect class* — what kind of event this is | choice of `FRAME` + line/ring/radial-spark/streak/pose |
| **Motion character** | *intensity*, jointly with audio | instant-radial / expanding-ring / travelling / sweeping / rising / falling / static-pose |
| **Audio envelope** | *element* (timbre) and *intensity* (envelope) | procedural synthesis only; see §1.4 |

### 1.1 Colour — hue means element

Hue is the element, and nothing else. Families are the audit §2.1 buckets, so a
re-run of its bucketing rules is a mechanical check of conformance.

| element | family | reserved for |
|---|---|---|
| fire / burn | ember-orange | ignition, burn ticks, pyres, meteor |
| blast / concussive | amber-warm | detonation, kinetic nova, shockwave |
| shock / electric | periwinkle-blue | arcs, chains, tesla, galvanic |
| frost / ice | ice-blue | freeze, slow, rime, chill zones |
| toxic / spore / bio | acid-green | clouds, spores, corrosive, swarm |
| restorative | mint-green | healing, revive, shields granted |
| gravity / mass | violet | pull, snare, collapse, wells |
| void / entropy | magenta | siphon, unmake, denial, corruption |
| physical / earth | tan-brown, earth-brown, bone-cream | debris, impact dust, bone, rebar |
| gore | element-tinted red (partly **[#147 G4]**, see §6) | `bloodHit` splat, tinted by the killing element |

The consequential move is **splitting shock out of ice-blue into
periwinkle-blue**. Today ice-blue means both lightning and frost, which is the
root of C1 and C8 and the reason seven chain-lightning items and a freeze nova
share a bucket. Periwinkle-blue is already an occupied, distinct bucket
(`shriver`, `galvanic`), so the split costs no new region of the space.

Two hues are **reserved and may never be spent on damage**: mint-green
(restorative) and magenta (void). A mint-green damage effect is a language
violation regardless of how it is authored.

### 1.2 Colour — core/rim polarity means source

Hue says what it is; polarity says whose it is.

- **Player effects**: white-hot core, element rim (`color0` near white, `color1`
  the element hue). This is already how `rookWard`, `anvilSweep` and
  `kestrelLance` read.
- **Enemy effects**: element core, dark or smoke rim (`color0` the element hue at
  full chroma, `color1` a low-lightness version of it). Requires the
  `spawnBlast` core-colour parameter **[#147 G3]** for every nova/slam/stomp —
  the fixed warm `0xffdc96`/`0xfff4d8` core is exactly what defeats polarity
  today (C2).
- **Elite modifier auras and their death events** take the enemy polarity at
  raised chroma, so an elite reads as *more of its element*, not a new one.

Polarity is a second channel on the same pixels, which is what lets class-kit
colour (audit X3) coexist with enemy colour in co-op: a Ranger's amber tracer
has a white core, a Harrier's amber barrage does not.

### 1.3 Shape family means effect class

| class | shape family | typical frames |
|---|---|---|
| directed single-target | **line** | beam, tracer, `BOLT` |
| area / zone / persistent hazard | **ring** | `RING`, `SHOCK`, ground telegraph |
| point impact / proc landing | **radial-spark** | `CROSS`, `SPARK`, `FLARE` |
| travelling ordnance | **streak** | `SPARK` stretched, `EMBER`, trail |
| protective / warded | **lattice** | `HEX`, `SQUARE` shell, spin ≠ 0 |
| telegraph / windup | **pose + ring** | pose plus a ground `SHOCK` ring |

**Lattice** is a new class name for an existing capability (`HEX` with spin,
already used by `shieldBreak`), introduced so that "a shield is going up" and "a
freeze is going off" cannot be the same shape (C8).

Persistent hazards use a *held* ring — a ring redrawn on a tick is the same
shape as an instantaneous nova, which is C7's mechanism. A hazard ring must
differ from an event ring in at least one of: sustained inner `DUST` fill,
non-zero spin, or a boundary that does not expand.

### 1.4 Motion + audio envelope mean intensity

Intensity is a three-step scale — **tick / event / heavy** — and both motion and
audio must agree on which step an effect is at. Disagreement is what makes a
16m stunning nova feel like nothing (`overload-cell`).

| step | motion | audio envelope | screen layer |
|---|---|---|---|
| tick | small, local, no expansion | short, ≤120ms, low gain, positioned | none |
| event | expanding-ring or travelling | 150-400ms with a transient | shake ≤0.05 |
| heavy | expanding-ring + debris + light | ≥400ms, transient + body + tail | shake, hitstop |

#### Audio envelope families

The audit §2.1 buckets envelopes into ten families (`crack-body`,
`crack-rumble-sub`, `sweep-crackle`, `ascending-sine`, `chord`,
`crack-tonal-fall`, `tick-thump`, `pip`, `sustained-low-chord`, `NONE`), and a
bucketing re-run can only see separations expressed in those terms. This
document **extends that list by three named families**, so that every separation
it claims is family-level by its own definitions rather than a texture
description:

| family | definition | why it is a family, not a texture |
|---|---|---|
| **plucked-tonal** | a single tonal transient with no noise bed, an immediate attack and a free exponential decay of ≥250ms, pitch fixed for the whole decay | distinct from `crack-tonal-fall` (which has a noise crack and a *falling* pitch) and from `pip` (≤80ms, no decay tail). A struck string. |
| **wobble-drone** | a filtered, pitch-unstable held tone whose detune is LFO-modulated (the existing pattern at `Audio.js:472-477`), no transient at onset | distinct from `sustained-low-chord` (fixed pitch, chordal, slow attack) and from every transient family, which have onsets it does not. |
| **sustained-rise** | a held voice whose pitch or filter cutoff climbs monotonically for the whole of a game state, releasing at its end **[#146 G2]** | the telegraph/charge family; distinct from `sweep-crackle`, whose sweep is a fixed-duration burst scheduled up front. |

Any future separation on audio must name one of these thirteen families. A
resolution that separates two effects by a texture with no family name has not
separated them, because the bucketing re-run will not see it.

**Audio stays procedural synthesis by default.** Each element carries a timbre
recipe discriminable by ear and fitting to its name:

| element | recipe (`_tone` / `_noise`) |
|---|---|
| fire | bandpass noise 300-2200Hz, slow attack, no tonal partial |
| blast | noise transient + sine sub, fast attack, long tail |
| shock | square/saw pair, detuned, fast exponential sweep + highpass crackle |
| frost | triangle high partial + highpass noise hiss, no sub |
| toxic | lowpass square with slow detune wobble, wet and pitch-unstable |
| restorative | pure sine ladder, ascending |
| gravity | sine pair detuned ~7Hz, *descending* sweep, no noise |
| void | sine descending under a bandpass noise bed, high detune |
| physical | short noise thump, lowpass, no tonal content |

Sampled playback is **not** part of the language. It exists only for the seven
G1-named entries (`carrion-flies`, `scrapfly-hive`, `hive-gland`,
`whisper-stalks`, `battle-hymn`, `gorge-tooth`, `charnel-bloom`) and only if
**#148** approves it. If #148 declines, those seven take their family's
procedural recipe with an authored irregularity (detune drift, retrigger jitter)
and lose only their bespoke timbre, not their point in the language — no
resolution in §3 or §4 depends on a sample.

A **sustained positioned voice** **[#146 G2]** is the one new audio primitive
the language assumes: a voice that starts, holds while a game state persists,
and releases. Every use of it is marked.

### 1.5 How a discriminability claim is demonstrated

No claim in this document is self-certifying. The tier palette's precedent
(`src/ui/Icons.js`, `tools/colour-vision.mjs`, `tests/readability-gate.test.mjs`)
is the standard: a claim names a check, and the check is capable of failing.

| check | what it demonstrates |
|---|---|
| **Bucketing re-run** — re-run audit §2.1's rules over the re-authored surface | that a named Collision group's members no longer share all four dimensions. The audit's own rules, so the result is comparable to the baseline. |
| **Showcase pile-up** (`src/core/Showcase.js`, Shift+F9) | eye/ear judgment of a group firing *together*, at adjacent offsets, down real paths through the real voice budget. Two forms, and every citation below uses one of them by name. |
| **`deltaEUnder` sweep** (`tools/colour-vision.mjs`, `VISIONS`) | that two element hues stay apart under protan/deutan/tritan/mono, as the tier palette proved. Applies to §1.1's element table as a whole, once, not per effect. |
| **`tests/showcase-surface.test.mjs`** | that the showcase still enumerates the whole surface, so a pile-up preset cannot silently stop covering a group. |

The eight presets that exist today, and no others, are:

| key | preset |
|---|---|
| `1` | every `onHit` proc at once |
| `2` | every `onKill` proc at once |
| `3` | every `onDamaged` proc at once |
| `4` | four equipment together |
| `5` | a kill, its loot and a level |
| `6` | every status at one point |
| `7` | **three** telegraphs overlapping (`.slice(0, 3)` — not the full set) |
| `8` | all six elite modifiers side by side |

The second form is the **filter + mark + `g` workflow**: letters filter the list,
arrows move, `Space` marks each entry wanted, `g` fires everything marked
together at adjacent offsets. It reaches any subset of the 164 entries and needs
no new code. Where neither form covers a claim, the resolution says **"requires
a new showcase preset"** and that is a dependency of adopting it, not a check
already in hand.

A resolution that cannot name one of these is not adopted.

---

## 2. Relationship to the tier palette

The tier palette (`TIERS` in `src/ui/Icons.js`: Common, Uncommon, Legendary,
Boss, Umbral, Blight, Equipment, Argent) has **reserved meanings that this
language does not touch**. Its eight colours were cut as a set against
CIEDE2000 and contrast floors under colour-vision simulation, and re-cutting one
of them to free a hue for an element would break that proof.

The separation rule is by **surface**, not by hue:

1. **Tier colour appears only on item-identity surfaces** — icon plates, logbook
   rows, the haul grid, the strip, and the one world effect that is *about*
   acquiring an item: `VFX.itemPickupBurst(pos, tierColour)`, plus the pickup
   sting that rises with tier. Nowhere else — and the surface is defined by what
   it depicts, not by where it happens: an effect qualifies only if the thing
   being acquired *has* a tier. Gold does not, which is why §4.4's coin cue is
   not tier-coloured.
2. **Element colour appears only on effect surfaces** — anything an ability,
   item proc, equipment, telegraph or elite affix draws in the world.
3. Therefore a hue collision between the two palettes is **not** a Collision in
   the `CONTEXT.md` sense: they cannot occupy the same point because they cannot
   occupy the same surface. A Legendary's `#fc6c78` and a coral-red hit spark
   never have to be told apart, because one is on a plate in the UI and the
   other is on an enemy.
4. What an item *does* is never coloured by its tier. A Blight-tier fire proc is
   ember-orange, not magenta. The pickup is the only tier-coloured moment.
5. Tier colour also carries a **shape** (`TIER_MARKS`) precisely because eight
   bright colours cannot be separated by hue alone. The same principle is why
   §1.3 exists here: colour never works alone in either palette.

One consequence to hold: `itemPickupBurst` is a *radial-spark, rising, tier-
coloured* point and is the single sanctioned exception to §1.1. It must not be
reused as a proc shape by any item.

---

## 3. Resolutions — the ten co-occurring Collision groups

Family-level. Each names the dimension that separates the group and its
demonstration.

**C1 — ice-blue · line · travelling · NONE** (`arc-rot`, `quicksilver-vein`,
`copper-wire`, `cracked-zither`, `arc-capacitor`, `squall-charm`, `spark-plug`).
Separated on **colour (element), frame family, motion character and audio
envelope family** — every member must differ from every other on at least one
*bucketed* dimension, not on a within-family nuance like bounce count. Moving
the whole group to periwinkle-blue shock and giving it one shock recipe would
merely rename the point from ice-blue/NONE to periwinkle-blue/shock; that is the
failure mode this resolution is written to avoid. The seven land as follows,
inside the approved shock decision:

| member | colour | frame | motion | audio envelope |
|---|---|---|---|---|
| `copper-wire` | periwinkle shock | line | travelling | sweep-crackle |
| `cracked-zither` | periwinkle shock | line | travelling | **plucked-tonal** (§1.4; a struck string) |
| `arc-capacitor` | periwinkle shock | **radial-spark** | **instant-radial** | crack-rumble-sub (a stored charge released) |
| `spark-plug` | periwinkle shock | **streak** | travelling | crack-body |
| `arc-rot` | **toxic acid-green** | line | travelling | **wobble-drone** (§1.4; it is rot, not lightning) |
| `quicksilver-vein` | **physical tan-brown** | line | travelling | tick-thump (a metal, not an arc) |
| `squall-charm` | **physical bone-cream** | **streak** | travelling | tick-thump (it is wind) |

No two rows share all four, and every separator is a **named family** — colour
families from §1.1, frame families from §1.3, motion characters and audio
envelope families from §1.4, which is where `plucked-tonal` and `wobble-drone`
are defined precisely so this table's audio separations are visible to a
bucketing re-run. `copper-wire` and `cracked-zither` are the pair that forced
that definition: they agree on colour, frame and motion, so their separation
lives entirely on the audio axis and had to be promoted from a texture
description to a family. Bounce count still varies the figure's *length*, but it
is decoration on top of a separation that already holds at family level.
*Demonstrated by*: preset `1` (every `onHit` proc at once) for the eye/ear call,
and a bucketing re-run on audit §2.1's rules as the mechanical check — that
re-run is precisely what would catch this group re-forming at a new point, and a
resolution that only re-hued it would fail it.

**C2 — warm · ring+radial-spark · expanding-ring · crack-rumble-sub** (13
tier-2 nova/slam/stomp users plus `galvanic`, `rimebound`, `warded`).
Separated on **colour**, and it cannot be separated any other way: the fix is
the parameterised `spawnBlast` core **[#147 G3]**. Core takes the source's
element hue at enemy polarity (§1.2), rim keeps the smoke. Audio gains a
per-element transient layered over the shared `explosion` body, so the rumble
stays common (all novas are novas) and the attack is elemental. Boss phase novas
take *heavy* intensity where ordinary ones take *event*. *Demonstrated by*: preset `8` (all six elite
modifiers side by side), which stands `galvanic`, `rimebound` and `warded`
together and is the exact case the fixed core defeats today. The 13 tier-2
nova/slam users are not covered by any existing preset — judging those together
**requires a new showcase preset** (every nova at one point), which is a
dependency of adopting C2's enemy-side half.

**C3 — line · sweeping · sweep-crackle** (`sentinel`, `harrier`, `redoubt`,
`colossus`, `vizier`, `thunderhead`, `herald`, `tesla-crown`, `gravity-snare`).
Separated on **audio element and source polarity**. `zap()` stops being the
universal beam voice: each beam takes its element recipe, and `gravity-snare`
leaves the group entirely under §4.1. Player beams take white-core polarity;
enemy beams take element-core. The windup gains a sustained charge voice
**[#146 G2]** that rises for the telegraph duration and releases at fire — which
also resolves C3's compounding with C6. *Demonstrated by*: preset `7` (three
telegraphs overlapping), judged for whether two beams charging at once are
separable — note that preset `7` is capped at three entries, so covering the
beam users as a set **requires a new showcase preset**. The player side
(`tesla-crown`, `gravity-snare`) is covered today by the filter + mark + `g`
workflow over the equipment entries.

**C4 — radial-spark · instant-radial · crack-body** (every projectile release).
Separated on **audio pitch-per-source** — an existing, unused capability, not a
gap. Each shooter is assigned a fundamental within its element's recipe, held
constant across that shooter's lifetime, so a horde reads as a chord of distinct
sources rather than one voice at varying scale. Scale continues to carry
intensity only. *Demonstrated by*: a bucketing re-run cannot see pitch, so the
check is an eye/ear one — the filter + mark + `g` workflow over several
telegraph entries marked together fires their releases at adjacent offsets
today, and a full-horde version **requires a new showcase preset**. "Reliable
across a horde" is the claim under test and only the latter settles it.

**C5 — mint-green · radial-spark · rising · ascending-sine** (`healPop`,
`acolyte` mend, `mending-flare`, `playerRevived`). Separated on **shape class
and motion**. Healing stays radial-spark rising. An *enemy* mend takes enemy
polarity (element core), so an Acolyte's heal is visibly not the player's.
`playerRevived` leaves the family for a **lattice, expanding, heavy** point of
its own — a revive is a person standing up, not a heal tick — and must call a
distinct voice rather than re-authoring `heal()`'s ladder. *Demonstrated by*: a
bucketing re-run, plus the filter + mark + `g` workflow over the `playerDowned`
and `playerRevived` moment entries fired alongside `mending-flare` — no existing
preset contains them (preset `5`, the nearest run-level one, is
`killSignature`/`damageNumber`/`levelUp`/`pickup:legendary`).

**C6 — silence · pose · static-pose · NONE** (16 telegraph windows: all melee
windups, non-blink charges, summon casts, `shrike`'s dive). This is a
**noticeability** failure, the first bar, and is resolved by *adding*, not
separating. Every windup gains a ground telegraph ring in the attacker's element
(`Director.spawnTelegraph` already exists and is merely excluded from those kind
lists) and a **sustained-rise** windup voice (§1.4) **[#146 G2]** whose length equals the
window, so a 1.9s Colossus barrage and a 0.66s scarab lunge are different
lengths of the same grammar. `shrike`'s dive takes *heavy* intensity — it is a
suicide diver and the riskiest gap on the roster. *Demonstrated by*: preset `7`
(three telegraphs overlapping — capped at three by its own `.slice(0, 3)`), with
the filter + mark + `g` workflow over the telegraph entries for any other
grouping; judging all 16 windows as a set **requires a new showcase preset**.
The claim under test is that a windup
is distinguishable **from idle**, which is the bar C6 actually fails.

**C7 — ember-orange · ring · expanding-ring · NONE** (`leaking-jerrycan`,
`warlock-ember`, `emberwake`, `cinderPyreFlask`). Separated on **shape (held
hazard ring vs event ring, §1.3) and motion**. `emberwake` is a trail under a
moving player: held ring with `DUST` fill and no expansion. `leaking-jerrycan`
and `cinderPyreFlask` are ignitions: one expanding ring, then a held hazard ring
at the same site. `warlock-ember` is a spread, so it takes travelling streaks
between victims rather than a ring at all. All gain fire-recipe voices at *tick*
intensity for the hazard and *event* for the ignition. *Demonstrated by*: preset `2` (every
`onKill` proc at once) plus a bucketing re-run.

**C8 — ice-blue · ring · expanding-ring · crack-tonal-fall**
(`frostbite-canister`, `aegis-emitter`). Separated on **shape class and audio**.
`aegis-emitter` is protective and takes the **lattice** class with a rising
frost-into-restorative voice; `frostbite-canister` keeps the expanding ring and
takes the frost recipe. Neither keeps `shieldBreak`'s voice, which belongs to a
shield *ending*. *Demonstrated by*: the filter + mark + `g` workflow over the
two equipment entries, fired together (preset `4` takes the first four
equipment, which is not this pair) — the semantic inversion (§4.1) is an eye/ear
call, not a bucket call.

**C9 — violet · line · travelling · NONE** (`prism-splinter`, `hive-gland`,
`mourners-dagger`). Separated on **colour, by re-elementing**. None of the three
is actually gravity: `prism-splinter` is a crit shatter (physical, bone-cream,
shard frames), `hive-gland` is a swarm (toxic acid-green), `mourners-dagger`
stays magenta but as void, which its fiction supports. Violet is left to actual
gravity effects (`gravity-well`, `gravity-snare`). All three gain voices.

`hive-gland` and C1's `arc-rot` are both toxic acid-green, so they are separated
on **frame family**, which holds in every mode: `hive-gland` is a swarm of motes
and takes **streak**, `arc-rot` is an arc and stays **line**. This is deliberate
rather than incidental — `hive-gland` is one of the seven G1-named entries, so
absent **#148** its voice degrades to the toxic base recipe (`wobble-drone`),
which is `arc-rot`'s envelope family exactly. **A G1 entry's degraded fallback
point is part of the language and must be checked like any other point**: a
separation that exists only in an entry's sampled ideal does not exist, because
#148 may decline. Every G1 entry is therefore separated from its neighbours on a
dimension other than timbre. *Demonstrated by*: a bucketing re-run, which will
show three different colour families where there were two adjacent ones, and
which must be run against the degraded assignment, not the sampled one.

**C10 — amber-warm · streak · travelling · crack-body** (`bile-shell`,
`missile-rack`). Literally the same effect on two items. Separated on **colour
and audio**: `bile-shell` is toxic (acid-green, wet lowpass-square voice),
`missile-rack` is blast (amber-warm kept, noise+sub). Both keep the
**crack-body** envelope — a fired shell has an onset — which is also what keeps
`bile-shell` off `hive-gland`'s point (§C9), the two being otherwise identical
in colour, frame and motion; `hive-gland` is `wobble-drone`, a held swarm with
no onset. Element *timbre* and envelope *family* are independent axes here: two
effects may both sound toxic and still sit in different envelope families.
*Demonstrated by*:
bucketing re-run; this is the cleanest mechanical case in the set.

### 3.1 The co-op groups (X1-X3)

The audit recommends treating class-kit colour as co-occurring, and this
document does: under co-op X1-X3 are live, raising the count to 13. They are
**not** resolved by re-huing kits — a class's colour is part of its identity.
They are resolved by §1.2 polarity plus per-class *shape* signature: Ranger
lines, Anvil rings, Kestrel charged lines with bead spool-ups, Rook lattices,
Cinder cones of streaks. Two amber players are then separable by what shape
their amber takes. *Demonstrated by*: the filter + mark + `g` workflow — filter
to the ability entries, mark two classes' primaries, fire them at adjacent
offsets. No preset covers cross-class mixing.

---

### 3.2 Cross-group check

Re-elementing a member out of one group can land it on another group's point, so
every reassignment above was walked against the whole set. A resolution is not
complete until this check has been done, and the bucketing re-run is what
enforces it — it does not know which group an effect used to be in, only where
it now sits.

| pair checked | shared | separated on |
|---|---|---|
| `arc-rot` (C1) vs `hive-gland` (C9) | toxic acid-green, travelling; envelope too in the no-#148 case | **frame**: line vs streak |
| `hive-gland` (C9) vs `bile-shell` (C10) | toxic acid-green, streak, travelling | **envelope**: wobble-drone vs crack-body |
| `arc-rot` (C1) vs `spore-sac` (C7 family) | toxic acid-green | **frame + motion**: line/travelling vs held hazard ring, no expansion |
| `copper-wire` (C1) vs `cracked-zither` (C1) | shock, line, travelling | **envelope**: sweep-crackle vs plucked-tonal (§1.4) |
| `copper-wire` (C1) vs the C3 beams | shock, line | **motion**: travelling vs sweeping; plus source polarity (§1.2) |
| `quicksilver-vein` (C1) vs `rebar-launcher` (§1c, tan-brown) | physical tan-brown, travelling | **frame**: `rebar-launcher` is launched ordnance and takes streak; the arc stays line |
| `quicksilver-vein` (C1) vs `tether-harpoon` (§4.2) | physical tan-brown, line, travelling | **envelope**: tick-thump vs the harpoon's sustained taut voice **[#146]** |
| `squall-charm` (C1) vs `prism-splinter` (C9) | physical bone-cream | **frame + motion**: streak/travelling vs radial-spark/instant-radial (a shatter happens at the crit point) |
| `cracked-zither` (C1) vs `coin` (§4.4) | tonal, no noise bed | **envelope**: plucked-tonal (≥250ms decay) vs pip (≤80ms); plus colour |

## 4. Fittingness treatments, by family

What the family should evoke, and which dimensions carry it. Family-level;
per-entry authoring is a later wave.

### 4.1 Equipment (audit §4.1 — 4 entries)

- **`gravity-snare`** — must evoke *mass*, not arcing. Violet, ring, contracting
  motion (the one place inward motion is sanctioned), gravity recipe: detuned
  sine pair on a descending sweep, no noise, sustained for the pull **[#146]**.
  Leaves C3 by doing so.
- **`overload-cell`** — the loudest-looking equipment in the tier is silent.
  Blast element at **heavy** intensity: amber-warm, expanding ring plus debris,
  noise transient + sine sub with a long tail, shake and hitstop.
- **`frostbite-canister`** — frost, not another effect's identity. Ice-blue,
  expanding ring, frost recipe (triangle partial + hiss). Must not use
  `shieldBreak`'s voice.
- **`aegis-emitter`** — protective. Lattice class, rising motion, a voice that
  *builds* and holds while the dome stands **[#146]**. The current cue is
  semantically inverted and must go.

### 4.2 Items (audit §4.2 — 49 entries)

The audit's 49 partition as **46 + 1 + 2**: the 46 hookless-feedback procs of
§1d, `tether-harpoon`, and the two cloud items. The third bullet below is *not* a
fourth part of that partition — the 13 named-promise items are a **subset of the
46**, called out because they need more than the floor the first bullet sets.

- **The 46 hookless-feedback procs (§1d)** — the root cause is one thing: the
  hook leans entirely on the generic damage/heal pipeline and adds nothing. The
  language's answer is a **proc grammar**: every item proc, however small, emits
  at minimum a *tick*-intensity radial-spark in its element at the point it
  acted, with a positioned tick voice. This is a floor, not a design — it buys
  the noticeability bar for all 46 at once, and the ones that deserve more get
  more in a later wave. Stat/buff procs (`bloodscent`, `bandolier`) emit at the
  player; damage procs at the victim.
- **The named-promise items** (`chime-of-absolution`, `battle-hymn`,
  `whisper-stalks`, `carrion-flies`, `charnel-bloom`, `concussion-charge`,
  `red-mist-pauldron`, `corpse-flare`, `molten-core`, `resonance-coil`,
  `hoarfrost-band`, `kinetic-recycler`, `shrapnel-heart`) — 13 entries, **all of
  them members of the 46 above, not additional to them** — these are the
  sharpest fittingness failures because the fiction is explicit, and they are
  where the language explicitly *steps aside*: each gets a bespoke authored
  effect whose element and class conform to §1, and whose timbre is its own. Of
  these, the G1-named subset depends on **#148** for sampled timbre and
  otherwise degrades to a procedural recipe with authored irregularity (§1.4).
  Each of the seven must be separated from its neighbours on a dimension other
  than timbre, so that its **degraded** point is as legible as its sampled one —
  see §3.2 and the `hive-gland`/`arc-rot` case in C9.
  `shrapnel-heart` is the highest-frequency proc in the game and must be
  authored at *tick* intensity or it will dominate the mix.
- **`tether-harpoon` and the two cloud items** (`emberwake`, `spore-sac`) —
  mechanical reel and persistent hazard respectively. The harpoon evokes
  *tension*: physical element, line class, a sustained taut voice for the reel
  **[#146]** with an impact at the anchor. The clouds take the held hazard ring
  (§1.3, C7) with a sustained bed while the cloud lives **[#146]**, toxic recipe
  for spores and fire for emberwake.

### 4.3 Tier 2 — telegraphs, hit reactions, elites (audit §4.3)

- **`UNIVERSAL-hitReaction`** — gore must carry damage type; today the gore
  layer is a fixed red on every hit in the game. The audit's G4 overstates the
  gap and this document corrects it: `bloodHit(pos, dir, colour = 0x9c0d18)`
  (`src/systems/VFX.js:470`) *already takes* a colour argument, and its one call
  site (`VFX.js:1401`) simply passes the default. Re-tinting the **primary gout**
  by element is therefore expressible today, with no #147 dependency — it is a
  call-site change. What genuinely needs a source change is the rest of the
  effect: the internal `hitSpark(pos, 0xff5a5a, 0.8)` (`VFX.js:499`) and the
  mist layer colours (`VFX.js:494`) are hardcoded and unreachable through that
  argument. That narrower parameterisation is what §6 books against **[#147]**.
- **`KIND-melee`** (9 enemies) — evokes *a body committing*. Pose plus a short
  element ground ring at the attacker's feet and a rising physical windup voice
  **[#146]**. See C6.
- **`KIND-projectile-noTelegraph`** (6 enemies) — evokes *aiming*. A brief
  muzzle-side charge glow and a rising charge voice before release **[#146]**;
  the release cue stays where it is.
- **`KIND-beam` / `barrage`** (7 enemies) — evokes *a weapon spooling*. The aim
  line gains beads travelling toward the muzzle (the `kestrelLance` grammar,
  enemy polarity) and a sustained rising charge that releases into the beam
  **[#146]**. Redoubt's 1.7s and Colossus' 1.9s are the largest silent windows
  measured and are the acceptance cases.
- **`KIND-pull`** (3 enemies) — evokes *being dragged*. Contracting ring plus a
  sustained gravity-recipe voice for the whole 1.5-1.7s drag **[#146]**; this is
  the gap G2 exists to close.
- **`KIND-charge` non-blink** (3 enemies) — evokes *a wind-up to a sprint*.
  Ground scuff decal, dust at the feet, accelerating tick voice whose rate rises
  into the dash.
- **`KIND-summon`** (3 enemies) — evokes *something arriving from elsewhere*. A
  ground rift ring at each arrival point for the whole 1.4-1.6s cast, growing,
  with a sustained void bed **[#146]**. Arrival keeps its pop.
- **`shrike`** — a suicide diver. Ground shadow ring tracking the dive, rising
  pitch tied to closure, *heavy* intensity at detonation. Highest-priority
  single entry in this section.
- **`warden_vault`** and **`herald`** — inherit the kind-level fixes above and
  then take hero authoring (§8) at boss intensity; a named elite and the finale
  boss must not read as a better-dressed charger.
- **The six elite modifiers** — an elite affix must be legible as *the affix*,
  from outside its radius and at the moment it acts:
  - `emberclad` — fire; the aura tick needs a per-tick player-facing cue (the
    `target.isPlayer` early-return in both `VFX._onDamage` and Audio's damage
    handler is what silences it) plus a held ring at `auraRadius`.
  - `galvanic` — shock; its blue survives only once the blast core is
    parameterised **[#147 G3]**, and the `shock` status it applies needs the
    status voice from §4.4.
  - `rimebound` — frost; the death nova must stop using the pale cyan the
    ambient aura was deliberately moved off for failing to read.
  - `withering` — void, not mint-green: it *denies* healing, and colouring
    denial with the restorative hue is a direct violation of §1.1's reservation.
    `denyRadius` needs a visible boundary and a held bed while a player stands
    inside it **[#146]**; healing that is being denied must show a failed heal.
  - `warded` — protective, so **lattice** class; the reflect tick needs its own
    proc identity (`type:'reflect'` is set today and read by nothing).
  - `voidtouched` — void; both halves of the loop need presentation — the drain
    on the player and the self-heal that undoes the player's damage.

### 4.4 Tier 3 — run-level moments (audit §4.4)

- **`statusApplied`** — every status application in the game is silent. Each
  status type takes a short voice in its element's recipe, pitched by status
  type, at *tick* intensity, alongside the existing `VFX.status()` pop. This one
  fix voices burn, freeze, shock, slow and void at once.
- **`playerDowned`** — must evoke *a person falling*, not a quieter death. Its
  own descending figure plus a world-space effect (there is none today): a
  collapsing ring and a low held marker at the body **[#146]** so teammates can
  find it.
- **`playerRevived`** — the most consequential co-op event. Lattice, expanding,
  heavy, restorative; a distinct voice, called rather than re-authored. See C5.
- **`coin`** — audio-only today, and six items grant gold silently. Gold takes a
  small rising spark at the gain point under the existing pip, in the **fixed
  coin hue** (amber-warm, the physical/metal family), **not** a tier colour:
  gold is not a tiered item and has no tier to carry, so §2's rule stands
  unbroken — `itemPickupBurst` remains the only tier-coloured world effect.
- **`bossHorn`** — a boss arrives with a 55Hz horn, a camera shake, and nothing
  in the world. Needs a world event at *heavy* intensity in the boss's element:
  an expanding ring from the spawn point and a light burst, so the horn has a
  place it came from.

---

## 5. What the language does not govern

- **Hero effects.** Every survivor ultimate, every boss signature moment, and
  the named-promise items of §4.2 are authored beyond the skeleton. The language
  constrains their *element hue*, their *source polarity* and their *intensity
  step* — that is all. Their shapes, their layer counts and their timbres are a
  taste call, and a hero effect that reads as "the language plus more particles"
  has failed differently but has still failed.
- **Ambience and environment.** `teleporterAura`, weather, realm mood, music
  beds and the global ambient sources are outside scope. `teleporterAura`'s
  blue→orange hue ramp deliberately crosses two element buckets and is correct
  as authored.
- **Mix and loudness balance.** Which effect wins a voice from the shared budget
  is a mixing decision, not a language one.
- **Per-entry specification.** Nothing here re-specs an individual effect. The
  resolutions are family-level by construction; per-entry authoring belongs to
  the post-adoption re-authoring waves, which take this document as their
  constraint and the audit as their worklist.
- **Accessibility knobs.** Hit flash, aberration, bloom and screen motion
  (`tests/effect-accessibility.test.mjs`) are player settings; the language must
  remain legible at any of their values, which is a reason effects may not rely
  on bloom or shake alone for discriminability.

---

## 6. Dependencies

| capability | issue | used by |
|---|---|---|
| G2 — sustained/releasable positioned voice | **#146** | C3, C6, §4.1 gravity-snare/aegis, §4.2 harpoon/clouds, §4.3 beam/pull/summon/charge/withering, §4.4 downed |
| G3 — parameterised `spawnBlast` core colour | **#147** | C2, §4.3 galvanic |
| G4 — parameterised `bloodHit` **internal spark + mist** tints (`VFX.js:494`, `:499`) | **#147** | §4.3 UNIVERSAL-hitReaction |
| — the primary gout tint | **none** | expressible today via `bloodHit`'s existing `colour` argument; a call-site change at `VFX.js:1401` |
| G1 — sampled playback (7 named entries only) | **#148** | §4.2 named-promise subset; degrades per §1.4 |

Nothing else in this document requires a primitive that does not exist today.
