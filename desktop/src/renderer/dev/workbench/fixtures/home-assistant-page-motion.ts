// Motion when moving around the Home page (redesign round 1, motion-nav c, "Glide and grow",
// picked by Destin 2026-10-04): pages slide in from the side their tab sits on (the pill row itself
// never moves); the device pop-up grows out of the card you pressed and shrinks
// back into it; a card's contents drop in one after another and everything below it glides to
// its new place; the Edit board's settings under a row open the same way.
//
// THE RULE that keeps it safe with live updates: motion starts ONLY from the person's own press
// (a capture-phase click listener below) or from the pop-up appearing/disappearing, never
// from "something changed". A push, a check or a history arrival draws in place with no motion.
// The in-place drawing (home-assistant-page-redraw.ts) keeps the same elements across redraws,
// so a glide is measured on the real elements before the press and after the redraw.
// Only transform and opacity are animated; reduced-motion, a hidden page and the practice-only
// window.__motionOff switch all turn it off. HOME_MOTION_JS is pasted INSIDE the page's script.
// Template string: no backticks, no dollar-brace, no backslashes.

export const HOME_MOTION_JS = `
  // ── Motion (redesign round 1, motion-nav c) ───────────────────────────────
  var MO_EASE = 'cubic-bezier(.2,.8,.2,1)', moStart = Date.now(), moGhost = null, moCard = null;
  var moRM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  // WHY every animation asks first: reduced-motion must win, a hidden page must not animate
  // (nothing runs in the background), and the practice-only "before" screen switches it all off.
  function moCan() { return !moRM.matches && !document.hidden && !window.__motionOff && typeof Element.prototype.animate === 'function'; }
  var MO_BODY = { 'data-fold': '.lights-body', 'data-scenes': '.sc-list', 'data-remote': '.remote', 'data-group': '.glist' };
  // WHY data-scenes is held by '.lights': the easel button sits in the card's header, so the whole card holds button and chips.
  var MO_HOLD = { 'data-fold': '.lights', 'data-scenes': '.lights', 'data-remote': '.rcard', 'data-group': '.rcard' };
  // Everything that can change place when a card opens or closes: rooms, cards inside them and rows.
  var MO_MOVE = '.room, .lights, .scenes, .rcard, .edc-row, [data-eid]';
  function moAll(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function moAnim(el, frames, opts, glide) {
    var a = el.animate(frames, opts);
    if (glide) a.__mo = 1;
    return a;
  }
  function moRects() {
    var m = new Map();
    moAll(MO_MOVE).forEach(function (el) { m.set(el, el.getBoundingClientRect()); });
    return m;
  }
  // Glide: each element that moved starts where it was and slides to where it is. A card inside
  // a card is already carried by its parent's slide, so it slides only the difference (otherwise
  // it would move twice as far).
  function moGlide(before) {
    if (!before) return;
    var els = moAll(MO_MOVE);
    // A slide still in flight is dropped first so "where it is now" means its true place.
    els.forEach(function (el) { (el.getAnimations ? el.getAnimations() : []).forEach(function (a) { if (a.__mo) a.cancel(); }); });
    els = els.filter(function (el) { return before.has(el); });
    var d = new Map();
    els.forEach(function (el) { var o = before.get(el), n = el.getBoundingClientRect(); d.set(el, { x: o.left - n.left, y: o.top - n.top }); });
    els.forEach(function (el) {
      var p = el.parentElement && el.parentElement.closest(MO_MOVE), dp = (p && d.get(p)) || { x: 0, y: 0 }, me = d.get(el);
      var x = me.x - dp.x, y = me.y - dp.y;
      if (Math.abs(x) < 1 && Math.abs(y) < 1) return;
      moAnim(el, [{ transform: 'translate(' + x + 'px,' + y + 'px)' }, { transform: 'none' }], { duration: 260, easing: MO_EASE }, true);
    });
  }
  // Cascade: each row of what just opened arrives a beat after the one above it.
  function moCascade(box) {
    Array.prototype.forEach.call(box.children, function (c, i) {
      moAnim(c, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: Math.min(i, 7) * 35, easing: MO_EASE, fill: 'backwards' });
    });
  }
  function moChev(b, was) {
    var s = b.classList.contains('fold') ? b.querySelector('svg') : b.querySelector('.rchev');
    if (s) moAnim(s, [{ transform: 'rotate(' + (was ? 180 : 0) + 'deg)' }, { transform: 'rotate(' + (was ? 0 : 180) + 'deg)' }], { duration: 200, easing: MO_EASE });
  }
  function moFind(attr, val) { return moAll('[' + attr + ']').filter(function (b) { return b.getAttribute(attr) === val; })[0]; }
  function moTabs() { return moAll('#chips [data-home], #chips [data-view]'); }
  function moIdx(b) { return b.hasAttribute('data-home') ? 0 : b.getAttribute('data-view') === 'settings' ? 99 : Math.max(1, moTabs().indexOf(b)); }

  // One press, played after the page has redrawn for it (still before the next paint).
  function moPlay(o) {
    if (!moCan()) return;
    if (o.k === 'nav') {
      // Pages slide in from the side their tab sits on. WHY nothing touches the pill row (Destin,
      // 2026-10-04: "the tab switchers bounce around when I change pages"): the row stays perfectly
      // still; the selected fill changes in place through the pills' own colour fade.
      ['view', 'favs', 'rooms'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.firstElementChild) moAnim(el, [{ opacity: 0, transform: 'translateX(' + (o.to > o.from ? 32 : -32) + 'px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: MO_EASE });
      });
      return;
    }
    var b = o.k === 'fold' ? moFind(o.a, o.v) : moFind('data-tok', o.v);
    if (!b || (b.getAttribute('aria-expanded') === 'true') === o.was) return; // the press changed nothing
    if (o.k === 'fold') { moChev(b, o.was); var body = o.was ? null : (b.closest(MO_HOLD[o.a]) || b.closest('[data-eid]') || document).querySelector(MO_BODY[o.a]); if (body) moCascade(body); }
    else { var row = b.closest('.edc-row'), menu = !o.was && row && row.querySelector('.edx-menu'); if (menu) moCascade(menu); }
    moGlide(o.before);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    // WHY defaultPrevented: the press that ended a press-and-hold was already swallowed by the pop-up code.
    if (!b || e.defaultPrevented || !moCan()) return;
    var o = null, a = null;
    for (var k in MO_BODY) if (b.hasAttribute(k)) a = k;
    if (a) o = { k: 'fold', a: a, v: b.getAttribute(a), was: b.getAttribute('aria-expanded') === 'true', before: moRects() };
    else if (b.getAttribute('data-act') === 'edopen') o = { k: 'panel', v: b.getAttribute('data-tok'), was: b.getAttribute('aria-expanded') === 'true', before: moRects() };
    else if (b.hasAttribute('data-view') || b.hasAttribute('data-home')) {
      var s = document.querySelector('#chips .sel');
      o = { k: 'nav', from: s ? moIdx(s) : 99, to: moIdx(b) };
    }
    if (o) (window.requestAnimationFrame || setTimeout)(function () { moPlay(o); });
  }, true);

  // The pop-up. Noticed by appearing or disappearing, so a press-and-hold, a right-click and a
  // name press all animate, and history arriving while it is open does not.
  ['pointerdown', 'contextmenu', 'click'].forEach(function (n) {
    document.addEventListener(n, function (e) { var c = e.target.closest && e.target.closest('[data-eid]'); if (c) moCard = c.getAttribute('data-eid'); }, true);
  });
  function moCardRect() { var c = moCard && moFind('data-eid', moCard); return c && !c.closest('#dlg') ? c.getBoundingClientRect() : null; }
  // WHY the frame grows alone and the contents fade in after (round 1: "text looked stretched
  // while it grows"): the text is invisible until the frame is nearly full size.
  function moFrame(d, from, to, extra) {
    var r = moCardRect(), dr = d.getBoundingClientRect();
    if (!r || !dr.width || !dr.height) return false;
    var small = 'translate(' + (r.left - dr.left) + 'px,' + (r.top - dr.top) + 'px) scale(' + r.width / dr.width + ',' + r.height / dr.height + ')';
    d.style.transformOrigin = '0 0';
    var a = moAnim(d, from ? [{ transform: small, opacity: 0 }, { opacity: 1, offset: .25 }, { transform: 'none', opacity: 1 }] : [{ transform: 'none', opacity: 1 }, { opacity: 1, offset: .7 }, { transform: small, opacity: 0 }], extra);
    a.onfinish = a.oncancel = function () { d.style.transformOrigin = ''; };
    return true;
  }
  function moDlgIn(scrim) {
    var d = scrim.querySelector('.dlg');
    moAnim(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    if (!d) return;
    if (moFrame(d, true, null, { duration: 300, easing: 'cubic-bezier(.2,.9,.25,1)' })) {
      Array.prototype.forEach.call(d.children, function (c) { moAnim(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 120, easing: 'ease-out', fill: 'backwards' }); });
    } else moAnim(d, [{ opacity: 0, transform: 'translateY(12px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: MO_EASE });
  }
  function moDlgOut(ghost) {
    ghost.inert = true; ghost.style.pointerEvents = 'none'; // a throw-away copy: never focusable or pressable
    document.body.appendChild(ghost);
    function done() { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }
    var a = moAnim(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    a.onfinish = a.oncancel = done;
    var d = ghost.querySelector('.dlg');
    if (!d) return;
    if (moFrame(d, false, null, { duration: 220, easing: 'cubic-bezier(.4,0,.8,.4)', fill: 'forwards' })) {
      Array.prototype.forEach.call(d.children, function (c) { moAnim(c, [{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'ease-in', fill: 'forwards' }); });
    } else moAnim(d, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.98)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
  }
  // Called by put() just before and just after it draws an area.
  function motionBefore(id, html) {
    var el = id === 'dlg' && !html ? $('dlg') : null;
    moGhost = el && el.firstElementChild ? el.firstElementChild.cloneNode(true) : null;
  }
  var moDlgWas = false;
  function motionAfter(id) {
    if (id !== 'dlg') return;
    var scrim = $('dlg').firstElementChild, ghost = moGhost;
    moGhost = null;
    // The first 1.5 s are a page being opened, not a pop-up being opened.
    if (moCan() && Date.now() - moStart > 1500) {
      if (scrim && !moDlgWas) moDlgIn(scrim);
      else if (!scrim && moDlgWas && ghost) moDlgOut(ghost);
    }
    moDlgWas = !!scrim;
  }
`;
