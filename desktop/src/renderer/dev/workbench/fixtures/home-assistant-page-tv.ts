// When a TV's app really reports playing and paused (Destin approved "option A", 2026-10-05).
// Some apps on a Google TV (Netflix, say) tell Home Assistant "playing" and nothing else: no title,
// and a state that never changes when you press play/pause. Claiming "Now playing" with a moving
// equaliser, or "Paused", for those is a guess shown as fact. THE RULE: a TV's playing/paused is
// trusted only if the app gives a media title, OR this page has SEEN the house report both
// "playing" and "paused" for that TV in this session (a state that really changes with presses).
// Otherwise the card shows the app's name with its mark, no label, no equaliser, and one neutral
// play/pause button that claims no state. Pressing it never changes what the card says by itself:
// only a report from the house (a push or a check) counts, never the page's own guess.
//
// THE REMOTE (Destin, 2026-10-05, round 2b "option A", built for real here):
//  - The remote is an icon button in the TV card's header beside power, shown only while the TV is on. Pressing it opens
//    a round glass arrow pad INSIDE the now-playing panel, above the volume row. The panel stretches down, the volume
//    slides lower and the pad fades in. No spinning, no sweeping.
//  - The transport row is always drawn, seven buttons in five slots. Closed: previous, -10s, play/pause, +10s, next.
//    Open: Back, previous, play/pause, next, Home. Play never moves; the others fade and slide.
//  - App buttons appear only while the remote is open: four of YouTube / Netflix / HBO Max / Disney+, with whichever
//    one is on the TV swapped (in place, animated) for Prime Video.
// WHY everything animated is ALWAYS drawn and driven by one data-open attribute: a redraw in the middle of an
// animation (a push from the TV, the 5-second check) then only patches that attribute (home-assistant-page-redraw.ts
// keeps the elements), so the CSS transition carries on and nothing is cut off or flickers.
// HOME_TV_JS is pasted INSIDE the page's script. Template string: no backticks, no dollar-brace, no backslashes.

