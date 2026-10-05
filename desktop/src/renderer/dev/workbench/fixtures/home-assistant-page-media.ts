// The Media tab (Destin, 2026-10-05, round 2 "option A" + his changes), built for real. Kept apart from home-assistant-page.ts
// so neither file outgrows its line budget; HOME_MEDIA_JS is pasted INSIDE the page's script (shares esc, thing, volRow, kindOf,
// remoteFor, soundbarFor, groupOf, groupHtml, tvKeysHtml ...). Template string: no backticks, no dollar-brace, no backslashes.
//
// WHAT IT DRAWS: one list of devices, no room card around them (the tab is already filtered to media).
//  - Playing and paused devices are wide cards. The DEVICE NAME is the big title, its room small above/under it; what is
//    playing sits in a "now playing" box below, with the play/pause/skip keys at the RIGHT END of that box so the volume
//    sliders under it can run the full card width.
//  - Everything else (idle, off, not responding) is a small tile on a "Not Playing" shelf below. Order: playing, paused, idle, off,
//    not responding last (dimmed).
//  - The volume lives INSIDE the now-playing box, directly under the song row (Destin, round 2c: "volume slider should just be part of
//    the same glass media card ... a sub-card in the media card"), so song, keys and volume are one glass sub-card. There is no separate
//    soundbar box any more.
//  - A TV and its soundbar are ONE card (soundbarFor decides which bar carries the TV's sound): that sub-card's slider controls the
//    SOUNDBAR, labelled with a small speaker icon and the soundbar's name, and the card gets a Group button for the soundbar.
//  - Speakers playing together are ONE card with a Playing together box and one volume bar per speaker. The old "Playing with..."
//    bar is not drawn here; adding or removing speakers is a small button in that box's header (or, for a speaker playing alone, in
//    the card's header), which opens the same tick list the Home tab uses.
//  - A TV with a remote is always a wide card (so its remote icon, pad and app buttons have a place), even with nothing playing.
// WHY controls reuse the page's own buttons (data-mp / data-rc / data-vol / data-remote / data-toggle / data-group): every press,
// every slider (the pending/target model in home-assistant-page-pending.ts) and every live update keeps working unchanged.

