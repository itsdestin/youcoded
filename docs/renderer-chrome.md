> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rule in youcoded-dev/.claude/rules/react-renderer.md is the terse always-injected layer; this doc is the depth.

# Renderer chrome, themes, overlays, remote sync — depth

## Framed shell & chrome-glass

The chat region renders inside `.framed-shell` (`desktop/src/renderer/styles/globals.css`). With the artifact drawer open the shell holds `[frame-edge] [chat-pane] [frame-divider] [drawer-pane] [frame-edge]`. The visible chrome (panel-colored frame around the chat + drawer windows) is painted by a SINGLE absolute element — `<div class="chrome-glass">` mounted at the top of the chat container in `App.tsx` — clipped to a rounded donut via `clip-path: polygon()`.

- **One backdrop-filter, ever.** Pre-May-2026, HeaderBar / frame-edge / frame-divider / drawer-pane / corner-pseudos each carried their own translucent panel + backdrop-filter. At non-100% zoom the element boundaries land at fractional screen pixels; the anti-aliased seams created tiny overlaps (double-blurred dark regions) or tiny gaps (sharp wallpaper bleed). `chrome-glass` consolidates all frame chrome into one element with one backdrop-filter — no inter-element compositing seams. Don't reintroduce per-element `backdrop-filter` in framed-chrome mode.
- **`destination-out` is NOT a valid `mix-blend-mode` value.** It's a Porter-Duff compositing operator (Canvas / SVG `<feComposite>` only). The CSS `mix-blend-mode` whitelist has no such value; the browser silently ignores it and renders the cutout's `background: black` straight through (black chat area). Use `clip-path` to cut a shape.
- **The TR corner of the chat-pane cutout polygon needs an explicit closer.** The polygon builds the donut as outer-CW + inner-CCW, the inner rounded rectangle approximated by 5 points per corner. The other three corners share their endpoint with the next side's start; TR's endpoint equals the FIRST inner point at the top of the list. Without an explicit `(R-corner, T)` repeated at the end, the implicit close jumps to `(0,0)` and the TR arc distorts. Keep the trailing closer point.
- **`chrome-glass` is `display:none` in floating-chrome modes.** When `chrome-style='floating'` (full floating, e.g. halftone-dimension) OR `input-style='floating'` (partial, e.g. devils-garden), HeaderBar / InputBar / StatusBar paint their own pills/strips. Mirror the gating for any new always-floating element so chrome-glass doesn't double up.
- **Compound attribute selectors must be on the same element.** `data-wallpaper` is on `<html>`; `data-chrome-style` / `data-input-style` on `<body>`. `[data-wallpaper][data-chrome-style='floating']` matches nothing — use the descendant combinator. (Bit Devil's Garden's header glassmorphism: opaque because the wallpaper-translucent rule never fired.)
- **drawer-pane sits ABOVE chrome-glass via `z-index:11`.** chrome-glass at z-10 cuts out only the chat-pane area (single polygon cutout). drawer-pane has its own `--canvas` bg + `border-radius`; its corner cutoffs reveal chrome-glass underneath (the rounded-corner visual). A second polygon cutout would also work but costs ~20 points; z-index is cheaper.
- **`.chrome-wrapper` must be transparent regardless of theme.** With chrome-glass providing the surface, the bottom wrapper at `z-index:20` (from `.bottom-float`) sits ABOVE chrome-glass at z-10; if it paints `--canvas` the bottom strip reads canvas-colored while the rest reads panel-colored. Universal `.chrome-wrapper { background-color: transparent !important; }` covers solid + wallpaper themes.
- **The right slot holds EITHER the artifact drawer OR the games panel — width is `--right-pane-width`.** As of June 2026 the games panel renders inside the framed-shell as a `.drawer-pane game-pane` (same chrome). `.drawer-pane` width and `chrome-glass--drawer-open`'s `--chat-right-offset` BOTH read `var(--right-pane-width, 480px)`; App sets it on the main-area div (`var(--game-pane-width, 420px)` when games is active, else `var(--drawer-width, 480px)` — both user-resizable). Hardcoding the width in either place drifts the frosted cutout from the actual pane width. The two are mutually exclusive (transition-gated effects close the other on open); `chrome-glass--drawer-open` gates on `activeDrawerOpen || gameState.panelOpen`. ChatView gets the games panel via a `gamePane` slot prop (active session only) with precedence over the artifact drawer. Games only shows in chat view (lives in ChatView), not terminal view.

## Theme color contrast

Thresholds enforced by `wecoded-themes/scripts/audit-contrast.mjs` (CI `validate-theme.yml`, BLOCKING since 2026-07-19 — HARD and SURFACE failures fail the build); dev copy `desktop/scripts/audit-theme-contrast.mjs` also audits the four built-ins.

