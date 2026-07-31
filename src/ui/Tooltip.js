// Item tooltip — the RoR2 hover card: name in tier colour, tier label,
// stat line with the live stack count substituted, flavour text in italics.
//
// Lives inside #hud so it inherits `pointer-events: none`; it is positioned
// with a transform only, so showing it never triggers layout on the HUD tree.

import { ITEM_BY_ID } from '../data/items.js';
import { tierMeta } from './Icons.js';

export class Tooltip {
  constructor(ctx, parent) {
    this.ctx = ctx;
    this.el = document.createElement('div');
    this.el.className = 'tip';
    this.el.innerHTML = `
      <div class="tip-head">
        <div class="tip-name"></div>
        <div class="tip-tier"></div>
      </div>
      <div class="tip-body"></div>
      <div class="tip-flavour"></div>`;
    parent.appendChild(this.el);
    this.refs = {
      name: this.el.querySelector('.tip-name'),
      tier: this.el.querySelector('.tip-tier'),
      body: this.el.querySelector('.tip-body'),
      flavour: this.el.querySelector('.tip-flavour'),
    };
    this.current = null;
  }

  /** The item catalogue is a single source of truth — read it directly. */
  def(id) {
    return ITEM_BY_ID.get(id) ?? null;
  }

  show(anchor, id, tier, count) {
    const key = `${id}:${count}`;
    if (this.current !== key) {
      this.current = key;
      const def = this.def(id);
      const meta = tierMeta(def?.tier || tier);
      const name = def?.name || prettify(id);

      this.refs.name.textContent = name;
      this.refs.name.style.color = meta.color;
      this.refs.tier.textContent = meta.label;
      this.refs.tier.style.color = meta.color;
      this.refs.body.innerHTML = describe(def, count);
      const flavour = def?.flavour ?? '';
      this.refs.flavour.textContent = flavour ? `"${flavour}"` : '';
      this.refs.flavour.hidden = !flavour;
      this.el.style.setProperty('--tier', meta.color);
    }
    this.place(anchor);
    this.el.classList.add('is-open');
  }

  place(anchor) {
    const a = anchor.getBoundingClientRect();
    const w = this.el.offsetWidth || 300;
    const h = this.el.offsetHeight || 120;
    let x = a.left + a.width / 2 - w / 2;
    let y = a.bottom + 12;
    x = Math.max(12, Math.min(x, innerWidth - w - 12));
    if (y + h > innerHeight - 12) y = a.top - h - 12;
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  hide() {
    this.el.classList.remove('is-open');
    this.current = null;
  }
}

export function prettify(id) {
  return String(id).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** `description` is a function of the stack count — see src/data/items.js. */
export function describeItem(def, count) {
  const n = Math.max(1, count | 0);
  if (typeof def?.description !== 'function') return '';
  try { return String(def.description(n)); } catch { return ''; }
}

/** Same copy, with the numbers picked out in the accent the way RoR2 does. */
function describe(def, count) {
  const n = Math.max(1, count | 0);
  const text = describeItem(def, count);
  if (!text) return `Stack count <b>${n}</b>.`;
  return escapeHtml(text).replace(/(\d+(?:\.\d+)?%?)/g, '<b>$1</b>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
