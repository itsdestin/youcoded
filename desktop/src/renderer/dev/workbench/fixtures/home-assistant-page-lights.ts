// The Lights tab (Destin, 2026-10-05, round 2c, practice option "r1 Tall cards"), built for real. Kept apart from
// home-assistant-page.ts so neither file outgrows its line budget; HOME_LIGHTS_JS is pasted INSIDE the page's script
// (shares esc, isLight, isOn, gone, open, expanded, hidden, dragging, scenesBtn, scenesHtml, groupBright, paletteHtml,
// rangeHtml, pendHtml, colourOf, canWhite, dimmable, render ...). Template string: no backticks, no dollar-brace, no backslashes.
//
// WHAT IT DRAWS (Lights tab only; the Home tab and Edit keep the old cards):
//  - ONE card per room, titled "<Room> Lights", with the page's own round All button, palette scenes button, fold arrow and
//    room brightness bar. Cards start closed (the page's `open` set, as everywhere).
//  - Unfolded, each light is a portrait "tall card": bulb, name, percent and the colour dot on top, a thick brightness bar
//    along the bottom. Tapping the card switches the light. About three per line, two on a phone.
//  - The colour dot opens a floating glass panel that hangs off the light; it closes on a click outside it and on Escape.
//  - Unreachable lights go last in their card (even after a custom Edit order); a room whose lights are ALL unreachable goes
//    after every working room, dimmed.
// WHY the bars and buttons are the page's own (data-bright / data-toggle / data-expand / data-gbright): every press, the slider
// target model (home-assistant-page-pending.ts: no rubber-band) and the room bar's sync keep working unchanged.

