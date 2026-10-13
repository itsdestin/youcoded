// What a device had before it was switched off (Destin, 2026-10-05: "when flicking lights on/off, the brightness slider often
// jumps between 0 and the correct level when turning back on"). Kept apart from home-assistant-page.ts for its line budget;
// HOME_MEMORY_JS is pasted INSIDE the page's script (shares isOn, gone, thing, rooms, domain, guess machinery).
//
// WHY (traced against the real house, ha-trace3.tsv): Home Assistant BLANKS brightness, colour (rgb / colour temperature),
// volume, mute and set points the moment a device goes OFF. When the person turns it back on the page shows "on" at once, but
// the device only answers about a second later, and its "on" and its real level arrive in the SAME message. So for that second
// the card was on with no level, and every bar drew 0. The page now remembers each device's last real level and draws it
// while the device has not yet said its own; the moment the device reports a real number, that number wins.
//
// A remembered value stands in ONLY for a field that is blank, on a device that is on, since the last time it was seen off with
// no real value reported since (`blank`). A device that never reports a field (an on/off light's brightness) has nothing
// remembered, so nothing is made up for it. Memory lives in the page (not saved): after a reload the first turn-on has nothing
// to remember, and the bar shows as "not known yet" (see .lr-unk) instead of 0.
//
// Escapes: this text lives in a template string inside another one: no backticks, no dollar-brace, backslashes doubled.

export const HOME_MEMORY_CSS = `
  /* A level the device has not told us yet: the bar keeps its place but is dim and has no handle, and says nothing false (no 0%). */
  .lr.lr-unk { opacity: .45; }
  .lr.lr-unk::-webkit-slider-thumb { opacity: 0; }
`;

export const HOME_MEMORY_JS = `
  // ── What a device had before it went off ─────────────────────────────────
  // Fields that go blank together are one group: a colour is either rgb or a colour temperature (never both needed),
  // a heat/cool range is a low and a high.
  var MEM_GROUPS = [['brightness'], ['rgb', 'k'], ['vol'], ['muted'], ['target'], ['tlo', 'thi']];
  var mem = {}; // device id -> { v: last real values, blank: group -> "seen off, no real value since" }
  function memOf(id) { return mem[id] || (mem[id] = { v: {}, blank: {} }); }
  function memHas(it, g) { return g.some(function (f) { return it[f] != null; }); }
  // A single set point only stands in when the thermostat is not in Auto (Auto has a low and a high and no single one); the
  // low/high only in Auto.
  function memAllows(g, it) { return g[0] === 'target' ? it.tlo == null && it.thi == null && it.state !== 'heat_cool' : g[0] === 'tlo' ? it.state === 'heat_cool' : true; }
  // The HOUSE just spoke for this device (a push or a check): remember what is real, and whether it is off.
  function memReport(it) {
    var m = memOf(it.id), live = isOn(it) && !gone(it);
    MEM_GROUPS.forEach(function (g) {
      if (!live) { m.blank[g[0]] = true; return; }
      if (memHas(it, g)) { m.blank[g[0]] = false; g.forEach(function (f) { m.v[f] = it[f]; }); }
    });
  }
  function memReportAll() { (rooms || []).forEach(function (r) { r.items.forEach(memReport); }); }
  // The person set a value (a slider, a colour, a set point): that is what the device will have, even if it is switched off before it says so.
  function memNote(id, field, value) {
    MEM_GROUPS.forEach(function (g) {
      if (g.indexOf(field) < 0) return;
      if (value != null || g.length > 1) memOf(id).v[field] = value;
    });
  }
  // Drawn from the top of every drawing: a device that is on with a blank field the house has not filled yet shows what it had.
  function memFix() {
    (rooms || []).forEach(function (r) {
      r.items.forEach(function (it) {
        var m = mem[it.id];
        if (!m || !isOn(it) || gone(it)) return;
        MEM_GROUPS.forEach(function (g) {
          if (!m.blank[g[0]] || memHas(it, g) || !memAllows(g, it)) return;
          g.forEach(function (f) { if (m.v[f] != null) it[f] = m.v[f]; });
        });
      });
    });
  }
  // The room bar: the average of the lights that are on AND have a level. A light that has just been turned on and has none yet
  // is left out of the average (it used to count as 0 and dragged the bar down). null = no level known for any lit light.
  function groupPct(lit, onList) {
    var known = lit.filter(function (it) { return it.brightness != null; });
    if (known.length) return Math.max(1, Math.round(known.reduce(function (a, it) { return a + it.brightness; }, 0) / known.length / 2.55));
    return lit.length ? null : onList.length ? 100 : 1;
  }
`;
