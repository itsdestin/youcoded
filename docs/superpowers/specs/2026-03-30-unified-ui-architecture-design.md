# Unified UI Architecture — Design

**Date:** 2026-03-30
**Status:** Proposed
**Scope:** Both repos — `youcoded` (mobile) and `youcoded-core` (desktop)

## Summary

Replace the mobile app's Compose chat UI with the desktop's React chat UI running in an Android WebView. A Kotlin `LocalBridgeServer` speaks the same WebSocket protocol as the desktop's `remote-server.ts`, routing to the existing native runtime (PtyBridge, EventBridge, TranscriptWatcher). The native Termux terminal stays untouched. The result is a single React codebase rendering chat, menus, settings, and status on both platforms.

## Goals

- A user switching between desktop and mobile sees visually identical chat UI, tool cards, approval prompts, menus, and settings
- All existing mobile features work: sending messages, approving tools, file attachments, permission mode cycling, session creation/switching/closing, quick chips
- Terminal view works exactly as it does today
- No regression in chat performance (message rendering, scroll, approval response time)
- New UI features added to the React app appear on both platforms automatically

## Non-Goals

- Replace the native terminal view with xterm.js
- Change the desktop app's Electron architecture
- Merge the two Git repositories
- Change Claude Code itself or the hook system

## Architecture

### High-Level Structure

```
┌────────────────────────────────────────────────────┐
│                  Android Activity                   │
│  ┌──────────────────────────────────────────────┐  │
│  │         WebView (chat mode)                   │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │  React App (same build as desktop)     │  │  │
│  │  │  - HeaderBar, SessionStrip             │  │  │
│  │  │  - ChatView, ToolCards, Approvals      │  │  │
│  │  │  - InputBar, QuickChips                │  │  │
│  │  │  - SettingsPanel, CommandDrawer         │  │  │
│  │  │  - StatusBar                           │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  │  remote-shim.ts → ws://localhost:9901        │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │    Native Terminal (shown when toggled)        │  │
│  │    Termux canvas + keyboard row               │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │         Kotlin LocalBridgeServer              │  │
│  │  Speaks remote-server.ts protocol             │  │
│  │  Routes to: PtyBridge, EventBridge,           │  │
│  │  TranscriptWatcher, FileSystem, Clipboard     │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### LocalBridgeServer

A Kotlin WebSocket server on `localhost:9901` implementing the same protocol as `remote-server.ts`.

**Protocol format:**

```json
// Request/response
{ "type": "session:create", "id": "msg-1", "payload": { ... } }
{ "type": "session:create:response", "id": "msg-1", "payload": { ... } }

// Fire-and-forget
{ "type": "session:input", "payload": { "sessionId": "abc", "text": "hello\r" } }

// Server push
{ "type": "hook:event", "payload": { ... } }
{ "type": "transcript:event", "payload": { ... } }
```

**Method routing:**

| Protocol Message | Kotlin Target |
|---|---|
| `session:create` | `SessionRegistry.createSession()` → spawns PTY via PtyBridge |
| `session:destroy` | `SessionRegistry.destroySession()` → kills PTY |
| `session:list` | `SessionRegistry.sessions` snapshot |
| `session:input` | `PtyBridge.writeInput(text)` |
| `session:resize` | `PtyBridge.resize(cols, rows)` |
| `permission:respond` | `EventBridge.respond(requestId, decision)` |
| `session:browse` | Reads JSONL files from `~/.claude/projects/`, returns array of `{ sessionId, projectSlug, title, lastModified }` matching desktop's `session:browse` response shape |
| `session:history` | Parses historical JSONL transcript, returns array of parsed messages matching desktop's `session:history` response shape |
| `dialog:open-file` | Sends intent to Activity → Android file picker → returns paths |
| `dialog:open-folder` | SAF directory picker → returns path |
| `clipboard:save-image` | `ClipboardManager` → save to temp file → return path |
| `skills:list` | Reads skill files from filesystem |
| `get-home-path` | Returns `$HOME` |

**Push events:**

| Event | Source |
|---|---|
| `transcript:event` | TranscriptWatcher → serialized to desktop JSON format |
| `hook:event` | EventBridge → serialized to desktop JSON format |
| `status:data` | Periodic push (10s) — version and session count always available. Rate limits and context % included when Claude Code's usage cache files exist at `~/.claude/usage/` (same paths as desktop). Fields absent on Android are omitted; React StatusBar renders only what's present. |
| `session:renamed` | Title/topic file changes from ManagedSession |

**Auth:** Skipped for localhost. Server binds to `127.0.0.1` only.

**Lifecycle:** Started with `SessionService` (foreground service), stopped with service. WebView connects on load; reconnects via `remote-shim.ts` existing backoff.

### WebView Hosting

**Activity structure:**

```
MainActivity
└── FrameLayout (fills screen)
    ├── WebView (chat mode) — VISIBLE or GONE
    │   └── file:///android_asset/web/index.html
    └── TerminalContainer (terminal mode) — VISIBLE or GONE
        ├── TerminalView (Termux canvas)
        ├── TerminalKeyboardRow
        └── Floating arrow buttons
