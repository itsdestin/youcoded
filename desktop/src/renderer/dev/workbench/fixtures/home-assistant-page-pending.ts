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
// fails (undone), or, for a send that was accepted, at the next check asked after
// that (the house's word, even if it clamped the value), with 8 seconds as the
// outer limit. `pend` is the status of each press: sending, done, didn't work.
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
  .pend[data-pend="done"] .pend-dot { background: rgb(50, 205, 90); }
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
  function heldSame(a, b, key) { return typeof b === 'number' ? Math.abs((a || 0) - b) <= 0.02 * (key === 'brightness' ? 255 : 1) : JSON.stringify(a) === JSON.stringify(b); }
  // WHY a slider's value is a TARGET (Destin's real house, rubber-banding, 2026-10-05): a Hue light answers about a
  // second after each call, with the answers for EARLIER values stamped newer than the guess, so newest-wins applied
  // the stale one and the bar jumped back and forward. A target stays until the device reports a value within 2% of
  // it, or about 4 seconds pass with no such report (then the device's word is accepted); until then every report
  // that does not match it is ignored whatever its stamp, and a check cannot drop it.
  var TARGETS = { brightness: 1, vol: 1 };
  function guessAgrees(it, g) { return g.field === 'state' ? it.state === g.value || (g.value === 'on' && isOn(it)) : heldSame(it[g.field], g.value, g.field); }
  // src names what the guess belongs to (a slider's key); a guess made by a press has none
  // yet and is picked up by pendBegin() ("fresh"), which tags it with the press's key.
  function guess(id, field, value, ms, src) {
    var k = id + '|' + field, old = guesses[k], it = thing(id);
    if (old) clearTimeout(old.timer);
    var g = guesses[k] = { id: id, field: field, value: value, before: old ? old.before : it ? it[field] : null, until: Date.now() + (ms || 4000), src: src || null, settledAt: 0, rep: old ? old.rep : null };
    // When nobody reports, the page still gives up the guess on time and shows what the device last said (or had).
    g.timer = setTimeout(function () { applyGuesses(); renderSoon(); }, (ms || 4000) + 20);
    if (!src) fresh.push(g);
    // The page shows the target at once and from then on, so a drawing (say the one right after you let go)
    // never draws the device's old value for a moment before its answer.
    if (it) it[field] = value;
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
      if (now > g.until) { clearTimeout(g.timer); delete guesses[k]; if (g.rep) it[g.field] = g.rep.v; else if (!g.reported) it[g.field] = g.before; return; }
      // A report that did not match is remembered (not shown): it is what the device last said if the target never comes.
      if (!heldSame(it[g.field], g.value, g.field) || g.field === 'state' && it.state !== g.value) { g.rep = { v: it[g.field] }; g.reported = true; }
      it[g.field] = g.value;
    });
  }
  function applyHeld() { applyGuesses(); }
  // A check asked AFTER a send was accepted reports the house's final word: the guess
  // (say a temperature the device capped) gives way to it instead of lingering 8 seconds.
  function dropSettled(sentAt) { Object.keys(guesses).forEach(function (k) { if (guesses[k].settledAt && guesses[k].settledAt <= sentAt) delete guesses[k]; }); }
  function settle(keys) { keys.forEach(function (k) { if (guesses[k] && !TARGETS[guesses[k].field]) guesses[k].settledAt = Date.now(); }); }
  // Put back only what still shows the guess: a field the house has since changed is left alone.
  function undoGuesses(keys) {
    keys.forEach(function (k) {
      var g = guesses[k];
      if (!g) return;
      var it = thing(g.id);
      if (it && JSON.stringify(it[g.field]) === JSON.stringify(g.value)) it[g.field] = g.before;
      delete guesses[k];
    });
  }
  function keysOf(src) { return Object.keys(guesses).filter(function (k) { return guesses[k].src === src; }); }
  // Only guesses made during the current press belong to it.
  ['click', 'change', 'input'].forEach(function (n) { document.addEventListener(n, function () { fresh = []; }, true); });

  // ── Status of each press (audit A-4) ─────────────────────────────────────
  // A slow one says "Sending…" (after half a second, so quick presses stay quiet), then "Done".
  // A refused one is undone at once and says "Didn't work" until dismissed or replaced.
  var pend = {}, pendSeq = 0, quietSeq = {}, toks = {};
  // own: the retry function shows its own guess (a rename, a move); otherwise Try again puts the guess back first (code review 7).
  function pendBegin(id, again, own, undo) {
    var taken = fresh; fresh = [];
    var keys = taken.map(function (g) { g.src = id; return g.id + '|' + g.field; });
    var redo = taken.map(function (g) { return { id: g.id, field: g.field, value: g.value }; });
    var tok = ++pendSeq;
    var e = pend[id] = { tok: tok, state: 'quiet', keys: keys, msg: '', again: !again ? null : own ? again : function () {
      batch(function () { redo.forEach(function (r) { var p = {}; p[r.field] = r.value; setLocal(r.id, p); }); });
      again();
    } };
    // Each press keeps its own undo, so a refusal that comes back after a newer press on the same thing still undoes ITS change (edit-board review 6).
    toks[tok] = { keys: keys, undo: undo || null, again: e.again };
    e.timer = setTimeout(function () { if (pend[id] === e && e.state === 'quiet') { e.state = 'sending'; renderSoon(); } }, 500);
    return tok;
  }
  function pendEnd(id, tok, err) {
    var e = pend[id], t = toks[tok] || { keys: [], undo: null, again: null };
    delete toks[tok];
    if (!e || e.tok !== tok) { // a newer press on the same thing took over
      if (err) {
        undoGuesses(t.keys); if (t.undo) t.undo();
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
    if (e.state === 'sending') {
      e.state = 'done';
      e.timer = setTimeout(function () { if (pend[id] === e) { delete pend[id]; renderSoon(); } }, 1500);
    } else delete pend[id];
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
    return '<div class="pend" role="status" data-pend="' + e.state + '"><span class="pend-dot" aria-hidden="true"></span><span>' + (e.state === 'done' ? 'Done' : 'Sending\\u2026') + '</span></div>';
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
