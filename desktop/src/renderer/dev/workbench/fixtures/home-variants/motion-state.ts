// Design options for the "motion-state" task of the Home page redesign: how the
// page moves and answers when things CHANGE (a light or TV turning on/off, a
// slider, a colour, play/pause, a speaker joining a group, the thermostat, a
// camera starting, loading, a change made somewhere else). Keys are
// "<option>" or "<option>-<state>"; each becomes the practice screen
// pages/page/page-home#v-motion-state-<key>. See types.ts.
//
// WHY one shared engine: the page replaces a card's HTML on every redraw, so a
// transition that lives on the old element is lost, and a switch is often
// redrawn twice (pressed, then confirmed). The engine below remembers what each
// card looked like at its last redraw (by name, not by element), and when a
// card's look changed it stamps the NEW element with a "data-fx" word plus a
// negative start offset (--ago) so a CSS animation resumes where the cut-off
// one left off. The three options differ only in the CSS they hang on those
// words (and, for option b, extra feedback the engine draws outside the cards).
import type { HomeVariants } from './types';

type Mode = 'a' | 'b' | 'c';

// What shows while the rooms are first loading, per option.
const SKELETON: Record<Mode, string> = {
  a: '<div class="fx-sk"></div><div class="fx-sk"></div><div class="fx-sk"></div>',
  b: '<div class="yc-empty">Loading your rooms…<div class="fx-bar"></div></div>',
  c: '<div class="yc-empty"><div class="fx-bulbs"><i></i><i></i><i></i></div>Loading your rooms…</div>',
};

// Two one-line hooks into the page's own script so the demo's "replay first
// load" button can redraw it, plus the option's loading look. Cost: if the page
// renames `var drawn = {};` or `function render() {` this stops working (it
// then does nothing rather than break the page).
const hooks = (mode: Mode) => (html: string): string => html
  .replace('var drawn = {};', 'var drawn = {}; window.__fxDrawn = drawn;')
  .replace('function render() {', 'window.__fxRender = function () { return render(); };\n  function render() {')
  .replace('<div class="yc-empty">Loading your rooms…</div>', SKELETON[mode]);

