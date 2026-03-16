# Claude Mobile Phase 2 — Spec

**Version:** 2.1
**Last updated:** 2026-03-16
**Feature location:** `~/claude-mobile/` (Android app), key files: `runtime/PtyBridge.kt`, `runtime/Bootstrap.kt`, `ui/TerminalPanel.kt`, `ui/ChatScreen.kt`, `parser/EventBridge.kt`

## Purpose

Claude Mobile Phase 2 adds three interaction modes to the Android app: a **Chat** view (hooks-based structured events), a full-screen **Terminal** view (raw PTY), and a **Shell** view (standalone bash). The Terminal view renders Claude Code's output directly from the Termux `TerminalEmulator` screen buffer and is the ground-truth fallback. The Chat view receives structured events from Claude Code hooks (PreToolUse, PostToolUse, PostToolUseFailure, Stop, Notification) via a Unix socket relay, rendering tool cards, approval prompts, and response bubbles without any terminal parsing. The Shell view provides direct bash access with the same linker64/BASH_ENV environment.

**Related documents:**
- **Phase 1 spec:** `~/docs/superpowers/specs/claude-mobile-android-design-spec.md`
- **Phase 2 design:** `docs/plans/phase2-design (03-15-2026).md` (frozen artifact)
- **Phase 2 plan:** `docs/plans/phase2-plan (03-15-2026).md` (frozen artifact)
- **Chat rebuild design:** `docs/plans/chat-rebuild-design (03-15-2026).md` (frozen artifact)
- **Chat rebuild plan:** `docs/plans/chat-rebuild-plan (03-15-2026).md` (frozen artifact)

## User Mandates

- Terminal view must remain production-ready — it is the ground truth for all Claude Code output and the fallback for any chat view failures (2026-03-15)
- Shell workarounds (linker64 functions, BASH_ENV, SELinux bypasses) must be preserved — they are the only way to run embedded binaries on Android without root (2026-03-15)
- Chat rebuild must use hooks-based architecture — direct structured events from Claude Code, not heuristic parsing of terminal text (2026-03-15)
- `claude-wrapper.js` monkey-patches must fail silently — never disrupt Claude Code's operation (2026-03-15)

## Design Decisions

