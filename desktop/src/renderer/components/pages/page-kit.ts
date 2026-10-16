// The page style kit (Phase 1 shell): one stylesheet a page can lean on so
// its buttons, fields, cards and text read as YouCoded's own. Written against
// the tokens page-theme.ts delivers, and against the design guide's rules —
// radii by role (G-3), one primary per view (G-4), the text floor (G-5),
// secondary buttons and fields always bordered (§2.4).
//
// WHY a stylesheet and not a component library: a page is plain HTML in an
// opaque frame. Classes are the smallest contract the creator skill can
// target, and a page that uses none of them still gets the right body
// colours and font from the element defaults below.
//
// The kit is a STARTING POINT, not a rule book (Destin, pages-kit-questions 2026-10-16): "users
// should still be able to fully customize page ui and disregard our design principles if they so
// choose. the kit is just a starting point for good first-shot attempts, but should be ignored if
// the user provides contradictory guidance." So every piece below is plain CSS a page's own styles
// override (the page's <style> comes after this sheet), and the scripted pieces step aside when a
// page opts out (`.yc-no-fade`) or simply does not use their class.
//
// The creator skill's vocabulary (keep this comment and the classes in step):
//   .yc-button [.yc-button--primary | --secondary (default) | --ghost (outlined) | --danger] [.yc-button--sm]
//   .yc-input  .yc-textarea  .yc-select        — bordered fields on `inset`
//   .yc-card                                   — raised card: `panel`, `edge` border, radius lg, 12px in, medium shadow
//   .yc-box                                    — a box inside a card (the app's CARD_LEVEL_2)
//   .yc-divider                                — the tapered line
//   .yc-eyebrow  .yc-title  .yc-muted  .yc-faint — text roles
//   .yc-row (flex, gap 8)  .yc-stack (column, gap 12)  .yc-grid (auto-fit cards)
//   .yc-page                                   — padded, reading-width column
//   .yc-status [--info | --ok | --warning | --danger] [--dot] — the app's tinted status Pill
//   .yc-notice [--warning | --danger] [--slim] (__text __title __details __actions) — the app's Callout
//   .yc-loading [--inline]  .yc-screen-error   — the app's LoadingState and ScreenError
//   .yc-switch (a <button role="switch" aria-checked>) — the app's Toggle; PAGE_KIT_JS flips it
//   .yc-search  .yc-filter [aria-pressed]      — the app's search box and FilterChip, one height
//   .yc-fold (<details>/<summary>)             — the app's FoldRow; .yc-section folds at phone width
//   .yc-chips                                  — one line of chips that scrolls sideways under the fade
//   .yc-scroll                                 — the app's one scroll fade (most scrollers get it automatically)
//
// Dropdowns (the kit's `.yc-menu`): write a plain `<select class="yc-select">` with its
// `<option>`s. PAGE_KIT_JS (below) opens every single-choice `<select>` in the app's own
// menu look instead of the browser's white list; the `<select>` stays the real control, so
// `.value`, `selectedIndex` and the `change` event work exactly as before. An action at the
// foot of the list ("Add another option…") is an `<option data-yc-action>`: it is drawn below
// the choices behind the tapered line, and choosing it sets the value and fires `change`
// like any option — the page's handler does the action and sets the value back.

