/**
 * Wire protocol.
 *
 * Two channels with different guarantees, because snapshots and events want
 * opposite things:
 *   - `state`  — unreliable, unordered. Input and snapshots. A dropped snapshot
 *                is worthless a frame later, so retransmitting it only adds
 *                latency. Never put anything non-idempotent here.
 *   - `events` — reliable, ordered. Item pickups, kills, stage transitions.
 *                These are one-shot facts a client can't reconstruct.
 *
 * Everything is hand-rolled binary rather than JSON: a 24-player-visible
 * snapshot at 20Hz is ~40x smaller packed, and JSON.parse on every snapshot
 * would allocate hard enough to show up as GC hitches during fights.
 */

// 2 — WELCOME gained the run's rules (artifact bitmask + difficulty index) on
// the end. Nothing validates this today; NetClient reads the two new fields
// only if the bytes are there, so a 1.x host degrades to vanilla rules rather
// than to a throw. Bumped because the message layout genuinely changed and the
// next person to add a check needs the number to already be honest.
// 3 — two additions, both about a client being simulated as *itself*:
//     · HELLO gained a body. It is the first thing a client sends and it
//       carries the survivor it picked. Until now nothing in `src/net/` carried
//       a joiner's survivor id at all, so `Coop._spawnPawn` fell through to
//       `ctx.survivorId` — the host's — and a client joining a `ranger` host as
//       `anvil` was simulated at 110 max health / 7.0 move speed against its own
//       170 / 6.5. Its own health readout then mapped the host's health
//       *fraction* onto its own maximum and read 55 % high forever.
//     · The entity record gained a shield fraction, for the same reason it
//       already carries a health fraction: a client's barrier was purely local
//       decoration over a pawn the host resolves every hit against with
//       `shield === 0`.
//     The HELLO half degrades cleanly (a host that does not understand it keeps
//     the old behaviour, a client that never sends one is spawned as before).
//     The entity half does NOT: the snapshot record grew by two bytes, so a 2.x
//     reader would mis-frame every entity after the first. Nothing validates
//     `PROTOCOL_VERSION` on either side today — WELCOME carries it and NetClient
//     reads it into a discard — so a cross-version pairing garbles rather than
//     refuses. That was already true at 2 and is not made worse here; it is the
//     next thing this file needs and is stated in round 3's report as held.
//     ** Now done — see below. **
//
// Both sides compare `PROTOCOL_VERSION` and refuse a mismatch out loud
// (`MSG.REFUSE`): the host on HELLO's version field, the client on WELCOME's,
// which is the first field of each after the message kind and is therefore
// readable even from a build whose layout has since moved.
//
// 4 — the number, not the bytes. `MSG.REFUSE` was added at "3" and the set of
//     HELLOs a host accepts changed again here (an empty or truncated survivor
//     id is now refused instead of silently simulated as the host's own
//     survivor). No layout moved for either change, and the earlier argument —
//     a new message *code* is inert to a reader that does not know it — is
//     still true of the wire. What it is not true of is the *check*: three
//     builds now call themselves "3" with three different behaviours, so the
//     one field whose entire job is to make a mismatched pairing refuse rather
//     than garble could not tell them apart. A version that does not identify
//     the protocol is worse than no version, because it is trusted. The cost of
//     bumping is that a pre-round-5 build can no longer join a round-5 one —
//     which is the correct outcome, told out loud on both machines, and it is
//     free today because the co-op entry is held and no build is deployed.
// 5 — the number again, not the bytes, for exactly the reason 4 was. No layout
//     moved. What moved is the *vocabulary* two peers exchange over the events
//     channel: `itemPickup` carries an item id and `realmEnter`/`realmExit`
//     carry a realm id, both as JSON strings, and round 7 renamed thirty-nine
//     item ids and the `bazaar` realm (`data/renamedIds.js`,
//     `reviews/round7/FIX-ror2-ids.md`).
//
//     A 4-with-old-ids host paired with a 4-with-new-ids client does not
//     garble a frame — it reads every byte correctly and then acts on a name
//     the other end has never heard of. The client shows the wrong pickup and
//     builds the wrong room, and every mechanism that would have complained is
//     satisfied. That is the silently-wrong session this field exists to
//     refuse, and it is the same argument the 4 bump made in words: a version
//     that does not identify the protocol is worse than no version, because it
//     is trusted.
//
//     The snapshot vocabulary did NOT move: an entity's `typeId` is its index
//     in `ENEMIES`, so renaming six enemy ids changed no wire byte and no
//     lookup on either end. Difficulty likewise crosses in `WELCOME` as
//     `DIFFICULTIES` index, not as the rung's id.
// 6: per-player economy. `itemPickup`/`goldChanged`/`equipmentChanged`/
//    `goldReward`/`itemMutated` are addressed to one peer instead of broadcast,
//    so a v5 client joined to a v6 host would sit at zero gold all run and a v6
//    client on a v5 host would adopt the host's purse as its own.
// 7: downed & revive (mp-p3). `ESTATE.DOWNED` joins the snapshot vocabulary —
//    a v6 peer reading a v7 host's `netState` byte would see an unrecognised
//    value where it expected ALIVE/DEAD/SPAWNING.
// 8: a player's `typeId` is its survivor's index in `SURVIVORS`, where it used
//    to be a constant 0. No byte moved — this is the same vocabulary argument
//    as 5. A v7 host writes 0 for every player, and a v8 client would read that
//    as "everyone is the Ranger" and build every teammate the Ranger's rig,
//    hurtbox and accent; a v7 client on a v8 host ignores the field and does
//    the same thing quietly. Both are the exact bug this bump exists to end:
//    per-class shape signatures (EFFECT-LANGUAGE.md §3.1) are unreadable if the
//    class does not cross, and "the wrong survivor, silently" is precisely the
//    trusted-but-wrong session `PROTOCOL_VERSION` refuses.
// 9: the signature economy replicates (issue #167). `MSG.WORLD` is a new kind
//    a v8 client would fall through its `default` and log as unknown — which is
//    the *good* failure — but the pairing it would produce is the bug this
//    version exists to refuse: a v8 client on a v9 host renders a corruption
//    gauge, a purse of marks and motes, an Argent grace window and a route
//    forecast that are all its own zeroed guesses while the host plays a ruined
//    world. Silently wrong numbers on every prompt price is worse than a
//    refused join, so the join is refused.
// 10: `MSG.WORLD` grows a `sanctEpoch` — layout, so the bump is the obvious
//    half of the rule. A v9 pairing would mis-frame the two bytes after the
//    sanctuary clock and read ruin and greed out of an epoch counter.
// 11: the blight toll's lever crosses the wire (issue #168). `MSG.MUTATE` is the
//    first client -> host *request* this protocol has ever carried, and
//    `mutationChoiceOffered`/`mutationChoiceClosed` join the addressed-event
//    vocabulary. No layout moved, so this is the vocabulary argument 5 and 8
//    made — but louder, because the pairing it refuses is one where a player is
//    asked a question their build cannot answer: a v10 client on a v11 host
//    would raise the three-card panel out of the forwarded offer, press a card,
//    and send nothing at all, then watch the void take a stack it had just been
//    promised it could choose. A refused join says that; a dead button does not.
// 12: `MSG.MUTATE` grows a target byte between the identifier and the id, so the
//    one client -> host request now carries every window a peer can be asked to
//    answer rather than only the blight toll's (issues #204, #205). Layout, so
//    the bump is the obvious half of the rule — a v11 client's four-then-string
//    reply would be read as a target of whatever the first byte of its card id
//    happened to be. But the vocabulary argument stands underneath it: a v11
//    client on a v12 host is handed a chest's three-way panel and a
//    consecration's three cards it has no reply for, presses one, and watches
//    the window lapse. Two dead buttons instead of one.
// 13: the entity record grows an affix byte (issue #228) -- an elite's affix,
//     packed 1-based into the low 7 bits (0 = none, AFFIX_IDS index + 1
//     otherwise), plus the cosmetic corrupted-appearance flag in the high bit.
//     Layout, so the bump is the obvious half: a v12 reader has no field here
//     and would mis-frame the byte after it as the start of the next entity's
//     netId, corrupting every entity that follows the first affixed one in
//     the snapshot. Both peers are always the same build in this game (no
//     cross-version matchmaking), so the break costs nothing today and is the
//     correct outcome told out loud rather than a garbled snapshot told
//     silently.
export const PROTOCOL_VERSION = 13;