| Decision | Rationale | Alternatives considered |
|----------|-----------|----------------------|
| Canvas-based terminal rendering from `TerminalEmulator` screen buffer | Termux library already maintains full ANSI state — no separate VT100 parser needed. Cell-by-cell rendering gives correct colors/attributes. | WebView-based terminal (rejected: heavyweight, harder to integrate with Compose), custom ANSI parser (rejected: duplicates Termux's work) |
| `drawRect()` not `nativeCanvas.drawColor()` for terminal background | `drawColor()` paints the entire window surface, not just composable bounds — caused top bar to be invisible for several iterations | `nativeCanvas.drawColor()` (rejected: paints beyond composable bounds) |
| PTY byte counter for activity signal instead of content parsing | Simple timestamp tracking (`lastPtyOutputTime`) tells the UI Claude is working without any content analysis. Sub-millisecond overhead. | Content-based activity detection (rejected: adds parsing complexity for no benefit) |
| Hooks-based chat rebuild (replacing parser sidecar) | Claude Code's hooks provide structured events (tool calls, responses, approvals) directly — eliminates the entire heuristic parsing pipeline that caused 6 documented failure modes | Screen-state-aware parser (considered: reads terminal buffer periodically, but still requires heuristic classification), improved line-by-line parser (rejected: fundamentally reactive approach) |
| Three-tier `spawnFix()` in claude-wrapper.js | Android SELinux blocks direct `execve()` on app binaries; different spawn patterns (shell+EB, shell+non-EB, no-shell+EB) need different fixes. Unified function handles all cases. | Single fix strategy (rejected: no one approach handles all spawn patterns), termux-exec LD_PRELOAD (insufficient: prebuilt .so has hardcoded Termux prefix) |
| Kotlin-generated BASH_ENV shell functions (not shell-generated) | Earlier shell-based approach with `eval`/`for` loops failed due to `$@` escaping — `eval` expanded `$@` prematurely, producing functions that lost arguments. Static Kotlin generation eliminates all shell escaping. | Shell `eval` + `for` loop (rejected: `$@` escaping issues), per-binary wrapper scripts (rejected: hundreds of files in `usr/bin/`) |
| ELF detection via magic bytes for binary wrapping | `linker64` only loads ELF binaries — script files (e.g., `claude`, `npm`) need the interpreter routed through linker64 instead. Reading 512 bytes to detect `\x7fELF` vs shebang determines the correct invocation pattern. | Blind wrapping with `linker64 binary "$@"` (rejected: fails for scripts) |
| Shell bypass for EB+shell spawn commands | Fixed shell binary (`PREFIX/bin/bash`) still can't be directly `execve()`d due to SELinux; `termux-exec` doesn't intercept for custom prefix. Bypassing the shell entirely for EB commands avoids the problem. | Fix shell path only (rejected: SELinux still blocks the fixed shell binary) |
| Command string splitting on `\s+` for EB+shell case | Works for hook commands (simple `binary arg` patterns). Acceptable because EB+shell only triggers for machine-generated paths from hook config, never user-authored commands with quoted spaces. | Full shell parsing (rejected: unnecessary complexity for machine-generated commands) |
| On-demand git install (not bundled) | Most phone workflows (journaling, inbox, briefings) don't need git. Saves ~15-20MB on initial install. | Bundle in APK (rejected: bloats initial install for rarely-used feature) |
| `apt.conf` overrides for package management | Termux-compiled `apt`/`dpkg` have hardcoded `/data/data/com.termux/` paths. Can't symlink without root. `APT_CONFIG` + `--admindir` flags redirect at runtime. | Recompile apt/dpkg (rejected: massive effort), symlink (rejected: requires root) |

## Current Implementation

### What Was Built (81 commits)

#### Terminal View — Production Ready

A full-screen terminal emulator that renders Claude Code's output directly from the Termux `TerminalEmulator` screen buffer.

**Architecture:**
- `TerminalPanel.kt` — Compose `Canvas` that reads `TerminalRow` data cell-by-cell from `TerminalBuffer`, rendering characters with correct foreground/background colors and attributes (bold, underline, inverse)
- Font size auto-calculated via binary search to fit 60 columns in screen width
- `TerminalKeyboardRow.kt` — pill-styled buttons for Ctrl, Esc, Tab, arrow keys (Material icons), and Enter
- Text input field with Cascadia Mono font, sends raw keystrokes via `\r` (carriage return)
- `PtyBridge.screenVersion` StateFlow triggers Canvas recomposition on every `onTextChanged`

**Key technical details:**
- Canvas `fillMaxSize()` removed from modifier chain — conflicted with `weight()` in Column layout
- Terminal redraws on ALL `onTextChanged` calls, including when transcript shrinks (ink menu redraws)
- Initial emulator size matches panel size (60x40) to prevent resize mismatch with ink menus

**Status:** Fully functional. Users can navigate Claude Code's first-run menus (theme picker, login method, OAuth), type commands, paste auth codes, and interact normally. Arrow keys, escape sequences, and Ctrl modifiers work correctly.

#### Chat View — Hooks-Based (Rebuilt)

A message-based view that receives structured events directly from Claude Code hooks, bypassing terminal parsing entirely. The old parser sidecar (`parser.js`, `patterns.js`, `ParsedEvent.kt`) and all heuristic parsing code have been deleted.

**Architecture:**
- `hook-relay.js` (~10 lines) — Claude Code hook script that reads stdin JSON and writes to an Android abstract-namespace Unix socket
- `EventBridge.kt` — `LocalServerSocket` that accepts hook-relay connections, parses JSON, emits `HookEvent` via `SharedFlow` (buffer: 1000)
- `HookEvent.kt` — sealed class with 5 variants: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`
- `ChatState.kt` — 7 `MessageContent` variants (`Text`, `Response`, `ToolRunning`, `ToolAwaitingApproval`, `ToolComplete`, `ToolFailed`, `SystemNotice`) with tool state machine transitions
- `ChatScreen.kt` — collects `EventBridge.events`, routes each hook type to the appropriate `ChatState` mutation
- `MessageBubble.kt` — routes content types to card composables (ToolCard, CodeCard, ErrorCard) or text bubbles

**Event routing:**
- `PreToolUse` → adds `ToolRunning` message (extracts args summary from `command`/`file_path`/`pattern` fields)
- `PostToolUse` → finds matching card by `toolUseId`, transitions to `ToolComplete`
- `PostToolUseFailure` → finds matching card by `toolUseId`, transitions to `ToolFailed`
- `Stop` → adds `Response` message with `lastAssistantMessage`
- `Notification` → if `permission_prompt`, transitions last `ToolRunning` to `ToolAwaitingApproval`; otherwise adds `SystemNotice`

**Approval flow:**
- Primary: `Notification` hook with `notificationType == "permission_prompt"`
- Fallback: 2-second PTY silence heuristic (if `ToolRunning` persists and no PTY output for 2s, assume approval needed)
- UI: ToolCard expands to show mini-terminal (160dp) + Accept/Reject buttons
- Actions: Accept sends `\r` (Enter), Reject sends `\u001b` (Esc) via `PtyBridge.sendApproval()`

**Activity indicator:**
- `ActivityIndicator.kt` — animated dots with tool-specific labels (Read→"Reading", Edit→"Editing", Bash→"Running command", etc.)
- Active when PTY output within last 2s OR `ChatState.activeToolName` is set
- Clears on `Stop` or tool completion

**What works:**
- Full tool lifecycle (running → approval → complete/failed) renders as ToolCard state transitions
- Bash tool results render as CodeCard with syntax highlighting
- Failed tools render as ErrorCard with expandable details
- Multiple tools per turn stack chronologically
- System notices display as dimmed text
- Quick chips send commands directly to Claude Code

**Current limitations:**
- Response text renders as plain text (no markdown parsing — no bold, italic, code spans, or links)
- Edit tool results use generic ToolCard (DiffCard exists but isn't routed — no diff parsing from `toolResponse`)
- Session messages lost on recomposition (no ViewModel/persistence)

**Status:** Implemented. Needs on-device validation with live Claude Code hook output.

#### Theme & Visual Design — Complete

- **Color palette:** Neutral dark (#111 background, #1c1c1c surface) with Claude sienna (#c96442) accents
- **Font:** Cascadia Mono (Regular + Bold) bundled as app resources, set as app-wide Material Typography
- **Layout:** Both views share identical header/footer structure:
  - Header: navigation pill (left), centered title (15sp), Claude mascot pill (right)
  - Footer: text input (42dp pill) + action row (keyboard pills or quick chips)
  - 0.5dp dividers between sections using surfaceBorder (#333)
- **Claude mascot icon:** Blocky pixel-art character with >< eyes (EvenOdd cutouts), square arms, legs. Tintable single-path vector.
- **System integration:** `enableEdgeToEdge()` + `statusBarsPadding()` + `navigationBarsPadding()` + `imePadding()` for proper insets

#### Smart Cards — Partially Integrated

Cards wired into the hooks pipeline and receiving real data:
- `ToolCard` — 3 states (Running with spinner, AwaitingApproval with mini-terminal + Accept/Reject, Complete with expandable result). Fully functional.
- `CodeCard` — syntax-highlighted code with copy button. Routed for Bash tool results.
- `ErrorCard` — red-bordered expandable error display. Routed for ToolFailed events.
- `SyntaxHighlighter` — token-based highlighting for Kotlin, JS/TS, Python. Used by CodeCard.

Cards built but **not reachable** from the hooks pipeline (no MessageContent type routes to them):
- `DiffCard` — syntax-highlighted red/green diffs. Needs diff parsing from Edit tool `toolResponse`.
- `ApprovalCard` — standalone Accept/Reject buttons. Superseded by ToolCard's AwaitingApproval state.
- `ProgressCard` — spinner + progress text. Superseded by ActivityIndicator.

Widgets built but **not reachable** (designed for old parser, no hook event drives them):
- `MenuWidget`, `ConfirmationWidget`, `OAuthWidget` — orphaned from the parser-era architecture.

Dead code:
- `InputBar` — ChatScreen builds its own inline input instead of using this component.
- `CardStateManager` — ChatState has its own identical toggle logic.

#### Shell Access for Bash Tool — Implemented

Claude Code's Bash tool was failing with "No suitable shell found." Six layered problems were discovered and fixed:

**Problem 1: Shell Detection — "No suitable shell found"**

Claude Code's shell detection (`El1` function) only accepts shells with "bash" or "zsh" in the path — `/system/bin/sh` is silently ignored regardless of POSIX compliance. The validation function (`iJ$`) checks `fs.accessSync(X_OK)` then falls back to `execFileSync(shell, ["--version"])`, both of which fail for embedded binaries due to SELinux.

**Fix:** `claude-wrapper.js` — a Node.js wrapper that monkey-patches `child_process` and `fs` before loading Claude Code:
- Patches `fs.accessSync` to downgrade `X_OK` to `R_OK` for embedded binaries (passes validation)
- Patches `spawn`, `spawnSync`, `execFile`, `execFileSync` to prepend `/system/bin/linker64` for embedded binaries
- Claude Code is launched via `linker64 node claude-wrapper.js cli.js`
- `CLAUDE_CODE_SHELL` env var set to embedded bash path (checked before `SHELL` by Claude Code)

**Problem 2: Bash Subprocess Exec — "Permission denied"**

Even after Claude Code's shell detection passes, the Bash tool spawns `bash -c "command"`. When bash tries to exec embedded binaries (e.g., `head`, `apt`, `npm`), SELinux blocks `execve()` on `app_data_file` context. The JS wrapper can't intercept these calls — they happen inside the bash process, not in Node.js.

**Fix:** BASH_ENV shell function wrappers — generated at launch time by Kotlin (`Bootstrap.buildBashEnvSh()`):
- Scans `usr/bin/` and reads first bytes of each file to detect type:
  - **ELF binaries** (`\x7fELF`) → `git() { /system/bin/linker64 "$PREFIX/bin/git" "$@"; }`
  - **Scripts with shebangs** (`#!/usr/bin/env node`) → `claude() { /system/bin/linker64 "$PREFIX/bin/node" "$PREFIX/bin/claude" "$@"; }` — runs the *interpreter* through linker64 with the script as an argument (linker64 can only load ELF binaries, not scripts)
  - **`#!/usr/bin/env <prog>`** shebangs → resolves `<prog>` to `$PREFIX/bin/<prog>`
  - **Direct shebangs** (`#!/path/to/interpreter`) → resolves basename to our prefix
- Shell functions run in-process (no `execve()` syscall), so SELinux can't block them
- Generated by Kotlin (not shell `eval`) to avoid all escaping issues
- The JS wrapper explicitly sources this file by injecting `. "/path/to/linker64-env.sh" 2>/dev/null;` before every `bash -c` command
- Interactive shells source it via `.bash_profile` → `.bashrc` → `linker64-env.sh` (BASH_ENV only works for non-interactive shells)
- `Bootstrap.deployBashEnv()` generates and writes the file; called by both `PtyBridge.start()` and `DirectShellBridge.start()` so the file exists regardless of which view launches first

**Problem 3: Login Shell Flag — "-l: command not found"**

Claude Code's `getSpawnArgs` returns `["-c", "-l", command]` — with `-l` (login shell) AFTER `-c`. On desktop bash, `-l` after `-c` is treated as an option. But via linker64, bash treats `-l` as the command string (the first non-option argument after `-c`), causing every command to fail with `-l: command not found`.

**Root cause:** When bash is loaded by linker64 instead of being exec'd directly, its argument processing handles the `-c`/`-l` ordering differently. Desktop bash (directly exec'd) processes all flags before consuming the command string; linker64-loaded bash consumes the next arg after `-c` immediately as the command.

