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
  .banner .yc-button { margin-left: 10px; }
`;

export const HOME_REDRAW_JS = `
  // ── Drawing in place (audit F1/F2/F3, A-1) ────────────────────────────────
  // put() used to replace a whole area's HTML whenever any character differed,
  // so one light changing rebuilt every card: a slider you held, a name you were
  // typing, keyboard focus, a hover, a playing clip and every CSS transition were
  // thrown away. morphInto() instead walks the new drawing against what is on the
  // page and changes only what differs. Cards are matched by their device id.
  var gripping = null; // the slider a finger or mouse is holding right now
  // WHY data-slot / data-app: a TV card's pad, key row and app buttons are matched to themselves (never to a neighbour that is
  // merely another div), so a redraw mid-animation keeps the same elements and the CSS transition carries on.
  // WHY every control and media slot has a key (code review 1, 2, 11): a thing is matched to
  // the SAME thing by its key, never to a neighbour that merely has the same tag, so an input
  // is never reused as another input, a video slot never keeps another slot's player, and a
  // typed name belongs to its own device.
  var KEYS = ['data-eid', 'id', 'data-rn', 'data-nr', 'data-vol', 'data-bright', 'data-gbright', 'data-move', 'data-sound', 'data-any', 'data-clip-slot', 'data-live-slot', 'data-k', 'data-slot', 'data-app'];
  function keyOf(n) {
    if (n.nodeType !== 1) return null;
    for (var i = 0; i < KEYS.length; i++) { var v = n.getAttribute(KEYS[i]); if (v != null && v !== '') return KEYS[i] + ':' + v; }
    return null;
  }
  function sameKind(a, b) { return a.nodeType === b.nodeType && a.nodeName === b.nodeName && (a.nodeName !== 'INPUT' || a.type === b.type); }
  // Things the person is working in are left exactly as they are: a name box (focused or
  // not: clicking elsewhere must not reset it, code review 2), an open drop-down, a
  // slider being dragged.
  function keepAsIs(el) {
    if (el.hasAttribute('data-rn') || el.hasAttribute('data-nr')) return true;
    // WHY the thermostat handle being dragged: the in-place drawing must not reset its place or focus mid-drag (thDrag, home-assistant-page-dial.ts); its place is set by the drag itself.
    if (el.hasAttribute('data-th-h') && typeof thDrag !== 'undefined' && thDrag && thDrag.k === el.getAttribute('data-k')) return true;
    if (el !== document.activeElement) return false;
    if (el.nodeName === 'SELECT') return true;
    // WHY an open colour picker is left alone too (code review F15): a drawing that landed while it was open reset its value to the light's
    // current colour, which could undo the pick before its change event fired.
    if (el.nodeName === 'INPUT' && el.type === 'color') return true;
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
  // The longest run of old children already in the right order stays where it is.
  function stableRun(seq) {
    var tails = [], prev = [];
    seq.forEach(function (s, i) {
      var lo = 0, hi = tails.length;
      while (lo < hi) { var m = (lo + hi) >> 1; if (seq[tails[m]].pos < s.pos) lo = m + 1; else hi = m; }
      prev[i] = lo ? tails[lo - 1] : -1; tails[lo] = i;
    });
    var out = new Set(), k = tails.length ? tails[tails.length - 1] : -1;
    while (k >= 0) { out.add(seq[k].node); k = prev[k]; }
    return out;
  }
  // WHY (code review 1): children that are gone are removed FIRST, and only children that
  // really changed place are moved. The first version walked a cursor that stayed on a
  // doomed card, so removing one card pulled every later card out and put it back, which
  // loses focus and restarts a playing clip: the harm this drawing exists to prevent.
  function patchKids(a, b) {
    var olds = Array.prototype.slice.call(a.childNodes), news = Array.prototype.slice.call(b.childNodes);
    var byKey = {}, loose = [], taken = new Set(), match = [], j = 0;
    olds.forEach(function (n) { var k = keyOf(n); if (k) { if (!byKey[k]) byKey[k] = n; } else loose.push(n); });
    news.forEach(function (bn, i) {
      var k = keyOf(bn), an = null;
      if (k) { an = byKey[k]; if (an && (taken.has(an) || !sameKind(an, bn))) an = null; }
      else { for (var c = j; c < loose.length; c++) { if (!taken.has(loose[c]) && sameKind(loose[c], bn)) { an = loose[c]; j = c + 1; break; } } }
      if (an) taken.add(an);
      match[i] = an;
    });
    olds.forEach(function (n) { if (!taken.has(n)) a.removeChild(n); });
    var order = new Map(), seq = [];
    Array.prototype.forEach.call(a.childNodes, function (n, i) { order.set(n, i); });
    match.forEach(function (an) { if (an) seq.push({ node: an, pos: order.get(an) }); });
    var stable = stableRun(seq), ref = null;
    for (var i = news.length - 1; i >= 0; i--) {
      var node = match[i] || news[i];
      if (!match[i] || !stable.has(node)) a.insertBefore(node, ref);
      ref = node;
    }
    news.forEach(function (bn, i) {
      var an = match[i];
      if (!an) return;
      if (an.nodeType === 1) patchEl(an, bn); else if (an.nodeValue !== bn.nodeValue) an.nodeValue = bn.nodeValue;
    });
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
  // WHY it returns early unless a slider was held (code review 3): clearing drawn forces a
  // full compare of every area, and a plain click or a touch-scroll start must not do that.
  function released(force) {
    var was = gripping || dragging;
    gripping = null;
    if (!was && force !== true) return;
    drawn = {}; renderSoon();
  }
  document.addEventListener('pointerup', function () { released(); });
  document.addEventListener('pointercancel', function () { released(); });
  document.addEventListener('change', function (e) { if (e.target.classList && e.target.classList.contains('lr')) released(true); });

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
`;
