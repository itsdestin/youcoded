// The Home page's history: a device's own pop-up and the Activity tab
// (round 5 design deck, 2026-10-04: C-device "popup", C-activity "tab"). Kept
// apart from home-assistant-page.ts so neither file outgrows the line budget;
// HOME_HISTORY_JS is pasted INSIDE the page's script, so it shares its
// helpers (esc, thing, roomOf, itemHtml, render, …) and state (view, rooms).
//
// Where the history comes from: Home Assistant's logbook (`/api/logbook`),
// which keeps about ten days. It names the person or automation behind a
// change when it knows; a change made on the device itself, in the Hue app or
// through Google Home reaches it with no source, and the page says exactly
// that (a note once above the list: "from a switch or another app") rather than guessing which.

export const HOME_HISTORY_CSS = `
  /* Activity tab */
  .act-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .fchip { appearance: none; font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); cursor: pointer; }
  .fchip:hover { border-color: var(--fg-muted); color: var(--fg); }
  .fchip[aria-pressed="true"] { background: var(--fg); color: var(--canvas); border-color: var(--fg); }
  .fchip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .fsep { width: 1px; height: 18px; background: var(--edge); margin: 0 4px; }
  .act-list { display: flex; flex-direction: column; gap: 6px; }
  .act-day { font-size: 12px; font-weight: 600; color: var(--fg-2); margin: 8px 0 0; }
  .ev { display: grid; grid-template-columns: 70px 30px 1fr auto; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--radius-md, 8px); background: var(--inset); border: 1px solid var(--edge-dim); font-size: 13px; }
  .ev .when { font-family: var(--font-mono); font-size: 12px; color: var(--fg-muted); }
  .ev .i { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: color-mix(in srgb, var(--d) 22%, transparent); color: color-mix(in srgb, var(--d) 70%, var(--fg)); }
  .ev .what { min-width: 0; }
  .ev .by { display: block; font-size: 11px; color: var(--fg-muted); }
  .ev .where { font-size: 11px; color: var(--fg-muted); text-align: right; }
  .ev-name { appearance: none; border: 0; background: none; padding: 0; font: inherit; color: inherit; font-weight: 600; cursor: pointer; text-align: left; }
  .ev-name:hover { text-decoration: underline; }
  .act-more { align-self: center; margin-top: 6px; }
  /* A device's pop-up */
  .dlg-scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); z-index: 50; display: grid; place-items: center; padding: 24px; }
  .dlg { width: min(720px, 100%); max-height: 100%; overflow: auto; border-radius: var(--radius-lg, 12px); border: 1px solid var(--edge); background: var(--panel); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  .dlg-head { display: flex; align-items: center; gap: 10px; }
  .dlg-head .t { flex: 1; min-width: 0; }
  .dlg-head h2 { font-size: 16px; font-weight: 600; }
  .dlg-head .vsub { font-size: 12px; }
  .dlg-x { appearance: none; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); display: grid; place-items: center; cursor: pointer; padding: 0; }
  .dlg-x:hover { color: var(--fg); border-color: var(--fg-muted); }
  .dlg-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dlg-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 640px) { .dlg-cols { grid-template-columns: 1fr; } }
  .dlg-sec { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); margin-bottom: 4px; }
  .hrow { display: grid; grid-template-columns: 72px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid var(--edge-dim); font-size: 13px; }
  .hrow:first-of-type { border-top: 0; }
  .hrow .when { color: var(--fg-muted); font-family: var(--font-mono); font-size: 12px; padding-top: 1px; }
  .hrow .by { display: block; font-size: 11px; color: var(--fg-muted); margin-top: 2px; }
  .hdot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--d, var(--fg-faint)); margin-right: 6px; vertical-align: 1px; }
  .about { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; margin: 0 0 10px; }
  .about dt { color: var(--fg-muted); }
  .about dd { margin: 0; overflow-wrap: anywhere; }
  .dlg .muted { font-size: 12px; color: var(--fg-muted); }
  [data-eid] .mname, [data-eid] > .line > .name { cursor: pointer; }
`;

