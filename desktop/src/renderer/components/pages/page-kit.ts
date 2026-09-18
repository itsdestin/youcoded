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
// The creator skill's vocabulary (keep this comment and the classes in step):
//   .yc-button [.yc-button--primary | --secondary (default) | --ghost | --danger] [.yc-button--sm]
//   .yc-input  .yc-textarea  .yc-select        — bordered fields on `inset`
//   .yc-card                                   — `panel` surface, `edge` border, radius lg
//   .yc-eyebrow  .yc-title  .yc-muted  .yc-faint — text roles
//   .yc-row (flex, gap 8)  .yc-stack (column, gap 12)  .yc-grid (auto-fit cards)
//   .yc-page                                   — padded, reading-width column

export const PAGE_KIT_CSS = `
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

.yc-page { max-width: 1100px; margin: 0 auto; padding: 16px; }
.yc-stack { display: flex; flex-direction: column; gap: 12px; }
.yc-row { display: flex; align-items: center; gap: 8px; }
.yc-row--end { justify-content: flex-end; }
.yc-row--between { justify-content: space-between; }
.yc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.yc-spacer { flex: 1; }

.yc-eyebrow { font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); }
.yc-title { font-size: 16px; font-weight: 500; color: var(--fg); }
.yc-muted { color: var(--fg-muted); }
.yc-dim { color: var(--fg-dim); }
.yc-faint { color: var(--fg-faint); }
.yc-small { font-size: 12px; }
.yc-caption { font-size: 11px; color: var(--fg-muted); }

.yc-card {
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: var(--radius-lg, 12px);
  padding: 16px;
}
.yc-card--inset { background: var(--inset); border-color: var(--edge-dim); }
.yc-well { background: var(--well); border: 1px solid var(--edge-dim); border-radius: var(--radius-md, 8px); padding: 12px; }
.yc-divider { border: 0; border-top: 1px solid var(--edge-dim); margin: 0; }

.yc-button {
  appearance: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 12px; font-weight: 500; line-height: 1.2;
  padding: 7px 12px;
  border-radius: var(--radius-md, 8px);
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
.yc-button--ghost { background: transparent; border-color: transparent; color: var(--fg-2); }
.yc-button--ghost:hover { background: var(--inset); border-color: transparent; color: var(--fg); }
.yc-button--danger { background: transparent; border-color: var(--destructive, currentColor); color: var(--destructive-fg, var(--fg)); }
.yc-button--danger:hover { background: var(--destructive, transparent); color: var(--on-destructive, var(--fg)); }
.yc-button--sm { font-size: 11px; padding: 4px 10px; }
.yc-button--full { width: 100%; }
.yc-button--icon { width: 28px; height: 28px; padding: 0; }
.yc-button--round { border-radius: var(--radius-full, 9999px); }

.yc-input, .yc-textarea, .yc-select {
  font: inherit; font-size: 14px; color: var(--fg);
  background: var(--inset);
  border: 1px solid var(--edge);
  border-radius: var(--radius-md, 8px);
  padding: 7px 10px;
  width: 100%;
}
.yc-input::placeholder, .yc-textarea::placeholder { color: var(--fg-muted); }
.yc-input:focus, .yc-textarea:focus, .yc-select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
.yc-textarea { min-height: 96px; resize: vertical; }
.yc-label { display: block; font-size: 12px; font-weight: 500; color: var(--fg-2); margin-bottom: 4px; }

.yc-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-sm, 4px);
  background: var(--inset); border: 1px solid var(--edge-dim); color: var(--fg-2);
}
.yc-pill { border-radius: var(--radius-full, 9999px); padding: 4px 12px; font-size: 14px; }
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
table.yc-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-muted); font-weight: 500; padding: 8px; border-bottom: 1px solid var(--edge); }
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
.yc-range { width: 100%; accent-color: var(--accent); }
.yc-swatches { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.yc-swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--edge); cursor: pointer; padding: 0; }
.yc-swatch--on { outline: 2px solid var(--fg); outline-offset: 2px; }
.yc-kbd { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: var(--radius-sm, 4px); background: var(--inset); border: 1px solid var(--edge-dim); color: var(--fg-2); }
.yc-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-2); }
.yc-badge::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--badge, var(--accent)); }

@media (prefers-reduced-motion: reduce) { .yc-button { transition: none; } }
`;
