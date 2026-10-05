// The Home page's BACKGROUND choice (Destin, 2026-10-05, round 3 "PB-1": he asked to see real versions of options b and c on his own
// house). Gear > Page settings > "Background": Plain (today, the default) / Frosted / House colours. Saved in the page's own data as
// prefs.bg ('plain' | 'frosted' | 'house'; anything else counts as plain).
//   Plain         adds nothing at all: no attribute on the page, none of the rules below match, so it is pixel-identical to before.
//   Frosted       a soft glow of the theme's own colours behind the page, with the room cards a little see-through.
//   House colours the same glow, tinted by up to three lights that are on and the app that is playing.
// WHY NO backdrop-filter anywhere: the app allows one blur only and never one per card (react-renderer.md, performance.md). The
// "frost" is faked: radial gradients are soft by nature (drawn once, one fixed layer), and the cards get a translucent fill plus a
// bright top edge. WHY the rules use :where(): it makes them lose to every existing rule on specificity (so a lit light's glowing
// edge, an open tab's accent fill etc. still win) while still coming later in the sheet than the base rule they replace.
// Motion (Frosted only): a very slow drift of the one fixed layer, transform only, 40 coarse steps over two minutes, off under
// reduced motion and paused while the page is hidden (the page already sets data-hid on the root then).
// HOUSE TINT is worked out from the page's DATA (so it is the same on every tab), only after the lists are redrawn, and written
// to the page root only when the colours actually changed.
// HOME_BG_JS is pasted INSIDE the page's script. Template string: no backticks, no dollar-brace, backslashes doubled.

export const HOME_BG_CSS = `
  .bgopts { display: grid; gap: 8px; }
  .bgopt { appearance: none; font: inherit; text-align: left; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; cursor: pointer; color: var(--fg);
    background: var(--well); border: 1px solid var(--edge-dim); transition: border-color 120ms ease, transform 90ms ease; }
  .bgopt:hover { border-color: var(--fg-muted); } .bgopt:active { transform: scale(.98); }
  .bgopt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .bgopt[aria-checked="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--well)); }
  .bgopt .sw { width: 44px; height: 32px; border-radius: 9px; flex-shrink: 0; border: 1px solid var(--edge-dim); background: var(--canvas); }
  .bgopt[data-bg="frosted"] .sw { background: radial-gradient(70% 90% at 15% 20%, color-mix(in srgb, var(--accent) 55%, transparent), transparent 75%), radial-gradient(70% 90% at 90% 90%, color-mix(in srgb, var(--fg-2) 40%, transparent), transparent 75%), var(--canvas); }
  .bgopt[data-bg="house"] .sw { background: radial-gradient(60% 90% at 12% 20%, #ffb36b, transparent 75%), radial-gradient(60% 90% at 88% 20%, #6b9bff, transparent 75%), radial-gradient(60% 90% at 50% 100%, #ff6bb0, transparent 75%), var(--canvas); }
  .bgopt b { display: block; font-size: 13px; font-weight: 600; } .bgopt i { display: block; font-style: normal; font-size: 12px; color: var(--fg-muted); }

  /* ── Frosted and House colours (never reached while the background is Plain) ── */
  :where(:root[data-bg]) body::before { content: ''; position: fixed; inset: -12%; z-index: -1; pointer-events: none; }
  :where(:root[data-bg="frosted"]) { --gl: 72; --h1: var(--accent); --h2: var(--accent); --h3: var(--fg-2); --h4: var(--link, var(--fg-2)); }
  :where(:root[data-bg="house"]) { --gl: 74; --h1: var(--accent); --h2: var(--accent); --h3: var(--fg-2); --h4: var(--accent); }
  :where(:root[data-bg]) body::before { background:
    radial-gradient(40% 36% at 12% 10%, color-mix(in srgb, var(--h1) 44%, transparent), transparent 70%),
    radial-gradient(36% 38% at 88% 20%, color-mix(in srgb, var(--h4) 40%, transparent), transparent 70%),
    radial-gradient(42% 38% at 62% 92%, color-mix(in srgb, var(--h2) 36%, transparent), transparent 70%),
    radial-gradient(32% 34% at 6% 78%, color-mix(in srgb, var(--h3) 28%, transparent), transparent 70%); }
  /* Cards become see-through glass: the theme's panel colour at --gl percent (readable in dark and light themes), a lighter top edge. */
  :where(:root[data-bg]) .yc-card.room, :where(:root[data-bg]) .yc-card.set-sec { border-color: color-mix(in srgb, var(--fg) 16%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 9%, transparent), transparent 55%), color-mix(in srgb, var(--panel) calc(var(--gl, 72) * 1%), transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 22%, transparent), 0 14px 30px -18px rgba(0,0,0,.45); }
  :where(:root[data-bg]) .tile, :where(:root[data-bg]) .thing, :where(:root[data-bg]) .np, :where(:root[data-bg]) .ev, :where(:root[data-bg]) .chip, :where(:root[data-bg]) .tile2, :where(:root[data-bg]) .prob {
    background: color-mix(in srgb, var(--fg) 6%, transparent); border-color: color-mix(in srgb, var(--fg) 14%, transparent); }
  :where(:root[data-bg]) .lights-body > .tile { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  :where(:root[data-bg]) .pill { background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 12%, transparent), color-mix(in srgb, var(--fg) 4%, transparent)), color-mix(in srgb, var(--panel) 55%, transparent);
    border-color: color-mix(in srgb, var(--fg) 20%, transparent); }
  :where(:root[data-bg]) .pill.sel, :where(:root[data-bg]) .pill.lit.sel { background: var(--accent); border-color: var(--accent); }
  @media (prefers-reduced-motion: no-preference) { :root[data-bg="frosted"] body::before { animation: bgdrift 120s steps(40) infinite alternate; } }
  :root[data-bg][data-hid] body::before { animation-play-state: paused; }
  @keyframes bgdrift { from { transform: translate3d(-3%, 2%, 0); } to { transform: translate3d(3%, -2%, 0); } }
`;

