# Changelog

All notable changes to YouCoded are documented in this file.

## [Unreleased]

## [1.3.0-beta] — 2026-09-11

Everything between v1.2.4 (18 May) and the 1.3 beta: 3,119 commits.

The headline is that YouCoded stopped being only a window onto Claude Code. It now has
an assistant of its own that can run a conversation, use tools, ask permission, hire
helpers and work offline on a model running on your own machine — while Claude Code
sessions keep working exactly as before. Around that: a project workspace with real file
viewers and editing, conversations that sync between your devices, sign-in with a ChatGPT
plan, a rebuilt marketplace, a four-game arcade, remote access you can use from a phone, a
first-run tour, and a security review whose fixes all landed before this build.

### The assistant of your own

- **A built-in assistant** — conversations can run inside YouCoded instead of through
  Claude Code, with the same chat, tools and files.
- **It asks before it acts** — a permission card names the tool and what allowing it
  permits. "Always allow" is remembered, can be scoped to exactly this command or the
  whole tool, and every standing grant is listed and revocable in Settings.
- **Reading never interrupts you** — reading, searching or listing a file outside the
  project no longer stops the assistant with a Yes/No card. Writing and editing still
  ask, and credential files stay blocked outright.
- **Helpers (specialists)** — the assistant can hire separate helper sessions with their
  own limited permissions, shown as cards in the chat. They run in the background, survive
  a restart, can be steered mid-run or interrupted, and can be defined by your own files.
  Each hire can use a cheaper or stronger model.
- **Web search and page reading** — with your own Tavily or Exa key, entered and tested in
  Settings.
- **Tools it can use** — commands (including long-running ones that outlive a single
  step), file search, reading images and PDFs, and tools from connected MCP servers.
- **Standing rules** — finish the job, don't act on a question, don't touch your uncommitted
  edits, look at visual output the way you will, and treat a fetched web page as
  information rather than instructions.
- **Skills you can call** — typing a skill name starts it as a labelled card instead of
  pasting thousands of characters into your message. Skills defined inside a project load.
- **A step guard you control** — how many steps a session may take is a setting, not a
  hidden rule.

### Models: your own machine, and your own plans

- **Local models** — browse a curated catalogue or search Hugging Face, see whether a model
  fits your graphics card, download it (resumable, checksum-verified), and chat fully
  offline. The engine installs, supervises and stops itself.
- **Per-model settings** — context length, how long it stays loaded, GPU layers and extra
  engine options, applied without restarting the engine.
- **A real memory estimate** — the fit warning reads the model file's own structure and
  scores it against the graphics chip actually present, instead of charging every model a
  flat 2 GB.
- **Faster, cheaper generation** — speculative decoding on by default (16 → 104 tokens/sec
  on a file rewrite, measured) and 8-bit conversation cache (about +40% speed and half the
  memory at 16k of context).
- **Vision models can see** — a model with a vision file downloads into the layout the
  engine will pair, an attached image reaches it, and an earlier download can be moved into
  that layout safely.
- **Graphics acceleration** — "Switch to CUDA" works on Windows without NVIDIA's toolkit
  installed, and AMD ROCm is an opt-in on Linux and Windows, described by measurement
  rather than a claim (about 20% faster reading a prompt, 24–46% slower writing replies).
- **Interrupted downloads** — a partial download is its own row with Resume and Delete, and
  can never be offered in the picker as if it were installed.
- **Sign in with ChatGPT** — use a ChatGPT plan's own models inside YouCoded, with the plan's
  models in the picker, usage bars labelled by the real window, and a card naming the reset
  when the plan runs out, with an Upgrade plan button.
- **Cheaper repeat requests** — prompt caching is actually requested from Anthropic,
  OpenRouter conversations are pinned to one session, and long conversations compact before
  anything is trimmed, so small models stop collapsing to the newest message.
- **Model names** — version numbers dropped ("Sonnet", not "Sonnet 4.6"), Fable added,
  and chips for DeepSeek, Meta Llama, Mistral, Perplexity and Cohere.
- **Gemini** — removed as a provider.

### Chat

- **"What the assistant was given"** — a line above every conversation, with a panel behind
  it, showing the instructions, rules, skills and tools it started with and what was left
  out. It turns amber mainly when a small model has had the entire skill list dropped.
- **Stop button and a message queue** — messages you send while it is still answering line
  up, where you can edit or cancel them before they go.
- **Deliverables** — files the assistant hands you render as a card with previews inside the
  reply; it can also hand you a link that opens in your browser.
- **Question cards** — "Other" with your own answer, or a note alongside the option you
  picked. Dismissing one ends the turn instead of telling the model to guess.
- **Find in chat** — Ctrl+F searches and highlights the whole conversation.
- **Chat Search** — a searchable index of past conversations, with Preview and Resume from a
  result, and tagging, noting and flagging from search.
- **Rename a conversation** — from the switcher's pencil, its right-click menu or the saved
  list, and a name you choose is never overwritten by automatic naming.
- **Automatic naming stops interrupting** — Off and Basic never interrupt a reply; the AI
  setting asks after the 1st, 3rd, then every 25th reply, instead of roughly six times a
  conversation.
- **Collapsible thinking**, clickable links and file paths everywhere, a copy button on every
  code block, and tool cards written in plain verbs ("Read foo.ts", past tense once done).
- **Right-click menus and flick scrolling** in the chat and message box.
- **App chrome can't be selected or copied** — select-all no longer paints titles, chips and
  buttons; file names inside messages stay copyable.
- **Fixed:** scrolling up mid-reply no longer yanks you to the bottom; a stalled provider
  parks the turn with a retry instead of losing it; turns no longer end silently empty;
  duplicate and missing messages after a reload or reconnect; approval prompts attaching to
  the wrong tool; the app recovering a conversation, model and permission mode after a
  display crash; the phantom "Compacted" message and the thinking state that never cleared;
  a stray Enter answering prompts for you; typing on a brand-new local-model session being
  told the session is dead.

### Sessions

- **Tags and notes** — your own coloured tags and freeform notes on any session, shown in
  the status bar, the resume list and the closing prompt, and searchable there.
- **Conversations that sync between devices** — saved with real titles and dates, resumable
  on another machine, with a clean takeover prompt when one is open elsewhere.
- **The resume browser** — a preview pane showing what was actually said before you go back
  in, with rename, tags and complete on a floating card; filter pills for projects and tags;
  chronological by default; year-long history retention.
- **Multi-window** — move a session to a new window or another window from its pill's menu,
  and on Linux/Wayland by dragging it onto another window's chat area. The moved session
  keeps its history.
- **Sessions without a folder** — a "No folder" choice that runs in an empty folder the app
  owns.
- **Fixed:** resuming opening in the wrong folder, sessions showing "Untitled" despite having
  names, the header stuck on "Resuming…", a resumed session spinning forever, transcripts
  mis-filed for folders with unusual characters, and a background session repointing the
  conversation you were looking at.

### Projects and files

- **Project View** — a hub per project with Files, Conversations and Instructions & Memories
  tabs, a project switcher, a description that syncs, and live counts that agree with each
  other.
- **A session file drawer** — every file a conversation created, edited, read or deleted,
  with previews, rename, find-in-file, reveal in folder, copy path, sort and filters.
- **Real file viewers** — spreadsheets (with formats, merged cells, formulas and sheet tabs),
  PDFs, Word documents, images, HTML as live pages, and code with syntax highlighting.
  Pictures and PDFs open up to 50 MB; large text opens as a readable beginning with the rest
  on request.
- **Editing in the app** — a real editor with save, unsaved-change warnings and a discard
  guard, plus zoom and a hover magnifier for images and PDFs.
- **Search inside files** — across the whole project, grouped by name matches and content
  matches.
- **Review and commit** — changed files, include-in-commit, message, commit, or discard with
  an explicit confirmation.
- **"Ask about this"** — right-click a selection in a file to ask about it, line numbers
  included.
- **Fixed:** importing a file onto itself deleting it; files inside a project being filed as
  outside files; "no longer on disk" flashing while loading; the Conversations and Context
  tabs coming up empty on Windows; file history no longer growing forever (30 days, with the
  10 most recent versions per file always kept).

### Backup and sync

- **Sync through your own GitHub account** — projects and conversations kept in step between
  your machines, with near-instant change signals, a devices list, dated snapshots and
  automatic pruning.
- **Connecting GitHub without the terminal** — sign in with a code; the app installs the
  GitHub tool itself on macOS and Linux where it is needed.
- **Honest status** — the panel turns green only on evidence of a completed sync, repairs
  half-finished setup itself, and clears its own stale warnings.
- **Removed:** restoring from a backup, pending a redesign.

### Marketplace and skills

- **Rebuilt marketplace** — a real catalogue of 4,100+ listings with origin badges, a "What
  this can do" panel before you install, visible trust information, and 👍/👎 with comments.
- **Update actually updates** — both on a card and in the Library's Updates tab; bundled
  skills upgrade themselves at launch.
- **Its own address** — the service moved to api.youcoded.ai, which also made its rate
  limiting work for the first time. Older installs keep working.

### Remote access

- **Use the app from a phone or another browser** — with projects and account available, a
  narrow-window layout, compression and caching for a faster first load.
- **Security batch 1** — your computer listens only on its Tailscale address, the password is
  always required (the "any tailnet address gets in free" bypass is gone), paired devices are
  named records with Online/Offline and an Unpair that revokes, and the status light reports
  whether the listener is actually up. **Every existing pairing must be re-paired once.**

### Games

- **A four-game arcade** — Connect 4 and chess against friends, Flappy and 2048 solo, with
  leaderboards and head-to-head records. Your player identity comes from your YouCoded
  sign-in.
- **Playable without a mouse** — Connect 4 columns are real buttons with announcements for
  assistive tech, and the chess board fits its pane.

### The buddy

- **Every mascot redrawn** in the promo film's warmer style, with eight expressions each,
  three new characters, a sleep pose, and one for every theme in the registry.
