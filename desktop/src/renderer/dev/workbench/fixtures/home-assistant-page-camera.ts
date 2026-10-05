// The Home page's cameras (home-page-next deck, C-camera "events", picked 2026-10-03; spec
// 2026-10-04 Parts 2 and 3; reshaped after Destin's real-use notes 2026-10-04: "the Watch live
// button should be a new, better styled button at the top of the card", "a shorter, scrollable
// event history in the card", "a Cameras tab that shows just the cameras, all live").
// Kept apart from home-assistant-page.ts so neither file outgrows the line budget;
// HOME_CAMERA_JS is pasted INSIDE the page's script, so it shares its helpers (esc, base,
// camNote, camCache, registry, render, renderSoon, thing, allItems, view, …).
//
// Two kinds of camera:
//  - one that gives Home Assistant a still picture (the Pi Zero) keeps its picture, refreshed
//    as before;
//  - a Nest camera gives NO still picture, only live video and recorded events. Its card is a
//    header (name, model, a Live button), the live picture or a playing clip right under it, and a
//    short scrolling list of recent events (what it saw, when, a thumbnail).
//
// The Cameras tab shows every camera in a grid. While it is the open tab and the page is visible,
// every Nest camera is live at once; leaving the tab or hiding the page stops them all, and a
// stream the app ended (it ends one after about 5 minutes) is started again quietly.
// Pressing a tile opens that camera's pop-up (the same card, with its recordings): one place for
// recordings instead of a second design.
//
// Where it all comes from: the events from Home Assistant's media browser over the same one-shot
// exchange the page's other registry calls use; a clip is fetched by the app
// (`youcoded.fetch(url, { as: 'video' })`) and handed back as a data: link for a <video>; live
// video is `youcoded.video`, which hands the page PICTURES, never an address or a stream.
//
// Escapes: this text lives in a template string inside another one, so every backslash in the
// page's own code is doubled and no backtick may appear.

export const HOME_CAMERA_CSS = `
  /* Camera card: header with a Live button, the picture, a short scrolling list of events */
  .cam-card .sub { font-size: 11px; color: var(--fg-muted); font-weight: 400; }
  .cam-head { justify-content: space-between; }
  .cam-live-btn { appearance: none; font: inherit; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 14px; border-radius: 9999px; cursor: pointer; flex-shrink: 0;
    color: var(--fg); border: 1px solid color-mix(in srgb, var(--fg) 14%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--panel)), var(--panel)); }
  .cam-live-btn::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); }
  .cam-live-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--fg) 30%, transparent); }
  .cam-live-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cam-live-btn:disabled { opacity: .5; cursor: default; }
  .cam-live-btn[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); box-shadow: 0 6px 18px -6px var(--accent); }
  .cam-live-btn[aria-pressed="true"]::before { background: rgb(235, 70, 55); box-shadow: 0 0 0 3px color-mix(in srgb, rgb(235, 70, 55) 35%, transparent); }
  .cam-evs-wait { min-height: 158px; }
  .cam-evs { display: flex; flex-direction: column; gap: 4px; max-height: 158px; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; scrollbar-width: thin; }
  .cam-ev { appearance: none; font: inherit; font-size: 12px; display: flex; align-items: center; gap: 10px; width: 100%; flex-shrink: 0; padding: 7px 10px; border: 0; border-radius: 14px; background: color-mix(in srgb, var(--fg) 6%, var(--panel)); color: var(--fg); cursor: pointer; text-align: left; }
  .cam-ev:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 10%, var(--panel)); }
  .cam-ev:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cam-ev[aria-pressed="true"] { box-shadow: inset 0 0 0 2px var(--accent); }
  .cam-ev:disabled { opacity: .6; cursor: default; }
  .cam-ev .th { width: 56px; height: 32px; border-radius: 9px; overflow: hidden; background: var(--inset); flex-shrink: 0; display: block; }
  .cam-ev .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cam-ev .w { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cam-ev time { color: var(--fg-muted); font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
  .cam-view { position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: 16px; overflow: hidden; background: #0e1116; padding: 0; border: 0; color: #e6e6e6; font: inherit; text-align: left; }
  .cam-view .cam-slot { position: absolute; inset: 0; display: block; }
  .cam-view canvas, .cam-view video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .cam-view img.cam { position: absolute; inset: 0; height: 100%; border-radius: 0; }
  .cam-view .cam-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 12px; text-align: center; font-size: 12px; line-height: 1.4; }
  .cam-badge { position: absolute; top: 8px; left: 8px; display: flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 9999px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 11px; font-weight: 600; z-index: 1; }
  .cam-badge::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #ff4d4d; }
  .cam-x { position: absolute; right: 8px; top: 8px; z-index: 1; }
  .cam-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .cam-note { font-size: 12px; color: var(--fg-muted); line-height: 1.4; }
  .cam-note a, .cam-actions a { color: var(--accent); font-size: 12px; }
  /* The Cameras tab */
  .cam-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .cam-open { cursor: pointer; width: 100%; }
  .cam-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cam-open:hover { box-shadow: 0 0 0 2px color-mix(in srgb, var(--fg) 25%, transparent); }
  .cam-cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 22px 12px 10px; background: linear-gradient(transparent, rgba(0, 0, 0, .72)); color: #fff; font-size: 13px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; pointer-events: none; z-index: 1; }
  .cam-cap .sub { color: rgba(255, 255, 255, .7); font-weight: 400; font-size: 11px; }
`;

