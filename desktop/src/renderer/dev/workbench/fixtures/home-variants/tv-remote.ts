// Design options for the "tv-remote" task of the Home page redesign (round 2). Keys are
// "<option>" or "<option>-<state>" (e.g. "a", "a-open"); each becomes the
// practice screen pages/page/page-home#v-tv-remote-<key>. See types.ts.
//
// THE REBUILT TV CARD (shared by all three options, owner's words 2026-10-04): the remote is a small
// icon in the card's header (beside power). Pressing it opens the arrow dial INSIDE the now-playing panel,
// above the volume row. Back and Home sit either side of previous / play / next. Four app buttons sit
// below; the app that is on the TV is never offered: Prime Video takes its place. The old separate
// "Remote" row is gone. The three options differ in how the dial LOOKS and how it ARRIVES.
//
// HOW (practice only): `transform` rewrites the page's tile drawing (exact-text swaps, each checked so a
// page change that moves a line fails loudly instead of silently showing the old card); the option's own
// CSS/JS then style and animate it. The reveal is driven by a data-open attribute on a wrapper that is
// always drawn, so a redraw in the middle of the animation only patches the attribute and the CSS
// transition carries on (nothing is cut off by `innerHTML`).
import type { HomeVariants } from './types';

const RC = 'remote.destins_room_tv_remote';
// WHY the others are hidden: the practice window is short, and this card sits below the Samsung TV and the
// soundbar; hiding them puts the card being judged at the top of the picture.
const DATA = { startOpen: ['destins_room'], view: 'media', hidden: ['media_player.destins_room_tv', 'media_player.destins_room', 'media_player.living_room_speaker', 'media_player.roam_2', 'media_player.move_2'] };

// Exact-text swap that refuses to run silently on a page that has changed.
function rep(html: string, from: string, to: string): string {
  if (!html.includes(from)) throw new Error('tv-remote variant: page text not found: ' + from.slice(0, 60));
  return html.replace(from, () => to);
}

