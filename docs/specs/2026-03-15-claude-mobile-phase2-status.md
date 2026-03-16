# Claude Mobile Phase 2 — Implementation Status Spec

**Version:** 1.3
**Date:** 2026-03-16
**Status:** In Progress

**Phase 1 spec:** `~/docs/superpowers/specs/2026-03-15-claude-mobile-android-design.md`
**Phase 2 design spec:** `docs/specs/2026-03-15-claude-mobile-phase2-design.md`
**Phase 2 plan:** `docs/plans/2026-03-15-claude-mobile-phase2.md`

## Summary

Phase 2 adds two interaction modes to Claude Mobile: a full-screen **Terminal** view and a widget-based **Chat** view. The Terminal view is fully functional and usable for all Claude Code interactions. The Chat view renders structured widgets for menus, confirmations, and OAuth flows but has significant reliability issues with message parsing, noise filtering, and URL reconstruction that make it unsuitable for production use. A rebuild of the chat pipeline is recommended.

## What Was Built (81 commits)

### Terminal View — Production Ready

A full-screen terminal emulator that renders Claude Code's output directly from the Termux `TerminalEmulator` screen buffer.

**Architecture:**
- `TerminalPanel.kt` — Compose `Canvas` that reads `TerminalRow` data cell-by-cell from `TerminalBuffer`, rendering characters with correct foreground/background colors and attributes (bold, underline, inverse)
- Font size auto-calculated via binary search to fit 60 columns in screen width
- `TerminalKeyboardRow.kt` — pill-styled buttons for Ctrl, Esc, Tab, arrow keys (Material icons), and Enter
- Text input field with Cascadia Mono font, sends raw keystrokes via `\r` (carriage return)
- `PtyBridge.screenVersion` StateFlow triggers Canvas recomposition on every `onTextChanged`

**Key technical decisions:**
- Uses `drawRect()` not `nativeCanvas.drawColor()` — the latter paints the entire window surface, not just the composable bounds (caused top bar to be invisible for several iterations)
- Canvas `fillMaxSize()` removed from modifier chain — conflicted with `weight()` in Column layout
- Terminal redraws on ALL `onTextChanged` calls, including when transcript shrinks (ink menu redraws)
- Initial emulator size matches panel size (60×40) to prevent resize mismatch with ink menus

**Status:** Fully functional. Users can navigate Claude Code's first-run menus (theme picker, login method, OAuth), type commands, paste auth codes, and interact normally. Arrow keys, escape sequences, and Ctrl modifiers work correctly.

### Chat View — Needs Rebuild

A message-based view that attempts to translate terminal output into structured chat bubbles and interactive widgets.

**Architecture:**
- Parser sidecar (`parser.js`) classifies PTY output into 12 event types via state machine
- `PtyBridge` accumulates output for 100ms before forwarding to parser
- `EventBridge` receives JSON events over Unix socket, emits `ParsedEvent` sealed class
- `ChatScreen` routes events to `ChatState` which manages message list
- `MessageBubble` delegates to card/widget composables based on content type

**What works:**
- Theme picker renders as `MenuWidget` (radio buttons + Select button)
- Menu selection sends delayed arrow-key sequences (50ms gaps) to ink
- Follow-up menus detected via hash-based transcript scanner after selection
- `MenuResolved` widget shows green ✓ with selected option
- OAuth URLs detected and shown as `OAuthWidget` with "Sign in with Claude" button
- Basic text deduplication prevents identical consecutive messages
- Noise filter suppresses ASCII art, block characters, decoration lines, code preview fragments

**What doesn't work reliably:**

1. **Message noise filtering is fragile** — Uses a growing list of ad-hoc heuristics (character counting, regex patterns, hardcoded strings). New Claude Code output patterns will bypass filters. ASCII art fragments, diff preview lines, auth code echoes, and terminal decorations all required individual filter rules. The approach is fundamentally reactive rather than structural.

