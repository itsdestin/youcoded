// Design options for the "edit" task of the Home page redesign. Keys are
// "<option>" or "<option>-<state>" (e.g. "a", "a-open"); each becomes the
// practice screen pages/page/page-home#v-edit-<key>. See types.ts.
//
// Three different MODELS of editing (not three skins of one row):
//   a  "Two quick buttons + More": each card keeps Favourite / Hide and one
//      More button that opens a small panel under that card.
//   b  "Tick, then act": tick any cards (or a whole room); one bar at the
//      bottom acts on everything ticked (multi-select).
//   c  "Organise board": Edit turns the page into slim rows you drag to
//      reorder or move between rooms; tap a row for its settings.
// Everything below is injected INSIDE the page's own script (by replacing a
// function by its exact text) so it can use the page's own state and its
// pretend-Home-Assistant save paths (renameThing, moveThing, registry).
import type { HomeVariants } from './types';

// WHY: a missing anchor must fail loudly, not silently show the old Edit.
function swap(html: string, from: string, to: string): string {
  if (html.indexOf(from) < 0) throw new Error('home-variants/edit: page text not found: ' + from.slice(0, 50));
  return html.split(from).join(to);
}

// Shared by all three: state, the panel of settings, small helpers.
const COMMON = String.raw`
  var ED = { menu: saved.edMenu || null, sel: {}, newRoom: false, newFor: null };
  (Array.isArray(saved.edSel) ? saved.edSel : []).forEach(function (x) { ED.sel[x] = true; });
  var CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';
  var GRIP = '<svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor"><circle cx="4" cy="3" r="1.6"/><circle cx="10" cy="3" r="1.6"/><circle cx="4" cy="9" r="1.6"/><circle cx="10" cy="9" r="1.6"/><circle cx="4" cy="15" r="1.6"/><circle cx="10" cy="15" r="1.6"/></svg>';
  function edKind(it) {
    var d = domain(it.id);
    if (d === 'light') return 'Light';
    if (d === 'climate') return 'Thermostat';
    if (d === 'camera') return 'Camera';
    var k = kindOf(it);
    return k === 'tv' ? 'TV' : k === 'soundbar' ? 'Soundbar' : k === 'display' ? 'Display' : 'Speaker';
  }
  function edRoomSelect(it) {
    var here = roomOf(it.id);
    return '<select class="yc-select" data-move="' + esc(it.id) + '" aria-label="Room for ' + esc(it.name) + '">' +
      (rooms || []).map(function (r) { return '<option value="' + esc(r.id) + '"' + (here && r.id === here.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') +
      '<option value="__new">New room…</option></select>';
  }
  // The settings panel (used by a and c): name, room, TV sound, order, details, Home Assistant.
  function edPanel(it, ctx, tok) {
    var id = it.id, i = ctx.ids.indexOf(id);
    var roomBox = newRoomFor === id
      ? '<div class="edx-in"><input class="yc-input" data-nr="' + esc(id) + '" placeholder="New room’s name" aria-label="Name of the new room for ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="room-create" data-id="' + esc(id) + '">Create and move</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="cancel">Cancel</button></div>'
      : edRoomSelect(it);
    var snd = soundPick(it);
    return '<div class="edx-menu">' +
      '<div class="edx-f"><span>Name</span><div class="edx-in"><input class="yc-input" data-edn="' + esc(id) + '" data-tok="' + esc(tok) + '" value="' + esc(it.name) + '" aria-label="Name of ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-ed="rename" data-id="' + esc(id) + '" data-tok="' + esc(tok) + '">Save</button></div></div>' +
      '<div class="edx-f"><span>Room</span>' + roomBox + '</div>' +
      (snd ? '<div class="edx-f"><span>TV sound</span>' + snd + '</div>' : '') +
      '<div class="edx-f"><span>Order</span><div class="edx-in">' +
        '<button class="yc-button yc-button--sm" data-ed="shift" data-dir="-1" data-id="' + esc(id) + '" data-key="' + esc(ctx.key) + '"' + (i <= 0 ? ' disabled' : '') + '>' + UP + 'Earlier</button>' +
        '<button class="yc-button yc-button--sm" data-ed="shift" data-dir="1" data-id="' + esc(id) + '" data-key="' + esc(ctx.key) + '"' + (i >= ctx.ids.length - 1 ? ' disabled' : '') + '>' + DOWN + 'Later</button></div></div>' +
      '<div class="edx-links"><button class="yc-button yc-button--sm yc-button--ghost" data-dev="' + esc(id) + '">' + INFO + 'Details</button>' +
        (it.device ? '<a class="yc-button yc-button--sm yc-button--ghost" href="' + esc(base + '/config/devices/device/' + encodeURIComponent(it.device)) + '" target="_blank" rel="noopener">' + OUT + 'Open in Home Assistant</a>' : '') + '</div>' +
      '</div>';
  }
  function edToggle(set, id, field) { if (set.has(id)) set.delete(id); else set.add(id); var p = {}; p[field] = Array.from(set); persist(p); }
  function edShift(key, id, dir) {
    var ids = Array.prototype.map.call(document.querySelectorAll('[data-edkey="' + key + '"]'), function (n) { return n.getAttribute('data-edid'); });
    shift(key, ids, id, dir);
  }
  // Make a new room in Home Assistant once, then move every id into it.
  function edMoveMany(ids, roomId, roomName) {
    if (!roomName) { ids.forEach(function (x) { moveThing(x, roomId); }); return; }
    registry([{ type: 'config/area_registry/create', name: roomName }]).then(function (res) {
      var aid = res[0] && res[0].area_id ? res[0].area_id : slug(roomName);
      ids.forEach(function (x) { moveThing(x, aid, roomName); });
    }).catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant did not make the room.'); }).then(afterChange);
  }
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute || !t.hasAttribute('data-edn')) return;
    if (e.key === 'Enter') { e.preventDefault(); var v = t.value.trim(); if (v) { renameThing(t.getAttribute('data-edn'), v); } }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ED.menu = null; render(); }
  }, true);
`;

