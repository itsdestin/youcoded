// Design options for the room cards' Scenes list (2026-10-06, Destin: "scene view and expanded room/light view
// mutually exclusive ... restyle scenes to better show the colors ... side-browseable cards").
// Three KINDS of side-scrolling scene card; all three share the same exclusivity, scroll row and "learned colours".
//
// WHY learned colours: Home Assistant exposes only name, group_name, brightness (0-255), is_dynamic and speed for a Hue scene, never its colours.
// So when a scene is pressed from the page, the page waits a moment, reads the colours its room's lights settled on and keeps them
// per scene in the page's own data ({ sceneLook: { <scene id>: { c: [up to 5 colours], b: 0-100 } } }). A scene never pressed shows an
// intentional "Try it to see its colours" look. Nothing is guessed from names.
// WHY brightness and "moving" come from `sceneInfo` here: the real page's room request does not carry them yet (its template only sends
// id, name, last). The built version must add `brightness` and `is_dynamic` to that request; these options seed what it would return.
import type { HomeVariants } from './types';

type Look = { c: string[]; b: number };
const ID = 'scene.destins_room_';
const idOf = (n: string) => ID + n.toLowerCase().replace(/ /g, '_');
// Brightness (0-100) and "moving" for every fake scene, as Home Assistant would report them.
const INFO: Record<string, { b: number; dyn: boolean }> = {
  Tokyo: { b: 70, dyn: true }, Relax: { b: 55, dyn: false }, Read: { b: 90, dyn: false }, Concentrate: { b: 100, dyn: false },
  Energize: { b: 100, dyn: false }, Nightlight: { b: 12, dyn: false }, 'TV Time': { b: 35, dyn: false },
  'Sunset Glow': { b: 65, dyn: true }, Galaxy: { b: 45, dyn: true }, 'Malibu pink': { b: 80, dyn: true },
};
// What pressing a scene earlier taught the page. Energize, Malibu pink, Read and Sunset Glow were never pressed: they show the "unknown" look.
const LEARNED: Record<string, Look> = {
  Tokyo: { c: ['rgb(255, 70, 150)', 'rgb(150, 80, 255)', 'rgb(60, 190, 255)', 'rgb(255, 120, 200)'], b: 70 },
  Relax: { c: ['rgb(255, 170, 90)', 'rgb(255, 205, 140)', 'rgb(255, 140, 70)'], b: 55 },
  Concentrate: { c: ['rgb(215, 235, 255)', 'rgb(235, 245, 255)', 'rgb(190, 220, 255)'], b: 100 },
  Nightlight: { c: ['rgb(255, 150, 60)', 'rgb(255, 120, 50)'], b: 12 },
  Galaxy: { c: ['rgb(90, 60, 220)', 'rgb(40, 90, 235)', 'rgb(170, 70, 230)', 'rgb(30, 40, 120)'], b: 45 },
  'TV Time': { c: ['rgb(110, 70, 230)', 'rgb(60, 90, 220)', 'rgb(40, 50, 140)'], b: 35 },
};
const sceneInfo: Record<string, { b: number; dyn: boolean }> = {};
const sceneLook: Record<string, Look> = {};
for (const n of Object.keys(INFO)) sceneInfo[idOf(n)] = INFO[n];
for (const n of Object.keys(LEARNED)) sceneLook[idOf(n)] = LEARNED[n];

// The page's saved data for a screen. (A variant's data replaces the page's whole saved data, so favourites are restated.)
const base = { fav: ['light.living_room_lamp', 'climate.thermostat'], sceneInfo, sceneLook };

