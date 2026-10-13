// The "Computer" card (Destin, 2026-10-05: "lets pull the pc in. in destin's room"). One card per computer, built from TWO Home Assistant
// things that are not linked to each other: a ping sensor ("Desktop PC": on = the computer answers) and a wake-on-LAN button
// ("Wake Desktop PC": pressing it sends the wake signal). They are paired by NAME inside one room: a button whose name contains a sensor's
// name belongs to that sensor. The sensor is the card; its button is folded into it and never drawn as a card of its own (pcHidden).
//   sensor + button -> title, "On" / "Off" / "Waking…" / "Didn't wake", and Wake while it is off
//   sensor alone    -> status only (nothing to press)
//   button alone    -> a Wake-only card
// There is NO off control today (it would need a helper program on the PC); a future off button/switch for the same computer would be
// folded in here the same way. HOME_COMPUTER_JS is pasted INSIDE the page's script (shares esc, domain, roomOf, gone, hidden, service,
// pend, pendHtml, render, ico). Template string: no backticks, no dollar-brace, backslashes doubled.

export const HOME_COMPUTER_JS = `
  // ── Computer card: ping sensor + wake button ─────────────────────────────
  var PC_TIMEOUT_MS = 180000, PC_SENT_MS = 4000;
  var pcWake = {}; // card id -> { at, timer }: a Wake that was sent and is waiting to be seen
  function pcNorm(n) { return String(n == null ? '' : n).toLowerCase().replace(/\\s+/g, ' ').trim(); }
  // The ping sensor a wake button belongs to: the one in the same room whose name its own name contains (the longest, if several).
  function pcSensorFor(btn) {
    var r = roomOf(btn.id), b = pcNorm(btn.name), best = null, bestN = '';
    if (!r || !b) return null;
    r.items.forEach(function (x) {
      var n = domain(x.id) === 'binary_sensor' ? pcNorm(x.name) : '';
      if (n && b.indexOf(n) >= 0 && n.length > bestN.length) { best = x; bestN = n; }
    });
    return best;
  }
  function pcButtonFor(sensor) {
    var r = roomOf(sensor.id);
    return r ? r.items.filter(function (x) { return domain(x.id) === 'button' && pcSensorFor(x) === sensor; })[0] || null : null;
  }
  // WHY: a wake button that belongs to a sensor is part of that sensor's card, so it gets no card, Edit row or Problems entry of its own.
  function pcHidden(it) { var s = domain(it.id) === 'button' ? pcSensorFor(it) : null; return !!s && pcButtonFor(s) === it; }
  function pcClear(key) { var w = pcWake[key]; if (w) { clearTimeout(w.timer); delete pcWake[key]; } }
  function pcCardHtml(it) {
    var isBtn = domain(it.id) === 'button', key = it.id;
    var btn = isBtn ? it : pcButtonFor(it), w = pcWake[key];
    var na = isBtn ? it.state === 'unavailable' : gone(it);
    var on = !isBtn && !na && it.state === 'on';
    var text = '', failed = false, waking = false;
    if (na) text = 'Not responding';
    else if (on) { if (w) pcClear(key); text = 'On'; } // the ping answered: the wait is over
    else if (!isBtn) {
      if (w && Date.now() - w.at < PC_TIMEOUT_MS) { waking = true; text = 'Waking\\u2026'; }
      else if (w) { failed = true; text = 'Didn\\u2019t wake'; } // about 3 minutes and the computer never answered
      else text = 'Off';
    } else if (w && Date.now() - w.at < PC_SENT_MS) { waking = true; text = 'Wake signal sent'; } // a lone button cannot see the result
    var canWake = !!btn && !na && !on && !waking;
    // WHY the failure is a dot and words in the status line, not the .pend bubble: the bubble floats over the card's bottom corner,
    // right where the Wake button sits; it keeps the same red dot and "Didn't ..." wording as the page's "Didn't work".
    var sub = text ? '<div class="sub' + (failed ? ' pc-fail' : '') + '">' + (failed ? '<span class="pc-dot" aria-hidden="true"></span>' : '') + esc(text) + '</div>' : '';
    var wake = canWake ? '<button class="yc-button yc-button--sm yc-button--primary pcw" data-wake="' + esc(key) + '" aria-label="' + (isBtn ? '' : 'Wake ') + esc(it.name) + '" title="Wake">Wake</button>' : '';
    return '<div class="tile media pc' + (on ? ' on' : '') + (na ? ' gone' : '') + (hidden.has(it.id) ? ' is-hidden' : '') + '" style="--c:var(--accent)"><span class="glow"></span>' +
      '<div class="line"><div class="mhead"><div class="kind">' + COMPUTER + 'Computer</div><div class="mname">' + esc(it.name) + '</div>' + sub + '</div>' + wake + '</div>' + pendHtml(it.id) + '</div>';
  }
  // One press sends one wake signal. While it waits (or just sent) the button is not drawn, and a second press is ignored anyway.
  function pcPress(key) {
    var it = thing(key);
    if (!it) return;
    var isBtn = domain(it.id) === 'button', btn = isBtn ? it : pcButtonFor(it);
    var w = pcWake[key];
    if (!btn || (w && Date.now() - w.at < (isBtn ? PC_SENT_MS : PC_TIMEOUT_MS))) return;
    pcClear(key);
    pcWake[key] = { at: Date.now(), timer: setTimeout(function () { render(); }, (isBtn ? PC_SENT_MS : PC_TIMEOUT_MS) + 50) }; // redraw when the wait runs out
    render();
    service('button', 'press', { entity_id: btn.id }, key).then(function () {
      var p = pend[key];
      // A refused press is not "waking". The card's own Wake button is the retry, so the bubble's Try again would only press unseen.
      if (p && p.state === 'failed') { pcClear(key); p.again = null; render(); }
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-wake]');
    if (b) pcPress(b.getAttribute('data-wake'));
  });
`;

export const HOME_COMPUTER_CSS = `
  /* The computer card reuses the media tile; only the Wake button and the failure line are its own. */
  .tile.pc .pcw { flex-shrink: 0; transition: transform 90ms ease, background-color 120ms ease; }
  .tile.pc .pcw:active { transform: scale(.94); }
  .tile.pc .sub.pc-fail { display: flex; align-items: center; gap: 6px; color: var(--fg); }
  .pc-dot { width: 6px; height: 6px; border-radius: 50%; background: rgb(235, 70, 55); flex-shrink: 0; }
  @media (prefers-reduced-motion: reduce) { .tile.pc .pcw { transition: none; } .tile.pc .pcw:active { transform: none; } }
`;