// ---------------------------------------------------------------- A
const A_JS = String.raw`
  function edRowA(it, ctx) {
    if (!editing || !ctx) return '';
    var id = it.id, f = fav.has(id), h = hidden.has(id), tok = id + '|' + ctx.key, o = ED.menu === tok;
    var row = '<div class="edx" data-edkey="' + esc(ctx.key) + '" data-edid="' + esc(id) + '">' +
      '<button class="edx-b" data-ed="fav" data-id="' + esc(id) + '" aria-pressed="' + f + '">' + (f ? STAR_ON : STAR) + '<span>Favourite</span></button>' +
      '<button class="edx-b" data-ed="hide" data-id="' + esc(id) + '" aria-pressed="' + h + '">' + (h ? EYE_OFF : EYE) + '<span>' + (h ? 'Show' : 'Hide') + '</span></button>' +
      '<button class="edx-b edx-more" data-ed="more" data-tok="' + esc(tok) + '" aria-expanded="' + o + '"><span>More</span>' + CHEVRON + '</button></div>';
    return row + (o ? edPanel(it, ctx, tok) : '');
  }
  document.addEventListener('click', function (e) {
    var ed = e.target.closest && e.target.closest('[data-act="edit"]');
    if (ed) { ED.menu = null; return; }
    var b = e.target.closest && e.target.closest('[data-ed]');
    if (!b || !editing) return;
    var a = b.getAttribute('data-ed'), id = b.getAttribute('data-id');
    if (a === 'fav') { edToggle(fav, id, 'fav'); render(); }
    else if (a === 'hide') { edToggle(hidden, id, 'hidden'); render(); }
    else if (a === 'more') {
      var tok = b.getAttribute('data-tok'); ED.menu = ED.menu === tok ? null : tok; newRoomFor = null; render();
      if (ED.menu) { var n = document.querySelector('[data-edn][data-tok="' + tok + '"]'); if (n) n.focus(); }
    }
    else if (a === 'rename') { var box = document.querySelector('[data-edn="' + id + '"][data-tok="' + b.getAttribute('data-tok') + '"]'); var v = box ? box.value.trim() : ''; if (v) renameThing(id, v); }
    else if (a === 'shift') edShift(b.getAttribute('data-key'), id, Number(b.getAttribute('data-dir')));
  }, true);
`;
const A_CSS = String.raw`
  .edx { display: flex; gap: 6px; padding-top: 8px; border-top: 1px dashed var(--edge-dim); }
  .edx-b { height: 30px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--well); color: var(--fg-2); font-size: 12px; cursor: pointer; }
  .edx-b:hover { color: var(--fg); border-color: var(--edge); }
  .edx-b:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .edx-b[data-ed="fav"][aria-pressed="true"] { color: rgb(240, 180, 40); border-color: rgb(240, 180, 40); }
  .edx-b[data-ed="hide"][aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
  .edx-more { margin-left: auto; }
  .edx-more svg { transition: transform 150ms ease; }
  .edx-more[aria-expanded="true"] svg { transform: rotate(180deg); }
  .edx-menu { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
  .edx-f { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-muted); }
  .edx-f .yc-select, .edx-f .yc-input { height: 30px; font-size: 12px; min-width: 0; width: 100%; }
  .edx-in { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
  .edx-in .yc-input { flex: 1; min-width: 100px; width: auto; }
  .edx-menu .yc-button svg { margin-right: 4px; }
  .edx-links { display: flex; gap: 6px; flex-wrap: wrap; padding-left: 72px; }
  .edx-links .yc-button { text-decoration: none; display: inline-flex; align-items: center; }
  @media (max-width: 420px) { .edx-f { grid-template-columns: 1fr; gap: 4px; } .edx-links { padding-left: 0; } }
  @media (prefers-reduced-motion: reduce) { .edx-more svg { transition: none; } }
`;

