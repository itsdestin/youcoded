# DestinCode

Electron + React app that wraps Claude Code CLI in a GUI.

## Architecture

- `src/main/` — Electron main process (session manager, hook relay, IPC)
- `src/renderer/` — React frontend (terminal view, chat view in Phase 2)
- `hook-scripts/` — Relay scripts that Claude Code hooks shell out to
- `scripts/` — Build and setup scripts

## Key Concepts

- **SessionManager** (`src/main/session-manager.ts`) — PTY pool, spawns/kills Claude Code processes
- **TranscriptWatcher** (`src/main/transcript-watcher.ts`) — Watches Claude Code's JSONL transcript files via `fs.watch` with byte-offset reading. Parses new lines into `TranscriptEvent` objects and emits them to the renderer. This is the **primary source of chat timeline state** — user messages, assistant text (including intermediate messages between tool calls), tool calls, and tool results all come from here. See `docs/transcript-watcher-spec.md` for full spec.
- **HookRelay** (`src/main/hook-relay.ts`) — Named pipe server receiving hook events from relay.js. Now used **only for permission flow** (`PermissionRequest`/`PermissionExpired`) and session initialization detection. All other chat state comes from the TranscriptWatcher.
- **HookDispatcher** (`src/renderer/state/hook-dispatcher.ts`) — Maps hook events to chat actions. Only handles `PermissionRequest` and `PermissionExpired` — all other hook types return null (chat state comes from transcript events instead).
- **IPC** — Electron contextBridge connects main process to React renderer
- **Preload** (`src/main/preload.ts`) — IPC channel constants are inlined (not imported) because Electron's sandboxed preload cannot resolve relative imports
- **TerminalRegistry** (`src/renderer/hooks/terminal-registry.ts`) — Coordinates xterm.js instances, screen buffer reads, and write-completion notifications. Permission prompt detection depends on the write-callback pub/sub here — do not bypass it by reading the buffer on raw `pty:output` events
- **PermissionMode** (`src/shared/types.ts`) — `'normal' | 'auto-accept' | 'plan' | 'bypass'`. The HeaderBar badge cycles through these on click by sending Shift+Tab (`\x1b[Z`) to the PTY. Bypass mode only appears in sessions created with `skipPermissions: true`
- **RemoteServer** (`src/main/remote-server.ts`) — HTTP + WebSocket server for remote browser access. Handles auth tokens, PTY buffer replay, hook event relay, transcript event relay, and cross-device session sync
- **RemoteConfig** (`src/main/remote-config.ts`) — Reads/writes `~/.claude/destincode-remote.json` for port, password hash, and Tailscale trust settings
- **SkillScanner** (`src/main/skill-scanner.ts`) — Scans installed skills from `~/.claude/plugins/` (DestinClaude skills, installed_plugins.json cache plugins)
- **LocalSkillProvider** (`src/main/skill-provider.ts`) — Skill marketplace backend: discovery, search, install, uninstall, overrides, sharing. Implements the `SkillProvider` interface used by both IPC handlers and RemoteServer
- **PluginInstaller** (`src/main/plugin-installer.ts`) — Installs Claude Code plugins to `~/.claude/plugins/<name>/` via git clone (url), copy from cache (local), or sparse checkout (git-subdir). Includes conflict detection against Claude Code's `installed_plugins.json`
- **SkillConfigStore** (`src/main/skill-config-store.ts`) — Reads/writes `~/.claude/destincode-skills.json`: favorites, chips, overrides, private prompt skills, and marketplace-installed plugin tracking
- **SettingsPanel** (`src/renderer/components/SettingsPanel.tsx`) — Settings UI for remote access config, appearance popup (theme + font)
- **ThemeProvider** (`src/renderer/state/theme-context.tsx`) — Appearance state: active theme, cycle list, font family, reducedEffects, showTimestamps. Persists to localStorage (`destincode-theme`, `destincode-theme-cycle`, `destincode-font`, `destincode-reduced-effects`, `destincode-show-timestamps`), applies `data-theme` attribute on `<html>`, swaps highlight.js stylesheet, sets font CSS variables. See `docs/theme-spec.md` for details

