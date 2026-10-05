// Edit mode of the Home page: the "organise board" (redesign round 1, Edit c,
// picked by Destin 2026-10-04). Pressing Edit turns every room into slim rows,
// one line per device: drag the dots to reorder or to move it to another room
// (or into the dashed box for a new room), star and eye on the row, and tapping
// the name opens that device's settings under it. Replaces the old row of nine
// small buttons under every card.
//
// HOME_EDIT_JS is pasted INSIDE the page's script, so it shares its helpers
// (rooms, fav, hidden, order, newRoomFor, thing, roomOf, shift, persist, render,
// renameThing, moveThing, pendHtml, soundPick, esc, UP/DOWN/STAR …). Escapes:
// this text lives in a template string inside another one, so backslashes are
// doubled and no backtick may appear.

export const HOME_EDIT_CSS = `
  /* ── Edit: the organise board (redesign round 1, Edit c) ── */
  .edc-room .room-head { gap: 6px; }
  .edc-list { display: flex; flex-direction: column; gap: 6px; }
  .edc-row { position: relative; border: 1px solid var(--edge-dim); border-radius: var(--radius-md, 8px); background: var(--well); padding: 6px 8px; }
  .edc-row.open { border-color: var(--edge); }
  .edc-row.is-hidden .edc-main { opacity: .5; }
  .edc-main { display: flex; align-items: center; gap: 6px; }
  .edc-grip { width: 28px; height: 36px; display: inline-grid; place-items: center; color: var(--fg-muted); cursor: grab; touch-action: none; flex-shrink: 0; border-radius: 6px; user-select: none; }
  .edc-grip:hover { color: var(--fg); background: var(--inset); }
  .edc-name { flex: 1; min-width: 0; min-height: 36px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 1px; text-align: left; background: none; border: 0; color: var(--fg); padding: 2px 4px; cursor: pointer; border-radius: 6px; user-select: none; -webkit-touch-callout: none; }
  .edc-name:hover { background: var(--inset); }
  .edc-name:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .edc-n { font-size: 13px; font-weight: 500; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edc-k { font-size: 11px; color: var(--fg-muted); }
  .edc-row .ib { width: 34px; height: 34px; }
  .edc-lift { z-index: 20; opacity: .92; box-shadow: 0 8px 24px rgba(0, 0, 0, .35); pointer-events: none; background: var(--panel); }
  .edc-before { box-shadow: 0 -3px 0 0 var(--accent); }
  .edc-after { box-shadow: 0 3px 0 0 var(--accent); }
  .edc-hot { outline: 2px dashed var(--accent); outline-offset: 2px; }
  .edc-new { display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; text-align: center; min-height: 64px; padding: 12px; border: 2px dashed var(--edge); border-radius: var(--radius-lg, 12px); color: var(--fg-muted); font-size: 13px; break-inside: avoid; }
  .edc-new b { color: var(--fg); }
  .fav-grid:has(.edc-row) { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
  .edc-row .pend { margin-top: 6px; }
  .edx-menu { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; margin-top: 6px; border-top: 1px dashed var(--edge-dim); }
  .edx-f { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-muted); }
  .edx-f .yc-select, .edx-f .yc-input { height: 32px; font-size: 12px; min-width: 0; width: 100%; }
  .edx-in { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
  .edx-in .yc-input { flex: 1; min-width: 100px; width: auto; }
  .edx-menu .yc-button svg { margin-right: 4px; }
  .edx-links { display: flex; gap: 6px; flex-wrap: wrap; padding-left: 72px; }
  .edx-links .yc-button { text-decoration: none; display: inline-flex; align-items: center; }
  @media (max-width: 420px) { .edx-f { grid-template-columns: 1fr; gap: 4px; } .edx-links { padding-left: 0; } }
`;

