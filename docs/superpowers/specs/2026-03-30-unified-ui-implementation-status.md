# Unified UI Architecture — Implementation Status

**Date:** 2026-03-30
**Branch:** `unified-ui-architecture` (both repos)
**Status:** Working prototype — first-run prompts rendering, sessions creating, further integration needed

## Original Plan

Replace the mobile app's Compose chat UI with the desktop's React chat UI running in an Android WebView. A Kotlin `LocalBridgeServer` speaks the same WebSocket protocol as the desktop's `remote-server.ts`, connecting the React app to the existing Android runtime (PtyBridge, EventBridge, TranscriptWatcher).

**Original spec:** `docs/superpowers/specs/2026-03-30-unified-ui-architecture-design.md`
**Original plan:** `docs/superpowers/plans/2026-03-30-unified-ui-architecture-plan.md`

## What Was Built (vs. Plan)

### Plan said: "Full WebView — React handles everything, terminal stays native"

### What actually happened: Three architectural pivots during implementation

**Pivot 1: "Full WebView, no native terminal"** (commit ee3b710)
- Deleted ALL native Compose UI including the terminal view
- ChatScreen.kt reduced to a single WebView
- Rationale: simpler architecture, one UI surface

**Pivot 2: "Actually, we need the native terminal back"** (commit 76d306c)
- Restored native Termux terminal view alongside WebView
- Added floating toggle button for Chat/Terminal switching
- Rationale: The React terminal (xterm.js) requires raw PTY bytes, which Termux's `TerminalSession` doesn't expose. The Termux library reads PTY output internally and feeds it to its emulator — raw bytes are never available to our code. A PTY layer refactor (calling `JNI.createSubprocess()` directly) would be needed to make xterm.js work, which is significant effort with uncertain outcome.

**Pivot 3: "Prompt passthrough for first-run setup"** (commit c6bc18b)
- Bridge broadcasts `prompt:show`/`prompt:dismiss`/`prompt:complete` events
- React chat reducer renders PromptCards for Ink Select menus
- Dismisses "Initializing" overlay when prompt arrives
- Rationale: Claude Code's first-run setup (theme, login, folder trust) happens via Ink TUI menus that need terminal interaction. Without PTY output forwarding, these are invisible in the React chat view. The prompt passthrough bridges this gap using the existing `InkSelectParser` on the native side.

## Pitfalls Encountered

### 1. CORS on file:// origin
**Problem:** Vite's build output uses `<link>` and `<script>` tags that trigger CORS when loaded from `file:///android_asset/web/`.
**Fix:** Enable `allowFileAccessFromFileURLs` and `allowUniversalAccessFromFileURLs` on the WebView.

### 2. Login screen blocking auto-connect
**Problem:** The React app's `index.tsx` shows a login screen in non-Electron mode, waiting for a password. On Android, the `LocalBridgeServer` auto-accepts connections without auth.
**Fix:** Detect `file://` protocol in `index.tsx` and auto-connect with dummy password. Fix `getWsUrl()` in `remote-shim.ts` to return `ws://localhost:9901` for `file://` origin.

### 3. TerminalSession requires main thread (Looper)
**Problem:** Termux's `TerminalSession` creates an Android `Handler` in its constructor, which requires `Looper.prepare()`. The bridge's `handleBridgeMessage` ran on `Dispatchers.IO`.
**Fix:** Wrap `createSession()` and `destroySession()` in `withContext(Dispatchers.Main)`.

### 4. Native EmptySessionState blocking WebView
**Problem:** The Task 8 implementer kept the native Compose empty state, which conditionally rendered the WebView only when `currentSession != null`. The React app has its own empty state but was never visible.
**Fix:** Remove the gate. WebView always renders. React owns the empty/no-session UI.

### 5. Serialization format mismatches
**Problem:** Three format mismatches between what the bridge sent and what the React app expected:
- **Transcript events:** Content was in `payload` directly; React expected a `data` object nested inside
- **Hook events:** Used `hook_event_name` + camelCase; React expected `type` field + snake_case (`tool_name`, `_requestId`)
- **SessionInfo:** Used `dangerous` + `status: "running"`; React expected `skipPermissions` + `status: "active"` + `createdAt`

