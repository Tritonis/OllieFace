import * as THREE from 'three';
import { ABILITIES } from '../data/abilities.js';
import { EQUIPMENT } from '../data/equipment.js';
import { ITEMS, TIERS } from '../data/items.js';
import { SPAWN_CARDS, BOSS_CARDS, ELITE_STATS } from '../data/enemies.js';
import { SAMPLES } from '../data/samples.js';

/**
 * The effects showcase (#144) — every player-facing effect, on demand, by eye
 * and ear.
 *
 * This is an *evaluation instrument*, not a feature. It ships in no player
 * build: vite emits it as its own chunk pinned at `assets/showcase.js` and
 * `package.json`'s `build.files` refuses that exact path, which
 * `tests/steam-sdk-packaging.test.mjs` proves. `tools/showcase-install.mjs`
 * puts the chunk back into a packed artifact for an evaluation session, so
 * "runs in the packaged build" is satisfied without the instrument reaching a
 * player. `main.js` reaches it through a lazy import behind Shift+F9, which in
 * a player build fails to resolve and warns — nothing else.
 *
 * Three rules it exists to enforce:
 *
 *  1. **The catalogue is derived, never typed.** Every entry below comes from
 *     iterating `ABILITIES`, `EQUIPMENT`, `ITEMS`, `SPAWN_CARDS`/`BOSS_CARDS`
 *     and `TIERS`. A hand-written list is a list that is wrong the first time
 *     someone adds an item, and silently — the missing effect is exactly the
 *     one nobody looks at.
 *  2. **Effects fire down their real paths.** Abilities go through
 *     `def.fire(ctx, player)`, equipment through `ctx.items.useEquipment()`,
 *     item hooks through `ctx.items.onHit/onKill/...` with a Combat-shaped
 *     payload, pickups through `ctx.items.give()`, and every enemy attack
 *     through a real unit's own `beginAttack` and state machine — a stand-in
 *     for one of those stages the absence of whatever the real path grew
 *     since. Nothing here calls VFX or
 *     Audio in a way gameplay would not, so audio arrives through the real
 *     `Audio` bus and spends the real voice budget. An effect that is
 *     inaudible under the budget is *evidence*, and a mixer bypass would
 *     destroy it.
 *  3. **Overlap is a first-class case.** Distinctiveness is only interesting
 *     when two effects land near each other, so marking (Space) fires any set
 *     together at adjacent offsets, and the presets are curated pile-ups.
 */

const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** A point `dist` metres ahead of the camera, `lateral` metres to its right, on the ground. */
function ground(ctx, dist = 12, lateral = 0) {
  const cam = ctx.camera;
  cam.getWorldDirection(_v);
  _v.y = 0;
  if (_v.lengthSq() < 1e-6) _v.set(0, 0, -1);
  _v.normalize();
  _side.copy(_v).cross(UP).normalize();
  const x = cam.position.x + _v.x * dist + _side.x * lateral;
  const z = cam.position.z + _v.z * dist + _side.z * lateral;
  const y = ctx.stage?.sampleHeight?.(x, z);
  return new THREE.Vector3(x, Number.isFinite(y) ? y + 0.1 : cam.position.y - 1.6, z);
}

/**
 * Take exactly one tick of an elite's aura, and prove it bit.
 *
 * The naive version of this — set `distToPlayer = 0` and step the unit — is
 * dead code, and quietly: `Enemy.fixedUpdate` recomputes `distToPlayer` from
 * the real player position (Enemy.js:583-587) *before* any aura block reads
 * it, so the write is overwritten every time. A showcase elite stands where
 * the lens can see it, ~5 m from a player behind a boomed camera, which is
 * outside Emberclad's 3.2 m and the void's 3.6 m — three of the six modifiers
 * demonstrated nothing and reported no error about it.
 *
 * So move the unit genuinely inside its own smallest ring for the one step,
 * pin line of sight past the staggered re-check (`losT`, Enemy.js:592-596)
 * rather than hoping the 85% lands, then put it back. The player is made whole
 * afterwards: an instrument must not be able to down the person holding it.
 *
 * Exported for `tests/showcase-elite-tick.test.mjs`, which drives a real Enemy
 * through this exact function rather than a copy of it.
 *
 * @returns {boolean} true if this affix has an aura and a tick was taken.
 */