// WHY the pieces are plain strings with no backticks/dollar-brace: they are pasted inside the page's own script.
const HELPERS = String.raw`
  function backIcon() { return ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 16); }
  function homeIcon() { return ico('<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>', 16); }
  // The remote icon in the header, beside power. aria-expanded drives its filled look.
  function rctlHtml(rc, rOpen, it, right) {
    return '<span class="rctl"><button class="rtoggle" data-remote="' + esc(rc.id) + '" aria-expanded="' + !!rOpen + '" aria-label="' + (rOpen ? 'Hide' : 'Show') + ' remote for ' + esc(it.name) + '" title="Remote">' + REMOTE + '</button>' + right + '</span>';
  }
  // The dial. Always drawn (closed = data-open 0, inert); the reveal is a CSS change of that one attribute.
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
  h = h.replace(/function remoteHtml\(r\) \{[\s\S]*?\n  \}\n/, () => {
    return HELPERS + '\n';
  });
  if (!h.includes('function padHtml(')) throw new Error('tv-remote variant: remoteHtml not replaced');
  // 4. A TV card always has its panel (so the dial has a place), even with nothing playing.
  h = rep(h, 'var nowHtml = media && on && (playing && what || app)', 'var nowHtml = media && on && (playing && what || app || (tv && rc))');
  h = rep(h, 'esc(playing && what ? what : app.name)', "esc(playing && what ? what : app ? app.name : 'TV')");
  // 5. Back and Home either side of previous / play / next.
  h = rep(h, "ctl = rk('MEDIA_PREVIOUS', 'Previous', PREV) +", "ctl = rk('BACK', 'Back', backIcon(), ' navkey') + rk('MEDIA_PREVIOUS', 'Previous', PREV) +");
  h = rep(h, "rk('MEDIA_NEXT', 'Next', NEXT);", "rk('MEDIA_NEXT', 'Next', NEXT) + rk('HOME', 'Home', homeIcon(), ' navkey');");
  // 6. The panel's controls: dial, volume, keys, app buttons.
  h = rep(h, `(vol || ctl ? '<div class="np-ctl">' + vol + (ctl ? '<div class="np-keys">' + ctl + '</div>' : '') + '</div>' : '')`,
    `(vol || ctl ? '<div class="np-ctl">' + (tv && rc ? padHtml(rc, remoteOpen.has(rc.id)) : '') + vol + (ctl ? '<div class="np-keys">' + ctl + '</div>' : '') + (tv && rc ? rcChipsHtml(rc, app) : '') + '</div>' : '')`);
  // 7. The remote icon joins power in the header; the separate Remote card goes.
  h = rep(h, "right + '</div>' + nowHtml", "(tv && rc && on ? rctlHtml(rc, rOpen, it, right) : right) + '</div>' + nowHtml");
  const before = h;
  h = h.replace(/\n      \(rc \? '<div class="rcard'[^\n]*\+\n/, "\n      '' +\n");
  if (h === before) throw new Error('tv-remote variant: Remote row not found');
  return h;
}

// ── Shared CSS: header icon, panel layout, transport row, app buttons ───────────────────────────
const SHARED_CSS = String.raw`
.rctl { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.rtoggle { width: 36px; height: 36px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-muted); cursor: pointer; display: grid; place-items: center; padding: 0; position: relative; transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 90ms ease; }
.rtoggle:hover { color: var(--fg); border-color: var(--fg-muted); }
.rtoggle:active { transform: scale(.92); }
.rtoggle[aria-expanded="true"] { background: color-mix(in srgb, var(--accent) 22%, var(--well)); border-color: var(--accent); color: var(--accent); }
.rtoggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.np-ctl { gap: 0; padding-top: 4px; }
.np-ctl > .np-keys { margin-top: 12px; gap: 8px; }
.np-ctl .key.navkey { border-radius: 11px; color: var(--fg-muted); }
.np-ctl .key.navkey:hover { color: var(--fg); }
/* The reveal: a wrapper whose row grows from 0 to its size (one element, only on a press; justified in the deck). */
.rpad { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 340ms cubic-bezier(.2,.8,.2,1); }
.rpad[data-open="1"] { grid-template-rows: 1fr; }
.rpad-in { min-height: 0; display: flex; justify-content: center; }
.rdial button { position: absolute; appearance: none; border: 0; background: transparent; color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.rdial button:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.rdial button svg { transition: transform 90ms ease; }
/* App buttons */
.rchips-in { min-height: 0; }
.apps2 { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.app2 { padding: 4px 2px; gap: 5px; font-size: 10.5px; }
.app2 .logo { width: 40px; height: 40px; border-radius: 12px; font-size: 14px; box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 2px 6px rgba(0,0,0,.22); }
.app2:active .logo { transform: scale(.92); }
.app2 .logo { transition: transform 90ms ease; }
.apps2 > .ghost { position: absolute; pointer-events: none; margin: 0; }
@media (max-width: 400px) { .rdial { transform-origin: 50% 0; } }
@media (prefers-reduced-motion: reduce) {
  .rpad, .rtoggle, .rdial, .rdial button svg, .app2 .logo, .rchips, .apps2 { transition: none !important; animation: none !important; }
}
`;

// ── Shared script: chip swap animation + the vector the dial grows from ────────────────────────────
// WHY it compares the buttons after each redraw: the TV tells the page which app is on, whenever it likes;
// the page then redraws. Remembering the buttons from the previous draw lets the outgoing one be drawn once
// more as a "ghost" that fades away while the new one arrives. Nothing here lives on the redrawn elements.
const SHARED_JS = String.raw`
(function () {
  var OPT = window.__rcOpt || 'a', prev = {};
  var EASE = 'cubic-bezier(.2,.8,.2,1)', SPRING = 'cubic-bezier(.34,1.4,.64,1)';
  var SW = {
    a: { out: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.5)', opacity: 0 }], outT: { duration: 200, easing: 'ease-in' }, inn: [{ transform: 'translateY(-18px) scale(.75)', opacity: 0 }, { transform: 'none', opacity: 1 }], inT: { duration: 380, delay: 120, easing: SPRING, fill: 'backwards' } },
    b: { out: [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-18px)', opacity: 0 }], outT: { duration: 220, easing: 'ease-in' }, inn: [{ transform: 'translateX(18px)', opacity: 0 }, { transform: 'none', opacity: 1 }], inT: { duration: 320, delay: 110, easing: EASE, fill: 'backwards' } },
    c: { out: [{ transform: 'translateY(0) scale(1)', opacity: 1 }, { transform: 'translateY(-12px) scale(1.15)', opacity: 0 }], outT: { duration: 240, easing: 'ease-in' }, inn: [{ transform: 'translateY(14px) scale(.85)', opacity: 0 }, { transform: 'none', opacity: 1 }], inT: { duration: 340, delay: 140, easing: EASE, fill: 'backwards' } }
  }[OPT];
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
        var a = el.animate(SW.out, SW.outT); a.onfinish = a.oncancel = function () { if (el.parentNode) el.parentNode.removeChild(el); };
      });
      Array.prototype.forEach.call(box.children, function (el) { if (wn.indexOf(el.getAttribute('data-name')) < 0 && !el.classList.contains('ghost')) el.animate(SW.inn, SW.inT); });
    });
  }
  window.__homeAfterPut = function () { scan(); };
  // The dial grows out of the remote icon: tell the wrapper where the icon is, relative to the dial's centre.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.rtoggle'); if (!b) return;
    document.documentElement.classList.add('rc-used'); // WHY: the light sweep plays only after a press, never on first paint
    var pad = b.closest('.tile') && b.closest('.tile').querySelector('.rpad'), dial = pad && pad.querySelector('.rdial'); if (!dial) return;
    var br = b.getBoundingClientRect(), pr = pad.getBoundingClientRect();
    pad.style.setProperty('--rx', Math.round(br.left + br.width / 2 - (pr.left + pr.width / 2)) + 'px');
    pad.style.setProperty('--ry', Math.round(br.top + br.height / 2 - (pr.top + dial.offsetHeight / 2)) + 'px');
  }, true);
  setTimeout(scan, 300);
})();
`;

// ── Option A: Machined dial. Brushed metal, engraved arrows; the dial grows out of the remote icon. ──
const A_CSS = String.raw`
.rpad-in { overflow: visible; }
.rdial { position: relative; width: 176px; height: 176px; margin: 10px 0 16px; border-radius: 50%; flex-shrink: 0;
  --m1: color-mix(in srgb, var(--fg) 10%, var(--well)); --m2: color-mix(in srgb, var(--fg) 24%, var(--well));
  background: repeating-radial-gradient(circle at 50% 50%, transparent 0 2px, rgba(255,255,255,.04) 2px 3px),
    conic-gradient(from 25deg, var(--m1), var(--m2), var(--m1) 18%, var(--m2) 36%, var(--m1) 52%, var(--m2) 70%, var(--m1) 86%, var(--m2));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.25), inset 0 -2px 4px rgba(0,0,0,.28), 0 10px 20px -8px rgba(0,0,0,.5), 0 0 0 1px color-mix(in srgb, var(--fg) 22%, transparent);
  transition: transform 420ms cubic-bezier(.34,1.3,.64,1), opacity 220ms ease, visibility 0s linear 0s; }