export const HOME_LIGHTS_JS = `
  // ── Lights tab: tall cards ─────────────────────────────────────────────────
  // Unreachable lights always go last in their card, whatever order Edit chose (stable otherwise).
  function ltSort(list) {
    return list.map(function (x, i) { return [x, i]; }).sort(function (a, b) { return (gone(a[0]) ? 1 : 0) - (gone(b[0]) ? 1 : 0) || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  // A room with lights where NONE answers goes after every working room (stable otherwise).
  function ltDead(r) { var ls = r.items.filter(function (it) { return isLight(it) && !hidden.has(it.id); }); return ls.length > 0 && ls.every(gone); }
  function ltRooms(list) {
    return list.map(function (x, i) { return [x, i]; }).sort(function (a, b) { return (ltDead(a[0]) ? 1 : 0) - (ltDead(b[0]) ? 1 : 0) || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  function ltPct(it) { return it.brightness ? Math.max(1, Math.round(it.brightness / 2.55)) : 0; }
  function ltStatus(it) { return gone(it) ? 'Not responding' : !isOn(it) ? 'Off' : dimmable(it) ? ltPct(it) + '%' : 'On'; }
  function ltDot(it, on) {
    return !gone(it) && on && canWhite(it) ? '<button class="cbtn" style="--c:' + colourOf(it) + '" data-expand="' + esc(it.id) + '" aria-expanded="' + (expanded.has(it.id) ? 'true' : 'false') + '" aria-label="Colour of ' + esc(it.name) + '" title="Colour"></button>' : '';
  }
  // The colour panel: a small glass box that hangs off the light it belongs to.
  function ltPop(it) {
    var p = paletteHtml(it);
    return p ? '<div class="ltp" role="dialog" aria-label="Colour of ' + esc(it.name) + '"><div class="ltp-h">Colour of ' + esc(it.name) + '</div>' + p + '</div>' : '';
  }
  // One light: the Roomy rows' calm glass, shrunk to a portrait card (same tile markup, so the page's glow and press feel apply).
  function ltCell(it) {
    var na = gone(it), on = !na && isOn(it), pct = ltPct(it), dim = dimmable(it);
    if (dragging === it.id) { var le = document.querySelector('[data-bright="' + it.id + '"]'); if (le) pct = Number(le.value); }
    var r = on && dim ? rangeHtml(it, pct) : '';
    return '<div class="ltw' + (expanded.has(it.id) && on ? ' pop' : '') + '" data-slot="lt:' + esc(it.id) + '"><div class="tile lt-cell' + (on ? ' on' : '') + (na ? ' gone' : '') + '" data-eid="' + esc(it.id) + '" style="--c:' + colourOf(it) + '"><span class="glow"></span>' +
      '<div class="line"><button class="tile-face" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">' +
      '<span class="bulb">' + BULB + '</span><span class="name">' + esc(it.name) + '<div class="sub">' + esc(ltStatus(it)) + '</div></span></button>' + ltDot(it, on) + '</div>' + r + '</div>' + ltPop(it) + '</div>';
  }
  // The ONE card for a room on the Lights tab. The header is the page's own "All" button, unchanged.
  function ltRoom(room, items) {
    var lights = ltSort(items.filter(isLight));
    if (!lights.length) return '';
    var live = lights.filter(function (it) { return !gone(it); }), onList = live.filter(isOn), anyOn = onList.length > 0;
    var isOpen = open.has(room.id), c = anyOn ? colourOf(onList[0]) : 'rgb(255, 190, 110)', nGone = lights.length - live.length;
    var status = !live.length ? 'None responding' : (anyOn ? onList.length + ' of ' + live.length + ' on' : 'All off') + (nGone ? ' \\u00b7 ' + nGone + ' not responding' : '');
    var all = '<div class="tile all' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><div class="line">' +
      '<button class="tile-face" data-room="' + esc(room.id) + '" data-room-to="' + (anyOn ? 'off' : 'on') + '" aria-pressed="' + anyOn + '"' + (live.length ? '' : ' disabled') + ' aria-label="All lights in ' + esc(room.name) + ', ' + esc(status) + '">' +
      '<span class="bulb-col"><span class="bulb">' + BULB + '</span><span class="all-lbl">All</span></span>' +
      '<span class="name">' + esc(room.name) + ' Lights<div class="sub">' + esc(status) + '</div></span></button>' +
      scenesBtn(room) + '<button class="fold" data-fold="' + esc(room.id) + '" aria-expanded="' + isOpen + '" aria-label="' + (isOpen ? 'Hide' : 'Show') + ' each light in ' + esc(room.name) + '" title="' + (isOpen ? 'Hide each light' : 'Show each light') + '">' + CHEVRON + '</button></div>' +
      groupBright(room, live, onList, c) + pendHtml('room:' + room.id) + '</div>';
    var body = '', popped = false;
    if (isOpen) {
      popped = lights.some(function (it) { return expanded.has(it.id) && isOn(it) && !gone(it); });
      body = '<div class="lt-grid">' + lights.map(ltCell).join('') + '</div>';
    }
    var pend = !isOpen ? '' : lights.map(function (it) { return pendHtml(it.id); }).join('');
    return '<section class="yc-card room lt' + (anyOn ? ' on' : '') + (isOpen ? ' is-open' : '') + (popped ? ' has-pop' : '') + (live.length ? '' : ' dead') + '" style="--c:' + c + '" data-lt="' + esc(room.id) + '"><span class="glow"></span>' +
      all + scenesHtml(room) + body + (pend ? '<div class="lt-pend">' + pend + '</div>' : '') + '</section>';
  }
  // Keeps a colour panel inside its card: after a redraw, nudge it sideways if it would poke out.
  function ltAfter() {
    var ps = document.querySelectorAll('.ltp');
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], card = p.closest('.lt');
      if (!card) continue;
      p.style.setProperty('--dx', '0px');
      var pr = p.getBoundingClientRect(), cr = card.getBoundingClientRect(), dx = 0;
      if (pr.right > cr.right - 6) dx = cr.right - 6 - pr.right;
      if (pr.left + dx < cr.left + 6) dx = cr.left + 6 - pr.left;
      p.style.setProperty('--dx', dx + 'px');
    }
  }
  // The colour panel closes on a click outside it, and on Escape. Only on the Lights tab: the Home tab's inline palettes are unchanged.
  // WHY a press on another colour dot closes the first panel (one open at a time), and opening the Lights tab starts with none
  // (palettes always start closed, Destin 2026-10-04).
  document.addEventListener('click', function (e) {
    var t = e.target, c = t && t.closest ? t : null;
    if (c && c.closest('[data-view="lights"]')) { expanded.clear(); return; }
    if (view !== 'lights' || editing || !expanded.size || !c) return;
    if (c.closest('.ltp')) return;
    var dot = c.closest('.cbtn'), keep = dot ? dot.getAttribute('data-expand') : null;
    Array.from(expanded).forEach(function (id) { if (id !== keep) expanded.delete(id); });
    if (!dot) render();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && view === 'lights' && !editing && expanded.size) { e.preventDefault(); expanded.clear(); render(); } // WHY preventDefault: the frame sends Escape on to the app (back to chat) unless the page used it
  });
`;

