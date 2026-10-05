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
| `startup` | `main` {mark: ms since process start}, `loadedMs` (first window loaded), `renderer` {marks: yc:* ms, fcp} or null |

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

**Limits (two independent layers):** window side <= 30 detailed entries per minute, flush every 5 s; main re-validates every
field (every string an enum or tight pattern, numbers range-checked, unknown keys dropped, <= 100 entries/batch, <= 40 batches/min
per window, <= 30 entries/min per window) and writes at most every 2 s. The file is opened, appended and closed per flush: it is
never held open, so it can be read while the app runs.

**Costs:** one unref'd 1 s timer in main (event-loop delay read + every 60th tick the minute line, which calls
`app.getAppMetrics()`); Node's own event-loop sampler (a timer every 100 ms; env `YOUCODED_HITCH_LOOP_MS`, 10-1000, overrides: measured idle cost of the main process on the rig, in % of one core: off 0.3, 250 ms 0.4, 100 ms 0.6, 50 ms 0.9, 20 ms 1.4-1.7, so 100 ms is the default); a wrapper on `ipcMain.handle`/`on` that stores a channel name and
a timestamp. Renderer: two PerformanceObservers that call back only for slow work, and one-shot timers.

**Reading it:** `node scripts/perf-lab/hitch-report.mjs <file|dir> [--since 24h] [--json]` (workspace repo).

**Attaching to a bug report (not done):** `dev-tools.ts` `buildIssueBody` already attaches a redacted log tail; an equivalent
would read the last N lines of this file through `hitch-report`'s `analyse()` and attach only the summary (counts, causes by
function/bundle name, per-hour totals, memory start/end per process type), never raw lines.

**The channel (`perf:hitch-batch`):** named in `shared/backend-contract.ts` (so the preload's generated list carries it) but deliberately
NOT a channel-table entry: the recorder is created in `whenReady` and registers its own `ipcMain.on`. A phone can never send it: the phone
door only dispatches table entries, and `hitch-recorder-wiring.test.ts` pins that remote-shim, remote-server and Kotlin never mention it.
`channel-table-complete.test.ts` lists the recorder's registrations as its named exceptions.
