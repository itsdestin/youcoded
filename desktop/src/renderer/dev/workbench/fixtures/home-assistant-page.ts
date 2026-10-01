// The Home Assistant page — the first page built on a device connection
// (home-device questions deck, 2026-10-01). The SAME document the workbench
// shows is what gets installed as a real page, so the review deck shows the
// page that will actually run.
//
// Decided on the deck: lights by room, the thermostat and the TV/speakers,
// and camera snapshots (Q-scope); every device Home Assistant has put in a
// room, with a hide button for the rest (Q-which-devices); checking every 5
// seconds while the page is on screen (Q-live).
//
// How it talks to Home Assistant: one template request returns every room and
// what is in it (Home Assistant's own `/api/template`, so rooms always match
// what Home Assistant says), service calls switch things, and
// `/api/camera_proxy/<camera>` returns a snapshot as a picture. All of it goes
// through `youcoded.fetch`; the page never holds the key.

/** One request that answers "every room, and the lights, thermostats, players
 *  and cameras in it". `.get()` rather than `.attr` so a missing attribute is
 *  null in the JSON, never a template error. */
const ROOMS_TEMPLATE = `{%- set ns = namespace(rooms=[]) -%}
{%- for a in areas() -%}
{%- set ens = namespace(items=[]) -%}
{%- for e in area_entities(a) -%}
{%- set d = e.split('.')[0] -%}
{%- if d in ['light','climate','media_player','camera'] and states[e] is not none -%}
{%- set s = states[e] -%}
{%- set ens.items = ens.items + [{'id': e, 'name': s.name, 'state': s.state, 'brightness': s.attributes.get('brightness'), 'modes': s.attributes.get('supported_color_modes'), 'cur': s.attributes.get('current_temperature'), 'target': s.attributes.get('temperature'), 'min': s.attributes.get('min_temp'), 'max': s.attributes.get('max_temp'), 'step': s.attributes.get('target_temp_step'), 'vol': s.attributes.get('volume_level'), 'title': s.attributes.get('media_title'), 'features': s.attributes.get('supported_features', 0), 'rgb': s.attributes.get('rgb_color'), 'k': s.attributes.get('color_temp_kelvin'), 'modesHvac': s.attributes.get('hvac_modes'), 'action': s.attributes.get('hvac_action'), 'device': device_id(e)}] -%}
{%- endif -%}
{%- endfor -%}
{%- if ens.items -%}{%- set ns.rooms = ns.rooms + [{'id': a, 'name': area_name(a), 'items': ens.items}] -%}{%- endif -%}
{%- endfor -%}
{{ ns.rooms | to_json }}`;

export const HOME_ASSISTANT_PAGE_JSON = {
  name: 'Home',
  description: 'Lights, temperature, TVs and cameras, room by room, from Home Assistant.',
  icon: 'page',
  connections: [
    {
      id: 'ha', kind: 'device', service: 'Home Assistant', address: 'homeassistant.local:8123',
      access: 'full', keyPage: '/profile/security',
      // Renames and room moves go over Home Assistant's websocket (Q-where):
      // the app sends this greeting first, with the key filled in by the app.
      socketHello: '{"type":"auth","access_token":"{{key}}"}',
      keyHelp: { steps: [
        'Press Open Home Assistant below and sign in.',
        'Scroll to the bottom, to "Long-lived access tokens", and press Create token.',
        'Name it "YouCoded", then copy the key it shows (it is shown only once) and paste it here.',
      ] },
    },
  ],
};

/** Light controls are TILES (light-controls choice deck, 2026-10-01, C-lights:
 *  picked over glowing power buttons and big sliders). Round 2 notes: room-wide
 *  "all on / all off" buttons, a better colour button and colour selection, and
 *  the speaker's volume in the same style. */
/** Round 4 (home-page-v2 questions deck, 2026-10-01): a room's lights fold
 *  into one card headed by an "All" bulb tile that only switches lights
 *  (Q-card lights-only, Q-all bulb-all); folds are remembered (Q-fold
 *  remember); an Edit mode for favourites, order, hiding, renaming and moving
 *  rooms (Q-settings, Q-where mixed); a link to each device's own screen in
 *  Home Assistant (Q-advanced deep-link); and Everything off, asked first
 *  (Q-extras house-off). */
function homeAssistantPageHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Home</title>
<style>
  .rooms { columns: 340px; column-gap: 12px; }
  .room { break-inside: avoid; margin-bottom: 12px; display: flex; flex-direction: column; gap: 10px; }
  .room-head { display: flex; align-items: center; gap: 8px; }
  .room-head h2 { flex: 1; font-size: 15px; font-weight: 600; }
  .thing { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 10px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .thing .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thing .sub { font-size: 11px; color: var(--fg-muted); }
  .thing.off .name { color: var(--fg-2); }
  .thing.gone { opacity: .55; }
  .thing.col { flex-direction: column; align-items: stretch; }
  .thing .line { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
  .temp { font-family: var(--font-mono); font-size: 28px; font-weight: 500; line-height: 1; }
  .cam { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius-md, 8px); background: var(--well); display: block; }
  .cam-empty { width: 100%; height: 56px; border-radius: var(--radius-md, 8px); background: var(--well); display: grid; place-items: center; color: var(--fg-muted); font-size: 12px; }
  /* ── Round 4: folding lights, Edit mode, Everything off ─────────────── */
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .confirm { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--inset); font-size: 13px; }
  /* A room's lights: one card whose header IS the All row, with each light
     as a card inside it, evenly inset on every side (round 4 reviews, S-fold
     then S-nest: "all of the cards just need to be sub-containers of the
     grouped/expandable card. centered properly" — no indent, no guide line). */
  .lights { position: relative; overflow: hidden; display: flex; flex-direction: column; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .lights > .tile.all { border: 0; border-radius: 0; background: transparent; }
  .lights-body { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; }
  .lights-body > .tile { background: var(--well); }
  .tile.all .line { gap: 8px; }
  .bulb-col { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
  .all-lbl { font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-muted); line-height: 1; }
  .tile.all.on .all-lbl { color: var(--fg); }
  .fold { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; position: relative; }
  .fold:hover { color: var(--fg); border-color: var(--fg-muted); }
  .fold:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .fold svg { transition: transform 150ms ease; }
  .fold[aria-expanded="true"] svg { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .fold svg { transition: none; } }
  /* Edit mode: each thing gets one row of small controls under it. */
  .edit-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; position: relative; padding-top: 6px; border-top: 1px dashed var(--edge-dim); }
  .ib { width: 30px; height: 30px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--well); color: var(--fg-2); cursor: pointer; display: inline-grid; place-items: center; padding: 0; text-decoration: none; flex-shrink: 0; }
  .ib:hover:not(:disabled) { color: var(--fg); border-color: var(--edge); }
  .ib:disabled { opacity: .35; cursor: default; }
  .ib[aria-pressed="true"] { color: rgb(240, 180, 40); border-color: rgb(240, 180, 40); }
  .ib:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .edit-row .yc-select { height: 30px; flex: 1; min-width: 110px; font-size: 12px; }
  .edit-row .yc-input { height: 30px; flex: 1; min-width: 120px; font-size: 13px; }
  .edit-row .grow { flex: 1; }
  .room-head .ib { width: 28px; height: 28px; }
  .tile.is-hidden, .clim.is-hidden, .thing.is-hidden { opacity: .5; }
  .fav-head { display: flex; align-items: center; gap: 6px; }
  /* Favourites sit side by side, the same width as a room's tiles. */
  .fav-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; align-items: start; }
  .fav-head svg { color: rgb(240, 180, 40); }
  .banner { padding: 10px 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge); background: var(--well); font-size: 13px; }
  @media (prefers-reduced-motion: reduce) { .tile .glow, .sw { transition: none; } }

  /* ── Light controls, shared ─────────────────────────────────────────── */
  /* A range painted as a filled bar: --pct is the fill, --c the light's own
     colour. Updated live while dragging, without redrawing the page. */
  .lr { appearance: none; -webkit-appearance: none; width: 100%; margin: 0; cursor: pointer; background: linear-gradient(to right, var(--c, var(--accent)) var(--pct, 0%), var(--well) var(--pct, 0%)); border-radius: 9999px; }
  .lr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .lr::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; }
  .palette { position: relative; display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
  .sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--edge); padding: 0; cursor: pointer; background: var(--sw); }
  .sw:hover { transform: scale(1.08); }
  .sw[aria-pressed="true"] { outline: 2px solid var(--fg); outline-offset: 2px; }
  .sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pct { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); }
  /* ── Tiles: the tile is the button ─────────────────────────────────── */
  .tile { position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .tile .line { display: flex; align-items: center; gap: 10px; position: relative; }
  .tile .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile-face { flex: 1; min-width: 0; appearance: none; font: inherit; color: inherit; text-align: left; background: none; border: 0; padding: 0; display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .tile .glow { position: absolute; inset: 0; background: var(--c); opacity: 0; pointer-events: none; transition: opacity 200ms ease; }
  .tile.on .glow { opacity: .16; }
  .tile .bulb { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--well); color: var(--fg-muted); flex-shrink: 0; position: relative; }
  .tile.on .bulb { background: var(--c); color: #1a1a1a; box-shadow: 0 0 14px var(--c); }
  .tile .lr { height: 14px; position: relative; }
  .tile .lr::-webkit-slider-thumb { width: 14px; height: 14px; border-radius: 50%; background: transparent; }

  .tile.media .bulb { border-radius: var(--radius-md, 8px); }
  .tile.media.on .bulb { background: var(--accent); color: var(--on-accent); box-shadow: none; }
  .tile .vol { display: flex; align-items: center; gap: 8px; position: relative; }
  .tile .vol svg { flex-shrink: 0; color: var(--fg-muted); }

  /* The colour button: a dot of the light's current colour, ringed, on the
     tile itself — what it does is what it shows. */
  .cbtn { width: 26px; height: 26px; flex-shrink: 0; border-radius: 50%; padding: 0; cursor: pointer; position: relative; background: var(--c); border: 2px solid var(--panel); box-shadow: 0 0 0 1px var(--edge); }
  .cbtn[aria-expanded="true"] { box-shadow: 0 0 0 2px var(--fg); }
  .cbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  /* Colour selection: whites and colours as two labelled rows, the chosen
     one ticked, and a rainbow swatch for any colour at all. */
  .palette { flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--radius-md, 8px); background: var(--panel); border: 1px solid var(--edge-dim); }
  .pal-row { display: grid; grid-template-columns: 56px 1fr; align-items: center; gap: 8px; }
  .pal-sw { display: flex; flex-wrap: wrap; gap: 8px; }
  .pal-lbl { width: 56px; flex-shrink: 0; font-size: 11px; color: var(--fg-muted); }
  .sw { width: 28px; height: 28px; position: relative; }
  .sw[aria-pressed="true"]::after { content: ''; position: absolute; left: 8px; top: 4px; width: 7px; height: 12px; border: solid #111; border-width: 0 2.5px 2.5px 0; transform: rotate(45deg); filter: drop-shadow(0 0 1px #fff); }
  .sw-any { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--edge); cursor: pointer; background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); position: relative; overflow: hidden; }
  .sw-any input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .room-acts { display: flex; gap: 6px; }

  /* Thermostat (round 2: "improve the ac/thermostat card visually"): a tile
     tinted by what it is set to do — blue cooling, orange heating — with the
     room's temperature large, the setting between two big round buttons, a
     scale showing both, and the modes as one row of pills. */
  .clim { --m: var(--fg-muted); position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 12px; padding: 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .clim.cool { --m: rgb(60, 150, 255); } .clim.heat { --m: rgb(255, 130, 40); } .clim.auto, .clim.heat_cool { --m: rgb(140, 120, 255); } .clim.dry, .clim.fan_only { --m: rgb(60, 190, 170); }
  .clim .glow { position: absolute; inset: 0; background: radial-gradient(circle at 20% 0%, var(--m), transparent 70%); opacity: .18; pointer-events: none; }
  .clim.off .glow { opacity: 0; }
  .clim-top { display: flex; align-items: flex-end; gap: 12px; position: relative; }
  .clim-now .temp { font-size: 40px; }
  .clim-doing { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-2); }
  .clim-doing::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--m); }
  .clim-set { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .clim-set .val { text-align: center; min-width: 54px; }
  .clim .sub { font-size: 11px; color: var(--fg-muted); }
  .clim-set .val b { display: block; font-family: var(--font-mono); font-size: 22px; font-weight: 500; color: var(--fg); }
  .step { width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg); font-size: 18px; line-height: 1; cursor: pointer; display: grid; place-items: center; padding: 0; }
  .step:hover { border-color: var(--m); }
  .step:disabled { opacity: .4; cursor: default; }
  .scale { position: relative; height: 6px; border-radius: 9999px; background: var(--well); }
  .scale .fill { position: absolute; top: 0; bottom: 0; border-radius: 9999px; background: var(--m); opacity: .55; }
  .scale .mk { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; }
  .scale .mk.now { background: var(--fg); border: 2px solid var(--panel); }
  .scale .mk.set { background: var(--m); border: 2px solid var(--panel); box-shadow: 0 0 0 1px var(--m); }
  .scale-lbl { display: flex; justify-content: space-between; font-size: 10px; color: var(--fg-muted); margin-top: -6px; }
  .modes { display: flex; gap: 6px; flex-wrap: wrap; position: relative; }
  .mode { appearance: none; font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 9999px; border: 1px solid var(--edge); background: transparent; color: var(--fg-2); cursor: pointer; }
  .mode[aria-pressed="true"] { background: var(--m); border-color: var(--m); color: #111; }
</style></head>
<body>
<div class="yc-page yc-stack" id="root">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">Home Assistant</div><h1>Home</h1></div>
    <div class="bar" id="bar"></div>
  </div>
  <div id="banner" class="banner" hidden></div>
  <div id="favs"></div>
  <div class="rooms" id="rooms"><div class="yc-empty">Loading your rooms…</div></div>
</div>
<script>
(function () {
  var TEMPLATE = ${JSON.stringify(ROOMS_TEMPLATE)};
  var POLL_MS = 5000, CAMERA_MS = 10000;
  var base = (window.youcoded.devices || {}).ha;
  var rooms = null, editing = false, timer = null, camTimer = null, busy = {};
  var saved = window.youcoded.data || {};
  var hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden : []);
  // Which lights have their colour palette open. Kept with the page's data so
  // a palette left open stays open (and so a review screen can show one).
  var expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded : []);
  // Round 4. open: rooms whose lights card is unfolded (Q-fold: as you left
  // them). fav: starred things, shown in a row above the rooms. order: the
  // order you chose, per room ('r:<room>'), for rooms ('rooms') and for
  // favourites ('fav'). All three are this page's own, not Home Assistant's
  // (Q-where: layout stays personal to the page).
  var open = new Set(Array.isArray(saved.open) ? saved.open : []);
  var fav = new Set(Array.isArray(saved.fav) ? saved.fav : []);
  var order = saved.order && typeof saved.order === 'object' ? saved.order : {};
  // One text box at a time: renaming a thing, or naming a new room for it.
  var renaming = null, newRoomFor = null, confirmOff = false;
  if (saved.editing) editing = true;
  var $ = function (id) { return document.getElementById(id); };

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function domain(id) { return id.split('.')[0]; }
  function isOn(it) { return it.state === 'on' || it.state === 'playing' || it.state === 'paused' || it.state === 'idle' || (domain(it.id) === 'climate' && it.state !== 'off'); }
  function gone(it) { return it.state === 'unavailable' || it.state === 'unknown'; }
  function dimmable(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m !== 'onoff'; }); }

  function persist(patch) { window.youcoded.save(Object.assign({}, window.youcoded.data || {}, patch)); }
  function banner(text) { var b = $('banner'); b.textContent = text || ''; b.hidden = !text; }

  function call(path, body) {
    return window.youcoded.fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 401) throw new Error('Home Assistant did not accept the key. Remove this connection and add a new key.');
      if (r.status >= 400) throw new Error('Home Assistant answered ' + r.status + '.');
      return r;
    });
  }

  function load() {
    if (!base) { banner('This page has not been connected to Home Assistant yet.'); return; }
    call('/api/template', { template: TEMPLATE }).then(function (r) {
      var first = rooms === null;
      // A redraw would throw away a half-typed name, so a check that lands
      // while a text box is open waits for the next one.
      if (!first && (renaming || newRoomFor)) return;
      rooms = JSON.parse(r.body);
      banner('');
      render();
      // Pictures as soon as there are cameras to put them in, not on a delay.
      if (first) refreshCameras();
    }).catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant could not be reached.'); });
  }

  function service(dom, svc, data, id) {
    busy[id] = true;
    return call('/api/services/' + dom + '/' + svc, data)
      .catch(function (e) { banner(e && e.message ? e.message : 'That did not go through.'); })
      .then(function () { delete busy[id]; setTimeout(load, 400); });
  }

  // Optimistic: the switch moves the moment it is pressed, then the next
  // check confirms or corrects it.
  function setLocal(id, patch) {
    (rooms || []).forEach(function (room) { room.items.forEach(function (it) { if (it.id === id) Object.assign(it, patch); }); });
    render();
  }

  // Colour: a light's own colour when it reports one, else its white
  // temperature as a colour, else warm white.
  var PALETTE = [
    { k: 2700, name: 'Warm white' }, { k: 4000, name: 'Neutral white' }, { k: 6500, name: 'Daylight' },
    { rgb: [255, 70, 50], name: 'Red' }, { rgb: [255, 140, 0], name: 'Orange' }, { rgb: [255, 210, 40], name: 'Yellow' },
    { rgb: [50, 205, 90], name: 'Green' }, { rgb: [0, 190, 200], name: 'Teal' }, { rgb: [50, 110, 255], name: 'Blue' },
    { rgb: [150, 80, 255], name: 'Purple' }, { rgb: [255, 80, 170], name: 'Pink' },
  ];
  function kelvinRgb(k) {
    var t = Math.max(0, Math.min(1, (k - 2200) / (6500 - 2200)));
    return [255, Math.round(170 + t * 80), Math.round(90 + t * 160)];
  }
  function colourOf(it) {
    var c = Array.isArray(it.rgb) ? it.rgb : it.k ? kelvinRgb(it.k) : [255, 190, 110];
    return 'rgb(' + c.join(',') + ')';
  }
  function canColour(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m === 'xy' || m === 'hs' || m === 'rgb' || m === 'rgbw' || m === 'rgbww'; }); }
  function canWhite(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m === 'color_temp' || m === 'xy' || m === 'hs' || m === 'rgb' || m === 'rgbw' || m === 'rgbww'; }); }
  var BULB = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/></svg>';
  var SPEAKER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
  var CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var STAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>';
  var STAR_ON = STAR.replace('fill="none"', 'fill="currentColor"');
  var UP = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
  var DOWN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  var EYE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  var OUT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  var TV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>';
  function hex(c) { return '#' + c.map(function (n) { return ('0' + n.toString(16)).slice(-2); }).join(''); }

  function swatch(it, p) {
    var c = p.k ? kelvinRgb(p.k) : p.rgb;
    var on = p.k ? (it.k && Math.abs(it.k - p.k) < 300 && !Array.isArray(it.rgb)) : (Array.isArray(it.rgb) && it.rgb.join() === p.rgb.join());
    return '<button class="sw" style="--sw: rgb(' + c.join(',') + ')" title="' + p.name + '" aria-label="' + p.name + '" aria-pressed="' + (on ? 'true' : 'false') + '" data-colour="' + esc(it.id) + '" data-' + (p.k ? 'k="' + p.k : 'rgb="' + p.rgb.join(',')) + '"></button>';
  }
  function paletteHtml(it) {
    if (!expanded.has(it.id) || !isOn(it) || gone(it)) return '';
    var whites = canWhite(it) ? '<div class="pal-row"><span class="pal-lbl">Whites</span><span class="pal-sw">' + PALETTE.filter(function (p) { return p.k; }).map(function (p) { return swatch(it, p); }).join('') + '</span></div>' : '';
    var current = Array.isArray(it.rgb) ? it.rgb : [255, 255, 255];
    var colours = canColour(it) ? '<div class="pal-row"><span class="pal-lbl">Colours</span><span class="pal-sw">' + PALETTE.filter(function (p) { return p.rgb; }).map(function (p) { return swatch(it, p); }).join('') +
      '<label class="sw-any" title="Any colour"><input type="color" value="' + hex(current) + '" aria-label="Any colour for ' + esc(it.name) + '" data-any="' + esc(it.id) + '"></label></span></div>' : '';
    return '<div class="palette" role="group" aria-label="Colour of ' + esc(it.name) + '">' + whites + colours + '</div>';
  }
  function colourBtn(it) {
    if (!canWhite(it) || !isOn(it) || gone(it)) return '';
    return '<button class="cbtn" style="--c:' + colourOf(it) + '" data-expand="' + esc(it.id) + '" aria-expanded="' + (expanded.has(it.id) ? 'true' : 'false') + '" aria-label="Colour of ' + esc(it.name) + '" title="Colour"></button>';
  }
  function rangeHtml(it, pct) {
    return '<input class="lr" type="range" min="1" max="100" value="' + pct + '" style="--pct:' + pct + '%;--c:' + colourOf(it) + '" aria-label="Brightness of ' + esc(it.name) + '" data-bright="' + esc(it.id) + '">';
  }

  function tileHtml(it, icon, media, ctx) {
    var off = !isOn(it), na = gone(it), on = !off && !na;
    var pct = it.brightness ? Math.round(it.brightness / 2.55) : 0;
    var status = na ? 'Not responding'
      : media ? (on ? (it.title || 'On') : 'Off')
      : on ? (dimmable(it) ? pct + '%' : 'On') : 'Off';
    var c = media ? 'var(--accent)' : colourOf(it);
    var vol = media && on && (it.features & 4) && it.vol != null
      ? '<div class="vol">' + SPEAKER + '<input class="lr" type="range" min="0" max="100" value="' + Math.round(it.vol * 100) + '" style="--pct:' + Math.round(it.vol * 100) + '%;--c:var(--accent)" aria-label="Volume of ' + esc(it.name) + '" data-vol="' + esc(it.id) + '"></div>'
      : '';
    var bright = !media && on && dimmable(it) ? rangeHtml(it, pct) : '';
    return '<div class="tile' + (media ? ' media' : '') + (on ? ' on' : '') + (na ? ' gone' : '') + (hidden.has(it.id) ? ' is-hidden' : '') + '" style="--c:' + c + '"><span class="glow"></span>' +
      '<div class="line"><button class="tile-face" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">' +
      '<span class="bulb">' + icon + '</span><span class="name">' + esc(it.name) + '<div class="sub">' + esc(status) + '</div></span></button>' +
      (media ? '' : colourBtn(it)) + '</div>' + bright + vol + (media ? '' : paletteHtml(it)) + editRow(it, ctx) + '</div>';
  }

  var MODE_NAMES = { off: 'Off', cool: 'Cool', heat: 'Heat', heat_cool: 'Auto', auto: 'Auto', dry: 'Dry', fan_only: 'Fan' };
  var DOING = { cooling: 'Cooling', heating: 'Heating', idle: 'Holding', off: 'Off', drying: 'Drying', fan: 'Fan only' };
  function climateHtml(it, ctx) {
    var na = gone(it), mode = it.state;
    if (na) return '<div class="clim gone"><div class="line"><div class="name">' + esc(it.name) + '<div class="sub">Not responding</div></div></div>' + editRow(it, ctx) + '</div>';
    var lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90;
    var at = function (v) { return Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); };
    var hasSet = it.target != null && mode !== 'off';
    var now = it.cur != null ? at(it.cur) : null, set = hasSet ? at(it.target) : null;
    var scale = now == null ? '' : '<div class="scale" aria-hidden="true">' +
      (set != null ? '<span class="fill" style="left:' + Math.min(now, set) + '%;width:' + Math.abs(now - set) + '%"></span><span class="mk set" style="left:' + set + '%"></span>' : '') +
      '<span class="mk now" style="left:' + now + '%"></span></div><div class="scale-lbl"><span>' + lo + '°</span><span>' + hi + '°</span></div>';
    var doing = it.action ? (DOING[it.action] || it.action) : (MODE_NAMES[mode] || mode);
    var modes = Array.isArray(it.modesHvac) && it.modesHvac.length ? '<div class="modes" role="group" aria-label="Mode">' + it.modesHvac.map(function (m) {
      return '<button class="mode" aria-pressed="' + (m === mode) + '" data-mode="' + esc(it.id) + '" data-hvac="' + esc(m) + '">' + esc(MODE_NAMES[m] || m) + '</button>';
    }).join('') + '</div>' : '';
    return '<div class="clim ' + esc(mode) + (hidden.has(it.id) ? ' is-hidden' : '') + '"><span class="glow"></span>' +
      '<div class="line" style="position:relative"><div class="name">' + esc(it.name) + '</div></div>' +
      '<div class="clim-top"><div class="clim-now"><div class="temp">' + (it.cur != null ? esc(it.cur) + '°' : '—') + '</div><div class="clim-doing">' + esc(doing) + '</div></div>' +
      (hasSet ? '<div class="clim-set"><button class="step" aria-label="Cooler" data-temp="' + esc(it.id) + '" data-delta="' + (-(it.step || 1)) + '"' + (it.target <= lo ? ' disabled' : '') + '>−</button>' +
        '<div class="val"><b>' + esc(it.target) + '°</b><span class="sub">Set to</span></div>' +
        '<button class="step" aria-label="Warmer" data-temp="' + esc(it.id) + '" data-delta="' + (it.step || 1) + '"' + (it.target >= hi ? ' disabled' : '') + '>+</button></div>' : '<div class="clim-set sub">Off</div>') +
      '</div>' + scale + modes + editRow(it, ctx) + '</div>';
  }

  // ── Order ───────────────────────────────────────────────────────────────
  // A chosen order lists ids; anything not in it (a new device) goes last,
  // in Home Assistant's order.
  function ordered(list, key, idOf) {
    var o = order[key];
    if (!Array.isArray(o)) return list;
    var rank = function (x) { var i = o.indexOf(idOf(x)); return i < 0 ? 1e6 : i; };
    return list.map(function (x, i) { return [x, i]; })
      .sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; })
      .map(function (p) { return p[0]; });
  }
  function shift(key, ids, id, dir) {
    var i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    var next = ids.slice(); next[i] = ids[j]; next[j] = id;
    order[key] = next;
    persist({ order: order });
    render();
  }

  // ── Edit mode: one row of small controls under each thing ────────────────
  // ctx = { key, ids }: which list this thing sits in, for the up/down arrows.
  function ib(act, id, icon, label, extra) {
    return '<button class="ib" data-act="' + act + '" data-id="' + esc(id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"' + (extra || '') + '>' + icon + '</button>';
  }
  function haLink(path, label) {
    return '<a class="ib" href="' + esc(base + path) + '" target="_blank" rel="noopener" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + OUT + '</a>';
  }
  function editRow(it, ctx) {
    if (!editing || !ctx) return '';
    var id = it.id;
    if (renaming === id) {
      return '<div class="edit-row"><input class="yc-input" data-rn="' + esc(id) + '" value="' + esc(it.name) + '" aria-label="New name for ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="rename-save" data-id="' + esc(id) + '">Save</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="cancel">Cancel</button></div>';
    }
    if (newRoomFor === id) {
      return '<div class="edit-row"><input class="yc-input" data-nr="' + esc(id) + '" placeholder="New room’s name" aria-label="Name of the new room for ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="room-create" data-id="' + esc(id) + '">Create and move</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="cancel">Cancel</button></div>';
    }
    var i = ctx.ids.indexOf(id), f = fav.has(id), h = hidden.has(id);
    var here = roomOf(id);
    var pick = '<select class="yc-select" data-move="' + esc(id) + '" aria-label="Room for ' + esc(it.name) + '">' +
      (rooms || []).map(function (r) { return '<option value="' + esc(r.id) + '"' + (here && r.id === here.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') +
      '<option value="__new">New room…</option></select>';
    return '<div class="edit-row">' +
      ib('fav', id, f ? STAR_ON : STAR, f ? 'Remove from favourites' : 'Add to favourites', ' aria-pressed="' + f + '"') +
      ib('up', id, UP, 'Move up', ' data-key="' + esc(ctx.key) + '"' + (i <= 0 ? ' disabled' : '')) +
      ib('down', id, DOWN, 'Move down', ' data-key="' + esc(ctx.key) + '"' + (i >= ctx.ids.length - 1 ? ' disabled' : '')) +
      ib('rename', id, PENCIL, 'Rename') +
      (ctx.key === 'fav' ? '<span class="grow"></span>' : pick) +
      ib('hide', id, h ? EYE_OFF : EYE, h ? 'Show on this page' : 'Hide from this page', ' aria-pressed="false"') +
      (it.device ? haLink('/config/devices/device/' + encodeURIComponent(it.device), 'Open ' + it.name + ' in Home Assistant') : '') +
      '</div>';
  }

  function itemHtml(it, ctx) {
    var d = domain(it.id), off = !isOn(it), na = gone(it);
    var cls = 'thing' + (off ? ' off' : '') + (na ? ' gone' : '') + (hidden.has(it.id) ? ' is-hidden' : '');
    var sub = na ? '<div class="sub">Not responding</div>' : '';
    if (d === 'light') return tileHtml(it, BULB, false, ctx);
    if (d === 'climate') return climateHtml(it, ctx);
    if (d === 'media_player') return tileHtml(it, /tv/i.test(it.id + ' ' + it.name) ? TV : SPEAKER, true, ctx);
    if (d === 'camera') {
      return '<div class="' + cls + ' col"><div class="line"><div class="name">' + esc(it.name) + sub + '</div></div>' +
        (na ? '<div class="cam-empty">Camera not responding</div>' : '<img class="cam" alt="" role="img" aria-label="' + esc(it.name) + '" data-cam="' + esc(it.id) + '"' + (camCache[it.id] ? ' src="' + camCache[it.id] + '"' : '') + '>') + editRow(it, ctx) + '</div>';
    }
    return '';
  }

  function roomOf(id) {
    var found = null;
    (rooms || []).forEach(function (r) { r.items.forEach(function (x) { if (x.id === id) found = r; }); });
    return found;
  }
  function thing(id) {
    var r = roomOf(id);
    return r ? r.items.filter(function (x) { return x.id === id; })[0] : null;
  }
  function isLight(it) { return domain(it.id) === 'light'; }
  function liveLights(list) { return list.filter(function (it) { return isLight(it) && !gone(it) && !hidden.has(it.id); }); }

  // A room's lights, folded into one card. The All tile on top is the same
  // tile as a single light, with "All" under its bulb (Q-all); it switches
  // only lights, never the TV or speaker (Q-card). While editing, every card
  // is open so every light's controls can be reached.
  function lightsCard(room, lights, ctx) {
    var live = liveLights(lights), onList = live.filter(isOn), anyOn = onList.length > 0;
    var isOpen = editing || open.has(room.id);
    var c = anyOn ? colourOf(onList[0]) : 'rgb(255, 190, 110)';
    var status = !live.length ? 'Not responding' : anyOn ? onList.length + ' of ' + live.length + ' on' : 'All off';
    var all = '<div class="tile all' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><span class="glow"></span><div class="line">' +
      '<button class="tile-face" data-room="' + esc(room.id) + '" data-room-to="' + (anyOn ? 'off' : 'on') + '" aria-pressed="' + anyOn + '"' + (live.length ? '' : ' disabled') +
      ' aria-label="All lights in ' + esc(room.name) + ', ' + esc(status) + '">' +
      '<span class="bulb-col"><span class="bulb">' + BULB + '</span><span class="all-lbl">All</span></span>' +
      '<span class="name">Lights<div class="sub">' + esc(status) + '</div></span></button>' +
      (editing ? '' : '<button class="fold" data-fold="' + esc(room.id) + '" aria-expanded="' + isOpen + '" aria-label="' + (isOpen ? 'Hide' : 'Show') + ' each light in ' + esc(room.name) + '" title="' + (isOpen ? 'Hide each light' : 'Show each light') + '">' + CHEVRON + '</button>') +
      '</div></div>';
    return '<div class="lights">' + all + (isOpen ? '<div class="lights-body">' + lights.map(function (it) { return itemHtml(it, ctx); }).join('') + '</div>' : '') + '</div>';
  }

  var camCache = {};
  function refreshCameras() {
    if (!base || document.hidden) return;
    document.querySelectorAll('img[data-cam]').forEach(function (img) {
      var id = img.getAttribute('data-cam');
      window.youcoded.fetch(base + '/api/camera_proxy/' + id, { as: 'picture' }).then(function (r) {
        if (r.status === 200) { camCache[id] = r.body; img.src = r.body; }
      }, function () { /* the next round tries again */ });
    });
  }

  function barHtml() {
    var lit = [];
    (rooms || []).forEach(function (r) { liveLights(r.items).forEach(function (it) { if (isOn(it)) lit.push(it); }); });
    if (confirmOff && !lit.length) confirmOff = false;
    // Everything off asks first: one press darkens the whole house (Q-extras).
    var off = confirmOff
      ? '<div class="confirm" role="group" aria-label="Confirm"><span>Turn off ' + lit.length + ' light' + (lit.length === 1 ? '' : 's') + '?</span>' +
        '<button class="yc-button yc-button--sm yc-button--danger" data-act="house-off-yes">Turn off</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="house-off-no">Cancel</button></div>'
      : '<button class="yc-button yc-button--sm" data-act="house-off"' + (lit.length && !editing ? '' : ' disabled') + '>Everything off</button>';
    var count = hidden.size && !editing ? '<span class="yc-caption">' + hidden.size + ' hidden</span>' : '';
    return count + off + '<button class="yc-button yc-button--sm' + (editing ? ' yc-button--primary' : '') + '" data-act="edit" aria-pressed="' + editing + '">' + (editing ? 'Done' : 'Edit') + '</button>';
  }

  function roomHtml(room, roomIds) {
    var key = 'r:' + room.id;
    var items = ordered(room.items.filter(function (it) { return editing || !hidden.has(it.id); }), key, function (x) { return x.id; });
    if (!items.length) return '';
    var ctx = { key: key, ids: items.map(function (x) { return x.id; }) };
    var lights = items.filter(isLight), rest = items.filter(function (it) { return !isLight(it); });
    // One light needs no card: its own tile already does what All would.
    var lightsHtml = lights.length > 1 ? lightsCard(room, lights, ctx) : lights.map(function (it) { return itemHtml(it, ctx); }).join('');
    var i = roomIds.indexOf(room.id);
    var tools = editing
      ? ib('up', room.id, UP, 'Move ' + room.name + ' up', ' data-key="rooms"' + (i <= 0 ? ' disabled' : '')) +
        ib('down', room.id, DOWN, 'Move ' + room.name + ' down', ' data-key="rooms"' + (i >= roomIds.length - 1 ? ' disabled' : '')) +
        haLink('/config/areas/area/' + encodeURIComponent(room.id), 'Open ' + room.name + ' in Home Assistant')
      : '';
    return '<section class="yc-card room"><div class="room-head"><h2>' + esc(room.name) + '</h2>' + tools + '</div>' +
      lightsHtml + rest.map(function (it) { return itemHtml(it, ctx); }).join('') + '</section>';
  }

  function render() {
    $('root').classList.toggle('editing', editing);
    $('bar').innerHTML = barHtml();
    if (!rooms) return;
    var favItems = [];
    rooms.forEach(function (r) { r.items.forEach(function (it) { if (fav.has(it.id) && (editing || !hidden.has(it.id))) favItems.push(it); }); });
    favItems = ordered(favItems, 'fav', function (x) { return x.id; });
    var favCtx = { key: 'fav', ids: favItems.map(function (x) { return x.id; }) };
    $('favs').innerHTML = favItems.length
      ? '<section class="yc-card room"><div class="room-head fav-head">' + STAR_ON + '<h2>Favourites</h2></div><div class="fav-grid">' + favItems.map(function (it) { return itemHtml(it, favCtx); }).join('') + '</div></section>'
      : '';
    var list = ordered(rooms.filter(function (r) { return r.items.some(function (it) { return editing || !hidden.has(it.id); }); }), 'rooms', function (r) { return r.id; });
    var roomIds = list.map(function (r) { return r.id; });
    var html = list.map(function (r) { return roomHtml(r, roomIds); }).join('');
    $('rooms').innerHTML = html || '<div class="yc-empty">Nothing to show. Put devices in rooms in Home Assistant, or press Edit to bring hidden ones back.</div>';
    var box = document.querySelector('[data-rn],[data-nr]');
    if (box && document.activeElement !== box) { box.focus(); if (box.select) box.select(); }
  }

  // ── Changes made in Home Assistant itself (Q-where: names and rooms) ─────
  // Names and rooms change in Home Assistant itself, over its websocket.
  // One exchange: the app opens it, sends the greeting with the key, then
  // these messages; the answer is every message Home Assistant sent back.
  function registry(messages) {
    var send = messages.map(function (m, i) { return JSON.stringify(Object.assign({ id: i + 1 }, m)); });
    return window.youcoded.fetch(base + '/api/websocket', { socket: { send: send, until: send.length + 2, timeoutMs: 10000 } }).then(function (r) {
      var frames = [];
      try { frames = JSON.parse(r.body).map(function (f) { return JSON.parse(f); }); } catch (e) { /* answered below */ }
      if (frames.some(function (f) { return f.type === 'auth_invalid'; })) throw new Error('Home Assistant did not accept the key. Remove this connection and add a new key.');
      var results = frames.filter(function (f) { return f.type === 'result'; });
      if (results.length < send.length) throw new Error('Home Assistant did not answer in time. Nothing may have changed.');
      var bad = results.filter(function (f) { return !f.success; })[0];
      if (bad) throw new Error('Home Assistant said: ' + (bad.error && bad.error.message ? bad.error.message : 'that did not work') + '.');
      return results.map(function (f) { return f.result; });
    });
  }
  function afterChange() { setTimeout(load, 400); }
  function renameThing(id, name) {
    var it = thing(id);
    if (!it || !name || name === it.name) return;
    setLocal(id, { name: name });
    registry([{ type: 'config/entity_registry/update', entity_id: id, name: name }])
      .catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant did not take the new name.'); })
      .then(afterChange);
  }
  function moveThing(id, roomId, roomName) {
    var from = roomOf(id), it = thing(id);
    if (!from || !it || from.id === roomId) return;
    from.items = from.items.filter(function (x) { return x.id !== id; });
    var to = rooms.filter(function (r) { return r.id === roomId; })[0];
    if (!to) { to = { id: roomId, name: roomName || roomId, items: [] }; rooms.push(to); }
    to.items.push(it);
    render();
    var moveTo = function (areaId) {
      return registry([it.device ? { type: 'config/device_registry/update', device_id: it.device, area_id: areaId } : { type: 'config/entity_registry/update', entity_id: id, area_id: areaId }]);
    };
    // A new room is made first: Home Assistant picks its id, and the move
    // needs that id, so it is two exchanges.
    (roomName
      ? registry([{ type: 'config/area_registry/create', name: roomName }]).then(function (res) { return moveTo(res[0] && res[0].area_id ? res[0].area_id : roomId); })
      : moveTo(roomId))
      .catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant did not move it.'); })
      .then(afterChange);
  }
  function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'room'; }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act) { onAct(act, t.getAttribute('data-id'), t); return; }
    var fd = t.getAttribute('data-fold');
    if (fd) {
      if (open.has(fd)) open.delete(fd); else open.add(fd);
      persist({ open: Array.from(open) });
      render();
      return;
    }
    var ex = t.getAttribute('data-expand');
    if (ex) {
      if (expanded.has(ex)) expanded.delete(ex); else expanded.add(ex);
      window.youcoded.save(Object.assign({}, window.youcoded.data || {}, { expanded: Array.from(expanded) }));
      render();
      return;
    }
    var col = t.getAttribute('data-colour');
    if (col) {
      var k = t.getAttribute('data-k'), rgb = t.getAttribute('data-rgb');
      if (k) { setLocal(col, { k: Number(k), rgb: null }); service('light', 'turn_on', { entity_id: col, color_temp_kelvin: Number(k) }, col); }
      else { var v3 = rgb.split(',').map(Number); setLocal(col, { rgb: v3 }); service('light', 'turn_on', { entity_id: col, rgb_color: v3 }, col); }
      return;
    }
    var mid = t.getAttribute('data-mode');
    if (mid) {
      var hv = t.getAttribute('data-hvac');
      setLocal(mid, { state: hv });
      service('climate', 'set_hvac_mode', { entity_id: mid, hvac_mode: hv }, mid);
      return;
    }
    var roomId = t.getAttribute('data-room');
    if (roomId) {
      // One button that flips (round 2): any light on → it turns them all off.
      var turnOn = t.getAttribute('data-room-to') === 'on';
      var room = rooms.find(function (r) { return r.id === roomId; });
      var ids = liveLights(room.items).map(function (it) { return it.id; });
      ids.forEach(function (x) { setLocal(x, { state: turnOn ? 'on' : 'off' }); });
      service('light', turnOn ? 'turn_on' : 'turn_off', { entity_id: ids }, 'room:' + room.id);
      return;
    }
    var id = t.getAttribute('data-toggle');
    if (id) {
      var on = (t.getAttribute('aria-checked') || t.getAttribute('aria-pressed')) !== 'true';
      setLocal(id, { state: on ? 'on' : 'off' });
      service(domain(id), on ? 'turn_on' : 'turn_off', { entity_id: id }, id);
      return;
    }
    var tid = t.getAttribute('data-temp');
    if (tid) {
      var it = null;
      rooms.forEach(function (r) { r.items.forEach(function (x) { if (x.id === tid) it = x; }); });
      if (!it || it.target == null) return;
      var next = Math.round((Number(it.target) + Number(t.getAttribute('data-delta'))) * 10) / 10;
      if (it.min != null) next = Math.max(it.min, next);
      if (it.max != null) next = Math.min(it.max, next);
      setLocal(tid, { target: next });
      service('climate', 'set_temperature', { entity_id: tid, temperature: next }, tid);
    }
  });
  function onAct(act, id, t) {
    if (act === 'edit') {
      editing = !editing; renaming = null; newRoomFor = null; confirmOff = false;
      persist({ editing: editing });
      render();
      if (!editing) load();
      return;
    }
    if (act === 'house-off') { confirmOff = true; render(); return; }
    if (act === 'house-off-no') { confirmOff = false; render(); return; }
    if (act === 'house-off-yes') {
      confirmOff = false;
      var ids = [];
      rooms.forEach(function (r) { liveLights(r.items).forEach(function (it) { if (isOn(it)) ids.push(it.id); }); });
      ids.forEach(function (x) { setLocal(x, { state: 'off' }); });
      if (ids.length) service('light', 'turn_off', { entity_id: ids }, 'house');
      render();
      return;
    }
    if (act === 'fav') {
      if (fav.has(id)) fav.delete(id); else fav.add(id);
      persist({ fav: Array.from(fav) });
      render();
      return;
    }
    if (act === 'hide') {
      if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
      persist({ hidden: Array.from(hidden) });
      render();
      return;
    }
    if (act === 'up' || act === 'down') {
      var key = t.getAttribute('data-key');
      var ids2 = key === 'rooms' ? Array.from(document.querySelectorAll('[data-act="up"][data-key="rooms"]')).map(function (b) { return b.getAttribute('data-id'); })
        : Array.from(document.querySelectorAll('[data-act="up"][data-key="' + key + '"]')).map(function (b) { return b.getAttribute('data-id'); });
      shift(key, ids2, id, act === 'up' ? -1 : 1);
      return;
    }
    if (act === 'rename') { renaming = id; newRoomFor = null; render(); return; }
    if (act === 'cancel') { renaming = null; newRoomFor = null; render(); return; }
    if (act === 'rename-save') {
      var box = document.querySelector('[data-rn]');
      var name = box ? box.value.trim() : '';
      renaming = null;
      renameThing(id, name);
      render();
      return;
    }
    if (act === 'room-create') {
      var nb = document.querySelector('[data-nr]');
      var rn = nb ? nb.value.trim() : '';
      if (!rn) { if (nb) nb.focus(); return; }
      newRoomFor = null;
      moveThing(id, slug(rn), rn);
      return;
    }
  }
  // Enter saves a name, Escape gives it up.
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var rid = t.getAttribute('data-rn') || t.getAttribute('data-nr');
    if (!rid) return;
    if (e.key === 'Enter') { e.preventDefault(); onAct(t.hasAttribute('data-rn') ? 'rename-save' : 'room-create', rid, t); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onAct('cancel', rid, t); }
  }, true);
  // While dragging: move the fill only (no redraw, no request).
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('lr')) t.style.setProperty('--pct', t.value + '%');
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    var b = t.getAttribute && t.getAttribute('data-bright');
    if (b) {
      // The big slider reaches 0: dragging all the way down turns the light off.
      if (Number(t.value) === 0) { setLocal(b, { state: 'off' }); service('light', 'turn_off', { entity_id: b }, b); return; }
      setLocal(b, { state: 'on', brightness: Math.round(t.value * 2.55) }); service('light', 'turn_on', { entity_id: b, brightness_pct: Number(t.value) }, b); return;
    }
    // Any colour, from the rainbow swatch's colour picker.
    var any = t.getAttribute && t.getAttribute('data-any');
    if (any) {
      var m = /^#(..)(..)(..)$/.exec(t.value);
      if (m) { var c3 = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]; setLocal(any, { rgb: c3 }); service('light', 'turn_on', { entity_id: any, rgb_color: c3 }, any); }
      return;
    }
    var mv = t.getAttribute && t.getAttribute('data-move');
    if (mv) {
      if (t.value === '__new') { newRoomFor = mv; renaming = null; render(); return; }
      moveThing(mv, t.value);
      return;
    }
    var v = t.getAttribute && t.getAttribute('data-vol');
    if (v) { setLocal(v, { vol: t.value / 100 }); service('media_player', 'volume_set', { entity_id: v, volume_level: t.value / 100 }, v); }
  });

  // Checking every 5 seconds only while the page is on screen (deck Q-live):
  // a minimised window stops asking, and catches up the moment it is back.
  function start() {
    stop();
    load();
    timer = setInterval(function () { if (!document.hidden && !Object.keys(busy).length) load(); }, POLL_MS);
    camTimer = setInterval(refreshCameras, CAMERA_MS);
  }
  function stop() { clearInterval(timer); clearInterval(camTimer); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { load(); refreshCameras(); } });
  window.youcoded.onRefresh(function () { load(); refreshCameras(); });
  window.youcoded.onData(function (d) {
    d = d || {};
    hidden = new Set(Array.isArray(d.hidden) ? d.hidden : []);
    open = new Set(Array.isArray(d.open) ? d.open : []);
    fav = new Set(Array.isArray(d.fav) ? d.fav : []);
    order = d.order && typeof d.order === 'object' ? d.order : {};
    render();
  });
  start();
})();
</script>
</body></html>`;
}

export const HOME_ASSISTANT_PAGE_HTML = homeAssistantPageHtml();
