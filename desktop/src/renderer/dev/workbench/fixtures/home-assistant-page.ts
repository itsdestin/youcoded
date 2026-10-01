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

/** One request that answers "every room, and the lights, thermostats, players
 *  and cameras in it". `.get()` rather than `.attr` so a missing attribute is
 *  null in the JSON, never a template error. */
const ROOMS_TEMPLATE = `{%- set ns = namespace(rooms=[]) -%}
{%- for a in areas() -%}
{%- set ens = namespace(items=[]) -%}
{%- for e in area_entities(a) -%}
{%- set d = e.split('.')[0] -%}
{%- if d in ['light','climate','media_player','camera'] and states[e] is not none -%}
{%- set s = states[e] -%}
{%- set ens.items = ens.items + [{'id': e, 'name': s.name, 'state': s.state, 'brightness': s.attributes.get('brightness'), 'modes': s.attributes.get('supported_color_modes'), 'cur': s.attributes.get('current_temperature'), 'target': s.attributes.get('temperature'), 'min': s.attributes.get('min_temp'), 'max': s.attributes.get('max_temp'), 'step': s.attributes.get('target_temp_step'), 'vol': s.attributes.get('volume_level'), 'title': s.attributes.get('media_title'), 'features': s.attributes.get('supported_features', 0)}] -%}
{%- endif -%}
{%- endfor -%}
{%- if ens.items -%}{%- set ns.rooms = ns.rooms + [{'id': a, 'name': area_name(a), 'items': ens.items}] -%}{%- endif -%}
{%- endfor -%}
{{ ns.rooms | to_json }}`;

export const HOME_ASSISTANT_PAGE_JSON = {
  name: 'Home',
  description: 'Lights, temperature, TVs and cameras, room by room, from Home Assistant.',
  icon: 'page',
  connections: [
    {
      id: 'ha', kind: 'device', service: 'Home Assistant', address: 'homeassistant.local:8123',
      access: 'full', keyPage: '/profile/security',
      keyHelp: { steps: [
        'Press Open Home Assistant below and sign in.',
        'Scroll to the bottom, to "Long-lived access tokens", and press Create token.',
        'Name it "YouCoded", then copy the key it shows (it is shown only once) and paste it here.',
      ] },
    },
  ],
};

export const HOME_ASSISTANT_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Home</title>
<style>
  .rooms { columns: 340px; column-gap: 12px; }
  .room { break-inside: avoid; margin-bottom: 12px; display: flex; flex-direction: column; gap: 10px; }
  .room-head { display: flex; align-items: center; gap: 8px; }
  .room-head h2 { flex: 1; font-size: 15px; font-weight: 600; }
  .thing { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 10px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .thing .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thing .sub { font-size: 11px; color: var(--fg-muted); }
  .thing.off .name { color: var(--fg-2); }
  .thing.gone { opacity: .55; }
  .thing.col { flex-direction: column; align-items: stretch; }
  .thing .line { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
  .switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; border-radius: 9999px; border: 1px solid var(--edge); background: var(--well); cursor: pointer; padding: 0; transition: background-color 150ms ease; }
  .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--fg-muted); transition: transform 150ms ease, background-color 150ms ease; }
  .switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .switch[aria-checked="true"]::after { transform: translateX(16px); background: var(--on-accent); }
  .switch:disabled { opacity: .5; cursor: default; }
  .switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .temp { font-family: var(--font-mono); font-size: 28px; font-weight: 500; line-height: 1; }
  .cam { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius-md, 8px); background: var(--well); display: block; }
  .cam-empty { width: 100%; height: 56px; border-radius: var(--radius-md, 8px); background: var(--well); display: grid; place-items: center; color: var(--fg-muted); font-size: 12px; }
  .hide { visibility: hidden; }
  .editing .hide { visibility: visible; }
  .banner { padding: 10px 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge); background: var(--well); font-size: 13px; }
  @media (prefers-reduced-motion: reduce) { .switch, .switch::after { transition: none; } }
</style></head>
<body>
<div class="yc-page yc-stack" id="root">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">Home Assistant</div><h1>Home</h1></div>
    <div class="yc-row">
      <span class="yc-caption" id="hidden-count"></span>
      <button class="yc-button yc-button--sm" id="edit" aria-pressed="false">Hide things</button>
    </div>
  </div>
  <div id="banner" class="banner" hidden></div>
  <div class="rooms" id="rooms"><div class="yc-empty">Loading your rooms…</div></div>