export const MSG = {
  HELLO: 1,       // client -> host
  WELCOME: 2,     // host   -> client
  INPUT: 3,       // client -> host  (state channel)
  SNAPSHOT: 4,    // host   -> client (state channel)
  EVENT: 5,       // host   -> client (events channel)
  PING: 6,
  PONG: 7,
  BYE: 8,
  REFUSE: 9,      // host   -> client, last message before the channel closes
  WORLD: 10,      // host   -> client, the run's world-level economy (issue #167)
  MUTATE: 11,     // client -> host  (events channel), one answer to one offer
};

/**
 * A remote player's answer to the blight toll's three cards (issue #168).
 *
 * The only client -> host *request* in this protocol, and it is deliberately
 * the smallest one that can exist: the identifier of the offer the host itself
 * minted, and the id of a card that offer carried. Nothing else. Every field a
 * card is painted from — the counterpart, its name, its effect text, the stack
 * size — was written by the host and is still held by the host, so a client
 * that lies about any of them is lying to itself.
 *
 * The reply names no pawn. Whose pack it touches is re-derived from the peer
 * the bytes arrived on (`NetHost._onMutate`), which is the one fact a sender
 * cannot forge, so ownership is structural rather than checked.
 *
 * An empty `baseId` is a refusal — the same "no" the panel's decline button
 * makes, told out loud rather than by silence, so the toll resolves at once
 * instead of after the window's whole clock.
 */