// ES5 only, no backticks. __MODE__ / __SKEL__ are filled in below.
const ENGINE = String.raw`
(function () {
  var MODE = '__MODE__', SKEL = __SKEL__;
  var DUR = 900, FIRST = 1500, EXT_MS = 10000, WAIT_MS = 9000;
  var sig = {}, anim = {}, pressAt = {}, cascAt = {}, seen = {}, pend = {}, okAt = {};
  var SLOW = false, flip = 0;
  var root = document.documentElement;
  root.setAttribute('data-fxm', MODE);
  function byId(i) { return document.getElementById(i); }
  function txt(n) { return n ? n.textContent.replace(/\s+/g, ' ').trim() : ''; }
  var EID = ['data-toggle', 'data-mp', 'data-vol', 'data-bright', 'data-temp', 'data-mode', 'data-join', 'data-group'];
  function eidOf(el) {
    for (var i = 0; i < EID.length; i++) { var n = el.querySelector('[' + EID[i] + ']'); if (n) return n.getAttribute(EID[i]); }
    return '';
  }
  function kind(el) { return el.classList.contains('lights') ? 'L' : el.classList.contains('clim') ? 'C' : 'T'; }
  // Same card, any redraw, any host (rooms and favourites both show a light).
  function ident(el) {
    var id = '';
    if (kind(el) === 'L') { var r = el.querySelector('.tile.all [data-room]'); id = r ? r.getAttribute('data-room') : ''; }
    else if (el.classList.contains('all')) { var r2 = el.querySelector('[data-room]'); id = r2 ? r2.getAttribute('data-room') : ''; }
    else id = eidOf(el);
    return kind(el) + (el.classList.contains('all') ? 'A' : '') + '|' + (id || txt(el.querySelector('.name,.mname')));
  }
  function sample(el) {
    var np = kind(el) === 'L' ? null : el.querySelector('.np');
    var main = el.querySelector('.np-ctl .key.main'), rl = el.querySelector('.gcard .rlbl');
    return {
      on: el.classList.contains('on'), mute: el.classList.contains('muted'),
      np: !!np, ttl: np ? txt(np.querySelector('.ttl')) : '',
      pp: main ? (main.getAttribute('aria-label') || '') : '',
      grp: rl ? txt(rl) : '', tick: el.querySelectorAll('.gitem[aria-pressed="true"]').length,
      tmp: txt(el.querySelector('.clim-set .val b')), c: el.style.getPropertyValue('--c') || ''
    };
  }
  function diff(a, b) {
    var d = [];
    if (a.on !== b.on) d.push(b.on ? 'on' : 'off');
    if (a.mute !== b.mute) d.push(b.mute ? 'muted' : 'unmuted');
    if (a.np !== b.np) { if (b.np) d.push('np-in'); }
    else if (a.ttl !== b.ttl && b.np) d.push('track');
    if (a.pp !== b.pp) d.push('pp');
    if (a.grp !== b.grp || a.tick !== b.tick) d.push('group');
    if (a.tmp && a.tmp !== b.tmp) d.push(parseFloat(b.tmp) > parseFloat(a.tmp) ? 'up' : 'down');
    if (a.c !== b.c && a.on === b.on && b.c) d.push('colour');
    return d;
  }
  function recent(map, k, ms) { return map[k] && Date.now() - map[k] < ms; }

  // Called by the page after EVERY redraw of a part (see put()).
  window.__homeAfterPut = function (id) {
    var host = byId(id); if (!host) return;
    if (id !== 'rooms' && id !== 'favs' && id !== 'view') return;
    var now = Date.now();
    var list = host.querySelectorAll('.tile, .lights, .clim');
    if (list.length && !seen[id]) seen[id] = now;
    var firstAt = seen[id] && now - seen[id] < FIRST ? seen[id] : 0;
    for (var n = 0; n < list.length; n++) {
      var el = list[n], key = id + '|' + ident(el), cur = sample(el), prev = sig[key], a = anim[key];
      sig[key] = cur;
      if (prev) {
        var d = diff(prev, cur);
        if (d.length) {
          var lt = el.closest('.lights'), idt = ident(el);
          var ext = !(recent(pressAt, idt, EXT_MS) || (lt && recent(pressAt, ident(lt), EXT_MS)));
          a = anim[key] = { t0: now, d: d, ext: ext, dur: ext ? 5000 : DUR,
            casc: !!(lt && recent(cascAt, ident(lt), 2500)) || (kind(el) === 'L' && recent(cascAt, ident(el), 2500)),
            c0: d.indexOf('colour') >= 0 ? prev.c : '' };
        }
      }
      if (!a && firstAt) a = anim[key] = { t0: firstAt, d: ['first'], dur: FIRST, ext: false, casc: false, c0: '' };
      if (a && now - a.t0 < a.dur) {
        var words = a.d.join(' ') + (a.ext ? ' ext' : '');
        el.setAttribute('data-fx', words);
        el.style.setProperty('--ago', (-(now - a.t0)) + 'ms');
        var idx = 0;
        if (a.d[0] === 'first') idx = Math.min(n, 14);
        else if (a.casc && el.parentNode) idx = Array.prototype.indexOf.call(el.parentNode.children, el);
        el.style.setProperty('--i', String(idx));
        if (a.c0) el.style.setProperty('--c0', a.c0);
      }
      // A brightness you just set keeps the glow at that level across the redraw.
      var br = el.querySelector('.lr[data-bright]') || el.querySelector('.lr[data-gbright]');
      if (br) el.style.setProperty('--b', String(br.value / 100));
    }
    paintWait();
  };

  // ── Pending: "the device has not answered yet" (used by option b) ───────
  function paintWait() {
    var now = Date.now(), tiles = document.querySelectorAll('.tile, .clim');
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i], e = eidOf(t), p = e && pend[e];
      if (t.classList.contains('all')) continue;
      if (p && !p.done && now - p.t < WAIT_MS) t.setAttribute('data-wait', '1'); else t.removeAttribute('data-wait');
      if (e && okAt[e] && now - okAt[e] < 1000) { t.setAttribute('data-ok', '1'); t.style.setProperty('--okago', (-(now - okAt[e])) + 'ms'); }
      else t.removeAttribute('data-ok');
    }
    var alls = document.querySelectorAll('.lights');
    for (var j = 0; j < alls.length; j++) {
      var all = alls[j].querySelector('.tile.all');
      if (!all) continue;
      if (alls[j].querySelector('.lights-body [data-wait]')) all.setAttribute('data-wait', '1'); else all.removeAttribute('data-wait');
      if (alls[j].querySelector('.lights-body [data-ok]')) all.setAttribute('data-ok', '1'); else all.removeAttribute('data-ok');
    }
  }
  var yc = window.youcoded, realFetch = yc && yc.fetch;
  if (realFetch) {
    try {
      yc.fetch = function (url, opts) {
        var isSvc = typeof url === 'string' && url.indexOf('/api/services/') >= 0 && opts && opts.body;
        var ids = [], drag = false;
        if (isSvc) { try { var b = JSON.parse(opts.body); ids = [].concat(b.entity_id || []); drag = b.brightness_pct != null || b.volume_level != null; } catch (e) { ids = []; } }
        var go = function () { return realFetch.call(yc, url, opts); };
        if (!ids.length || drag) return go();
        ids.forEach(function (x) { pend[x] = { t: Date.now(), done: false }; });
        paintWait();
        var p = SLOW ? new Promise(function (ok) { setTimeout(ok, 3000); }).then(go) : go();
        var fin = function () {
          ids.forEach(function (x) { if (pend[x]) pend[x].done = true; okAt[x] = Date.now(); });
          paintWait();
          setTimeout(paintWait, 1050);
        };
        p.then(fin, fin);
        return p;
      };
    } catch (e) { /* the demo then simply has no slow-device switch */ }
  }

  // ── Presses ─────────────────────────────────────────────────────────────
  function press(t) {
    var tile = t.closest ? t.closest('.tile, .clim') : null; if (!tile) return;
    var now = Date.now(), lt = tile.closest('.lights');
    pressAt[ident(tile)] = now;
    if (lt) { pressAt[ident(lt)] = now; if (t.closest('[data-room-to]')) cascAt[ident(lt)] = now; }
  }
  document.addEventListener('click', function (e) { press(e.target); }, true);
  document.addEventListener('input', function (e) {
    var t = e.target; press(t);
    if (t.classList && t.classList.contains('lr')) {
      var host = t.closest('.tile, .lights');
      if (host && (t.hasAttribute('data-bright') || t.hasAttribute('data-gbright'))) host.style.setProperty('--b', String(t.value / 100));
      if (MODE === 'b') tip(t);
    }
  }, true);

  // Option b: an instant ripple under the finger and a value bubble while
  // dragging. Both live on the document, not on a card, so redraws cannot
  // cut them off.
  var tipEl = document.createElement('div'); tipEl.id = 'fx-tip'; document.body.appendChild(tipEl);
  var tipTimer = 0;
  function tip(t) {
    if (MODE !== 'b') return;
    var r = t.getBoundingClientRect(), mn = Number(t.min || 0), mx = Number(t.max || 100);
    var f = (Number(t.value) - mn) / ((mx - mn) || 1);
    tipEl.textContent = t.value + '%';
    tipEl.style.transform = 'translate(' + Math.round(r.left + 8 + f * (r.width - 16)) + 'px,' + Math.round(r.top - 8) + 'px) translate(-50%,-100%)';
    tipEl.setAttribute('data-show', '1');
    clearTimeout(tipTimer); tipTimer = setTimeout(function () { tipEl.removeAttribute('data-show'); }, 700);
  }
  document.addEventListener('pointerdown', function (e) {
    if (MODE !== 'b') return;
    var b = e.target.closest && e.target.closest('button, .tile-face, .sw');
    if (!b || b.disabled || (b.closest && b.closest('.fx-demo'))) return;
    var r = document.createElement('div'); r.className = 'fx-rip';
    r.style.setProperty('--x', e.clientX + 'px'); r.style.setProperty('--y', e.clientY + 'px');
    document.body.appendChild(r); setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 600);
  }, true);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) root.setAttribute('data-hid', '1'); else root.removeAttribute('data-hid');
  });

  // ── Demo controls (only in this practice page) ─────────────────────────
  var bar = document.createElement('div'); bar.className = 'fx-demo';
  bar.innerHTML = '<b>Try:</b><button class="yc-button yc-button--sm" data-fx-slow aria-pressed="false">Slow device: off</button>' +
    '<button class="yc-button yc-button--sm" data-fx-ext>Flip a lamp from elsewhere</button>' +
    '<button class="yc-button yc-button--sm" data-fx-replay>Replay first load</button>';
  document.body.appendChild(bar);
  bar.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-fx-slow')) {
      SLOW = !SLOW; t.setAttribute('aria-pressed', String(SLOW)); t.textContent = 'Slow device: ' + (SLOW ? 'ON (3 s)' : 'off');
    } else if (t.hasAttribute('data-fx-ext')) {
      // Another person at the wall switch: Home Assistant changes, the page is NOT told directly.
      flip++; var base = (yc.devices || {}).ha, on = flip % 2 === 0;
      [ 'light.overhead_light', 'light.living_room_ceiling' ].forEach(function (x) {
        realFetch.call(yc, base + '/api/services/light/' + (on ? 'turn_on' : 'turn_off'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_id: x }) });
      });
    } else if (t.hasAttribute('data-fx-replay') && window.__fxRender) {
      sig = {}; anim = {}; seen = {};
      byId('rooms').innerHTML = SKEL; if (window.__fxDrawn) window.__fxDrawn.rooms = null;
      setTimeout(function () { window.__fxRender(); }, 2200);
    }
  });
})();
`;

