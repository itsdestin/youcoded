// The thermostat dial's tick, handle and "Now" label (owner, 2026-10-05: "the current temp should be a line cutting across the
// wheel instead of a dot; the wheel should have a handle like the brightness/volume sliders that I can use instead of the +/-
// buttons; 'Now 79' should sit next to the line; make sure it never overlaps the +/- buttons").
// Kept apart from home-assistant-page.ts for its line budget. HOME_DIAL_JS is pasted INSIDE the page's script and shares its
// helpers (thing, esc, holdVal, sendSlider, quiet, thRange, thSide, thWords, thRangeMid, morphInto, renderSoon, MODE_NAMES).
//
// What a person sees: the room's temperature is a short line crossing the ring; the set point is a round handle on the ring (two in
// Auto) that can be dragged or moved with the arrow keys; "Now 79°" sits beside the line. The − and + buttons stay: the handle is
// a second way to do the same thing.
//
// WHY the label's place is computed (HOME_DIAL_GEOM_JS, pure, no page): the card is narrow, the − and + buttons sit right beside the dial and
// the ring leaves almost no room outside it, so "just put it next to the line" overlaps something at some temperatures. The rule, tried in
// this order, first one that overlaps nothing wins: (1) just outside the ring at the line's angle; (2) just inside the ring at the line's
// angle; (3) the same two, moved along the ring a few degrees at a time (up to 90 degrees either way, closest first); (4) the middle of the
// dial under the big number (the old place). A spot is refused if it leaves the dial's allowed area (the dial plus a margin, so it
// stays in the card: on a room card sideways it may reach as far as the buttons' column, since the buttons themselves are obstacles), touches the ring, a handle, the − or + button (with a gap), or the big number in the middle.
// The geometry is its own string so a test can run the exact code the page runs (jsdom cannot measure layout).
//
// Escapes: this text lives in a template string inside another one: no backticks, no dollar-brace, no backslashes.

