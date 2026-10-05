// Design options for the "lights-tab" task of the Home page redesign, ROUND 2c. Keys are
// "<option>" or "<option>-<state>"; each becomes the practice screen
// pages/page/page-home#v-lights-tab-<key>. See types.ts.
//
// Round 2b verdict (Destin): torn between the STYLE of Roomy rows (clear name + percent, thick full bar,
// calm glass surface, colour dot) and the SHAPE of Big tiles (2-3 per line, tap to switch). Round 2c mixes
// the two. Still settled: one card per room "<Room> Lights" with the page's own round All button, the
// palette scenes button and the fold arrow; unreachable lights last; all-unreachable rooms last; colour
// opens a floating glass pop-up hanging off the light.
//   r1  "Tall cards"   portrait cards, about three per line: bulb, name, percent and colour dot on top, a thick
//                      bar along the bottom; tap the card to switch, use the bar to dim
//   r2  "Slide tiles"  wide tiles, two per line, rows' type on a calm surface; the whole tile is the slider
//                      (fill = brightness): tap switches, drag sideways dims
//   r3  "Half rows"    the rows exactly as they are, half width, two lights per line
import type { HomeVariants } from './types';

// The page's own functions are reached from inside its script, so this block is pasted into it by
// `transform` just before roomHtml (WHY: CSS/JS appended after the page cannot see esc, isOn, gone,
// open, scenesBtn, groupBright, paletteHtml ... which live inside the page's closure).
// Plain ES5, no backticks, no dollar-brace.
const LT_CODE = String.raw`
  var LT_KIND = '__KIND__', LT_GONE = __GONE__;
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
  // Cards (r1 Tall cards, r3 Half rows): the page's own light row, shrunk into a grid cell. Same markup as a row
  // (face = bulb + name + percent, colour dot, thick bar) so it picks up the page's calm surface and glow.
  function ltCell(it) {
    var na = gone(it), on = !na && isOn(it), pct = ltPct(it), dim = dimmable(it);
    if (dragging === it.id) { var le = document.querySelector('[data-bright="' + it.id + '"]'); if (le) pct = Number(le.value); }
    var r = on && dim ? rangeHtml(it, pct) : '';
    return '<div class="ltw' + (expanded.has(it.id) && on ? ' pop' : '') + '"><div class="tile lt-cell' + (on ? ' on' : '') + (na ? ' gone' : '') + '" data-eid="' + esc(it.id) + '" style="--c:' + colourOf(it) + '"><span class="glow"></span>' +
      '<div class="line"><button class="tile-face" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">' +
      '<span class="bulb">' + BULB + '</span><span class="name">' + esc(it.name) + '<div class="sub">' + esc(ltStatus(it)) + '</div></span></button>' + ltDot(it, on) + '</div>' + r + '</div>' + ltPop(it, false) + '</div>';
  }
  // Slide tile (r2): the whole tile is the slider. Its brightness bar is kept (hidden, 1px) so the page's own
  // sending, holding and "Didn't work" handling run; DRAG_JS moves it from a sideways drag.
  function ltTile2(it) {
    var na = gone(it), on = !na && isOn(it), pct = ltPct(it), dim = dimmable(it);
    if (dragging === it.id) { var le = document.querySelector('[data-bright="' + it.id + '"]'); if (le) pct = Number(le.value); }
    var r = on && dim ? rangeHtml(it, pct).replace('class="lr"', 'class="lr ltt-r"') : '';
    return '<div class="ltw' + (expanded.has(it.id) && on ? ' pop' : '') + '"><div class="ltt ltt2' + (on ? ' on' : '') + (na ? ' gone' : '') + '" data-eid="' + esc(it.id) + '" style="--c:' + colourOf(it) + ';--v:' + (on ? pct : 0) + '">' +
      '<button class="ltt-face" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">' +
      '<span class="bulb">' + BULB + '</span><span class="tx"><span class="nm">' + esc(it.name) + '</span><span class="pc">' + esc(ltStatus(it)) + '</span></span></button>' + ltDot(it, on) + r + '</div>' + ltPop(it, false) + '</div>';
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
      popped = lights.some(function (it) { return expanded.has(it.id) && isOn(it) && !gone(it); });
      if (LT_KIND === 'r1') body = '<div class="lt-grid lt-g1">' + lights.map(ltCell).join('') + '</div>';
      else if (LT_KIND === 'r2') body = '<div class="lt-grid lt-g2">' + lights.map(ltTile2).join('') + '</div>';
      else body = '<div class="lt-grid lt-g3">' + lights.map(ltCell).join('') + '</div>';
    }
    var pend = !isOpen ? '' : lights.map(function (it) { return pendHtml(it.id); }).join('');
    return '<section class="yc-card room lt lt-k-' + LT_KIND + (anyOn ? ' on' : '') + (isOpen ? ' is-open' : '') + (popped ? ' has-pop' : '') + '" style="--c:' + c + '" data-lt="' + esc(room.id) + '"><span class="glow"></span>' +
      all + scenesHtml(room) + body + (pend ? '<div class="lt-pend">' + pend + '</div>' : '') + '</section>';
  }
  // The colour pop-up closes on a click outside it, and on Escape.
  document.addEventListener('click', function (e) {
    if (!expanded.size) return;
    if (e.target.closest && (e.target.closest('.ltp') || e.target.closest('.cbtn'))) return;
    expanded.clear(); render();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && expanded.size) { expanded.clear(); render(); }
  });
`;