export const PAGE_KIT_CSS = `
/* Values the app derives from theme tokens and a page does not receive as tokens, rebuilt from the
   ones it does, with the app's own formulas (globals.css): the card outline (--edge-card), the
   strong outline every outlined button draws (--edge-strong), the control corner (--radius-control:
   the theme's medium corner + 2px, so a theme's shape setting reaches buttons and chips), the
   raised-card shadow (--shadow-card, decisions "Card shadow") and the fixed status hues
   (Tailwind green-400 / amber-500 as the app's @theme sets them). WHY on :root and prefixed: the
   theme's own :root rule is swapped on every theme change and these recompute from it; the
   prefix keeps them from colliding with anything a page defines. */
:root {
  --yc-edge-card: color-mix(in srgb, var(--edge) 82%, var(--fg) 18%);
  --yc-edge-strong: color-mix(in srgb, var(--edge) 65%, var(--fg) 35%);
  --yc-radius-control: calc(var(--radius-md, 12px) + 2px);
  --yc-shadow-card: 0 4px 20px rgb(0 0 0 / 0.16), 0 1px 3px rgb(0 0 0 / 0.08);
  --yc-ok: #4CAF50;
  --yc-warning: oklch(76.9% 0.188 70.08);
  --yc-danger: var(--destructive, #DD4444);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--fg);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
code, pre, kbd, .yc-mono { font-family: var(--font-mono, ui-monospace, monospace); }
a { color: var(--link, var(--accent)); }
a:hover { color: var(--link-hover, var(--accent)); }
h1, h2, h3, h4 { margin: 0; font-weight: 500; line-height: 1.3; }
h1 { font-size: 18px; font-weight: 600; }
h2 { font-size: 16px; }
h3 { font-size: 14px; }
p { margin: 0; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--edge); border-radius: 9999px; border: 2px solid var(--canvas); }
::-webkit-scrollbar-track { background: transparent; }

/* See-through (the host sets this attribute only when the app's page pane is
   glass over the theme's wallpaper AND the person has the page's "Show theme
   background" switch on): the page paints no backdrop of its own, so the pane's
   glass — and the wallpaper under it — is what shows, exactly as in Office.
   WHY the scrollbar border changes too: it was painted --canvas to look inset,
   which would be a visible opaque rim on glass. */
:root[data-yc-see-through] body { background: transparent; }
:root[data-yc-see-through] ::-webkit-scrollbar-thumb { border-color: transparent; background-clip: padding-box; }

.yc-page { max-width: 1100px; margin: 0 auto; padding: 16px; }
.yc-stack { display: flex; flex-direction: column; gap: 12px; }
.yc-row { display: flex; align-items: center; gap: 8px; }
.yc-row--end { justify-content: flex-end; }
.yc-row--between { justify-content: space-between; }
.yc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.yc-spacer { flex: 1; }

/* WHY: dropped the spaced-caps eyebrow look (labels batch, guide: no spaced
   capitals — decisions H-3/L-1…L-4). Class name kept — existing Pages
   reference .yc-eyebrow by name; only its computed style changed, matching
   the app's own SectionLabel: 12px medium grey, normal case, no tracking. */
.yc-eyebrow { font-size: 12px; font-weight: 500; color: var(--fg-muted); }
.yc-title { font-size: 16px; font-weight: 500; color: var(--fg); }
.yc-muted { color: var(--fg-muted); }
.yc-dim { color: var(--fg-dim); }
.yc-faint { color: var(--fg-faint); }
.yc-small { font-size: 12px; }
.yc-caption { font-size: 11px; color: var(--fg-muted); }

/* WHY 12px in and the medium shadow (pages-kit-questions K-4): the guide's Cards recipe — a raised
   card is the panel colour, a thin border, the theme's card corner and the medium shadow, with
   12px inside its edge (Spacing). It was 16px and flat. A card inside a card, and the inset card,
   stay flat: a shadow there reads as a card floating in a card. */
.yc-card {
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: var(--radius-lg, 12px);
  padding: 12px;
  box-shadow: var(--yc-shadow-card);
}
.yc-card--inset { background: var(--inset); border-color: var(--edge-dim); box-shadow: none; }
.yc-card .yc-card { box-shadow: none; }
.yc-well { background: var(--well); border: 1px solid var(--edge-dim); border-radius: var(--radius-md, 8px); padding: 12px; }
/* A box inside a card: the app's second-level look (cardLevels.ts CARD_LEVEL_2 = the field
   surface — solid inset, the card outline, the theme's large corner). Every nested box looks the
   same, whatever it holds (guide "Card levels"). */
.yc-box { background: var(--inset); border: 1px solid var(--yc-edge-card); border-radius: var(--radius-lg, 12px); padding: 12px; }
/* WHY tapered (K-4; guide "Card levels": no line crosses the full width of a card, a divider is
   the tapered line): the popup header's line, in the card-outline colour (Dialog.css). It was a
   hard full-width rule. */
.yc-divider { border: 0; margin: 0; height: 1px; background: linear-gradient(to right, transparent, var(--yc-edge-card) 8%, var(--yc-edge-card) 92%, transparent); }

.yc-button {
  appearance: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 12px; font-weight: 500; line-height: 1.2;
  padding: 7px 12px;
  /* WHY the control corner (K-4; guide principle 2): the app's every button takes
     --radius-control, so a theme's shape setting reaches the page's buttons as it does the app's. */
  border-radius: var(--yc-radius-control);
  border: 1px solid var(--edge);
  background: var(--inset);
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, opacity 150ms ease;
}
.yc-button:hover { background: var(--well); border-color: var(--fg-faint); }
.yc-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.yc-button:disabled { opacity: .5; cursor: default; }
.yc-button--primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.yc-button--primary:hover { background: var(--accent); border-color: var(--accent); opacity: .9; }
/* WHY --ghost draws OUTLINED (K-4; guide "Buttons": everything less important beside the main
   action is outlined with the full-strength outline, never bare text; principle 9: anything
   clickable sits in a container). It is the app's secondary Button exactly — no fill, the strong
   outline, fg-2 words, inset on hover, edge on press. The class name stays so every existing Page
   that wrote --ghost keeps working and simply gains the outline. */
.yc-button--ghost { background: transparent; border-color: var(--yc-edge-strong); color: var(--fg-2); }
.yc-button--ghost:hover { background: var(--inset); border-color: var(--yc-edge-strong); color: var(--fg-2); }
.yc-button--ghost:active { background: var(--edge); }
.yc-button--danger { background: transparent; border-color: var(--destructive, currentColor); color: var(--destructive-fg, var(--fg)); }
.yc-button--danger:hover { background: var(--destructive, transparent); color: var(--on-destructive, var(--fg)); }
.yc-button--sm { font-size: 11px; padding: 4px 10px; }
.yc-button--full { width: 100%; }
.yc-button--icon { width: 28px; height: 28px; padding: 0; }
/* WHY no longer a full pill (K-4; guide principle 2: never write a fixed pill on a control): the
   class still works and takes the theme's control corner like every other button. */
.yc-button--round { border-radius: var(--yc-radius-control); }

/* WHY select.yc-menu beside .yc-select: the design guide tells page authors the kit's dropdown
   is .yc-menu, so a page that writes <select class="yc-menu"> gets the same closed box. */
.yc-input, .yc-textarea, .yc-select, select.yc-menu {
  font: inherit; font-size: 14px; color: var(--fg);
  background: var(--inset);
  border: 1px solid var(--edge);
  border-radius: var(--radius-md, 8px);
  padding: 7px 10px;
  width: 100%;
}
.yc-input::placeholder, .yc-textarea::placeholder { color: var(--fg-muted); }
.yc-input:focus, .yc-textarea:focus, .yc-select:focus, select.yc-menu:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
/* The closed dropdown answers the pointer the way the app's own Select does (field.ts
   FIELD_TRIGGER_STATES): the border, never the fill, which would move under the words. */
.yc-select, select.yc-menu { cursor: pointer; transition: border-color 150ms ease; }
.yc-select:hover, select.yc-menu:hover { border-color: var(--fg-muted); }
.yc-select:disabled, select.yc-menu:disabled { opacity: .5; cursor: not-allowed; }

/* The open dropdown list — the app's own Select menu (ui/Select.tsx): the popup surface
   (panel fill, card outline, the theme's large corner, the popup shadow), rows in the theme's
   middle corner, the current choice filled with the accent, the row under the pointer or the
   arrow keys on inset. PAGE_KIT_JS builds it; a page never writes this markup itself.
   WHY the shadow is the one literal colour: it is the app's popup shadow (globals.css
   .layer-surface), a darkening rather than a theme colour. */
.yc-menu[role="listbox"] {
  position: fixed; z-index: 2147483000;
  display: flex; flex-direction: column;
  min-width: 120px; max-width: calc(100vw - 16px);
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: var(--radius-lg, 12px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .15);
  font-size: 13px; line-height: 1.35; color: var(--fg-2);
  overflow: hidden;
  user-select: none;
}
/* WHY the choices scroll in their own box: a foot action stays in sight however long the list. */
.yc-menu__list { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px; }
.yc-menu__item { display: block; padding: 6px 10px; border-radius: var(--radius-md, 8px); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yc-menu__item[data-active] { background: var(--inset); }
.yc-menu__item[aria-selected="true"] { background: var(--accent); color: var(--on-accent); font-weight: 500; }
.yc-menu__item[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.yc-menu__group { padding: 8px 10px 2px; font-size: 11px; font-weight: 500; color: var(--fg-muted); }
/* The foot action, behind the tapered line in the card-outline colour (the app's --edge-card,
   rebuilt here from the two tokens a page has). */
.yc-menu__foot { position: relative; flex: none; padding: 4px; }
.yc-menu__foot::before { content: ''; position: absolute; left: 12px; right: 12px; top: 0; height: 1px;
  background: linear-gradient(to right, transparent, var(--yc-edge-card) 8%, var(--yc-edge-card) 92%, transparent); }
/* A finger needs a taller row (the app's coarse-roomy); rows sit flush, so the row grows. */
@media (pointer: coarse) { .yc-menu__item { padding-top: 8px; padding-bottom: 8px; } }
.yc-textarea { min-height: 96px; resize: vertical; }
.yc-label { display: block; font-size: 12px; font-weight: 500; color: var(--fg-2); margin-bottom: 4px; }

.yc-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-sm, 4px);
  background: var(--inset); border: 1px solid var(--edge-dim); color: var(--fg-2);
}
/* WHY the control corner (K-4): a selectable pill is a filter chip, and the app's filter chips take
   --radius-control, never a hard-coded full pill. */
.yc-pill { border-radius: var(--yc-radius-control); padding: 4px 12px; font-size: 14px; }
.yc-pill--on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

.yc-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.yc-list-row {
  display: flex; align-items: center; gap: 10px;
  min-height: 40px; padding: 6px 10px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--edge-dim);
  background: var(--panel);
}
.yc-empty { padding: 32px 16px; text-align: center; color: var(--fg-muted); font-size: 14px; }

table.yc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
/* WHY: dropped uppercase + letter-spacing (labels batch, guide: no spaced
   capitals) — this is a table column header, so it keeps its 11px size. */
table.yc-table th { text-align: left; font-size: 11px; color: var(--fg-muted); font-weight: 500; padding: 8px; border-bottom: 1px solid var(--edge); }
table.yc-table td { padding: 8px; border-bottom: 1px solid var(--edge-dim); }

/* App-shaped pages: a toolbar across the top, a tool rail on the left, a
   sidebar on the right, the work in the middle. Added for the paint studio
   and planner samples (shell deck round 1: the first samples were "too
   basic"), so the creator skill has a layout vocabulary, not only controls. */
.yc-app { height: 100%; display: flex; flex-direction: column; }
.yc-app__body { flex: 1; display: flex; min-height: 0; }
.yc-app__main { flex: 1; min-width: 0; position: relative; overflow: auto; }
.yc-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--edge); }
.yc-rail { display: flex; flex-direction: column; gap: 4px; padding: 8px; background: var(--panel); border-right: 1px solid var(--edge); }
.yc-sidebar { width: 232px; padding: 12px; background: var(--panel); border-left: 1px solid var(--edge); overflow: auto; display: flex; flex-direction: column; gap: 16px; }
.yc-tool { width: 36px; height: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-md, 8px); border: 1px solid transparent; background: transparent; color: var(--fg-2); cursor: pointer; }
.yc-tool:hover { background: var(--inset); color: var(--fg); }
.yc-tool--on { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.yc-tool svg { width: 18px; height: 18px; }
/* The slider: the app's own look (ui/Slider.tsx, Destin submit-ticket-5#ST5-5 and #ST6-Q1) —
   a round track, the accent fill to a round handle, its end wrapping the handle. CSS only, as a
   page is plain HTML: the thumb is a white circle ringed in the accent, and its shadow (offset
   left by half a thumb past the track) paints the fill up to the handle's centre; with the ring
   that makes one shape whose end is concentric with the handle. The track clips the shadow. */
.yc-range { -webkit-appearance: none; appearance: none; box-sizing: border-box; width: 100%; height: 20px; margin: 0; border-radius: 999px; background: var(--inset); border: 1px solid var(--edge-dim); overflow: hidden; cursor: pointer; }
.yc-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 3px solid var(--accent); box-shadow: calc(-100vw - 9px) 0 0 100vw var(--accent); }
.yc-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 3px solid var(--accent); }
.yc-range::-moz-range-progress { height: 100%; border-radius: 999px; background: var(--accent); }
.yc-range:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.yc-range:disabled { opacity: .5; cursor: not-allowed; }
.yc-swatches { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.yc-swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--edge); cursor: pointer; padding: 0; }
.yc-swatch--on { outline: 2px solid var(--fg); outline-offset: 2px; }
.yc-kbd { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: var(--radius-sm, 4px); background: var(--inset); border: 1px solid var(--edge-dim); color: var(--fg-2); }
.yc-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-2); }
.yc-badge::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--badge, var(--accent)); }

/* ── The app's own building blocks (pages-kit-questions, 2026-10-16) ──────────────────────────
   Each is the app's primitive redrawn in plain CSS on the page's tokens — sizes, colours and
   corners read from components/ui/*.tsx, never invented. Comments name the primitive. */

/* Status label — ui/Pill.tsx: a small tinted pill, the colour ONLY in the tint and border, the
   words in the normal text colour (guide "Status and notices"). --dot adds the live-status dot
   inside the pill. The pill's round shape is the app's Pill's own (the theme's --radius-full). */
.yc-status {
  display: inline-flex; align-items: center; gap: 4px; flex: none; vertical-align: middle;
  padding: 1px 8px; font-size: 11px; font-weight: 400; line-height: 1.25; white-space: nowrap;
  color: var(--fg-2); background: var(--inset); border: 1px solid var(--edge-dim);
  border-radius: var(--radius-full, 9999px);
}
.yc-status--info { background: color-mix(in oklab, var(--accent) 15%, transparent); border-color: color-mix(in oklab, var(--accent) 30%, transparent); --yc-dot: var(--accent); }
.yc-status--ok { background: color-mix(in oklab, var(--yc-ok) 15%, transparent); border-color: color-mix(in oklab, var(--yc-ok) 30%, transparent); --yc-dot: var(--yc-ok); }
.yc-status--warning { background: color-mix(in oklab, var(--yc-warning) 15%, transparent); border-color: color-mix(in oklab, var(--yc-warning) 30%, transparent); --yc-dot: var(--yc-warning); }
.yc-status--danger { background: color-mix(in oklab, var(--yc-danger) 15%, transparent); border-color: color-mix(in oklab, var(--yc-danger) 30%, transparent); --yc-dot: var(--yc-danger); }
.yc-status--dot { padding-left: 6px; }
.yc-status--dot::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--yc-dot, var(--fg-muted)); }

/* Notice box — ui/Callout.tsx: one tinted box with a matching border; only the box carries the
   colour, the title and words stay the normal text colours. Its buttons sit inside it at the
   right; with a Details fold (.yc-notice__details, a .yc-fold) the box reads sentence → Details →
   buttons, the buttons on their own line at the right BELOW the fold (Destin, gt-r1#E-2/#E-3) —
   whatever order the page wrote them in (the order property). .yc-screen-error is the same box as
   the app's ScreenError: a whole screen that could not load, centred a little below the top
   (pt-24), at a readable width, its buttons full width. */
.yc-notice, .yc-screen-error {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 12px; border: 1px solid; border-radius: var(--radius-lg, 12px);
  font-size: 12px; line-height: 1.333; color: var(--fg-2);
  background: color-mix(in oklab, var(--accent) 10%, transparent);
  border-color: color-mix(in oklab, var(--accent) 25%, transparent);
}
.yc-notice--warning { background: color-mix(in oklab, var(--yc-warning) 10%, transparent); border-color: color-mix(in oklab, var(--yc-warning) 25%, transparent); }
.yc-notice--danger, .yc-screen-error { background: color-mix(in oklab, var(--yc-danger) 10%, transparent); border-color: color-mix(in oklab, var(--yc-danger) 50%, transparent); }
.yc-notice--slim { padding: 6px 10px; gap: 6px 12px; }
.yc-notice:has(.yc-notice__title), .yc-screen-error:has(.yc-notice__title) { align-items: flex-start; }
.yc-notice__text { flex: 1 1 192px; min-width: 0; }
.yc-notice__title { display: block; font-weight: 500; color: var(--fg); margin-bottom: 2px; }
.yc-notice__details { flex: 1 1 100%; order: 1; }
.yc-notice__details code, .yc-notice__details pre { display: block; margin: 0; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--fg-2); white-space: pre-wrap; word-break: break-all; }
.yc-notice__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; order: 2; }
.yc-notice:has(> .yc-notice__details) > .yc-notice__actions, .yc-screen-error > .yc-notice__actions { flex-basis: 100%; }
.yc-screen-error { width: min(384px, 100% - 32px); margin: 96px auto 48px; }
.yc-screen-error > .yc-notice__actions { flex-direction: column; align-items: stretch; }
.yc-screen-error > .yc-notice__actions > * { width: 100%; }

/* Loading line — ui/states.tsx LoadingState: the braille spinner, then "Loading …" in grey,
   centred with room above and below (--inline: small, at the left, inside a section). The spinner
   is the app's BrailleSpinner — the same ten frames every 80ms and the same colour cycle — in CSS
   only, so a page needs no script for it. WHY steps(): performance rule 6, an infinite animation
   presents only the frames that change. */
.yc-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 32px 0; font-size: 14px; color: var(--fg-muted); }
.yc-loading--inline { justify-content: flex-start; padding: 0 4px; font-size: 11px; }
.yc-loading::before { content: '⠋'; display: inline-block; flex: none; width: 1em; text-align: center; line-height: 1; animation: yc-spin 800ms steps(1, end) infinite, yc-spin-hue 3000ms steps(1, end) infinite; }
@keyframes yc-spin { 0% { content: '⠋'; } 10% { content: '⠙'; } 20% { content: '⠹'; } 30% { content: '⠸'; } 40% { content: '⠼'; } 50% { content: '⠴'; } 60% { content: '⠦'; } 70% { content: '⠧'; } 80% { content: '⠇'; } 90% { content: '⠏'; } 100% { content: '⠋'; } }
@keyframes yc-spin-hue { 0% { color: var(--fg-dim); } 20% { color: var(--fg-2); } 40% { color: var(--accent); } 60% { color: var(--fg-muted); } 80% { color: var(--fg-muted); } 100% { color: var(--fg-dim); } }

/* On/off switch — ui/Toggle.tsx: the 36×20 track, a 16px white knob ringed in edge-dim, accent
   when on, the border kept (transparent) when on so the knob never shifts. Write
   <button class="yc-switch" role="switch" aria-checked="false" aria-label="…"></button>;
   PAGE_KIT_JS flips aria-checked on a click, Space or Enter and fires "change". A plain
   <input type="checkbox" class="yc-switch"> draws the same and works natively. */
.yc-switch {
  -webkit-appearance: none; appearance: none; position: relative; display: inline-block; flex: none;
  vertical-align: middle; width: 36px; height: 20px; margin: 0; padding: 0; font: inherit;
  background: var(--inset); border: 1px solid var(--edge-dim); border-radius: var(--radius-full, 9999px);
  cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease;
}
.yc-switch::before {
  content: ''; position: absolute; top: 50%; left: 1px; width: 16px; height: 16px; transform: translateY(-50%);
  border-radius: 50%; background: #fff; border: 1px solid var(--edge-dim);
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1); transition: left 150ms ease;
}
.yc-switch[aria-checked="true"], .yc-switch:checked { background: var(--accent); border-color: transparent; }
.yc-switch--danger[aria-checked="true"], .yc-switch--danger:checked { background: var(--destructive); }
.yc-switch[aria-checked="true"]::before, .yc-switch:checked::before { left: 17px; }
.yc-switch:disabled, .yc-switch[aria-disabled="true"] { opacity: .6; cursor: not-allowed; }
.yc-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* The app's coarse-hit: a 44px invisible target on a touchscreen, no visual change. */
@media (pointer: coarse) { .yc-switch::after { content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 100%; height: 100%; min-width: 44px; min-height: 44px; } }

/* Search box + filter chips — ui/SearchFilterPill.tsx and ui/FilterChip.tsx: the inset box with
   the search glyph, the theme's control corner, the accent border while typing; chips inset with
   the edge outline, filled with the accent when on (aria-pressed="true" or .yc-filter--on).
   WHY one fixed height for both (guide principle 6; Destin gt-r2#C-5a: chips beside a box were too
   tight): controls on one line share one height, and 32px leaves the chip's words 6px above and
   below. */
.yc-search {
  display: flex; align-items: center; gap: 8px; height: 32px; min-width: 0; padding: 0 12px;
  color: var(--fg-muted); background: var(--inset); border: 1px solid var(--edge); border-radius: var(--yc-radius-control);
}
.yc-search::before { content: ''; flex: none; width: 15px; height: 15px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E") center / contain no-repeat; }
.yc-search:focus-within { border-color: var(--accent); }
.yc-search input { flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; font: inherit; font-size: 13px; color: var(--fg); }
.yc-search input::placeholder { color: var(--fg-muted); }
.yc-search input::-webkit-search-cancel-button { -webkit-appearance: none; }
.yc-filter {
  -webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none;
  height: 32px; margin: 0; padding: 0 12px; font: inherit; font-size: 14px; line-height: 20px; white-space: nowrap;
  color: var(--fg-2); background: var(--inset); border: 1px solid var(--edge); border-radius: var(--yc-radius-control);
  cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
}
.yc-filter:hover { color: var(--fg); border-color: var(--edge-dim); }
.yc-filter[aria-pressed="true"], .yc-filter[aria-checked="true"], .yc-filter--on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.yc-filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* One line of chips — the app's fact-chip row (marketplace/FactChips.tsx) and its chip (ui/Chip.tsx).
   WHY it never wraps (guide "Cards", principle 8): it scrolls sideways under the edge fade, with no
   scrollbar and 4px of room above and below so a chip's border is never cut. Filter chips
   (.yc-filter) go in one too. */
.yc-chips { display: flex; align-items: center; flex-wrap: nowrap; gap: 6px; min-width: 0; overflow-x: auto; overflow-y: hidden; padding: 4px 0; margin: -4px 0; scrollbar-width: none; }
.yc-chips::-webkit-scrollbar { display: none; }
.yc-chips > * { flex-shrink: 0; }
.yc-row > .yc-chips { flex: 1 1 auto; }
.yc-chips .yc-chip { gap: 4px; padding: 2px 6px; font-weight: 400; white-space: nowrap; }

/* Fold-out row — ui/FoldRow.tsx: a boxed row like a setting (the app's first-level box: inset at
   half, the card outline, the large corner), its title and grey hint at the left, the arrow at the
   right turning down when open. Write <details class="yc-fold"><summary>Title <span
   class="yc-fold__hint">hint</span></summary>…</details>: what it reveals opens INSIDE the same box,
   and pointing at it lights the WHOLE box in its own rounded shape (guide "Settings"). WHY native
   <details>: it opens and closes from the keyboard and to a screen reader with no script. */
.yc-fold, .yc-section { --yc-fold-arrow: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 5l7 7-7 7'/%3E%3C/svg%3E"); }
.yc-fold { background: color-mix(in oklab, var(--inset) 50%, transparent); border: 1px solid var(--yc-edge-card); border-radius: var(--radius-lg, 12px); transition: background-color 150ms steps(4); }
.yc-fold:has(> summary:hover) { background: var(--inset); }
.yc-fold > summary { position: relative; display: block; padding: 8px 40px 8px 12px; font-size: 12px; font-weight: 500; color: var(--fg); list-style: none; cursor: pointer; user-select: none; border-radius: inherit; }
.yc-fold > summary::-webkit-details-marker { display: none; }
.yc-fold > summary::after { content: ''; position: absolute; right: 12px; top: 50%; width: 16px; height: 16px; margin-top: -8px; background: var(--fg-muted); -webkit-mask: var(--yc-fold-arrow) center / contain no-repeat; mask: var(--yc-fold-arrow) center / contain no-repeat; transition: transform 150ms ease; }
.yc-fold[open] > summary::after { transform: rotate(90deg); }
.yc-fold > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.yc-fold__hint { display: block; margin-top: -2px; font-size: 11px; font-weight: 400; color: var(--fg-muted); }
.yc-fold > :not(summary) { margin-left: 12px; margin-right: 12px; }
.yc-fold > summary + * { margin-top: 4px; }
.yc-fold > :last-child:not(summary) { margin-bottom: 8px; }

/* A long section that folds at PHONE width only (guide principle 8, gt-r2#E-3b: the screen becomes
   a short list you open, the first one open). Write <details class="yc-section" open> on the first
   and <details class="yc-section"> on the rest, each starting with its <summary> heading. On a
   wider screen the heading is a plain Large heading and every section shows in full, whatever its
   open state; below 640px (the app's one breakpoint, 639.98px) each becomes a fold-out row. */
.yc-section > summary { list-style: none; margin-bottom: 8px; font-size: 16px; font-weight: 500; color: var(--fg); }
.yc-section > summary::-webkit-details-marker { display: none; }
@supports selector(::details-content) {
  @media not all and (max-width: 639.98px) {
    .yc-section::details-content { content-visibility: visible; }
    .yc-section > summary { pointer-events: none; }
  }
}
@media (max-width: 639.98px) {
  .yc-section { background: color-mix(in oklab, var(--inset) 50%, transparent); border: 1px solid var(--yc-edge-card); border-radius: var(--radius-lg, 12px); transition: background-color 150ms steps(4); }
  .yc-section:has(> summary:hover) { background: var(--inset); }
  .yc-section > summary { position: relative; margin: 0; padding: 8px 40px 8px 12px; font-size: 14px; cursor: pointer; user-select: none; border-radius: inherit; }
  .yc-section > summary::after { content: ''; position: absolute; right: 12px; top: 50%; width: 16px; height: 16px; margin-top: -8px; background: var(--fg-muted); -webkit-mask: var(--yc-fold-arrow) center / contain no-repeat; mask: var(--yc-fold-arrow) center / contain no-repeat; transition: transform 150ms ease; }
  .yc-section[open] > summary::after { transform: rotate(90deg); }
  .yc-section > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .yc-section > :not(summary) { margin-left: 12px; margin-right: 12px; }
  .yc-section > summary + * { margin-top: 4px; }
  .yc-section > :last-child:not(summary) { margin-bottom: 12px; }
}

/* The scroll fade — the app's ONE fade (styles/scroll-mask.css), mirrored rule for rule: the
   content fades to see-through at an edge only while more is hidden that way, followed by the
   browser itself (scroll-driven animations), no script per frame. The gradients and keyframes are
   the app's text exactly (pinned by tests/page-kit.test.ts); only the selectors differ.
   WHO gets it: the kit's own scrollers (.yc-app__main, .yc-sidebar, the dropdown's list, a chip
   row), anything marked .yc-scroll, and — automatically — every element a page makes scroll:
   PAGE_KIT_JS marks it .yc-scroll. The page document itself fades in the app's frame (the host
   draws the same fade on it). A page that wants none writes .yc-no-fade on the scroller. */
.yc-scroll, .yc-app__main, .yc-sidebar, .yc-menu__list, .yc-chips {
  --scroll-mask-size: 40px;
  --scroll-mask-under: 0px;
  --scroll-mask-over: 0px;
  --scroll-mask-start: 0px;
  --scroll-mask-t: 0;
  --scroll-mask-b: 0;
  --scroll-mask-l: 0;
  --scroll-mask-r: 0;
  --scroll-mask-on-y: initial;
  --scroll-mask-on-x: initial;
  --scroll-mask-on: var(--scroll-mask-on-y, var(--scroll-mask-on-x));
  --scroll-mask-s: min(var(--scroll-mask-size), 25%);
  --scroll-mask-y: linear-gradient(to bottom, #000 0, #000 var(--scroll-mask-over), transparent var(--scroll-mask-over), #000 calc(var(--scroll-mask-over) + var(--scroll-mask-t) * var(--scroll-mask-s) + var(--scroll-mask-on)), #000 calc(100% - var(--scroll-mask-under) - var(--scroll-mask-b) * var(--scroll-mask-s)), transparent calc(100% - var(--scroll-mask-under)));
  --scroll-mask-x: linear-gradient(to right, #000 0, #000 var(--scroll-mask-start), transparent var(--scroll-mask-start), #000 calc(var(--scroll-mask-start) + var(--scroll-mask-l) * var(--scroll-mask-s)), #000 calc(100% - var(--scroll-mask-r) * var(--scroll-mask-s)), transparent 100%);
  scroll-padding-block: var(--scroll-mask-s);
  -webkit-mask-image: var(--scroll-mask-y), var(--scroll-mask-x);
  mask-image: var(--scroll-mask-y), var(--scroll-mask-x);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}
/* The app's chip-row size (scroll-mask--chips): at 40px a chip-sized row loses most of its last chip. */
.yc-chips { --scroll-mask-size: 24px; }
@keyframes scroll-mask-top { from { --scroll-mask-t: 0; --scroll-mask-on-y: 0px; } to { --scroll-mask-t: 1; --scroll-mask-on-y: 0px; } }
@keyframes scroll-mask-bottom { from { --scroll-mask-b: 1; } to { --scroll-mask-b: 0; } }
@keyframes scroll-mask-left { from { --scroll-mask-l: 0; --scroll-mask-on-x: 0px; } to { --scroll-mask-l: 1; --scroll-mask-on-x: 0px; } }
@keyframes scroll-mask-right { from { --scroll-mask-r: 1; } to { --scroll-mask-r: 0; } }
@supports (animation-timeline: scroll()) {
  .yc-scroll, .yc-app__main, .yc-sidebar, .yc-menu__list {
    animation: scroll-mask-top linear both, scroll-mask-bottom linear both,
               scroll-mask-left linear both, scroll-mask-right linear both;
    animation-timeline: scroll(self block), scroll(self block),
                        scroll(self inline), scroll(self inline);
    animation-range: 0px 6px, calc(100% - 6px) 100%,
                     0px 6px, calc(100% - 6px) 100%;
  }
  /* A chip row only ever scrolls sideways: the app's one-way form (scroll-mask-x), half the cost. */
  .yc-chips {
    animation: scroll-mask-left linear both, scroll-mask-right linear both;
    animation-timeline: scroll(self inline), scroll(self inline);
    animation-range: 0px 6px, calc(100% - 6px) 100%;
  }
}
/* Without scroll-driven animations (an older browser), PAGE_KIT_JS sets these flags instead. */
@supports not (animation-timeline: scroll()) {
  [data-fade-top] { --scroll-mask-on-y: 0px; }
  [data-fade-top="true"] { --scroll-mask-t: 1; }
  [data-fade-bottom="true"] { --scroll-mask-b: 1; }
  [data-fade-left="true"] { --scroll-mask-l: 1; }
  [data-fade-right="true"] { --scroll-mask-r: 1; }
}
.yc-no-fade { -webkit-mask-image: none !important; mask-image: none !important; animation: none !important; }

@media (prefers-reduced-motion: reduce) {
  .yc-button, .yc-select, select.yc-menu, .yc-switch, .yc-switch::before, .yc-filter, .yc-fold, .yc-fold > summary::after, .yc-section, .yc-section > summary::after { transition: none; }
  .yc-loading::before { animation: none; }
}
`;