const engine = (mode: Mode) => ENGINE.replace('__MODE__', mode).replace('__SKEL__', JSON.stringify(SKELETON[mode]));

// Look shared by all three: the demo strip, the loading look's pieces, and
// room at the bottom so the strip never covers a card.
const BASE = String.raw`
body { padding-bottom: 54px; }
.fx-demo { position: fixed; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 50; display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; align-items: center; max-width: calc(100% - 16px); padding: 5px 8px; border-radius: var(--radius-lg, 12px); background: var(--panel); border: 1px solid var(--edge); font-size: 11px; color: var(--fg-muted); }
.fx-demo b { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.fx-demo button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.cam-view, .cam-badge, .cam-msg { transform-origin: top; }
.clim-set .val b { display: inline-block; }
@keyframes fxSweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
@keyframes fxBlink { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@keyframes fxEnter { from { opacity: 0; transform: translateY(6px); } }
@keyframes fxPop { 0% { transform: scale(.8); } 60% { transform: scale(1.1); } 100% { transform: scale(1); } }
@keyframes fxRise { from { opacity: 0; transform: translateY(8px); } }
@keyframes fxSlide { from { opacity: 0; transform: translateX(10px); } }
@keyframes fxFromFull { from { opacity: 1; } }
@keyframes fxFromDim { from { opacity: .5; } }
@keyframes fxOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes fxUp { from { opacity: 0; transform: translateY(45%); } }
@keyframes fxDown { from { opacity: 0; transform: translateY(-45%); } }
@keyframes fxGlowIn { from { opacity: 0; } }
@keyframes fxGlowOut { from { opacity: var(--g0, .16); } to { opacity: 0; } }
:root[data-hid] *, :root[data-hid] *::before, :root[data-hid] *::after { animation-play-state: paused !important; }
`;

