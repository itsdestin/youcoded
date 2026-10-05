// When a TV's app really reports playing and paused (Destin approved "option A", 2026-10-05).
// Some apps on a Google TV (Netflix, say) tell Home Assistant "playing" and nothing else: no title,
// and a state that never changes when you press play/pause. Claiming "Now playing" with a moving
// equaliser, or "Paused", for those is a guess shown as fact. THE RULE: a TV's playing/paused is
// trusted only if the app gives a media title, OR this page has SEEN the house report both
// "playing" and "paused" for that TV in this session (a state that really changes with presses).
// Otherwise the card shows the app's name with its mark, no label, no equaliser, and one neutral
// play/pause button that claims no state. Pressing it never changes what the card says by itself:
// only a report from the house (a push or a check) counts, never the page's own guess.
// HOME_TV_JS is pasted INSIDE the page's script. Template string: no backticks, no dollar-brace, no backslashes.

export const HOME_TV_JS = `
  // ── Does this TV's app really report play and pause? ─────────────────────
  var playSeen = {};
  var PLAYPAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 5v14l9-7z"/><rect x="14" y="5" width="3.5" height="14" rx="1"/><rect x="19.5" y="5" width="3" height="14" rx="1"/></svg>';
  // Called with the house's own word about a device (never the page's guess).
  function noteReport(it) {
    if (it.state !== 'playing' && it.state !== 'paused') return;
    var s = playSeen[it.id] || (playSeen[it.id] = {});
    s[it.state] = true;
  }
  function noteReports() { (rooms || []).forEach(function (r) { r.items.forEach(noteReport); }); }
  function playReported(it) { var s = playSeen[it.id]; return !!(s && s.playing && s.paused); }
`;
