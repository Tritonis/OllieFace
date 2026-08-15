# modelkit-seam — the measured evidence behind the #59 import seam

Issue **#59** / `docs/superpowers/plans/art-detail-and-cohesion-code-fixes.md` Task 4.
Produced by `node tools/kitprobe.mjs`, seed **1337**, renderer **d3d11**, on the tree that
became `d047e58`.

## Why this directory exists

Two **ratified** documents quote numbers measured off these exact pixels:

- `docs/ART-STYLE-GUIDE.md` (rule 3, the ModelKit subsection) — **209**, **195**, **67.0**, **93.8**
- `docs/art/ASSET-SPEC.md` (*Format and budget*) — the same measurement, plus **728** faces,
  **two** swatch cells and **28,896** dropped attribute bytes

Until this commit those documents cited `shots-modelkit/record.json`, a path that existed
only inside a disposable agent worktree and matched two `.gitignore` rules at once
(`shots-*/`, and `reviews/**/*.png` for the crops). A `git worktree prune` would have left
both documents carrying unverifiable figures immediately before the #26/#27 purchase
decision they exist to inform. That is what is fixed here — the numbers were always
correct, they were simply not in the repository.

## What is here, and what is deliberately not

| kept | why |
|---|---|
| `record.json` | The probe's full record: manifest, import report, every crop measurement, and all 18 checks with their pass state. |
| `crop-pair-{seam,authored}.png` | The identical 195x143 crop, 27,885 px, that the **209 / 195 / 67.0 / 93.8** claim is read from. This is the pair the ratified sentence cites. |
| `crop-clean-{seam,authored,handbuilt}.png` | The near-field trio: the seam copy at 211 unique / 67.0 mean, the raw-`GLTFLoader` control at 202 / 133.8, and the hand-built prop beside them at 249 / 81.5. |
| `crop-blight-{seam,authored,handbuilt}.png` | The same trio under one corruption patch. The seam copy moves 67.0 -> 53.6 while the control sits at 133.8 -> 133.7 — the measurement behind "re-shaded by the corruption, not replaced by it". |
| `crop-far-{seam,authored,handbuilt}.png` | The far-field band, where the detail classes retire. |

**Not kept, on purpose:**

- The five full 1600x900 frames (`10-kit-clean.png` through `14-pair-authored.png`, ~10 MB
  together). The crops carry every cited number; the frames carry only context, and
  `reviews/**/*.png` exists precisely to keep megabytes of regenerable capture out of history.
- **Any downloaded asset binary.** `assets/kit/` stays ignored and empty until **#26** closes
  and a pack is actually chosen. The KayKit chest these crops photograph is evidence's
  *subject*, not evidence, and nothing in this directory ships a third-party mesh or atlas.

## Reproducing it

`tools/kitprobe.mjs` needs the model present at `assets/kit/chest.glb`; the fetch command is
in that file's header. Because that download is a manual step gated on #26, these crops are
not regenerable from a clean clone today — which is the specific reason they are committed
rather than left to be re-derived on demand.

## The measurement, in one line

Through one identical crop, discarding the pack's authored atlas and rebinding to `PALETTE`
costs **no** luma spread (**209** unique values against the authored copy's **195**) and
removes a value problem (**67.0** mean against **93.8**). A gradient atlas has no surface
detail to lose. What the rebind *does* lose is the near-field UV map — see
`docs/art/ASSET-SPEC.md`, *Format and budget*.