- **`panel` vs `canvas` ≥ 1.07:1** — both are surface colors (chrome wraps content); below 1.07 the two blur together (Crème was 1.046 — the frame disappeared).
- **Text on every surface** (canvas, panel, inset, well, inset-50 — `desktop/scripts/vendor/contrast-rules.js`): `fg` ≥ 8, `fg-2` ≥ 5.5, `fg-dim` ≥ 4, `fg-muted` ≥ 3, `fg-faint` ≥ 2.
- **User bubble text:** `on-accent` vs `accent` ≥ 4.5 (Strawberry Kitty's `#D94E6B` on white was 4.0 → darkened to `#CC4060` = 4.7).
- **chat-pane bg == drawer-pane bg** (both `--canvas`) so the two windows read as one content surface. drawer-pane briefly used `--inset` during the chrome-glass refactor — looked like a different window. Change both in the same edit; the audit doesn't catch this mismatch.

### Status colours (added 2026-09-05)

`StatusDot.tsx` `STATUS_LABEL` is the app's whole status vocabulary, and it is what the session
pills in the header show all day: **green = Working, blue = Response Ready, amber = Needs a Look,
red = Needs Input**. A new surface that picks its own colour for a state does not merely look
different — it tells the user the opposite of what they already read. The specialists popup
shipped with a BLUE "Working" pill until Destin caught it on the review deck (2026-09-05).

The status colours are declared "constant across all themes" in `globals.css`
(`--color-green-400: #4CAF50`, `red-400`, `amber-700`), which is exactly why **they must never
carry the word**. Measured on the helpers popup's own pill fill: `#4CAF50` as text is 1.97:1 on
light, 1.81:1 on creme, 1.50:1 on meadow-mist, against a 4.5:1 floor — it passes only on the
three dark themes. `amber-500` is worse (1.52 / 1.41 / 1.19:1). Put the colour in the ring and
the tint and leave the word on `text-fg`/`text-fg-2`; `SessionStrip.tsx` `STATUS_PILL` is the
pattern, and its own comment records the same finding from 2026-08-28.

The UI review sweep measures this for free — a `scripts/ui-review/plans/` shot with
`probe: false` opts OUT of the painted-pixel contrast probe, and `contrast.md` then says so
rather than coming back empty.

## Header bar

- **No `min-w-0` on the left cluster** — it collapses below the settings gear's `shrink-0` width, letting SessionStrip paint over the gear. Left + right `flex-1` columns stay symmetric (both omit `min-w-0`); truncate an individual child instead.
- **Layout is space-aware, not viewport-aware.** SessionStrip uses `packSessions()` + ResizeObserver; the chat/terminal toggle labels follow a measured 560px threshold on the header's own `clientWidth`. No ad-hoc `@media` or `window.innerWidth` — they lie when the window is narrow but the viewport is wide (the default on desktop). The one sanctioned viewport branch is `useNarrowViewport()` (`max-width: 639.98px`), which HeaderBar uses for its whole narrow layout; the gamepad pill is `hidden sm:block` with the `|||` menu as its narrow entry point.
- **Chat/terminal toggle placement is platform-conditional** — right cluster on macOS, left on Win/Linux, balancing the opposite-side OS window controls; at narrow widths it is on the right on every platform. The gamepad pill + caption buttons stay in the right cluster on all platforms.
- **`showCaptionButtons` must include Linux.** The `BrowserWindow` is frameless (`frame:false`, `titleBarStyle:'hidden'`) on BOTH Windows and Linux; only macOS gets traffic lights. Gating on `navigator.platform === 'Win32'` left Linux with zero window controls. Gate window-chrome on "not macOS" (`!isMac && !isAndroid() && !isRemoteMode()`). General trap: `navigator.platform === 'Win32'` / `process.platform === 'win32'` exclude Linux — audit any `if(win)…else if(mac)…` fallthrough for Linux correctness.
- **Announcement lives in StatusBar** (an `announcement` widget in "Updates"). Don't re-thread it into HeaderBar.

## Render-path chat-state access (migrated 2026-08-12 from the path-scoped rule)

- **Reading chat state on the render path: use a cached selector, not the whole map.** `state/chat-context.ts` is a custom `useSyncExternalStore` store, not a plain Context. `useChatState(id)` re-renders only on that session's change. `useChatStore()` gives effect-only readers (`getState`/`subscribeAll`) and backs cached-selector hooks (`useSessionAttention`, `useActiveSessionModel`) that re-render their host only when a *derived* value changes. **Do NOT put `useChatStateMap()` on the render path** — it re-renders on every dispatch; the one sanctioned caller is `RemoteSnapshotExporter` (serializes the full map for remote hydration). **Never call `store.getState()` during render** for render-path data — it bypasses the subscription and can tear; add a selector instead. (2026-07-17 AppInner tranche removed AppInner's whole-map subscription this way — ~20× fewer AppInner re-renders.)
- The chat reducer preserves `toolCalls`/`toolGroups` Map refs when unchanged so `React.memo` works — don't clone them needlessly. Prefer `content-visibility: auto` over virtualization (keeps find-in-page + a11y); memoize every Context value (`useMemo`), split contexts by change frequency.

