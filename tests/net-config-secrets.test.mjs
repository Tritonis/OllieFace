/**
 * A TURN credential is never written down.
 *
 *   node tests/net-config-secrets.test.mjs
 *
 * `?turn=`, `?turnuser=` and `?turnpass=` have to keep working — the parked
 * `slice/mp-p4-remote-network` branch passes the real relay credentials that
 * way, and the P4 handoff makes that the only path whose secrets
 * `tools/coopprobe.mjs` can redact before a record is committed. What must stop
 * is the *persistence*: a credential in `localStorage` outlives the run that
 * needed it, is readable by everything else on the origin, and survives into
 * screenshots and support dumps taken long afterwards.
 *
 * `NetConfig` reads `location.search` once at module load, so each case installs
 * its own globals and then imports a fresh copy with a cache-busting query.
 * That is also what lets a case prove the purge happens at *load* rather than on
 * the first `iceServers()` call: it simply never calls anything.
 */
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
    keys: () => [...map.keys()],
    dump: () => Object.fromEntries(map),
  };
}

/** Install a global the way a browser would have it, whether or not one exists. */
function install(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

let nonce = 0;
async function loadNetConfig({ search = '', storage = fakeStorage() } = {}) {
  install('location', { search, protocol: 'https:', href: `https://play.test/${search}` });
  install('localStorage', storage);
  const mod = await import(`../src/net/NetConfig.js?case=${++nonce}`);
  return { mod, storage };
}

console.log('T1 — a credential arriving by query is used but never stored');
{
  const { mod, storage } = await loadNetConfig({
    search: '?turn=turn:relay.test:3478&turnuser=alice&turnpass=s3cret',
  });
  const turn = mod.iceServers().find((s) => String(s.urls).includes('turn:'));
  ok(turn?.username === 'alice' && turn?.credential === 's3cret',
     'the credential reaches the ICE server list');
  const stored = JSON.stringify(storage.dump());
  ok(!stored.includes('alice') && !stored.includes('s3cret'),
     `nothing about it is written down (storage: ${stored})`);
  ok(storage.keys().some((k) => k.endsWith('.turn')),
     'while the endpoint itself — which is not a secret — still persists');
}

console.log('T2 — a credential left in storage by an older build is purged at load, unasked');
{
  // Deliberately nothing is called on the module. The purge has to happen when
  // NetConfig loads, not when `iceServers()` is first reached, because the
  // player whose stale credential matters most is the one who never opens the
  // co-op screen at all. A test that called `iceServers()` here could not tell
  // the two designs apart.
  const { storage } = await loadNetConfig({
    search: '',
    storage: fakeStorage({
      'telluric.net.turnuser': 'alice',
      'telluric.net.turnpass': 's3cret',
      'petrichor.net.turnpass': 'older-secret',
      'telluric.net.turn': 'turn:relay.test:3478',
    }),
  });
  const stored = JSON.stringify(storage.dump());
  ok(!stored.includes('s3cret') && !stored.includes('older-secret') && !stored.includes('alice'),
     `both prefixes are cleared without anyone asking for an ICE list (storage: ${stored})`);
  ok(storage.getItem('telluric.net.turn') === 'turn:relay.test:3478',
     'and the endpoint is left alone');
}

console.log('T3 — a credential written after load is cleared by the next read');
{
  // The load-time purge cannot see a write that happens after it. An older
  // build of the game left open in a second tab is exactly that: it still
  // persists credentials, into the same origin this page is reading. So every
  // read of a secret setting clears too, which bounds the exposure to the gap
  // between two reads rather than to the next reload.
  const { mod, storage } = await loadNetConfig({ search: '' });
  storage.setItem('telluric.net.turnpass', 'late-secret');
  storage.setItem('petrichor.net.turnuser', 'late-alice');
  mod.iceServers();
  const stored = JSON.stringify(storage.dump());
  ok(!stored.includes('late-secret') && !stored.includes('late-alice'),
     `a credential that appeared after load does not survive a read (storage: ${stored})`);
}

console.log('T4 — a stored credential is not silently used, so TURN fails loudly rather than half-configured');
{
  const { mod } = await loadNetConfig({
    search: '',
    storage: fakeStorage({
      'telluric.net.turn': 'turn:relay.test:3478',
      'telluric.net.turnuser': 'alice',
      'telluric.net.turnpass': 's3cret',
    }),
  });
  const turn = mod.iceServers().find((s) => String(s.urls).includes('turn:'));
  ok(turn && turn.username === undefined,
     `a session with no credential in its URL gets no credential (got ${JSON.stringify(turn)})`);
}

console.log('T5 — describeNet still says whether TURN is configured, and never what it is');
{
  const { mod } = await loadNetConfig({
    search: '?turn=turn:relay.test:3478&turnuser=alice&turnpass=s3cret',
  });
  const d = JSON.stringify(mod.describeNet());
  ok(d.includes('"hasTurn":true'), 'it reports that TURN is on');
  ok(!d.includes('alice') && !d.includes('s3cret'), `and carries neither half of the credential (got ${d})`);
}

console.log('T6 — every non-credential query parameter still persists exactly as it did');
{
  // The whole point of the persistence this task removes for two keys is that
  // it stays for the other four: a tester follows one link and every later
  // plain visit keeps the same relay, the same relay-only policy and the same
  // simulated network. `describeNet()` is the one call that reads all four.
  const { mod, storage } = await loadNetConfig({
    search: '?signal=wss://relay.test&ice=relay&netlag=40-90&netloss=2'
      + '&turn=turn:relay.test:3478&turnuser=alice&turnpass=s3cret',
  });
  mod.describeNet();
  for (const [key, want] of [
    ['signal', 'wss://relay.test'],
    ['ice', 'relay'],
    ['netlag', '40-90'],
    ['netloss', '2'],
    ['turn', 'turn:relay.test:3478'],
  ]) {
    ok(storage.getItem(`telluric.net.${key}`) === want,
       `?${key}= still persists (got ${JSON.stringify(storage.getItem(`telluric.net.${key}`))})`);
  }
  ok(storage.getItem('telluric.net.turnuser') === null
     && storage.getItem('telluric.net.turnpass') === null,
     'and only the two credentials do not');

  // And a second visit with a bare URL still resolves what the first one stored.
  const again = await loadNetConfig({ search: '', storage });
  const d = again.mod.describeNet();
  ok(d.signal === 'wss://relay.test' && d.relayOnly === true && d.sim.lagMs === 40 && d.sim.lossPct === 2,
     `a later plain visit keeps the whole non-credential configuration (got ${JSON.stringify(d)})`);
  ok(d.hasTurn === true, 'including the TURN endpoint');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