## Chat View Data Flow

The Chat View timeline is built from three event sources:

1. **TranscriptWatcher** (primary) — `transcript:event` IPC → `TRANSCRIPT_*` reducer actions. Provides user messages, assistant text, tool calls, tool results, turn completion. Intermediate assistant messages (text between tool calls) appear as chat bubbles in real-time.
2. **HookRelay** (permissions only) — `hook:event` IPC → `PERMISSION_REQUEST`/`PERMISSION_EXPIRED` reducer actions. Transitions tool cards to approval state with Yes/No buttons.
3. **InputBar** (optimistic) — `USER_PROMPT` reducer action dispatched immediately when user sends a message (marked `optimistic: true`), before the transcript watcher catches up. `TRANSCRIPT_USER_MESSAGE` claims the optimistic entry by flipping the flag to false — this prevents duplicates without suppressing intentionally repeated messages.

**Permission race:** The hook relay is faster than the file watcher. If `PERMISSION_REQUEST` arrives before `TRANSCRIPT_TOOL_USE`, the reducer creates a synthetic tool entry from the permission payload. See spec for details.

## Node.js vs Browser Boundary

`src/main/` runs in Node.js. `src/renderer/` runs in a browser sandbox (via Vite).

- **Never use `process.env`** in renderer code — it doesn't exist in the browser. Use `import.meta.env` with `VITE_` prefixed vars if you need build-time env injection, but note the tsconfig uses `module: "commonjs"` so `import.meta` will fail `tsc`. Prefer constants or IPC for config the renderer needs.
- **Never use `require()`** in renderer code — use ES `import` only.
- **`node-pty`** cannot load in Electron's main process (ABI mismatch). It runs in a separate `node` child process via `pty-worker.js`.
- **Preload** is sandboxed — no `require()`, no relative imports, no `process.env`. IPC channel names are inlined as string literals.

## Dev Commands

- `npm run dev` — Start in development mode (hot reload)
- `npm test` — Run tests
- `npm run build` — Build distributable

## Remote Access

DestinCode includes a built-in remote access server that serves the UI to any web browser.

- **Config:** `~/.claude/destincode-remote.json` — port, password, Tailscale trust
- **Set password:** Create config file with bcrypt hash, or use the settings UI
- **Access:** Open `http://<host>:9900` in any browser
- **Security:** Password auth + optional Tailscale network-level trust. **Privacy note:** Remote access transmits full conversation content (transcript events) over WebSocket. The connection is NOT TLS-encrypted — use Tailscale (which provides WireGuard encryption) rather than plain network access for sensitive conversations.
- **Key files:** `src/main/remote-server.ts`, `src/main/remote-config.ts`, `src/renderer/remote-shim.ts`
- **The remote UI is the same React app** — `remote-shim.ts` replaces Electron IPC with WebSocket. No React components are changed.

## Multiplayer Games

DestinCode includes a multiplayer game system (currently Connect 4) powered by PartyKit (Cloudflare Durable Objects).

- **Server:** `partykit/` — separate deployable project with per-game room classes
  - `LobbyRoom` (`src/lobby-room.ts`) — global presence, online users, challenge relay
  - `ConnectFourRoom` (`src/connect-four-room.ts`) — two-player message relay for a game session
  - Deploy: `cd partykit && npx partykit deploy`
  - Dev: `cd partykit && npx partykit dev` (localhost:1999)
- **Client hooks:**
  - `usePartyLobby` (`src/renderer/hooks/usePartyLobby.ts`) — connects to LobbyRoom on app launch, handles presence + challenges
  - `usePartyGame` (`src/renderer/hooks/usePartyGame.ts`) — connects to a game room during gameplay, handles moves/chat/rematch
