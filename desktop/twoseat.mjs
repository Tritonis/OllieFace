/**
 * The two-seat test mode (#241): one desktop app plays the host's or the
 * joiner's half of a Steam co-op session with nobody at its keyboard, and
 * writes a record saying what happened. Contract: `.superpowers/sdd/twoseat/
 * contract.md` sections A and B; schema and launch lines: docs/STEAM.md 8.5b.
 *
 * It is a SCRIPT OVER SHIPPING PATHS, not a second stack. Every step below is
 * a dependency `desktop/main.mjs` supplies from the code a player runs: the
 * lobby is opened by clicking the menu's own "Host via Steam" button, the
 * joiner's invite goes through `joinDelivery.offer` and the menu's own
 * `acceptSteamInvite` -> `joinViaSteam`, and the Conversation forms over
 * `SteamTransport` because that is what `TransportSelect` picks in a Steam
 * boot. This file decides only the order, the caps and the verdicts.
 *
 * THE GATE. `parseTwoSeat` answers null unless `OLLIE_TWOSEAT=1` is in the
 * environment. Flags alone are inert, so a player (or a shortcut someone
 * edited) can never land in a seat. The packed build carries this file — #14
 * is judged there — and the env var is the deliberate switch, the same shape
 * as the showcase's `showcase:install` step. `tests/desktop-twoseat.test.mjs`
 * holds both halves.
 *
 * Imports nothing from Electron, so the whole decision runs in plain node.
 */

export const TWOSEAT_SCHEMA = 'twoseat/1';
export const TWOSEAT_ENV = 'OLLIE_TWOSEAT';

export const REQUIRED_CHECKS = Object.freeze({
  host: Object.freeze(['friends-listed', 'lobby-created', 'invite-sent', 'peer-joined', 'conversation-formed', 'play-window']),
  joiner: Object.freeze(['invite-heard', 'lobby-joined', 'conversation-formed', 'play-window']),
});

/** Inner caps, in seconds, before being clamped to the overall cap. */
const INNER_CAPS_S = Object.freeze({ rendererS: 60, lobbyS: 30, inviteS: 120, peerS: 120, formationS: 60 });
const POLL_MS = 250;

const STEAM_ID = /^\d{1,20}$/;

/**
 * Read contract-A flags. Returns null for a player (no env var, or no
 * `--twoseat`), `{ error, record? }` for a seat that was asked for but is
 * malformed, or the seat's config.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 */
export function parseTwoSeat(argv, env) {
  if (!env || env[TWOSEAT_ENV] !== '1') return null;
  const flags = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith('--twoseat')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) flags[a.slice(2)] = String(args[++i]);
    else flags[a.slice(2)] = '';
  }
  if (!('twoseat' in flags)) return null;

  const record = flags['twoseat-record'] || null;
  const bad = (error) => ({ error, record });
  const seat = flags.twoseat;
  if (seat !== 'host' && seat !== 'joiner') return bad(`--twoseat must be host or joiner (got "${seat}")`);
  const runId = flags['twoseat-run-id'];
  if (!runId) return bad('--twoseat-run-id is required');
  if (!record || !isAbsolute(record)) return bad('--twoseat-record must be an absolute path');
  const playS = Number(flags['twoseat-play-s']);
  const capS = Number(flags['twoseat-cap-s']);
  if (!(playS > 0)) return bad('--twoseat-play-s must be a positive number');
  if (!(capS > playS)) return bad('--twoseat-cap-s must be a number larger than --twoseat-play-s');
  const inviteEveryS = flags['twoseat-invite-every-s'] === undefined ? 10 : Number(flags['twoseat-invite-every-s']);
  if (!(inviteEveryS > 0)) return bad('--twoseat-invite-every-s must be a positive number');
  const peer = flags['twoseat-peer'] ?? null;
  if (seat === 'host' && !STEAM_ID.test(peer ?? '')) return bad('--twoseat-peer <steamId64> is required for the host seat');
  return { seat, runId, record, playS, capS, peer: seat === 'host' ? peer : null, inviteEveryS, flags };
}

const isAbsolute = (p) => /^([A-Za-z]:[\\/]|[\\/])/.test(p);

/** Every cap this run will use, in seconds. All of them go in the record. */
export function capsFor(cfg) {
  const out = { capS: cfg.capS, playS: cfg.playS };
  // Inside the overall cap by at least the play window, so an inner wait that
  // runs out is reported as ITS check failing, not as the overall cap winning.
  const room = cfg.capS - cfg.playS;
  for (const [k, v] of Object.entries(INNER_CAPS_S)) out[k] = Math.min(v, room);
  if (cfg.seat === 'host') out.inviteEveryS = Math.min(cfg.inviteEveryS ?? 10, room);
  return out;
}

