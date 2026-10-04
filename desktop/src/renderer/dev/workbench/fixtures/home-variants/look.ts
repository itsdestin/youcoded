// Design options for the "look" task of the Home page redesign: how premium
// the page feels. Three different KINDS of look, each shown on the main page
// and, with a state suffix, on the pop-up, Activity and Climate.
// Keys: a, b, c (+ -device, -activity, -climate); each becomes the practice
// screen pages/page/page-home#v-look-<key>. See types.ts.
import type { HomeVariants } from './types';

// WHY: these are what the page's own "connected" screen starts from, so the
// three options are compared on the same rooms as today's page.
const MAIN = { open: ['destins_room'], expanded: ['light.desk_backlight'], fav: ['light.living_room_lamp', 'climate.thermostat'] };
const DEVICE = { ...MAIN, dlg: 'light.living_room_lamp' };
const ACTIVITY = { ...MAIN, view: 'activity' };
const CLIMATE = { ...MAIN, view: 'climate' };

// ── A. Calm and flat ──────────────────────────────────────────────────────
// WHY: today every thing sits in a box inside a box inside a box. Here the
// room boxes disappear, devices become soft tinted surfaces, the fat
// brightness bars become thin lines with a round handle, and there is more
// air between things. Quiet, like a well-made phone settings app.
const CSS_A = String.raw`
  :root { --soft: color-mix(in srgb, var(--fg) 5%, transparent); --soft2: color-mix(in srgb, var(--fg) 9%, transparent); }
  .yc-page { gap: 22px; }
  .rooms { column-gap: 28px; }
  .yc-card.room, .yc-card.set-sec { background: transparent; border-color: transparent; padding: 0; gap: 12px; margin-bottom: 28px; }
  .room-head h2 { font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-muted); padding-left: 4px; }
  .fav-head h2 { color: var(--fg-muted); }
  .tile, .thing, .np, .gitem { border-color: transparent; background: var(--soft); border-radius: 18px; }
  .tile { padding: 14px 16px; gap: 12px; }
  .tile.on { background: color-mix(in srgb, var(--c) 10%, var(--soft)); }
  .lights { border-color: transparent; background: var(--soft); border-radius: 20px; }
  .lights-body > .tile { background: var(--soft2); border-radius: 14px; }
  .lights > .tile.all { background: transparent; padding: 14px 18px 10px; }
  .tile .glow { display: none; }
  .tile .bulb { width: 36px; height: 36px; }
  .tile.on .bulb { box-shadow: none; }
  .tile .name { font-size: 15px; font-weight: 500; }
  .tile .lr { height: 28px; background-size: 100% 6px; background-position: center; background-repeat: no-repeat; border-radius: 0; }
  .tile .lr::-webkit-slider-thumb { width: 22px; height: 22px; margin-top: 0; border-radius: 50%; background: var(--fg); box-shadow: 0 1px 4px rgba(0,0,0,.35); }
  .scenes { border: 0; background: var(--soft2); border-radius: 12px; margin: 0 10px 10px; }
  .sw { border-width: 0; box-shadow: 0 0 0 1px var(--edge-dim); }
  .pill { border-color: transparent; background: var(--soft); height: 38px; }
  .pill:hover { background: var(--soft2); border-color: transparent; }
  .pill.sel, .pill.lit.sel { background: var(--fg); border-color: transparent; }
  .bar .yc-button { border-radius: 9999px; border-color: transparent; background: var(--soft); height: 34px; }
  .bar .yc-button:hover { background: var(--soft2); }
  .chip, .tile2, .prob, .th-hero, .wx { border-color: transparent; border-radius: 22px; }
  .prob { background: var(--soft); }
  .th-hero { background: var(--soft); }
  .th-step { background: var(--soft2); border-color: transparent; }
  .th-mode { padding: 8px 16px; }
  .vicon2 { background: var(--soft); border-radius: 14px; }
  .vtitle h2 { font-size: 26px; letter-spacing: -.01em; }
  .fchip { border-color: transparent; background: var(--soft); padding: 6px 14px; }
  .fchip[aria-pressed="true"] { background: var(--fg); }
  .act-list { gap: 0; }
  .ev { background: transparent; border: 0; border-bottom: 1px solid var(--edge-dim); border-radius: 0; padding: 14px 4px; }
  .ev .i { width: 34px; height: 34px; }
  .act-day { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-muted); margin-top: 16px; }
  .dlg-scrim { background: rgba(0,0,0,.38); backdrop-filter: blur(6px); }
  .dlg { border-radius: 26px; border-color: transparent; padding: 26px; gap: 22px; box-shadow: 0 24px 60px -20px rgba(0,0,0,.5); }
  .dlg-head h2 { font-size: 22px; }
  .hrow { padding: 12px 0; }
  .dlg-x { border-color: transparent; background: var(--soft2); }
  @media (max-width: 520px) { .tile { padding: 12px 14px; } .rooms { column-gap: 0; } .dlg { padding: 18px; border-radius: 22px; } }
`;

