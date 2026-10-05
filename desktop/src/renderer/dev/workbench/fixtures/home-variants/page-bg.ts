// Design options for the "page-bg" task of the Home page redesign (round 3: the page's background). Keys are
// "<option>" or "<option>-<state>"; each becomes the practice screen pages/page/page-home#v-page-bg-<key>. See types.ts.
//
// Destin: "replace the whole page background with a glass style". Three KINDS:
//   a  See-through     the page paints NO background of its own, so the app's wallpaper would show through. The frame does
//                      not allow that today (PageHost.tsx puts bg-canvas on the pane and on the iframe), so here a stand-in
//                      wallpaper is drawn behind the page. Needs an app-side change, see the deck text.
//   b  Frosted canvas  a soft, blurry-looking glow drawn by the page itself (big theme-coloured gradients, no blur filter).
//   c  Colours of the house  the same soft glow, tinted by the lights that are on and the app that is playing.
// WHY no backdrop-filter anywhere in here: a blur inside the frame cannot see the app behind it, and the app allows one
// blur only (react-renderer.md "ONE backdrop-filter, ever"; performance.md: never one per card). The "glass" is faked with
// translucent fills + a bright top edge, over a background that is already soft, so it costs nothing to paint.
// Theme colours only (var(--accent) etc.); the status colours (a light's own colour) stay literal.
import type { HomeVariants } from './types';

// Shared: every card becomes see-through glass (the fill is the theme's panel colour at a percentage, so it works in
// dark and light themes), with a lighter top edge. --gl is how much of the panel colour stays (higher = more solid = more readable).
const GLASS = String.raw`
  html { background: var(--canvas); }
  body { background: transparent; }
  /* the background layer: fixed, behind everything, never repaints on scroll */
  body::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none; }
  .yc-card.room, .yc-card.set-sec { border-color: color-mix(in srgb, var(--fg) 16%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 9%, transparent), transparent 55%), color-mix(in srgb, var(--panel) calc(var(--gl, 70) * 1%), transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 22%, transparent), 0 14px 30px -18px rgba(0,0,0,.45); }
  .tile, .thing, .np, .ev, .chip, .tile2, .prob { background: color-mix(in srgb, var(--fg) 6%, transparent); border-color: color-mix(in srgb, var(--fg) 14%, transparent); }
  .lights-body > .tile { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .pill, .bar .yc-button { background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 12%, transparent), color-mix(in srgb, var(--fg) 4%, transparent)), color-mix(in srgb, var(--panel) 55%, transparent);
    border-color: color-mix(in srgb, var(--fg) 20%, transparent); }
  .pill.sel, .pill.lit.sel { background: var(--accent); border-color: var(--accent); }
  .bar .yc-button--primary { background: var(--accent); border-color: var(--accent); }
`;

// a. See-through. A stand-in for the app's own wallpaper after the app's glass has softened it: a warm light from the top
// left and a darker lower right, with a faint diagonal sheen. Cards are the most transparent of the three (--gl 52).
const SEE_THROUGH = GLASS + String.raw`
  :root { --gl: 52; }
  body::before { background:
    radial-gradient(60% 55% at 12% 0%, color-mix(in srgb, var(--accent) 38%, transparent), transparent 72%),
    radial-gradient(50% 50% at 100% 100%, color-mix(in srgb, var(--link, var(--accent)) 24%, transparent), transparent 70%),
    repeating-linear-gradient(115deg, transparent 0 140px, color-mix(in srgb, var(--fg) 4%, transparent) 140px 190px),
    linear-gradient(160deg, color-mix(in srgb, var(--accent) 14%, var(--canvas)), var(--canvas) 70%); }
`;

// b. Frosted canvas: four big soft glows (radial gradients are soft by nature, so no blur filter is needed).
const FROSTED = GLASS + String.raw`
  :root { --gl: 72; }
  body::before { inset: -12%; background:
    radial-gradient(38% 34% at 14% 14%, color-mix(in srgb, var(--accent) 46%, transparent), transparent 70%),
    radial-gradient(34% 38% at 86% 24%, color-mix(in srgb, var(--link, var(--fg-2)) 34%, transparent), transparent 70%),
    radial-gradient(40% 36% at 70% 88%, color-mix(in srgb, var(--accent) 32%, transparent), transparent 70%),
    radial-gradient(34% 34% at 8% 80%, color-mix(in srgb, var(--fg-2) 24%, transparent), transparent 70%); }
`;
// Slow drift (live pane only): transform only, in 40 coarse steps over two minutes, off for reduced motion and while hidden.
const DRIFT = String.raw`
  @media (prefers-reduced-motion: no-preference) { body::before { animation: bgdrift 120s steps(40) infinite alternate; } }
  :root[data-hid] body::before { animation-play-state: paused; }
  @keyframes bgdrift { from { transform: translate3d(-3%, 2%, 0); } to { transform: translate3d(3%, -2%, 0); } }
`;

