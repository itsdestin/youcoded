// Round 3 design options for the TV card's APP DRAWER (Destin, 2026-10-05: "what other apps can we launch from here? could we add
// a little app drawer on the left that scales up/down before collapsing to a bottom bar on narrow views?"). Practice screens only:
// nothing here touches the real page. Shown as pages/page/page-home#v-tv-remote-<key>.
//
// HOW IT WORKS (all in this file):
//  - `transform` swaps the page's own tvChipsHtml (the four app buttons) for one that draws a LONGER list, with the open app marked
//    "on now" instead of being swapped out. Each button keeps the page's launch mechanism untouched: a press sends
//    remote.turn_on with `activity` = the app's web address (YouTube, Netflix, Prime, HBO Max, Disney+ keep theirs) or, for the
//    new ones, the Android app id. UNVERIFIED: none of the new ids has been tried on the real TV (Home Assistant's Android TV Remote
//    accepts a link or an app id; an id the TV does not have opens nothing). The TV cannot report what is installed.
//  - `css` places the drawer with CONTAINER queries on the TV card itself (not the window), so the same card is a drawer on the wide
//    Media tab and a bottom bar on the narrow Home tab or a phone. Breakpoints are measured on the card's inner width.
//  - Open states: `<key>` = the Media tab as it is at a normal window (the card is about 500 px: a small drawer); `<key>-wide` = the
//    TV alone with the page's own width cap lifted (so a 1900 px window gives a ~1700 px card, like Destin's screenshot);
//    `<key>-home` = the Home tab's card (narrow: bottom bar). The NARROW picture is simply the `<key>` screen shot at --width 390.
// "More" in the grid option is kept in the page's own `expanded` set (key "more:<tv id>") so the page's existing click handler
// toggles it and a redraw cannot forget it.
import type { HomeVariant, HomeVariants } from './types';
import { fakeHomeAssistantIds } from '../fake-home-assistant';

const RC = 'remote.destins_room_tv_remote';
const TV_IDS = ['media_player.destins_room_google_tv', RC];
const others = () => fakeHomeAssistantIds().filter((id) => !TV_IDS.includes(id));

