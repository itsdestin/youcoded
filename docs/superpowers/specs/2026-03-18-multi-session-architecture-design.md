# Multi-Session Architecture Design

**Date:** 2026-03-18
**Version:** 1.0
**Status:** Draft

## Overview

Transforms Claude Mobile from a single-session app into a multi-session client with process persistence and improved terminal quality. Inspired by Termux's session management model while preserving Claude Mobile's chat-primary interface, tool cards, approval widgets, and distinct chat/terminal views.

### Goals

1. **Multiple concurrent Claude Code sessions** — each with its own PTY, EventBridge, ChatState, and chat history
2. **Process persistence** — wake lock + foreground service keep sessions alive when app is backgrounded
3. **Termux terminal-view integration** — replace custom Canvas renderer with Termux's battle-tested TerminalView for text selection, pinch-to-zoom, resize handling, and gestures
4. **Boot self-test** — verify binary execution after extraction to catch broken bootstraps early
5. **linker64-env.sh audit** — investigate whether the shell function generation layer is redundant with LD_PRELOAD

### Non-Goals (Explicit Scope Boundary)

- Shared storage access (`~/storage/` symlinks)
- Configurable extra keys
- Intent-based prompt execution (Tasker integration)
- Full "task done" background notifications (approval notifications are in scope)

## Section 1: ManagedSession & SessionManager

### ManagedSession

A self-contained unit bundling everything one Claude Code session needs:

```
ManagedSession(
    id: String,                        // UUID
    cwd: File,                         // Working directory
    dangerousMode: Boolean,            // --dangerously-skip-permissions
    ptyBridge: PtyBridge,              // PTY + wrapper JS + hook relay
    eventBridge: EventBridge,          // Unix socket listener for this session
    chatState: ChatState,              // Message list, tool card states
    status: StateFlow<SessionStatus>,  // Active / AwaitingApproval / Idle / Dead
    name: StateFlow<String>,           // Auto-title, initially "New Session"
    titleFilePath: String,             // Where auto-title hook writes the name
    createdAt: Long,                   // For ordering in switcher
)

enum class SessionStatus { Active, AwaitingApproval, Idle, Dead }
```

### SessionManager

Holds the session collection and the "current" pointer:

```
class SessionManager {
    val sessions: StateFlow<Map<String, ManagedSession>>
    val currentSessionId: StateFlow<String?>

    fun createSession(cwd: File, dangerousMode: Boolean): ManagedSession
    fun switchTo(sessionId: String)
    fun destroySession(sessionId: String)
    fun getCurrentSession(): ManagedSession?
}
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Socket isolation | Each session gets `parser-{sessionId}.sock` | Hook events must route to the correct EventBridge |
| Title file isolation | Each session writes to `~/.claude-mobile/titles/{sessionId}` | Auto-title hook writes per-session; app watches each file |
| SessionManager location | Lives inside SessionService | Survives activity destruction |
| Session switching | Update `currentSessionId` StateFlow | ChatScreen recomposes with the target session's ChatState — instant, no data loss |

### Status Derivation

No new signals needed — derived from existing data:

| Status | Condition |
|--------|-----------|
| Active | `lastPtyOutputTime` within last 2 seconds |
| AwaitingApproval | Last message in `chatState` is `ToolAwaitingApproval` |
| Idle | `session.isRunning` but not Active or AwaitingApproval |
| Dead | `!session.isRunning` |

## Section 2: SessionService & Process Persistence

### Service Changes

The current `SessionService` manages one `PtyBridge`. Expanded to manage `SessionManager` + wake lock:

```
class SessionService : Service() {
    val sessionManager = SessionManager()
    private var wakeLock: PowerManager.WakeLock? = null

    fun createSession(bootstrap: Bootstrap, cwd: File, dangerousMode: Boolean, apiKey: String?)
    fun destroySession(sessionId: String)
    fun destroyAllSessions()
}
```

### Wake Lock

- `PARTIAL_WAKE_LOCK` — keeps CPU alive, screen can turn off
- Tagged: `"ClaudeMobile::Session"`
- Timeout: 4 hours (safety net against infinite drain)
- Acquired when first session created, released when last session destroyed

### Notification

Updates dynamically based on session state:

| Condition | Notification text |
|-----------|-------------------|
| Normal | "N sessions active" |
| Approval needed | "{session-name}: waiting for approval" (higher priority) |

Tapping the notification opens the app to the session that needs attention (session ID passed in Intent).

### Process Survival Strategy

- `START_STICKY` — Android restarts service if killed
- PTY processes are gone if Android kills the service. On restart, `SessionManager` finds all sessions `Dead`. They appear in the switcher with a red dot. User can tap to relaunch in the same CWD with the same flags.
- Chat history is in-memory only — lost if the process dies. Accepted trade-off.

### Session Cleanup

- Destroying a session: kills PTY, stops EventBridge, removes from map, deletes title file
- Last session destroyed: release wake lock, `stopForeground`, `stopSelf`
- `onTaskRemoved` (user swipes app from recents): keep service running. Sessions survive. User returns via notification.

## Section 3: Session Switcher UI

### Header Bar

```
[Terminal]    ● ▾ claude-mobile    [Claude mascot]
```

Status dot + dropdown chevron + auto-title name. Tappable.

### Dropdown Menu

Tap the session name → dropdown appears directly below:

```
            ┌───────────────────────────┐
            │ ● claude-mobile        ✕  │
            │ ◉ Multi-Session Design ✕  │
            │ ○ Journal Session      ✕  │
            │ ✕ Old Session     [Relaunch] │
            ├───────────────────────────┤
            │       + New Session       │
            └───────────────────────────┘
