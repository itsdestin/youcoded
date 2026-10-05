// Design options for the "motion-state" task of the Home page redesign. Round 1's three options
// (picked: c, "Spread and spring", then calmed after Destin's notes) are in git at 30723d2e0; c is
// now built into the page itself (home-assistant-page-feel.ts). What stays here are two
// PRACTICE-ONLY review screens of the built page, so Destin can judge motion in one big pane
// (each becomes the practice screen pages/page/page-home#v-motion-state-<key>). See types.ts.
//
// Both carry a small "Try" strip (practice only, never in the real page): slow device (every
// press waits 3 s before it reaches the house), flip a lamp from elsewhere (the house changes by
// itself, the page is not told directly), replay first load.
import type { HomeVariants } from './types';

const DATA = { open: ['destins_room', 'living_room'] };

// Plain ES5, no backticks. WHY the one-line page hook (transform): replaying the first load needs the
// page's own `drawn` list and render(); without the hook the button just does nothing.
const STRIP = String.raw`
(function () {
  var yc = window.youcoded, realFetch = yc.fetch, slow = false, flip = 0;
  yc.fetch = function (url, opts) {
    var go = function () { return realFetch.call(yc, url, opts); };
    if (slow && typeof url === 'string' && url.indexOf('/api/services/') >= 0) return new Promise(function (ok) { setTimeout(ok, 3000); }).then(go);
    return go();
  };
  var css = document.createElement('style');
  css.textContent = 'body{padding-bottom:54px}.fx-demo{position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:50;display:flex;gap:6px;flex-wrap:wrap;justify-content:center;align-items:center;max-width:calc(100% - 16px);padding:5px 8px;border-radius:var(--radius-lg,12px);background:var(--panel);border:1px solid var(--edge);font-size:11px;color:var(--fg-muted)}.fx-demo b{font-weight:700;letter-spacing:.06em;text-transform:uppercase}.fx-demo button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}';
  document.head.appendChild(css);
  var bar = document.createElement('div'); bar.className = 'fx-demo';
  bar.innerHTML = '<b>Try:</b><button class="yc-button yc-button--sm" data-fx-slow aria-pressed="false">Slow device: off</button>' +
    '<button class="yc-button yc-button--sm" data-fx-ext>Flip a lamp from elsewhere</button><button class="yc-button yc-button--sm" data-fx-replay>Replay first load</button>';
  document.body.appendChild(bar);
  bar.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-fx-slow')) { slow = !slow; t.setAttribute('aria-pressed', String(slow)); t.textContent = 'Slow device: ' + (slow ? 'ON (3 s)' : 'off'); }
    else if (t.hasAttribute('data-fx-ext')) {
      flip++; var on = flip % 2 === 0, base = (yc.devices || {}).ha;
      ['light.overhead_light', 'light.living_room_ceiling'].forEach(function (x) {
        realFetch.call(yc, base + '/api/services/light/' + (on ? 'turn_on' : 'turn_off'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_id: x }) });
      });
    } else if (t.hasAttribute('data-fx-replay') && window.__fxReplay) {
      document.getElementById('rooms').innerHTML = '<div class="yc-empty"><div class="fx-bulbs"><i></i><i></i><i></i></div>Loading your rooms…</div>';
      setTimeout(function () { window.__fxReplay(); }, 2200);
    }
  });
})();`;

const hook = (html: string): string => html.replace('var drawn = {};', 'var drawn = {}; window.__fxReplay = function () { drawn = {}; fxFirst = {}; render(); };');

export const VARIANTS: HomeVariants = {
  // The built page at normal speed with the "Try" strip, so the slow-device and from-elsewhere tests work at full pace too.
  built: {
    label: 'Press feedback, with the Try strip',
    data: DATA, transform: hook, js: STRIP,
  },
  // The built page with every movement at quarter speed, to see what it is doing.
  // WHY patch animate() and poll: the page's own movements start through Element.animate, and its
  // few CSS fades are caught by the poll, so everything runs at the same slow pace.
  slow: {
    label: 'Press feedback at quarter speed',
    data: DATA, transform: hook,
    sameAs: { name: 'pages/page/page-home#v-motion-state-built', why: 'the same page at rest; only its speed differs' },
    js: STRIP + String.raw`
(function () {
  var real = Element.prototype.animate;
  Element.prototype.animate = function () { var a = real.apply(this, arguments); a.playbackRate = 0.25; return a; };
  setInterval(function () { if (document.hidden) return; document.getAnimations().forEach(function (a) { if (a.playbackRate !== 0.25) a.playbackRate = 0.25; }); }, 60);
})();`,
  },
  // The built page with its press feedback switched off (the page's own check), for comparison.
  before: {
    label: 'Without the new press feedback',
    data: DATA, transform: hook,
    sameAs: { name: 'pages/page/page-home#v-motion-state-built', why: 'the same page at rest; only its press feedback differs' },
    js: String.raw`window.__feelOff = true; document.documentElement.setAttribute('data-feel-off', '1');` + STRIP,
  },
};