export function forceAuraTick(ctx, e, player) {
  const s = e?.elite;
  if (!s || !(s.auraDps || s.denyRadius || s.siphonDps) || !player?.position) return false;
  // The smallest ring the unit owns, because the tick only pays inside all of
  // them: Withering denies healing out to 16 m but only draws blood inside 4.
  const ring = Math.min(...[s.auraRadius, s.siphonRadius, s.denyRadius].filter(Number.isFinite));
  const home = { x: e.position.x, y: e.position.y, z: e.position.z };
  const hp = player.health;

  e.position.x = player.position.x + ring * 0.3;
  e.position.z = player.position.z;
  e.targetPlayer = player;
  e.hasLOS = true;
  e.losT = 1;      // past the stagger: this step reads the value above, not a raycast
  e.auraT = 0;     // the tick is due now rather than up to half a second from now
  try {
    e.fixedUpdate?.(ctx, 1 / 60);
  } finally {
    e.position.x = home.x; e.position.y = home.y; e.position.z = home.z;
    if (hp != null) player.health = hp;
  }
  return true;
}

export function installShowcase(ctx) {
  /* ------------------------------------------------------------ targets */

  let dummy = null;

  /**
   * A live enemy to hang `onHit`/`onKill` payloads on.
   *
   * The hooks reach for `e.target.position`, `e.victim.stats` and the like, so
   * a plain object literal produces a showcase that fires nothing and reports
   * no error about it. Spawn a real one instead, keep it healthy, and put it
   * where the lens already is.
   */
  const target = (lateral = 0) => {
    if (dummy?.alive) return dummy;
    const card = SPAWN_CARDS.find((c) => c.id === 'skink') ?? SPAWN_CARDS[0];
    dummy = ctx.director?.spawnOne?.(ctx, card, ground(ctx, 12, lateral), null) ?? null;
    if (dummy) {
      dummy.health = dummy.maxHealth = 1e6;
      // A showcase dummy that walks out of frame mid-comparison is a dummy
      // that answers a different question than the one being asked.
      //
      // `frozen = true` used to stand here and nothing read it — Enemy has no
      // such field, so the dummy wandered exactly as before. The unit's own
      // `moveSpeed` is the field that actually holds it: `applyMovement`
      // scales *every* term of the desired velocity by it — the seek, the
      // separation push, the obstacle avoidance and the shrike jitter alike —
      // so zero is a complete stop rather than a slowed drift under its
      // neighbours. It is also not a status: applying `freeze` would have held
      // it just as well and then multiplied every incoming hit by 1.35 and
      // tinted it ice-blue, which is a poor thing to do to the target the
      // colour language is being judged against. Damage, procs and death are
      // untouched.
      dummy.moveSpeed = 0;
    }
    return dummy;
  };

  const player = () => ctx.player;

  /* ---------------------------------------------------------- catalogue */

  /**
   * `meta` is the table row an entry came off — the attack's `kind`, an
   * elite's stat block. Presets filter on it rather than on names, so a set
   * named in the effect language stays a *property* of the data and cannot
   * quietly fall behind it.
   *
   * @type {{group:string,id:string,label:string,fire:(lateral:number)=>void,meta:object}[]}
   */
  const entries = [];
  const add = (group, id, label, fire, meta = {}) => entries.push({ group, id, label, fire, meta });

  // --- survivor abilities -------------------------------------------------
  for (const def of Object.values(ABILITIES)) {
    add('ability', def.id, `${def.name} [${def.slot}]`, () => {
      const p = player();
      if (!p) return;
      def.fire(ctx, p);
      // Abilities that pay into `onAbility` do so through Items in real play.
      ctx.items?.onAbility?.({ id: def.id, slot: def.slot });
    });
  }

  // --- equipment ----------------------------------------------------------
  for (const def of EQUIPMENT) {
    add('equipment', def.id, def.name, () => {
      const items = ctx.items;
      if (!items) return;
      items.setEquipment(def.id);
      // Refill rather than bypass: `useEquipment` is the real path, charges
      // and all, and a showcase that skipped it would also skip the refund a
      // `use` returning false performs.
      items.equipCharges = items.equipmentMaxCharges();
      items.equipTimer = 0;
      const fired = items.useEquipment();
      if (!fired) console.warn(`[showcase] ${def.id} declined to fire (nothing in range?)`);
    }, { shape: def.shape });
  }

  // --- item combat hooks --------------------------------------------------
  const HOOKS = ['onHit', 'onKill', 'onDamaged', 'onInterval'];
  const dispatch = (item, hook, lateral) => {
    const items = ctx.items, p = player();
    if (!items || !p) return;
    // Grant, fire, revoke. The hook list is rebuilt from the inventory, so a
    // single held copy is what isolates one card's effect from the rest.
    items.give(item.id, 1);
    try {
      const t = hook === 'onDamaged' ? p : target(lateral);
      const pos = hook === 'onDamaged' ? p.position : (t?.position ?? ground(ctx, 12, lateral));
      if (hook === 'onHit') {
        items.onHit({
          target: t, source: p, amount: 40, toHealth: 40, crit: true, position: pos,
          procCoefficient: 1, procDepth: 1, type: 'hit',
        });
      } else if (hook === 'onKill') {
        items.onKill({ victim: t, source: p, position: pos, procDepth: 1, procCoefficient: 1 });
      } else if (hook === 'onDamaged') {
        items.onDamaged({ target: p, source: t, amount: 25, position: pos, procDepth: 1 });
      } else {
        // `onInterval` is paid a fixed-step `dt` in play; hand it the tick
        // length its authors wrote against rather than a whole second.
        items.onInterval?.({ dt: 1 / 60 });
      }
    } finally {
      items.take(item.id, 1);
    }
  };
  for (const item of ITEMS) {
    for (const hook of HOOKS) {
      if (typeof item.hooks?.[hook] !== 'function') continue;
      add(`item:${hook}`, `${item.id}:${hook}`, `${item.name} — ${hook}`,
        (lateral) => dispatch(item, hook, lateral));
    }
  }

  // --- enemy attack windows -----------------------------------------------
  // Every attack on every card, split by whether the table gives it something
  // to see. The ones with a ring or a blast are the telegraphed half; the rest
  // are the effect language's C6 group — windows that used to be *silent*,
  // which is precisely why the showcase has to be able to fire them. An
  // enumeration that skipped them would omit the effects most in need of
  // judging.
  //
  // Both halves fire the same way: a real unit off the card, driven into the
  // real `WINDUP` -> release state machine by `beginAttack`. The earlier
  // version drew stand-ins — a ring, a blip, an `explosion()` with no core
  // colour — and that was tolerable only while play did the same. It no longer
  // does: the windup now carries a ground ring, a held rising voice in the
  // attacker's element and a per-kind tell, and a nova's core is tinted by the
  // caster's element (#151). A stand-in showcase therefore staged the *absence*
  // of exactly what the jury presets were convened to judge. Nothing below
  // re-implements any of that; it only spawns the unit and opens the window.
  const demos = new Set();

  /**
   * Retire a demonstrator down the real path.
   *
   * `despawn` is what `Director.clear` calls at every stage transition, and it
   * is the call that returns every held voice (`Enemy.releaseVoices`) — the
   * windup voice above all, which is *held* for the length of its window. An
   * instrument that leaked one would poison the voice-budget evidence it exists
   * to collect, so this runs on the timer, again on close, and is idempotent.
   */
  const retire = (e) => {
    if (!demos.delete(e)) return;
    e.despawn?.(ctx);
    const list = ctx.director?.enemies;
    const i = list ? list.indexOf(e) : -1;
    if (i >= 0) list.splice(i, 1);
  };

  /**
   * Stand a real unit of `card` up and make it perform attack `index`.
   *
   * The mercy window is not squeamishness: the attack lands for real, on the
   * real player, through the real Combat, and an evaluation session that ends
   * with the evaluator downed answers a question nobody asked. `grantIFrames`
   * is the same gate a dash opens, so the damage still travels its whole path
   * and is refused at the last step rather than never being dealt.
   */
  const perform = (card, a, index, lateral) => {
    const at = ground(ctx, 14, lateral);
    const e = ctx.director?.spawnOne?.(ctx, card, at, null);
    if (!e) return;
    const p = player();
    e.health = e.maxHealth = 1e6;
    e.targetPlayer = p ?? null;
    e.hasLOS = true;
    e.losT = 1;         // past the staggered LOS re-check, as `forceAuraTick` does
    e.gcd = 0;
    e.cd?.fill?.(0);
    demos.add(e);
    const span = (a.windup ?? 0.6) * (e.timeScale ?? 1) + (a.active ?? 0) + 1.2;
    p?.grantIFrames?.(span + 0.5);
    e.beginAttack(ctx, index);
    setTimeout(() => retire(e), span * 1000);
  };
  for (const card of [...SPAWN_CARDS, ...BOSS_CARDS]) {
    const attacks = card.attacks ?? [];
    for (let i = 0; i < attacks.length; i++) {
      const a = attacks[i];
      const meta = { kind: a.kind, cardId: card.id, tier: card.tier, attackId: a.id };
      const radius = a.telegraph || a.blast;
      if (radius) {
        add('telegraph', `${card.id}:${a.id}`, `${card.name} — ${a.id} (r${radius})`,
          (lateral) => perform(card, a, i, lateral), meta);
      } else {
        const win = a.windup ?? 0.6;
        add('windup', `${card.id}:${a.id}`, `${card.name} — ${a.id} (windup ${win}s)`,
          (lateral) => perform(card, a, i, lateral), meta);
      }
    }
  }

  // --- elite modifiers ----------------------------------------------------
  // Iterated off `ELITE_STATS`, not `ELITE_AFFIXES`: the void's own affix is
  // deliberately absent from `ELITE_TIERS` (the Director's void path is its
  // only door), so the tier list would enumerate five of six and look right.
  //
  // Each affix is shown the only way it is honest to show one — a real elite
  // spawned with it, so the tint and aura come off the same rig a fight would
  // build. Then its signature: one forced aura tick for the three that drain,
  // and a real killing blow for the three whose signature is a corpse, which
  // also pops a Warded barrier because Combat drains the shield on the way.
  for (const [affix, stats] of Object.entries(ELITE_STATS)) {
    add('elite', `elite:${affix}`, `${stats.label} — aura, tint and signature`, (lateral) => {
      const card = SPAWN_CARDS.find((c) => c.id === 'skink') ?? SPAWN_CARDS[0];
      const e = ctx.director?.spawnOne?.(ctx, card, ground(ctx, 12, lateral), affix);
      if (!e) return;
      const p = player();
      forceAuraTick(ctx, e, p);
      // The corpse effects — Galvanic's shock blast, Rimebound's freezing nova,
      // Warded's reflected pop — through the real killing blow, so the death
      // signature and dissolve arrive with them exactly as in play.
      setTimeout(() => {
        if (e.alive) ctx.combat?.applyDamage?.(e, e.maxHealth * 10, { source: p, type: 'showcase' });
      }, 1400);
    }, { affix, stats });
  }

  // --- pickups ------------------------------------------------------------
  // One representative card per tier, chosen from the table rather than named:
  // the tier ladder is what the pickup jingle is pitched against, and Audio
  // hears the grant through its inventory watcher exactly as it does in play.
  for (const tier of Object.keys(TIERS)) {
    const item = tier === 'equipment' ? null : ITEMS.find((i) => i.tier === tier);
    const label = `${TIERS[tier].name} pickup — ${item?.name ?? EQUIPMENT[0].name}`;
    add('pickup', `pickup:${tier}`, label, (lateral) => {
      const at = ground(ctx, 6, lateral);
      ctx.vfx?.itemPickupBurst?.(at, TIERS[tier].colour);
      if (item) {
        ctx.items?.give?.(item.id, 1);
        setTimeout(() => ctx.items?.take?.(item.id, 1), 1500);
      } else {
        ctx.items?.setEquipment?.(EQUIPMENT[0].id);
        ctx.audio?.play?.('pickup', at, 'equipment');
      }
    });
  }

  // --- sampled voices (#148) ---------------------------------------------
  // Read off the registry, so a sample added or renamed there appears here
  // without anyone remembering to. The first press of a cold entry starts the
  // decode and is silent by design; the second one sounds.
  for (const def of SAMPLES) {
    add('sample', `sample:${def.id}`, `Sample — ${def.id}`, (l) => {
      ctx.audio?.playSample?.(def.id, ground(ctx, 10, l));
    });
  }

  // --- run-level moments --------------------------------------------------
  // Not table-driven because they are not table-backed: each is a one-off VFX
  // or Audio call the game makes at a named moment, and the enumeration that
  // matters is the public API of the two systems.
  add('moment', 'levelUp', 'Level up', () => {
    const p = player(); if (!p) return;
    ctx.vfx?.levelUp?.(p.position); ctx.audio?.play?.('levelUp');
  });
  add('moment', 'teleporterAura', 'Teleporter aura', (l) => ctx.vfx?.teleporterAura?.(ground(ctx, 10, l), 12));
  add('moment', 'bossHorn', 'Boss horn', () => ctx.audio?.bossHorn?.());
  add('moment', 'stageStart', 'Stage sting', () => ctx.audio?.play?.('stageStart'));
  add('moment', 'shieldBreak', 'Shield break', (l) => {
    const at = ground(ctx, 8, l);
    ctx.vfx?.shieldBreak?.(at); ctx.audio?.play?.('shieldBreak', at);
  });
  add('moment', 'playerDowned', 'Player downed', () => ctx.audio?.playerDowned?.(player()?.position));
  add('moment', 'playerRevived', 'Player revived', () => ctx.audio?.playerRevived?.(player()?.position));
  add('moment', 'killSignature', 'Kill signature', (l) => {
    const t = target(l); if (!t) return;
    ctx.vfx?.killSignature?.(t.position, t.def?.color ?? 0xff8844);
    ctx.vfx?.corpseLaunch?.(t.position, t.radius ?? 0.5);
    ctx.audio?.play?.('death', t.position, false);
  });
  add('moment', 'damageNumber', 'Damage number (crit)', (l) => {
    const t = target(l); if (!t) return;
    ctx.vfx?.damageNumber?.(t.position, 1337, true);
    ctx.audio?.play?.('hit', t.position, true);
  });
  for (const s of ['burn', 'slow', 'shock', 'bleed']) {
    add('moment', `status:${s}`, `Status applied — ${s}`, (l) => {
      const t = target(l); if (!t) return;
      ctx.vfx?.statusApplied?.(t.position, s);
    });
  }

  /* ------------------------------------------------------------- presets */

  const idsOf = (pred) => entries.filter(pred);

  // The effect language's set memberships, expressed as the property that
  // *defines* each set rather than as the roster it happened to have on the
  // day the document was written.
  //
  //  C2 — the expanding-ring novas: every attack kind that ends in a blast at
  //       the attacker's feet, plus the three elite affixes whose death is one.
  //  C3 — the sweeping lines: beams and barrages, which share a long charge
  //       and a swept delivery.
  //  C4 — every projectile release.
  //  C6 — the silent windows: melee swings, charges, summon casts and the
  //       shrike's dive, none of which marks the ground it is aimed at.
  const NOVA_KINDS = new Set(['nova', 'slam', 'stomp']);
  const BEAM_KINDS = new Set(['beam', 'barrage']);
  const WINDOW_KINDS = new Set(['melee', 'charge', 'summon', 'dive']);
  /** An elite whose corpse is a nova — read off the radius its stat block carries. */
  const isDeathNovaElite = (e) =>
    e.group === 'elite' && !!(e.meta.stats?.blastRadius || e.meta.stats?.novaRadius);
  const presets = [
    ['1', 'every onHit proc at once', () => idsOf((e) => e.group === 'item:onHit')],
    ['2', 'every onKill proc at once', () => idsOf((e) => e.group === 'item:onKill')],
    ['3', 'every onDamaged proc at once', () => idsOf((e) => e.group === 'item:onDamaged')],
    ['4', 'four equipment together', () => idsOf((e) => e.group === 'equipment').slice(0, 4)],
    ['5', 'a kill, its loot and a level', () =>
      entries.filter((e) => ['killSignature', 'damageNumber', 'levelUp', 'pickup:legendary'].includes(e.id))],
    ['6', 'every status at one point', () => idsOf((e) => e.id.startsWith('status:'))],
    ['7', 'three telegraphs overlapping', () => idsOf((e) => e.group === 'telegraph').slice(0, 3)],
    ['8', 'all six elite modifiers side by side', () => idsOf((e) => e.group === 'elite')],

    // --- set-level presets (#149) -----------------------------------------
    // Four groups the effect language (docs/art/EFFECT-LANGUAGE.md C2-C6)
    // names as needing to be judged *whole*, and which no earlier preset can
    // reach: 4 caps at four, 7 caps at three, and the silent windows had no
    // entries at all until this file grew them. Each membership is a
    // predicate over the data tables, never a list of names, so an attack
    // added to `enemies.js` joins its set without anyone remembering to.
    ['9', 'every nova at one point', () =>
      idsOf((e) => NOVA_KINDS.has(e.meta.kind) || isDeathNovaElite(e))],
    // C3 is not an enemy-only group: `tesla-crown` and `gravity-snare` are
    // named in it, and a preset that showed only the six enemy beams staged
    // half the comparison the document asks for. The equipment table now says
    // `shape: 'beam'` so this stays a predicate over the data.
    ['0', 'all beam users charging together', () =>
      idsOf((e) => BEAM_KINDS.has(e.meta.kind) || e.meta.shape === 'beam')],
    ['-', 'full-horde release', () => idsOf((e) => e.meta.kind === 'projectile')],
    ['=', 'all telegraph windows at once', () => idsOf((e) => WINDOW_KINDS.has(e.meta.kind))],
  ];

  /**
   * The physical key a preset is bound to. Twelve presets outrun the digit
   * row, so 10-12 take the three keys that continue it: `0`, `-`, `=`.
   */
  const codeOf = (k) => (/^[0-9]$/.test(k) ? `Digit${k}` : { '-': 'Minus', '=': 'Equal' }[k]);

  /* ------------------------------------------------------------- firing */

  const fire = (entry, lateral = 0) => {
    try {
      entry.fire(lateral);
    } catch (err) {
      // Loudly, and without taking the frame: a showcase whose list stops
      // responding after one bad entry is worse than one that says which.
      console.error(`[showcase] ${entry.id} threw:`, err);
      flash(`ERROR ${entry.id} — see console`);
    }
  };

  /**
   * Fire a set together, spread across adjacent lateral offsets.
   *
   * Same frame, not staggered: overlap is the property under test, and a
   * 100 ms stagger is exactly the interval that makes two indistinguishable
   * effects look distinct.
   */
  const fireGroup = (set) => {
    const n = set.length;
    const span = Math.min(3, n <= 1 ? 0 : 9 / (n - 1));
    set.forEach((e, i) => fire(e, n === 1 ? 0 : (i - (n - 1) / 2) * span));
    flash(`fired ${n}: ${set.map((e) => e.id).join(', ')}`);
  };

  /* ----------------------------------------------------------------- UI */

  const root = document.createElement('div');
  root.id = 'showcase';
  root.style.cssText = [
    'position:fixed', 'inset:auto 0 0 0', 'height:46vh', 'z-index:99999',
    'font:12px/1.45 ui-monospace,Consolas,monospace', 'color:#dfe8ef',
    'background:rgba(6,10,14,0.88)', 'border-top:1px solid #2b3a46',
    'display:none', 'padding:8px 12px', 'overflow:hidden',
  ].join(';');
  const head = document.createElement('div');
  head.style.cssText = 'color:#9fd0ff;padding-bottom:6px;border-bottom:1px solid #22303a';
  const list = document.createElement('div');
  list.style.cssText = 'height:calc(100% - 46px);overflow:auto;padding-top:4px';
  const note = document.createElement('div');
  note.style.cssText = 'color:#8fa3b2;padding-top:4px;height:16px';
  root.append(head, list, note);
  document.body.appendChild(root);

  let open = false, cursor = 0, filter = '';
  const marked = new Set();
  let flashUntil = 0;
  const flash = (msg) => { note.textContent = msg; flashUntil = Date.now() + 4000; };

  const visible = () => {
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter((e) => `${e.group} ${e.id} ${e.label}`.toLowerCase().includes(f));
  };

  const render = () => {
    const rows = visible();
    cursor = Math.max(0, Math.min(cursor, rows.length - 1));
    head.textContent =
      `SHOWCASE  ${rows.length}/${entries.length} effects` +
      `${filter ? `  filter:"${filter}"` : ''}  marked:${marked.size}` +
      '   [up/down] move  [enter] fire  [space] mark  [g] fire marked  [c] clear' +
      '  [1-9 0 - =] presets  [type] filter  [esc] close';
    list.innerHTML = '';
    let group = null;
    rows.forEach((e, i) => {
      if (e.group !== group) {
        group = e.group;
        const h = document.createElement('div');
        h.textContent = `-- ${group}`;
        h.style.cssText = 'color:#5f7d92;margin-top:6px';
        list.appendChild(h);
      }
      const row = document.createElement('div');
      row.textContent = `${marked.has(e) ? '[x] ' : '[ ] '}${e.label}`;
      row.style.cssText = i === cursor
        ? 'background:#1d3a4f;color:#ffffff;padding:0 4px'
        : 'padding:0 4px';
      if (i === cursor) queueMicrotask(() => row.scrollIntoView({ block: 'nearest' }));
      list.appendChild(row);
    });
    if (Date.now() > flashUntil) {
      note.textContent = presets.map(([k, name]) => `${k}:${name}`).join('   ');
    }
  };

  const setOpen = (v) => {
    open = v;
    root.style.display = v ? 'block' : 'none';
    // The showcase is judged by eye and ear against a live game, so the sim
    // keeps running underneath — only the keyboard is borrowed.
    if (v) render();
    // Closing ends the session: any demonstrator still mid-window is retired
    // here, which returns its held voice with it.
    if (!v) for (const e of [...demos]) retire(e);
    // Warm the sampled voices the moment the menu opens, so the first press of
    // a sample entry is not the silent one that starts its decode.
    if (v) ctx.audio?.ensureSamples?.()?.catch?.(() => {});
  };

  const onKey = (ev) => {
    if (ev.code === 'F9' && ev.shiftKey) {
      ev.preventDefault(); ev.stopPropagation();
      setOpen(!open);
      return;
    }
    if (!open) return;
    const rows = visible();
    const here = rows[cursor];
    let handled = true;
    switch (ev.code) {
      case 'Escape': setOpen(false); break;
      case 'ArrowDown': case 'KeyJ': cursor++; break;
      case 'ArrowUp': case 'KeyK': cursor--; break;
      case 'PageDown': cursor += 12; break;
      case 'PageUp': cursor -= 12; break;
      case 'Home': cursor = 0; break;
      case 'End': cursor = rows.length - 1; break;
      case 'Enter': if (here) { fire(here, 0); flash(`fired ${here.id}`); } break;
      case 'Space':
        if (here) { marked.has(here) ? marked.delete(here) : marked.add(here); }
        break;
      case 'KeyG': if (marked.size) fireGroup([...marked]); break;
      case 'KeyC': marked.clear(); flash('marks cleared'); break;
      case 'Backspace': filter = filter.slice(0, -1); break;
      default:
        if (presets.some(([k]) => codeOf(k) === ev.code)) {
          const p = presets.find(([k]) => codeOf(k) === ev.code);
          const set = p[2]();
          if (set.length) { fireGroup(set); flash(`preset: ${p[1]} (${set.length})`); }
          else flash(`preset: ${p[1]} — nothing matched`);
        } else if (/^Key[A-Z]$/.test(ev.code) && !ev.ctrlKey && !ev.altKey) {
          filter += ev.key.toLowerCase();
        } else {
          handled = false;
        }
    }
    if (handled) {
      // Capture phase plus both stops: Input listens on window and would
      // otherwise read every keystroke of a filter as movement.
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      render();
    }
  };
  window.addEventListener('keydown', onKey, true);

  const api = {
    entries,
    // `ids` is resolved here rather than exposed as a thunk so that
    // `tests/showcase-surface.test.mjs` can re-derive each preset's membership
    // from the tables and object when a preset falls behind them.
    presets: presets.map(([k, name, resolve]) => ({ key: k, name, ids: resolve().map((e) => e.id) })),
    open: () => setOpen(true),
    close: () => setOpen(false),
    fire: (id) => {
      const e = entries.find((x) => x.id === id);
      if (!e) { console.warn(`[showcase] no effect "${id}"`); return false; }
      fire(e, 0);
      return true;
    },
    dispose: () => {
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      // Every demonstrator still standing goes now, which is also how every
      // voice it is holding is returned. Closing the instrument must not leave
      // a windup chord sounding over the game underneath it.
      for (const e of [...demos]) retire(e);
    },
  };
  globalThis.__SHOWCASE__ = api;
  console.log(`[showcase] ${entries.length} effects catalogued; Shift+F9 to open.`);
  return api;
}