- **Connection wrapper:** `src/renderer/game/party-client.ts` — typed wrapper around `partysocket`, host configured via `PARTYKIT_HOST`
- **Game logic:** `src/renderer/game/connect-four.ts` — pure functions (`dropPiece`, `checkWin`, `checkDraw`), runs client-side only
- **State:** `src/renderer/state/game-types.ts` — `GameState`, `GameAction`, `GameConnection` interface
- **Persistent stats:** Planned via PartyKit server-side storage (not yet implemented)
- **Favorites:** Local file `~/.claude/destinclaude-favorites.json`, read/written via IPC (`favorites:get`, `favorites:set`)
- **Identity:** GitHub username via `gh auth token` IPC
- **Spec:** `docs/superpowers/specs/2026-03-27-partykit-game-backend-design.md`

Adding a new game requires: a new room class in `partykit/src/`, new client game logic, and new UI components. The lobby and favorites system are game-agnostic.

## Theming & Appearance

The app uses a semantic CSS token system for theming. All colors are CSS custom properties toggled by `data-theme` on `<html>`.

- **Themes:** Light (default), Dark, Midnight, Crème — defined in `src/renderer/styles/globals.css`
- **Tokens:** `bg-canvas`, `bg-panel`, `bg-inset`, `bg-well`, `bg-accent`, `text-fg`, `text-fg-2`, `text-fg-dim`, `text-fg-muted`, `text-fg-faint`, `text-on-accent`, `border-edge`, `border-edge-dim`
- **Adding a theme:** Add a `[data-theme="name"]` block in globals.css with all variables, add the name to `THEMES` array in `theme-context.tsx`, add label/description/swatches to `SettingsPanel.tsx`
- **Font (chat):** User-selectable via `queryLocalFonts()` API. Applied via `--font-sans`/`--font-mono` CSS variables. Only affects the chat UI.
- **Font (terminal):** Hardcoded to Cascadia Code (`'Cascadia Code', 'Cascadia Mono', Consolas, monospace`). User font selection does not apply to xterm — proportional fonts break the character cell grid.
- **Persistence:** `localStorage` keys: `destincode-theme`, `destincode-theme-cycle`, `destincode-font`
- **Status bar pill:** Cycles through user-configured subset of themes (configurable in appearance popup)
- **highlight.js:** Dynamically swaps between `github-dark.css` and `github.css` via inline `?inline` CSS imports managed in ThemeProvider
- **xterm.js:** Reads `--canvas` and `--fg` CSS variables for terminal colors, syncs reactively on theme change. WebGL renderer is always loaded for performance. When a wallpaper, gradient, or glassmorphism background is active, the terminal container uses `opacity: 0.88` to let the background peek through (xterm itself stays opaque — WebGL requires it).
- **Anti-FOUC:** Theme + font applied before React mounts in `index.tsx`

**Key rule:** Status colors (green, red, amber, blue, orange) are theme-independent and stay hardcoded. Only surface/text/border colors use semantic tokens.

## Keyboard Shortcuts

The desktop app uses a layered keyboard system. The text input auto-focuses when any printable character is typed, and auto-unfocuses after 0.5s of idle so global shortcuts become available.

| Shortcut | Context | Action |
|----------|---------|--------|
| **Shift (hold)** | Not typing | Opens session switcher dropdown |
| **Shift + Arrow Up/Down** | Shift held, dropdown open | Navigate between sessions |
| **Shift (release)** | Dropdown open | Switch to highlighted session |
| **Arrow Up/Down** | Not typing | Scroll chat view (accelerates with held press) |
| **Ctrl+`** | Any | Toggle between chat and terminal view |
| **Shift+Tab** | Any | Cycle permission mode (normal → auto-accept → plan → bypass) |
| **Shift+Enter** | Text input focused | Insert newline |
| **Enter** | Text input focused | Send message |
| **/** | Text input focused | Open skill/command drawer |
| **Escape** | Drawer/modal open | Close drawer or modal |
| **Arrow Left/Right** | Permission prompt visible | Cycle between Yes/No/Always Allow buttons |

**Implementation:** Global shortcuts use capture-phase `window` event listeners so they work even when xterm has focus. The idle unfocus timer and auto-focus listener coordinate through `document.activeElement` without direct coupling between components. See `InputBar.tsx` (idle unfocus + auto-focus), `SessionStrip.tsx` (Shift-hold nav), and `ChatView.tsx` (arrow scroll).

## Specs

See `desktop/docs/` for design documents and implementation plans.
