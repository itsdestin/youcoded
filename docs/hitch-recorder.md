# Hitch recorder

An always-on, private, local record of the app's stutters, stalls and memory. Built 2026-10-05
(perf gap review M1-M3). Code: `desktop/src/main/hitch-recorder.ts` (main half, privacy header),
`hitch-validate.ts` (what a window may send), `hitch-log-writer.ts` (rotating async writer), and
`installHitchRecorder` inside `desktop/src/main/preload.ts` (window half; inline because the sandboxed
preload cannot import). Tests: `desktop/tests/hitch-*.test.ts`. Reader: `scripts/perf-lab/hitch-report.mjs`
in the workspace repo.

**File:** `<userData>/perf/hitches.jsonl`, rolling over at 5 MiB to `hitches.1.jsonl` (two files, ~10 MiB at most).
Per profile (dev instances have their own), mode 0600 in a 0700 folder, never synced, never in `~/.claude`, **never
attached to a bug report** (owner decision pending). **Off switch:** `YOUCODED_HITCH_LOG=0` (no file, no timers, no
observers). No UI.

**Format.** One JSON object per line. Every line: `ts` (ISO), `v` (app version), `launch` (random per launch),
`kind`, and `win` (`w1`, `w2` ... per launch) when it came from a window.

| kind | fields |
|---|---|
| `frame` | `d` ms the page was frozen (>= 100), `b` blocking ms, `sl` style+layout ms, `rd` render ms, `inp` a keypress/click was waiting, `sc` top 3 scripts `{it invokerType, iv invoker (ids stripped), fn function, src bundle file BASENAME, pos char position, d ms, fl forced-layout ms}`, `ctx`, `sessions`, `windows`, `src` (`loaf` or `longtask`) |
| `event` | `type` (keydown/pointerdown/pointerup/click/input), `d`, `delay` input delay, `proc` handler ms, `pres` wait-to-draw ms, `tgt` coarse kind (`terminal`/`text-input`/`chat`/`other`), `ctx`, `sessions` |
| `task` | `d` only (fallback when `long-animation-frame` is unsupported) |
| `main-stall` | `ms` estimated time the main process did not answer (>= 100, accurate to about +/- `resMs`/2), `resMs` sampler interval, `lastIpc` + `lastIpcAgoMs` (last request main started: a hint, only meaningful when `lastIpcAgoMs` is not much larger than `ms`), `sessions`, `windows` |
| `minute` | `loop` {p50,p99,max ms of event-loop delay, `res` sampler interval}, `procs` {browser, gpu, utility, other: {n, ws MB, cpu %}; renderer: [{ws, cpu}] top 12}, `main` {rss, heapUsed, heapTotal, external, arrayBuffers MB}, `windows`, `sessions`, `rend` {frames, framesMs (50-100 ms frames), over (detail entries not written), dropped, rejected, entries}, `stalls`, `lost` |
| `switch` | one per session switch in a window (see "Switch marks" below): `cause`, `vm`, `dk`, `str`, `cold`, `open`, `ff`, `st`, `end`, `interrupted`, `e1`, `e2`, `mut`, `ls`, `lsv`, `loaf`, `loafMs`, `ind`, `gap`, `drain`, `src` |
| `startup` | `packaged` (boolean only: true = installed build, false = developer build; absent in files from before 2026-10-07), `main` {mark: ms since process start}, `loadedMs` (first window loaded), `renderer` {marks: yc:* ms, fcp} or null |

`ctx` (only on a hitch, no layout reads): `vis`, `foc`, `vm` view mode, `dlg` a `[role=dialog]` exists, `scr` a full screen is
open, `dpr`, `els` DOM element count (cached 10 s). (`[data-screen]` dialog names exist only in screenshot builds, so a dialog's
name is not available in a normal build.)