// ── Option a: Settle — every change eases in place, quietly ───────────────
const CSS_A = BASE + String.raw`
.fx-sk { height: 62px; margin-bottom: 8px; border-radius: var(--radius-md, 8px); background: var(--inset); border: 1px solid var(--edge-dim); position: relative; overflow: hidden; }
.fx-sk::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, var(--edge-dim), transparent); }
/* Brightness: the glow follows the slider while you drag. */
.tile.on > .glow { opacity: calc(.06 + var(--b, .6) * .17); }
@media (prefers-reduced-motion: no-preference) {
  .fx-sk::after { animation: fxSweep 1.4s steps(12) infinite; }
  [data-fx~="first"] { animation: fxEnter 420ms ease-out calc(var(--i, 0) * 45ms + var(--ago, 0ms)) both; }
  [data-fx~="on"] > .glow { animation: fxGlowIn 380ms ease-out var(--ago, 0ms) both; }
  [data-fx~="off"] > .glow { --g0: .16; animation: fxGlowOut 300ms ease-out var(--ago, 0ms) both; }
  .lights[data-fx~="off"] > .glow { --g0: .10; }
  [data-fx~="on"] > .line .bulb { animation: fxPop 380ms cubic-bezier(.3, 1.4, .5, 1) var(--ago, 0ms) both; }
  [data-fx~="np-in"] .np { animation: fxRise 320ms ease-out var(--ago, 0ms) both; }
  [data-fx~="track"] .np .txt { animation: fxSlide 260ms ease-out var(--ago, 0ms) both; }
  [data-fx~="pp"] .np-ctl .key.main { animation: fxPop 300ms ease-out var(--ago, 0ms) both; }
  [data-fx~="muted"] .vlr { animation: fxFromFull 300ms ease-out var(--ago, 0ms) both; }
  [data-fx~="unmuted"] .vlr { animation: fxFromDim 300ms ease-out var(--ago, 0ms) both; }
  [data-fx~="group"] .gcard .rlbl { animation: fxSlide 260ms ease-out var(--ago, 0ms) both; }
  [data-fx~="group"] .gitem[aria-pressed="true"] .gtick { animation: fxPop 320ms ease-out var(--ago, 0ms) both; }
  [data-fx~="up"] .clim-set .val b { animation: fxUp 240ms ease-out var(--ago, 0ms) both; }
  [data-fx~="down"] .clim-set .val b { animation: fxDown 240ms ease-out var(--ago, 0ms) both; }
  [data-fx~="colour"] .bulb::after, [data-fx~="colour"] > .glow::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: var(--c0); animation: fxOut 420ms ease-out var(--ago, 0ms) both; }
  /* Changed by someone else: one soft ring that fades. */
  [data-fx~="ext"]::after { content: ''; position: absolute; inset: 0; border-radius: inherit; border: 2px solid var(--accent); pointer-events: none; animation: fxOut 1600ms ease-out var(--ago, 0ms) both; }
  .cam-view { animation: fxEnter 260ms ease-out both; }
  .cam-badge { animation: fxPop 360ms ease-out both; }
  .cam-msg { animation: fxBlink 1.4s steps(2) infinite; }
}
`;

