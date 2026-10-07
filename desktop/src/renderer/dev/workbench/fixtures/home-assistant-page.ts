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
import { HOME_CLIMATE_CSS, HOME_CLIMATE_JS } from './home-assistant-page-climate';
import { HOME_DIAL_CSS, HOME_DIAL_JS } from './home-assistant-page-dial';
import { HOME_TABS_JS } from './home-assistant-page-tabs';
import { HOME_ICONS_JS } from './home-assistant-page-icons';
import { HOME_REDRAW_CSS, HOME_REDRAW_JS } from './home-assistant-page-redraw';
import { HOME_PENDING_CSS, HOME_PENDING_JS } from './home-assistant-page-pending';
import { HOME_MEMORY_CSS, HOME_MEMORY_JS } from './home-assistant-page-memory';
import { HOME_EDIT_CSS, HOME_EDIT_JS } from './home-assistant-page-edit';
import { HOME_CAMERA_CSS, HOME_CAMERA_JS } from './home-assistant-page-camera';
import { HOME_TV_JS, HOME_TV_CSS } from './home-assistant-page-tv';
import { HOME_BASIC_JS, HOME_BASIC_CSS } from './home-assistant-page-basic';
import { HOME_COMPUTER_JS, HOME_COMPUTER_CSS } from './home-assistant-page-computer';
import { HOME_SCENES_JS, HOME_SCENES_CSS } from './home-assistant-page-scenes';
import { HOME_GLASS_CSS } from './home-assistant-page-glass';
import { HOME_MEDIA_JS, HOME_MEDIA_CSS } from './home-assistant-page-media';
import { HOME_LIGHTS_JS, HOME_LIGHTS_CSS } from './home-assistant-page-lights';
import { HOME_LOOK_CSS } from './home-assistant-page-look';
import { HOME_MOTION_JS } from './home-assistant-page-motion';
import { HOME_FEEL_CSS, HOME_FEEL_JS } from './home-assistant-page-feel';


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
<style>${HOME_ASSISTANT_PAGE_CSS}${HOME_HISTORY_CSS}${HOME_CAMERA_CSS}${HOME_REDRAW_CSS}${HOME_PENDING_CSS}${HOME_MEMORY_CSS}${HOME_EDIT_CSS}${HOME_LOOK_CSS}${HOME_FEEL_CSS}${HOME_TV_CSS}${HOME_BASIC_CSS}${HOME_COMPUTER_CSS}${HOME_MEDIA_CSS}${HOME_LIGHTS_CSS}${HOME_GLASS_CSS}${HOME_CLIMATE_CSS}${HOME_DIAL_CSS}${HOME_SCENES_CSS}</style></head>
<body>
<div class="yc-page yc-stack" id="root">
  <!-- No page title: the app's own bar already names the page, so the
       pills sit at the very top with Edit and the gear on their right
       (round 4 note: "could we remove and push the pills up?"). -->
  <div class="toprow"><div id="chips"></div><div class="bar" id="bar"></div></div>
  <div id="banner" class="banner" hidden></div>
  <div id="view"></div>
  <div id="favs"></div>
  <div class="rooms" id="rooms"><div class="yc-empty"><div class="fx-bulbs"><i></i><i></i><i></i></div>Loading your rooms…</div></div>
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
  // Which lights have their colour palette open. WHY not saved (Destin, 2026-10-04: "the color menus should
  // start closed even when the parent card is expanded"): every palette starts closed on each load. Only the
  // practice app and tests can seed one, through saved.startPalettes (the real page never writes it).
  var expanded = new Set(Array.isArray(saved.startPalettes) ? saved.startPalettes : []);
  // Round 4. open: rooms whose lights card is unfolded. WHY not saved (Destin, 2026-10-04: "all grouped light
  // cards should start collapsed by default"): every Lights card starts collapsed on each load; the Lights tab
  // still opens them all. Practice screens and tests seed one through saved.startOpen. fav: starred things, shown in a row above the rooms. order: the
  // order you chose, per room ('r:<room>'), for rooms ('rooms') and for
  // favourites ('fav'). All three are this page's own, not Home Assistant's
  // (Q-where: layout stays personal to the page).
  var open = new Set(Array.isArray(saved.startOpen) ? saved.startOpen : []);
  var fav = new Set(Array.isArray(saved.fav) ? saved.fav : []);
  var order = saved.order && typeof saved.order === 'object' ? saved.order : {};
  // One text box at a time: a row's name box, or the new room's name.
  var newRoomFor = null, confirmOff = false;
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
  // Scenes also start closed on each load (practice screens seed one with saved.startScenes).
  var scenesOpen = new Set(Array.isArray(saved.startScenes) ? saved.startScenes : []);
  var fixing = {};
  function pref(k) { return prefs[k] !== false; }
  // A review screen can open on a chip's page or with settings showing.
  if (typeof saved.view === 'string') view = saved.view;
  if (saved.settingsOpen === true) view = 'settings';
  if (typeof saved.chipStyle === 'string') prefs.chipStyle = saved.chipStyle;
  // WHY Edit mode is never saved (code review F6): every other open/closed toggle starts fresh on each load, and a page left in Edit
  // reopened as slim rows with no explanation. A practice screen can still seed "editing"; a stale saved true (written by an
  // earlier build) opens Edit once and is cleared here.
  if (saved.editing) { editing = true; setTimeout(function () { persist({ editing: false }); }, 0); }
  var $ = function (id) { return document.getElementById(id); };

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function domain(id) { return id.split('.')[0]; }
  function isOn(it) { return it.state === 'on' || it.state === 'playing' || it.state === 'paused' || it.state === 'idle' || (domain(it.id) === 'climate' && it.state !== 'off'); }
  // WHY a button is only gone when 'unavailable': a button's state is when it was last pressed, so a never-pressed Wake button says 'unknown' and is fine.
  function gone(it) { return it.state === 'unavailable' || (it.state === 'unknown' && domain(it.id) !== 'button'); }
  function dimmable(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m !== 'onoff'; }); }

  function persist(patch) { window.youcoded.save(Object.assign({}, window.youcoded.data || {}, patch)); }
  // WHY sticky (redesign audit F5): a refusal used to vanish at the next successful
  // check (about half a second later). A sticky one stays until dismissed or replaced.
  var bannerSticky = false;
  function banner(text, sticky) {
    var b = $('banner');
    if (!text && bannerSticky) return;
    bannerSticky = !!(text && sticky);
    b.textContent = text || ''; b.hidden = !text;
    if (bannerSticky) b.insertAdjacentHTML('beforeend', '<button class="yc-button yc-button--sm yc-button--ghost" data-banner-dismiss="1">Dismiss</button>');
  }

  function call(path, body) {
    return window.youcoded.fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 401) throw new Error('Home Assistant did not accept the key. Remove this connection and add a new key.');
      if (r.status >= 400) throw new Error('Home Assistant answered ' + r.status + '.');
      return r;
    });
  }

  // WHY: a Hue room is also a light of its own (light.destin_s_room lists its 9 lights). Drawn, it was a tile for the
  // whole room inside the room's own card. A group whose lights are all already in that room is dropped; the room's All
  // button and bar already do its job. A group reaching into other rooms stays.
  function dropRoomGroups(list) {
    list.forEach(function (r) {
      var ids = {}; r.items.forEach(function (x) { ids[x.id] = 1; });
      r.items = r.items.filter(function (x) {
        var m = Array.isArray(x.members) ? x.members.filter(function (id) { return id !== x.id; }) : [];
        return m.length < 2 || !m.every(function (id) { return ids[id]; });
      });
    });
  }
  // WHY an answer older than one already laid in is dropped (code review F14, latest check wins): on a slow link a check asked earlier can
  // come back after a later one and would put the older rooms back; with no live connection nothing re-lays the newer state.
  var checkSeq = 0, checkApplied = 0;
  function load() {
    if (!base) { banner('This page has not been connected to Home Assistant yet.'); return; }
    var sentAt = Date.now(), mine = ++checkSeq;
    call('/api/template', { template: TEMPLATE }).then(function (r) {
      if (mine < checkApplied) return;
      checkApplied = mine;
      var first = rooms === null;
      rooms = JSON.parse(r.body);
      dropRoomGroups(rooms);
      memReportAll(); // what the house says now, before pushes are laid back on top (home-assistant-page-memory.ts)
      noteReports();
      camPrune(); // frames kept for cameras no longer on the page are dropped
      // WHY stamps (redesign audit F4 "the newest one wins", code review 4): every state
      // carries when the house last updated it; a pushed state newer than this answer's
      // goes back on top, an older one never overwrites a newer.
      liveReplay();
      guessReportAll(); // the check is the house speaking for every device
      dropSettled(sentAt); // guesses for sends accepted before this check was asked: the house has spoken
      applyHeld();
      liveSubscribe(); // the first check tells the live connection which devices to follow
      // WHY no guards for a held slider or an open name box (audit F1): drawing is
      // now in place and leaves what you are working in alone, so nothing waits.
      banner('');
      renderSoon();
      // Pictures as soon as there are cameras to put them in, not on a delay.
      if (first) refreshCameras();
    }).catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant could not be reached.'); });
    call('/api/template', { template: EXTRAS }).then(function (r) {
      try { var x = JSON.parse(r.body); extras = { weather: x.weather || null, low: Array.isArray(x.low) ? x.low : [], people: Array.isArray(x.people) ? x.people : [] }; } catch (e) { /* keep the last */ }
      renderSoon();
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
      renderSoon();
    }, function () { /* not fatal */ });
  }

  // WHY pendBegin/pendEnd (redesign audit F5, A-4/A-6): the press shows at once; if
  // the house refuses, the old value comes back and the card says so until dismissed.
  function service(dom, svc, data, id) {
    busy[id] = true;
    var tok = pendBegin(id, function () { service(dom, svc, data, id); });
    return call('/api/services/' + dom + '/' + svc, data)
      .then(function () { pendEnd(id, tok, null); }, function (e) { pendEnd(id, tok, e && e.message ? e.message : 'That did not go through.'); })
      .then(function () { delete busy[id]; hist.stale = true; setTimeout(load, 400); });
  }

  // Optimistic: the switch moves the moment it is pressed. A TV or light can
  // take a few seconds to actually change, and a check that lands before it
  // has would flip the switch back and then forward again — so a pressed
  // switch holds its new position for up to 8 seconds, until Home Assistant
  // agrees (round 5 testing: "on/off doesn't work super well").
  // WHY every field is a guess (redesign audit F5/F7, A-6; code review 7): shown before the
  // house agrees, it keeps what it replaced (to undo on a refusal) and holds against a push
  // that has not caught up, whatever the field (see home-assistant-page-pending.ts).
  function setLocal(id, patch) {
    var it = thing(id);
    if (it) { Object.keys(patch).forEach(function (k) { guess(id, k, patch[k], HOLD_MS); }); Object.assign(it, patch); }
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
${HOME_ICONS_JS}
  function sourceOf(it) {
    var hay = [it.app, it.source, it.cid && String(it.cid).split(':')[0], it.title === 'TV' ? 'tv' : ''].filter(Boolean).join(' ').toLowerCase();
    if (!hay) return null;
    return SOURCES.filter(function (x) { return x.key === 'tv' ? hay.split(' ').indexOf('tv') >= 0 : hay.indexOf(x.key) >= 0; })[0] || null;
  }
  function appOf(pkg) {
    if (!pkg) return null;
    return APPS.filter(function (a) { return String(pkg).toLowerCase().indexOf(a.pkg) >= 0; })[0] || null;
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
    return '<input class="lr' + (it.brightness == null ? ' lr-unk' : '') + '" type="range" min="1" max="100" value="' + pct + '" style="--v:' + Math.round((pct - 1) / 99 * 100) + ';--c:' + colourOf(it) + '" aria-label="Brightness of ' + esc(it.name) + '" data-bright="' + esc(it.id) + '">';
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
    // WHY (basic controls, 2026-10-05): a player with only volume steps (an Android TV box) gets - / + that step it, with no bar.
    if (target && ((target.features || 0) & 1024)) {
      return '<div class="vrow keys-only"><button class="vbtn" data-mp="' + esc(target.id) + '" data-svc="volume_down" aria-label="Volume down' + esc(where) + '" title="Volume down">' + minus + '</button>' +
        '<span class="vlbl">Volume</span><button class="vbtn" data-mp="' + esc(target.id) + '" data-svc="volume_up" aria-label="Volume up' + esc(where) + '" title="Volume up">' + plus + '</button></div>';
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
    // WHY "stale" is kept (code review F3): a stale Cast side must not show "Now playing", moving bars or a Pause key either.
    var stale = !!(tv && rc && playing && castStale(it, rc));
    if (stale) playing = false;
    // A soundbar playing the TV's sound reports the title "TV".
    var what = it.title === 'TV' && kind === 'soundbar' ? 'TV sound' : it.title;
    // Option A (Destin, 2026-10-05): an app that gives no title and has never shown a real play/pause is not claimed to be playing (home-assistant-page-tv.ts).
    var neutral = media && tv && playing && !what && !playReported(it);
    var app = tv && rc ? appOf(rc.activity) : media && !tv ? sourceOf(it) : null;
    var status = na ? 'Not responding'
      : media ? (on ? (neutral ? 'On' : playing && it.state === 'paused' ? 'Paused' : playing ? 'Playing' : 'On') : castOnlyOff(it, rc) ? 'Nothing casting' : 'Off')
      : on ? (dimmable(it) && it.brightness != null ? pct + '%' : 'On') : 'Off';
    // Speakers and soundbars get play/pause and skip while something is
    // playing; a TV gets its remote instead (round 5 testing: "soundbar
    // shouldn't have full tv controls").
    var f = it.features || 0;
    // Controls live inside Now playing. A speaker uses its own play/pause
    // and skip; a TV sends the same keys through its remote, which works for
    // any app on it, not only ones that cast.
    var isPlay = it.state === 'playing' && !stale;
    var pp = isPlay ? 'Pause' : 'Play';
    var ctl = '';
    // WHY tvKeysHtml (Destin, 2026-10-05): the TV's keys are one row of seven that the remote button re-arranges (home-assistant-page-tv.ts).
    if (media && tv && rc && on) ctl = tvKeysHtml(it, rc, neutral, isPlay);
    // WHY one rule for every player with no paired remote (basic controls, home-assistant-page-basic.ts): the keys are what the device says it can do now.
    // A soundbar playing the TV has nothing of its own to pause or skip.
    else if (media && on && !(kind === 'soundbar' && (it.source === 'TV' || it.title === 'TV'))) ctl = bcKeys(it, { playing: playing, isPlay: isPlay, neutral: neutral, sound: kind === 'soundbar' || kind === 'speaker', resume: 'Play' });
    var playRow = '';
    // A TV's volume bar moves the soundbar playing its sound, when there is
    // one (the TV's own volume is not what you hear).
    var sb = tv ? soundbarFor(it) : null;
    var volOf = sb || it;
    var vol = media && (on || ((kind === 'soundbar' || kind === 'speaker') && !gone(it))) ? volRow(it, tv && rc && !sb ? null : volOf, tv ? rc : null) : '';
    // Now playing, in a block of its own (S-kinds notes: "improve the now
    // playing ui styling"): the app's mark on a TV, a note on a speaker.
    // The input picker and the pairing hint (none for a paired-remote TV, a speaker or a player that is not responding).
    var bcx = media && on && !rc ? bcExtra(it, rc) : '';
    var nowHtml = media && on && (playing && what || app || (tv && rc) || (tv && bcAny(it))) // a TV with a remote always has its panel, so the pad has a place
      ? '<div class="np' + (ctl || vol ? ' has-ctl' : '') + '"><span class="art" style="--app:' + (app ? app.bg : 'var(--accent)') + '">' +
        (app ? app.mark : tv && !rc ? TV : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>') +
        '</span><span class="txt">' + (neutral || stale || (tv && !rc && !playing) ? '' : '<div class="lbl">' + (it.state === 'paused' ? 'Paused' : 'Now playing') +
        '<span class="eq' + (isPlay ? ' on' : '') + '" aria-hidden="true"><i></i><i></i><i></i></span></div>') +
        '<div class="ttl">' + esc(playing && what ? what : app ? app.name : 'TV') + '</div>' +
        (app && playing && what && what !== app.name && app.name !== 'TV' ? '<div class="by">' + (tv ? 'in ' : 'on ') + esc(app.name) + '</div>' : '') + '</span>' +
        // Volume above previous/play/next (round 7).
        (vol || ctl || bcx ? '<div class="np-ctl' + (tv && rc ? ' tv' : '') + '">' + (tv && rc ? tvPadHtml(rc, remoteOpen.has(rc.id)) : '') + vol + (ctl ? (tv && rc ? ctl : '<div class="np-keys">' + ctl + '</div>') : '') + (tv && rc ? tvChipsHtml(rc, app) : bcx) + '</div>' : '') + '</div>'
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
    // A TV or display with no remote: mute (when it can) and power (when it can), both only as the device says (basic controls).
    if (media && !isSound && !rc) right = '<span class="rctl">' + bcActs(it, on, na, sb) + '</span>';
    var mSub = na ? 'Not responding' : isSound ? (muted ? 'Muted' : '') : status;
    var header = media
      ? '<div class="mhead"><div class="kind">' + icon + KIND_LABEL[kind] + '</div><div class="mname">' + esc(it.name) + '</div>' + (nowHtml || !mSub ? '' : '<div class="sub">' + esc(mSub) + '</div>') + '</div>'
      : face + '<span class="bulb">' + icon + '</span><span class="name">' + esc(it.name) + '<div class="sub">' + esc(status) + '</div></span></button>';
    return '<div class="tile' + (media ? ' media' : '') + (on && !isSound ? ' on' : '') + (na ? ' gone' : '') + (hidden.has(it.id) ? ' is-hidden' : '') + (muted ? ' muted' : '') + '" style="--c:' + c + '"><span class="glow"></span>' +
      '<div class="line">' + header +
      (tv && rc && on ? tvToggleHtml(rc, it, right) : right) + '</div>' + nowHtml + bright + (nowHtml ? '' : vol + bcx) + playRow + (isSound ? groupHtml(it) : '') +
      // The old separate Remote row is gone (Destin, 2026-10-05): the remote is an icon in the header that opens inside the now-playing panel.
      (media ? '' : paletteHtml(it)) + pendHtml(it.id, rc && rc.id) + '</div>';
  }

  var MODE_NAMES = { off: 'Off', cool: 'Cool', heat: 'Heat', heat_cool: 'Auto', auto: 'Auto', dry: 'Dry', fan_only: 'Fan' };
  var DOING = { cooling: 'Cooling', heating: 'Heating', idle: 'Holding', off: 'Off', drying: 'Drying', fan: 'Fan only' };
  function climateHtml(it, ctx) {
    var na = gone(it), mode = it.state;
    if (na) return '<div class="clim gone"><div class="line"><div class="name">' + esc(it.name) + '<div class="sub">Not responding</div></div></div></div>';
    // Redesign round 1 (Destin: "the thermostat on the home page should match the one on the Climate page"):
    // a room card and Favourites show the Climate page's dial, scaled down (thermoHero's compact form).
    return thermoHero(it, null, true);
  }

  // ── Order ───────────────────────────────────────────────────────────────
  // A chosen order lists ids; anything not in it (a new device) goes last,
  // in Home Assistant's order.
  // WHY (Destin, 2026-10-05: "disabled/broken devices should sort to the end by default"): a device that is not
  // responding goes after the working ones, in every list (rooms' cards, the Lights/Media/Climate/Cameras pages,
  // Favourites, the Cameras grid, the Edit board). Once he has put THIS list in an order himself in Edit, that
  // order is kept as it is: order[key] exists only after he moved something in that list, so its presence is
  // how his choice is told from the default. A device that comes back simply stops being "gone" and is back in its place.
  function ordered(list, key, idOf) {
    var o = order[key];
    if (!Array.isArray(o)) return list.map(function (x, i) { return [x, i]; })
      .sort(function (a, b) { return (gone(a[0]) ? 1 : 0) - (gone(b[0]) ? 1 : 0) || a[1] - b[1]; })
      .map(function (p) { return p[0]; });
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
  // bare (the Media tab's Playing together box, home-assistant-page-media.ts): only the tick list, when open; the box has its own header button.
  function groupHtml(it, bare) {
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
    if (bare) return list;
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
  // Every card carries its device's id, which is how a long press, a
  // right-click or its name opens the device's pop-up (round 5, C-device).
  function itemHtml(it, ctx) {
    if (editing && ctx) return edRowHtml(it, ctx); // redesign round 1, Edit c: Edit shows slim rows, not cards (the pop-up passes no ctx)
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
    if (d === 'binary_sensor' || d === 'button') return pcCardHtml(it); // the Computer card (home-assistant-page-computer.ts)
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
    // WHY (U8, UX review 2): Kitchen read "1 of 2 on" with its bar at zero, because the one light on (Under cabinet) cannot dim
    // and the one that can (Pendants) was off. A room that is on while nothing dimmable is lit has no brightness to average,
    // so the bar shows full (what an on/off-only light is) instead of looking switched off.
    var pct = groupPct(lit, onList), unk = pct == null; // WHY: a lit light with no level yet is left out of the average, not counted as 0
    if (unk) pct = 1;
    var key = 'room:' + room.id;
    if (dragging === key) { var liveEl = document.querySelector('[data-gbright="' + room.id + '"]'); if (liveEl) pct = Number(liveEl.value); }
    return '<input class="lr' + (unk ? ' lr-unk' : '') + '" type="range" min="1" max="100" value="' + pct + '" style="--v:' + Math.round((pct - 1) / 99 * 100) + ';--c:' + c + '" aria-label="Brightness of every light in ' + esc(room.name) + '" data-gbright="' + esc(room.id) + '">';
  }
  // Hue scenes, folded into a Scenes section of the room's Lights card
  // (round 4, Q-scenes: "collapse into a scenes expandable card in the
  // lighting group per room"). Names drop the room's own name ("Destin's
  // Room Tokyo" → "Tokyo"); the one used last is marked.
  function sceneName(sc, room) {
    var n = sc.name || sc.id;
    return n.toLowerCase().indexOf(room.name.toLowerCase() + ' ') === 0 ? n.slice(room.name.length + 1) : n;
  }
  function scenesList(room) { var l = Array.isArray(room.scenes) ? room.scenes : []; return pref('scenes') ? l : []; }
  // Redesign round 1 (Destin: "an easel type icon to the left of the main lights dropdown button"): the
  // Scenes row is now a round palette button in the Lights card's header, left of the chevron. It opens the
  // scene chips under the header on their own, whether or not the lights list below is unfolded.
  // A painter's palette, not an easel (Destin: "i want like the paint board thing").
  var SCENE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 3.5-3.6 3.5h-1.8a2 2 0 0 0-1.4 3.4c.4.4.6.9.6 1.4A1.7 1.7 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1" fill="currentColor"/><circle cx="10.5" cy="7" r="1" fill="currentColor"/><circle cx="15" cy="7.5" r="1" fill="currentColor"/><circle cx="17" cy="11" r="1" fill="currentColor"/></svg>';
  function scenesBtn(room) {
    var l = scenesList(room); if (!l.length) return '';
    var isOpen = scenesOpen.has(room.id);
    return '<button class="scn" data-scenes="' + esc(room.id) + '" aria-expanded="' + isOpen + '" aria-label="Scenes in ' + esc(room.name) + ', ' + l.length + '" title="Scenes (' + l.length + ')">' + SCENE_ICON + '</button>';
  }
  // scenesHtml (the colour cards) lives in home-assistant-page-scenes.ts.
  function lightsCard(room, lights, ctx) {
    var live = liveLights(lights), onList = live.filter(isOn), anyOn = onList.length > 0;
    var isOpen = editing || open.has(room.id);
    var c = anyOn ? colourOf(onList[0]) : 'rgb(255, 190, 110)';
    // WHY the not-responding count (U8): the Lights tab says "3 of 3 on · 1 not responding" for the same room; Home must agree.
    var nGone = lights.filter(function (it) { return gone(it); }).length;
    var status = !live.length ? 'Not responding' : (anyOn ? onList.length + ' of ' + live.length + ' on' : 'All off') + (nGone ? ' \\u00b7 ' + nGone + ' not responding' : '');
    var all = '<div class="tile all' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><span class="glow"></span><div class="line">' +
      '<button class="tile-face" data-room="' + esc(room.id) + '" data-room-to="' + (anyOn ? 'off' : 'on') + '" aria-pressed="' + anyOn + '"' + (live.length ? '' : ' disabled') +
      ' aria-label="All lights in ' + esc(room.name) + ', ' + esc(status) + '">' +
      '<span class="bulb-col"><span class="bulb">' + BULB + '</span><span class="all-lbl">All</span></span>' +
      '<span class="name">Lights<div class="sub">' + esc(status) + '</div></span></button>' +
      (editing ? '' : scenesBtn(room) + '<button class="fold" data-fold="' + esc(room.id) + '" aria-expanded="' + isOpen + '" aria-label="' + (isOpen ? 'Hide' : 'Show') + ' each light in ' + esc(room.name) + '" title="' + (isOpen ? 'Hide each light' : 'Show each light') + '">' + CHEVRON + '</button>') +
      '</div>' + groupBright(room, live, onList, c) + pendHtml('room:' + room.id) + '</div>';
    return '<div class="lights' + (anyOn ? ' on' : '') + '" style="--c:' + c + '"><span class="glow"></span>' + all + scenesHtml(room) + (isOpen ? '<div class="lights-body">' + lights.map(function (it) { return itemHtml(it, ctx); }).join('') + '</div>' : '') + '</div>';
  }

  var camCache = {};
  var camNote = {};
  function refreshCameras(force) { // force: the page was shown again or refreshed by the app, so ask everything
    if (!base || document.hidden || !rooms) return;
    allItems().forEach(function (x) {
      var it = x.it, id = it.id;
      if (domain(id) !== 'camera') return;
      // WHY skip a Nest camera already known to have no still picture (code review F8): asking cost a failing request, a rewrite of its
      // note and a redraw every 10 seconds, forever. It is asked again every 10 minutes in case that has changed.
      var known = camNote[id];
      if (!force && known && known.nest && Date.now() - (known.at || 0) < 600000) { camEvents(it); return; } // its events still refresh (camEvents asks at most once a minute)
      window.youcoded.fetch(base + '/api/camera_proxy/' + id, { as: 'picture' }).then(function (r) {
        // A tiny picture is Home Assistant's blank stand-in, not a real one.
        if (r.status === 200 && String(r.body).length > 6000) { camCache[id] = r.body; delete camNote[id]; var img = document.querySelector('img[data-cam="' + id + '"]'); if (img) img.src = r.body; else renderSoon(); return; }
        var nest = /nest|google/i.test((it.maker || '') + ' ' + (it.model || ''));
        var auth = health.flows.some(function (f) { return f.handler === 'nest' && f.context && f.context.source === 'reauth'; });
        camNote[id] = nest && auth ? { text: 'No picture: Google Nest needs you to sign in again.', link: 'Sign in', href: '/config/integrations/integration/nest' }
          // A Nest camera is shown as its events card (camera.ts), not a note.
          : nest ? { nest: true, at: Date.now() }
          : { text: 'This camera sent no picture.' };
        renderSoon();
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
      if (!gone_(it) || hidden.has(it.id) || domain(it.id) === 'remote' || remoteDevice(it) || pcHidden(it) || covered[it.entry]) return;
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
    var playing = media.filter(function (x) { var rc = isTv(x.it) ? remoteFor(x.it, x.room) : null; return x.it.state === 'playing' && !(rc && castStale(x.it, rc)) && !(isTv(x.it) && !x.it.title && !playReported(x.it)); });
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
      cameras: { big: '', unit: '' },
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
        sub: th ? (th.it.cur != null ? th.it.cur + '° inside' : '') + (th.it.state && th.it.state !== 'off' && th.it.target != null ? ' · ' + thLine(th.it) : thRange(th.it) ? thSummary(th.it) : th.it.state === 'off' ? ' · off' : '') : '' },
      // Reshaped after real use: every camera, live at once, on a tab of its own (home-assistant-page-camera.ts).
      camerasChip(),
      { id: 'problems', label: 'Problems', icon: ALERT, on: probs.length > 0, warn: probs.some(function (p) { return p.sev === 'high'; }),
        main: probs.length ? probs.length + ' to fix' : 'All good', sub: probs.length ? probs[0].title : '' },
      // Round 5 (C-activity "tab"): the house's history is a tab of its own.
      { id: 'activity', label: 'Activity', icon: ACTIVITY, on: false, main: activityCount() || 'Activity', sub: '' },
    ].map(function (c) { c.x = extra[c.id]; return c; }).filter(function (c) { return pref('chip-' + c.id) && (c.id !== 'cameras' || c.n); });
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
    if (c.id === 'cameras') return c.on ? 'rgb(235, 70, 55)' : null;
    return x.sevs.high ? 'rgb(235, 70, 55)' : (x.sevs.mid || x.sevs.low) ? 'rgb(240, 165, 40)' : 'rgb(60, 190, 110)';
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
    else if (c.id === 'cameras') b = '<b>' + c.main + '</b>';
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

  function roomHtml(room, roomIds) {
    if (editing) return edRoomHtml(room, roomIds); // redesign round 1, Edit c
    var key = 'r:' + room.id;
    var items = ordered(room.items.filter(function (it) { return !hidden.has(it.id) && domain(it.id) !== 'remote' && !remoteDevice(it) && !pcHidden(it); }), key, function (x) { return x.id; });
    if (!items.length) return '';
    var ctx = { key: key, ids: items.map(function (x) { return x.id; }) };
    // The Lights tab draws ONE card per room, "<Room> Lights", with tall light cards inside (home-assistant-page-lights.ts); the Home tab keeps lightsCard.
    if (view === 'lights') return ltRoom(room, items);
    var lights = items.filter(isLight), rest = items.filter(function (it) { return !isLight(it); });
    // One light needs no card: its own tile already does what All would.
    var lightsHtml = lights.length > 1 ? lightsCard(room, lights, ctx) : lights.map(function (it) { return itemHtml(it, ctx); }).join('');
    return '<section class="yc-card room"><div class="room-head"><h2>' + esc(room.name) + '</h2></div>' +
      lightsHtml + rest.map(function (it) { return itemHtml(it, ctx); }).join('') + '</section>';
  }

  // Redraw a part only when its drawing changed (round 7: "optimize"): an
  // unchanged check leaves the page alone, so a hovered button stays
  // hovered, focus stays put, and camera pictures do not reload.
  var drawn = {};
  function put(id, html) {
    if (drawn[id] === html) return;
    drawn[id] = html;
    // WHY morphInto, not innerHTML (redesign audit F1/F2/F9): only what differs changes, so
    // focus, held sliders, typed names, hover, transitions and a playing clip survive.
    // WHY motionBefore/After (redesign round 1, motion-nav c): the pop-up's grow and shrink need to see it appear and disappear.
    motionBefore(id, html); mediaHold(); morphInto($(id), html); mediaBack(); motionAfter(id);
    feelAfter(id); ltAfter(); // ltAfter = a colour panel on the Lights tab kept inside its card (home-assistant-page-lights.ts); feel = redesign round 1, motion-state c (home-assistant-page-feel.ts)
    // Redesign options in the practice app hook each redraw (fixtures/home-variants/).
    if (window.__homeAfterPut) window.__homeAfterPut(id);
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
    if (view === 'cameras') return head + camerasPageHtml();
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
      // WHY (Lights tab): a room whose lights ALL stopped answering goes after every working room.
      if (view === 'lights') list = ltRooms(list);
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
      // The Media tab is one list of devices, not rooms (Destin, 2026-10-05: home-assistant-page-media.ts); Edit keeps the room board.
      body += view === 'media' && !editing ? mediaTabHtml(list) : '<div class="rooms">' + list.map(function (r) { return roomHtml(r, ids); }).join('') + '</div>';
    }
    return head + edHint() + body;
  }
  // The thermostat, large: a dial whose arc fills to the setting in the mode's colour, a short line across the ring where the
  // room is now, a handle on the set point (drag it, or use the arrow keys), the setting in the middle, big - and + either side,
  // and the modes under it. The dial's parts are drawn by thDialHtml (home-assistant-page-dial.ts).
  function thermoHero(it, room, compact) {
    if (gone(it)) return '<div class="th-hero gone"><div class="th-side"><div class="th-name">' + esc(it.name) + '</div><div class="vsub">Not responding' + (it.maker && /nest/i.test(it.maker) ? ' — Google Nest needs you to sign in again (see Problems).' : '.') + '</div></div></div>';
    var mode = it.state, lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90;
    var hasSet = (it.target != null || thRange(it)) && mode !== 'off'; // Auto: a low and a high set point (home-assistant-page-climate.ts)
    var tv = thValue(it);
    var step = it.step || 1;
    var modes = Array.isArray(it.modesHvac) && it.modesHvac.length ? '<div class="th-modes" role="group" aria-label="Mode">' + it.modesHvac.map(function (m) {
      return '<button class="th-mode" aria-pressed="' + (m === mode) + '" data-mode="' + esc(it.id) + '" data-hvac="' + esc(m) + '">' + esc(MODE_NAMES[m] || m) + '</button>';
    }).join('') + '</div>' : '';
    var dial = thDialHtml(it, compact);
    var minus = hasSet ? '<button class="th-step" aria-label="Cooler" data-temp="' + esc(it.id) + '" data-delta="' + (-step) + '"' + (tv <= lo ? ' disabled' : '') + '>−</button>' : '';
    var plus = hasSet ? '<button class="th-step" aria-label="Warmer" data-temp="' + esc(it.id) + '" data-delta="' + step + '"' + (tv >= hi ? ' disabled' : '') + '>+</button>' : '';
    if (compact) {
      // WHY compact: on the Home page the same dial sits in a room card, so it is the Climate page's dial with
      // − and + either side and the modes under it. The name keeps the old card's ".line > .name" so pressing it
      // still opens the pop-up; the room is already the card's heading.
      return '<div class="th-hero clim th-compact ' + esc(mode) + (hidden.has(it.id) ? ' is-hidden' : '') + '"><span class="glow"></span>' +
        '<div class="line" style="position:relative"><div class="name">' + esc(it.name) + '</div></div>' +
        '<div class="th-row">' + minus + dial + plus + '</div>' + modes + pendHtml(it.id) + '</div>';
    }
    return '<div class="th-hero clim ' + esc(mode) + '"><span class="glow"></span>' + dial +
      '<div class="th-side"><div class="th-name">' + esc(it.name) + '<span class="vsub"> · ' + esc(room.name) + '</span></div>' +
      (hasSet ? '<div class="th-steps">' + minus + plus + '</div>' : '') + modes + pendHtml(it.id) + '</div></div>';
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

  function render() { if (batching) { batchDirty = true; return; } draw(); }
  function draw() {
    memFix(); // a device that is on with a blank level shows what it had, never 0 (home-assistant-page-memory.ts)
    camTabSync(); // the Cameras tab starts and stops its live pictures with what is on screen
    if (edDrag) { edDirty = true; return; } // a row is being dragged: nothing redraws under the finger, and it all draws when it ends (redesign round 1, Edit c)
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
      ? '<section class="yc-card room"><div class="room-head fav-head">' + STAR_ON + '<h2>Favorites</h2></div><div class="fav-grid">' + favItems.map(function (it) { return itemHtml(it, favCtx); }).join('') + '</div></section>'
      : '');
    var list = ordered(rooms.filter(function (r) { return r.items.some(function (it) { return editing || !hidden.has(it.id); }); }), 'rooms', function (r) { return r.id; });
    var roomIds = list.map(function (r) { return r.id; });
    var html = list.map(function (r) { return roomHtml(r, roomIds); }).join('');
    if (html) html += edNewZone(); // no dashed box when there is nothing to drag
    put('rooms', (html ? edHint() : '') + html || '<div class="yc-empty">Nothing to show. Put devices in rooms in Home Assistant, or press Edit to bring hidden ones back.</div>');
    edFocusBox();
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
  // WHY pendBegin/pendEnd here too (redesign round 1, Edit c): a rename or move the house
  // refuses is undone and says "Didn't work" on its own row, with Try again, like a switch.
  function renameThing(id, name) {
    var it = thing(id);
    if (!it || !name || name === it.name) return;
    fresh = [];
    setLocal(id, { name: name }); // held like a switch (audit F7): a push still carrying the old name cannot flip it back
    var tok = pendBegin(id, function () { renameThing(id, name); }, true);
    registry([{ type: 'config/entity_registry/update', entity_id: id, name: name }])
      .then(function () { pendEnd(id, tok, null); }, function (e) { pendEnd(id, tok, e && e.message ? e.message : 'Home Assistant did not take the new name.'); })
      .then(afterChange);
  }
  // index: put it back at this place in its room (code review 7).
  function relocate(id, roomId, roomName, index) {
    var it = thing(id), from = roomOf(id);
    if (!it || !from) return;
    from.items = from.items.filter(function (x) { return x.id !== id; });
    var to = rooms.filter(function (r) { return r.id === roomId; })[0];
    if (!to) { to = { id: roomId, name: roomName || roomId, items: [] }; rooms.push(to); }
    if (index == null || index > to.items.length) to.items.push(it); else to.items.splice(index, 0, it);
  }
  // extraUndo: whatever else the caller changed for the move (a saved order) and must put back if it is refused.
  function moveThing(id, roomId, roomName, extraUndo) {
    var from = roomOf(id), it = thing(id);
    if (!from || !it || from.id === roomId) return;
    var fromId = from.id, at = from.items.indexOf(it), madeArea = null;
    fresh = [];
    // WHY undo is handed to the ledger: a refusal puts it back even when a newer press on the same device has taken over (code review 6).
    var tok = pendBegin(id, function () { moveThing(id, roomId, roomName, extraUndo); }, true, function () {
      relocate(id, fromId, null, at); // not moved: back in its old room, at its old place
      rooms = rooms.filter(function (r) { return r.items.length || r.id !== roomId || !roomName; });
      if (extraUndo) extraUndo();
      // The room was made in Home Assistant before the move was refused: do not leave it empty there.
      if (madeArea) registry([{ type: 'config/area_registry/delete', area_id: madeArea }]).catch(function () { /* it stays; a retry makes a new one */ });
    });
    relocate(id, roomId, roomName);
    render();
    var moveTo = function (areaId) {
      return registry([it.device ? { type: 'config/device_registry/update', device_id: it.device, area_id: areaId } : { type: 'config/entity_registry/update', entity_id: id, area_id: areaId }]);
    };
    // A new room is made first: Home Assistant picks its id, and the move
    // needs that id, so it is two exchanges.
    (roomName
      ? registry([{ type: 'config/area_registry/create', name: roomName }]).then(function (res) { madeArea = res[0] && res[0].area_id ? res[0].area_id : roomId; return moveTo(madeArea); })
      : moveTo(roomId))
      .then(function () { pendEnd(id, tok, null); }, function (e) { pendEnd(id, tok, e && e.message ? e.message : 'Home Assistant did not move it.'); })
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
    if (scn) { if (scenesOpen.has(scn)) scenesOpen.delete(scn); else { scenesOpen.add(scn); open.delete(scn); } render(); return; }
    var sc = t.getAttribute('data-scene');
    if (sc) {
      // Mark it as the one used last straight away; the lights follow.
      rooms.forEach(function (r) { (r.scenes || []).forEach(function (x) { if (x.id === sc) x.last = new Date().toISOString(); }); });
      service('scene', 'turn_on', { entity_id: sc }, sc);
      learnScene(sc); // remembers the colours the lights settle on (home-assistant-page-scenes.ts)
      render();
      return;
    }
    var rl = t.getAttribute('data-reload');
    if (rl) {
      // Reconnect: Home Assistant reloads that integration, which is what
      // fixed the Hue bridge earlier.
      fixing[rl] = true; render();
      call('/api/config/config_entries/entry/' + encodeURIComponent(rl) + '/reload', {})
        .catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant could not reload it.', true); })
        .then(function () { setTimeout(function () { delete fixing[rl]; healthAt = 0; load(); }, 3000); });
      return;
    }
    var mp = t.getAttribute('data-mp');
    if (mp) {
      var svc = t.getAttribute('data-svc'), volTo = null;
      // WHY volume_up/down become an exact volume_set (redesign round 1, motion-state c: "the +/- buttons feel laggy"):
      // the bar used to move only after the house answered and a re-check 0.4 s later, and a "step" is whatever the
      // device decides, so quick presses could not add up on screen. Now the new level is worked out here from what is
      // shown (so five quick presses are five steps), shown at once, and sent as that exact level.
      if (svc === 'volume_up' || svc === 'volume_down') {
        var vt = thing(mp);
        if (vt && vt.vol != null) { var nv = Math.max(0, Math.min(1, Math.round((vt.vol + (svc === 'volume_up' ? 0.05 : -0.05)) * 100) / 100)); setLocal(mp, { vol: nv }); svc = 'volume_set'; volTo = nv; }
      }
      if (svc === 'media_play_pause' && !t.hasAttribute('data-neutral')) { var cur = thing(mp); if (cur) setLocal(mp, { state: cur.state === 'playing' ? 'paused' : 'playing' }); }
      var body = { entity_id: mp };
      if (volTo != null) body.volume_level = volTo;
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
      // WHY setLocal + batch (audit F7, A-6): the tick is held and undoable like a switch.
      batch(function () { next.forEach(function (m) { setLocal(m, { group: next }); }); setLocal(mem, { group: inIt ? [mem] : next }); });
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
    // A remote press goes straight to the TV: no redraw, no re-check (home-assistant-page-tv.ts).
    var rcId = t.getAttribute('data-rc');
    if (rcId) { tvPress(t, rcId); return; }
    if (t.getAttribute('data-seek')) { tvSeek(t); return; }
    var fd = t.getAttribute('data-fold');
    if (fd) {
      if (open.has(fd)) open.delete(fd); else { open.add(fd); scenesOpen.delete(fd); } // WHY: lights and scenes never open together (Destin, 2026-10-06)
      render();
      return;
    }
    var ex = t.getAttribute('data-expand');
    if (ex) {
      if (expanded.has(ex)) expanded.delete(ex); else expanded.add(ex);
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
      batch(function () { ids.forEach(function (x) { setLocal(x, { state: turnOn ? 'on' : 'off' }); }); }); // one drawing, not one per light (audit F3)
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
      if (!it) return;
      thPress(it, t.getAttribute('data-delta')); // held at once, sent once the presses stop (home-assistant-page-dial.ts)
    }
  });
  function onAct(act, id, t) {
    if (act === 'edit') {
      editing = !editing; edReset(); confirmOff = false;
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
      batch(function () { ids.forEach(function (x) { setLocal(x, { state: 'off' }); }); });
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
      // WHY data-edkey (redesign round 1, Edit c): every row and room names its list, so the order is read from the page itself.
      var ids2 = Array.from(document.querySelectorAll('[data-edkey="' + key + '"]')).map(function (b) { return b.getAttribute('data-edid'); });
      shift(key, ids2, id, act === 'up' ? -1 : 1);
      return;
    }
    if (act === 'edopen') { edOpen(t.getAttribute('data-tok')); return; }
    if (act === 'cancel') { edCancel(); return; }
    if (act === 'rename-save') {
      var box = document.querySelector('[data-rn]');
      var name = box ? box.value.trim() : '';
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
      edAfterMove(id, slug(rn));
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
      var lv = t.value / 100; holdVal(v, 'vol', lv, 4000, v); sendSlider(v, 400, lv, function () { quiet('/api/services/media_player/volume_set', { entity_id: v, volume_level: lv }, v); }); }
    var gb = t.getAttribute('data-gbright');
    if (gb) {
      dragging = 'room:' + gb;
      var gr = rooms.filter(function (r) { return r.id === gb; })[0];
      var gids = gr ? liveLights(gr.items).filter(dimmable).map(function (x) { return x.id; }) : [];
      var gp = Number(t.value);
      // WHY every light follows on THIS frame (Destin: "the individual lights lag behind and jump around"):
      // the guess is also laid on each light's own data and the page draws now, so every light's bar,
      // percent and glow move with the room's bar. The guess holds each one against per-light answers that
      // land late, one by one, out of order or capped. Lights that cannot dim, or are not responding, are
      // not in this list and are never touched; an off light that can dim turns on and joins at the bar's level.
      gids.forEach(function (x) { holdVal(x, 'brightness', Math.round(gp * 2.55), 4000, 'room:' + gb); holdVal(x, 'state', 'on', HOLD_MS, 'room:' + gb); var li = thing(x); li.state = 'on'; li.brightness = Math.round(gp * 2.55); });
      if (gids.length) render();
      if (gids.length) sendSlider('room:' + gb, 1000, gp, function () { quiet('/api/services/light/turn_on', { entity_id: gids, brightness_pct: gp }, 'room:' + gb); });
    }
    if (b && Number(t.value) > 0) { var bp = Number(t.value); holdVal(b, 'brightness', Math.round(bp * 2.55), 4000, b); sendSlider(b, 400, bp, function () { quiet('/api/services/light/turn_on', { entity_id: b, brightness_pct: bp }, b); }); }
  });
  document.addEventListener('pointerup', function () { if (dragging) setTimeout(function () { dragging = null; }, 300); });
  document.addEventListener('change', function (e) {
    var t = e.target;
    var b = t.getAttribute && t.getAttribute('data-bright');
    if (b) {
      // The big slider reaches 0: dragging all the way down turns the light off.
      if (Number(t.value) === 0) { setLocal(b, { state: 'off' }); service('light', 'turn_off', { entity_id: b }, b); return; }
      dragging = null; holdVal(b, 'brightness', Math.round(t.value * 2.55), 4000, b);
      var fb = Number(t.value); sendSlider(b, 400, fb, function () { quiet('/api/services/light/turn_on', { entity_id: b, brightness_pct: fb }, b); }, true); return;
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
      if (t.value === '__new') { newRoomFor = mv; render(); return; }
      moveThing(mv, t.value);
      edAfterMove(mv, t.value);
      return;
    }
    var gbc = t.getAttribute && t.getAttribute('data-gbright');
    if (gbc) {
      // Let go: show every light at the new brightness straight away.
      dragging = null;
      var grc = rooms.filter(function (r) { return r.id === gbc; })[0];
      var gfin = Number(t.value), gfids = grc ? liveLights(grc.items).filter(dimmable).map(function (x) { return x.id; }) : [];
      gfids.forEach(function (x) { holdVal(x, 'brightness', Math.round(gfin * 2.55), 4000, 'room:' + gbc); holdVal(x, 'state', 'on', HOLD_MS, 'room:' + gbc); });
      // The final value is always sent, once (never the same value twice).
      if (gfids.length) sendSlider('room:' + gbc, 1000, gfin, function () { quiet('/api/services/light/turn_on', { entity_id: gfids, brightness_pct: gfin }, 'room:' + gbc); }, true);
      render();
      return;
    }
    var v = t.getAttribute && t.getAttribute('data-vol');
    if (v) { var vf = t.value / 100; dragging = null; holdVal(v, 'vol', vf, 4000, v); sendSlider(v, 400, vf, function () { quiet('/api/services/media_player/volume_set', { entity_id: v, volume_level: vf }, v); }, true); }
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
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { load(); refreshCameras(true); } });
  window.youcoded.onRefresh(function () { load(); refreshCameras(true); liveStart(); });
  window.youcoded.onData(function (d) {
    d = d || {};
    hidden = new Set(Array.isArray(d.hidden) ? d.hidden : []);
    fav = new Set(Array.isArray(d.fav) ? d.fav : []);
    order = d.order && typeof d.order === 'object' ? d.order : {};
    remoteOpen = new Set(Array.isArray(d.remote) ? d.remote : []);
    sound = d.sound && typeof d.sound === 'object' ? d.sound : {};
    prefs = d.prefs && typeof d.prefs === 'object' ? d.prefs : {};
    renderSoon();
  });
${HOME_HISTORY_JS}
${HOME_LIVE_JS}
${HOME_CAMERA_JS}
${HOME_TV_JS}
${HOME_BASIC_JS}
${HOME_COMPUTER_JS}
${HOME_SCENES_JS}
${HOME_MEDIA_JS}
${HOME_LIGHTS_JS}
${HOME_REDRAW_JS}
${HOME_PENDING_JS}
${HOME_MEMORY_JS}
${HOME_EDIT_JS}
${HOME_MOTION_JS}
${HOME_FEEL_JS}
${HOME_CLIMATE_JS}
${HOME_DIAL_JS}
${HOME_TABS_JS}
  start();
})();
</script>
</body></html>`;
}

export const HOME_ASSISTANT_PAGE_HTML = homeAssistantPageHtml();