```

**View switching:** React header bar toggle sends `ui:action:broadcast` with `{ action: 'switch-view', mode: 'terminal' }` over WebSocket. Kotlin side toggles visibility. WebView is never disposed — stays alive behind terminal to preserve state.

**WebView configuration:**
- `javaScriptEnabled = true`
- `domStorageEnabled = true`
- `allowFileAccess = true` (for asset loading and attachment thumbnails)
- `mixedContentMode = MIXED_CONTENT_NEVER_ALLOW`
- Hardware acceleration enabled
- Background color `#111111` (matches app background, prevents white flash)
- `WebChromeClient` for console.log → Logcat forwarding (debug builds)

### Platform Detection

`remote-shim.ts` sets `window.__PLATFORM__` from the server's auth response:

```typescript
window.__PLATFORM__ = 'android' | 'electron' | 'browser'
```

Used for: safe area padding, hiding desktop-only features (game panel), touch adaptations, platform-specific file picker behavior.

### Native Bridges

| Operation | Mechanism |
|---|---|
| File picker | WebSocket message → Kotlin Activity → `ActivityResultContracts.GetMultipleContents()` → copies to `$HOME/attachments/` → returns paths over WebSocket |
| Clipboard image | WebSocket message → `ClipboardManager.getPrimaryClip()` → save to temp → return path |
| URL opening | WebSocket message → `Intent(ACTION_VIEW, uri)` |
| Notifications | Native Kotlin only — LocalBridgeServer monitors for AwaitingApproval state, fires via NotificationManager |
| WakeLock | Native Kotlin only — no change |
| Back gesture | `onBackPressed` → if settings/drawer open, send close action to React; otherwise normal Android back |

## Shared React App — Mobile Adaptations

### Responsive Breakpoints

| Breakpoint | Width | Target |
|---|---|---|
| (default) | < 640px | Phone portrait |
| `sm:` | ≥ 640px | Phone landscape / small tablet |
| `md:` | ≥ 768px | Tablet / desktop narrow |
| `lg:` | ≥ 1024px | Desktop normal |

### Touch Adaptations (when `__PLATFORM__ === 'android'`)

| Element | Desktop | Mobile |
|---|---|---|
| Approval buttons | `py-1` (~28px) | `py-2` (~36px) |
| Quick chips | `h-6` (24px) | `h-8` (32px) |
| Tool card header | `px-3 py-2` | `px-3 py-2.5` |
| Close/delete buttons | `w-5 h-5`, hover reveal | `w-6 h-6`, always visible |
| Settings gear | 16px | 20px |
| Hover states | `hover:bg-gray-800` | Disabled — use `:active` states |
| Session close button | Hidden until hover | Always visible, lower opacity |
| Copy button (code blocks) | Hidden until hover | Always visible |

### Safe Area Handling

```css
.android-safe-area {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}
```

Header bar gets `safe-area-inset-top`. Input bar gets `safe-area-inset-bottom`. Viewport meta includes `viewport-fit=cover`.

### Features Mobile Gains

- StatusBar (rate limits, context %, sync status)
- Command Drawer (skill browser with search)
- Resume Browser (browse and resume past sessions)
- Backdrop blur on overlays
- Full markdown rendering (tables, full syntax highlighting via highlight.js)
- Skill cards with source badges

### Features Hidden on Mobile

- Game panel toggle (desktop-only)
- `dialog.openFolder()` (folder selection stays native for session creation)
- Drag-and-drop file attachments

## Build Pipeline

### React App Delivery

Built once (Vite), output goes two places:
- Desktop: bundled into Electron's `renderer/` (no change)
- Mobile: copied into `app/src/main/assets/web/` at build time

The mobile repo's `assets/web/` is gitignored — it's a build artifact.

### Mobile Build Process

1. Clone/pull desktop repo (or download tagged release artifact)
2. `npm run build` in `desktop/`
3. Copy `dist/renderer/` → `app/src/main/assets/web/`
4. Run normal Gradle Android build

### Development Workflow

For local hot-reload development:
1. `npm run dev` in desktop repo (Vite dev server on `localhost:5173`)
2. Point Android WebView at `http://10.0.2.2:5173` (emulator alias for host localhost)
3. Build config flag `DEV_WEBVIEW_URL` controls this; production always uses bundled assets

### Versioning

React build includes version string from `package.json`. Mobile checks on WebView load — if bundled version is too old (missing required protocol methods), shows "UI update required" instead of broken UI.

## Migration — Files Changed

### Mobile: Deleted (Compose UI replaced by React)

