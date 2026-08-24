# Alignment commitment is a separate, monotone ledger

**Status:** accepted (2026-08-23) — defined and exposed by #169, adopted by
#170/#171/#173-179.

The 2026-08-23 corruption/purity audit
(`reviews/corruption-purity-audit-2026-08-23.md`) found one Critical, and it is
not a tuning defect: **mixed is a superset rather than a compromise.** A run can
descend for everything corruption mints, ward the gauge back down, and check out
holding both halves.

Three facts make that possible, all of them verified in the code:

1. Cleansing drops live corruption, but `Corruption._peak` survives — so void
   marks minted by the descent survive with it.
2. Blight stacks and their synergy buffs are permanent, while Argent card
   strength fades with **live** corruption — so cleansing restores every pure
   benefit and retains every corrupt one.
3. The finale gate reads the **live band at checkout**
   (`src/data/realms.js:525-553`) — so "clean ending" means "clean at the door",
   not "pure run".

Each of these is individually defensible. Together they mean the gauge is being
asked a question it cannot answer.

## Decision

**Live corruption stays what it is — a measure of present danger — and a second
number records commitment.** `src/data/alignment.js` defines the ledger and the
pure queries over it; `Corruption` owns the one mutating verb.

The ledger is not a redesign of the economy. It changes no gameplay: #169 wires
the sources, exposes the queries, and stops. The tickets that give a query a
reader own the balance consequences of doing so.

### Four invariants

1. **Commitment is monotone.** `Corruption.commit` is the only writer and only
   ever adds. No font, sanctuary, bleed, or net message lowers a class total.
   Cleansing buys down danger; it cannot buy back history.

2. **Capstone eligibility is mutually exclusive by construction.** Not by two
   thresholds that happen not to overlap — by a **partition**. `alignmentOf` is
   a single-valued function of the ledger, and each capstone predicate requires
   it to have returned a different one of its values. A both-eligible state
   would need one call to return two values.

   This matters more than the crispness: it means re-tuning `TOLERANCE`,
   `CAPSTONE`, or any source weight *cannot* reintroduce the defect. A property
   that survives its own tuning dials is the only kind worth writing down.
   `tests/alignment-ledger.test.mjs` attempts the construction over a grid that
   includes the threshold boundaries, absurd magnitudes, and malformed ledgers,
   and fails to build one.

3. **Route history answers from the ledger, never from the live band.** Every
   query in `data/alignment.js` takes a ledger and nothing else, so a caller
   cannot accidentally ask the gauge instead. This is the direct fix for the
   checkout-laundering shape in fact 3 above; #171 adopts it.

4. **Totals are authoritative; `history` is a bounded window.** The entry log is
   capped at `HISTORY_MAX` and drops its oldest rows. The class counters are
   separate and stay exact. Never re-derive a total by summing `history`.

### What the tolerance is for

A strict partition would cost a corrupted run its capstone for two incidental
Voidtouched kills, because a kill wards. `TOLERANCE` forgives off-class
commitment below a floor. Note what it does *not* do: it cannot make both
capstones open, because it is an input to the partition and not a bypass of it.

### The launderer, under this design

Descend, buy the synergy, take the mutation, force a chest, then cleanse 400
points at fonts. Live band: Pristine. Ledger: corrupt commitment *and* 20 points
of pure commitment from the warding. Alignment: **mixed**. Neither capstone is
open. The oscillation still buys marks, motes, and safety — it no longer buys an
identity it did not commit to.

## Replication: the ledger is host-local

**Decided deliberately, not by omission.** `Corruption.applyNetState` leaves the
ledger untouched, and `commit` is authority-gated, so a guest accrues nothing
from the host events it observes.

- Nothing reads it yet. Spending wire budget on a field with no reader is how a
  protocol grows fields nobody can remove.
- `MSG.WORLD` is a fixed 27-byte record (protocol version 10). The ledger is
  three floats plus a variable-length history; carrying it means a new
  variable-length message and a version bump for write-only state.
- The failure mode a *half*-replicated ledger would have — a guest computing a
  different alignment from the host and acting on it — cannot occur here,
  because a guest computes a consistent `'neutral'` and nothing reads it. That
  is enforced by test, not by convention.

**The first ticket to give the ledger a client-side reader owns replicating
it**, and owns the `PROTOCOL_VERSION` bump and `NETCODE.md` entry that come with
that. #171 (finale routing) is the likely one: a route forecast a guest can see
is a reader.

## Persistence

`Profile` stores an `alignment` string and three commitment totals per run.
Absent, malformed, or unrecognised values read as a neutral, zero-commitment run
— so every record written before this existed loads with all its existing fields
untouched. The run history is deliberately **not** persisted: it is a run-scoped
diagnostic, and the logbook wants the verdict.

## Consequences

- `Corruption` gains a second concern. Accepted: the alternative is a system
  that must be initialised, replicated, and persisted alongside the gauge while
  being definitionally derived from the same acts.
- Telemetry does not yet record commitment. The run record already carries every
  underlying act (`itemOffers`, `bargains`, `mutations`, `stabilisations`,
  `corruption.ruined`), so the ledger is reconstructible from a run record
  today; a first-class `alignment` field belongs with the playtest work in the
  audit's Priority 8.
- The unwired sources in `SOURCES` (Wounds #178, Vows #177, Tempering #179) are
  declared and priced but have no call site. That is the extension point: those
  tickets add one `commit` call each. It is not dead code — it is the contract
  they are written against, and the test holds the table to it.