// The longer list, in the order proposed: Destin's four, Prime Video, then streaming, then music, then the rest.
// `base` = reuse the page's own APPS entry (its address and mark). Marks are drawn here (no images).
const DRAWER = [
  { name: 'YouTube', base: 1 }, { name: 'Netflix', base: 1 }, { name: 'HBO Max', base: 1 }, { name: 'Disney+', base: 1 }, { name: 'Prime Video', base: 1 },
  { name: 'Hulu', id: 'com.hulu.livingroomplus', bg: '#1ce783', mark: '<span style="color:#0b0c0f;font-size:12px;font-weight:900;letter-spacing:-.05em">hulu</span>' },
  { name: 'Apple TV', id: 'com.apple.atve.androidtv.appletv', bg: '#141414', mark: '<span style="font-size:13px;font-weight:800">tv</span>' },
  { name: 'Peacock', id: 'com.peacocktv.peacockandroid', bg: '#0c0c0c', mark: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="17" r="2.2" fill="#fff"/><circle cx="6.5" cy="13" r="2" fill="#f5c400"/><circle cx="17.5" cy="13" r="2" fill="#13b24a"/><circle cx="8" cy="7.5" r="2" fill="#e5322d"/><circle cx="16" cy="7.5" r="2" fill="#1f7ae0"/></svg>' },
  { name: 'Paramount+', id: 'com.cbs.ott', bg: '#0064ff', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M3 19 12 5l9 14z"/><circle cx="12" cy="13" r="1.2" fill="#fff" stroke="none"/></svg>' },
  { name: 'Spotify', id: 'com.spotify.tv.android', bg: '#1db954', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.3-1 6.7-.7 9.5.9M8 16.3c2.6-.7 5-.5 7 .7"/></svg>' },
  { name: 'YouTube Music', id: 'com.google.android.youtube.tvmusic', bg: '#1c1c1c', mark: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="#ff0033" stroke-width="2"/><path d="M10 8.5v7l6-3.5z" fill="#fff"/></svg>' },
  { name: 'Plex', id: 'com.plexapp.android', bg: '#1f1f1f', mark: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h5l5 8-5 8H8l5-8z" fill="#e5a00d"/></svg>' },
  { name: 'Tubi', id: 'com.tubitv', bg: '#2b0f5c', mark: '<span style="font-size:12px;font-weight:800;letter-spacing:-.02em">tubi</span>' },
  { name: 'Twitch', id: 'tv.twitch.android.app', bg: '#9146ff', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h15v10l-4 4h-4l-3 3v-3H5z"/><path d="M12 7v3.5M16 7v3.5"/></svg>' },
  { name: 'Crunchyroll', id: 'com.crunchyroll.crunchyroid', bg: '#f47521', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="14.2" cy="10" r="1.6" fill="#fff" stroke="none"/></svg>' },
];

// The replacement for the page's tvChipsHtml. ES5, no backticks. `style` = which drawer look (data-drawer on the box).
function chipsFn(style: string): string {
  return `function tvChipsHtml(r, active) {
    // WHY (round 3): a longer list, the open app marked "on now" (not swapped out, so every button keeps its place), and the
    // drawer's look chosen by data-drawer. Same launch mechanism as before: remote.turn_on with activity = address or app id.
    var RC_DRAWER = ${JSON.stringify(DRAWER)};
    var id = esc(r.id), more = expanded.has('more:' + r.id), cur = active ? active.name : '';
    var btns = RC_DRAWER.map(function (a) {
      var base = a.base ? APPS.filter(function (x) { return x.name === a.name; })[0] : null;
      var go = base ? base.url : a.id, on = cur === a.name;
      return '<button class="app rapp' + (on ? ' on' : '') + '" data-rc="' + id + '" data-app="' + esc(go) + '" data-name="' + esc(a.name) + '"' + (on ? ' aria-current="true"' : '') +
        ' aria-label="Open ' + esc(a.name) + (on ? ' (on now)' : '') + '" title="' + esc(a.name) + '"><span class="logo" style="--app:' + (base ? base.bg : a.bg) + '">' + (base ? base.mark : a.mark) +
        '</span><span class="nm">' + esc(a.name) + '</span>' + (on ? '<span class="onnow">On now</span>' : '') + '</button>';
    }).join('');
    var moreBtn = '${style}' === 'grid' ? '<button class="app rapp more" data-expand="more:' + id + '" aria-expanded="' + more + '" aria-label="' + (more ? 'Show fewer apps' : 'Show all apps') + '"><span class="logo"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></svg></span><span class="nm">' + (more ? 'Less' : 'More') + '</span></button>' : '';
    return '<div class="rchips" data-slot="chips" data-drawer="${style}" data-more="' + (more ? 1 : 0) + '"><div class="rchips-in"><div class="rapps">' + btns + moreBtn + '</div></div></div>';
  }
  `;
}

function swapChips(style: string) {
  return (html: string): string => {
    const a = html.indexOf('function tvChipsHtml(r, active) {');
    const b = html.indexOf('// A press on a TV key or app button');
    if (a < 0 || b < 0 || b < a) throw new Error('tv-remote variants: tvChipsHtml not found - the page changed, update this file');
    return html.slice(0, a) + chipsFn(style) + html.slice(b);
  };
}

// ── CSS shared by all three ────────────────────────────────────────────────────────────────────────────────────────
// Containers: the Media tab's card (.tile.mv-wide) and the Home tab's remote box (.np-ctl.tv). Below 460 px of card = the bottom bar
// (a row that scrolls sideways under the pad); from 460 px = the drawer, a column block left of the pad, and the pad + drawer are
// centred as one compact block with the volume bar capped (the lonely-pad emptiness at wide sizes).
const BASE = String.raw`
  .tile.mv-wide, .np-ctl.tv { container: tvc / inline-size; }
  /* Bottom bar (narrow): one row, scrolls sideways, the last icon peeks out as the hint. */
  .rchips[data-drawer] .rapps { display: flex; flex-wrap: nowrap; justify-content: safe center; gap: 10px; overflow-x: auto; overflow-y: hidden; padding: 12px 2px 6px;
    scrollbar-width: thin; scrollbar-color: var(--fg-faint) transparent; }
  .rchips[data-drawer] .rapp { flex: 0 0 auto; }
  .rapp .logo { position: relative; }
  .rapp.on .logo { outline: 2px solid var(--accent); outline-offset: 2px; }
  .rapp.on .nm { color: var(--accent); font-weight: 700; }
  .rapp .onnow { display: none; }
  /* The drawer (wide). */
  @container tvc (min-width: 460px) {
    .np.mv-np { display: grid; grid-template-columns: minmax(0, 1fr) auto auto minmax(0, 1fr); column-gap: 28px; }
    .mv-np > .mv-nprow { grid-column: 1 / -1; grid-row: 1; }
    .mv-np > .mv-vol { grid-column: 1 / -1; grid-row: 2; }
    .mv-np > .rchips { grid-column: 2; grid-row: 3; align-self: center; }
    .mv-np > .rpad { grid-column: 3; grid-row: 3; align-self: center; }
    .rchips[data-drawer] .rapps { overflow-x: hidden; overflow-y: auto; margin-top: 10px; padding: 8px; border-radius: 18px; align-content: start; justify-content: center;
      background: color-mix(in srgb, var(--fg) 5%, var(--well)); border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 8%, transparent); }
  }
  /* WHY the volume is capped from 900 px: a bar 1700 px long is hard to aim at and leaves the card feeling empty. */
  @container tvc (min-width: 900px) { .mv-np > .mv-vol { width: min(100%, 640px); justify-self: center; } }
`;

// ── A. Icon rail ───────────────────────────────────────────────────────────────────────────────────────────────────
const CSS_A = BASE + String.raw`
  .rchips[data-drawer="rail"] .rapp { padding: 0; }
  .rchips[data-drawer="rail"] .rapp .nm { display: none; }
  .rchips[data-drawer="rail"] .rapp:hover .logo { filter: brightness(1.12); }
  @container tvc (min-width: 460px) {
    .rchips[data-drawer="rail"] .rapps { display: grid; grid-template-columns: repeat(2, 44px); gap: 8px; max-height: 260px; }
  }
  @container tvc (min-width: 900px) { .rchips[data-drawer="rail"] .rapps { grid-template-columns: repeat(3, 44px); } }
  @container tvc (min-width: 1300px) {
    .rchips[data-drawer="rail"] .rapps { grid-template-columns: repeat(3, 52px); gap: 10px; max-height: 330px; }
    .rchips[data-drawer="rail"] .rapp .logo { width: 52px; height: 52px; border-radius: 14px; font-size: 16px; }
  }
`;

// ── B. Launcher grid with More ────────────────────────────────────────────────────────────────────────────────────
const CSS_B = BASE + String.raw`
  .rchips[data-drawer="grid"] .rapp { width: 62px; padding: 4px 0; }
  .rchips[data-drawer="grid"] .rapp .nm { font-size: 10px; white-space: nowrap; }
  .rchips[data-drawer="grid"] .rapp.more .logo { background: var(--well); color: var(--fg-2); border: 1px dashed var(--edge); }
  .rchips[data-drawer="grid"] .rapp.on .nm { color: var(--accent); }
  /* Collapsed: only the first few, plus More. Narrow bar: 4 + More on a very small card, 5 + More otherwise. Expanded: everything, wrapped. */
  .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(n+5):not(.more) { display: none; }
  @container tvc (min-width: 400px) { .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(n+5):not(.more) { display: flex; } .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(n+6):not(.more) { display: none; } }
  .rchips[data-drawer="grid"][data-more="1"] .rapps { flex-wrap: wrap; overflow: visible; row-gap: 4px; }
  @container tvc (min-width: 460px) {
    .rchips[data-drawer="grid"] .rapps { display: grid; grid-template-columns: repeat(3, 62px); gap: 6px; max-height: none; }
    .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(n+6):not(.more) { display: none; }
    .rchips[data-drawer="grid"][data-more="1"] .rapp { display: flex; }
  }
  @container tvc (min-width: 900px) {
    .rchips[data-drawer="grid"] .rapps { grid-template-columns: repeat(4, 62px); }
    .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(6):not(.more), .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(7):not(.more) { display: flex; }
    .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(n+8):not(.more) { display: none; }
  }
  @container tvc (min-width: 1300px) {
    .rchips[data-drawer="grid"] .rapps { grid-template-columns: repeat(5, 72px); gap: 8px; }
    .rchips[data-drawer="grid"] .rapp { width: 72px; }
    .rchips[data-drawer="grid"] .rapp .logo { width: 48px; height: 48px; }
    .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(8):not(.more), .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(9):not(.more) { display: flex; }
    .rchips[data-drawer="grid"][data-more="0"] .rapp:nth-child(n+10):not(.more) { display: none; }
  }
`;

// ── C. Name list ───────────────────────────────────────────────────────────────────────────────────────────────────
const CSS_C = BASE + String.raw`
  /* Narrow: pills (icon + name) in a sideways row. */
  .rchips[data-drawer="list"] .rapp { flex-direction: row; align-items: center; gap: 8px; padding: 4px 12px 4px 4px; border-radius: 9999px; font-size: 12px; background: var(--well); border: 1px solid var(--edge-dim); color: var(--fg); }
  .rchips[data-drawer="list"] .rapp .logo { width: 28px; height: 28px; border-radius: 9px; font-size: 11px; }
  .rchips[data-drawer="list"] .rapp .nm { white-space: nowrap; }
  .rchips[data-drawer="list"] .rapp.on { border-color: var(--accent); }
  .rchips[data-drawer="list"] .rapp.on .logo { outline: none; }
  @container tvc (min-width: 460px) {
    .rchips[data-drawer="list"] .rapps { display: grid; grid-template-columns: repeat(1, 172px); gap: 2px; max-height: 262px; }
    .rchips[data-drawer="list"] .rapp { border: 0; background: transparent; border-radius: 12px; padding: 4px 8px 4px 4px; width: auto; }
    .rchips[data-drawer="list"] .rapp:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
    .rchips[data-drawer="list"] .rapp .nm { flex: 1; text-align: left; }
    .rchips[data-drawer="list"] .rapp.on { background: color-mix(in srgb, var(--accent) 16%, transparent); }
    .rchips[data-drawer="list"] .rapp .onnow { display: inline; font-size: 10px; font-weight: 700; letter-spacing: .04em; color: var(--accent); }
  }
  @container tvc (min-width: 900px) { .rchips[data-drawer="list"] .rapps { grid-template-columns: repeat(2, 172px); } }
  @container tvc (min-width: 1300px) { .rchips[data-drawer="list"] .rapps { grid-template-columns: repeat(3, 180px); max-height: 330px; } .rchips[data-drawer="list"] .rapp { padding: 6px 10px 6px 6px; } }
`;

const WIDE_CSS = String.raw`
  .yc-page { max-width: none !important; }
`;

function trio(key: string, label: string, style: string, css: string): Record<string, HomeVariant> {
  const mediaTv = { view: 'media', remote: [RC] };
  return {
    // The Media tab at a normal window (two cards side by side, so the TV card is about 500 px wide).
    [key]: { label, css, transform: swapChips(style), data: mediaTv },
    // The TV alone, the page's own width cap lifted: a wide window gives a ~1700 px card (Destin's screenshot).
    [`${key}-wide`]: { label: `${label}, wide card`, css: css + WIDE_CSS, transform: swapChips(style), data: { ...mediaTv, hidden: others() } },
    // The Home tab's card (narrow): the bottom bar.
    [`${key}-home`]: { label: `${label}, Home tab`, css, transform: swapChips(style), data: { remote: [RC], startOpen: ['destins_room'], hidden: others() } },
  };
}

export const VARIANTS: HomeVariants = {
  ...trio('a', 'Icon rail', 'rail', CSS_A),
  ...trio('b', 'Launcher grid', 'grid', CSS_B),
  ...trio('c', 'Name list', 'list', CSS_C),
};