```

- Each row: status dot + session name + close button
- Tap a session → switch, dropdown dismisses
- Tap `✕` → destroy session (confirmation dialog if alive)
- Dead sessions show "Relaunch" instead of `✕`
- Current session visually highlighted (primary color accent)
- Sessions ordered by `createdAt`

### Status Dot Colors

| Status | Color |
|--------|-------|
| Active | Green (`#4CAF50`) |
| AwaitingApproval | Orange (`#FF9800`) |
| Idle | Gray (`#666666`) |
| Dead | Red (`#dd4444`) |

### New Session Dialog

Tap `+ New Session` → dialog opens:

```
    ┌─────────────────────────────┐
    │        New Session          │
    │                             │
    │  Working Directory:         │
    │  ○ Home (~)                 │
    │  ● claude-mobile            │
    │  ○ destin-claude            │
    │                             │
    │  ☐ Skip permissions         │
    │                             │
    │    [Cancel]    [Create]     │
    └─────────────────────────────┘
```

Directory picker (radio buttons for known directories) + `--dangerously-skip-permissions` toggle. "Create" launches the session and switches to it.

### Auto-Title Integration

Uses the existing `[Auto-Title]` hook mechanism from Destin's Claude setup. The hook writes a 3-5 word Title Case summary to the session's title file. The app watches each session's title file (coroutine polling loop, ~2 second interval) and updates `ManagedSession.name` StateFlow. The header pill text recomposes automatically.

Initial name before first auto-title: CWD basename (e.g., "claude-mobile").

## Section 4: Terminal View Replacement

### Dependency

```
implementation("com.github.termux.termux-app:terminal-view:v0.118.1")
```

Same version as the existing `terminal-emulator` dependency.

### Integration

Replace all uses of the custom `TerminalPanel.kt` Canvas renderer with Termux's `TerminalView` wrapped in Compose `AndroidView` interop:

**Full-screen terminal/shell modes:**
```kotlin
AndroidView(
    factory = { context ->
        TerminalView(context, null).apply {
            setTextSize(fontSizeDp)
            setTypeface(cascadiaMono)
            attachSession(session)
        }
    },
    update = { view ->
        view.attachSession(currentSession.ptyBridge.getSession())
    }
)
```

**Approval card mini-terminal embeds:**
```kotlin
AndroidView(
    factory = { context ->
        TerminalView(context, null).apply {
            attachSession(session)
            isEnabled = false  // read-only
        }
    },
    modifier = Modifier.height(120.dp)  // ~6 rows
)
```

Same component everywhere, different sizing. Zero custom Canvas rendering code.

### Capabilities Gained

From Termux's `TerminalView`, with no custom implementation:

- Text selection (long-press → drag handles → copy)
- Pinch-to-zoom
- Terminal resize / `SIGWINCH` (automatic on layout change)
- Scrollback via touch gesture
- Cursor rendering and blinking
- Proper text measurement and Unicode handling

### Theme Configuration

`TerminalView` colors configured programmatically to match existing theme:
- Background: `#0a0a0a`
- Foreground: `#e8e0d8`
- ANSI color palette: preserved from current `TerminalPanel` implementation

### Focus Handling

When switching to terminal mode, `TerminalView` gets keyboard focus via `view.requestFocus()`. When switching back to chat mode, focus returns to the Compose input bar via `view.clearFocus()`. Tied to `screenMode` state changes.

### What Stays

- `TerminalKeyboardRow` — extra keys composable sits below the `TerminalView`, unchanged
- `TerminalInputBar` — unchanged

### What Gets Deleted

- `TerminalPanel.kt` — deleted entirely (~300 lines of custom Canvas rendering)

## Section 5: Boot Self-Test

### Purpose

Catch broken bootstraps early with a clear diagnostic, instead of cryptic hangs mid-session.

### Implementation

After bootstrap extraction (and on every subsequent app launch), before launching Claude Code:

