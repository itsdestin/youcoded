---
name: Theme & Appearance System
version: 1.0
created: 2026-04-02
---

# Theme & Appearance System Spec

## Overview

DestinCode uses a semantic CSS token system for theming. Colors are CSS custom properties defined per-theme and toggled via a `data-theme` attribute on `<html>`. Font is a separate user preference applied via `--font-sans`/`--font-mono` CSS variables.

## User Mandates

1. **Status colors are theme-independent.** Green (#4CAF50), red (#DD4444), amber (#FF9800), blue, and orange are fixed across all themes. They represent semantic states (success, error, warning), not UI chrome.
2. **Default theme is Light.** New users see Light on first launch.
3. **All installed system fonts are available**, not just monospace. The app is a chat interface for general users, not a code editor.

## Architecture

### CSS Layer

**File:** `src/renderer/styles/globals.css`

Each theme is a `[data-theme="name"]` selector block defining the same set of CSS custom properties:

```
--canvas, --panel, --inset, --well        (surfaces)
--accent, --on-accent                     (active elements)
--fg, --fg-2, --fg-dim, --fg-muted, --fg-faint  (text hierarchy)
--edge, --edge-dim                        (borders)
--scrollbar-thumb, --scrollbar-hover      (scrollbars)
--hl-theme                                (light|dark — controls highlight.js)
```

The `@theme` block maps these to Tailwind utility classes:
- `--color-canvas: var(--canvas)` → enables `bg-canvas`, `text-canvas`, etc.
- Same pattern for all tokens

**Design decision:** Semantic token names (`canvas`, `panel`, `inset`) rather than color-based names (`gray-900`) so any theme can provide different values without the names becoming misleading. Rationale: a "Solarized" theme mapping `--canvas` to `#FDF6E3` reads naturally, while `--gray-950: #FDF6E3` would be confusing.

**Design decision:** `data-theme` attribute rather than `.dark`/`.light` classes. Rationale: mutually exclusive by definition (one attribute vs managing multiple classes), and scales cleanly to N themes.

### React Layer

**File:** `src/renderer/state/theme-context.tsx`

`ThemeProvider` wraps the app and manages:
- `theme: ThemeName` — active theme
- `cycleList: ThemeName[]` — which themes the status bar pill cycles through
- `font: string` — CSS font-family string

State changes trigger:
1. `data-theme` attribute update on `<html>`
2. highlight.js `<style>` element content swap (github-dark.css vs github.css, imported via Vite `?inline`)
3. `--font-sans`/`--font-mono` CSS variable updates

All values persist to `localStorage` under `destincode-theme`, `destincode-theme-cycle`, `destincode-font`.

**Design decision:** highlight.js uses Vite `?inline` imports to get raw CSS strings, managed via a single `<style id="hljs-theme">` element. Rationale: normal CSS imports are side-effects that can't be unloaded. Inline strings let us swap content without DOM accumulation.

### Anti-FOUC

**File:** `src/renderer/index.tsx`

Theme and font are applied synchronously before `createRoot()` to prevent a flash of default styling on page load.

### xterm.js Integration

**File:** `src/renderer/components/TerminalView.tsx`

Terminal reads `--canvas` and `--fg` CSS computed values for its theme. A `useEffect` on `theme` and `font` updates `terminal.options.theme` and `terminal.options.fontFamily` reactively, with a re-fit after font changes (different glyph widths).

### Font Selection

**File:** `src/renderer/components/SettingsPanel.tsx`

Uses the Local Font Access API (`queryLocalFonts()`) to enumerate all installed system fonts. Falls back to a curated list of 20 common fonts when unavailable (remote browser mode). Fonts are displayed in a searchable list where each name is rendered in its own typeface.

## Current Themes

| Theme | Canvas | Panel | Inset | Accent | Text | Character |
|-------|--------|-------|-------|--------|------|-----------|
| Light | #F2F2F2 | #EAEAEA | #E0E0E0 | #1A1A1A | #1A1A1A | Neutral gray, softened white |
| Dark | #111111 | #191919 | #222222 | #D4D4D4 | #E0E0E0 | Pure neutral, no blue tint |
| Midnight | #0D1117 | #161B22 | #21262D | #B1BAC4 | #C9D1D9 | Deep navy, GitHub-inspired |
| Creme | #F0E6D6 | #EBE1D1 | #DDD1BE | #3D3229 | #2C2418 | Warm parchment |

## How To: Add a New Theme

1. Add a `[data-theme="name"]` block in `globals.css` with all variables
2. Add the name to the `ThemeName` type union and `THEMES` array in `theme-context.tsx`
3. Add label, description, and swatch hex values to `THEME_LABELS`, `THEME_DESCRIPTIONS`, and `THEME_SWATCHES` in `SettingsPanel.tsx`
4. If the theme is dark (light text on dark bg), add it to the `DARK_THEMES` array in `theme-context.tsx` so highlight.js uses the dark stylesheet

## How To: Add a New Token

1. Add the CSS variable to every `[data-theme]` block in `globals.css`
2. Add the Tailwind mapping in `@theme`: `--color-token-name: var(--token-name)`
3. Use `bg-token-name`, `text-token-name`, or `border-token-name` in components
4. For inline styles: `var(--token-name)`

## Future: Roundness Slider

The border-radius system is ready for dynamic control. Adding `--radius-*` overrides to `@theme` would make all existing `rounded-*` Tailwind classes dynamic without any component changes. Implementation: ~40 lines (CSS variables + slider + localStorage).

## Change Log

- **1.0** (2026-04-02) — Initial spec. 4 themes, semantic CSS tokens, font selection, cycle configuration.
