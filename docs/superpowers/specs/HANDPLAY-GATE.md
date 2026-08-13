# The hand-played co-op gate

**Roadmap:** `2026-08-04-multiplayer-roadmap-design.md` §1 (Verification decision), §5 rules 6/10/11.

The automated rig (`node tests/run.mjs`, `npm run gate:sp`, `npm run gate:mp1`,
`node tools/coopprobe.mjs`) proves the netcode forms connections and holds
fingerprints. None of it proves the game is *fun with a second person in it*,
and none of it has ever listened to the audio. Roadmap rule 11: **"Nobody has
played a full run by hand, and nobody has listened to the audio. Both are
gates, not chores."**

## This checklist is USER-ONLY

**Every box below is checked by a human who played the run, never by an
agent.** An agent may prepare the build, print this file, or transcribe a
user's dictated results — it may never tick a box itself, and it must say so
plainly if asked to fill one in.

**A checked box with no evidence line is void.** The evidence line is not
decoration; it is the on-disk claim the box rests on (memory: name the
baseline capture — claims need on-disk sources). A box checked without its
evidence written in is treated as unchecked.

---

## Setup

| # | Row | Evidence |
|---|---|---|
| 1 | Build deployed, signalling relay reachable (P4 output — see `2026-08-12-mp-p4-remote-network.md`; pending until that plan's user checkpoints land) | Deployed URL: __________ |
| 2 | TURN configured and proven with `?ice=relay` (P4 output — same plan) | TURN provider: __________ · `?ice=relay` result: __________ |
| 3 | Two machines, two different networks (not the same LAN/NAT) | Network A: __________ · Network B: __________ |
| 4 | One session run at Steam-shipped default settings — no debug flags, no `?ice=`/`?netlag=` overrides | Settings confirmed default: [ ] |

## Play

| # | Row | Evidence |
|---|---|---|
| 5 | One full run, start to ending, with 2 players | Run seed: __________ · Duration: __________ · Stages cleared: __________ |
| 6 | Every interactable type touched by the **non-host** at least once (chests, shrines, pickups, terminals — whatever the build ships) | Interactable types touched by non-host: __________ |
| 7 | One death → revive | Who died, who revived, at what stage: __________ |
| 8 | One bleed-out → stage-end return (the downed player is *not* revived and returns at the next stage boundary) | Stage bled out at, stage returned at: __________ |
| 9 | One deliberate wipe (both players down, run ends) | Stage wiped at: __________ |
| 10 | Audio listened to, on both machines, for the entire run (rule 11 — audio is a gate, not a chore) | Any artifact noted against the known audio-graph flaw (playtest 2026-08-08): __________ |

## Defects

| # | Row | Evidence |
|---|---|---|
| 11 | Every defect seen during the run, however minor | Defects seen (or "none"): __________ |

---

## Payoff

When every box above is checked with its evidence line filled in, the Co-op
menu label drops "(beta)" (roadmap §1, "Consequences worth stating": *"The
Co-op menu entry stays live, relabelled 'Co-op (beta)'. It reverts to a plain
label when P5's hand-play gate passes."*).

The label lives at `src/ui/Menus.js:212` (also `:360`, `:395`, `:398` — all
four instances change together), guarded by the comment at `:206-211`:
`"(beta)" is load-bearing, not decoration: co-op has never been played end to
end by two people on a real remote network... It stays until that hand-played
session happens.`
Editing those lines is the one code change this gate authorizes, and only
after every row above is checked and evidenced.
