# DestinCode Remote Web Access — Design Spec

**Date:** 2026-03-24
**Version:** 1.1
**Status:** Approved

## Summary

Add a remote web access layer to the DestinCode desktop app, allowing the full UI (chat view, terminal view, tool cards, approval prompts, session management) to be accessed from any web browser over a secure connection. The feature plugs into the existing Electron main process alongside the current IPC infrastructure, reusing the same React renderer with a WebSocket transport shim replacing Electron IPC.

## Design Decisions

### Transport: WebSocket bridge in the Electron main process

**Decision:** A single `RemoteServer` class in `src/main/remote-server.ts` starts an HTTP + WebSocket server on a configurable port (default `9900`). It shares the same `SessionManager` and `HookRelay` instances that the Electron IPC handlers use.

**Rationale:** The IPC surface is small (~15 methods) and well-defined via `window.claude`. Adding a WebSocket translation layer is minimal code (~200 lines) and avoids duplicating session management or hook relay logic. A separate process would require shared state coordination with no benefit at this stage.

### View model: Shared view

**Decision:** Remote clients see the same sessions as the local Electron window. All clients (Electron + any number of browser connections) share one set of sessions. Input from any client goes to the same PTY.

**Rationale:** Simplest model. The user is the only person using the app. Independent views would require session ownership tracking with no practical benefit.

### Concurrent connections: Multiple clients supported

**Decision:** The WebSocket server maintains a `Set<WebSocket>` of authenticated clients. All events are broadcast to all connected clients.

**Rationale:** Nearly zero additional complexity over single-connection. Enables having the UI open on phone and laptop simultaneously.

### Authentication: User-set password with optional Tailscale trust

**Decision:** Password stored as a bcrypt hash in `~/.claude/destincode-remote.json`. Browser sessions persist via a server-generated token stored in `localStorage`. Optional `trustTailscale` flag skips auth for connections from Tailscale IP ranges (`100.64.0.0/10`).

**Rationale:** A remembered password is convenient across restarts. Bcrypt is standard for at-rest password storage. Session tokens avoid re-entering the password on every page load. Tailscale trust is a convenience toggle for users who are the sole occupant of their Tailnet.

### Dialog methods: Stubbed for now

**Decision:** `dialog.openFile()`, `dialog.openFolder()`, and `dialog.saveClipboardImage()` return empty/null in the remote UI. No browser-native replacements in v1.

**Rationale:** These are non-essential for the core remote experience (chat, terminal, tool calls, approvals). Can be addressed later if needed.

## Architecture

### Connection flow

```
Browser (any device on Tailnet)
  │
  │  HTTP GET / → static React app (Vite-built dist/renderer/)
  │  WS /ws → bidirectional JSON messages
  │
  ▼
DestinCode Electron Main Process (port 9900)
  ├─ RemoteServer
  │    ├─ HTTP static file server
  │    ├─ WebSocket server
  │    │    ├─ Auth (bcrypt password or session token)
  │    │    ├─ Message routing → SessionManager / HookRelay
  │    │    └─ Event broadcasting → all connected clients
  │    └─ Rolling buffers (terminal output + hook events per session)
  │
  ├─ SessionManager (shared with Electron IPC — unchanged)
  ├─ HookRelay (shared with Electron IPC — unchanged)
  └─ Electron BrowserWindow (local UI — unchanged)
```

### Message protocol

All messages are JSON with the following structure:

**Client → Server (request):**
```json
{
  "type": "session:create",
  "id": "msg-1",
  "payload": { "name": "New Session", "cwd": "/home/user", "skipPermissions": false }
}
```

**Server → Client (response):**
```json
{
  "type": "session:create:response",
  "id": "msg-1",
  "payload": { "id": "uuid", "name": "New Session", "cwd": "/home/user", ... }
}
```

**Server → Client (push event):**
```json
{
  "type": "pty:output",
  "payload": { "sessionId": "uuid", "data": "..." }
}
```

Message types map 1:1 to the existing IPC channels defined in `src/shared/types.ts`:

