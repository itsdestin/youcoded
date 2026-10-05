// The TV card's APP DRAWER (Destin, 2026-10-05, round 3: "TD-1" launcher grid, picked B; his note for wide cards: "when the panel is
// really big and wide ... the apps look big/zoomed and the app panel should take most of the width (like 2/3s), then the controller
// pad more on the right"). Replaces the old four-button row. Built from the practice option that was in home-variants/tv-remote.ts.
//
// HOW IT LAYS OUT (all by CONTAINER queries on the TV card itself, so the same card is right in a wide Media tab, a half-width one and
// the narrow Home tab or a phone; the card's own inner width is what is measured, never the window):
//   below ~460 px  a bottom bar: one row under the pad, scrolls sideways, first four or five apps + "More".
//   460 - 899 px   drawer and round pad side by side, centred as one block; 3 then 4 columns; first five or seven + "More".
//   900 px up      the drawer takes the left two thirds with big tiles (they grow in steps with the card), the pad sits in the right
//                  third, centred up and down. Every app shows, so there is no "More".
// The app on the TV right now is marked "on now" IN PLACE (a ring, an accent name and a small dot); nothing is swapped or hidden
// (this replaces the older rule that swapped it for Prime Video).
// App list and order: Destin's four (YouTube, Netflix, HBO Max, Disney+), then Prime Video, then streaming, music, the rest.
// LAUNCH: unchanged mechanism. A press sends remote.turn_on with activity = the app's web address (the five the page already knew
// keep theirs) or, for new apps, the Android app id. See tvPress in home-assistant-page-tv.ts.
// "More" lives in the page's own `expanded` set (key "more:<tv id>") so the page's existing data-expand handler toggles it and a
// redraw (push, 5 s check) cannot fold it shut.
// Template strings: no backticks, no dollar-brace inside the page script; backslashes doubled.