- `ui/state/ChatReducer.kt` — Compose state management
- `ui/state/ChatTypes.kt` — Timeline/tool state types
- `ui/AssistantTurnBubble.kt` — Assistant message bubble
- `ui/UserMessageBubble.kt` — User message bubble
- `ui/cards/ToolCardV2.kt` — Tool call card
- `ui/cards/PromptCardV2.kt` — Prompt card
- `ui/cards/CodeCard.kt` — Code block
- `ui/MarkdownRenderer.kt` — Regex markdown parser
- `ui/SyntaxHighlighter.kt` — 3-language highlighter
- `ui/UnifiedTopBar.kt` — Header bar
- `ui/SessionSwitcher.kt` — Session dropdown
- `ui/QuickChips.kt` — Chip row
- `ui/ThinkingIndicator.kt` — Loading indicator
- `ui/BrailleSpinner.kt` — Compose spinner
- `ui/NewSessionDialog.kt` — Session creation popup
- `ui/theme/DesktopColors.kt` — Color constants
- `ui/theme/AppIcons.kt` — Compose icons
- `config/ChipConfig.kt` — Chip definitions

### Mobile: Modified

| File | Change |
|---|---|
| `ui/ChatScreen.kt` | Gutted — thin shell hosting WebView + TerminalView, handles view switching |
| `ui/theme/Theme.kt` | Simplified — only terminal and keyboard row theming |
| `runtime/ManagedSession.kt` | Remove ChatReducer/ChatState references, add LocalBridgeServer event forwarding |
| `runtime/SessionService.kt` | Start/stop LocalBridgeServer alongside sessions |

### Mobile: Added

| File | Purpose |
|---|---|
| `bridge/LocalBridgeServer.kt` | WebSocket server, speaks remote-server.ts protocol |
| `bridge/PlatformBridge.kt` | Android-specific operations (file picker, clipboard, notifications) |
| `bridge/TranscriptSerializer.kt` | TranscriptEvent → desktop JSON format |
| `bridge/HookSerializer.kt` | HookEvent → desktop JSON format |
| `ui/WebViewHost.kt` | WebView configuration and lifecycle |
| `assets/web/` (gitignored) | Built React app bundle |

### Desktop: Modified

| File | Change |
|---|---|
| `remote-shim.ts` | Add platform field from auth response, set `window.__PLATFORM__` |
| `App.tsx` | Read `__PLATFORM__`, pass to components, handle `switch-view` action |
| `globals.css` | Safe area rules, touch overrides, android-specific class |
| `InputBar.tsx` | Platform-aware file picker |
| Various components | Touch adaptations (larger targets, always-visible instead of hover-reveal) |

### Unchanged

- `TerminalPanel.kt`, `TerminalKeyboardRow.kt` — untouched
- `PtyBridge.kt` — untouched
- `Bootstrap.kt`, runtime logic — untouched
- `EventBridge.kt`, `TranscriptWatcher.kt` — untouched (new consumer, same code)
- `InkSelectParser.kt` — untouched
- Desktop Electron main process — untouched

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| WebView scroll perf on long chats | Jank, memory bloat | Add `react-window` or `@tanstack/virtual` to React chat. Fixes latent desktop issue too. |
| WebSocket latency for approvals | Delayed tool responses | Localhost should be <1ms. Measure; fall back to `@JavascriptInterface` for approvals only if needed. |
| View switch flicker | White flash between modes | Keep WebView always rendered (VISIBLE/GONE). Set bg to `#111111`. |
| File picker async complexity | Broken attachment flow | Timeout + loading indicator. Return empty array on dismiss (matches desktop). |
| React bundle APK size | Bloated install | ~2-3MB gzipped. Acceptable. Monitor and lazy-load if needed. |
| Protocol drift | Desktop adds method, mobile doesn't | Version handshake on connect. React checks `serverCapabilities`, degrades gracefully. Shared TypeScript interface as contract. |

## Testing Strategy

| Layer | Method |
|---|---|
| LocalBridgeServer protocol | Kotlin unit tests — mock PtyBridge/EventBridge, verify JSON matches desktop format. Use desktop's remote-shim payloads as fixtures. |
| End-to-end message flow | On device: send message → appears in chat → Claude Code receives via PTY stdin. Same for approvals. |
| Visual parity | Side-by-side screenshots: desktop at 400px width vs mobile. Pixel-diff chat area. |
| Terminal switching | Rapid toggle 20+ times — no crashes, no state loss, no leaked connections. |
| Attachment flow | Pick image → thumbnail appears → send → Claude Code receives path. |
| Offline resilience | Kill LocalBridgeServer mid-session → React shows reconnecting → restart → auto-reconnect. |

## Rollback Plan

Entire Compose chat UI remains on `main` branch. If WebView approach proves unworkable, the testing branch is abandoned with zero impact to production.