| IPC Channel | WS Message Type | Direction | Style |
|---|---|---|---|
| `session:create` | `session:create` | request/response | invoke |
| `session:destroy` | `session:destroy` | request/response | invoke |
| `session:list` | `session:list` | request/response | invoke |
| `session:input` | `session:input` | client → server | fire-and-forget |
| `session:resize` | `session:resize` | client → server | fire-and-forget |
| `session:terminal-ready` | `session:terminal-ready` | client → server | fire-and-forget |
| `permission:respond` | `permission:respond` | request/response | invoke |
| `skills:list` | `skills:list` | request/response | invoke |
| `get-home-path` | `get-home-path` | request/response | invoke |
| `transcript:read-meta` | `transcript:read-meta` | request/response | invoke (routed via WS) |
| `github:auth` | `github:auth` | request/response | invoke (routed via WS) |
| `pty:output` | `pty:output` | server → client | push |
| `hook:event` | `hook:event` | server → client | push |
| `session:created` | `session:created` | server → client | push |
| `session:destroyed` | `session:destroyed` | server → client | push |
| `session:renamed` | `session:renamed` | server → client | push |
| `status:data` | `status:data` | server → client | push |

**Stubbed methods** (return default values in remote UI, no WebSocket round-trip):

| Method | Return Value |
|---|---|
| `dialog.openFile()` | `[]` |
| `dialog.openFolder()` | `null` |
| `dialog.saveClipboardImage()` | `null` |
| `shell.openChangelog()` | `void` (no-op) |

### Authentication protocol

1. Client opens WebSocket to `/ws`
2. Client sends: `{ "type": "auth", "password": "..." }` or `{ "type": "auth", "token": "..." }`
3. Server validates:
   - Password: bcrypt compare against stored hash
   - Token: lookup in in-memory token map
   - Tailscale trust: if `trustTailscale` is true and source IP is in `100.64.0.0/10`, auto-accept
4. Success: server sends `{ "type": "auth:ok", "token": "uuid" }` — client stores token in `localStorage`
5. Failure: server sends `{ "type": "auth:failed" }` and closes the socket
6. Timeout: if no auth message within 5 seconds, server closes the socket

### State synchronization

When a remote client connects to an already-running DestinCode instance:

**Session list:** Server sends a `session:list` response immediately after auth, so the client knows what sessions exist.

**Terminal buffer replay:** The server maintains a rolling buffer of the last 256KB of PTY output per session (enough for ~4000 lines of typical terminal output). On connect, it replays this as a burst of `pty:output` messages. The client's xterm.js renders recent terminal history.

**Hook event replay:** The server maintains a rolling buffer of the last 500 hook events per session (a typical Claude Code conversation generates ~50-100 hook events per exchange, so 500 covers the last 5-10 exchanges). On connect, it replays these so the chat view populates with recent tool calls, responses, and messages.

Both buffer sizes are constants in `remote-server.ts` and can be adjusted if needed.

**Status data:** `RemoteServer` runs its own 10-second polling interval (same logic as `ipc-handlers.ts`) to push `status:data` to connected remote clients. This avoids modifying `ipc-handlers.ts` — the Electron window and remote clients each have their own independent polling loop reading the same cache files.

**Live from there:** After replay, all new events stream in real time.

### Browser client shim

`src/renderer/remote-shim.ts` implements the `window.claude` interface over WebSocket:

- **Request/response methods** (`session.create`, `session.list`, `skills.list`, etc.): Send a message with a unique correlation `id`, return a Promise that resolves when the server sends a response with the matching `id`.
- **Fire-and-forget methods** (`session.sendInput`, `session.resize`, `session.signalReady`): Send a message, no response expected.
- **Event listeners** (`on.ptyOutput`, `on.hookEvent`, etc.): Register callbacks in a local map, invoke them when matching push events arrive from the server.
- **Cleanup** (`off(channel, handler)`, `removeAllListeners(channel)`): Remove callbacks from the local map. Must accept the same channel string constants as the Electron preload (e.g., `'pty:output'`, `'hook:event'`) so existing components that call `window.claude.off('pty:output', handler)` work unchanged.
- **Dialog stubs**: See "Stubbed methods" table above.