export const HOME_MEDIA_JS = `
  // ── Media tab ──────────────────────────────────────────────────────────────
  var MV_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  var MV_LINK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
  var MV_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>';
  var MV_IDLE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>';
  var MV_ON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>';
  var MV_OFF = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>';
  var MV_GONE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>';
  var MV_WORDS = { playing: 'Playing', on: 'On', paused: 'Paused', idle: 'Idle', off: 'Off', gone: 'Not responding' };
  // Everything the tab needs to know about one player, worked out once.
  function mvInfo(it, room) {
    var kind = kindOf(it), tv = kind === 'tv', rc = tv ? remoteFor(it, room) : null, power = rc || it;
    var sb = tv ? soundbarFor(it) : null, na = gone(power), on = !na && isOn(power), f = it.features || 0;
    var playing = it.state === 'playing' || it.state === 'paused';
    if (tv && rc && playing && castStale(it, rc)) playing = false;
    var what = it.title === 'TV' && kind === 'soundbar' ? 'TV sound' : it.title;
    // A TV app that never reports play/pause claims nothing (home-assistant-page-tv.ts): it is "On", with a neutral key.
    var neutral = tv && playing && !what && !playReported(it);
    var app = tv && rc ? appOf(rc.activity) : !tv ? sourceOf(it) : null;
    // WHY a TV with a remote that is on is "On" (not "Idle"): it stays a wide card so the remote has somewhere to open.
    var st = na ? 'gone' : !on ? 'off' : (on && playing) ? (neutral ? 'on' : it.state === 'paused' ? 'paused' : 'playing') : (tv && rc ? 'on' : 'idle');
    return { sb: sb, it: it, room: room, kind: kind, tv: tv, sound: kind === 'soundbar' || kind === 'speaker', rc: rc, power: power, na: na, on: on, f: f,
      what: what || (app ? app.name : tv ? 'TV' : ''), app: app, neutral: neutral, st: st, tier: { playing: 0, on: 0, paused: 1, idle: 2, off: 3, gone: 4 }[st],
      tvAudio: kind === 'soundbar' && (it.source === 'TV' || it.title === 'TV') };
  }
  function mvKind(x) { return x.kind === 'tv' ? TV : x.kind === 'soundbar' ? SOUNDBAR : x.kind === 'display' ? DISPLAY : SPEAKER; }
  // The room, only when the device's own name does not already say it.
  function mvWhere(x) { return x.room && x.it.name.toLowerCase().indexOf(x.room.name.toLowerCase()) < 0 ? x.room.name : ''; }
  function mvBy(x) { return x.app && x.what !== x.app.name && x.app.name !== 'TV' && x.st !== 'idle' ? (x.tv ? 'in ' : 'on ') + x.app.name : ''; }
  function mvArt(x, size) {
    var plain = !x.app || String(x.app.bg).indexOf('var(') === 0;
    return '<span class="mv-art s' + size + (plain ? ' plain' : '') + '" style="--app:' + (x.app ? x.app.bg : 'var(--accent)') + '">' + (x.app ? x.app.mark : MV_NOTE) + '</span>';
  }
  // WHY the "On" mark is a still dot (never the moving bars): "On" is exactly the case where the page does not know that anything plays.
  function mvGlyph(st) { return st === 'playing' ? eqBars(true) : st === 'on' ? MV_ON : st === 'paused' ? MV_PAUSE : st === 'idle' ? MV_IDLE : st === 'off' ? MV_OFF : MV_GONE; }
  // The state, said by shape and colour first and by a word second.
  function mvBadge(x) { return '<span class="mv-b ' + x.st + '">' + mvGlyph(x.st) + MV_WORDS[x.st] + '</span>'; }
  // The play/pause/skip keys. A TV: its one row of seven (home-assistant-page-tv.ts). A speaker: its own three.
  function mvKeys(x) {
    var it = x.it, isPlay = it.state === 'playing', f = x.f;
    if (x.tv && x.rc && x.on) return tvKeysHtml(it, x.rc, x.neutral, isPlay);
    if (!x.tv && x.on && (f & 1) && !x.tvAudio) {
      var mk = function (svc, label, icon, main) { return '<button class="key' + (main ? ' main' : '') + '" data-mp="' + esc(it.id) + '" data-svc="' + svc + '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>'; };
      var skip = x.st === 'playing' || x.st === 'paused';
      return '<div class="np-keys">' + (skip && (f & 16) ? mk('media_previous_track', 'Previous', PREV) : '') + mk('media_play_pause', isPlay ? 'Pause' : x.st === 'paused' ? 'Resume' : 'Play', isPlay ? PAUSE : PLAY, true) + (skip && (f & 32) ? mk('media_next_track', 'Next', NEXT) : '') + '</div>';
    }
    return '';
  }
  function mvVol(x) {
    var sb = x.tv ? soundbarFor(x.it) : null;
    return x.on || (x.sound && !x.na) ? volRow(x.it, x.tv && !sb ? null : (sb || x.it), x.tv ? x.rc : null) : '';
  }
  function mvCanGroup(it) { return canGroup(it) && !gone(it) && allItems().some(function (o) { return o.it.id !== it.id && canGroup(o.it); }); }
  // The button that opens the tick list for adding or removing speakers (the Home tab's "Playing with..." bar did this).
  function mvGroupBtn(it, label) {
    if (!mvCanGroup(it)) return '';
    var o = groupOpen.has(it.id);
    return '<button class="mv-gbtn" data-group="' + esc(it.id) + '" aria-expanded="' + o + '" aria-label="Choose which speakers play with ' + esc(it.name) + '" title="Choose speakers">' + MV_LINK + esc(label) + '</button>';
  }
  // The little round buttons: a TV gets its remote icon and power; a speaker gets mute.
  function mvActs(x) {
    var it = x.it, out = '';
    if (x.tv) {
      if (!x.na) {
        var pw = '<button class="pwr" data-toggle="' + esc(x.power.id) + '" aria-pressed="' + x.on + '" aria-label="Turn ' + esc(it.name) + (x.on ? ' off' : ' on') + '" title="' + (x.on ? 'Turn off' : 'Turn on') + '">' + POWER + '</button>';
        out += x.rc && x.on ? tvToggleHtml(x.rc, it, pw) : pw;
      }
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
  // A failed press shows its note on the card that shows the device (a folded-in soundbar has no card of its own).
  function mvPend(ids) { for (var i = 0; i < ids.length; i++) { var h = ids[i] ? pendHtml(ids[i]) : ''; if (h) return h; } return ''; }
  function mvCard(x, cls, inner, more) {
    var on = x.st === 'playing' || x.st === 'on';
    return '<div data-eid="' + esc(x.it.id) + '" class="tile media mv st-' + x.st + ' ' + cls + (on ? ' on' : '') + (x.it.muted ? ' muted' : '') + '" style="--c:' + (x.app ? x.app.bg : 'var(--accent)') + '"><span class="glow"></span>' +
      inner + mvPend([x.it.id, x.rc && x.rc.id].concat(more || [])) + '</div>';
  }
  // The devices, in order. One unit per card: a group of speakers is one unit; a soundbar folded into its TV is not a unit.
  function mvUnits(list) {
    var xs = [], byId = {}, seen = {}, units = [];
    list.forEach(function (r) {
      r.items.forEach(function (it) {
        if (domain(it.id) !== 'media_player' || hidden.has(it.id) || remoteDevice(it)) return;
        var x = mvInfo(it, roomOf(it.id) || r);
        xs.push(x); byId[it.id] = x;
      });
    });
    // WHY: the page already knows which soundbar carries a TV's sound (soundbarFor: your Edit choice, else the room's one soundbar
    // with its one remote-paired TV). That bar is folded into the TV's card unless it is playing its own music.
    var folded = {};
    xs.forEach(function (x) {
      var b = x.sb && byId[x.sb.id];
      if (b && !((b.it.state === 'playing' || b.it.state === 'paused') && !b.tvAudio)) folded[b.it.id] = 1;
    });
    // WHY (soundbar Group button): speakers grouped WITH a TV's soundbar are listed in that TV's card (a Playing together box), never as a
    // second card with the same soundbar in it; they are marked seen before the main loop so their own turn skips them.
    var extras = {};
    xs.forEach(function (x) {
      var b = x.sb && byId[x.sb.id];
      if (!b || !folded[b.it.id]) return;
      extras[x.it.id] = groupOf(b.it).filter(function (m) { return m !== b.it.id && m !== x.it.id && byId[m] && !byId[m].na; }).map(function (m) { seen[m] = 1; return byId[m]; });
    });
    xs.forEach(function (x) {
      if (seen[x.it.id] || folded[x.it.id]) return;
      var g = groupOf(x.it).filter(function (m) { return byId[m] && !byId[m].na; });
      if (g.length > 1) { g.forEach(function (m) { seen[m] = 1; }); units.push({ x: byId[g[0]], members: g.map(function (m) { return byId[m]; }) }); }
      else { seen[x.it.id] = 1; units.push({ x: x, members: [x], extra: extras[x.it.id] || [] }); }
    });
    // Playing first, unreachable last; a stable sort keeps the house's own order inside each step.
    return units.map(function (u, i) { return [u, i]; }).sort(function (a, b) { return a[0].x.tier - b[0].x.tier || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }
  function mvSec(label, n) { return '<h3 class="mv-sec">' + label + '<b>' + n + '</b></h3>'; }
  function mvQuiet() { return '<div class="mv-quiet">' + MV_NOTE + '<span>Nothing is playing right now.</span></div>'; }
  // The device name is the card's title; a group lists each name.
  function mvTitle(u) { return u.members.length > 1 ? u.members.map(function (m) { return m.it.name; }).join(' + ') : u.x.it.name; }
  // The room, as a small label: only when the name does not already say it (a group lists each room once).
  function mvRoom(u) {
    if (u.members.length < 2) return mvWhere(u.x);
    var seen = {}, out = [];
    u.members.forEach(function (m) { var r = m.room ? m.room.name : ''; if (r && !seen[r]) { seen[r] = 1; out.push(r); } });
    return out.join(' · ');
  }
  function mvRoomLbl(u) { var r = mvRoom(u); return r ? '<div class="mv-room">' + esc(r) + '</div>' : ''; }
  // The now-playing box: art, what plays, the keys at its right end, then the volume directly under that row (one glass sub-card).
  // A TV's pad and app buttons open below the volume, inside it too.
  function mvNow(x, vol) {
    var by = mvBy(x), w = x.what || (x.st === 'idle' ? '' : 'Nothing playing'), tvx = x.tv && x.rc && x.on;
    return '<div class="np mv-np' + (tvx ? ' tv' : '') + '"><div class="mv-nprow">' + mvArt(x, 52) + '<span class="txt mv-nowt"><div class="ttl mv-song">' + esc(w) + '</div>' + (by ? '<div class="by">' + esc(by) + '</div>' : '') + '</span>' + mvKeys(x) + '</div>' + (vol || '') +
      (tvx ? tvPadHtml(x.rc, remoteOpen.has(x.rc.id)) + tvChipsHtml(x.rc, x.app) : '') + '</div>';
  }
  // A glass box with a small title: the soundbar's volume, or the speakers playing together (one look for both).
  function mvBox(title, icon, inner, head) { return '<div class="mv-tog"><div class="mv-togh">' + icon + '<span>' + esc(title) + '</span>' + (head || '') + '</div>' + inner + '</div>'; }
  function mvTogBox(u) {
    // WHY the first speaker that can group (not always the first one): the tick list joins speakers to "this" one, and a group's
    // leader may be a speaker that cannot lead (a Nest Mini playing along with a Sonos).
    var lead = u.members.map(function (m) { return m.it; }).filter(mvCanGroup)[0];
    return mvBox('Playing together', MV_LINK, u.members.map(function (m) {
      var w = mvWhere(m);
      return '<div class="mv-mem"><span class="mv-mn">' + mvKind(m) + '<b>' + esc(m.it.name) + '</b>' + (w ? '<i>' + esc(w) + '</i>' : '') + '</span>' + mvVol(m) + '</div>';
    }).join('') + (lead ? groupHtml(lead, true) : ''), lead ? mvGroupBtn(lead, 'Change') : '');
  }
  // The volume inside the now-playing box. A TV with a soundbar: the slider is the SOUNDBAR's, said by a small speaker icon and its name.
  // A group has no slider here (its Playing together box has one per speaker).
  function mvSubVol(u) {
    var x = u.x;
    if (u.members.length > 1) return '';
    var v = mvVol(x);
    if (!v) return '';
    var lbl = x.tv && x.sb ? '<span class="mv-vlbl" title="Volume of ' + esc(x.sb.name) + '">' + SOUNDBAR + '<span>' + esc(x.sb.name) + '</span></span>' : '';
    return '<div class="mv-vol">' + lbl + v + '</div>';
  }
  // Speakers playing with a TV's soundbar: their own bar each, and the button that changes who plays along.
  function mvExtraBox(u) {
    var x = u.x, sb = x.sb;
    return mvBox('Playing together', MV_LINK, u.extra.map(function (m) {
      var w = mvWhere(m);
      return '<div class="mv-mem"><span class="mv-mn">' + mvKind(m) + '<b>' + esc(m.it.name) + '</b>' + (w ? '<i>' + esc(w) + '</i>' : '') + '</span>' + mvVol(m) + '</div>';
    }).join('') + groupHtml(sb, true), mvGroupBtn(sb, 'Change'));
  }
  function mvWide(u) {
    var x = u.x, tog = u.members.length > 1;
    var head = '<div class="mv-h1"><span class="mv-ic big">' + mvKind(x) + '</span><div class="mv-h1t"><div class="mv-name">' + esc(mvTitle(u)) + '</div>' + mvRoomLbl(u) + '</div>' + mvBadge(x) + (tog ? '' : mvActs(x)) + '</div>';
    // A speaker playing alone (or a TV's soundbar) can still start a group: the button sits under the sub-card, the list opens there.
    var lead = tog ? null : x.sound ? x.it : x.tv && x.sb ? x.sb : null, extra = !tog && u.extra && u.extra.length && lead;
    var grp = extra ? mvExtraBox(u) : lead ? mvGroupBtn(lead, 'Group') + groupHtml(lead, true) : '';
    return mvCard(x, 'mv-wide', head + mvNow(x, mvSubVol(u)) + (tog ? mvTogBox(u) : '') + grp, x.sb ? [x.sb.id] : u.members.slice(1).map(function (m) { return m.it.id; }));
  }
  // The Not Playing shelf: small tiles, the name still the title.
  function mvSub(x) {
    var s = x.st === 'idle' ? (x.tv ? 'On' + (x.app ? ' · ' + x.app.name : '') : 'Idle') : MV_WORDS[x.st];
    return '<span class="mv-g ' + x.st + '">' + mvGlyph(x.st) + '</span>' + esc(s);
  }
  function mvTile(u) {
    var x = u.x;
    return mvCard(x, 'mv-sq', '<div class="mv-sqtop"><div class="mv-sqn"><div class="mv-name sm">' + esc(x.it.name) + '</div>' + mvRoomLbl(u) + '</div>' + mvQuick(x) + '</div><div class="mv-rsub">' + mvSub(x) + '</div>');
  }
  function mediaTabHtml(list) {
    var units = mvUnits(list);
    if (!units.length) return '<div class="yc-empty">No speakers or TVs on this page.</div>';
    var live = units.filter(function (u) { return u.x.tier < 2; }), rest = units.filter(function (u) { return u.x.tier >= 2; });
    return '<div class="mv-wrap" data-slot="media">' + (live.length ? '<div class="mv-stage" data-slot="stage">' + live.map(mvWide).join('') + '</div>' : mvQuiet()) +
      (rest.length ? '<div class="mv-shelfh">' + mvSec('Not Playing', rest.length) + '</div><div class="mv-shelf" data-slot="shelf">' + rest.map(mvTile).join('') + '</div>' : '') + '</div>';
  }
`;

