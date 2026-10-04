// Design options for the "motion-nav" task of the Home page redesign: motion
// when moving around the page (switching tabs, the device pop-up, expanding
// and collapsing cards). Each becomes the practice screen
// pages/page/page-home#v-motion-nav-<key>. See types.ts.
//
// THE CONSTRAINT all three work around: put() replaces innerHTML, and live
// updates redraw at any moment. So none of them animates because "something
// changed" (a live update would replay it). Each reacts only to the person's
// own click/key, remembered for one tick, and animates either a container
// that survives redraws (#view, #rooms, #favs) or a throw-away copy.
import type { HomeVariants } from './types';

// Shared helpers (plain ES5, no backticks). WHY here: A and C watch the same
// user actions; they differ only in what they draw. `LEAVE` is set by A.
const COMMON = String.raw`
(function () {
  var RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  // WHY: honour reduced-motion and never animate a hidden page.
  function can() { return !RM.matches && !document.hidden && !!Element.prototype.animate; }
  var ua = null, skip = false, startedAt = Date.now(), LEAVE = false, SLIDE = false, GROW = false, FLIPS = false;
  window.__nm = function (o) { for (var k in o) { if (k === 'LEAVE') LEAVE = o[k]; if (k === 'SLIDE') SLIDE = o[k]; if (k === 'GROW') GROW = o[k]; if (k === 'FLIPS') FLIPS = o[k]; } };
  // The person's own action, remembered until this tick ends. A redraw from a
  // live update arrives later and finds nothing remembered, so it stays still.
  function mark(o) { ua = o; setTimeout(function () { if (ua === o) ua = null; }, 0); }
  var BODY = { 'data-fold': '.lights-body', 'data-scenes': '.sc-list', 'data-remote': '.remote', 'data-group': '.glist' };
  var HOLD = { 'data-fold': '.lights', 'data-scenes': '.scenes', 'data-remote': '.rcard', 'data-group': '.rcard' };
  function attrOf(b) { for (var k in BODY) if (b.hasAttribute(k)) return k; return null; }
  function bodyOf(b, a) { var c = b.closest(HOLD[a]) || b.closest('[data-eid]'); return c ? c.querySelector(BODY[a]) : null; }
  function pillIdx(b) {
    if (b.hasAttribute('data-home')) return 0;
    if (b.getAttribute('data-view') === 'settings') return 99;
    var i = Array.prototype.indexOf.call(document.querySelectorAll('.pills .pill'), b);
    return i < 0 ? 1 : i;
  }
  function selPill() { return document.querySelector('.pills .pill.sel'); }
  function roomsNow() { return document.querySelectorAll('#favs .room, #rooms > .room, #view .rooms > .room'); }
  function roomRects() {
    var m = {};
    Array.prototype.forEach.call(roomsNow(), function (r) { var h = r.querySelector('h2'); m[h ? h.textContent : ''] = r.getBoundingClientRect(); });
    return m;
  }
  var EASE = 'cubic-bezier(.2,.8,.2,1)';

  // A collapse that waits 120 ms so the card's contents can fade out first,
  // then presses the same button again for real.
  function leave(body, b, a, v) {
    var fired = false;
    function go() {
      if (fired) return; fired = true;
      var b2 = document.querySelector('[' + a + '="' + v + '"]') || b;
      skip = true; try { b2.click(); } finally { skip = false; }
    }
    var an = body.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 120, easing: 'ease-in', fill: 'forwards' });
    an.onfinish = go; an.oncancel = go;
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b) return;
    var a = attrOf(b);
    if (a) {
      var was = b.getAttribute('aria-expanded') === 'true';
      var v = b.getAttribute(a);
      if (was && LEAVE && !skip && can()) {
        var body = bodyOf(b, a);
        if (body) { e.stopPropagation(); e.preventDefault(); leave(body, b, a, v); return; }
      }
      mark({ k: 'fold', a: a, v: v, was: was, rects: FLIPS ? roomRects() : null, done: {} });
      return;
    }
    if (b.hasAttribute('data-view') || b.hasAttribute('data-home')) {
      var s = selPill(), cur = s ? pillIdx(s) : 99;
      mark({ k: 'nav', from: cur, to: pillIdx(b), pill: s ? s.getBoundingClientRect() : null, done: {} });
    }
  }, true);

  // Which card the pop-up belongs to (so option C can grow it out of the card).
  var cardId = null;
  ['pointerdown', 'contextmenu', 'click'].forEach(function (n) {
    document.addEventListener(n, function (e) { var c = e.target.closest && e.target.closest('[data-eid]'); if (c) cardId = c.getAttribute('data-eid'); }, true);
  });
  function cardRect() { var c = cardId ? document.querySelector('[data-eid="' + cardId + '"]') : null; return c ? c.getBoundingClientRect() : null; }

  function chev(b, was) {
    var s = b.classList.contains('fold') ? b.querySelector('svg') : b.querySelector('.rchev');
    if (s) s.animate([{ transform: 'rotate(' + (was ? 180 : 0) + 'deg)' }, { transform: 'rotate(' + (was ? 0 : 180) + 'deg)' }], { duration: 200, easing: EASE });
  }
  function foldIn(o, id) {
    if (!o.done.fold) {
      var b = document.querySelector('[' + o.a + '="' + o.v + '"]');
      if (!b) return;
      o.done.fold = 1;
      chev(b, o.was);
      var body = o.was ? null : bodyOf(b, o.a);
      if (body) {
        if (SLIDE) {
          // Cascade: each row arrives a beat after the one above it.
          Array.prototype.forEach.call(body.children, function (c, i) {
            c.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: Math.min(i, 7) * 35, easing: EASE, fill: 'backwards' });
          });
        } else {
          body.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
        }
      }
    }
    // Cards below glide to their new place instead of jumping (C).
    if (o.rects && !o.done.flip && (id === 'rooms' || id === 'view')) {
      o.done.flip = 1;
      Array.prototype.forEach.call(roomsNow(), function (r) {
        var h = r.querySelector('h2'), old = o.rects[h ? h.textContent : ''];
        if (!old) return;
        var n = r.getBoundingClientRect(), dx = old.left - n.left, dy = old.top - n.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        r.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: EASE });
      });
    }
  }
  function navIn(o, id) {
    if (id === 'chips') {
      // The filled pill glides from the old tab to the new one (C).
      if (SLIDE && o.pill && !o.done.chips) {
        var s = selPill();
        if (s) { o.done.chips = 1; var dx = o.pill.left - s.getBoundingClientRect().left; if (Math.abs(dx) > 2) s.animate([{ transform: 'translateX(' + dx + 'px)' }, { transform: 'none' }], { duration: 260, easing: EASE }); }
      }
      return;
    }
    if (o.done[id]) return;
    var el = document.getElementById(id);
    if (!el || !el.firstElementChild) return;
    o.done[id] = 1;
    var from = SLIDE ? 'translateX(' + (o.to > o.from ? 32 : -32) + 'px)' : 'translateY(8px)';
    el.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], { duration: SLIDE ? 260 : 200, easing: EASE });
  }

  // The pop-up: noticed by being there or not, never by a click, so opening by
  // press-and-hold, right-click or name all animate, and live redraws while it
  // is open (history arriving) do not.
  var dlgOn = false, dlgLast = null;
  function dlgIn(scrim) {
    var d = scrim.querySelector('.dlg');
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GROW ? 200 : 160, easing: 'ease-out' });
    if (!d) return;
    var r = GROW ? cardRect() : null, dr = d.getBoundingClientRect();
    if (r && dr.width && dr.height) {
      d.style.transformOrigin = '0 0';
      var an = d.animate([
        { transform: 'translate(' + (r.left - dr.left) + 'px,' + (r.top - dr.top) + 'px) scale(' + r.width / dr.width + ',' + r.height / dr.height + ')', opacity: 0 },
        { opacity: 1, offset: .35 },
        { transform: 'none', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.2,.9,.25,1)' });
      an.onfinish = an.oncancel = function () { d.style.transformOrigin = ''; };
    } else {
      d.animate([{ opacity: 0, transform: 'translateY(12px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE });
    }
  }
  function dlgOut(clone) {
    clone.inert = true; clone.style.pointerEvents = 'none';
    document.body.appendChild(clone);
    var d = clone.querySelector('.dlg');
    function done() { if (clone.parentNode) clone.parentNode.removeChild(clone); }
    setTimeout(done, 450);
    var an = clone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: GROW ? 220 : 140, easing: 'ease-in', fill: 'forwards' });
    an.onfinish = an.oncancel = done;
    if (!d) return;
    var r = GROW ? cardRect() : null, dr = d.getBoundingClientRect();
    if (r && dr.width && dr.height) {
      d.style.transformOrigin = '0 0';
      d.animate([{ transform: 'none', opacity: 1 }, { opacity: 1, offset: .6 },
        { transform: 'translate(' + (r.left - dr.left) + 'px,' + (r.top - dr.top) + 'px) scale(' + r.width / dr.width + ',' + r.height / dr.height + ')', opacity: 0 }],
        { duration: 220, easing: 'cubic-bezier(.4,0,.8,.4)', fill: 'forwards' });
    } else {
      d.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.98)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
    }
  }
  window.__homeAfterPut = function (id) {
    if (id === 'dlg') {
      var scrim = document.getElementById('dlg').firstElementChild;
      if (can()) {
        if (scrim && !dlgOn && Date.now() - startedAt > 1500) dlgIn(scrim);
        else if (!scrim && dlgOn && dlgLast) dlgOut(dlgLast);
      }
      dlgOn = !!scrim; dlgLast = scrim ? scrim.cloneNode(true) : null;
      return;
    }
    if (!ua || !can()) return;
    if (ua.k === 'fold' && (id === 'rooms' || id === 'view' || id === 'favs')) foldIn(ua, id);
    else if (ua.k === 'nav' && (id === 'view' || id === 'rooms' || id === 'favs' || id === 'chips')) navIn(ua, id);
  };
})();
`;

