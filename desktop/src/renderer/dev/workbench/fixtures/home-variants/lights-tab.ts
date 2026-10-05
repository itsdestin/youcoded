// Design options for the "lights-tab" task of the Home page redesign (round 2). Keys are
// "<option>" or "<option>-<state>"; each becomes the practice screen
// pages/page/page-home#v-lights-tab-<key>. See types.ts.
//
// Destin's request: on the Lights tab the page is already filtered to lights, so a room needs ONE
// card ("Destin's Room Lights") holding the whole-room control and the individual lights — no
// room card with a lights card nested inside it. Unreachable lights sort to the bottom of their
// card, and a room whose lights are all unreachable sorts to the end of the tab.
//
// All three options share the same card header (title, how many are on, an All off / All on button,
// the paint-palette scenes button, a chevron to open the card) and differ in how the individual
// lights are shown once it is open:
//   a  "Room strip"   a big room bar, then slim rows (the page's own light rows, made thin)
//   b  "Tile grid"    a square tile per light: tap to switch, drag sideways to dim
//   c  "Mixer"        vertical faders side by side, the room's master fader first
// Existing decisions kept: cards and colour menus start closed, scenes sit behind the palette
// button, the slider handle stays attached to its fill, the "Didn't work" note is kept.
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
  // One light as a square tile (option b).
  function ltTile(it) {
    var na = gone(it), on = !na && isOn(it), pct = ltPct(it), dim = dimmable(it);
    if (dragging === it.id) { var le = document.querySelector('[data-bright="' + it.id + '"]'); if (le) pct = Number(le.value); }
    var r = on && dim ? rangeHtml(it, pct).replace('class="lr"', 'class="lr ltt-r"') : '';
    var dot = !na && on && canWhite(it) ? '<button class="cbtn" style="--c:' + colourOf(it) + '" data-expand="' + esc(it.id) + '" aria-expanded="' + (expanded.has(it.id) ? 'true' : 'false') + '" aria-label="Colour of ' + esc(it.name) + '" title="Colour"></button>' : '';
    return '<div class="ltt' + (on ? ' on' : '') + (na ? ' gone' : '') + '" data-eid="' + esc(it.id) + '" style="--c:' + colourOf(it) + ';--v:' + (on ? pct : 0) + '">' +
      '<button class="ltt-face" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">' +
      '<span class="bulb">' + BULB + '</span><span class="nm">' + esc(it.name) + '</span><span class="pc">' + esc(ltStatus(it)) + '</span></button>' + dot + r + '</div>';
  }
  // One light as a vertical fader (option c).
  function ltFader(it) {
    var na = gone(it), on = !na && isOn(it), pct = ltPct(it), dim = dimmable(it);
    if (dragging === it.id) { var le = document.querySelector('[data-bright="' + it.id + '"]'); if (le) pct = Number(le.value); }
    var trk = na ? '<div class="ltf-trk static"></div>'
      : dim ? '<div class="ltf-trk">' + rangeHtml(it, on ? pct : 1) + '</div>'
      : '<div class="ltf-trk static' + (on ? ' full' : '') + '"></div>';
    var dot = !na && on && canWhite(it) ? '<button class="cbtn" style="--c:' + colourOf(it) + '" data-expand="' + esc(it.id) + '" aria-expanded="' + (expanded.has(it.id) ? 'true' : 'false') + '" aria-label="Colour of ' + esc(it.name) + '" title="Colour"></button>' : '<span class="cbtn-gap"></span>';
    return '<div class="ltf' + (on ? ' on' : '') + (na ? ' gone' : '') + '" data-eid="' + esc(it.id) + '" style="--c:' + colourOf(it) + '">' +
      '<button class="ltf-top" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">' + BULB + '</button>' +
      trk + '<span class="ltf-pc">' + esc(na ? '—' : ltStatus(it)) + '</span><span class="ltf-nm">' + esc(it.name) + '</span>' + dot + '</div>';
  }
  function ltPalettes(lights) {
    return lights.map(function (it) { var p = paletteHtml(it); return p ? '<div class="lt-pal"><div class="lt-pal-h">Colour of ' + esc(it.name) + '</div>' + p + '</div>' : ''; }).join('');
  }
  // The ONE card for a room on the Lights tab.
  function ltRoom(room, items, ctx) {
    var lights = ltSort(items.filter(isLight));
    if (!lights.length) return '';
    var live = lights.filter(function (it) { return !gone(it); }), onList = live.filter(isOn), anyOn = onList.length > 0;
    var isOpen = open.has(room.id), c = anyOn ? colourOf(onList[0]) : 'rgb(255, 190, 110)', nGone = lights.length - live.length;
    var status = !live.length ? 'None responding' : (anyOn ? onList.length + ' of ' + live.length + ' on' : 'All off') + (nGone ? ' · ' + nGone + ' not responding' : '');
    var head = '<div class="lt-head"><span class="lt-ic" aria-hidden="true">' + BULB + '</span><div class="lt-ttl"><h3>' + esc(room.name) + ' Lights</h3><div class="lt-sub">' + esc(status) + '</div></div>' +
      '<button class="lt-all" data-room="' + esc(room.id) + '" data-room-to="' + (anyOn ? 'off' : 'on') + '"' + (live.length ? '' : ' disabled') + ' aria-label="' + (anyOn ? 'Turn off' : 'Turn on') + ' every light in ' + esc(room.name) + '">' + (anyOn ? 'All off' : 'All on') + '</button>' +
      scenesBtn(room) + '<button class="fold" data-fold="' + esc(room.id) + '" aria-expanded="' + isOpen + '" aria-label="' + (isOpen ? 'Hide' : 'Show') + ' each light in ' + esc(room.name) + '" title="' + (isOpen ? 'Hide each light' : 'Show each light') + '">' + CHEVRON + '</button></div>';
    var bar = LT_KIND !== 'c' ? groupBright(room, live, onList, c) : '';
    var body = '';
    if (isOpen) {
      if (LT_KIND === 'a') body = '<div class="lt-rows">' + lights.map(function (it) { return itemHtml(it, ctx); }).join('') + '</div>';
      else if (LT_KIND === 'b') body = '<div class="lt-grid">' + lights.map(ltTile).join('') + '</div>' + ltPalettes(lights);
      else {
        var master = groupBright(room, live, onList, c);
        body = '<div class="lt-mix">' + (master ? '<div class="ltf master' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><span class="ltf-top" aria-hidden="true">' + HOUSE + '</span><div class="ltf-trk">' + master + '</div><span class="ltf-pc">' + (onList.length ? Math.round(onList.filter(dimmable).reduce(function (a, it) { return a + ltPct(it); }, 0) / Math.max(1, onList.filter(dimmable).length)) + '%' : 'Off') + '</span><span class="ltf-nm">Whole room</span><span class="cbtn-gap"></span></div>' : '') +
          lights.map(ltFader).join('') + '</div>' + ltPalettes(lights);
      }
    }
    var pend = pendHtml('room:' + room.id) + (LT_KIND === 'a' ? '' : lights.map(function (it) { return pendHtml(it.id); }).join(''));
    return '<section class="yc-card room lt lt-' + LT_KIND + (anyOn ? ' on' : '') + (isOpen ? ' is-open' : '') + '" style="--c:' + c + '" data-lt="' + esc(room.id) + '"><span class="glow"></span>' +
      head + bar + scenesHtml(room) + body + (pend ? '<div class="lt-pend">' + pend + '</div>' : '') + '</section>';
  }
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
  /* Wider columns than the Home tab's 340 px: one card per room carries a longer title and, in the mixer, five faders. */
  #view .rooms { columns: 440px; }
  .lt { position: relative; overflow: hidden; gap: 12px; }
  .lt > .glow { position: absolute; inset: 0; background: radial-gradient(120% 90% at 0% 0%, var(--c), transparent 72%); opacity: 0; pointer-events: none; }
  .lt.on > .glow { opacity: .16; }
  .lt > :not(.glow) { position: relative; }
  .lt-head { display: flex; align-items: center; gap: 10px; }
  .lt-ic { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; background: var(--well); color: var(--fg-muted); }
  .lt.on .lt-ic { background: var(--c); color: #1a1a1a; box-shadow: 0 0 22px var(--c), inset 0 1px 0 rgba(255,255,255,.5); }
  .lt-ttl { flex: 1; min-width: 0; }
  .lt-ttl h3 { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.25; color: var(--fg); }
  .lt-sub { font-size: 12px; color: var(--fg-muted); margin-top: 1px; }
  .lt-ttl h3 { overflow-wrap: anywhere; }
  .lt-all { flex-shrink: 0; height: 34px; padding: 0 14px; border-radius: 9999px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--fg); background: var(--well); border: 1px solid var(--edge); }
  .lt-all:hover:not(:disabled) { border-color: var(--fg-muted); }
  .lt-all[data-room-to="on"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .lt-all:disabled { opacity: .45; cursor: default; }
  .lt-all:focus-visible, .lt .fold:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* One slider look for the room bar and every light bar: a round-capped fill with the handle inside its end
     (the handle stays attached at every value); --h is the bar's height, so it can be thick or slim. */
  .lt .lr { --h: 34px; height: var(--h); border-radius: calc(var(--h) / 2); box-shadow: inset 0 1px 3px rgba(0,0,0,.3);
    background:
      radial-gradient(circle at center, var(--c, var(--accent)) calc(var(--h) / 2 - .5px), transparent calc(var(--h) / 2)) calc(var(--v, 0) * 1%) 0 / var(--h) var(--h) no-repeat,
      linear-gradient(to right, var(--c, var(--accent)) calc(var(--h) / 2 + (100% - var(--h)) * var(--v, 0) / 100), var(--well) 0); }
  .lt .lr::-webkit-slider-thumb { width: var(--h); height: var(--h); margin: 0; border-radius: 50%; border: 0; box-sizing: border-box; cursor: grab;
    background: radial-gradient(circle, #fff calc(var(--h) / 2 - 3.5px), rgba(255,255,255,0) calc(var(--h) / 2 - 3px)); filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
  .lt .scenes { margin: 0; }
  .lt-pend { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .lt .pend { position: static; max-width: 100%; }
  .lt-pal { display: flex; flex-direction: column; gap: 6px; }
  .lt-pal-h { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); }
  .lt .cbtn { width: 24px; height: 24px; }
  .lt .gone { opacity: .55; }
  @media (max-width: 520px) { .lt-ic { display: none; } .lt-all { padding: 0 11px; } .lt-head { gap: 8px; } .lt .scn, .lt .fold { width: 30px; height: 30px; } }
`;

// ── a: Room strip ───────────────────────────────────────────────────────────────────────────────
// The room bar is thick and on top; the lights are the page's own rows, made thin.
const CSS_A = String.raw`
  .lt-a .lt-rows { display: flex; flex-direction: column; gap: 6px; }
  .lt-a .lt-rows .tile { padding: 8px 12px; gap: 6px; border-radius: 14px; }
  .lt-a .lt-rows .tile .bulb { width: 28px; height: 28px; }
  .lt-a .lt-rows .tile .bulb svg { width: 14px; height: 14px; }
  .lt-a .lt-rows .tile .name { font-size: 13px; }
  .lt-a .lt-rows .tile .sub { display: inline; margin-left: 8px; }
  .lt-a .lt-rows .tile .lr { --h: 18px; height: 18px; }
  .lt-a .lt-rows .tile .lr::-webkit-slider-thumb { height: 18px; }
  .lt-a .lt-rows .tile .cbtn { width: 22px; height: 22px; }
  .lt-a .lt-rows .tile.gone .name { color: var(--fg-muted); }
`;

// ── b: Tile grid ────────────────────────────────────────────────────────────────────────────────
const CSS_B = String.raw`
  .lt-b > .lr { --h: 30px; }
  .lt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
  .ltt { position: relative; min-height: 104px; border-radius: 18px; overflow: hidden; touch-action: pan-y; user-select: none; -webkit-user-select: none;
    border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  /* The fill shows how bright the light is: it grows from the left as the tile is dragged sideways. */
  .ltt.on { border-color: color-mix(in srgb, var(--c) 55%, transparent); box-shadow: 0 10px 24px -14px var(--c);
    background: linear-gradient(to right, color-mix(in srgb, var(--c) 42%, transparent) calc(var(--v, 0) * 1%), color-mix(in srgb, var(--fg) 5%, var(--panel)) 0); }
  .ltt.drag { cursor: ew-resize; }
  .ltt-face { appearance: none; font: inherit; color: inherit; text-align: left; background: none; border: 0; cursor: pointer; width: 100%; height: 100%; min-height: 104px; padding: 12px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; gap: 6px; }
  .ltt-face:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  .ltt-face .bulb { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--well); color: var(--fg-muted); }
  .ltt.on .bulb { background: var(--c); color: #1a1a1a; box-shadow: 0 0 16px var(--c); }
  .ltt .nm { font-size: 13px; font-weight: 600; line-height: 1.2; color: var(--fg); }
  .ltt .pc { font-size: 11px; color: var(--fg-2); font-family: var(--font-mono); }
  .ltt .cbtn { position: absolute; top: 10px; right: 10px; }
  .ltt .ltt-r { position: absolute; width: 1px; height: 1px; left: 0; bottom: 0; opacity: 0; pointer-events: none; }
  .ltt:has(.ltt-r:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

// ── c: Mixer ────────────────────────────────────────────────────────────────────────────────────
const CSS_C = String.raw`
  /* Faders wrap onto a second row instead of scrolling sideways, so every light is visible at phone width. */
  .lt-mix { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px; padding: 4px 0 6px; }
  .ltf { flex: 0 0 72px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 4px 10px; border-radius: 18px;
    border: 1px solid color-mix(in srgb, var(--fg) 8%, transparent); background: color-mix(in srgb, var(--fg) 4%, var(--panel)); }
  .ltf.on { border-color: color-mix(in srgb, var(--c) 45%, transparent); }
  .ltf.master { background: color-mix(in srgb, var(--fg) 8%, var(--panel)); }
  .ltf-top { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; padding: 0; border: 0; background: var(--well); color: var(--fg-muted); }
  .ltf.on .ltf-top { background: var(--c); color: #1a1a1a; box-shadow: 0 0 16px var(--c); }
  .ltf-top:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  span.ltf-top { cursor: default; }
  /* A fader is the same bar turned on its end: bottom is off, top is full. */
  .ltf-trk { position: relative; width: 44px; height: 150px; flex-shrink: 0; }
  .ltf-trk .lr { --h: 34px; position: absolute; left: 50%; top: 50%; width: 150px; transform: translate(-50%, -50%) rotate(-90deg); }
  .ltf-trk.static { border-radius: 22px; background: var(--well); box-shadow: inset 0 1px 3px rgba(0,0,0,.3); }
  .ltf-trk.static.full { background: linear-gradient(to top, var(--c) 100%, var(--well) 0); }
  .ltf-pc { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); }
  .ltf-nm { font-size: 11px; font-weight: 600; color: var(--fg); text-align: center; line-height: 1.2; max-width: 68px; overflow-wrap: break-word; }
  .cbtn-gap { height: 24px; }
  .ltf.gone .ltf-nm { color: var(--fg-muted); }
`;

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
const states = (k: string, label: string, gone: string[] = []) => {
  const tf = transformFor(k, gone);
  const css = CSS_BASE + (k === 'a' ? CSS_A : k === 'b' ? CSS_B : CSS_C);
  const js = k === 'b' ? DRAG_JS : undefined;
  const base = { css, js, transform: tf };
  return {
    // one room open (Destin's Room, which has an unreachable light), the others closed
    [k]: { label, ...base, data: OPEN },
    // how it first appears: every card closed
    [k + '-closed']: { label: label + ', all closed', ...base, data: { view: 'lights' } },
    // Living Room's lights unreachable: its card goes to the end, greyed
    [k + '-gone']: { label: label + ', a room unreachable', ...base, transform: transformFor(k, ['living_room']), data: { view: 'lights', startOpen: ['destins_room', 'living_room'] } },
    // colour menu and scenes open
    [k + '-colour']: { label: label + ', colour and scenes open', ...base, data: { ...OPEN, startPalettes: ['light.desk_backlight'], startScenes: ['destins_room'] } },
  };
};

export const VARIANTS: HomeVariants = {
  ...states('a', 'Room strip'),
  ...states('b', 'Tile grid'),
  ...states('c', 'Mixer'),
};