**Fix:** Rewrote TranscriptSerializer, HookSerializer, and MessageRouter to match the exact desktop protocol format. Validated against the complete protocol trace.

### 6. Missing bridge message handlers
**Problem:** The React app sends many messages on startup that the bridge didn't handle: `github:auth`, `remote:get-client-count` (every 10s), `session:terminal-ready`, `remote:get-config`, `remote:detect-tailscale`, `remote:get-client-list`, `favorites:get/set`, `transcript:read-meta`, `session:browse`, `session:history`.
**Fix:** Added handlers for all message types, returning sensible defaults (empty arrays, null, false, etc.).

### 7. Double bridge server start
**Problem:** Android's `onStartCommand()` can be called multiple times. The second `bridgeServer.start()` threw `BindException: Address already in use`.
**Fix:** Guard with `if (!bridgeServer.isRunning)`.

### 8. PTY output not available for xterm.js
**Problem:** Termux's `TerminalSession` reads PTY bytes internally, processes them through `TerminalEmulator`, and only exposes screen buffer changes via `onTextChanged()`. Raw VT100 bytes (needed by xterm.js) are never exposed. A `dup()` on the PTY fd doesn't work because both readers would compete for the same bytes.
**Decision:** Keep native Termux terminal for terminal mode. Don't attempt xterm.js on Android. The long-term fix would require replacing `TerminalSession` with a custom PTY wrapper that calls `JNI.createSubprocess()` directly and tees output to both xterm.js and the emulator.

### 9. "Initializing session" overlay blocking prompts
**Problem:** The React app shows an "Initializing session..." overlay until the first hook event arrives. But first-run setup prompts (theme, login) happen BEFORE any hook events fire. The overlay blocked the PromptCards.
**Fix:** `prompt:show` events also dismiss the "Initializing" overlay.

## Final Architecture