// ---------------------------------------------------------------- B
const B_JS = String.raw`
  function edRowB(it, ctx) {
    if (!editing || !ctx) return '';
    var id = it.id, s = !!ED.sel[id];
    return '<button class="edt' + (s ? ' on' : '') + '" data-ed="tick" data-id="' + esc(id) + '" data-edkey="' + esc(ctx.key) + '" data-edid="' + esc(id) + '" aria-pressed="' + s + '">' +
      '<span class="edt-box">' + (s ? CHECK : '') + '</span><span>' + (s ? 'Selected' : 'Select') + '</span></button>';
  }
  function edRoomTick(room, items) {
    var ids = items.map(function (x) { return x.id; });
    var all = ids.length && ids.every(function (x) { return ED.sel[x]; });
    return '<button class="edt edt-room' + (all ? ' on' : '') + '" data-ed="room" data-ids="' + esc(ids.join(',')) + '" aria-pressed="' + !!all + '">' +
      '<span class="edt-box">' + (all ? CHECK : '') + '</span><span>' + (all ? 'Unselect all' : 'Select all') + '</span></button>';
  }
  function edSelIds() { return Object.keys(ED.sel).filter(function (x) { return ED.sel[x] && thing(x); }); }
  function edBarHtml(ids) {
    var n = ids.length, one = n === 1 ? thing(ids[0]) : null;
    var allFav = ids.every(function (x) { return fav.has(x); }), allHid = ids.every(function (x) { return hidden.has(x); });
    var key = one ? 'r:' + (roomOf(one.id) || {}).id : '';
    var html = '<div class="edb-top"><b>' + (one ? esc(one.name) : n + ' selected') + '</b>' +
      '<button class="edx-b" data-ed="bfav" aria-pressed="' + allFav + '">' + (allFav ? STAR_ON : STAR) + '<span>' + (allFav ? 'Unfavourite' : 'Favourite') + '</span></button>' +
      '<button class="edx-b" data-ed="bhide" aria-pressed="' + allHid + '">' + (allHid ? EYE_OFF : EYE) + '<span>' + (allHid ? 'Show' : 'Hide') + '</span></button>' +
      (ED.newRoom ? '' : '<select class="yc-select" data-edroom aria-label="Move to a room"><option value="">Move to…</option>' +
        (rooms || []).map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>'; }).join('') + '<option value="__new">New room…</option></select>') +
      (one ? '<button class="edx-b" data-ed="bshift" data-dir="-1" data-key="' + esc(key) + '">' + UP + '<span>Earlier</span></button><button class="edx-b" data-ed="bshift" data-dir="1" data-key="' + esc(key) + '">' + DOWN + '<span>Later</span></button>' : '') +
      '<button class="edx-b edx-more" data-ed="clear"><span>Clear</span></button></div>';
    if (ED.newRoom) html += '<div class="edb-row"><input class="yc-input" data-ednewroom placeholder="New room’s name" aria-label="Name of the new room">' +
      '<button class="yc-button yc-button--sm yc-button--primary" data-ed="bnew">Create and move ' + n + '</button><button class="yc-button yc-button--sm yc-button--ghost" data-ed="bnewno">Cancel</button></div>';
    if (one) {
      var snd = soundPick(one);
      html += '<div class="edb-row"><input class="yc-input" data-edn="' + esc(one.id) + '" data-tok="bar" value="' + esc(one.name) + '" aria-label="Name of ' + esc(one.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-ed="brename" data-id="' + esc(one.id) + '">Rename</button>' + (snd || '') +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-dev="' + esc(one.id) + '">' + INFO + 'Details</button>' +
        (one.device ? '<a class="yc-button yc-button--sm yc-button--ghost" href="' + esc(base + '/config/devices/device/' + encodeURIComponent(one.device)) + '" target="_blank" rel="noopener">' + OUT + 'Open in Home Assistant</a>' : '') + '</div>';
    }
    return html;
  }
  function edSync() {
    var bar = document.getElementById('edbar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'edbar'; bar.className = 'edb'; document.getElementById('root').appendChild(bar); }
    if (!editing) { ED.sel = {}; ED.newRoom = false; }
    var ids = editing ? edSelIds() : [];
    if (!ids.length) ED.newRoom = false;
    var html = ids.length ? edBarHtml(ids) : '';
    if (bar.__h !== html) { bar.__h = html; bar.innerHTML = html; }
    bar.hidden = !html;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-ed]');
    if (!b || !editing) return;
    var a = b.getAttribute('data-ed'), id = b.getAttribute('data-id'), ids = edSelIds();
    if (a === 'tick') { ED.sel[id] = !ED.sel[id]; render(); }
    else if (a === 'room') {
      var rids = b.getAttribute('data-ids').split(','), all = rids.every(function (x) { return ED.sel[x]; });
      rids.forEach(function (x) { ED.sel[x] = !all; }); render();
    }
    else if (a === 'clear') { ED.sel = {}; render(); }
    else if (a === 'bfav') { var af = ids.every(function (x) { return fav.has(x); }); ids.forEach(function (x) { if (af) fav.delete(x); else fav.add(x); }); persist({ fav: Array.from(fav) }); render(); }
    else if (a === 'bhide') { var ah = ids.every(function (x) { return hidden.has(x); }); ids.forEach(function (x) { if (ah) hidden.delete(x); else hidden.add(x); }); persist({ hidden: Array.from(hidden) }); render(); }
    else if (a === 'bshift') edShift(b.getAttribute('data-key'), ids[0], Number(b.getAttribute('data-dir')));
    else if (a === 'brename') { var box = document.querySelector('[data-edn][data-tok="bar"]'); var v = box ? box.value.trim() : ''; if (v) renameThing(id, v); }
    else if (a === 'bnewno') { ED.newRoom = false; render(); }
    else if (a === 'bnew') {
      var nb = document.querySelector('[data-ednewroom]'), nm = nb ? nb.value.trim() : '';
      if (!nm) { if (nb) nb.focus(); return; }
      ED.newRoom = false; edMoveMany(ids, null, nm); render();
    }
  }, true);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-edroom') || !t.value) return;
    var ids = edSelIds();
    if (t.value === '__new') { ED.newRoom = true; render(); var nb = document.querySelector('[data-ednewroom]'); if (nb) nb.focus(); return; }
    edMoveMany(ids, t.value, null); t.value = '';
  }, true);
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-ednewroom') && e.key === 'Enter') { e.preventDefault(); var bn = document.querySelector('[data-ed="bnew"]'); if (bn) bn.click(); }
  }, true);
`;
const B_CSS = String.raw`
  .edt { display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 10px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--well); color: var(--fg-2); font-size: 12px; cursor: pointer; text-align: left; }
  .edt:hover { color: var(--fg); border-color: var(--edge); }
  .edt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .edt-box { width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--fg-muted); display: inline-grid; place-items: center; flex-shrink: 0; }
  .edt.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
  .edt.on .edt-box { border-color: var(--on-accent); }
  .edt-room { width: auto; height: 28px; }
  [data-eid]:has(> .edt.on) { outline: 2px solid var(--accent); outline-offset: -2px; }
  .edx-b { height: 30px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--well); color: var(--fg-2); font-size: 12px; cursor: pointer; }
  .edx-b:hover { color: var(--fg); border-color: var(--edge); }
  .edx-b[data-ed="bfav"][aria-pressed="true"] { color: rgb(240, 180, 40); border-color: rgb(240, 180, 40); }
  .edx-b[data-ed="bhide"][aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
  .edx-more { margin-left: auto; }
  .edb { position: sticky; bottom: 8px; z-index: 5; display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--radius-lg, 12px); background: var(--panel); border: 1px solid var(--edge); box-shadow: 0 6px 24px rgba(0, 0, 0, .3); }
  .edb[hidden] { display: none; }
  .edb-top, .edb-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .edb-top b { font-size: 13px; margin-right: 4px; }
  .edb .yc-select, .edb .yc-input { height: 30px; font-size: 12px; min-width: 0; flex: 0 1 170px; }
  .edb .yc-input { flex: 1 1 150px; }
  .edb .yc-button svg { margin-right: 4px; }
  .edb a.yc-button { text-decoration: none; display: inline-flex; align-items: center; }
`;