// ---- Shared script: replaces the page's scenesHtml with a card builder, and teaches the page the three behaviours below. ----
// 1) the card row (arrow keys, mouse wheel); 2) learning colours when a scene is pressed; 3) the scene rows' data.
const SHARED = String.raw`
  var sceneLook = saved.sceneLook && typeof saved.sceneLook === 'object' ? saved.sceneLook : {};
  var sceneInfo = saved.sceneInfo && typeof saved.sceneInfo === 'object' ? saved.sceneInfo : {};
  // WHY a delay: a Hue scene takes a moment to reach the lights, and the live update then lands. Read what the lights settled on.
  function learnScene(id) {
    setTimeout(function () {
      var room = (rooms || []).filter(function (r) { return (r.scenes || []).some(function (x) { return x.id === id; }); })[0];
      if (!room) return;
      var on = room.items.filter(function (it) { return isLight(it) && isOn(it) && !gone(it) && !(Array.isArray(it.members) && it.members.length); });
      if (!on.length) return;
      var cs = [], tot = 0, n = 0;
      on.forEach(function (it) { var c = colourOf(it); if (cs.indexOf(c) < 0 && cs.length < 5) cs.push(c); if (it.brightness != null) { tot += it.brightness; n++; } });
      sceneLook[id] = { c: cs, b: n ? Math.round(tot / n / 255 * 100) : 100 };
      persist({ sceneLook: sceneLook });
      render();
    }, 2500);
  }
  var SC_WAVE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M2 12c3-7 5-7 8 0s5 7 8 0 3-4 4-4"/></svg>';
  function scInfo(sc) { return sceneInfo[sc.id] || { b: null, dyn: false }; }
  function scLook(sc) { var l = sceneLook[sc.id]; return l && l.c && l.c.length ? l : null; }
  function scBri(sc) { var l = scLook(sc), i = scInfo(sc); return l && l.b != null ? l.b : (i.b != null ? i.b : 100); }
  function scLabel(sc, room, isLast) {
    var l = scLook(sc);
    return sceneName(sc, room) + (isLast ? ', last used' : '') + (scInfo(sc).dyn ? ', moves through its colours' : '') + ', ' + scBri(sc) + ' percent bright' + (l ? ', ' + l.c.length + ' colours' : ', colours not seen yet');
  }
  function scMoving(sc) { return scInfo(sc).dyn ? '<span class="sx-mv" title="Moves slowly through its colours">' + SC_WAVE + 'Moving</span>' : ''; }
  function scLastPill(isLast) { return isLast ? '<span class="sx-last">Last used</span>' : ''; }
  function scenesHtml(room) {
    var list = scenesList(room);
    if (!list.length || !scenesOpen.has(room.id)) return '';
    var last = list.reduce(function (a, b) { return Date.parse(b.last) > Date.parse(a ? a.last : 0) ? b : a; }, null);
    var sorted = list.slice().sort(function (a, b) { return sceneName(a, room).localeCompare(sceneName(b, room)); });
    return '<div class="scenes sx open"><div class="sx-row" role="group" aria-label="Scenes in ' + esc(room.name) + ', scroll sideways">' + sorted.map(function (sc) {
      var isLast = !!(last && sc.id === last.id && Date.parse(last.last));
      return '<button class="scene sx-card' + (isLast ? ' last' : '') + (scLook(sc) ? '' : ' unk') + '" data-scene="' + esc(sc.id) + '" aria-label="' + esc(scLabel(sc, room, isLast)) + '">' + sxCard(sc, room, isLast) + '</button>';
    }).join('') + '</div></div>';
  }
  // WHY: a row opens already scrolled to the scene used last, so the "last used" card is the first thing you see (once per row; later redraws keep your own scrolling).
  var sxDone = typeof WeakSet === 'function' ? new WeakSet() : null, sxPrev = window.__homeAfterPut;
  window.__homeAfterPut = function (id) {
    if (sxPrev) sxPrev(id);
    if (!sxDone) return;
    Array.prototype.forEach.call(document.querySelectorAll('.sx-row'), function (row) {
      if (sxDone.has(row)) return; sxDone.add(row);
      var c = row.querySelector('.sx-card.last'); if (!c) return;
      row.scrollLeft += c.getBoundingClientRect().left - row.getBoundingClientRect().left - (row.clientWidth - c.offsetWidth) / 2;
    });
  };
  // Arrow keys move between cards; the mouse wheel scrolls the row sideways (until its end, then the page scrolls again).
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var card = e.target.closest && e.target.closest('.sx-card'); if (!card) return;
    var next = e.key === 'ArrowRight' ? card.nextElementSibling : card.previousElementSibling;
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ inline: 'center', block: 'nearest' }); }
  });
  document.addEventListener('wheel', function (e) {
    var row = e.target.closest && e.target.closest('.sx-row'); if (!row || e.ctrlKey) return;
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? 0 : e.deltaY; if (!d) return;
    var max = row.scrollWidth - row.clientWidth;
    if ((d > 0 && row.scrollLeft < max - 1) || (d < 0 && row.scrollLeft > 0)) { e.preventDefault(); row.scrollLeft += d; }
  }, { passive: false });
`;

