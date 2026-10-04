// The Home Assistant page — the first page built on a device connection
// (home-device questions deck, 2026-10-01). The SAME document the workbench
// shows is what gets installed as a real page, so the review deck shows the
// page that will actually run.
//
// Decided on the deck: lights by room, the thermostat and the TV/speakers,
// and camera snapshots (Q-scope); every device Home Assistant has put in a
// room, with a hide button for the rest (Q-which-devices); checking every 5
// seconds while the page is on screen (Q-live).
//
// How it talks to Home Assistant: one template request returns every room and
// what is in it (Home Assistant's own `/api/template`, so rooms always match
// what Home Assistant says), service calls switch things, and
// `/api/camera_proxy/<camera>` returns a snapshot as a picture. All of it goes
// through `youcoded.fetch`; the page never holds the key.

import { HOME_ASSISTANT_PAGE_CSS } from './home-assistant-page-style';
import { HOME_HISTORY_CSS, HOME_HISTORY_JS } from './home-assistant-page-history';
import { ROOMS_TEMPLATE, EXTRAS_TEMPLATE } from './home-assistant-page-templates';
import { HOME_LIVE_JS } from './home-assistant-page-live';
import { HOME_CAMERA_CSS, HOME_CAMERA_JS } from './home-assistant-page-camera';


export const HOME_ASSISTANT_PAGE_JSON = {
  name: 'Home',
  description: 'Lights, temperature, TVs and cameras, room by room, from Home Assistant.',
  icon: 'page',
  connections: [
    {
      id: 'ha', kind: 'device', service: 'Home Assistant', address: 'homeassistant.local:8123',
      access: 'full', keyPage: '/profile/security',
      // Renames and room moves go over Home Assistant's websocket (Q-where):
      // the app sends this greeting first, with the key filled in by the app.
      socketHello: '{"type":"auth","access_token":"{{key}}"}',
      // The device's profile (spec 2026-10-04), approved with the page: what
      // "logged in" and "wrong key" look like, and how the app asks for camera
      // video on the page's behalf. No socketDeny: this page needs
      // config/*_registry, and the app's built-in floor (auth/, config/auth,
      // person/) already blocks new keys and login changes.
      socketReady: 'auth_ok',
      socketAuthFailed: 'auth_invalid',
      videoProfile: {
        targetPrefix: 'camera.',
        send: '{"id":1,"type":"camera/webrtc/offer","entity_id":{{target}},"offer":{{offer}}}',
        answer: 'event.answer', candidate: 'event.candidate', failed: 'event.message',
      },
      keyHelp: { steps: [
        'Press Open Home Assistant below and sign in.',
        'Scroll to the bottom, to "Long-lived access tokens", and press Create token.',
        'Name it "YouCoded", then copy the key it shows (it is shown only once) and paste it here.',
      ] },
    },
  ],
};

/** Light controls are TILES (light-controls choice deck, 2026-10-01, C-lights:
 *  picked over glowing power buttons and big sliders). Round 2 notes: room-wide
 *  "all on / all off" buttons, a better colour button and colour selection, and
 *  the speaker's volume in the same style. */
/** Round 5 (home-page-v2 deck, Q-tv remote): a Google TV paired through Home
 *  Assistant's Android TV Remote gives a `remote.*` entity. Its TV's tile
 *  gets a Remote button that opens a remote under it: app buttons, arrows
 *  and OK, back, home, play/pause, volume. The extra media player the pairing
 *  adds is left off the page, so the TV is one tile, not two.
 *
 *  Round 4 (home-page-v2 questions deck, 2026-10-01): a room's lights fold
 *  into one card headed by an "All" bulb tile that only switches lights
 *  (Q-card lights-only, Q-all bulb-all); folds are remembered (Q-fold
 *  remember); an Edit mode for favourites, order, hiding, renaming and moving
 *  rooms (Q-settings, Q-where mixed); a link to each device's own screen in
 *  Home Assistant (Q-advanced deep-link); and Everything off, asked first
 *  (Q-extras house-off). */
function homeAssistantPageHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Home</title>
<style>${HOME_ASSISTANT_PAGE_CSS}${HOME_HISTORY_CSS}${HOME_CAMERA_CSS}</style></head>
<body>
<div class="yc-page yc-stack" id="root">
  <!-- No page title: the app's own bar already names the page, so the
       pills sit at the very top with Edit and the gear on their right
       (round 4 note: "could we remove and push the pills up?"). -->
  <div class="toprow"><div id="chips"></div><div class="bar" id="bar"></div></div>
  <div id="banner" class="banner" hidden></div>
  <div id="view"></div>
  <div id="favs"></div>
  <div class="rooms" id="rooms"><div class="yc-empty">Loading your rooms…</div></div>
  <div id="dlg"></div>
