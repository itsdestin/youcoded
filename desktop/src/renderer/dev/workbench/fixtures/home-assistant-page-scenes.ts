// A room's Scenes as side-scrolling colour cards (Destin, 2026-10-06: "scene view and expanded room/light view mutually exclusive ...
// restyle scenes to better show the colors ... side-browseable cards"). Picked in the scenes decks: a gradient face (scenes-all,
// 2026-10-06) in two stacked rows that slide sideways together (home-scenes-2, 2026-10-07, "rows2"); no "last used" chip, the scene
// used last keeps only an accent outline and the row opens scrolled to it.
//
// WHY learned colours: Home Assistant tells the page a Hue scene's name, brightness (0-255) and whether it moves (is_dynamic), never its
// colours. So when a scene is pressed from the page, the page waits a moment, reads the colours its room's lights settled on and keeps
// them per scene in the page's own saved data ({ sceneLook: { <scene id>: { c: [up to 5 colours] } } }). A scene never pressed from the
// page shows an intentional striped "Try it to see its colours" face. Nothing is guessed from names.
// Opening a room's Scenes closes its lights list and the other way round (the two handlers in home-assistant-page.ts).
// HOME_SCENES_JS is pasted INSIDE the page's script (shares esc, rooms, isLight, isOn, gone, colourOf, persist, render, sceneName,
// scenesList, scenesOpen). Template string: no backticks, no dollar-brace, no backslashes.

export const HOME_SCENES_JS = `
  // ── Scenes: gradient cards in two sliding rows ───────────────────────────
  var scLooks = null;
  function scLookAll() {
    if (!scLooks) { var d = (window.youcoded && window.youcoded.data) || {}; scLooks = d.sceneLook && typeof d.sceneLook === 'object' ? d.sceneLook : {}; }
    return scLooks;
  }
  // WHY a delay: a Hue scene takes a moment to reach the lights, and the live update then lands. Read what the lights settled on.
  // A moving scene is caught at one moment of its cycle, which is still its own colours.
  function learnScene(id) {
    setTimeout(function () {
      var room = (rooms || []).filter(function (r) { return (r.scenes || []).some(function (x) { return x.id === id; }); })[0];
      if (!room) return;
      var on = room.items.filter(function (it) { return isLight(it) && isOn(it) && !gone(it) && !(Array.isArray(it.members) && it.members.length); });
      if (!on.length) return;
      var cs = [];
      on.forEach(function (it) { var c = colourOf(it); if (cs.indexOf(c) < 0 && cs.length < 5) cs.push(c); });
      scLookAll()[id] = { c: cs };
      persist({ sceneLook: scLookAll() });
      render();
    }, 2500);
  }
  var SC_WAVE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M2 12c3-7 5-7 8 0s5 7 8 0 3-4 4-4"/></svg>';
  function scLook(sc) { var l = scLookAll()[sc.id]; return l && Array.isArray(l.c) && l.c.length ? l : null; }
  // The scene's own brightness from Home Assistant (0-255), as a percent; full when it does not say.
  function scBri(sc) { return typeof sc.b === 'number' ? Math.max(1, Math.round(sc.b / 255 * 100)) : 100; }
  function scLabel(sc, room) {
    var l = scLook(sc);
    return sceneName(sc, room) + (sc.dyn ? ', moves through its colours' : '') + ', ' + scBri(sc) + ' percent bright' + (l ? ', ' + l.c.length + ' colours' : ', colours not seen yet');
  }
  function scMoving(sc) { return sc.dyn ? '<span class="sx-mv" title="Moves slowly through its colours">' + SC_WAVE + '</span>' : ''; }
  function scCard(sc, room) {
    var l = scLook(sc), b = scBri(sc);
    var foot = '<span class="sx-nm">' + esc(sceneName(sc, room)) + '</span><span class="sx-pct">' + b + '%</span>';
    if (!l) return '<span class="sg-face sg-unk"><span class="sg-top">' + scMoving(sc) + '</span><span class="sx-try">Try it to see its colours</span></span><span class="sg-foot">' + foot + '</span>';
    var cs = l.c.length > 1 ? l.c : [l.c[0], 'color-mix(in srgb, ' + l.c[0] + ' 55%, #000)'];
    // WHY dimmer scenes look dimmer: the gradient fades toward the card's own background with the scene's brightness.
    return '<span class="sg-face" style="--sgo:' + (0.5 + 0.5 * b / 100).toFixed(2) + '"><span class="sg-bg" style="background:' + esc('linear-gradient(135deg, ' + cs.join(', ') + ')') + '"></span><span class="sg-top">' + scMoving(sc) + '</span></span>' +
      '<span class="sg-foot sg-on">' + foot + '</span>';
  }
  function scenesHtml(room) {
    var list = scenesList(room);
    if (!list.length || !scenesOpen.has(room.id)) return '';
    var last = list.reduce(function (a, b) { return Date.parse(b.last) > Date.parse(a ? a.last : 0) ? b : a; }, null);
    if (last && !Date.parse(last.last)) last = null;
    var sorted = list.slice().sort(function (a, b) { return sceneName(a, room).localeCompare(sceneName(b, room)); });
    return '<div class="scenes sx open"><div class="sx-row" role="group" aria-label="Scenes in ' + esc(room.name) + ', scroll sideways">' + sorted.map(function (sc) {
      var isLast = !!(last && sc.id === last.id);
      return '<button class="scene sx-card' + (isLast ? ' last' : '') + (scLook(sc) ? '' : ' unk') + '" data-scene="' + esc(sc.id) + '" aria-label="' + esc(scLabel(sc, room) + (isLast ? ', used last' : '')) + '">' + scCard(sc, room) + '</button>';
    }).join('') + '</div></div>';
  }
  // WHY: a row opens already scrolled to the scene used last (once per row; later redraws keep your own scrolling).
  var sxDone = typeof WeakSet === 'function' ? new WeakSet() : null, sxPrev = window.__homeAfterPut;
  window.__homeAfterPut = function (id) {
    if (sxPrev) sxPrev(id);
    if (!sxDone) return;
    Array.prototype.forEach.call(document.querySelectorAll('.sx-row'), function (row) {
      if (sxDone.has(row)) return; sxDone.add(row);
      var c = row.querySelector('.sx-card.last'); if (!c) return;
      row.scrollLeft += c.getBoundingClientRect().left - row.getBoundingClientRect().left - (row.clientWidth - c.offsetWidth) / 2;
    });
  };
  // Arrow keys move between cards; the mouse wheel scrolls the row sideways (until its end, then the page scrolls again).
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var card = e.target.closest && e.target.closest('.sx-card'); if (!card) return;
    var cards = Array.prototype.slice.call(card.parentElement.children), i = cards.indexOf(card);
    var next = cards[i + (e.key === 'ArrowRight' ? 2 : -2)] || cards[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ inline: 'center', block: 'nearest' }); }
  });
  document.addEventListener('wheel', function (e) {
    var row = e.target.closest && e.target.closest('.sx-row'); if (!row || e.ctrlKey) return;
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? 0 : e.deltaY; if (!d) return;
    var max = row.scrollWidth - row.clientWidth;
    if ((d > 0 && row.scrollLeft < max - 1) || (d < 0 && row.scrollLeft > 0)) { e.preventDefault(); row.scrollLeft += d; }
  }, { passive: false });
`;

