// How the Home page draws and how it tracks what you just did (redesign audit,
// 2026-10-04: A-1 "change only what changed", A-2 "one drawing per moment",
// A-4 "show sending, done, failed", A-6 "one list of pending changes").
// Kept apart from home-assistant-page.ts so neither file outgrows its line
// budget; HOME_REDRAW_JS is pasted INSIDE the page's script, so it shares its
// helpers (drawn, thing, rooms, held, heldVal, banner, render, draw, dragging …).
//
// Escapes: this text lives in a template string inside another one, so every
// backslash in the page's own code is doubled and no backtick may appear.

export const HOME_REDRAW_CSS = `
  /* A press that is slow, finished or refused says so on its own card (audit A-4). Kept neutral on purpose. */
  .pend { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--fg-muted); }
  .pend .pend-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-muted); flex-shrink: 0; }
  .pend[data-pend="done"] .pend-dot { background: rgb(50, 205, 90); }
  .pend[data-pend="failed"] { color: var(--fg); }
  .pend[data-pend="failed"] .pend-dot { background: rgb(235, 70, 55); }
  .banner .yc-button { margin-left: 10px; }
  /* The pop-up's history keeps its room while it loads, so the pop-up does not jump (audit F8). */
  .dlg-hist { min-height: 11em; }
`;