// A: only what is newly shown moves, quietly: fade and a small rise.
const A_JS = COMMON + String.raw`
window.__nm({ LEAVE: true });
`;

// C: spatial. Pages slide the way the tab row points, the filled pill glides,
// the pop-up grows out of its card, cards below glide when one opens/closes.
const C_JS = COMMON + String.raw`
window.__nm({ SLIDE: true, GROW: true, FLIPS: true });
`;

// B: the browser's own View Transitions. Every redraw the person causes is
// wrapped so the browser photographs before/after and animates between them.
const VT_FN = `
  function render() { if (window.__vt && window.__vt(render0)) return; render0(); }
`;
function swap(html: string, from: string, to: string): string {
  // WHY loud: if the page's text changes, this option should fail visibly
  // rather than silently show no motion.
  if (!html.includes(from)) throw new Error('motion-nav B: page text not found: ' + from);
  return html.replace(from, to);
}

let namesCss = '#favs > .room { view-transition-name: r-fav; }\n';
for (let i = 1; i <= 12; i++) namesCss += `#rooms > .room:nth-child(${i}), #view .rooms > .room:nth-child(${i}) { view-transition-name: r-${i}; }\n`;

const B_CSS = String.raw`
  .toprow { view-transition-name: toprow; }
  #dlg .dlg { view-transition-name: dlg; }
  ::view-transition-group(*) { animation-duration: 260ms; animation-timing-function: cubic-bezier(.2,.8,.2,1); }
  ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 180ms; }
  html.vt-nav::view-transition-new(root) { animation: vtin 220ms cubic-bezier(.2,.8,.2,1) both; }
  html.vt-nav::view-transition-old(root) { animation: vtout 120ms ease-in both; }
  ::view-transition-group(dlg) { animation: none; }
  ::view-transition-new(dlg) { animation: vtdin 220ms cubic-bezier(.2,.8,.2,1) both; mix-blend-mode: normal; }
  ::view-transition-old(dlg) { animation: vtdout 140ms ease-in both; mix-blend-mode: normal; }
  @keyframes vtin { from { opacity: 0; transform: translateY(8px); } }
  @keyframes vtout { to { opacity: 0; } }
  @keyframes vtdin { from { opacity: 0; transform: translateY(12px) scale(.97); } }
  @keyframes vtdout { to { opacity: 0; transform: translateY(8px) scale(.98); } }
  @media (prefers-reduced-motion: reduce) { ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; } }
` + namesCss.split('\n').map((l) => (l ? 'html.vt-fold ' + l.replace(/, /g, ', html.vt-fold ') : '')).join('\n');

