// The Home page's camera card (home-page-next deck, C-camera "events", picked
// 2026-10-03; spec 2026-10-04 Parts 2 and 3). Kept apart from
// home-assistant-page.ts so neither file outgrows the line budget; HOME_CAMERA_JS
// is pasted INSIDE the page's script, so it shares its helpers (esc, base,
// camNote, camCache, registry, render, …).
//
// Two kinds of camera:
//  - one that gives Home Assistant a still picture (the Pi Zero) keeps its
//    picture, refreshed as before;
//  - a Nest camera gives NO still picture, only live video and recorded events.
//    Its card is the name, a list of recent events (person / motion / doorbell,
//    with a time and a thumbnail), and a Watch live button. Pressing an event
//    plays its clip; Watch live draws the app's live video into a canvas with a
//    LIVE badge and a Stop button.
//
// Where it all comes from: the events from Home Assistant's media browser over
// the same one-shot exchange the page's other registry calls use; a clip is
// fetched by the app (`youcoded.fetch(url, { as: 'video' })`) and handed back
// as a data: link for a <video>; live video is `youcoded.video`, which hands
// the page PICTURES, never an address or a stream.
//
// Escapes: this text lives in a template string inside another one, so every
// backslash in the page's own code is doubled and no backtick may appear.

export const HOME_CAMERA_CSS = `
  /* Camera card: recent events, a clip, live video (C-camera "events") */
  .cam-card .sub { font-size: 11px; color: var(--fg-muted); font-weight: 400; }
  .cam-evs-wait { min-height: 9em; }
  .cam-evs { display: flex; flex-direction: column; gap: 4px; }
  .cam-ev { appearance: none; font: inherit; font-size: 12px; display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border: 0; border-radius: 8px; background: var(--well); color: var(--fg); cursor: pointer; text-align: left; }
  .cam-ev:hover:not(:disabled) { background: var(--inset); }
  .cam-ev:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cam-ev[aria-pressed="true"] { box-shadow: inset 0 0 0 2px var(--accent); }
  .cam-ev:disabled { opacity: .6; cursor: default; }
  .cam-ev .th { width: 56px; height: 32px; border-radius: 5px; overflow: hidden; background: var(--inset); flex-shrink: 0; display: block; }
  .cam-ev .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cam-ev .w { flex: 1; min-width: 0; }
  .cam-ev time { color: var(--fg-muted); font-family: var(--font-mono); font-size: 11px; }
  .cam-view { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-md, 8px); overflow: hidden; background: #0e1116; }
  .cam-view .cam-slot { position: absolute; inset: 0; }
  .cam-view canvas, .cam-view video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .cam-view .cam-msg { position: absolute; inset: 0; display: grid; place-items: center; color: #e6e6e6; font-size: 12px; }
  .cam-badge { position: absolute; top: 8px; left: 8px; display: flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 9999px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 11px; font-weight: 600; }
  .cam-badge::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #ff4d4d; }
  .cam-stop { position: absolute; right: 8px; bottom: 8px; }
  .cam-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .cam-note { font-size: 12px; color: var(--fg-muted); line-height: 1.4; }
  .cam-note a, .cam-actions a { color: var(--accent); font-size: 12px; }
`;

