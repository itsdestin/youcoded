// Basic controls for every media player that has NO paired remote (Destin, 2026-10-05: "integrate those basic cast controls for TVs
// without a paired remote ... and other basic controls for devices like the Samsung TV where straightforward").
// ONE capability-driven rule: a card shows exactly what the device says it can do RIGHT NOW (Home Assistant's supported_features,
// read again on every draw, because a playing app adds seek / next and an idle one takes them away):
//   play / pause (bits 1, 16384), previous / next (16, 32), back / forward 10 s (seek, 2, only when the position is known),
//   stop (4096), volume slider (volume_set, 4) else - / + (volume_step, 1024), mute (8), power (turn_on 128 / turn_off 256),
//   and an input picker (source, 2048, only when the device lists its sources).
// A paired-remote TV keeps its own remote card (home-assistant-page-tv.ts); Sonos / speaker cards keep what they had and gain only
// what they really support. Nothing here is drawn for a device that is not responding.
// HOME_BASIC_JS is pasted INSIDE the page's script (shares esc, PREV, NEXT, PLAY, PAUSE, PLAYPAUSE, POWER, volIcon, seekHow, seekIcon,
// thing, setLocal, service, isTv, kindOf). Template string: no backticks, no dollar-brace, no backslashes.

export const HOME_BASIC_JS = `
  // ── Basic controls for players without a paired remote ───────────────────
  var STOP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  function bcHas(it, bit) { return ((it.features || 0) & bit) !== 0; }
  // Does an unpaired TV have anything to control right now? (Then its card gets a panel, even idle.)
  function bcAny(it) { return bcHas(it, 1 | 4 | 8 | 1024 | 2048 | 4096 | 16384); }
  // The keys, as buttons (the caller wraps them): previous, back 10, play/pause, forward 10, next, stop.
  // o: playing = the house says playing or paused; isPlay = playing; neutral = the app never reports play/pause (the neutral rule);
  //    sound = a speaker or soundbar; resume = the word for the play key while paused.
  // WHY idle plays with media_play (never media_play_pause): the page guesses "playing" for a play/pause press, which on an idle TV would
  // claim something is playing that the house never confirms. WHY a neutral press sends no guess (data-neutral): the neutral rule says
  // the card never claims a state the house has not reported.
  function bcKeys(it, o) {
    var id = esc(it.id), out = '';
    var mk = function (svc, label, icon, cls, more) {
      return '<button class="key' + (cls ? ' ' + cls : '') + '" data-mp="' + id + '" data-svc="' + svc + '"' + (more || '') + ' aria-label="' + label + '" title="' + label + '">' + icon + '</button>';
    };
    var seek = o.playing && seekHow(it, null) === 'seek';
    var ten = function (dir, label, cls) { return '<button class="key ' + cls + '" data-seek="' + id + '" data-dir="' + dir + '" aria-label="' + label + '" title="' + label + '">' + seekIcon(dir > 0 ? 1 : 0) + '</button>'; };
    if (o.playing && bcHas(it, 16)) out += mk('media_previous_track', 'Previous', PREV);
    if (seek) out += ten(-10, 'Back 10 seconds', 's-sb');
    if (o.playing ? (bcHas(it, 1) || bcHas(it, 16384)) : (!o.sound && bcHas(it, 16384))) {
      out += o.neutral ? mk('media_play_pause', 'Play or pause', PLAYPAUSE, 'main', ' data-neutral="1"')
        : o.playing ? mk('media_play_pause', o.isPlay ? 'Pause' : (o.resume || 'Play'), o.isPlay ? PAUSE : PLAY, 'main')
        : mk('media_play', 'Play', PLAY, 'main');
    }
    if (seek) out += ten(10, 'Forward 10 seconds', 's-sf');
    if (o.playing && bcHas(it, 32)) out += mk('media_next_track', 'Next', NEXT);
    if (o.playing && bcHas(it, 4096)) out += mk('media_stop', 'Stop', STOP_ICON);
    return out;
  }
  // Input picker: only where the device offers sources. Not on Sonos: its list is its favourites, and choosing one starts playing it.
  function bcSources(it) {
    return bcHas(it, 2048) && Array.isArray(it.sources) && it.sources.length > 0 && !/sonos/i.test(it.maker || '') && kindOf(it) !== 'soundbar' && kindOf(it) !== 'speaker';
  }
  // A Google / Android TV can be paired for the arrow pad and apps; say so, quietly, only where that is true.
  // WHY the maker test: Home Assistant's own device record is the only reliable sign here (Cast and Google TV devices say Google);
  // a Samsung or LG TV cannot be paired this way, so telling its owner to would be wrong.
  function bcPairable(it) { return isTv(it) && it.dc === 'tv' && /google|chromecast/i.test((it.maker || '') + ' ' + (it.model || '')); }
  function bcExtra(it, rc) {
    if (rc || gone(it)) return '';
    var out = '';
    if (bcSources(it)) {
      out += '<label class="bc-src"><span class="bc-sl">Input</span><select class="yc-select" data-source="' + esc(it.id) + '" aria-label="Input for ' + esc(it.name) + '">' +
        (it.source && it.sources.indexOf(it.source) < 0 ? '<option value="" selected>' + esc(it.source) + '</option>' : '') +
        it.sources.map(function (s) { return '<option value="' + esc(s) + '"' + (s === it.source ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></label>';
    }
    if (bcPairable(it)) out += '<div class="bc-note">Pair this TV&#39;s remote in Home Assistant for the arrow pad and apps.</div>';
    return out ? '<div class="bc-more">' + out + '</div>' : '';
  }
  function bcMuteBtn(it) {
    var m = !!it.muted;
    return '<button class="pwr mute" data-mp="' + esc(it.id) + '" data-svc="volume_mute" data-mute="' + (m ? 'false' : 'true') + '" aria-pressed="' + m + '" aria-label="' + (m ? 'Unmute ' : 'Mute ') + esc(it.name) + '" title="' + (m ? 'Unmute' : 'Mute') + '">' + volIcon(m ? 0 : 70, m) + '</button>';
  }
  // Is there a power button? Only where the device says it can be switched that way now (a "not responding" tile keeps its disabled one).
  function bcCanPower(it, on) { return gone(it) || bcHas(it, on ? 256 : 128); }
  function bcPwrBtn(it, on, na) {
    return '<button class="pwr" data-toggle="' + esc(it.id) + '" aria-pressed="' + on + '"' + (na ? ' disabled' : '') + ' aria-label="Turn ' + esc(it.name) + (on ? ' off' : ' on') + '" title="' + (on ? 'Turn off' : 'Turn on') + '">' + POWER + '</button>';
  }
  // The header buttons of a TV or display with no remote: mute (when it can, and its own volume is the one that is heard), then power.
  function bcActs(it, on, na, sb) {
    return (!na && !sb && bcHas(it, 8) ? bcMuteBtn(it) : '') + (bcCanPower(it, on) ? bcPwrBtn(it, on, na) : '');
  }
  // Choosing an input: shown at once, sent to the house, confirmed (or undone) like every other press.
  document.addEventListener('change', function (e) {
    var t = e.target, id = t && t.getAttribute && t.getAttribute('data-source');
    if (!id || !t.value) return;
    setLocal(id, { source: t.value });
    service('media_player', 'select_source', { entity_id: id, source: t.value }, id);
  });
`;

export const HOME_BASIC_CSS = `
  /* The input picker and the pairing hint under a no-remote TV's controls. Quiet: the hint is the dimmest text on the card. */
  .bc-more { flex-basis: 100%; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--fg) 8%, transparent); min-width: 0; }
  /* WHY: a wide Media-tab panel is a grid (home-assistant-page-drawer.ts); without this the block lands in one narrow column. */
  .mv-np > .bc-more { grid-column: 1 / -1; }
  .bc-src { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .bc-sl { flex: 0 0 auto; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); }
  .bc-src .yc-select { flex: 1 1 0; min-width: 0; height: 32px; font-size: 12px; }
  .bc-note { font-size: 11px; line-height: 1.35; color: var(--fg-faint); }
  .np-keys .key.s-sb, .np-keys .key.s-sf { color: var(--fg-2); }
  .np-keys { flex-wrap: wrap; }
`;
