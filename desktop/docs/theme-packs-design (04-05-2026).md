---
name: Theme Packs — Immersive Theming System
version: 1.0
created: 2026-04-05
status: approved
supersedes: theme-builder-design (04-05-2026).md
---

# Theme Packs Design — Immersive Theming System

Evolves the theme builder from a palette swapper into a full visual identity system. Themes become self-contained "packs" — folders with manifests, downloaded imagery, Claude-generated SVGs, and custom CSS. The `/theme-builder` skill becomes a brand designer that creates themes capturing the user's actual vision.

---

## User Mandates

1. **Existing 4 built-in themes (Light, Dark, Midnight, Creme) must be preserved** and continue to work exactly as today. They do not need to migrate to the folder format.
2. **Status colors (green, red, amber) are never themeable.** They are semantic, not cosmetic.
3. **The manual editor must stay simple.** Accent, roundness, particles, font. Full palette editing is Claude's job.
4. **The concept browser phase must never touch the running app.** App changes only happen after explicit user approval in chat.
5. **User-created themes must survive app updates** — stored outside the app bundle in `~/.claude/destinclaude-themes/`.
6. **Two rounds of 3, always.** The skill presents 3 concepts, then 3 refined variations after the user picks — even if they don't explicitly ask for another round.
7. **Brand fidelity over generic approximation.** When a theme references a recognizable IP/brand, source real imagery. "Hello Kitty" means Kitty's actual bow, not a generic ribbon.

---

## Architecture Overview

```
/theme-builder skill
    │
    ├─ Phase 1: Concept browser (localhost HTML, no app changes)
    │       ├─ Round 1: 3 distinct interpretations as realistic app mockup cards
    │       └─ Round 2: 3 refined variations of chosen direction (always)
    │
    └─ Phase 2: Theme pack generation (on user approval)
            ├─ Claude creates theme folder with manifest + assets
            │   ├─ Downloads real imagery for brand/IP prompts
            │   ├─ Generates original SVGs for vibe/abstract prompts
            │   └─ Writes manifest.json with full theme definition
            └─ ThemeEngine watches directory → hot-reloads app

Settings Panel (ThemeScreen)
    └─ Grid of all themes + simple editor for active theme (unchanged)
```

---

## Theme Pack Format

### Directory Structure

```
~/.claude/destinclaude-themes/
  hello-kitty/
    manifest.json          # Theme definition (evolved from current single-file JSON)
    assets/
      wallpaper.png        # Downloaded hero image
      bow-pattern.svg      # Claude-generated or sourced repeating pattern
      heart.svg            # Custom particle shape
      icon-send.svg        # Themed icon override
      cursor.svg           # Custom cursor (optional)
    preview.png            # Auto-generated thumbnail for the theme grid
```

### manifest.json Schema

```jsonc
{
  // === Required (same as current) ===
  "name": "Hello Kitty Classic",
  "slug": "hello-kitty-classic",
  "dark": false,
  "author": "claude",
  "created": "2026-04-05",

  // === Color Tokens (same 15 as current) ===
  "tokens": {
    "canvas": "#FFF0F5",
    "panel": "#FFD4E8",
    "inset": "#FFC0D8",
    "well": "#FFF5F8",
    "accent": "#E75480",
    "on-accent": "#FFFFFF",
    "fg": "#9E3A5C",
    "fg-2": "#B05070",
    "fg-dim": "#C07088",
    "fg-muted": "#D8A0B0",
    "fg-faint": "#E8C8D4",
    "edge": "#F0B0C8",
    "edge-dim": "#F0B0C880",
    "scrollbar-thumb": "#E8A0B8",
    "scrollbar-hover": "#D88098"
  },

  // === Shape (same as current) ===
  "shape": {
    "radius-sm": "8px",
    "radius-md": "16px",
    "radius-lg": "24px",
    "radius-full": "9999px"
  },

  // === Background (expanded) ===
  "background": {
    "type": "image",                              // "solid" | "gradient" | "image"
    "value": "assets/wallpaper.png",              // NOW: relative path to theme folder
    "opacity": 0.85,
    "panels-blur": 12,                            // glassmorphism blur (px)
    "panels-opacity": 0.75,                       // panel transparency
    "pattern": "assets/bow-pattern.svg",          // NEW: repeating pattern overlay
    "pattern-opacity": 0.06                       // NEW: pattern opacity (subtle)
  },

  // === Layout (same as current) ===
  "layout": {
    "input-style": "floating",
    "bubble-style": "pill",
    "header-style": "default",
    "statusbar-style": "default"
  },

  // === Effects (expanded) ===
  "effects": {
    "particles": "custom",                        // existing presets + NEW "custom"
    "particle-shape": "assets/heart.svg",         // NEW: SVG shape for custom particles
    "particle-count": 40,                         // NEW: tunable count
    "particle-speed": 1.0,                        // NEW: speed multiplier
    "particle-drift": 0.5,                        // NEW: horizontal drift
    "particle-size-range": [8, 16],               // NEW: min/max size in px
    "scan-lines": false,
    "vignette": 0,
    "noise": 0
  },

  // === NEW: Icon Overrides ===
  "icons": {
    "send": "assets/icon-send.svg"
    // Supported slots: send, new-chat, settings, theme-cycle, close, menu
  },

  // === NEW: Custom Cursor ===
  "cursor": "assets/cursor.svg",

  // === NEW: Scrollbar Theming ===
  "scrollbar": {
    "thumb-image": "assets/scrollbar-thumb.svg",  // optional SVG for scrollbar thumb
    "track-color": "transparent"
  },

  // === NEW: Mascot Overrides ===
  "mascot": {
    "idle": "assets/mascot-idle.svg",              // replaces AppIcon (initializing + trust gate)
    "welcome": "assets/mascot-welcome.svg",        // replaces WelcomeAppIcon (no session screen)
    "inquisitive": "assets/mascot-inquisitive.svg" // replaces InquisitiveAppIcon
  },

  // === Custom CSS (existing, but skill uses it more aggressively) ===
  "custom_css": "::selection { background: rgba(231,84,128,0.3); }"
}
```

