// The thermostat's Auto (heat_cool) mode (code review F4). In Auto a thermostat has no single set point: it holds a
// LOW (heat) and a HIGH (cool) one (`target_temp_low` / `target_temp_high`; `temperature` is empty), so the dial used to
// say "Off" with no buttons while Auto was the pressed mode. Kept apart from home-assistant-page.ts for its line budget;
// HOME_CLIMATE_JS is pasted INSIDE the page's script and shares its helpers (thing, setLocal, service, render, esc).
//
// What a person sees: the dial's middle shows both numbers ("68°  74°"); the arc fills BETWEEN them; one of the two numbers
// is the one the − and + act on (underlined; press a number to switch). No separate controls were added.
//
// Escapes: this text lives in a template string inside another one, so every backslash in the page's own code is doubled and
// no backtick may appear.

export const HOME_CLIMATE_CSS = `
  .th-range { display: flex; align-items: baseline; gap: 8px; font-family: var(--font-mono); font-size: 30px; line-height: 1.1; color: var(--fg); }
  .th-compact .th-range { font-size: 22px; gap: 6px; }
  .th-side-btn { appearance: none; font: inherit; color: inherit; background: transparent; border: 0; border-bottom: 3px solid transparent; padding: 0 2px; cursor: pointer; border-radius: 0; }
  .th-side-btn[aria-pressed="true"] { border-bottom-color: var(--m); }
  .th-side-btn:focus-visible { outline: 2px solid var(--m); outline-offset: 2px; }
  .th-rcap { font-size: 10px; color: var(--fg-muted); font-family: inherit; }
`;

export const HOME_CLIMATE_JS = `
  // ── Auto (heat_cool) thermostat ───────────────────────────────────────────
  // Which of the two numbers − and + act on, per thermostat: what the person last pressed; before that, the cool side while
  // it is cooling and the heat side otherwise.
  var thSide = {};
  function thRange(it) { return it.state === 'heat_cool' && it.tlo != null && it.thi != null; }
  function thSideOf(it) { return thSide[it.id] || (it.action === 'cooling' ? 'high' : 'low'); }
  function thValue(it) { return thRange(it) ? (thSideOf(it) === 'low' ? it.tlo : it.thi) : it.target; }
  // The dial's middle in Auto: both numbers, each a button that chooses the side − and + act on.
  function thRangeMid(it, doing) {
    var side = thSideOf(it);
    var btn = function (s, v, word) {
      return '<button class="th-side-btn" data-side="' + s + '" data-tid="' + esc(it.id) + '" aria-pressed="' + (side === s) + '" aria-label="' + word + ' setting ' + esc(v) + ' degrees, press to adjust it">' + esc(v) + '°</button>';
    };
    return '<span class="th-lbl">' + esc(doing) + '</span><span class="th-range">' + btn('low', it.tlo, 'Heat') + '<span class="th-rcap" aria-hidden="true">to</span>' + btn('high', it.thi, 'Cool') + '</span>';
  }
  // The new pair after one press of − or +: the chosen side moves, never past the device's limits nor across the other side.
  function thNext(it, delta) {
    var side = thSideOf(it), step = it.step || 1, lo = it.min != null ? it.min : 50, hi = it.max != null ? it.max : 90;
    var next = Math.round((Number(thValue(it)) + Number(delta)) * 10) / 10;
    var tlo = it.tlo, thi = it.thi;
    if (side === 'low') tlo = Math.max(lo, Math.min(next, thi - step)); else thi = Math.min(hi, Math.max(next, tlo + step));
    return { patch: { tlo: tlo, thi: thi }, body: { entity_id: it.id, target_temp_low: tlo, target_temp_high: thi } };
  }
  // " · Auto 68–74°" for the one-line summaries.
  function thSummary(it) { return thRange(it) ? ' · Auto ' + it.tlo + '–' + it.thi + '°' : ''; }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-side]');
    if (!b) return;
    thSide[b.getAttribute('data-tid')] = b.getAttribute('data-side');
    render();
  });
`;