</div>
<script>
(function () {
  var TEMPLATE = ${JSON.stringify(ROOMS_TEMPLATE)};
  var EXTRAS = ${JSON.stringify(EXTRAS_TEMPLATE)};
  var POLL_MS = 5000, CAMERA_MS = 10000;
  var base = (window.youcoded.devices || {}).ha;
  var rooms = null, editing = false, timer = null, camTimer = null, busy = {};
  var saved = window.youcoded.data || {};
  var hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden : []);
  // Which lights have their colour palette open. Kept with the page's data so
  // a palette left open stays open (and so a review screen can show one).
  var expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded : []);
  // Round 4. open: rooms whose lights card is unfolded (Q-fold: as you left
  // them). fav: starred things, shown in a row above the rooms. order: the
  // order you chose, per room ('r:<room>'), for rooms ('rooms') and for
  // favourites ('fav'). All three are this page's own, not Home Assistant's
  // (Q-where: layout stays personal to the page).
  var open = new Set(Array.isArray(saved.open) ? saved.open : []);
  var fav = new Set(Array.isArray(saved.fav) ? saved.fav : []);
  var order = saved.order && typeof saved.order === 'object' ? saved.order : {};
  // One text box at a time: renaming a thing, or naming a new room for it.
  var renaming = null, newRoomFor = null, confirmOff = false;
  // Round 5: which TVs have their remote open (kept like the colour palettes).
  var remoteOpen = new Set(Array.isArray(saved.remote) ? saved.remote : []);
  // Round 7: which soundbar or speaker a TV's sound plays through, when you
  // chose it in Edit ({ tvId: speakerId | 'none' }). A choice always wins
  // over the automatic link.
  var sound = saved.sound && typeof saved.sound === 'object' ? saved.sound : {};
  // The slider being dragged: its value is not replaced by a check landing
  // mid-drag, so it never jumps under your finger.
  var dragging = null;
  // Round 4. view: which chip's page is open (null = the rooms). extras:
  // weather and low batteries. health: what Home Assistant says about its
  // own connections (needs sign-in, failed to start, repairs), checked
  // once a minute. prefs: the gear's switches. scenesOpen: rooms whose
  // Scenes section is unfolded. fixing: a Fix button that is working.
  var view = null, extras = { weather: null, low: [] }, health = { entries: [], flows: [], issues: [] }, healthAt = 0;
  var prefs = saved.prefs && typeof saved.prefs === 'object' ? saved.prefs : {};
  var scenesOpen = new Set(Array.isArray(saved.scenesOpen) ? saved.scenesOpen : []);
  var fixing = {};
  function pref(k) { return prefs[k] !== false; }
  // A review screen can open on a chip's page or with settings showing.
  if (typeof saved.view === 'string') view = saved.view;
  if (saved.settingsOpen === true) view = 'settings';
  if (typeof saved.chipStyle === 'string') prefs.chipStyle = saved.chipStyle;
  if (saved.editing) editing = true;
  var $ = function (id) { return document.getElementById(id); };

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function domain(id) { return id.split('.')[0]; }
  function isOn(it) { return it.state === 'on' || it.state === 'playing' || it.state === 'paused' || it.state === 'idle' || (domain(it.id) === 'climate' && it.state !== 'off'); }
  function gone(it) { return it.state === 'unavailable' || it.state === 'unknown'; }
  function dimmable(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m !== 'onoff'; }); }

  function persist(patch) { window.youcoded.save(Object.assign({}, window.youcoded.data || {}, patch)); }
  function banner(text) { var b = $('banner'); b.textContent = text || ''; b.hidden = !text; }

  function call(path, body) {
    return window.youcoded.fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 401) throw new Error('Home Assistant did not accept the key. Remove this connection and add a new key.');
      if (r.status >= 400) throw new Error('Home Assistant answered ' + r.status + '.');
      return r;
    });
  }

  function load() {
    if (!base) { banner('This page has not been connected to Home Assistant yet.'); return; }
    call('/api/template', { template: TEMPLATE }).then(function (r) {
      var first = rooms === null;
      // A redraw would throw away a half-typed name, so a check that lands
      // while a text box is open waits for the next one.
      if (!first && (renaming || newRoomFor)) return;
      rooms = JSON.parse(r.body);
      applyHeld();
      applyHeldVals();
      liveSubscribe(); // the first check tells the live connection which devices to follow
      // Mid-drag, the page is not redrawn at all: the next check catches up.
      if (dragging) return;
      banner('');
      render();
      // Pictures as soon as there are cameras to put them in, not on a delay.
      if (first) refreshCameras();
    }).catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant could not be reached.'); });
    call('/api/template', { template: EXTRAS }).then(function (r) {
      try { var x = JSON.parse(r.body); extras = { weather: x.weather || null, low: Array.isArray(x.low) ? x.low : [], people: Array.isArray(x.people) ? x.people : [] }; } catch (e) { /* keep the last */ }
      if (!dragging) render();
    }, function () { /* the rooms request reports the problem */ });
    if (Date.now() - healthAt > 60000) loadHealth();
    // History only while someone is looking at it (round 5: Activity tab,
    // a device's pop-up).
    if (view === 'activity') refreshHistory();
    if (dlgId) refreshDevice();
  }
  // Home Assistant's own health, over the live connection, once a minute:
  // integrations that failed to start, ones waiting for you to sign in
  // again, and its Repairs list. A failure here just leaves it empty.
  function loadHealth() {
    healthAt = Date.now();
    registry([{ type: 'config_entries/get' }, { type: 'config_entries/flow/progress' }, { type: 'repairs/list_issues' }]).then(function (res) {
      health = {
        entries: Array.isArray(res[0]) ? res[0] : [],
        flows: Array.isArray(res[1]) ? res[1] : [],
        issues: res[2] && Array.isArray(res[2].issues) ? res[2].issues : [],
      };
      render();
    }, function () { /* not fatal */ });
  }

  function service(dom, svc, data, id) {
    busy[id] = true;
    return call('/api/services/' + dom + '/' + svc, data)
      .catch(function (e) { banner(e && e.message ? e.message : 'That did not go through.'); })
      .then(function () { delete busy[id]; setTimeout(load, 400); });
  }

  // Optimistic: the switch moves the moment it is pressed. A TV or light can
  // take a few seconds to actually change, and a check that lands before it
  // has would flip the switch back and then forward again — so a pressed
  // switch holds its new position for up to 8 seconds, until Home Assistant
  // agrees (round 5 testing: "on/off doesn't work super well").
  var held = {};
  var HOLD_MS = 8000;
  function holdState(id, state) { held[id] = { state: state, until: Date.now() + HOLD_MS }; }
  function applyHeld() {
    var now = Date.now();
    (rooms || []).forEach(function (room) { room.items.forEach(function (it) {
      var h = held[it.id];
      if (!h) return;
      if (now > h.until || (it.state === h.state) || (h.state === 'on' && isOn(it))) { delete held[it.id]; return; }
      it.state = h.state;
    }); });
  }
  function setLocal(id, patch) {
    if (patch && typeof patch.state === 'string') holdState(id, patch.state);
    (rooms || []).forEach(function (room) { room.items.forEach(function (it) { if (it.id === id) Object.assign(it, patch); }); });
    render();
  }

  // Colour: a light's own colour when it reports one, else its white
  // temperature as a colour, else warm white.
  var PALETTE = [
    { k: 2700, name: 'Warm white' }, { k: 4000, name: 'Neutral white' }, { k: 6500, name: 'Daylight' },
    { rgb: [255, 70, 50], name: 'Red' }, { rgb: [255, 140, 0], name: 'Orange' }, { rgb: [255, 210, 40], name: 'Yellow' },
    { rgb: [50, 205, 90], name: 'Green' }, { rgb: [0, 190, 200], name: 'Teal' }, { rgb: [50, 110, 255], name: 'Blue' },
    { rgb: [150, 80, 255], name: 'Purple' }, { rgb: [255, 80, 170], name: 'Pink' },
  ];
  function kelvinRgb(k) {
    var t = Math.max(0, Math.min(1, (k - 2200) / (6500 - 2200)));
    return [255, Math.round(170 + t * 80), Math.round(90 + t * 160)];
  }
  function colourOf(it) {
    var c = Array.isArray(it.rgb) ? it.rgb : it.k ? kelvinRgb(it.k) : [255, 190, 110];
    return 'rgb(' + c.join(',') + ')';
  }
  function canColour(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m === 'xy' || m === 'hs' || m === 'rgb' || m === 'rgbw' || m === 'rgbww'; }); }
  function canWhite(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m === 'color_temp' || m === 'xy' || m === 'hs' || m === 'rgb' || m === 'rgbw' || m === 'rgbww'; }); }
  var BULB = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/></svg>';
  var SPEAKER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
  var CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var STAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>';
  var STAR_ON = STAR.replace('fill="none"', 'fill="currentColor"');
  var UP = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
  var DOWN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  var EYE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  var INFO = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
  var OUT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  function ico(d, w) { return '<svg width="' + (w || 18) + '" height="' + (w || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var REMOTE = ico('<rect x="7" y="2" width="10" height="20" rx="4"/><circle cx="12" cy="9" r="2.5"/><path d="M12 5.2v.1M10 15h.01M14 15h.01M10 18h.01M14 18h.01"/>', 16);
  // Apps open through the remote by their web address; the TV hands each to
  // its app. These are the ones Home Assistant's own docs list as working.
  // Each app's mark is drawn here in its own colour, so the buttons read at
  // a glance without loading anything from the internet.
  var APPS = [
    { name: 'YouTube', url: 'https://www.youtube.com', pkg: 'youtube', bg: '#ff0033', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>' },
    { name: 'Netflix', url: 'https://www.netflix.com/title', pkg: 'netflix', bg: '#141414', mark: '<span style="color:#e50914;font-size:20px">N</span>' },
    { name: 'Prime', url: 'https://app.primevideo.com', pkg: 'amazon', bg: '#1a98ff', mark: 'pv' },
    { name: 'Disney+', url: 'https://www.disneyplus.com', pkg: 'disney', bg: '#0e2a8c', mark: 'D+' },
  ];
  // Where a speaker's music comes from, when Home Assistant says (S-now:
  // "if we can determine source, we should show spotify/etc icon").
  var SOURCES = [
    { name: 'Spotify', key: 'spotify', bg: '#1db954', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.3-1 6.7-.7 9.5.9M8 16.3c2.6-.7 5-.5 7 .7"/></svg>' },
    { name: 'YouTube Music', key: 'youtube music', bg: '#ff0033', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M9 7v10l8-5z"/></svg>' },
    { name: 'Apple Music', key: 'apple music', bg: '#fa243c', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>' },
    { name: 'Amazon Music', key: 'amazon', bg: '#25d1da', mark: '<span style="color:#000">a</span>' },
    { name: 'Pandora', key: 'pandora', bg: '#224099', mark: 'P' },
    { name: 'TV', key: 'tv', bg: 'var(--accent)', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>' },
  ];
  function sourceOf(it) {
    var hay = [it.app, it.source, it.cid && String(it.cid).split(':')[0], it.title === 'TV' ? 'tv' : ''].filter(Boolean).join(' ').toLowerCase();
    if (!hay) return null;
    return SOURCES.filter(function (x) { return x.key === 'tv' ? hay.split(' ').indexOf('tv') >= 0 : hay.indexOf(x.key) >= 0; })[0] || null;
  }
  function appOf(pkg) {
    if (!pkg) return null;
    return APPS.filter(function (a) { return String(pkg).toLowerCase().indexOf(a.pkg) >= 0; })[0] || null;
  }
  function remoteHtml(r) {
    var id = esc(r.id);
    var k = function (cmd, label, icon, cls) { return '<button class="' + cls + '" data-rc="' + id + '" data-cmd="' + cmd + '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>'; };
    var nk = function (cmd, label, icon) { return '<button class="nk" data-rc="' + id + '" data-cmd="' + cmd + '" aria-label="' + label + '"><span class="ic">' + icon + '</span>' + label + '</button>'; };
    return '<div class="remote" role="group" aria-label="Remote for ' + esc(r.name) + '">' +

      '<div class="dpad">' +
        k('DPAD_UP', 'Up', ico('<path d="m18 15-6-6-6 6"/>'), 'up') + k('DPAD_LEFT', 'Left', ico('<path d="m15 18-6-6 6-6"/>'), 'left') +
        k('DPAD_CENTER', 'OK', 'OK', 'ok') + k('DPAD_RIGHT', 'Right', ico('<path d="m9 18 6-6-6-6"/>'), 'right') + k('DPAD_DOWN', 'Down', ico('<path d="m6 9 6 6 6-6"/>'), 'down') +
      '</div>' +
      '<div class="nav">' +
        nk('BACK', 'Back', ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>')) +
        nk('HOME', 'Home', ico('<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>')) +
      '</div>' +
      // Apps sit at the bottom, under the controls you press most (round 2
      // third look, S-power: "put the youtube/etc buttons at the bottom").
      '<div class="apps">' + APPS.map(function (a) {
        return '<button class="app" data-rc="' + id + '" data-app="' + esc(a.url) + '" aria-label="Open ' + esc(a.name) + '"><span class="logo" style="--app:' + a.bg + '">' + a.mark + '</span><span class="nm">' + esc(a.name) + '</span></button>';
      }).join('') + '</div>' +
      '</div>';
  }
  // Which remote belongs to this TV tile: one in the same room named the
  // TV's name plus "remote" ("Destin's Room TV remote" → "Destin's Room
  // TV"), else the room's only remote when the room has one working TV.
  function remoteFor(it, room) {
    if (!room || !isTv(it)) return null;
    var remotes = room.items.filter(function (x) { return domain(x.id) === 'remote'; });
    if (!remotes.length) return null;
    // The whole name must match once "remote" is taken off: a prefix match
    // gave the soundbar "Destin's Room" the remote of "Destin's Room TV".
    var base = function (n) { return n.toLowerCase().replace(/\\s*remote\\s*$/, '').trim(); };
    var byName = remotes.filter(function (r) { return base(r.name) === it.name.toLowerCase().trim(); })[0];
    if (byName) return byName;
    var tvs = room.items.filter(function (x) { return domain(x.id) === 'media_player' && isTv(x) && !remoteDevice(x); });
    return remotes.length === 1 && tvs.length === 1 && tvs[0].id === it.id ? remotes[0] : null;
  }
  // What kind of player it is, from Home Assistant's device model and class
  // (round 5 testing: the soundbar looked like the TV and got its remote).
  function kindOf(it) {
    var m = (it.model || '') + ' ' + it.name;
    if (/beam|\\barc\\b|\\bray\\b|playbar|playbase|soundbar|sound bar/i.test(m)) return 'soundbar';
    if (/nest hub|display/i.test(m)) return 'display';
    if (it.dc === 'tv' || /\\btv\\b|chromecast|streamer|television/i.test(m)) return 'tv';
    return 'speaker';
  }
  var KIND_LABEL = { tv: 'TV', soundbar: 'Soundbar', display: 'Display', speaker: 'Speaker' };
  function isTv(it) { return kindOf(it) === 'tv'; }
  // Where a TV's sound comes out (round 7: "ensure we don't accidentally
  // link tvs and sound devices … the most smart/correct/simple/robust way").
  // 1. Your choice in Edit, always. 2. Otherwise only when there is no doubt:
  // the room has exactly one soundbar and exactly one TV with a paired
  // remote, and this is that TV. Anything else links nothing — guessing
  // wrong would turn the wrong thing up.
  function soundCandidates(it) {
    var room = roomOf(it.id);
    return room ? room.items.filter(function (x) { return domain(x.id) === 'media_player' && (kindOf(x) === 'soundbar' || kindOf(x) === 'speaker') && !remoteDevice(x); }) : [];
  }
  function soundbarFor(it) {
    var room = roomOf(it.id);
    if (!room) return null;
    if (Object.prototype.hasOwnProperty.call(sound, it.id)) return sound[it.id] === 'none' ? null : thing(sound[it.id]);
    var bars = room.items.filter(function (x) { return domain(x.id) === 'media_player' && kindOf(x) === 'soundbar' && !remoteDevice(x); });
    var paired = room.items.filter(function (x) { return domain(x.id) === 'media_player' && isTv(x) && !remoteDevice(x) && remoteFor(x, room); });
    return bars.length === 1 && paired.length === 1 && paired[0].id === it.id ? bars[0] : null;
  }
  // The pairing adds a media player on the remote's own device; it would be
  // a second tile for the same TV, so it is left off the page.
  function remoteDevice(it) {
    if (!it.device || domain(it.id) !== 'media_player') return false;
    var r = roomOf(it.id);
    return !!(r && r.items.some(function (x) { return domain(x.id) === 'remote' && x.device === it.device; }));
  }
  var POWER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>';
  var PROB_ICON = {
    key: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/></svg>',
    plug: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/></svg>',
    off: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 5.2-2.7M16.8 12.9c.7.4 1.3.9 1.9 1.4M12 20h.01"/></svg>',
    battery: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M6 11v2"/></svg>',
    wrench: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l8-8z"/></svg>',
  };
  var SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>';
  var HOUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';
  var GEAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  var THERMO = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/></svg>';
  var ALERT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  var BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  var SOUNDBAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="9" width="20" height="6" rx="2"/><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01"/></svg>';
  var DISPLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
  var PREV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 20 9 12l10-8z"/><path d="M5 19V5"/></svg>';
  var NEXT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/></svg>';
  var PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
  var PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  var TV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>';
  function hex(c) { return '#' + c.map(function (n) { return ('0' + n.toString(16)).slice(-2); }).join(''); }

  function swatch(it, p) {
    var c = p.k ? kelvinRgb(p.k) : p.rgb;
    var on = p.k ? (it.k && Math.abs(it.k - p.k) < 300 && !Array.isArray(it.rgb)) : (Array.isArray(it.rgb) && it.rgb.join() === p.rgb.join());
    return '<button class="sw" style="--sw: rgb(' + c.join(',') + ')" title="' + p.name + '" aria-label="' + p.name + '" aria-pressed="' + (on ? 'true' : 'false') + '" data-colour="' + esc(it.id) + '" data-' + (p.k ? 'k="' + p.k : 'rgb="' + p.rgb.join(',')) + '"></button>';
  }
  function paletteHtml(it) {
    if (!expanded.has(it.id) || !isOn(it) || gone(it)) return '';
    var whites = canWhite(it) ? '<div class="pal-row"><span class="pal-lbl">Whites</span><span class="pal-sw">' + PALETTE.filter(function (p) { return p.k; }).map(function (p) { return swatch(it, p); }).join('') + '</span></div>' : '';
    var current = Array.isArray(it.rgb) ? it.rgb : [255, 255, 255];
    var colours = canColour(it) ? '<div class="pal-row"><span class="pal-lbl">Colours</span><span class="pal-sw">' + PALETTE.filter(function (p) { return p.rgb; }).map(function (p) { return swatch(it, p); }).join('') +
      '<label class="sw-any" title="Any colour"><input type="color" value="' + hex(current) + '" aria-label="Any colour for ' + esc(it.name) + '" data-any="' + esc(it.id) + '"></label></span></div>' : '';
    return '<div class="palette" role="group" aria-label="Colour of ' + esc(it.name) + '">' + whites + colours + '</div>';
  }
  function colourBtn(it) {
    if (!canWhite(it) || !isOn(it) || gone(it)) return '';
    return '<button class="cbtn" style="--c:' + colourOf(it) + '" data-expand="' + esc(it.id) + '" aria-expanded="' + (expanded.has(it.id) ? 'true' : 'false') + '" aria-label="Colour of ' + esc(it.name) + '" title="Colour"></button>';
  }
  function rangeHtml(it, pct) {
    return '<input class="lr" type="range" min="1" max="100" value="' + pct + '" style="--v:' + Math.round((pct - 1) / 99 * 100) + ';--c:' + colourOf(it) + '" aria-label="Brightness of ' + esc(it.name) + '" data-bright="' + esc(it.id) + '">';
  }

  // Volume: − and + either side of a bar (round 7). \`target\` is the player
  // whose volume it is — the TV's soundbar when its sound goes there. With
  // no level to show (a TV box with no soundbar), the keys alone.
  function volIcon(pct, muted) {
    var waves = muted || pct <= 0 ? '<path d="m16 9 5 6M21 9l-5 6"/>' : (pct < 34 ? '<path d="M15 9.5a3.5 3.5 0 0 1 0 5"/>' : pct < 67 ? '<path d="M15 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>' : '<path d="M15 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10M21 4.5a10.5 10.5 0 0 1 0 15"/>');
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/>' + waves + '</svg>';
  }
  function volRow(it, target, rc) {
    var minus = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';
    var plus = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>';
    var where = target && target.id !== it.id ? ' on ' + target.name : '';
    if (target && ((target.features || 0) & 4) && target.vol != null) {
      var v = Math.round(target.vol * 100);
      if (dragging === target.id) { var live = document.querySelector('[data-vol="' + target.id + '"]'); if (live) v = Number(live.value); }
      return '<div class="vrow"><button class="vbtn" data-mp="' + esc(target.id) + '" data-svc="volume_down" aria-label="Volume down' + esc(where) + '" title="Volume down">' + minus + '</button>' +
        '<span class="vwrap"><input class="lr vlr" type="range" min="0" max="100" value="' + v + '" style="--v:' + v + ';--c:var(--accent)" aria-label="Volume of ' + esc(it.name) + esc(where) + '" data-vol="' + esc(target.id) + '">' +
        '<span class="vicon' + (v < 12 || target.muted ? ' low' : '') + '" data-vicon="' + esc(target.id) + '">' + volIcon(v, target.muted) + '</span></span>' +
        '<button class="vbtn" data-mp="' + esc(target.id) + '" data-svc="volume_up" aria-label="Volume up' + esc(where) + '" title="Volume up">' + plus + '</button></div>';
    }
    if (rc) {
      return '<div class="vrow keys-only"><button class="vbtn" data-rc="' + esc(rc.id) + '" data-cmd="VOLUME_DOWN" aria-label="Volume down" title="Volume down">' + minus + '</button>' +
        '<span class="vlbl">Volume</span>' +
        '<button class="vbtn" data-rc="' + esc(rc.id) + '" data-cmd="VOLUME_UP" aria-label="Volume up" title="Volume up">' + plus + '</button></div>';
    }
    return '';
  }
  function castStale(it, rc) {
    var castAt = Date.parse(it.since || ''), powerAt = Date.parse(rc.since || '');
    var nowApp = appOf(rc.activity), castApp = appOf(it.app);
    return !!((castAt && powerAt && castAt < powerAt && rc.state === 'on') ||
      (rc.activity && !/mediashell/.test(rc.activity) && nowApp && castApp && nowApp !== castApp));
  }
  function tileHtml(it, icon, media, ctx) {
    // A TV with a paired remote is switched by the remote, which works the
    // TV's real power; its Cast side only knows whether something is
    // casting, so its "off" left the TV on (round 5 testing).
    var rc = media ? remoteFor(it, roomOf(it.id)) : null;
    var power = rc || it;
    var off = !isOn(power), na = gone(power), on = !off && !na;
    var pct = it.brightness ? Math.round(it.brightness / 2.55) : 0;
    var kind = media ? kindOf(it) : null;
    var tv = kind === 'tv';
    var playing = it.state === 'playing' || it.state === 'paused';
    // A TV's Cast side keeps reporting what WAS playing until it reconnects
    // after a restart, while the remote side knows the real power at once
    // (testing note: "keep the old now playing info after a tv … restarts").
    // So the Cast side's title is ignored when the TV came on after it last
    // changed, or when the TV is now in a different app than the one casting.
    if (tv && rc && playing && castStale(it, rc)) playing = false;
    // A soundbar playing the TV's sound reports the title "TV".
    var what = it.title === 'TV' && kind === 'soundbar' ? 'TV sound' : it.title;
    var app = tv && rc ? appOf(rc.activity) : media && !tv ? sourceOf(it) : null;
    var status = na ? 'Not responding'
      : media ? (on ? (playing && it.state === 'paused' ? 'Paused' : playing ? 'Playing' : 'On') : 'Off')
      : on ? (dimmable(it) ? pct + '%' : 'On') : 'Off';
    // Speakers and soundbars get play/pause and skip while something is
    // playing; a TV gets its remote instead (round 5 testing: "soundbar
    // shouldn't have full tv controls").
    var f = it.features || 0;
    // Controls live inside Now playing. A speaker uses its own play/pause
    // and skip; a TV sends the same keys through its remote, which works for
    // any app on it, not only ones that cast.
    var isPlay = it.state === 'playing';
    var pp = isPlay ? 'Pause' : 'Play';
    var ctl = '';
    if (media && tv && rc && on) {
      var rk = function (cmd, label, icon, cls) { return '<button class="key' + (cls || '') + '" data-rc="' + esc(rc.id) + '" data-cmd="' + cmd + '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>'; };
      ctl = rk('MEDIA_PREVIOUS', 'Previous', PREV) + rk('MEDIA_PLAY_PAUSE', 'Play or pause', isPlay ? PAUSE : PLAY, ' main') + rk('MEDIA_NEXT', 'Next', NEXT);
    // A soundbar playing the TV has nothing of its own to pause or skip.
    } else if (media && !tv && playing && (f & 1) && !(kind === 'soundbar' && (it.source === 'TV' || it.title === 'TV'))) {
      var mk = function (svc, label, icon, cls) { return '<button class="key' + (cls || '') + '" data-mp="' + esc(it.id) + '" data-svc="' + svc + '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>'; };
      ctl = ((f & 16) ? mk('media_previous_track', 'Previous', PREV) : '') + mk('media_play_pause', pp, isPlay ? PAUSE : PLAY, ' main') + ((f & 32) ? mk('media_next_track', 'Next', NEXT) : '');
    }
    var playRow = '';
    // A TV's volume bar moves the soundbar playing its sound, when there is
    // one (the TV's own volume is not what you hear).
    var sb = tv ? soundbarFor(it) : null;
    var volOf = sb || it;
    var vol = media && (on || ((kind === 'soundbar' || kind === 'speaker') && !gone(it))) ? volRow(it, tv && !sb ? null : volOf, tv ? rc : null) : '';
    // Now playing, in a block of its own (S-kinds notes: "improve the now
    // playing ui styling"): the app's mark on a TV, a note on a speaker.
    var nowHtml = media && on && (playing && what || app)
      ? '<div class="np' + (ctl || vol ? ' has-ctl' : '') + '"><span class="art" style="--app:' + (app ? app.bg : 'var(--accent)') + '">' +
        (app ? app.mark : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>') +
        '</span><span class="txt"><div class="lbl">' + (it.state === 'paused' ? 'Paused' : 'Now playing') +
        '<span class="eq' + (it.state === 'playing' ? ' on' : '') + '" aria-hidden="true"><i></i><i></i><i></i></span></div>' +
        '<div class="ttl">' + esc(playing && what ? what : app.name) + '</div>' +
        (app && playing && what && what !== app.name && app.name !== 'TV' ? '<div class="by">' + (tv ? 'in ' : 'on ') + esc(app.name) + '</div>' : '') + '</span>' +
        // Volume above previous/play/next (round 7).
        (vol || ctl ? '<div class="np-ctl">' + vol + (ctl ? '<div class="np-keys">' + ctl + '</div>' : '') + '</div>' : '') + '</div>'
      : '';
    var c = media ? 'var(--accent)' : colourOf(it);
    var bright = !media && on && dimmable(it) ? rangeHtml(it, pct) : '';
    var rOpen = rc && remoteOpen.has(rc.id);
    // A TV: the tile opens its remote, and power is its own button on the
    // right, so opening the remote can never switch the TV off by accident.
    var face = tv && rc
      ? '<button class="tile-face" data-remote="' + esc(rc.id) + '" aria-expanded="' + !!rOpen + '" aria-label="' + esc(it.name) + ', ' + (rOpen ? 'hide' : 'show') + ' remote">'
      : '<button class="tile-face" data-toggle="' + esc(power.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="' + esc(it.name) + (on ? ', on' : ', off') + '">';
    // Round 8 (testing notes): a media card's header is the small type icon
    // beside its type label, then the name flush left, and the one control
    // that matters most top right — power on a TV or display, mute on a
    // soundbar or speaker. Soundbars and speakers have no on/off: "that just
    // should be left to tv. just volume and mute/unmute".
    var isSound = kind === 'soundbar' || kind === 'speaker';
    var muted = !!it.muted;
    var right = !media ? colourBtn(it)
      : isSound ? (((it.features || 0) & 8) && !na
        ? '<button class="pwr mute" data-mp="' + esc(it.id) + '" data-svc="volume_mute" data-mute="' + (muted ? 'false' : 'true') + '" aria-pressed="' + muted + '" aria-label="' + (muted ? 'Unmute ' : 'Mute ') + esc(it.name) + '" title="' + (muted ? 'Unmute' : 'Mute') + '">' + volIcon(muted ? 0 : 70, muted) + '</button>' : '')
      : '<button class="pwr" data-toggle="' + esc(power.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="Turn ' + esc(it.name) + (on ? ' off' : ' on') + '" title="' + (on ? 'Turn off' : 'Turn on') + '">' + POWER + '</button>';
    var mSub = na ? 'Not responding' : isSound ? (muted ? 'Muted' : '') : status;
    var header = media
      ? '<div class="mhead"><div class="kind">' + icon + KIND_LABEL[kind] + '</div><div class="mname">' + esc(it.name) + '</div>' + (nowHtml || !mSub ? '' : '<div class="sub">' + esc(mSub) + '</div>') + '</div>'
      : face + '<span class="bulb">' + icon + '</span><span class="name">' + esc(it.name) + '<div class="sub">' + esc(status) + '</div></span></button>';
    return '<div class="tile' + (media ? ' media' : '') + (on && !isSound ? ' on' : '') + (na ? ' gone' : '') + (hidden.has(it.id) ? ' is-hidden' : '') + (muted ? ' muted' : '') + '" style="--c:' + c + '"><span class="glow"></span>' +
      '<div class="line">' + header +
      right + '</div>' + nowHtml + bright + (nowHtml ? '' : vol) + playRow + (isSound ? groupHtml(it) : '') +
      // The remote opens from a full-width bar under what is playing, so the
      // TV's name keeps its room (a pill beside it cut the name short).
      // The remote is one card: its header opens it, the remote sits inside
      // the same card below (round 7: "the same container as the remote").
      (rc ? '<div class="rcard' + (rOpen ? ' open' : '') + '"><button class="rbtn" data-remote="' + esc(rc.id) + '" aria-expanded="' + !!rOpen + '" aria-label="' + (rOpen ? 'Hide' : 'Show') + ' remote for ' + esc(it.name) + '">' + REMOTE + '<span class="rlbl">Remote</span><span class="rchev">' + CHEVRON + '</span></button>' + (rOpen ? remoteHtml(rc) : '') + '</div>' : '') +
      (media ? '' : paletteHtml(it)) + editRow(it, ctx) + '</div>';
  }

  var MODE_NAMES = { off: 'Off', cool: 'Cool', heat: 'Heat', heat_cool: 'Auto', auto: 'Auto', dry: 'Dry', fan_only: 'Fan' };
  var DOING = { cooling: 'Cooling', heating: 'Heating', idle: 'Holding', off: 'Off', drying: 'Drying', fan: 'Fan only' };
  function climateHtml(it, ctx) {
    var na = gone(it), mode = it.state;
    if (na) return '<div class="clim gone"><div class="line"><div class="name">' + esc(it.name) + '<div class="sub">Not responding</div></div></div>' + editRow(it, ctx) + '</div>';
    var lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90;
    var at = function (v) { return Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); };
    var hasSet = it.target != null && mode !== 'off';
    var now = it.cur != null ? at(it.cur) : null, set = hasSet ? at(it.target) : null;
    var scale = now == null ? '' : '<div class="scale" aria-hidden="true">' +
      (set != null ? '<span class="fill" style="left:' + Math.min(now, set) + '%;width:' + Math.abs(now - set) + '%"></span><span class="mk set" style="left:' + set + '%"></span>' : '') +
      '<span class="mk now" style="left:' + now + '%"></span></div><div class="scale-lbl"><span>' + lo + '°</span><span>' + hi + '°</span></div>';
    var doing = it.action ? (DOING[it.action] || it.action) : (MODE_NAMES[mode] || mode);
    var modes = Array.isArray(it.modesHvac) && it.modesHvac.length ? '<div class="modes" role="group" aria-label="Mode">' + it.modesHvac.map(function (m) {
      return '<button class="mode" aria-pressed="' + (m === mode) + '" data-mode="' + esc(it.id) + '" data-hvac="' + esc(m) + '">' + esc(MODE_NAMES[m] || m) + '</button>';
    }).join('') + '</div>' : '';
    return '<div class="clim ' + esc(mode) + (hidden.has(it.id) ? ' is-hidden' : '') + '"><span class="glow"></span>' +
      '<div class="line" style="position:relative"><div class="name">' + esc(it.name) + '</div></div>' +
      '<div class="clim-top"><div class="clim-now"><div class="temp">' + (it.cur != null ? esc(it.cur) + '°' : '—') + '</div><div class="clim-doing">' + esc(doing) + '</div></div>' +
      (hasSet ? '<div class="clim-set"><button class="step" aria-label="Cooler" data-temp="' + esc(it.id) + '" data-delta="' + (-(it.step || 1)) + '"' + (it.target <= lo ? ' disabled' : '') + '>−</button>' +
        '<div class="val"><b>' + esc(it.target) + '°</b><span class="sub">Set to</span></div>' +
        '<button class="step" aria-label="Warmer" data-temp="' + esc(it.id) + '" data-delta="' + (it.step || 1) + '"' + (it.target >= hi ? ' disabled' : '') + '>+</button></div>' : '<div class="clim-set sub">Off</div>') +
      '</div>' + scale + modes + editRow(it, ctx) + '</div>';
  }

  // ── Order ───────────────────────────────────────────────────────────────
  // A chosen order lists ids; anything not in it (a new device) goes last,
  // in Home Assistant's order.
  function ordered(list, key, idOf) {
    var o = order[key];
    if (!Array.isArray(o)) return list;
    var rank = function (x) { var i = o.indexOf(idOf(x)); return i < 0 ? 1e6 : i; };
    return list.map(function (x, i) { return [x, i]; })
      .sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; })
      .map(function (p) { return p[0]; });
  }
  function shift(key, ids, id, dir) {
    var i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    var next = ids.slice(); next[i] = ids[j]; next[j] = id;
    order[key] = next;
    persist({ order: order });
    render();
  }

  // ── Edit mode: one row of small controls under each thing ────────────────
  // ctx = { key, ids }: which list this thing sits in, for the up/down arrows.
  function ib(act, id, icon, label, extra) {
    return '<button class="ib" data-act="' + act + '" data-id="' + esc(id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"' + (extra || '') + '>' + icon + '</button>';
  }
  function haLink(path, label) {
    return '<a class="ib" href="' + esc(base + path) + '" target="_blank" rel="noopener" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + OUT + '</a>';
  }
  // Edit: where a TV's sound plays (round 7). Automatic shows what it found.
  // Sonos grouping (home-page-v3 Q-sonos: "tick-list"): a speaker that can
  // play in a group gets a Group bar; open, it lists every other speaker that
  // can, ticked when it is playing along. Ticking one joins it to this
  // speaker's group; unticking takes it out. Asleep speakers are listed but
  // cannot be ticked, so the list never looks shorter than the house.
  var GROUPING = 524288;
  // Not kept between visits; groupOpen in the saved data opens one for a
  // workbench screen.
  var groupOpen = new Set(Array.isArray(saved.groupOpen) ? saved.groupOpen : []);
  function canGroup(it) { return domain(it.id) === 'media_player' && ((it.features || 0) & GROUPING) !== 0; }
  function groupOf(it) { return Array.isArray(it.group) && it.group.length ? it.group : [it.id]; }
  function groupHtml(it) {
    if (!canGroup(it) || gone(it)) return '';
    var others = allItems().filter(function (x) { return x.it.id !== it.id && canGroup(x.it); });
    if (!others.length) return '';
    var members = groupOf(it), open = groupOpen.has(it.id);
    var withNames = members.filter(function (m) { return m !== it.id; }).map(function (m) { var x = thing(m); return x ? x.name : m; });
    var label = withNames.length ? 'Playing with ' + withNames.join(', ') : 'Group';
    var list = open ? '<div class="glist" role="group" aria-label="Speakers playing with ' + esc(it.name) + '">' + others.map(function (x) {
      var on = members.indexOf(x.it.id) >= 0, asleep = gone(x.it);
      return '<button class="gitem" data-join="' + esc(it.id) + '" data-member="' + esc(x.it.id) + '" aria-pressed="' + on + '"' + (asleep ? ' disabled' : '') + '>' +
        '<span class="gtick" aria-hidden="true">' + (on ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>' : '') + '</span>' +
        '<span class="gname">' + esc(x.it.name) + '<span class="sub">' + esc(asleep ? 'Asleep or off' : x.room.name) + '</span></span></button>';
    }).join('') + '</div>' : '';
    return '<div class="rcard gcard' + (open ? ' open' : '') + '"><button class="rbtn" data-group="' + esc(it.id) + '" aria-expanded="' + open + '">' + SPEAKER + '<span class="rlbl">' + esc(label) + '</span><span class="rchev">' + CHEVRON + '</span></button>' + list + '</div>';
  }
  function soundPick(it) {
    if (domain(it.id) !== 'media_player' || !isTv(it)) return '';
    var cands = soundCandidates(it);
    if (!cands.length) return '';
    var chosen = Object.prototype.hasOwnProperty.call(sound, it.id) ? sound[it.id] : '';
    var auto = !chosen ? soundbarFor(it) : null;
    return '<select class="yc-select" data-sound="' + esc(it.id) + '" aria-label="Where ' + esc(it.name) + '\u2019s sound plays">' +
      '<option value=""' + (!chosen ? ' selected' : '') + '>Sound: automatic' + (auto ? ' (' + esc(auto.name) + ')' : ' (none)') + '</option>' +
      '<option value="none"' + (chosen === 'none' ? ' selected' : '') + '>Sound: the TV itself</option>' +
      cands.map(function (x) { return '<option value="' + esc(x.id) + '"' + (chosen === x.id ? ' selected' : '') + '>Sound: ' + esc(x.name) + '</option>'; }).join('') +
      '</select>';
  }
  function editRow(it, ctx) {
    if (!editing || !ctx) return '';
    var id = it.id;
    if (renaming === id) {
      return '<div class="edit-row"><input class="yc-input" data-rn="' + esc(id) + '" value="' + esc(it.name) + '" aria-label="New name for ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="rename-save" data-id="' + esc(id) + '">Save</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="cancel">Cancel</button></div>';
    }
    if (newRoomFor === id) {
      return '<div class="edit-row"><input class="yc-input" data-nr="' + esc(id) + '" placeholder="New room’s name" aria-label="Name of the new room for ' + esc(it.name) + '">' +
        '<button class="yc-button yc-button--sm yc-button--primary" data-act="room-create" data-id="' + esc(id) + '">Create and move</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="cancel">Cancel</button></div>';
    }
    var i = ctx.ids.indexOf(id), f = fav.has(id), h = hidden.has(id);
    var here = roomOf(id);
    var pick = '<select class="yc-select" data-move="' + esc(id) + '" aria-label="Room for ' + esc(it.name) + '">' +
      (rooms || []).map(function (r) { return '<option value="' + esc(r.id) + '"' + (here && r.id === here.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') +
      '<option value="__new">New room…</option></select>';
    return '<div class="edit-row">' +
      ib('fav', id, f ? STAR_ON : STAR, f ? 'Remove from favourites' : 'Add to favourites', ' aria-pressed="' + f + '"') +
      ib('up', id, UP, 'Move up', ' data-key="' + esc(ctx.key) + '"' + (i <= 0 ? ' disabled' : '')) +
      ib('down', id, DOWN, 'Move down', ' data-key="' + esc(ctx.key) + '"' + (i >= ctx.ids.length - 1 ? ' disabled' : '')) +
      ib('rename', id, PENCIL, 'Rename') +
      '<button class="ib" data-dev="' + esc(id) + '" aria-label="Details of ' + esc(it.name) + '" title="Details">' + INFO + '</button>' +
      (ctx.key === 'fav' ? '<span class="grow"></span>' : pick) +
      soundPick(it) +
      ib('hide', id, h ? EYE_OFF : EYE, h ? 'Show on this page' : 'Hide from this page', ' aria-pressed="false"') +
      (it.device ? haLink('/config/devices/device/' + encodeURIComponent(it.device), 'Open ' + it.name + ' in Home Assistant') : '') +
      '</div>';
  }

  // Every card carries its device's id, which is how a long press, a
  // right-click or its name opens the device's pop-up (round 5, C-device).
  function itemHtml(it, ctx) {
    var html = cardHtml(it, ctx);
    return html.replace(/^<div /, '<div data-eid="' + esc(it.id) + '" ');
  }
  function cardHtml(it, ctx) {
    var d = domain(it.id), off = !isOn(it), na = gone(it);
    var cls = 'thing' + (off ? ' off' : '') + (na ? ' gone' : '') + (hidden.has(it.id) ? ' is-hidden' : '');
    var sub = na ? '<div class="sub">Not responding</div>' : '';
    if (d === 'light') return tileHtml(it, BULB, false, ctx);
    if (d === 'climate') return climateHtml(it, ctx);
    if (d === 'media_player') { var k = kindOf(it); return tileHtml(it, k === 'tv' ? TV : k === 'soundbar' ? SOUNDBAR : k === 'display' ? DISPLAY : SPEAKER, true, ctx); }
    // Round 4 camera fix + the C-camera "events" card (spec 2026-10-04): a
    // camera with a picture keeps it; a Nest camera gets its recent events and
    // Watch live (home-assistant-page-camera.ts).
    if (d === 'camera') return pref('cameras') ? cameraCardHtml(it, cls, na, ctx) : '';
    return '';
  }

  function roomOf(id) {
    var found = null;
    (rooms || []).forEach(function (r) { r.items.forEach(function (x) { if (x.id === id) found = r; }); });
    return found;
  }
  function thing(id) {
    var r = roomOf(id);
    return r ? r.items.filter(function (x) { return x.id === id; })[0] : null;
  }
  function isLight(it) { return domain(it.id) === 'light'; }
  function liveLights(list) { return list.filter(function (it) { return isLight(it) && !gone(it) && !hidden.has(it.id); }); }

  // A room's lights, folded into one card. The All tile on top is the same
  // tile as a single light, with "All" under its bulb (Q-all); it switches
  // only lights, never the TV or speaker (Q-card). While editing, every card
  // is open so every light's controls can be reached.
  // One brightness bar for the whole room's lights (round 8: "grouped
  // lights need a brightness slider to change all together"). It shows the
  // lights that are on, averaged; dragging sets every working dimmable
  // light in the room, turning on any that were off.
  function groupBright(room, live, onList, c) {
    var dim = live.filter(dimmable);
    if (!dim.length) return '';
    var lit = onList.filter(dimmable);
    var pct = lit.length ? Math.max(1, Math.round(lit.reduce(function (a, it) { return a + (it.brightness || 0); }, 0) / lit.length / 2.55)) : 1;
    var key = 'room:' + room.id;
    if (dragging === key) { var liveEl = document.querySelector('[data-gbright="' + room.id + '"]'); if (liveEl) pct = Number(liveEl.value); }
    return '<input class="lr" type="range" min="1" max="100" value="' + pct + '" style="--v:' + Math.round((pct - 1) / 99 * 100) + ';--c:' + c + '" aria-label="Brightness of every light in ' + esc(room.name) + '" data-gbright="' + esc(room.id) + '">';
  }
  // Hue scenes, folded into a Scenes section of the room's Lights card
  // (round 4, Q-scenes: "collapse into a scenes expandable card in the
  // lighting group per room"). Names drop the room's own name ("Destin's
  // Room Tokyo" → "Tokyo"); the one used last is marked.
  function sceneName(sc, room) {
    var n = sc.name || sc.id;
    return n.toLowerCase().indexOf(room.name.toLowerCase() + ' ') === 0 ? n.slice(room.name.length + 1) : n;
  }
  function scenesHtml(room) {
    var list = Array.isArray(room.scenes) ? room.scenes : [];
    if (!list.length || !pref('scenes')) return '';
    var isOpen = scenesOpen.has(room.id);
    var last = list.reduce(function (a, b) { return Date.parse(b.last) > Date.parse(a ? a.last : 0) ? b : a; }, null);
    var sorted = list.slice().sort(function (a, b) { return sceneName(a, room).localeCompare(sceneName(b, room)); });
    return '<div class="scenes' + (isOpen ? ' open' : '') + '"><button class="sc-head" data-scenes="' + esc(room.id) + '" aria-expanded="' + isOpen + '">' + SPARK +
      '<span class="sc-lbl">Scenes <span class="sc-n">' + list.length + '</span></span>' + (last && !isOpen ? '<span class="sc-last">Last: ' + esc(sceneName(last, room)) + '</span>' : '') + '<span class="rchev">' + CHEVRON + '</span></button>' +
      (isOpen ? '<div class="sc-list">' + sorted.map(function (sc) {
        return '<button class="scene' + (last && sc.id === last.id ? ' last' : '') + '" data-scene="' + esc(sc.id) + '">' + esc(sceneName(sc, room)) + '</button>';
      }).join('') + '</div>' : '') + '</div>';
  }
  function lightsCard(room, lights, ctx, forceOpen) {
    var live = liveLights(lights), onList = live.filter(isOn), anyOn = onList.length > 0;
    var isOpen = editing || forceOpen || open.has(room.id);
    var c = anyOn ? colourOf(onList[0]) : 'rgb(255, 190, 110)';
    var status = !live.length ? 'Not responding' : anyOn ? onList.length + ' of ' + live.length + ' on' : 'All off';
    var all = '<div class="tile all' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><span class="glow"></span><div class="line">' +
      '<button class="tile-face" data-room="' + esc(room.id) + '" data-room-to="' + (anyOn ? 'off' : 'on') + '" aria-pressed="' + anyOn + '"' + (live.length ? '' : ' disabled') +
      ' aria-label="All lights in ' + esc(room.name) + ', ' + esc(status) + '">' +
      '<span class="bulb-col"><span class="bulb">' + BULB + '</span><span class="all-lbl">All</span></span>' +
      '<span class="name">Lights<div class="sub">' + esc(status) + '</div></span></button>' +
      (editing ? '' : '<button class="fold" data-fold="' + esc(room.id) + '" aria-expanded="' + isOpen + '" aria-label="' + (isOpen ? 'Hide' : 'Show') + ' each light in ' + esc(room.name) + '" title="' + (isOpen ? 'Hide each light' : 'Show each light') + '">' + CHEVRON + '</button>') +
      '</div>' + groupBright(room, live, onList, c) + '</div>';
    return '<div class="lights' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><span class="glow"></span>' + all + scenesHtml(room) + (isOpen ? '<div class="lights-body">' + lights.map(function (it) { return itemHtml(it, ctx); }).join('') + '</div>' : '') + '</div>';
  }

  var camCache = {};
  var camNote = {};
  function refreshCameras() {
    if (!base || document.hidden || !rooms) return;
    allItems().forEach(function (x) {
      var it = x.it, id = it.id;
      if (domain(id) !== 'camera') return;
      window.youcoded.fetch(base + '/api/camera_proxy/' + id, { as: 'picture' }).then(function (r) {
        // A tiny picture is Home Assistant's blank stand-in, not a real one.
        if (r.status === 200 && String(r.body).length > 6000) { camCache[id] = r.body; delete camNote[id]; var img = document.querySelector('img[data-cam="' + id + '"]'); if (img) img.src = r.body; else render(); return; }
        var nest = /nest|google/i.test((it.maker || '') + ' ' + (it.model || ''));
        var auth = health.flows.some(function (f) { return f.handler === 'nest' && f.context && f.context.source === 'reauth'; });
        camNote[id] = nest && auth ? { text: 'No picture: Google Nest needs you to sign in again.', link: 'Sign in', href: '/config/integrations/integration/nest' }
          // A Nest camera is shown as its events card (camera.ts), not a note.
          : nest ? { nest: true }
          : { text: 'This camera sent no picture.' };
        render();
        if (camNote[id] && camNote[id].nest) camEvents(it);
      }, function () { /* the next round tries again */ });
    });
  }

  // ── Problems (round 4: "actionable error states that help me fix issues")
  // Each problem says what is wrong in plain words and offers the fix that
  // works: sign in again, reconnect (reload the integration), or open the
  // right screen in Home Assistant.
  function entryById(id) { return health.entries.filter(function (e) { return e.entry_id === id; })[0] || null; }
  function prettyDomain(d) { return ({ hue: 'Philips Hue', nest: 'Google Nest', cast: 'Google Cast', sonos: 'Sonos', androidtv_remote: 'Android TV Remote', dlna_dmr: 'DLNA', frigate: 'Frigate', mqtt: 'MQTT' })[d] || (d ? d.charAt(0).toUpperCase() + d.slice(1).replace(/_/g, ' ') : 'An integration'); }
  function ago(iso) {
    var t = Date.parse(iso); if (!t) return '';
    var m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  }
  // One cause, one problem: a connection that needs signing in, or that
  // failed to start, also covers every device that comes through it, so
  // those devices are named inside it rather than listed again.
  function problems() {
    var out = [];
    var affected = {};
    (rooms || []).forEach(function (r) { r.items.forEach(function (it) { if (it.entry && domain(it.id) !== 'remote') (affected[it.entry] = affected[it.entry] || []).push(it.name); }); });
    var covered = {};
    var authFlows = health.flows.filter(function (f) { return f.context && f.context.source === 'reauth'; });
    authFlows.forEach(function (f) {
      var name = (f.context.title_placeholders && f.context.title_placeholders.name) || prettyDomain(f.handler);
      var hit = f.context.entry_id ? affected[f.context.entry_id] || [] : [];
      if (f.context.entry_id) covered[f.context.entry_id] = 1;
      out.push({ key: 'auth:' + f.flow_id, sev: 'high', icon: 'key', title: prettyDomain(f.handler) + ' needs you to sign in again',
        detail: 'Its sign-in for ' + name + ' expired. Until you sign in, its devices cannot be controlled' + (f.handler === 'nest' ? ' and its cameras show no picture' : '') + '.' +
          (hit.length ? ' Affects: ' + hit.join(', ') + '.' : ''),
        actions: [{ label: 'Sign in again', href: '/config/integrations/integration/' + f.handler }] });
    });
    health.entries.filter(function (e) { return !e.disabled_by && !covered[e.entry_id] && /setup_error|setup_retry|migration_error|failed_unload/.test(e.state || ''); }).forEach(function (e) {
      covered[e.entry_id] = 1;
      var hit = affected[e.entry_id] || [];
      out.push({ key: 'entry:' + e.entry_id, sev: 'high', icon: 'plug', title: prettyDomain(e.domain) + (e.title && e.title !== prettyDomain(e.domain) ? ' (' + e.title + ')' : '') + (e.state === 'setup_retry' ? ' cannot connect' : ' failed to start'),
        detail: (e.reason ? 'Home Assistant says: ' + e.reason + '.' : 'Home Assistant could not start it.') + (hit.length ? ' Affects: ' + hit.join(', ') + '.' : ''),
        actions: [{ label: 'Try again', reload: e.entry_id }, { label: 'Open', href: '/config/integrations/integration/' + e.domain }] });
    });
    // Devices on this page that stopped answering, grouped by the
    // integration they come through, so one Reconnect fixes them all.
    var gone = {};
    (rooms || []).forEach(function (r) { r.items.forEach(function (it) {
      if (!gone_(it) || hidden.has(it.id) || domain(it.id) === 'remote' || remoteDevice(it) || covered[it.entry]) return;
      var k = it.entry || 'none';
      (gone[k] = gone[k] || []).push({ it: it, room: r.name });
    }); });
    Object.keys(gone).forEach(function (k) {
      var list = gone[k], e = entryById(k), dom = e ? e.domain : null;
      var who = e ? prettyDomain(dom) : (list[0].it.maker || 'Some');
      out.push({ key: 'gone:' + k, sev: 'mid', icon: 'off', title: list.length === 1 ? list[0].it.name + ' is not responding' : list.length + ' ' + who + ' devices are not responding',
        detail: list.map(function (x) { return x.it.name + ' (' + x.room + (x.it.since ? ', ' + ago(x.it.since) : '') + ')'; }).join(' · ') + '. ' +
          (dom === 'hue' ? 'Usually the bulb lost power (a wall switch is off), or the Hue bridge is overloaded; Reconnect fixes the second.' : 'Check it has power and is on the network; Reconnect asks Home Assistant to try again.'),
        actions: (e ? [{ label: 'Reconnect ' + prettyDomain(dom), reload: e.entry_id }] : []).concat(list[0].it.device ? [{ label: 'Open', href: '/config/devices/device/' + list[0].it.device }] : []) });
    });
    extras.low.forEach(function (b) {
      out.push({ key: 'bat:' + b.id, sev: b.level < 10 ? 'mid' : 'low', icon: 'battery', title: b.name.replace(/ ?battery( level)?$/i, '') + ' battery is at ' + Math.round(b.level) + '%',
        detail: (b.room ? b.room + '. ' : '') + 'Replace or charge it before it stops working.',
        actions: b.device ? [{ label: 'Open', href: '/config/devices/device/' + b.device }] : [] });
    });
    health.issues.filter(function (i) { return !i.ignored && !i.dismissed_version; }).forEach(function (i) {
      out.push({ key: 'issue:' + i.domain + i.issue_id, sev: i.severity === 'error' || i.severity === 'critical' ? 'high' : 'low', icon: 'wrench',
        title: prettyDomain(i.domain) + ': ' + String(i.translation_key || i.issue_id).replace(/_/g, ' '),
        detail: 'Home Assistant has a repair waiting for this.', actions: [{ label: 'Open Repairs', href: '/config/repairs' }] });
    });
    var rank = { high: 0, mid: 1, low: 2 };
    return out.sort(function (a, b) { return rank[a.sev] - rank[b.sev]; });
  }
  function gone_(it) { return gone(it); }

  // ── The four chips (round 4: "only those chips, but they should all
  // dynamically update to display different information").
  function allItems() { var a = []; (rooms || []).forEach(function (r) { r.items.forEach(function (it) { if (!hidden.has(it.id)) a.push({ it: it, room: r }); }); }); return a; }
  function chipData() {
    var items = allItems();
    var lights = items.filter(function (x) { return isLight(x.it); });
    var lit = lights.filter(function (x) { return !gone(x.it) && isOn(x.it); });
    var litRooms = {}; lit.forEach(function (x) { litRooms[x.room.id] = 1; });
    var nr = lights.filter(function (x) { return gone(x.it); }).length;
    var media = items.filter(function (x) { return domain(x.it.id) === 'media_player' && !remoteDevice(x.it); });
    // Same rule as the cards: a TV's stale Cast title is not "playing".
    var playing = media.filter(function (x) { var rc = isTv(x.it) ? remoteFor(x.it, x.room) : null; return x.it.state === 'playing' && !(rc && castStale(x.it, rc)); });
    var tvsOn = media.filter(function (x) { return isTv(x.it) && isOn(remoteFor(x.it, x.room) || x.it) && !gone(x.it); });
    var clim = items.filter(function (x) { return domain(x.it.id) === 'climate'; });
    var th = clim.filter(function (x) { return !gone(x.it); })[0];
    var w = extras.weather;
    var probs = problems();
    var nLit = lit.length, nRooms = Object.keys(litRooms).length;
    // What the chip styles draw with (round 4 chip notes: "visual effects
    // or status animations based on colors/playing status/temp").
    var litCols = lit.map(function (x) { return colourOf(x.it); });
    var liveL = lights.filter(function (x) { return !gone(x.it); });
    var firstPlay = playing[0] ? playing[0].it : null;
    var playApp = firstPlay ? (isTv(firstPlay) ? appOf((remoteFor(firstPlay, playing[0].room) || {}).activity) : sourceOf(firstPlay)) : null;
    var temp = w && w.temp != null ? w.temp : th && th.it.cur != null ? th.it.cur : null;
    var sevs = { high: 0, mid: 0, low: 0 }; probs.forEach(function (p) { sevs[p.sev]++; });
    var extra = {
      lights: { big: nLit ? String(nLit) : 'Off', unit: nLit ? 'on' : '', cols: litCols, segs: liveL.map(function (x) { return isOn(x.it) ? colourOf(x.it) : null; }) },
      media: { big: playing.length + tvsOn.length ? String(playing.length + tvsOn.length) : 'Quiet', unit: playing.length + tvsOn.length ? 'on' : '', playing: playing.length > 0, appBg: playApp ? playApp.bg : null,
        segs: media.filter(function (x) { return !gone(x.it); }).map(function (x) { return x.it.state === 'playing' ? 'var(--accent)' : (isTv(x.it) && isOn(remoteFor(x.it, x.room) || x.it)) ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : null; }) },
      climate: { big: temp != null ? Math.round(temp) + '°' : '—', unit: w ? 'outside' : 'inside', temp: temp, inside: th && th.it.cur != null ? th.it.cur : null, mode: th ? th.it.state : null },
      problems: { big: probs.length ? String(probs.length) : '✓', unit: probs.length ? 'to fix' : 'all good', sevs: sevs },
      activity: { big: '', unit: '' },
    };
    return [
      { id: 'lights', label: 'Lights', icon: BULB, on: nLit > 0,
        main: nLit ? nLit + ' on' + (nRooms > 1 ? ' in ' + nRooms + ' rooms' : '') : 'All off', sub: nr ? nr + ' not responding' : '' },
      { id: 'media', label: 'Media', icon: TV, on: playing.length + tvsOn.length > 0,
        main: playing.length ? playing.length + ' playing' : tvsOn.length ? tvsOn.length + ' TV' + (tvsOn.length > 1 ? 's' : '') + ' on' : 'All quiet',
        sub: playing.length && tvsOn.length ? tvsOn.length + ' TV on' : '' },
      // The real sky outside, not a thermometer (round 4 choice note).
      { id: 'climate', label: 'Climate', icon: w ? skyIcon(w.state, 16) : THERMO, on: !!(th && th.it.state !== 'off'),
        main: w && w.temp != null ? Math.round(w.temp) + '° ' + condName(w.state) : th && th.it.cur != null ? th.it.cur + '° inside' : 'No climate',
        sub: th ? (th.it.cur != null ? th.it.cur + '° inside' : '') + (th.it.state && th.it.state !== 'off' && th.it.target != null ? ' · ' + (MODE_NAMES[th.it.state] || th.it.state) + ' to ' + th.it.target + '°' : th.it.state === 'off' ? ' · off' : '') : '' },
      { id: 'problems', label: 'Problems', icon: ALERT, on: probs.length > 0, warn: probs.some(function (p) { return p.sev === 'high'; }),
        main: probs.length ? probs.length + ' to fix' : 'All good', sub: probs.length ? probs[0].title : '' },
      // Round 5 (C-activity "tab"): the house's history is a tab of its own.
      { id: 'activity', label: 'Activity', icon: ACTIVITY, on: false, main: activityCount() || 'Activity', sub: '' },
    ].map(function (c) { c.x = extra[c.id]; return c; }).filter(function (c) { return pref('chip-' + c.id); });
  }
  // A temperature as a colour: deep blue when cold, through teal and
  // yellow, to orange-red when hot (°F; °C is converted first).
  function tempColour(t) {
    if (t == null) return 'var(--fg-muted)';
    var f = extras.weather && /C/.test(extras.weather.unit || '') ? t * 9 / 5 + 32 : t;
    var x = Math.max(0, Math.min(1, (f - 30) / 70));
    return 'hsl(' + Math.round(215 - x * 200) + ', 80%, ' + Math.round(55 + Math.sin(x * Math.PI) * 5) + '%)';
  }
  var CONDITIONS = { 'clear-night': 'clear', sunny: 'sunny', cloudy: 'cloudy', partlycloudy: 'partly cloudy', rainy: 'rain', pouring: 'heavy rain', snowy: 'snow', 'snowy-rainy': 'sleet', fog: 'fog', windy: 'windy', 'windy-variant': 'windy', lightning: 'storms', 'lightning-rainy': 'storms', hail: 'hail', exceptional: '' };
  function condName(c) { return CONDITIONS[c] != null ? CONDITIONS[c] : String(c || '').replace(/-/g, ' '); }
  // Three new directions (round 4 again: "still don't love any of the
  // proposed designs" — the last three were all the same card dressed
  // differently). Pills: small and quiet, one row. Sentence: the house in
  // one line of words, each part a link. Tiles: big squares, number first.
  function chipStyle() { return prefs.chipStyle === 'sentence' || prefs.chipStyle === 'tiles' ? prefs.chipStyle : 'pills'; }
  function stateColour(c) {
    var x = c.x || {};
    if (c.id === 'lights') return c.on ? (x.cols[0] || 'rgb(255, 190, 110)') : null;
    if (c.id === 'media') return c.on ? (x.appBg || 'var(--accent)') : null;
    if (c.id === 'climate') return tempColour(x.temp);
    if (c.id === 'activity') return null;
    return x.sevs.high ? 'rgb(235, 70, 55)' : (x.sevs.mid || x.sevs.low) ? 'rgb(240, 165, 40)' : 'rgb(60, 190, 110)';
  }
  function chipShort(c) {
    var x = c.x || {};
    if (c.id === 'lights') return c.on ? x.big + ' on' : 'Lights off';
    if (c.id === 'media') return x.playing ? (c.main) : c.on ? c.main : 'Quiet';
    if (c.id === 'climate') return x.big + (x.inside != null ? ' · ' + x.inside + '° in' : '');
    if (c.id === 'activity') return 'Activity';
    return c.x.sevs.high + c.x.sevs.mid + c.x.sevs.low ? c.main : 'All good';
  }
  function chipPill(c) {
    var col = stateColour(c);
    return '<button class="pill k-' + c.id + (col ? ' lit' : '') + (view === c.id ? ' sel' : '') + '" style="' + (col ? '--k:' + col : '') + '" data-view="' + c.id + '" aria-pressed="' + (view === c.id) + '" aria-label="' + esc(c.label + ': ' + c.main + (c.sub ? ', ' + c.sub : '')) + '" title="' + esc(c.label + (c.sub ? ' · ' + c.sub : '')) + '">' +
      '<span class="pill-ic">' + c.icon + '</span>' + esc(chipShort(c)) + (c.id === 'media' && c.x.playing ? eqBars(true) : '') + '</button>';
  }
  function sentencePart(c) {
    var x = c.x || {}, b;
    if (c.id === 'lights') b = c.on ? '<b>' + x.big + ' light' + (x.big === '1' ? '' : 's') + '</b> on' + (c.main.indexOf(' in ') > 0 ? c.main.slice(c.main.indexOf(' in ')) : '') : '<b>All lights</b> off';
    else if (c.id === 'media') b = x.playing ? '<b>' + c.main + '</b>' : c.on ? '<b>' + c.main + '</b>' : '<b>Nothing</b> playing';
    else if (c.id === 'climate') b = '<b>' + x.big + '</b> ' + esc(c.main.replace(/^[^ ]+ /, '')) + ' outside';
    else b = c.on ? '<b>' + c.main.replace(' to fix', '') + ' problem' + (c.main.indexOf('1 ') === 0 ? '' : 's') + '</b> to fix' : '<b>No problems</b>';
    return '<button class="part k-' + c.id + (view === c.id ? ' sel' : '') + '" style="--k:' + (stateColour(c) || 'var(--fg)') + '" data-view="' + c.id + '" aria-pressed="' + (view === c.id) + '">' + b + '</button>';
  }
  function chipTile(c) {
    var col = stateColour(c);
    return '<button class="tile2 k-' + c.id + (col ? ' lit' : '') + (view === c.id ? ' sel' : '') + '" style="' + (col ? '--k:' + col : '') + '" data-view="' + c.id + '" aria-pressed="' + (view === c.id) + '" aria-label="' + esc(c.label + ': ' + c.main + (c.sub ? ', ' + c.sub : '')) + '">' +
      '<span class="t2-blob"></span><span class="t2-ic">' + c.icon + '</span>' + (c.id === 'media' && c.x.playing ? eqBars(true) : c.id === 'problems' && c.x.sevs.high ? '<span class="pulse" aria-hidden="true"></span>' : '') +
      '<span class="t2-big">' + esc(c.x.big) + '</span><span class="t2-lbl">' + c.label + (c.x.unit ? ' ' + esc(c.x.unit) : '') + '</span><span class="t2-sub">' + esc(c.sub || c.main) + '</span></button>';
  }
  function eqBars(on) { return '<span class="eq' + (on ? ' on' : '') + '" aria-hidden="true"><i></i><i></i><i></i></span>'; }
  function chipsHtml() {
    if (!rooms) return '';
    var cs = chipData();
    if (!cs.length) return '';
    var st = chipStyle();
    if (st === 'sentence') return '<p class="glance" role="group" aria-label="Your home at a glance">' + cs.map(sentencePart).join('<span class="sep" aria-hidden="true"> · </span>') + '</p>';
    // Pills are the page's tabs (round 4 headers note: "remove the back
    // button, add a home button/tab thing first in the row of pills, then
    // give all the pills a clear selected state so they serve as pages").
    var home = st === 'pills' ? '<button class="pill k-home' + (view ? '' : ' sel') + '" data-home="1" aria-pressed="' + !view + '" aria-label="Home: every room"><span class="pill-ic">' + HOUSE + '</span>Home</button>' : '';
    return '<div class="' + (st === 'tiles' ? 'tiles2' : 'pills') + '" role="tablist" aria-label="Your home at a glance">' + home + cs.map(st === 'tiles' ? chipTile : chipPill).join('') + '</div>';
  }

  // ── The gear's settings (round 4, Q-settings: a gear next to Edit).
  var PREF_ROWS = [
    ['chip-lights', 'Lights chip'], ['chip-media', 'Media chip'], ['chip-climate', 'Climate chip'], ['chip-problems', 'Problems chip'],
    ['scenes', 'Hue scenes in each room'], ['favourites', 'Favourites row'], ['cameras', 'Camera pictures'],
  ];
  // Settings are a page of their own (round 4 settings note: "should
  // probably be a full page menu"), grouped into sections.
  var PREF_SECTIONS = [
    { title: 'At a glance', note: 'The chips across the top of the page.', rows: PREF_ROWS.slice(0, 4) },
    { title: 'In each room', note: 'What each room card shows.', rows: PREF_ROWS.slice(4) },
  ];
  function settingsPageHtml() {
    return '<div class="set-grid">' + PREF_SECTIONS.map(function (sec) {
      return '<section class="yc-card set-sec"><h3>' + sec.title + '</h3><p class="yc-caption">' + sec.note + '</p>' +
        sec.rows.map(function (r) {
          var on = pref(r[0]);
          return '<label class="set-row"><span>' + r[1] + '</span><button class="tog" role="switch" aria-checked="' + on + '" data-pref="' + r[0] + '"><span></span></button></label>';
        }).join('') + '</section>';
    }).join('') + '</div>';
  }

  function barHtml() {
    var lit = [];
    (rooms || []).forEach(function (r) { liveLights(r.items).forEach(function (it) { if (isOn(it)) lit.push(it); }); });
    if (confirmOff && !lit.length) confirmOff = false;
    // Everything off asks first: one press darkens the whole house (Q-extras).
    var off = confirmOff
      ? '<div class="confirm" role="group" aria-label="Confirm"><span>Turn off ' + lit.length + ' light' + (lit.length === 1 ? '' : 's') + '?</span>' +
        '<button class="yc-button yc-button--sm yc-button--danger" data-act="house-off-yes">Turn off</button>' +
        '<button class="yc-button yc-button--sm yc-button--ghost" data-act="house-off-no">Cancel</button></div>'
      // Removed for now (round 4 settings note: "remove the everything off
      // button at the top of the page for now"); its confirm stays wired.
      : '';
    var count = hidden.size && !editing ? '<span class="yc-caption">' + hidden.size + ' hidden</span>' : '';
    return count + off + '<button class="yc-button yc-button--sm' + (editing ? ' yc-button--primary' : '') + '" data-act="edit" aria-pressed="' + editing + '">' + (editing ? 'Done' : 'Edit') + '</button>' +
      '<button class="yc-button yc-button--sm yc-button--icon gear" data-view="settings" aria-pressed="' + (view === 'settings') + '" aria-label="Page settings" title="Page settings">' + GEAR + '</button>';
  }

  function roomHtml(room, roomIds, forceOpen) {
    var key = 'r:' + room.id;
    var items = ordered(room.items.filter(function (it) { return (editing || !hidden.has(it.id)) && domain(it.id) !== 'remote' && !remoteDevice(it); }), key, function (x) { return x.id; });
    if (!items.length) return '';
    var ctx = { key: key, ids: items.map(function (x) { return x.id; }) };
    var lights = items.filter(isLight), rest = items.filter(function (it) { return !isLight(it); });
    // One light needs no card: its own tile already does what All would.
    var lightsHtml = lights.length > 1 ? lightsCard(room, lights, ctx, forceOpen) : lights.map(function (it) { return itemHtml(it, ctx); }).join('');
    var i = roomIds.indexOf(room.id);
    var tools = editing
      ? ib('up', room.id, UP, 'Move ' + room.name + ' up', ' data-key="rooms"' + (i <= 0 ? ' disabled' : '')) +
        ib('down', room.id, DOWN, 'Move ' + room.name + ' down', ' data-key="rooms"' + (i >= roomIds.length - 1 ? ' disabled' : '')) +
        haLink('/config/areas/area/' + encodeURIComponent(room.id), 'Open ' + room.name + ' in Home Assistant')
      : '';
    return '<section class="yc-card room"><div class="room-head"><h2>' + esc(room.name) + '</h2>' + tools + '</div>' +
      lightsHtml + rest.map(function (it) { return itemHtml(it, ctx); }).join('') + '</section>';
  }

  // Redraw a part only when its drawing changed (round 7: "optimize"): an
  // unchanged check leaves the page alone, so a hovered button stays
  // hovered, focus stays put, and camera pictures do not reload.
  var drawn = {};
  function put(id, html) {
    if (drawn[id] === html) return;
    drawn[id] = html;
    mediaHold(); $(id).innerHTML = html; mediaBack(); // a playing clip / live canvas survives the redraw
  }
  // A chip's page (round 4, Q-chip-tap: "an organized page dedicated to
  // optimal ux for managing the selected item"). It replaces the rooms
  // until you go back.
  function viewHtml() {
    var c = chipData().filter(function (x) { return x.id === view; })[0];
    if (view === 'settings') c = { label: 'Page settings', main: 'What this page shows' };
    // Round 4 note: "change the back/home button styling and the headers".
    // A round back button, then the page's icon, its title large, and what
    // is happening under it.
    var vIcon = view === 'settings' ? GEAR : c ? c.icon : '';
    var head = '<div class="vhead"><span class="vicon2">' + vIcon + '</span><div class="vtitle"><h2>' + (c ? c.label : '') + '</h2>' + (c ? '<span class="vsub">' + esc(c.main + (c.sub ? ' · ' + c.sub : '')) + '</span>' : '') + '</div></div>';
    var body = '';
    if (view === 'settings') return head + settingsPageHtml();
    if (view === 'activity') return head + activityHtml();
    if (view === 'problems') {
      var ps = problems();
      // Problems are cards in a grid that fills the page (round 4 note:
      // the narrow left-hand list "looks proportionally weird").
      body = ps.length ? '<div class="probs">' + ps.map(function (p) {
        return '<div class="prob ' + p.sev + '"><div class="prob-top"><span class="prob-ic">' + (PROB_ICON[p.icon] || ALERT) + '</span><div class="prob-title">' + esc(p.title) + '</div></div><div class="prob-detail">' + esc(p.detail) + '</div>' +
          '<div class="prob-acts">' + p.actions.map(function (a) {
            return a.reload ? '<button class="yc-button yc-button--sm' + (a === p.actions[0] ? ' yc-button--primary' : '') + '" data-reload="' + esc(a.reload) + '"' + (fixing[a.reload] ? ' disabled' : '') + '>' + (fixing[a.reload] ? 'Working\u2026' : esc(a.label)) + '</button>'
              : '<a class="yc-button yc-button--sm' + (a === p.actions[0] ? ' yc-button--primary' : '') + '" href="' + esc(base + a.href) + '" target="_blank" rel="noopener">' + esc(a.label) + '</a>';
          }).join('') + '</div></div>';
      }).join('') + '</div>' : '<div class="yc-empty">Nothing to fix. Every device on this page is answering.</div>';
    } else {
      var keep = view === 'lights' ? isLight : view === 'media' ? function (it) { return domain(it.id) === 'media_player' || domain(it.id) === 'remote'; } : function (it) { return domain(it.id) === 'climate'; };
      var list = ordered(rooms, 'rooms', function (r) { return r.id; }).map(function (r) {
        return { id: r.id, name: r.name, scenes: view === 'lights' ? r.scenes : [], items: r.items.filter(keep) };
      }).filter(function (r) { return r.items.some(function (it) { return !hidden.has(it.id) && domain(it.id) !== 'remote'; }); });
      var ids = list.map(function (r) { return r.id; });
      if (view === 'climate') {
        // Most homes have one thermostat, so it leads the page, large (round
        // 4 note: "that card should be much more prominent/restyled"); the
        // weather sits beside it, and any other thermostats follow.
        var ths = allItems().filter(function (x) { return domain(x.it.id) === 'climate'; });
        // Weather first, thermostat beside it (round 4: "swap positions").
        body += '<div class="clim-hero-row">' + weatherHtml() + (ths.length ? thermoHero(ths[0].it, ths[0].room) : '') + '</div>';
        list = list.map(function (r) { return { id: r.id, name: r.name, scenes: [], items: r.items.filter(function (it) { return !ths.length || it.id !== ths[0].it.id; }) }; }).filter(function (r) { return r.items.length; });
      }
      body += '<div class="rooms">' + list.map(function (r) { return roomHtml(r, ids, view === 'lights'); }).join('') + '</div>';
    }
    return head + body;
  }
  // The thermostat, large: a dial whose arc fills to the setting in the
  // mode's colour, a dot where the room is now, the setting in the middle,
  // big − and + either side, and the modes under it.
  function thermoHero(it, room) {
    if (gone(it)) return '<div class="th-hero gone"><div class="th-side"><div class="th-name">' + esc(it.name) + '</div><div class="vsub">Not responding' + (it.maker && /nest/i.test(it.maker) ? ' — Google Nest needs you to sign in again (see Problems).' : '.') + '</div></div></div>';
    var mode = it.state, lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90;
    var f = function (v) { return Math.max(0, Math.min(1, (v - lo) / (hi - lo))); };
    var hasSet = it.target != null && mode !== 'off';
    var R = 80, L = 2 * Math.PI * R * 0.75, C = 2 * Math.PI * R;
    var fill = hasSet ? f(it.target) * L : 0;
    var nowA = it.cur != null ? (135 + 270 * f(it.cur)) * Math.PI / 180 : null;
    var dot = nowA == null ? '' : '<circle class="th-now" cx="' + (100 + R * Math.cos(nowA)).toFixed(1) + '" cy="' + (100 + R * Math.sin(nowA)).toFixed(1) + '" r="7"/>';
    var doing = it.action ? (DOING[it.action] || it.action) : (MODE_NAMES[mode] || mode);
    var step = it.step || 1;
    var modes = Array.isArray(it.modesHvac) && it.modesHvac.length ? '<div class="th-modes" role="group" aria-label="Mode">' + it.modesHvac.map(function (m) {
      return '<button class="th-mode" aria-pressed="' + (m === mode) + '" data-mode="' + esc(it.id) + '" data-hvac="' + esc(m) + '">' + esc(MODE_NAMES[m] || m) + '</button>';
    }).join('') + '</div>' : '';
    return '<div class="th-hero clim ' + esc(mode) + '"><span class="glow"></span>' +
      '<div class="th-dial"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="th-track" cx="100" cy="100" r="' + R + '" stroke-dasharray="' + L.toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(135 100 100)"/>' +
      (hasSet ? '<circle class="th-fill" cx="100" cy="100" r="' + R + '" stroke-dasharray="' + fill.toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(135 100 100)"/>' : '') + dot + '</svg>' +
      '<div class="th-mid"><span class="th-lbl">' + (hasSet ? esc(doing) + ' to' : 'Off') + '</span><span class="th-set">' + (hasSet ? esc(it.target) + '°' : '—') + '</span><span class="th-cur">' + (it.cur != null ? 'Now ' + esc(it.cur) + '°' : '') + '</span></div></div>' +
      '<div class="th-side"><div class="th-name">' + esc(it.name) + '<span class="vsub"> · ' + esc(room.name) + '</span></div>' +
      (hasSet ? '<div class="th-steps"><button class="th-step" aria-label="Cooler" data-temp="' + esc(it.id) + '" data-delta="' + (-step) + '"' + (it.target <= lo ? ' disabled' : '') + '>−</button>' +
        '<button class="th-step" aria-label="Warmer" data-temp="' + esc(it.id) + '" data-delta="' + step + '"' + (it.target >= hi ? ' disabled' : '') + '>+</button></div>' : '') +
      modes + '</div></div>';
  }
  // Outside, as a wide card coloured like the sky it describes (round 4
  // note: the weather card "looks a bit odd … we can make it prettier").
  var SKY = {
    'clear-night': ['#0b1433', '#23306b'], sunny: ['#1f6fd1', '#f2a33a'], partlycloudy: ['#3a6ea8', '#9db4cc'], cloudy: ['#4a5563', '#7b8794'],
    rainy: ['#24324a', '#4b6584'], pouring: ['#1c2638', '#3d5170'], snowy: ['#5b7493', '#c9d6e3'], 'snowy-rainy': ['#3f5570', '#93a8bf'], fog: ['#5c6470', '#a2a9b2'],
    windy: ['#2f5d7c', '#8fb2c9'], 'windy-variant': ['#2f5d7c', '#8fb2c9'], lightning: ['#1d1a33', '#5a4a8a'], 'lightning-rainy': ['#1d1a33', '#4a4f7a'], hail: ['#33435a', '#8a9bb0'],
  };
  function skyIcon(c, size) {
    var p = c === 'clear-night' ? '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'
      : c === 'sunny' ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
      : /rain|pouring|lightning/.test(c) ? '<path d="M20 15.5A4.5 4.5 0 0 0 17.5 7a6 6 0 0 0-11.4 1.6A4 4 0 0 0 6 16.5h13"/><path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2"/>'
      : /snow/.test(c) ? '<path d="M20 15.5A4.5 4.5 0 0 0 17.5 7a6 6 0 0 0-11.4 1.6A4 4 0 0 0 6 16.5h13"/><path d="M8 20h.01M12 21h.01M16 20h.01"/>'
      : '<path d="M20 16.5A4.5 4.5 0 0 0 17.5 8a6 6 0 0 0-11.4 1.6A4 4 0 0 0 6 17.5h13.5"/>';
    return '<svg width="' + (size || 44) + '" height="' + (size || 44) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (size ? 2 : 1.6) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  function weatherHtml() {
    var w = extras.weather;
    if (!w) return '';
    var sky = SKY[w.state] || ['#2b3a52', '#5a6f8c'];
    var th = allItems().filter(function (x) { return domain(x.it.id) === 'climate' && !gone(x.it) && x.it.cur != null; })[0];
    return '<div class="wx" style="--s1:' + sky[0] + ';--s2:' + sky[1] + '"><div class="wx-main"><span class="wx-ic">' + skyIcon(w.state) + '</span>' +
      '<div><div class="wx-temp">' + (w.temp != null ? Math.round(w.temp) + '°' : '—') + '</div><div class="wx-cond">' + esc(condName(w.state) || w.state) + ' outside</div></div></div>' +
      '<div class="wx-facts">' + (w.humidity != null ? '<div><span>Humidity</span><b>' + Math.round(w.humidity) + '%</b></div>' : '') +
      (th ? '<div><span>Inside</span><b>' + esc(th.it.cur) + '°</b></div>' : '') + '</div></div>';
  }

  function render() {
    $('root').classList.toggle('editing', editing);
    put('bar', barHtml());

    put('chips', chipsHtml());
    if (!rooms) return;
    put('dlg', dialogHtml());
    $('root').classList.toggle('in-view', !!view);
    if (view) { put('view', viewHtml()); put('favs', ''); put('rooms', ''); return; }
    put('view', '');
    var favItems = [];
    rooms.forEach(function (r) { r.items.forEach(function (it) { if (fav.has(it.id) && (editing || !hidden.has(it.id))) favItems.push(it); }); });
    favItems = ordered(favItems, 'fav', function (x) { return x.id; });
    var favCtx = { key: 'fav', ids: favItems.map(function (x) { return x.id; }) };
    put('favs', favItems.length && pref('favourites')
      ? '<section class="yc-card room"><div class="room-head fav-head">' + STAR_ON + '<h2>Favourites</h2></div><div class="fav-grid">' + favItems.map(function (it) { return itemHtml(it, favCtx); }).join('') + '</div></section>'
      : '');
    var list = ordered(rooms.filter(function (r) { return r.items.some(function (it) { return editing || !hidden.has(it.id); }); }), 'rooms', function (r) { return r.id; });
    var roomIds = list.map(function (r) { return r.id; });
    var html = list.map(function (r) { return roomHtml(r, roomIds); }).join('');
    put('rooms', html || '<div class="yc-empty">Nothing to show. Put devices in rooms in Home Assistant, or press Edit to bring hidden ones back.</div>');
    var box = document.querySelector('[data-rn],[data-nr]');
    if (box && document.activeElement !== box) { box.focus(); if (box.select) box.select(); }
  }

  // ── Changes made in Home Assistant itself (Q-where: names and rooms) ─────
  // Names and rooms change in Home Assistant itself, over its websocket.
  // One exchange: the app opens it, sends the greeting with the key, then
  // these messages; the answer is every message Home Assistant sent back.
  function registry(messages) {
    var send = messages.map(function (m, i) { return JSON.stringify(Object.assign({ id: i + 1 }, m)); });
    return window.youcoded.fetch(base + '/api/websocket', { socket: { send: send, until: send.length + 2, timeoutMs: 10000 } }).then(function (r) {
      var frames = [];
      try { frames = JSON.parse(r.body).map(function (f) { return JSON.parse(f); }); } catch (e) { /* answered below */ }
      if (frames.some(function (f) { return f.type === 'auth_invalid'; })) throw new Error('Home Assistant did not accept the key. Remove this connection and add a new key.');
      var results = frames.filter(function (f) { return f.type === 'result'; });
      if (results.length < send.length) throw new Error('Home Assistant did not answer in time. Nothing may have changed.');
      var bad = results.filter(function (f) { return !f.success; })[0];
      if (bad) throw new Error('Home Assistant said: ' + (bad.error && bad.error.message ? bad.error.message : 'that did not work') + '.');
      return results.map(function (f) { return f.result; });
    });
  }
  function afterChange() { setTimeout(load, 400); }
  function renameThing(id, name) {
    var it = thing(id);
    if (!it || !name || name === it.name) return;
    setLocal(id, { name: name });
    registry([{ type: 'config/entity_registry/update', entity_id: id, name: name }])
      .catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant did not take the new name.'); })
      .then(afterChange);
  }
  function moveThing(id, roomId, roomName) {
    var from = roomOf(id), it = thing(id);
    if (!from || !it || from.id === roomId) return;
    from.items = from.items.filter(function (x) { return x.id !== id; });
    var to = rooms.filter(function (r) { return r.id === roomId; })[0];
    if (!to) { to = { id: roomId, name: roomName || roomId, items: [] }; rooms.push(to); }
    to.items.push(it);
    render();
    var moveTo = function (areaId) {
      return registry([it.device ? { type: 'config/device_registry/update', device_id: it.device, area_id: areaId } : { type: 'config/entity_registry/update', entity_id: id, area_id: areaId }]);
    };
    // A new room is made first: Home Assistant picks its id, and the move
    // needs that id, so it is two exchanges.
    (roomName
      ? registry([{ type: 'config/area_registry/create', name: roomName }]).then(function (res) { return moveTo(res[0] && res[0].area_id ? res[0].area_id : roomId); })
      : moveTo(roomId))
      .catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant did not move it.'); })
      .then(afterChange);
  }
  function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'room'; }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act) { onAct(act, t.getAttribute('data-id'), t); return; }
    var vw = t.getAttribute('data-view');
    if (t.getAttribute('data-home')) { view = null; render(); window.scrollTo(0, 0); return; }
    // A pill is a tab: pressing the open one keeps it open; the gear still
    // toggles settings.
    if (vw) { view = vw === 'settings' && view === 'settings' ? null : vw; render(); window.scrollTo(0, 0); if (vw === 'problems') loadHealth(); if (vw === 'activity') refreshHistory(true); return; }
    var pf = t.getAttribute('data-pref');
    if (pf) { prefs[pf] = !pref(pf); persist({ prefs: prefs }); render(); return; }
    var scn = t.getAttribute('data-scenes');
    if (scn) { if (scenesOpen.has(scn)) scenesOpen.delete(scn); else scenesOpen.add(scn); persist({ scenesOpen: Array.from(scenesOpen) }); render(); return; }
    var sc = t.getAttribute('data-scene');
    if (sc) {
      // Mark it as the one used last straight away; the lights follow.
      rooms.forEach(function (r) { (r.scenes || []).forEach(function (x) { if (x.id === sc) x.last = new Date().toISOString(); }); });
      service('scene', 'turn_on', { entity_id: sc }, sc);
      render();
      return;
    }
    var rl = t.getAttribute('data-reload');
    if (rl) {
      // Reconnect: Home Assistant reloads that integration, which is what
      // fixed the Hue bridge earlier.
      fixing[rl] = true; render();
      call('/api/config/config_entries/entry/' + encodeURIComponent(rl) + '/reload', {})
        .catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant could not reload it.'); })
        .then(function () { setTimeout(function () { delete fixing[rl]; healthAt = 0; load(); }, 3000); });
      return;
    }
    var mp = t.getAttribute('data-mp');
    if (mp) {
      var svc = t.getAttribute('data-svc');
      if (svc === 'media_play_pause') { var cur = thing(mp); if (cur) setLocal(mp, { state: cur.state === 'playing' ? 'paused' : 'playing' }); }
      var body = { entity_id: mp };
      if (svc === 'volume_mute') { body.is_volume_muted = t.getAttribute('data-mute') === 'true'; setLocal(mp, { muted: body.is_volume_muted }); }
      service('media_player', svc, body, mp);
      return;
    }
    var gp = t.getAttribute('data-group');
    if (gp) { if (groupOpen.has(gp)) groupOpen.delete(gp); else groupOpen.add(gp); render(); return; }
    var jn = t.getAttribute('data-join');
    if (jn) {
      var lead = thing(jn), mem = t.getAttribute('data-member'), x = thing(mem);
      if (!lead || !x) return;
      var g = groupOf(lead), inIt = g.indexOf(mem) >= 0;
      // Show the tick straight away; the next check confirms it.
      var next = inIt ? g.filter(function (m) { return m !== mem; }) : g.concat([mem]);
      next.forEach(function (m) { var y = thing(m); if (y) y.group = next; });
      x.group = inIt ? [mem] : next;
      if (inIt) service('media_player', 'unjoin', { entity_id: mem }, mem);
      else service('media_player', 'join', { entity_id: g[0], group_members: [mem] }, jn);
      render();
      return;
    }
    var ro = t.getAttribute('data-remote');
    if (ro) {
      if (remoteOpen.has(ro)) remoteOpen.delete(ro); else remoteOpen.add(ro);
      persist({ remote: Array.from(remoteOpen) });
      render();
      return;
    }
    // A remote press goes straight to the TV: no redraw, no re-check, so
    // pressing Down five times is five quick presses.
    var rcId = t.getAttribute('data-rc');
    if (rcId) {
      var cmd = t.getAttribute('data-cmd'), app = t.getAttribute('data-app');
      (cmd ? call('/api/services/remote/send_command', { entity_id: rcId, command: cmd })
        : call('/api/services/remote/turn_on', { entity_id: rcId, activity: app }))
        .catch(function (e) { banner(e && e.message ? e.message : 'The TV did not get that.'); });
      return;
    }
    var fd = t.getAttribute('data-fold');
    if (fd) {
      if (open.has(fd)) open.delete(fd); else open.add(fd);
      persist({ open: Array.from(open) });
      render();
      return;
    }
    var ex = t.getAttribute('data-expand');
    if (ex) {
      if (expanded.has(ex)) expanded.delete(ex); else expanded.add(ex);
      window.youcoded.save(Object.assign({}, window.youcoded.data || {}, { expanded: Array.from(expanded) }));
      render();
      return;
    }
    var col = t.getAttribute('data-colour');
    if (col) {
      var k = t.getAttribute('data-k'), rgb = t.getAttribute('data-rgb');
      if (k) { setLocal(col, { k: Number(k), rgb: null }); service('light', 'turn_on', { entity_id: col, color_temp_kelvin: Number(k) }, col); }
      else { var v3 = rgb.split(',').map(Number); setLocal(col, { rgb: v3 }); service('light', 'turn_on', { entity_id: col, rgb_color: v3 }, col); }
      return;
    }
    var mid = t.getAttribute('data-mode');
    if (mid) {
      var hv = t.getAttribute('data-hvac');
      setLocal(mid, { state: hv });
      service('climate', 'set_hvac_mode', { entity_id: mid, hvac_mode: hv }, mid);
      return;
    }
    var roomId = t.getAttribute('data-room');
    if (roomId) {
      // One button that flips (round 2): any light on → it turns them all off.
      var turnOn = t.getAttribute('data-room-to') === 'on';
      var room = rooms.find(function (r) { return r.id === roomId; });
      var ids = liveLights(room.items).map(function (it) { return it.id; });
      ids.forEach(function (x) { setLocal(x, { state: turnOn ? 'on' : 'off' }); });
      service('light', turnOn ? 'turn_on' : 'turn_off', { entity_id: ids }, 'room:' + room.id);
      return;
    }
    var id = t.getAttribute('data-toggle');
    if (id) {
      var on = (t.getAttribute('aria-checked') || t.getAttribute('aria-pressed')) !== 'true';
      setLocal(id, { state: on ? 'on' : 'off' });
      service(domain(id), on ? 'turn_on' : 'turn_off', { entity_id: id }, id);
      return;
    }
    var tid = t.getAttribute('data-temp');
    if (tid) {
      var it = null;
      rooms.forEach(function (r) { r.items.forEach(function (x) { if (x.id === tid) it = x; }); });
      if (!it || it.target == null) return;
      var next = Math.round((Number(it.target) + Number(t.getAttribute('data-delta'))) * 10) / 10;
      if (it.min != null) next = Math.max(it.min, next);
      if (it.max != null) next = Math.min(it.max, next);
      setLocal(tid, { target: next });
      service('climate', 'set_temperature', { entity_id: tid, temperature: next }, tid);
    }
  });
  function onAct(act, id, t) {
    if (act === 'edit') {
      editing = !editing; renaming = null; newRoomFor = null; confirmOff = false;
      persist({ editing: editing });
      render();
      if (!editing) load();
      return;
    }
    if (act === 'house-off') { confirmOff = true; render(); return; }
    if (act === 'house-off-no') { confirmOff = false; render(); return; }
    if (act === 'house-off-yes') {
      confirmOff = false;
      var ids = [];
      rooms.forEach(function (r) { liveLights(r.items).forEach(function (it) { if (isOn(it)) ids.push(it.id); }); });
      ids.forEach(function (x) { setLocal(x, { state: 'off' }); });
      if (ids.length) service('light', 'turn_off', { entity_id: ids }, 'house');
      render();
      return;
    }
    if (act === 'fav') {
      if (fav.has(id)) fav.delete(id); else fav.add(id);
      persist({ fav: Array.from(fav) });
      render();
      return;
    }
    if (act === 'hide') {
      if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
      persist({ hidden: Array.from(hidden) });
      render();
      return;
    }
    if (act === 'up' || act === 'down') {
      var key = t.getAttribute('data-key');
      var ids2 = key === 'rooms' ? Array.from(document.querySelectorAll('[data-act="up"][data-key="rooms"]')).map(function (b) { return b.getAttribute('data-id'); })
        : Array.from(document.querySelectorAll('[data-act="up"][data-key="' + key + '"]')).map(function (b) { return b.getAttribute('data-id'); });
      shift(key, ids2, id, act === 'up' ? -1 : 1);
      return;
    }
    if (act === 'rename') { renaming = id; newRoomFor = null; render(); return; }
    if (act === 'cancel') { renaming = null; newRoomFor = null; render(); return; }
    if (act === 'rename-save') {
      var box = document.querySelector('[data-rn]');
      var name = box ? box.value.trim() : '';
      renaming = null;
      renameThing(id, name);
      render();
      return;
    }
    if (act === 'room-create') {
      var nb = document.querySelector('[data-nr]');
      var rn = nb ? nb.value.trim() : '';
      if (!rn) { if (nb) nb.focus(); return; }
      newRoomFor = null;
      moveThing(id, slug(rn), rn);
      return;
    }
  }
  // Enter saves a name, Escape gives it up.
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var rid = t.getAttribute('data-rn') || t.getAttribute('data-nr');
    if (!rid) return;
    if (e.key === 'Enter') { e.preventDefault(); onAct(t.hasAttribute('data-rn') ? 'rename-save' : 'room-create', rid, t); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onAct('cancel', rid, t); }
  }, true);
  // While dragging (round 7: "make the volume sliders feel much smoother"):
  // the fill follows the finger every frame, and the light or speaker
  // follows too — at most every 250 ms, so a long drag is a few requests,
  // not hundreds — and the last value is always sent.
  var sendTimer = null, sendNext = null;
  function sendSoon(fn) {
    sendNext = fn;
    if (sendTimer) return;
    sendNext(); sendNext = null;
    sendTimer = setTimeout(function () { sendTimer = null; if (sendNext) { var f = sendNext; sendNext = null; sendSoon(f); } }, 250);
  }
  function quiet(path, body) { call(path, body).catch(function (e) { banner(e && e.message ? e.message : 'That did not go through.'); }); }
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t.classList || !t.classList.contains('lr')) return;
    var lo = Number(t.min) || 0, hi = Number(t.max) || 100;
    t.style.setProperty('--v', String((Number(t.value) - lo) / (hi - lo) * 100));
    var v = t.getAttribute('data-vol'), b = t.getAttribute('data-bright');
    dragging = v || b;
    if (v) {
      var vi = t.parentNode && t.parentNode.querySelector('.vicon');
      if (vi) { vi.innerHTML = volIcon(Number(t.value), false); vi.classList.toggle('low', Number(t.value) < 12); }
      var lv = t.value / 100; holdVal(v, 'vol', lv); sendSoon(function () { quiet('/api/services/media_player/volume_set', { entity_id: v, volume_level: lv }); }); }
    var gb = t.getAttribute('data-gbright');
    if (gb) {
      dragging = 'room:' + gb;
      var gr = rooms.filter(function (r) { return r.id === gb; })[0];
      var gids = gr ? liveLights(gr.items).filter(dimmable).map(function (x) { return x.id; }) : [];
      var gp = Number(t.value);
      gids.forEach(function (x) { holdVal(x, 'brightness', Math.round(gp * 2.55)); holdState(x, 'on'); });
      if (gids.length) sendSoon(function () { quiet('/api/services/light/turn_on', { entity_id: gids, brightness_pct: gp }); });
    }
    if (b && Number(t.value) > 0) { var bp = Number(t.value); holdVal(b, 'brightness', Math.round(bp * 2.55)); sendSoon(function () { quiet('/api/services/light/turn_on', { entity_id: b, brightness_pct: bp }); }); }
  });
  // A value you set holds until Home Assistant reports it (or 4 seconds),
  // so a check that lands just after you let go cannot snap the bar back.
  var heldVal = {};
  function holdVal(id, key, value) { heldVal[id + '|' + key] = { id: id, key: key, value: value, until: Date.now() + 4000 }; }
  function applyHeldVals() {
    var now = Date.now();
    Object.keys(heldVal).forEach(function (k) {
      var h = heldVal[k], it = thing(h.id);
      if (!it || now > h.until || Math.abs((it[h.key] || 0) - h.value) < 0.015 * (h.key === 'brightness' ? 255 : 1)) { delete heldVal[k]; return; }
      it[h.key] = h.value;
    });
  }
  document.addEventListener('pointerup', function () { if (dragging) setTimeout(function () { dragging = null; }, 300); });
  document.addEventListener('change', function (e) {
    var t = e.target;
    var b = t.getAttribute && t.getAttribute('data-bright');
    if (b) {
      // The big slider reaches 0: dragging all the way down turns the light off.
      if (Number(t.value) === 0) { setLocal(b, { state: 'off' }); service('light', 'turn_off', { entity_id: b }, b); return; }
      dragging = null; holdVal(b, 'brightness', Math.round(t.value * 2.55));
      var fb = Number(t.value); sendSoon(function () { quiet('/api/services/light/turn_on', { entity_id: b, brightness_pct: fb }); }); return;
    }
    // Any colour, from the rainbow swatch's colour picker.
    var any = t.getAttribute && t.getAttribute('data-any');
    if (any) {
      var m = /^#(..)(..)(..)$/.exec(t.value);
      if (m) { var c3 = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]; setLocal(any, { rgb: c3 }); service('light', 'turn_on', { entity_id: any, rgb_color: c3 }, any); }
      return;
    }
    var snd = t.getAttribute && t.getAttribute('data-sound');
    if (snd) {
      if (t.value) sound[snd] = t.value; else delete sound[snd];
      persist({ sound: sound });
      render();
      return;
    }
    var mv = t.getAttribute && t.getAttribute('data-move');
    if (mv) {
      if (t.value === '__new') { newRoomFor = mv; renaming = null; render(); return; }
      moveThing(mv, t.value);
      return;
    }
    var gbc = t.getAttribute && t.getAttribute('data-gbright');
    if (gbc) {
      // Let go: show every light at the new brightness straight away.
      dragging = null;
      var grc = rooms.filter(function (r) { return r.id === gbc; })[0];
      if (grc) liveLights(grc.items).filter(dimmable).forEach(function (x) { x.state = 'on'; x.brightness = Math.round(Number(t.value) * 2.55); });
      render();
      return;
    }
    var v = t.getAttribute && t.getAttribute('data-vol');
    if (v) { dragging = null; holdVal(v, 'vol', t.value / 100); sendSoon(function () { quiet('/api/services/media_player/volume_set', { entity_id: v, volume_level: t.value / 100 }); }); }
  });

  // Checking every 5 seconds only while the page is on screen (deck Q-live):
  // a minimised window stops asking, and catches up the moment it is back.
  function start() {
    stop();
    load();
    repoll(live.on ? LIVE_POLL_MS : POLL_MS); // quick checks, until the live connection says it is delivering
    liveStart();
    camTimer = setInterval(refreshCameras, CAMERA_MS);
  }
  function stop() { clearInterval(timer); clearInterval(camTimer); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { load(); refreshCameras(); } });
  window.youcoded.onRefresh(function () { load(); refreshCameras(); liveStart(); });
  window.youcoded.onData(function (d) {
    d = d || {};
    hidden = new Set(Array.isArray(d.hidden) ? d.hidden : []);
    open = new Set(Array.isArray(d.open) ? d.open : []);
    fav = new Set(Array.isArray(d.fav) ? d.fav : []);
    order = d.order && typeof d.order === 'object' ? d.order : {};
    remoteOpen = new Set(Array.isArray(d.remote) ? d.remote : []);
    sound = d.sound && typeof d.sound === 'object' ? d.sound : {};
    prefs = d.prefs && typeof d.prefs === 'object' ? d.prefs : {};
    scenesOpen = new Set(Array.isArray(d.scenesOpen) ? d.scenesOpen : []);
    render();
  });
${HOME_HISTORY_JS}
${HOME_LIVE_JS}
${HOME_CAMERA_JS}
  start();
})();
</script>
</body></html>`;
}

export const HOME_ASSISTANT_PAGE_HTML = homeAssistantPageHtml();
