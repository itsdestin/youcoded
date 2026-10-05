// Design options for the "lights-tab" task of the Home page redesign, ROUND 2b. Keys are
// "<option>" or "<option>-<state>"; each becomes the practice screen
// pages/page/page-home#v-lights-tab-<key>. See types.ts.
//
// Round 2 verdicts (Destin): keep the page's EXISTING room control as it is (the round "All" bulb
// button, the palette scenes button, the fold arrow, the room bar); no separate "All off" button.
// He liked the room strip and the tile grid, not the mixer, and asked for more of those two kinds.
// Colour: in-card menu for rows; a small glass pop-over anchored to the light for the tile-like kinds.
// A room is ONE card ("Destin's Room Lights"), unreachable lights last in it, all-unreachable rooms
// last on the tab. The three kinds differ in how the open card shows each light:
//   rows   "Roomy rows"   one wide row per light: bulb, name, percent, a thick bar, the colour menu inside the card
//   tiles  "Big tiles"    two big tiles per row, the fill shows brightness; tap switches, drag sideways dims;
//                         the colour dot opens a pop-over
//   chips  "Chips"        a wrapped line of small chips (tap switches); the small arrow on a chip opens it into a
//                         full-width panel with its bar and colour pop-over
import type { HomeVariants } from './types';

