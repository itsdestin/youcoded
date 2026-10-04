// Design mockups for the Home page's next round (2026-10-04 questions deck,
// Q-order "designs first"): three versions each of the device page, the
// activity list and the camera card. Workbench only — `?pagesHome=mock-<name>`
// adds this script to the real Home page, which draws as usual against the
// pretend Home Assistant; the mockup is then laid over it. The history,
// activity and video here are drawn, not fetched: they show a shape for Destin
// to pick, and the chosen one is built properly afterwards. Never shipped.
// Names: device-inplace|popup|panel, activity-tab|feed|timeline,
// camera-tap|always|events (screens/pages.ts lists them).

const MOCK_CSS = `
  .mk-seg { display: inline-flex; border: 1px solid var(--edge); border-radius: 9999px; overflow: hidden; background: var(--well); }
  .mk-seg button { appearance: none; border: 0; background: transparent; color: var(--fg-2); font: inherit; font-size: 12px; padding: 5px 12px; cursor: pointer; }
  .mk-seg button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
  .mk-h { display: flex; align-items: center; gap: 10px; }
  .mk-h .t { flex: 1; min-width: 0; }
  .mk-h .t b { display: block; font-size: 15px; font-weight: 600; }
  .mk-h .t span { font-size: 12px; color: var(--fg-muted); }
  .mk-ic { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--c, var(--accent)); color: #1a1a1a; flex-shrink: 0; }
  .mk-x { appearance: none; width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); display: grid; place-items: center; cursor: pointer; padding: 0; }
  .mk-sec { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); margin: 4px 0 2px; }
  .mk-hist { display: flex; flex-direction: column; }
  .mk-row { display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid var(--edge-dim); font-size: 13px; }
  .mk-row:first-child { border-top: 0; }
  .mk-row .when { color: var(--fg-muted); font-family: var(--font-mono); font-size: 12px; padding-top: 1px; }
  .mk-row .by { display: block; font-size: 11px; color: var(--fg-muted); margin-top: 2px; }
  .mk-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--d, var(--fg-faint)); margin-right: 6px; vertical-align: 1px; }
  .mk-about { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; }
  .mk-about dt { color: var(--fg-muted); }
  .mk-about dd { margin: 0; }
  .mk-bar { height: 30px; border-radius: 10px; background: linear-gradient(to right, var(--c) 71%, var(--well) 0); position: relative; }
  .mk-bar::after { content: ''; position: absolute; left: calc(71% - 10px); top: 30%; width: 3px; height: 40%; background: rgba(0,0,0,.3); border-radius: 2px; }
  .mk-link { color: var(--accent); font-size: 12px; text-decoration: none; }
  /* Device page, in place: the tile itself opens into the page. */
  .mk-inplace { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge); background: var(--inset); box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 45%, transparent); }
  /* Device page, pop-up over the page. */
  .mk-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 50; display: grid; place-items: center; padding: 24px; }
  .mk-pop { width: min(720px, 100%); max-height: 100%; overflow: auto; border-radius: var(--radius-lg, 12px); border: 1px solid var(--edge); background: var(--panel); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  .mk-pop .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  /* Device page, side panel: the rooms stay usable on the left. */
  #root.mk-paneled { padding-right: 350px; }
  .mk-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 330px; border-left: 1px solid var(--edge); background: var(--panel); padding: 18px; display: flex; flex-direction: column; gap: 14px; overflow: auto; z-index: 40; }
  /* Activity. */
  #root.mk-act #favs, #root.mk-act #rooms, #root.mk-act #view { display: none; }
  .mk-acts { display: flex; flex-direction: column; gap: 12px; }
  .mk-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .mk-chip { appearance: none; font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); cursor: pointer; }
  .mk-chip[aria-pressed="true"] { background: var(--fg); color: var(--canvas); border-color: var(--fg); }
  .mk-sep { width: 1px; height: 18px; background: var(--edge); margin: 0 4px; }
  .mk-day { font-size: 12px; font-weight: 600; color: var(--fg-2); margin: 6px 0 0; }
  .mk-ev { display: grid; grid-template-columns: 70px 30px 1fr auto; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--radius-md, 8px); background: var(--inset); border: 1px solid var(--edge-dim); font-size: 13px; }
  .mk-ev .when { font-family: var(--font-mono); font-size: 12px; color: var(--fg-muted); }
  .mk-ev .i { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: color-mix(in srgb, var(--d) 22%, transparent); color: var(--d); }
  .mk-ev .room { font-size: 11px; color: var(--fg-muted); text-align: right; }
  .mk-ev .by { display: block; font-size: 11px; color: var(--fg-muted); }
  .mk-feed { display: flex; flex-direction: column; gap: 6px; }
  .mk-feed .mk-ev { padding: 6px 10px; }
  .mk-tl { display: grid; grid-template-columns: 120px 1fr; gap: 6px 10px; align-items: center; font-size: 12px; }
  .mk-tl .lane { position: relative; height: 22px; border-radius: 6px; background: var(--well); }
  .mk-tl .lane i { position: absolute; top: 3px; bottom: 3px; border-radius: 4px; background: var(--d); opacity: .85; }
  .mk-tl .axis { position: relative; height: 14px; color: var(--fg-muted); font-family: var(--font-mono); font-size: 10px; }
  .mk-tl .axis span { position: absolute; transform: translateX(-50%); }
  .mk-now { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--accent); }
  /* Cameras. */
  .mk-cam { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-md, 8px); overflow: hidden; background: #0e1116; }
  .mk-cam .mk-scene, .mk-evs .thumb .mk-scene { position: absolute; inset: 0; display: block; }
  .mk-cam .stamp { position: absolute; right: 8px; top: 8px; color: #fff; opacity: .75; font-family: var(--font-mono); font-size: 10px; }
  .mk-cam.dim .mk-scene { filter: brightness(.35) blur(2px); }
  .mk-live { position: absolute; top: 8px; left: 8px; display: flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 9999px; background: rgba(0,0,0,.55); color: #fff; font-size: 11px; font-weight: 600; }
  .mk-live::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #ff4d4d; }
  .mk-play { position: absolute; inset: 0; margin: auto; width: 56px; height: 56px; border-radius: 50%; border: 0; background: rgba(255,255,255,.9); color: #111; display: grid; place-items: center; cursor: pointer; }
  .mk-caption { position: absolute; left: 0; right: 0; bottom: 0; padding: 18px 10px 8px; background: linear-gradient(transparent, rgba(0,0,0,.7)); color: #fff; font-size: 12px; display: flex; gap: 8px; align-items: center; }
  .mk-caption .sp { flex: 1; }
  .mk-cbtn { appearance: none; width: 28px; height: 28px; border-radius: 50%; border: 0; background: rgba(255,255,255,.18); color: #fff; display: grid; place-items: center; cursor: pointer; padding: 0; }
  .mk-camrow { display: flex; align-items: center; gap: 10px; font-size: 13px; }
  .mk-camrow .name { flex: 1; font-weight: 500; }
  .mk-camrow .sub { font-size: 11px; color: var(--fg-muted); }
  .mk-evs { display: flex; flex-direction: column; gap: 4px; }
  .mk-evs .e { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--well); font-size: 12px; }
  .mk-evs .e .thumb { width: 56px; height: 32px; border-radius: 5px; overflow: hidden; position: relative; flex-shrink: 0; }
  .mk-evs .e .w { flex: 1; }
  .mk-evs .e time { color: var(--fg-muted); font-family: var(--font-mono); font-size: 11px; }
`;