// Swaps the page's own scene list, and makes Scenes and each light mutually exclusive (opening one closes the other).
function build(cardJs: string) {
  return (html: string) => {
    const must = (out: string, was: string, what: string) => { if (out === was) throw new Error('scenes variant: could not find ' + what); return out; };
    let out = html;
    out = must(out.replace(/ {2}function scenesHtml\(room\) \{[\s\S]*?\n {2}\}\n(?= {2}function lightsCard)/, () => SHARED + cardJs + '\n'), out, 'scenesHtml');
    // WHY: opening the room's lights closes its scenes ...
    out = must(out.replace('if (open.has(fd)) open.delete(fd); else open.add(fd);', 'if (open.has(fd)) open.delete(fd); else { open.add(fd); scenesOpen.delete(fd); }'), out, 'fold');
    // ... and opening its scenes closes its lights (same on the Home tab and the Lights tab: both use these two buttons).
    out = must(out.replace('if (scenesOpen.has(scn)) scenesOpen.delete(scn); else scenesOpen.add(scn);', 'if (scenesOpen.has(scn)) scenesOpen.delete(scn); else { scenesOpen.add(scn); open.delete(scn); }'), out, 'palette');
    out = must(out.replace("service('scene', 'turn_on', { entity_id: sc }, sc);", () => "service('scene', 'turn_on', { entity_id: sc }, sc); learnScene(sc);"), out, 'scene press');
    return out;
  };
}

// ---- CSS shared by all three: the scroll row, the card base, the pills ----
const ROW_CSS = String.raw`
  .scenes.sx { padding: 12px 0 4px; margin: 0 8px 8px; }
  /* A side-scrolling row: cards snap to its start; a thin themed scrollbar; both edges fade so "more this way" shows. */
  .sx-row { display: flex; gap: 10px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scroll-padding: 0 12px; padding: 2px 12px 12px; scrollbar-width: thin; scrollbar-color: var(--edge) transparent;
    -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 18px), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 18px), transparent 100%); }
  .sx-row::-webkit-scrollbar { height: 6px; }
  .sx-row::-webkit-scrollbar-track { background: transparent; }
  .sx-row::-webkit-scrollbar-thumb { background: var(--edge); border-radius: 9999px; }
  .sx-row::-webkit-scrollbar-thumb:hover { background: var(--fg-muted); }
  .sx-card { position: relative; flex: 0 0 var(--sxw, 148px); width: var(--sxw, 148px); scroll-snap-align: start; text-align: left; padding: 0; overflow: hidden; display: flex; flex-direction: column; color: var(--fg); border-radius: var(--radius-md, 10px); border: 1px solid var(--edge); background: var(--inset); cursor: pointer; transition: transform 90ms ease, border-color 120ms ease; font-size: 12px; }
  .sx-card:hover { border-color: var(--accent); }
  .sx-card:active { transform: scale(.97); }
  .sx-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .sx-card.last { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .sx-nm { font-weight: 600; font-size: 13px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sx-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 9999px; white-space: nowrap; }
  .sx-last { display: inline-flex; align-items: center; font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 9999px; background: var(--accent); color: var(--on-accent); font-weight: 600; white-space: nowrap; }
  .sx-mv { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 9999px; background: rgba(0,0,0,.45); color: #fff; white-space: nowrap; }
  .sx-try { font-size: 10.5px; color: var(--fg-muted); line-height: 1.3; }
  .sx-pct { font-size: 11px; color: var(--fg-2); font-variant-numeric: tabular-nums; }
  @media (max-width: 480px) { .sx-card { --sxw: 132px; } }
  @media (prefers-reduced-motion: reduce) { .sx-card { transition: none; } .sx-row { scroll-behavior: auto; } }
`;

