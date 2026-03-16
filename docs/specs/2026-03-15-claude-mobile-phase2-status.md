# Claude Mobile Phase 2 — Implementation Status Spec

**Version:** 1.0
**Date:** 2026-03-15
**Status:** In Progress

**Phase 1 spec:** `~/docs/superpowers/specs/2026-03-15-claude-mobile-android-design.md`
**Phase 2 design spec:** `docs/specs/2026-03-15-claude-mobile-phase2-design.md`
**Phase 2 plan:** `docs/plans/2026-03-15-claude-mobile-phase2.md`

## Summary

Phase 2 adds two interaction modes to Claude Mobile: a full-screen **Terminal** view and a widget-based **Chat** view. The Terminal view is fully functional and usable for all Claude Code interactions. The Chat view renders structured widgets for menus, confirmations, and OAuth flows but has significant reliability issues with message parsing, noise filtering, and URL reconstruction that make it unsuitable for production use. A rebuild of the chat pipeline is recommended.

## What Was Built (59 commits, 49 files, ~3400 lines)

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

### Priority 3: Smart Card Integration

Smart cards are built but need real-world testing with actual Claude Code tool output. The parser's tool_start/tool_end, diff_block, and code_block detection patterns need validation against live output.

### Priority 4: Direct Terminal Access

Add an option to open a plain shell session (no Claude Code) for direct terminal access. The PTY infrastructure already supports this — `PtyBridge.start()` just needs a parameterized launch command (`/system/bin/sh` instead of the Claude Code binary). Options:
- Long-press terminal toggle for raw shell
- Session picker (Claude Code / Terminal) on launch
- Tab-based multi-session with simultaneous Claude + shell

### Priority 5: Session Persistence

Chat messages are lost on tab switch (Compose recomposition). Need to hoist state to ViewModel or persist across configuration changes.

## File Inventory

### New Files (Phase 2)
```
ui/TerminalPanel.kt          — Terminal canvas renderer
ui/TerminalKeyboardRow.kt     — Special key buttons
ui/SyntaxHighlighter.kt       — Token-based code highlighting
ui/BtwSheet.kt                — /btw bottom sheet (deferred)
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
runtime/PtyBridge.kt       — Accumulator, screenVersion, session accessor, \r input
runtime/Bootstrap.kt       — installGit() method
parser/EventBridge.kt      — onConnected callback
parser/ParsedEvent.kt      — 12 event types + DiffHunk
assets/parser/parser.js    — State machine rewrite
assets/parser/patterns.js  — Expanded pattern set
MainActivity.kt            — Edge-to-edge, system bar insets, IME padding
app/build.gradle.kts       — material-icons-extended, version 0.2.0
```

## Change Log

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-03-15 | Initial status spec documenting Phase 2 implementation |