export const HOME_HISTORY_JS = String.raw`
  // ── History: the Activity tab and a device's pop-up ─────────────────────
  var HIST_DAYS_MAX = 10;
  var hist = { events: [], days: 1, at: 0, loading: false, failed: false };
  var devHist = { id: null, events: [], at: 0, loading: false, failed: false };
  var actRoom = 'all', actKind = 'all';
  // How many history lines each device showed last time, so its pop-up reserves that much room (code review 9).
  var histRows = {};
  // A workbench screen can open with a device's pop-up showing (saved dlg).
  var dlgId = typeof saved.dlg === 'string' ? saved.dlg : null, dlgReturn = null;
  var ACTIVITY = ico('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', 16);
  var CLOSE = ico('<path d="M18 6 6 18M6 6l12 12"/>', 14);
  var KIND_OF_DOMAIN = { light: 'lights', scene: 'lights', media_player: 'media', remote: 'media', climate: 'climate', camera: 'cameras' };
  var KIND_NAMES = [['lights', 'Lights'], ['media', 'Media'], ['climate', 'Climate'], ['cameras', 'Cameras'], ['problems', 'Problems']];

  function isoAgo(days) { return new Date(Date.now() - days * 86400000).toISOString(); }
  function logbook(days, entity) {
    var q = '?end_time=' + encodeURIComponent(new Date().toISOString()) + (entity ? '&entity=' + encodeURIComponent(entity) : '');
    return window.youcoded.fetch(base + '/api/logbook/' + encodeURIComponent(isoAgo(days)) + q, {}).then(function (r) {
      if (r.status === 401) throw new Error('Home Assistant did not accept the key.');
      if (r.status >= 400) throw new Error('Home Assistant answered ' + r.status + '.');
      var list = JSON.parse(r.body);
      return Array.isArray(list) ? list : [];
    });
  }
  // The house's activity: fetched when the tab opens, then again with the
  // page's own checks while it stays open (at most every 30 seconds).
  function refreshHistory(force) {
    if (!base || hist.loading) return;
    // WHY stale (U9): a change made from this page must show in Activity at the next check, not up to 30 seconds later.
    if (!force && !hist.stale && Date.now() - hist.at < 30000) return;
    hist.loading = true; hist.stale = false;
    logbook(hist.days).then(function (list) { hist.events = list; hist.failed = false; })
      .catch(function () { hist.failed = true; })
      .then(function () { hist.loading = false; hist.at = Date.now(); renderSoon(); });
  }
  function refreshDevice(force) {
    var id = dlgId;
    if (!base || !id || devHist.loading) return;
    if (!force && devHist.id === id && Date.now() - devHist.at < 30000) return;
    devHist.loading = true;
    logbook(3, id).then(function (list) { if (dlgId === id) { devHist.events = list; devHist.failed = false; } })
      .catch(function () { if (dlgId === id) devHist.failed = true; })
      .then(function () { devHist.loading = false; devHist.id = id; devHist.at = Date.now(); renderSoon(); });
  }

  // One logbook line in words. Only what the page knows how to say.
  function evWords(e) {
    var d = domain(e.entity_id || ''), s = e.state;
    if (s === 'unavailable') return 'stopped responding';
    if (d === 'scene') return 'turned on';
    if (d === 'light' || d === 'remote') return s === 'on' ? 'turned on' : s === 'off' ? 'turned off' : null;
    if (d === 'media_player') return ({ playing: 'started playing', paused: 'paused', idle: 'stopped', off: 'turned off', on: 'turned on' })[s] || null;
    if (d === 'climate') return MODE_NAMES[s] ? (s === 'off' ? 'turned off' : 'set to ' + MODE_NAMES[s]) : null;
    if (d === 'camera') return s === 'recording' ? 'started recording' : null;
    return null;
  }
  // Who did it, as far as Home Assistant knows (see the top of this file).
  function evWho(e) {
    if (e.context_entity_id_name) return 'by ' + e.context_entity_id_name;
    if (e.context_user_id) {
      var p = (extras.people || []).filter(function (x) { return x.user === e.context_user_id; })[0];
      return 'by ' + (p ? p.name : 'someone in Home Assistant');
    }
    // WHY empty (U9, UX review 2): "on the device or another app" sat under most rows. Rows with no name beside them are
    // explained once, by a line above the list (activityHtml), and are not repeated.
    return '';
  }
  function evKind(e) { return e.state === 'unavailable' ? 'problems' : KIND_OF_DOMAIN[domain(e.entity_id || '')] || null; }
  // The page's devices and scenes only, newest first; a burst of changes to
  // one device inside 20 seconds (a TV flicking between idle and playing)
  // shows as its last one.
  function pageEvents(list) {
    var mine = {};
    var all = allItems();
    all.forEach(function (x) { if (domain(x.it.id) !== 'remote') mine[x.it.id] = x; });
    // A TV is switched through its remote, which has no card of its own, so
    // the remote's changes are told as the TV's.
    all.forEach(function (x) { if (isTv(x.it)) { var rc = remoteFor(x.it, x.room); if (rc) mine[rc.id] = { it: x.it, room: x.room }; } });
    (rooms || []).forEach(function (r) { (r.scenes || []).forEach(function (sc) { mine[sc.id] = { it: { id: sc.id, name: sceneName(sc, r) }, room: r, scene: true }; }); });
    // A line that repeats the state before it (a TV still playing, only a
    // new title) says nothing new, so it is dropped.
    // WHY sorted here (U9): this walk assumes oldest first, and Home Assistant does send it that way, but nothing here proved it;
    // an out-of-order answer showed 1:45, 1:44, then 1:54 and 12:54. Stable for equal times.
    // Cheap check first (same-format ISO times compare as text), so the usual in-order answer costs no date parsing.
    var inOrder = list.every(function (x, i) { return !i || String(list[i - 1].when) <= String(x.when); });
    if (!inOrder) list = list.map(function (x, i) { return [x, i, Date.parse(x.when)]; }).sort(function (a, b) { return a[2] - b[2] || a[1] - b[1]; }).map(function (p) { return p[0]; });
    var prev = {}, fresh = [];
    list.forEach(function (e) { if (prev[e.entity_id] !== e.state || domain(e.entity_id || '') === 'scene') fresh.push(e); prev[e.entity_id] = e.state; });
    var out = [];
    for (var i = fresh.length - 1; i >= 0; i--) {
      var e = fresh[i], own = mine[e.entity_id];
      if (!own) continue;
      var words = evWords(e);
      if (!words) continue;
      var t = Date.parse(e.when);
      var last = out[out.length - 1];
      if (last && last.id === e.entity_id && last.t - t < 20000) continue;
      out.push({ id: e.entity_id, devId: own.it.id, name: own.scene ? 'Scene ' + own.it.name : own.it.name, room: own.room, t: t, words: words, who: evWho(e), kind: evKind(e), scene: !!own.scene, state: e.state });
    }
    return out;
  }
  function evColour(ev) {
    if (ev.kind === 'problems') return 'rgb(240, 165, 40)';
    var it = thing(ev.devId);
    if (ev.kind === 'lights') return it && !ev.scene ? colourOf(it) : 'rgb(255, 176, 102)';
    if (ev.kind === 'media') return 'var(--accent)';
    if (ev.kind === 'climate') return ev.state === 'heat' ? 'rgb(240, 120, 60)' : 'rgb(77, 163, 255)';
    return 'var(--fg-muted)';
  }
  function evIcon(ev) {
    if (ev.kind === 'problems') return ALERT;
    if (ev.kind === 'lights') return ev.scene ? SPARK : BULB;
    if (ev.kind === 'climate') return THERMO;
    if (ev.kind === 'media') { var it = thing(ev.devId); return it && isTv(it) ? TV : SPEAKER; }
    return ACTIVITY;
  }
  function clock(t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase(); }
  function dayName(t) {
    var d = new Date(t), now = new Date();
    var start = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((start(now) - start(d)) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function evRow(ev) {
    return '<div class="ev" data-k="' + esc(ev.id + '|' + ev.t) + '" style="--d:' + evColour(ev) + '"><span class="when">' + esc(clock(ev.t)) + '</span><span class="i">' + evIcon(ev) + '</span>' +
      '<span class="what">' + (ev.scene ? '<b>' + esc(ev.name) + '</b>' : '<button class="ev-name" data-dev="' + esc(ev.devId) + '">' + esc(ev.name) + '</button>') + ' ' + esc(ev.words) +
      (ev.who ? '<span class="by">' + esc(ev.who) + '</span>' : '') + '</span><span class="where">' + esc(ev.room.name) + '</span></div>';
  }
  function activityHtml() {
    if (!hist.at && !hist.failed) return '<div class="yc-empty">Reading the house’s history…</div>';
    if (hist.failed && !hist.events.length) return '<div class="yc-empty">Home Assistant did not send its history. <button class="yc-button yc-button--sm" data-hist-retry="1">Try again</button></div>';
    var evs = pageEvents(hist.events);
    var roomIds = {}; evs.forEach(function (e) { roomIds[e.room.id] = e.room.name; });
    var filters = '<div class="act-filters" role="group" aria-label="Show"><button class="fchip" data-act-room="all" aria-pressed="' + (actRoom === 'all') + '">All rooms</button>' +
      ordered(rooms, 'rooms', function (r) { return r.id; }).filter(function (r) { return roomIds[r.id]; }).map(function (r) {
        return '<button class="fchip" data-act-room="' + esc(r.id) + '" aria-pressed="' + (actRoom === r.id) + '">' + esc(r.name) + '</button>';
      }).join('') + '<span class="fsep" aria-hidden="true"></span>' +
      KIND_NAMES.map(function (k) { return '<button class="fchip" data-act-kind="' + k[0] + '" aria-pressed="' + (actKind === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div>';
    // The once-only explanation for rows with no name beside them (U9).
    var unnamed = evs.some(function (e) { return !e.who; }) ? '<div class="yc-caption">Changes with no name beside them came from a switch or another app.</div>' : '';
    var shown = evs.filter(function (e) { return (actRoom === 'all' || e.room.id === actRoom) && (actKind === 'all' || e.kind === actKind); });
    var body = '', day = null;
    shown.forEach(function (e) { var dn = dayName(e.t); if (dn !== day) { day = dn; body += '<div class="act-day">' + esc(dn) + '</div>'; } body += evRow(e); });
    if (!shown.length) body = '<div class="yc-empty">' + (evs.length ? 'Nothing matches. Press All rooms, or the same kind again, to see everything.' : 'Nothing has changed in the last ' + (hist.days === 1 ? 'day' : hist.days + ' days') + '.') + '</div>';
    var more = hist.days < HIST_DAYS_MAX ? '<button class="yc-button yc-button--sm act-more" data-hist-more="1"' + (hist.loading ? ' disabled' : '') + '>' + (hist.loading ? 'Loading…' : 'Show the day before') + '</button>' : '<div class="yc-caption act-more">Home Assistant keeps about ' + HIST_DAYS_MAX + ' days.</div>';
    return '<div class="act-list">' + filters + unnamed + body + more + '</div>';
  }
  // WHY cached (code review F11): the pill's count walked the whole loaded logbook on EVERY drawing (any push, any tab). It now
  // recounts only when the logbook, the rooms or the day changes, which is once per check at most.
  var actCount = { events: null, rooms: null, day: 0, text: '' };
  function activityCount() {
    if (!hist.at) return '';
    var dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    var day = dayStart.getTime();
    if (actCount.events !== hist.events || actCount.rooms !== rooms || actCount.day !== day) {
      var n = pageEvents(hist.events).filter(function (e) { return e.t >= day; }).length;
      actCount = { events: hist.events, rooms: rooms, day: day, text: n + ' change' + (n === 1 ? '' : 's') + ' today' };
    }
    return actCount.text;
  }

  // ── A device's pop-up ────────────────────────────────────────────────────
  function dialogHtml() {
    var it = dlgId ? thing(dlgId) : null;
    if (!it) return '';
    var room = roomOf(it.id);
    var entry = entryById(it.entry);
    var evs = devHist.id === it.id ? pageEvents(devHist.events).filter(function (e) { return e.devId === it.id; }).slice(0, 8) : [];
    var histHtml = devHist.id !== it.id || (devHist.loading && !evs.length) ? '<div class="muted">Reading its history…</div>'
      : devHist.failed ? '<div class="muted">Home Assistant did not send its history.</div>'
      : evs.length ? evs.map(function (e) {
        return '<div class="hrow"><span class="when">' + esc(dayName(e.t) === 'Today' ? clock(e.t) : dayName(e.t).split(',')[0]) + '</span><span><span class="hdot" style="--d:' + evColour(e) + '"></span>' + esc(e.words.charAt(0).toUpperCase() + e.words.slice(1)) + (e.who ? '<span class="by">' + esc(e.who) + '</span>' : '') + '</span></div>';
      }).join('') : '<div class="muted">No changes in the last 3 days.</div>';
    // WHY rows, not a fixed height (code review 9): the area is sized for the lines it will hold, from what this
    // device showed last time (3 the first time), so it does not jump when the history arrives.
    var loaded = devHist.id === it.id && !devHist.loading, hrows = loaded ? Math.max(evs.length, 1) : (histRows[it.id] || 3);
    if (loaded) histRows[it.id] = hrows;
    var about = [['Maker', it.maker], ['Model', it.model], ['Connects through', entry ? (entry.title && entry.title !== prettyDomain(entry.domain) ? prettyDomain(entry.domain) + ' · ' + entry.title : prettyDomain(entry.domain)) : null], ['Room', room ? room.name : null], ['Software', it.sw]]
      .filter(function (a) { return a[1]; });
    var since = it.since ? (gone(it) ? 'Not responding since ' : 'Last changed ') + ago(it.since) : '';
    return '<div class="dlg-scrim" data-dlg-scrim="1"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">' +
      '<div class="dlg-head"><div class="t"><h2 id="dlg-title">' + esc(it.name) + '</h2><span class="vsub">' + esc([room ? room.name : '', since].filter(Boolean).join(' · ')) + '</span></div>' +
      '<button class="dlg-x" data-dlg-close="1" aria-label="Close">' + CLOSE + '</button></div>' +
      itemHtml(it, null) +
      '<div class="dlg-cols"><section><div class="dlg-sec">History</div><div class="dlg-hist" style="min-height:' + (hrows * 1.9) + 'em">' + histHtml + '</div></section>' +
      '<section><div class="dlg-sec">About this device</div>' + (about.length ? '<dl class="about">' + about.map(function (a) { return '<dt>' + esc(a[0]) + '</dt><dd>' + esc(a[1]) + '</dd>'; }).join('') + '</dl>' : '<div class="muted">Home Assistant has no details for it.</div>') +
      (it.device ? '<a class="yc-button yc-button--sm" href="' + esc(base + '/config/devices/device/' + encodeURIComponent(it.device)) + '" target="_blank" rel="noopener">Open in Home Assistant ' + OUT + '</a>' : '') + '</section></div></div></div>';
  }
  function openDevice(id) {
    if (!thing(id)) return;
    dlgReturn = document.activeElement;
    dlgId = id;
    render();
    refreshDevice(true);
    var d = document.querySelector('.dlg'); if (d) d.focus();
  }
  function closeDevice() {
    dlgId = null;
    render();
    if (dlgReturn && dlgReturn.focus && document.contains(dlgReturn)) dlgReturn.focus();
    dlgReturn = null;
  }

  // Opening a device: its name (on a speaker, TV, thermostat or camera, where
  // the card itself is not a switch), a right-click or a long press anywhere
  // on its card, or Details in Edit. A long press is how Apple Home opens a
  // device, and leaves a plain press to switch it, as today.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (t.closest('[data-dlg-close]') || t.getAttribute('data-dlg-scrim')) { closeDevice(); return; }
    var dev = t.closest('[data-dev]');
    if (dev) { openDevice(dev.getAttribute('data-dev')); return; }
    var nm = t.closest('.mname, [data-eid] > .line > .name, .clim > .line > .name');
    var card = nm && nm.closest('[data-eid]');
    if (card && !dlgId) { openDevice(card.getAttribute('data-eid')); return; }
    var ar = t.closest('[data-act-room]');
    if (ar) { var r = ar.getAttribute('data-act-room'); actRoom = actRoom === r ? 'all' : r; render(); return; }
    var ak = t.closest('[data-act-kind]');
    if (ak) { var k = ak.getAttribute('data-act-kind'); actKind = actKind === k ? 'all' : k; render(); return; }
    if (t.closest('[data-hist-more]')) { hist.days = Math.min(HIST_DAYS_MAX, hist.days + 1); refreshHistory(true); render(); return; }
    if (t.closest('[data-hist-retry]')) { refreshHistory(true); return; }
  });
  document.addEventListener('contextmenu', function (e) {
    var card = e.target.closest && e.target.closest('[data-eid]');
    if (!card || dlgId || editing) return;
    e.preventDefault();
    openDevice(card.getAttribute('data-eid'));
  });
  var pressTimer = null, pressed = false;
  document.addEventListener('pointerdown', function (e) {
    var card = e.target.closest && e.target.closest('[data-eid]');
    if (!card || dlgId || editing || e.button !== 0 || e.target.closest('input, select')) return;
    pressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () { pressed = true; openDevice(card.getAttribute('data-eid')); }, 550);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) { document.addEventListener(n, function () { clearTimeout(pressTimer); }); });
  // The press that opened the pop-up must not also switch the light.
  document.addEventListener('click', function (e) { if (pressed) { pressed = false; e.stopPropagation(); e.preventDefault(); } }, true);
  document.addEventListener('keydown', function (e) {
    if (!dlgId) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDevice(); return; }
    // Tab stays inside the pop-up while it is open.
    if (e.key === 'Tab') {
      var d = document.querySelector('.dlg');
      var f = d ? d.querySelectorAll('button:not([disabled]), a[href], input, select') : [];
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === d)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
`;