/** The placeholder: a crash leaves a failing record, never a stale passing one. */
export const placeholder = (cfg) => ({
  schema: TWOSEAT_SCHEMA, runId: cfg.runId ?? null, seat: cfg.seat ?? null,
  aborted: 'run in progress', checks: [], allPass: false,
});

/**
 * Contract B2: the joiner's 503 latch. Only the first invite is acted on; a
 * host re-sends its invite until the peer joins, and every repeat (same lobby
 * or another) is ignored so the joiner never leaves the lobby it is joining.
 */
export function createInviteLatch(onFirst) {
  let held = null;
  return {
    hear(invite) {
      if (held || !invite?.lobbyId) return false;
      held = invite;
      onFirst(invite);
      return true;
    },
    heard: () => held,
  };
}

/**
 * Finish a record: every required check that never ran is written as failed,
 * and `allPass` is true only when every required check is present and passed
 * and nothing was fatal.
 */
export function finalize(base, checks, fatal) {
  const required = REQUIRED_CHECKS[base.seat] ?? [];
  const out = [...checks];
  for (const id of required) {
    if (!out.some((c) => c.id === id)) out.push({ id, pass: false, detail: 'not reached' });
  }
  const allPass = !fatal && required.length > 0
    && required.every((id) => out.some((c) => c.id === id && c.pass === true))
    && out.every((c) => c.pass === true);
  return { ...base, checks: out, fatal: fatal ?? null, allPass };
}

/**
 * Poll `probe` until it answers truthy or `capS` runs out. The answer is
 * returned; null means the cap was hit.
 */
async function waitFor(deps, capS, probe) {
  const deadline = deps.now() + capS * 1000;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (deps.now() >= deadline) return null;
    await deps.sleep(POLL_MS);
  }
}

/**
 * Run one seat and write its record. Returns the exit code (0 iff allPass).
 *
 * @param {ReturnType<typeof parseTwoSeat>} cfg
 * @param {{
 *   writeRecord: (path: string, json: string) => Promise<void>|void,
 *   now: () => number, sleep: (ms: number) => Promise<void>,
 *   identity: () => { appId: number|null, steamId: string|null, available: boolean },
 *   rendererReady: () => Promise<boolean>|boolean,
 *   listFriends: () => Promise<Array<{steamId: string}>>|Array<{steamId: string}>,
 *   hostLobby: () => Promise<void>|void,
 *   heldLobby: () => string|null,
 *   invite: (lobbyId: string, steamId: string) => Promise<boolean>|boolean,
 *   lobbyMembers: (lobbyId: string) => string[],
 *   heardInvite: () => ({ lobbyId: string, fromSteamId: string|null }|null),
 *   formed: () => Promise<{ ok: boolean, detail: string }>,
 *   startRun: () => Promise<boolean>|boolean,
 *   play: (ms: number) => Promise<{ ok: boolean, detail: string }>,
 * }} deps
 */