// The page's own functions are reached from inside its script, so this block is pasted into it by
// `transform` just before roomHtml (WHY: CSS/JS appended after the page cannot see esc, isOn, gone,
// open, scenesBtn, groupBright, paletteHtml ... which live inside the page's closure).
// Plain ES5, no backticks, no dollar-brace.
const LT_CODE = String.raw`
  var LT_KIND = '__KIND__', LT_GONE = __GONE__, ltSel = __SEL__;
  // Practice-only: make a room's lights unreachable so the "sort to the end" rule can be seen.
  function ltMutate(rs) { rs.forEach(function (r) { if (LT_GONE.indexOf(r.id) >= 0) r.items.forEach(function (x) { if (isLight(x)) { x.state = 'unavailable'; } }); }); }
  // Unreachable lights always go last in their card, whatever order was chosen in Edit.
  function ltSort(list) {
    return list.map(function (x, i) { return [x, i]; }).sort(function (a, b) { return (gone(a[0]) ? 1 : 0) - (gone(b[0]) ? 1 : 0) || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  // A room whose lights are ALL unreachable goes after every working room (stable otherwise).
  function ltRooms(list) {
    var dead = function (r) { var ls = r.items.filter(function (it) { return isLight(it) && !hidden.has(it.id); }); return ls.length > 0 && ls.every(gone); };
    return list.map(function (x, i) { return [x, i]; }).sort(function (a, b) { return (dead(a[0]) ? 1 : 0) - (dead(b[0]) ? 1 : 0) || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  function ltPct(it) { return it.brightness ? Math.max(1, Math.round(it.brightness / 2.55)) : 0; }
  function ltStatus(it) { return gone(it) ? 'Not responding' : !isOn(it) ? 'Off' : dimmable(it) ? ltPct(it) + '%' : 'On'; }
  function ltDot(it, on) {
    return !gone(it) && on && canWhite(it) ? '<button class="cbtn" style="--c:' + colourOf(it) + '" data-expand="' + esc(it.id) + '" aria-expanded="' + (expanded.has(it.id) ? 'true' : 'false') + '" aria-label="Colour of ' + esc(it.name) + '" title="Colour"></button>' : '';
  }
  // The colour pop-over: a small glass panel that hangs off the light it belongs to (tiles and chips only).
  function ltPop(it, up) {
    var p = paletteHtml(it);
    return p ? '<div class="ltp' + (up ? ' up' : '') + '" role="dialog" aria-label="Colour of ' + esc(it.name) + '"><div class="ltp-h">Colour of ' + esc(it.name) + '</div>' + p + '</div>' : '';
  }
  // Big tile (option tiles): the whole tile switches the light; sliding it sideways dims it.
  function ltTile(it) {
    var na = gone(it), on = !na && isOn(it), pct = ltPct(it), dim = dimmable(it);
    if (dragging === it.id) { var le = document.querySelector('[data-bright="' + it.id + '"]'); if (le) pct = Number(le.value); }
    var r = on && dim ? rangeHtml(it, pct).replace('class="lr"', 'class="lr ltt-r"') : '';
    return '<div class="ltw' + (expanded.has(it.id) && on ? ' pop' : '') + '"><div class="ltt' + (on ? ' on' : '') + (na ? ' gone' : '') + '" data-eid="' + esc(it.id) + '" style="--c:' + colourOf(it) + ';--v:' + (on ? pct : 0) + '">' +
      '<button class="ltt-face" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">' +
      '<span class="bulb">' + BULB + '</span><span class="pc">' + esc(ltStatus(it)) + '</span><span class="nm">' + esc(it.name) + '</span></button>' + ltDot(it, on) + r + '</div>' + ltPop(it, false) + '</div>';
  }
  // Chip (option chips): small, one line. Tap switches; the little arrow opens it into a full-width panel.
  function ltChip(it) {
    var na = gone(it), on = !na && isOn(it), pct = ltPct(it), dim = dimmable(it);
    var more = !na && on && (dim || canWhite(it));
    var sel = more && ltSel === it.id;
    if (dragging === it.id) { var le = document.querySelector('[data-bright="' + it.id + '"]'); if (le) pct = Number(le.value); }
    var face = '<button class="ltc-face" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '"><span class="bulb">' + BULB + '</span><span class="nm">' + esc(it.name) + '</span><span class="pc">' + esc(na ? 'Not responding' : ltStatus(it)) + '</span></button>';
    var arrow = more ? '<button class="ltc-more" data-ltx="' + esc(it.id) + '" aria-expanded="' + sel + '" aria-label="' + (sel ? 'Close' : 'Open') + ' settings for ' + esc(it.name) + '" title="Brightness and colour">' + CHEVRON + '</button>' : '';
    var ex = sel ? '<div class="ltc-ex">' + (dim ? rangeHtml(it, pct) : '<div class="ltc-only">This light only switches on and off.</div>') + (canWhite(it) ? '<div class="ltw' + (expanded.has(it.id) ? ' pop' : '') + '">' + ltDot(it, on) + ltPop(it, true) + '</div>' : '') + '</div>' : '';
    return '<div class="ltc' + (on ? ' on' : '') + (na ? ' gone' : '') + (sel ? ' sel' : '') + '" data-eid="' + esc(it.id) + '" style="--c:' + colourOf(it) + '"><div class="ltc-row">' + face + arrow + '</div>' + ex + '</div>';
  }
  // The ONE card for a room on the Lights tab. The header is the page's own "All" tile, unchanged.
  function ltRoom(room, items, ctx) {
    var lights = ltSort(items.filter(isLight));
    if (!lights.length) return '';
    var live = lights.filter(function (it) { return !gone(it); }), onList = live.filter(isOn), anyOn = onList.length > 0;
    var isOpen = open.has(room.id), c = anyOn ? colourOf(onList[0]) : 'rgb(255, 190, 110)', nGone = lights.length - live.length;
    var status = !live.length ? 'None responding' : (anyOn ? onList.length + ' of ' + live.length + ' on' : 'All off') + (nGone ? ' · ' + nGone + ' not responding' : '');
    var all = '<div class="tile all' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><div class="line">' +
      '<button class="tile-face" data-room="' + esc(room.id) + '" data-room-to="' + (anyOn ? 'off' : 'on') + '" aria-pressed="' + anyOn + '"' + (live.length ? '' : ' disabled') + ' aria-label="All lights in ' + esc(room.name) + ', ' + esc(status) + '">' +
      '<span class="bulb-col"><span class="bulb">' + BULB + '</span><span class="all-lbl">All</span></span>' +
      '<span class="name">' + esc(room.name) + ' Lights<div class="sub">' + esc(status) + '</div></span></button>' +
      scenesBtn(room) + '<button class="fold" data-fold="' + esc(room.id) + '" aria-expanded="' + isOpen + '" aria-label="' + (isOpen ? 'Hide' : 'Show') + ' each light in ' + esc(room.name) + '" title="' + (isOpen ? 'Hide each light' : 'Show each light') + '">' + CHEVRON + '</button></div>' +
      groupBright(room, live, onList, c) + pendHtml('room:' + room.id) + '</div>';
    var body = '', popped = false;
    if (isOpen) {
      popped = LT_KIND !== 'rows' && lights.some(function (it) { return expanded.has(it.id) && isOn(it) && !gone(it); });
      if (LT_KIND === 'rows') body = '<div class="lt-rows">' + lights.map(function (it) { return itemHtml(it, ctx); }).join('') + '</div>';
      else if (LT_KIND === 'tiles') body = '<div class="lt-grid">' + lights.map(ltTile).join('') + '</div>';
      else body = '<div class="lt-chips">' + lights.map(ltChip).join('') + '</div>';
    }
    var pend = LT_KIND === 'rows' || !isOpen ? '' : lights.map(function (it) { return pendHtml(it.id); }).join('');
    return '<section class="yc-card room lt lt-k-' + LT_KIND + (anyOn ? ' on' : '') + (isOpen ? ' is-open' : '') + (popped ? ' has-pop' : '') + '" style="--c:' + c + '" data-lt="' + esc(room.id) + '"><span class="glow"></span>' +
      all + scenesHtml(room) + body + (pend ? '<div class="lt-pend">' + pend + '</div>' : '') + '</section>';
  }
  // Pop-overs close on a click outside them, and on Escape. Rows keep their in-card menu, so they are left alone.
  document.addEventListener('click', function (e) {
    var x = e.target.closest && e.target.closest('button[data-ltx]');
    if (x) { var id = x.getAttribute('data-ltx'); ltSel = ltSel === id ? null : id; expanded.clear(); render(); return; }
    if (LT_KIND === 'rows' || !expanded.size) return;
    if (e.target.closest && (e.target.closest('.ltp') || e.target.closest('.cbtn'))) return;
    expanded.clear(); render();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || LT_KIND === 'rows') return;
    if (expanded.size) { expanded.clear(); render(); } else if (ltSel) { ltSel = null; render(); }
  });
`;