const B_JS = String.raw`
(function () {
  var RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  var ua = null;
  function mark(k) { ua = k; setTimeout(function () { ua = null; }, 0); }
  window.__uaPop = function () { mark('pop'); };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (b && (b.hasAttribute('data-view') || b.hasAttribute('data-home'))) { mark('nav'); return; }
    if (b && (b.hasAttribute('data-fold') || b.hasAttribute('data-scenes') || b.hasAttribute('data-remote') || b.hasAttribute('data-group'))) { mark('fold'); return; }
    if ((b && b.hasAttribute('data-dlg-close')) || (e.target.getAttribute && e.target.getAttribute('data-dlg-scrim'))) mark('pop');
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') mark('pop'); }, true);
  document.addEventListener('contextmenu', function () { mark('pop'); }, true);
  // Returns true when it took over the redraw.
  window.__vt = function (draw) {
    if (!ua || RM.matches || document.hidden || !document.startViewTransition) return false;
    var k = ua; ua = null;
    var root = document.documentElement;
    root.classList.add('vt-' + k);
    function clean() { root.classList.remove('vt-' + k); }
    var t = document.startViewTransition(function () {
      draw();
      if (k === 'nav') window.scrollTo(0, 0);
      // The page normally focuses the pop-up right after opening it, before
      // the redraw has happened; do it here instead.
      var d = document.querySelector('.dlg'); if (d) d.focus();
    });
    t.finished.then(clean, clean);
    return true;
  };
})();
`;

export const VARIANTS: HomeVariants = {
  a: { label: 'Quiet fades', js: A_JS },
  b: {
    label: 'Whole-page morph',
    css: B_CSS,
    js: B_JS,
    transform: (html) => {
      let h = swap(html, '  function render() {', VT_FN + '  function render0() {');
      h = swap(h, 'function openDevice(id) {', 'function openDevice(id) { if (window.__uaPop) window.__uaPop();');
      return h;
    },
  },
  c: { label: 'Glide and grow', js: C_JS },
};