// ---------------------------------------------------------------- C
const C_JS = String.raw`
  function edRowC(it, ctx) {
    var id = it.id, f = fav.has(id), h = hidden.has(id), tok = id + '|' + ctx.key, o = ED.menu === tok;
    return '<div class="edc-row' + (h ? ' is-hidden' : '') + (o ? ' open' : '') + '" data-edrow="' + esc(id) + '" data-edkey="' + esc(ctx.key) + '" data-edid="' + esc(id) + '">' +
      '<div class="edc-main"><span class="edc-grip" data-edgrip="1" title="Drag to reorder, or onto another room" aria-hidden="true">' + GRIP + '</span>' +
      '<button class="edc-name" data-ed="open" data-tok="' + esc(tok) + '" aria-expanded="' + o + '"><span class="edc-n">' + esc(it.name) + '</span><span class="edc-k">' + edKind(it) + '</span></button>' +
      '<button class="ib" data-ed="fav" data-id="' + esc(id) + '" aria-pressed="' + f + '" aria-label="' + (f ? 'Remove from favourites' : 'Add to favourites') + '" title="Favourite">' + (f ? STAR_ON : STAR) + '</button>' +
      '<button class="ib" data-ed="hide" data-id="' + esc(id) + '" aria-label="' + (h ? 'Show on this page' : 'Hide from this page') + '" title="' + (h ? 'Show' : 'Hide') + '">' + (h ? EYE_OFF : EYE) + '</button></div>' +
      (o ? edPanel(it, ctx, tok) : '') + '</div>';
  }
  function edRoomC(room, roomIds) {
    var key = 'r:' + room.id;
    var items = ordered(room.items.filter(function (it) { return domain(it.id) !== 'remote' && !remoteDevice(it); }), key, function (x) { return x.id; });
    if (!items.length) return '';
    var ctx = { key: key, ids: items.map(function (x) { return x.id; }) };
    var i = roomIds.indexOf(room.id);
    return '<section class="yc-card room edc-room" data-edroomid="' + esc(room.id) + '"><div class="room-head"><span class="edc-grip" data-edgrip="1" data-edroomgrip="1" title="Drag to reorder rooms" aria-hidden="true">' + GRIP + '</span><h2>' + esc(room.name) + '</h2>' +
      ib('up', room.id, UP, 'Move ' + room.name + ' up', ' data-key="rooms"' + (i <= 0 ? ' disabled' : '')) +
      ib('down', room.id, DOWN, 'Move ' + room.name + ' down', ' data-key="rooms"' + (i >= roomIds.length - 1 ? ' disabled' : '')) +
      haLink('/config/areas/area/' + encodeURIComponent(room.id), 'Open ' + room.name + ' in Home Assistant') +
      '</div><div class="edc-list">' + items.map(function (it) { return edRowC(it, ctx); }).join('') + '</div></section>';
  }
  function edNewZone() {
    if (!editing) return '';
    var it = ED.newFor ? thing(ED.newFor) : null;
    if (it) return '<section class="edc-new" id="edc-new"><span>New room for <b>' + esc(it.name) + '</b></span><div class="edx-in"><input class="yc-input" data-ednr placeholder="Room name" aria-label="Name of the new room">' +
      '<button class="yc-button yc-button--sm yc-button--primary" data-ed="newgo">Create and move</button><button class="yc-button yc-button--sm yc-button--ghost" data-ed="newno">Cancel</button></div></section>';
    return '<section class="edc-new" id="edc-new"><span>Drag a device here to put it in a new room</span></section>';
  }
  document.addEventListener('click', function (e) {
    var ed0 = e.target.closest && e.target.closest('[data-act="edit"]');
    if (ed0) { ED.menu = null; ED.newFor = null; return; }
    var b = e.target.closest && e.target.closest('[data-ed]');
    if (!b || !editing) return;
    var a = b.getAttribute('data-ed'), id = b.getAttribute('data-id');
    if (a === 'fav') { edToggle(fav, id, 'fav'); render(); }
    else if (a === 'hide') { edToggle(hidden, id, 'hidden'); render(); }
    else if (a === 'open') {
      var tok = b.getAttribute('data-tok'); ED.menu = ED.menu === tok ? null : tok; newRoomFor = null; render();
      if (ED.menu) { var n = document.querySelector('[data-edn][data-tok="' + tok + '"]'); if (n) n.focus(); }
    }
    else if (a === 'rename') { var box = document.querySelector('[data-edn="' + id + '"][data-tok="' + b.getAttribute('data-tok') + '"]'); var v = box ? box.value.trim() : ''; if (v) renameThing(id, v); }
    else if (a === 'shift') edShift(b.getAttribute('data-key'), id, Number(b.getAttribute('data-dir')));
    else if (a === 'newno') { ED.newFor = null; render(); }
    else if (a === 'newgo') {
      var nb = document.querySelector('[data-ednr]'), nm = nb ? nb.value.trim() : '';
      if (!nm) { if (nb) nb.focus(); return; }
      var who = ED.newFor; ED.newFor = null; edMoveMany([who], null, nm); render();
    }
  }, true);
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-ednr') && e.key === 'Enter') { e.preventDefault(); var g = document.querySelector('[data-ed="newgo"]'); if (g) g.click(); }
  }, true);

  // Dragging by the grip: a row to reorder or to move into another room (or the
  // new-room box); a room's grip reorders rooms. The page does not redraw
  // itself while 'dragging' is set, so a check landing mid-drag cannot wipe it.
  var DR = null;
  function edClear() { Array.prototype.forEach.call(document.querySelectorAll('.edc-before, .edc-after, .edc-hot'), function (n) { n.classList.remove('edc-before', 'edc-after', 'edc-hot'); }); }
  function edIdsOf(key, skip) {
    return Array.prototype.map.call(document.querySelectorAll('.edc-row[data-edkey="' + key + '"]'), function (n) { return n.getAttribute('data-edid'); }).filter(function (x) { return x !== skip; });
  }
  document.addEventListener('pointerdown', function (e) {
    if (!editing || e.button !== 0) return;
    var g = e.target.closest && e.target.closest('[data-edgrip]');
    if (!g) return;
    var room = g.hasAttribute('data-edroomgrip');
    var src = room ? g.closest('.edc-room') : g.closest('.edc-row');
    if (!src) return;
    e.preventDefault();
    DR = { room: room, src: src, x: e.clientX, y: e.clientY, moved: false, tgt: null };
    dragging = 'ed';
    try { g.setPointerCapture(e.pointerId); } catch (x) { /* a drag still works without capture */ }
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (!DR) return;
    var dx = e.clientX - DR.x, dy = e.clientY - DR.y;
    if (!DR.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!DR.moved) { DR.moved = true; DR.src.classList.add('edc-lift'); }
    DR.src.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    if (e.clientY < 60) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 14);
    edClear(); DR.tgt = null;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    var row = DR.room ? null : el.closest('.edc-row'), sec = el.closest('.edc-room');
    if (DR.room) {
      if (sec && sec !== DR.src) { var r = sec.getBoundingClientRect(); var after = e.clientY > r.top + r.height / 2; sec.classList.add(after ? 'edc-after' : 'edc-before'); DR.tgt = { el: sec, after: after }; }
      return;
    }
    if (row && row !== DR.src) {
      var sk = DR.src.getAttribute('data-edkey'), tk = row.getAttribute('data-edkey');
      if (sk !== tk && (sk === 'fav' || tk === 'fav')) return;
      var rr = row.getBoundingClientRect(), aft = e.clientY > rr.top + rr.height / 2;
      row.classList.add(aft ? 'edc-after' : 'edc-before'); DR.tgt = { el: row, after: aft };
    } else if (sec && DR.src.getAttribute('data-edkey') !== 'fav') {
      sec.classList.add('edc-hot'); DR.tgt = { el: sec, end: true };
    } else if (el.closest('#edc-new') && DR.src.getAttribute('data-edkey') !== 'fav') {
      el.closest('#edc-new').classList.add('edc-hot'); DR.tgt = { el: el.closest('#edc-new'), fresh: true };
    }
  }, true);
  function edDrop(cancel) {
    if (!DR) return;
    var d = DR; DR = null;
    d.src.style.transform = ''; d.src.classList.remove('edc-lift'); edClear();
    setTimeout(function () { dragging = null; }, 0);
    if (cancel || !d.moved || !d.tgt) return;
    var t = d.tgt;
    if (d.room) {
      var secs = Array.prototype.map.call(document.querySelectorAll('.edc-room'), function (n) { return n.getAttribute('data-edroomid'); });
      var mine = d.src.getAttribute('data-edroomid'); secs = secs.filter(function (x) { return x !== mine; });
      var at = secs.indexOf(t.el.getAttribute('data-edroomid')) + (t.after ? 1 : 0);
      secs.splice(at, 0, mine); order.rooms = secs; persist({ order: order }); render(); return;
    }
    var id = d.src.getAttribute('data-edid'), sk = d.src.getAttribute('data-edkey');
    if (t.fresh) { ED.newFor = id; render(); var nb = document.querySelector('[data-ednr]'); if (nb) nb.focus(); return; }
    var tk = t.end ? 'r:' + t.el.getAttribute('data-edroomid') : t.el.getAttribute('data-edkey');
    var ids = edIdsOf(tk, id);
    if (t.end) ids.push(id); else { var i = ids.indexOf(t.el.getAttribute('data-edid')) + (t.after ? 1 : 0); ids.splice(i, 0, id); }
    if (tk !== sk) moveThing(id, tk.slice(2));
    order[tk] = ids; persist({ order: order }); render();
  }
  document.addEventListener('pointerup', function () { edDrop(false); }, true);
  document.addEventListener('pointercancel', function () { edDrop(true); }, true);
`;
const C_CSS = String.raw`
  .edc-room .room-head { gap: 6px; }
  .edc-list { display: flex; flex-direction: column; gap: 6px; }
  .edc-row { position: relative; border: 1px solid var(--edge-dim); border-radius: var(--radius-md, 8px); background: var(--well); padding: 6px 8px; }
  .edc-row.open { border-color: var(--edge); }
  .edc-row.is-hidden .edc-main { opacity: .5; }
  .edc-main { display: flex; align-items: center; gap: 6px; }
  .edc-grip { width: 24px; height: 32px; display: inline-grid; place-items: center; color: var(--fg-muted); cursor: grab; touch-action: none; flex-shrink: 0; border-radius: 6px; }
  .edc-grip:hover { color: var(--fg); background: var(--inset); }
  .edc-name { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; text-align: left; background: none; border: 0; color: var(--fg); padding: 2px 4px; cursor: pointer; border-radius: 6px; }
  .edc-name:hover { background: var(--inset); }
  .edc-name:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .edc-n { font-size: 13px; font-weight: 500; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edc-k { font-size: 11px; color: var(--fg-muted); }
  .edc-lift { z-index: 20; opacity: .92; box-shadow: 0 8px 24px rgba(0, 0, 0, .35); pointer-events: none; background: var(--panel); }
  .edc-room.edc-lift { pointer-events: none; }
  .edc-before { box-shadow: 0 -3px 0 0 var(--accent); }
  .edc-after { box-shadow: 0 3px 0 0 var(--accent); }
  .edc-hot { outline: 2px dashed var(--accent); outline-offset: 2px; }
  .edc-row .edx-menu { border-top: 1px dashed var(--edge-dim); margin-top: 6px; }
  .edc-new { display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; text-align: center; min-height: 64px; padding: 12px; border: 2px dashed var(--edge); border-radius: var(--radius-lg, 12px); color: var(--fg-muted); font-size: 13px; break-inside: avoid; }
  .edc-new b { color: var(--fg); }
  .fav-grid:has(.edc-row) { display: flex; flex-direction: column; gap: 6px; }
  .edx-f { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-muted); }
  .edx-menu { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
  .edx-f .yc-select, .edx-f .yc-input { height: 30px; font-size: 12px; min-width: 0; width: 100%; }
  .edx-in { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
  .edx-in .yc-input { flex: 1; min-width: 100px; width: auto; }
  .edx-menu .yc-button svg { margin-right: 4px; }
  .edx-links { display: flex; gap: 6px; flex-wrap: wrap; padding-left: 72px; }
  .edx-links .yc-button { text-decoration: none; display: inline-flex; align-items: center; }
  @media (max-width: 420px) { .edx-f { grid-template-columns: 1fr; gap: 4px; } .edx-links { padding-left: 0; } }
`;