const ROOM_HTML_HEAD = 'function roomHtml(room, roomIds, forceOpen) {';
const CTX_LINE = "var ctx = { key: key, ids: items.map(function (x) { return x.id; }) };";
const IDS_LINE = 'var ids = list.map(function (r) { return r.id; });';

// WHY exact-text swaps (not CSS): the Lights tab draws through roomHtml/viewHtml, which only the page's own
// script can change. Each swap is checked, so a page edit that moves these lines makes the screen fail loudly
// instead of silently showing today's page.
function transformFor(kind: string, gone: string[] = [], sel: string | null = null) {
  return (html: string): string => {
    for (const s of [ROOM_HTML_HEAD, CTX_LINE, IDS_LINE]) {
      if (html.split(s).length !== 2) throw new Error('lights-tab variant: page text changed, cannot find: ' + s);
    }
    const code = LT_CODE.replace('__KIND__', kind).replace('__GONE__', JSON.stringify(gone)).replace('__SEL__', JSON.stringify(sel));
    return html
      .replace(ROOM_HTML_HEAD, () => code + '\n  ' + ROOM_HTML_HEAD)
      .replace(CTX_LINE, () => CTX_LINE + " if (forceOpen && !editing) return ltRoom(room, items, ctx);")
      // WHY the practice-only mutation runs at draw time, not at load: later live updates would put the real
      // states back; the item objects are shared with the rows, so the rows see it too.
      .replace(IDS_LINE, () => "if (view === 'lights') { ltMutate(rooms); list = ltRooms(list); } " + IDS_LINE);
  };
}