**Never recorded:** message text, prompts, file names or paths, keys typed, element text/ids/classes, session names (only the
COUNT), URLs, tokens. Every string is an allow-list enforced in main (`hitch-validate.ts`), not just a length cap:
`it` one of 6 invoker types; `iv` empty for script starts, `url` for anything path-like, `TAG.onevent` for element
listeners (ids and classes dropped), a short letters-only API name (`Window.requestAnimationFrame`), else `other`; `fn` `^[A-Za-z_$][\w$.]{0,59}$` else
dropped; `src` `^[\w.-]{1,60}\.(js|mjs)$`, `inline`, or `other`; event type, target, mode, window kind, visibility: fixed lists;
`vm` `^[a-z][a-z0-9-]{0,19}$`; marks `yc:*`; IPC channels `^[A-Za-z0-9_:.*-]{1,60}$` else `?`. Only scripts under the window's
own app directory are named (anything else is `other`, no function name). User HTML (HtmlView/Pages: sandboxed `srcDoc`,
opaque origin) and Office (sealed `office://<token>` origin) are cross-origin, so their scripts are not reported to this window.
A suspend/resume (OS power events, or a gap/stall over a minute) is discarded, never recorded as a stall.

## Switch marks (2026-10-05)

A `switch` line for every change of the active session in a desktop window, measured in the real app. Built so session switching
is judged from what people actually do (any session, any rhythm, rapid flips, late content), not from the lab's once-a-second,
wait-until-quiet loop. Page half: `desktop/src/renderer/state/switch-marks.ts` (tells the recorder; `App.tsx` one layout effect
on the active session, `SessionStrip.tsx` names the cause, `TerminalView.tsx` reports a terminal show). Window half: the
"Switch marks" block inside `installHitchRecorder` (`preload.ts`). Main half: `hitch-validate.ts` (`batch.sw`) +
`hitch-recorder.ts`. No new channel (rides `perf:hitch-batch`) and nothing added to `window.claude`: the page dispatches a DOM
event (`yc:switch`, `yc:switch-term`, `yc:switch-none`) whose detail is a JSON string; the sandboxed preload shares the DOM.