### Asset Path Resolution

- All paths in the manifest are relative to the theme folder
- The main process registers a custom Electron protocol (`theme-asset://`) that resolves `theme-asset://<slug>/assets/wallpaper.png` to the absolute file path on disk. This avoids `file://` CSP issues in the renderer
- No absolute paths or external URLs allowed in saved manifests — all assets must be local
- Claude downloads external images at theme creation time, saves to `assets/`

### Preview Thumbnail

- `preview.png` is auto-generated by the skill at theme creation time
- It's a screenshot of the concept card from the visual companion, or a simple color-swatch composite
- Used in the ThemeScreen grid for visual theme selection
- If missing, the grid falls back to the current gradient preview (canvas → accent)

---

## Skill Behavior: Claude as Theme Designer

### Prompt Interpretation Modes

Claude determines the mode automatically based on the prompt:

**Brand/IP Mode** — Triggered by recognizable characters, brands, franchises, or products.
- Research-first: web search for authentic imagery, official color palettes, recognizable iconography
- Source real assets (wallpapers, character art, official patterns) and download to `assets/`
- Claude-generated SVGs for supporting elements only (patterns, particles, decorative touches)
- Brand fidelity is paramount: Kitty's actual bow shape, not a generic ribbon

**Vibe/Abstract Mode** — Triggered by aesthetic descriptions, moods, settings, or abstract concepts.
- Creative-first: Claude designs original visual identities
- Claude generates all SVGs, picks complementary wallpapers from stock/creative-commons
- Freedom to be inventive with color stories, effects, and atmospheric touches
- Examples: "cozy autumn", "deep ocean", "cyberpunk hacker", "cottagecore", "lo-fi"

### Two-Round Concept Flow

**Round 1 — Three Distinct Interpretations:**
Claude presents 3 concepts that interpret the prompt differently. Not 3 slight variations — 3 genuinely different takes. Each rendered as a realistic app mockup card in the concept browser showing:
- Mini DestinCode mockup (header + chat bubbles + input bar) using the theme's actual colors, styles, and background
- Color palette strip (key tokens as swatches)
- Asset preview list (what Claude plans to download/generate)
- Vibe tags (layout style, effects, atmosphere keywords)

**Round 2 — Three Refinements (always, even unprompted):**
After the user picks a direction, Claude automatically presents 3 variations:
1. The chosen concept fully polished — final colors, all effects dialed in
2. Dialed up — bolder, more atmospheric, more immersive
3. Dialed down — subtler, daily-driver friendly, fewer effects

**Then Build** — User picks, Claude generates the full theme pack.

### Asset Generation Strategy

