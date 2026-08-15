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
