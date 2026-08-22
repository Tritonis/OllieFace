import * as THREE from 'three';
import { ABILITIES } from '../data/abilities.js';
import { EQUIPMENT } from '../data/equipment.js';
import { ITEMS, TIERS } from '../data/items.js';
import { SPAWN_CARDS, BOSS_CARDS } from '../data/enemies.js';

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
 *     payload, pickups through `ctx.items.give()`. Nothing here calls VFX or
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
      dummy.frozen = true;
    }
    return dummy;
  };

  const player = () => ctx.player;

  /* ---------------------------------------------------------- catalogue */

  /** @type {{group:string,id:string,label:string,fire:(lateral:number)=>void}[]} */
  const entries = [];
  const add = (group, id, label, fire) => entries.push({ group, id, label, fire });

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
    });
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

  // --- enemy telegraphs ---------------------------------------------------
  for (const card of [...SPAWN_CARDS, ...BOSS_CARDS]) {
    for (const a of card.attacks ?? []) {
      const radius = a.telegraph || a.blast;
      if (!radius) continue;
      add('telegraph', `${card.id}:${a.id}`, `${card.name} — ${a.id} (r${radius})`, (lateral) => {
        const at = ground(ctx, 14, lateral);
        // Ring life is the shell's flight in play; the impact is what the ring
        // is a deadline *for*, so fire both or the effect reads as half of one.
        const life = a.telegraph ? 1.1 : 0.4;
        ctx.director?.spawnTelegraph?.(at.x, at.z, radius, life, a.color ?? 0xff5a3c);
        ctx.audio?.play?.('shoot', at, 1.2);
        setTimeout(() => {
          ctx.vfx?.explosion?.(at, radius, a.color ?? 0xff5a3c);
          ctx.audio?.play?.('explosion', at, radius);
        }, life * 1000);
      });
    }
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
  const presets = [
    ['1', 'every onHit proc at once', () => idsOf((e) => e.group === 'item:onHit')],
    ['2', 'every onKill proc at once', () => idsOf((e) => e.group === 'item:onKill')],
    ['3', 'every onDamaged proc at once', () => idsOf((e) => e.group === 'item:onDamaged')],
    ['4', 'four equipment together', () => idsOf((e) => e.group === 'equipment').slice(0, 4)],
    ['5', 'a kill, its loot and a level', () =>
      entries.filter((e) => ['killSignature', 'damageNumber', 'levelUp', 'pickup:legendary'].includes(e.id))],
    ['6', 'every status at one point', () => idsOf((e) => e.id.startsWith('status:'))],
    ['7', 'three telegraphs overlapping', () => idsOf((e) => e.group === 'telegraph').slice(0, 3)],
  ];

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
      '  [1-7] presets  [type] filter  [esc] close';
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
        if (/^Digit[1-7]$/.test(ev.code)) {
          const p = presets[Number(ev.code.slice(5)) - 1];
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
    presets: presets.map(([k, name]) => ({ key: k, name })),
    open: () => setOpen(true),
    close: () => setOpen(false),
    fire: (id) => {
      const e = entries.find((x) => x.id === id);
      if (!e) { console.warn(`[showcase] no effect "${id}"`); return false; }
      fire(e, 0);
      return true;
    },
    dispose: () => { window.removeEventListener('keydown', onKey, true); root.remove(); },
  };
  globalThis.__SHOWCASE__ = api;
  console.log(`[showcase] ${entries.length} effects catalogued; Shift+F9 to open.`);
  return api;
}
