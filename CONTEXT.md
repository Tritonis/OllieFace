# Telluric Void

The shared language of this project. A glossary, not a spec — it says what terms
mean, never how anything is built. Implementation lives in code; state lives in
GitHub Issues; plans live in `docs/superpowers/plans/`.

## Shipping

**Private Beta**:
A build handed directly to a population the author chose by name, running
against a borrowed development app identity rather than the project's own. The
first release, and the only one on the current critical path. Notably it does
not travel through Steam's distribution — testers receive the build itself.
_Avoid_: launch, beta, soft launch

**Public Launch**:
A release available to anyone who finds the store page. Distinct from Private
Beta in one way that governs every security decision: the population is
unbounded and unknown.
_Avoid_: launch, full launch, 1.0, release

**Ship Blocker**:
A defect that makes a release impossible, as opposed to unpleasant. Always
qualified by which release it blocks — a Public Launch blocker is not
necessarily a Private Beta blocker.
_Avoid_: blocker, critical bug

**STOP Condition**:
A check that, if it fails, refutes the design rather than revealing a bug. Its
purpose is to be run early, before further investment.
_Avoid_: acceptance criterion, gate

## The queue

**Decision Block**:
Work that is stopped because a human owes a judgement no agent can make —
money, licence terms, taste, or a call the project has deliberately reserved.
Nothing proceeds until it is answered, and silence is itself a decision.
_Avoid_: blocked, waiting on user

**Keyboard Block**:
Work that is stopped only because a human must be present at a machine — eyes
on a screen, two accounts, a second box. The decision is already made; what
remains is scheduling. Distinct from a Decision Block in that it is never
*stuck*, only *unscheduled*.
_Avoid_: blocked, manual test, user-only

## Assets

**Seam-Compatible**:
A model pack the game's existing import route can carry as-is — judged by the
published screening criteria, never assumed. Incompatibility disqualifies a
candidate outright; the route is not extended to accommodate a purchase.
_Avoid_: convertible, importable, supported format

**Round Cap**:
The total money one decision round may spend across all its purchases,
agreed before the search begins. A search bound for agents; every actual
purchase is still an individual human decision.
_Avoid_: budget, spending limit

## Effects

**Effect Language**:
The shared vocabulary in which effects become tellable-apart: each dimension
of an effect — colour, shape family, motion, audio signature — carries meaning
about its source and class, and every effect is a point in that space. Includes
fittingness: an effect's look and sound must evoke what it is (fire reads as
fire). The language is a skeleton; hero effects are authored beyond it.
_Avoid_: style guide, VFX standards, theming

**Collision**:
Two effects occupying the same point in the Effect Language — indistinguishable
by the dimensions that are supposed to separate them. Found mechanically by
enumeration, judged for severity by a human.
_Avoid_: duplicate, overlap, similarity

**Proc Grammar**:
The minimum cue every item proc must emit — a small element-coloured mark and a
quiet positioned sound at the point it acted. A floor that buys noticeability
for everything at once; never a design, and never the whole of any effect.
_Avoid_: default VFX, placeholder effect

**Hero Effect**:
An effect authored beyond the Effect Language's skeleton. The language
constrains only its element, its source polarity and its intensity step;
everything else is a taste call. One that reads as "the language plus more
particles" has failed differently but has still failed.
_Avoid_: bespoke VFX, polish pass, juice

**Degraded Point**:
Where an effect lands in the Effect Language when its ideal presentation is
unavailable — a sampled voice falling back to synthesis. Part of the language:
a separation that exists only at the ideal point does not exist.
_Avoid_: fallback, graceful degradation

**Capability Gap**:
Something the current effect frameworks demonstrably cannot express, as opposed
to merely do not yet — proven against the primitives, never assumed from absence.
The only finding class that may open a purchase or a new subsystem.
_Avoid_: limitation, missing feature, tech debt

## Networking

The two halves below are independent, and conflating them is the single most
common confusion in this domain. Introductions can be replaced without touching
the Conversation, and vice versa.

**Introduction**:
How two players find each other and exchange the details needed to open a
Conversation. Happens once, at the start, and carries a few small messages.
_Avoid_: signalling, matchmaking, handshake

**Conversation**:
The continuous flow of game data between players once connected — positions,
events, everything at frame rate. Independent of how the Introduction was made.
_Avoid_: transport, connection, channel, socket

**Relay**:
A third-party machine that forwards a Conversation when the two players'
networks refuse to talk directly. Costs money per byte and requires proving you
are allowed to use it.
_Avoid_: TURN, TURN server, proxy

**Binding**:
The library through which the game reaches Steam at all. Both the Introduction
and, once Steam carries it, the Conversation ride the same Binding — so
replacing it invalidates every previously verified Steam behaviour at once.
_Avoid_: wrapper, bindings, SDK

**Relay Credential**:
The proof a player presents to be allowed to use a Relay. Its danger is
proportional to how many unknown people hold a copy.
_Avoid_: TURN credential, turnpass, secret