// (a) Gradient cards: the whole face is a soft gradient of the scene's colours; name at the bottom.
const GRADIENT_JS = String.raw`
  function sxCard(sc, room, isLast) {
    var l = scLook(sc), b = scBri(sc);
    if (!l) {
      return '<span class="sg-face sg-unk"><span class="sg-top">' + scLastPill(isLast) + scMoving(sc).replace('sx-mv', 'sx-mv sx-mv-n') + '</span><span class="sx-try">Try it to see its colours</span></span>' +
        '<span class="sg-foot"><span class="sx-nm">' + esc(sceneName(sc, room)) + '</span><span class="sx-pct">' + b + '%</span></span>';
    }
    var cs = l.c.length > 1 ? l.c : [l.c[0], 'color-mix(in srgb, ' + l.c[0] + ' 55%, #000)'];
    var bg = 'linear-gradient(135deg, ' + cs.join(', ') + ')';
    return '<span class="sg-face" style="--sgo:' + (0.5 + 0.5 * b / 100).toFixed(2) + '"><span class="sg-bg" style="background:' + esc(bg) + '"></span><span class="sg-top">' + scLastPill(isLast) + scMoving(sc) + '</span></span>' +
      '<span class="sg-foot sg-on"><span class="sx-nm">' + esc(sceneName(sc, room)) + '</span><span class="sx-pct">' + b + '%</span></span>';
  }
`;
const GRADIENT_CSS = String.raw`
  .sx-card { height: 108px; }
  .sg-face { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 8px; }
  .sg-bg { position: absolute; inset: 0; opacity: var(--sgo, 1); }
  .sg-bg::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.62) 0, rgba(0,0,0,0) 62%); }
  .sg-top { position: relative; display: flex; justify-content: space-between; align-items: flex-start; gap: 4px; min-height: 16px; }
  .sg-top .sx-mv:only-child { margin-left: auto; }
  .sg-foot { position: relative; margin-top: auto; padding: 8px; display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  .sg-foot.sg-on { color: #fff; }
  .sg-foot.sg-on .sx-pct { color: rgba(255,255,255,.85); }
  .sg-unk { background: repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in srgb, var(--edge-dim) 70%, transparent) 7px 8px); justify-content: flex-start; gap: 10px; }
  .sx-card.unk { border-style: dashed; }
  .sx-card.unk.last { border-style: solid; }
  .sg-unk .sx-mv { background: var(--well); color: var(--fg-2); border: 1px solid var(--edge-dim); }
  .sg-unk .sx-try { position: absolute; left: 8px; right: 8px; top: 38%; text-align: center; }
`;

// (b) Swatch cards: a calm glass card; name on top, a row of round colour dots, a brightness bar.
const SWATCH_JS = String.raw`
  function sxCard(sc, room, isLast) {
    var l = scLook(sc), b = scBri(sc), dots = '';
    if (l) { l.c.forEach(function (c) { dots += '<i class="sw-dot" style="background:' + esc(c) + '"></i>'; }); }
    else { dots = '<i class="sw-dot sw-q"></i><i class="sw-dot sw-q"></i><i class="sw-dot sw-q"></i>'; }
    return '<span class="sw-top"><span class="sx-nm">' + esc(sceneName(sc, room)) + '</span>' + scMoving(sc).replace('sx-mv', 'sx-mv sx-mv-n') + '</span>' +
      '<span class="sw-dots">' + dots + '</span>' +
      (l ? '' : '<span class="sx-try">Try it to see its colours</span>') +
      '<span class="sw-bar"><span class="sw-bar-in" style="width:' + b + '%"></span></span>' +
      '<span class="sw-foot"><span class="sx-pct">' + b + '%</span>' + scLastPill(isLast) + '</span>';
  }
`;
const SWATCH_CSS = String.raw`
  .sx-card { padding: 10px; gap: 8px; --sxw: 156px; background: var(--inset); }
  .sw-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 18px; }
  .sw-top .sx-nm { flex: 1; min-width: 0; }
  .sw-top .sx-mv-n, .sg-top .sx-mv-n { background: var(--well); color: var(--fg-2); border: 1px solid var(--edge-dim); }
  .sw-dots { display: flex; gap: 6px; min-height: 26px; align-items: center; }
  .sw-dot { width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto; border: 1px solid rgba(0,0,0,.18); box-shadow: inset 0 1px 2px rgba(255,255,255,.35); }
  .sw-dot.sw-q { background: none; border: 1.5px dashed var(--fg-faint); box-shadow: none; }
  .sw-bar { display: block; height: 5px; border-radius: 9999px; background: var(--well); overflow: hidden; }
  .sw-bar-in { display: block; height: 100%; border-radius: 9999px; background: var(--fg-muted); }
  .sw-foot { display: flex; align-items: center; justify-content: space-between; min-height: 14px; }
  @media (max-width: 480px) { .sx-card { --sxw: 136px; padding: 8px; } .sw-dot { width: 22px; height: 22px; } }
`;