.rpad[data-open="0"] .rdial { transform: translate(var(--rx, 96px), var(--ry, -120px)) scale(.12); opacity: 0; visibility: hidden; transition: transform 300ms cubic-bezier(.5,0,.75,0), opacity 200ms ease 100ms, visibility 0s linear 320ms; }
.rdial::before { content: ''; position: absolute; inset: 15px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--well) 78%, #000), color-mix(in srgb, var(--well) 94%, #000));
  box-shadow: inset 0 3px 9px rgba(0,0,0,.55), 0 1px 0 rgba(255,255,255,.22); }
.rdial button { z-index: 1; border-radius: 50%; width: 54px; height: 54px; }
.rdial button svg { filter: drop-shadow(0 1px 0 rgba(255,255,255,.2)); }
.rdial .up { top: 17px; left: 61px; } .rdial .down { bottom: 17px; left: 61px; }
.rdial .left { left: 17px; top: 61px; } .rdial .right { right: 17px; top: 61px; }
.rdial .ok { left: 56px; top: 56px; width: 64px; height: 64px; font: 800 14px/1 inherit; letter-spacing: .04em; color: var(--fg);
  background: radial-gradient(circle at 36% 28%, color-mix(in srgb, var(--fg) 22%, var(--well)), color-mix(in srgb, var(--fg) 8%, var(--well)) 70%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -3px 5px rgba(0,0,0,.3), 0 4px 8px -2px rgba(0,0,0,.5); text-shadow: 0 1px 0 rgba(255,255,255,.25); transition: transform 90ms ease, box-shadow 90ms ease; }
.rdial .ok:active { transform: scale(.95); box-shadow: inset 0 3px 7px rgba(0,0,0,.5), 0 1px 1px rgba(0,0,0,.4); }
.rdial button:hover:not(.ok) { color: var(--fg); background: radial-gradient(circle, color-mix(in srgb, var(--fg) 12%, transparent), transparent 70%); }
.rdial button:active:not(.ok) { color: var(--accent); background: radial-gradient(circle, color-mix(in srgb, var(--accent) 40%, transparent), transparent 70%); }
.rdial button:active:not(.ok) svg { transform: translateY(1px) scale(.88); }
.apps2 { padding: 6px; border-radius: 16px; background: var(--well); box-shadow: inset 0 2px 5px rgba(0,0,0,.25); }
`;

// ── Option B: Glass jog wheel. Soft glass ring; the pressed direction lights up; the panel extends. ──
const B_CSS = String.raw`
.rpad-in { overflow: hidden; }
.rdial { position: relative; width: 188px; height: 188px; margin: 8px 0 14px; border-radius: 50%; flex-shrink: 0;
  background: radial-gradient(circle at 50% 18%, rgba(255,255,255,.2), transparent 55%), color-mix(in srgb, var(--fg) 6%, var(--well));
  box-shadow: inset 0 1px 1px rgba(255,255,255,.3), inset 0 -10px 24px -10px rgba(0,0,0,.35), 0 0 0 1px color-mix(in srgb, var(--fg) 14%, transparent);
  opacity: 1; transform: none; transition: opacity 260ms ease 80ms, transform 360ms cubic-bezier(.2,.8,.2,1) 40ms, visibility 0s linear 0s; }
.rpad[data-open="0"] .rdial { opacity: 0; transform: scale(.9); visibility: hidden; transition: opacity 160ms ease, transform 240ms ease, visibility 0s linear 340ms; }
/* the groove the light runs in */
.rdial::before { content: ''; position: absolute; inset: 9px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle closest-side at 50% 50%, transparent 0 72%, color-mix(in srgb, var(--fg) 7%, transparent) 72% 97%, transparent 98%);
  box-shadow: inset 0 2px 4px rgba(0,0,0,.18); }
