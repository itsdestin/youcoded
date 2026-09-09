# YouCoded

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
- **PermissionMode** (`src/shared/types.ts`) — `'normal' | 'auto-accept' | 'plan' | 'auto' | 'bypass'`. The StatusBar permission chip (`StatusBar.tsx`, `PERMISSION_DISPLAY` — always the second chip) cycles through these on click by sending Shift+Tab (`\x1b[Z`) to the PTY. `bypass` only appears in sessions created with `skipPermissions: true`. `auto` (CC v2.1.83+ classifier-backed mode) only appears when the active session is on Opus 4.7 1M — Anthropic gates it by plan/model so showing it elsewhere would be a click-but-nothing-happens state. Mode detection is PTY screen-scrape (`'auto mode on'`, `'accept edits on'`, etc.) and the optimistic UI state is corrected by that watcher within ~1 tick if the user's local cycle order disagrees with CC's.
- **RemoteServer** (`src/main/remote-server.ts`) — HTTP + WebSocket server for remote browser access. Handles auth tokens, PTY buffer replay, hook event relay, transcript event relay, and cross-device session sync
- **RemoteConfig** (`src/main/remote-config.ts`) — Reads/writes `~/.claude/youcoded-remote.json` for port, password hash, and Tailscale trust settings
- **SkillScanner** (`src/main/skill-scanner.ts`) — Scans installed skills: (1) YouCoded skills at `~/.claude/plugins/youcoded-core/skills/`, (2) marketplace plugins via `~/.claude/plugins/installed_plugins.json` (inside the plugin cache dir — an earlier version wrote to `~/.claude/installed_plugins.json`, fixed in the marketplace-paths refactor)
- **LocalSkillProvider** (`src/main/skill-provider.ts`) — Skill marketplace backend: discovery, search, install, uninstall, overrides, sharing. Implements the `SkillProvider` interface used by both IPC handlers and RemoteServer
- **PluginInstaller** (`src/main/plugin-installer.ts`) — Installs Claude Code plugins to `~/.claude/plugins/marketplaces/youcoded/plugins/<name>/` and wires them into all four Claude Code registries via `ClaudeCodeRegistry`. Source types: git clone (url), copy from cache (local), sparse checkout (git-subdir)
- **ClaudeCodeRegistry** (`src/main/claude-code-registry.ts`) — Writes the four on-disk registries that Claude Code v2.1+ requires to recognize a plugin: `settings.json` (`enabledPlugins["id@youcoded"]: true`), `installed_plugins.json` (v2 entry with absolute `installPath`), `known_marketplaces.json` (marketplace source), and `marketplaces/youcoded/.claude-plugin/marketplace.json` (plugin manifest list). Without entries in all four, `/reload-plugins` silently reports 0 new plugins and the plugin is invisible to the CLI
- **SkillConfigStore** (`src/main/skill-config-store.ts`) — Reads/writes `~/.claude/youcoded-skills.json`: favorites, chips, overrides, private prompt skills, and marketplace-installed plugin tracking
- **CommandProvider** (`src/main/command-provider.ts`) — Merges slash commands from three sources for the CommandDrawer search/browse: YouCoded-handled (dispatcher-backed list in `src/main/youcoded-commands.ts`), filesystem-scanned (user/project/plugin commands via `src/main/command-scanner.ts`), and Claude Code built-ins (hand-maintained list in `src/main/cc-builtin-commands.ts`). Exposed to the renderer via `window.claude.commands.list()`. Cache invalidated on plugin install/uninstall. Android mirror at `app/.../runtime/CommandProvider.kt`
- **BundledPlugins** (`src/shared/bundled-plugins.ts`) — Hardcoded list of plugins auto-installed on every launch (currently `wecoded-themes-plugin`, `wecoded-marketplace-publisher`, and `youcoded-chatsearch`). Duplicated in `app/.../skills/BundledPlugins.kt` for Android — the two lists are now pinned equal (ids AND order) by `tests/bundled-plugins-parity.test.ts`, which reads the Kotlin file directly; before that test the sync was comment-enforced only. Uninstall is blocked at the UI layer (SkillCard / MarketplaceDetailOverlay) AND the IPC layer (skills:uninstall handler in main, SessionService.kt on Android) so users cannot accidentally remove the plugins that power the bundled `/theme-builder` and marketplace-publisher flows
- **AnnouncementService** (`src/main/announcement-service.ts`) — Fetches `announcements.txt` from the youcoded repo (raw.githubusercontent.com) every 1h and writes `~/.claude/.announcement-cache.json`. Both fetch-time and render-time expiry filters apply. Android mirror at `app/.../runtime/AnnouncementService.kt`. The toolkit's statusline reads the cache file but no longer owns the fetch.
- **SettingsPanel** (`src/renderer/components/SettingsPanel.tsx`) — Settings UI for remote access config, appearance popup (theme + font)
- **ThemeProvider** (`src/renderer/state/theme-context.tsx`) — Appearance state: active theme, cycle list, font family, reducedEffects, showTimestamps, showTurnMetadata. Persists to localStorage (`youcoded-theme`, `youcoded-theme-cycle`, `youcoded-font`, `youcoded-reduced-effects`, `youcoded-show-timestamps`, `youcoded-show-turn-metadata`), applies `data-theme` attribute on `<html>`, swaps highlight.js stylesheet, sets font CSS variables. See `docs/theme-spec.md` for details
- **Buddy hosting** has two strategies: three separate windows (`BuddyWindowManager`, Windows/macOS/X11) vs one screen-sized transparent overlay window (`BuddyOverlayManager`, Linux Wayland). `chooseBuddyStrategy` in `src/main/buddy-manager.ts` picks between them (env override `YOUCODED_BUDDY_STRATEGY`).

