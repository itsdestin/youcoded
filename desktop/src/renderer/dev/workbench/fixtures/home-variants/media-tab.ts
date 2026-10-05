// Design options for the "media-tab" task of the Home page redesign (round 2). Keys are
// "<option>" or "<option>-<state>" (e.g. "a", "a-group"); each becomes the
// practice screen pages/page/page-home#v-media-tab-<key>. See types.ts.
//
// WHY one card per device and no room card around it (Destin, 2026-10-05: "the page is filtered to media, so each
// card can just be a single device card"). The Media tab's drawing is replaced by a script injected INSIDE the
// page's own script (the page is one closed block, so a separate script could not reach its helpers): it flattens
// every room's players into one list, sorts it (playing first, then paused, idle, off, and unreachable LAST) and
// draws it three different ways. Edit mode keeps the page's own board. Controls reuse the page's own buttons
// (data-mp / data-rc / data-vol / data-remote / data-toggle), so every press, slider and live update keeps working.
// "-group" states stage Sonos speakers playing together without touching the fake house (see mvStage below).
import type { HomeVariants } from './types';

// Plain ES5, no backticks, no dollar-brace.
const MV_JS = String.raw`
  // ── Media tab: one card per device (redesign round 2, media-tab) ───────────
  var MV_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  var MV_LINK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
  var MV_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>';
  var MV_IDLE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>';
  var MV_OFF = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>';
  var MV_GONE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>';
  var MV_WORDS = { playing: 'Playing', on: 'On', paused: 'Paused', idle: 'Idle', off: 'Off', gone: 'Not responding' };
  // Practice only: two Sonos speakers playing one song together, so the grouped look can be shown.
  function mvStage(it) {
    if (!MV_STAGE) return it;
    if (it.id !== 'media_player.destins_room' && it.id !== 'media_player.roam_2') return it;
    var c = {}, k;
    for (k in it) c[k] = it[k];
    c.state = 'playing'; c.title = 'Weightless — Marconi Union'; c.app = 'Spotify'; c.source = 'Spotify';
    c.group = ['media_player.destins_room', 'media_player.roam_2'];
    return c;
  }
  function mvInfo(it, room) {
    var kind = kindOf(it), tv = kind === 'tv', rc = tv ? remoteFor(it, room) : null, power = rc || it;
    var na = gone(power), on = !na && isOn(power), f = it.features || 0;
    var playing = it.state === 'playing' || it.state === 'paused';
    if (tv && rc && playing && castStale(it, rc)) playing = false;
    var what = it.title === 'TV' && kind === 'soundbar' ? 'TV sound' : it.title;
    // A TV app that never reports play/pause claims nothing (home-assistant-page-tv.ts): it is "On", with a neutral key.
    var neutral = tv && playing && !what && !playReported(it);
    var app = tv && rc ? appOf(rc.activity) : !tv ? sourceOf(it) : null;
    var st = na ? 'gone' : !on ? 'off' : (on && playing) ? (neutral ? 'on' : it.state === 'paused' ? 'paused' : 'playing') : 'idle';
    return { it: it, room: room, kind: kind, tv: tv, sound: kind === 'soundbar' || kind === 'speaker', rc: rc, power: power, na: na, on: on, f: f,
      what: what || (app ? app.name : ''), app: app, neutral: neutral, st: st, tier: { playing: 0, on: 0, paused: 1, idle: 2, off: 3, gone: 4 }[st],
      tvAudio: kind === 'soundbar' && (it.source === 'TV' || it.title === 'TV') };
  }
  function mvKind(x) { return x.kind === 'tv' ? TV : x.kind === 'soundbar' ? SOUNDBAR : x.kind === 'display' ? DISPLAY : SPEAKER; }
  function mvWhere(x) { return x.room && x.it.name.toLowerCase().indexOf(x.room.name.toLowerCase()) < 0 ? x.room.name : ''; }
  function mvBy(x) { return x.app && x.what !== x.app.name && x.app.name !== 'TV' && x.st !== 'idle' ? (x.tv ? 'in ' : 'on ') + x.app.name : ''; }
  function mvArt(x, size) {
    var plain = !x.app || String(x.app.bg).indexOf('var(') === 0;
    return '<span class="mv-art s' + size + (plain ? ' plain' : '') + '" style="--app:' + (x.app ? x.app.bg : 'var(--accent)') + '">' + (x.app ? x.app.mark : MV_NOTE) + '</span>';
  }
  function mvGlyph(st) { return st === 'playing' || st === 'on' ? eqBars(true) : st === 'paused' ? MV_PAUSE : st === 'idle' ? MV_IDLE : st === 'off' ? MV_OFF : MV_GONE; }
  // The state, said by shape and colour first and by a word second.
  function mvBadge(x) { return '<span class="mv-b ' + x.st + '">' + mvGlyph(x.st) + MV_WORDS[x.st] + '</span>'; }
  function mvKeys(x) {
    var it = x.it, isPlay = it.state === 'playing', f = x.f, out = '';
    var btn = function (attrs, label, icon, main) { return '<button class="key' + (main ? ' main' : '') + '" ' + attrs + ' aria-label="' + label + '" title="' + label + '">' + icon + '</button>'; };
    if (x.tv && x.rc && x.on) {
      var rk = function (cmd, label, icon, main) { return btn('data-rc="' + esc(x.rc.id) + '" data-cmd="' + cmd + '"', label, icon, main); };
      out = rk('MEDIA_PREVIOUS', 'Previous', PREV) + rk('MEDIA_PLAY_PAUSE', x.neutral ? 'Play or pause' : isPlay ? 'Pause' : 'Play', x.neutral ? PLAYPAUSE : isPlay ? PAUSE : PLAY, true) + rk('MEDIA_NEXT', 'Next', NEXT);
    } else if (!x.tv && x.on && (f & 1) && !x.tvAudio) {
      var mk = function (svc, label, icon, main) { return btn('data-mp="' + esc(it.id) + '" data-svc="' + svc + '"', label, icon, main); };
      var skip = x.st === 'playing' || x.st === 'paused';
      out = (skip && (f & 16) ? mk('media_previous_track', 'Previous', PREV) : '') + mk('media_play_pause', isPlay ? 'Pause' : x.st === 'paused' ? 'Resume' : 'Play', isPlay ? PAUSE : PLAY, true) + (skip && (f & 32) ? mk('media_next_track', 'Next', NEXT) : '');
    }
    return out;
  }
  function mvVol(x) {
    var sb = x.tv ? soundbarFor(x.it) : null;
    return x.on || (x.sound && !x.na) ? volRow(x.it, x.tv && !sb ? null : (sb || x.it), x.tv ? x.rc : null) : '';
  }
  // The little round buttons: a TV gets its remote (a placeholder icon: the remote's own design is another task) and
  // power; a speaker gets mute.
  function mvActs(x) {
    var it = x.it, out = '';
    if (x.tv) {
      if (x.rc && x.on) { var open = remoteOpen.has(x.rc.id); out += '<button class="pwr mv-rm" data-remote="' + esc(x.rc.id) + '" aria-expanded="' + open + '" aria-label="Remote for ' + esc(it.name) + '" title="Remote">' + REMOTE + '</button>'; }
      if (!x.na) out += '<button class="pwr" data-toggle="' + esc(x.power.id) + '" aria-pressed="' + x.on + '" aria-label="Turn ' + esc(it.name) + (x.on ? ' off' : ' on') + '" title="' + (x.on ? 'Turn off' : 'Turn on') + '">' + POWER + '</button>';
    } else if ((x.f & 8) && !x.na) {
      var m = !!it.muted;
      out += '<button class="pwr mute" data-mp="' + esc(it.id) + '" data-svc="volume_mute" data-mute="' + (m ? 'false' : 'true') + '" aria-pressed="' + m + '" aria-label="' + (m ? 'Unmute ' : 'Mute ') + esc(it.name) + '" title="' + (m ? 'Unmute' : 'Mute') + '">' + volIcon(m ? 0 : 70, m) + '</button>';
    }
    return out ? '<div class="mv-acts">' + out + '</div>' : '';
  }
  // The one obvious action on a device that is not playing.
  function mvQuick(x) {
    if (x.na) return '';
    if (x.st === 'off') return '<button class="mv-act" data-toggle="' + esc(x.power.id) + '" aria-pressed="false" aria-label="Turn on ' + esc(x.it.name) + '">' + POWER + 'Turn on</button>';
    if (x.st === 'idle' && !x.tv && (x.f & 1)) return '<button class="mv-act main" data-mp="' + esc(x.it.id) + '" data-svc="media_play_pause" aria-label="Play ' + esc(x.it.name) + '">' + PLAY + 'Play</button>';
    return mvActs(x);
  }
  function mvRemote(x) { return x.rc && x.on && remoteOpen.has(x.rc.id) ? '<div class="rcard open mv-remote">' + remoteHtml(x.rc) + '</div>' : ''; }
  function mvCard(x, cls, inner) {
    var on = x.st === 'playing' || x.st === 'on';
    return '<div data-eid="' + esc(x.it.id) + '" class="tile media mv st-' + x.st + ' ' + cls + (on ? ' on' : '') + (x.it.muted ? ' muted' : '') + '" style="--c:' + (x.app ? x.app.bg : 'var(--accent)') + '"><span class="glow"></span>' +
      inner + mvRemote(x) + pendHtml(x.it.id, x.rc && x.rc.id) + '</div>';
  }
  function mvNames(u) { return u.members.map(function (m) { return m.it.name; }).join(' + '); }
  function mvSub(x) {
    var w = mvWhere(x);
    var s = x.st === 'idle' ? (x.tv ? 'On' + (x.app ? ' · ' + x.app.name : '') : 'Idle') : MV_WORDS[x.st];
    return '<span class="mv-g ' + x.st + '">' + mvGlyph(x.st) + '</span>' + esc(s + (w ? ' · ' + w : ''));
  }
  function mvUnits(list) {
    var xs = [], byId = {}, seen = {}, units = [];
    list.forEach(function (r) {
      r.items.forEach(function (it) {
        if (domain(it.id) !== 'media_player' || hidden.has(it.id) || remoteDevice(it)) return;
        var x = mvInfo(mvStage(it), roomOf(it.id) || r);
        x.i = xs.length; xs.push(x); byId[it.id] = x;
      });
    });
    xs.forEach(function (x) {
      if (seen[x.it.id]) return;
      var g = groupOf(x.it).filter(function (m) { return byId[m] && !byId[m].na; });
      if (g.length > 1) { g.forEach(function (m) { seen[m] = 1; }); units.push({ x: byId[g[0]], members: g.map(function (m) { return byId[m]; }) }); }
      else { seen[x.it.id] = 1; units.push({ x: x, members: [x] }); }
    });
    // Playing first, unreachable last; a stable sort keeps the house's own order inside each step.
    return units.map(function (u, i) { return [u, i]; }).sort(function (a, b) { return a[0].x.tier - b[0].x.tier || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  function mvSec(label, n) { return '<h3 class="mv-sec">' + label + '<b>' + n + '</b></h3>'; }
  function mvQuiet() { return '<div class="mv-quiet">' + MV_NOTE + '<span>Nothing is playing right now.</span></div>'; }
  function mvGroupBar(u) { return u.x.sound ? groupHtml(u.x.it) : ''; }

  // ── A: Now playing hero ──
  function mvAHero(u) {
    var x = u.x, tog = u.members.length > 1;
    var by = mvBy(x), w = mvWhere(x);
    var top = '<div class="mv-htop">' + mvArt(x, 84) + '<div class="mv-htxt">' + mvBadge(x) +
      '<div class="mv-ttl">' + esc(x.what || x.it.name) + '</div>' + (by ? '<div class="mv-by">' + esc(by) + '</div>' : '') +
      '<div class="mv-dev">' + mvKind(x) + '<span>' + esc(tog ? mvNames(u) : x.it.name + (w ? ' · ' + w : '')) + '</span></div></div>' + (tog ? '' : mvActs(x)) + '</div>';
    var together = tog ? '<div class="mv-tog"><div class="mv-togh">' + MV_LINK + 'Playing together</div>' + u.members.map(function (m) {
      return '<div class="mv-mem"><span class="mv-mn">' + mvKind(m) + esc(m.it.name) + '</span>' + mvVol(m) + '</div>'; }).join('') + '</div>' : '';
    var keys = mvKeys(x);
    return mvCard(x, 'mv-hero', top + (keys ? '<div class="mv-keys">' + keys + '</div>' : '') + (tog ? together : mvVol(x)) + mvGroupBar(u));
  }
  function mvARow(u) {
    var x = u.x, w = mvWhere(x);
    return mvCard(x, 'mv-row', '<span class="mv-ic">' + mvKind(x) + '</span><div class="mv-rtxt"><div class="mv-rname">' + esc(x.it.name) + '</div><div class="mv-rsub">' + mvSub(x) + '</div></div>' + mvQuick(x));
  }
  function mvA(units) {
    var live = units.filter(function (u) { return u.x.tier === 0; }), paused = units.filter(function (u) { return u.x.tier === 1; }), idle = units.filter(function (u) { return u.x.tier >= 2 && u.x.tier < 4; }), gn = units.filter(function (u) { return u.x.tier === 4; });
    return '<div class="mv-wrap mv-opta">' + (live.length ? mvSec('Playing now', live.length) + '<div class="mv-heroes">' + live.map(mvAHero).join('') + '</div>' : paused.length ? '' : mvQuiet()) +
      (paused.length ? mvSec('Paused', paused.length) + '<div class="mv-heroes">' + paused.map(mvAHero).join('') + '</div>' : '') +
      (idle.length ? mvSec('Not playing', idle.length) + '<div class="mv-list">' + idle.map(mvARow).join('') + '</div>' : '') +
      (gn.length ? mvSec('Not responding', gn.length) + '<div class="mv-list">' + gn.map(mvARow).join('') + '</div>' : '') + '</div>';
  }

  // ── B: Stage and shelf ──
  function mvBWide(u) {
    var x = u.x, tog = u.members.length > 1, by = mvBy(x), w = mvWhere(x);
    var head = '<div class="mv-wtop">' + mvArt(x, 72) + '<div class="mv-htxt">' + mvBadge(x) + '<div class="mv-ttl small">' + esc(x.what || x.it.name) + '</div>' +
      '<div class="mv-dev">' + mvKind(x) + '<span>' + esc((tog ? mvNames(u) : x.it.name + (w ? ' · ' + w : '')) + (by ? ' · ' + by : '')) + '</span></div></div>' + (tog ? '' : mvActs(x)) + '</div>';
    var chips = tog ? '<div class="mv-chips">' + MV_LINK + '<span>Playing together</span>' + u.members.map(function (m) { return '<i>' + mvKind(m) + esc(m.it.name) + '</i>'; }).join('') + '</div>' : '';
    var keys = mvKeys(x), vol = mvVol(x);
    return mvCard(x, 'mv-wide', head + chips + (keys || vol ? '<div class="mv-wctl">' + (keys ? '<div class="mv-keys l">' + keys + '</div>' : '') + vol + '</div>' : '') + mvGroupBar(u));
  }
  function mvBTile(u) {
    var x = u.x, w = mvWhere(x), open = x.rc && x.on && remoteOpen.has(x.rc.id);
    return mvCard(x, 'mv-sq' + (open ? ' rem-open' : ''), '<div class="mv-sqtop"><span class="mv-ic">' + mvKind(x) + '</span>' + mvQuick(x) + '</div>' +
      '<div class="mv-sqtxt"><div class="mv-rname wrap">' + esc(x.it.name) + '</div><div class="mv-rsub">' + mvSub(x) + '</div></div>');
  }
  function mvB(units) {
    var live = units.filter(function (u) { return u.x.tier < 2; }), rest = units.filter(function (u) { return u.x.tier >= 2; });
    return '<div class="mv-wrap mv-optb">' + (live.length ? '<div class="mv-stage">' + live.map(mvBWide).join('') + '</div>' : mvQuiet()) +
      (rest.length ? '<div class="mv-shelfh">' + mvSec('On the shelf', rest.length) + '</div><div class="mv-shelf">' + rest.map(mvBTile).join('') + '</div>' : '') + '</div>';
  }

  // ── C: One list, live rows ──
  function mvCRow(u) {
    var x = u.x, tog = u.members.length > 1, live = x.tier < 2, w = mvWhere(x), by = mvBy(x);
    if (!live) return mvCard(x, 'mv-lrow', '<div class="mv-lmain"><span class="mv-ic">' + mvKind(x) + '</span><div class="mv-rtxt"><div class="mv-rname">' + esc(x.it.name) + '</div><div class="mv-rsub">' + mvSub(x) + '</div></div>' + mvQuick(x) + '</div>');
    var line2 = tog ? '<span class="mv-tg">' + MV_LINK + esc(mvNames(u) + ' together') + '</span>' : esc(x.it.name + (w ? ' · ' + w : '') + (by ? ' · ' + by : ''));
    var keys = mvKeys(x), vol = mvVol(x);
    return mvCard(x, 'mv-lrow live', '<div class="mv-lmain">' + mvArt(x, 48) + '<div class="mv-rtxt"><div class="mv-rname big">' + esc(x.what || x.it.name) + '</div><div class="mv-rsub">' + line2 + '</div></div>' + mvBadge(x) + (tog ? '' : mvActs(x)) + '</div>' +
      (keys || vol ? '<div class="mv-lsub">' + (keys ? '<div class="mv-keys l">' + keys + '</div>' : '') + vol + '</div>' : '') + mvGroupBar(u));
  }
  function mvC(units) { return '<div class="mv-wrap mv-optc">' + units.map(mvCRow).join('') + '</div>'; }

  function mvHtml(list) {
    var units = mvUnits(list);
    return MV_OPT === 'a' ? mvA(units) : MV_OPT === 'b' ? mvB(units) : mvC(units);
  }
`;

