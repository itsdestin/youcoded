// The Home page's instant updates (spec 2026-10-04, Part 1: "a card changes
// the moment the device does"). Kept apart from home-assistant-page.ts so
// neither file outgrows the line budget; HOME_LIVE_JS is pasted INSIDE the
// page's script, so it shares its helpers (rooms, render, banner, applyHeld,
// applyHeldVals, dragging, load, …).
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
  var live = { sock: null, state: 'none', authed: false, on: false, msg: 0, subId: 0, sig: '', raw: {}, at: {} };
  var LIVE_POLL_MS = 60000, RECONNECT_NOTE_MS = 5000;
  var liveDirty = false, noteTimer = null;
  // Home Assistant's attribute names → the fields the rooms template produces.
  var LIVE_ATTRS = [
    ['friendly_name', 'name'], ['brightness', 'brightness'], ['supported_color_modes', 'modes'], ['current_temperature', 'cur'],
    ['temperature', 'target'], ['min_temp', 'min'], ['max_temp', 'max'], ['target_temp_step', 'step'], ['volume_level', 'vol'],
    ['media_title', 'title'], ['rgb_color', 'rgb'], ['color_temp_kelvin', 'k'], ['hvac_modes', 'modesHvac'], ['hvac_action', 'action'],
    ['device_class', 'dc'], ['current_activity', 'activity'], ['app_name', 'app'], ['source', 'source'], ['media_content_id', 'cid'],
    ['is_volume_muted', 'muted'], ['group_members', 'group']
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
    if (!live.sock || live.state !== 'open' || !live.authed || !rooms) return;
    var ids = itemIds(), sig = ids.join('|');
    if (sig === live.sig && live.subId) return;
    if (live.subId) liveSend({ type: 'unsubscribe_events', subscription: live.subId });
    // WHY the id is claimed BEFORE sending: an answer can come back inside the
    // very call that sends (the pretend one does), and must find its id waiting.
    live.sig = sig; live.subId = live.msg + 1;
    liveSend({ type: 'subscribe_entities', entity_ids: ids });
  }
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
    live.authed = false; live.subId = 0; live.sig = ''; live.msg = 0; live.raw = {}; live.at = {};
    if (state !== 'open') liveRate(false);
    if (state === 'closed') live.sock = null;
  }
  function liveMessages(texts) {
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
  // WHY the arrival time (redesign audit F4, "the newest one wins"): a check that was
  // asked before this arrived must not overwrite it (see liveReplay).
  function liveApply(id, raw, replay) {
    if (!replay) live.at[id] = Date.now();
    var it = thing(id);
    if (!it) return;
    var before = JSON.stringify(it);
    it.state = raw.s;
    var a = raw.a || {};
    LIVE_ATTRS.forEach(function (p) { if (p[0] in a) it[p[1]] = a[p[0]]; else if (p[0] !== 'friendly_name') it[p[1]] = null; });
    it.features = a.supported_features == null ? 0 : a.supported_features;
    if (typeof raw.lc === 'number') it.since = new Date(raw.lc * 1000).toISOString();
    if (JSON.stringify(it) !== before) liveDirty = true;
  }
  // After a check's answer is laid in: every pushed state that arrived since the check
  // was ASKED is at least as new as the answer (it either predates the answer's picture,
  // and then agrees with it, or follows it), so it goes back on top.
  function liveReplay(since) {
    Object.keys(live.raw).forEach(function (id) { if ((live.at[id] || 0) >= since) liveApply(id, live.raw[id], true); });
  }
  function liveEvent(ev) {
    var added = ev.a || {}, changed = ev.c || {};
    Object.keys(added).forEach(function (id) { live.raw[id] = { s: added[id].s, a: Object.assign({}, added[id].a), lc: added[id].lc }; liveApply(id, live.raw[id]); });
    Object.keys(changed).forEach(function (id) {
      var raw = live.raw[id] || (live.raw[id] = { s: '', a: {}, lc: 0 });
      var plus = changed[id]['+'] || {}, minus = changed[id]['-'] || {};
      if ('s' in plus) raw.s = plus.s;
      if ('lc' in plus) raw.lc = plus.lc;
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
    applyHeld(); applyHeldVals();
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