export async function runSeat(cfg, deps) {
  if (cfg.error) {
    const rec = finalize({ ...placeholder(cfg), when: new Date(deps.now()).toISOString(), bounded: {} }, [], cfg.error);
    delete rec.aborted;
    if (cfg.record) await deps.writeRecord(cfg.record, JSON.stringify(rec, null, 2) + '\n');
    return 1;
  }

  await deps.writeRecord(cfg.record, JSON.stringify(placeholder(cfg), null, 2) + '\n');

  const bounded = capsFor(cfg);
  const checks = [];
  const check = (id, pass, detail) => { checks.push({ id, pass: !!pass, detail: String(detail) }); return !!pass; };
  const id = deps.identity();
  const base = {
    schema: TWOSEAT_SCHEMA, runId: cfg.runId, seat: cfg.seat,
    appId: id.appId ?? null, steamId: id.steamId ?? null, socketsIdentity: id.socketsIdentity ?? null,
    peerSteamId: cfg.peer,
    when: new Date(deps.now()).toISOString(), flags: cfg.flags, bounded,
  };

  let fatal = null;
  let timer = null;
  const overall = new Promise((resolve) => {
    timer = setTimeout(() => resolve(`overall cap of ${cfg.capS} s reached`), cfg.capS * 1000);
  });
  const steps = (cfg.seat === 'host' ? hostSteps : joinerSteps)(cfg, deps, bounded, check, (p) => { base.peerSteamId = p; });
  try {
    fatal = await Promise.race([steps.then(() => null), overall]);
  } catch (err) {
    fatal = `seat threw: ${err && err.message ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
  if (!id.available && !fatal) fatal = 'steam-unavailable';

  const rec = finalize(base, checks, fatal);
  await deps.writeRecord(cfg.record, JSON.stringify(rec, null, 2) + '\n');
  return rec.allPass ? 0 : 1;
}

async function common(deps, bounded) {
  if (!deps.identity().available) throw new Error('Steam did not initialise; a seat cannot run without it');
  if (!(await waitFor(deps, bounded.rendererS, deps.rendererReady))) {
    throw new Error(`the renderer never reached the title screen inside ${bounded.rendererS} s`);
  }
}

async function formAndPlay(cfg, deps, bounded, check) {
  const formed = await waitFor(deps, bounded.formationS, async () => {
    const f = await deps.formed();
    return f.ok ? f : null;
  });
  if (!check('conversation-formed', formed, formed ? formed.detail : `not formed inside ${bounded.formationS} s`)) return;
  const played = await deps.play(cfg.playS * 1000);
  check('play-window', played.ok, played.detail);
}

function hostSteps(cfg, deps, bounded, check) {
  return (async () => {
    await common(deps, bounded);

    const friends = await deps.listFriends();
    const listed = Array.isArray(friends) && friends.some((f) => f.steamId === cfg.peer);
    if (!check('friends-listed', listed, Array.isArray(friends)
      ? `${friends.length} friend(s); peer ${cfg.peer} ${listed ? 'present' : 'ABSENT'}`
      : 'friends list unavailable')) return;

    await deps.hostLobby();
    const lobbyId = await waitFor(deps, bounded.lobbyS, deps.heldLobby);
    if (!check('lobby-created', lobbyId, lobbyId ?? `no lobby inside ${bounded.lobbyS} s`)) return;

    // The host is in a run before the peer arrives, the order coopprobe uses.
    if (!(await deps.startRun())) throw new Error('the host could not launch a run');

    const sent = await deps.invite(lobbyId, cfg.peer);
    if (!check('invite-sent', sent, sent ? `invited ${cfg.peer} to ${lobbyId}` : 'inviteUserToLobby refused')) return;

    // B2: re-send every inviteEveryS until the peer is in, so a joiner that
    // armed its 503 handler late still hears one.
    let lastInvite = deps.now(), sends = 1;
    const joined = await waitFor(deps, bounded.peerS, async () => {
      if (deps.lobbyMembers(lobbyId).includes(cfg.peer)) return true;
      if (deps.now() - lastInvite >= bounded.inviteEveryS * 1000) {
        lastInvite = deps.now(); sends++;
        await deps.invite(lobbyId, cfg.peer);
      }
      return false;
    });
    if (!check('peer-joined', joined, joined ? `${cfg.peer} is a lobby member (${sends} invite(s) sent)` : `peer not in the lobby inside ${bounded.peerS} s (${sends} invite(s) sent)`)) return;

    await formAndPlay(cfg, deps, bounded, check);
  })();
}

function joinerSteps(cfg, deps, bounded, check, setPeer) {
  return (async () => {
    // B2: once Steam is up and the 503 handler armed, say so -- still failing.
    if (deps.listening && await waitFor(deps, bounded.rendererS, deps.listening)) {
      const rec = { ...placeholder(cfg), listening: true, listeningAt: new Date(deps.now()).toISOString() };
      await deps.writeRecord(cfg.record, JSON.stringify(rec, null, 2) + '\n');
    }
    await common(deps, bounded);

    const invite = await waitFor(deps, bounded.inviteS, deps.heardInvite);
    if (!check('invite-heard', invite, invite
      ? `lobby ${invite.lobbyId} from ${invite.fromSteamId ?? 'unknown'}`
      : `no LobbyInvite_t inside ${bounded.inviteS} s`)) return;
    setPeer(invite.fromSteamId);

    const lobbyId = await waitFor(deps, bounded.lobbyS, deps.heldLobby);
    if (!check('lobby-joined', lobbyId === invite.lobbyId, lobbyId
      ? `holding ${lobbyId}` : `no lobby joined inside ${bounded.lobbyS} s`)) return;

    const formed = await waitFor(deps, bounded.formationS, async () => {
      const f = await deps.formed();
      return f.ok ? f : null;
    });
    if (!check('conversation-formed', formed, formed ? formed.detail : `not formed inside ${bounded.formationS} s`)) return;
    if (!(await deps.startRun())) throw new Error('the joiner could not launch a run');
    const played = await deps.play(cfg.playS * 1000);
    check('play-window', played.ok, played.detail);
  })();
}
