# Pause run summary + starting equipment choice — design

Date: 2026-08-09. Approved by user in session (option "Yes, build both").

## 1. Run summary in the pause menu

The pause screen (`Menus.js`, `screen--pause`) grows a run-summary block under
the existing button list:

- **Stats panel** — the survivor's *effective* stats, read from `ctx.player.stats`
  (the Items pipeline output, so items/buffs/artifacts are included): max health,
  health regen, damage, attack speed, crit chance, armor, move speed, cooldown
  rate. Rendered with the same `sbar` row markup the survivor-select "Base
  stats" panel uses, so the two read as the same product.
- **Inventory panel** — `ctx.items.inventory()` rendered as tier-coloured tiles
  with the same art the HUD strip uses (`itemArt`), stack count badges, plus the
  held equipment (`ctx.items.equipment`, `equipmentArt`) as the first tile.
- **Tooltips** — Menus owns its own `Tooltip` instance (parented to the overlay
  root; the HUD's tooltip lives inside `#hud`, which is hidden behind the
  overlay). Mouse-over a tile shows the standard hover card via
  `tooltip.show(el, id, tier, count)`; `cardDef` already covers items and
  equipment.
- The summary is rebuilt each time the pause screen opens — no per-frame work.

## 2. Starting equipment choice

- The survivor-select footer gets a third chip, **Equipment**, next to
  Difficulty and Artifacts, showing the current pick ("Random" by default).
- It opens a new `screen--equipment` pre-run screen: a grid of all equipment
  cards (art, name, cooldown) plus a **Random** card. Clicking selects; Back
  pops to select. Selection is held on `Menus.equipmentId` (null = random).
- `launch()` copies the pick to `ctx.startEquipmentId`.
- `Items`' `stageStart` seeding (`Items.js` ~207) becomes:
  `if (!this.equipmentId) this.setEquipment(this.ctx.startEquipmentId || this.rollEquipment())`.
  Only an empty slot seeds, so barrel swaps mid-run are untouched, and co-op
  clients are untouched (`setEquipment` is host-gated already).

## Testing

- New headless test: with `ctx.startEquipmentId` set, `stageStart` equips that
  id; without it, the slot still seeds randomly (control arm).
- UI verified in the running app.