// ── B. Glass and glow ────────────────────────────────────────────────────
// WHY: a richer, more tactile look. Cards are raised glass with a soft edge
// light and shadow; anything that is ON glows in its own colour so the
// house reads at a glance; controls are chunky and rounded; the open tab is
// filled with the theme's accent instead of plain black/white.
const CSS_B = String.raw`
  .yc-card.room, .yc-card.set-sec { border-radius: 24px; padding: 16px; gap: 12px; border-color: color-mix(in srgb, var(--fg) 11%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 6%, var(--panel)), var(--panel));
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 12%, transparent), 0 14px 30px -18px rgba(0,0,0,.55); }
  .room-head h2 { font-size: 16px; letter-spacing: -.005em; }
  .tile, .thing, .np { border-radius: 18px; border-color: color-mix(in srgb, var(--fg) 9%, transparent); background: color-mix(in srgb, var(--fg) 4%, var(--panel));
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 8%, transparent); }
  .tile { padding: 12px 14px; }
  .tile.on { border-color: color-mix(in srgb, var(--c) 50%, transparent); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--c) 30%, transparent), 0 10px 26px -14px var(--c); }
  .tile.on .glow { opacity: .3; background: radial-gradient(120% 160% at 0% 0%, var(--c), transparent 75%); }
  .lights { border-radius: 20px; border-color: color-mix(in srgb, var(--fg) 9%, transparent); }
  .lights-body > .tile { background: color-mix(in srgb, var(--fg) 6%, var(--panel)); }
  .tile .bulb { width: 38px; height: 38px; }
  .tile.on .bulb { box-shadow: 0 0 22px var(--c), inset 0 1px 0 rgba(255,255,255,.5); }
  .tile .lr { height: 30px; border-radius: 15px; box-shadow: inset 0 1px 3px rgba(0,0,0,.3); }
  .tile .lr::-webkit-slider-thumb { width: 26px; height: 26px; margin: 0 2px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
  .scenes { border-radius: 14px; border-color: color-mix(in srgb, var(--fg) 8%, transparent); }
  .pill { border-color: color-mix(in srgb, var(--fg) 14%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--panel)), var(--panel)); box-shadow: 0 4px 12px -8px rgba(0,0,0,.5); }
  .pill.sel, .pill.lit.sel { background: var(--accent); border-color: var(--accent); color: var(--on-accent); box-shadow: 0 6px 18px -6px var(--accent); }
  .pill.sel .pill-ic { background: var(--on-accent); color: var(--accent); }
  .pill.sel .eq i { background: var(--on-accent); }
  .bar .yc-button { border-radius: 9999px; height: 36px; background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--panel)), var(--panel)); border-color: color-mix(in srgb, var(--fg) 14%, transparent); }
  .chip, .tile2, .prob, .th-hero { border-radius: 22px; border-color: color-mix(in srgb, var(--fg) 11%, transparent); box-shadow: 0 14px 30px -18px rgba(0,0,0,.5); }
  .wx { border-radius: 24px; box-shadow: 0 18px 36px -18px rgba(0,0,0,.6); }
  .th-step { box-shadow: 0 6px 14px -8px rgba(0,0,0,.5); }
  .fchip { border-color: color-mix(in srgb, var(--fg) 14%, transparent); }
  .fchip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .ev { border-radius: 16px; padding: 12px 14px; border-color: color-mix(in srgb, var(--fg) 9%, transparent); box-shadow: inset 3px 0 0 var(--d, var(--edge-dim)); }
  .ev .i { width: 32px; height: 32px; }
  .dlg-scrim { background: rgba(0,0,0,.55); backdrop-filter: blur(10px); }
  .dlg { border-radius: 28px; padding: 24px; border-color: color-mix(in srgb, var(--fg) 14%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 7%, var(--panel)), var(--panel));
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 14%, transparent), 0 30px 80px -20px rgba(0,0,0,.7); }
  .dlg-head h2 { font-size: 20px; }
  .dlg-x { background: color-mix(in srgb, var(--fg) 10%, transparent); }
  @media (max-width: 520px) { .yc-card.room { padding: 12px; border-radius: 20px; } .dlg { padding: 16px; border-radius: 22px; } }
`;