/**
 * Which window an answer is answering (issues #204, #205).
 *
 * Two id spaces mint offer identifiers on a host — `Items`' and
 * `itemTransaction`'s — and they count independently, so the same number is
 * live in both at once as a matter of course. Without this byte a chest answer
 * whose id happened to collide would resolve a blight toll, which is a peer
 * spending somebody's stack by pressing a button on the wrong panel. It is a
 * discriminator, never a permission: neither target reaches anything but the
 * answering peer's own pawn.
 *
 * `CHOICE` carries both kinds of choice window — the toll's cards and the
 * Argent altar's — because both live in one slot on one `Items` instance under
 * one identifier, and the host knows which is open without being told.
 */
export const MUTATE_TARGET = {
  CHOICE: 0,   // the pack's choice window: the blight toll, or a consecration
  OFFER: 1,    // an open item offer: the chest's three-way claim
};

export function writeMutate(w, { offerId = 0, baseId = '', target = MUTATE_TARGET.CHOICE } = {}) {
  w.u8(MSG.MUTATE);
  w.u32(offerId >>> 0);
  w.u8(target & 0xff);
  w.str(String(baseId ?? ''));
  return w;
}

// The longest item id in the catalogue is well under this; it exists so a peer
// cannot choose how much of this machine's memory its answer occupies. Read
// defensively for `readHello`'s reason — a truncated reply must cost the reply,
// not the session — but a manufactured value must never reach a decision, and
// neither of these can: offer 0 is never minted and no offer ever carried ''.
export const MUTATE_BASE_MAX = 64;

export function readMutate(r, out = {}) {
  out.offerId = r.remaining >= 4 ? r.u32() : 0;
  // A truncated message reads as the choice window, which is the target that
  // was the whole message before this byte existed — and one whose every other
  // field is still checked against a live window, so a manufactured target
  // reaches no decision an honest one would not have.
  out.target = r.remaining >= 1 ? r.u8() : MUTATE_TARGET.CHOICE;
  out.baseId = r.remaining >= 2 ? r.str() : '';
  // `null`, not `''`: an empty card id is a *refusal*, which pays a real toll.
  // An id no catalogue could hold is a malformed message, and answering it with
  // a refusal would let a peer spend somebody's stack by sending garbage.
  // `NetHost._onMutate` drops a null outright.
  if (out.baseId.length > MUTATE_BASE_MAX) out.baseId = null;
  return out;
}