export const HOME_DIAL_GEOM_JS = `
  // ── Dial geometry (pure: numbers in, numbers out) ─────────────────────────
  // The ring runs 270 degrees clockwise from 135 (bottom left, the minimum) to 405 (bottom right, the maximum).
  function thAngle(f) { return 135 + 270 * f; }
  function thFracOf(deg) {
    var a = (((deg - 135) % 360) + 360) % 360;
    if (a <= 270) return a / 270;
    return a < 315 ? 1 : 0; // the gap at the bottom snaps to the nearer end
  }
  // A value snapped to the device's step, inside its limits (never a long float such as 72.30000001).
  function thSnap(v, lo, hi, step) {
    var s = step > 0 ? step : 1;
    var n = lo + Math.round((v - lo) / s) * s;
    return Math.round(Math.max(lo, Math.min(hi, n)) * 100) / 100;
  }
  // Auto: one side moves, never past the limits and never across or onto the other (a gap of at least a degree).
  function thClampRange(side, v, tlo, thi, lo, hi, step) {
    var gap = Math.max(step || 1, 1);
    if (side === 'low') return { tlo: Math.max(lo, Math.min(v, thi - gap)), thi: thi };
    return { tlo: tlo, thi: Math.min(hi, Math.max(v, tlo + gap)) };
  }
  // Where things are drawn in the page, as the CSS lays them out (the same numbers as the dial's CSS): the dial's size, the round
  // buttons either side of it on a room card, and the sizes of its text. narrow = the window under 420px.
  function thGeom(compact, narrow) {
    if (!compact) return { S: 210, arcW: 14, hs: 30, setFs: 54, lblFs: 12, nowFs: 12, rangeFs: 22, btn: 0, gap: 0, mx: 12, my: 12 };
    return narrow ? { S: 118, arcW: 16, hs: 26, setFs: 30, lblFs: 10, nowFs: 10, rangeFs: 10, btn: 36, gap: 8, mx: 42, my: 4 }
      : { S: 148, arcW: 16, hs: 28, setFs: 38, lblFs: 10, nowFs: 10, rangeFs: 14, btn: 42, gap: 12, mx: 52, my: 4 };
  }
  // Where "Now 79°" goes. o: S (dial px), R (ring radius px), half (half the ring's thickness), tick (how far the line sticks out of the
  // ring each way), a (the line's angle in degrees), w/h (the label's box), mx / my (how far past the dial it may reach sideways / up and down), circles [{x,y,r}]
  // (the handles), rects [{x,y,w,h}] (the buttons, dial-local), core {w,h} (the big number, centred) or null.
  // Returns { x, y, side: 'out' | 'in', turn } (the label's centre), or null: put it in the middle under the number.
  function thLabelSpot(o) {
    var c = o.S / 2, lox = -o.mx, hix = o.S + o.mx, loy = -o.my, hiy = o.S + o.my, pad = 4;
    function clear(x, y) {
      var l = x - o.w / 2, t = y - o.h / 2, r = l + o.w, b = t + o.h;
      if (l < lox || r > hix || t < loy || b > hiy) return false;
      var ndx = c < l ? l - c : c > r ? c - r : 0, ndy = c < t ? t - c : c > b ? c - b : 0;
      var dmin = Math.sqrt(ndx * ndx + ndy * ndy);
      var dmax = Math.sqrt(Math.pow(Math.max(Math.abs(l - c), Math.abs(r - c)), 2) + Math.pow(Math.max(Math.abs(t - c), Math.abs(b - c)), 2));
      if (dmin <= o.R + o.half + 1.5 && dmax >= o.R - o.half - 1.5) return false; // touches the ring
      var i;
      for (i = 0; i < (o.circles || []).length; i++) {
        var k = o.circles[i], px = Math.max(l, Math.min(k.x, r)), py = Math.max(t, Math.min(k.y, b));
        if (Math.sqrt((px - k.x) * (px - k.x) + (py - k.y) * (py - k.y)) < k.r + 3) return false; // touches a handle
      }
      for (i = 0; i < (o.rects || []).length; i++) {
        var q = o.rects[i];
        if (l < q.x + q.w + pad && r > q.x - pad && t < q.y + q.h + pad && b > q.y - pad) return false; // touches a button
      }
      if (o.core && l < c + o.core.w / 2 + pad && r > c - o.core.w / 2 - pad && t < c + o.core.h / 2 + pad && b > c - o.core.h / 2 - pad) return false; // touches the big number
      return true;
    }
    for (var n = 0; n <= 15; n++) {
      var turns = n === 0 ? [0] : [n * 6, -n * 6];
      for (var j = 0; j < turns.length; j++) {
        var rad = (o.a + turns[j]) * Math.PI / 180, ux = Math.cos(rad), uy = Math.sin(rad);
        var sup = Math.abs(ux) * o.w / 2 + Math.abs(uy) * o.h / 2;
        var sides = ['out', 'in'];
        for (var s = 0; s < 2; s++) {
          var rc = sides[s] === 'out' ? o.R + o.tick + 2 + sup : o.R - o.tick - 2 - sup;
          if (rc <= 0) continue;
          var x = c + ux * rc, y = c + uy * rc;
          if (clear(x, y)) return { x: x, y: y, side: sides[s], turn: turns[j] };
        }
      }
    }
    return null;
  }
  // Everything thLabelSpot needs, from the dial's size class (g) and what is drawn: the line's angle, the label's text length, the
  // handles' places (fractions 0-1 round the ring), whether there is a set point at all, whether it is Auto, and the big number's length.
  function thLabelPlan(g, nowDeg, nowLen, handles, hasSet, range, setLen) {
    var k = g.S / 200, circles = [], bigFs = range ? g.rangeFs : g.setFs;
    handles.forEach(function (f) {
      var pa = thAngle(f) * Math.PI / 180;
      circles.push({ x: (100 + 80 * Math.cos(pa)) * k, y: (100 + 80 * Math.sin(pa)) * k, r: g.hs / 2 });
    });
    var core = { w: (range ? 2 * 3 * 0.62 * bigFs + bigFs * 1.4 : setLen * 0.62 * bigFs) + 4, h: g.lblFs * 1.25 + bigFs * 1.1 };
    var rects = g.btn && hasSet ? [{ x: -g.gap - g.btn, y: g.S / 2 - g.btn / 2, w: g.btn, h: g.btn }, { x: g.S + g.gap, y: g.S / 2 - g.btn / 2, w: g.btn, h: g.btn }] : [];
    var o = { S: g.S, R: 80 * k, half: g.arcW / 2 * k, tick: 12 * k, a: nowDeg, w: nowLen * 0.56 * g.nowFs + 8, h: g.nowFs * 1.25 + 2, mx: g.mx, my: g.my, circles: circles, rects: rects, core: core };
    return { o: o, spot: thLabelSpot(o) };
  }
`;

