// Design options for the "media-tab" task of the Home page redesign (round 2). Keys are
// "<option>" or "<option>-<state>" (e.g. "a", "a-group"); each becomes the
// practice screen pages/page/page-home#v-media-tab-<key>. See types.ts.
//
// WHY one card per device and no room card around it (Destin, 2026-10-05: "the page is filtered to media, so each
// card can just be a single device card"). The Media tab's drawing is replaced by a script injected INSIDE the
// page's own script (the page is one closed block, so a separate script could not reach its helpers): it flattens
// every room's players into one list, sorts it (playing first, then paused, idle, off, and unreachable LAST) and
// draws it three different ways (round 2b: the device name leads, all three). Edit mode keeps the page's own board. Controls reuse the page's own buttons
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
  // Practice only: Roam 2 and the Living Room speaker play one song together, so the grouped look can be shown. WHY these two and
  // not the Sonos Beam: the Beam belongs to the TV pair. Once someone presses a play/pause button the staging stops forcing "playing",
  // so the practice page does not look broken when you pause.
  var MV_TOUCH = false;
  document.addEventListener('click', function (e) { if (e.target && e.target.closest && e.target.closest('[data-mp]')) MV_TOUCH = true; }, true);
  function mvStage(it) {
    if (!MV_STAGE) return it;
    if (it.id !== 'media_player.living_room_speaker' && it.id !== 'media_player.roam_2') return it;
    var c = {}, k;
    for (k in it) c[k] = it[k];
    if (!MV_TOUCH) c.state = 'playing';
    c.title = 'Weightless \u2014 Marconi Union'; c.app = 'Spotify'; c.source = 'Spotify';
    c.group = ['media_player.roam_2', 'media_player.living_room_speaker'];
    return c;
  }
  function mvInfo(it, room) {
    var kind = kindOf(it), tv = kind === 'tv', rc = tv ? remoteFor(it, room) : null, power = rc || it;
    var sb = tv ? soundbarFor(it) : null, na = gone(power), on = !na && isOn(power), f = it.features || 0;
    var playing = it.state === 'playing' || it.state === 'paused';
    if (tv && rc && playing && castStale(it, rc)) playing = false;
    var what = it.title === 'TV' && kind === 'soundbar' ? 'TV sound' : it.title;
    // A TV app that never reports play/pause claims nothing (home-assistant-page-tv.ts): it is "On", with a neutral key.
    var neutral = tv && playing && !what && !playReported(it);
    var app = tv && rc ? appOf(rc.activity) : !tv ? sourceOf(it) : null;
    var st = na ? 'gone' : !on ? 'off' : (on && playing) ? (neutral ? 'on' : it.state === 'paused' ? 'paused' : 'playing') : 'idle';
    return { sb: sb, it: it, room: room, kind: kind, tv: tv, sound: kind === 'soundbar' || kind === 'speaker', rc: rc, power: power, na: na, on: on, f: f,
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
    // WHY no room here: round 2b shows the room as its own small label above the state.
    var w = '';
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
    // WHY: the page already knows which soundbar carries a TV's sound (soundbarFor: your Edit choice, else the room's one
    // soundbar with its one remote-paired TV). That bar is folded into the TV's card unless it is playing its own music.
    var folded = {};
    xs.forEach(function (x) {
      var b = x.sb && byId[x.sb.id];
      if (b && !((b.it.state === 'playing' || b.it.state === 'paused') && !b.tvAudio)) folded[b.it.id] = 1;
    });
    xs.forEach(function (x) {
      if (seen[x.it.id] || folded[x.it.id]) return;
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

  // ── Round 2b: name first ──────────────────────────────────────────────────
  // The device (and its room) is the loudest text on every card; the song or app is the quiet line.
  function mvTitle(u) { return u.members.length > 1 ? mvNames(u) : u.x.it.name; }
  // The room, as a small label: only when the name does not already say it (a group lists each room once).
  function mvRoom(u) {
    if (u.members.length < 2) return mvWhere(u.x);
    var seen = {}, out = [];
    u.members.forEach(function (m) { var r = m.room ? m.room.name : ''; if (r && !seen[r]) { seen[r] = 1; out.push(r); } });
    return out.join(' · ');
  }
  // The song or app, as the quiet line: art, then what plays and where it comes from.
  function mvNow(x, size) {
    var by = mvBy(x), w = x.what || (x.st === 'idle' ? '' : 'Nothing playing');
    return '<div class="mv-now">' + mvArt(x, size) + '<div class="mv-nowt"><div class="mv-song">' + esc(w) + '</div>' + (by ? '<div class="mv-by">' + esc(by) + '</div>' : '') + '</div></div>';
  }
  // The TV card says where its sound comes out (the same soundbar the page's own volume bar moves).
  function mvSound(x) {
    return x.sb ? '<span class="mv-snd">' + SOUNDBAR + '<span>Sound from ' + esc(x.sb.name) + ' soundbar</span></span>' : '';
  }
  function mvTogBox(u) {
    return '<div class="mv-tog"><div class="mv-togh">' + MV_LINK + 'Playing together</div>' + u.members.map(function (m) {
      var w = mvWhere(m);
      return '<div class="mv-mem"><span class="mv-mn">' + mvKind(m) + '<b>' + esc(m.it.name) + '</b>' + (w ? '<i>' + esc(w) + '</i>' : '') + '</span>' + mvVol(m) + '</div>'; }).join('') + '</div>';
  }
  function mvCtl(x, tog) {
    var keys = mvKeys(x), vol = tog ? '' : mvVol(x);
    return keys || vol ? '<div class="mv-wctl">' + (keys ? '<div class="mv-keys l">' + keys + '</div>' : '') + vol + '</div>' : '';
  }
  function mvTail(u) { return (u.members.length > 1 ? mvTogBox(u) : '') + mvGroupBar(u); }
  function mvRoomLbl(u) { var r = mvRoom(u); return r ? '<div class="mv-room">' + esc(r) + '</div>' : ''; }

  // ── Option 1 (a): the name is the card's title, the song sits under it ──
  function mvW1(u) {
    var x = u.x, tog = u.members.length > 1;
    var head = '<div class="mv-h1"><span class="mv-ic big">' + mvKind(x) + '</span><div class="mv-h1t"><div class="mv-name">' + esc(mvTitle(u)) + '</div>' + mvRoomLbl(u) + '</div>' + mvBadge(x) + (tog ? '' : mvActs(x)) + '</div>';
    return mvCard(x, 'mv-wide mv-w1', head + mvNow(x, 52) + mvSound(x) + mvCtl(x, tog) + mvTail(u));
  }
  function mvT1(u) {
    var x = u.x;
    return mvCard(x, 'mv-sq', '<div class="mv-sqtop"><div class="mv-sqn"><div class="mv-name sm">' + esc(x.it.name) + '</div>' + mvRoomLbl(u) + '</div>' + mvQuick(x) + '</div><div class="mv-rsub">' + mvSub(x) + '</div>');
  }
  // ── Option 2 (b): a header strip in the app's colour carries the name ──
  function mvW2(u) {
    var x = u.x, tog = u.members.length > 1;
    var strip = '<div class="mv-strip"><span class="mv-ic">' + mvKind(x) + '</span><div class="mv-h1t">' + mvRoomLbl(u) + '<div class="mv-name">' + esc(mvTitle(u)) + '</div></div>' + mvBadge(x) + (tog ? '' : mvActs(x)) + '</div>';
    return mvCard(x, 'mv-wide mv-w2', strip + '<div class="mv-body">' + mvNow(x, 52) + mvSound(x) + mvCtl(x, tog) + mvTail(u) + '</div>');
  }
  function mvT2(u) {
    var x = u.x;
    return mvCard(x, 'mv-sq mv-t2', '<div class="mv-tstrip"><div class="mv-name sm">' + esc(x.it.name) + '</div>' + mvRoomLbl(u) + '</div><div class="mv-tbody"><div class="mv-rsub">' + mvSub(x) + '</div>' + mvQuick(x) + '</div>');
  }
  // ── Option 3 (c): the name owns the left column, the controls own the right ──
  function mvW3(u) {
    var x = u.x, tog = u.members.length > 1;
    var left = '<div class="mv-lcol"><span class="mv-ic big">' + mvKind(x) + '</span><div><div class="mv-name">' + esc(mvTitle(u)) + '</div>' + mvRoomLbl(u) + '</div>' + mvBadge(x) + (tog ? '' : mvActs(x)) + '</div>';
    return mvCard(x, 'mv-wide mv-w3', left + '<div class="mv-rcol">' + mvNow(x, 44) + mvSound(x) + mvCtl(x, tog) + mvTail(u) + '</div>');
  }
  function mvT3(u) {
    var x = u.x;
    return mvCard(x, 'mv-lrow3', '<div class="mv-rtxt"><div class="mv-name sm">' + esc(x.it.name) + '</div><div class="mv-rsub">' + mvSub(x) + '</div></div>' + mvQuick(x));
  }

  function mvHtml(list) {
    var units = mvUnits(list), W = MV_OPT === 'a' ? mvW1 : MV_OPT === 'b' ? mvW2 : mvW3, T = MV_OPT === 'a' ? mvT1 : MV_OPT === 'b' ? mvT2 : mvT3;
    var live = units.filter(function (u) { return u.x.tier < 2; }), rest = units.filter(function (u) { return u.x.tier >= 2; });
    return '<div class="mv-wrap mv-opt' + MV_OPT + '">' + (live.length ? '<div class="mv-stage">' + live.map(W).join('') + '</div>' : mvQuiet()) +
      (rest.length ? '<div class="mv-shelfh">' + mvSec('Not Playing', rest.length) + '</div><div class="mv-shelf">' + rest.map(T).join('') + '</div>' : '') + '</div>';
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

  /* ── Round 2b: name first. Shared by all three options. ── */
  .mv-stage { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 12px; align-items: start; }
  .tile.mv-wide { padding: 14px; gap: 12px; border-radius: 22px; }
  .mv-wctl { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .mv-wctl .vrow { flex: 1 1 150px; }
  .mv-name { font-size: 21px; font-weight: 800; line-height: 1.15; color: var(--fg); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .mv-name.sm { font-size: 15px; font-weight: 700; line-height: 1.2; }
  .mv-room { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--fg-muted); line-height: 1.3; }
  .mv-ic.big { width: 44px; height: 44px; border-radius: 14px; background: color-mix(in srgb, var(--c) 22%, var(--well)); color: var(--fg); }
  .mv-ic.big svg { width: 22px; height: 22px; }
  .mv-h1t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .mv-now { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .mv-nowt { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .mv-song { font-size: 13.5px; font-weight: 600; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv-art.s52 { width: 52px; height: 52px; border-radius: 14px; font-size: 18px; }
  .mv-art.s44 { width: 44px; height: 44px; border-radius: 12px; font-size: 15px; }
  .mv-snd { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; font-size: 11.5px; color: var(--fg-2); padding: 3px 10px 3px 8px; border-radius: 9999px; background: color-mix(in srgb, var(--fg) 7%, transparent); max-width: 100%; }
  .mv-snd svg { width: 13px; height: 13px; flex-shrink: 0; color: var(--fg-muted); }
  .mv-snd span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv-tog { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 12px; border-radius: 16px; background: color-mix(in srgb, var(--fg) 5%, transparent); border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .mv-togh { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-2); }
  .mv-mem { display: flex; flex-direction: column; gap: 4px; }
  .mv-mn { display: flex; align-items: baseline; gap: 6px; font-size: 14px; color: var(--fg); }
  .mv-mn b { font-weight: 700; }
  .mv-mn i { font-style: normal; font-size: 11px; color: var(--fg-muted); }
  .mv-mn svg { width: 13px; height: 13px; color: var(--fg-muted); align-self: center; }
  .mv-shelfh { margin-top: 4px; }
  .mv-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .tile.mv-sq { min-height: 104px; padding: 12px; gap: 8px; justify-content: space-between; border-radius: 18px; }
  .mv-sqtop { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .mv-sqn { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .mv-sq .mv-act { width: 36px; padding: 0; justify-content: center; font-size: 0; gap: 0; flex-shrink: 0; }
  .mv-sq .mv-act svg { width: 16px; height: 16px; }
  .mv-sq .mv-rsub { white-space: normal; }
  .mv-sq.st-off .mv-name, .mv-sq.st-gone .mv-name { color: var(--fg-2); }

  /* Option 1: the name is the title */
  .mv-h1 { display: flex; align-items: center; gap: 12px; position: relative; }
  .mv-w1 .mv-now { padding: 10px; border-radius: 16px; background: color-mix(in srgb, var(--fg) 5%, transparent); }

  /* Option 2: a header strip in the app's colour carries the name */
  .tile.mv-w2 { padding: 0; gap: 0; overflow: hidden; }
  .mv-strip { display: flex; align-items: center; gap: 12px; padding: 12px 14px; position: relative;
    background: linear-gradient(100deg, color-mix(in srgb, var(--c) 46%, var(--panel)), color-mix(in srgb, var(--c) 18%, var(--panel))); border-bottom: 1px solid color-mix(in srgb, var(--c) 40%, var(--edge-dim)); }
  .mv-strip .mv-ic { background: color-mix(in srgb, var(--c) 40%, var(--panel)); color: var(--fg); }
  .mv-strip .mv-room { color: var(--fg-2); }
  .mv-body { display: flex; flex-direction: column; gap: 12px; padding: 14px; position: relative; }
  .st-paused .mv-strip { filter: saturate(.5); }
  .tile.mv-t2 { padding: 0; gap: 0; overflow: hidden; justify-content: flex-start; }
  .mv-tstrip { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; background: color-mix(in srgb, var(--fg) 8%, var(--panel)); border-bottom: 1px solid var(--edge-dim); }
  .mv-tbody { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; flex: 1; }
  .mv-t2 .mv-act { width: 36px; padding: 0; justify-content: center; }

  /* Option 3: the name owns the left column, controls the right */
  .tile.mv-w3 { flex-direction: row; padding: 0; gap: 0; overflow: hidden; }
  .mv-lcol { flex: 0 0 40%; max-width: 230px; min-width: 150px; overflow: hidden; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 14px; background: color-mix(in srgb, var(--c) 14%, var(--well)); border-right: 1px solid var(--edge-dim); position: relative; }
  .mv-lcol .mv-acts { margin-top: auto; }
  .mv-lcol .mv-name { font-size: 18px; -webkit-line-clamp: 3; }
  .mv-lcol .mv-room { white-space: normal; margin-top: 3px; }
  .mv-rcol { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; padding: 14px; position: relative; justify-content: flex-start; }
  .mv-w3 .mv-wctl { flex-direction: column; align-items: stretch; }
  .mv-w3 .mv-wctl .vrow { flex: none; }
  .mv-w3 .mv-keys.l { justify-content: flex-start; }
  .mv-shelf { }
  .mv-opt-c .mv-shelf, .mv-optc .mv-shelf { grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 8px; }
  .tile.mv-lrow3 { flex-direction: row; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 16px; }
  @media (max-width: 520px) {
    .tile.mv-w3 { flex-direction: column; }
    .mv-lcol { flex: none; max-width: none; flex-direction: row; flex-wrap: wrap; align-items: center; border-right: 0; border-bottom: 1px solid var(--edge-dim); }
    .mv-lcol .mv-acts { margin: 0 0 0 auto; }
    .mv-name { font-size: 19px; }
  }
`;

function build(opt: 'a' | 'b' | 'c') {
  const inject = `var MV_OPT = '${opt}', MV_STAGE = true;\n${MV_JS}\n  `;
  return {
    css: MV_CSS,
    data: { view: 'media' },
    // WHY a text rewrite (not appended script): the page is one closed block, and the Media tab's drawing sits inside it.
    transform: (html: string) => html
      .replace('function viewHtml() {', () => inject + 'function viewHtml() {')
      .replace(`body += '<div class="rooms">' + list.map(`, () => `body += view === 'media' && !editing ? mvHtml(list) : '<div class="rooms">' + list.map(`),
  };
}

// Every option shows the same house in the same state: the TV and its soundbar as one card, two speakers playing together,
// the Not Playing shelf, and one speaker that is not responding.
export const VARIANTS: HomeVariants = {
  a: { label: 'Name as the title', ...build('a') },
  b: { label: 'Name strip across the top', ...build('b') },
  c: { label: 'Name column on the left', ...build('c') },
};