</div>
<script>
(function () {
  var TEMPLATE = ${JSON.stringify(ROOMS_TEMPLATE)};
  var POLL_MS = 5000, CAMERA_MS = 10000;
  var base = (window.youcoded.devices || {}).ha;
  var rooms = null, editing = false, timer = null, camTimer = null, busy = {};
  var saved = window.youcoded.data || {};
  var hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden : []);
  var $ = function (id) { return document.getElementById(id); };

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function domain(id) { return id.split('.')[0]; }
  function isOn(it) { return it.state === 'on' || it.state === 'playing' || it.state === 'paused' || it.state === 'idle' || (domain(it.id) === 'climate' && it.state !== 'off'); }
  function gone(it) { return it.state === 'unavailable' || it.state === 'unknown'; }
  function dimmable(it) { return Array.isArray(it.modes) && it.modes.some(function (m) { return m !== 'onoff'; }); }

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
      rooms = JSON.parse(r.body);
      banner('');
      render();
    }).catch(function (e) { banner(e && e.message ? e.message : 'Home Assistant could not be reached.'); });
  }

  function service(dom, svc, data, id) {
    busy[id] = true;
    return call('/api/services/' + dom + '/' + svc, data)
      .catch(function (e) { banner(e && e.message ? e.message : 'That did not go through.'); })
      .then(function () { delete busy[id]; setTimeout(load, 400); });
  }

  // Optimistic: the switch moves the moment it is pressed, then the next
  // check confirms or corrects it.
  function setLocal(id, patch) {
    (rooms || []).forEach(function (room) { room.items.forEach(function (it) { if (it.id === id) Object.assign(it, patch); }); });
    render();
  }

  function sw(id, on, label, disabled) {
    return '<button class="switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '" data-toggle="' + esc(id) + '"' + (disabled ? ' disabled' : '') + '></button>';
  }
  function hideBtn(id) {
    var h = hidden.has(id);
    return '<button class="yc-button yc-button--ghost yc-button--sm hide" data-hide="' + esc(id) + '">' + (h ? 'Show' : 'Hide') + '</button>';
  }

  function itemHtml(it) {
    var d = domain(it.id), off = !isOn(it), na = gone(it);
    var cls = 'thing' + (off ? ' off' : '') + (na ? ' gone' : '');
    var sub = na ? '<div class="sub">Not responding</div>' : '';
    if (d === 'light') {
      var pct = it.brightness ? Math.round(it.brightness / 2.55) : 0;
      var slider = (!na && dimmable(it) && !off)
        ? '<input class="yc-range" type="range" min="1" max="100" value="' + pct + '" aria-label="Brightness of ' + esc(it.name) + '" data-bright="' + esc(it.id) + '">' : '';
      return '<div class="' + cls + (slider ? ' col' : '') + '"><div class="line"><div class="name">' + esc(it.name) + sub + '</div>' + hideBtn(it.id) + sw(it.id, !off && !na, it.name, na) + '</div>' + slider + '</div>';
    }
    if (d === 'climate') {
      var unit = '°';
      var step = it.step || 1;
      return '<div class="' + cls + ' col"><div class="line"><div class="name">' + esc(it.name) + sub + '</div>' + hideBtn(it.id) + '</div>' +
        (na ? '' : '<div class="line"><div><div class="temp">' + (it.cur != null ? esc(it.cur) + unit : '—') + '</div><div class="sub">Now</div></div><span class="yc-spacer"></span>' +
        '<button class="yc-button yc-button--icon yc-button--round" aria-label="Cooler" data-temp="' + esc(it.id) + '" data-delta="' + (-step) + '">−</button>' +
        '<div style="text-align:center;min-width:56px"><div class="yc-title">' + (it.target != null ? esc(it.target) + unit : 'Off') + '</div><div class="sub">Set to</div></div>' +
        '<button class="yc-button yc-button--icon yc-button--round" aria-label="Warmer" data-temp="' + esc(it.id) + '" data-delta="' + step + '">+</button></div>') + '</div>';
    }
    if (d === 'media_player') {
      var canVol = (it.features & 4) && it.vol != null && !off && !na;
      var now = it.title && !off ? '<div class="sub">' + esc(it.title) + '</div>' : sub;
      return '<div class="' + cls + (canVol ? ' col' : '') + '"><div class="line"><div class="name">' + esc(it.name) + now + '</div>' + hideBtn(it.id) + sw(it.id, !off && !na, it.name, na) + '</div>' +
        (canVol ? '<input class="yc-range" type="range" min="0" max="100" value="' + Math.round(it.vol * 100) + '" aria-label="Volume of ' + esc(it.name) + '" data-vol="' + esc(it.id) + '">' : '') + '</div>';
    }
    if (d === 'camera') {
      return '<div class="' + cls + ' col"><div class="line"><div class="name">' + esc(it.name) + sub + '</div>' + hideBtn(it.id) + '</div>' +
        (na ? '<div class="cam-empty">Camera not responding</div>' : '<img class="cam" alt="" role="img" aria-label="' + esc(it.name) + '" data-cam="' + esc(it.id) + '"' + (camCache[it.id] ? ' src="' + camCache[it.id] + '"' : '') + '>') + '</div>';
    }
    return '';
  }

  var camCache = {};
  function refreshCameras() {
    if (!base || document.hidden) return;
    document.querySelectorAll('img[data-cam]').forEach(function (img) {
      var id = img.getAttribute('data-cam');
      window.youcoded.fetch(base + '/api/camera_proxy/' + id, { as: 'picture' }).then(function (r) {
        if (r.status === 200) { camCache[id] = r.body; img.src = r.body; }
      }, function () { /* the next round tries again */ });
    });
  }

  function render() {
    var root = $('rooms');
    $('root').classList.toggle('editing', editing);
    $('edit').textContent = editing ? 'Done' : 'Hide things';
    $('edit').setAttribute('aria-pressed', editing ? 'true' : 'false');
    $('hidden-count').textContent = hidden.size && !editing ? hidden.size + ' hidden' : '';
    if (!rooms) return;
    var html = rooms.map(function (room) {
      var items = room.items.filter(function (it) { return editing || !hidden.has(it.id); });
      if (!items.length) return '';
      var lights = room.items.filter(function (it) { return domain(it.id) === 'light' && !gone(it) && !hidden.has(it.id); });
      var anyOn = lights.some(isOn);
      var roomSw = lights.length > 1 ? sw('room:' + room.id, anyOn, 'All lights in ' + room.name, false) : '';
      return '<section class="yc-card room"><div class="room-head"><h2>' + esc(room.name) + '</h2>' + roomSw + '</div>' + items.map(itemHtml).join('') + '</section>';
    }).join('');
    root.innerHTML = html || '<div class="yc-empty">Nothing to show. Put devices in rooms in Home Assistant, or press Hide things to bring hidden ones back.</div>';
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'edit') { editing = !editing; render(); return; }
    var h = t.getAttribute('data-hide');
    if (h) {
      if (hidden.has(h)) hidden.delete(h); else hidden.add(h);
      window.youcoded.save(Object.assign({}, window.youcoded.data || {}, { hidden: Array.from(hidden) }));
      render();
      return;
    }
    var id = t.getAttribute('data-toggle');
    if (id) {
      var on = t.getAttribute('aria-checked') !== 'true';
      if (id.indexOf('room:') === 0) {
        var room = rooms.find(function (r) { return 'room:' + r.id === id; });
        var ids = room.items.filter(function (it) { return domain(it.id) === 'light' && !gone(it) && !hidden.has(it.id); }).map(function (it) { return it.id; });
        ids.forEach(function (x) { setLocal(x, { state: on ? 'on' : 'off' }); });
        service('light', on ? 'turn_on' : 'turn_off', { entity_id: ids }, id);
        return;
      }
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
  document.addEventListener('change', function (e) {
    var t = e.target;
    var b = t.getAttribute && t.getAttribute('data-bright');
    if (b) { setLocal(b, { brightness: Math.round(t.value * 2.55) }); service('light', 'turn_on', { entity_id: b, brightness_pct: Number(t.value) }, b); return; }
    var v = t.getAttribute && t.getAttribute('data-vol');
    if (v) { setLocal(v, { vol: t.value / 100 }); service('media_player', 'volume_set', { entity_id: v, volume_level: t.value / 100 }, v); }
  });

  // Checking every 5 seconds only while the page is on screen (deck Q-live):
  // a minimised window stops asking, and catches up the moment it is back.
  function start() {
    stop();
    load();
    timer = setInterval(function () { if (!document.hidden && !Object.keys(busy).length) load(); }, POLL_MS);
    camTimer = setInterval(refreshCameras, CAMERA_MS);
    setTimeout(refreshCameras, 600);
  }
  function stop() { clearInterval(timer); clearInterval(camTimer); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { load(); refreshCameras(); } });
  window.youcoded.onRefresh(function () { load(); refreshCameras(); });
  window.youcoded.onData(function (d) { hidden = new Set(d && Array.isArray(d.hidden) ? d.hidden : []); render(); });
  start();
})();
</script>
</body></html>`;
