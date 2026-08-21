/**
 * The GPU notice must not eat clicks meant for what's underneath it.
 *
 *   node tests/gpu-notice.test.mjs
 *
 * #125: the banner sits over the title-screen Settings button until
 * dismissed, and its container swallowed pointer events for anything behind
 * it. The fix is CSS-only -- the non-interactive subtree is
 * `pointer-events:none`, and the one interactive control inside it,
 * `.gpu-notice__x`, restores `pointer-events:auto` for itself. This test
 * parses the actual `<style>` text the module installs (not the module's
 * source text) and resolves the effective declaration per selector, the way
 * a real cascade would -- so it fails if the restore is missing, misspelled,
 * or attached to the wrong selector.
 */
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function stubNode(tagName) {
  const node = {
    tagName, className: '', textContent: '', children: [], parent: null, _listeners: {},
    _html: '',
    set innerHTML(html) {
      node._html = html;
      node.children = parseChildren(html);
      for (const c of node.children) c.parent = node;
    },
    get innerHTML() { return node._html; },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    remove() {
      const p = node.parent;
      if (p) { p.children = p.children.filter((c) => c !== node); node.parent = null; }
    },
    addEventListener(type, cb) {
      (node._listeners[type] ||= []).push(cb);
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const walk = (n) => {
        for (const c of n.children) {
          if (c.className.split(/\s+/).includes(cls)) return c;
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(node);
    },
  };
  return node;
}

/** Minimal HTML parser: enough for the two elements GpuNotice builds. */
function parseChildren(html) {
  const out = [];
  const re = /<(div|button|p|span)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, attrs] = m;
    const classMatch = /class="([^"]*)"/.exec(attrs);
    const n = stubNode(tag);
    n.className = classMatch ? classMatch[1] : '';
    out.push(n);
  }
  return out;
}

globalThis.document = {
  head: stubNode('head'),
  body: stubNode('body'),
  createElement: (tag) => stubNode(tag),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { maybeShowGpuNotice } = await import('../src/ui/GpuNotice.js');

/** Parse the installed `<style>` text into {selector: {prop: value}}. */
function parseCss(css) {
  const rules = {};
  const re = /([^{}]+)\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    const decls = {};
    for (const part of m[2].split(';')) {
      const [prop, ...rest] = part.split(':');
      if (!prop || !rest.length) continue;
      decls[prop.trim()] = rest.join(':').trim();
    }
    for (const sel of selectors) {
      rules[sel] = { ...(rules[sel] || {}), ...decls };
    }
  }
  return rules;
}

console.log('\n-- the notice is built and its style rules resolved');
{
  const el = maybeShowGpuNotice({ integrated: true, name: 'Intel UHD 630' });
  ok(el !== null, 'shows for integrated graphics');
  ok(document.head.children.length === 1, 'installs one <style> element');

  const css = document.head.children[0].textContent;
  const rules = parseCss(css);

  ok(rules['.gpu-notice']?.['pointer-events'] === 'none',
    'the container subtree is click-transparent (pointer-events:none)');
  ok(rules['.gpu-notice__x']?.['pointer-events'] === 'auto',
    'the dismiss button explicitly restores pointer-events so it stays clickable');

  const dismiss = el.querySelector('.gpu-notice__x');
  ok(dismiss !== null, 'the dismiss button exists in the built DOM');
  ok((dismiss._listeners.click || []).length === 1, 'the dismiss button has its click listener attached');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
