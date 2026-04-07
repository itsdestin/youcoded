---
name: DestinCode Theme Builder System
version: 1.0
created: 2026-04-05
status: approved
---

# Theme Builder System Design

Adds a Claude-powered `/theme-builder` skill and an expanded settings panel to DestinCode for creating fully custom, Tier 3 themes — covering colors, shapes, backgrounds, layout, effects, and arbitrary CSS.

---

## User Mandates

1. **The existing 4 built-in themes (Light, Dark, Midnight, Crème) must be preserved** and continue to work exactly as today.
2. **Status colors (green, red, amber) are never themeable.** They are semantic, not cosmetic.
3. **The manual editor must stay simple.** It exposes only the highest-impact controls: accent color, roundness, background type, effects, font. Full palette editing is Claude's job.
4. **The concept browser phase must never touch the running app.** App changes only happen after explicit user approval in chat.
5. **User-created themes must survive app updates** — stored outside the app bundle in `~/.claude/destinclaude-themes/`.

---

## Architecture Overview

```
/theme-builder skill
    │
    ├─ Phase 1: Concept browser (localhost HTML, no app changes)
    │       └─ Claude renders palette cards, user iterates in chat
    │
    └─ Phase 2: Implementation (on user approval)
            ├─ Claude writes theme JSON to ~/.claude/destinclaude-themes/
            └─ ThemeEngine watches directory → hot-reloads app

Settings Panel
    └─ ThemeScreen (new): grid of all themes + simple editor for active theme
```

---

## Theme File Format

**Location:** `~/.claude/destinclaude-themes/<slug>.json`  
**Also:** Built-in themes migrate to `desktop/src/renderer/themes/builtin/<slug>.json` (same format, same loader).

```jsonc
{
  // Required
  "name":   "Tokyo Rain",
  "slug":   "tokyo-rain",          // becomes data-theme="tokyo-rain"
  "dark":   true,                  // controls highlight.js theme selection

  // Optional metadata
  "author": "your-name",
  "created": "2026-04-05",

  // Color tokens (all 15 — required for custom themes, optional for partials)
  "tokens": {
    "canvas":          "#0D0F1A",
    "panel":           "#141726",
    "inset":           "#1F2440",
    "well":            "#0D0F1A",
    "accent":          "#7C6AF7",
    "on-accent":       "#FFFFFF",
    "fg":              "#C4BFFF",
    "fg-2":            "#9090C0",
    "fg-dim":          "#6060A0",
    "fg-muted":        "#404070",
    "fg-faint":        "#282848",
    "edge":            "#2A2F55",
    "edge-dim":        "#2A2F5580",
    "scrollbar-thumb": "#2A2F55",
    "scrollbar-hover": "#3A3F70"
  },

  // Shape — border radius scale
  "shape": {
    "radius-sm":   "4px",     // maps to Tailwind rounded
    "radius-md":   "8px",     // maps to Tailwind rounded-lg
    "radius-lg":   "16px",    // maps to Tailwind rounded-xl
    "radius-full": "9999px"   // pills
  },

  // Background — sits behind all panels
  "background": {
    "type":            "gradient",  // "solid" | "gradient" | "image"
    "value":           "linear-gradient(135deg, #0D0F1A 0%, #1A1F35 60%, #0D1A2A 100%)",
    "opacity":         1,
    "panels-blur":     12,          // px — glassmorphism. 0 = no blur
    "panels-opacity":  0.75         // panel bg transparency over the background layer
  },

  // Layout — named presets for key components
  "layout": {
    "input-style":     "floating",  // "default" | "floating" | "minimal" | "terminal"
    "bubble-style":    "pill",      // "default" | "pill" | "flat" | "bordered"
    "header-style":    "default",   // "default" | "minimal" | "hidden"
    "statusbar-style": "default"    // "default" | "minimal" | "floating"
  },

  // Effects — canvas-layer ambient effects
  "effects": {
    "particles": "rain",   // "none" | "rain" | "dust" | "ember" | "snow"
    "scan-lines": false,
    "vignette":   0.3,     // 0–1 edge darkening
    "noise":      0.04     // 0–1 film grain overlay opacity
  },

  // Escape hatch — arbitrary CSS injected last, after all generated rules
  "custom_css": ""
}
```

### Design Decisions

**Why JSON + CSS escape hatch rather than pure CSS?**  
Structured JSON lets the manual editor render proper controls (color pickers, sliders, dropdowns) for every known field without parsing CSS. The `custom_css` escape hatch gives Claude freedom to generate novel effects that don't fit named fields — paralleling how Tailwind's `extend` escape hatch works.