// After the page's own styles (it overrides the old pill look of .scene).
export const HOME_SCENES_CSS = `
  .scenes.sx { padding: 12px 0 4px; margin: 0 8px 8px; }
  /* Two stacked rows that slide sideways together; cards snap; the page's own thin themed scrollbar (home-assistant-page-look.ts); both edges fade so "more this way" shows. */
  .sx-row { display: grid; grid-auto-flow: column; grid-template-rows: repeat(2, 84px); grid-auto-columns: 128px; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scroll-padding: 0 12px; padding: 2px 12px 12px;
    -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 18px), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 18px), transparent 100%); }
  .sx-row::-webkit-scrollbar { height: 6px; }
  .sx-card { position: relative; height: 84px; scroll-snap-align: start; text-align: left; padding: 0; overflow: hidden; display: flex; flex-direction: column; color: var(--fg); border-radius: var(--radius-md, 10px); border: 1px solid var(--edge); background: var(--inset); cursor: pointer; transition: transform 90ms ease, border-color 120ms ease; font-size: 12px; }
  .sx-card:hover { border-color: var(--accent); }
  .sx-card:active { transform: scale(.97); }
  .sx-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .sx-card.last { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .sx-nm { font-weight: 600; font-size: 13px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sx-mv { display: inline-flex; align-items: center; padding: 3px 5px; border-radius: 9999px; background: rgba(0,0,0,.45); color: #fff; line-height: 1; margin-left: auto; }
  .sx-try { position: absolute; left: 8px; right: 8px; top: 22px; text-align: center; font-size: 9.5px; line-height: 1.2; color: var(--fg-muted); }
  .sx-pct { font-size: 11px; color: var(--fg-2); font-variant-numeric: tabular-nums; }
  .sg-face { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 8px; }
  .sg-bg { position: absolute; inset: 0; opacity: var(--sgo, 1); }
  .sg-bg::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.62) 0, rgba(0,0,0,0) 62%); }
  .sg-top { position: relative; display: flex; align-items: flex-start; min-height: 16px; }
  .sg-foot { position: relative; margin-top: auto; padding: 6px 8px; display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  .sg-foot.sg-on { color: #fff; }
  .sg-foot.sg-on .sx-pct { color: rgba(255,255,255,.85); }
  .sg-unk { background: repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in srgb, var(--edge-dim) 70%, transparent) 7px 8px); }
  .sx-card.unk { border-style: dashed; }
  .sx-card.unk.last { border-style: solid; }
  .sg-unk .sx-mv { background: var(--well); color: var(--fg-2); border: 1px solid var(--edge-dim); }
  @media (max-width: 480px) { .sx-row { grid-auto-columns: 116px; } }
  @media (prefers-reduced-motion: reduce) { .sx-card { transition: none; } }
`;