export const HOME_CAMERA_JS = `
  // ── Camera card and the Cameras tab ─────────────────────────────────────
  // Per camera: events { state: 'loading' | 'ready' | 'failed', list, at },
  // clip { id, label, state: 'loading' | 'ready' | 'failed', why },
  // live { state: 'starting' | 'playing' | 'stopped', why }.
  var camEv = {}, clipEv = {}, clipEl = {}, liveCanvas = {}, liveVid = {}, clipBusy = false;
  var EVENTS_MAX = 20, EVENTS_EVERY_MS = 60000, EVENT_ROW_PX = 50, THUMBS_AHEAD = 6, CAM_MAX_LIVE = 4;
  var PLAYG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
  var CAMERA_ICO = ico('<path d="m23 7-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>', 16);
  function camState(id) { return camEv[id] || (camEv[id] = { events: { state: 'loading', list: [], at: 0 }, clip: null, live: null }); }
  function canVideo() { return typeof window.youcoded.video === 'function'; }
  function isCam(it) { return domain(it.id) === 'camera'; }
  function camsOnPage() { return allItems().map(function (x) { return x.it; }).filter(isCam); }
  // WHY (code review 10): a Nest camera is known from its maker at the first drawing, so its card starts as
  // the events card with its room reserved, not as an empty grey picture that then jumps into one.
  function camNoteOf(it) {
    var cm = camNote[it.id];
    if (!cm && !camCache[it.id] && /nest|google/i.test((it.maker || '') + ' ' + (it.model || ''))) cm = { nest: true };
    return cm;
  }
  function liveCount() { return Object.keys(liveVid).length; }

  // A Nest title is the local time and what it saw: "2026-10-04 18:48:02 Person".
  function eventFrom(c) {
    var title = String(c.title || ''), lower = title.toLowerCase();
    var m = /(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})(?::(\\d{2}))?/.exec(title);
    var at = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
    var what = lower.indexOf('person') >= 0 ? 'Person' : lower.indexOf('doorbell') >= 0 || lower.indexOf('chime') >= 0 ? 'Doorbell rang'
      : lower.indexOf('motion') >= 0 ? 'Motion' : lower.indexOf('sound') >= 0 ? 'Sound' : title.replace(m ? m[0] : '', '').trim() || 'Event';
    return { id: c.media_content_id, what: what, at: at, thumbUrl: c.thumbnail || null, thumb: null };
  }
  // "6:48 pm" today, "Yesterday 6:48 pm", else "Oct 3, 6:48 pm".
  function evTime(d) {
    if (!d) return '';
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
    var days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    return days <= 0 ? t : days === 1 ? 'Yesterday ' + t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
  }

  // Recent events, at most once a minute per camera. One exchange; thumbnails follow for the rows
  // that can be seen (the first few, then more as the list is scrolled) and are put into the page
  // without redrawing the card.
  function camEvents(it, force) {
    var st = camState(it.id);
    if (!base || !it.device || st.events.busy || (!force && st.events.at && Date.now() - st.events.at < EVENTS_EVERY_MS)) return;
    st.events.busy = true;
    registry([{ type: 'media_source/browse_media', media_content_id: 'media-source://nest/' + it.device }]).then(function (res) {
      var kids = res[0] && Array.isArray(res[0].children) ? res[0].children : [];
      var list = kids.filter(function (c) { return c && c.media_content_id && c.can_play !== false; }).map(eventFrom);
      list.sort(function (a, b) { return (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0); });
      list = list.slice(0, EVENTS_MAX);
      // Keep a thumbnail already fetched for the same event.
      (st.events.list || []).forEach(function (o) { list.forEach(function (e) { if (o.id === e.id) { e.thumb = o.thumb; e.thumbBusy = o.thumbBusy; } }); });
      st.events = { state: 'ready', list: list, at: Date.now() };
      renderSoon();
      camThumbs(st, 0);
    }, function () {
      st.events = { state: 'failed', list: [], at: Date.now() };
      renderSoon();
    });
  }
  function camThumbs(st, first) {
    st.events.list.slice(first, first + THUMBS_AHEAD).forEach(function (e) { if (!e.thumb && !e.thumbBusy && e.thumbUrl) camThumb(e); });
  }
  function camThumb(e) {
    e.thumbBusy = true;
    var u = /^https?:/i.test(e.thumbUrl) ? e.thumbUrl : base + e.thumbUrl;
    window.youcoded.fetch(u, { as: 'picture' }).then(function (r) {
      if (r.status !== 200 || String(r.body).indexOf('data:image/') !== 0) return;
      e.thumb = r.body;
      Array.prototype.forEach.call(document.querySelectorAll('img[data-thumb]'), function (img) { if (img.getAttribute('data-thumb') === e.id) img.src = r.body; });
    }, function () { /* a missing thumbnail leaves the grey box */ });
  }
  // Scrolling the list asks for the thumbnails now in view (and a few after), never all twenty at once.
  document.addEventListener('scroll', function (e) {
    var box = e.target && e.target.classList && e.target.classList.contains('cam-evs') ? e.target : null;
    var card = box && box.closest('[data-eid]');
    if (card) camThumbs(camState(card.getAttribute('data-eid')), Math.floor(box.scrollTop / EVENT_ROW_PX));
  }, true);

  // A clip: Home Assistant signs a short-lived address, the app fetches the video (only an mp4, at
  // most 4 MB) and hands back a data: link. It plays in the card's picture area.
  function playClip(it, ev) {
    if (clipBusy) return;
    var st = camState(it.id);
    // A clip replaces the live picture in a card; in the Cameras tab the tile keeps streaming behind the pop-up.
    if (view !== 'cameras') stopLive(it.id);
    st.clip = { id: ev.id, label: ev.what + ' ' + evTime(ev.at), state: 'loading' };
    delete clipEl[it.id];
    clipBusy = true;
    render();
    var fail = function (e) {
      st.clip = { id: ev.id, label: st.clip ? st.clip.label : '', state: 'failed', why: e && e.message ? e.message : 'That clip could not be loaded.' };
    };
    registry([{ type: 'media_source/resolve_media', media_content_id: ev.id, expires: 120 }]).then(function (res) {
      var url = res[0] && res[0].url;
      if (!url) throw new Error('Home Assistant sent no address for that clip.');
      return window.youcoded.fetch(/^https?:/i.test(url) ? url : base + url, { as: 'video' });
    }).then(function (r) {
      if (r.status >= 400) throw new Error('Home Assistant answered ' + r.status + ' for that clip.');
      if (String(r.body).indexOf('data:video/mp4') !== 0) throw new Error('That clip could not be played.');
      // The player is made here, not in the card's text, so a redraw of the page keeps the very
      // same player (and its place in the clip).
      var v = document.createElement('video');
      v.controls = true; v.muted = true; v.autoplay = true; v.setAttribute('playsinline', '');
      v.src = r.body;
      clipEl[it.id] = v;
      st.clip = { id: ev.id, label: st.clip ? st.clip.label : '', state: 'ready' };
    }).catch(fail).then(function () { clipBusy = false; render(); });
  }
  function closeClip(id) { var st = camState(id); st.clip = null; delete clipEl[id]; render(); }

  // Live video: pictures from the app, drawn on a canvas, each one handed back (ack) so the next
  // can come. quiet = started by the Cameras tab: it redraws on the next frame and keeps the
  // person's clip, and a stream that ended is started again without a flicker.
  var tabOn = {}, tabRetry = {}, tabFails = {};
  function startLive(it, quiet) {
    var st = camState(it.id), id = it.id;
    if (!canVideo()) return;
    var again = quiet && st.live && st.live.state === 'playing';
    if (!quiet) { stopLive(id); st.clip = null; delete clipEl[id]; }
    // WHY the canvas is reused when the tab restarts a stream: the last picture stays up for the moment the new one takes.
    var canvas = liveCanvas[id] || (liveCanvas[id] = document.createElement('canvas'));
    if (!again) st.live = { state: 'starting' };
    var at = Date.now(), frames = 0;
    (quiet ? renderSoon : render)();
    var v = window.youcoded.video('ha', id, {
      onFrame: function (bitmap, ack) {
        try {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
        } catch (e) { /* a frame that cannot be drawn is skipped */ }
        try { if (bitmap.close) bitmap.close(); } catch (e2) { /* already closed */ }
        ack();
        frames++;
        if (st.live && st.live.state !== 'playing') { st.live = { state: 'playing' }; if (quiet) tabFails[id] = 0; (quiet ? renderSoon : render)(); }
      },
      onState: function (state, why) {
        if (state === 'playing') { if (st.live && st.live.state !== 'playing') { st.live = { state: 'playing' }; (quiet ? renderSoon : render)(); } return; }
        if (state !== 'stopped') return;
        delete liveVid[id];
        if (quiet && tabOn[id]) { tabEnded(it, st, why, Date.now() - at > 10000 && frames > 0); return; }
        // The reason, in the app's own words; the card offers Play again.
        delete liveCanvas[id];
        st.live = { state: 'stopped', why: why || '' };
        render();
      }
    });
    liveVid[id] = v;
  }
  // A tab stream ended. The app ends every stream after about 5 minutes: one that had been playing
  // is started again at once, quietly. One that never really played (or the page was hidden) waits,
  // with a growing pause, and says why in the meantime.
  function tabEnded(it, st, why, played) {
    var id = it.id;
    if (!tabWanted()) { st.live = { state: 'stopped', why: why || '' }; renderSoon(); return; }
    var delay;
    if (played) { tabFails[id] = 0; delay = 300; }
    else {
      tabFails[id] = (tabFails[id] || 0) + 1;
      delay = Math.min(30000, 2000 * Math.pow(2, tabFails[id] - 1));
      st.live = { state: 'stopped', why: why || '' };
    }
    renderSoon();
    clearTimeout(tabRetry[id]);
    tabRetry[id] = setTimeout(function () { delete tabRetry[id]; camTabSync(); }, delay);
  }
  function stopLive(id) {
    var v = liveVid[id];
    if (v) { try { v.stop(); } catch (e) { /* already stopped */ } }
    delete liveVid[id]; delete liveCanvas[id];
    var st = camEv[id];
    if (st && st.live) { st.live = null; }
  }

  // ── The Cameras tab: every camera live at once, only while it is the open tab and the page is
  // visible. Called after every drawing and when the page is hidden or shown; it only ever
  // starts what is missing and stops what is not wanted, so calling it often is harmless.
  function tabWanted() { return view === 'cameras' && !document.hidden && !!rooms; }
  function camTabSync() {
    if (!canVideo()) return;
    if (!tabWanted()) {
      Object.keys(tabOn).forEach(function (id) { clearTimeout(tabRetry[id]); delete tabRetry[id]; stopLive(id); delete tabOn[id]; });
      return;
    }
    // Only cameras that give no still picture and are answering stream (a Pi Zero shows its picture instead).
    var cams = camsOnPage().filter(function (it) { var cm = camNoteOf(it); return cm && cm.nest && !gone(it); }).slice(0, CAM_MAX_LIVE);
    cams.forEach(function (it) {
      if (liveVid[it.id] || tabRetry[it.id]) return;
      tabOn[it.id] = true;
      startLive(it, true);
    });
  }
  // A live picture whose card is no longer on the page (another tab was opened, the card was hidden)
  // is stopped: nothing streams for something nobody can see. Checked a moment after each drawing,
  // when every area has been drawn.
  var sweepAt = null;
  function camSweepSoon() {
    if (sweepAt !== null) return;
    sweepAt = setTimeout(function () {
      sweepAt = null;
      Object.keys(liveVid).forEach(function (id) { if (!document.querySelector('[data-live-slot="' + id + '"]')) { stopLive(id); delete tabOn[id]; } });
    }, 0);
  }
  document.addEventListener('visibilitychange', function () { camTabSync(); });

  function nestFallback(it) {
    return '<a href="' + esc(base + (it.device ? '/config/devices/device/' + encodeURIComponent(it.device) : '/config/integrations/integration/nest')) + '" target="_blank" rel="noopener">Watch live in Home Assistant</a>';
  }
  // The card. A camera that gives a picture keeps it; a Nest camera gets its header with a Live
  // button, a live picture or a clip, and its recent events.
  function cameraCardHtml(it, cls, na, ctx) {
    var cm = camNoteOf(it);
    if (!cm || !cm.nest) {
      return '<div class="' + cls + ' col"><div class="line"><div class="name">' + esc(it.name) + (na && !camCache[it.id] ? '<div class="sub">Not responding</div>' : na ? '<div class="sub">Last picture · camera not responding</div>' : '') + '</div></div>' +
        (cm ? '<div class="cam-empty note">' + esc(cm.text) + (cm.href ? ' <a href="' + esc(base + cm.href) + '" target="_blank" rel="noopener">' + esc(cm.link) + '</a>' : '') + '</div>'
          : '<img class="cam" alt="" role="img" aria-label="' + esc(it.name) + '" data-cam="' + esc(it.id) + '"' + (camCache[it.id] ? ' src="' + camCache[it.id] + '"' : '') + '>') + '</div>';
    }
    var st = camState(it.id), ev = st.events, live = st.live, clip = st.clip, eid = esc(it.id), inTab = view === 'cameras';
    var running = live && live.state !== 'stopped';
    // In the Cameras tab the tile is already live behind the pop-up, so the card there has no Live button.
    var btn = canVideo() && !inTab ? '<button class="cam-live-btn" data-cam-act="' + (running ? 'stop' : 'live') + '" data-id="' + eid + '" aria-pressed="' + !!running + '"' + (na ? ' disabled' : '') + '>Live</button>' : '';
    var html = '<div class="' + cls + ' col cam-card"><div class="line cam-head"><div class="name">' + esc(it.name) + '<div class="sub">' + (na ? 'Not responding' : esc(it.model || 'Camera')) + '</div></div>' + btn + '</div>';
    if (running && !inTab) {
      html += '<div class="cam-view"><span class="cam-slot" data-live-slot="' + eid + '"></span>' + (live.state === 'playing' ? '<span class="cam-badge">LIVE</span>' : '<span class="cam-msg">Starting live view…</span>') + '</div>';
    } else if (clip) {
      html += clip.state === 'failed' ? '<div class="cam-note" role="status">' + esc(clip.why) + '</div>'
        : '<div class="cam-view"><span class="cam-slot" data-clip-slot="' + eid + '"></span>' + (clip.state === 'loading' ? '<span class="cam-msg">Loading clip…</span>' : '') +
          '<button class="yc-button yc-button--sm cam-x" data-cam-act="close" data-id="' + eid + '">Close</button></div>';
    }
    var stopped = live && live.state === 'stopped' && !inTab;
    if (stopped) html += '<div class="cam-note" role="status">Live view stopped' + (live.why ? ': ' + esc(live.why) : '') + '.</div>';
    if (ev.state === 'loading') html += '<div class="cam-evs-wait" aria-hidden="true"></div>';
    else if (ev.state === 'failed') html += '<div class="cam-note">Could not load recent events from Home Assistant.</div>';
    else if (ev.state === 'ready' && !ev.list.length) html += '<div class="cam-note">No recordings yet. Nest only saves clips when it can send events to Home Assistant.</div>';
    else if (ev.state === 'ready') {
      html += '<div class="cam-evs" aria-label="Recent recordings">' + ev.list.map(function (e) {
        return '<button class="cam-ev" data-cam-act="play" data-id="' + eid + '" data-ev="' + esc(e.id) + '" aria-pressed="' + !!(clip && clip.id === e.id) + '"' + (clipBusy ? ' disabled' : '') + '>' +
          '<span class="th">' + (e.thumb ? '<img data-thumb="' + esc(e.id) + '" alt="" src="' + e.thumb + '">' : '<img data-thumb="' + esc(e.id) + '" alt="">') + '</span>' +
          '<span class="w">' + esc(e.what) + '</span><time>' + esc(evTime(e.at)) + '</time></button>';
      }).join('') + '</div>';
    }
    if (stopped || !canVideo()) html += '<div class="cam-actions">' + (stopped && canVideo() ? '<button class="yc-button yc-button--sm" data-cam-act="live" data-id="' + eid + '">' + PLAYG + ' Play again</button>' : '') + nestFallback(it) + '</div>';
    return html + '</div>';
  }

  // One camera in the Cameras tab: its live picture (or its still picture, or why there is none),
  // a LIVE badge only while a live picture is really playing, and its name. Pressing it opens the pop-up.
  function camTileHtml(it) {
    var cm = camNoteOf(it), st = camState(it.id), live = st.live, eid = esc(it.id), na = gone(it), body, badge = '';
    if (cm && cm.nest) {
      if (na) body = '<span class="cam-msg">Not responding</span>';
      else if (!canVideo()) body = '<span class="cam-msg">This window cannot show live video.</span>';
      else if (live && live.state === 'stopped') body = '<span class="cam-slot" data-live-slot="' + eid + '"></span><span class="cam-msg" style="background:rgba(0,0,0,.55)">Live view stopped' + (live.why ? ': ' + esc(live.why) : '') + '. Trying again…</span>';
      else if (live && live.state === 'playing') { body = '<span class="cam-slot" data-live-slot="' + eid + '"></span>'; badge = '<span class="cam-badge">LIVE</span>'; }
      else body = '<span class="cam-slot" data-live-slot="' + eid + '"></span><span class="cam-msg">Starting live view…</span>';
    } else body = camCache[it.id] ? '<img class="cam" alt="" data-cam="' + eid + '" src="' + camCache[it.id] + '">' : '<span class="cam-msg">' + esc(cm ? cm.text : 'Looking for a picture…') + '</span>';
    return '<div class="cam-tile" data-eid="' + eid + '"><button class="cam-view cam-open" data-cam-act="open" data-id="' + eid + '" aria-label="Open ' + esc(it.name) + ' and its recordings">' + body + badge +
      '<span class="cam-cap"><span>' + esc(it.name) + '</span><span class="sub">' + (na ? 'Not responding' : esc(it.model || '')) + '</span></span></button></div>';
  }
  function camerasPageHtml() {
    var cams = ordered(camsOnPage(), 'cameras', function (x) { return x.id; });
    return cams.length ? '<div class="cam-grid">' + cams.map(camTileHtml).join('') + '</div>' : '<div class="yc-empty">No cameras on this page. Put cameras in rooms in Home Assistant.</div>';
  }
  // The tab's pill: how many cameras there are, or how many are live right now.
  function camerasChip() {
    var cams = camsOnPage(), n = cams.length, lv = cams.filter(function (it) { var s = camEv[it.id]; return s && s.live && s.live.state === 'playing'; }).length;
    return { id: 'cameras', label: 'Cameras', icon: CAMERA_ICO, on: lv > 0, main: lv ? lv + ' live' : n + ' camera' + (n === 1 ? '' : 's'), sub: lv ? n + ' camera' + (n === 1 ? '' : 's') : '', n: n };
  }

  // Players and the live canvas are made in JS, so a redraw of the page must put them back, and a
  // clip that was playing keeps playing. (The in-place drawing never touches a slot's contents;
  // this covers a slot that was drawn afresh.)
  function mediaHold() {
    Object.keys(clipEl).forEach(function (k) { var v = clipEl[k]; v.__was = !v.paused && !v.ended; });
  }
  function mediaBack() {
    Object.keys(liveCanvas).forEach(function (k) {
      var slot = document.querySelector('[data-live-slot="' + k + '"]');
      if (slot && liveCanvas[k].parentNode !== slot) slot.appendChild(liveCanvas[k]);
    });
    Object.keys(clipEl).forEach(function (k) {
      var slot = document.querySelector('[data-clip-slot="' + k + '"]'), v = clipEl[k];
      if (!slot || v.parentNode === slot) return;
      slot.appendChild(v);
      if (v.__was) { try { var p = v.play(); if (p && p.catch) p.catch(function () { /* the person can press play */ }); } catch (e) { /* no player here */ } }
    });
    camSweepSoon();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-cam-act]');
    if (!b) return;
    var id = b.getAttribute('data-id'), it = thing(id), act = b.getAttribute('data-cam-act');
    if (!it) return;
    if (act === 'live') startLive(it);
    else if (act === 'stop') { stopLive(id); render(); }
    else if (act === 'close') closeClip(id);
    else if (act === 'open') { camEvents(it); openDevice(id); }
    else if (act === 'play') {
      var evs = camState(id).events.list, pick = evs.filter(function (x) { return x.id === b.getAttribute('data-ev'); })[0];
      if (pick) playClip(it, pick);
    }
  });
`;
