# Round 7 — decisions of record (2026-08-11)

Three open items from `reviews/round6/HANDOFF.md` were escalated to the project
owner on 2026-08-11 and decided. These are decisions, not diagnoses; do not
re-litigate them in later rounds without a new escalation.

## 1. Blight glyph polarity → ordinary itemArt path

Handoff "Open" item 4. The tier author's deliberate tile inversion loses to the
axis-4 silhouette finding. **Decision: route Blight through the ordinary
`itemArt` path (~5 lines); the magenta tier rule carries findability.** The
`--t-blight` variable half-fix stays. Implementation dispatched this round
(`FIX-blight-glyphs.md` when it lands).

Amended same day: the tooltip name chip's inversion (`Tooltip.js`) goes too —
**no inverted Blight element remains anywhere.**

## 2. RoR2-derived code identifiers → migrate now

Handoff "Standing hazards" final bullet. ~40 code identifiers
(`hopoo-feather`, `shatterspleen`, `meshFactory: 'lemurian'`, …) still carry
RoR2 names; display text was cleaned in round 6 (`BRANDING-LEDGER.md`).
**Decision: rename the id layer now, as one change with a save/profile
migration and a golden-hash re-baseline** rather than deferring to the Steam
workstream. Implementation dispatched this round (`FIX-ror2-ids.md`).

## 3. Mesa low-pass → accepted, closed

Handoff "Open" item 5. Round 3 requested a mesa low-pass three times; a 2.7×
gain moved the target statistic 0.02 because the request was aimed at the wrong
term. The true cause is `b09c3d4`'s reflection probe (per-pixel normals →
per-pixel reflections), an 8.3% regression on that ROI and the price of the
axis-5 fix — the fix that ended a project-lifetime history of reflections
containing no geometry. **Decision: the regression is accepted as the cost of
the axis-5 fix. No further mesa low-pass work. Closed.** Any future proposal to
revert or weaken `b09c3d4`'s probe on the mesa's account needs a new owner
escalation.
