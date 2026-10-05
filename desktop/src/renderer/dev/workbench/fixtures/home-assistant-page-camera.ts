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
// Recent events merge two sources: the recordings (Home Assistant's media browser: a picture and a clip) and the camera's
// own event.* entities' history (motion / person / chime, with NO picture: a newer Nest camera saves no recordings at all).
// An event with a recording within a few seconds shows once, as the recording. Matching a camera to its event entities is
// by DEVICE (the rooms template lists them as the camera's `evs`), never by guessing from names.
//
// Live video that Google refuses (HA's error says 429 / RESOURCE_EXHAUSTED / rate limited) backs off here, in the page,
// because the page is what re-asks (main never retries): 60 s, then 120 s, then 300 s per camera, shared by every tile and
// card of that camera; the Cameras tab also starts its cameras 1.5 s apart. A person's own Retry / Play is always allowed.
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
  /* The play disc on the picture (Destin picked "a play button on the picture", 2026-10-05, and asked for it to fit the
     Glass and glow look): a frosted disc with a soft ring, filling with the theme's accent when hovered or focused.
     The same glass chip is the LIVE badge, Stop and Close, so the picture's overlays read as one family. */
  .cam-view.cam-idle { background: radial-gradient(120% 120% at 30% 20%, color-mix(in srgb, var(--accent) 20%, #10151c), #0b0f14); }
  .cam-play { appearance: none; position: absolute; inset: 0; margin: auto; width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; padding: 0; color: #fff;
    background: linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,.08)); border: 1px solid rgba(255,255,255,.34);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 0 0 7px rgba(255,255,255,.07), 0 12px 30px -8px rgba(0,0,0,.75); transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, color 140ms ease; }
  .cam-play svg { width: 24px; height: 24px; margin-left: 3px; }
  .cam-play:hover:not(:disabled), .cam-play:focus-visible { background: var(--accent); border-color: var(--accent); color: var(--on-accent); box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 0 0 7px color-mix(in srgb, var(--accent) 28%, transparent), 0 0 32px -4px var(--accent); outline: none; }
  .cam-play:focus-visible { outline: 2px solid #fff; outline-offset: 4px; }
  .cam-play:active:not(:disabled) { transform: scale(.94); }
  .cam-play:disabled { opacity: .4; cursor: default; }
  /* A preview still (a recording's thumbnail, or the last live frame) behind the disc: dimmed and softened so the disc reads
     clearly and an old picture can never pass for live; its label always says what it is and when. */
  .cam-prev { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: brightness(.6) blur(1.5px) saturate(.9); transform: scale(1.03); }
  .cam-prevlbl { position: absolute; top: 8px; left: 8px; z-index: 1; max-width: calc(100% - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 8px; border-radius: 9999px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 11px; font-weight: 600; }
  @media (prefers-reduced-motion: reduce) { .cam-play { transition: none; } .cam-play:active:not(:disabled) { transform: none; } }
  .cam-evs { display: flex; flex-direction: column; gap: 4px; max-height: 158px; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
  .cam-ev { appearance: none; font: inherit; font-size: 12px; display: flex; align-items: center; gap: 10px; width: 100%; flex-shrink: 0; padding: 7px 10px; border: 0; border-radius: 14px; background: color-mix(in srgb, var(--fg) 6%, var(--panel)); color: var(--fg); cursor: pointer; text-align: left; }
  .cam-ev:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 10%, var(--panel)); }
  .cam-ev:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cam-ev[aria-pressed="true"] { box-shadow: inset 0 0 0 2px var(--accent); }
  .cam-ev:disabled { opacity: .6; cursor: default; }
  .cam-ev .th { width: 56px; height: 32px; border-radius: 9px; overflow: hidden; background: var(--inset); flex-shrink: 0; display: block; }
  /* An event with no recording: same size and place as a thumbnail, holding a plain icon; not a button, no hover, no focus. */
  .cam-ev-plain { cursor: default; }
  .cam-ev .th.ico { display: grid; place-items: center; color: var(--fg-muted); }
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
  .cam-x { position: absolute; right: 8px; top: 8px; z-index: 1; appearance: none; font: inherit; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 9999px; cursor: pointer; border: 0;
    background: rgba(0, 0, 0, .55); color: #fff; transition: background-color 120ms ease; }
  .cam-x:hover { background: rgba(0, 0, 0, .78); } .cam-x:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .cam-x:active { transform: scale(.94); }
  .cam-x svg { width: 10px; height: 10px; }
  @media (prefers-reduced-motion: reduce) { .cam-x { transition: none; } .cam-x:active { transform: none; } }
  .cam-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .cam-note { font-size: 12px; color: var(--fg-muted); line-height: 1.4; }
  .cam-note a, .cam-actions a { color: var(--accent); font-size: 12px; }
  /* The Cameras tab */
  .cam-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .cam-tile { position: relative; }
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
  // Events with no picture: how far back to ask, how close in time to a recording counts as the same event, rows kept.
  var EVENT_HISTORY_H = 36, EVENT_MATCH_MS = 15000, ROWS_MAX = 30;
  // The Cameras tab starts its cameras this far apart; a refused start waits 60, 120, then 300 seconds.
  var STAGGER_MS = 1500, RATE_STEPS = [60000, 120000, 300000];
  var RATE_RE = /\\b429\\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i;
  var STOPG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
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

  // ── Preview stills ────────────────────────────────────────────────────────
  // Nest gives no still on request, so a card that is not live shows the NEWER of two things: the newest recording's
  // thumbnail, or the last live frame this page kept when a live view ended. Never a live view started to get one.
  // The last frame is kept per camera in the page's own saved data, only when live STOPS (not per frame): shrunk to at
  // most 640 px wide as a JPEG, under about 60 KB of text each, at most 8 cameras (the saved data may be 1 MB in all).
  // A frame comes from the app as an ImageBitmap, so the canvas is never tainted and can be read back.
  var FRAME_MAX_CHARS = 60000, FRAMES_MAX = 8;
  function camFrames() { var f = (window.youcoded.data || {}).frames; return f && typeof f === 'object' ? f : {}; }
  function camShrink(c) {
    var tries = [[640, 0.7], [640, 0.5], [480, 0.5], [320, 0.5]];
    for (var i = 0; i < tries.length; i++) {
      try {
        var w = Math.min(tries[i][0], c.width), h = Math.max(1, Math.round(c.height * w / c.width)), o = document.createElement('canvas');
        o.width = w; o.height = h;
        o.getContext('2d').drawImage(c, 0, 0, w, h);
        var url = o.toDataURL('image/jpeg', tries[i][1]);
        if (url && url.indexOf('data:image/jpeg') === 0 && url.length <= FRAME_MAX_CHARS) return url;
      } catch (e) { return null; }
    }
    return null;
  }
  function camKeepFrame(id) {
    var c = liveCanvas[id];
    if (!c || !c.__drawn || !c.width) return;
    var url = camShrink(c);
    if (!url) return;
    var frames = Object.assign({}, camFrames());
    frames[id] = { at: Date.now(), img: url };
    var ids = Object.keys(frames).sort(function (a, b) { return frames[b].at - frames[a].at; });
    ids.slice(FRAMES_MAX).forEach(function (k) { delete frames[k]; });
    persist({ frames: frames });
  }
  // Frames of cameras no longer on the page are dropped (checked after each check of the house).
  function camPrune() {
    if (!rooms) return;
    var have = {}, frames = camFrames(), drop = false;
    rooms.forEach(function (r) { r.items.forEach(function (it) { have[it.id] = 1; }); });
    var keep = {};
    Object.keys(frames).forEach(function (k) { if (have[k]) keep[k] = frames[k]; else drop = true; });
    if (drop) persist({ frames: keep });
  }
  // What a card that is not live shows: the newer of the newest recording's thumbnail and the kept last frame.
  function camPreview(it) {
    var list = camState(it.id).events.list, ev = list && list[0], fr = camFrames()[it.id], best = null;
    if (ev && ev.thumb) best = { img: ev.thumb, at: ev.at ? ev.at.getTime() : 0, label: ev.what + (ev.at ? ' · ' + evTime(ev.at) : '') };
    if (fr && fr.img && (!best || fr.at > best.at)) best = { img: fr.img, at: fr.at, label: 'Last seen ' + evTime(new Date(fr.at)) };
    return best;
  }
  function camPreviewHtml(it) {
    var pv = camPreview(it);
    return pv ? '<img class="cam-prev" alt="" src="' + pv.img + '"><span class="cam-prevlbl">' + esc(pv.label) + '</span>' : '';
  }

  // A Nest title is the local time and what it saw: "2026-10-04 18:48:02 Person".
  function eventFrom(c) {
    var title = String(c.title || ''), lower = title.toLowerCase();
    var m = /(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})(?::(\\d{2}))?/.exec(title);
    var at = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
    var what = lower.indexOf('person') >= 0 ? 'Person' : lower.indexOf('doorbell') >= 0 || lower.indexOf('chime') >= 0 ? 'Doorbell rang'
      : lower.indexOf('motion') >= 0 ? 'Motion' : lower.indexOf('sound') >= 0 ? 'Sound' : title.replace(m ? m[0] : '', '').trim() || 'Event';
    return { id: c.media_content_id, what: what, at: at, thumbUrl: c.thumbnail || null, thumb: null };
  }
  function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase(); }
  // ── Google refusing live video ───────────────────────────────────────────
  // Per camera, shared by its tile and its card: how many refusals in a row, and when trying again stops being a hammering.
  var rate = {};
  function rateLeft(id) { var r = rate[id]; return r && r.until > Date.now() ? r.until - Date.now() : 0; }
  // A stopped live view; one whose reason says Google refused for too many requests also starts (or lengthens) the wait.
  function stoppedLive(id, why) {
    var o = { state: 'stopped', why: why || '' };
    if (RATE_RE.test(o.why)) {
      var r = rate[id] || (rate[id] = { level: 0, until: 0 });
      r.level = Math.min(r.level + 1, RATE_STEPS.length);
      r.until = Date.now() + RATE_STEPS[r.level - 1];
      o.limited = r.until;
    }
    return o;
  }
  // "6:48 pm" today, "Yesterday 6:48 pm", else "Oct 3, 6:48 pm".
  function evTime(d) {
    if (!d) return '';
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
    var days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    return days <= 0 ? t : days === 1 ? 'Yesterday ' + t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
  }

  // An event entity's kind, from its event_type (what Nest sends: motion, person, chime…) or, failing that, its name.
  // "more" ranks them when two arrive together (one person walking up sets off both Motion and Person): the most specific wins.
  // WHY the type alone when there is one: the real house's event.doorbell_motion sends camera_person / camera_motion,
  // and reading its entity name too made every doorbell motion "Doorbell rang". Real Nest types: camera_motion,
  // camera_person, camera_sound, ring (checked on the owner's house 2026-10-05).
  function histKind(entity, type) {
    var t = String(type || entity || '').toLowerCase();
    return t.indexOf('chime') >= 0 || t.indexOf('doorbell') >= 0 || /(^|_)ring$/.test(t) ? { k: 'chime', what: 'Doorbell rang', more: 4 }
      : t.indexOf('person') >= 0 ? { k: 'person', what: 'Person', more: 3 }
      : t.indexOf('sound') >= 0 ? { k: 'sound', what: 'Sound', more: 2 }
      : t.indexOf('motion') >= 0 ? { k: 'motion', what: 'Motion', more: 1 }
      : { k: 'event', what: 'Event', more: 0 };
  }
  var EV_ICONS = {
    motion: ico('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', 16),
    person: ico('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', 16),
    chime: ico('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', 16),
    sound: ico('<path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7"/>', 16),
    event: ico('<circle cx="12" cy="12" r="3"/>', 16)
  };
  // The camera's event entities' history, from Home Assistant's history list (the logbook does not say what kind an event was).
  // Each state IS the event's time; its event_type attribute says what. The first line of each list is the state at the
  // start of the window, so anything before the window is dropped. Events seconds apart are one (see histKind).
  function camHistory(ids) {
    var from = Date.now() - EVENT_HISTORY_H * 3600000;
    var q = '?filter_entity_id=' + encodeURIComponent(ids.join(',')) + '&end_time=' + encodeURIComponent(new Date().toISOString());
    return window.youcoded.fetch(base + '/api/history/period/' + encodeURIComponent(new Date(from).toISOString()) + q, {}).then(function (r) {
      if (r.status >= 400) throw new Error('Home Assistant answered ' + r.status + '.');
      var groups = JSON.parse(r.body), found = [];
      (Array.isArray(groups) ? groups : []).forEach(function (g) {
        (Array.isArray(g) ? g : []).forEach(function (s) {
          var t = s ? Date.parse(s.state) : NaN;
          if (!isFinite(t) || t < from) return;
          var kd = histKind(s.entity_id, s.attributes && s.attributes.event_type);
          found.push({ id: 'h:' + (s.entity_id || '') + ':' + t, at: new Date(t), what: kd.what, k: kd.k, more: kd.more, plain: true });
        });
      });
      found.sort(function (a, b) { return b.at.getTime() - a.at.getTime(); });
      var out = [];
      found.forEach(function (e) {
        var last = out[out.length - 1];
        if (last && last.at.getTime() - e.at.getTime() <= EVENT_MATCH_MS) { if (e.more > last.more) out[out.length - 1] = e; return; }
        out.push(e);
      });
      return out.slice(0, ROWS_MAX);
    });
  }
  // What the card lists: the recordings, plus every event with no recording (none within a few seconds, on this camera),
  // newest first. A recording always wins its event, so one thing that happened is one row.
  function camRows(st) {
    var rec = st.events.list || [], rows = rec.slice();
    (st.events.evs || []).forEach(function (h) {
      var t = h.at.getTime();
      if (!rec.some(function (r) { return r.at && Math.abs(r.at.getTime() - t) <= EVENT_MATCH_MS; })) rows.push(h);
    });
    rows.sort(function (a, b) { return (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0); });
    return rows.slice(0, ROWS_MAX);
  }

  // Recent events, at most once a minute per camera. One exchange; thumbnails follow for the rows
  // that can be seen (the first few, then more as the list is scrolled) and are put into the page
  // without redrawing the card.
  function camEvents(it, force) {
    var st = camState(it.id);
    if (!base || !it.device || st.events.busy || (!force && st.events.at && Date.now() - st.events.at < EVENTS_EVERY_MS)) return;
    st.events.busy = true;
    var ids = Array.isArray(it.evs) ? it.evs.filter(function (x) { return typeof x === 'string'; }) : [];
    // Recordings and event history are asked together and each may fail alone: the card shows what it got, and says
    // "could not load" only when it got nothing.
    var browse = registry([{ type: 'media_source/browse_media', media_content_id: 'media-source://nest/' + it.device }]).then(function (res) {
      var kids = res[0] && Array.isArray(res[0].children) ? res[0].children : [];
      var list = kids.filter(function (c) { return c && c.media_content_id && c.can_play !== false; }).map(eventFrom);
      list.sort(function (a, b) { return (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0); });
      return list.slice(0, EVENTS_MAX);
    }, function () { return null; });
    var hist = ids.length ? camHistory(ids).then(function (x) { return x; }, function () { return null; }) : Promise.resolve([]);
    Promise.all([browse, hist]).then(function (r) {
      var list = r[0], evs = r[1];
      if (list === null && (evs === null || !ids.length)) { st.events = { state: 'failed', list: [], evs: [], at: Date.now() }; renderSoon(); return; }
      list = list || [];
      // Keep a thumbnail already fetched for the same event.
      (st.events.list || []).forEach(function (o) { list.forEach(function (e) { if (o.id === e.id) { e.thumb = o.thumb; e.thumbBusy = o.thumbBusy; } }); });
      st.events = { state: 'ready', list: list, evs: evs || [], at: Date.now() };
      renderSoon();
      camThumbs(st, 0);
    });
  }
  function camThumbs(st, first) {
    // Rows are the merged list (recordings and picture-less events), so the place scrolled to is looked up there.
    camRows(st).slice(first, first + THUMBS_AHEAD).forEach(function (e) { if (!e.thumb && !e.thumbBusy && e.thumbUrl) camThumb(e, e === st.events.list[0]); });
  }
  function camThumb(e, newest) {
    e.thumbBusy = true;
    var u = /^https?:/i.test(e.thumbUrl) ? e.thumbUrl : base + e.thumbUrl;
    window.youcoded.fetch(u, { as: 'picture' }).then(function (r) {
      if (r.status !== 200 || String(r.body).indexOf('data:image/') !== 0) return;
      e.thumb = r.body;
      if (newest) renderSoon(); // the newest one is also the card's preview still
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
  var tabOn = {}, tabRetry = {}, tabFails = {}, tabSlot = 0;
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
          canvas.__drawn = true;
        } catch (e) { /* a frame that cannot be drawn is skipped */ }
        try { if (bitmap.close) bitmap.close(); } catch (e2) { /* already closed */ }
        ack();
        frames++;
        if (st.live && st.live.state !== 'playing') { st.live = { state: 'playing' }; delete rate[id]; if (quiet) tabFails[id] = 0; (quiet ? renderSoon : render)(); }
      },
      onState: function (state, why) {
        if (state === 'playing') { if (st.live && st.live.state !== 'playing') { st.live = { state: 'playing' }; (quiet ? renderSoon : render)(); } return; }
        if (state !== 'stopped') return;
        delete liveVid[id];
        if (quiet && tabOn[id]) { tabEnded(it, st, why, Date.now() - at > 10000 && frames > 0); return; }
        // The reason, in the app's own words; the card offers Play again.
        camKeepFrame(id);
        delete liveCanvas[id];
        st.live = stoppedLive(id, why);
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
    if (!tabWanted() || !played) camKeepFrame(id); // a stream that ended on its own and restarts at once needs no kept frame
    if (!tabWanted()) { st.live = stoppedLive(id, why); renderSoon(); return; }
    var delay;
    if (played) { tabFails[id] = 0; delay = 300; }
    else {
      tabFails[id] = (tabFails[id] || 0) + 1;
      delay = Math.min(30000, 2000 * Math.pow(2, tabFails[id] - 1));
      st.live = stoppedLive(id, why);
      // WHY: Google said "too many requests", so asking again in 2 seconds is exactly what it is refusing (a failed
      // restart after a 5-minute stream lands here too, so it backs off the same way).
      if (st.live.limited) delay = Math.max(delay, rateLeft(id));
    }
    renderSoon();
    clearTimeout(tabRetry[id]);
    tabRetry[id] = setTimeout(function () { delete tabRetry[id]; camTabSync(); }, delay);
  }
  function stopLive(id) {
    var v = liveVid[id];
    if (v) { try { v.stop(); } catch (e) { /* already stopped */ } }
    camKeepFrame(id); // the last picture stays as the card's preview
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
      tabSlot = 0;
      return;
    }
    // Only cameras that give no still picture and are answering stream (a Pi Zero shows its picture instead).
    var cams = camsOnPage().filter(function (it) { var cm = camNoteOf(it); return cm && cm.nest && !gone(it); }).slice(0, CAM_MAX_LIVE);
    cams.forEach(function (it) {
      var id = it.id;
      if (liveVid[id] || tabRetry[id]) return;
      tabOn[id] = true;
      var wait = rateLeft(id);
      if (wait > 0) {
        // Google refused this camera not long ago (the tab may have been left and opened again): wait out the pause, showing why.
        var st = camState(id);
        if (!st.live || st.live.state !== 'stopped') { st.live = { state: 'stopped', why: '', limited: rate[id].until }; renderSoon(); }
        tabRetry[id] = setTimeout(function () { delete tabRetry[id]; camTabSync(); }, wait);
        return;
      }
      // WHY staggered: opening the tab used to send every camera's offer in the same instant, and Google then refused them
      // all ("Too Many Requests"). Each camera takes the next free slot, 1.5 s after the one before.
      var slot = Math.max(Date.now(), tabSlot), now = Date.now();
      tabSlot = slot + STAGGER_MS;
      if (slot <= now) { startLive(it, true); return; }
      tabRetry[id] = setTimeout(function () { delete tabRetry[id]; if (tabWanted() && !liveVid[id]) startLive(it, true); }, slot - now);
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
    var html = '<div class="' + cls + ' col cam-card"><div class="line cam-head"><div class="name">' + esc(it.name) + '<div class="sub">' + (na ? 'Not responding' : esc(it.model || 'Camera')) + '</div></div></div>';
    var stoppedNow = live && live.state === 'stopped' && !inTab;
    // Nothing playing: the picture area holds the play disc (a camera that is not answering shows why instead, and the disc waits).
    if (!running && !clip && !inTab && canVideo()) {
      html += '<div class="cam-view cam-idle">' + camPreviewHtml(it) + '<button class="cam-play" data-cam-act="live" data-id="' + eid + '" aria-label="' + (stoppedNow ? 'Play ' + esc(it.name) + ' again' : 'Watch ' + esc(it.name) + ' live') + '" title="' + (stoppedNow ? 'Play again' : 'Watch live') + '"' + (na ? ' disabled' : '') + '>' + PLAYG + '</button>' + (na ? '<span class="cam-msg" style="top:auto;bottom:10px;height:auto">Not responding</span>' : '') + '</div>';
    }
    if (running && !inTab) {
      html += '<div class="cam-view">' + (live.state === 'playing' ? '' : camPreviewHtml(it)) + '<span class="cam-slot" data-live-slot="' + eid + '"></span>' + (live.state === 'playing' ? '<span class="cam-badge">LIVE</span>' : '<span class="cam-msg">Starting live view…</span>') +
        '<button class="cam-x" data-cam-act="stop" data-id="' + eid + '">' + STOPG + 'Stop</button></div>';
    } else if (clip) {
      html += clip.state === 'failed' ? '<div class="cam-note" role="status">' + esc(clip.why) + '</div>'
        : '<div class="cam-view"><span class="cam-slot" data-clip-slot="' + eid + '"></span>' + (clip.state === 'loading' ? '<span class="cam-msg">Loading clip…</span>' : '') +
          '<button class="cam-x" data-cam-act="close" data-id="' + eid + '">Close</button></div>';
    }
    var stopped = stoppedNow;
    if (stopped) html += '<div class="cam-note" role="status">' + (live.limited ? 'Google is limiting live video right now. Pressing play again before ' + clock(live.limited) + ' may be refused.' : 'Live view stopped' + (live.why ? ': ' + esc(live.why) : '') + '.') + '</div>';
    if (ev.state === 'loading') html += '<div class="cam-evs-wait" aria-hidden="true"></div>';
    else if (ev.state === 'failed') html += '<div class="cam-note">Could not load recent events from Home Assistant.</div>';
    else if (ev.state === 'ready' && !camRows(st).length) html += '<div class="cam-note">No recordings or events yet.</div>';
    else if (ev.state === 'ready') {
      html += '<div class="cam-evs" aria-label="Recent events">' + camRows(st).map(function (e) {
        // An event with no recording: a plain row with the kind's icon. Not a button, so it can be neither pressed nor tabbed to.
        if (e.plain) return '<div class="cam-ev cam-ev-plain"><span class="th ico" aria-hidden="true">' + EV_ICONS[e.k] + '</span><span class="w">' + esc(e.what) + '</span><time>' + esc(evTime(e.at)) + '</time></div>';
        return '<button class="cam-ev" data-cam-act="play" data-id="' + eid + '" data-ev="' + esc(e.id) + '" aria-pressed="' + !!(clip && clip.id === e.id) + '"' + (clipBusy ? ' disabled' : '') + '>' +
          '<span class="th">' + (e.thumb ? '<img data-thumb="' + esc(e.id) + '" alt="" src="' + e.thumb + '">' : '<img data-thumb="' + esc(e.id) + '" alt="">') + '</span>' +
          '<span class="w">' + esc(e.what) + '</span><time>' + esc(evTime(e.at)) + '</time></button>';
      }).join('') + '</div>';
    }
    // The disc on the picture is Play again; the link to Home Assistant stays as the other way to watch.
    if (stopped || !canVideo()) html += '<div class="cam-actions">' + nestFallback(it) + '</div>';
    return html + '</div>';
  }

  // One camera in the Cameras tab: its live picture (or its still picture, or why there is none),
  // a LIVE badge only while a live picture is really playing, and its name. Pressing it opens the pop-up.
  function camTileHtml(it) {
    var cm = camNoteOf(it), st = camState(it.id), live = st.live, eid = esc(it.id), na = gone(it), body, badge = '';
    if (cm && cm.nest) {
      if (na) body = '<span class="cam-msg">Not responding</span>';
      else if (!canVideo()) body = '<span class="cam-msg">This window cannot show live video.</span>';
      else if (live && live.state === 'stopped' && live.limited) body = camPreviewHtml(it) + '<span class="cam-slot" data-live-slot="' + eid + '"></span><span class="cam-msg" style="background:rgba(0,0,0,.55)">Google is limiting live video. Trying again at ' + clock(live.limited) + '.</span>';
      else if (live && live.state === 'stopped') body = camPreviewHtml(it) + '<span class="cam-slot" data-live-slot="' + eid + '"></span><span class="cam-msg" style="background:rgba(0,0,0,.55)">Live view stopped' + (live.why ? ': ' + esc(live.why) : '') + '. Trying again…</span>';
      else if (live && live.state === 'playing') { body = '<span class="cam-slot" data-live-slot="' + eid + '"></span>'; badge = '<span class="cam-badge">LIVE</span>'; }
      else body = camPreviewHtml(it) + '<span class="cam-slot" data-live-slot="' + eid + '"></span><span class="cam-msg">Starting live view…</span>';
    } else body = camCache[it.id] ? '<img class="cam" alt="" data-cam="' + eid + '" src="' + camCache[it.id] + '">' : '<span class="cam-msg">' + esc(cm ? cm.text : 'Looking for a picture…') + '</span>';
    return '<div class="cam-tile" data-eid="' + eid + '"><button class="cam-view cam-open" data-cam-act="open" data-id="' + eid + '" aria-label="Open ' + esc(it.name) + ' and its recordings">' + body + badge +
      '<span class="cam-cap"><span>' + esc(it.name) + '</span><span class="sub">' + (na ? 'Not responding' : esc(it.model || '')) + '</span></span></button>' +
      // A person's own Retry is always allowed, even before the page's own try (a sibling of the tile button: buttons cannot nest).
      (cm && cm.nest && live && live.state === 'stopped' && live.limited && !na ? '<button class="cam-x cam-retry" data-cam-act="retry" data-id="' + eid + '">Retry</button>' : '') + '</div>';
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
    // A person's Retry is allowed at any time: it skips the wait (and, if Google refuses again, the next wait is longer).
    else if (act === 'retry') { clearTimeout(tabRetry[id]); delete tabRetry[id]; if (!liveVid[id] && tabWanted()) { tabOn[id] = true; startLive(it, true); } }
    else if (act === 'close') closeClip(id);
    else if (act === 'open') { camEvents(it); openDevice(id); }
    else if (act === 'play') {
      var evs = camState(id).events.list, pick = evs.filter(function (x) { return x.id === b.getAttribute('data-ev'); })[0];
      if (pick) playClip(it, pick);
    }
  });
`;
