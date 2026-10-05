// Icons, TV app buttons and speaker source marks for the Home page. Moved out of
// home-assistant-page.ts (redesign audit work) only to keep that file under its
// line budget; HOME_ICONS_JS is pasted INSIDE the page's script at the exact spot
// the code used to sit, so order and scope are unchanged. Escapes: this text lives
// in a template string inside another one, so backslashes are doubled and no
// backtick may appear.

export const HOME_ICONS_JS = `
  var BULB = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/></svg>';
  var SPEAKER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
  var CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var STAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>';
  var STAR_ON = STAR.replace('fill="none"', 'fill="currentColor"');
  var UP = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
  var DOWN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var EYE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  var INFO = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
  var OUT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  function ico(d, w) { return '<svg width="' + (w || 18) + '" height="' + (w || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var REMOTE = ico('<rect x="7" y="2" width="10" height="20" rx="4"/><circle cx="12" cy="9" r="2.5"/><path d="M12 5.2v.1M10 15h.01M14 15h.01M10 18h.01M14 18h.01"/>', 16);
  // A computer: a monitor with its tower (the Computer card, home-assistant-page-computer.ts).
  var COMPUTER = ico('<rect x="2" y="4" width="13" height="10" rx="1.5"/><path d="M8.5 14v4M6 18h5"/><rect x="17.5" y="6" width="4.5" height="12" rx="1.5"/>', 16);
  // Apps open through the remote by their web address; the TV hands each to
  // its app. These are the ones Home Assistant's own docs list as working.
  // Each app's mark is drawn here in its own colour, so the buttons read at
  // a glance without loading anything from the internet.
  var APPS = [
    { name: 'YouTube', url: 'https://www.youtube.com', pkg: 'youtube', bg: '#ff0033', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>' },
    { name: 'Netflix', url: 'https://www.netflix.com/title', pkg: 'netflix', bg: '#141414', mark: '<span style="color:#e50914;font-size:20px">N</span>' },
    // WHY the name is "Prime Video" (Destin, 2026-10-05): it is the app that takes the place of whichever one is already on the TV.
    { name: 'Prime Video', url: 'https://app.primevideo.com', pkg: 'amazon', bg: '#1a98ff', mark: 'pv' },
    // UNVERIFIED: https://play.hbomax.com is the address I expect the TV to hand to the HBO Max app, but it has not been tried on the
    // real TV (the other four are the ones Home Assistant's docs list). If the button opens nothing, this address is the first suspect.
    { name: 'HBO Max', url: 'https://play.hbomax.com', pkg: 'wbd', bg: 'linear-gradient(145deg,#0a0614 0%,#3a1a8a 55%,#8a3ffc 100%)', mark: '<span style="font-size:15px;font-weight:900;letter-spacing:-.05em;text-transform:lowercase">max</span>' },
    { name: 'Disney+', url: 'https://www.disneyplus.com', pkg: 'disney', bg: '#0e2a8c', mark: 'D+' },
  ];
  // Where a speaker's music comes from, when Home Assistant says (S-now:
  // "if we can determine source, we should show spotify/etc icon").
  var SOURCES = [
    { name: 'Spotify', key: 'spotify', bg: '#1db954', mark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9.5c4-1.3 8.5-1 12 1M7 13c3.3-1 6.7-.7 9.5.9M8 16.3c2.6-.7 5-.5 7 .7"/></svg>' },
    { name: 'YouTube Music', key: 'youtube music', bg: '#ff0033', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M9 7v10l8-5z"/></svg>' },
    { name: 'Apple Music', key: 'apple music', bg: '#fa243c', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>' },
    { name: 'Amazon Music', key: 'amazon', bg: '#25d1da', mark: '<span style="color:#000">a</span>' },
    { name: 'Pandora', key: 'pandora', bg: '#224099', mark: 'P' },
    { name: 'TV', key: 'tv', bg: 'var(--accent)', mark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>' },
  ];
`;