/**
 * The signature economy on the wire (issue #167).
 *
 * Everything a peer needs to render the same corruption gauge, the same purse
 * of marks and motes, the same sanctuary clock and the same route forecast the
 * host is playing. Small enough (27 bytes) that it rides its own on-change
 * message rather than the 20 Hz snapshot: this state moves a handful of times
 * a run, and paying for it every tick would be paying for stillness.
 *
 * The monotone mints (`peak`, `warded`) cross rather than the derived currency
 * counts, so the far side runs the *same* mint arithmetic
 * (`bandBoons.marksMinted`) instead of a second copy that could disagree —
 * the same reason `priceOf` is one expression and not two.
 *
 * `sanctuaryT` is remaining seconds, not an end tick: the far side ticks it
 * down with its own clock and is corrected by the next message, so a lagged
 * peer's window closes late by the latency rather than never closing at all.
 */
export function writeWorld(w, s) {
  w.u8(MSG.WORLD);
  w.f32(s.world || 0);
  w.u8(s.band || 0);
  w.f32(s.peak || 0);
  w.u16(s.spent || 0);
  w.f32(s.warded || 0);
  w.u16(s.motesSpent || 0);
  w.f32(s.sanctuaryT || 0);
  w.u16(s.sanctEpoch || 0);
  w.u8(s.ruined ? 1 : 0);
  w.u8(s.greed ? 1 : 0);
  w.u8(s.peakBand || 0);
  return w;
}

export function readWorld(r) {
  return {
    world: r.f32(),
    band: r.u8(),
    peak: r.f32(),
    spent: r.u16(),
    warded: r.f32(),
    motesSpent: r.u16(),
    sanctuaryT: r.f32(),
    sanctEpoch: r.u16(),
    ruined: r.u8() === 1,
    greed: r.u8() === 1,
    peakBand: r.u8(),
  };
}

/**
 * Why a host would not let a peer in.
 *
 * Refusal is a *told* failure, not a dropped one: the host sends this, then
 * closes the peer. A silent drop reads to the player as "co-op is broken", and
 * an accepted-but-wrong join reads as "the game is broken", which is worse —
 * both of the states this refuses (a version-skewed pairing, a survivor this
 * build does not have) end in a session where one player is silently simulated
 * as somebody else. That is the exact defect PROTOCOL_VERSION 3 was bumped to
 * fix, and accepting it here would recreate it from one bad byte.
 */
export const REFUSE = {
  VERSION: 'version',
  SURVIVOR: 'survivor',
  HELLO: 'hello',
};

export function writeRefuse(w, reason, detail = '') {
  w.u8(MSG.REFUSE);
  w.str(String(reason ?? ''));
  w.str(String(detail ?? ''));
  return w;
}

export function readRefuse(r, out = {}) {
  out.reason = r.remaining >= 2 ? r.str() : '';
  out.detail = r.remaining >= 2 ? r.str() : '';
  return out;
}

// Button bits packed into the input word.
export const BTN = {
  JUMP: 1 << 0,
  SPRINT: 1 << 1,
  FIRE: 1 << 2,
  SECONDARY: 1 << 3,
  UTILITY: 1 << 4,
  SPECIAL: 1 << 5,
  INTERACT: 1 << 6,
  // The equipment slot (F). Like INTERACT it is a *request*, resolved on the
  // host against the pressing pawn's own `Items` — without it a joiner's slot
  // was seeded, replicated and painted on their HUD with no way to fire it.
  EQUIP: 1 << 7,
};

// Entity kinds that appear in snapshots. Anything purely cosmetic (particles,
// decals, damage numbers) is NEVER replicated — clients spawn those locally
// from events, which is both cheaper and looks better under latency.
export const EKIND = {
  PLAYER: 1,
  ENEMY: 2,
  PROJECTILE: 3,
  INTERACTABLE: 4,
};

export const ESTATE = { ALIVE: 0, DEAD: 1, SPAWNING: 2, DOWNED: 3 };

