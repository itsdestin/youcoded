# Multi-Session Architecture Design

**Date:** 2026-03-18
**Version:** 1.1
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

## Section 1: ManagedSession & SessionRegistry

### Naming: Existing SessionManager

The existing `SessionManager.kt` handles Activity-to-Service binding (ServiceConnection, SessionState sealed class, bind/unbind lifecycle). It is **renamed to `ServiceBinder`** to free the name, since its role is service binding, not session management. `MainActivity.kt` references are updated accordingly.

The new multi-session coordinator is named `SessionRegistry` (not `SessionManager`) to further avoid ambiguity.

### ManagedSession

A self-contained unit bundling everything one Claude Code session needs:

```
ManagedSession(
    id: String,                        // UUID
    cwd: File,                         // Working directory
    dangerousMode: Boolean,            // --dangerously-skip-permissions
    ptyBridge: PtyBridge,              // PTY + wrapper JS (owns EventBridge internally)
    chatState: ChatState,              // Message list, tool card states
    status: StateFlow<SessionStatus>,  // Active / AwaitingApproval / Idle / Dead
    name: StateFlow<String>,           // Auto-title, initially CWD basename
    titleFilePath: String,             // Where auto-title hook writes the name
    createdAt: Long,                   // For ordering in switcher
)

enum class SessionStatus { Active, AwaitingApproval, Idle, Dead }
```

### EventBridge Ownership

`PtyBridge` continues to own and manage `EventBridge` internally, as it does today. The socket name is parameterized via `PtyBridge`'s constructor. `ManagedSession` accesses the EventBridge through `ptyBridge.getEventBridge()` — same pattern `ChatScreen` uses now.

This avoids splitting lifecycle management. PtyBridge creates the EventBridge before launching Claude Code (hooks fire immediately on launch) and stops it when the session is destroyed.

### Socket Architecture

EventBridge uses Android `LocalServerSocket`, which creates **abstract namespace** Unix sockets (not filesystem paths). These are global to the device. Each session's socket name must be unique: `parser-{sessionId}`.

The current socket name (`${homeDir}/.claude-mobile/parser.sock`) happens to look like a file path but is already an abstract namespace string. This design changes the name format to `parser-{sessionId}`. The `CLAUDE_MOBILE_SOCKET` env var passes this name to `hook-relay.js`, which connects with the `'\0'` abstract namespace prefix. `hook-relay.js` is agnostic to the name content — it uses whatever string is in the env var — so it requires no code changes despite the format change.

### SessionRegistry

Holds the session collection and the "current" pointer:

