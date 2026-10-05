// The Home page's instant updates (spec 2026-10-04, Part 1: "a card changes
// the moment the device does"). Kept apart from home-assistant-page.ts so
// neither file outgrows the line budget; HOME_LIVE_JS is pasted INSIDE the
// page's script, so it shares its helpers (rooms, render, banner, applyHeld,
// dragging, load, …).
//
// How it works: the app keeps ONE live connection to Home Assistant for this
// page (`youcoded.socket`). After Home Assistant says it accepted the key
// (`auth_ok`) the page subscribes to its devices' states
// (`subscribe_entities`). Home Assistant answers with every state in full, then
// sends only what changed. Each change is laid onto the same rooms the template
// check produces, so the cards draw exactly as they do today, only sooner.
//
// The template check keeps running (once a minute while live, every 5 seconds
// otherwise): it still finds renames, new rooms and new devices, which a state
// subscription cannot see. A press the person just made still wins over a
// pushed state that has not caught up (the same holds the checks use).
//
// Escapes: this text lives in a template string inside another one, so every
// backslash in the page's own code is doubled and no backtick may appear.

export const HOME_LIVE_JS = `
  // ── Instant updates ───────────────────────────────────────────────────
  // live.on is true only while the subscription is really delivering: the
  // socket is open AND Home Assistant said yes to the subscription. Only then
  // does the template check slow to once a minute.
  var live = { sock: null, state: 'none', authed: false, on: false, msg: 0, subId: 0, sig: '', raw: {} };
  var LIVE_POLL_MS = 60000, RECONNECT_NOTE_MS = 5000;
  var liveDirty = false, noteTimer = null;
  // Home Assistant's attribute names → the fields the rooms template produces.
  var LIVE_ATTRS = [
    ['friendly_name', 'name'], ['brightness', 'brightness'], ['supported_color_modes', 'modes'], ['current_temperature', 'cur'],
    ['temperature', 'target'], ['min_temp', 'min'], ['max_temp', 'max'], ['target_temp_step', 'step'], ['volume_level', 'vol'],
    ['media_title', 'title'], ['rgb_color', 'rgb'], ['color_temp_kelvin', 'k'], ['hvac_modes', 'modesHvac'], ['hvac_action', 'action'],
    ['device_class', 'dc'], ['current_activity', 'activity'], ['app_name', 'app'], ['source', 'source'], ['media_content_id', 'cid'], ['media_position', 'pos'], ['media_position_updated_at', 'posAt'], ['source_list', 'sources'],
    ['is_volume_muted', 'muted'], ['group_members', 'group'], ['target_temp_low', 'tlo'], ['target_temp_high', 'thi']
  ];

  function repoll(ms) {
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden && !Object.keys(busy).length) load(); }, ms);
  }
  // The checking speed follows the connection: slow while live, quick when not.
  function liveRate(on) {
    if (live.on === on) return;
    live.on = on;
    repoll(on ? LIVE_POLL_MS : POLL_MS);
  }
  function itemIds() {
    var ids = [];
    (rooms || []).forEach(function (r) { r.items.forEach(function (it) { ids.push(it.id); }); });
    return ids.sort();
  }
  function liveNote(show) {
    var n = $('livenote');
    if (!n) {
      n = document.createElement('div'); n.id = 'livenote'; n.className = 'livenote'; n.hidden = true;
      $('banner').parentNode.insertBefore(n, $('banner').nextSibling);
    }
    n.textContent = show ? 'Reconnecting…' : '';
    n.hidden = !show;
  }
  function liveSend(m) {
    if (!live.sock) return;
    live.msg += 1;
    m.id = live.msg;
    live.sock.send(JSON.stringify(m));
    return m.id;
  }
  // Subscribe once there is something to subscribe for: Home Assistant has
  // accepted the key AND the first check has told the page which devices exist.
  // Called from both, so whichever finishes last starts it. A changed list of
  // devices (found by a later check) replaces the subscription.
  function liveSubscribe() {
    if (!live.sock || live.state !== 'open' || !live.authed || !rooms || document.hidden) return; // hidden means idle: nothing is subscribed while the page is not on screen
    var ids = itemIds(), sig = ids.join('|');
    if (sig === live.sig && live.subId) return;
    if (live.subId) liveSend({ type: 'unsubscribe_events', subscription: live.subId });
    // WHY the id is claimed BEFORE sending: an answer can come back inside the
    // very call that sends (the pretend one does), and must find its id waiting.
    live.sig = sig; live.subId = live.msg + 1;
    liveSend({ type: 'subscribe_entities', entity_ids: ids });
  }
  // WHY unsubscribe on hide and resubscribe on show: while the page is not on screen every light and speaker push would still be
  // parsed and applied. Showing it again subscribes anew, and Home Assistant answers with every state in full, so nothing is missed
  // (the page's own check runs on show too).
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (live.subId && live.sock && live.state === 'open') liveSend({ type: 'unsubscribe_events', subscription: live.subId });
      live.subId = 0; live.sig = ''; live.raw = {};
    } else liveSubscribe();
  });
  function liveStart() {
    if (!base || typeof window.youcoded.socket !== 'function' || live.sock) return;
    live.sock = window.youcoded.socket(base + '/api/websocket', { onState: liveState, onMessages: liveMessages });
  }
  function liveState(state) {
    live.state = state;
    clearTimeout(noteTimer);
    if (state === 'reconnecting') noteTimer = setTimeout(function () { liveNote(true); }, RECONNECT_NOTE_MS);
    else liveNote(false);
    // Every 'open' is a brand-new connection: nothing is subscribed on it yet,
    // and the greeting must be answered again before anything is sent.
    live.authed = false; live.subId = 0; live.sig = ''; live.msg = 0; live.raw = {};
    if (state !== 'open') liveRate(false);
    if (state === 'closed') live.sock = null;
  }
  function liveMessages(texts) {
    // WHY nothing is parsed while hidden (code review F10, "hidden means idle"): once the greeting is answered, the pushes
    // that were already on their way when the page was hidden are dropped unread; the subscription is ended below.
    if (document.hidden && live.authed) return;
    texts.forEach(function (text) {
      var m;
      try { m = JSON.parse(text); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'auth_ok') { live.authed = true; liveSubscribe(); return; }
      if (m.id !== live.subId || !live.subId) return;
      if (m.type === 'result') { liveRate(!!m.success); return; }
      if (m.type === 'event' && m.event) liveEvent(m.event);
    });
    if (liveDirty) liveSchedule();
  }

  // One entity's compressed state → the item's fields. Fields that are not
  // state attributes (maker, model, device, …) are left as the template gave them.
  // WHY stamps (redesign audit F4 "the newest one wins", code review 4): the house stamps every
  // state with when it last updated it (lu, else lc); the check's answer carries the same
  // stamp as upd. Whichever is newer wins, in both directions, whatever order they arrive in.
  // WHY the NEWER of lc and lu (code review F1): the real house sends lc ALONE when the state changes (lu equals it and
  // is left out) and lu alone when only attributes change, so "lu, else lc" kept an old lu after a later state change and
  // the push was thrown away as stale.
  function liveStamp(raw) { return Math.round(Math.max(raw.lu || 0, raw.lc || 0) * 1000); }
  function liveApply(id, raw) {
    var it = thing(id);
    if (!it) return;
    var stamp = liveStamp(raw);
    if (stamp && Date.parse(it.upd || '') > stamp) return; // the check already has something newer
    var before = JSON.stringify(it);
    it.state = raw.s;
    noteReport(it); // the house's word on whether this app really reports play and pause (home-assistant-page-tv.ts)
    var a = raw.a || {};
    LIVE_ATTRS.forEach(function (p) { if (p[0] in a) it[p[1]] = a[p[0]]; else if (p[0] !== 'friendly_name') it[p[1]] = null; });
    it.features = a.supported_features == null ? 0 : a.supported_features;
    if (typeof raw.lc === 'number') it.since = new Date(raw.lc * 1000).toISOString();
    guessReport(id); // the house just spoke for this device: does it agree with what the page is showing?
    if (JSON.stringify(it) !== before) liveDirty = true;
    if (stamp) it.upd = new Date(stamp).toISOString();
  }
  // After a check's answer is laid in: every pushed state at least as new as the answer's goes back on top.
  function liveReplay() { Object.keys(live.raw).forEach(function (id) { liveApply(id, live.raw[id]); }); }
  function liveEvent(ev) {
    var added = ev.a || {}, changed = ev.c || {};
    Object.keys(added).forEach(function (id) { live.raw[id] = { s: added[id].s, a: Object.assign({}, added[id].a), lc: added[id].lc, lu: added[id].lu }; liveApply(id, live.raw[id]); });
    Object.keys(changed).forEach(function (id) {
      var raw = live.raw[id] || (live.raw[id] = { s: '', a: {}, lc: 0, lu: 0 });
      var plus = changed[id]['+'] || {}, minus = changed[id]['-'] || {};
      if ('s' in plus) raw.s = plus.s;
      if ('lc' in plus) { raw.lc = plus.lc; raw.lu = plus.lc; } // a state change: last updated is that same moment
      if ('lu' in plus) raw.lu = plus.lu;
      Object.assign(raw.a, plus.a || {});
      (minus.a || []).forEach(function (k) { delete raw.a[k]; });
      liveApply(id, raw);
    });
    // A device taken out of Home Assistant leaves the page; the next check
    // puts it back if it was only a hiccup.
    (ev.r || []).forEach(function (id) {
      delete live.raw[id];
      (rooms || []).forEach(function (r) { r.items = r.items.filter(function (x) { return x.id !== id; }); });
      liveDirty = true;
    });
    // What the person pressed a moment ago still wins over a state that has
    // not caught up with it (the same holds the checks use).
    applyHeld();
  }
  // Redraw once per animation frame however many changes arrived (renderSoon). WHY no
  // pause while a slider is held or a name typed (redesign audit F1/F6): drawing is now
  // in place and leaves those alone, so a change made while you drag shows the moment
  // it arrives instead of waiting for the next push or check.
  function liveSchedule() {
    if (!liveDirty) return;
    liveDirty = false;
    renderSoon();
  }
`;