**Fix:** The JS wrapper strips `-l` from bash args before spawning (`stripLogin()` function). Login shell behavior is unnecessary in the embedded environment (no profile files to source). Stripping `-l` also moves `"-c"` to `args[0]`, which enables the `injectEnv()` function to detect and inject the BASH_ENV source command.

**Problem 4: Package Manager Hardcoded Paths**

Termux-compiled `apt` and `dpkg` binaries have `/data/data/com.termux/files/usr/` baked in at compile time. Running `apt install` or `pkg install` from the shell fails with "Unable to read /data/data/com.termux/files/usr/etc/apt/apt.conf.d/". Cannot create a symlink at `/data/data/com.termux/` without root.

**Fix:** `apt.conf` + custom shell functions:
- `Bootstrap.setupAptSources()` creates `$PREFIX/etc/apt/apt.conf` that overrides all directory settings (`Dir::State`, `Dir::Cache`, `Dir::Etc`, `Dir::Log`, `Dpkg::Options`)
- Shell functions for `apt`, `apt-get`, `apt-cache` set `APT_CONFIG` env var pointing to our `apt.conf`
- Shell function for `dpkg` passes `--admindir="$PREFIX/var/lib/dpkg"` at every invocation
- `pkg()` function wraps apt to match Termux UX: `pkg install git` → `apt install -y git`
- Bootstrap creates all required state directories and initializes empty dpkg status/available files