export const HOME_DIAL_CSS = `
  /* The room's temperature: a short line crossing the ring (not a dot). A thin outline in the card colour keeps it visible on the
     coloured fill and on the empty track alike. */
  .th-now-halo { stroke: var(--inset); stroke-width: 5.5; stroke-linecap: round; fill: none; }
  .th-now-line { stroke: var(--fg); stroke-width: 2.5; stroke-linecap: round; fill: none; }
  .th-now-lbl { position: absolute; transform: translate(-50%, -50%); z-index: 1; padding: 1px 4px; border-radius: 9999px; font-size: 12px; line-height: 1.25; white-space: nowrap; color: var(--fg-2); pointer-events: none;
    background: color-mix(in srgb, var(--inset) 82%, transparent); }
  /* Auto's two numbers must fit inside the ring clear of the handles: sized from the ring's inner radius (a test pins it); the Climate dial's is set below. */
  .th-dial .th-range { font-size: 22px; gap: 6px; }
  .th-compact .th-range { font-size: 14px; gap: 3px; } @media (max-width: 420px) { .th-compact .th-range { font-size: 10px; gap: 2px; } }
  .th-compact .th-now-lbl { font-size: 10px; padding: 1px 3px; }
  /* The set point: the same handle as the brightness and volume bars (a white disc with a ring of the fill's colour and a soft shadow). */
  .th-dial { --hs: 30px; } .th-compact .th-dial { --hs: 28px; }
  @media (max-width: 420px) { .th-compact .th-dial { --hs: 26px; } }
  .th-h { position: absolute; z-index: 2; width: var(--hs); height: var(--hs); margin: calc(var(--hs) / -2) 0 0 calc(var(--hs) / -2); border-radius: 50%; cursor: grab; touch-action: none; -webkit-tap-highlight-color: transparent;
    background: radial-gradient(circle, #fff calc(var(--hs) / 2 - 3.5px), var(--m) calc(var(--hs) / 2 - 3px) calc(var(--hs) / 2 - .5px), transparent calc(var(--hs) / 2));
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
  .th-h:active { cursor: grabbing; }
  .th-h:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
`;