// --- quantisation -----------------------------------------------------------
// Stage is ~220 units across; ±512 with 1/64 unit precision fits i16 exactly and
// is ~1.5cm, well below what interpolation smooths over anyway.
const POS_SCALE = 64;
const POS_LIMIT = 32767;

export const packPos = (v) => Math.max(-POS_LIMIT, Math.min(POS_LIMIT, Math.round(v * POS_SCALE)));
export const unpackPos = (q) => q / POS_SCALE;

// Angles as i16 over [-PI, PI] — 0.01° precision, far finer than perceptible.
const ANG_SCALE = 32767 / Math.PI;
export const packAngle = (a) => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return Math.round(x * ANG_SCALE);
};
export const unpackAngle = (q) => q / ANG_SCALE;

// --- sizes ------------------------------------------------------------------
export const INPUT_SIZE = 1 + 4 + 1 + 1 + 2 + 2 + 2; // kind,tick,mx,mz,buttons,yaw,pitch
export const ENTITY_SIZE = 2 + 1 + 1 + 6 + 2 + 2 + 2 + 1 + 1; // id,kind,type,pos,yaw,health,shield,state,affix
export const SNAPSHOT_HEADER = 1 + 4 + 4 + 2;         // kind,tick,ackInput,count

/**
 * Growable writer. Reused across sends by the caller so steady-state
 * networking allocates nothing.
 */