- **Better behaviour** — hover-revealed actions, snapping to the screen edge with a peek,
  smoother animation, and an opt-in helper that lets you drag him on KDE Wayland.
- **Fixed:** the docked buddy drawing two poses at once, a bad saved position parking him
  behind the taskbar, and the floater's Resume Session button being a placeholder.

### Getting started, and getting help

- **A first-run tour** — after setup the buddy walks eight stops through the real app, and it
  can be replayed from Settings.
- **Tips, empty screens and first-time warnings** — one tip per sitting with a switch to stop
  them, "Start your first session" on a new install, an explained empty Projects screen, and
  an I-understand checkbox the first time you use Skip Permissions or Full auto.
- **Help & feedback in Settings** — the tour, the tips switch, r/youcoded, the bug report and
  known issues.
- **Bug reports start from the error** you hit, show every piece of evidence before it leaves
  your machine, work with no AI at all, and keep your draft through a failure.
- **Crashes and freezes leave a record** on your own machine (never uploaded) and a line in
  the log a bug report attaches.
- **Seventeen false error messages fixed** — "Uploaded!" for a failed backup, "Nothing
  installed yet" when the list could not load, "Launch failed" for a failed download. Every
  error state now offers an action, with Retry last.
- **The assistant is "your assistant"** — about 45 references to "Claude" in the app's own
  wording now name the assistant you chose.

### Look and feel

- **One consistent control set** across the app — buttons, inputs, toggles, dropdowns, empty
  states, loading states, dialogs — and Settings as one uniform list of rows.
- **Assistant settings in one place** — Model Providers, Session Defaults, Permissions and
  Specialists became one panel, sitting directly under Account.
- **Themes** — preview cards in the picker, readable muted text in every built-in theme,
  correct glass on floating-chrome themes, a terminal that stays readable under wallpapers,
  and Reduced Effects that also stops animation a community theme adds.
- **New app and installer icons** — the waving purple mascot across Windows, Mac, Linux and
  Android, with the installer named and marked distinctly from the app.

### Speed

- **Huge conversations open fast** — about half a second instead of 20+ seconds, with history
  loaded a page at a time, and far-off messages folded to a placeholder so scrolling stays
  smooth.
- **The app stops running out of memory** on long conversations (it crashed six times in one
  day before this).
- **Project view stops chugging** — eight rapid tab clicks went from 7.1 seconds of
  unresponsiveness to none; a cold open from 2.1s to about 0.8s.
- **Resume browser** — a 42.6 MB conversation previews in 21 ms instead of stalling.
- **A six-minute freeze after taking a sync lease** is gone, marketplace, theme preview and
  resume reads no longer block the window, and the live transcript reader is capped so one
  huge conversation cannot stall the app.

### Security and privacy

- **Pre-launch security review, all fixes in this build** — a community theme or a document
  preview could run code with the app's powers; an "Always allow" command grant could be
  chained past; the assistant could read stored-credential files or leak them through
  automatically loaded chat images (now tap-to-show); remote access had no origin check and
  accepted one-character passwords (now an 8-character minimum with a Generate button).
- **Signed updates** — the app verifies a signed update before launching it, from the next
  signed release onward, and every download in a release is listed in a signed manifest so it
  can be checked for tampering or corruption.
- **The file write-guard ships inside the app** — the old separate plugin is removed on
  launch and never installed for new users.

### Installer and updates

- **Real Linux installers** — .deb, .rpm and .pacman alongside the AppImage.
- **The Update button works again** — GitHub moved where downloads are served from, which had
  been failing for everyone, and the Windows updater stopped re-downloading on every reopen.
- **Betas can update to the full release** — a beta now offers 1.3.0 when it ships and
  verifies it before installing. **Betas up to 1.3.0-beta.76 cannot: install this build or
  1.3.0 from youcoded.ai instead.**
- **macOS signature restored** — lost to a build-tool bump in July, which had made those
  builds unopenable.
- **Windows first-run install made resilient** — no duplicate installs from Retry, the
  install found after it completes, downloads retried, and antivirus file locks explained.

### Android

- **Honest builds** — phone builds carry a real version number (every earlier beta shipped as
  1.2.4), the app asks for notification permission after setup (so Android 13+ stops
  silently dropping every prompt), and an unsupported request refuses cleanly instead of
  crashing Project View.
- **Parity fixes** — the same conversation history, names and timestamps as desktop, working
  marketplace updates, and presence that no longer flaps.
- **Removed:** the phone-only restore-from-backup flow.
- **Relicensed from GPLv3 to MIT** — the whole repository is now MIT. The GPL label rested on
  a misreading of Termux's licence: its terminal-emulator library (the only Termux code the
  app contains) is carved out as Apache 2.0, and no other Android dependency is copyleft. The
  vendored library keeps its Apache 2.0 LICENSE and NOTICE. No runtime change.

### Website

- **youcoded.ai rebuilt** for 1.3, with recordings of the real app instead of drawings, a live
  embed of the interface, a phone layout, and scroll motion across the page.
- **The right download for your machine** — Mac visitors choose Apple silicon or Intel (an
  Intel Mac cannot open the Apple silicon build), and Linux visitors get their distribution's
  package.
- **Company and policy details** — Privacy and Terms linked from the site and Settings →
  About, naming Destin's Adventures, LLC (Arizona), with support@youcoded.ai as the contact.

### Also changed

- **Local models are freed less aggressively** — a model sleeps after 15 minutes idle (was 5)
  and the engine shuts down after 25 minutes without requests (was 10). The next message
  wakes either one.

## [1.2.4] — 2026-05-18

**Claude Code CLI baseline:** v2.1.143

Patch release. The headline change is the analytics redesign: anonymous
telemetry is now keyed by a device-ID hash instead of a random install ID,
so reinstalls no longer inflate the user count. The bug-report flow gained
an environment-diagnostics snapshot, three Linux desktop platform-parity
gaps were closed, and the first-run installer is more robust on minimal,
musl, and fish-shell Linux setups.

### Added
- **Bug-report environment diagnostics** — The Settings → Development issue
  reporter attaches an environment snapshot (git/claude/gh on PATH, ~/.claude
  permissions, marketplace cache health, GitHub reachability) to bug reports.
  Home paths and token patterns are redacted; the snapshot appears in the
  editable preview before submission. Desktop + Android.
- **PRIVACY.md, TERMS.md, SECURITY.md** — Public privacy policy, terms of
  service, and security-disclosure policy for the project.

### Changed
- **Analytics: device-ID-hash redesign** — Anonymous opt-out telemetry is now
  keyed by an on-device HMAC hash of a hardware ID — the raw machine ID never
  leaves the device, and reinstalling no longer creates a new "user". Adds
  approximate region (derived server-side from request IP) and drops the
  separate install event. Desktop + Android; opt-out in Settings → About →
  Privacy.

### Fixed
- **CC prompt-suggestion auto-submit** — YouCoded force-disables Claude Code's
  next-prompt ghost-text suggestion on every launch. The ghost text
  concatenated with chat→PTY writes and auto-submitted on the trailing
  carriage return, sending text the user never typed. Desktop + Android.
- **Linux platform parity** — Closed three desktop gaps: the first-run
  installer auto-installs Node.js on Linux, the custom window caption buttons
  render on Linux's frameless window, and three smaller parity gaps were fixed.
- **First-run installer robustness (Linux)** — The Claude Code installer falls
  back to `wget` when `curl` is absent; the Node.js installer detects musl
  distros (Alpine) up front with package-manager guidance instead of failing
  opaquely; and the Node PATH entry is persisted to `config.fish` for fish
  users.
- **Bug-report subprocess reliability (Windows)** — dev-tools subprocesses
  (git/gh/claude) resolve to absolute paths and EINVAL-guard `.cmd` shims, so
  environment diagnostics and the issue summarizer no longer under-deliver on
  Windows.
- **Theme effects** — The particle canvas pauses its animation loop when the
  window is hidden, and masks out chrome regions so particles no longer render
  under the header and input bar.
- **Open Tasks popup** — The popup body is scrollable when the task list is long.
- **Chat→PTY submit** — The submit-confirmation `\r` retry is suppressed while
  the terminal view is active, preventing a stray carriage return.

## [1.2.3] — 2026-05-01

**Claude Code CLI baseline:** v2.1.126

Patch release. The headline fix is the Android marketplace install bug: the
`PluginInstaller` used string-based reflection against `Bootstrap` that R8
silently obfuscated in release builds, so every marketplace plugin install
since 2026-03-25 (v1.2.0 onward) shipped with a stripped runtime env and died
with `cannot exec 'remote-https': Permission denied` on real users while every
dev build worked fine. Plus the attention banner now correctly handles
multi-word gerunds and ticking counters (no more spurious "still waiting" mid-
turn), the drawer no longer flickers when the desktop chat re-renders, long
URLs/paths wrap inside chat bubbles, and Android marketplace install state
matches by `pluginName` instead of bare ID.

### Added
- **Android `releaseTest` build type + CI parity check** — Same R8 / shrinker / proguard config as production release, debug-signed for side-by-side install (`com.youcoded.app.releasetest`, bridge port 9961). `android-ci.yml` and `android-test-build.yml` run `assembleReleaseTest` on every push so R8-induced regressions surface at PR time, not after tagging. Catches the class of bug that shipped v1.2.0 → v1.2.2 invisibly.
- **ProGuard `-keep` rule for `com.youcoded.app.runtime.Bootstrap`** — Defensive: protects all of Bootstrap's public surface from R8 obfuscation so any future reflection against it can't silently break. Negligible APK size cost.