export const HOME_EDIT_JS = `
  // ── Edit: the organise board (redesign round 1, Edit c) ───────────────────
  // ED.open is which row's settings are showing ("<id>|<list>": a device that is
  // also a favourite has two rows, and only the one you pressed opens).
  var ED = { open: saved.editOpen || null }, edDrag = false, edSuppress = false;
  var GRIP = '<svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3" r="1.6"/><circle cx="10" cy="3" r="1.6"/><circle cx="4" cy="9" r="1.6"/><circle cx="10" cy="9" r="1.6"/><circle cx="4" cy="15" r="1.6"/><circle cx="10" cy="15" r="1.6"/></svg>';
  function edReset() { ED.open = null; newRoomFor = null; }
  function edOpen(tok) { ED.open = ED.open === tok ? null : tok; newRoomFor = null; render(); }
  // Escape / Cancel: first the new-room box, then the settings, and the keyboard goes back to the row's name.
  function edCancel() {
    var tok = ED.open;
    if (newRoomFor !== null) newRoomFor = null; else ED.open = null;
    render();
    var n = tok && !ED.open ? document.querySelector('[data-ed-name="' + tok + '"]') : null;
    if (n) n.focus();
  }
  // WHY not for the name box on a phone: opening the settings should not throw the
  // keyboard up over the row; the new room's box (typing is its whole point) always takes focus.
  function edFocusBox() {
    var box = document.querySelector('[data-nr],[data-rn]');
    if (!box || box.__fx) return;
    box.__fx = 1;
    if (box.hasAttribute('data-rn') && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
    box.focus(); if (box.select) box.select();
  }
  function edKind(it) {
    var d = domain(it.id);
    if (d === 'light') return 'Light';
    if (d === 'climate') return 'Thermostat';
    if (d === 'camera') return 'Camera';
    var k = kindOf(it);
    return k === 'tv' ? 'TV' : k === 'soundbar' ? 'Soundbar' : k === 'display' ? 'Display' : 'Speaker';
  }
  function edIb(act, id, icon, label, extra) {
    return '<button class="ib" data-act="' + act + '" data-id="' + esc(id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"' + (extra || '') + '>' + icon + '</button>';
  }
  function edPanel(it, ctx, tok) {
    var id = it.id, i = ctx.ids.indexOf(id), here = roomOf(id);
    var roomBox = newRoomFor === id
      ? '<div class="edx-in"><input class="yc-input" data-nr="' + esc(id) + '" placeholder="New room’s name" aria-label="Name of the new room for ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="room-create" data-id="' + esc(id) + '">Create and move</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="cancel">Cancel</button></div>'
      : '<select class="yc-select" data-move="' + esc(id) + '" aria-label="Room for ' + esc(it.name) + '">' +
        (rooms || []).map(function (r) { return '<option value="' + esc(r.id) + '"' + (here && r.id === here.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') +
        '<option value="__new">New room…</option></select>';
    var snd = soundPick(it);
    return '<div class="edx-menu" role="group" aria-label="Settings for ' + esc(it.name) + '">' +
      '<div class="edx-f"><span>Name</span><div class="edx-in"><input class="yc-input" data-rn="' + esc(id) + '" value="' + esc(it.name) + '" aria-label="Name of ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="rename-save" data-id="' + esc(id) + '">Save</button></div></div>' +
      '<div class="edx-f"><span>Room</span>' + roomBox + '</div>' +
      (snd ? '<div class="edx-f"><span>TV sound</span>' + snd + '</div>' : '') +
      '<div class="edx-f"><span>Order</span><div class="edx-in">' +
        '<button class="yc-button yc-button--sm" data-act="up" data-id="' + esc(id) + '" data-key="' + esc(ctx.key) + '"' + (i <= 0 ? ' disabled' : '') + '>' + UP + 'Earlier</button>' +
        '<button class="yc-button yc-button--sm" data-act="down" data-id="' + esc(id) + '" data-key="' + esc(ctx.key) + '"' + (i >= ctx.ids.length - 1 ? ' disabled' : '') + '>' + DOWN + 'Later</button></div></div>' +
      '<div class="edx-links"><button class="yc-button yc-button--sm yc-button--ghost" data-dev="' + esc(id) + '">' + INFO + 'Details</button>' +
        (it.device ? '<a class="yc-button yc-button--sm yc-button--ghost" href="' + esc(base + '/config/devices/device/' + encodeURIComponent(it.device)) + '" target="_blank" rel="noopener">' + OUT + 'Open in Home Assistant</a>' : '') + '</div>' +
      '</div>';
  }
  // One device as a slim row. data-eid is the key the in-place drawing matches rows by.
  function edRowHtml(it, ctx) {
    var id = it.id, f = fav.has(id), h = hidden.has(id), tok = id + '|' + ctx.key, o = ED.open === tok;
    return '<div class="edc-row' + (h ? ' is-hidden' : '') + (o ? ' open' : '') + '" data-eid="' + esc(id) + '" data-edkey="' + esc(ctx.key) + '" data-edid="' + esc(id) + '">' +
      '<div class="edc-main"><span class="edc-grip" data-edgrip="1" title="Drag to reorder, or onto another room" aria-hidden="true">' + GRIP + '</span>' +
      '<button class="edc-name" data-act="edopen" data-tok="' + esc(tok) + '" data-ed-name="' + esc(tok) + '" aria-expanded="' + o + '" aria-label="Settings for ' + esc(it.name) + '"><span class="edc-n">' + esc(it.name) + '</span><span class="edc-k">' + edKind(it) + '</span></button>' +
      edIb('fav', id, f ? STAR_ON : STAR, f ? 'Remove from favourites' : 'Add to favourites', ' aria-pressed="' + f + '"') +
      edIb('hide', id, h ? EYE_OFF : EYE, h ? 'Show on this page' : 'Hide from this page') + '</div>' +
      (o ? edPanel(it, ctx, tok) : '') + pendHtml(id) + '</div>';
  }
  function edRoomHtml(room, roomIds) {
    var key = 'r:' + room.id;
    var items = ordered(room.items.filter(function (it) { return domain(it.id) !== 'remote' && !remoteDevice(it); }), key, function (x) { return x.id; });
    if (!items.length) return '';
    var ctx = { key: key, ids: items.map(function (x) { return x.id; }) }, i = roomIds.indexOf(room.id);
    return '<section class="yc-card room edc-room" id="edroom-' + esc(room.id) + '" data-edkey="rooms" data-edid="' + esc(room.id) + '"><div class="room-head"><span class="edc-grip" data-edgrip="1" data-edroomgrip="1" title="Drag to reorder rooms" aria-hidden="true">' + GRIP + '</span><h2>' + esc(room.name) + '</h2>' +
      edIb('up', room.id, UP, 'Move ' + room.name + ' up', ' data-key="rooms"' + (i <= 0 ? ' disabled' : '')) +
      edIb('down', room.id, DOWN, 'Move ' + room.name + ' down', ' data-key="rooms"' + (i >= roomIds.length - 1 ? ' disabled' : '')) +
      '<a class="ib" href="' + esc(base + '/config/areas/area/' + encodeURIComponent(room.id)) + '" target="_blank" rel="noopener" aria-label="Open ' + esc(room.name) + ' in Home Assistant" title="Open ' + esc(room.name) + ' in Home Assistant">' + OUT + '</a>' +
      '</div><div class="edc-list">' + items.map(function (it) { return edRowHtml(it, ctx); }).join('') + '</div></section>';
  }
  // The dashed box at the end: drop a device on it to start a new room; it turns into the name box.
  function edNewZone() {
    if (!editing) return '';
    var it = newRoomFor ? thing(newRoomFor) : null;
    if (it && !(ED.open && ED.open.split('|')[0] === newRoomFor)) {
      return '<section class="edc-new" id="edc-new"><span>New room for <b>' + esc(it.name) + '</b></span><div class="edx-in"><input class="yc-input" data-nr="' + esc(it.id) + '" placeholder="New room’s name" aria-label="Name of the new room for ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="room-create" data-id="' + esc(it.id) + '">Create and move</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="cancel">Cancel</button></div></section>';
    }
    return '<section class="edc-new" id="edc-new"><span>Drag a device here to put it in a new room</span></section>';
  }

  // Dragging. A mouse drags by the dots; a finger drags by the dots too, or by
  // pressing and holding a row (or a room's title) for a moment — a quick swipe
  // still scrolls the page. While a drag is on, the page does not redraw
  // (see draw), so a check landing mid-drag cannot undo it.
  var DR = null, edHold = null;
  function edClear() { Array.prototype.forEach.call(document.querySelectorAll('.edc-before, .edc-after, .edc-hot'), function (n) { n.classList.remove('edc-before', 'edc-after', 'edc-hot'); }); }
  function edIdsOf(key, skip) {
    return Array.prototype.map.call(document.querySelectorAll('.edc-row[data-edkey="' + key + '"]'), function (n) { return n.getAttribute('data-edid'); }).filter(function (x) { return x !== skip; });
  }
  function edStart(src, room, e, body) {
    DR = { room: room, src: src, x: e.clientX, y: e.clientY, moved: false, tgt: null, body: body };
    edDrag = true;
    try { if (e.target.setPointerCapture && e.pointerId != null) e.target.setPointerCapture(e.pointerId); } catch (x) { /* a drag still works without capture */ }
  }
  document.addEventListener('pointerdown', function (e) {
    if (!editing || e.button !== 0 || DR) return;
    var g = e.target.closest && e.target.closest('[data-edgrip]');
    if (g) {
      var room = g.hasAttribute('data-edroomgrip'), src = room ? g.closest('.edc-room') : g.closest('.edc-row');
      if (src) { e.preventDefault(); edStart(src, room, e, false); }
      return;
    }
    if (e.pointerType !== 'touch') return;
    var h = e.target.closest && e.target.closest('.edc-main, .edc-room > .room-head');
    if (!h || (e.target.closest('.ib') && !e.target.closest('.edc-room > .room-head h2'))) return;
    var isRoom = h.classList.contains('room-head'), s2 = h.parentNode;
    edHold = { x: e.clientX, y: e.clientY, t: setTimeout(function () { var ev = { clientX: edHold.x, clientY: edHold.y, target: h, pointerId: e.pointerId }; edHold = null; edStart(s2, isRoom, ev, true); }, 380) };
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (edHold && Math.abs(e.clientX - edHold.x) + Math.abs(e.clientY - edHold.y) > 8) { clearTimeout(edHold.t); edHold = null; }
    if (!DR) return;
    var dx = e.clientX - DR.x, dy = e.clientY - DR.y;
    if (!DR.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!DR.moved) { DR.moved = true; DR.src.classList.add('edc-lift'); }
    DR.src.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    if (window.scrollBy) { try { if (e.clientY < 60) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 14); } catch (x) { /* no scrolling here */ } }
    edClear(); DR.tgt = null;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    var row = DR.room ? null : el.closest('.edc-row'), sec = el.closest('.edc-room'), skey = DR.src.getAttribute('data-edkey');
    if (DR.room) {
      if (sec && sec !== DR.src) { var r = sec.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2; sec.classList.add(after ? 'edc-after' : 'edc-before'); DR.tgt = { el: sec, after: after }; }
      return;
    }
    if (row && row !== DR.src) {
      var tk = row.getAttribute('data-edkey');
      if (skey !== tk && (skey === 'fav' || tk === 'fav')) return; // a favourite stays in Favourites; a room's device stays in rooms
      var rr = row.getBoundingClientRect(), aft = e.clientY > rr.top + rr.height / 2;
      row.classList.add(aft ? 'edc-after' : 'edc-before'); DR.tgt = { el: row, after: aft };
    } else if (sec && skey !== 'fav') { sec.classList.add('edc-hot'); DR.tgt = { el: sec, end: true }; }
    else if (el.closest('#edc-new') && skey !== 'fav') { el.closest('#edc-new').classList.add('edc-hot'); DR.tgt = { el: el.closest('#edc-new'), fresh: true }; }
  }, true);
  function edDrop(cancel) {
    if (edHold) { clearTimeout(edHold.t); edHold = null; }
    if (!DR) return;
    var d = DR, t = d.tgt; DR = null;
    d.src.style.transform = ''; d.src.classList.remove('edc-lift'); edClear();
    edDrag = false;
    if (d.moved && d.body) { edSuppress = true; setTimeout(function () { edSuppress = false; }, 80); } // the press that ended a held drag is not a tap
    if (cancel || !d.moved || !t) { if (d.moved) render(); return; }
    if (d.room) {
      var secs = Array.prototype.map.call(document.querySelectorAll('.edc-room'), function (n) { return n.getAttribute('data-edid'); });
      var mine = d.src.getAttribute('data-edid'); secs = secs.filter(function (x) { return x !== mine; });
      secs.splice(secs.indexOf(t.el.getAttribute('data-edid')) + (t.after ? 1 : 0), 0, mine);
      order.rooms = secs; persist({ order: order }); render(); return;
    }
    var id = d.src.getAttribute('data-edid'), sk = d.src.getAttribute('data-edkey');
    if (t.fresh) { ED.open = null; newRoomFor = id; render(); return; }
    var tk = t.end ? 'r:' + t.el.getAttribute('data-edid') : t.el.getAttribute('data-edkey');
    var ids = edIdsOf(tk, id);
    if (t.end) ids.push(id); else ids.splice(ids.indexOf(t.el.getAttribute('data-edid')) + (t.after ? 1 : 0), 0, id);
    if (tk !== sk) moveThing(id, tk.slice(2));
    order[tk] = ids; persist({ order: order }); render();
  }
  document.addEventListener('pointerup', function () { edDrop(false); }, true);
  document.addEventListener('pointercancel', function () { edDrop(true); }, true);
  // A held finger that has started a drag must not also scroll the page.
  document.addEventListener('touchmove', function (e) { if (DR && e.cancelable) e.preventDefault(); }, { passive: false });
  document.addEventListener('click', function (e) { if (edSuppress) { edSuppress = false; e.stopPropagation(); e.preventDefault(); } }, true);
  document.addEventListener('keydown', function (e) { if (DR && e.key === 'Escape') { e.preventDefault(); edDrop(true); } }, true);
`;