const ROOM_HTML_HEAD = 'function roomHtml(room, roomIds, forceOpen) {';
const CTX_LINE = "var ctx = { key: key, ids: items.map(function (x) { return x.id; }) };";
const IDS_LINE = 'var ids = list.map(function (r) { return r.id; });';

// WHY exact-text swaps (not CSS): the Lights tab draws through roomHtml/viewHtml, which only the page's own
// script can change. Each swap is checked, so a page edit that moves these lines makes the screen fail loudly
// instead of silently showing today's page.
function transformFor(kind: string, gone: string[] = []) {
  return (html: string): string => {
    for (const s of [ROOM_HTML_HEAD, CTX_LINE, IDS_LINE]) {
      if (html.split(s).length !== 2) throw new Error('lights-tab variant: page text changed, cannot find: ' + s);
    }
    const code = LT_CODE.replace('__KIND__', kind).replace('__GONE__', JSON.stringify(gone));
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
  .lt .fold:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 520px) { .lt .scn, .lt .fold { width: 30px; height: 30px; } }
`;

// ── shared grid ─────────────────────────────────────────────────────────────────────────────────
const CSS_GRID = String.raw`
  .lt-grid { display: grid; gap: 10px; }
  /* a grid cell is as tall as its row, so an unreachable light is not a short stub beside working ones */
  .ltw { min-width: 0; display: flex; flex-direction: column; }
  .ltw > .tile, .ltw > .ltt { flex: 1; }
  .lt-cell { min-width: 0; border-radius: 18px; background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  .lt-cell .name { font-size: 15px; font-weight: 600; white-space: normal; line-height: 1.25; }
  .lt-cell .lr { --h: 30px; height: 30px; }
  .lt-cell .cbtn { width: 28px; height: 28px; flex-shrink: 0; }
  .lt-cell.gone .name { color: var(--fg-muted); }
`;

// ── r1: Tall cards ──────────────────────────────────────────────────────────────────────────────
// Portrait: the top of the card is one big tap area (bulb, name, percent); the thick bar lies along the bottom.
const CSS_R1 = String.raw`
  .lt-g1 { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .lt-g1 .lt-cell { min-height: 140px; padding: 12px 12px 12px; gap: 10px; }
  .lt-g1 .lt-cell .line { flex: 1; align-items: stretch; }
  .lt-g1 .lt-cell .tile-face { flex-direction: column; align-items: flex-start; justify-content: space-between; gap: 8px; align-self: stretch; }
  .lt-g1 .lt-cell .bulb { width: 38px; height: 38px; }
  .lt-g1 .lt-cell .name { flex: 0 0 auto; width: 100%; }
  .lt-g1 .lt-cell .name .sub { margin-top: 2px; white-space: nowrap; }
  .lt-g1 .lt-cell .cbtn { position: absolute; top: 0; right: 0; }
`;

// ── r2: Slide tiles ─────────────────────────────────────────────────────────────────────────────
// A calm surface with the rows' type. The fill is a soft tint of the light's colour; a thin bright edge marks the level.
const CSS_R2 = String.raw`
  .lt-g2 { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .ltt { position: relative; min-height: 100px; border-radius: 18px; overflow: hidden; touch-action: pan-y; user-select: none; -webkit-user-select: none;
    border: 1px solid var(--edge-dim); background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  /* The fill grows from the left as the tile is dragged sideways (two gradients: the thin edge, then the tint). */
  .ltt.on { border-color: color-mix(in srgb, var(--c) 40%, var(--edge-dim));
    background:
      linear-gradient(to right, transparent calc(var(--v, 0) * 1% - 3px), var(--c) 0, var(--c) calc(var(--v, 0) * 1%), transparent 0),
      linear-gradient(to right, color-mix(in srgb, var(--c) 26%, var(--panel)) calc(var(--v, 0) * 1%), color-mix(in srgb, var(--fg) 5%, var(--panel)) 0); }
  .ltt.drag { cursor: ew-resize; }
  .ltt-face { appearance: none; font: inherit; color: inherit; text-align: left; background: none; border: 0; cursor: pointer; width: 100%; height: 100%; min-height: 98px; padding: 0 52px 0 14px; display: flex; align-items: center; gap: 12px; }
  .ltt-face:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  .ltt-face .bulb { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; background: var(--well); color: var(--fg-muted); }
  .ltt.on .bulb { background: var(--c); color: #1a1a1a; box-shadow: 0 0 14px var(--c); }
  .ltt .tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ltt .nm { font-size: 15px; font-weight: 600; line-height: 1.25; color: var(--fg); overflow-wrap: anywhere; }
  .ltt .pc { font-size: 12px; font-family: var(--font-mono); color: var(--fg-2); }
  .ltt.gone .nm, .ltt.gone .pc { color: var(--fg-muted); }
  .ltt.gone .pc { font-family: inherit; }
  .ltt .cbtn { position: absolute; top: 50%; right: 14px; translate: 0 -50%; }
  .ltt .ltt-r { position: absolute; width: 1px; height: 1px; left: 0; bottom: 0; opacity: 0; pointer-events: none; }
  .ltt:has(.ltt-r:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

// ── r3: Half rows ───────────────────────────────────────────────────────────────────────────────
// The roomy row, unchanged but half as wide: two lights per line (one per line on a phone).
const CSS_R3 = String.raw`
  .lt-g3 { grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); }
  .lt-g3 .lt-cell .tile-face { align-items: flex-start; }
  .lt-g3 .lt-cell { padding: 12px 14px 14px; gap: 10px; }
  .lt-g3 .lt-cell .bulb { width: 40px; height: 40px; }
  .lt-g3 .lt-cell .lr { --h: 34px; height: 34px; }
  .lt-g3 .lt-cell .cbtn { width: 30px; height: 30px; }
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
const CSS_OF: Record<string, string> = { r1: CSS_GRID + CSS_R1, r2: CSS_GRID + CSS_R2, r3: CSS_GRID + CSS_R3 };
const states = (k: string, label: string) => {
  const css = CSS_BASE + CSS_OF[k];
  const base = { css, js: (k === 'r2' ? DRAG_JS : '') + POP_JS };
  return {
    // the picture: Destin's Room open (it has an unreachable light), the other rooms closed, no pop-up showing
    // (so the three crops stay the same height; the pop-up is tried in the live panes)
    [k]: { label, ...base, transform: transformFor(k), data: OPEN },
    // practice pane: everything just as it first opens, only Destin's Room unfolded
    [k + '-play']: { label: label + ', to try', ...base, transform: transformFor(k), data: OPEN, sameAs: { name: 'pages/page/page-home#v-lights-tab-' + k, why: 'the same open card; this one is for the live pane' } },
    // how it first appears: every card closed
    // WHY only r1: closed cards are drawn the same in every option, so one closed screen covers all three
    ...(k === 'r1' ? { [k + '-closed']: { label: label + ', all closed', ...base, transform: transformFor(k), data: { view: 'lights' } } } : {}),
    // the colour pop-up showing on the second light
    [k + '-colour']: { label: label + ', colour pop-up', ...base, transform: transformFor(k), data: { ...OPEN, startPalettes: ['light.desk_backlight'] } },
    // Living Room's lights unreachable: its card goes to the end, greyed
    [k + '-gone']: { label: label + ', a room unreachable', ...base, transform: transformFor(k, ['living_room']), data: { view: 'lights', startOpen: ['destins_room', 'living_room'] } },
  };
};

export const VARIANTS: HomeVariants = {
  ...states('r1', 'Tall cards'),
  ...states('r2', 'Slide tiles'),
  ...states('r3', 'Half rows'),
};
