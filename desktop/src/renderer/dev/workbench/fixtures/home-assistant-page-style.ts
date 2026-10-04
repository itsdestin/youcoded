// The Home page's styles, kept apart from its script and markup so neither
// file outgrows the line budget (home-assistant-page.ts assembles them).
// The comments inside say which review round asked for each part.
export const HOME_ASSISTANT_PAGE_CSS = `
  .rooms { columns: 340px; column-gap: 12px; }
  .room { break-inside: avoid; margin-bottom: 12px; display: flex; flex-direction: column; gap: 10px; }
  .room-head { display: flex; align-items: center; gap: 8px; }
  .room-head h2 { flex: 1; font-size: 15px; font-weight: 600; }
  .thing { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 10px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .thing .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thing .sub { font-size: 11px; color: var(--fg-muted); }
  .thing.off .name { color: var(--fg-2); }
  .thing.gone { opacity: .55; }
  .thing.col { flex-direction: column; align-items: stretch; }
  .thing .line { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
  .temp { font-family: var(--font-mono); font-size: 28px; font-weight: 500; line-height: 1; }
  .cam { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius-md, 8px); background: var(--well); display: block; }
  .cam-empty { width: 100%; height: 56px; border-radius: var(--radius-md, 8px); background: var(--well); display: grid; place-items: center; color: var(--fg-muted); font-size: 12px; }
  /* ── Round 4 (v3 deck): chips, chip pages, scenes, settings, problems ── */
  .chips { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  .chip { appearance: none; font: inherit; color: inherit; text-align: left; display: flex; align-items: flex-start; gap: 10px; padding: 12px; border-radius: var(--radius-lg, 12px); border: 1px solid var(--edge-dim); background: var(--panel); cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease, transform 90ms ease; }
  .chip:hover { border-color: var(--edge); }
  .chip:active { transform: scale(.98); }
  .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chip.sel { border-color: var(--accent); }
  .chip { position: relative; overflow: hidden; min-height: 74px; }
  .chip > * { position: relative; }
  .chip-ic { width: 32px; height: 32px; flex-shrink: 0; border-radius: 10px; display: grid; place-items: center; background: var(--well); color: var(--fg-muted); }
  .pulse { position: absolute; top: 14px; right: 14px; width: 8px; height: 8px; border-radius: 50%; background: rgb(235, 70, 55); }
  .pulse::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; border: 2px solid rgb(235, 70, 55); opacity: 0; animation: pulse 1.6s steps(8, end) infinite; }
  @keyframes pulse { 0% { transform: scale(.4); opacity: .9; } 100% { transform: scale(1.3); opacity: 0; } }
  /* Pills: one quiet row; a pill takes its state's colour when lit. */
  .pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill { appearance: none; font: inherit; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px 0 6px; border-radius: 9999px; border: 1px solid var(--edge-dim); background: var(--panel); color: var(--fg); cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease, transform 90ms ease; }
  .pill:hover { border-color: var(--edge); }
  .pill:active { transform: scale(.97); }
  /* The open tab is unmistakable: filled with the text colour. */
  .pill.sel, .pill.lit.sel { background: var(--fg); border-color: var(--fg); color: var(--panel); font-weight: 700; }
  .pill.sel .pill-ic { background: var(--panel); color: var(--fg); }
  .pill.sel.lit .pill-ic { background: var(--k); color: #111; }
  .pill.sel .eq i { background: var(--panel); }
  .pill-ic { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--well); color: var(--fg-muted); }
  .pill-ic svg { width: 14px; height: 14px; }
  /* Status colour lives only in the round icon; the pill itself stays
     plain, so the one filled pill is always the open tab (round 4 note:
     "hard to tell selected state from the regular status colors"). */
  .pill.lit .pill-ic { background: var(--k); color: #111; }
  .pill .eq { margin-left: 2px; }
  /* Sentence: the house in one line; each part opens its page. */
  .glance { font-size: 19px; line-height: 1.5; color: var(--fg-2); margin: 0; }
  .glance .part { appearance: none; font: inherit; color: inherit; background: none; border: 0; padding: 0 2px; cursor: pointer; border-radius: 6px; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--k) 45%, transparent); text-decoration-thickness: 2px; text-underline-offset: 5px; }
  .glance .part b { color: var(--k); font-weight: 600; }
  .glance .part:hover { background: var(--inset); }
  .glance .part.sel { background: var(--inset); }
  .glance .sep { color: var(--fg-muted); }
  /* Tiles: big squares, the number first, a colour blob in the corner. */
  .tiles2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile2 { appearance: none; font: inherit; color: inherit; text-align: left; position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; min-height: 132px; padding: 14px; border-radius: var(--radius-lg, 12px); border: 1px solid var(--edge-dim); background: var(--panel); cursor: pointer; transition: border-color 120ms ease, transform 90ms ease; }
  .tile2 > * { position: relative; }
  .tile2:hover { border-color: var(--edge); } .tile2:active { transform: scale(.98); } .tile2.sel { border-color: var(--fg-muted); }
  .tile2 .t2-blob { position: absolute; top: -50px; right: -50px; width: 160px; height: 160px; border-radius: 50%; background: radial-gradient(circle, var(--k, transparent), transparent 70%); opacity: 0; }
  .tile2.lit .t2-blob { opacity: .5; }
  .t2-ic { position: absolute; top: 14px; left: 14px; color: var(--fg-muted); }
  .t2-ic svg { width: 22px; height: 22px; }
  .tile2.lit .t2-ic { color: var(--k); }
  .tile2 .eq { position: absolute; top: 18px; right: 16px; }
  .tile2 .pulse { position: absolute; top: 18px; right: 18px; }
  .t2-big { font-family: var(--font-mono); font-size: 34px; line-height: 1; color: var(--fg); }
  .t2-lbl { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); margin-top: 6px; }
  .t2-sub { font-size: 12px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (prefers-reduced-motion: reduce) { .pulse::after { animation: none; } .pill, .tile2 { transition: none; } }
  .chip-txt { display: flex; flex-direction: column; min-width: 0; }
  .chip-lbl { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); }
  .chip-main { font-size: 14px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip-sub { font-size: 11px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A chip's page: its parts spaced like the main page's. */
  #view:not(:empty) { display: flex; flex-direction: column; gap: 14px; }
  .vhead { display: flex; align-items: center; gap: 12px; padding: 4px 0; }
  .vback { width: 38px; height: 38px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--edge); background: var(--panel); color: var(--fg); cursor: pointer; display: grid; place-items: center; padding: 0; transition: border-color 120ms ease, transform 90ms ease; }
  .vback:hover { border-color: var(--fg-muted); } .vback:active { transform: scale(.94); }
  .vback:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .vicon2 { width: 38px; height: 38px; flex-shrink: 0; border-radius: 12px; display: grid; place-items: center; background: var(--inset); color: var(--fg-2); }
  .vtitle { display: flex; flex-direction: column; min-width: 0; }
  .vtitle h2 { font-size: 22px; font-weight: 600; line-height: 1.15; }
  .vsub { font-size: 12px; color: var(--fg-muted); }
  /* Climate page: the thermostat large, the weather beside it. */
  .clim-hero-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; align-items: stretch; }
  @media (max-width: 760px) { .clim-hero-row { grid-template-columns: 1fr; } }
  .clim-hero-row .wx { flex-direction: column; align-items: flex-start; justify-content: space-between; }
  .clim-hero-row .wx-facts div { align-items: flex-start; }
  .th-hero { position: relative; overflow: hidden; display: flex; align-items: center; gap: 28px; flex-wrap: wrap; padding: 20px 24px; border-radius: var(--radius-lg, 12px); border: 1px solid var(--edge-dim); background: var(--inset); }
  /* .clim gives the mode colours; its column layout is not wanted here. */
  .th-hero.clim { flex-direction: row; flex-wrap: wrap; gap: 28px; padding: 20px 24px; }
  .th-hero .glow { opacity: .22; }
  .th-dial { position: relative; width: 210px; height: 210px; flex-shrink: 0; }
  .th-dial svg { width: 100%; height: 100%; }
  .th-track, .th-fill { fill: none; stroke-width: 14; stroke-linecap: round; }
  .th-track { stroke: var(--well); }
  .th-fill { stroke: var(--m); transition: stroke-dasharray 300ms ease; }
  .th-now { fill: var(--fg); stroke: var(--inset); stroke-width: 4; }
  .th-mid { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .th-lbl { font-size: 12px; color: var(--fg-2); }
  .th-set { font-family: var(--font-mono); font-size: 54px; line-height: 1.05; color: var(--fg); }
  .th-cur { font-size: 12px; color: var(--fg-muted); }
  .th-side { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 16px; position: relative; }
  .th-name { font-size: 18px; font-weight: 600; }
  .th-steps { display: flex; gap: 12px; }
  .th-step { width: 58px; height: 58px; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg); font-size: 26px; line-height: 1; cursor: pointer; display: grid; place-items: center; padding: 0; transition: border-color 120ms ease, transform 90ms ease; }
  .th-step:hover { border-color: var(--m); } .th-step:active { transform: scale(.94); } .th-step:disabled { opacity: .4; cursor: default; }
  .th-modes { display: flex; padding: 3px; gap: 3px; border-radius: 9999px; background: var(--well); width: fit-content; flex-wrap: wrap; }
  .th-mode { appearance: none; font: inherit; font-size: 12px; padding: 7px 14px; border-radius: 9999px; border: 0; background: transparent; color: var(--fg-2); cursor: pointer; }
  .th-mode[aria-pressed="true"] { background: var(--m); color: #111; }
  .th-hero.gone { opacity: .7; }
  @media (prefers-reduced-motion: reduce) { .th-fill, .th-step { transition: none; } }
  /* The weather: a wide card painted like the sky outside. Its colours are
     always deep enough for white text. */
  .wx { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding: 22px 26px; border-radius: var(--radius-lg, 12px); color: #fff; background: linear-gradient(120deg, var(--s1), var(--s2)); }
  .wx::after { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 85% -20%, rgba(255, 255, 255, .22), transparent 55%); pointer-events: none; }
  .wx-main { display: flex; align-items: center; gap: 18px; position: relative; }
  .wx-ic { opacity: .9; display: grid; }
  .wx-temp { font-family: var(--font-mono); font-size: 52px; line-height: 1; font-weight: 500; }
  .wx-cond { font-size: 15px; opacity: .9; margin-top: 4px; }
  .wx-cond::first-letter { text-transform: uppercase; }
  .wx-facts { display: flex; gap: 24px; position: relative; }
  .wx-facts div { display: flex; flex-direction: column; align-items: flex-end; }
  .wx-facts span { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; opacity: .75; }
  .wx-facts b { font-family: var(--font-mono); font-size: 22px; font-weight: 500; }
  /* Problems: cards in a grid that fills the page, the kind of problem as a
     coloured icon. */
  .probs { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; align-items: stretch; }
  .prob { display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: var(--radius-lg, 12px); border: 1px solid var(--edge-dim); background: var(--panel); }
  .prob-top { display: flex; align-items: center; gap: 10px; }
  .prob-ic { width: 30px; height: 30px; flex-shrink: 0; border-radius: 9px; display: grid; place-items: center; background: var(--well); color: var(--fg-muted); }
  .prob.high .prob-ic { background: rgb(235, 70, 55); color: #fff; }
  .prob.mid .prob-ic { background: rgb(240, 165, 40); color: #1a1a1a; }
  .prob-title { font-weight: 600; line-height: 1.3; }
  .prob-detail { font-size: 12px; color: var(--fg-2); line-height: 1.45; flex: 1; }
  .prob-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .prob-acts a { text-decoration: none; }
  .scenes { position: relative; margin: 0 8px 8px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--well); overflow: hidden; }
  .sc-head { appearance: none; font: inherit; font-size: 12px; color: var(--fg-2); width: 100%; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 0; background: transparent; cursor: pointer; }
  .sc-head:hover { color: var(--fg); }
  .sc-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .sc-lbl { flex: 0 0 auto; }
  .sc-n { color: var(--fg-muted); }
  .sc-last { flex: 1; text-align: right; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .scenes.open .rchev { transform: rotate(180deg); }
  .scenes:not(.open) .sc-lbl { flex: 0 0 auto; }
  .scenes.open .sc-head .rchev { margin-left: auto; }
  .sc-list { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 10px 10px; }
  .scene { appearance: none; font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--inset); color: var(--fg); cursor: pointer; transition: border-color 120ms ease, transform 90ms ease; }
  .scene:hover { border-color: var(--accent); }
  .scene:active { transform: scale(.95); }
  .scene.last { border-color: var(--accent); background: var(--panel); }
  /* Settings: a page of sections, side by side when there is room. */
  .set-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; align-items: start; }
  .set-sec { display: flex; flex-direction: column; gap: 2px; }
  .set-sec h3 { font-size: 15px; font-weight: 600; }
  .set-sec .yc-caption { margin-bottom: 8px; }
  .set-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 13px; }
  .tog { width: 38px; height: 22px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--well); padding: 2px; cursor: pointer; position: relative; flex-shrink: 0; transition: background-color 120ms ease; }
  .tog span { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--fg-muted); transition: transform 120ms ease, background-color 120ms ease; }
  .tog[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .tog[aria-checked="true"] span { transform: translateX(16px); background: var(--on-accent); }
  .tog:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cam-empty.note { height: auto; padding: 12px; text-align: center; line-height: 1.4; }
  .cam-empty.note a { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .chip, .scene, .tog, .tog span { transition: none; } }

  /* ── Round 5: the TV remote ────────────────────────────────────────── */
  .play { display: flex; align-items: center; justify-content: center; gap: 10px; position: relative; }
  .play .key { width: 36px; height: 36px; }
  .play .key.main { width: 44px; height: 44px; background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .tile .name .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mhead { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; position: relative; }
  .mhead .kind { display: flex; align-items: center; gap: 5px; }
  .mhead .kind svg { width: 12px; height: 12px; flex-shrink: 0; }
  .mname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mhead .sub { font-size: 11px; color: var(--fg-muted); }
  .pwr.mute[aria-pressed="true"] { background: var(--fg); border-color: var(--fg); color: var(--panel); }
  .tile.muted .vlr { opacity: .5; }
  .lights > .tile.all > .lr { margin-top: 2px; }
  .kind { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); }
  /* Round 6 (S-kinds notes): a TV has an obvious power button on the right
     of its header; tapping the TV itself opens its remote. */
  .pwr { width: 36px; height: 36px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-muted); cursor: pointer; display: grid; place-items: center; padding: 0; position: relative; }
  .pwr:hover { color: var(--fg); border-color: var(--fg-muted); }
  .pwr[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .pwr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* The remote button says what it is (fourth-look notes: the icon alone
     and its outlined open state did not read). Open, it is filled. */
  .rbtn { height: 36px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); font: inherit; font-size: 12px; cursor: pointer; position: relative; }
  .rbtn:hover { color: var(--fg); border-color: var(--fg-muted); }
  .rbtn[aria-expanded="true"] { background: var(--panel); color: var(--fg); }
  .rchev { display: grid; transition: transform 150ms ease; }
  .rbtn[aria-expanded="true"] .rchev { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .rchev { transition: none; } }
  .rbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* Controls inside Now playing (fourth-look notes: "the play/pause button
     and some other basic controls should be attached to the now playing"). */
  .np.has-ctl { flex-wrap: wrap; }
  .np-ctl { flex-direction: column; gap: 10px; }
  .np-keys { display: flex; align-items: center; justify-content: center; gap: 10px; }
  .vrow { display: flex; align-items: center; gap: 8px; width: 100%; position: relative; }
  .vrow.keys-only { justify-content: center; }
  .vlbl { font-size: 11px; color: var(--fg-muted); min-width: 64px; text-align: center; }
  .vbtn { width: 26px; height: 26px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; }
  .vbtn:hover { color: var(--fg); border-color: var(--fg-muted); }
  .vbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* Sixth-look notes: a slightly bigger bar, smaller − and +, and a
     see-through speaker on the bar's left that shows how loud it is. */
  .vwrap { position: relative; flex: 1; display: flex; align-items: center; }
  /* Seventh-look notes: "i wanted volume bar to be taller". \`.lr.vlr\`
     outranks the shared \`.tile .lr\` height further down, which had kept
     the bar at its old height. */
  .tile .lr.vlr { height: 30px; flex: 1; border-radius: 10px; }
  .tile .lr.vlr { --tw: 16px; }
  .tile .lr.vlr::-webkit-slider-thumb { width: 16px; height: 30px; border-radius: 10px; background-size: 3px 40%; }
  .vicon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); display: grid; color: var(--on-accent); opacity: .75; pointer-events: none; mix-blend-mode: normal; }
  .vicon.low { color: var(--fg); opacity: .55; }
  /* Playing: three bars that bounce beside Now playing, still when paused.
     steps() keeps the animation cheap (performance rule 6). */
  .eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 9px; margin-left: 6px; vertical-align: -1px; }
  .eq i { width: 2px; height: 3px; border-radius: 1px; background: var(--accent); }
  .eq.on i { animation: eq 0.9s steps(6, end) infinite; }
  .eq.on i:nth-child(2) { animation-delay: -0.3s; }
  .eq.on i:nth-child(3) { animation-delay: -0.6s; }
  @keyframes eq { 0% { height: 3px; } 50% { height: 9px; } 100% { height: 3px; } }
  @media (prefers-reduced-motion: reduce) { .eq.on i { animation: none; height: 6px; } }
  /* The remote: one card. Its header is the button; open, the remote sits
     inside the same card. */
  .rcard { position: relative; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--well); overflow: hidden; }
  .rcard.open { background: var(--panel); }
  .rcard .rbtn { width: 100%; height: 40px; border: 0; border-radius: 0; background: transparent; justify-content: flex-start; padding: 0 12px; }
  .rcard .rlbl { flex: 1; text-align: left; }
  .rcard .remote { border: 0; border-radius: 0; background: transparent; padding-top: 4px; }
  /* Interactions (round 7: "better hover/touch/drag"): every control eases
     between states and gives a small press, sliders show a handle on hover
     and while held, and touch targets stay at least 30px. */
  .tile-face, .key, .pwr, .vbtn, .nk .ic, .app, .rbtn, .fold, .cbtn, .sw, .mode, .step, .ib, .dpad button, .volpill button {
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 90ms ease, box-shadow 120ms ease;
  }
  .key:active, .pwr:active, .vbtn:active, .nk:active .ic, .app:active, .fold:active, .cbtn:active, .sw:active, .mode:active, .step:active, .ib:active { transform: scale(.94); }
  .tile:has(> .line > .tile-face:active) { transform: scale(.99); }
  .tile { transition: transform 90ms ease; }
  .lr { touch-action: pan-y; }
  @media (prefers-reduced-motion: reduce) {
    .tile, .tile-face, .key, .pwr, .vbtn, .nk .ic, .app, .rbtn, .fold, .cbtn, .sw, .mode, .step, .ib, .dpad button { transition: none; }
    .key:active, .pwr:active, .vbtn:active, .nk:active .ic, .app:active, .fold:active, .cbtn:active, .sw:active, .mode:active, .step:active, .ib:active, .tile:has(> .line > .tile-face:active) { transform: none; }
  }
  .np-ctl { flex-basis: 100%; display: flex; align-items: center; justify-content: center; gap: 10px; padding-top: 6px; }
  .np-ctl .key { width: 34px; height: 34px; }
  .np-ctl .key.main { width: 42px; height: 42px; background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  /* Now playing: what is on, in a block of its own, with the app's mark.
     (.np, not .now: the thermostat's scale already has a .now marker.) */
  .np { position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-md, 8px); background: var(--panel); border: 1px solid var(--edge-dim); }
  .np .art { width: 36px; height: 36px; border-radius: 9px; flex-shrink: 0; display: grid; place-items: center; background: var(--app, var(--accent)); color: #fff; font-weight: 800; font-size: 13px; }
  .np .txt { min-width: 0; flex: 1; }
  .np .lbl { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted); }
  .np .ttl { font-size: 13px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .np .by { font-size: 11px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* The remote (S-kinds notes: "improve the youtube/netflix/prime/disney
     buttons. and the polish of our remote ui"). */
  .remote { position: relative; display: flex; flex-direction: column; align-items: stretch; gap: 16px; padding: 14px 12px; border-radius: var(--radius-md, 8px); background: var(--panel); border: 1px solid var(--edge-dim); }
  .apps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .app { appearance: none; font: inherit; font-size: 11px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 6px 2px; border-radius: var(--radius-md, 8px); border: 0; background: transparent; color: var(--fg-2); cursor: pointer; min-width: 0; }
  .app:hover { background: var(--well); color: var(--fg); }
  .app:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .app .logo { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--app); color: #fff; font-weight: 800; font-size: 15px; letter-spacing: -.02em; }
  .app .nm { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dpad { position: relative; align-self: center; width: 156px; height: 156px; border-radius: 50%; background: var(--well); border: 1px solid var(--edge-dim); flex-shrink: 0; }
  .dpad button { position: absolute; appearance: none; border: 0; background: transparent; color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; border-radius: 50%; }
  .dpad button:hover { color: var(--fg); background: var(--inset); }
  .dpad button:active { background: var(--edge-dim); }
  .dpad button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .dpad .up, .dpad .down { left: 56px; width: 44px; height: 44px; }
  .dpad .up { top: 4px; } .dpad .down { bottom: 4px; }
  .dpad .left, .dpad .right { top: 56px; width: 44px; height: 44px; }
  .dpad .left { left: 4px; } .dpad .right { right: 4px; }
  .dpad .ok { left: 48px; top: 48px; width: 60px; height: 60px; background: var(--inset); border: 1px solid var(--edge); color: var(--fg); font-size: 13px; font-weight: 700; }
  .dpad .ok:hover { border-color: var(--accent); }
  .nav { display: flex; justify-content: center; gap: 22px; }
  .nk { appearance: none; font: inherit; font-size: 10px; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--fg-muted); cursor: pointer; }
  .nk .ic { width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); display: grid; place-items: center; }
  .nk:hover .ic { color: var(--fg); border-color: var(--fg-muted); }
  .nk:active .ic { background: var(--edge-dim); }
  .nk:focus-visible .ic { outline: 2px solid var(--accent); outline-offset: 2px; }
  .volpill { align-self: center; display: flex; border: 1px solid var(--edge); border-radius: 9999px; overflow: hidden; background: var(--well); }
  .volpill button { appearance: none; width: 56px; height: 36px; border: 0; background: transparent; color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; }
  .volpill button + button { border-left: 1px solid var(--edge-dim); }
  .volpill button:hover { background: var(--inset); color: var(--fg); }
  .volpill button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .key { width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; }
  .key:hover { color: var(--fg); border-color: var(--fg-muted); }
  .key:active { background: var(--edge-dim); }
  .key:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ── Round 4: folding lights, Edit mode, Everything off ─────────────── */
  .toprow { display: flex; align-items: center; gap: 12px; }
  .toprow > #chips { flex: 1; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .confirm { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-radius: 9999px; border: 1px solid var(--edge); background: var(--inset); font-size: 13px; }
  /* A room's lights: one card whose header IS the All row, with each light
     as a card inside it, evenly inset on every side (round 4 reviews, S-fold
     then S-nest: "all of the cards just need to be sub-containers of the
     grouped/expandable card. centered properly" — no indent, no guide line). */
  .lights { position: relative; overflow: hidden; display: flex; flex-direction: column; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  /* One surface: the glow tints the whole card, not just the header, so
     nothing draws a hard edge between the All row and the lights below it
     (S-inside: "harsh line separating the top part"). The header is inset
     like the cards under it, so its bulb lines up with theirs. */
  .lights > .glow { position: absolute; inset: 0; background: var(--c); opacity: 0; pointer-events: none; transition: opacity 200ms ease; }
  .lights.on > .glow { opacity: .10; }
  .lights > .tile.all { border: 0; border-radius: 0; background: transparent; padding: 10px 20px 8px; }
  .lights > .tile.all .glow { display: none; }
  .lights-body { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; }
  @media (prefers-reduced-motion: reduce) { .lights > .glow { transition: none; } }
  .lights-body > .tile { background: var(--well); }
  .tile.all .line { gap: 8px; }
  .bulb-col { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
  .all-lbl { font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-muted); line-height: 1; }
  .tile.all.on .all-lbl { color: var(--fg); }
  .fold { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg-2); cursor: pointer; display: grid; place-items: center; padding: 0; position: relative; }
  .fold:hover { color: var(--fg); border-color: var(--fg-muted); }
  .fold:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .fold svg { transition: transform 150ms ease; }
  .fold[aria-expanded="true"] svg { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .fold svg { transition: none; } }
  /* Edit mode: each thing gets one row of small controls under it. */
  .edit-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; position: relative; padding-top: 6px; border-top: 1px dashed var(--edge-dim); }
  .ib { width: 30px; height: 30px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--well); color: var(--fg-2); cursor: pointer; display: inline-grid; place-items: center; padding: 0; text-decoration: none; flex-shrink: 0; }
  .ib:hover:not(:disabled) { color: var(--fg); border-color: var(--edge); }
  .ib:disabled { opacity: .35; cursor: default; }
  .ib[aria-pressed="true"] { color: rgb(240, 180, 40); border-color: rgb(240, 180, 40); }
  .ib:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .edit-row .yc-select { height: 30px; flex: 1; min-width: 110px; font-size: 12px; }
  .edit-row .yc-input { height: 30px; flex: 1; min-width: 120px; font-size: 13px; }
  .edit-row .grow { flex: 1; }
  .room-head .ib { width: 28px; height: 28px; }
  .tile.is-hidden, .clim.is-hidden, .thing.is-hidden { opacity: .5; }
  .fav-head { display: flex; align-items: center; gap: 6px; }
  /* Favourites sit side by side, the same width as a room's tiles. */
  .fav-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; align-items: start; }
  .fav-head svg { color: rgb(240, 180, 40); }
  .banner { padding: 10px 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge); background: var(--well); font-size: 13px; }
  @media (prefers-reduced-motion: reduce) { .tile .glow, .sw { transition: none; } }

  /* ── Light controls, shared ─────────────────────────────────────────── */
  /* A range painted as a filled bar: --v (0–100) is how far along it is, --c
     the colour. The fill ends exactly where the browser puts the handle —
     the handle travels from 0 to (width − handle width), so the fill is
     handle width + that share of the rest (eighth-look testing: "the slider
     fill seems to separate from the drag handle"). Updated live while
     dragging, without redrawing the page. */
  .lr { appearance: none; -webkit-appearance: none; width: 100%; margin: 0; cursor: pointer; background: linear-gradient(to right, var(--c, var(--accent)) calc(var(--tw, 14px) + (100% - var(--tw, 14px)) * var(--v, 0) / 100), var(--well) 0); border-radius: 9999px; }
  .lr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .lr::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; }
  .palette { position: relative; display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
  .sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--edge); padding: 0; cursor: pointer; background: var(--sw); }
  .sw:hover { transform: scale(1.08); }
  .sw[aria-pressed="true"] { outline: 2px solid var(--fg); outline-offset: 2px; }
  .sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pct { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); }
  /* ── Tiles: the tile is the button ─────────────────────────────────── */
  .tile { position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .tile .line { display: flex; align-items: center; gap: 10px; position: relative; }
  .tile .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile-face { flex: 1; min-width: 0; appearance: none; font: inherit; color: inherit; text-align: left; background: none; border: 0; padding: 0; display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .tile .glow { position: absolute; inset: 0; background: var(--c); opacity: 0; pointer-events: none; transition: opacity 200ms ease; }
  .tile.on .glow { opacity: .16; }
  .tile .bulb { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--well); color: var(--fg-muted); flex-shrink: 0; position: relative; }
  .tile.on .bulb { background: var(--c); color: #1a1a1a; box-shadow: 0 0 14px var(--c); }
  .tile .lr { height: 14px; position: relative; }
  /* The handle is a grip line inside the end of the fill, always shown, so
     nothing pops in on hover (eighth-look testing). */
  .tile .lr { --tw: 14px; }
  .tile .lr::-webkit-slider-thumb { width: 14px; height: 14px; border-radius: 9999px; background: linear-gradient(rgba(0, 0, 0, .3), rgba(0, 0, 0, .3)) center / 3px 55% no-repeat; cursor: grab; }
  .tile .lr:active::-webkit-slider-thumb { cursor: grabbing; }

  .tile.media .bulb { border-radius: var(--radius-md, 8px); }
  .tile.media.on .bulb { background: var(--accent); color: var(--on-accent); box-shadow: none; }
  .tile .vol { display: flex; align-items: center; gap: 8px; position: relative; }
  .tile .vol svg { flex-shrink: 0; color: var(--fg-muted); }

  /* The colour button: a dot of the light's current colour, ringed, on the
     tile itself — what it does is what it shows. */
  .cbtn { width: 26px; height: 26px; flex-shrink: 0; border-radius: 50%; padding: 0; cursor: pointer; position: relative; background: var(--c); border: 2px solid var(--panel); box-shadow: 0 0 0 1px var(--edge); }
  .cbtn[aria-expanded="true"] { box-shadow: 0 0 0 2px var(--fg); }
  .cbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  /* Colour selection: whites and colours as two labelled rows, the chosen
     one ticked, and a rainbow swatch for any colour at all. */
  .palette { flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--radius-md, 8px); background: var(--panel); border: 1px solid var(--edge-dim); }
  .pal-row { display: grid; grid-template-columns: 56px 1fr; align-items: center; gap: 8px; }
  .pal-sw { display: flex; flex-wrap: wrap; gap: 8px; }
  .pal-lbl { width: 56px; flex-shrink: 0; font-size: 11px; color: var(--fg-muted); }
  .sw { width: 28px; height: 28px; position: relative; }
  .sw[aria-pressed="true"]::after { content: ''; position: absolute; left: 8px; top: 4px; width: 7px; height: 12px; border: solid #111; border-width: 0 2.5px 2.5px 0; transform: rotate(45deg); filter: drop-shadow(0 0 1px #fff); }
  .sw-any { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--edge); cursor: pointer; background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); position: relative; overflow: hidden; }
  .sw-any input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .room-acts { display: flex; gap: 6px; }

  /* Thermostat (round 2: "improve the ac/thermostat card visually"): a tile
     tinted by what it is set to do — blue cooling, orange heating — with the
     room's temperature large, the setting between two big round buttons, a
     scale showing both, and the modes as one row of pills. */
  .clim { --m: var(--fg-muted); position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 12px; padding: 12px; border-radius: var(--radius-md, 8px); border: 1px solid var(--edge-dim); background: var(--inset); }
  .clim.cool { --m: rgb(60, 150, 255); } .clim.heat { --m: rgb(255, 130, 40); } .clim.auto, .clim.heat_cool { --m: rgb(140, 120, 255); } .clim.dry, .clim.fan_only { --m: rgb(60, 190, 170); }
  .clim .glow { position: absolute; inset: 0; background: radial-gradient(circle at 20% 0%, var(--m), transparent 70%); opacity: .18; pointer-events: none; }
  .clim.off .glow { opacity: 0; }
  .clim-top { display: flex; align-items: flex-end; gap: 12px; position: relative; }
  .clim-now .temp { font-size: 40px; }
  .clim-doing { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-2); }
  .clim-doing::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--m); }
  .clim-set { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .clim-set .val { text-align: center; min-width: 54px; }
  .clim .sub { font-size: 11px; color: var(--fg-muted); }
  .clim-set .val b { display: block; font-family: var(--font-mono); font-size: 22px; font-weight: 500; color: var(--fg); }
  .step { width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--edge); background: var(--well); color: var(--fg); font-size: 18px; line-height: 1; cursor: pointer; display: grid; place-items: center; padding: 0; }
  .step:hover { border-color: var(--m); }
  .step:disabled { opacity: .4; cursor: default; }
  .scale { position: relative; height: 6px; border-radius: 9999px; background: var(--well); }
  .scale .fill { position: absolute; top: 0; bottom: 0; border-radius: 9999px; background: var(--m); opacity: .55; }
  .scale .mk { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; }
  .scale .mk.now { background: var(--fg); border: 2px solid var(--panel); }
  .scale .mk.set { background: var(--m); border: 2px solid var(--panel); box-shadow: 0 0 0 1px var(--m); }
  .scale-lbl { display: flex; justify-content: space-between; font-size: 10px; color: var(--fg-muted); margin-top: -6px; }
  .modes { display: flex; gap: 6px; flex-wrap: wrap; position: relative; }
  .mode { appearance: none; font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 9999px; border: 1px solid var(--edge); background: transparent; color: var(--fg-2); cursor: pointer; }
  .mode[aria-pressed="true"] { background: var(--m); border-color: var(--m); color: #111; }
`;
