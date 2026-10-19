// Workbench only: one page that shows every piece of the Pages style kit Destin picked on
// pages-kit-questions (2026-10-16) — the status pill, the notice box with its Details fold, the
// loading line, the full-screen error, the switch, the search box beside filter chips, the fold
// row, the inner box, the one-line chip row, the outlined button, the tapered divider, the raised
// card, the scroll fade, and the dropdown with its "Add another…" foot action (moved here from the
// removed Week planner sample, 2026-10-16) — so the kit can be photographed in every theme and at phone width.
//
// WHY its own page, listed only with `?pagesKit=` (mock-shim.ts): the sample Pages stay exactly as
// they are (K-5 "leave"), and the Pages list on every other screen keeps its cards.
//
// Written the way the page-builder skill tells an author to write a page: kit classes only, its
// sections as `.yc-section`s so the phone width folds them (the first open). `data.open` (set by
// `?pagesKit=<section>`) opens another section first, so each one can be photographed at phone
// width.
import type { PageDocument } from '../../../../shared/pages-types';

const KIT_PIECES_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Kit pieces</title>
<style>
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: start; }
  .set { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .set > div { flex: 1; min-width: 0; }
  .set b { display: block; font-size: 12px; font-weight: 500; }
  .set span { display: block; font-size: 11px; color: var(--fg-muted); }
  .list { max-height: 132px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .list > div { display: flex; justify-content: space-between; padding: 6px 8px; font-size: 13px; }
  .filters .yc-search { flex: 0 0 180px; }
</style></head>
<body>
<div class="yc-page yc-stack">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">Recipes</div><h1>Kit pieces</h1></div>
    <div class="yc-row"><button class="yc-button yc-button--ghost">Preview</button><button class="yc-button yc-button--primary">Save</button></div>
  </div>

  <div class="cols">
    <div class="yc-stack" style="gap:16px">
      <details class="yc-section" id="s-status" open>
        <summary>Status and notices</summary>
        <div class="yc-card yc-stack">
          <div class="yc-row" style="flex-wrap:wrap">
            <span class="yc-status yc-status--ok">Installed</span>
            <span class="yc-status yc-status--warning">Needed</span>
            <span class="yc-status yc-status--danger">Failed</span>
            <span class="yc-status yc-status--info">New</span>
            <span class="yc-status">Draft</span>
          </div>
          <div class="yc-row" style="flex-wrap:wrap">
            <span class="yc-status yc-status--ok yc-status--dot">Online</span>
            <span class="yc-status yc-status--info yc-status--dot">Working</span>
            <span class="yc-status yc-status--dot">Offline</span>
          </div>
          <div class="yc-notice">Pages follow your theme, so a page made today matches the one you pick tomorrow.</div>
          <div class="yc-notice yc-notice--warning yc-notice--slim">
            <div class="yc-notice__text">This list is almost full.</div>
            <div class="yc-notice__actions"><button class="yc-button yc-button--sm yc-button--ghost">Clean up</button></div>
          </div>
          <div class="yc-notice yc-notice--danger" role="alert">
            <div class="yc-notice__text">Your groceries couldn't be saved. Your changes are still here.</div>
            <details class="yc-fold yc-notice__details"><summary>Details</summary><code>ENOSPC: no space left on device, write 'data.json'</code></details>
            <div class="yc-notice__actions"><button class="yc-button yc-button--sm yc-button--ghost">Not now</button><button class="yc-button yc-button--sm yc-button--primary">Try again</button></div>
          </div>
          <div class="yc-loading">Loading your recipes…</div>
        </div>
      </details>

      <details class="yc-section" id="s-controls">
        <summary>Controls</summary>
        <div class="yc-card yc-stack">
          <div class="yc-row filters">
            <label class="yc-search"><input type="search" placeholder="Search recipes" aria-label="Search recipes"></label>
            <div class="yc-chips" role="group" aria-label="Meal">
              <button class="yc-filter" aria-pressed="true">All</button>
              <button class="yc-filter" aria-pressed="false">Breakfast</button>
              <button class="yc-filter" aria-pressed="false">Lunch</button>
              <button class="yc-filter" aria-pressed="false">Dinner</button>
              <button class="yc-filter" aria-pressed="false">Snacks</button>
              <button class="yc-filter" aria-pressed="false">Desserts</button>
            </div>
          </div>
          <div class="yc-box" style="padding-top:4px;padding-bottom:4px">
            <div class="set"><div><b>Remind me each morning</b><span>A note at 8:00 with today's meals.</span></div>
              <button class="yc-switch" role="switch" aria-checked="true" aria-label="Remind me each morning"></button></div>
            <div class="set"><div><b>Show finished recipes</b><span>Keep cooked ones in the list.</span></div>
              <button class="yc-switch" role="switch" aria-checked="false" aria-label="Show finished recipes"></button></div>
            <div class="set"><div><b>Share with family</b><span>Needs a family group first.</span></div>
              <button class="yc-switch" role="switch" aria-checked="false" aria-label="Share with family" disabled></button></div>
          </div>
          <div><label class="yc-label" for="k-meal">Meal</label><select class="yc-select" id="k-meal"><option value="breakfast">Breakfast</option><option value="lunch">Lunch</option><option value="dinner" selected>Dinner</option><option value="snacks">Snacks</option><option value="__new" data-yc-action>Add another meal…</option></select><input class="yc-input" id="k-newmeal" placeholder="New meal, then Enter" aria-label="New meal" hidden></div>
          <div class="yc-row yc-row--end"><button class="yc-button">Duplicate</button><button class="yc-button yc-button--ghost">Cancel</button><button class="yc-button yc-button--primary">Add recipe</button></div>
        </div>
      </details>
    </div>

    <div class="yc-stack" style="gap:16px">
      <details class="yc-section" id="s-layout">
        <summary>Layout</summary>
        <div class="yc-card yc-stack" style="gap:8px">
          <div class="yc-row yc-row--between"><span class="yc-title">Lemon pasta</span><span class="yc-status yc-status--ok">Saved</span></div>
          <div class="yc-chips"><span class="yc-chip">@destin</span><span class="yc-chip">Dinner</span><span class="yc-chip">12 steps</span><span class="yc-chip">Serves 4</span><span class="yc-chip">Vegetarian</span><span class="yc-chip">25 minutes</span><span class="yc-chip">Saved 3 days ago</span></div>
          <p class="yc-muted yc-small">Bright, quick and made from what is already in the cupboard.</p>
          <hr class="yc-divider">
          <div class="yc-box list">
            <div><span>Spaghetti</span><span class="yc-muted">400 g</span></div>
            <div><span>Lemons</span><span class="yc-muted">2</span></div>
            <div><span>Parmesan</span><span class="yc-muted">80 g</span></div>
            <div><span>Butter</span><span class="yc-muted">40 g</span></div>
            <div><span>Black pepper</span><span class="yc-muted">to taste</span></div>
            <div><span>Basil</span><span class="yc-muted">a handful</span></div>
            <div><span>Salt</span><span class="yc-muted">for the water</span></div>
            <div><span>Olive oil</span><span class="yc-muted">2 tbsp</span></div>
          </div>
          <details class="yc-fold"><summary>Advanced options <span class="yc-fold__hint">Rarely needed</span></summary><p class="yc-small yc-muted">Scale the recipe, or change units.</p></details>
          <details class="yc-fold" open><summary>Shopping notes</summary><p class="yc-small">Buy unwaxed lemons; the zest goes in the sauce.</p></details>
        </div>
      </details>

      <details class="yc-section" id="s-error">
        <summary>When a whole screen can't load</summary>
        <div class="yc-card" style="padding:0 0 1px">
          <div class="yc-screen-error" role="alert" style="margin-top:24px;margin-bottom:24px">
            <div class="yc-notice__text"><span class="yc-notice__title">Your recipes couldn't load</span>The saved list could not be read. Nothing was lost.</div>
            <details class="yc-fold yc-notice__details"><summary>Details</summary><code>SyntaxError: Unexpected end of JSON input</code></details>
            <div class="yc-notice__actions"><button class="yc-button yc-button--primary">Try again</button><button class="yc-button yc-button--ghost">Report bug</button></div>
          </div>
        </div>
      </details>
    </div>
  </div>
</div>
<script>
  // Workbench only: open another section first (\`?pagesKit=<section>\`, mock-shim.ts) so each can be
  // photographed at phone width, where only the open one shows.
  var saved = window.youcoded && window.youcoded.data;
  if (saved && saved.open) {
    var want = document.getElementById('s-' + saved.open);
    if (want) { document.getElementById('s-status').open = false; want.open = true; }
  }
  // The kit dropdown's foot action (page-kit.ts PAGE_KIT_JS, \`data-yc-action\`): choosing
  // "Add another meal…" fires change like any option, so the page puts the meal back and asks for
  // the new name in a box; Enter adds it to the list and picks it.
  var meal = document.getElementById('k-meal'), newMeal = document.getElementById('k-newmeal'), lastMeal = meal.value;
  meal.onchange = function () {
    if (meal.value !== '__new') { lastMeal = meal.value; return; }
    meal.value = lastMeal; newMeal.hidden = false; newMeal.focus();
  };
  newMeal.onkeydown = function (ev) {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    var name = newMeal.value.trim(); newMeal.value = ''; newMeal.hidden = true;
    if (!name) return;
    var o = document.createElement('option'); o.value = name.toLowerCase(); o.textContent = name;
    meal.insertBefore(o, meal.querySelector('[data-yc-action]'));
    meal.value = lastMeal = o.value;
  };
  // Workbench only: \`?pagesMenu=kind\` (mock-shim.ts) opens the Meal list, so the open kit dropdown
  // is a screen of its own (screens/pages.ts, #menu-open). WHY a press on the select: that is
  // exactly what opens it for a person; the page frame is out of reach of the screenshot tool's
  // clicks. Its section opens first so the list also shows at phone width.
  if (saved && saved.demoMenu) {
    document.getElementById('s-controls').open = true;
    // WHY load, not a timer: the frame must be able to take focus (Escape belongs to its menu),
    // and the requested state must exist when loading finishes, not 300 ms after it.
    window.addEventListener('load', function () {
      document.getElementById(saved.demoMenu).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    }, { once: true });
  }
  // The filter chips are the page's own: one meal at a time, as an author would write them.
  document.querySelectorAll('.yc-filter').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.yc-filter').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    });
  });
</script>
</body></html>`;

/** The kit showcase, opening `open` first at phone width when given. */
export function kitPiecesPage(open: string | null): PageDocument {
  return {
    id: 'page-kit-pieces',
    name: 'Kit pieces',
    description: 'Every piece of the Pages style kit on one page.',
    icon: 'list',
    home: { kind: 'personal' },
    pinned: false,
    updatedAt: '2026-10-16T09:00:00.000Z',
    htmlStamp: 1792141200000,
    html: KIT_PIECES_HTML,
    data: open ? { open } : null,
  };
}