// ── C. Clean list ─────────────────────────────────────────────────────────
// WHY: the opposite of cards. Rooms become titled sections divided by thin
// lines, devices become rows, only the little round icons carry colour, and
// the tabs become an underlined strip. Dense, precise, instrument-like: fits
// more on screen and reads like a well-set page rather than a dashboard.
const CSS_C = String.raw`
  .yc-card.room, .yc-card.set-sec { background: transparent; border: 0; border-top: 1px solid var(--edge); border-radius: 0; padding: 14px 0 6px; gap: 2px; margin-bottom: 16px; }
  .room-head { padding-bottom: 6px; }
  .room-head h2 { font-size: 20px; font-weight: 600; letter-spacing: -.01em; }
  .tile, .thing, .np, .gitem { background: transparent; border: 0; border-radius: 0; box-shadow: none; }
  .tile, .thing { border-top: 1px solid var(--edge-dim); padding: 10px 2px; }
  .room-head + .tile, .room-head + .thing, .lights > .tile:first-child { border-top: 0; }
  .lights { background: transparent; border: 0; border-radius: 0; }
  .lights > .glow { display: none; }
  .lights-body { padding: 0; }
  .lights-body > .tile { background: transparent; border-top: 1px solid var(--edge-dim); }
  .lights > .tile.all { padding: 6px 2px; }
  .tile .glow { display: none; }
  .tile .bulb { width: 28px; height: 28px; }
  .tile.on .bulb { box-shadow: none; }
  .tile .name { font-size: 14px; }
  .tile .lr { height: 22px; background-size: 100% 3px; background-position: center; background-repeat: no-repeat; border-radius: 0; }
  .tile .lr::-webkit-slider-thumb { width: 14px; height: 14px; margin: 0; border-radius: 50%; background: var(--fg); box-shadow: 0 0 0 4px color-mix(in srgb, var(--fg) 14%, transparent); }
  .scenes { background: transparent; border: 0; border-top: 1px solid var(--edge-dim); border-radius: 0; margin: 0; }
  .np { border-top: 1px solid var(--edge-dim); }
  .pills, #chips { gap: 4px; }
  .pill { border: 0; border-radius: 0; background: transparent; height: 40px; padding: 0 12px 0 4px; border-bottom: 2px solid transparent; color: var(--fg-2); }
  .pill:hover { background: transparent; color: var(--fg); }
  .pill.sel, .pill.lit.sel { background: transparent; color: var(--fg); border: 0; border-bottom: 2px solid var(--accent); }
  .pill.sel .pill-ic { background: var(--well); color: var(--fg); }
  .pill.sel.lit .pill-ic { background: var(--k); color: #111; }
  .pill.sel .eq i { background: var(--accent); }
  .toprow { border-bottom: 1px solid var(--edge-dim); padding-bottom: 2px; }
  .bar .yc-button { background: transparent; border-color: transparent; text-decoration: underline; text-underline-offset: 3px; }
  .chip, .tile2, .prob, .th-hero { border-radius: 14px; background: transparent; }
  .th-hero { border-color: var(--edge-dim); }
  .vicon2 { background: transparent; border: 1px solid var(--edge); border-radius: 50%; }
  .vtitle h2 { font-size: 28px; letter-spacing: -.015em; }
  .fchip { background: transparent; border-color: transparent; border-radius: 0; padding: 4px 8px; border-bottom: 2px solid transparent; color: var(--fg-2); }
  .fchip[aria-pressed="true"] { background: transparent; color: var(--fg); border-bottom-color: var(--accent); }
  .act-list { gap: 0; }
  .ev { background: transparent; border: 0; border-top: 1px solid var(--edge-dim); border-radius: 0; padding: 9px 2px; }
  .act-day { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; margin: 14px 0 4px; color: var(--fg-muted); }
  .dlg-scrim { background: rgba(0,0,0,.45); }
  .dlg { border-radius: 10px; padding: 22px; gap: 16px; }
  .dlg-head h2 { font-size: 22px; letter-spacing: -.01em; }
  .dlg-sec { border-bottom: 1px solid var(--edge-dim); padding-bottom: 6px; margin-bottom: 6px; }
  @media (max-width: 520px) { .tile { padding: 9px 0; } .pill { padding: 0 8px 0 2px; } .dlg { padding: 16px; } }
`;

const v = (label: string, css: string, data: Record<string, unknown>) => ({ label, css, data });

export const VARIANTS: HomeVariants = {
  a: v('Calm and flat', CSS_A, MAIN),
  'a-device': v('Calm and flat, device pop-up', CSS_A, DEVICE),
  'a-activity': v('Calm and flat, Activity', CSS_A, ACTIVITY),
  'a-climate': v('Calm and flat, Climate', CSS_A, CLIMATE),
  b: v('Glass and glow', CSS_B, MAIN),
  'b-device': v('Glass and glow, device pop-up', CSS_B, DEVICE),
  'b-activity': v('Glass and glow, Activity', CSS_B, ACTIVITY),
  'b-climate': v('Glass and glow, Climate', CSS_B, CLIMATE),
  c: v('Clean list', CSS_C, MAIN),
  'c-device': v('Clean list, device pop-up', CSS_C, DEVICE),
  'c-activity': v('Clean list, Activity', CSS_C, ACTIVITY),
  'c-climate': v('Clean list, Climate', CSS_C, CLIMATE),
};