// ── Shared look (theme variables only) ──────────────────────────────────────────────────────────
const CSS_BASE = String.raw`
  /* Wider columns than the Home tab's 340 px: one card per room carries a longer title. */
  #view .rooms { columns: 440px; }
  /* overflow stays visible so a colour pop-over can hang outside the card; the glow rounds itself instead. */
  .lt { position: relative; gap: 12px; }
  .lt > .glow { position: absolute; inset: 0; border-radius: inherit; background: radial-gradient(120% 90% at 0% 0%, var(--c), transparent 72%); opacity: 0; pointer-events: none; }
  .lt.on > .glow { opacity: .16; }
  .lt > :not(.glow) { position: relative; }
  .lt.has-pop { z-index: 6; }
  /* The page's own All tile, with the chrome of a separate tile removed so it reads as the card's header. */
  .lt > .tile.all { border: 0; border-radius: 0; background: transparent; box-shadow: none; padding: 0; overflow: visible; }
  .lt > .tile.all .glow { display: none; }
  .lt .tile.all .name { white-space: normal; overflow: visible; overflow-wrap: anywhere; font-weight: 600; }
  .lt .tile.all > .lr { margin-top: 10px; }
  /* One slider look for the room bar and every light bar: a round-capped fill with the handle inside its end
     (the handle stays attached at every value); --h is the bar's height, so it can be thick or slim. */
  .lt .lr { --h: 32px; height: var(--h); border-radius: calc(var(--h) / 2); box-shadow: inset 0 1px 3px rgba(0,0,0,.3);
    background:
      radial-gradient(circle at center, var(--c, var(--accent)) calc(var(--h) / 2 - .5px), transparent calc(var(--h) / 2)) calc(var(--v, 0) * 1%) 0 / var(--h) var(--h) no-repeat,
      linear-gradient(to right, var(--c, var(--accent)) calc(var(--h) / 2 + (100% - var(--h)) * var(--v, 0) / 100), var(--well) 0); }
  .lt .lr::-webkit-slider-thumb { width: var(--h); height: var(--h); margin: 0; border-radius: 50%; border: 0; box-sizing: border-box; cursor: grab;
    background: radial-gradient(circle, #fff calc(var(--h) / 2 - 3.5px), rgba(255,255,255,0) calc(var(--h) / 2 - 3px)); filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
  .lt .scenes { margin: 0; }
  .lt-pend { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .lt .pend { position: static; max-width: 100%; }
  .lt .cbtn { width: 26px; height: 26px; }
  .lt .gone { opacity: .55; }
  /* The glass pop-over: theme panel colour, soft edge, a short fade-and-grow (opacity and transform only). */
  .ltw { position: relative; }
  .ltp { position: absolute; z-index: 20; top: calc(100% + 8px); left: 0; translate: var(--dx, 0px) 0; width: 264px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 10px 12px 12px; border-radius: 16px;
    background: color-mix(in srgb, var(--panel) 90%, transparent); -webkit-backdrop-filter: blur(16px) saturate(1.2); backdrop-filter: blur(16px) saturate(1.2);
    border: 1px solid var(--edge); box-shadow: 0 18px 40px -12px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.08); transform-origin: 16px 0; animation: ltp-in 140ms ease-out; }
  .ltp.up { top: auto; bottom: calc(100% + 8px); right: 0; left: auto; transform-origin: calc(100% - 16px) 100%; }
  .ltp-h { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); margin-bottom: 8px; }
  .ltp .palette { padding: 0; border: 0; background: transparent; }
  @keyframes ltp-in { from { opacity: 0; transform: translateY(-4px) scale(.96); } to { opacity: 1; transform: none; } }
  .ltp.up { animation-name: ltp-in-up; }
  @keyframes ltp-in-up { from { opacity: 0; transform: translateY(4px) scale(.96); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .ltp { animation: none; } }
  .lt .fold:focus-visible, .ltc-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 520px) { .lt .scn, .lt .fold { width: 30px; height: 30px; } }
`;

// ── rows: Roomy rows ────────────────────────────────────────────────────────────────────────────
// The page's own light rows, but loose: tall, with a thick bar, and no card inside the card.
const CSS_ROWS = String.raw`
  .lt-rows { display: flex; flex-direction: column; gap: 8px; }
  .lt-rows .tile { padding: 12px 16px 14px; gap: 10px; border-radius: 18px; background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  .lt-rows .tile .bulb { width: 40px; height: 40px; }
  .lt-rows .tile .name { font-size: 15px; font-weight: 600; }
  .lt-rows .tile .lr { --h: 34px; height: 34px; }
  .lt-rows .tile .cbtn { width: 30px; height: 30px; }
  .lt-rows .tile.gone .name { color: var(--fg-muted); }
`;

