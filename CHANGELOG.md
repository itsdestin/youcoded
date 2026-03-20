# Changelog

All notable changes to DestinCode are documented in this file.

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