export const HOME_REDRAW_JS = `
  // ── Drawing in place (audit F1/F2/F3, A-1) ────────────────────────────────
  // put() used to replace a whole area's HTML whenever any character differed,
  // so one light changing rebuilt every card: a slider you held, a name you were
  // typing, keyboard focus, a hover, a playing clip and every CSS transition were
  // thrown away. morphInto() instead walks the new drawing against what is on the
  // page and changes only what differs. Cards are matched by their device id.
  var gripping = null; // the slider a finger or mouse is holding right now
  function keyOf(n) { return n.nodeType === 1 ? (n.getAttribute('data-eid') || n.id || null) : null; }
  function sameKind(a, b) { return a.nodeType === b.nodeType && a.nodeName === b.nodeName; }
  // Things the person is working in are left exactly as they are: a text box
  // being typed in, an open drop-down, a slider being dragged.
  function keepAsIs(el) {
    if (el !== document.activeElement) return false;
    if (el.nodeName === 'SELECT' || el.hasAttribute('data-rn') || el.hasAttribute('data-nr')) return true;
    return el.nodeName === 'INPUT' && el.type === 'range' && !!(dragging || gripping === el);
  }
  function patchEl(a, b) {
    var keep = keepAsIs(a);
    Array.prototype.slice.call(b.attributes).forEach(function (at) {
      if (keep && (at.name === 'style' || at.name === 'value')) return;
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    });
    Array.prototype.slice.call(a.attributes).forEach(function (at) {
      if (!b.hasAttribute(at.name) && !(keep && at.name === 'style')) a.removeAttribute(at.name);
    });
    // A player or live picture drawn by script lives inside these slots: never touched.
    if (!a.hasAttribute('data-live-slot') && !a.hasAttribute('data-clip-slot')) patchKids(a, b);
    if (keep) return;
    if (a.nodeName === 'INPUT') { var v = b.getAttribute('value'); if (v != null && a.value !== v) a.value = v; }
    else if (a.nodeName === 'SELECT') { var sel = b.querySelector('option[selected]'); if (sel && a.value !== sel.getAttribute('value')) a.value = sel.getAttribute('value'); }
  }
  function patchKids(a, b) {
    var byKey = {}, used = [];
    Array.prototype.forEach.call(a.childNodes, function (n) { var k = keyOf(n); if (k) byKey[k] = n; });
    var pos = a.firstChild;
    Array.prototype.slice.call(b.childNodes).forEach(function (bn) {
      var k = keyOf(bn), an = null;
      if (k) { an = byKey[k] && used.indexOf(byKey[k]) < 0 && sameKind(byKey[k], bn) ? byKey[k] : null; }
      else { for (var c = pos; c; c = c.nextSibling) { if (!keyOf(c) && used.indexOf(c) < 0 && sameKind(c, bn)) { an = c; break; } } }
      if (!an) { a.insertBefore(bn, pos); used.push(bn); return; }
      if (an === pos) pos = pos.nextSibling; else a.insertBefore(an, pos);
      used.push(an);
      if (an.nodeType === 1) patchEl(an, bn); else if (an.nodeValue !== bn.nodeValue) an.nodeValue = bn.nodeValue;
    });
    Array.prototype.slice.call(a.childNodes).forEach(function (n) { if (used.indexOf(n) < 0) a.removeChild(n); });
  }
  function morphInto(el, html) {
    if (!el.firstChild || !html) { el.innerHTML = html; return; }
    var t = document.createElement('template');
    t.innerHTML = html;
    patchKids(el, t.content);
  }
  document.addEventListener('pointerdown', function (e) { if (e.target.classList && e.target.classList.contains('lr')) gripping = e.target; }, true);
  // Letting go: whatever was held back while the slider was held draws now, and
  // the drawing is compared with the page afresh (a slider the house did not take
  // goes back, audit F6).
  function released() { gripping = null; drawn = {}; renderSoon(); }
  document.addEventListener('pointerup', released);
  document.addEventListener('pointercancel', released);
  document.addEventListener('change', function (e) { if (e.target.classList && e.target.classList.contains('lr')) released(); });

  // ── One drawing per moment (audit F3, A-2) ───────────────────────────────
  // What the person presses draws at once (render). Everything that arrives by
  // itself (a push, a check, a camera, history) asks with renderSoon(), and any
  // number of asks inside one frame become one drawing. batch() lets one press
  // that changes several cards ("All lights") draw once.
  var soonHandle = null, batching = 0, batchDirty = false;
  function renderSoon() {
    if (soonHandle !== null) return;
    soonHandle = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { soonHandle = null; render(); });
  }
  function batch(fn) {
    batching += 1;
    try { fn(); } finally { batching -= 1; }
    if (!batching && batchDirty) { batchDirty = false; draw(); }
  }

  // ── Pending changes (audit F5/F6/F7, A-4 and A-6) ────────────────────────
  // Every guess the page shows before the house has agreed (a pressed switch, a
  // dragged slider, a speaker tick, a new name) is kept in one place with what it
  // replaced. If the house does not take it, the old value comes back at once and
  // the card says "Didn't work" until dismissed or until the next press on it.
  // A slow one says "Sending…" (only after half a second, so quick presses stay
  // quiet) and then "Done".
  var pend = {}, pendSeq = 0, undoBuf = [], dragBefore = {};
  ['click', 'change', 'input'].forEach(function (n) { document.addEventListener(n, function () { undoBuf = []; }, true); });
  function undoAll(list) {
    (list || []).forEach(function (u) {
      var it = thing(u.id);
      if (it) Object.assign(it, u.before);
      delete held[u.id];
      Object.keys(u.before).forEach(function (k) { delete heldVal[u.id + '|' + k]; });
    });
  }
  function pendBegin(id, again) {
    var tok = ++pendSeq, e = pend[id] = { tok: tok, state: 'quiet', undo: undoBuf, again: again, msg: '' };
    undoBuf = [];
    e.timer = setTimeout(function () { if (pend[id] === e && e.state === 'quiet') { e.state = 'sending'; renderSoon(); } }, 500);
    return tok;
  }
  function pendEnd(id, tok, err) {
    var e = pend[id];
    if (!e || e.tok !== tok) return; // a newer press on the same thing took over
    clearTimeout(e.timer);
    if (err) return pendFail(id, e, err);
    if (e.state === 'sending') {
      e.state = 'done';
      e.timer = setTimeout(function () { if (pend[id] === e) { delete pend[id]; renderSoon(); } }, 1500);
    } else delete pend[id];
    renderSoon();
  }
  function pendFail(id, e, msg) {
    undoAll(e.undo);
    e.state = 'failed'; e.msg = msg;
    // Something with no card of its own (a scene, Everything off) says it in the bar at the top.
    if (!thing(id) && id.indexOf('room:') !== 0) { delete pend[id]; banner(msg, true); }
    render();
  }
  // A slider the house did not take (they send without waiting, so no pendBegin).
  function dragSnap(t) {
    var v = t.getAttribute('data-vol'), b = t.getAttribute('data-bright'), g = t.getAttribute('data-gbright'), key = v || b || (g ? 'room:' + g : null), list = [];
    if (!key) return;
    if (v) list.push({ id: v, fields: ['vol'] });
    else if (b) list.push({ id: b, fields: ['brightness', 'state'] });
    else (rooms || []).filter(function (r) { return r.id === g; }).forEach(function (r) { liveLights(r.items).filter(dimmable).forEach(function (x) { list.push({ id: x.id, fields: ['brightness', 'state'] }); }); });
    dragBefore[key] = list.map(function (p) { var it = thing(p.id), before = {}; p.fields.forEach(function (f) { before[f] = it ? it[f] : null; }); return { id: p.id, before: before }; });
  }
  function sliderFailed(key, msg) {
    var e = pend[key] = { tok: ++pendSeq, state: 'failed', undo: dragBefore[key], again: null, msg: msg };
    pendFail(key, e, msg);
  }
  function pendHtml(a, b) {
    var e = pend[a] && pend[a].state !== 'quiet' ? pend[a] : pend[b] && pend[b].state !== 'quiet' ? pend[b] : null;
    if (!e) return '';
    var key = pend[a] === e ? a : b;
    if (e.state === 'failed') {
      return '<div class="pend" role="alert" data-pend="failed"><span class="pend-dot" aria-hidden="true"></span><span>Didn\\u2019t work. ' + esc(e.msg) + '</span>' +
        (e.again ? '<button class="yc-button yc-button--sm" data-pend-retry="' + esc(key) + '">Try again</button>' : '') +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-pend-dismiss="' + esc(key) + '">Dismiss</button></div>';
    }
    return '<div class="pend" role="status" data-pend="' + e.state + '"><span class="pend-dot" aria-hidden="true"></span><span>' + (e.state === 'done' ? 'Done' : 'Sending\\u2026') + '</span></div>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-pend-dismiss],[data-pend-retry],[data-banner-dismiss]');
    if (!t) return;
    var d = t.getAttribute('data-pend-dismiss'), r = t.getAttribute('data-pend-retry');
    if (t.hasAttribute('data-banner-dismiss')) { bannerSticky = false; banner(''); return; }
    if (d) { delete pend[d]; render(); return; }
    var p = pend[r];
    if (p && p.again) { delete pend[r]; p.again(); }
  });
`;
