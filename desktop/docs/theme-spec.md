---
name: Theme & Appearance System
version: 2.0
created: 2026-04-02
updated: 2026-07-22
---

# Theme & Appearance System

> **The colour/token half of this spec was deleted on 2026-07-22.** It documented
> a pre-engine workflow that no longer exists — hand-written `[data-theme]` CSS
> blocks, a `ThemeName` union, a `DARK_THEMES` array — plus the wrong product
> name ("DestinCode") and the wrong localStorage key (`destincode-theme`; the
> real key is `youcoded-theme`). Following it would have produced a theme the
> engine never loads.
>
> The mascot-rig sections below were re-verified against code on the same date
> and are kept: every file and type they cite still exists.

## Where the theming system is actually defined

There is no prose spec for the token system, by design — the code is the spec and
these are its entry points:

| What | Where |
|---|---|
| Token computation, overlay/derived tokens (`--scrim`, `--destructive`, `--on-destructive`, `--code`, `--link`) | `src/renderer/themes/theme-engine.ts` |
| Active theme, cycle list, font, persistence, `data-theme` on `<html>` | `src/renderer/state/theme-context.tsx` |
| Manifest shape a theme pack must satisfy | `src/renderer/themes/theme-types.ts` |
| The user's global Look (layout, glass, bubble shape, message box, roundness) laid over whichever theme is active; absent field = the theme's own. A theme ships ONE set of these; there are no per-theme user tweaks (retired 2026-09-24) | `src/renderer/themes/look-overrides.ts` (UI: `components/appearance/LookSettings.tsx`) |
| Validation + non-fatal `custom_css` lint | `src/renderer/themes/theme-validator.ts` |
| Built-in theme values (the four packs) | `src/renderer/themes/builtin/*.json` |
| Anti-FOUC duplicate of those values | the `[data-theme]` blocks in `src/renderer/styles/globals.css` |

**The JSON and the CSS must move together.** They are two sources for the same
values (the CSS block exists only to paint before React mounts) and they have
drifted and shipped before. `tests/theme-builtin-sources.test.ts` pins them to
each other and fails if only one side moves.

**Contrast rules are not defined here either.** The canonical table lives in the
theme-builder skill (`wecoded-marketplace/.../theme-builder/scripts/contrast-rules.js`)
and is vendored into this repo at `scripts/vendor/contrast-rules.js`. Do not edit
the vendored copy by hand. Audit every theme with:

```bash
node scripts/audit-theme-contrast.mjs
```

## Chrome styles (`layout.chrome-style`)

A theme picks how the app's chrome sits around the chat. The user can override the
pick for every theme (Settings → Appearance → Layout; `look-overrides.ts`).

| Value | Picker name | What it does | Where it lives |
|---|---|---|---|
| `default` (or absent) | Framed | Header, frame edges and the bottom bars are one continuous surface with the chat cut out of it. | `.chrome-glass` in `globals.css` |
| `floating` | Floating bars | The three bars become detached rounded cards; the controls inside them stay flat. | `[data-chrome-style='floating']` rules in `globals.css`; frost in `theme-engine.ts` |
| `float` | Minimalist | No bars at all: every control (header buttons, session switcher, quick chips, message box, status chips) wears its own light frosted surface over the wallpaper, and messages fade out beneath them. | `styles/float-chrome.css`; frost in `theme-engine.ts` (`FLOAT_CHROME_GLASS`) |

- **Every rule is gated on `[data-chrome-style='<value>']`** on `<body>`, so a style
  never touches themes that do not pick it (`tests/float-chrome-pops.test.ts`).
- **Blur only through the theme engine's glass sheet**, which is written only with a
  wallpaper/gradient, Reduced effects off and panel blur above zero — so both user
  settings turn a style's frost off.
- **`float` without a wallpaper** still floats every control; they are simply not see-through.
- The theme builder offers all three (Kit → Chrome & Layout: Classic, Floating,
  Minimalist; plus Minimal, which is `default` with slimmer header/input/status styles).
  Its mockup mirrors these rules in `theme-preview.css`, guarded by `sync-check.cjs`.

## Adding a theme or a token