export const HOME_TV_JS = `
  // ── Does this TV's app really report play and pause? ─────────────────────
  var playSeen = {};
  var PLAYPAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 5v14l9-7z"/><rect x="14" y="5" width="3.5" height="14" rx="1"/><rect x="19.5" y="5" width="3" height="14" rx="1"/></svg>';
  // Called with the house's own word about a device (never the page's guess).
  function noteReport(it) {
    if (it.state !== 'playing' && it.state !== 'paused') return;
    var s = playSeen[it.id] || (playSeen[it.id] = {});
    s[it.state] = true;
  }
  function noteReports() { (rooms || []).forEach(function (r) { r.items.forEach(noteReport); }); }
  function playReported(it) { var s = playSeen[it.id]; return !!(s && s.playing && s.paused); }

  // ── The TV card's remote (see the top of this file) ───────────────────────
  var BACK_ICON = ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 16);
  var HOME_ICON = ico('<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>', 16);
  // Jump back / forward 10 seconds: a circular arrow with a small "10" inside.
  function seekIcon(fwd) {
    var arc = fwd ? '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>' : '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>';
    return ico(arc + '<text x="12" y="15.6" text-anchor="middle" font-size="8.5" font-weight="700" stroke="none" fill="currentColor" font-family="inherit">10</text>', 18);
  }
  // HOW the -10s / +10s buttons work for this TV (Destin, 2026-10-05: only where they really can).
  //  'seek' = the media player can seek AND reports where it is (media_position + when that was true): press media_seek to
  //           that position plus or minus 10.
  //  'keys' = the TV has a paired remote: press the TV's own rewind / fast-forward keys through it.
  //  ''     = neither: the buttons are not drawn.
  // WHY the position must be reported too: a seek is "go to second N"; without knowing where it is now there is no N.
  function seekHow(it, rc) {
    if (((it.features || 0) & 2) && it.pos != null && it.posAt && !isNaN(Date.parse(it.posAt))) return 'seek';
    return rc ? 'keys' : '';
  }
  // The transport row. Seven buttons, always present, so opening the remote only changes data-open (the CSS does the rest).
  function tvKeysHtml(it, rc, neutral, isPlay) {
    var how = seekHow(it, rc), id = esc(rc.id);
    var rk = function (cmd, label, icon, cls) { return '<button class="key ' + cls + '" data-rc="' + id + '" data-cmd="' + cmd + '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>'; };
    var ten = function (dir, cmd, label, icon, cls) {
      if (how === 'keys') return rk(cmd, label, icon, cls);
      return '<button class="key ' + cls + '" data-seek="' + esc(it.id) + '" data-dir="' + dir + '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>';
    };
    var open = remoteOpen.has(rc.id) ? 1 : 0;
    return '<div class="np-keys" data-slot="keys" data-open="' + open + '" data-ten="' + (how ? 1 : 0) + '">' +
      rk('BACK', 'Back', BACK_ICON, 's-back') + rk('MEDIA_PREVIOUS', 'Previous', PREV, 's-prev') +
      (how ? ten(-10, 'MEDIA_REWIND', 'Back 10 seconds', seekIcon(0), 's-sb') : '') +
      rk('MEDIA_PLAY_PAUSE', 'Play or pause', neutral ? PLAYPAUSE : isPlay ? PAUSE : PLAY, 'main') +
      (how ? ten(10, 'MEDIA_FAST_FORWARD', 'Forward 10 seconds', seekIcon(1), 's-sf') : '') +
      rk('MEDIA_NEXT', 'Next', NEXT, 's-next') + rk('HOME', 'Home', HOME_ICON, 's-home') + '</div>';
  }
  // The remote icon in the header, beside power (only while the TV is on). aria-expanded drives its filled look.
  function tvToggleHtml(rc, it, right) {
    var o = remoteOpen.has(rc.id);
    return '<span class="rctl"><button class="pwr rtoggle" data-remote="' + esc(rc.id) + '" aria-expanded="' + o + '" aria-label="' + (o ? 'Hide' : 'Show') + ' remote for ' + esc(it.name) + '" title="Remote">' + REMOTE + '</button>' + right + '</span>';
  }
  // The round glass arrow pad. Arrows are the page's own chevron icons (same stroke as every other icon here), so they take the
  // theme's colours: quiet at rest, accent on hover and press.
  function tvPadHtml(r, open) {
    var id = esc(r.id);
    var k = function (cmd, label, inner, cls) { return '<button class="pk ' + cls + '" data-rc="' + id + '" data-cmd="' + cmd + '" aria-label="' + label + '" title="' + label + '"><span class="ch">' + inner + '</span></button>'; };
    return '<div class="rpad" data-slot="pad" data-open="' + (open ? 1 : 0) + '"' + (open ? '' : ' inert aria-hidden="true"') + '><div class="rpad-in"><div class="rdial" role="group" aria-label="Arrows for ' + esc(r.name) + '">' +
      k('DPAD_UP', 'Up', ico('<path d="m18 15-6-6-6 6"/>', 22), 'up') + k('DPAD_LEFT', 'Left', ico('<path d="m15 18-6-6 6-6"/>', 22), 'left') +
      k('DPAD_RIGHT', 'Right', ico('<path d="m9 18 6-6-6-6"/>', 22), 'right') + k('DPAD_DOWN', 'Down', ico('<path d="m6 9 6 6 6-6"/>', 22), 'down') +
      '<button class="pk ok" data-rc="' + id + '" data-cmd="DPAD_CENTER" aria-label="OK" title="OK">OK</button></div></div></div>';
  }
  // Four app buttons from this order; whichever is on the TV right now is replaced, in the same place, by Prime Video.
  // Drawn always (hidden by CSS until the remote opens) for the same reason as the pad.
  var RC_ORDER = ['YouTube', 'Netflix', 'HBO Max', 'Disney+'];
  function tvChipsHtml(r, active) {
    var id = esc(r.id);
    var list = RC_ORDER.map(function (n) { return active && active.name === n ? 'Prime Video' : n; });
    return '<div class="rchips" data-slot="chips"><div class="rchips-in"><div class="rapps">' + list.map(function (n) {
      var a = APPS.filter(function (x) { return x.name === n; })[0];
      return '<button class="app rapp" data-rc="' + id + '" data-app="' + esc(a.url) + '" data-name="' + esc(a.name) + '" aria-label="Open ' + esc(a.name) + '"><span class="logo" style="--app:' + a.bg + '">' + a.mark + '</span><span class="nm">' + esc(a.name) + '</span></button>';
    }).join('') + '</div></div></div>';
  }
  // A press on a TV key or app button: straight to the TV, no redraw, no re-check, so pressing Down five times is five quick presses.
  function tvPress(t, rcId) {
    var cmd = t.getAttribute('data-cmd'), app = t.getAttribute('data-app');
    (cmd ? call('/api/services/remote/send_command', { entity_id: rcId, command: cmd })
      : call('/api/services/remote/turn_on', { entity_id: rcId, activity: app }))
      .catch(function (e) { banner(e && e.message ? e.message : 'The TV did not get that.', true); });
  }
  // -10s / +10s on a TV that can seek: "go to" the position it is at now, plus or minus 10.
  // WHY the position is worked out from when it was reported: Home Assistant gives the position as of a moment, not live.
  // WHY the new place is remembered at once: two quick presses must add up to 20 seconds, not both start from the old place.
  function tvSeek(t) {
    var id = t.getAttribute('data-seek'), it = thing(id), d = Number(t.getAttribute('data-dir'));
    if (!it || it.pos == null || !it.posAt) return;
    var at = Date.parse(it.posAt), since = it.state === 'playing' && at ? (Date.now() - at) / 1000 : 0;
    var to = Math.max(0, Math.round((it.pos + since + d) * 10) / 10);
    it.pos = to; it.posAt = new Date().toISOString();
    call('/api/services/media_player/media_seek', { entity_id: id, seek_position: to })
      .catch(function (e) { banner(e && e.message ? e.message : 'The TV did not get that.', true); });
  }
  // The app buttons: the one that left slides out and fades while the new one slides in. WHY it compares after each drawing: the
  // TV tells the page which app is on whenever it likes; remembering the buttons from the previous drawing lets the one that
  // left be drawn once more as a throw-away copy that fades away. Nothing here lives on the elements the page redraws.
  var tvSeen = {};
  function tvSnap(box) {
    var br = box.getBoundingClientRect();
    return Array.prototype.map.call(box.children, function (c) { var r = c.getBoundingClientRect(); return { n: c.getAttribute('data-name'), x: r.left - br.left, y: r.top - br.top, w: r.width, html: c.outerHTML }; });
  }
  function tvAfter(id) {
    if (id !== 'rooms' && id !== 'favs' && id !== 'view') return;
    var seen = {};
    Array.prototype.forEach.call(document.querySelectorAll('#' + id + ' .rapps'), function (box) {
      var card = box.closest('[data-eid]'), key = id + ':' + (card ? card.getAttribute('data-eid') : '');
      var cur = tvSnap(box), was = tvSeen[key];
      seen[key] = cur;
      if (!was || !fxCan()) return;
      var wn = was.map(function (c) { return c.n; }), cn = cur.map(function (c) { return c.n; });
      if (wn.join('|') === cn.join('|')) return;
      was.forEach(function (c) {
        if (cn.indexOf(c.n) >= 0) return;
        var g = document.createElement('div'); g.innerHTML = c.html; var el = g.firstChild;
        el.classList.add('ghost'); el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true');
        el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; el.style.width = c.w + 'px';
        box.appendChild(el);
        var a = el.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-18px)', opacity: 0 }], { duration: 220, easing: 'ease-in' });
        a.onfinish = a.oncancel = function () { if (el.parentNode) el.parentNode.removeChild(el); };
      });
      Array.prototype.forEach.call(box.children, function (el) {
        if (wn.indexOf(el.getAttribute('data-name')) < 0 && !el.classList.contains('ghost')) el.animate([{ transform: 'translateX(18px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, delay: 110, easing: FX_EASE, fill: 'backwards' });
      });
    });
    // Only this area's boxes were measured; the other areas keep what they had.
    Object.keys(tvSeen).forEach(function (k) { if (k.indexOf(id + ':') === 0) delete tvSeen[k]; });
    Object.keys(seen).forEach(function (k) { tvSeen[k] = seen[k]; });
  }
`;