2. **URL reconstruction from fragments** — OAuth URLs wrap at 60 columns, producing ~8 text events. The URL accumulator joins fragments by detecting `https://` start + no-space continuation lines, then reads the full URL from `getTranscriptText()` with newline joining. This pipeline is multi-stage and fragile. `getTranscriptText()` itself splits URLs with `\n` at column boundaries, requiring `\n(?=\S)` regex replacement before extraction.

3. **Menu detection depends on numbered format** — Only detects `N. option text` patterns. Non-numbered menus (bullet points, ink selector-only) are not caught. Menu options arrive as separate text events requiring a 300ms accumulator with decoration-aware flush logic.

4. **Follow-up menu detection is indirect** — After menu selection, polls transcript 5 times over 5 seconds looking for menus with a new hash. Relies on `getTranscriptText()` which includes scrollback history. Previous attempts to read only visible rows failed due to Termux API access issues.

5. **Event pipeline has no concept of "screen state"** — The parser processes text line-by-line. It has no awareness of whether Claude Code is showing a menu, waiting for input, displaying output, or idle. Every piece of output goes through the same noise/menu/URL heuristic chain.

6. **Widget state management is scattered** — `menuWasResolved`, `shownMenuHashes`, `urlAccumulator`, `menuAccumulator`, `menuFlushJob`, `urlFlushJob`, `pendingMenuScan` are all separate `remember` state in `ChatScreen`. The interaction between these states creates subtle bugs (e.g., menu scanner activating too early, URL accumulator not being set).

### Theme & Visual Design — Complete