**Problem 5: Android Filesystem Quirks**

Two issues discovered during on-device testing:

1. **`cd /tmp` fails** — Android has no `/tmp` directory (root filesystem is read-only without root). Claude Code's LLM sometimes hardcodes `cd /tmp` in bash commands, causing CWD to become invalid.

2. **`pwd` inode error** — Android's FUSE layer reports inconsistent inode numbers between `stat()` and `readdir()` results. Bash's physical `pwd -P` mode walks the directory tree by matching inodes, which breaks on FUSE.

**Fix:**
- `cd()` shell function redirects `/tmp` and `/var/tmp` to `$HOME/tmp` using `builtin cd`
- `set +P` in BASH_ENV forces logical pwd mode (uses `$PWD` instead of inode walk)
- `pwd()` shell function wraps `builtin pwd -L` with fallback to `$PWD`
- Guard ensures `$PWD` is always set: `[ -z "$PWD" ] && PWD="$HOME" && export PWD`

**Problem 6: Hook Execution — "spawn /data/data/com.termux/files/usr/bin/sh ENOENT"**

Claude Code hooks (`"type": "command"` in `settings.json`) failed with ENOENT when Claude Code tried to execute the hook command. The hooks are installed by `Bootstrap.installHooks()` which writes a `settings.json` with hook entries for PreToolUse, PostToolUse, PostToolUseFailure, Stop, and Notification events. Each hook runs `<PREFIX>/bin/node <HOME>/.claude-mobile/hook-relay.js`, which reads stdin and relays JSON events over an Android abstract-namespace Unix socket to `EventBridge`.