export const HOME_BG_JS = `
  // ── Background choice (see home-assistant-page-bg.ts) ───────────────────────
  var BG_OPTS = [
    ['plain', 'Plain', 'The flat colour, as it has always been.'],
    ['frosted', 'Frosted', 'A soft, slowly drifting glow of the theme colours.'],
    ['house', 'House colours', 'The same glow, tinted by the lights that are on and the app that is playing.'],
  ];
  var bgLast = '';
  function bgNow() { var v = prefs.bg; return v === 'frosted' || v === 'house' ? v : 'plain'; }
  // The settings card (called from settingsPageHtml).
  function bgSectionHtml() {
    var cur = bgNow();
    return '<section class="yc-card set-sec"><h3>Background</h3><p class="yc-caption">What shows behind the rooms.</p><div class="bgopts" role="radiogroup" aria-label="Background">' +
      BG_OPTS.map(function (o) {
        return '<button class="bgopt" role="radio" aria-checked="' + (cur === o[0]) + '" data-bg="' + o[0] + '"><span class="sw"></span><span><b>' + o[1] + '</b><i>' + o[2] + '</i></span></button>';
      }).join('') + '</div></section>';
  }
  // A colour (#rrggbb) bright enough to tint with; near-black app colours (Netflix) would only muddy the glow.
  function bgHex(bg) {
    var m = String(bg || '').match(/#[0-9a-fA-F]{6}/g);
    if (!m) return '';
    var h = m[m.length - 1], n = parseInt(h.slice(1), 16);
    return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) < 150 ? '' : h;
  }
  // The colours of up to three different lights that are on, and the first playing app.
  function bgTint() {
    var L = [], seen = {}, app = '';
    (rooms || []).forEach(function (r) {
      r.items.forEach(function (it) {
        if (isLight(it) && !gone(it) && !hidden.has(it.id) && isOn(it) && L.length < 3) { var c = colourOf(it); if (!seen[c]) { seen[c] = 1; L.push(c); } }
        if (!app && it.state === 'playing' && !gone(it)) {
          var a = isTv(it) ? appOf((remoteFor(it, r) || {}).activity) : sourceOf(it);
          app = a ? bgHex(a.bg) : '';
        }
      });
    });
    return { lights: L, app: app };
  }
  // Called by put() after every drawing. Plain returns at once; House recomputes after the lists are drawn, and writes only on a change.
  function bgAfter(id) {
    var m = bgNow(), root = document.documentElement, was = root.getAttribute('data-bg') || 'plain';
    if (was !== m) {
      if (m === 'plain') { root.removeAttribute('data-bg'); ['--h1', '--h2', '--h3', '--h4'].forEach(function (p) { root.style.removeProperty(p); }); } else root.setAttribute('data-bg', m);
      bgLast = '';
    }
    if (m !== 'house' || (id !== 'rooms' && id !== 'favs' && id !== 'view')) return;
    var t = bgTint(), key = t.lights.join('|') + '~' + t.app;
    if (key === bgLast) return;
    bgLast = key;
    var L = t.lights;
    // fewer than three lights on: the missing glows fall back to the theme's own colours
    root.style.setProperty('--h1', L[0] || 'var(--accent)');
    root.style.setProperty('--h2', L[1] || L[0] || 'var(--accent)');
    root.style.setProperty('--h3', L[2] || 'var(--fg-2)');
    root.style.setProperty('--h4', t.app || L[0] || 'var(--accent)');
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-bg].bgopt') : null;
    if (!b) return;
    prefs.bg = b.getAttribute('data-bg');
    persist({ prefs: prefs });
    render();
  });
`;