## Control primitives (`components/ui/`) — migrated 2026-08-12 from the path-scoped rule

- **Every control goes through its primitive** — never hand-roll `bg-accent text-on-accent`. A caller's `className` REPLACES base tokens by conflict group via `mergeClasses` (a hand-rolled tailwind-merge stand-in); it does not pile on. Guard `primitive-adoption.test.ts` also fails on a primitive with NO call site — an unused one becomes a shadow copy.
- **Padding groups are per-axis:** `px-`/`py-`/`p{trbl}-` are independent; `p-N` belongs to ALL padding groups. An `px-`-only override must NOT drop the size's `py-` (2026-07-20: the old single `/^p[xytrbl]?-/` group collapsed welcome CTAs + SyncPanel Save to text height). Guard: `Button.test.tsx` — keep per-axis independence if you touch `CONFLICT_GROUPS`.

## Overlays

Full layer system: workspace `docs/shared-ui-architecture.md → Overlay Layer System`. Rules:
- **Use `<Scrim>` + `<OverlayPanel>` from `components/overlays/Overlay.tsx`** — don't hardcode `bg-black/40`, `bg-canvas/60`, `backdrop-blur-sm`, `shadow-xl`, `rounded-xl`, or z-index. Scrimless anchored popovers (dropdowns, context menus) use `.layer-surface` directly.
- **Pick a layer, not a z-index:** L1 drawers (z 40/50), L2 popups (z 60/61), L3 destructive (z 70/71), L4 system (z 100).
- **SessionStrip dropdown at `z-[9000]` is load-bearing** — `.header-bar`'s `backdrop-filter` creates a stacking context that traps lower values. Don't "fix" it.
- **Glassmorphism is automatic + var-driven** — `.layer-surface` reads `--panels-blur` / `--panels-opacity` (defaults `0px`/`1`); no `[data-panels-blur]` gate. Reduced-effects forces `--panels-blur:0` but preserves opacity intent.
- **`.layer-surface` on a REPEATED element (grid tile, list row) is a paint bug, not a style choice** (migrated 2026-08-12 from the path-scoped rule) — theme-engine gives each one a `backdrop-filter` under `[data-wallpaper]`, so N tiles = N blur layers, and inside an `overflow-hidden` + `transform`-animating parent Windows Electron drops their paint *per card* (shipped twice: `516411a5`, `1f68a7f0`). Over an opaque parent cancel it; over a real wallpaper pre-blur ONE backdrop instead. Guard + full rationale: `youcoded/desktop/tests/drawer-card-glass.test.ts`.

## Remote access state sync

- **Remote clients hydrate via `chat:hydrate` on connect** — `remote-server.ts::restoreClient()` (run when the client says `client:ready`, or after a 5 s fallback for an older page) calls `requestChatSnapshot(webContents)` (the renderer's `RemoteSnapshotExporter` serializes `ChatState`), then pushes ONE `chat:hydrate` to the connecting client. The old `transcriptBuffers` replay buffer was removed (two sources of truth → ordering/dedup bugs). Backfill new remote state by extending `serializeChatState`/`deserializeChatState` in `state/chat-types.ts` — no sidecar buffer.
- **`attentionState` is authoritative on DESKTOP only.** `useAttentionClassifier` reads the xterm PTY buffer every 1s (Electron only). Remote browsers have no PTY and MUST NOT run their own classifier (CLI-version regex would drift across two sites). Flow: App's `statusData` handler diffs `attentionMap` against the previous map → `useRemoteAttentionSync` fires `remote:attention-changed` → main caches in `lastAttentionBySession` → `buildStatusData()` folds `attentionMap` into `status:data` → broadcast on change. The shim diffs `attentionMap` vs `prevAttentionRef` before dispatching `ATTENTION_STATE_CHANGED` — load-bearing (else every 10s tick thrashes the reducer).
- **`RemoteSnapshotExporter` is Electron-only by design** — mounted in `App.tsx` inside `ChatProvider`, guards on `typeof window.claude.onChatExportSnapshot === 'function'`. On remote browsers that API doesn't exist (remote-shim doesn't expose it), so it short-circuits. Intentional, not a parity bug.
- **`chat:export-snapshot` has a 2s timeout** — `requestChatSnapshot()` resolves `{sessions:[], degraded:true}` on timeout. The PTY and hook replays follow the hydrate in the same pass (the old 500 ms guess is gone — `tests/remote-readiness.test.ts` guards against its return), so worst case before a new remote sees PTY output is the 2 s when the renderer is unresponsive. Shortening it makes the degenerate case (renderer still booting at connect) hydrate empty and fall back to live events.
