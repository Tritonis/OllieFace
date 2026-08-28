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

### Seat independence

Added after the integration review refuted the first draft. **A commitment
derived from a world threshold is billed once per threshold, at any party
size; only a deliberate per-seat act is billed per seat.**

The rule in one line: **N distinct toll thresholds crossed bills exactly N
times, at any seat count, under any batching of feeds** — while a deliberate
per-seat act is billed per press.

The defect: a band crossing is one world event, but the mutation toll it fires
runs once per *seat* — each pawn's `Items` emits its own `itemMutated` — and the
listener was deliberately un-owner-filtered. With zero deliberate acts and every
choice window lapsed, one descent to Consumed billed 12 solo, 24 at two seats,
48 at four. `CAPSTONE.corrupt` is 20, so **any two-seat co-op run was
automatically corrupt-capstone eligible and could never read pure**, while
`warded` ran once through `bleed` and stayed at solo rate. The asymmetry was not
a tuning error; it made the partition a function of party size.

`Corruption` therefore bills the toll **once per band value**, keyed on the band
each `itemMutated` payload carries, on whichever seat's mutation lands first.

The key must be the band and not the transaction. A first fix counted `feed`
calls and deduped per call, which was the inverse defect: `Items` queues one
mutation per *distinct* band crossed and drains them in one frame
(`Items.js:440-446`), so a single feed jumping several thresholds — a legendary
void-credit chest is 45, doubled to 90 on greed time — billed once for what this
rule calls three acts, under-counting solo runs. Keying on the band names the
threshold rather than the transaction that crossed it, which makes billing
independent of how feeds are batched as well as of seat count.

**A band is billed at most once per run, and is not re-billed after bleeding
below it and climbing back.** That is not a softening of the rule — it is the
emitter's own behaviour: `Items._mutePeak` is monotone (`nextTollBand`,
`Items.js:825`), so a re-crossed threshold produces no second `itemMutated` to
bill. An earlier draft reset the billed set on the way down; that branch was
reachable only from a synthetic event, and a rule provable only against a
fixture is not a rule.

Deliberate acts are the other side of the rule and are unchanged: a bargain, a
chest forced on void credit, a stabilisation and a sanctuary are each one pawn's
press with one emitter, so per-seat billing is the correct billing. A *chosen*
mutation is still world-threshold commitment — the choice is which stack
festers, not whether the crossing happened — so it stays once per crossing.

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
- `MSG.WORLD` is a fixed-size record (27 bytes at protocol version 10, when this
  was decided). The ledger is three floats plus a variable-length history;
  carrying it means a new variable-length message and a version bump for
  write-only state.
- A guest computes a consistent `'neutral'` ledger rather than a partial one.

**Narrowed, not reversed, by #220 (protocol version 15):** the committed-route
contract (#171/#218) gave the ledger a reader on the guest — the HUD's
barred-gate line. `MSG.WORLD` now carries the resolved alignment **class** as
one byte (28 bytes total). The ledger's numbers and history still never cross
the wire; the host stays the only machine that can compute the partition.

**The first draft's claim that "nothing reads it, enforced by test" was false**,
and the integration review was right to refute it: the test asserted the guest's
ledger *is* empty — the symptom — while `Progression._endRun`, which is not
authority-gated, read that empty ledger and filed it. A guest's permanent
logbook recorded every co-op run as `alignment: 'neutral', commitCorrupt: 0`,
in flat disagreement with the host's record of the same run.

The fix is that **a machine may only file a verdict it simulated.**
`runStats` contributes the alignment fields only under `ctx.authority`; off the
host they are absent, and `Profile` stores `ALIGNMENT_UNKNOWN` with `null`
totals. The `null` is load-bearing: `0` is the claim "committed nothing", which
is exactly what a guest is not entitled to say, whereas `null` says "not
simulated here". A reader must treat `unknown` as *ask the host*, never as
neutral.

`ALIGNMENT_UNKNOWN` is deliberately not a fifth member of `ALIGNMENT`. The
partition still has four values and invariant 2 is untouched — this is a
property of the logbook, not of a ledger.

**The first ticket to give the ledger a client-side reader owns replicating
it**, and owns the `PROTOCOL_VERSION` bump and `NETCODE.md` entry that come with
that. #171 (finale routing) is the likely one: a route forecast a guest can see
is a reader.

## Persistence

`Profile` stores an `alignment` string and three commitment totals per run.
Absent, malformed, or unrecognised values read as `ALIGNMENT_UNKNOWN` with
`null` totals — never as neutral. That covers three cases with one honest
answer: a record written by a guest, a record written before this system
existed, and a record from a future build this one does not understand. Every
field an old record already carried loads untouched.

The run history is deliberately **not** persisted: it is a run-scoped
diagnostic, and the logbook wants the verdict. #177's vow scopes will want it
and should revisit this.

## Consequences

- `Corruption` gains a second concern. Accepted: the alternative is a system
  that must be initialised, replicated, and persisted alongside the gauge while
  being definitionally derived from the same acts.
- Telemetry does not yet record commitment. **In solo** the run record carries
  every underlying act (`itemOffers`, `bargains`, `mutations`,
  `stabilisations`, `corruption.ruined`), so the ledger is reconstructible from
  it. **In co-op it is not**: `Telemetry` owner-filters to the local player, so
  a guest's record is missing the host's acts and a host's is missing the
  guests'. A first-class `alignment` field — replicated or host-filed — belongs
  with the playtest work in the audit's Priority 8, and until it exists
  commitment cannot be analysed from co-op records at all.
- The unwired sources in `SOURCES` (Wounds #178, Vows #177, Tempering #179) are
  declared and priced but have no call site. That is the extension point: those
  tickets add one `commit` call each. It is not dead code — it is the contract
  they are written against, and the test holds the table to it.