// (c) Light preview cards: a tiny night-time picture of the room's lights as glowing dots, then the name.
const PREVIEW_JS = String.raw`
  var SP_POS = [[22, 38], [50, 24], [78, 40], [34, 70], [68, 72]];
  function sxCard(sc, room, isLast) {
    var l = scLook(sc), b = scBri(sc), dots = '';
    var n = l ? l.c.length : 4;
    for (var i = 0; i < n; i++) {
      var p = SP_POS[i % SP_POS.length], sz = l ? 9 + Math.round(b / 100 * 8) : 10;
      if (l) {
        var c = l.c[i], gl = 6 + Math.round(b / 100 * 18);
        dots += '<i class="sp-dot" style="left:' + p[0] + '%;top:' + p[1] + '%;width:' + sz + 'px;height:' + sz + 'px;background:' + esc(c) + ';box-shadow:0 0 ' + gl + 'px ' + Math.round(gl / 3) + 'px ' + esc(c) + '"></i>';
      } else dots += '<i class="sp-dot sp-q" style="left:' + p[0] + '%;top:' + p[1] + '%;width:' + sz + 'px;height:' + sz + 'px"></i>';
    }
    return '<span class="sp-stage">' + dots + '<span class="sp-top">' + scLastPill(isLast) + scMoving(sc) + '</span>' + (l ? '' : '<span class="sp-try">Try it to see its colours</span>') + '</span>' +
      '<span class="sp-foot"><span class="sx-nm">' + esc(sceneName(sc, room)) + '</span><span class="sx-pct">' + b + '%</span></span>';
  }
`;
const PREVIEW_CSS = String.raw`
  .sx-card { --sxw: 150px; }
  /* WHY a fixed dark stage on every theme: a glow only reads against dark, and Creme's panels are light. */
  .sp-stage { position: relative; display: block; height: 84px; background: #16141f; background-image: radial-gradient(ellipse at 50% 120%, rgba(255,255,255,.07), transparent 70%); border-bottom: 1px solid var(--edge-dim); }
  .sp-dot { position: absolute; border-radius: 50%; transform: translate(-50%, -50%); }
  .sp-dot.sp-q { background: none; border: 1.5px dashed rgba(255,255,255,.35); box-shadow: none; }
  .sp-top { position: absolute; left: 6px; right: 6px; top: 6px; display: flex; justify-content: space-between; align-items: flex-start; gap: 4px; }
  .sp-top .sx-mv:only-child { margin-left: auto; }
  .sp-try { position: absolute; left: 6px; right: 6px; bottom: 6px; text-align: center; font-size: 10.5px; color: rgba(255,255,255,.72); line-height: 1.25; }
  .sp-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; padding: 8px 10px 9px; }
  .sx-card.unk .sp-stage { background-color: #1d1b26; }
  @media (max-width: 480px) { .sx-card { --sxw: 132px; } }
`;

export const VARIANTS: HomeVariants = {
  gradient: { label: 'Gradient cards', css: ROW_CSS + GRADIENT_CSS, transform: build(GRADIENT_JS), data: { ...base, startScenes: ['destins_room'] } },
  swatch: { label: 'Swatch cards', css: ROW_CSS + SWATCH_CSS, transform: build(SWATCH_JS), data: { ...base, startScenes: ['destins_room'] } },
  preview: { label: 'Light preview cards', css: ROW_CSS + PREVIEW_CSS, transform: build(PREVIEW_JS), data: { ...base, startScenes: ['destins_room'] } },
  // The same three on the Lights tab's tall room cards.
  'gradient-lights': { label: 'Gradient cards, Lights tab', css: ROW_CSS + GRADIENT_CSS, transform: build(GRADIENT_JS), data: { ...base, view: 'lights', startScenes: ['destins_room'] } },
  'swatch-lights': { label: 'Swatch cards, Lights tab', css: ROW_CSS + SWATCH_CSS, transform: build(SWATCH_JS), data: { ...base, view: 'lights', startScenes: ['destins_room'] } },
  'preview-lights': { label: 'Light preview cards, Lights tab', css: ROW_CSS + PREVIEW_CSS, transform: build(PREVIEW_JS), data: { ...base, view: 'lights', startScenes: ['destins_room'] } },
};