## Chat View Data Flow

The Chat View timeline is built from four event sources:

1. **TranscriptWatcher** (primary) — `transcript:event` IPC → `TRANSCRIPT_*` reducer actions. Provides user messages, assistant text, tool calls, tool results, turn completion. Intermediate assistant messages (text between tool calls) appear as chat bubbles in real-time. Also emits `assistant-thinking` heartbeats for extended-thinking models (dispatched as `TRANSCRIPT_THINKING_HEARTBEAT`).
2. **HookRelay** (permissions only) — `hook:event` IPC → `PERMISSION_REQUEST`/`PERMISSION_EXPIRED` reducer actions. Transitions tool cards to approval state with Yes/No buttons.
3. **InputBar** (optimistic) — `USER_PROMPT` reducer action dispatched immediately when user sends a message, before the transcript watcher catches up. Dedup uses a `pending` flag on user timeline entries: `USER_PROMPT` appends with `pending: true`, and `TRANSCRIPT_USER_MESSAGE` finds the oldest matching pending entry and clears the flag (if no pending match exists, a new `pending: false` entry is appended). This replaces the prior last-10-entries content match, which silently dropped legitimate rapid-fire duplicates. See `docs/PITFALLS.md → Chat Reducer` and `docs/transcript-watcher-spec.md` Design Decision #5.
4. **PTY classifier** — `useAttentionClassifier` reads the xterm buffer every 1s while Claude is thinking and no tool is running/awaiting-approval. Pure `classifyBuffer` in `src/renderer/state/attention-classifier.ts` returns an internal `BufferClass` (`'thinking-active' | 'thinking-stalled' | 'unknown'`); the upstream hook maps that to the public `AttentionState` union `'ok' | 'stuck' | 'session-died' | 'error'` (4 reachable states — the prior `awaiting-input | shell-idle` branches were deleted in the 2026-04-26 audit because nothing dispatched them; `'error'` was reintroduced in Phase 1 Plan A with the `NATIVE_SESSION_ERROR` dispatcher, fired only by native-runtime sessions). `ATTENTION_STATE_CHANGED` is dispatched only on diffs; any transcript event clears back to `'ok'`. `ChatView` swaps `<ThinkingIndicator />` for `<AttentionBanner state={...} />` when the state is non-ok. Process exits piped through as `SESSION_PROCESS_EXITED` surface as `'session-died'` when a turn was in flight or exitCode != 0.