### Fixed
- **Android marketplace plugin install (R8 reflection footgun)** — Replaced `bootstrap.javaClass.getMethod("buildRuntimeEnv")` in `PluginInstaller.kt` with a direct strongly-typed call. R8 minification was renaming the target to a one-letter symbol in release builds, so the reflection threw `NoSuchMethodException` and a silent `try/catch` fallback shipped a stripped env without `LD_PRELOAD`, breaking every plugin install with `cannot exec 'remote-https': Permission denied`. Affected v1.2.0 onward.
- **Marketplace installed-plugin matching by `pluginName`** — `MarketplaceScreen` and `MarketplaceDetailOverlay` now match installed plugins by their declared `pluginName` instead of just the bare ID, so plugins whose published name differs from their install slug correctly show as installed and trigger the right install/uninstall path.
- **Attention classifier — multi-word gerunds and ticking counters** — `SPINNER_RE` widened from `[A-Za-z]+…` to `[A-Za-z][A-Za-z +\-]*…` so multi-word gerunds like `Installing + verifying on device…` match. New parallel `COUNTER_RE` matches CC's paren-wrapped `(Nm Ns · …)` seconds counter as an OR liveness signal. Active-vs-stalled now requires both same-glyph-for-30s AND counter-not-advancing — fixes spurious "still waiting on Claude" banners during real long thinking turns where CC pauses glyph rotation but keeps the counter live.
- **Desktop drawer card-flicker on chat re-renders** — `SkillCard` is now `React.memo`-wrapped with a stable comparator, and `FavoriteStar` lost a redundant `bg-panel/80 backdrop-blur-sm` that compositor-thrashed on every parent re-render. Chat re-rendering during a turn no longer makes drawer cards flash.
- **Long URLs/paths wrap inside chat bubbles** — `AssistantTurnBubble`, `UserMessage`, and the bubble container apply Tailwind `break-words` so unbroken paths and URLs wrap at character boundaries instead of overflowing the bubble width.

## [1.2.2] — 2026-04-29

**Claude Code CLI baseline:** v2.1.123

Wide-scope release. Tier 2 Android terminal rewrite (xterm in WebView replaces
native Termux TerminalView), opt-out anonymous telemetry, native Claude Code
installer, new productivity surfaces (Open Tasks, Context popup, Performance
Settings, Resume Browser filters, AUTO permission mode), mobile marketplace
polish, hardware back-button navigation on Android, echo-driven PTY submit,
vendored terminal-emulator at v0.118.1, plus ~50 fixes across desktop and Android.