**Why `~/.claude/destinclaude-themes/` for user themes?**  
App updates replace files in the app bundle. User themes must survive updates. This directory is also where Claude skills naturally write output.

**Why migrate built-in themes to JSON?**  
Unifies the loading pipeline. One `ThemeEngine` handles all themes. Built-in themes remain editable by Claude's skill if the user wants to fork and modify them.

---

## ThemeEngine (App Side)

**File:** `src/renderer/state/theme-engine.ts` (new — replaces `theme-context.tsx` or wraps it)

### Responsibilities

1. **Load themes** — scans `~/.claude/destinclaude-themes/` and built-in JSON files on startup
2. **Watch for changes** — IPC listener for `theme:reload` events from main process (triggered when skill writes a new file)
3. **Apply a theme** — converts JSON → CSS custom properties, injects into `<html>`, handles background layer, effects, and `custom_css`
4. **Expose theme list** — provides all available themes (builtin + user) to the settings panel

### CSS Application Order

```
1. Base token overrides    →  --canvas, --panel, ... (from tokens block)
2. Shape overrides         →  --radius-sm, --radius-md, --radius-lg, --radius-full
3. Background layer        →  ::before on <html> or dedicated <div id="theme-bg">
4. Glassmorphism           →  backdrop-filter on .bg-panel elements (via CSS class)
5. Layout class swap       →  data attributes on <body> (data-input-style="floating")
6. Effects layer           →  <canvas> or <div id="theme-effects"> for particles/vignette
7. custom_css              →  injected into <style id="theme-custom">
```

### Layout Presets

Layout options map to CSS classes/data attributes applied to `<body>`:

| Field | Values | Implementation |
|---|---|---|
| `input-style` | default / floating / minimal / terminal | `data-input-style` on body → CSS targets `[data-input-style="floating"] .input-bar` |
| `bubble-style` | default / pill / flat / bordered | `data-bubble-style` on body |
| `header-style` | default / minimal / hidden | `data-header-style` on body |
| `statusbar-style` | default / minimal / floating | `data-statusbar-style` on body |

Each preset is defined in `globals.css` under its data attribute selector. Adding a new preset requires only a CSS block + adding the option to the schema docs.

### Particle System

A lightweight `<canvas>` overlay (absolute positioned, pointer-events: none, z-index below chat) renders ambient particle effects. Implemented as a `useEffect` hook in a `ThemeEffects` component. Presets: `rain`, `dust`, `ember`, `snow`. Each is ~30 lines of canvas animation code.

---

## `/theme-builder` Skill

**File:** `~/.claude/skills/theme-builder/theme-builder.md`

### Phase 1 — Concept Browser

When the user invokes `/theme-builder <prompt>`:

1. Skill starts a localhost server (reusing the brainstorming visual companion infrastructure at `~/.claude/plugins/.../skills/brainstorming/scripts/`)
2. Claude generates 3 concept cards — each with: name, slug, 4-color swatch row, short vibe description, and a mini UI preview (30px tall mockup showing panel/bubble/input shapes)
3. Renders them as an HTML page at `localhost:<port>`
4. Tells the user the URL and asks them to browse while iterating in chat

**Iteration loop:** User requests changes in chat → Claude re-renders the browser page with updated/added/replaced cards → no app changes. Loop continues until the user says a phrase like "go with ②", "apply tokyo rain", or "build that one".

**Concept cards are lightweight** — just palette + name + description + mini preview. No full CSS generation yet.

### Phase 2 — Full Theme Generation

On user approval:

1. Claude generates the complete theme JSON (all sections of the schema)
2. Writes it to `~/.claude/destinclaude-themes/<slug>.json`
3. The main process detects the new/updated file via `fs.watch` on `~/.claude/destinclaude-themes/` and emits `theme:reload` to the renderer via the existing IPC bridge
4. App's ThemeEngine picks up the new file, applies it, hot-reloads
5. Claude confirms in chat: "Tokyo Rain is live. What would you like to change?"

**Further refinements:** User continues in chat. Claude edits the JSON file directly. Each edit triggers another `theme:reload`. The app is the live preview from this point forward.

### Skill Prompting Strategy