Three sub-problems were discovered and fixed:

**6a. Abstract namespace sockets.** `hook-relay.js` originally used `net.connect(socketPath)` which creates a filesystem socket. Android's `LocalServerSocket` creates abstract-namespace sockets (kernel-managed, no filesystem path). Node.js requires a `\0` prefix to connect to abstract namespace sockets: `net.connect({ path: '\0' + socketPath })`. `EventBridge.kt` was also updated to use `LocalServerSocket` (abstract namespace) and remove filesystem socket cleanup.

**6b. Shell path resolution.** Claude Code executes hooks via `spawn(hookCommand, [], {shell: true})` (discovered by reading the minified bundle at `cli.js` line 6948: `N_z(Z,[],{env:f,cwd:V,shell:v,windowsHide:!0})`). Termux-compiled Node.js resolves `shell: true` to the hardcoded `/data/data/com.termux/files/usr/bin/sh` deep inside `normalizeSpawnArguments` (C++ level), which doesn't exist in our relocated prefix.

The wrapper's original `isEB` check made this worse: the hook command string (`/data/user/0/.../node /data/user/0/.../hook-relay.js`) starts with PREFIX, so `isEB` returned `true` and the wrapper tried to pass the ENTIRE COMMAND STRING to linker64 as if it were a binary path — while still passing `{shell: true}` in options. The original spawn then resolved the shell to the Termux path → ENOENT.

Attempts to fix the shell path alone (patching `exec`/`execSync`, adding `fixOpts` to rewrite `shell: true` → `PREFIX/bin/bash`) failed because Node.js can't execute `PREFIX/bin/bash` directly either — SELinux blocks `execve()` on `app_data_file` context. The shell binary needs linker64 to load it, but when `shell` is processed inside Node.js's `normalizeSpawnArguments`, it goes directly to libuv's `uv_spawn` which calls `execve` without linker64.

**6c. The fix — three-tier `spawnFix()`.** The wrapper's `spawn`/`spawnSync` patches now use a unified `spawnFix()` function with three tiers:

1. **`shell` + EB command** → Bypass the shell entirely. Split the command string on whitespace, extract the binary path, fix it with `fixPath()`, route through linker64 with `shell` removed from options. For hooks: `spawn(LINKER64, [PREFIX/bin/node, hookRelayPath], {env, cwd})`.
2. **`shell` + non-EB command** → Fix the shell path. `fixOpts()` rewrites `shell: true` → `PREFIX/bin/bash` and Termux string paths via `fixPath()`. For commands like `which npm`: `spawn("which npm", [], {shell: PREFIX/bin/bash})`.
3. **No `shell` + EB command** → Route binary through linker64 (existing behavior). For direct binary calls: `spawn(LINKER64, [PREFIX/bin/git, "status"], opts)`.