export const HOME_LIGHTS_CSS = `
  /* Lights tab: wider columns than the Home tab's, since one card per room carries a longer title. */
  /* WHY a grid, not columns (U10, UX review 2): CSS columns re-balance when a card gets shorter or taller, so turning a room off
     made Living Room and Kitchen swap places while the person was looking. A grid keeps every card in its order and place;
     a card changing height only moves what is below it. Cards keep their own bottom gap (the base .room margin). */
  #view .rooms { columns: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(440px, 100%), 1fr)); column-gap: 12px; align-items: start; }
  /* overflow stays visible so a colour panel can hang outside the card; the glow rounds itself instead. */
  .lt { position: relative; gap: 12px; }
  .lt > .glow { position: absolute; inset: 0; border-radius: inherit; background: radial-gradient(120% 90% at 0% 0%, var(--c), transparent 72%); opacity: 0; pointer-events: none; transition: opacity 200ms ease; }
  .lt.on > .glow { opacity: .16; }
  .lt > :not(.glow) { position: relative; }
  .lt.has-pop { z-index: 6; }
  .lt.dead { opacity: .6; }
  /* The page's own All tile, with the chrome of a separate tile removed so it reads as the card's header. */
  .lt > .tile.all { border: 0; border-radius: 0; background: transparent; box-shadow: none; padding: 0; overflow: visible; }
  .lt > .tile.all .glow { display: none; }
  .lt .tile.all .name { white-space: normal; overflow: visible; overflow-wrap: anywhere; font-weight: 600; }
  .lt .tile.all > .lr { margin-top: 10px; }
  /* One slider look for the room bar and every light bar: a round-capped fill with the handle inside its end
     (the handle stays attached at every value); --h is the bar's height. */
  .lt .lr { --h: 32px; height: var(--h); border-radius: calc(var(--h) / 2); box-shadow: inset 0 1px 3px rgba(0,0,0,.3);
    background:
      radial-gradient(circle at center, var(--c, var(--accent)) calc(var(--h) / 2 - .5px), transparent calc(var(--h) / 2)) calc(var(--v, 0) * 1%) 0 / var(--h) var(--h) no-repeat,
      linear-gradient(to right, var(--c, var(--accent)) calc(var(--h) / 2 + (100% - var(--h)) * var(--v, 0) / 100), var(--well) 0); }
  .lt .lr::-webkit-slider-thumb { width: var(--h); height: var(--h); margin: 0; border-radius: 50%; border: 0; box-sizing: border-box; cursor: grab;
    background: radial-gradient(circle, #fff calc(var(--h) / 2 - 3.5px), rgba(255,255,255,0) calc(var(--h) / 2 - 3px)); filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
  .lt .scenes { margin: 0; }
  .lt-pend { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .lt .pend { position: static; max-width: 100%; }
  .lt .gone { opacity: .55; }
  .lt .fold:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 520px) { .lt .scn, .lt .fold { width: 30px; height: 30px; } }
  /* The tall cards: about three per line, two on a phone. A cell is as tall as its row, so an unreachable light is not a stub. */
  .lt-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .ltw { position: relative; min-width: 0; display: flex; flex-direction: column; }
  .ltw > .tile { flex: 1; }
  .lt-cell { min-width: 0; min-height: 140px; padding: 12px; gap: 10px; border-radius: 18px; background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  .lt-cell .line { flex: 1; align-items: stretch; }
  .lt-cell .tile-face { flex-direction: column; align-items: flex-start; justify-content: space-between; gap: 8px; align-self: stretch; }
  .lt-cell .bulb { width: 38px; height: 38px; }
  .lt-cell .name { flex: 0 0 auto; width: 100%; font-size: 15px; font-weight: 600; white-space: normal; line-height: 1.25; }
  .lt-cell .name .sub { margin-top: 2px; white-space: nowrap; }
  .lt-cell .lr { --h: 30px; height: 30px; }
  .lt-cell .cbtn { position: absolute; top: 0; right: 0; width: 28px; height: 28px; flex-shrink: 0; }
  .lt-cell.gone .name { color: var(--fg-muted); }
  /* The glass colour panel: theme panel colour, soft edge, a short fade-and-grow (opacity and transform only). */
  .ltp { position: absolute; z-index: 20; top: calc(100% + 8px); left: 0; translate: var(--dx, 0px) 0; width: 264px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 10px 12px 12px; border-radius: 16px;
    background: color-mix(in srgb, var(--panel) 90%, transparent); -webkit-backdrop-filter: blur(16px) saturate(1.2); backdrop-filter: blur(16px) saturate(1.2);
    border: 1px solid var(--edge); box-shadow: 0 18px 40px -12px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.08); transform-origin: 16px 0; animation: ltp-in 140ms ease-out; }
  .ltp-h { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); margin-bottom: 8px; }
  .ltp .palette { padding: 0; border: 0; background: transparent; }
  @keyframes ltp-in { from { opacity: 0; transform: translateY(-4px) scale(.96); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .ltp { animation: none; } .lt > .glow { transition: none; } }
`;