// ── Option b: Acknowledge and wait — instant feedback, honest about waiting ─
const CSS_B = BASE + String.raw`
.fx-bar { margin: 10px auto 0; width: 140px; height: 3px; border-radius: 2px; background: var(--edge-dim); overflow: hidden; position: relative; }
.fx-bar::after { content: ''; position: absolute; inset: 0; background: var(--accent); }
.tile[data-wait], .clim[data-wait] { --wait: 1; }
.tile[data-wait]::after, .clim[data-wait]::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: linear-gradient(90deg, transparent, var(--accent), transparent); pointer-events: none; }
.tile[data-wait] .sub { opacity: .6; }
.tile[data-ok]::after, .clim[data-ok]::after { content: '\2713'; position: absolute; right: 8px; top: 8px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: rgb(47, 184, 106); color: #fff; font-size: 12px; font-weight: 700; pointer-events: none; opacity: 0; }
[data-fx~="ext"]::before { content: 'Just changed'; position: absolute; top: 6px; right: 8px; z-index: 2; padding: 2px 8px; border-radius: 9999px; font-size: 10px; font-weight: 700; letter-spacing: .04em; background: var(--accent); color: var(--on-accent); pointer-events: none; opacity: 0; }
#fx-tip { position: fixed; left: 0; top: 0; z-index: 70; padding: 2px 9px; border-radius: 9999px; background: var(--fg); color: var(--canvas); font: 600 12px var(--font-mono, monospace); pointer-events: none; opacity: 0; transition: opacity 120ms ease; }
#fx-tip[data-show] { opacity: 1; }
.fx-rip { position: fixed; left: 0; top: 0; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; background: var(--accent); pointer-events: none; z-index: 60; opacity: 0; }
@keyframes fxRip { from { opacity: .4; transform: translate(var(--x), var(--y)) scale(.3); } to { opacity: 0; transform: translate(var(--x), var(--y)) scale(1.7); } }
@keyframes fxTick { 0% { opacity: 0; transform: scale(.4); } 18% { opacity: 1; transform: scale(1.15); } 28% { transform: scale(1); } 80% { opacity: 1; } 100% { opacity: 0; } }
@keyframes fxPill { 0% { opacity: 0; transform: translateY(-4px); } 6% { opacity: 1; transform: none; } 88% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: no-preference) {
  .fx-bar::after { animation: fxSweep 1.1s steps(10) infinite; }
  .fx-rip { animation: fxRip 520ms ease-out forwards; }
  .tile[data-wait]::after, .clim[data-wait]::after { animation: fxSweep 1s steps(12) infinite; }
  .tile[data-wait] .bulb { animation: fxBlink 1.6s steps(4) infinite; }
  .tile[data-ok]::after, .clim[data-ok]::after { animation: fxTick 1000ms ease-out var(--okago, 0ms) both; }
  [data-fx~="ext"]::before { animation: fxPill 5000ms ease-out var(--ago, 0ms) both; }
  [data-fx~="np-in"] .np { animation: fxRise 260ms ease-out var(--ago, 0ms) both; }
  .cam-msg { animation: fxBlink 1.2s steps(2) infinite; }
  .cam-badge { animation: fxPop 300ms ease-out both; }
}
@media (prefers-reduced-motion: reduce) {
  .tile[data-wait]::after, .clim[data-wait]::after { animation: none; opacity: .6; }
  .tile[data-ok]::after, .clim[data-ok]::after { opacity: 1; }
  [data-fx~="ext"]::before { opacity: 1; }
}
`;