Additionally, `exec`/`execSync` are patched with `fixExecShell()` which proactively sets `shell: PREFIX/bin/bash` when shell is undefined or `true`, before Node.js's internal resolution can substitute the Termux default.

#### Supporting Infrastructure

1. **`termux-exec` LD_PRELOAD** (best-effort) — Installed from Termux repos, linker variant `.so` set up as primary. `LD_PRELOAD` and `TERMUX__PREFIX` set in environment. However, the prebuilt `.so` has hardcoded `/data/data/com.termux/` paths and does **not** intercept exec calls for our custom `com.destins.claudemobile` prefix, even with `TERMUX__PREFIX` set. The shell function approach above is the actual fix; termux-exec is retained in case a future custom build resolves the prefix issue.

2. **Environment changes:**
   - `SHELL` → embedded bash path (was `/system/bin/sh`)
   - `CLAUDE_CODE_SHELL` → embedded bash path (checked first by Claude Code)
   - `CLAUDE_CODE_TMPDIR` → `$HOME/tmp` (Claude Code defaults to `/tmp` which doesn't exist on Android)
   - `BASH_ENV` → path to generated `linker64-env.sh`
   - `LD_PRELOAD` → `libtermux-exec-ld-preload.so` (conditional on `.so` existing)
   - `TERMUX__PREFIX` → custom prefix with double underscore (for termux-exec v2.x)

3. **Deployment:** `claude-wrapper.js` is deployed by `PtyBridge.start()` (inline `WRAPPER_JS` constant). `linker64-env.sh` is generated by `Bootstrap.deployBashEnv()`, called by both `PtyBridge.start()` and `DirectShellBridge.start()` — no dependency on launch order.

4. **Interactive shell support:** `Bootstrap.setupHome()` creates `.bash_profile` (sources `.bashrc`) and `.bashrc` (sources `linker64-env.sh`). This ensures interactive login shells (Shell view) get the same linker64 functions that non-interactive shells get via `BASH_ENV`.

**Status:** First on-device test completed. Shell detection, bash subprocess exec, `-l` flag stripping, package management, filesystem workarounds, and hook execution are implemented. Claude Code successfully installed git 2.53.0 and gh 2.88.1 from Termux repos during testing.

#### Other Components — Built

- **On-demand git install:** `Bootstrap.installGit()` with .deb package list (hardcoded URLs — functional but could be dynamically resolved from Termux repos)
- **Quick chips:** Journal, Inbox, Briefing, Draft Text styled as pill buttons. Fully wired — tapping sends the command to Claude Code; "Briefing" and "Draft Text" pre-fill input for completion.
- **Direct shell:** `DirectShellBridge.kt` provides standalone bash with full linker64/BASH_ENV environment. Accessible via long-press on Terminal button. No visible UI affordance.
- **/btw sheet:** `BtwSheet.kt` — modal bottom sheet for quick asides via `/btw` command.

## Dependencies

- **Claude Code CLI** — the desktop CLI that runs inside the embedded terminal
- **Termux terminal-emulator library** — provides `TerminalSession`, `TerminalEmulator`, screen buffer APIs
- **Node.js** — embedded runtime for Claude Code and hook relay
- **Bash** — embedded shell for Claude Code's Bash tool
- **rclone** — bundled for Google Drive sync (initial install, not deferred)
- **Cascadia Mono font** — bundled Regular + Bold for terminal and UI typography

## Known Bugs / Issues

*None currently tracked.*

## Planned Updates

### Priority 1: On-Device Validation

The hooks-based chat pipeline is implemented but needs end-to-end validation with live Claude Code output. Specific areas:
- Full tool lifecycle: PreToolUse → Notification (approval) → PostToolUse → Stop
- Multiple tools in a single turn (cards should stack chronologically)
- Hook execution performance (Unix socket write should be sub-millisecond)
- ToolCard expand/collapse with real JSON results
- Activity indicator clearing reliably on Stop events

### Priority 2: Markdown Rendering

Response bubbles currently render `last_assistant_message` as plain text. Claude's output is markdown — bold, italic, code spans, code blocks, links, and lists are all lost. Options:
- Compose markdown library (e.g., `mikepenz/multiplatform-markdown-renderer`)
- Basic regex-based annotated string (handles bold/italic/code spans, skips full block rendering)

### Priority 3: Session Persistence

Chat messages are lost on tab switch (Compose recomposition). Need to hoist `ChatState` to a ViewModel or persist across configuration changes. This becomes painful once the chat view is the primary interaction mode.

### Priority 4: DiffCard for Edit Tool

DiffCard is built (syntax-highlighted red/green diffs) but unreachable — Edit tool results go through generic ToolCard. Need to parse `toolResponse` JSON from PostToolUse into DiffHunk format and route Edit/Write tools to DiffCard in MessageBubble.

### Priority 5: OAuth Flow

Current approach requires manual browser + paste. Consider:
- Localhost HTTP server in embedded Node.js to catch the OAuth callback
- Custom URI scheme handler (`claudemobile://callback`) for redirect
- Or accept the manual flow if it works well enough on-device

### Priority 6: Hook Config Merge

`Bootstrap.installHooks()` does deduplication but could clobber existing user hooks from desktop Claude Code if they have custom matchers. Needs true additive merge: read existing hooks, append ours, preserve theirs.

### Priority 7: Dead Code Cleanup

Unreachable components from the parser era:
- `ApprovalCard` (superseded by ToolCard.AwaitingApproval)
- `ProgressCard` (superseded by ActivityIndicator)
- `MenuWidget`, `ConfirmationWidget`, `OAuthWidget` (no hook event drives them)
- `InputBar` (ChatScreen builds its own inline input)
- `CardStateManager` (ChatState has its own toggle)

### Priority 8: Direct Shell UI Affordance

DirectShellBridge works via long-press on Terminal button but there's no visible indicator. Users won't discover it. Needs a UI element (toggle, menu item, or labeled button).

### Priority 9: Person Briefings + Text Drafting Chips

Config-only change in `ChipConfig.kt` — no new files or complex logic.

## Open Questions

1. **Tablet layout:** Split-view (2/3 chat + 1/3 file preview) deferred to Phase 3.
2. **Config sync from Drive:** rclone integration for syncing `~/.claude/` from Google Drive deferred to Phase 3.
3. **Notifications:** Actionable notifications when Claude needs approval while app is backgrounded — deferred to Phase 3.
4. **GPL compliance:** Termux runtime licensing question remains open from Phase 1.

## File Inventory

### New Files (Phase 2)
```
ui/TerminalPanel.kt            — Terminal canvas renderer
ui/TerminalKeyboardRow.kt      — Special key buttons
ui/ActivityIndicator.kt        — Tool-specific animated "Working..." indicator
ui/SyntaxHighlighter.kt        — Token-based code highlighting
ui/BtwSheet.kt                 — /btw bottom sheet
ui/ApiKeyScreen.kt             — API key entry screen
ui/cards/CardState.kt          — Expand/collapse state manager (unused — ChatState has own toggle)
ui/cards/ToolCard.kt           — Tool call card (3 states: Running, AwaitingApproval, Complete)
ui/cards/DiffCard.kt           — Diff display card (built, not routed from hooks pipeline)
ui/cards/CodeCard.kt           — Code block card with syntax highlighting + copy
ui/cards/ErrorCard.kt          — Error display card with expandable details
ui/cards/ProgressCard.kt       — Progress indicator (unused — superseded by ActivityIndicator)
ui/cards/ApprovalCard.kt       — Approval prompt card (unused — superseded by ToolCard.AwaitingApproval)
ui/widgets/MenuWidget.kt       — Radio button menu selector (unused — no hook event drives it)
ui/widgets/ConfirmationWidget.kt — Yes/No prompt (unused — no hook event drives it)
ui/widgets/OAuthWidget.kt      — Sign-in button (unused — no hook event drives it)
ui/theme/AppIcons.kt           — Custom vector icons (Terminal, Chat, ClaudeMascot)
parser/HookEvent.kt            — Sealed class: 5 hook event types with JSON deserialization
runtime/DirectShellBridge.kt   — Standalone bash shell session (no Claude Code)
assets/hook-relay.js           — Hook script: reads stdin JSON, writes to abstract-namespace socket
assets/claude-wrapper.js       — Reference copy of SELinux exec bypass wrapper
res/font/cascadia_mono_regular.ttf
res/font/cascadia_mono_bold.ttf
```

### Deleted Files (removed during hooks rebuild)
```
parser/ParsedEvent.kt          — 12 event types + DiffHunk (replaced by HookEvent.kt)
assets/parser/parser.js        — Parser sidecar state machine (deleted — hooks replace parsing)
assets/parser/patterns.js      — Pattern matching rules (deleted — hooks replace parsing)
```

### Modified Files
```
ui/theme/Theme.kt         — Color palette, CascadiaMono FontFamily, app Typography
ui/ChatScreen.kt           — Three-mode layout (Chat/Terminal/Shell), hook event routing,
                              approval detection (primary + fallback heuristic)
ui/ChatState.kt            — 7 MessageContent variants, tool state machine transitions,
                              activeToolName tracking for activity indicator
ui/MessageBubble.kt        — Routes content types to ToolCard/CodeCard/ErrorCard/text bubbles
ui/InputBar.kt             — Circular send button (unused — ChatScreen builds inline input)
ui/QuickChips.kt           — Pill-styled chips matching keyboard row
runtime/PtyBridge.kt       — screenVersion, session accessor, \r input,
                              SELinux exec bypass (claude-wrapper.js deployment,
                              WRAPPER_JS with stripLogin + injectEnv + spawnFix + fixExecShell,
                              hook installation, DirectShellBridge factory, sendApproval())
runtime/Bootstrap.kt       — installGit(), buildRuntimeEnv(), deployBashEnv() + buildBashEnvSh()
                              (ELF/script detection, pkg manager wrappers, cd/pwd fixes, .bashrc setup),
                              setupAptSources() with apt.conf dir overrides + dpkg state init,
                              installHooks() with hook-relay.js deployment + settings.json merge
parser/EventBridge.kt      — Rewritten as LocalServerSocket (abstract namespace), SharedFlow emitter
MainActivity.kt            — Edge-to-edge, system bar insets, IME padding
app/build.gradle.kts       — material-icons-extended, version 0.2.0
```

## Change Log

| Date | Version | What changed | Type | Approved by | Session |
|------|---------|-------------|------|-------------|---------|
| 2026-03-15 | 1.0 | Initial status spec documenting Phase 2 implementation | New | Destin | Phase 2 review |
| 2026-03-16 | 1.1 | Shell access: document three-layer fix (JS wrapper, BASH_ENV functions, `-l` flag strip), termux-exec prefix limitation, deployment strategy, `CLAUDE_CODE_TMPDIR`. Freshen stale items: commit count 59→81, fix duplicate Priority 4, add DirectShellBridge/ApiKeyScreen/BtwSheet to inventory, add chat rebuild refs, update Direct Terminal Access status | Update | Destin | Shell access |
| 2026-03-16 | 1.2 | First on-device test results: 6 bugs and fixes. ELF/script-aware binary detection, package manager path remapping, Android filesystem workarounds. Moved buildBashEnvSh to shared Bootstrap.deployBashEnv(). Added .bashrc/.bash_profile for interactive shells | Update | Destin | On-device testing |
| 2026-03-16 | 1.3 | Hook execution fix (Problem 6): abstract namespace sockets, shell path resolution, three-tier spawnFix(). Document exec/execSync patching, hook installation system, design decisions on shell bypass and command splitting | Update | Destin | Hook debugging |
| 2026-03-16 | 2.0 | Restructured to standard spec format. Added User Mandates, Design Decisions table, Dependencies. Consolidated open questions from frozen design docs. Updated cross-references to new filenames | Format | Destin | Specs reorganization |
| 2026-03-16 | 2.1 | Reflect hooks-based chat rebuild as implemented (not planned). Rewrite Chat View section with hooks architecture. Update Smart Cards to show integrated vs orphaned. Remove obsolete open questions (parser patterns, multiple tools per turn). Reprioritize Planned Updates: P1=on-device validation, P2=markdown, P3=session persistence, P4=DiffCard routing, P5=OAuth, P6=hook merge, P7=dead code cleanup, P8=shell UI, P9=chips. Update File Inventory (add HookEvent/hook-relay/ActivityIndicator, remove parser.js/patterns.js/ParsedEvent, add Deleted Files section) | Update | Destin | Spec review |