Add a theme: drop a JSON pack in `src/renderer/themes/builtin/`, mirror its
tokens into a `[data-theme]` block in `globals.css`, and run the audit above —
`theme-builtin-sources.test.ts` enforces the mirror.

Add a token: add it to `theme-types.ts`, emit it from `theme-engine.ts`, and give
it a contrast rule in the canonical rules file if it is a text or surface colour.
A token with no rule is a token that silently regresses.

## Mascot rig (preferred mascot format)

A theme may ship `mascot.rig`: a single SVG whose named groups the app animates.
Flat variants (`idle`/`shocked`/`welcome`) remain supported as the legacy tier
(no limb trailing, no blink, no peek hands, no companions).

**The full authoring contract, six approved skins, example rigs, and drop-in
components live in the wecoded-themes repo: `mascots/README.md`.** Summary:

- `viewBox="-3 -5 30 30"` (24x24 art box + hat/item padding). Group ids:
  `rig-root`, `rig-body` (required), `rig-arm-left/right`, `rig-leg-left/right`,
  `rig-tail`, six faces (`rig-face-idle/welcome/curious/shocked/dizzy/blink`),
  slots (`slot-hat`/`slot-eyewear`/`slot-item`), `rig-hand-peek-right/left`
  (grip mittens for the side-edge peek, `display:none` — the app clones + pins
  them at the screen edge).
- Draw limbs HANGING DOWN from their `data-pivot="x y"` hinge (viewBox coords;
  default: top-center of the group's bbox). Canonical capsule pivots: arms
  (2.5 9)/(21.5 9), legs (8.95 17)/(15.05 17), tail (19 14).
- Faces are PAINT on a solid body, not evenodd cutouts — face groups must be
  swappable. All but `rig-face-idle` start `style="display:none"`. The curious
  face wraps its sparkle pupils in `<g class="pupil">` for cursor tracking.
- Tint via `var(--rig-accent)` / `var(--rig-on-accent)` / `var(--rig-line)`
  (always with fallbacks) — NOT `currentColor`, which renders black in the
  legacy `<img>` path. Hardcoded identity colors are fine.
- Don't bake static scenery into the rig — flourishes ship as scene companions
  (below).
- Groups may embed raster art via `<image href="data:image/...">` — painted
  mascots can be rigged by slicing.
- SECURITY: rigs are sanitized at load (`sanitize-rig-svg.ts`) — scripts,
  foreignObject, `<style>`, SMIL animation tags, `on*` attributes, and external
  URLs are stripped. Only `#refs` and `data:image/*` URLs survive.
- Poses, springs, motion styles, blinking, and peek staging are app-defined in
  `src/renderer/components/mascot/mascot-poses.ts` — new behaviors ship in app
  updates and apply to every conforming rig with no re-authoring.
- Reference implementation: `src/renderer/components/mascot/default-buddy-rig.ts`
  (the 2.5D-soft capsule) + the reference rigs in wecoded-themes `mascots/skins/`.

### Scene companions

A theme may declare a TOP-LEVEL `companions` manifest array (deliberately NOT
inside `mascot` — app versions that predate companions ignore unknown top-level
keys, but a non-string value inside `mascot` crashes their asset resolver):

```json
"companions": [
  { "asset": "assets/companions/sun.svg", "size": 0.435, "dx": -0.6, "dy": -0.452,
    "stiffness": 65, "damping": 9, "float": 0.026, "floatMs": 2600 }
]
```

All lengths are fractions of the mascot's rendered size (`size` width, optional
`height`, `dx`/`dy` center offset, `float` bob amplitude / `floatMs` period);
`stiffness`/`damping` tune the buddy-floater follow spring; `"ghost": true`
marks a lag-distance after-image. Companion SVGs go through the same sanitizer
as rigs; the app animates the class names `comp-twinkle` / `comp-spin` /
`comp-pulse` / `comp-bob` (keyframes in `styles/mascot.css`). Today companions
render on the welcome screen (`MascotScene`, static tier with CSS bob); the
buddy floater's spring-follow tier is pending its window-padding redesign.
Type: `MascotCompanion` in `src/renderer/themes/theme-types.ts`.