export const HOME_DIAL_JS = `${HOME_DIAL_GEOM_JS}
  // ── The dial's drawing ────────────────────────────────────────────────────
  function thNarrow() { return window.matchMedia ? window.matchMedia('(max-width: 420px)').matches : window.innerWidth <= 420; }
  function thPct(v) { return (v / 2).toFixed(2) + '%'; } // a point in the 200-unit drawing, as a share of the dial
  // One handle. which: 'set' (one set point), 'low' or 'high' (Auto).
  function thHandle(it, which, val, lo, hi, step, f) {
    var a = thAngle(f) * Math.PI / 180, gap = Math.max(step, 1);
    var min = which === 'high' ? it.tlo + gap : lo, max = which === 'low' ? it.thi - gap : hi;
    var nm = which === 'low' ? 'Heat setting' : which === 'high' ? 'Cool setting' : 'Temperature setting';
    return '<div class="th-h" role="slider" tabindex="0" data-th-h="' + which + '" data-th-id="' + esc(it.id) + '" data-k="th-h:' + esc(it.id) + ':' + which + '" aria-label="' + nm + '" aria-valuemin="' + min + '" aria-valuemax="' + max + '" aria-valuenow="' + val + '" aria-valuetext="' + val + ' degrees" style="left:' + thPct(100 + 80 * Math.cos(a)) + ';top:' + thPct(100 + 80 * Math.sin(a)) + '"></div>';
  }
  // The dial's inside: ring, line, middle, handles, and "Now" label.
  function thDialInner(it, compact) {
    var mode = it.state, lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90, step = it.step || 1;
    var f = function (v) { return Math.max(0, Math.min(1, (v - lo) / (hi - lo))); };
    var range = thRange(it), hasSet = (it.target != null || range) && mode !== 'off', g = thGeom(compact, thNarrow());
    var R = 80, L = 2 * Math.PI * R * 0.75, C = 2 * Math.PI * R;
    var fill = hasSet ? f(range ? it.thi : it.target) * L : 0, fromA = 0;
    if (range) { fromA = f(it.tlo) * L; fill = Math.max(2, fill - fromA); } // Auto fills BETWEEN the two set points
    var doing = it.action ? (DOING[it.action] || it.action) : (MODE_NAMES[mode] || mode);
    var haveNow = it.cur != null, nowDeg = haveNow ? thAngle(f(it.cur)) : 0, nowA = nowDeg * Math.PI / 180;
    var line = !haveNow ? '' : '<g class="th-now"><line class="th-now-halo" x1="' + (100 + (R - 12) * Math.cos(nowA)).toFixed(1) + '" y1="' + (100 + (R - 12) * Math.sin(nowA)).toFixed(1) + '" x2="' + (100 + (R + 12) * Math.cos(nowA)).toFixed(1) + '" y2="' + (100 + (R + 12) * Math.sin(nowA)).toFixed(1) + '"/>' +
      '<line class="th-now-line" x1="' + (100 + (R - 12) * Math.cos(nowA)).toFixed(1) + '" y1="' + (100 + (R - 12) * Math.sin(nowA)).toFixed(1) + '" x2="' + (100 + (R + 12) * Math.cos(nowA)).toFixed(1) + '" y2="' + (100 + (R + 12) * Math.sin(nowA)).toFixed(1) + '"/></g>';
    var svg = '<svg viewBox="0 0 200 200" aria-hidden="true"><circle class="th-track" cx="100" cy="100" r="' + R + '" stroke-dasharray="' + L.toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(135 100 100)"/>' +
      (hasSet ? '<circle class="th-fill" cx="100" cy="100" r="' + R + '" stroke-dasharray="' + fill.toFixed(1) + ' ' + C.toFixed(1) + '"' + (fromA ? ' stroke-dashoffset="' + (-fromA).toFixed(1) + '"' : '') + ' transform="rotate(135 100 100)"/>' : '') + line + '</svg>';
    // Handles: one on the set point, or a low and a high in Auto.
    var hs = '', fr = [];
    if (hasSet) {
      (range ? [['low', it.tlo], ['high', it.thi]] : [['set', it.target]]).forEach(function (p) { hs += thHandle(it, p[0], p[1], lo, hi, step, f(p[1])); fr.push(f(p[1])); });
    }
    // The label: beside the line when there is room, else in the middle (the rule is at the top of this file).
    var nowTxt = haveNow ? 'Now ' + esc(it.cur) + '°' : '', lbl = '', centre = '';
    if (haveNow) {
      var plan = thLabelPlan(g, nowDeg, nowTxt.length, fr, hasSet, range, hasSet ? String(range ? 5 : it.target).length + 1 : 1), spot = plan.spot;
      if (spot) lbl = '<span class="th-now-lbl" data-k="th-now:' + esc(it.id) + '" data-spot="' + spot.side + '" style="left:' + (spot.x / g.S * 100).toFixed(2) + '%;top:' + (spot.y / g.S * 100).toFixed(2) + '%">' + nowTxt + '</span>';
      else centre = '<span class="th-cur" data-spot="centre">' + nowTxt + '</span>';
    }
    return svg + '<div class="th-mid">' + (range && hasSet ? thRangeMid(it, doing) : '<span class="th-lbl">' + (hasSet ? esc(thWords(it)) : 'Off') + '</span><span class="th-set">' + (hasSet ? esc(it.target) + '°' : '—') + '</span>') + centre + '</div>' + hs + lbl;
  }
  function thDialHtml(it, compact) { return '<div class="th-dial" data-th-dial="' + esc(it.id) + '">' + thDialInner(it, compact) + '</div>'; }
  // Window crossing 420px changes the dial's size: draw again so the label is placed for the new size.
  var thWasNarrow = thNarrow();
  window.addEventListener('resize', function () { var n = thNarrow(); if (n !== thWasNarrow) { thWasNarrow = n; drawn = {}; renderSoon(); } });

  // ── Dragging and arrow keys ───────────────────────────────────────────────
  // The handle's value goes through the same target model as the brightness bar: the page shows the new number at once and holds it
  // until the thermostat reports it (8 seconds at most, a thermostat is slow); sends are at most one per 400 ms, the newest value, never
  // the same twice, and letting go sends the last one.
  var thDrag = null; // { id, which, k, changed }
  function thHeldNow(it, which) { return which === 'high' ? it.thi : which === 'low' ? it.tlo : it.target; }
  // Sets one handle to v. Returns false when nothing changed.
  function thSet(it, which, v, final) {
    var lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90, step = it.step || 1, patch, body, val;
    if (thRange(it)) {
      var r = thClampRange(which === 'high' ? 'high' : 'low', v, it.tlo, it.thi, lo, hi, step);
      patch = { tlo: r.tlo, thi: r.thi }; body = { entity_id: it.id, target_temp_low: r.tlo, target_temp_high: r.thi }; val = r.tlo + '|' + r.thi;
    } else { patch = { target: v }; body = { entity_id: it.id, temperature: v }; val = String(v); }
    var same = Object.keys(patch).every(function (k) { return it[k] === patch[k]; });
    if (same && !final) return false;
    Object.keys(patch).forEach(function (k) { holdVal(it.id, k, patch[k], HOLD_MS, it.id); });
    thRepaint(it);
    if (!same || final) sendSlider(it.id, 400, val, function () { quiet('/api/services/climate/set_temperature', body, it.id); }, final);
    return !same;
  }
  // Every drawing of this thermostat (a room card, Favourites, the Climate tab) follows at once, in place.
  function thRepaint(it) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-th-dial="' + it.id + '"]'), function (d) {
      morphInto(d, thDialInner(it, !!d.closest('.th-compact')));
      // The handle being dragged is left as it is by the in-place drawing, so it is placed here.
      var h = thDrag && d.querySelector('[data-k="th-h:' + it.id + ':' + thDrag.which + '"]'), fresh = d.querySelector('[data-k="th-h:' + it.id + ':' + (thDrag ? thDrag.which : '') + '"]');
      if (h && fresh) { var lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90, fv = Math.max(0, Math.min(1, (thHeldNow(it, thDrag.which) - lo) / (hi - lo))), a = thAngle(fv) * Math.PI / 180; h.style.left = thPct(100 + 80 * Math.cos(a)); h.style.top = thPct(100 + 80 * Math.sin(a)); }
    });
  }
  document.addEventListener('pointerdown', function (e) {
    var h = e.target.closest && e.target.closest('[data-th-h]');
    if (!h || e.button > 0) return;
    e.preventDefault();
    thDrag = { id: h.getAttribute('data-th-id'), which: h.getAttribute('data-th-h'), k: h.getAttribute('data-k'), changed: false };
    var it = thing(thDrag.id);
    if (it && thRange(it) && thDrag.which !== 'set') { thSide[thDrag.id] = thDrag.which; thRepaint(it); } // the number it moves is the one − and + act on
    try { if (h.setPointerCapture && e.pointerId != null) h.setPointerCapture(e.pointerId); } catch (x) { /* a drag still works without capture */ }
    if (h.focus) h.focus();
  });
  document.addEventListener('pointermove', function (e) {
    if (!thDrag) return;
    var it = thing(thDrag.id), h = document.querySelector('[data-k="' + thDrag.k + '"]'), d = h && h.closest('.th-dial');
    if (!it || !d) return;
    var rc = d.getBoundingClientRect();
    var deg = Math.atan2(e.clientY - (rc.top + rc.height / 2), e.clientX - (rc.left + rc.width / 2)) * 180 / Math.PI;
    var lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90;
    if (thSet(it, thDrag.which, thSnap(lo + thFracOf(deg) * (hi - lo), lo, hi, it.step || 1), false)) thDrag.changed = true;
  });
  function thRelease() {
    if (!thDrag) return;
    var it = thing(thDrag.id), was = thDrag;
    thDrag = null;
    if (it && was.changed) thSet(it, was.which, thHeldNow(it, was.which), true); // letting go sends the last value (never one already sent)
    renderSoon(); // the buttons' limits and the rest of the page catch up
  }
  document.addEventListener('pointerup', thRelease);
  document.addEventListener('pointercancel', thRelease);
  document.addEventListener('keydown', function (e) {
    var h = e.target.closest && e.target.closest('[data-th-h]');
    if (!h) return;
    var it = thing(h.getAttribute('data-th-id')), which = h.getAttribute('data-th-h');
    if (!it) return;
    var lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90, step = it.step || 1, cur = Number(thHeldNow(it, which)), v = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = cur + step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = cur - step;
    else if (e.key === 'PageUp') v = cur + 5 * step;
    else if (e.key === 'PageDown') v = cur - 5 * step;
    else if (e.key === 'Home') v = lo;
    else if (e.key === 'End') v = hi;
    if (v === null) return;
    e.preventDefault();
    if (thRange(it) && which !== 'set') thSide[it.id] = which;
    thSet(it, which, thSnap(v, lo, hi, step), false);
    renderSoon(); // the buttons' limits catch up; the focused handle keeps its place (matched by its key)
  });
`;