| Asset Type | Brand/IP Source | Vibe/Abstract Source |
|---|---|---|
| Hero wallpaper | Web search → download real imagery | Web search (Unsplash/stock) or gradient |
| Repeating patterns | Traced from real brand elements or web-sourced | Claude-generated SVG |
| Custom particle shapes | Sourced or simplified from brand iconography | Claude-generated SVG |
| Icon overrides | Simplified from brand imagery | Claude-generated outlined SVG |
| Scrollbar art | CSS + optional SVG | CSS + optional SVG |
| Mascot crossovers | Modify base SVG with brand-accurate accessories | Modify base SVG with creative thematic accessories |

---

## Renderer Changes

### Theme Loader (theme-context.tsx)

- Scan `~/.claude/destinclaude-themes/` for **directories** (not bare JSON files)
- Read `manifest.json` from each directory
- Resolve relative asset paths to absolute file paths
- Built-in themes continue loading from app bundle as-is (no folder format needed)

### Theme Watcher (theme-watcher.ts)

- Watch theme directories recursively (manifest AND asset changes trigger reload)
- Debounce per theme folder, not per file
- Handle directory creation (new theme installed) and deletion (theme removed)

### Migration (one-time, on first load)

- Scan for bare `.json` files in the themes directory
- For each: create `<slug>/` folder, move JSON inside as `manifest.json`
- Transparent — existing themes work without user action

### Background Layer

- Support `pattern` field: render as a repeating `background-image` layer between the wallpaper and panels
- Resolve `image` and `pattern` `value` fields via `theme-asset://` custom protocol
- Pattern layer respects `pattern-opacity` as a separate opacity from the background

### Particle Renderer (ThemeEffects.tsx)

- Add `"custom"` particle preset
- Load SVG from `particle-shape` path, render to offscreen `Image` once
- Draw via `ctx.drawImage()` per particle (not re-parsing SVG per frame)
- Expose `particle-count`, `particle-speed`, `particle-drift`, `particle-size-range`
- Existing presets (rain, dust, ember, snow) continue to work unchanged

### Icon Override System (new)

- Define icon slot registry: `send`, `new-chat`, `settings`, `theme-cycle`, `close`, `menu`
- `useThemeIcon(slotName)` hook returns override SVG path or `null`
- Components check for override before rendering default icon
- SVG icons loaded via `<img>` tag with `theme-asset://` protocol src (keeps it simple, avoids SVG injection concerns)

### Mascot Override System (new)

- Three mascot slots: `idle` (initializing + trust gate), `welcome` (no-session screen), `inquisitive` (unused currently but available)
- `useThemeMascot(variant)` hook returns override SVG path or `null`
- `AppIcon`, `WelcomeAppIcon`, `InquisitiveAppIcon` check for mascot override — if present, render as `<img>` with `theme-asset://` src; otherwise render the default inline SVG
- The base mascot SVG paths are included in the skill instructions as a reference template for Claude to modify
- **Key constraint:** Themed mascots must preserve the core silhouette (squat body, nub arms, stubby legs, cutout eyes) while adding thematic accessories, proportional tweaks, and themed details. The character must be recognizably the same mascot in a crossover costume, not a completely different character

### Custom CSS (existing, expanded usage)

No renderer changes needed — `custom_css` injection already works. The skill should use it for:
- `::selection` colors
- `::-webkit-scrollbar-thumb` with SVG backgrounds
- `cursor: url(...)` for custom cursors
- Subtle `box-shadow` / `text-shadow` glows on accent elements
- Animated gradient borders on input bar
- Themed focus ring styles

---

## What Does NOT Change

- **15 color token system** — works great, no changes
- **Shape/radius system** — no changes
- **4 layout presets** (input/bubble/header/statusbar) — no changes
- **Built-in themes** — stay as JSON in app bundle, no migration
- **ThemeScreen manual editor** — stays simple (accent, roundness, particles, font)
- **Theme cycling** — works the same, reads from folders now
- **Hot-reload IPC mechanism** — same channel, watcher just watches directories
- **Highlight.js theme switching** — driven by `dark` boolean, unchanged

---

## Rollout Order

1. **Folder format + migrated loader/watcher** — Foundation everything depends on
2. **Asset resolution in renderer** — Background images and patterns from local paths
3. **Custom particle renderer** — SVG-based particles via `drawImage`
4. **Icon override system** — `useThemeIcon` hook + slot registry
5. **Mascot override system** — `useThemeMascot` hook + themed mascot rendering in AppIcon/WelcomeAppIcon/InquisitiveAppIcon
6. **Updated `/theme-builder` skill** — Two-round flow, web search, SVG generation, mascot crossovers, folder output
7. **Concept browser upgrade** — Realistic app mockup cards

Steps 1-5 are renderer infrastructure. Steps 6-7 are the skill layer.