export const HOME_CAMERA_JS = `
  // ── Camera card ─────────────────────────────────────────────────────────
  // Per camera: events { state: 'loading' | 'ready' | 'failed', list, at },
  // clip { id, label, state: 'loading' | 'ready' | 'failed', src, why },
  // live { state: 'starting' | 'playing' | 'stopped', why }.
  var camEv = {}, clipEl = {}, liveCanvas = {}, liveVid = {}, clipBusy = false;
  var EVENTS_MAX = 6, EVENTS_EVERY_MS = 60000;
  var PLAYG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
  function camState(id) { return camEv[id] || (camEv[id] = { events: { state: 'loading', list: [], at: 0 }, clip: null, live: null }); }
  function canVideo() { return typeof window.youcoded.video === 'function'; }

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

  // Recent events, at most once a minute per camera. One exchange; thumbnails
  // follow one by one and are put into the page without redrawing the card.
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
      var old = st.events.list || [];
      list.forEach(function (e) { old.forEach(function (o) { if (o.id === e.id) e.thumb = o.thumb; }); });
      st.events = { state: 'ready', list: list, at: Date.now() };
      renderSoon();
      list.forEach(function (e) { if (!e.thumb && e.thumbUrl) camThumb(e); });
    }, function () {
      st.events = { state: 'failed', list: [], at: Date.now() };
      renderSoon();
    });
  }
  function camThumb(e) {
    var u = /^https?:/i.test(e.thumbUrl) ? e.thumbUrl : base + e.thumbUrl;
    window.youcoded.fetch(u, { as: 'picture' }).then(function (r) {
      if (r.status !== 200 || String(r.body).indexOf('data:image/') !== 0) return;
      e.thumb = r.body;
      Array.prototype.forEach.call(document.querySelectorAll('img[data-thumb]'), function (img) { if (img.getAttribute('data-thumb') === e.id) img.src = r.body; });
    }, function () { /* a missing thumbnail leaves the grey box */ });
  }

  // A clip: Home Assistant signs a short-lived address, the app fetches the
  // video (only an mp4, at most 4 MB) and hands back a data: link.
  function playClip(it, ev) {
    if (clipBusy) return;
    var st = camState(it.id);
    stopLive(it.id);
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
      // The player is made here, not in the card's text, so a redraw of the
      // page keeps the very same player (and its place in the clip).
      var v = document.createElement('video');
      v.controls = true; v.muted = true; v.autoplay = true; v.setAttribute('playsinline', '');
      v.src = r.body;
      clipEl[it.id] = v;
      st.clip = { id: ev.id, label: st.clip ? st.clip.label : '', state: 'ready' };
    }).catch(fail).then(function () { clipBusy = false; render(); });
  }
  function closeClip(id) { var st = camState(id); st.clip = null; delete clipEl[id]; render(); }

  // Live video: pictures from the app, drawn on a canvas, each one handed back
  // (ack) so the next can come.
  function startLive(it) {
    var st = camState(it.id);
    if (!canVideo()) return;
    stopLive(it.id);
    st.clip = null; delete clipEl[it.id];
    var canvas = document.createElement('canvas');
    liveCanvas[it.id] = canvas;
    st.live = { state: 'starting' };
    render();
    var v = window.youcoded.video('ha', it.id, {
      onFrame: function (bitmap, ack) {
        try {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
        } catch (e) { /* a frame that cannot be drawn is skipped */ }
        try { if (bitmap.close) bitmap.close(); } catch (e2) { /* already closed */ }
        ack();
        if (st.live && st.live.state === 'starting') { st.live = { state: 'playing' }; render(); }
      },
      onState: function (state, why) {
        if (state === 'playing') { if (st.live) st.live = { state: 'playing' }; render(); return; }
        if (state === 'stopped') {
          // The reason, in the app's own words; the card offers Play again.
          delete liveVid[it.id]; delete liveCanvas[it.id];
          st.live = { state: 'stopped', why: why || '' };
          render();
        }
      }
    });
    liveVid[it.id] = v;
  }
  function stopLive(id) {
    var v = liveVid[id];
    if (v) { try { v.stop(); } catch (e) { /* already stopped */ } }
    delete liveVid[id]; delete liveCanvas[id];
    var st = camEv[id];
    if (st && st.live) { st.live = null; }
  }

  function nestFallback(it) {
    return '<a href="' + esc(base + (it.device ? '/config/devices/device/' + encodeURIComponent(it.device) : '/config/integrations/integration/nest')) + '" target="_blank" rel="noopener">Watch live in Home Assistant</a>';
  }
  // The card. A camera that gives a picture keeps it; a Nest camera gets its
  // events, a clip or live view, and Watch live.
  function cameraCardHtml(it, cls, na, ctx) {
    var cm = camNote[it.id];
    // WHY (code review 10): a Nest camera is known from its maker at the first drawing, so its card starts as
    // the events card with its room reserved, not as an empty grey picture that then jumps into one.
    if (!cm && !camCache[it.id] && /nest|google/i.test((it.maker || '') + ' ' + (it.model || ''))) cm = { nest: true };
    if (!cm || !cm.nest) {
      return '<div class="' + cls + ' col"><div class="line"><div class="name">' + esc(it.name) + (na && !camCache[it.id] ? '<div class="sub">Not responding</div>' : na ? '<div class="sub">Last picture · camera not responding</div>' : '') + '</div></div>' +
        (cm ? '<div class="cam-empty note">' + esc(cm.text) + (cm.href ? ' <a href="' + esc(base + cm.href) + '" target="_blank" rel="noopener">' + esc(cm.link) + '</a>' : '') + '</div>'
          : '<img class="cam" alt="" role="img" aria-label="' + esc(it.name) + '" data-cam="' + esc(it.id) + '"' + (camCache[it.id] ? ' src="' + camCache[it.id] + '"' : '') + '>') + '</div>';
    }
    var st = camState(it.id), ev = st.events, live = st.live, clip = st.clip, eid = esc(it.id);
    var html = '<div class="' + cls + ' col cam-card"><div class="line"><div class="name">' + esc(it.name) + '<div class="sub">' + (na ? 'Not responding' : esc(it.model || 'Camera')) + '</div></div></div>';
    if (live) {
      html += live.state === 'stopped'
        ? '<div class="cam-note" role="status">Live view stopped' + (live.why ? ': ' + esc(live.why) : '') + '.</div>'
        : '<div class="cam-view"><div class="cam-slot" data-live-slot="' + eid + '"></div>' +
          (live.state === 'playing' ? '<span class="cam-badge">LIVE</span>' : '<div class="cam-msg">Starting live view…</div>') +
          '<button class="yc-button yc-button--sm cam-stop" data-cam-act="stop" data-id="' + eid + '">Stop</button></div>';
    } else if (clip) {
      html += clip.state === 'failed' ? '<div class="cam-note" role="status">' + esc(clip.why) + '</div>'
        : '<div class="cam-view"><div class="cam-slot" data-clip-slot="' + eid + '"></div>' + (clip.state === 'loading' ? '<div class="cam-msg">Loading clip…</div>' : '') +
          '<button class="yc-button yc-button--sm cam-stop" data-cam-act="close" data-id="' + eid + '">Close</button></div>';
    }
    if (ev.state === 'loading') html += '<div class="cam-evs cam-evs-wait" aria-hidden="true"></div>';
    else if (ev.state === 'failed') html += '<div class="cam-note">Could not load recent events from Home Assistant.</div>';
    else if (ev.state === 'ready' && !ev.list.length) html += '<div class="cam-note">No recordings yet. Nest only saves clips when it can send events to Home Assistant.</div>';
    else if (ev.state === 'ready') {
      html += '<div class="cam-evs">' + ev.list.map(function (e) {
        return '<button class="cam-ev" data-cam-act="play" data-id="' + eid + '" data-ev="' + esc(e.id) + '" aria-pressed="' + !!(clip && clip.id === e.id) + '"' + (clipBusy ? ' disabled' : '') + '>' +
          '<span class="th">' + (e.thumb ? '<img data-thumb="' + esc(e.id) + '" alt="" src="' + e.thumb + '">' : '<img data-thumb="' + esc(e.id) + '" alt="">') + '</span>' +
          '<span class="w">' + esc(e.what) + '</span><time>' + esc(evTime(e.at)) + '</time></button>';
      }).join('') + '</div>';
    }
    var stopped = live && live.state === 'stopped';
    html += '<div class="cam-actions">' +
      (canVideo() && !(live && !stopped) ? '<button class="yc-button yc-button--sm yc-button--primary" data-cam-act="live" data-id="' + eid + '"' + (na ? ' disabled' : '') + '>' + PLAYG + ' ' + (stopped ? 'Play again' : 'Watch live') + '</button>' : '') +
      (!canVideo() || stopped ? nestFallback(it) : '') + '</div>';
    return html + '</div>';
  }

  // Players and the live canvas are made in JS, so a redraw of the page (which
  // replaces the card's text) must put them back, and a clip that was playing
  // keeps playing.
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
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-cam-act]');
    if (!b) return;
    var id = b.getAttribute('data-id'), it = thing(id), act = b.getAttribute('data-cam-act');
    if (!it) return;
    if (act === 'live') startLive(it);
    else if (act === 'stop') { stopLive(id); render(); }
    else if (act === 'close') closeClip(id);
    else if (act === 'play') {
      var evs = camState(id).events.list, pick = evs.filter(function (x) { return x.id === b.getAttribute('data-ev'); })[0];
      if (pick) playClip(it, pick);
    }
  });
`;