export class Writer {
  constructor(capacity = 8192) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.off = 0;
  }
  reset() { this.off = 0; return this; }
  _need(n) {
    if (this.off + n <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.off + n));
    new Uint8Array(next).set(new Uint8Array(this.buf));
    this.buf = next;
    this.view = new DataView(next);
  }
  u8(v) { this._need(1); this.view.setUint8(this.off, v); this.off += 1; return this; }
  i8(v) { this._need(1); this.view.setInt8(this.off, v); this.off += 1; return this; }
  u16(v) { this._need(2); this.view.setUint16(this.off, v, true); this.off += 2; return this; }
  i16(v) { this._need(2); this.view.setInt16(this.off, v, true); this.off += 2; return this; }
  u32(v) { this._need(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; return this; }
  f32(v) { this._need(4); this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  str(s) {
    const bytes = new TextEncoder().encode(s);
    this.u16(bytes.length);
    this._need(bytes.length);
    new Uint8Array(this.buf, this.off, bytes.length).set(bytes);
    this.off += bytes.length;
    return this;
  }
  json(o) { return this.str(JSON.stringify(o)); }
  // Copy out — DataChannel.send() must not be handed a view over a buffer we
  // are about to overwrite on the next tick.
  bytes() { return this.buf.slice(0, this.off); }
}

export class Reader {
  constructor(buf) {
    this.view = new DataView(buf);
    this.buf = buf;
    this.off = 0;
  }
  get remaining() { return this.view.byteLength - this.off; }
  u8() { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i8() { const v = this.view.getInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  str() {
    const n = this.u16();
    const s = new TextDecoder().decode(new Uint8Array(this.buf, this.off, n));
    this.off += n;
    return s;
  }
  json() { return JSON.parse(this.str()); }
}

// --- input ------------------------------------------------------------------

export function writeInput(w, cmd) {
  w.u8(MSG.INPUT);
  w.u32(cmd.tick);
  w.i8(Math.round(cmd.moveX * 127));
  w.i8(Math.round(cmd.moveZ * 127));
  w.u16(cmd.buttons);
  w.i16(packAngle(cmd.yaw));
  w.i16(packAngle(cmd.pitch));
  return w;
}

export function readInput(r, out = {}) {
  out.tick = r.u32();
  out.moveX = r.i8() / 127;
  out.moveZ = r.i8() / 127;
  out.buttons = r.u16();
  out.yaw = unpackAngle(r.i16());
  out.pitch = unpackAngle(r.i16());
  return out;
}

// --- snapshots --------------------------------------------------------------

export function writeEntity(w, e) {
  w.u16(e.netId);
  w.u8(e.kind);
  w.u8(e.typeId ?? 0);
  w.i16(packPos(e.position.x));
  w.i16(packPos(e.position.y));
  w.i16(packPos(e.position.z));
  w.i16(packAngle(e.yaw ?? 0));
  // Health as a 0..65535 fraction of max — max is derived from typeId
  // client-side, so scaling changes don't need their own field.
  w.u16(Math.max(0, Math.min(65535, Math.round((e.health / Math.max(1, e.maxHealth)) * 65535))));
  // Barrier, as a fraction of the same maximum health rather than of
  // `maxShield`: `maxShield` is derived (`maxHealth * 0.5`) and a receiver that
  // scales by its own copy of it would double the divergence when the two
  // maxima disagree. One denominator for both bars.
  w.u16(Math.max(0, Math.min(65535, Math.round((Math.max(0, e.shield ?? 0) / Math.max(1, e.maxHealth)) * 65535))));
  w.u8(e.netState ?? ESTATE.ALIVE);
  // Affix (issue #228): host-authoritative, never derived on a client. `0` is
  // "no affix"; anything else is a 1-based index into `AFFIX_IDS`
  // (`data/enemies.js`), the same index-not-name shape `typeId` already uses.
  // `corrupted` is cosmetic-only (see `Enemy.js`) and rides the high bit of
  // the same byte rather than a byte of its own — the two never coincide
  // (`EnemyMeshes.setAffix` clears `corrupted` whenever an affix is present),
  // so nothing is lost by sharing the field.
  w.u8(((e.corrupted ? 1 : 0) << 7) | ((e.affixId ?? 0) & 0x7f));
}

export function readEntity(r, out = {}) {
  out.netId = r.u16();
  out.kind = r.u8();
  out.typeId = r.u8();
  out.x = unpackPos(r.i16());
  out.y = unpackPos(r.i16());
  out.z = unpackPos(r.i16());
  out.yaw = unpackAngle(r.i16());
  out.healthFrac = r.u16() / 65535;
  out.shieldFrac = r.u16() / 65535;
  out.state = r.u8();
  const affixByte = r.u8();
  out.affixId = affixByte & 0x7f;
  out.corrupted = (affixByte & 0x80) !== 0;
  return out;
}

// --- hello ------------------------------------------------------------------

/**
 * First message a client sends, the moment both channels are open.
 *
 * The host has already spawned this peer's pawn by then (it does so on channel
 * open, before any message can arrive) and it built it from its own
 * `ctx.survivorId`, because until PROTOCOL_VERSION 3 there was nothing else to
 * build it from. This is what tells it otherwise.
 */
export function writeHello(w, { survivorId = '' } = {}) {
  w.u8(MSG.HELLO);
  w.u16(PROTOCOL_VERSION);
  w.str(String(survivorId ?? ''));
  return w;
}

export function readHello(r, out = {}) {
  // Read defensively for the same reason WELCOME's trailing fields are: a peer
  // that sends a bare HELLO must not throw out of the message that identifies it.
  //
  // But defensive reading manufactures values, and a manufactured value that
  // reaches a *decision* is a lie the decision cannot see. Both substitutions
  // below were read as facts by `NetHost._onHello`: a 3-byte HELLO became
  // "version 0", which the host reported to the player as a version mismatch
  // ("theirs 0, ours 3") — wrong diagnosis, wrong remedy — and a 5-byte one
  // became `survivorId: ''`, which was waved through into a session where the
  // peer was simulated as the host's own survivor. `malformed` is the one bit
  // that distinguishes "they told us 0" from "they told us nothing": a
  // well-formed HELLO body is at minimum a u16 version plus a u16 length
  // prefix, so anything shorter than four bytes carries neither field.
  out.malformed = r.remaining < 4;
  out.version = r.remaining >= 2 ? r.u16() : 0;
  out.survivorId = r.remaining >= 2 ? r.str() : '';
  return out;
}

// Longest attacker-supplied string this build will echo into a refusal or a
// status line. Survivor ids are a dozen characters; the rest is somebody else's
// machine choosing how much of our screen to fill. See `NetHost._refuse`.
export const REFUSE_DETAIL_MAX = 64;