const MV_CSS = String.raw`
  /* Media tab, round 2: one card per device, no room card around it. Everything here is scoped to .mv. */
  .mv-wrap { display: flex; flex-direction: column; gap: 12px; min-width: 0; width: 100%; }
  .mv-sec { margin: 6px 2px 0; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-muted); display: flex; align-items: center; gap: 8px; }
  .mv-sec b { font-weight: 700; color: var(--fg-2); background: color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 9999px; padding: 1px 8px; letter-spacing: 0; }
  .mv-quiet { display: flex; align-items: center; gap: 12px; padding: 22px 18px; border-radius: 22px; border: 1px dashed var(--edge); color: var(--fg-muted); font-size: 13px; }
  .mv-quiet svg { width: 22px; height: 22px; flex-shrink: 0; }
  .tile.mv { min-width: 0; }
  /* Album-art stand-in: the app's own colour, lit from a corner, with faint rings so it reads as a record. */
  .mv-art { flex-shrink: 0; display: grid; place-items: center; position: relative; overflow: hidden; color: #fff; font-weight: 800; font-size: 20px;
    background: linear-gradient(150deg, color-mix(in srgb, var(--app) 80%, #fff), var(--app) 52%, color-mix(in srgb, var(--app) 68%, #000));
    box-shadow: 0 10px 22px -10px var(--app), inset 0 1px 0 rgba(255,255,255,.35); }
  .mv-art::after { content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(circle at 78% 120%, transparent 36%, rgba(255,255,255,.16) 37% 38.5%, transparent 40% 52%, rgba(255,255,255,.1) 53% 54.5%, transparent 56%); }
  .mv-art.plain { color: var(--on-accent); }
  .mv-art svg { width: 46%; height: 46%; position: relative; z-index: 1; }
  .mv-art > span { position: relative; z-index: 1; }
  .mv-art.s84 { width: 84px; height: 84px; border-radius: 22px; font-size: 28px; }
  .mv-art.s72 { width: 72px; height: 72px; border-radius: 20px; font-size: 24px; }
  .mv-art.s48 { width: 48px; height: 48px; border-radius: 14px; font-size: 16px; }
  .st-paused .mv-art { filter: saturate(.55) brightness(.93); }
  /* States: the badge and the glyph say it by shape and colour before a word is read. */
  .mv-b { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 3px 9px 3px 8px; border-radius: 9999px; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg-2); white-space: nowrap; }
  .mv-b .eq { margin: 0; height: 10px; }
  .mv-b.playing, .mv-b.on { background: color-mix(in srgb, var(--accent) 24%, transparent); color: var(--fg); }
  .mv-b.paused { background: color-mix(in srgb, #e8a33d 26%, transparent); color: var(--fg); }
  .mv-b.paused svg { color: #d28f1f; }
  .mv-b.gone { background: color-mix(in srgb, #d9534f 18%, transparent); color: var(--fg-2); }
  .mv-b.gone svg { color: #d9534f; }
  .mv-g { display: inline-flex; align-items: center; margin-right: 5px; color: var(--fg-muted); }
  .mv-g .eq { margin: 0; height: 10px; }
  .mv-g.paused { color: #d28f1f; } .mv-g.gone { color: #d9534f; } .mv-g.playing { color: var(--accent); }
  /* Text */
  .mv-htxt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .mv-ttl { font-size: 20px; font-weight: 700; line-height: 1.2; color: var(--fg); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .mv-ttl.small { font-size: 16px; }
  .mv-by { font-size: 12px; color: var(--fg-2); }
  .mv-dev { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-muted); min-width: 0; }
  .mv-dev svg { width: 13px; height: 13px; flex-shrink: 0; }
  .mv-dev span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv-acts { display: flex; gap: 6px; flex-shrink: 0; }
  .mv .pwr[aria-expanded="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .mv-keys { display: flex; align-items: center; justify-content: center; gap: 14px; }
  .mv-keys.l { gap: 8px; flex-shrink: 0; }
  .mv .key.main { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .mv .vrow { min-width: 0; }
  .mv .vwrap { min-width: 0; }
  .mv-remote { margin-top: 2px; }
  .mv.st-gone { opacity: .62; border-style: dashed; }
  .mv.st-gone .mv-ic { background: transparent; }
  .mv.st-off { opacity: .85; }
  /* Quiet one-line devices */
  .mv-ic { width: 38px; height: 38px; flex-shrink: 0; display: grid; place-items: center; border-radius: 12px; background: var(--well); color: var(--fg-muted); }
  .mv-ic svg { width: 18px; height: 18px; }
  .mv-rtxt { flex: 1; min-width: 0; }
  .mv-rname { font-size: 14px; font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mv-rname.big { font-size: 15.5px; font-weight: 700; }
  .mv-rname.wrap { white-space: normal; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .mv-rsub { display: flex; align-items: center; font-size: 11.5px; color: var(--fg-muted); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mv-act { flex-shrink: 0; height: 34px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--well); color: var(--fg); display: inline-flex; align-items: center; gap: 6px; padding: 0 14px 0 11px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .mv-act svg { width: 14px; height: 14px; }
  .mv-act.main { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .mv-act:hover { border-color: var(--fg-muted); }
  .mv-act:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ── A: Now playing hero ── */
  .mv-heroes { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 400px), 1fr)); gap: 14px; align-items: start; }
  .tile.mv-hero { padding: 18px; gap: 16px; border-radius: 26px; }
  .mv-htop { display: flex; gap: 16px; align-items: flex-start; position: relative; }
  .mv-hero .mv-keys { gap: 16px; }
  .mv-hero .key { width: 46px; height: 46px; }
  .mv-hero .key.main { width: 60px; height: 60px; }
  .mv-hero .key.main svg { width: 24px; height: 24px; }
  .mv-tog { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; border-radius: 18px; background: color-mix(in srgb, var(--fg) 5%, transparent); border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .mv-togh { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-2); }
  .mv-mem { display: flex; flex-direction: column; gap: 4px; }
  .mv-mn { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--fg); }
  .mv-mn svg { width: 13px; height: 13px; color: var(--fg-muted); }
  .mv-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 8px; }
  .tile.mv-row { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 16px; }
  .mv-row > .rcard, .mv-row > .pend { flex-basis: 100%; }

  /* ── B: Stage and shelf ── */
  .mv-stage { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 12px; }
  .tile.mv-wide { padding: 14px; gap: 12px; border-radius: 22px; }
  .mv-wtop { display: flex; gap: 14px; align-items: flex-start; position: relative; }
  .mv-wctl { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .mv-wctl .vrow { flex: 1 1 150px; }
  .mv-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-2); }
  .mv-chips svg { width: 14px; height: 14px; }
  .mv-chips > span { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin-right: 4px; }
  .mv-chips i { font-style: normal; display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 9999px; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  .mv-chips i svg { width: 12px; height: 12px; color: var(--fg-muted); }
  .mv-shelfh { margin-top: 4px; }
  .mv-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(136px, 1fr)); gap: 10px; }
  .tile.mv-sq { min-height: 128px; padding: 12px; gap: 8px; justify-content: space-between; border-radius: 20px; }
  .mv-sq.rem-open { grid-column: 1 / -1; }
  .mv-sqtop { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .mv-sq .mv-act { width: 38px; padding: 0; justify-content: center; }
  .mv-sq .mv-act { font-size: 0; gap: 0; }
  .mv-sq .mv-act svg { width: 16px; height: 16px; }
  .mv-sq .mv-rsub { white-space: normal; }

  /* ── C: One list, live rows ── */
  .mv-optc { max-width: 780px; gap: 8px; }
  .tile.mv-lrow { padding: 0; gap: 0; border-radius: 18px; --rail: var(--fg-faint); }
  .mv-lrow::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 4px; border-radius: 0 4px 4px 0; background: var(--rail); z-index: 1; }
  .mv-lrow.st-playing, .mv-lrow.st-on { --rail: var(--accent); }
  .mv-lrow.st-paused { --rail: #e8a33d; }
  .mv-lrow.st-gone { --rail: #d9534f; }
  .mv-lrow.st-off { --rail: transparent; }
  .mv-lmain { display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 18px; position: relative; }
  .mv-lrow.live .mv-lmain { padding: 14px 14px 8px 18px; }
  .mv-lsub { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 4px 14px 14px 18px; position: relative; }
  .mv-lsub .vrow { flex: 1 1 170px; }
  .mv-lrow > .rcard { margin: 0 14px 14px 18px; }
  .mv-lrow > .gcard { margin: 0 14px 14px 18px; }
  .mv-tg { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); font-weight: 600; }
  .mv-lrow .mv-rsub { font-size: 12px; }
  @media (max-width: 520px) {
    .tile.mv-hero { padding: 14px; border-radius: 22px; }
    .mv-art.s84 { width: 68px; height: 68px; border-radius: 18px; }
    .mv-ttl { font-size: 18px; }
    .mv-lmain { flex-wrap: wrap; }
    .mv-lrow.live .mv-lmain > .mv-rtxt { flex-basis: calc(100% - 140px); }
  }
`;

function build(opt: 'a' | 'b' | 'c', stage: boolean) {
  const inject = `var MV_OPT = '${opt}', MV_STAGE = ${stage};\n${MV_JS}\n  `;
  return {
    css: MV_CSS,
    data: { view: 'media' },
    // WHY a text rewrite (not appended script): the page is one closed block, and the Media tab's drawing sits inside it.
    transform: (html: string) => html
      .replace('function viewHtml() {', () => inject + 'function viewHtml() {')
      .replace(`body += '<div class="rooms">' + list.map(`, () => `body += view === 'media' && !editing ? mvHtml(list) : '<div class="rooms">' + list.map(`),
  };
}

export const VARIANTS: HomeVariants = {
  a: { label: 'Now playing hero', ...build('a', false) },
  'a-group': { label: 'Now playing hero, speakers together', ...build('a', true) },
  b: { label: 'Stage and shelf', ...build('b', false) },
  'b-group': { label: 'Stage and shelf, speakers together', ...build('b', true) },
  c: { label: 'One list, live rows', ...build('c', false) },
  'c-group': { label: 'One list, live rows, speakers together', ...build('c', true) },
};