// The panel's shared styles also belong to A (already in A_CSS) — C repeats the few it needs.

const A_FN = 'function editRow(it, ctx) {';
function optionA(h: string): string {
  return swap(h, A_FN, COMMON + A_JS + 'function editRow(it, ctx) { return edRowA(it, ctx); } function editRowOld(it, ctx) {');
}
function optionB(h: string): string {
  let o = swap(h, A_FN, COMMON + B_JS + 'function editRow(it, ctx) { return edRowB(it, ctx); } function editRowOld(it, ctx) {');
  // The room's heading gets a "Select all" button.
  o = swap(o, "'</h2>' + tools + '</div>'", "'</h2>' + (editing ? edRoomTick(room, items) : '') + tools + '</div>'");
  // Redraw the bottom bar whenever the page redraws.
  return swap(o, 'function render() {', 'function render() { edSync();');
}
function optionC(h: string): string {
  let o = swap(h, A_FN, COMMON + C_JS + 'function editRow(it, ctx) { return \'\'; } function editRowOld(it, ctx) {');
  // In Edit the rooms become slim rows; outside Edit nothing changes.
  o = swap(o, 'function roomHtml(room, roomIds, forceOpen) {', 'function roomHtml(room, roomIds, forceOpen) { if (editing) return edRoomC(room, roomIds); return roomHtml0(room, roomIds, forceOpen); } function roomHtml0(room, roomIds, forceOpen) {');
  o = swap(o, 'function itemHtml(it, ctx) {', 'function itemHtml(it, ctx) { if (editing) return edRowC(it, ctx); return itemHtml0(it, ctx); } function itemHtml0(it, ctx) {');
  return swap(o, "var html = list.map(function (r) { return roomHtml(r, roomIds); }).join('');", "var html = list.map(function (r) { return roomHtml(r, roomIds); }).join('') + edNewZone();");
}

export const VARIANTS: HomeVariants = {
  a: { label: 'Two buttons and More', transform: optionA, css: A_CSS, data: { editing: true } },
  'a-more': { label: 'Two buttons and More, panel open', transform: optionA, css: A_CSS, data: { editing: true, edMenu: 'media_player.destins_room_tv|r:destins_room' } },
  b: { label: 'Tick, then act', transform: optionB, css: B_CSS, data: { editing: true } },
  'b-one': { label: 'Tick, then act, one ticked', transform: optionB, css: B_CSS, data: { editing: true, edSel: ['media_player.destins_room_tv'] } },
  'b-many': { label: 'Tick, then act, three ticked', transform: optionB, css: B_CSS, data: { editing: true, edSel: ['light.overhead_light', 'light.desk_backlight', 'light.hue_play_1'] } },
  c: { label: 'Organise board', transform: optionC, css: C_CSS, data: { editing: true } },
  'c-open': { label: 'Organise board, row open', transform: optionC, css: C_CSS, data: { editing: true, edMenu: 'media_player.destins_room_tv|r:destins_room' } },
};