// ── tiles: Big tiles ────────────────────────────────────────────────────────────────────────────
const CSS_TILES = String.raw`
  .lt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .ltt { position: relative; min-height: 124px; border-radius: 20px; overflow: hidden; touch-action: pan-y; user-select: none; -webkit-user-select: none;
    border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  /* The fill shows how bright the light is: it grows from the left as the tile is dragged sideways. */
  .ltt.on { border-color: color-mix(in srgb, var(--c) 55%, transparent); box-shadow: 0 10px 24px -14px var(--c);
    background: linear-gradient(to right, color-mix(in srgb, var(--c) 42%, transparent) calc(var(--v, 0) * 1%), color-mix(in srgb, var(--fg) 5%, var(--panel)) 0); }
  .ltt.drag { cursor: ew-resize; }
  .ltt-face { appearance: none; font: inherit; color: inherit; text-align: left; background: none; border: 0; cursor: pointer; width: 100%; height: 100%; min-height: 124px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; gap: 4px; }
  .ltt-face:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  .ltt-face .bulb { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--well); color: var(--fg-muted); }
  .ltt.on .bulb { background: var(--c); color: #1a1a1a; box-shadow: 0 0 16px var(--c); }
  .ltt .pc { font-size: 24px; font-weight: 600; line-height: 1; color: var(--fg); margin-top: auto; }
  .ltt.gone .pc { font-size: 12px; font-weight: 400; color: var(--fg-muted); }
  .ltt .nm { font-size: 13px; font-weight: 600; line-height: 1.2; color: var(--fg-2); }
  .ltt .cbtn { position: absolute; top: 14px; right: 14px; }
  .ltt .ltt-r { position: absolute; width: 1px; height: 1px; left: 0; bottom: 0; opacity: 0; pointer-events: none; }
  .ltt:has(.ltt-r:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* A pop-over from a right-hand tile keeps inside the card (the page nudges it with --dx). */
`;

// ── chips: Chips that open into a panel ─────────────────────────────────────────────────────────
const CSS_CHIPS = String.raw`
  .lt-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
  .ltc { border-radius: 22px; border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  .ltc.on { border-color: color-mix(in srgb, var(--c) 50%, transparent); }
  .ltc.sel { flex: 1 0 100%; border-radius: 20px; background: color-mix(in srgb, var(--c) 14%, var(--panel)); }
  .ltc-row { display: flex; align-items: center; }
  .ltc.sel .ltc-row { padding-right: 2px; }
  .ltc-face { appearance: none; font: inherit; color: inherit; background: none; border: 0; cursor: pointer; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px 0 8px; text-align: left; border-radius: 22px; flex: 1; min-width: 0; }
  .ltc-face:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .ltc-face .bulb { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; background: var(--well); color: var(--fg-muted); }
  .ltc-face .bulb svg { width: 14px; height: 14px; }
  .ltc.on .bulb { background: var(--c); color: #1a1a1a; box-shadow: 0 0 12px var(--c); }
  .ltc .nm { font-size: 13px; font-weight: 600; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ltc .pc { font-size: 12px; color: var(--fg-2); font-family: var(--font-mono); white-space: nowrap; margin-left: auto; padding-left: 4px; }
  .ltc:not(.sel) .pc { margin-left: 0; }
  .ltc.gone .pc { color: var(--fg-muted); font-family: inherit; }
  .ltc-more { width: 44px; height: 44px; border: 0; background: none; color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; border-radius: 50%; margin-left: -10px; }
  .ltc-more svg { width: 14px; height: 14px; transition: transform 140ms ease; }
  .ltc.sel .ltc-more svg { transform: rotate(180deg); }
  .ltc-ex { display: flex; align-items: center; gap: 12px; padding: 2px 14px 14px; }
  .ltc-ex .lr { flex: 1; min-width: 0; }
  .ltc-only { flex: 1; font-size: 12px; color: var(--fg-muted); }
  .ltc-ex .ltw { flex-shrink: 0; }
  @media (prefers-reduced-motion: reduce) { .ltc-more svg { transition: none; } }
`;

