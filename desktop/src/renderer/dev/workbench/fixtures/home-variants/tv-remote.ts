// Design options for the "tv-remote" task of the Home page redesign (round 2b). Keys are
// "<option>" or "<option>-<state>" (e.g. "a", "a-open"); each becomes the
// practice screen pages/page/page-home#v-tv-remote-<key>. See types.ts.
//
// THE REBUILT TV CARD (owner's verdicts 2026-10-04, shared by all three options):
//  - CLOSED: one transport row  previous · -10s · play/pause · +10s · next. No app buttons.
//  - OPEN (remote icon in the header): the row becomes  Back · previous · play/pause · next · Home, the pad
//    appears above the volume row, and four app buttons sit below. The app that is on the TV is never offered:
//    Prime Video takes its place.
//  - The -10s/+10s buttons are drawn only where the device can seek (the media player supports it, or the TV has a
//    remote the build can press rewind/fast-forward on). The practice house is assumed to support it.
//  - REVEAL = "option B" of round 2: the panel stretches down while the volume row slides lower and the pad fades in.
//    No spinning or sweeping anything.
// The three options differ ONLY in the pad's layout, all in the page's own "Glass and glow" styling.
//
// HOW (practice only): `transform` rewrites the page's tile drawing (exact-text swaps, each checked so a page change
// that moves a line fails loudly); the option's own CSS then styles the pad. Everything animated is always drawn
// and driven by a data-open attribute, so a redraw mid-animation only patches the attribute and the CSS transition
// carries on (nothing is cut off by innerHTML).
import type { HomeVariants } from './types';

const RC = 'remote.destins_room_tv_remote';
// WHY the others are hidden: the practice window is short; hiding them puts the card being judged at the top.
const DATA = { startOpen: ['destins_room'], view: 'media', hidden: ['media_player.destins_room_tv', 'media_player.destins_room', 'media_player.living_room_speaker', 'media_player.roam_2', 'media_player.move_2'] };

// Exact-text swap that refuses to run silently on a page that has changed.
function rep(html: string, from: string, to: string): string {
  if (!html.includes(from)) throw new Error('tv-remote variant: page text not found: ' + from.slice(0, 60));
  return html.replace(from, () => to);
}

// WHY plain strings with no backticks/dollar-brace: they are pasted inside the page's own script.
const HELPERS = String.raw`
  function backIcon() { return ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 16); }
  function homeIcon() { return ico('<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>', 16); }
  // Jump back / forward 10 seconds: a circular arrow with a small "10" inside.
  function seekIcon(fwd) {
    var arc = fwd ? '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>' : '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>';
    return ico(arc + '<text x="12" y="15.6" text-anchor="middle" font-size="8.5" font-weight="700" stroke="none" fill="currentColor" font-family="inherit">10</text>', 18);
  }
  // The remote icon in the header, beside power. aria-expanded drives its filled look.
  function rctlHtml(rc, rOpen, it, right) {
    return '<span class="rctl"><button class="rtoggle" data-remote="' + esc(rc.id) + '" aria-expanded="' + !!rOpen + '" aria-label="' + (rOpen ? 'Hide' : 'Show') + ' remote for ' + esc(it.name) + '" title="Remote">' + REMOTE + '</button>' + right + '</span>';
  }
  // The pad. Always drawn (closed = data-open 0, inert); the reveal is a CSS change of that one attribute.
  function padHtml(r, open) {
    var id = esc(r.id);
    var k = function (cmd, label, inner, cls) { return '<button class="' + cls + '" data-rc="' + id + '" data-cmd="' + cmd + '" aria-label="' + label + '" title="' + label + '">' + inner + '</button>'; };
    return '<div class="rpad" data-open="' + (open ? 1 : 0) + '"' + (open ? '' : ' inert aria-hidden="true"') + '><div class="rpad-in"><div class="rdial" role="group" aria-label="Arrows for ' + esc(r.name) + '">' +
      k('DPAD_UP', 'Up', ico('<path d="m18 15-6-6-6 6"/>', 22), 'up') + k('DPAD_LEFT', 'Left', ico('<path d="m15 18-6-6 6-6"/>', 22), 'left') +
      k('DPAD_CENTER', 'OK', 'OK', 'ok') + k('DPAD_RIGHT', 'Right', ico('<path d="m9 18 6-6-6-6"/>', 22), 'right') + k('DPAD_DOWN', 'Down', ico('<path d="m6 9 6 6 6-6"/>', 22), 'down') +
      '</div></div></div>';
  }
  // Four buttons from this order; whichever is on the TV right now is replaced, in the same place, by Prime Video.
  var RC_ORDER = ['YouTube', 'Netflix', 'HBO Max', 'Disney+'];
  function rcChipsHtml(r, active) {
    var id = esc(r.id);
    var list = RC_ORDER.map(function (n) { return active && active.name === n ? 'Prime' : n; });
    return '<div class="rchips"><div class="rchips-in"><div class="apps2">' + list.map(function (n) {
      var a = APPS.filter(function (x) { return x.name === n; })[0];
      return '<button class="app app2" data-rc="' + id + '" data-app="' + esc(a.url) + '" data-name="' + esc(a.name) + '" aria-label="Open ' + esc(a.name) + '"><span class="logo" style="--app:' + a.bg + '">' + a.mark + '</span><span class="nm">' + esc(a.name) + '</span></button>';
    }).join('') + '</div></div></div>';
  }
`;