```kotlin
fun selfTest(): SelfTestResult {
    // Test 1: Can we execute bash through linker64?
    val bash = processBuilder("/system/bin/linker64", "$PREFIX/bin/bash", "--version")

    // Test 2: Can Node.js start?
    val node = processBuilder("/system/bin/linker64", "$PREFIX/bin/node", "-e", "process.exit(0)")

    // Test 3: Does Claude Code's CLI entry point exist?
    val cliExists = File("$PREFIX/lib/node_modules/@anthropic-ai/claude-code/cli.js").exists()

    return SelfTestResult(bash.ok, node.ok, cliExists)
}
```

### Failure Handling

If self-test fails: show a diagnostic screen instead of launching. Screen displays which test failed and offers a "Re-extract" button that re-runs `Bootstrap.setup()`.

## Section 6: linker64-env.sh Audit

### Background

Currently three layers intercept binary execution:

1. `LD_PRELOAD=libtermux-exec-ld-preload.so` — C-level `execve()` intercept
2. `claude-wrapper.js` — Node.js `child_process` intercept
3. `linker64-env.sh` — bash shell function wrappers for every binary in `$PREFIX/bin`

Layer 3 exists because layers 1-2 don't cover direct bash invocations. But `termux-exec` v2 (already enabled via `TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=enable`) should handle this at the LD_PRELOAD level.

### Investigation Steps

This is an investigation, not a guaranteed removal:

1. Disable `linker64-env.sh` generation
2. Test: bash interactive commands (`git`, `curl`, `python`, `apt`)
3. Test: Claude Code tool spawns (Bash, Read, Edit, etc.)
4. Test: subshells (`bash -c "git status"`)
5. If all pass → delete generation code (~100 lines in `Bootstrap.deployBashEnv()`)
6. If some fail → document which cases need shell functions, generate only those

### Decision

Made during implementation based on test results. The design accommodates either outcome.

## Data Flow

```
User taps "New Session" → SessionManager.createSession(cwd, dangerousMode)
    → creates ManagedSession with unique ID
    → creates PtyBridge with socket path "parser-{id}.sock"
    → starts EventBridge on that socket
    → starts Claude Code PTY (with --dangerously-skip-permissions if flagged)
    → adds to sessions map
    → sets as currentSessionId

User types in chat → ChatScreen reads currentSessionId
    → gets current ManagedSession
    → writes to that session's PtyBridge
    → hook events arrive on that session's EventBridge
    → routed to that session's ChatState
    → Compose renders that ChatState

User taps session switcher → picks different session
    → SessionManager.switchTo(otherId)
    → currentSessionId updates
    → ChatScreen recomposes with other session's ChatState
    → Terminal mode shows other session's TerminalView
    → Instant switch, no data loss on either side

Auto-title hook fires → writes to ~/.claude-mobile/titles/{sessionId}
    → SessionManager polls/watches file (~2s interval)
    → updates ManagedSession.name StateFlow
    → header pill text recomposes
```

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `runtime/ManagedSession.kt` | Bundles PtyBridge + EventBridge + ChatState + metadata |
| `runtime/SessionManager.kt` | Session collection, current pointer, create/switch/destroy |
| `ui/SessionSwitcher.kt` | Dropdown menu composable |
| `ui/NewSessionDialog.kt` | Directory picker + permissions toggle dialog |

### Modified Files

| File | Changes |
|------|---------|
| `runtime/SessionService.kt` | Holds SessionManager instead of single PtyBridge, adds wake lock, dynamic notification |
| `runtime/PtyBridge.kt` | Parameterize socket path (currently hardcoded), accept CWD and dangerousMode params |
| `ui/ChatScreen.kt` | Observe currentSessionId, render current session's ChatState. Replace TerminalPanel with TerminalView via AndroidView |
| `ui/cards/` (approval card) | Replace mini TerminalPanel with mini TerminalView |
| `runtime/Bootstrap.kt` | Add `selfTest()`, title file directory setup |
| `build.gradle.kts` | Add `terminal-view` dependency, `WAKE_LOCK` permission |
| `AndroidManifest.xml` | Add `WAKE_LOCK` permission |

### Deleted Files

| File | Reason |
|------|--------|
| `ui/TerminalPanel.kt` | Replaced entirely by Termux's TerminalView |

### Unchanged Files

- `ChatState.kt` — no structural changes, just instantiated per-session
- `EventBridge.kt` — no changes, just instantiated per-session with unique socket path
- `HookEvent.kt` — unchanged
- `DirectShellBridge.kt` — unchanged
- All card composables, theme, markdown renderer, syntax highlighter — unchanged
- `claude-wrapper.js` — unchanged
- `hook-relay.js` — unchanged (reads socket path from env var, already parameterized)
- `TerminalKeyboardRow.kt` — unchanged

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-18 | Initial multi-session architecture design |