export const HOME_TV_CSS = `
  /* The remote icon in the header, beside power. Filled with the accent while the remote is open. */
  .rctl { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .pwr.rtoggle[aria-expanded="true"] { background: color-mix(in srgb, var(--accent) 22%, var(--well)); border-color: var(--accent); color: var(--accent); }
  .np-ctl.tv { gap: 0; padding-top: 4px; }

  /* The transport row: five equal slots. Closed: previous, -10s, play, +10s, next. Open: back, previous, play, next, home.
     Play never moves; previous and next slide one slot inward while -10s/+10s fade out and Back/Home fade in.
     WHY individual transform properties (translate / scale) here: the page's own press feel is a transform: scale() on :active, so
     a slide that also used transform would snap when a sliding button is pressed. */
  .np-keys[data-open] { --k: 44px; --g: 8px; --s: calc(var(--k) + var(--g)); display: grid; grid-template-columns: repeat(5, var(--k)); justify-content: center; gap: var(--g); }
  .np-ctl.tv > .np-keys { margin-top: 12px; }
  .np-keys[data-open] > .key { grid-row: 1; width: var(--k); height: var(--k); justify-self: center; align-self: center; transition: translate 320ms cubic-bezier(.2,.8,.2,1), scale 320ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease, background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 90ms ease, visibility 0s linear 0s; }
  .np-keys > .s-back, .np-keys > .s-prev { grid-column: 1; } .np-keys > .s-sb { grid-column: 2; }
  .np-keys > .main { grid-column: 3; }
  .np-keys > .s-sf { grid-column: 4; } .np-keys > .s-next, .np-keys > .s-home { grid-column: 5; }
  .np-keys[data-ten="0"] > .s-prev { grid-column: 2; } .np-keys[data-ten="0"] > .s-next { grid-column: 4; }
  .np-keys[data-open] > .key.main { width: calc(var(--k) + 4px); height: calc(var(--k) + 4px); }
  .np-keys .s-sb, .np-keys .s-sf { color: var(--fg-2); }
  .np-keys[data-open="0"] > .s-back, .np-keys[data-open="0"] > .s-home { opacity: 0; scale: .6; visibility: hidden; pointer-events: none; transition: opacity 160ms ease, scale 200ms ease, visibility 0s linear 220ms; }
  .np-keys[data-open="1"][data-ten="1"] > .s-prev { translate: var(--s) 0; }
  .np-keys[data-open="1"][data-ten="1"] > .s-next { translate: calc(var(--s) * -1) 0; }
  .np-keys[data-open="1"] > .s-sb, .np-keys[data-open="1"] > .s-sf { opacity: 0; scale: .6; visibility: hidden; pointer-events: none; transition: opacity 160ms ease, scale 200ms ease, visibility 0s linear 220ms; }
  .np-keys[data-open="1"] > .s-back, .np-keys[data-open="1"] > .s-home { transition-delay: 90ms, 90ms, 0s, 0s, 0s, 0s, 0s, 0s; }

  /* The reveal: the pad's row grows from 0 (the panel stretches, the volume row below slides lower) while the pad fades in.
     Only a row height and opacity move, no spin and no sweep. */
  .rpad { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 340ms cubic-bezier(.2,.8,.2,1); }
  .rpad[data-open="1"] { grid-template-rows: 1fr; }
  .rpad-in { min-height: 0; overflow: hidden; display: flex; justify-content: center; }
  .rdial { opacity: 1; transition: opacity 260ms ease 100ms, visibility 0s linear 0s; }
  .rpad[data-open="0"] .rdial { opacity: 0; visibility: hidden; transition: opacity 140ms ease, visibility 0s linear 340ms; }

  /* The pad itself: one glass circle (the same glass as the page's cards), four quarter-pieces and OK in the middle.
     Each arrow button covers its whole quarter, so a hover lights that quarter (a soft accent glow growing toward the rim, drawn
     on ::before so only opacity moves) and the chevron leans a little outward (transform only). */
  .rdial { position: relative; width: 184px; height: 184px; margin: 10px 0 16px; border-radius: 50%; flex-shrink: 0; overflow: hidden;
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--well)), var(--well));
    border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 10%, transparent); }
  .rdial .pk { appearance: none; border: 0; background: transparent; padding: 0; cursor: pointer; display: grid; position: absolute; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    color: var(--fg-2); transform-origin: 50% 50%; transition: transform 90ms ease, color 140ms ease; }
  .rdial .pk:not(.ok) { inset: 0; width: 100%; height: 100%; }
  .rdial .pk:not(.ok)::before { content: ''; position: absolute; inset: 0; opacity: 0; transition: opacity 160ms ease;
    background: radial-gradient(circle at 50% 50%, transparent 24%, color-mix(in srgb, var(--accent) 26%, transparent) 100%); }
  .rdial .pk .ch { display: grid; place-items: center; position: relative; transition: transform 160ms cubic-bezier(.2,.8,.2,1); }
  .rdial .up { clip-path: polygon(50% 50%, 0 0, 100% 0); place-items: start center; padding-top: 17px; }
  .rdial .down { clip-path: polygon(50% 50%, 100% 100%, 0 100%); place-items: end center; padding-bottom: 17px; }
  .rdial .left { clip-path: polygon(50% 50%, 0 100%, 0 0); place-items: center start; padding-left: 17px; }
  .rdial .right { clip-path: polygon(50% 50%, 100% 0, 100% 100%); place-items: center end; padding-right: 17px; }
  @media (hover: hover) {
    .rdial .pk:not(.ok):hover { color: var(--accent); }
    .rdial .pk:not(.ok):hover::before { opacity: .7; }
    .rdial .up:hover .ch { transform: translateY(-3px); } .rdial .down:hover .ch { transform: translateY(3px); }
    .rdial .left:hover .ch { transform: translateX(-3px); } .rdial .right:hover .ch { transform: translateX(3px); }
  }
  .rdial .pk:not(.ok):active { color: var(--accent); transform: scale(.94); }
  .rdial .pk:not(.ok):active::before { opacity: 1; }
  .rdial .pk:not(.ok):focus-visible { outline: none; color: var(--accent); }
  .rdial .pk:not(.ok):focus-visible::before { opacity: .7; }
  /* OK is the page's primary round button (the same accent fill as play/pause), in the page's button lettering. */
  .rdial .ok { left: 60px; top: 60px; width: 62px; height: 62px; place-items: center; border-radius: 50%; background: var(--accent); color: var(--on-accent);
    font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .04em; box-shadow: 0 6px 16px -8px var(--accent); transition: transform 90ms ease, box-shadow 160ms ease; }
  @media (hover: hover) { .rdial .ok:hover { box-shadow: 0 6px 16px -8px var(--accent), 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); } }
  .rdial .ok:active { transform: scale(.94); }
  .rdial .ok:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }

  /* App buttons: only while the remote is open; they arrive after the pad. */
  .rchips { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 340ms cubic-bezier(.2,.8,.2,1); }
  .rchips-in { min-height: 0; overflow: hidden; }
  .np-ctl:has(.rpad[data-open="1"]) .rchips, .np:has(.rpad[data-open="1"]) .rchips { grid-template-rows: 1fr; }
  .rapps { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding-top: 12px; opacity: 0; transform: translateY(8px); transition: opacity 200ms ease, transform 200ms ease; }
  .np:has(.rpad[data-open="1"]) .rapps { opacity: 1; transform: none; transition: opacity 260ms ease 140ms, transform 300ms cubic-bezier(.2,.8,.2,1) 140ms; }
  .rapp { padding: 4px 2px; gap: 5px; font-size: 10.5px; }
  /* "Prime Video" is the one long name: it wraps to two lines instead of being cut off. */
  .rapp .nm { white-space: normal; text-align: center; line-height: 1.15; overflow-wrap: anywhere; }
  .rapp .logo { width: 40px; height: 40px; border-radius: 12px; font-size: 14px; transition: transform 90ms ease; }
  .rapp:active .logo { transform: scale(.94); }
  .rapps > .ghost { position: absolute; pointer-events: none; margin: 0; }
  @media (prefers-reduced-motion: reduce) {
    .rpad, .rdial, .rdial .pk, .rdial .pk::before, .rdial .pk .ch, .rdial .ok, .np-keys[data-open] > .key, .rapp .logo, .rchips, .rapps { transition: none !important; animation: none !important; }
    .rdial .pk:not(.ok):hover .ch { transform: none !important; }
  }
`;