// Keeps a pop-over inside its card: after every redraw, nudge it sideways if it would poke out.
const POP_JS = String.raw`
window.__homeAfterPut = function () {
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
};`;

// Tap switches a tile; dragging it sideways dims it. It drives the tile's own (hidden) brightness bar, so
// the page's usual sending, holding and "Didn't work" handling all apply. Practice-only code.
const DRAG_JS = String.raw`
(function () {
  var st = null, noClick = false;
  document.addEventListener('pointerdown', function (e) {
    var t = e.target.closest && e.target.closest('.ltt');
    if (!t || e.target.closest('.cbtn') || e.button > 0) return;
    var r = t.querySelector('input[data-bright]');
    if (!r) return;
    st = { t: t, r: r, x: e.clientX, v: Number(r.value), on: false, id: e.pointerId };
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (!st || e.pointerId !== st.id) return;
    if (!st.on) {
      if (Math.abs(e.clientX - st.x) < 8) return;
      st.on = true; st.x = e.clientX; st.t.classList.add('drag');
      try { st.t.setPointerCapture(e.pointerId); } catch (x) { /* a tile that was redrawn mid-press just stops dragging */ }
    }
    var w = st.t.getBoundingClientRect().width || 100;
    var v = Math.max(1, Math.min(100, Math.round(st.v + (e.clientX - st.x) / w * 100)));
    st.r.value = String(v);
    st.t.style.setProperty('--v', String(v));
    var pc = st.t.querySelector('.pc'); if (pc) pc.textContent = v + '%';
    st.r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  function done(e) {
    if (!st || e.pointerId !== st.id) return;
    if (st.on) { st.r.dispatchEvent(new Event('change', { bubbles: true })); st.t.classList.remove('drag'); noClick = true; setTimeout(function () { noClick = false; }, 50); }
    st = null;
  }
  document.addEventListener('pointerup', done); document.addEventListener('pointercancel', done);
  window.addEventListener('click', function (e) { if (noClick) { e.stopPropagation(); e.preventDefault(); } }, true);
})();`;

const OPEN = { view: 'lights', startOpen: ['destins_room'] };
// What the still picture shows open: rows → Desk backlight's colour menu inside the card; tiles → Hue Play's pop-over;
// chips → Desk backlight opened to its panel with its colour pop-over (hanging upward so the unreachable chip stays visible).
const SHOWN: Record<string, { pal: string; sel: string | null }> = {
  rows: { pal: 'light.desk_backlight', sel: null },
  tiles: { pal: 'light.hue_play_1', sel: null },
  chips: { pal: 'light.desk_backlight', sel: 'light.desk_backlight' },
};
const states = (k: string, label: string) => {
  const css = CSS_BASE + (k === 'rows' ? CSS_ROWS : k === 'tiles' ? CSS_TILES : CSS_CHIPS);
  const js = (k === 'tiles' ? DRAG_JS : '') + (k === 'rows' ? '' : POP_JS);
  const base = { css, js: js || undefined };
  const sh = SHOWN[k];
  return {
    // the picture: Destin's Room open (it has an unreachable light), one colour menu showing, the other rooms closed
    [k]: { label, ...base, transform: transformFor(k, [], sh.sel), data: { ...OPEN, startPalettes: [sh.pal] } },
    // practice pane: everything just as it first opens, only Destin's Room unfolded
    [k + '-play']: { label: label + ', to try', ...base, transform: transformFor(k), data: OPEN },
    // how it first appears: every card closed
    [k + '-closed']: { label: label + ', all closed', ...base, transform: transformFor(k), data: { view: 'lights' } },
    // Living Room's lights unreachable: its card goes to the end, greyed
    [k + '-gone']: { label: label + ', a room unreachable', ...base, transform: transformFor(k, ['living_room']), data: { view: 'lights', startOpen: ['destins_room', 'living_room'] } },
  };
};

export const VARIANTS: HomeVariants = {
  ...states('rows', 'Roomy rows'),
  ...states('tiles', 'Big tiles'),
  ...states('chips', 'Chips'),
};
