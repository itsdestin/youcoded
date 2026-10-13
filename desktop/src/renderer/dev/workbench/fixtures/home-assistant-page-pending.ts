// What the Home page shows before the house has agreed (redesign audit A-4 "show
// sending, done, failed" and A-6 "one list of pending changes", plus code review
// 5, 6, 7, 8 of commit e18c40b0d). Kept apart from home-assistant-page.ts so it stays
// inside its line budget; HOME_PENDING_JS is pasted INSIDE the page's script, so it
// shares thing(), rooms, render, batch, setLocal, banner, call, load, esc, isOn …
//
// One list holds every guess the page is showing: `guesses`, keyed "device|field"
// (a switch's state, a slider's value, a speaker's group, a new name). Each guess
// remembers what it replaced, so a refusal puts the old value back, and holds against
// a push that has not caught up. A guess ends when the house agrees, when its send
// fails (undone), or, for an accepted send of a value the device may clamp (a
// temperature), at the next check asked after that; a switch's state is held until
// the device reports it, with 8 seconds as the outer limit. `pend` holds a press's status; only a refusal is ever shown ("Didn't work"): Destin found the
// "Sending…" and "Done" notes annoying (2026-10-05), so a slow or finished press shows no text.
//
// Escapes: this text lives in a template string inside another one, so every
// backslash in the page's own code is doubled and no backtick may appear.

export const HOME_PENDING_CSS = `
  /* A slow, finished or refused press says so on its own card, laid OVER the card's
     bottom edge so it never changes the card's height (code review 6): no jump below
     it when it appears or goes. Kept neutral on purpose. */
  .tile, .clim, .th-hero, .lights, .edc-row { position: relative; }
  .pend { position: absolute; right: 8px; bottom: 6px; z-index: 3; max-width: calc(100% - 16px); display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 3px 8px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--panel); color: var(--fg-muted); font-size: 11px; line-height: 1.3; }
  .pend-msg { max-width: 18em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pend .pend-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-muted); flex-shrink: 0; }
  .pend[data-pend="failed"] { color: var(--fg); }
  .pend[data-pend="failed"] .pend-dot { background: rgb(235, 70, 55); }
  .pend .yc-button { padding: 0 8px; min-height: 22px; font-size: 11px; }
  /* The pop-up's history keeps the room it will need (see dialogHtml), so the pop-up does not jump when it arrives. */
  .dlg-hist { box-sizing: content-box; }
`;