// HBO Max: a purple-to-black badge with a lower-case "max" wordmark, drawn from text only.
const HBO = `{ name: 'HBO Max', url: 'https://play.hbomax.com', pkg: 'wbd', bg: 'linear-gradient(145deg,#0a0614 0%,#3a1a8a 55%,#8a3ffc 100%)', mark: '<span style="font-size:15px;font-weight:900;letter-spacing:-.05em;text-transform:lowercase">max</span>' },
    `;

function transform(html: string): string {
  let h = html;
  // 1. HBO Max joins the app list (Prime stays: it is the swap-in).
  h = rep(h, "{ name: 'Prime', url:", HBO + "{ name: 'Prime', url:");
  // 2. PRACTICE ONLY: the pretend TV says "YouTube"; this card is judged with Netflix playing, and pressing an app
  //    button makes that app the one playing (the real TV reports it back through Home Assistant).
  h = rep(h, 'function appOf(pkg) {', "function appOf(pkg) {\n    if (pkg) { if (window.__demoApp) pkg = window.__demoApp; else if (String(pkg).indexOf('youtube.tv') >= 0) pkg = 'netflix'; }");
  h = rep(h, "var cmd = t.getAttribute('data-cmd'), app = t.getAttribute('data-app');",
    "var cmd = t.getAttribute('data-cmd'), app = t.getAttribute('data-app');\n      if (app) { window.__demoApp = (APPS.filter(function (a) { return a.url === app; })[0] || {}).pkg; setTimeout(render, 600); }");
  // 3. The old Remote row and its big dial are replaced by the helpers above.
  h = h.replace(/function remoteHtml\(r\) \{[\s\S]*?\n  \}\n/, () => HELPERS + '\n');
  if (!h.includes('function padHtml(')) throw new Error('tv-remote variant: remoteHtml not replaced');
  // 4. A TV card always has its panel (so the pad has a place), even with nothing playing.
  h = rep(h, 'var nowHtml = media && on && (playing && what || app)', 'var nowHtml = media && on && (playing && what || app || (tv && rc))');
  h = rep(h, 'esc(playing && what ? what : app.name)', "esc(playing && what ? what : app ? app.name : 'TV')");
  // 5. The transport row: seven buttons that always exist. Closed shows -10s/+10s; open shows Back/Home.
  //    (-10s/+10s are drawn here because the practice house supports them; the build draws them only when the
  //    media player can seek or the TV has a remote entity.)
  h = rep(h, "ctl = rk('MEDIA_PREVIOUS', 'Previous', PREV) +",
    "ctl = rk('BACK', 'Back', backIcon(), ' s-back') + rk('MEDIA_PREVIOUS', 'Previous', PREV, ' s-prev') + rk('SEEK_BACK', 'Back 10 seconds', seekIcon(0), ' s-sb') +");
  h = rep(h, "rk('MEDIA_NEXT', 'Next', NEXT);",
    "rk('SEEK_FWD', 'Forward 10 seconds', seekIcon(1), ' s-sf') + rk('MEDIA_NEXT', 'Next', NEXT, ' s-next') + rk('HOME', 'Home', homeIcon(), ' s-home');");
  // 6. The panel's controls: pad, volume, keys (carrying the open state), app buttons.
  h = rep(h, `(vol || ctl ? '<div class="np-ctl">' + vol + (ctl ? '<div class="np-keys">' + ctl + '</div>' : '') + '</div>' : '')`,
    `(vol || ctl ? '<div class="np-ctl">' + (tv && rc ? padHtml(rc, remoteOpen.has(rc.id)) : '') + vol + (ctl ? '<div class="np-keys"' + (tv && rc ? ' data-open="' + (remoteOpen.has(rc.id) ? 1 : 0) + '"' : '') + '>' + ctl + '</div>' : '') + (tv && rc ? rcChipsHtml(rc, app) : '') + '</div>' : '')`);
  // 7. The remote icon joins power in the header; the separate Remote card goes.
  h = rep(h, "right + '</div>' + nowHtml", "(tv && rc && on ? rctlHtml(rc, rOpen, it, right) : right) + '</div>' + nowHtml");
  const before = h;
  h = h.replace(/\n      \(rc \? '<div class="rcard'[^\n]*\+\n/, "\n      '' +\n");
  if (h === before) throw new Error('tv-remote variant: Remote row not found');
  return h;
}

// ── Shared CSS: header icon, the swap of -10s/+10s with Back/Home, the reveal, app buttons ─────────────
// WHY individual transform properties (translate / scale) on the row's buttons: the page's own press feel is a
// `transform: scale(.94)` on :active; if the slide used `transform` too, pressing a sliding button would snap it.
const SHARED_CSS = String.raw`
.rctl { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.rtoggle { width: 36px; height: 36px; flex-shrink: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--fg) 14%, transparent); background: var(--well); color: var(--fg-muted); cursor: pointer; display: grid; place-items: center; padding: 0; transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 90ms ease; }
.rtoggle:hover { color: var(--fg); border-color: var(--fg-muted); }
.rtoggle:active { transform: scale(.94); }
.rtoggle[aria-expanded="true"] { background: color-mix(in srgb, var(--accent) 22%, var(--well)); border-color: var(--accent); color: var(--accent); }
.rtoggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.np-ctl { gap: 0; padding-top: 4px; }

/* The transport row: five equal slots. Closed: prev -10 play +10 next. Open: back prev play next home.
   Play never moves; prev and next slide one slot inward while -10/+10 fade out and Back/Home fade in. */
.np-ctl > .np-keys { --s: 52px; display: grid; grid-template-columns: repeat(5, 44px); justify-content: center; gap: 8px; margin-top: 12px; }
.np-keys > .key { grid-row: 1; justify-self: center; align-self: center; transition: translate 320ms cubic-bezier(.2,.8,.2,1), scale 320ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease, background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 90ms ease, visibility 0s linear 0s; }
.np-keys > .s-back { grid-column: 1; } .np-keys > .s-prev { grid-column: 1; } .np-keys > .s-sb { grid-column: 2; }
.np-keys > .main { grid-column: 3; }
.np-keys > .s-sf { grid-column: 4; } .np-keys > .s-next { grid-column: 5; } .np-keys > .s-home { grid-column: 5; }
.np-keys .s-sb, .np-keys .s-sf { color: var(--fg-2); }
/* closed: Back/Home wait (invisible, unreachable) */
.np-keys[data-open="0"] > .s-back, .np-keys[data-open="0"] > .s-home { opacity: 0; scale: .6; visibility: hidden; pointer-events: none; transition: opacity 160ms ease, scale 200ms ease, visibility 0s linear 220ms; }
/* open: -10/+10 step out, prev/next step in */
.np-keys[data-open="1"] > .s-prev { translate: var(--s) 0; }
.np-keys[data-open="1"] > .s-next { translate: calc(var(--s) * -1) 0; }
.np-keys[data-open="1"] > .s-sb, .np-keys[data-open="1"] > .s-sf { opacity: 0; scale: .6; visibility: hidden; pointer-events: none; transition: opacity 160ms ease, scale 200ms ease, visibility 0s linear 220ms; }
.np-keys[data-open="1"] > .s-back, .np-keys[data-open="1"] > .s-home { transition-delay: 90ms, 90ms, 0s, 0s, 0s, 0s, 0s, 0s; }
/* a TV with no open state (a plain speaker) never gets here; the attribute is only drawn for TVs */

/* The reveal (round 2, option B): the panel's row grows from 0 while the volume row slides lower and the pad fades in. */
.rpad { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 340ms cubic-bezier(.2,.8,.2,1); }
.rpad[data-open="1"] { grid-template-rows: 1fr; }
.rpad-in { min-height: 0; overflow: hidden; display: flex; justify-content: center; }
.rdial { opacity: 1; transition: opacity 260ms ease 100ms, visibility 0s linear 0s; }
.rpad[data-open="0"] .rdial { opacity: 0; visibility: hidden; transition: opacity 140ms ease, visibility 0s linear 340ms; }
.rdial button { appearance: none; border: 0; background: transparent; color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: transform 90ms ease, background-color 120ms ease, color 120ms ease, box-shadow 120ms ease; }
.rdial button:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.rdial button:hover:not(.ok) { color: var(--fg); }
.rdial button:active:not(.ok) { color: var(--accent); }
/* OK is the page's primary round button (same as play/pause) */
.rdial .ok { background: var(--accent); color: var(--on-accent); font: 700 14px/1 inherit; letter-spacing: .04em; border-radius: 50%; box-shadow: 0 6px 16px -8px var(--accent); }
.rdial .ok:active { transform: scale(.94); }

/* App buttons: only while the remote is open; they arrive after the pad */
.rchips { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 340ms cubic-bezier(.2,.8,.2,1); }
.rchips-in { min-height: 0; overflow: hidden; }
.np-ctl:has(.rpad[data-open="1"]) .rchips { grid-template-rows: 1fr; }
.apps2 { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding-top: 12px; opacity: 0; transform: translateY(8px); transition: opacity 200ms ease, transform 200ms ease; }
.np-ctl:has(.rpad[data-open="1"]) .apps2 { opacity: 1; transform: none; transition: opacity 260ms ease 140ms, transform 300ms cubic-bezier(.2,.8,.2,1) 140ms; }
.app2 { padding: 4px 2px; gap: 5px; font-size: 10.5px; }
.app2 .logo { width: 40px; height: 40px; border-radius: 12px; font-size: 14px; transition: transform 90ms ease; }
.app2:active .logo { transform: scale(.94); }
.apps2 > .ghost { position: absolute; pointer-events: none; margin: 0; }
@media (prefers-reduced-motion: reduce) {
  .rpad, .rtoggle, .rdial, .rdial button, .np-keys > .key, .app2 .logo, .rchips, .apps2 { transition: none !important; animation: none !important; }
}
`;

// ── Shared script: the app-button swap (outgoing button slides out left, Prime slides in from the right) ──
// WHY it compares the buttons after each redraw: the TV tells the page which app is on, whenever it likes; the page
// then redraws. Remembering the buttons from the previous draw lets the outgoing one be drawn once more as a "ghost"
// that fades away while the new one arrives. Nothing here lives on the redrawn elements.
const SHARED_JS = String.raw`
(function () {
  var prev = {};
  var EASE = 'cubic-bezier(.2,.8,.2,1)';
  var OUT = [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-18px)', opacity: 0 }], OUTT = { duration: 220, easing: 'ease-in' };
  var INN = [{ transform: 'translateX(18px)', opacity: 0 }, { transform: 'none', opacity: 1 }], INT = { duration: 320, delay: 110, easing: EASE, fill: 'backwards' };
  function can() { return !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) && !document.hidden && !window.__motionOff && typeof Element.prototype.animate === 'function'; }
  function snap(box) {
    var br = box.getBoundingClientRect();
    return Array.prototype.map.call(box.children, function (c) { var r = c.getBoundingClientRect(); return { n: c.getAttribute('data-name'), x: r.left - br.left, y: r.top - br.top, w: r.width, h: r.height, html: c.outerHTML }; });
  }
  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('.apps2'), function (box, i) {
      var holder = box.closest('#rooms, #favs, #view'), key = (holder ? holder.id : '') + i;
      var cur = snap(box), was = prev[key];
      prev[key] = cur;
      if (!was || !can()) return;
      var wn = was.map(function (c) { return c.n; }), cn = cur.map(function (c) { return c.n; });
      if (wn.join('|') === cn.join('|')) return;
      was.forEach(function (c) {
        if (cn.indexOf(c.n) >= 0) return;
        var g = document.createElement('div'); g.innerHTML = c.html; var el = g.firstChild;
        el.classList.add('ghost'); el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true');
        el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; el.style.width = c.w + 'px';
        box.appendChild(el);
        var a = el.animate(OUT, OUTT); a.onfinish = a.oncancel = function () { if (el.parentNode) el.parentNode.removeChild(el); };
      });
      Array.prototype.forEach.call(box.children, function (el) { if (wn.indexOf(el.getAttribute('data-name')) < 0 && !el.classList.contains('ghost')) el.animate(INN, INT); });
    });
  }
  window.__homeAfterPut = function () { scan(); };
  setTimeout(scan, 300);
})();
`;

// ── Option A: Round glass pad. One glass circle, four arrows, OK in the middle in the accent colour. ──
// The same glass as the page's "dpad" and cards (soft top-lit gradient, hairline edge); arrows are plain, press lights a round tint.
const A_CSS = String.raw`
.rdial { position: relative; width: 184px; height: 184px; margin: 10px 0 16px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--well)), var(--well));
  border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 10%, transparent); }
.rdial button { position: absolute; border-radius: 50%; width: 52px; height: 52px; }
.rdial .up { top: 8px; left: 64px; } .rdial .down { bottom: 8px; left: 64px; }
.rdial .left { left: 8px; top: 64px; } .rdial .right { right: 8px; top: 64px; }
.rdial .ok { left: 60px; top: 60px; width: 62px; height: 62px; }
.rdial button:hover:not(.ok) { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.rdial button:active:not(.ok) { background: color-mix(in srgb, var(--accent) 24%, transparent); transform: scale(.94); }
`;

// ── Option B: Five round buttons. A plus of the page's own round control buttons: up, down, left, right, OK. ──
const B_CSS = String.raw`
.rdial { display: grid; grid-template-columns: repeat(3, 52px); grid-template-rows: repeat(3, 52px); gap: 8px; margin: 12px 0 16px; flex-shrink: 0; }
.rdial button { position: static; width: 52px; height: 52px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--fg) 14%, transparent); background: var(--well); }
.rdial .up { grid-area: 1 / 2; } .rdial .left { grid-area: 2 / 1; } .rdial .ok { grid-area: 2 / 2; border-color: var(--accent); } .rdial .right { grid-area: 2 / 3; } .rdial .down { grid-area: 3 / 2; }
.rdial button:hover:not(.ok) { border-color: var(--fg-muted); }
.rdial button:active:not(.ok) { background: var(--edge-dim); transform: scale(.94); }
`;

// ── Option C: Touchpad. A rounded glass square split into four edge zones; the zone you press tints. ──
const C_CSS = String.raw`
.rdial { position: relative; width: 208px; height: 176px; margin: 10px 0 16px; border-radius: 24px; overflow: hidden; flex-shrink: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--well)), var(--well));
  border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 10%, transparent); }
.rdial button:not(.ok) { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 0; }
.rdial .up { clip-path: polygon(50% 50%, 0 0, 100% 0); place-items: start center; padding-top: 12px; }
.rdial .right { clip-path: polygon(50% 50%, 100% 0, 100% 100%); place-items: center end; padding-right: 14px; }
.rdial .down { clip-path: polygon(50% 50%, 100% 100%, 0 100%); place-items: end center; padding-bottom: 12px; }
.rdial .left { clip-path: polygon(50% 50%, 0 100%, 0 0); place-items: center start; padding-left: 14px; }
.rdial button:not(.ok) { transition: background-color 120ms ease, color 120ms ease; }
.rdial button:hover:not(.ok) { background: color-mix(in srgb, var(--fg) 6%, transparent); }
.rdial button:active:not(.ok) { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.rdial .ok { position: absolute; left: 76px; top: 58px; width: 56px; height: 56px; z-index: 1; }
`;

const open = { ...DATA, remote: [RC] };
const mk = (label: string, css: string) => ({ label, transform, css: SHARED_CSS + css, js: SHARED_JS });

export const VARIANTS: HomeVariants = {
  a: { ...mk('Round glass pad', A_CSS), data: DATA },
  'a-open': { ...mk('Round glass pad, remote open', A_CSS), data: open },
  b: { ...mk('Five round buttons', B_CSS), data: DATA },
  'b-open': { ...mk('Five round buttons, remote open', B_CSS), data: open },
  c: { ...mk('Touchpad', C_CSS), data: DATA },
  'c-open': { ...mk('Touchpad, remote open', C_CSS), data: open },
};