- **Color palette:** Neutral dark (#111 background, #1c1c1c surface) with Claude sienna (#c96442) accents
- **Font:** Cascadia Mono (Regular + Bold) bundled as app resources, set as app-wide Material Typography
- **Layout:** Both views share identical header/footer structure:
  - Header: navigation pill (left), centered title (15sp), Claude mascot pill (right)
  - Footer: text input (42dp pill) + action row (keyboard pills or quick chips)
  - 0.5dp dividers between sections using surfaceBorder (#333)
- **Claude mascot icon:** Blocky pixel-art character with >< eyes (EvenOdd cutouts), square arms, legs. Tintable single-path vector.
- **System integration:** `enableEdgeToEdge()` + `statusBarsPadding()` + `navigationBarsPadding()` + `imePadding()` for proper insets

### Smart Cards — Built, Untested in Production

Card composables built but largely untested beyond compilation:
- `ToolCard` — collapsible tool name + args
- `DiffCard` — syntax-highlighted red/green diffs
- `CodeCard` — syntax-highlighted code with copy button
- `ErrorCard` — red-bordered error display
- `ProgressCard` — spinner + progress text
- `ApprovalCard` — Accept/Reject buttons
- `SyntaxHighlighter` — token-based highlighting for Kotlin, JS/TS, Python

Single-expanded-card constraint managed by `CardStateManager`.

### Other Components — Built

- **Output accumulator:** 100ms coroutine-based debounce in PtyBridge with socket connection backlog flush
- **Parser state machine:** 5 modes (NORMAL, IN_TOOL, IN_DIFF, IN_CODE_BLOCK, IN_ERROR) tracking multi-line constructs
- **On-demand git install:** `Bootstrap.installGit()` with .deb package list (URLs need verification)
- **Quick chips:** Journal, Inbox, Briefing, Draft Text styled as pill buttons

## Planned Updates

### Priority 1: Rebuild Chat View

The chat view's approach of parsing terminal output line-by-line and reconstructing interactive elements through heuristic pattern matching is fundamentally flawed. The terminal is the source of truth; the chat view is a lossy interpretation layer that creates more problems than it solves in its current form.

**Recommended approach for rebuild:**
- **Screen-state-aware architecture** — Instead of processing individual text events, read the terminal screen buffer periodically and classify the entire screen state (menu showing, waiting for input, output streaming, idle)
- **Diff-based updates** — Compare current screen state to previous state to determine what changed, rather than trying to classify each text delta
- **Structured screen parser** — Parse the visible screen rows as a whole document, extracting menus, prompts, and text blocks as complete structures rather than accumulating fragments
- **Separate noise from signal at the screen level** — The terminal screen shows exactly what the user should see. Parse the screen layout (header area, content area, prompt area) rather than filtering individual text lines

### Priority 2: OAuth Flow

The OAuth flow requires a localhost callback server or a clipboard-based code exchange. Current approach (URL reconstruction + browser open + manual code paste) works but is clunky. Consider:
- Running a minimal HTTP server in the embedded runtime to catch the OAuth callback
- Or implementing a custom URI scheme handler for the callback redirect

### Priority 3: Shell Access for Bash Tool — Implemented

Claude Code's Bash tool was failing with "No suitable shell found." Three layered problems were discovered and fixed:

#### Problem 1: Shell Detection — "No suitable shell found"

Claude Code's shell detection (`El1` function) **only accepts shells with "bash" or "zsh" in the path** — `/system/bin/sh` is silently ignored regardless of POSIX compliance. The validation function (`iJ$`) checks `fs.accessSync(X_OK)` then falls back to `execFileSync(shell, ["--version"])`, both of which fail for embedded binaries due to SELinux.

**Fix:** `claude-wrapper.js` — a Node.js wrapper that monkey-patches `child_process` and `fs` before loading Claude Code:
- Patches `fs.accessSync` to downgrade `X_OK` to `R_OK` for embedded binaries (passes validation)
- Patches `spawn`, `spawnSync`, `execFile`, `execFileSync` to prepend `/system/bin/linker64` for embedded binaries
- Claude Code is launched via `linker64 node claude-wrapper.js cli.js`
- `CLAUDE_CODE_SHELL` env var set to embedded bash path (checked before `SHELL` by Claude Code)

#### Problem 2: Bash Subprocess Exec — "Permission denied"

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

**Design decision: Kotlin-generated vs shell-generated functions.** An earlier approach used a shell script with `eval` and `for` loops to dynamically create functions at bash startup. This failed due to `$@` escaping issues (the `eval` expanded `$@` prematurely, producing functions that lost their arguments). The current approach generates each function as a static string in Kotlin, eliminating all shell escaping complexity.

**Design decision: ELF detection vs blind wrapping.** The original implementation wrapped every file with `linker64 binary "$@"`. This failed for script files (e.g., `claude`, `npm`, `npx`) because linker64 only loads ELF binaries. The shebang-aware approach reads 512 bytes of each file to determine the correct invocation pattern.

#### Problem 3: Login Shell Flag — "-l: command not found"

Claude Code's `getSpawnArgs` returns `["-c", "-l", command]` — with `-l` (login shell) AFTER `-c`. On desktop bash, `-l` after `-c` is treated as an option. But via linker64, bash treats `-l` as the command string (the first non-option argument after `-c`), causing every command to fail with `-l: command not found`.

**Root cause:** When bash is loaded by linker64 instead of being exec'd directly, its argument processing handles the `-c`/`-l` ordering differently. Desktop bash (directly exec'd) processes all flags before consuming the command string; linker64-loaded bash consumes the next arg after `-c` immediately as the command.

**Fix:** The JS wrapper strips `-l` from bash args before spawning (`stripLogin()` function). Login shell behavior is unnecessary in the embedded environment (no profile files to source). Stripping `-l` also moves `"-c"` to `args[0]`, which enables the `injectEnv()` function to detect and inject the BASH_ENV source command.

#### Problem 4: Package Manager Hardcoded Paths

Termux-compiled `apt` and `dpkg` binaries have `/data/data/com.termux/files/usr/` baked in at compile time. Running `apt install` or `pkg install` from the shell fails with "Unable to read /data/data/com.termux/files/usr/etc/apt/apt.conf.d/". Cannot create a symlink at `/data/data/com.termux/` without root.

**Fix:** `apt.conf` + custom shell functions:
- `Bootstrap.setupAptSources()` creates `$PREFIX/etc/apt/apt.conf` that overrides all directory settings (`Dir::State`, `Dir::Cache`, `Dir::Etc`, `Dir::Log`, `Dpkg::Options`)
- Shell functions for `apt`, `apt-get`, `apt-cache` set `APT_CONFIG` env var pointing to our `apt.conf`
- Shell function for `dpkg` passes `--admindir="$PREFIX/var/lib/dpkg"` at every invocation
- `pkg()` function wraps apt to match Termux UX: `pkg install git` → `apt install -y git`
- Bootstrap creates all required state directories and initializes empty dpkg status/available files

#### Problem 5: Android Filesystem Quirks

Two issues discovered during on-device testing:

1. **`cd /tmp` fails** — Android has no `/tmp` directory (root filesystem is read-only without root). Claude Code's LLM sometimes hardcodes `cd /tmp` in bash commands, causing CWD to become invalid.

2. **`pwd` inode error** — Android's FUSE layer reports inconsistent inode numbers between `stat()` and `readdir()` results. Bash's physical `pwd -P` mode walks the directory tree by matching inodes, which breaks on FUSE.

**Fix:**
- `cd()` shell function redirects `/tmp` and `/var/tmp` to `$HOME/tmp` using `builtin cd`
- `set +P` in BASH_ENV forces logical pwd mode (uses `$PWD` instead of inode walk)
- `pwd()` shell function wraps `builtin pwd -L` with fallback to `$PWD`
- Guard ensures `$PWD` is always set: `[ -z "$PWD" ] && PWD="$HOME" && export PWD`

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

#### Problem 6: Hook Execution — "spawn /data/data/com.termux/files/usr/bin/sh ENOENT"

Claude Code hooks (`"type": "command"` in `settings.json`) failed with ENOENT when Claude Code tried to execute the hook command. The hooks are installed by `Bootstrap.installHooks()` which writes a `settings.json` with hook entries for PreToolUse, PostToolUse, PostToolUseFailure, Stop, and Notification events. Each hook runs `<PREFIX>/bin/node <HOME>/.claude-mobile/hook-relay.js`, which reads stdin and relays JSON events over an Android abstract-namespace Unix socket to `EventBridge`.

**Three sub-problems were discovered and fixed:**

**6a. Abstract namespace sockets.** `hook-relay.js` originally used `net.connect(socketPath)` which creates a filesystem socket. Android's `LocalServerSocket` creates abstract-namespace sockets (kernel-managed, no filesystem path). Node.js requires a `\0` prefix to connect to abstract namespace sockets: `net.connect({ path: '\0' + socketPath })`. `EventBridge.kt` was also updated to use `LocalServerSocket` (abstract namespace) and remove filesystem socket cleanup.

**6b. Shell path resolution.** Claude Code executes hooks via `spawn(hookCommand, [], {shell: true})` (discovered by reading the minified bundle at `cli.js` line 6948: `N_z(Z,[],{env:f,cwd:V,shell:v,windowsHide:!0})`). Termux-compiled Node.js resolves `shell: true` to the hardcoded `/data/data/com.termux/files/usr/bin/sh` deep inside `normalizeSpawnArguments` (C++ level), which doesn't exist in our relocated prefix.

The wrapper's original `isEB` check made this worse: the hook command string (`/data/user/0/.../node /data/user/0/.../hook-relay.js`) starts with PREFIX, so `isEB` returned `true` and the wrapper tried to pass the ENTIRE COMMAND STRING to linker64 as if it were a binary path — while still passing `{shell: true}` in options. The original spawn then resolved the shell to the Termux path → ENOENT.

Attempts to fix the shell path alone (patching `exec`/`execSync`, adding `fixOpts` to rewrite `shell: true` → `PREFIX/bin/bash`) failed because Node.js can't execute `PREFIX/bin/bash` directly either — SELinux blocks `execve()` on `app_data_file` context. The shell binary needs linker64 to load it, but when `shell` is processed inside Node.js's `normalizeSpawnArguments`, it goes directly to libuv's `uv_spawn` which calls `execve` without linker64.

**6c. The fix — three-tier `spawnFix()`.** The wrapper's `spawn`/`spawnSync` patches now use a unified `spawnFix()` function with three tiers:

1. **`shell` + EB command** → Bypass the shell entirely. Split the command string on whitespace, extract the binary path, fix it with `fixPath()`, route through linker64 with `shell` removed from options. For hooks: `spawn(LINKER64, [PREFIX/bin/node, hookRelayPath], {env, cwd})`.
2. **`shell` + non-EB command** → Fix the shell path. `fixOpts()` rewrites `shell: true` → `PREFIX/bin/bash` and Termux string paths via `fixPath()`. For commands like `which npm`: `spawn("which npm", [], {shell: PREFIX/bin/bash})`.
3. **No `shell` + EB command** → Route binary through linker64 (existing behavior). For direct binary calls: `spawn(LINKER64, [PREFIX/bin/git, "status"], opts)`.

Additionally, `exec`/`execSync` are patched with `fixExecShell()` which proactively sets `shell: PREFIX/bin/bash` when shell is undefined or `true`, before Node.js's internal resolution can substitute the Termux default.

**Design decision: bypass shell vs fix shell for EB commands.** Earlier iterations tried to fix the shell path and let Node.js handle shell execution normally. This failed because the fixed shell binary (`PREFIX/bin/bash`) still can't be directly `execve()`d — it needs linker64. On Android, `termux-exec` (LD_PRELOAD) is supposed to intercept `execve()` calls and route through linker64, but the prebuilt `.so` has hardcoded Termux prefix paths and doesn't intercept for our custom prefix (see Problem 3 note about termux-exec). The shell-bypass approach avoids the shell execution problem entirely for EB commands, while the shell-fix approach handles non-EB commands (like `which`, `uname`) where `/system/bin/sh` could work but the Termux default still fails.

**Design decision: command string splitting.** Splitting on `\s+` works for hook commands (which are simple `binary arg` patterns) but would break for commands with quoted arguments containing spaces. This is acceptable because the EB+shell case only triggers when the command string starts with PREFIX or TERMUX_PREFIX — these are always machine-generated paths from hook configuration, not user-authored shell commands.

### Priority 4: Smart Card Integration

Smart cards are built but need real-world testing with actual Claude Code tool output. The parser's tool_start/tool_end, diff_block, and code_block detection patterns need validation against live output.

### Priority 5: Direct Terminal Access — Partially Implemented

A standalone bash shell session (no Claude Code) is available via `DirectShellBridge.kt`. It shares the Bootstrap environment (PATH, LD_PRELOAD, BASH_ENV) so all embedded binaries are accessible. `PtyBridge.createDirectShell()` is the factory method. UI integration (toggle button, session picker) is not yet wired up.

### Priority 6: Chat View Rebuild

A separate design spec and implementation plan have been created:
- **Design:** `docs/specs/2026-03-15-claude-mobile-chat-rebuild-design.md`
- **Plan:** `docs/plans/2026-03-15-claude-mobile-chat-rebuild.md`

### Priority 7: Session Persistence

Chat messages are lost on tab switch (Compose recomposition). Need to hoist state to ViewModel or persist across configuration changes.

## File Inventory

### New Files (Phase 2)
```
ui/TerminalPanel.kt            — Terminal canvas renderer
ui/TerminalKeyboardRow.kt      — Special key buttons
ui/SyntaxHighlighter.kt        — Token-based code highlighting
ui/BtwSheet.kt                 — /btw bottom sheet (74 lines, implemented)
ui/ApiKeyScreen.kt             — API key entry screen
ui/cards/CardState.kt          — Expand/collapse state manager
ui/cards/ToolCard.kt           — Tool call card
ui/cards/DiffCard.kt           — Diff display card
ui/cards/CodeCard.kt           — Code block card
ui/cards/ErrorCard.kt          — Error display card
ui/cards/ProgressCard.kt       — Progress indicator
ui/cards/ApprovalCard.kt       — Approval prompt card
ui/widgets/MenuWidget.kt       — Radio button menu selector
ui/widgets/ConfirmationWidget.kt — Yes/No prompt
ui/widgets/OAuthWidget.kt      — Sign-in button
ui/theme/AppIcons.kt           — Custom vector icons (Terminal, Chat, ClaudeMascot)
runtime/DirectShellBridge.kt   — Standalone bash shell session (no Claude Code)
assets/claude-wrapper.js       — Reference copy of SELinux exec bypass wrapper
res/font/cascadia_mono_regular.ttf
res/font/cascadia_mono_bold.ttf
```

### Modified Files
```
ui/theme/Theme.kt         — Color palette, CascadiaMono FontFamily, app Typography
ui/ChatScreen.kt           — Dual-mode layout, event routing, menu/URL accumulators
ui/ChatState.kt            — MessageContent types, menu/OAuth/confirm content
ui/MessageBubble.kt        — Card/widget delegation
ui/InputBar.kt             — Circular send button (chat mode uses BasicTextField now)
ui/QuickChips.kt           — Pill-styled chips matching keyboard row
ui/SetupScreen.kt          — Unchanged
runtime/PtyBridge.kt       — screenVersion, session accessor, \r input,
                              SELinux exec bypass (claude-wrapper.js deployment,
                              WRAPPER_JS with stripLogin + injectEnv + spawnFix + fixExecShell,
                              hook installation, DirectShellBridge factory)
runtime/Bootstrap.kt       — installGit(), buildRuntimeEnv(), deployBashEnv() + buildBashEnvSh()
                              (ELF/script detection, pkg manager wrappers, cd/pwd fixes, .bashrc setup),
                              setupAptSources() with apt.conf dir overrides + dpkg state init
parser/EventBridge.kt      — onConnected callback
parser/ParsedEvent.kt      — 12 event types + DiffHunk
assets/parser/parser.js    — State machine rewrite
assets/parser/patterns.js  — Expanded pattern set
assets/claude-wrapper.js   — Reference copy (actual deploy is from PtyBridge.kt string)
MainActivity.kt            — Edge-to-edge, system bar insets, IME padding
app/build.gradle.kts       — material-icons-extended, version 0.2.0
```

## Change Log

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-03-15 | Initial status spec documenting Phase 2 implementation |
| 1.1 | 2026-03-16 | Shell access: document three-layer fix (JS wrapper → BASH_ENV functions → `-l` flag strip), termux-exec prefix limitation, deployment strategy (PtyBridge.start not Bootstrap.setup), `CLAUDE_CODE_TMPDIR` env var. Freshen stale items: update commit count (59→81), fix duplicate Priority 4 numbering, add DirectShellBridge/ApiKeyScreen/BtwSheet to file inventory, add chat rebuild spec/plan references, update Direct Terminal Access status to partially implemented |
| 1.2 | 2026-03-16 | First on-device test results: document 6 bugs and fixes. New: ELF/script-aware binary detection in buildBashEnvSh (Problem 2 update), package manager path remapping via APT_CONFIG + dpkg --admindir (Problem 4), Android filesystem workarounds for cd /tmp and pwd inode errors (Problem 5). Moved buildBashEnvSh to Bootstrap.deployBashEnv() shared by both bridges. Added .bashrc/.bash_profile for interactive shell support. Updated file inventory for Bootstrap.kt and PtyBridge.kt |
| 1.3 | 2026-03-16 | Hook execution fix (Problem 6): document three sub-problems — abstract namespace sockets for hook-relay.js/EventBridge, Termux-compiled Node.js shell path resolution in spawn, and the three-tier spawnFix() solution (shell+EB bypass, shell+non-EB fix, no-shell+EB linker64). Document exec/execSync patching with fixExecShell(). Document hook installation system (Bootstrap.installHooks, settings.json, hook-relay.js). Design decisions on shell bypass vs fix, and command string splitting safety |