**Permission race:** The hook relay is faster than the file watcher. If `PERMISSION_REQUEST` arrives before `TRANSCRIPT_TOOL_USE`, the reducer creates a synthetic tool entry from the permission payload. See spec for details.

## Node.js vs Browser Boundary

`src/main/` runs in Node.js. `src/renderer/` runs in a browser sandbox (via Vite).

- **Never use `process.env`** in renderer code — it doesn't exist in the browser. Use `import.meta.env` with `VITE_` prefixed vars if you need build-time env injection, but note the tsconfig uses `module: "commonjs"` so `import.meta` will fail `tsc`. Prefer constants or IPC for config the renderer needs.
- **Never use `require()`** in renderer code — use ES `import` only.
- **`node-pty`** cannot load in Electron's main process (ABI mismatch). It runs in a separate `node` child process via `pty-worker.js`. The worker's `case 'input'` handler implements Windows-ConPTY-aware submit logic — passthrough for non-CR writes, atomic single-write when `body + \r` ≤ 56 bytes (`SAFE_ATOMIC_LEN`, with an 8-byte margin under the empirically-measured 64-byte ConPTY paste threshold), and **echo-driven submit** for longer text (chunk the body in ≤56-byte pieces, wait for CC's stdout echo, then write a bare `\r`). See `docs/PITFALLS.md` → "PTY Writes" before changing how input is written. Android's `PtyBridge.writeInput` still uses a 600 ms gap because Linux PTY doesn't have ConPTY's gap-collapse issue.
- **Preload** is sandboxed — no `require()` of app modules, no relative imports. IPC channel names are inlined as string literals. Electron's polyfilled `process` IS available (including `process.env` — verified empirically 2026-07-10 against the built preload in a sandboxed window). `window.claude.native.supported` is `true` by default (enabled 2026-07-16); `YOUCODED_NATIVE=0` is the kill switch.

## Dev Commands

- `npm run dev` — Start in development mode (hot reload)
- `npm test` — Run tests
- `npm run build` — Build distributable
- `npm run lint` — ESLint. A **bug** gate, not a style gate: it carries only rules that catch real defects (conditional React hooks, floating promises in the main process, impossible comparisons), because tsc + vitest + knip were all green while exactly those classes shipped. Every enabled rule is at zero on the tree, so a failure means a NEW defect. The rules that are measured-but-not-yet-enabled — and what each would cost to adopt — are listed at the bottom of `desktop/eslint.config.mjs`; drive one to zero in the same commit that enables it.
- `npm run knip` — Dead-code check. **This is the authority on "is X still used?" — do not answer that from a `grep`** (see the workspace `CLAUDE.md` → "Never assert a negative from a single search"). Config + the rationale for every ignore lives in `desktop/knip.jsonc`; it runs as its own step in `desktop-ci.yml`. It gates only on the categories that are clean today (`files`, `unresolved`, `duplicates`, `dependencies`) and reports the rest as warnings, so a green run does NOT mean zero findings — read the output.

### `allowScripts` in package.json

npm 12 (Node 26+) blocks dependency install scripts by default; CI is on Node 22 (npm 10) and never sees this. Without an entry, `npm ci` "succeeds" but leaves `node_modules/electron/` with **no binary inside**, and the failure surfaces much later as `Electron failed to install correctly` when `run-dev.sh` launches. Every fresh checkout and every new worktree hit it.

Only `electron` is approved — its postinstall downloads the ~100 MB runtime, so nothing works without it. `node-pty`, `koffi`, and `electron-winstaller` are explicitly **denied**: the first two ship per-platform prebuilts (`node-pty/prebuilds/linux-x64/pty.node` is present with scripts blocked — verified 2026-08-11), and the third only packages Windows installers, which happens in CI. Denying rather than leaving them unlisted keeps `npm ci` warning-free, so a *new* blocked package is visible instead of buried.

Entries are deliberately **unpinned** (`"electron": true`, not `"electron@41.10.3"`). npm's default pins to a version, which would silently re-block on the next Electron bump and reproduce the same cryptic launch failure. Re-approve with `npm install-scripts approve <pkg> --no-allow-scripts-pin`.

## Remote Access

YouCoded includes a built-in remote access server that serves the UI to any web browser.

- **Config:** `~/.claude/youcoded-remote.json` — port, password, Tailscale trust
- **Set password:** Create config file with bcrypt hash, or use the settings UI
- **Access:** Open `http://<host>:9900` in any browser
- **Security:** Password auth + optional Tailscale network-level trust. **Privacy note:** Remote access transmits full conversation content (transcript events) over WebSocket. The connection is NOT TLS-encrypted — use Tailscale (which provides WireGuard encryption) rather than plain network access for sensitive conversations.
- **Key files:** `src/main/remote-server.ts`, `src/main/remote-config.ts`, `src/renderer/remote-shim.ts`
- **The remote UI is the same React app** — `remote-shim.ts` replaces Electron IPC with WebSocket. No React components are changed.

## Multiplayer Games — the arcade

Four games in the side pane (spec archived at
`youcoded-dev/docs/archive/specs/2026-08-30-games-arcade-design.md`, shipped
2026-08-31): **Connect 4** and **chess** are versus over the network; **Flappy**
and **2048** are solo and never touch the network to be playable.

- **Adding a game is a renderer-only change.** Register it in
  `src/renderer/components/game/game-registry.ts`; the shell, the IPC surface and
  the Worker learn nothing new. Scores cross every boundary as RAW NUMBERS —
  "31 pipes" and "12,480" are the registry's words. Guarded by
  `tests/arcade-authority.test.ts`.
- **PartyKit server:** `partykit/` — `connectfour` → `src/connect-four-room.ts`,
  `chess` → `src/chess-room.ts`. Both are **relays that know no rules**; each
  client re-validates every incoming move (chess.js lives in the renderer, not in
  the party). Those two are the ONLY parties any client connects to
  (`party: 'connectfour'` / `party: 'chess'`).
  - `src/lobby-room.ts` is still `main` in `partykit.json` but **nothing in the
    app connects to it** — presence and challenges moved to the marketplace
    Worker's presence Durable Object. Treat it as legacy, not as the lobby.
  - Deploy: `cd partykit && npx partykit deploy` · Dev: `npx partykit dev` (:1999)
- **Presence, challenges and head-to-head:** `src/renderer/hooks/usePresence.ts`
  against the Worker's `presence-room.ts` DO. (`usePartyLobby.ts` is deleted.)
  A match becomes a permanent record only when BOTH players report and agree —
  the client never asserts a result alone.
- **Client hooks:** `usePartyGame.ts` (Connect 4), `useChessGame.ts` (chess),
  `useMatchReport.ts` (sends this client's half of a result).
- **Scores and records:** the marketplace Worker, not PartyKit storage — D1
  tables from `worker/migrations/0007_games.sql`, reached over `arcade:*` IPC
  (`src/main/arcade-handlers.ts`, five surfaces). Solo bests also persist locally
  (`components/game/local-best.ts`) so playing signed-out or offline still counts.
- **State:** `src/renderer/state/game-types.ts` / `game-reducer.ts`. `state.play`
  is the open game's OWN state and is opaque to the shell — only that game's board
  may narrow it. `matchIdOf()` lives in game-types because BOTH ends of the record
  round trip need the identical string.
- **Identity:** the account display name (accounts, spec §3) — NOT the GitHub
  username. Display names are not unique, so records are keyed by account id.
- **Favorites:** `~/.claude/youcoded-favorites.json` via `favorites:get`/`:set`.

## Theming & Appearance

The app uses a semantic CSS token system for theming. All colors are CSS custom properties toggled by `data-theme` on `<html>`.

- **Themes:** Light (default), Dark, Midnight, Crème — defined in `src/renderer/styles/globals.css`
- **Tokens:** `bg-canvas`, `bg-panel`, `bg-inset`, `bg-well`, `bg-accent`, `text-fg`, `text-fg-2`, `text-fg-dim`, `text-fg-muted`, `text-fg-faint`, `text-on-accent`, `border-edge`, `border-edge-dim`
- **Adding a theme:** Add a `[data-theme="name"]` block in globals.css with all variables, add the name to `THEMES` array in `theme-context.tsx`, add label/description/swatches to `SettingsPanel.tsx`
- **Font (chat):** User-selectable via `queryLocalFonts()` API. Applied via `--font-sans`/`--font-mono` CSS variables. Only affects the chat UI.
- **Font (terminal):** Hardcoded to Cascadia Code (`'Cascadia Code', 'Cascadia Mono', Consolas, monospace`). User font selection does not apply to xterm — proportional fonts break the character cell grid.
- **Persistence:** `localStorage` keys: `youcoded-theme`, `youcoded-theme-cycle`, `youcoded-font`
- **Status bar pill:** Cycles through user-configured subset of themes (configurable in appearance popup)
- **highlight.js:** Dynamically swaps between `github-dark.css` and `github.css` via inline `?inline` CSS imports managed in ThemeProvider
- **xterm.js:** Reads `--canvas` and `--fg` CSS variables for terminal colors, syncs reactively on theme change. WebGL renderer is always loaded for performance. When a wallpaper, gradient, or glassmorphism background is active, the terminal container uses `opacity: 0.88` to let the background peek through (xterm itself stays opaque — WebGL requires it).
- **Anti-FOUC:** Theme + font applied before React mounts in `index.tsx`

**Key rule:** Status colors (green, red, amber, blue, orange) are theme-independent and stay hardcoded. Only surface/text/border colors use semantic tokens.

## Keyboard Shortcuts

The desktop app uses a layered keyboard system. The text input auto-focuses when any printable character is typed, and auto-unfocuses after 0.5s of idle so global shortcuts become available. (Auto-unfocus is skipped on Android because blur dismisses the soft keyboard; the relevant Shift-hold global shortcuts don't exist on touch devices anyway.)

| Shortcut | Context | Action |
|----------|---------|--------|
| **Shift (hold)** | Not typing | Opens session switcher dropdown |
| **Shift + Arrow Up/Down** | Shift held, dropdown open | Navigate between sessions |
| **Shift (release)** | Dropdown open | Switch to highlighted session |
| **Arrow Up/Down** | Not typing | Scroll chat view (accelerates with held press) |
| **Ctrl+`** | Any | Toggle between chat and terminal view |
| **Shift+Tab** | Any | Cycle permission mode (normal → auto-accept → plan → auto* → bypass*). `auto` only on Opus 4.7 1M; `bypass` only when session was started with `skipPermissions: true`. |
| **Shift+Enter** | Text input focused | Insert newline |
| **Enter** | Text input focused | Send message |
| **/** | Text input focused | Open skill/command drawer |
| **Escape** | Drawer/modal open | Close the topmost drawer/modal |
| **Escape** | Chat view focused, no overlay open | Interrupt the active Claude session (sends `\x1b` to the PTY) |
| **Arrow Left/Right** | Permission prompt visible | Cycle between Yes/No/Always Allow buttons |

**Implementation:** Global shortcuts use capture-phase `window` event listeners so they work even when xterm has focus. The idle unfocus timer and auto-focus listener coordinate through `document.activeElement` without direct coupling between components. See `InputBar.tsx` (idle unfocus + auto-focus), `SessionStrip.tsx` (Shift-hold nav), and `ChatView.tsx` (arrow scroll).

## Specs

See `desktop/docs/` for living subsystem reference and the workspace's `docs/active/` and `docs/archive/` trees for design, plan, handoff, and investigation records. The cross-cutting `docs/PITFALLS.md` and rule files in `.claude/rules/` also live in the workspace scaffold.