Claude should be briefed with:
- The complete theme JSON schema (so it fills all fields correctly)
- The available layout presets and effect presets (so it doesn't invent unsupported values)
- Examples of good concept card descriptions (vibe-focused, not technical)
- The rule: never write to the app directory or touch built-in themes

---

## Manual Theme Editor (Settings Panel)

Replaces the current `ThemeSelector` popup with a `ThemeScreen` — a dedicated section inside the settings panel.

### ThemeScreen Layout

```
┌─────────────────────────────────────┐
│ Themes                              │
├─────────────────────────────────────┤
│ [grid of theme cards — 2 per row]   │
│  ┌────────┐  ┌────────┐             │
│  │ Light  │  │ Dark   │             │
│  └────────┘  └────────┘             │
│  ┌────────┐  ┌────────┐             │
│  │ Tokyo  │  │ Ember  │  [+ more]  │
│  │ Rain ✓ │  │ Cave   │             │
│  └────────┘  └────────┘             │
├─────────────────────────────────────┤
│ Edit: Tokyo Rain                    │
│                                     │
│ Accent        [● #7C6AF7]           │
│ Roundness     □ ─────●───── ○       │
│ Background    [gradient ▾]          │
│ Particles     [rain ▾]              │
│ Font          [Cascadia Mono ▾]     │
│                                     │
│ Quick Cycle   [✓ Light] [✓ Tokyo]  │
│                                     │
│ [✦ Build new theme with Claude]     │
└─────────────────────────────────────┘
```

### Manual Editor Controls

| Control | What it changes | Implementation |
|---|---|---|
| Accent color picker | `tokens.accent` + `tokens.on-accent` (auto-set to white if accent luminance < 0.4, black otherwise) | Native `<input type="color">` |
| Roundness slider | All 4 `shape.radius-*` values on a scale (sharp→round) | Single slider → maps to 4 values |
| Background dropdown | `background.type` | Dropdown; if "image", shows URL input |
| Particles dropdown | `effects.particles` | Dropdown of presets |
| Font picker | Font family | Existing `queryLocalFonts()` flow |
| Quick cycle toggles | Which themes appear in status bar cycle | Checkboxes per theme card |

**Design decision:** No full 15-token color editing in the manual editor. That complexity belongs to the skill. Keeps the settings panel approachable for non-technical users.

### "Build with Claude" Button

Opens a prompt in the current Claude chat session: `"/theme-builder — I want to create a new theme"`. This is a simple `window.claude.shell.sendInput()` call — no new infrastructure.

---

## Storage & Persistence

| What | Where | Format |
|---|---|---|
| User themes | `~/.claude/destinclaude-themes/` | JSON files |
| Built-in themes | `desktop/src/renderer/themes/builtin/` | JSON files (bundled) |
| Active theme slug | `localStorage: "destincode-theme"` | String |
| Cycle list | `localStorage: "destincode-theme-cycle"` | JSON array of slugs |
| Font | `localStorage: "destincode-font"` | CSS font-family string |

---

## Migration Plan

The 4 existing built-in themes (Light, Dark, Midnight, Crème) are currently defined as CSS blocks in `globals.css` and hardcoded in `theme-context.tsx`. Migration:

1. Write JSON files for each built-in theme in `src/renderer/themes/builtin/`
2. `ThemeEngine` loads these at startup alongside user themes
3. The hardcoded CSS blocks in `globals.css` remain as fallbacks (anti-FOUC), but ThemeEngine's output takes precedence
4. `THEMES` array and `ThemeName` type in `theme-context.tsx` expand to include any loaded theme slug

---

## How To: Add a New Layout Preset

1. Add the option to the schema docs and the manual editor dropdown
2. Add a CSS block in `globals.css`: `[data-input-style="new-style"] .input-bar { ... }`
3. No component changes needed — ThemeEngine sets the data attribute, CSS does the rest

## How To: Add a New Particle Effect

1. Add a case to the particle system's `useEffect` switch
2. ~30 lines of canvas animation code per preset
3. Add the slug to the schema docs and the manual editor dropdown

---

## What Stays Unchanged

- Status colors (green `#4CAF50`, red `#DD4444`, amber `#FF9800`) — hardcoded, not in theme tokens
- The status bar theme pill cycling — behavior unchanged, now cycles user+builtin themes
- xterm.js color sync — continues to read `--canvas` and `--fg` from computed CSS
- highlight.js swap — driven by the `dark: true/false` field in theme JSON
- Anti-FOUC in `index.tsx` — reads localStorage slug, applies built-in CSS fallback before React mounts

## Change Log

- **1.0** (2026-04-05) — Initial design. Tier 3 theme system, JSON envelope + CSS escape hatch, two-phase skill flow (concept browser → in-app hot-reload), manual editor in settings panel.