```
class SessionRegistry {
    val sessions: StateFlow<Map<String, ManagedSession>>
    val currentSessionId: StateFlow<String?>

    fun createSession(bootstrap: Bootstrap, cwd: File, dangerousMode: Boolean, apiKey: String?): ManagedSession
    fun switchTo(sessionId: String)
    fun destroySession(sessionId: String)
    fun getCurrentSession(): ManagedSession?
}
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Socket isolation | Each session gets abstract namespace socket `parser-{sessionId}` | Hook events must route to the correct EventBridge; abstract namespace avoids filesystem collisions |
| Title file isolation | Each session writes to `~/.claude-mobile/titles/{sessionId}` | Auto-title hook writes per-session; app watches each file |
| SessionRegistry location | Lives inside SessionService | Survives activity destruction |
| Session switching | Update `currentSessionId` StateFlow | ChatScreen recomposes with the target session's ChatState — instant, no data loss |
| EventBridge ownership | PtyBridge owns EventBridge (unchanged) | Keeps lifecycle management simple; socket name parameterized via PtyBridge constructor |
| Session limit | Soft limit of 5 concurrent sessions | Each session consumes a PTY, Node.js process, and EventBridge socket. Show warning dialog when creating 6th session. |
| API key | Passed to `createSession()`, forwarded to PtyBridge | Same mechanism as today; all sessions share the same API key from app config |

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

The current `SessionService` manages one `PtyBridge`. Expanded to manage `SessionRegistry` + wake lock:

```
class SessionService : Service() {
    val sessionRegistry = SessionRegistry()
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
- When timeout fires: wake lock releases silently. Sessions may stall if CPU sleeps. User reopening the app re-acquires the wake lock. Long-running tasks (>4h) are an accepted edge case — user can manually re-acquire by switching to the app.
- Acquired when first session created, released when last session destroyed

### Notification

Two notification channels:

| Channel | ID | Importance | Purpose |
|---------|-----|-----------|---------|
| Session | `claude_session` | `IMPORTANCE_LOW` | Normal session status |
| Approval | `claude_approval` | `IMPORTANCE_HIGH` | Permission prompts (heads-up notification) |

Dynamic notification text:

| Condition | Channel | Text |
|-----------|---------|------|
| Normal | `claude_session` | "N sessions active" |
| Approval needed | `claude_approval` | "{session-name}: waiting for approval" |

Tapping the notification opens the app to the session that needs attention (session ID passed in Intent).

### Process Survival Strategy

- `START_STICKY` — Android restarts the service process if killed
- **On process death:** All PTY processes die. `SessionRegistry` is a fresh empty instance on restart — there is no persistence layer. Sessions are gone. The user starts fresh. This is the accepted trade-off for in-memory-only chat history (option C from requirements).
- **On normal backgrounding:** Wake lock keeps CPU alive. Foreground service notification keeps the process running. Sessions survive indefinitely within the wake lock timeout.

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

Uses the existing `[Auto-Title]` hook mechanism from Destin's Claude setup. The hook writes a 3-5 word Title Case summary to the session's title file at `~/.claude-mobile/titles/{sessionId}`. The app watches each session's title file via `FileObserver` (inotify-based, zero polling overhead) and updates `ManagedSession.name` StateFlow. The header pill text recomposes automatically.

Initial name before first auto-title: CWD basename (e.g., "claude-mobile").

## Section 4: Terminal View Replacement

### Dependency

```
implementation("com.github.termux.termux-app:terminal-view:v0.118.1")
```

Same version as the existing `terminal-emulator` dependency.

### Integration

Replace all uses of the custom `TerminalPanel.kt` Canvas renderer with Termux's `TerminalView` wrapped in Compose `AndroidView` interop.

`TerminalView` requires two things at setup:
1. A `TerminalSession` (from `PtyBridge.getSession()`)
2. A `TerminalViewClient` interface implementation (handles keyboard input, clipboard, context menus)

**TerminalViewClient implementation:**

A new `ClaudeTerminalViewClient` class implementing the required interface:
- `onTextInput()` — forward text to PtyBridge (replaces current manual writeInput)
- `onKeyDown()`/`onKeyUp()` — handle hardware keyboard events
- `onCopyTextToClipboard()` — copy to Android clipboard
- `onPasteTextFromClipboard()` — paste from Android clipboard
- `readExternalClipboard()` — read clipboard content for paste
- Scale/font callbacks — delegate to theme configuration

**Full-screen terminal/shell modes:**
```kotlin
AndroidView(
    factory = { context ->
        TerminalView(context, null).apply {
            setTextSize(fontSizeDp)
            setTypeface(cascadiaMono)
            attachSession(session, viewClient)
        }
    },
    update = { view ->
        view.attachSession(currentSession.ptyBridge.getSession(), viewClient)
    }
)
```

**Mini-terminal embeds in approval cards:**

The existing approval card (`ApprovalCard.kt`) does not currently contain a terminal embed. The chat-rebuild design spec described this as a future feature. This design adds it:

```kotlin
AndroidView(
    factory = { context ->
        TerminalView(context, null).apply {
            attachSession(session, readOnlyViewClient)
            isEnabled = false  // read-only, no touch input
        }
    },
    modifier = Modifier.height(120.dp)  // ~6 rows
)
```

This is **new functionality** — the approval card gains a live terminal preview showing what Claude Code is actually displaying (the permission prompt text). The `readOnlyViewClient` is a no-op implementation that ignores input callbacks.

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

After bootstrap extraction (and on every subsequent app launch), before launching any Claude Code session:

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

## Section 7: DirectShellBridge Scoping

`DirectShellBridge` (long-press Shell mode) remains **global, not per-session**. Rationale:

- The shell is a general-purpose escape hatch — it shares the Bootstrap environment but is not tied to any Claude Code instance.
- Creating per-session shells adds complexity without clear benefit — the shell doesn't interact with Claude Code's hook system.
- The current behavior (one shared shell, accessible from any screen mode) is preserved.

If the user switches Claude Code sessions, the Shell mode still shows the same `DirectShellBridge` instance. This matches Termux's model where additional terminal sessions are independent of each other.

## Data Flow

```
User taps "New Session" → SessionRegistry.createSession(bootstrap, cwd, dangerousMode, apiKey)
    → creates ManagedSession with unique ID
    → creates PtyBridge with socket name "parser-{id}" (abstract namespace)
    → PtyBridge starts EventBridge on that socket internally
    → PtyBridge starts Claude Code PTY (with --dangerously-skip-permissions if flagged)
    → adds to sessions map
    → sets as currentSessionId
    → starts FileObserver on title file

User types in chat → ChatScreen reads currentSessionId
    → gets current ManagedSession
    → writes to that session's PtyBridge
    → hook events arrive on that session's PtyBridge.getEventBridge()
    → routed to that session's ChatState
    → Compose renders that ChatState

User taps session switcher → picks different session
    → SessionRegistry.switchTo(otherId)
    → currentSessionId updates
    → ChatScreen recomposes with other session's ChatState
    → Terminal mode attaches other session's TerminalSession to TerminalView
    → Instant switch, no data loss on either side

Auto-title hook fires → writes to ~/.claude-mobile/titles/{sessionId}
    → FileObserver triggers
    → updates ManagedSession.name StateFlow
    → header pill text recomposes
```

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `runtime/ManagedSession.kt` | Bundles PtyBridge + ChatState + metadata per session |
| `runtime/SessionRegistry.kt` | Session collection, current pointer, create/switch/destroy |
| `runtime/ClaudeTerminalViewClient.kt` | TerminalViewClient implementation for Termux's TerminalView |
| `ui/SessionSwitcher.kt` | Dropdown menu composable |
| `ui/NewSessionDialog.kt` | Directory picker + permissions toggle dialog |

### Modified Files

| File | Changes |
|------|---------|
| `runtime/SessionManager.kt` | **Renamed to `ServiceBinder.kt`** — same functionality, name freed for clarity |
| `runtime/SessionService.kt` | Holds SessionRegistry instead of single PtyBridge, adds wake lock, dual notification channels, dynamic notification |
| `runtime/PtyBridge.kt` | Constructor accepts socket name (currently computed internally), CWD (currently hardcoded to `bootstrap.homeDir`), and dangerousMode flag. `start()` method appends `--dangerously-skip-permissions` to the Claude Code launch command when flagged. `TerminalSession` CWD parameter (currently `bootstrap.homeDir.absolutePath`) uses the new CWD param instead. |
| `ui/ChatScreen.kt` | Observe currentSessionId from SessionRegistry, render current session's ChatState. Replace TerminalPanel with TerminalView via AndroidView. Add session switcher in header. |
| `ui/cards/` (approval card) | Add mini TerminalView embed (new functionality) |
| `runtime/Bootstrap.kt` | Add `selfTest()`, title file directory setup (`~/.claude-mobile/titles/`) |
| `MainActivity.kt` | Update references from SessionManager to ServiceBinder |
| `build.gradle.kts` | Add `terminal-view` dependency |
| `AndroidManifest.xml` | Add `WAKE_LOCK` permission |

### Deleted Files

| File | Reason |
|------|--------|
| `ui/TerminalPanel.kt` | Replaced entirely by Termux's TerminalView |

### Unchanged Files

- `ChatState.kt` — no structural changes, just instantiated per-session
- `EventBridge.kt` — no changes, just instantiated per-session with unique socket name
- `HookEvent.kt` — unchanged
- `DirectShellBridge.kt` — unchanged (global, not per-session)
- All card composables (except approval card), theme, markdown renderer, syntax highlighter — unchanged
- `claude-wrapper.js` — unchanged
- `hook-relay.js` — unchanged (reads socket name from env var, already parameterized)
- `TerminalKeyboardRow.kt` — unchanged
- `TerminalInputBar.kt` — unchanged

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-18 | Initial multi-session architecture design |
| 1.1 | 2026-03-18 | Address spec review: rename SessionManager→ServiceBinder, new class is SessionRegistry; clarify abstract namespace sockets; clarify EventBridge ownership stays in PtyBridge; fix START_STICKY behavior (no persistence, sessions gone on process death); add wake lock timeout behavior; add TerminalViewClient requirement; clarify mini-terminal in cards is new functionality; add DirectShellBridge scoping (Section 7); add session limit (5); add API key to createSession; add dual notification channels; switch title file watching to FileObserver |