// ── Option c: Spread and spring — light blooms from the bulb, rooms cascade ─
const CSS_C = BASE + String.raw`
.fx-bulbs { display: flex; gap: 10px; justify-content: center; margin-bottom: 10px; }
.fx-bulbs i { width: 14px; height: 14px; border-radius: 50%; background: var(--fg-muted); opacity: .3; }
.tile.on > .glow { opacity: calc(.08 + var(--b, .6) * .14); }
.tile.on .bulb { transform: scale(calc(.9 + var(--b, .6) * .14)); }
@keyframes fxBloom { from { opacity: 0; transform: scaleX(.06); } }
@keyframes fxBloomOut { from { opacity: var(--g0, .16); transform: scaleX(1); } to { opacity: 0; transform: scaleX(.06); } }
@keyframes fxSpring { 0% { transform: scale(.5); } 55% { transform: scale(1.18); } 100% { transform: scale(1); } }
@keyframes fxHalo { from { opacity: .85; transform: scale(1); } to { opacity: 0; transform: scale(2.3); } }
@keyframes fxUnfold { from { opacity: 0; transform: scaleY(.55); } }
@keyframes fxKey { 0% { transform: scale(.6) rotate(-70deg); } 60% { transform: scale(1.15) rotate(8deg); } 100% { transform: none; } }
@keyframes fxFlash { from { opacity: .6; } }
@keyframes fxGlint { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
@keyframes fxBulbWake { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: no-preference) {
  .fx-bulbs i { animation: fxBulbWake 1.2s steps(6) infinite; }
  .fx-bulbs i:nth-child(2) { animation-delay: -.4s; } .fx-bulbs i:nth-child(3) { animation-delay: -.8s; }
  /* The light spreads out from the bulb; a room's All makes its lights follow one after another. */
  [data-fx~="on"] > .glow, [data-fx~="first"].on > .glow { transform-origin: 28px 50%; animation: fxBloom 560ms cubic-bezier(.2, .8, .2, 1) calc(var(--i, 0) * 70ms + var(--ago, 0ms)) both; }
  .lights[data-fx~="on"] > .glow { transform-origin: 28px 0; }
  [data-fx~="off"] > .glow { --g0: .16; transform-origin: 28px 50%; animation: fxBloomOut 360ms ease-in calc(var(--i, 0) * 70ms + var(--ago, 0ms)) both; }
  .lights[data-fx~="off"] > .glow { --g0: .10; }
  [data-fx~="on"] > .line .bulb, [data-fx~="first"].on > .line .bulb { animation: fxSpring 480ms cubic-bezier(.34, 1.56, .64, 1) calc(var(--i, 0) * 70ms + var(--ago, 0ms)) both; }
  [data-fx~="on"] > .line .bulb::before, [data-fx~="first"].on > .line .bulb::before { content: ''; position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--c); pointer-events: none; animation: fxHalo 640ms ease-out calc(var(--i, 0) * 70ms + var(--ago, 0ms)) both; }
  [data-fx~="first"] { animation: fxEnter 460ms ease-out calc(var(--i, 0) * 90ms + var(--ago, 0ms)) both; }
  [data-fx~="np-in"] .np { transform-origin: top; animation: fxUnfold 400ms cubic-bezier(.2, .9, .3, 1.15) var(--ago, 0ms) both; }
  [data-fx~="track"] .np .art { animation: fxSpring 420ms cubic-bezier(.34, 1.56, .64, 1) var(--ago, 0ms) both; }
  [data-fx~="track"] .np .txt { animation: fxSlide 280ms ease-out var(--ago, 0ms) both; }
  [data-fx~="pp"] .np-ctl .key.main { animation: fxKey 400ms cubic-bezier(.34, 1.56, .64, 1) var(--ago, 0ms) both; }
  [data-fx~="muted"] .vlr { animation: fxFromFull 300ms ease-out var(--ago, 0ms) both; }
  [data-fx~="unmuted"] .vlr { animation: fxFromDim 300ms ease-out var(--ago, 0ms) both; }
  [data-fx~="group"] .gitem[aria-pressed="true"] .gtick { animation: fxSpring 420ms cubic-bezier(.34, 1.56, .64, 1) var(--ago, 0ms) both; }
  [data-fx~="group"] .gcard .rlbl { animation: fxSlide 260ms ease-out var(--ago, 0ms) both; }
  [data-fx~="up"] .clim-set .val b { animation: fxUp 260ms cubic-bezier(.3, 1.3, .5, 1) var(--ago, 0ms) both; }
  [data-fx~="down"] .clim-set .val b { animation: fxDown 260ms cubic-bezier(.3, 1.3, .5, 1) var(--ago, 0ms) both; }
  [data-fx~="up"] > .glow, [data-fx~="down"] > .glow { animation: fxFlash 700ms ease-out var(--ago, 0ms) both; }
  [data-fx~="colour"] .bulb::after, [data-fx~="colour"] > .glow::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: var(--c0); animation: fxOut 500ms ease-out var(--ago, 0ms) both; }
  /* Changed by someone else: a glint sweeps once across the card. */
  [data-fx~="ext"]::before { content: ''; position: absolute; inset: 0; z-index: 2; pointer-events: none; background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, .3) 50%, transparent 70%); animation: fxGlint 950ms ease-out var(--ago, 0ms) both; }
  .cam-view { transform-origin: 50% 50%; animation: fxUnfold 360ms cubic-bezier(.2, .9, .3, 1.1) both; }
  .cam-badge { animation: fxSpring 420ms cubic-bezier(.34, 1.56, .64, 1) both; }
  .cam-msg { animation: fxBlink 1.2s steps(2) infinite; }
}
`;

const OPEN = { open: ['destins_room', 'living_room'] };

export const VARIANTS: HomeVariants = {
  a: {
    label: 'Settle: gentle fades and pops',
    css: CSS_A, js: engine('a'), transform: hooks('a'), data: OPEN,
  },
  b: {
    label: 'Acknowledge and wait: ripple, waiting bar, tick',
    css: CSS_B, js: engine('b'), transform: hooks('b'), data: OPEN,
  },
  c: {
    label: 'Spread and spring: light blooms, rooms cascade',
    css: CSS_C, js: engine('c'), transform: hooks('c'), data: OPEN,
  },
};