// UNVERIFIED (every id below): none of these Android app ids has been tried on Destin's real Google TV. Home Assistant's Android TV
// Remote accepts a web link or an app id; an id the TV does not have simply opens nothing. The TV cannot report what is installed.
// `pkg` = a piece of the package name the TV reports as its current activity, used only to mark the app that is on now.
// Marks are drawn here (no images); their sizes are scaled by the drawer's own CSS (svg 56 % of the tile, text via zoom).
const NEW_APPS = [
  // UNVERIFIED id (Hulu's Android TV app).
  { name: 'Hulu', id: 'com.hulu.livingroomplus', pkg: 'hulu', bg: '#1ce783', mark: '<span style="color:#0b0c0f;font-size:12px;font-weight:900;letter-spacing:-.05em">hulu</span>' },
  // UNVERIFIED id (Apple TV app on Android TV).
  { name: 'Apple TV', id: 'com.apple.atve.androidtv.appletv', pkg: 'apple', bg: '#141414', mark: '<span style="font-size:13px;font-weight:800">tv</span>' },
  // UNVERIFIED id (Peacock).
  { name: 'Peacock', id: 'com.peacocktv.peacockandroid', pkg: 'peacock', bg: '#0c0c0c', mark: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="17" r="2.2" fill="#fff"/><circle cx="6.5" cy="13" r="2" fill="#f5c400"/><circle cx="17.5" cy="13" r="2" fill="#13b24a"/><circle cx="8" cy="7.5" r="2" fill="#e5322d"/><circle cx="16" cy="7.5" r="2" fill="#1f7ae0"/></svg>' },
  // UNVERIFIED id (Paramount+; com.cbs.ott is the id its Android TV app has used, newer builds may differ).
  { name: 'Paramount+', id: 'com.cbs.ott', pkg: 'cbs.ott', bg: '#0064ff', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M3 19 12 5l9 14z"/><circle cx="12" cy="13" r="1.2" fill="#fff" stroke="none"/></svg>' },
  // UNVERIFIED id (Spotify's TV app).
  { name: 'Spotify', id: 'com.spotify.tv.android', pkg: 'spotify', bg: '#1db954', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.3-1 6.7-.7 9.5.9M8 16.3c2.6-.7 5-.5 7 .7"/></svg>' },
  // UNVERIFIED id (YouTube Music on Android TV).
  { name: 'YouTube Music', id: 'com.google.android.youtube.tvmusic', pkg: 'youtube.tvmusic', bg: '#1c1c1c', mark: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="#ff0033" stroke-width="2"/><path d="M10 8.5v7l6-3.5z" fill="#fff"/></svg>' },
  // UNVERIFIED id (Plex).
  { name: 'Plex', id: 'com.plexapp.android', pkg: 'plexapp', bg: '#1f1f1f', mark: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h5l5 8-5 8H8l5-8z" fill="#e5a00d"/></svg>' },
  // UNVERIFIED id (Tubi).
  { name: 'Tubi', id: 'com.tubitv', pkg: 'tubitv', bg: '#2b0f5c', mark: '<span style="font-size:12px;font-weight:800;letter-spacing:-.02em">tubi</span>' },
  // UNVERIFIED id (Twitch).
  { name: 'Twitch', id: 'tv.twitch.android.app', pkg: 'twitch', bg: '#9146ff', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h15v10l-4 4h-4l-3 3v-3H5z"/><path d="M12 7v3.5M16 7v3.5"/></svg>' },
  // UNVERIFIED id (Crunchyroll).
  { name: 'Crunchyroll', id: 'com.crunchyroll.crunchyroid', pkg: 'crunchyroll', bg: '#f47521', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="14.2" cy="10" r="1.6" fill="#fff" stroke="none"/></svg>' },
];
// `base` = reuse the page's own APPS entry (its web address, colour and mark) so those five launch exactly as before.
const DRAWER = [{ name: 'YouTube', base: 1 }, { name: 'Netflix', base: 1 }, { name: 'HBO Max', base: 1 }, { name: 'Disney+', base: 1 }, { name: 'Prime Video', base: 1 }, ...NEW_APPS];

const MORE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></svg>';

export const HOME_DRAWER_JS = `
  // ── The TV's app drawer (see home-assistant-page-drawer.ts) ─────────────────
  var RC_DRAWER = ${JSON.stringify(DRAWER)};
  // Which drawer app is on the TV right now. WHY the longest matching piece of the package name wins: YouTube Music's package
  // also contains "youtube". Falls back to the app the page already worked out (active) so the five older apps keep matching.
  function drawerNow(r, active) {
    var act = String(r.activity || '').toLowerCase(), cur = '', best = 0;
    RC_DRAWER.forEach(function (a) {
      var base = a.base ? APPS.filter(function (x) { return x.name === a.name; })[0] : null, p = base ? base.pkg : a.pkg;
      if (act && p && act.indexOf(p) >= 0 && p.length > best) { best = p.length; cur = a.name; }
    });
    return cur || (active ? active.name : '');
  }
  function tvChipsHtml(r, active) {
    var id = esc(r.id), more = expanded.has('more:' + r.id), cur = drawerNow(r, active);
    var btns = RC_DRAWER.map(function (a) {
      var base = a.base ? APPS.filter(function (x) { return x.name === a.name; })[0] : null, go = base ? base.url : a.id, on = cur === a.name;
      return '<button class="app rapp' + (on ? ' on' : '') + '" data-rc="' + id + '" data-app="' + esc(go) + '" data-name="' + esc(a.name) + '"' + (on ? ' aria-current="true"' : '') +
        ' aria-label="Open ' + esc(a.name) + (on ? ' (on now)' : '') + '" title="' + esc(a.name) + '"><span class="logo" style="--app:' + (base ? base.bg : a.bg) + '">' + (base ? base.mark : a.mark) +
        (on ? '<span class="onnow"></span>' : '') + '</span><span class="nm">' + esc(a.name) + '</span></button>';
    }).join('');
    var moreBtn = '<button class="app rapp more" data-expand="more:' + id + '" aria-expanded="' + more + '" aria-label="' + (more ? 'Show fewer apps' : 'Show all apps') + '"><span class="logo">${MORE_ICON}</span><span class="nm">' + (more ? 'Less' : 'More') + '</span></button>';
    return '<div class="rchips" data-slot="chips" data-more="' + (more ? 1 : 0) + '"><div class="rchips-in"><div class="rapps">' + btns + moreBtn + '</div></div></div>';
  }
`;

// Layout. The opening animation (rows 0fr to 1fr, fade) stays in home-assistant-page-tv.ts; this is only where things sit.
export const HOME_DRAWER_CSS = `
  .tile.mv-wide, .np-ctl.tv { container: tvc / inline-size; }
  /* Bottom bar (narrow): one row that scrolls sideways; the last icon peeking out is the hint. */
  .rchips .rapps { display: flex; flex-wrap: nowrap; justify-content: safe center; gap: 10px; overflow-x: auto; overflow-y: hidden; padding: 12px 2px 6px; } /* WHY no scrollbar-width: Chromium then ignores the page's themed ::-webkit-scrollbar rules (pinned in home-page-camera.test.ts) */
  .rchips .rapp { flex: 0 0 auto; width: 62px; padding: 4px 0; font-size: 10px; position: relative; }
  /* WHY two lines allowed: "YouTube Music" and "Prime Video" are longer than a 62 px tile. */
  .rapp .nm { white-space: normal; text-align: center; line-height: 1.15; overflow-wrap: anywhere; }
  .rapp .logo { position: relative; }
  .rapp.on .logo { outline: 2px solid var(--accent); outline-offset: 2px; }
  .rapp.on .nm { color: var(--accent); font-weight: 700; }
  .rapp .onnow { position: absolute; top: -4px; right: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); border: 2px solid var(--well); box-sizing: content-box; }
  .rapp.more .logo { background: var(--well); color: var(--fg-2); border: 1px dashed var(--edge); box-sizing: border-box; }
  .rapp .logo svg { max-width: 100%; max-height: 100%; }
  /* Folded: only the first few apps and More. Each size re-lists what shows (a reset first, so a later size can show more). */
  .rchips[data-more="0"] .rapp:nth-child(n+5):not(.more) { display: none; }
  .rchips[data-more="1"] .rapps { flex-wrap: wrap; overflow: visible; row-gap: 4px; }
  @container tvc (min-width: 400px) {
    .rchips[data-more="0"] .rapp:nth-child(n+1):not(.more) { display: flex; }
    .rchips[data-more="0"] .rapp:nth-child(n+6):not(.more) { display: none; }
  }
  /* Medium: the drawer and the pad side by side, centred as one block. */
  @container tvc (min-width: 460px) {
    .mv-wide .np.mv-np { display: grid; grid-template-columns: minmax(0, 1fr) auto auto minmax(0, 1fr); column-gap: 28px; } /* WHY .mv-wide in front: the Media tab sheet (loaded after this one) says display: block at the same weight */
    .mv-np > .mv-nprow, .mv-np > .mv-vol { grid-column: 1 / -1; }
    .mv-np > .mv-nprow { grid-row: 1; } .mv-np > .mv-vol { grid-row: 2; }
    .mv-np > .rchips { grid-column: 2; grid-row: 3; align-self: center; }
    .mv-np > .rpad { grid-column: 3; grid-row: 3; align-self: center; }
    .rchips .rapps { display: grid; grid-template-columns: repeat(3, 62px); gap: 6px; overflow: visible; margin-top: 10px; padding: 8px; border-radius: 18px; justify-content: center; align-content: start;
      background: color-mix(in srgb, var(--fg) 5%, var(--well)); border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 8%, transparent); }
    .rchips[data-more="1"] .rapp { display: flex; }
  }
  @container tvc (min-width: 650px) {
    .rchips .rapps { grid-template-columns: repeat(4, 62px); }
    .rchips[data-more="0"] .rapp:nth-child(n+1):not(.more) { display: flex; }
    .rchips[data-more="0"] .rapp:nth-child(n+8):not(.more) { display: none; }
  }
  /* Wide: the drawer takes the left two thirds with big tiles, the pad sits in the right third, centred. Everything shows, no More.
     WHY zoom in steps (not a smooth size): the app marks have fixed pixel sizes; zoom scales mark, ring and dot together. */
  @container tvc (min-width: 900px) {
    .mv-wide .np.mv-np { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); column-gap: 24px; }
    .mv-np > .rchips { grid-column: 1; align-self: stretch; }
    .mv-np > .rpad { grid-column: 2; align-self: center; justify-self: center; }
    .rchips .rapps { grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); justify-items: center; gap: 12px 8px; padding: 14px; border-radius: 22px; }
    .rchips .rapp { display: flex !important; width: 100%; font-size: 12px; }
    .rchips .rapp.more { display: none !important; }
    .rapp .logo { zoom: 1.3; }
    .mv-np > .mv-vol { width: min(100%, 640px); justify-self: center; }
    /* WIDE + REMOTE OPEN only (Destin's markup, 2026-10-05): the drawer takes the whole left area right under the app title; the right
       column, top to bottom, is the pad, the volume, then the five transport keys (bottom lines up with the drawer's bottom).
       WHY CSS only: row 1's flex box is made transparent (display: contents) so the keys, which live inside it, become grid items of
       the panel; no element is moved or redrawn, so slider drags, the reveal and keyed redraws are untouched. Closed, medium and
       narrow keep their layout because every rule needs data-open="1" on the pad AND this width. */
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) { grid-template-rows: auto auto auto 1fr; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .mv-nprow { display: contents; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) .mv-nprow > .mv-art { grid-column: 1; grid-row: 1; justify-self: start; align-self: center; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) .mv-nprow > .mv-nowt { grid-column: 1 / -1; grid-row: 1; margin-left: 62px; align-self: center; } /* 62 = art 52 + gap 10 */
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .rchips { grid-column: 1; grid-row: 2 / -1; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .rpad { grid-column: 2; grid-row: 2; align-self: start; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .mv-vol { grid-column: 2; grid-row: 3; width: 100%; margin-top: 0; padding-top: 0; border-top: 0; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) .mv-nprow > .np-keys { grid-column: 2; grid-row: 4; align-self: end; justify-self: center; margin: 12px 0 0; }
    /* WHY one column width (Destin, 2026-10-05: "the buttons, volume slider, and circle pad should all be roughly the same width,
       with matching left/right margins. app tray should fill remaining space"): the right column is exactly --rc wide and the pad,
       the volume row and the key row are each sized to it; the drawer takes everything else. The keys keep their slot grid (the
       open/close swap animates by slot), only the gap is worked out so five keys span the column. The soundbar's name and icon
       are dropped here: "remove the destins room soundbar line/icon". */
    /* WHY 252 and the closed gap (Destin, 2026-10-05: "smaller circle. buttons in expanded view should match spacing from closed
       view"): the Media tab's closed row is five 40 px keys with 4 px gaps (home-assistant-page-media.ts), 216 px; the expanded keys
       keep exactly that, the volume matches its width, and the circle is smaller and centred. */
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) { --rc: 216px; grid-template-columns: minmax(0, 1fr) var(--rc); }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .rpad { justify-self: stretch; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) .rdial { width: 196px; height: 196px; margin: 0 0 16px; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .mv-vol .mv-vlbl { display: none; }
    /* the tray runs the column's full height; .rchips stays a grid (its 0fr → 1fr row is the reveal), the inner layer stretches */
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .rchips { align-self: stretch; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .rchips .rchips-in { display: flex; flex-direction: column; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) > .rchips .rapps { flex: 1 1 auto; margin-top: 0; }
    .mv-wide .np.mv-np:has(.rpad[data-open="1"]) .mv-nprow > .np-keys { width: var(--rc); }
  }
  @container tvc (min-width: 1200px) { .rchips .rapps { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); } .rapp .logo { zoom: 1.55; } .rchips .rapp { font-size: 13px; } }
  @container tvc (min-width: 1500px) { .rchips .rapps { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); } .rapp .logo { zoom: 1.8; } .rchips .rapp { font-size: 14px; } }
  @container tvc (min-width: 1800px) { .rchips .rapps { grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); } .rapp .logo { zoom: 2.1; } .rchips .rapp { font-size: 15px; } }
`;
