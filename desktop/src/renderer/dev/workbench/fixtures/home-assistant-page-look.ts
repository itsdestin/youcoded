// Redesign round 1, look b ("Glass and glow") — the Home page's look layer. Destin chose it
// 2026-10-04: raised glass cards with soft shadows, anything that is ON glows in its own
// colour, the open tab is filled with the theme's accent. Loaded LAST so it restyles every
// feature's own CSS (cards, tiles, pills, pop-up, Activity, Edit board, pending note, camera,
// Sonos group list, remote) without those files knowing about it. Colours come only from the
// theme's variables; the status colours (a light's own colour) stay literal. No transitions
// are added here (motion belongs to the motion rounds). Template string: no backticks, no
// dollar-brace, no backslashes.
// Activity rows: the round-1 picture had a coloured edge and a round tinted "thumbnail" per row;
// Destin disliked it, so each row keeps only a small plain icon in the event's colour.
export const HOME_LOOK_CSS = `
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
  /* Edit mode's Done button is the primary (accent) button; keep it filled. */
  .bar .yc-button--primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .chip, .tile2, .prob, .th-hero { border-radius: 22px; border-color: color-mix(in srgb, var(--fg) 11%, transparent); box-shadow: 0 14px 30px -18px rgba(0,0,0,.5); }
  .wx { border-radius: 24px; box-shadow: 0 18px 36px -18px rgba(0,0,0,.6); }
  .th-step { box-shadow: 0 6px 14px -8px rgba(0,0,0,.5); }
  .fchip { border-color: color-mix(in srgb, var(--fg) 14%, transparent); }
  .fchip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .ev { border-radius: 16px; padding: 12px 16px; border-color: color-mix(in srgb, var(--fg) 8%, transparent); background: color-mix(in srgb, var(--fg) 4%, var(--panel)); }
  .ev .i { width: 20px; height: 20px; background: none; color: color-mix(in srgb, var(--d) 75%, var(--fg)); }
  .dlg-scrim { background: rgba(0,0,0,.55); backdrop-filter: blur(10px); }
  .dlg { border-radius: 28px; padding: 24px; border-color: color-mix(in srgb, var(--fg) 14%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 7%, var(--panel)), var(--panel));
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 14%, transparent), 0 30px 80px -20px rgba(0,0,0,.7); }
  .dlg-head h2 { font-size: 20px; }
  .dlg-x { background: color-mix(in srgb, var(--fg) 10%, transparent); }
  @media (max-width: 520px) { .yc-card.room { padding: 12px; border-radius: 20px; } .dlg { padding: 16px; border-radius: 22px; } }

  /* The things added after round 1: the Edit board, the pending note, the camera card,
     the Sonos group list and the remote get the same raised-glass look. */
  .edc-row { border-radius: 16px; border-color: color-mix(in srgb, var(--fg) 9%, transparent); background: color-mix(in srgb, var(--fg) 5%, var(--panel)); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 8%, transparent); }
  .edc-row.open { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .edc-grip { border-radius: 10px; }
  .edc-new { border-radius: 16px; border-color: color-mix(in srgb, var(--fg) 18%, transparent); }
  .edx-menu { border-top-style: solid; border-top-color: color-mix(in srgb, var(--fg) 8%, transparent); }
  .edc-lift { box-shadow: 0 14px 32px -10px rgba(0, 0, 0, .55); }
  .pend { border-color: color-mix(in srgb, var(--fg) 14%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--panel)), var(--panel)); box-shadow: 0 6px 16px -8px rgba(0, 0, 0, .55); padding: 4px 10px; }
  .cam-card { border-radius: 20px; }
  .cam-ev { border-radius: 14px; background: color-mix(in srgb, var(--fg) 6%, var(--panel)); padding: 7px 10px; }
  .cam-ev .th { border-radius: 9px; }
  .cam-view, .cam, .cam-empty { border-radius: 16px; }
  .glist { gap: 6px; }
  .gitem { border-radius: 14px; border-color: color-mix(in srgb, var(--fg) 9%, transparent); background: color-mix(in srgb, var(--fg) 6%, var(--panel)); }
  .gitem[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .gtick { border-radius: 7px; }
  .remote { border-radius: 18px; border-color: color-mix(in srgb, var(--fg) 9%, transparent); background: color-mix(in srgb, var(--fg) 5%, var(--panel)); }
  .dpad { background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 8%, var(--well)), var(--well)); border-color: color-mix(in srgb, var(--fg) 12%, transparent); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--fg) 10%, transparent); }
  .app .logo { border-radius: 14px; box-shadow: 0 6px 14px -8px rgba(0, 0, 0, .6); }
  .rbtn, .key, .pwr, .vbtn { border-color: color-mix(in srgb, var(--fg) 14%, transparent); }
  .yc-card.room, .yc-card.set-sec, .tile, .lights { max-width: 100%; }
  @media (max-width: 520px) { .pend { right: 6px; } .remote { padding: 12px 8px; } }
`;