// The mockup script runs inside the page, after the page's own script.
const MOCK_JS = String.raw`
(function () {
  var NAME = window.__homeMockup;
  function ico(d, w) { return '<svg width="' + (w || 16) + '" height="' + (w || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var BULB = ico('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/>');
  var X = ico('<path d="M18 6 6 18M6 6l12 12"/>', 14);
  var SPK = ico('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>');
  var TH = ico('<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>');
  var CAM = ico('<path d="M23 7l-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>');
  var WARN = ico('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>');
  var PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
  var MUTE = ico('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>', 14);
  var FULL = ico('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>', 14);
  var ACT = ico('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>');
  var LAMP = '#ffb066';

  // ── Pretend data ────────────────────────────────────────────────────────
  var HISTORY = [
    ['7:42 pm', 'Turned on · 71%', 'Living Room switch', LAMP],
    ['6:10 pm', 'Turned off', 'This page', null],
    ['5:55 pm', 'Scene: Relax', 'Hue app', LAMP],
    ['8:02 am', 'Turned off', 'Automation “Lights out at 8”', null],
    ['Yesterday', 'Turned on · 100%', 'Google Home (“Hey Google”)', LAMP],
  ];
  var ABOUT = [['Maker', 'Signify (Philips Hue)'], ['Model', 'Hue Go · LLC020'], ['Connects via', 'Hue Bridge'], ['Room', 'Living Room'], ['Added', '2 March 2026'], ['Software', '1.108.7']];
  var EVENTS = [
    ['Today', '7:42 pm', 'Floor lamp turned on · 71%', 'Living Room switch', 'Living Room', LAMP, BULB],
    ['Today', '7:30 pm', "Destin's Room TV started YouTube", 'TV remote', "Destin's Room", '#ff4b4b', SPK],
    ['Today', '7:05 pm', 'Thermostat set to 72°', 'This page', 'Upstairs', '#4da3ff', TH],
    ['Today', '6:48 pm', 'Motion at the Doorbell', 'Doorbell camera', 'Front door', '#b07cff', CAM],
    ['Today', '6:10 pm', 'Floor lamp turned off', 'This page', 'Living Room', '#8a8f98', BULB],
    ['Today', '5:55 pm', 'Scene Relax turned on', 'Hue app', 'Living Room', LAMP, BULB],
    ['Today', '4:12 pm', 'TV backlight stopped responding', 'Philips Hue', "Destin's Room", '#ff9f1a', WARN],
    ['Yesterday', '11:48 pm', 'Floor lamp turned on · 100%', 'Google Home', 'Living Room', LAMP, BULB],
    ['Yesterday', '10:20 pm', 'Living Room speaker played Clair de Lune', 'Spotify', 'Living Room', '#1ed760', SPK],
  ];
  // A pretend camera picture, painted with plain gradients (the class "scene" belongs to the Hue scene chips, and an SVG came
  // out oval inside the page).
  function scene(hue, t) {
    var bg = 'radial-gradient(circle at 78% 22%, rgba(255,227,168,.55) 0 6%, transparent 7%),' +
      'linear-gradient(hsl(' + hue + ',15%,10%), hsl(' + hue + ',15%,10%)) 0 100% / 100% 29% no-repeat,' +
      'linear-gradient(hsl(' + hue + ',18%,24%), hsl(' + hue + ',18%,24%)) 88% 70% / 34% 28% no-repeat,' +
      'linear-gradient(hsla(' + hue + ',30%,55%,.35), hsla(' + hue + ',30%,55%,.35)) 12% 30% / 25% 39% no-repeat,' +
      'linear-gradient(hsl(' + hue + ',25%,32%), hsl(' + hue + ',20%,14%))';
    return '<span class="mk-scene" style="background:' + bg + '"></span>' + (t ? '<span class="stamp">' + t + '</span>' : '');
  }

  function head(sub) {
    return '<div class="mk-h"><span class="mk-ic" style="--c:' + LAMP + '">' + BULB + '</span><div class="t"><b>Floor lamp</b><span>' + sub + '</span></div><button class="mk-x" aria-label="Close">' + X + '</button></div>';
  }
  function hist(n) {
    return '<div class="mk-hist">' + HISTORY.slice(0, n || 5).map(function (h) {
      return '<div class="mk-row"><span class="when">' + h[0] + '</span><span><span class="mk-dot" style="--d:' + (h[3] || 'var(--fg-faint)') + '"></span>' + h[1] + '<span class="by">by ' + h[2] + '</span></span></div>';
    }).join('') + '</div>';
  }
  function about() {
    return '<dl class="mk-about">' + ABOUT.map(function (a) { return '<dt>' + a[0] + '</dt><dd>' + a[1] + '</dd>'; }).join('') + '</dl>' +
      '<a class="mk-link" href="#">Open in Home Assistant ↗</a>';
  }
  function controls() { return '<div class="mk-bar" style="--c:' + LAMP + '"></div>'; }

  function lampTile() { var b = document.querySelector('[data-toggle="light.living_room_lamp"]'); return b && b.closest('.tile'); }
  function camThing(id) { var el = document.querySelector('[data-cam="' + id + '"]') || null; if (el) return el.closest('.thing'); var all = document.querySelectorAll('.thing.col'); for (var i = 0; i < all.length; i++) if (all[i].textContent.indexOf(id === 'camera.doorbell' ? 'Doorbell' : 'Living room camera') === 0) return all[i]; return null; }

  var MOCKS = {
    'device-inplace': function () {
      var t = lampTile(); if (!t) return false;
      var box = document.createElement('div');
      box.className = 'mk-inplace'; box.setAttribute('data-mk', ''); box.style.setProperty('--c', LAMP);
      box.innerHTML = head('On · 71% · Living Room') + controls() +
        '<div class="mk-seg" role="tablist"><button aria-pressed="false">Controls</button><button aria-pressed="true">History</button><button aria-pressed="false">About</button></div>' + hist(5);
      t.replaceWith(box); return true;
    },
    'device-popup': function () {
      if (!lampTile()) return false;
      var s = document.createElement('div'); s.className = 'mk-scrim'; s.setAttribute('data-mk', '');
      s.innerHTML = '<div class="mk-pop" role="dialog" aria-label="Floor lamp">' + head('On · 71% · Living Room') + controls() +
        '<div class="cols"><div><div class="mk-sec">History</div>' + hist(5) + '</div><div><div class="mk-sec">About this device</div>' + about() + '</div></div></div>';
      document.body.appendChild(s); return true;
    },
    'device-panel': function () {
      var t = lampTile(); if (!t) return false;
      t.style.boxShadow = '0 0 0 2px ' + LAMP;
      document.getElementById('root').classList.add('mk-paneled');
      var p = document.createElement('aside'); p.className = 'mk-panel'; p.setAttribute('data-mk', '');
      p.innerHTML = head('On · 71% · Living Room') + controls() + '<div class="mk-sec">History</div>' + hist(5) + '<div class="mk-sec">About this device</div>' + about();
      document.body.appendChild(p); return true;
    },
    'activity-tab': function () { return activity('list'); },
    'activity-timeline': function () { return activity('timeline'); },
    'activity-feed': function () {
      var favs = document.getElementById('favs'), rooms = document.getElementById('rooms');
      if (!rooms || !rooms.querySelector('.room')) return false;
      var c = document.createElement('section'); c.className = 'yc-card room'; c.setAttribute('data-mk', '');
      c.innerHTML = '<div class="room-head">' + ACT + '<h2>Recently</h2><button class="yc-button yc-button--sm yc-button--ghost">See all 23</button></div>' +
        '<div class="mk-feed">' + EVENTS.slice(0, 4).map(evRow).join('') + '</div>';
      favs.parentNode.insertBefore(c, favs); return true;
    },
    'camera-tap': function () { return cams('tap'); },
    'camera-always': function () { return cams('always'); },
    'camera-events': function () { return cams('events'); },
  };

  function evRow(e) {
    return '<div class="mk-ev" style="--d:' + e[5] + '"><span class="when">' + e[1] + '</span><span class="i">' + e[6] + '</span><span>' + e[2] + '<span class="by">by ' + e[3] + '</span></span><span class="room">' + e[4] + '</span></div>';
  }
  function activity(kind) {
    var chips = document.getElementById('chips'), root = document.getElementById('root');
    if (!chips || !chips.querySelector('.pill')) return false;
    // An Activity pill joins the row and is the open one.
    chips.querySelectorAll('.pill').forEach(function (p) { p.classList.remove('sel'); });
    var pill = document.createElement('button'); pill.className = 'pill sel'; pill.setAttribute('data-mk', ''); pill.innerHTML = '<span class="pill-ic">' + ACT + '</span>Activity';
    (chips.querySelector('.pills') || chips.firstElementChild || chips).appendChild(pill);
    root.classList.add('mk-act');
    var box = document.createElement('div'); box.className = 'mk-acts'; box.setAttribute('data-mk', '');
    var rooms = ['All rooms', "Destin's Room", 'Living Room', 'Kitchen', 'Upstairs', 'Front door'];
    var types = ['Lights', 'Media', 'Climate', 'Cameras', 'Problems'];
    var filters = '<div class="mk-filters">' + rooms.map(function (r, i) { return '<button class="mk-chip" aria-pressed="' + (i === 0) + '">' + r + '</button>'; }).join('') +
      '<span class="mk-sep"></span>' + types.map(function (t) { return '<button class="mk-chip" aria-pressed="false">' + t + '</button>'; }).join('') + '</div>';
    var top = '<div class="vhead"><span class="vicon2">' + ACT + '</span><div class="vtitle"><h2>Activity</h2><span class="vsub">23 changes today · 4 rooms</span></div></div>';
    if (kind === 'list') {
      var days = ['Today', 'Yesterday'];
      box.innerHTML = top + filters + days.map(function (d) {
        return '<div class="mk-day">' + d + '</div>' + EVENTS.filter(function (e) { return e[0] === d; }).map(evRow).join('');
      }).join('');
    } else {
      // When things were on, over the last 24 hours: one lane per device.
      var lanes = [
        ['Floor lamp', LAMP, [[0, 4], [73, 75], [80, 86]]],
        ['Overhead light', LAMP, [[30, 52], [76, 100]]],
        ["Destin's Room TV", '#ff4b4b', [[82, 100]]],
        ['Living Room speaker', '#1ed760', [[3, 7], [60, 66]]],
        ['Thermostat (cooling)', '#4da3ff', [[45, 58], [70, 92]]],
        ['Doorbell motion', '#b07cff', [[41, 42], [78, 79], [88, 89]]],
      ];
      var axis = ['8 pm', '2 am', '8 am', '2 pm', '8 pm'];
      box.innerHTML = top + filters +
        '<div class="yc-card" style="padding:14px"><div class="mk-tl">' + lanes.map(function (l) {
          return '<span>' + l[0] + '</span><div class="lane" style="--d:' + l[1] + '">' + l[2].map(function (s) { return '<i style="left:' + s[0] + '%;width:' + (s[1] - s[0]) + '%"></i>'; }).join('') + '<span class="mk-now" style="left:97%"></span></div>';
        }).join('') + '<span></span><div class="axis">' + axis.map(function (a, i) { return '<span style="left:' + (i * 25) + '%">' + a + '</span>'; }).join('') + '</div></div></div>' +
        '<div class="mk-day">Around 7 pm</div>' + EVENTS.slice(0, 4).map(evRow).join('');
    }
    document.getElementById('favs').parentNode.insertBefore(box, document.getElementById('favs'));
    return true;
  }

  function cams(kind) {
    var lr = camThing('camera.living_room_camera'), db = camThing('camera.doorbell');
    if (!lr || !db) return false;
    function card(name, room, hue, state) {
      var body;
      if (state === 'idle') {
        body = '<div class="mk-cam dim">' + scene(hue, '') + '<button class="mk-play" aria-label="Watch ' + name + ' live">' + PLAY + '</button>' +
          '<div class="mk-caption"><span>Tap to watch live</span><span class="sp"></span><span>Motion 6:48 pm</span></div></div>';
      } else if (state === 'live') {
        body = '<div class="mk-cam">' + scene(hue, '7:51:12 PM') + '<span class="mk-live">LIVE</span>' +
          '<div class="mk-caption"><span>' + (kind === 'tap' ? 'Stops in 0:48' : 'Live while on screen') + '</span><span class="sp"></span><button class="mk-cbtn" aria-label="Sound">' + MUTE + '</button><button class="mk-cbtn" aria-label="Full screen">' + FULL + '</button></div></div>';
      } else {
        body = '<div class="mk-evs">' + [['Person', '6:48 pm', 270], ['Motion', '2:14 pm', 200], ['Doorbell rang', '11:02 am', 30]].map(function (e) {
          return '<div class="e"><span class="thumb">' + scene(e[2], '') + '</span><span class="w">' + e[0] + '</span><time>' + e[1] + '</time></div>';
        }).join('') + '</div><button class="yc-button yc-button--sm yc-button--primary" style="align-self:flex-start">' + PLAY.replace('22', '14').replace('22', '14') + ' Watch live</button>';
      }
      return '<div class="thing col" data-mk><div class="mk-camrow"><span class="name">' + name + '</span><span class="sub">' + room + '</span></div>' + body + '</div>';
    }
    if (kind === 'tap') { lr.outerHTML = card('Living room camera', 'Nest Cam', 210, 'idle'); db.outerHTML = card('Doorbell', 'Nest Doorbell', 30, 'live'); }
    else if (kind === 'always') { lr.outerHTML = card('Living room camera', 'Nest Cam', 210, 'live'); db.outerHTML = card('Doorbell', 'Nest Doorbell', 30, 'live'); }
    else { lr.outerHTML = card('Living room camera', 'Nest Cam', 210, 'events'); db.outerHTML = card('Doorbell', 'Nest Doorbell', 30, 'events'); }
    return true;
  }

  var st = document.createElement('style'); st.textContent = ${JSON.stringify(MOCK_CSS)}; document.head.appendChild(st);
  // Wait for the page to draw its rooms, then lay the mockup over it — and
  // again whenever the page's own redraw (every 5 seconds) wipes part of it.
  var want = 0;
  setInterval(function () {
    var f = MOCKS[NAME];
    if (!f || document.hidden) return;
    var have = document.querySelectorAll('[data-mk]').length;
    if (want && have === want) return;
    document.querySelectorAll('[data-mk]').forEach(function (el) { el.remove(); });
    try { if (f()) { want = document.querySelectorAll('[data-mk]').length; document.documentElement.setAttribute('data-mockup-ready', NAME); try { parent.postMessage({ homeMockupReady: NAME }, '*'); } catch (e2) { /* no parent */ } } } catch (e) { /* page not drawn yet */ }
  }, 100);
})();
`;

/** The Home page with one mockup laid over it. */
export function withHomeMockup(html: string, name: string): string {
  return html.replace('</body>', '<script>window.__homeMockup = ' + JSON.stringify(name) + ';</script><script>' + MOCK_JS + '</script></body>');
}