export const HOME_MEDIA_CSS = `
  /* Media tab: one card per device, no room card around it. Everything is scoped to .mv. */
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
  .mv-art.s52 { width: 52px; height: 52px; border-radius: 14px; font-size: 18px; }
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
  .mv-g.paused { color: #d28f1f; } .mv-g.gone { color: #d9534f; } .mv-g.playing, .mv-g.on { color: var(--accent); }
  .mv-acts { display: flex; gap: 6px; flex-shrink: 0; }
  .mv .vrow { min-width: 0; }
  .mv .vwrap { min-width: 0; }
  .mv.st-gone { opacity: .62; border-style: dashed; }
  .mv.st-gone .mv-ic { background: transparent; }
  .mv.st-off { opacity: .85; }
  .mv-ic { width: 38px; height: 38px; flex-shrink: 0; display: grid; place-items: center; border-radius: 12px; background: var(--well); color: var(--fg-muted); }
  .mv-ic svg { width: 18px; height: 18px; }
  .mv-rsub { display: flex; align-items: center; font-size: 11.5px; color: var(--fg-muted); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mv-act { flex-shrink: 0; height: 34px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--well); color: var(--fg); display: inline-flex; align-items: center; gap: 6px; padding: 0 14px 0 11px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .mv-act svg { width: 14px; height: 14px; }
  .mv-act.main { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .mv-act:hover { border-color: var(--fg-muted); }
  .mv-act:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Wide cards: the name is the loudest text; the song is the quiet line inside its own box. */
  .mv-stage { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 12px; align-items: start; }
  .tile.mv-wide { padding: 14px; gap: 12px; border-radius: 22px; }
  .mv-name { font-size: 21px; font-weight: 800; line-height: 1.15; color: var(--fg); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .mv-name.sm { font-size: 15px; font-weight: 700; line-height: 1.2; }
  .mv-room { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--fg-muted); line-height: 1.3; }
  .mv-ic.big { width: 44px; height: 44px; border-radius: 14px; background: color-mix(in srgb, var(--c) 22%, var(--well)); color: var(--fg); }
  .mv-ic.big svg { width: 22px; height: 22px; }
  .mv-h1 { display: flex; align-items: center; gap: 12px; position: relative; }
  .mv-h1t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  /* The now-playing box. Art, song, then the keys at the right end; when the row is too narrow the keys drop under, still at the right. */
  .np.mv-np { display: block; padding: 10px; border-radius: 16px; background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .mv-nprow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
  .mv-nowt { flex: 1 1 120px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .mv-song { font-size: 13.5px; font-weight: 600; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv-np .by { font-size: 11px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mv-nprow > .np-keys { margin-left: auto; flex: 0 0 auto; }
  .mv .np-keys:not([data-open]) { display: flex; align-items: center; gap: 8px; }
  .mv .np-keys:not([data-open]) > .key { width: 36px; height: 36px; }
  .mv .np-keys:not([data-open]) > .key.main { width: 42px; height: 42px; }
  .mv .np-keys .key.main { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .mv .np-keys[data-open] { --k: 40px; --g: 4px; }
  .mv .np.tv .rpad { margin-top: 2px; }
  /* The volume sits inside the now-playing box, under the song row, after a hairline: one glass sub-card. */
  .mv-vol { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--fg) 8%, transparent); min-width: 0; }
  .mv-vol .vrow { flex: 1 1 0; }
  .mv-vlbl { flex: 0 0 auto; max-width: 42%; min-width: 0; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--fg-2); }
  .mv-vlbl svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--fg-muted); }
  .mv-vlbl > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 420px) { .mv-vlbl > span { display: none; } }
  /* The glass box (speakers playing together). */
  .mv-tog { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 12px; border-radius: 16px; background: color-mix(in srgb, var(--fg) 5%, transparent); border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .mv-togh { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-2); min-width: 0; }
  .mv-togh svg { flex-shrink: 0; width: 14px; height: 14px; }
  .mv-togh > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv-mem { display: flex; flex-direction: column; gap: 4px; }
  .mv-mn { display: flex; align-items: baseline; gap: 6px; font-size: 14px; color: var(--fg); }
  .mv-mn b { font-weight: 700; }
  .mv-mn i { font-style: normal; font-size: 11px; color: var(--fg-muted); }
  .mv-mn svg { width: 13px; height: 13px; color: var(--fg-muted); align-self: center; }
  /* Choosing which speakers play together: a small pill, in the box header (or under a lone speaker's volume). */
  .mv-gbtn { appearance: none; margin-left: auto; flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 9999px; border: 1px solid color-mix(in srgb, var(--fg) 14%, transparent); background: var(--well); color: var(--fg-2); font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: none; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 90ms ease; }
  .mv-gbtn:hover { color: var(--fg); border-color: var(--fg-muted); }
  .mv-gbtn:active { transform: scale(.94); }
  .mv-gbtn[aria-expanded="true"] { background: color-mix(in srgb, var(--accent) 22%, var(--well)); border-color: var(--accent); color: var(--fg); }
  .mv-gbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .mv-wide > .mv-gbtn { align-self: flex-start; margin-left: 0; }
  .mv .glist { padding-top: 0; }
  /* The Not Playing shelf */
  .mv-shelfh { margin-top: 4px; }
  .mv-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .tile.mv-sq { min-height: 104px; padding: 12px; gap: 8px; justify-content: space-between; border-radius: 18px; }
  .mv-sqtop { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .mv-sqn { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .mv-sq .mv-act { width: 36px; padding: 0; justify-content: center; font-size: 0; gap: 0; flex-shrink: 0; }
  .mv-sq .mv-act svg { width: 16px; height: 16px; }
  .mv-sq .mv-rsub { white-space: normal; }
  .mv-sq.st-off .mv-name, .mv-sq.st-gone .mv-name { color: var(--fg-2); }
  @media (max-width: 520px) { .mv-name { font-size: 19px; } }
  @media (prefers-reduced-motion: reduce) { .mv-gbtn { transition: none; } .mv-gbtn:active { transform: none; } }
`;
