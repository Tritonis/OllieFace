/**
 * The Steam friend picker's UI contract.
 *
 *   node tests/menus-friend-picker.test.mjs
 *
 * Integration review MAJOR 1 (#54): `renderSteamFriends` is the first thing on
 * the co-op screen whose length is decided outside this repo — a Steam friends
 * list is as long as it is — and it was rendering into a `.screen` that is
 * `inset: 0; justify-content: center` with no overflow. Past about a dozen rows
 * the panel head left the top of the viewport and the Back button left the
 * bottom, with no way to reach either on any input device.
 *
 * Two halves, both provable without a browser:
 *
 *  1. The layout contract, read off the shipped sources. `.coop-body` has to
 *     exist, has to wrap the picker, has to leave the footer buttons OUTSIDE
 *     itself, and hud.css has to bound the panel and scroll that wrapper — the
 *     same four facts `.screen--settings` and `.screen--death` were given when
 *     they hit this (#43).
 *  2. `renderSteamFriends` itself, against a document stand-in small enough to
 *     read: every row lands inside the picker host (so it inherits the bound),
 *     every row is a `[data-nav]` target (so `paintFocus`'s `scrollIntoView`
 *     reaches it), and a persona name is placed as TEXT.
 *
 * There is no jsdom in this repo, so the second half uses the same minimal-doc
 * idiom as `tests/menus-recovery.test.mjs`.
 */
import { readFileSync } from 'node:fs';
import { Menus } from '../src/ui/Menus.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const read = (rel) => readFileSync(new URL(`../src/ui/${rel}`, import.meta.url), 'utf8');
const MENUS = read('Menus.js');
const CSS = read('hud.css');

// -------------------------------------------------------- the layout contract

console.log('-- the co-op panel bounds its own content');
{
  ok(/\.screen--coop \.panel--wide \{[^}]*max-height:/.test(CSS),
    'hud.css bounds `.screen--coop .panel--wide` with a max-height, as settings and death both are');
  ok(/\.screen--coop \.panel--wide \{[^}]*min-height: 0;/.test(CSS),
    'and carries `min-height: 0` — without the flex-child escape hatch the overflow never engages');
  ok(/\.screen--coop \.panel--wide \{[^}]*flex-shrink: 0;/.test(CSS),
    'and `flex-shrink: 0`, so `.screen` cannot squeeze the panel below its max-height (the "scrolls when it fits" regression)');

  ok(/\.coop-body \{[^}]*overflow-y: auto;/.test(CSS), '`.coop-body` is the scroller');
  ok(/\.coop-body \{[^}]*min-height: 0;/.test(CSS), 'and it too gets the escape hatch');
  ok(/\.screen--coop \.panel--wide > \.menu-list \{[^}]*flex: 0 0 auto;/.test(CSS),
    'the footer row does not shrink, so Leave and Back survive any friends list');
}

console.log('\n-- and the markup puts the right things inside it');
{
  // Sliced on the data-screen attributes, not the class names: the class names
  // also appear in the SCROLLERS comment far above the markup.
  const screen = MENUS.slice(MENUS.indexOf('data-screen="coop"'), MENUS.indexOf('data-screen="death"'));
  ok(screen.includes('class="coop-body" data-coop-body'), 'the co-op panel has a `.coop-body` wrapper');

  const bodyStart = screen.indexOf('data-coop-body');
  const bodyEnd = screen.indexOf('/.coop-body');
  ok(bodyStart > 0 && bodyEnd > bodyStart, 'the wrapper opens and closes inside the co-op screen');

  const inside = screen.slice(bodyStart, bodyEnd);
  const after = screen.slice(bodyEnd);
  ok(inside.includes('data-coop-friends'), 'the friend picker renders INSIDE the scroller');
  ok(inside.includes('data-coop-steam'), 'and so does the Steam block that opens it');
  ok(!inside.includes('coop-leave') && after.includes('coop-leave'),
    'while Leave co-op sits outside it, where a long list cannot push it off frame');
  ok(!inside.includes('data-act="back"') && after.includes('data-act="back"'),
    'and so does Back — the button whose unreachability was the whole finding');

  ok(/const SCROLLERS = \{[^}]*coop: '\.coop-body'/.test(MENUS),
    "`scrollRegion()`'s map names the co-op scroller, so the screen is not special-cased to death any more");
}

