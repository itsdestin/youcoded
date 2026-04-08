# Changelog

All notable changes to DestinCode are documented in this file.

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