/** Page → host: which edges of the page document hide more (`{ top, bottom }` booleans), so the
 *  host fades its frame with the app's one scroll fade (PageHost; scroll-mask.css
 *  `.scroll-mask-frame`). Posted by PAGE_KIT_JS only when an edge changes. */
export const PAGE_EDGES_MESSAGE = 'youcoded:edges';

/** The kit's script, put into every page after the bootstrap (page-theme.ts
 *  prepareHostedDocument). Three jobs, in two parts: the dropdown (first part, below) opens every
 *  single-choice `<select>` in the `.yc-menu` list above instead of the browser's own list; the
 *  second part flips `.yc-switch`es and gives every scroller the scroll fade, the page document
 *  included (its own cost note is in place).
 *
 *  WHY the `<select>` stays on the page and only the OPEN list is replaced (rather than
 *  swapping the select for a button): page code keeps working untouched — it reads and sets
 *  `.value`, listens for `change`, and styles its selects by tag (`.fld select`) — and pages
 *  that redraw by comparing their new HTML with the page (the Home page's morph) would strip
 *  or reuse an extra button they never drew. The browser's list is stopped where it starts:
 *  the press on the select (mousedown, cancelled) and the keys that would open it.
 *
 *  Cost (performance rules 2, 6, 8): three listeners on `window` for the page's life, each
 *  returning at once unless a select or an open list is involved; scroll/resize listeners
 *  (passive) exist only while a list is open and redo the placement at most once a frame;
 *  the list is built on open from the select's options and removed on close.
 *
 *  Kept dependency-free ES5 in one string, like the bootstrap, because it runs in the page.
 *  No backticks in here, and dollar-brace only for the one message name: this is a template
 *  literal. */