// c. Colours of the house: the glow takes the colours of up to three lights that are on, and the playing app's colour.
// The script writes --h1..--h3 on the page root after each redraw (no transition: it simply changes with the house).
const HOUSE = GLASS + String.raw`
  :root { --gl: 74; --h1: var(--accent); --h2: var(--accent); --h3: var(--fg-2); --h4: var(--accent); }
  body::before { inset: -12%; background:
    radial-gradient(40% 36% at 12% 10%, color-mix(in srgb, var(--h1) 44%, transparent), transparent 70%),
    radial-gradient(36% 38% at 88% 20%, color-mix(in srgb, var(--h4) 42%, transparent), transparent 70%),
    radial-gradient(42% 38% at 62% 92%, color-mix(in srgb, var(--h2) 38%, transparent), transparent 70%),
    radial-gradient(32% 34% at 6% 78%, color-mix(in srgb, var(--h3) 30%, transparent), transparent 70%); }
`;
const HOUSE_JS = String.raw`
  // WHY read the pages's own cards instead of the data: the cards already hold the colour each light shows (--c), and the
  // playing card holds the app's colour (--app), so the glow always agrees with what is on screen. Only after the lists redraw.
  (function () {
    var last = '';
    function pick() {
      var out = [], seen = {};
      var els = document.querySelectorAll('.tile.on');
      for (var i = 0; i < els.length && out.length < 3; i++) {
        var c = els[i].style.getPropertyValue('--c').trim();
        if (c && c.indexOf('var(') < 0 && !seen[c]) { seen[c] = 1; out.push(c); }
      }
      var art = document.querySelector('.np .art');
      var app = art ? art.style.getPropertyValue('--app').trim() : '';
      return { lights: out, app: app && app.indexOf('var(') < 0 ? app : '' };
    }
    var prev = window.__homeAfterPut;
    window.__homeAfterPut = function (id) {
      if (prev) prev(id);
      if (id !== 'rooms' && id !== 'favs' && id !== 'view') return;
      var p = pick(), key = p.lights.join('|') + '~' + p.app;
      if (key === last) return;
      last = key;
      var r = document.documentElement.style, L = p.lights;
      // fewer than three lights on: the missing glows fall back to the theme's accent
      r.setProperty('--h1', L[0] || 'var(--accent)');
      r.setProperty('--h2', L[1] || L[0] || 'var(--accent)');
      r.setProperty('--h3', L[2] || 'var(--fg-2)');
      r.setProperty('--h4', p.app || L[0] || 'var(--accent)');
    };
  })();
`;
// Pictures: the entrance stagger runs while the screenshot is taken and would hide room cards 2 and up, so the
// still-picture states switch the page's own entrance motion off (the same switch the other redesign pictures use).
// Two switches: __motionOff (page motion) and __feelOff (the first-load rise of room cards: the stagger that hid rooms 2+). Set BEFORE the page's first draw (an extra script at the end runs too late), so it goes in by rewrite.
const STILL_OFF = (html: string) => html.replace('<body>', '<body><script>window.__motionOff = true; window.__feelOff = true;</script>');

export const VARIANTS: HomeVariants = {
  // the page as it is now, with the entrance rise off so every room card is drawn when the picture is taken
  today: { label: 'Today (flat background)', transform: STILL_OFF },
  a: { label: 'See-through (stand-in wallpaper)', css: SEE_THROUGH, transform: STILL_OFF },
  b: { label: 'Frosted canvas', css: FROSTED, transform: STILL_OFF },
  c: { label: 'Colours of the house', css: HOUSE, js: HOUSE_JS, transform: STILL_OFF },
  // live panes: normal motion; b also drifts
  'a-play': { label: 'See-through, to operate', css: SEE_THROUGH, sameAs: { name: 'pages/page/page-home#v-page-bg-a', why: 'same background; only the page\'s own motion is on, for the live pane' } },
  'b-play': { label: 'Frosted canvas, to operate', css: FROSTED + DRIFT },
  'c-play': { label: 'Colours of the house, to operate', css: HOUSE, js: HOUSE_JS, sameAs: { name: 'pages/page/page-home#v-page-bg-c', why: 'same background; only the page\'s own motion is on, for the live pane' } },
};