**Environment detection in `index.tsx`:**
- Check if `window.claude` exists (set by Electron's preload)
- If yes: Electron mode, proceed normally
- If no: browser mode, import and initialize `remote-shim.ts`, show login screen until authenticated

**Reconnection:**
- On WebSocket close, attempt reconnection with exponential backoff (1s, 2s, 4s, max 30s)
- Show a "Reconnecting..." banner in the UI during reconnection
- On reconnect, re-authenticate with the stored session token
- After re-auth, server replays buffers to resync state

## Configuration

**File:** `~/.claude/destincode-remote.json`

```json
{
  "enabled": true,
  "port": 9900,
  "passwordHash": "$2b$10$...",
  "trustTailscale": false
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the remote server starts on app launch |
| `port` | number | `9900` | HTTP + WebSocket listen port |
| `passwordHash` | string | `null` | Bcrypt hash of the user-set password |
| `trustTailscale` | boolean | `false` | Skip auth for Tailscale IP range connections |

**Password setup flow:**
- On first launch with remote enabled, if `passwordHash` is null, the remote server starts but rejects all non-Tailscale connections. The Electron window shows a notification: "Remote access enabled but no password set. Set one in Settings or run with --set-remote-password."
- Password can be set via:
  1. A "Remote Access" section in the Electron app's settings/header bar (text input + save button)
  2. A CLI flag: `destincode --set-remote-password` which prompts for the password and writes the hash to the config file
- Changing the password invalidates all in-memory session tokens, forcing remote clients to re-authenticate.

**Behavior when `passwordHash` is null and `trustTailscale` is false:**
- Server starts and listens, but responds to all auth attempts with `{ "type": "auth:failed", "reason": "no-password-configured" }`. The browser login screen shows "Remote access is not configured. Set a password in the desktop app."

## File Changes

### New files

| File | Purpose |
|---|---|
| `src/main/remote-server.ts` | HTTP static file server + WebSocket server, auth validation, message routing, event broadcasting, rolling buffer management |
| `src/main/remote-config.ts` | Config file read/write, password hashing with bcrypt, Tailscale IP detection |
| `src/renderer/remote-shim.ts` | `window.claude` WebSocket implementation, login state management, reconnection logic |

### Modified files

| File | Change |
|---|---|
| `src/main/main.ts` | Import `RemoteServer` and `RemoteConfig`, start server after hook relay, pass `SessionManager` + `HookRelay` instances. Call `remoteServer.stop()` in `window-all-closed` handler alongside existing cleanup. |
| `src/renderer/index.tsx` | Detect Electron vs browser, conditionally load remote shim, gate on auth state |
| `package.json` | Add `ws` and `bcryptjs` dependencies |

### Unchanged files

All existing React components, `preload.ts`, `ipc-handlers.ts`, `session-manager.ts`, `hook-relay.ts`, and all other files remain untouched. The feature is fully additive.

## Dependencies

| Package | Purpose | Size |
|---|---|---|
| `ws` | WebSocket server for Node.js | ~50KB |
| `bcryptjs` | Pure JS bcrypt (no native build) | ~30KB |

## Security Model

**Layer 1 — Network (Tailscale):**
- WireGuard encryption, device-level authentication
- Port 9900 not exposed to public internet
- Only Tailscale-authenticated devices can reach the server

**Layer 2 — Application (password + token):**
- Bcrypt-hashed password stored on disk
- Session tokens held in server memory (expire on restart)
- 5-second auth timeout on new connections
- Optional Tailscale trust bypass for convenience
- Rate limiting: max 5 failed auth attempts per IP per minute. After exceeding, connections from that IP are rejected for 60 seconds.

**Tailscale IP detection:** v1 checks IPv4 CGNAT range `100.64.0.0/10` only. Also handles IPv6-mapped IPv4 addresses (`::ffff:100.64.x.x`) which Node.js may report on Windows. Tailscale IPv6 range (`fd7a:115c:a1e0::/48`) is a non-goal for v1.

**Sensitive data consideration:** PTY output and hook events may contain file contents, environment variables, or API keys. The auth layer prevents unauthorized access. Users should not share their password or leave session tokens in shared environments.

## Non-Goals (v1)

- Browser-native file/folder pickers (dialog methods stubbed)
- Headless mode (no Electron window)
- Per-device token management
- HTTPS termination (rely on Tailscale's WireGuard encryption; HTTPS can be added via `tailscale cert` externally)
- Mobile-optimized responsive layout
