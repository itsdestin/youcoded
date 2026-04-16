# Landing Page Mockup Redesign — 16:10 Stacked Frames

**Status:** Design approved, ready for implementation plan
**Scope:** `youcoded/docs/index.html` — `#demo` section only
**Date:** 2026-04-16

## Problem

The five mockups in the `#demo` showcase (one animated `.demo-app` + four static `.mock-frame`) render with inconsistent aspect ratios and clip content.

Root causes, all in `youcoded/docs/index.html`:

1. **Fixed pixel height on responsive width.** `.demo-app` (line 830) and `.mock-frame` (line 867) both use `width: 100%; max-width: 680px; height: 480px`. Width scales with viewport; height does not. Result: aspect ratio drifts from ~0.9:1 (tall/narrow) at ~1280px desktop to ~1.42:1 (widescreen-ish) when the 2-column grid collapses to single-column at 768px.
2. **Content exceeds usable chat area.** Usable chat height at 480px frame is `480 − 40 header − ~56 input − ~32 status ≈ 352px`. Journaling (4 bubbles + 3 tool cards) and Sync (2 tool cards + 8-line info block) do not fit. `.demo-chat { overflow: hidden }` (line 1119) silently clips the tail.
3. **Cramped bubble spacing.** `.demo-chat` / `.mock-chat` use `gap: 2px` (line 1123). With `align-self` flipping user/assistant left/right, 2px reads as "stuck together."

## Goal

All five mockups render at a **consistent, desktop-like aspect ratio** with **all current content preserved and visible** inside the frame.

## Non-goals

- Redesigning mockup content, copy, or visual styling beyond what's needed to fit.
- Adding device-frame chrome (laptop bezel, traffic lights). Could be a follow-up.
- Changing the animated demo's timing or sequence.
- Changing any section outside `#demo`.

## Design

### Target frame dimensions

**960 × 600 (16:10)**, applied uniformly to `.demo-app` and `.mock-frame`. 16:10 matches YouCoded's own desktop app window shape and provides more vertical room than 16:9 for chat content.

At 960px wide, content budget becomes ~2× the current `.demo-app`:

| | Current | New |
|---|---|---|
| Frame width | ~680px max (often ~500px in 2-col grid) | 960px max |
| Frame height | 480px fixed | 600px (16:10 scaled) |
| Usable chat height | ~352px | ~472px |
| Shape at 1280px viewport | ~0.9:1 tall | 1.6:1 widescreen |

### Layout change

The 2-column `.showcase-item` grid (line 1601) is replaced by a single-column flex layout. Each showcase item renders as:

```
[showcase-label]
[showcase-title]
[showcase-desc]
[mockup — 960×600]
```

Text block constrained to the current reading width (~680px) and aligned consistently across items. The `.showcase-item.reverse` variant (lines 1608–1609) becomes dead code — remove it.

### Frame sizing

`.demo-app` and `.mock-frame` both change from:

```css
width: 100%; max-width: 680px;
height: 480px;
```

…to:

```css
width: 100%; max-width: 960px;
aspect-ratio: 16 / 10;
```

Dropping fixed `height` in favor of `aspect-ratio` keeps the shape constant at any viewport width. Below 960px container width, the frame scales down proportionally instead of becoming a tall-or-wide rectangle.

### Bubble spacing

`.demo-chat` / `.mock-chat`: `gap: 2px` → `gap: 10px`. This is the only spacing change. Bubble padding, border-radius, and fonts stay as-is (they already mirror the real app).

### Content fit verification

Each of the five mockups will be spot-checked in the new 960×600 frame before shipping:

1. **Theme Builder** (animated) — 2 bubbles + 2 sequenced tool cards. Expected: fits comfortably.
2. **WeCoded Marketplace** — filter bar + hero + 2 rails of 4 cards. Expected: fits; rails may need to remain horizontally scrollable (current behavior).
3. **Journaling** — 4 bubbles + 3 tool cards. Expected: fits at new size.
4. **Cross-Device Sync** — 2 tool cards + 8-line info block. Worst case; if it still overflows at 960×600, tighten *this mockup's* internal padding or font-size — not the global CSS.
5. **Connect 4** — 7×6 board + side chat panel. Current game-panel-width rules already sized for 480px height; verify the board + panel still look right at 600px height and 960px width.

Content is preserved verbatim. Per-mockup density tweaks are allowed only if a specific mockup fails the fit check.

### Mobile behavior

`aspect-ratio: 16/10` means at a 400px phone viewport the frame renders at 400×250 — same shape as desktop, just smaller. Content inside will be small on phones (acceptable per the "consistent size across all mockups" priority). Existing `max-width: 100%` prevents overflow.

Remove mobile-specific 2-col → 1-col collapse (lines 1722–1725) since the layout is already single-column on desktop.

## Implementation surface

All changes land in `youcoded/docs/index.html`. Affected CSS blocks:

- `.demo-app` (line 830) — swap `height` for `aspect-ratio`, bump `max-width`.
- `.mock-frame` (line 867) — same.
- `.demo-chat` / `.mock-chat` (line 1113) — bump `gap`.
- `.showcase-item` (line 1601) — replace grid with flex column.
- `.showcase-item.reverse` (lines 1608–1609) — delete.
- `@media (max-width: 768px) .showcase-item` (lines 1722–1725) — delete (now unnecessary).
- Per-mockup tweaks (Sync, Connect 4 if needed) — scoped to the mockup's specific class.

No HTML changes unless a specific mockup needs a minor restructure to fit. No JS changes. No changes outside `#demo`.

## Risks & mitigations

- **Risk:** A mockup overflows at 960×600 despite the larger budget.
  **Mitigation:** Scoped per-mockup CSS tightening. Content stays; only density adjusts.
- **Risk:** Stacking full-width makes the page feel longer and less visually dynamic than the alternating side-by-side rhythm.
  **Mitigation:** Accepted tradeoff. The page's visual interest now comes from the mockups themselves being larger and more readable. If this feels flat in implementation, add a small decorative element between items (not in scope for this spec).
- **Risk:** `aspect-ratio` support — not a real concern, all modern browsers support it since 2021.

## Success criteria

1. All 5 mockups render at the same aspect ratio at all viewport widths (desktop, tablet, mobile).
2. No content is clipped in any mockup at any viewport width ≥ 360px.
3. Bubble spacing no longer reads as cramped.
4. Landing page still loads, theme switching still works, animated demo still plays its sequence.