export const PAGE_KIT_JS = `(function(){
  var open = null; // { sel, menu, list, items, active, ta, taAt, raf }
  var seq = 0;
  function single(sel) { return sel && sel.tagName === 'SELECT' && !sel.multiple && !(sel.size > 1); }
  function dispatch(sel, type) { sel.dispatchEvent(new Event(type, { bubbles: true })); }
  function setActive(i) {
    if (!open) return;
    var prev = open.items[open.active];
    if (prev) prev.el.removeAttribute('data-active');
    open.active = i;
    var it = open.items[i];
    if (!it) { open.sel.removeAttribute('aria-activedescendant'); return; }
    it.el.setAttribute('data-active', '');
    open.sel.setAttribute('aria-activedescendant', it.el.id);
    // Keep it in sight inside its own scroller (never scrollIntoView: that can scroll the page).
    var box = it.el.parentNode;
    if (box && box.className === 'yc-menu__list') {
      var top = it.el.offsetTop, bot = top + it.el.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bot > box.scrollTop + box.clientHeight) box.scrollTop = bot - box.clientHeight;
    }
  }
  function step(from, dir) {
    var n = open.items.length;
    for (var k = 1; k <= n; k++) { var i = ((from + dir * k) % n + n) % n; if (!open.items[i].opt.disabled) return i; }
    return from;
  }
  function place() {
    if (!open) return;
    open.raf = 0;
    var r = open.sel.getBoundingClientRect(), m = open.menu, vw = window.innerWidth, vh = window.innerHeight;
    m.style.minWidth = Math.round(r.width) + 'px';
    m.style.maxHeight = 'none';
    var want = Math.min(m.scrollHeight, 320), below = vh - r.bottom - 12, above = r.top - 12;
    // WHY it can open upward: a page in a short pane often has its dropdown near the bottom.
    var up = want > below && above > below;
    var h = Math.max(80, Math.min(want, up ? above : below));
    m.style.maxHeight = h + 'px';
    m.style.top = (up ? Math.max(8, r.top - 4 - Math.min(want, h)) : r.bottom + 4) + 'px';
    m.style.left = Math.max(8, Math.min(r.left, vw - m.offsetWidth - 8)) + 'px';
  }
  function schedule() { if (open && !open.raf) open.raf = requestAnimationFrame(place); }
  function close(refocus) {
    if (!open) return;
    var o = open; open = null;
    if (o.raf) cancelAnimationFrame(o.raf);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    o.sel.removeEventListener('blur', onBlur);
    o.sel.removeAttribute('aria-expanded');
    o.sel.removeAttribute('aria-controls');
    o.sel.removeAttribute('aria-activedescendant');
    if (o.menu.parentNode) o.menu.parentNode.removeChild(o.menu);
    if (refocus) { try { o.sel.focus(); } catch (e) {} }
  }
  function onBlur() { close(false); }
  function choose(i) {
    if (!open) return;
    var it = open.items[i];
    if (!it || it.opt.disabled) return;
    var sel = open.sel;
    close(true);
    // The real select changes, and tells the page the way the browser would: input, then change.
    if (sel.selectedIndex !== it.opt.index) { sel.selectedIndex = it.opt.index; dispatch(sel, 'input'); dispatch(sel, 'change'); }
  }
  function row(opt, items) {
    var el = document.createElement('div');
    el.className = 'yc-menu__item';
    el.id = 'yc-menu-' + seq + '-' + items.length;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
    if (opt.disabled) el.setAttribute('aria-disabled', 'true');
    el.textContent = opt.label || opt.text;
    el.setAttribute('data-index', String(items.length));
    items.push({ el: el, opt: opt });
    return el;
  }
  function openFor(sel) {
    close(false);
    seq++;
    var menu = document.createElement('div');
    menu.className = 'yc-menu';
    menu.id = 'yc-menu-' + seq;
    menu.setAttribute('role', 'listbox');
    if (sel.getAttribute('aria-label')) menu.setAttribute('aria-label', sel.getAttribute('aria-label'));
    var list = document.createElement('div');
    list.className = 'yc-menu__list';
    var foot = null, items = [], actions = [];
    for (var c = sel.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName === 'OPTGROUP') {
        var g = document.createElement('div');
        g.className = 'yc-menu__group'; g.setAttribute('role', 'presentation'); g.textContent = c.label;
        list.appendChild(g);
        for (var o = c.firstElementChild; o; o = o.nextElementSibling) if (o.tagName === 'OPTION' && !o.hidden) list.appendChild(row(o, items));
      } else if (c.tagName === 'OPTION' && !c.hidden) {
        if (c.hasAttribute('data-yc-action')) actions.push(c); else list.appendChild(row(c, items));
      }
    }
    menu.appendChild(list);
    if (actions.length) {
      foot = document.createElement('div');
      foot.className = 'yc-menu__foot';
      for (var fi = 0; fi < actions.length; fi++) foot.appendChild(row(actions[fi], items));
      menu.appendChild(foot);
    }
    (document.body || document.documentElement).appendChild(menu);
    open = { sel: sel, menu: menu, list: list, items: items, active: -1, ta: '', taAt: 0, raf: 0 };
    sel.setAttribute('aria-expanded', 'true');
    sel.setAttribute('aria-controls', menu.id);
    place();
    var cur = -1;
    for (var i = 0; i < items.length; i++) if (items[i].opt.selected) { cur = i; break; }
    setActive(cur >= 0 ? cur : step(-1, 1));
    // The pointer: hovering lights a row, a press keeps focus on the select, a click chooses.
    menu.addEventListener('mousedown', function (e) { e.preventDefault(); });
    menu.addEventListener('mousemove', function (e) {
      var t = e.target.closest ? e.target.closest('.yc-menu__item') : null;
      if (!t || !open) return;
      var n = +t.getAttribute('data-index');
      if (n !== open.active && !open.items[n].opt.disabled) setActive(n);
    });
    menu.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.yc-menu__item') : null;
      if (t) choose(+t.getAttribute('data-index'));
    });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    sel.addEventListener('blur', onBlur);
  }
  // A press on a select opens ours instead of the browser's; a press anywhere else closes it.
  window.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (open && open.menu.contains(t)) return;
    var sel = t && t.closest ? t.closest('select') : null;
    if (!single(sel) || sel.disabled) { if (open) close(false); return; }
    if (e.button !== 0) return;
    e.preventDefault();
    if (open && open.sel === sel) { close(true); return; }
    try { sel.focus(); } catch (err) {}
    openFor(sel);
  }, true);
  // WHY on window, in the capture phase, registered before the page's own script runs: while
  // the list is open its keys belong to it alone, as they do to the browser's own list — the
  // page's shortcuts and the app's Escape (the bootstrap leaves the page on an Escape nobody
  // used) never see them.
  window.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!open) {
      if (!single(t) || t.disabled) return;
      var k0 = e.key;
      if (k0 === ' ' || k0 === 'Enter' || k0 === 'F4' || k0 === 'ArrowDown' || k0 === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        openFor(t);
      }
      return;
    }
    var k = e.key;
    if (k === 'Tab') { close(false); return; }
    e.stopImmediatePropagation();
    if (k === 'Escape') { e.preventDefault(); close(true); return; }
    if (k === 'ArrowDown') { e.preventDefault(); setActive(step(open.active, 1)); return; }
    if (k === 'ArrowUp') { e.preventDefault(); setActive(step(open.active < 0 ? 0 : open.active, -1)); return; }
    if (k === 'Home') { e.preventDefault(); setActive(step(-1, 1)); return; }
    if (k === 'End') { e.preventDefault(); setActive(step(0, -1)); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(open.active); return; }
    if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // First letters jump, as in the app's Select: keys within half a second add up ("mo").
      e.preventDefault();
      var now = Date.now();
      open.ta = now - open.taAt < 500 ? open.ta + k.toLowerCase() : k.toLowerCase();
      open.taAt = now;
      for (var i = 0; i < open.items.length; i++) {
        var it = open.items[i];
        if (!it.opt.disabled && (it.opt.label || it.opt.text).toLowerCase().indexOf(open.ta) === 0) { setActive(i); break; }
      }
      return;
    }
    e.preventDefault();
  }, true);
})();
(function(){
  // ── The switch (.yc-switch) ── the app's Toggle: a click, Space or Enter flips aria-checked and
  // fires "change", so page code reads el.getAttribute('aria-checked') === 'true' in its handler.
  // WHY in the capture phase on window: the flip happens before the page's own click handler runs,
  // so a page listening for "click" reads the new state too. WHY the kit handles Space and Enter
  // itself (and cancels the browser's): one path for a button and for a span or div a page made a
  // switch, and no double flip from the browser's own key-to-click.
  function sw(t) { var el = t && t.closest ? t.closest('.yc-switch') : null; return el && el.tagName !== 'INPUT' ? el : null; }
  function prep(el) {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'switch');
    if (!el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', 'false');
    if (el.tagName !== 'BUTTON' && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  }
  function flip(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    prep(el);
    el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  window.addEventListener('click', function (e) { var el = sw(e.target); if (el) flip(el); }, true);
  window.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    var el = sw(e.target);
    if (!el || el !== e.target) return;
    e.preventDefault();
    if (!e.repeat) flip(el);
  }, true);
  window.addEventListener('keyup', function (e) { if (e.key === ' ' && sw(e.target) === e.target) e.preventDefault(); }, true);

  // ── The scroll fade (.yc-scroll) ── every element a page makes scroll gets the app's one fade
  // without the page asking: a scroller (overflow auto/scroll, from any stylesheet or style
  // attribute) is marked .yc-scroll, and the kit's CSS does the rest — it draws nothing while the
  // box fits. Cost (performance rules 2, 6, 8): one pass over the page when it is ready; after that
  // only ADDED elements are looked at, once per frame at most and only in a frame where something
  // was added; a class a page's redraw strips is put back in the same task, before paint (no
  // flicker); one passive scroll listener marks a scroller the passes missed the first time it
  // moves. No timers, nothing per frame while the page is still.
  var FADED = '.yc-scroll, .yc-app__main, .yc-sidebar, .yc-menu__list, .yc-chips';
  var timeline = !!(window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()'));
  function scrolls(v) { return v === 'auto' || v === 'scroll'; }
  function edges(el) {
    // Only without scroll-driven animations: the flags the kit's fallback CSS reads.
    var t = el.scrollTop > 3, b = el.scrollTop + el.clientHeight < el.scrollHeight - 3;
    var l = el.scrollLeft > 3, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 3;
    var v = [t, b, l, r], n = ['data-fade-top', 'data-fade-bottom', 'data-fade-left', 'data-fade-right'];
    for (var i = 0; i < 4; i++) if (el.getAttribute(n[i]) !== String(v[i])) el.setAttribute(n[i], String(v[i]));
  }
  function look(el) {
    if (el.nodeType !== 1 || el === document.documentElement) return;
    var c = el.classList;
    if (c.contains('yc-switch') && el.tagName !== 'INPUT') prep(el);
    if (c.contains('yc-scroll') || c.contains('yc-no-fade') || el.matches(FADED)) return;
    var s = getComputedStyle(el);
    if (scrolls(s.overflowY) || scrolls(s.overflowX)) { c.add('yc-scroll'); if (!timeline) edges(el); }
  }
  function lookAll(root) {
    look(root);
    var els = root.getElementsByTagName ? root.getElementsByTagName('*') : [];
    for (var i = 0; i < els.length; i++) look(els[i]);
  }
  var queue = [], raf = 0;
  function drain() {
    raf = 0;
    var list = queue; queue = [];
    for (var i = 0; i < list.length; i++) if (list[i].isConnected) lookAll(list[i]);
    if (!timeline) { var f = document.querySelectorAll(FADED); for (var j = 0; j < f.length; j++) edges(f[j]); }
    docSoon();
  }
  var mo = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'attributes') {
        // A redraw that rewrote the class dropped the mark: put it straight back (still this task).
        var el = r.target;
        if (r.oldValue && /(^|\\s)yc-scroll(\\s|$)/.test(r.oldValue) && !el.classList.contains('yc-scroll')) el.classList.add('yc-scroll');
        continue;
      }
      for (var k = 0; k < r.addedNodes.length; k++) if (r.addedNodes[k].nodeType === 1) queue.push(r.addedNodes[k]);
    }
    if (queue.length && !raf) raf = requestAnimationFrame(drain);
    else docSoon();
  });
  window.addEventListener('scroll', function (e) {
    var el = e.target;
    if (el && el.nodeType === 1) {
      if (!el.classList.contains('yc-scroll') && !el.classList.contains('yc-no-fade') && el !== document.documentElement && el !== document.body && !el.matches(FADED)) el.classList.add('yc-scroll');
      if (!timeline && el.matches(FADED)) edges(el);
    } else docSoon();
  }, { capture: true, passive: true });

  // ── The page document's own fade ── the document scrolls inside the app's frame, and a mask on
  // the document cannot follow it (a root mask scrolls away with the page), so the page tells the
  // app which edges hide more and the APP fades the frame with its one fade (PageHost,
  // scroll-mask.css .scroll-mask-frame). Read at most once a frame, posted only when it changes.
  var docT = null, docB = null, dRaf = 0;
  function docEdges() {
    dRaf = 0;
    var se = document.scrollingElement || document.documentElement;
    var t = se.scrollTop > 3, b = se.scrollTop + se.clientHeight < se.scrollHeight - 3;
    if (t === docT && b === docB) return;
    docT = t; docB = b;
    try { parent.postMessage({ type: ${JSON.stringify(PAGE_EDGES_MESSAGE)}, top: t, bottom: b }, '*'); } catch (err) {}
  }
  function docSoon() { if (!dRaf) dRaf = requestAnimationFrame(docEdges); }
  window.addEventListener('resize', function () { docSoon(); if (!timeline && !raf) raf = requestAnimationFrame(drain); }, { passive: true });
  window.addEventListener('load', docSoon);
  // A fold opening changes the page's height without adding anything ("toggle" does not bubble).
  document.addEventListener('toggle', docSoon, true);

  function start() {
    lookAll(document.body || document.documentElement);
    if (!timeline) { var f = document.querySelectorAll(FADED); for (var j = 0; j < f.length; j++) edges(f[j]); }
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    docSoon();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;