/* one sweep of light round the groove when it opens */
.rdial::after { content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none; opacity: 0;
  background: conic-gradient(from 0deg, transparent 0 70%, color-mix(in srgb, var(--accent) 80%, transparent) 100%);
  -webkit-mask: radial-gradient(circle closest-side, transparent 0 74%, #000 76% 94%, transparent 96%); mask: radial-gradient(circle closest-side, transparent 0 74%, #000 76% 94%, transparent 96%); }
.rc-used .rpad[data-open="1"] .rdial::after { animation: rsweep 900ms cubic-bezier(.3,.6,.3,1) 120ms 1 both; }
@keyframes rsweep { 0% { transform: rotate(-120deg); opacity: 0; } 25% { opacity: 1; } 100% { transform: rotate(240deg); opacity: 0; } }
.rdial button { z-index: 1; inset: 0; width: 100%; height: 100%; border-radius: 50%; color: var(--fg-2); }
.rdial .up { clip-path: polygon(50% 50%, 0 0, 100% 0); place-items: start center; padding-top: 14px; }
.rdial .right { clip-path: polygon(50% 50%, 100% 0, 100% 100%); place-items: center end; padding-right: 14px; }
.rdial .down { clip-path: polygon(50% 50%, 100% 100%, 0 100%); place-items: end center; padding-bottom: 14px; }
.rdial .left { clip-path: polygon(50% 50%, 0 100%, 0 0); place-items: center start; padding-left: 14px; }
/* the pressed-in light: a lit band in that quarter only */
.rdial button:not(.ok)::after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 160ms ease;
  background: radial-gradient(circle closest-side at 50% 50%, transparent 0 66%, color-mix(in srgb, var(--accent) 55%, transparent) 76%, var(--accent) 84%, color-mix(in srgb, var(--accent) 45%, transparent) 92%, transparent 98%),
    radial-gradient(circle closest-side at 50% 50%, transparent 0 40%, color-mix(in srgb, var(--accent) 22%, transparent) 70%, transparent 90%); }
.rdial button:hover:not(.ok)::after { opacity: .3; }
.rdial button:active:not(.ok)::after { opacity: 1; transition-duration: 40ms; }
.rdial button:active:not(.ok) { color: var(--accent); }
.rdial button:active:not(.ok) svg { transform: scale(.88); }
.rdial .ok { inset: auto; left: 62px; top: 62px; width: 64px; height: 64px; font: 700 14px/1 inherit; letter-spacing: .05em; color: var(--fg); z-index: 2;
  background: radial-gradient(circle at 38% 26%, rgba(255,255,255,.35), transparent 60%), color-mix(in srgb, var(--fg) 9%, var(--well));
  box-shadow: inset 0 1px 1px rgba(255,255,255,.4), inset 0 -4px 8px -3px rgba(0,0,0,.3), 0 0 0 1px color-mix(in srgb, var(--fg) 16%, transparent), 0 6px 12px -4px rgba(0,0,0,.4); transition: transform 90ms ease, box-shadow 90ms ease, color 90ms ease; }
.rdial .ok:hover { color: var(--accent); }
.rdial .ok:active { transform: scale(.95); color: var(--accent); box-shadow: inset 0 3px 8px rgba(0,0,0,.35), 0 0 0 2px color-mix(in srgb, var(--accent) 70%, transparent), 0 0 14px color-mix(in srgb, var(--accent) 45%, transparent); }
.apps2 { padding: 2px 0 0; }
`;

// ── Option C: Floating ring. A thin outline with a ripple on every press; the dial unfolds; apps wait until open. ──
const C_CSS = String.raw`
.rpad-in { overflow: hidden; }
.rdial { position: relative; width: 172px; height: 172px; margin: 8px 0 14px; border-radius: 50%; flex-shrink: 0;
  border: 1.5px solid color-mix(in srgb, var(--fg) 24%, transparent);
  transform-origin: 50% 0; opacity: 1; transform: none; transition: transform 420ms cubic-bezier(.2,.8,.2,1), opacity 240ms ease, visibility 0s linear 0s; }
.rpad[data-open="0"] .rdial { transform: perspective(520px) rotateX(-88deg); opacity: 0; visibility: hidden; transition: transform 300ms ease-in, opacity 200ms ease 60ms, visibility 0s linear 340ms; }
.rdial::before { content: ''; position: absolute; left: 50%; top: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--fg) 24%, transparent); pointer-events: none; }
.rdial button { border-radius: 50%; width: 50px; height: 50px; color: var(--fg-muted); overflow: visible; transition: color 120ms ease; }
.rdial button:hover { color: var(--fg); }
.rdial button:active { color: var(--accent); }
.rdial button:active svg { transform: scale(.82); }
.rdial .up { top: 8px; left: 59px; } .rdial .down { bottom: 8px; left: 59px; }
.rdial .left { left: 8px; top: 59px; } .rdial .right { right: 8px; top: 59px; }
.rdial .ok { left: 56px; top: 56px; width: 60px; height: 60px; font: 700 13px/1 inherit; letter-spacing: .06em; color: var(--fg-2); }
.rdial .ok:active { transform: scale(.94); }
.rdial .rip { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; border: 1.5px solid var(--accent); pointer-events: none; }
/* apps wait until the remote is open, and arrive after the dial */
.rchips { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 340ms cubic-bezier(.2,.8,.2,1); }
.rchips-in { overflow: hidden; }
.np-ctl:has(.rpad[data-open="1"]) .rchips { grid-template-rows: 1fr; }
.apps2 { padding-top: 10px; opacity: 0; transform: translateY(8px); transition: opacity 200ms ease, transform 200ms ease; }
.np-ctl:has(.rpad[data-open="1"]) .apps2 { opacity: 1; transform: none; transition: opacity 260ms ease 140ms, transform 300ms cubic-bezier(.2,.8,.2,1) 140ms; }
`;

// Ripple on every press (practice script for option C): two rings, the second a beat behind.
const C_JS = String.raw`
document.addEventListener('pointerdown', function (e) {
  var b = e.target.closest && e.target.closest('.rdial button');
  if (!b || typeof b.animate !== 'function' || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  [0, 110].forEach(function (d, i) {
    var s = document.createElement('span'); s.className = 'rip'; b.appendChild(s);
    var a = s.animate([{ transform: 'scale(.6)', opacity: i ? .35 : .7 }, { transform: 'scale(' + (i ? 4.6 : 3.6) + ')', opacity: 0 }], { duration: 560, delay: d, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });
    a.onfinish = a.oncancel = function () { if (s.parentNode) s.parentNode.removeChild(s); };
  });
}, true);
`;

const open = { ...DATA, remote: [RC] };
const mk = (id: string, label: string, css: string, extraJs = '') => ({
  label, transform, css: SHARED_CSS + css,
  js: "window.__rcOpt = '" + id + "';" + SHARED_JS + extraJs,
});

export const VARIANTS: HomeVariants = {
  a: { ...mk('a', 'Machined dial', A_CSS), data: DATA },
  'a-open': { ...mk('a', 'Machined dial, remote open', A_CSS), data: open },
  b: { ...mk('b', 'Glass jog wheel', B_CSS), data: DATA },
  'b-open': { ...mk('b', 'Glass jog wheel, remote open', B_CSS), data: open },
  c: { ...mk('c', 'Floating ring', C_CSS, C_JS), data: DATA },
  'c-open': { ...mk('c', 'Floating ring, remote open', C_CSS, C_JS), data: open },
};
