// The "look" task's options are finished: Destin chose b ("Glass and glow") and it is built into the
// page (home-assistant-page-look.ts). The three directions' CSS is in git at 30723d2e0.
//
// What stays here: three ways to start and stop LIVE in a camera card (Destin did not like the "Live" pill in the
// card's header, 2026-10-05). Practice-only; screens pages/page/page-home#v-look-cam-a|b|c. The built page's
// camera card is rewritten by text (transform) at three small places, so each option is the real card, working:
//  a: a play button on the picture itself      b: an icon-only button in the header
//  c: a Live / Recordings switch under the header
import type { HomeVariant, HomeVariants } from './types';
import { fakeHomeAssistantIds } from '../fake-home-assistant';

/** Replace one piece of the page's script; fail loudly when the page has changed under the option. */
function swap(html: string, from: string | RegExp, to: string): string {
  const out = html.replace(from, () => to);
  if (out === html) throw new Error('home variant: anchor not found: ' + String(from).slice(0, 70));
  return out;
}
// The camera card as drawn by the built page (home-assistant-page-camera.ts): where the header button is made, and the live picture.
const BTN = /    var btn = canVideo\(\) && !inTab \?[^\n]*\n/;
const LIVE_STAGE = '    if (running && !inTab) {';
const LIVE_END = `'<span class="cam-msg">Starting live view…</span>') + '</div>';`;
const LIST = `    if (ev.state === 'loading') html +=`;

/** Only the Living Room camera on the page, with its 20 recordings, the Nest account working. */
const DATA = { hidden: fakeHomeAssistantIds().filter((id) => id !== 'camera.living_room_camera'), startOpen: [] as string[] };
const COMMON = { data: DATA, nestSignedIn: true };

const STOP_SQUARE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>`;

const camA: HomeVariant = {
  ...COMMON,
  label: 'Camera: play button on the picture',
  // The card always has its picture area; a big round play button sits on it. While live, a small Stop sits in the corner.
  transform: (html) => {
    let out = swap(html, BTN, `    var btn = '';\n`);
    out = swap(out, LIVE_STAGE, `    if (!running && !clip && !inTab && canVideo()) html += '<div class="cam-view cam-idle"><button class="cam-play" data-cam-act="live" data-id="' + eid + '" aria-label="Watch ' + esc(it.name) + ' live"' + (na ? ' disabled' : '') + '>' + PLAYG + '</button><span class="cam-hint">' + (na ? 'Not responding' : 'Watch live') + '</span></div>';\n${LIVE_STAGE}`);
    return swap(out, LIVE_END, `'<span class="cam-msg">Starting live view…</span>') + '<button class="yc-button yc-button--sm cam-x" data-cam-act="stop" data-id="' + eid + '">Stop</button></div>';`);
  },
  css: `
    .cam-idle { background: radial-gradient(120% 120% at 30% 20%, color-mix(in srgb, var(--accent) 22%, #10151c), #0b0f14); }
    .cam-play { appearance: none; position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%); width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
      color: #fff; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.35); backdrop-filter: blur(6px); box-shadow: 0 10px 28px -8px rgba(0,0,0,.7); }
    .cam-play svg { width: 26px; height: 26px; margin-left: 3px; }
    .cam-play:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .cam-play:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .cam-play:disabled { opacity: .45; cursor: default; }
    .cam-hint { position: absolute; left: 0; right: 0; bottom: 10px; text-align: center; color: rgba(255,255,255,.8); font-size: 12px; letter-spacing: .02em; }
  `,
};

const camB: HomeVariant = {
  ...COMMON,
  label: 'Camera: icon-only button in the header',
  // A round camera icon at the top right; while live it turns red with a stop square. No word.
  transform: (html) => swap(html, BTN, `    var btn = canVideo() && !inTab ? '<button class="cam-ic" data-cam-act="' + (running ? 'stop' : 'live') + '" data-id="' + eid + '" aria-pressed="' + !!running + '" aria-label="' + (running ? 'Stop live view' : 'Watch live') + '" title="' + (running ? 'Stop live view' : 'Watch live') + '"' + (na ? ' disabled' : '') + '>' + (running ? '${STOP_SQUARE}' : CAMERA_ICO) + '</button>' : '';\n`),
  css: `
    .cam-ic { appearance: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; color: var(--fg);
      border: 1px solid color-mix(in srgb, var(--fg) 16%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 9%, var(--panel)), var(--panel)); }
    .cam-ic svg { width: 18px; height: 18px; }
    .cam-ic:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .cam-ic:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .cam-ic:disabled { opacity: .45; cursor: default; }
    .cam-ic[aria-pressed="true"] { background: rgb(235, 70, 55); border-color: rgb(235, 70, 55); color: #fff; box-shadow: 0 0 0 4px color-mix(in srgb, rgb(235, 70, 55) 28%, transparent); }
  `,
};

const camC: HomeVariant = {
  ...COMMON,
  label: 'Camera: Live / Recordings switch',
  // A two-part switch under the header. Recordings (the list) is the resting side; Live shows only the picture.
  transform: (html) => {
    let out = swap(html, BTN, `    var btn = '';\n`);
    out = swap(out, LIVE_STAGE, `    if (canVideo() && !inTab) html += '<div class="cam-seg" role="group" aria-label="What to show"><button data-cam-act="' + (running ? 'noop' : 'live') + '" data-id="' + eid + '" aria-pressed="' + !!running + '"' + (na ? ' disabled' : '') + '><i aria-hidden="true"></i>Live</button><button data-cam-act="' + (running ? 'stop' : 'noop') + '" data-id="' + eid + '" aria-pressed="' + !running + '">Recordings</button></div>';\n${LIVE_STAGE}`);
    return swap(out, LIST, `    if (running && !inTab) { /* the Live side shows only the picture */ } else if (ev.state === 'loading') html +=`);
  },
  css: `
    .cam-seg { display: grid; grid-template-columns: 1fr 1fr; padding: 3px; gap: 3px; border-radius: 9999px; background: color-mix(in srgb, var(--fg) 7%, var(--well)); border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
    .cam-seg button { appearance: none; font: inherit; font-size: 12px; font-weight: 600; height: 30px; border: 0; border-radius: 9999px; background: transparent; color: var(--fg-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
    .cam-seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .cam-seg button:disabled { opacity: .45; cursor: default; }
    .cam-seg button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); box-shadow: 0 4px 14px -6px var(--accent); }
    .cam-seg i { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); }
    .cam-seg button[aria-pressed="true"] i { background: rgb(235, 70, 55); }
  `,
};

export const VARIANTS: HomeVariants = { 'cam-a': camA, 'cam-b': camB, 'cam-c': camC };