### Added
- **Open Tasks tracker** — Status-bar chip + centered popup that surfaces every active TaskCreate/TaskList tool result across the active session. Toggleable, mark-inactive flow, grouped by status. Auto-deduplicates against per-session task IDs.
- **Context popup** — Status-bar context chip is now a button that opens a popup with `/compact` (split-button main click + chevron-driven focused-compact editor), `/clear` start-over, and an `(i)` explainer of what context window means. ESC / scrim / X all close cleanly.
- **Performance Settings** — New Performance section in SettingsPanel with discrete-GPU preference toggle, persisted to disk, applied to Chromium at startup; `usePerformanceConfig` renderer hook + `(i)` info explainer. Full `performance:*` IPC parity (desktop + Android stub) plus a new `app:restart` channel for re-applying GPU pref.
- **Resume Browser filters** — Project, Tag, and Sort pills above the conversation list. Filters persist across sessions.
- **AUTO permission mode** — New cycle position in the permission-mode toggle for CC v2.1.83+ classifier-backed auto-mode. Opus 4.7 1M only (gated by Anthropic plan/model).
- **Hardware back button (Android)** — `system:back` IPC + dismiss-stack listeners pop overlays in LIFO order before the activity quits.
- **Mobile-responsive marketplace** — Drawer keyboard handling, wallpaper backdrop, glass-on-close-X, swipe-to-cycle hero featured slots, rail clip + uncapped explore, real shadow room, no horizontal wiggle, glass toggles.
- **Local themes in Library** — User-built themes (e.g., from `/theme-builder`) now appear in the Library tab with a "Local" badge. Marketplace entries always win on slug collision. Synthesizer is pure (unit-testable). Android parity tracked separately.
- **Anonymous opt-out telemetry** — Install + DAU/MAU pings via the marketplace Cloudflare Worker. Random install ID, app version, platform/OS, country (server-side from CF-IPCountry — never sent from client). Opt-out toggle in About popup. Privacy-by-construction: `install_id` never logged outside `count(DISTINCT)` in the six admin SQL queries.
- **Native Claude Code installer** — `installClaude` now uses Anthropic's `claude.ai/install.{ps1,sh}` bootstrap script instead of `npm i -g`. Eliminates the `.cmd` shim chain entirely on Windows (sidesteps Node CVE-2024-27980 EINVAL on `.cmd`/`.bat` spawn). Android still uses npm — paths intentionally diverge.
- **Echo-driven PTY submit (desktop)** — `pty-worker.js` no longer relies on a 600ms enter-split for long messages on Windows ConPTY. New 3-path logic: passthrough for non-CR writes, atomic for `body + \r ≤ 56b`, echo-driven (chunk body in 56b pieces, wait for CC's stdout echo, then write a bare `\r`) for longer text. Empirically anchored to a CC-version-pinned snapshot; `cc-snapshot.mjs` baseline preserved in `desktop/test-conpty/snapshots/`.
- **Tier 2 Android terminal rewrite** — Native Termux `TerminalView` Compose block removed from `ChatScreen.kt`. xterm.js in the WebView is now the sole Android terminal renderer. Vendored `terminal-emulator-vendored/` (Termux v0.118.1, Apache 2.0) owns the PTY + emulator and exposes raw bytes via `pty:raw-bytes` (base64-encoded WebSocket push). xterm is display-only on touch (typing flows through React `InputBar`); custom touch-scroll handler routes to `terminal.scrollLines()`. Single-finger touch-scroll replaces native mouse drag.
- **In-app issue submission (Settings → Development)** — Tail logs, summarize via `claude -p`, file GitHub issue from inside the app. Six new IPC channels in cross-platform parity. Issue body assembled in main process so version + OS + platform info are correct. Workspace install can be re-run idempotently from the same surface.
- **Restore UX on Android** — Recent-50 conversations + status chip; Restore Wizard surfaces.
- **Statusbar widget config popup** — Per-widget reorder/hide controls.
- **Tool-card dev sandbox** — Standalone Vite mode (`?mode=tool-sandbox`) that renders every `.jsonl` fixture as a real `<ToolCard>`. HMR-driven iteration on `ToolBody.tsx` view designs without a live PTY session.
- **Worker test harness** — `desktop/test-conpty/test-worker-submit.mjs` runs the actual `pty-worker.js` (forked exactly as production) against real `claude` to verify all three submit paths.

### Changed
- **AttentionState union narrowed** to `'ok' | 'stuck' | 'session-died'`. The unused `'awaiting-input' | 'shell-idle' | 'error'` branches were removed in the 2026-04-26 audit because nothing dispatched them. `BufferClass` (internal to the classifier) is now distinct from the public `AttentionState`.
- **Spinner classifier rewritten** for CC v2.1.119+ — drops the obsolete `(Ns · esc to interrupt)` suffix requirement, adds glyph-rotation detection for active-vs-stalled (same glyph for ≥30s = stalled). Anchored to live `cc-snapshot.mjs` capture against CC v2.1.119; verified through v2.1.123. Probes at `desktop/test-conpty/test-spinner-fullcapture.mjs` + `test-attention-states.mjs`.
- **xterm overlay scrollbar** — Scrollbar now overlays the gutter rather than eating the rightmost terminal column. Per-platform CSS-only.
- **Project slug encoding** — All four caller sites (desktop transcript-watcher, desktop sync-service, Android TranscriptWatcher, Android SyncService) now encode space → dash, fixing chat view + sync for users with spaces in cwd.
- **Marketplace rail polish** — Card shadows, gutter alignment, side-edge scroll-out, tighter taglines, scoped shadow override via plain CSS (Tailwind arbitrary-shadow fights specificity in production builds). "Featured picks" filter chip (was "Destin's picks").
- **Subagent end_turn no longer pollutes parent model pill** — Per-turn `model` reconciliation skips subagent transcript lines.
- **GPU recovery on xterm WebGL context loss** — Renderer falls back gracefully instead of going blank.
- **Native installer is the desktop default** — Old npm path removed; Android still uses npm.

### Fixed
- **Self-heal installed-plugins list on Android** — Drift between `installed_plugins.json` and on-disk plugin dirs is reconciled at startup.
- **`system:back` dispatch on remote-shim** — Hardware back now reaches all overlay listeners.
- **Marketplace reviews button label** — "Install to review" when gated.
- **xterm.js mobile IME conflicts** — Resolved by `disableStdin: true` on touch + dedicated `InputBar` text path.
- **Personal-sync remote name self-heal** — Recovers from misnamed git remotes on the personal-backup repo.
- **Subagent end_turn pollution of parent model pill** (PR #83).
- **Android plugin discovery** (PR #82) — Self-heals from disk after install/uninstall.
- **Android Tier-A parity** — Status data, exec-resolve, menu navigation.

### Removed
- **Native Termux `TerminalView`** from `ChatScreen.kt` — superseded by xterm.js in WebView (Tier 2).
- **600ms enter-split** from desktop `pty-worker.js` — superseded by echo-driven submit. Android still uses 600ms gap.
- **`terminal-view` Maven dependency** (`com.github.termux.termux-app:terminal-view:v0.118.1`) — no longer needed after Tier 2.
- **Three legacy AttentionState branches** (`awaiting-input | shell-idle | error`) — never dispatched, removed in audit.

### Internal
- Vendored Termux `terminal-emulator` at v0.118.1 with a single documented `RawByteListener` patch. Apache 2.0 LICENSE + NOTICE co-located. See `terminal-emulator-vendored/VENDORED.md`.
- Project bumps `versionCode` 17 → 18.

## [1.2.1] — 2026-04-23

**Claude Code CLI baseline:** v2.1.119

### Added
- **Separate "YouCoded Dev" Android build** — debug APK now installs side-by-side with the release app (different `applicationIdSuffix`, label, and bridge port 9951). Both variants can coexist on the same device.
- **Soft-keyboard animation on Android** — chat input bar now smoothly tracks the Android soft keyboard via `visualViewport` + GPU translate, with the viewport meta tag configured so Android WebView fires the resize events reliably.
- **Bridge bind-failure overlay** — if both YouCoded variants are running, the one that loses the port race now shows a clear "another variant is running" screen instead of silently failing.

### Changed
- **Android git/gh authenticate like desktop** — OAuth token from `gh auth login` is now mirrored into `~/.netrc` (mode 0600) so `git push` over HTTPS works without `gh auth setup-git` (which can't run under Android's exec model).
- **Google Drive OAuth opens via Intent** — `rclone config create gdrive drive` now streams stderr, captures the auth URL, and opens it via `Intent.ACTION_VIEW` instead of relying on rclone's built-in browser-open (which rclone's Go runtime can't execute on Android).
- **Terminal toolbar restyled** — ESC/Tab/Ctrl/arrow keys are now quick chips inside the input bar, consistent with the mobile-first layout.
- **Floating status bar** — corners align with content, children clip correctly to edges, and there's breathing room below.

### Fixed
- **Android Resume Browser** slug decoding + missing `size` field — projects with hyphens in their directory name (e.g. `youcoded-dev`) now resolve correctly via greedy filesystem walk instead of collapsing to the wrong path.
- **Project slug encoding** now matches Claude Code for folders with spaces on Windows (e.g. `PAF 540 Final Data Project`) across both transcript-watcher and sync-service, on desktop and Android.
- **Chat input focus retention on Android** — the soft keyboard no longer dismisses when you release focus to global shortcuts (there are no global shortcuts on touch devices anyway).
- **`session:created` payload carries `model` on Android** — status-bar pill shows the correct model alias at session launch instead of defaulting until the first transcript event.
- **`status:data` broadcast carries `gitBranchMap` on Android** — git-branch widget now renders on Android matching desktop behavior.
- **Hide desktop-only settings on Android** — buddy floater toggle and "Sessions in this window" label no longer appear.
- **CI unblock** — removed invalid `@Volatile` on a local variable in `SyncService.authGdriveWithBrowserIntent`.

## [1.2.0] — 2026-04-22

**Claude Code CLI baseline:** v2.1.117

In-app update flow (changelog popup + download/launch installer), ESC stack +
chat-to-PTY interrupt, sync UX polish, marketplace integration polish, buddy
mascot drag rewrite, and assorted stability fixes.

### Added
- **In-app update installer** — Clicking "Update Now" in the version pill now
  downloads the platform-correct release asset (`.exe` / `.dmg` /
  `.AppImage`), shows throttled progress with cancel, then launches the
  installer. Mac DMG asset matching honors `process.arch`. Includes
  URL validation, safe filename derivation, stale-download sweep,
  cached-download lookup, platform-specific launch branches, and
  `YOUCODED_DEV_FAKE_UPDATE` env flag (gated on `!app.isPackaged`) with
  bundled dummy installers for manual verification. Five new IPC channels
  added in cross-platform parity (preload, remote-shim, ipc-handlers,
  Android stub: `UpdateInstallerStub.kt`).
- **In-app changelog popup** — Version pill click opens the new
  `UpdatePanel` showing the changelog filtered to versions newer than the
  installed build (uses CHANGELOG position, not semver, so version resets
  don't break the filter). Full-changelog mode also available.
  New `changelog-service` (fetch + cache + capped redirects + atomic write
  + graceful fallback) and shared `compareSemver` helper. Wired across
  preload, ipc-handlers, remote-shim, and Android stub via new
  `update:changelog` IPC.
- **ESC overlay stack + chat-to-PTY interrupt** — New `useEscClose` stack
  hook centralizes overlay dismissal so ESC pops the topmost overlay
  (LIFO). When no overlay is open and chat view has focus, ESC forwards a
  single byte to the active Claude session as an interrupt. New
  `TRANSCRIPT_INTERRUPT` reducer event detects `[Request interrupted by
  user]` markers in the transcript watcher and ends the in-flight turn
  with `stopReason: 'interrupted'` (renders an "Interrupted" footer on
  the affected turn bubble). 13 overlays migrated to `useEscClose`.
- **Ctrl+O expand/collapse all tool cards** — Toggles every tool card in
  the active chat between expanded and collapsed states.
- **Settings → Development popup polish** — New icons, centered layout, and
  follow-on integrations from the v1.1.2 dev panel: `platform:get` and
  `integrations:connect` IPCs (cross-platform parity) let the panel
  re-run an integration's `postInstallCommand` for already-installed
  entries. New `useCurrentPlatform` renderer hook (cached, single IPC
  per session) and `platform-display` shared helper (e.g. `darwin` →
  `macOS`) used in user-facing copy.
- **`platform:get` IPC** — Returns the current OS so renderer code can
  branch on it without scraping userAgent. Implemented in desktop main +
  Android `SessionService` for parity.
- **Marketplace `connect` action for installed integrations** — Re-runs an
  integration's `postInstallCommand` so users can refresh credentials or
  reconfigure without uninstall/reinstall. Integration entries now carry
  an optional `tags` field.
- **`locked` badge tone + "macOS Only" badge on platform-blocked cards** —
  Marketplace cards for platform-restricted integrations now show a
  distinct visual state with a clear platform note.

### Changed
- **Sync UX unified through `deriveSyncState` helper** — All sync UI surfaces
  (compact rows, per-backend dots, status-bar pill, syncpanel tiles) now
  derive their visual state from a single helper with exhaustive switch
  checks. Status-bar pill is now severity-aware (single pill instead of
  per-warning fan-out). Vestigial `SKILLS_UNROUTED` warning code removed.
  Sync setup wizard's per-backend dots include a loading gate so they
  don't flash an incorrect color before health-check completes.
- **Buddy mascot drag rewrite** — Anchor-based drag with rAF coalescing
  eliminates cursor drift and lag on long drag gestures. Replaces the
  prior pointer-delta model that accumulated rounding error.
- **Marketplace integration detail overlay rewritten** — Now shares parity
  with plugin detail overlay; `MarketplaceCard` consolidates rendering
  for both integrations and plugins (props: `iconUrl`, `accentColor`,
  `statusBadge`, `suppressCorner`).
- **Diff viewer line-number gutter collapsed** — Two-column gutter
  collapsed into a single line-number column for cleaner reading on
  narrow widths.
- **Site landing page polish** — Smoother intro (preload backdrops,
  fonts-ready gate, faster timing, nav clicks fast-forward), tagline
  updated to "Make Claude Yours", description meta refreshed. Install
  modal redesigned to show platform-specific install instructions
  *before* the download starts.

### Fixed
- **Filter-path crashes that wiped chat state** — Hardened renderer code
  paths that filter chat entries so a thrown predicate no longer aborts
  reducer state and silently empties the chat.
- **`/rate-limit-options` menu surfaces in chat view** — Was previously
  only routable from terminal view.
- **Theme picker flicker after install/uninstall** — Reload `userThemes`
  immediately after install/uninstall instead of waiting for the next
  poll.
- **About popup rounded corners + Package Tier popup centering** — Both
  popups now match the standard overlay surface treatment.
- **About popup header background** — Dropped opaque background so the
  header matches peer popups.
- **Post-install integration setup hint** — Replaces the fragile
  auto-type-into-PTY behavior with a setup-hint banner that shows the
  command for the user to run themselves.
- **CI `partykit-deploy` health check** — Treats the "No onRequest
  handler" 500 response as healthy (PartyKit returns this when the
  deployed worker has no HTTP handler — only WebSocket — which is
  correct for the lobby room).
- **Scroll-fade quirks** — Flush fades on conditional-mount, hook
  conditional-mount, rounded-corner clipping. Plus a `useScrollFade`
  hook lifecycle fix.

### Removed
- **`SyncService.kt` legacy hook scaffolding** — Drops 43 lines of dead
  code for the pre-app sync flow. Sync is now owned entirely by the
  desktop app's `sync-service.ts`.

## [1.1.2] — 2026-04-21

**Claude Code CLI baseline:** v2.1.117

Bundled default plugins, command-drawer commands subsystem, announcement system rebuild,
marketplace polish, and several stability fixes. Notable: a platform-detection bug was
silently mis-tagging packaged Windows installs as Android — fixed.

### Added
- **Settings → Development panel** — New row under Settings → Other opens a
  three-flow popup: (1) **Report a bug or feature** — three-screen wizard
  that pulls the last ~200 PTY lines from the active session, runs
  `claude -p` over stdin to summarize them into a structured issue body,
  redacts paths/tokens, then submits via `gh issue create` if `gh` is
  authenticated (auto-falls back to a browser URL-prefill if not). Labels
  the issue with `bug` or `enhancement` plus `youcoded-app:reported` on
  `itsdestin/youcoded`. (2) **Contribute to YouCoded** — clones
  `youcoded-dev` into a user-chosen folder (with progress streaming +
  idempotent re-install), registers it as a project folder in YouCoded's
  saved-folders list, and opens a fresh session in it with a prefilled
  prompt that orients new contributors. (3) **View known issues** —
  opens the GitHub issues list for `itsdestin/youcoded`. Cross-platform
  parity: desktop main implementation in `desktop/src/main/dev-tools.ts`,
  Android implementation in `app/.../runtime/DevTools.kt` and
  `SessionService.kt` `dev:*` IPC cases, mirrored in `remote-shim.ts` so
  remote browsers can use the panel too. New `dev:open-session-in`,
  `dev:install-workspace`, `dev:submit-issue`, `dev:summarize-issue`,
  `dev:log-tail` IPC channels.
- **Bundled default plugins** — `wecoded-themes-plugin` (Theme Builder) and
  `wecoded-marketplace-publisher` are now auto-installed on every desktop and Android
  launch. Uninstall is blocked at the UI layer (SkillCard / MarketplaceDetailOverlay)
  AND the IPC layer (`skills:uninstall` defense in both desktop main and Android
  `SessionService`). Single hardcoded list lives in `desktop/src/shared/bundled-plugins.ts`
  and `app/.../skills/BundledPlugins.kt` — both must stay in sync.
- **Commands in the CommandDrawer** — Slash commands now appear alongside skills in the
  drawer's search and a new dedicated browse mode. Three sources: YouCoded-handled
  (clickable, dispatched in-app — 9 entries), filesystem-scanned (user `~/.claude/commands`,
  project `.claude/commands`, plugin `commands/`), and Claude Code built-ins (visible
  reference list, marked "Run in Terminal View"). New IPC `commands:list` wired across
  desktop preload + ipc-handlers and Android SessionService + new `CommandProvider.kt`.
- **Announcement system rebuild** — Source of truth `announcements.txt` moved from
  `youcoded-core` to this repo (`itsdestin/youcoded/master/announcements.txt`). Single
  fetcher per platform: desktop `announcement-service.ts` (Electron main, 1h cadence) +
  Android `AnnouncementService.kt`. Shared `isExpired()` helper at
  `desktop/src/shared/announcement.ts` gates the StatusBar pill at render time so
  expired entries disappear at local midnight without waiting for the next fetch.
  Cleared announcements propagate as explicit `{message: null}` cache writes.
- **Marketplace install-state corner** — `InstallFavoriteCorner` primitive cycles
  download → braille spinner → unfavorited FavoriteStar on install complete.
  `IntegrationCard` retired; integrations now render through `MarketplaceCard` with
  `iconUrl`, `accentColor`, `statusBadge`, `suppressCorner` props. New
  `IntegrationDetailOverlay` for click-to-expand on integration tiles.
- **Plugin-name badge on skill cards** — Each skill card shows a clickable pill with
  the parent plugin's display name; clicking jumps to the plugin's marketplace
  detail overlay. Replaces an earlier (reverted) plugin-grouping experiment that
  showed one card per plugin.
- **Fix-action buttons in SyncPanel** — Sync warnings now carry actionable next-step
  buttons specific to each warning code.

### Changed
- **Sync timeouts bumped** — `RCLONE_TIMEOUT` 60s → 10 min, `GIT_TIMEOUT` 60s → 5 min,
  plugin-installer `GIT_TIMEOUT` 2 min → 5 min. The 60s rclone timeout was silently
  SIGTERM'ing mid-upload on large conversation slugs (one user has a 156 MB slug
  with a 25 MB single .jsonl) and the killed-by-Node case left `e.stderr` empty so
  the classifier fell through to UNKNOWN with no actionable message.
- **Sync error classifier expanded** — New `extractStderr()` helper detects
  `e.killed && e.signal` and injects a `TIMEOUT_SENTINEL` so the classifier can
  surface a real TIMEOUT diagnosis. Added `UNIVERSAL_PATTERNS` (TIMEOUT,
  LOCAL_DISK_FULL) that apply to any backend, drive-side
  RATE_LIMITED / PERMISSION_DENIED, and a full GitHub pattern set
  (AUTH, REPO_NOT_FOUND, LARGE_FILE, PUSH_REJECTED, NETWORK).
  11 new classifier tests (28/28 pass).
- **Sync pull failures surface immediately** — `pullDrive` and `pullGithub` now route
  through `recordBackendFailure` so first-run pull failures (CONFIG_MISSING,
  AUTH_EXPIRED) appear in the UI right away instead of waiting up to 15 min for
  the next push cycle. Pull success does NOT clear warnings — pull working doesn't
  prove push works.
- **Multiplayer lobby pong is liveness-only** — `LobbyRoom` no longer broadcasts the
  full presence list back on every 30s heartbeat. Drift self-heals on reconnect via
  the existing `presence` message in `onConnect`. Raises the practical lobby
  ceiling from ~200 to ~5k concurrent users (was O(N²) bandwidth per heartbeat).
- **Skill-id Uninstalls resolve to parent plugin** — `skill-provider.uninstall(id)`
  now looks up the skill's `pluginName` from `scanSkills` if the id doesn't match a
  plugin directly, then uninstalls that plugin. Fixes Library "Uninstall" buttons
  on bundled skills of legacy-marketplace plugins that were silently no-ops.
- **No more auto-favoriting on install** — The install-affordance corner now ends in
  an unfavorited star so the user sees a deliberate favorite click as a separate
  action.

### Fixed
- **Packaged desktop mis-tagged as Android** — `platform-bootstrap.ts` was checking
  `location.protocol === 'file:'` before `window.claude`, so packaged Electron on
  Windows (which loads via `win.loadFile()` and presents `file:` protocol) got
  `__PLATFORM__ = 'android'`. SettingsPanel rendered `<AndroidSettings>`, the tier
  picker appeared, session-switcher was limited to one session, and
  `html[data-platform="android"]` CSS hid theme backgrounds under the terminal.
  Now checks `window.claude` first (Electron preload populates it synchronously
  before any renderer JS runs); Android still falls through to the `file:` branch.
  Added `platform-bootstrap.test.ts` covering all four scenarios.
- **Android: remote pairing unblocked** — `network_security_config.xml` was only
  permitting cleartext WS to localhost and `*.ts.net`, but the desktop pairing URL
  encodes raw CGNAT IPs (e.g. 100.64.x.x) or LAN IPs. Android's NSC blocked the
  WebSocket at the OS level before any auth handshake, surfacing as the generic
  "Connection closed before auth". NSC now permits cleartext broadly per the
  documented threat model (Tailscale WireGuard underlay, LAN exposure parity with
  desktop, bcrypt-verified WS handshake regardless). `remote-shim`'s `onclose`
  also now differentiates reachability failures from post-open closes for a
  more actionable error message.
- **Subagent briefings no longer pollute the main chat** — Claude Code writes the
  parent Task prompt as the first user-role line of the subagent JSONL.
  `TRANSCRIPT_USER_MESSAGE` was missing the `parentAgentToolUseId` guard at all
  three layers (action type, dispatchers, reducer), so subagent briefings fell
  through and got appended to the main timeline as if the user had typed them.
  Stamped events are now dropped in the reducer; the briefing is already shown
  in the parent Agent card's Briefing section. Already-polluted sessions need
  `/clear` to recover.
- **Buddy floater fixes** — (1) Closing the viewed session in the main window left
  the floater stuck reading "no session" while the feed froze; BuddyChat now
  listens for `session:destroyed` and auto-switches. (2) Subagent activity was
  appearing inline in the main-line buddy feed; BubbleFeed now forwards
  `parentAgentToolUseId` / `agentId` / `model` so the reducer's subagent router
  kicks in. (3) Long URLs and unbreakable tokens overflowed the ~220px bubble
  width; added `overflow-wrap: anywhere` + `word-break: break-all` on anchors,
  scoped to buddy only.
- **Duplicate plugin-level placeholder cards in CommandDrawer** —
  `getInstalled()` was synthesizing a plugin-level `SkillEntry` from `configStore`
  even when `scanSkills` had already emitted individual skill entries; the dedup
  only compared skill ids, not pluginName. Now also skips synthesis when any
  scanned skill's `pluginName` matches the plugin id.
- **CommandProvider async fix** — `LocalSkillProvider.getInstalled()` is async, so
  the CommandProvider callback was silently passing a Promise to
  `mergeCommandSources`. Made `getCommands()` async.
- **CommandDrawer tile sizing** — Drawer SkillCards uniform-sized again with
  fixed h-32 + overflow-hidden. Chip rows switched to flex-nowrap; individual
  chips capped to max-w-[80px].
- **Marketplace overlay onDetailConsumed callback stabilized** — Memoized with
  `useCallback` to stop a setState-during-render warning that fired when the
  parent App re-rendered.
- **Per-turn metadata reaches buddy turns** — `BubbleFeed`'s
  `TRANSCRIPT_TURN_COMPLETE` dispatch now forwards `stopReason` / `model` /
  `anthropicRequestId` / `usage` to match `App.tsx`. (Release-review fix.)
- **Status badges restored on integration tiles** — Coming soon / Needs auth /
  Connected / Error / Deprecated labels were lost when `IntegrationCard` was
  retired. Generic `statusBadge` prop on `MarketplaceCard`.
- **CommandEntry type restored after merge** — Accidentally dropped during the
  feat/command-drawer-commands merge resolve.
- **Android: serviceScope cancelled on shutdown** — Three `serviceScope.launch`
  sites (bridge dispatcher, end-of-session sync push, bundled-plugin install)
  weren't cancelled in `onDestroy()`. Hygiene + tidies the bundled-install path
  on graceful service teardown.

### Removed
- **Dead UI components** — `ThemeDetail.tsx`, `ThemeCard.tsx`, `SignInButton.tsx`,
  `RestoreFromBackupButton.tsx`, `sign-in-button.test.tsx`, `IntegrationCard.tsx`,
  `SkillDetail.tsx`. All zero-import after the marketplace redesign / bundled-
  plugins consolidation.
- **`scripts/verify-deps.sh`** — Standalone Android ELF dep checker not invoked by
  any CI workflow, package.json script, or hook.
- **Legacy `desktop/hook-scripts/announcement-fetch.js`** + its 6h `setInterval`
  spawner in `ipc-handlers.ts` — superseded by the new TS announcement-service.
- **Undeployed glibc-on-Android research artifacts** — `native/execve-interceptor.c`,
  `native/glibc-loader.c`, `native/hello-glibc.c`, `native/libexec-intercept.so`.
  The 2026-03 spike concluded the approach was not the right path; the actual
  exec-routing solution shipped via termux-exec linker variant +
  linker64-env.sh wrappers.
- **Retired plan and design docs** — `docs/plans/` Phase 2 era plans + status spec,
  shipped/superseded plans for model selector, plugin marketplace, skill marketplace,
  generic menu parser, etc. Canonical specs in `docs/specs/` remain as reference.

### Protocol notes (for custom remote clients / automation)
- New WebSocket message type: `commands:list` (request) → `commands:list:response`.
  Returns the merged YouCoded + filesystem + CC-builtin slash command list.
- `transcript:event` `user-message` events now carry optional
  `parentAgentToolUseId` + `agentId` for subagent-routed events. Existing
  consumers can ignore these fields safely.

## [1.1.1] — 2026-04-20

**Claude Code CLI baseline:** v2.1.116

Patch release. Fixes the Windows CI test failure that blocked v1.1.0's desktop installer upload (Mac + Linux built fine, Windows test failed so the whole upload step was skipped and v1.1.0 shipped Android-only). Also ships the About popup and Android tier-picker styling polish.

### Added
- **About popup** — Replaces the inline collapsible About blocks in Desktop and Android settings with a shared `AboutPopup` rendered via `<Scrim>` + `<OverlayPanel>` at layer 2 with Escape-to-close and platform-specific privacy/licenses content. Matches the rest of the settings-menu popups (centered, glassmorphism from theme tokens, scrim-to-dismiss).
- **Android tier picker styling** — First-run `TierPickerScreen` Compose content wrapped in a dim-scrim + centered themed Surface so the package selector matches the popup aesthetic. Tier list scrolls inside the card; Continue stays pinned to the bottom.

### Fixed
- **Windows desktop installer CI** — `tests/ipc-handlers.test.ts` electron mock now includes `setAppUserModelId` (no-op). The AUMID hot-swap added in v1.1.0 calls this at `main.ts:159` on Windows during module load; desktop-ci runs Linux-only so the gap was invisible until v1.1.0's release matrix hit the Windows leg and skipped the installer upload. The test mock covers the call so Windows CI can complete the build → upload cycle.

### Notes
- v1.1.0's GitHub release has Android artifacts (APK + AAB) only. Users who want desktop installers should grab v1.1.1. The v1.1.0 → v1.1.1 upgrade is otherwise purely additive (UI polish + CI infra).

## [1.1.0] — 2026-04-20

**Claude Code CLI baseline:** v2.1.116

Headline: Buddy floater mascot companion, nested subagent timelines, typed sync warnings with fix-actions, per-turn transcript metadata, and three cross-cutting Windows PTY fixes.

### Added
- **Buddy floater** — A companion mascot window that floats above your desktop, reflects session attention state (idle vs. shocked), and opens an inline chat bubble on click. Session pill in the bubble lets you switch sessions or spawn a new one from the welcome screen. Multi-window session subscriptions + attention aggregation under the hood. Windows-only capture exclusion (via koffi + `SetWindowDisplayAffinity`, Win10 19041+) keeps the mascot out of screenshares. Toggleable in Settings.
- **Subagent threading** — When Claude invokes the `Agent` tool, its nested work (text, tool calls, results) now renders as a chat-style grouped timeline inside the parent tool card. Correlation by `parentAgentToolUseId` on both the desktop TranscriptWatcher and Android parity, with a directory-level SubagentWatcher tailing sub-session transcripts.
- **Typed sync warnings** — Replaces the old string-code sync warnings with a typed `SyncWarning[]` store (`~/.claude/.sync-warnings.json`). SyncPanel renders fix-action buttons per-warning; StatusBar chips stay in sync; a red dot appears on the Settings gear when danger-severity warnings exist. Health-check and per-backend push failures own non-overlapping codes.
- **Per-turn transcript metadata** — Every completing turn now carries `stopReason`, `model`, `usage` (input/output/cache-read/cache-creation tokens), and `anthropicRequestId`. Drives an opt-in per-turn metadata strip under assistant bubbles, an inline footer explaining non-`end_turn` stop reasons, and a session-pill model reconciliation effect that picks up `/model X` from the terminal, rate-limit downshifts, or resume drift. AttentionBanner now surfaces the Anthropic request ID on `session-died` / `error` so you can reference it when reporting issues.
- **Remote chat hydration** — New remote clients receive a full chat state snapshot via `chat:hydrate` immediately on connect, so they see full timelines without waiting for transcript replay. Replaces the old `transcriptBuffers` side channel.
- **Android IPC parity (4 new handlers)** — `marketplace:read-component`, `model:read-last`, `theme:list`, `theme:read-file`, `theme:write-file`. Android now handles the same read/write paths desktop does for marketplace and theme flows. `github:auth` upgraded from stub to real `/system/bin/linker64`-routed `gh` invocation.
- **Usage-limit prompt parser** — Recognizes Claude Code's usage-limit prompt as a titled Ink menu so the renderer can anchor its popover correctly and forward Arrow/Enter.
- **`docs/cc-dependencies.md`** — Spine doc mapping every YouCoded touchpoint that depends on Claude Code CLI behavior. Feeds the `review-cc-changes` release agent.
- **Dev profile isolation** — `scripts/run-dev.sh` now supports concurrent dev profiles via `YOUCODED_PROFILE` + `YOUCODED_PORT_OFFSET`, with hardened hook-path safety so the dev instance can't clobber the built app's `~/.claude/`.
- **Landing page redesign** — Word-cycling hero headline, theme crossfade, halftone animation, combined features/integrations flow, demo mockups rebuilt, gallery populated with screenshots, mobile-responsive scaling for mockup chrome + content, `#demo` anchor and "Installing now..." popup with platform-gated launch tips. Hosted at `itsdestin.github.io/youcoded`.
- **Root `CLAUDE.md` + `.claude/rules/android-runtime.md`** — Contributors opening Claude Code directly in this repo now get orientation + path-gated Android runtime rules.

### Changed
- **Dedup: `pending` flag, not content match** — User timeline entries carry a `pending` flag; `USER_PROMPT` always appends with `pending: true`, and `TRANSCRIPT_USER_MESSAGE` finds the oldest matching pending entry and clears the flag. Replaces the prior last-10-entries content match, which silently dropped legitimate rapid-fire duplicates (e.g. "yes" sent twice within five turns).
- **Opus label: 4.6 → 4.7** — Model selector display and chat header pill reflect the current model ID.
- **Integration install** — Now plugin-backed with icons and `postInstallCommand` support. `IntegrationReconciler` removed; install/sync flows simplified.
- **Multi-session lag** — Reducer, IPC, and transcript-watcher perf fixes for sessions in double digits. Measurable improvements in session-switch latency and chat-view scroll.
- **Model selector scoped to active session** — Changing model no longer affects other sessions; `SessionInfo` now includes the model.
- **Subagent view styling** — Chat-style grouped timeline with compact rows, card-styled sections, real ToolCard icons, and drop nested left border (parent card frames it).
- **Licensing clarified** — Desktop code = MIT, Android APK = GPLv3 (due to Termux). Root `LICENSE`, `desktop/LICENSE`, `app/LICENSE`, and README License section all state the split and invoke GPLv3 § 5 aggregation for the shared React UI.
- **Windows AUMID alignment** — Packaged taskbar icon now hot-swaps with theme.

### Fixed
- **PTY: long-text paste on Windows ConPTY + Ink** — `pty-worker.js` now splits `content + trailing \r` into two writes with a 600 ms gap to work around Ink's 500 ms `PASTE_TIMEOUT`, and chunks writes >64 bytes into 64-byte pieces with 50 ms gaps to work around ConPTY's silent byte drop on large writes. Paste of 2500+ chars now lands reliably.
- **PTY: resize dedup + debounce** — `TerminalView.fitAndSync` dedupes on unchanged cols/rows and debounces real resize IPCs to coalesce drag jitter. Previously, ConPTY re-emitted the Ink-rendered UI into xterm scrollback on every spurious resize.
- **Android marketplace / theme install** — Skill marketplace discovery, theme list/install/apply, and quick-chip defaults all unbroken after recent changes.
- **Android: pin Claude Code to 2.1.112** — Restores cli.js launch. Bootstrap now gates `isFullySetup` on cli.js existence, not just the install directory.
- **Android: TurnComplete metadata parity** — `TranscriptEvent.TurnComplete` + `TranscriptSerializer.turnComplete` now emit `stopReason` / `model` / `usage` / `anthropicRequestId`, so remote clients connecting to an Android session see the same per-turn metadata, StopReasonFooter, request-ID in AttentionBanner, and sessionModels reconciliation as desktop.
- **Sync: conversation tags survive reinstall/sync** (#52).
- **Chat: rare message loss from dedup + emit-throw races** — `readNewLines` isolates each emit in try/catch so a throwing listener can't strand subsequent chunks in the batch.
- **Chat: `stopReason` footer only on non-`end_turn`** — Normal completions no longer render the explainer.
- **Input bar cursor drift + text selection** on narrow/Android and long text.
- **Theme inline-code color derived from tokens** — No longer hardcoded; adapts to the active theme.
- **Desktop file picker defaults to all file types** — Was defaulting to a filtered subset.
- **Session strip overflow** — `+N` badge for sessions that don't fit.
- **Reconnect copy** — Sync setup wizard reconnect flow steers the user to the same Google account.
- **Status: preserve last-known session chip values across poll misses** — Transient read failures no longer blank context / git-branch / session stats.
- **Header: set `__PLATFORM__` synchronously** so module-level `isAndroid()` works correctly; Android chat/terminal toggle stays on the right side.
- **Icon: desktop app icon rebranded DC → YC.**

### Removed
- **Dead transcript-buffer replay** in the remote server — superseded by `chat:hydrate`.
- **`IntegrationReconciler` + `integration-context.md` generation** — Integration install is plugin-backed now.

### Protocol notes (for custom remote clients / automation)
- `chat:hydrate` is a new WebSocket message sent once per authenticated remote connection, carrying a serialized `ChatState`. Old `transcript-buffer` replay is gone.
- `remote:attention-changed` (renderer → main) and `attentionMap` in `status:data` (main → remote) keep remote browsers in sync with desktop's `AttentionState`.
- `transcript:event` `turn-complete` events now carry `{stopReason, model, usage, anthropicRequestId}` in their `data` field on both desktop and Android. Consumers that previously treated this as an empty object should now read the new fields.
- Subagent-tagged events (`assistant-text`, `tool-use`, `tool-result`) carry optional `parentAgentToolUseId` + `agentId`.

## [1.0.1] — 2026-04-15

### Fixed
- **DC → YC monogram everywhere** — SkillCard badge label and Android launcher adaptive icon + monochrome variant. The "D" glyph in the launcher icons was retraced from Consolas Bold as a "Y" to match the existing "C" glyph's styling.
- **First-party plugin prefix matching** — `skill-scanner.ts`, `sync-service.ts`, and Android `SkillScanner.kt` used `startsWith('youcoded-core')` after the rebrand sed, which missed sibling first-party plugins (`youcoded-encyclopedia`, `youcoded-inbox`, etc.). Now matches `startsWith('youcoded')`.

## [1.0.0] — 2026-04-15

Rebrand release. DestinCode is now YouCoded. All app identifiers, config file names, localStorage keys, IPC names, and user-visible strings updated. This is a fresh v1 line — the old v2.x series was DestinCode.

### Changed
- **App name** — DestinCode → YouCoded. Window title, installers, and menus all reflect the new name.
- **Electron appId** — `com.destinclaude.desktop` → `com.youcoded.desktop`.
- **Android applicationId / package** — `com.destin.code` → `com.youcoded.app`. All Kotlin sources moved to the new package tree.
- **URI scheme** — `destincode://` → `youcoded://` for skill and plugin deep links.
- **Marketplace ID** — The Claude Code registry key is now `youcoded` (was `destincode`). Plugin IDs carry the `@youcoded` suffix in `enabledPlugins`.
- **Config paths** — All `~/.claude/destincode-*.json` files renamed to `~/.claude/youcoded-*.json` (remote, skills, model, appearance, defaults, folders, model-modes).
- **localStorage keys** — `destincode-theme`, `destincode-font`, `destincode-reduced-effects`, `destincode-show-timestamps`, `destincode-statusbar-widgets`, `destincode-remote-token`, `destincode-sound-*`, etc. all renamed to the `youcoded-` prefix.
- **Env vars** — `DESTINCODE_PORT_OFFSET`, `DESTINCODE_PROFILE`, `DESTINCODE_MARKETPLACE_BRANCH` renamed to the `YOUCODED_` prefix.
- **PartyKit** — Multiplayer lobby moved from `destinclaude-games.itsdestin.partykit.dev` to `youcoded-games.itsdestin.partykit.dev`. Old project deleted.
- **GitHub URLs** — All internal references updated: `itsdestin/destincode` → `itsdestin/youcoded`, `itsdestin/destincode-marketplace` → `itsdestin/wecoded-marketplace`, `itsdestin/destinclaude-themes` → `itsdestin/wecoded-themes`, `itsdestin/destinclaude` → `itsdestin/youcoded-core`.
- **Android keystore alias** — `destincode` → `youcoded`. A fresh keystore is required for signed release builds.

## [2.4.0] — 2026-04-15

Headline: marketplace auth, attention classifier, parsed tool cards, glassmorphism overhaul, and the app now owns DestinClaude toolkit reconciliation.

### Added
- **Marketplace authentication** — Sign in with GitHub via the OAuth device flow. Installs, ratings, likes, and reports are now tied to your account. Token storage hardened (cookie-bound CSRF, no raw token at rest).
- **Attention classifier** — Replaces the old 30-second "thinking" timer with a per-second PTY-buffer classifier. New `AttentionBanner` surfaces five distinct states (`awaiting-input`, `shell-idle`, `error`, `stuck`, `session-died`) with banner copy that explains what's happening.
- **Parsed tool-card views** — Edit / Write / Bash / Read / TodoWrite / Agent / Grep / Glob / WebFetch / TaskUpdate now render with a preview-and-expand interface instead of raw JSON blobs.
- **Chrome-style session tear-off** — Drag a session pill out of the SessionStrip to detach it into its own window; drag back to reattach.
- **Per-theme transparency sliders** — Panel Blur, Panel Opacity, Bubble Blur, and Bubble Opacity are now per-theme settings (with a pencil-per-theme editor in Appearance) rather than global. Reduce Effects forces blur off but preserves your opacity intent.
- **Combined model + effort pill** — StatusBar pill collapses model and reasoning effort into a single control with a fast-mode cost warning.
- **Game lobby reconnect** — Real reconnect path with accurate error hints when the room is full or the opponent left.
- **Cross-destination drawer buttons** — Jump between marketplace and library (Library tile dropped in favor of explicit destination buttons).
- **Notification sound picker** — `dialog:open-sound` IPC for choosing custom notification sounds (desktop only).
- **Per-platform header layout** — Chat/terminal toggle moves to the side opposite the OS window controls (left on Windows/Linux, right on macOS). Header packing is space-aware, not viewport-aware.
- **Announcement widget** — Moved from the header into a default-visible StatusBar widget under "Updates."
- **Theme hot-swap window/dock icon** — Active theme controls the OS-level icon.
- **Compounding wheel-scroll acceleration** — Scrolling builds momentum the longer you scroll.
- **Dev port + userData isolation** — `scripts/run-dev.sh` shifts ports (Vite 5173→5223, remote 9900→9950) and splits Electron `userData` so dev coexists with the built app.

### Changed
- **Glassmorphism is fully variable-driven** — All glass surfaces read `--panels-blur` / `--panels-opacity` / `--bubble-blur` / `--bubble-opacity` directly. The old `[data-panels-blur]` attribute gate is gone; blur and opacity are independent knobs.
- **Bottom chrome scroll-behind** — Input + status bars float over chat with frosted glass, padded via ResizeObserver.
- **Plugin install paths** — Marketplace plugins now install under `~/.claude/plugins/marketplaces/destincode/plugins/<id>/` (was `~/.claude/marketplaces/...`); `installed_plugins.json` lives at `~/.claude/plugins/installed_plugins.json` (was `~/.claude/installed_plugins.json`). Both moves match Claude Code v2.1+ expectations — plugins installed against the old paths are invisible to the CLI.
- **Plugin discovery uses four registries** — `ClaudeCodeRegistry` writes `settings.json` (`enabledPlugins`), `installed_plugins.json`, `known_marketplaces.json`, and `marketplaces/<src>/.claude-plugin/marketplace.json` atomically. Without all four, `/reload-plugins` reports zero new plugins.
- **Theme file watcher** — `chokidar` replaces `fs.watch`; recursive directory hot-reload is now reliable on macOS and Windows.
- **Theme publish upload** — Body piped via stdin with a pre-flight size check (no more silent failure on large themes).
- **Network security config** — Tailscale `*.ts.net` cleartext exception now documented inline (traffic still rides inside the WireGuard tunnel).

### Fixed
- **Hook reconciler now prunes dead plugin entries** — On every app launch, `settings.json` hook entries that point inside a plugin root at a missing file are removed. Cleans up stale registrations from the DestinClaude phase-3 decomposition (sync, title-update, todo-capture, checklist-reminder, done-sound, session-end-sync, contribution-detector, check-inbox). Never touches user-added hooks.
- **Orphan symlinks cleaned up** — New `cleanupOrphanSymlinks()` startup sweep removes broken `~/.claude/{hooks,commands,skills}/` symlinks pointing into deleted toolkit subtrees. Claude Code v2.1+ doesn't read these dirs anyway, but they were visible clutter.
- **Wizard symlink block dropped** — The DestinCode app no longer creates `setup-wizard` symlinks in `~/.claude/skills/` or `~/.claude/commands/` during toolkit clone — those paths were broken post-decomposition and Claude Code discovers commands/skills via `plugin.json` regardless.
- **Game presence + remote access status** — Various reliability fixes (per 2.3.2 follow-on commits).
- **Toggle pill** — Cached endpoints survive label visibility flip.
- **Glass UX** — Reduce Effects now lives above the Glass sliders; sliders hide entirely when Reduce Effects is on; sliders only show on themes with wallpapers.
- **Diag panel removed** — From theme settings (was leftover debug surface).
- **Bootstrap.kt** — Removed duplicate `bashPath` declaration that broke Android build under newer Kotlin.

### Removed
- **`gmessages` integration** — Pre-built Go binary and related setup paths.
- **Setup-wizard symlink creation in `prerequisite-installer.ts`** — Dead code from pre-decomposition layout.
- **`desktop/electron-debug.log`** — Was committed by accident; `*.log` now in `.gitignore`.

### Backend
- **Cloudflare Worker (marketplace)** — OAuth device flow hardened. CI deploy order locked: `migrations apply --remote` → `deploy` → `secret put` (avoids `Binding name already in use`).
- **PartyKit** — Server changes deploy automatically via `partykit-deploy` workflow.

## [2.3.2] — 2026-04-08

### Added
- **AskUserQuestion UI** — multiple-choice option selection with keyboard nav (Arrow Up/Down, Enter, Ctrl+Enter to submit)
- **Notification sounds** — selectable Web Audio presets for completion, attention (red status), and ready (blue status) events with per-category toggles
- **Welcome screen form** — expandable New Session with project folder, model picker, and skip-permissions toggle; Resume Session button
- **Glassmorphism sliders** — Panel Blur, Panel Opacity, Bubble Blur, Bubble Opacity controls in appearance settings
- **Appearance persistence** — theme, cycle list, reduced effects, and timestamps now persist to disk across app restarts (localStorage kept as FOUC cache)
- **Sync Management UI** — visual control plane for DestinClaude sync in Settings (backend cards, force sync, warning resolution, config editor, log viewer)
- **Keyboard shortcuts** — Ctrl+` toggles chat/terminal view; shortcuts help panel in settings

### Fixed
- **Enter key stolen by ToolCard** — global Enter handler no longer intercepts when user is typing in InputBar textarea
- **Paste fails after idle blur** — Ctrl+V refocuses textarea; paste resets idle timer
- **PTY paste swallowed** — text and Enter sent as separate PTY writes with 50ms delay so Ink processes them in distinct read cycles
- **Initializing overlay covers chrome** — lowered z-index so glassmorphism header/bottom bars remain accessible
- **Game presence** — server pong returns full user list every 30s for self-correction; challenge-failed feedback when target offline; green dot checks connected state
- **Remote access status** — green only when remote enabled + Tailscale installed + VPN active
- **Android session:destroyed** — broadcast added so React UI removes closed sessions from selector (desktop parity)
- **Glass dropdown blur** — portaled to #root for live content backdrop-filter; removed transform-based centering that broke Chromium compositing
- **Bubble blur slider** — engine override rules injected after theme custom_css to ensure manifest fields take precedence
- **macOS traffic lights** — overlay-header padding on all overlay screens; fullscreen state relay removes padding when traffic lights disappear
- **Session dropdown corners** — child backgrounds clipped to container border-radius

### Changed
- **Glassmorphism CSS** — all glass rules now use --panels-blur and --panel-glass CSS variables (slider-controlled in real-time)
- **Bottom chrome scroll-behind** — input + status bars absolutely positioned with ResizeObserver-driven padding so chat scrolls behind frosted glass
- **Sound settings** — converted from inline section to popout panel with master volume, per-category toggles, and preset selectors

## [2.3.1] — 2026-04-08

### Added
- **Message timestamps** — Show time sent in each chat bubble (e.g. "2:34 PM"). Toggleable via "Message Timestamps" switch in the appearance popup.
- **Donate confirmation modal** — Themed confirmation dialog before opening BMC donation link, matching existing popup patterns. Applied to both Android and desktop settings.
- **Desktop test build CI** — Manual `desktop-test-build.yml` workflow builds .exe/.dmg/.AppImage on all 3 platforms without versioning or release upload.

### Changed
- **Terminal font** — Hardcoded to Cascadia Code with Consolas/monospace fallbacks. User font selection now only affects the chat UI.
- **Terminal wallpaper** — Uses container opacity (0.88) instead of backdrop-filter/transparent xterm. WebGL renderer stays always loaded for performance.
- **Remote setup** — "Set Up Remote Access" button now drives Tailscale install/auth via IPC instead of sending `/remote-setup` to a Claude session. Shows confirmation, progress states, and auto-detects if Tailscale is already installed.
- **Hidden terminals** — Collapse to 0x0 instead of visibility:hidden alone, eliminating scrollbar overlap from multiple sessions.
- **Add Device button** — Always visible when Tailscale installed + password set.

### Fixed
- **Glassmorphism toggle** — Restored "Reduce Visual Effects" toggle removed in a prior refactor.
- **Session browser retries** — readdir/stat calls retry up to 3x with increasing delay to handle Windows antivirus/search indexer transient locks.
- **App icon path** — electron-builder now points to `assets/` instead of nonexistent `build/`. Icon upgraded to 512x512 for macOS .icns requirement.
- **Settings close button** — Inline `-webkit-app-region: no-drag` on panel, backdrop, and close button to bypass Electron's OS-level drag hit-test.
- **Hidden terminal paste** — xterm.js paste handler no longer fires on collapsed terminals, preventing bracketed paste from reaching the PTY when pasting into the chat input.
- **Terminal text bunching** — fitAddon.fit() skips when container is 0x0 and fits twice on visibility change to catch slow browser reflows.
- **Folder switcher** — Centered dropdown with `left-1/2 + translateX(-50%)`. Fixed duplicate style attribute that broke tsc compilation.

## [2.3.0] — 2026-04-07

First unified release. Desktop and Android now share the same version number and release from a single `v*` tag.

### Added
- **Desktop app** — Full Electron app with React UI, now lives in this repo alongside the Android app.
- **Theme system** — Theme packs with custom colors, patterns, particles, glassmorphism, wallpapers, mascots, and icon overrides. Includes theme editor in settings.
- **Theme marketplace** — Browse, install, preview, and publish community themes.
- **Skill marketplace** — Browse, search, install, and share Claude Code plugins. Favorites, quick chips, and curated defaults.
- **Multiplayer games** — Connect 4 via PartyKit (Cloudflare Durable Objects) with lobby, challenges, reconnection, and incognito mode.
- **Remote access** — Built-in HTTP + WebSocket server for browser-based access from any device. Password auth + Tailscale trust.
- **First-run setup wizard (Desktop)** — Zero-terminal onboarding: detects prerequisites, installs Claude Code, handles OAuth sign-in.
- **Session resume** — Browse and resume past Claude Code sessions with history loading.
- **Folder switcher** — Quick-access saved directories for session creation.
- **Model selector** — Cycle between Claude models with persistence and transcript verification.
- **Desktop CI** — New `desktop-ci.yml` runs vitest + tsc on every push. `android-ci.yml` now runs `./gradlew test`.
- **Unified release tags** — Single `v*` tag triggers both `android-release.yml` and `desktop-release.yml`.

### Changed
- **CI consolidation** — Renamed workflows to `{platform}-{purpose}.yml` convention. Standardized all actions to `@v4`.
- **Release APKs** — `android-release.yml` now runs `build-web-ui.sh` so release APKs include the full React UI instead of placeholders.
- **License** — Split licensing: MIT for desktop (`desktop/LICENSE`), GPLv3 for Android (root `LICENSE`).

### Fixed
- **Auto-approve safety** — AskUserQuestion prompts are no longer auto-approved in dangerous mode; they now require actual user input.
- **Protocol parity** — Theme API calls no longer crash on Android/remote (optional chaining guards). Session status uses consistent `"destroyed"` value across platforms. Added `model.readLastModel` stub and `session.switch` handler for cross-platform consistency.
- **Security hardening** — Remote access server defaults to disabled. Cleartext traffic scoped to localhost only. Deep link skill imports now require user confirmation. Plaintext password no longer persisted to disk.
- **Android runtime** — Restored `claude-wrapper.js` asset file as canonical source. Replaced `isRunning` polling with reactive `sessionFinished` StateFlow for instant session death detection.
- **Remote access** — Added folder switcher handlers to remote server.
- **13 broken desktop tests** — session-manager (missing electron mock), transcript-reducer (updated for turn-based model), transcript-watcher (async read timing), theme-preview-sync (cross-repo path).
- **TypeScript error** — Aligned `onResumeSession` callback signature across App, HeaderBar, SessionStrip.
- **Android protocol** — Added `game:getIncognito`/`game:setIncognito` IPC handlers.
- **Execute bits** — Set +x on all 6 shell scripts.
- **build-web-ui.sh** — Added build output existence check with clear error message.

## [1.0.0] — 2026-03-20

First stable release. DestinCode runs Claude Code natively on Android with a touch-optimized chat and terminal interface.

### Core
- Native Android app (Kotlin + Jetpack Compose) running Claude Code via embedded Termux runtime
- 3-layer SELinux bypass routing all binary execution through `/system/bin/linker64`
- Claude Code JS wrapper (`claude-wrapper.js`) patches Node.js `child_process` and `fs` for on-device compatibility
- Foreground service keeps sessions alive in background
- Bootstrap system downloads and extracts Termux `.deb` packages with SHA256 verification

### Chat Interface
- Chat view with structured message rendering (user bubbles, Claude responses, tool cards)
- Tool cards: Running, Awaiting Approval, Complete, Failed states with expandable details
- Markdown rendering with syntax highlighting
- Interactive prompt buttons for Claude Code setup menus (theme, login, trust folder)
- Generic Ink Select menu parser — auto-detects numbered menus from terminal output
- Hardcoded fallback for multi-line menus (login method selection)
- Activity indicator ("Working...", "Reading...") during Claude processing
- URL detection with tappable link pills
- Image attachment support via file picker
- Quick action chips (journal, inbox, briefing, draft)
- Auto-scroll on new messages

### Terminal Interface
- Full terminal emulator via Termux `TerminalView` with raw PTY access
- Floating up/down arrow buttons overlaid on terminal view (for Ink menu navigation)
- Terminal keyboard row: Ctrl, Esc, Tab, left/right arrows
- Permission mode pill with canvas-drawn play/pause icons (Normal ▶, Auto-Accept ▶▶, Bypass ▶▶▶, Plan Mode ⏸)
- Optimistic permission mode cycling with screen-poll correction
- Bypass mode excluded from cycle in non-dangerous sessions
- Shared input draft across Chat, Terminal, and Shell modes

### Shell Mode
- Direct bash shell (long-press terminal icon) via `DirectShellBridge`
- Independent from Claude Code session — no parser, no hooks

### Multi-Session
- Up to 5 concurrent Claude Code sessions
- Session switcher dropdown with color-coded status indicators (Active, Idle, Awaiting Approval, Dead)
- Session creation dialog with working directory selection
- Session destroy and relaunch support
- Auto-titling from Claude Code session files

### Theming
- Default Dark and Light themes with neutral terminal-style colors
- Material You (Dynamic Color) support: Material Dark and Material Light pull accent colors from wallpaper
- Theme selector in app menu with 4 options
- Cascadia Mono font throughout

### Events & Hooks
- Unix socket event bridge (`hook-relay.js` → `EventBridge`) for structured hook events
- Hook event types: PreToolUse, PostToolUse, PostToolUseFailure, Stop, Notification
- Permission prompt detection from notification events with 2/3-option support
- Screen text polling for interactive prompt and permission mode detection

### Icon
- Custom adaptive icon with terminal window, chevron prompt, "DC" monogram, and cursor block
- Scaled to adaptive icon safe zone for Samsung launcher compatibility

## [0.2.0] — 2026-03-15

Phase 2: Hook-based architecture rebuild.

### Changed
- Replaced heuristic text parser with structured hook event system
- Rewrote ChatState with 7 message content types
- Added ToolCard with Running/AwaitingApproval/Complete/Failed states
- Added animated activity indicator
- Deployed `hook-relay.js` and `EventBridge` socket server

### Fixed
- SELinux exec permission for subprocess binaries
- Browser-based OAuth on Android
- Shell detection (`CLAUDE_CODE_SHELL` with bash path)
- Git HTTPS auth with `.netrc` credential sync

## [0.1.0] — 2026-03-14

Initial prototype. Chat UI with heuristic text parsing, basic terminal panel, approval detection.
