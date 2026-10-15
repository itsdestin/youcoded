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
//
// Dropdowns (the kit's `.yc-menu`): write a plain `<select class="yc-select">` with its
// `<option>`s. PAGE_KIT_JS (below) opens every single-choice `<select>` in the app's own
// menu look instead of the browser's white list; the `<select>` stays the real control, so
// `.value`, `selectedIndex` and the `change` event work exactly as before. An action at the
// foot of the list ("Add another option…") is an `<option data-yc-action>`: it is drawn below
// the choices behind the tapered line, and choosing it sets the value and fires `change`
// like any option — the page's handler does the action and sets the value back.

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
  background: linear-gradient(to right, transparent, color-mix(in srgb, var(--edge) 82%, var(--fg) 18%) 8%, color-mix(in srgb, var(--edge) 82%, var(--fg) 18%) 92%, transparent); }
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

@media (prefers-reduced-motion: reduce) { .yc-button, .yc-select, select.yc-menu { transition: none; } }
`;

/** The kit's dropdown, as a script the host puts into every page after the bootstrap
 *  (page-theme.ts prepareHostedDocument). It opens every single-choice `<select>` in the
 *  `.yc-menu` list above instead of the browser's own list.
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
 *  No backticks or dollar-brace in here: this is a template literal. */
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
})();`;