// ------------------------------------------------------------ a tiny document

/** Just enough DOM for `renderSteamFriends` to build into. */
function makeDoc() {
  const node = (tag) => {
    const el = {
      tag,
      children: [],
      dataset: {},
      className: '',
      hidden: false,
      _text: '',
      get textContent() { return el._text || el.children.map((c) => c.textContent).join(''); },
      set textContent(v) { el._text = String(v); el.children = []; },
      append(...kids) { el.children.push(...kids); },
      replaceChildren(...kids) { el.children = kids; },
      // Deliberately absent: `innerHTML`. A picker that reached for it would
      // throw here rather than quietly splice a persona name into markup.
    };
    return el;
  };
  return { createElement: node, node };
}

const walk = (el, out = []) => { out.push(el); for (const c of el.children) walk(c, out); return out; };

/** A `Menus`-shaped `this` carrying only what the method under test touches. */
function makePicker() {
  const doc = makeDoc();
  const host = doc.node('div');
  host.hidden = true;
  const self = {
    root: { querySelector: (sel) => (sel === '[data-coop-friends]' ? host : null) },
    painted: 0,
    navTargets: () => walk(host).filter((el) => el.dataset.nav !== undefined),
    paintFocus() { self.painted++; },
  };
  return { self, host, doc };
}

console.log('\n-- renderSteamFriends: every row inside the bound, and reachable');
{
  const { self, host, doc } = makePicker();
  globalThis.document = doc;

  const friends = [
    { steamId: '1', personaName: 'Ada', personaState: 1, inGame: true },
    { steamId: '2', personaName: 'Bo', personaState: 1, inGame: false },
    { steamId: '3', personaName: 'Cy', personaState: 0, inGame: false },
  ];
  Menus.prototype.renderSteamFriends.call(self, friends);

  const rows = walk(host).filter((el) => el.dataset.steamFriend !== undefined);
  ok(rows.length === 3, 'one row per friend');
  ok(rows.map((r) => r.dataset.steamFriend).join(',') === '1,2,3', 'each row names its own friend');
  ok(rows.every((r) => r.dataset.nav !== undefined),
    'every row is a [data-nav] target — which is what lets paintFocus scrollIntoView reach it inside the scroller');
  ok(host.hidden === false, 'the picker host is revealed');
  ok(self.painted === 1, 'and the focus ring is repainted over the new targets');

  // Containment: nothing is appended anywhere but the host, so every row
  // inherits `.coop-body`'s bound rather than escaping the panel.
  ok(walk(host).length - 1 >= rows.length, 'the whole list hangs off the picker host');

  ok(rows[0].textContent === 'Ada — in this game', 'a friend already here says so');
  ok(rows[1].textContent === 'Bo', 'an online friend is just their name');
  ok(rows[2].textContent === 'Cy — offline', 'and an offline one is marked');

  // A second render replaces rather than accumulates: pressing Invite twice
  // must not double the list inside a scroller that would then hide the seam.
  Menus.prototype.renderSteamFriends.call(self, friends);
  ok(walk(host).filter((el) => el.dataset.steamFriend !== undefined).length === 3,
    'rendering again replaces the list rather than growing it');

  delete globalThis.document;
}

console.log('\n-- a persona name is placed as text, never as markup');
{
  const { self, host, doc } = makePicker();
  globalThis.document = doc;
  Menus.prototype.renderSteamFriends.call(self,
    [{ steamId: '1', personaName: '<img src=x onerror=alert(1)>', personaState: 1, inGame: false }]);
  const row = walk(host).find((el) => el.dataset.steamFriend !== undefined);
  ok(row.textContent === '<img src=x onerror=alert(1)>',
    'the name survives verbatim as text — it was set through textContent, and this document has no innerHTML to set');
  delete globalThis.document;
}

console.log('\n-- an empty list is a sentence, not a blank panel');
{
  const { self, host, doc } = makePicker();
  globalThis.document = doc;
  Menus.prototype.renderSteamFriends.call(self, []);
  ok(host.hidden === false, 'the host still opens');
  ok(/no steam friends/i.test(host.textContent), `and says so (${JSON.stringify(host.textContent)})`);
  ok(walk(host).filter((el) => el.dataset.steamFriend !== undefined).length === 0, 'with no rows at all');
  delete globalThis.document;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