| field | meaning | validation on main |
|---|---|---|
| `ts` | when the user's input happened (the input event's own timestamp; else when the page noticed) | clamped to [-15 min, +1 min] of receipt |
| `cause` | `pill` (tab press/click), `menu` (All Sessions row), `key` (Shift-hold nav, at its release), `drawer` (reserved, nothing emits it yet), `auto` (no input of its own: a session was created/closed/adopted), `other` (the buddy window's "open main app") | enum, else `other` |
| `vm` | view shown: `chat` or `terminal` | enum, else the line is rejected |
| `dk` | destination kind `claude` / `native` / `shell` | enum, else rejected |
| `str` | the destination was streaming a reply at the moment of the switch | boolean |
| `cold` | first visit to that session in this window's lifetime (a revisit is warm) | boolean |
| `open` | sessions open in the window | int 0..10000 |
| `ff` | ms from input to FIRST FRAME (null if interrupted/closed before one) | int 0..120000 or null |
| `st` | ms from input until SETTLED; null unless `end` is `settled`; never below `ff` | int or null |
| `end` | how the record closed: `settled`, `streaming` (never held still and the destination was streaming), `cap` (3 s, still changing), `interrupted` (another switch started), `hidden` (page hidden mid-switch), `closed` (no session left) | enum, else rejected |
| `interrupted` | `end == "interrupted"`, derived on main | derived |
| `e1`, `e2` | message rows in the new pane at first frame / at the end (chat view only; the children of the timeline, not a deep walk) | int or null |
| `mut` | DOM changes seen in the pane until the end | int |
| `ls`, `lsv` | layout shifts of something inside the new pane (chat view; includes ones the browser blames on the click, since the switch is the cause) and their summed score, until the end; terminal view counts every shift in the page. The session strip's pills resize for ~200 ms after every switch (~14 tiny shifts, measured), which is why chat view only counts shifts inside the pane | int; number 0..1000 rounded to 3 places |
| `loaf`, `loafMs` | long animation frames overlapping start..end, and their summed ms (the recorder's own observer; browser-queued entries are taken at close so the last ones count) | ints |
| `ind` | worst input delay among SLOW interactions (>= 104 ms) that started in the window | int or null |
| `gap` | ms since the previous switch's start (capped at 1 h; null for the first) | int or null |
| `drain` | terminal view only: characters the hidden terminal's backlog held when it was shown | int or null |

**Definitions and blind spots.** START is the input event itself (pointerdown on a pill, click on a row, the key release of the
Shift-hold switcher). FIRST FRAME is the first task after the animation frame that followed React's commit of the new pane
(a page cannot learn when a frame was presented on screen; this is about when it was produced). SETTLED, chat view: 150 ms with
no childList/subtree/characterData change in the new pane and no layout shift inside it, reported as the moment of the LAST change (never
before the first frame). Not seen: attribute-only changes (the `.in-view` class), CSS animations, paint/GPU work, anything outside
the pane. A ticking indicator inside the pane (a spinner's text) keeps it changing, so a busy session usually ends at the 3 s cap
with `st` null, which is why that is recorded with the destination's streaming flag instead of being guessed. SETTLED, terminal
view: xterm draws on a canvas/WebGL, so a DOM observer sees nothing; it is the moment xterm finished PARSING the backlog the
hidden terminal had queued (an empty write queued behind the show's drain, its callback), or the first frame when there was none.
WebGL repaint after that, and the shared glyph-atlas re-rasterize on every show, are not seen. A switch that starts while the page
is hidden is not recorded. A chat/terminal toggle on the same session is not a session switch and is not recorded. The first
selection of a window's life (nothing -> a session) is remembered as "visited" but not recorded.

**Cost.** Between switches: two idle DOM listeners. A switch arms one `requestAnimationFrame`, one MutationObserver (chat
view only), one `layout-shift` observer and one or two timers, and tears all of it down at settle, interrupt, hide, close or the
3 s cap; a test asserts that nothing short-lived remains. No layout reads (entry counts read one sibling count, not a subtree
walk). The page side is one small JSON string and one `dispatchEvent` per switch.

**Limits.** Window side <= 120 `switch` lines per minute (excess counted in `swOver`); main re-validates (<= 100 per batch,
<= 120 per minute per window, separate from the 30-a-minute budget of frames/events) and counts what it dropped in the minute
line's `rend.switches` (written) and `rend.swOver` (dropped by either side).

**Limits (two independent layers):** window side <= 30 detailed entries per minute, flush every 5 s; main re-validates every
field (every string an enum or tight pattern, numbers range-checked, unknown keys dropped, <= 100 entries/batch, <= 40 batches/min
per window, <= 30 entries/min per window) and writes at most every 2 s. The file is opened, appended and closed per flush: it is
never held open, so it can be read while the app runs.

**Costs:** one unref'd 1 s timer in main (event-loop delay read + every 60th tick the minute line, which calls
`app.getAppMetrics()`); Node's own event-loop sampler (a timer every 100 ms; env `YOUCODED_HITCH_LOOP_MS`, 10-1000, overrides: measured idle cost of the main process on the rig, in % of one core: off 0.3, 250 ms 0.4, 100 ms 0.6, 50 ms 0.9, 20 ms 1.4-1.7, so 100 ms is the default); a wrapper on `ipcMain.handle`/`on` that stores a channel name and
a timestamp. Renderer: two PerformanceObservers that call back only for slow work, and one-shot timers.

**Reading it:** `node scripts/perf-lab/hitch-report.mjs <file|dir> [--since 24h] [--json]` (workspace repo). A "SWITCHING SESSIONS" section appears when the file has `switch` lines (typical/slowest/worst time to show and to settle, splits by view, first visit vs revisit, idle vs streaming, quick vs spaced, three worst with overlapping freezes, the 2 s after arrival); `--json` carries the raw aggregates under `switching`. Rig proof: `node scripts/perf-lab/suspects.mjs --only switchmarks`.

**Attaching to a bug report (not done):** `dev-tools.ts` `buildIssueBody` already attaches a redacted log tail; an equivalent
would read the last N lines of this file through `hitch-report`'s `analyse()` and attach only the summary (counts, causes by
function/bundle name, per-hour totals, memory start/end per process type), never raw lines.

**The channel (`perf:hitch-batch`):** named in `shared/backend-contract.ts` (so the preload's generated list carries it) but deliberately
NOT a channel-table entry: the recorder is created in `whenReady` and registers its own `ipcMain.on`. A phone can never send it: the phone
door only dispatches table entries, and `hitch-recorder-wiring.test.ts` pins that remote-shim, remote-server and Kotlin never mention it.
`channel-table-complete.test.ts` lists the recorder's registrations as its named exceptions.
