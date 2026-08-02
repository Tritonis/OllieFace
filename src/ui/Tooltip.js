// Item tooltip — the RoR2 hover card: name in tier colour, tier label,
// stat line with the live stack count substituted, flavour text in italics.
//
// Lives inside #hud so it inherits `pointer-events: none`; it is positioned
// with a transform only, so showing it never triggers layout on the HUD tree.

import { tierMeta, cardDef } from './Icons.js';

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

  /**
   * One lookup across items *and* equipment. Reading `ITEM_BY_ID` alone meant
   * an equipment hovered anywhere rendered as a bare id with no description
   * and no tier colour — `cardDef` is the single-source read that covers both
   * catalogues.
   */
  def(id) {
    return cardDef(id);
  }

  show(anchor, id, tier, count) {
    const key = `${id}:${count}`;
    if (this.current !== key) {
      this.current = key;
      const def = this.def(id);
      const meta = tierMeta(def?.tier || tier);
      const name = def?.name || prettify(id);

      // The corruption tier reads inverted everywhere it is drawn: its tile is a
      // dark glyph punched out of a solid field (`Icons.drawInverted`), and the
      // card that opens off that tile says the same thing in the same way — the
      // name sits *in* the tier colour instead of being written in it. One rule,
      // no extra row, and it lands on the element the eye goes to first.
      const inverted = (def?.tier || tier) === 'blight';
      this.refs.name.textContent = name;
      this.refs.name.style.color = inverted ? '#0b0409' : meta.color;
      this.refs.name.style.background = inverted ? meta.color : '';
      this.refs.name.style.padding = inverted ? '0.1em 0.42em' : '';
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

/**
 * `description` is a function of the stack count — see src/data/items.js.
 *
 * A count of zero is a real state on this path rather than a bad argument: the
 * corruption tier drives a base item's stack to zero and the inventory
 * announces that on the same `itemPickup` channel a pickup uses, so the pickup
 * banner would otherwise describe an item the player has just stopped owning
 * as though they had gained it. Naming what happened is both more honest and
 * the only feedback the transform gets — the tiles themselves cannot say it.
 */
export function describeItem(def, count) {
  if (typeof def?.description !== 'function') return '';
  if ((count | 0) <= 0) return 'Consumed by a corruption in your inventory.';
  try { return String(def.description(count | 0)); } catch { return ''; }
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