```
┌────────────────────────────────────────────────────┐
│                  Android Activity                   │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  WebView (always alive, React app)            │  │
│  │  - HeaderBar, SessionStrip (no terminal btn)  │  │
│  │  - ChatView with PromptCards for setup        │  │
│  │  - Tool cards, approval prompts               │  │
│  │  - InputBar, QuickChips, StatusBar            │  │
│  │  - SettingsPanel, CommandDrawer               │  │
│  │  remote-shim.ts → ws://localhost:9901         │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │  Native Terminal (toggled via floating FAB)   │  │
│  │  - Termux TerminalView (canvas rendering)     │  │
│  │  - TerminalKeyboardRow (Ctrl/Esc/Tab/arrows)  │  │
│  │  - Floating scroll arrows                     │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │  Floating Toggle Button (Chat ↔ Terminal)     │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │  Kotlin LocalBridgeServer (localhost:9901)    │  │
│  │  Protocol: same as desktop remote-server.ts   │  │
│  │  + prompt:show/dismiss/complete (Android-only) │  │
│  │  Routes to: PtyBridge, EventBridge,           │  │
│  │  TranscriptWatcher, InkSelectParser           │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │  Existing Runtime (unchanged)                 │  │
│  │  PtyBridge, ManagedSession, Bootstrap,        │  │
│  │  EventBridge, TranscriptWatcher               │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### Key Differences from Master Branch

| Aspect | Master Branch | unified-ui-architecture |
|---|---|---|
| Chat UI | Native Compose (ChatReducer, ToolCardV2, AssistantTurnBubble, etc.) | React WebView (shared with desktop) |
| Empty state | Native Compose EmptySessionState | React "No Active Session" (desktop's) |
| Session creation | Native Compose buttons → direct Kotlin call | React UI → WebSocket bridge → Kotlin |
| Tool cards | Native Compose ToolCardV2 | React ToolCard (desktop's) |
| Approval prompts | Native Compose PermissionButtons | React PermissionButtons (desktop's) |
| Markdown rendering | Custom regex parser (3 languages) | react-markdown + highlight.js (full) |
| Terminal view | Native Termux (same) | Native Termux (same) |
| Terminal keyboard | Native Compose TerminalKeyboardRow | Same |
| Settings/menus | Native Compose dropdown | React SettingsPanel + CommandDrawer |
| First-run prompts | Native Compose + InkSelectParser | InkSelectParser → bridge → React PromptCards |
| Status bar | Not present | React StatusBar (rate limits, context %) |
| Session strip | Native Compose pill | React SessionStrip (desktop's) |

### Files Changed (Mobile)

**Deleted (18 Compose UI files):**
- `ui/v2/` entire directory (9 files)
- `ui/MarkdownRenderer.kt`, `ui/SyntaxHighlighter.kt`, `ui/UnifiedTopBar.kt`, `ui/SessionSwitcher.kt`, `ui/QuickChips.kt`, `ui/NewSessionDialog.kt`, `ui/ChatState.kt`
- `ui/cards/CodeCard.kt`
- `ui/state/ChatReducer.kt`, `ui/state/ChatTypes.kt`, `ui/state/ToolInputFormatter.kt`
- `ui/theme/AppIcons.kt`, `config/ChipConfig.kt`

**Added (bridge layer):**
- `bridge/LocalBridgeServer.kt` — WebSocket server on localhost:9901
- `bridge/MessageRouter.kt` — Protocol message parser/builder
- `bridge/TranscriptSerializer.kt` — TranscriptEvent → desktop JSON format
- `bridge/HookSerializer.kt` — HookEvent → desktop JSON format
- `bridge/PlatformBridge.kt` — Android-native operations (file picker, clipboard)
- `ui/WebViewHost.kt` — WebView composable

**Modified:**
- `ui/ChatScreen.kt` — Hybrid WebView + native terminal with floating toggle
- `runtime/SessionService.kt` — Bridge server lifecycle + message routing
- `runtime/ManagedSession.kt` — Event forwarding to bridge, prompt broadcasting
- `runtime/SessionRegistry.kt` — Bridge server wiring for new sessions
- `app/build.gradle.kts` — OkHttp + Java-WebSocket dependencies
- `scripts/build-web-ui.sh` — Build script to bundle React app from desktop repo

### Files Changed (Desktop)

- `src/renderer/remote-shim.ts` — Android auto-connect, platform detection, prompt events
- `src/renderer/index.tsx` — Platform default, file:// auto-connect
- `src/renderer/App.tsx` — Prompt listeners, platform passing
- `src/renderer/platform.ts` — New: platform utility functions
- `src/renderer/styles/globals.css` — Safe area CSS, touch overrides
- `src/renderer/components/HeaderBar.tsx` — Touch targets, terminal toggle hidden on Android
- `src/renderer/components/ToolCard.tsx` — Touch-friendly approval buttons
- `src/renderer/components/QuickChips.tsx` — Larger chips on Android
- `src/main/remote-server.ts` — Platform field in auth response

## Remaining Work

### Critical (blocks normal usage)
1. **Transcript events not rendering in chat** — Sessions create and prompts show, but after first-run setup completes, assistant messages/tool calls don't appear in the React chat view. Need to verify the transcript event format matches what the React reducer expects and that TranscriptWatcher starts for the session.
2. **PTY output forwarding** — Terminal mode has no xterm.js on Android. Long-term requires PTY layer refactor or keeping native terminal.

### Important
3. **React terminal keyboard row** — If we eventually move to full xterm.js, need a React equivalent of TerminalKeyboardRow (Ctrl/Esc/Tab/arrows).
4. **Status dot CSS overflow** — The pulsing animation on session status dots overflows its container on mobile.
5. **session:browse / session:history** — Return empty arrays; need implementation for session resume.
6. **session:renamed** — Not pushed; need FileObserver on title/topic files.
7. **status:data** — Not pushed; need periodic broadcast of available data.

### Nice to have
8. **dialog:open-file** — Returns empty; need Android file picker bridge wiring.
9. **Back gesture handling** — Not implemented.
10. **Version handshake** — Not implemented.