export const HOME_PENDING_JS = `
  // ── Guesses (code review 7, 8; audit A-6) ─────────────────────────────────
  var guesses = {}, fresh = [], HOLD_MS = 8000;
  // Numbers agree when close (a bar's rounding); anything else (names, groups, colours) when equal.
  // Within 2% of the bar's range counts as the device having taken it (Hue rounds a little).
  // A thermostat's set point (target / tlo / thi) agrees within half a step (0.5 for a whole-degree one): a Nest rounds to its own grid.
  function heldSame(a, b, key, step) { return typeof b === 'number' ? Math.abs((a || 0) - b) <= (CLIMATE_KEYS[key] ? Math.min(0.5, (step || 1) / 2) : 0.02 * (key === 'brightness' ? 255 : 1)) : JSON.stringify(a) === JSON.stringify(b); }
  // WHY a slider's value is a TARGET (Destin's real house, rubber-banding, 2026-10-05): a Hue light answers about a
  // second after each call, with the answers for EARLIER values stamped newer than the guess, so newest-wins applied
  // the stale one and the bar jumped back and forward. A target stays until the device reports a value within 2% of
  // it, or about 4 seconds pass with no such report (then the device's word is accepted); until then every report
  // that does not match it is ignored whatever its stamp, and a check cannot drop it.
  // WHY a thermostat's set points are targets too (Destin: "the ac +/- is still buggy and rubberband-y", 2026-10-07): his Nest confirms a
  // change through Google about 2-4 seconds later, and confirmations of earlier presses land after a newer one, so the number jumped back and
  // forth. Held for 20 s, not 4-8: the confirmation is slow and Google rate-limits rapid commands, so a late one is normal; if none ever comes
  // the device's last word is shown after that. While held, every report that is not within half a step of the target is ignored.
  var CLIMATE_KEYS = { target: 1, tlo: 1, thi: 1 }, CLIMATE_HOLD_MS = 20000;
  var TARGETS = { brightness: 1, vol: 1, target: 1, tlo: 1, thi: 1 };
  function guessAgrees(it, g) { return g.field === 'state' ? it.state === g.value || (g.value === 'on' && isOn(it)) : heldSame(it[g.field], g.value, g.field, it.step); }
  // src names what the guess belongs to (a slider's key); a guess made by a press has none
  // yet and is picked up by pendBegin() ("fresh"), which tags it with the press's key.
  function guess(id, field, value, ms, src) {
    var k = id + '|' + field, old = guesses[k], it = thing(id);
    if (CLIMATE_KEYS[field]) ms = CLIMATE_HOLD_MS;
    if (old) clearTimeout(old.timer);
    var g = guesses[k] = { id: id, field: field, value: value, before: old ? old.before : it ? it[field] : null, until: Date.now() + (ms || 4000), src: src || null, settledAt: 0, rep: old ? old.rep : null };
    // When nobody reports, the page still gives up the guess on time and shows what the device last said (or had).
    g.timer = setTimeout(function () { applyGuesses(); renderSoon(); }, (ms || 4000) + 20);
    if (!src) fresh.push(g);
    // The page shows the target at once and from then on, so a drawing (say the one right after you let go)
    // never draws the device's old value for a moment before its answer.
    if (it) it[field] = value;
    memNote(id, field, value); // a level the person set is the one to bring back after an off (home-assistant-page-memory.ts)
  }
  function holdState(id, state) { guess(id, 'state', state, HOLD_MS); }
  function holdVal(id, key, value, ms, src) { guess(id, key, value, ms, src); }
  // WHY agreement is judged only when the HOUSE reports (rubber-banding, 2026-10-05): the page writes its own guess onto
  // the device's data, so comparing that data with the guess "agreed" at once and the guess was dropped by the next
  // unrelated update. guessReport(id) runs right after a push or a check wrote the house's value for that device.
  function guessReport(id) {
    Object.keys(guesses).forEach(function (k) {
      var g = guesses[k], it = g.id === id ? thing(id) : null;
      if (it && guessAgrees(it, g)) delete guesses[k];
    });
  }
  function guessReportAll() { var seen = {}; Object.keys(guesses).forEach(function (k) { var id = guesses[k].id; if (!seen[id]) { seen[id] = 1; guessReport(id); } }); }
  function applyGuesses() {
    var now = Date.now();
    Object.keys(guesses).forEach(function (k) {
      var g = guesses[k], it = thing(g.id);
      if (!it) { delete guesses[k]; return; }
      // A set point means nothing once the mode changed under it (Auto holds a low and a high, every other mode one, Off none): let go, the house's numbers show.
      if (CLIMATE_KEYS[g.field] && (it.state === 'off' || (g.field === 'target') === (it.state === 'heat_cool'))) { clearTimeout(g.timer); delete guesses[k]; return; }
      if (now > g.until) { clearTimeout(g.timer); delete guesses[k]; if (g.rep) it[g.field] = g.rep.v; else if (!g.reported) it[g.field] = g.before; return; }
      // A report that did not match is remembered (not shown): it is what the device last said if the target never comes.
      if (!heldSame(it[g.field], g.value, g.field, it.step) || g.field === 'state' && it.state !== g.value) { g.rep = { v: it[g.field] }; g.reported = true; }
      it[g.field] = g.value;
    });
  }
  function applyHeld() { applyGuesses(); }
  // A check asked AFTER a send was accepted reports the house's final word: the guess
  // (say a temperature the device capped) gives way to it instead of lingering 8 seconds.
  function dropSettled(sentAt) { Object.keys(guesses).forEach(function (k) { if (guesses[k].settledAt && guesses[k].settledAt <= sentAt) delete guesses[k]; }); }
  // WHY a switch's state is NOT settled (code review F2, the rubber-banding Destin reported): the house takes a moment (Hue
  // about a second) to report after it ACCEPTS a call, so the first check asked afterwards still shows the OLD state; dropping
  // the hold there flipped the card back and forward again. A state guess keeps its hold until the device reports it
  // (guessReport) or the 8 seconds run out. Other fields (a temperature the device may clamp) still give way to the next check.
  function settle(keys) { keys.forEach(function (k) { var f = guesses[k] && guesses[k].field; if (f && !TARGETS[f] && f !== 'state') guesses[k].settledAt = Date.now(); }); }
  // Put back only what still shows the guess: a field the house has since changed is left alone.
  // WHY tok (code review F13): an OLDER press that is refused after a NEWER press on the same field must not undo the newer
  // press's guess (the newer one may have gone through); a guess is stamped with the press that owns it, and only that press undoes it.
  function undoGuesses(keys, tok) {
    keys.forEach(function (k) {
      var g = guesses[k];
      if (!g || (tok && g.tok !== tok)) return;
      var it = thing(g.id);
      if (it && JSON.stringify(it[g.field]) === JSON.stringify(g.value)) it[g.field] = g.before;
      delete guesses[k];
    });
  }
  function keysOf(src) { return Object.keys(guesses).filter(function (k) { return guesses[k].src === src; }); }
  // Only guesses made during the current press belong to it.
  ['click', 'change', 'input'].forEach(function (n) { document.addEventListener(n, function () { fresh = []; }, true); });

  // ── Status of each press (audit A-4) ─────────────────────────────────────
  // A press that goes through shows no note at all (the button's own feel is the acknowledgement).
  // A refused one is undone at once and says "Didn't work" until dismissed or replaced.
  var pend = {}, pendSeq = 0, quietSeq = {}, toks = {};
  // own: the retry function shows its own guess (a rename, a move); otherwise Try again puts the guess back first (code review 7).
  function pendBegin(id, again, own, undo) {
    var taken = fresh; fresh = [];
    var tok0 = pendSeq + 1;
    var keys = taken.map(function (g) { g.src = id; g.tok = tok0; return g.id + '|' + g.field; });
    var redo = taken.map(function (g) { return { id: g.id, field: g.field, value: g.value }; });
    var tok = ++pendSeq;
    var e = pend[id] = { tok: tok, state: 'quiet', keys: keys, msg: '', again: !again ? null : own ? again : function () {
      batch(function () { redo.forEach(function (r) { var p = {}; p[r.field] = r.value; setLocal(r.id, p); }); });
      again();
    } };
    // Each press keeps its own undo, so a refusal that comes back after a newer press on the same thing still undoes ITS change (edit-board review 6).
    toks[tok] = { keys: keys, undo: undo || null, again: e.again };
    return tok;
  }
  function pendEnd(id, tok, err) {
    var e = pend[id], t = toks[tok] || { keys: [], undo: null, again: null };
    delete toks[tok];
    if (!e || e.tok !== tok) { // a newer press on the same thing took over
      if (err) {
        undoGuesses(t.keys, tok); if (t.undo) t.undo();
        // The older refusal still says so on the same row, even if the newer press has long finished.
        if (e) clearTimeout(e.timer);
        pend[id] = { tok: e ? e.tok : ++pendSeq, state: 'failed', keys: e ? e.keys : [], msg: err, again: t.again };
        render();
      }
      return;
    }
    clearTimeout(e.timer);
    if (err) { if (t.undo) t.undo(); return pendFail(id, e, err); }
    settle(e.keys);
    if (e.state === 'failed') { renderSoon(); return; } // an older refusal on this row stays until dismissed
    delete pend[id];
    renderSoon();
  }
  function pendFail(id, e, msg) {
    undoGuesses(e.keys);
    e.state = 'failed'; e.msg = msg;
    // Something with no card of its own (a scene, Everything off) says it in the bar at the top.
    if (!thing(id) && id.indexOf('room:') !== 0) { delete pend[id]; banner(msg, true); }
    render();
  }
  // Mid-drag values go out at most every ms per slider key (a light 400 ms, a room's command 1 s: a Hue group takes about one
  // a second), the newest value only; letting go always sends the final value, and never the same value twice.
  var sends = {};
  function flushSend(s) {
    var n = s.n; s.n = null;
    if (!n || (n.val === s.last && Date.now() - s.at < 4000)) return;
    s.last = n.val; s.at = Date.now(); n.fn();
  }
  // A press of a button (a thermostat's − or +) sends only after the presses stop: the number shows at once, five quick presses are one send
  // of the final value (a Nest is rate-limited by Google, and each early send brings a late confirmation that pulls the number back).
  // Shares the slider's record, so a drag and a press cannot fight: letting go of the drag flushes whatever is newest.
  function sendAfter(key, ms, val, fn) {
    var s = sends[key] || (sends[key] = { t: null, n: null, last: null, at: 0 });
    s.n = { val: val, fn: fn };
    clearTimeout(s.t);
    s.t = setTimeout(function () { s.t = null; flushSend(s); }, ms);
  }
  function sendSlider(key, ms, val, fn, final) {
    var s = sends[key] || (sends[key] = { t: null, n: null, last: null, at: 0 });
    s.n = { val: val, fn: fn };
    if (final) { clearTimeout(s.t); s.t = null; flushSend(s); return; }
    if (s.t) return; // a send is waiting its turn and will carry the newest value
    var wait = s.at + ms - Date.now();
    if (wait <= 0) { flushSend(s); return; }
    s.t = setTimeout(function () { s.t = null; flushSend(s); }, wait);
  }
  // Sliders send without waiting. Only the NEWEST send of a slider decides (code review 5):
  // an older one failing after a later one went through must not put the old value back.
  function quiet(path, body, key) {
    var n = key ? (quietSeq[key] = (quietSeq[key] || 0) + 1) : 0;
    call(path, body).then(function () {
      // (nothing to do on success: the target stays until the device reports it, or about 4 seconds pass)
    }, function (e) {
      var m = e && e.message ? e.message : 'That did not go through.';
      if (!key) { banner(m, true); return; }
      if (quietSeq[key] !== n) return;
      var keys = keysOf(key);
      pendFail(key, pend[key] = { tok: ++pendSeq, state: 'failed', keys: keys, again: null, msg: m }, m);
      setTimeout(load, 400); // and ask the house what it really has (it self-corrects like a switch does)
    });
  }
  function pendHtml(a, b) {
    var e = pend[a] && pend[a].state !== 'quiet' ? pend[a] : pend[b] && pend[b].state !== 'quiet' ? pend[b] : null;
    if (!e) return '';
    var key = pend[a] === e ? a : b;
    if (e.state === 'failed') {
      return '<div class="pend" role="alert" data-pend="failed" title="' + esc(e.msg) + '"><span class="pend-dot" aria-hidden="true"></span><span class="pend-msg">Didn\\u2019t work. ' + esc(e.msg) + '</span>' +
        (e.again ? '<button class="yc-button yc-button--sm" data-pend-retry="' + esc(key) + '">Try again</button>' : '') +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-pend-dismiss="' + esc(key) + '">Dismiss</button></div>';
    }
    return ''; // only a refusal has a note
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-pend-dismiss],[data-pend-retry],[data-banner-dismiss]');
    if (!t) return;
    var d = t.getAttribute('data-pend-dismiss'), r = t.getAttribute('data-pend-retry');
    if (t.hasAttribute('data-banner-dismiss')) { bannerSticky = false; banner(''); return; }
    if (d) { delete pend[d]; render(); return; }
    var p = pend[r];
    if (p && p.again) { delete pend[r]; p.again(); }
  });
`;
