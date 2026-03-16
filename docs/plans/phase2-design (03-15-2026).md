# Claude Mobile Phase 2 — Design Spec

**Version:** 1.3
**Date:** 2026-03-15
**Status:** Approved

**Phase 1 spec:** `~/docs/superpowers/specs/2026-03-15-claude-mobile-android-design.md`
**Phase 1 plan:** `~/docs/superpowers/plans/2026-03-15-claude-mobile-phase1.md`

## Overview

Phase 2 transforms Claude Mobile from a basic PTY chat wrapper into a polished, interactive mobile client. The core insight from Phase 1 usage: Claude Code's terminal UI uses interactive elements (arrow-key menus, OAuth flows, confirmation prompts) that the current plain-text input can't handle. Without proper terminal input, the app is stuck at the first-run onboarding screen.

Phase 2 addresses this by adding a layered interaction model: native Android widgets handle common terminal interactions, with a full terminal emulator as an always-available fallback.

### Deliberate Changes from Phase 1 Spec

| Phase 1 Design | Phase 2 Change | Rationale |
|---|---|---|
| Raw terminal as a Settings toggle (hidden) | First-class toolbar toggle button | Terminal access is critical — it's the escape hatch for all unrecognized interactive elements. Must be one tap away, not buried in settings. |
| /btw as floating bubble + mini overlay | FAB + bottom sheet (40% screen) | More room for typing and reading history than a tiny overlay. |
| Smart cards in Phase 2, raw terminal in Phase 3 | Both in Phase 2 | Terminal input is the #1 blocker (can't get past first-run). Must ship together. |
| Conservative parser (false negatives OK) | Aggressive widget detection | With the terminal toggle always accessible, false positives in widget detection are recoverable — user taps terminal and handles it manually. This lets the parser attempt more detections. False positives for *text classification* (e.g., misidentifying normal text as a diff) remain bad and should stay conservative. |

## Architecture: Layered Single View

A unified chat view with a slide-up terminal panel behind a toggle button. The chat stream shows smart cards and native widgets for recognized events. The terminal panel shows raw PTY output with full ANSI rendering and accepts real terminal input (arrow keys, escape sequences, tab, ctrl).

```
┌─────────────────────────────────┐
│         Chat View (top)         │  Smart cards, messages, widgets
│                                 │
├─────────────────────────────────┤
│    Terminal Panel (bottom)      │  Slide-up, toggled via button
│    Real VT100 terminal canvas   │
├─────────────────────────────────┤
│         Input Bar               │  Dual mode: chat or terminal keyboard
└─────────────────────────────────┘
```

The terminal panel is the ground truth. The chat view is a pretty interpretation layer on top.

## Priority Order

1. Terminal input handling (raw terminal mode with toggle button)
2. First-run onboarding widgets (theme picker, login, permission mode)
3. Re-theme to Claude brand colors
4. Output batching + ANSI stripping
5. Smart cards (diffs, files, tool badges, errors, progress, code blocks)
6. Approval prompt refinement
7. Interactive menu widgets
8. /btw mini-chat
9. Person briefings + text drafting chips
10. Git installation (on-demand)

## 1. Terminal Panel & Input

### Toggle Button
- Terminal icon in the toolbar area
- Tap: panel slides up from bottom, covers ~60% of screen
- Chat view compresses into top ~40% (stays visible — no context loss)
- Tap again: panel slides down, chat expands back
- Badge/pulse animation on icon when parser detects unrecognized interactive content

### Input Routing

**Chat mode (default):**
- Text input bar sends strings to PtyBridge via `session.write(text + "\n")`
- Standard mobile keyboard

**Terminal mode (toggled):**
- Input bar transforms into a terminal keyboard row: arrow keys (←↑↓→), Tab, Ctrl, Esc, Enter
- Text field sends raw keystrokes character-by-character (no newline buffering)
- Each keypress goes to `session.write()` immediately
- Arrow keys send ANSI escape sequences: `\u001b[A` (up), `\u001b[B` (down), etc.

**Widget input:**
- Native widgets send appropriate sequences directly to PtyBridge
- Approval "Accept" → `"y\n"`, arrow-menu selection → `"\u001b[B"` × N + `"\r"`
- **Note:** Exact key sequences must be validated during implementation against Claude Code's ink-based terminal menus. Key sequences are defined in `patterns.js` (not hardcoded in Kotlin) so they can be updated without rebuilding the APK.

### Terminal Rendering
- Read from `TerminalSession.emulator.screen` (Termux's terminal-emulator already maintains full ANSI state)
- Render as a Compose Canvas: characters with correct foreground/background colors and attributes
- No separate VT100 parser needed — Termux library handles it

**Rendering details:**
- Grid size: dynamic based on panel dimensions and monospace font size. Recalculate rows/cols on panel resize and call `TerminalSession.updateSize(cols, rows)`.
- Row rendering: iterate `emulator.screen.getLine(row)`, draw each cell with its stored foreground/background color via `Canvas.drawText()`.
- Attributes: bold (heavier font weight), underline (draw line beneath), inverse (swap fg/bg). Blink ignored.
- Scrollback: vertical scroll gesture on the Canvas. Read from `emulator.screen` with negative row offsets for history.
- Touch: scroll only in v1. No text selection or cursor positioning.

## 2. Theme: Neutral Dark + Claude Sienna

### Color Palette

| Token | Value | Usage |
|---|---|---|
| `background` | `#111111` | App background |
| `surface` | `#1c1c1c` | Cards, Claude message bubbles, input field |
| `surfaceBorder` | `#333333` | Card borders, input field border |
| `primary` | `#c96442` | User bubbles, send button, accents, FAB |
| `onPrimary` | `#ffffff` | Text on primary color |
| `onSurface` | `#e8e0d8` | Body text on surface |
| `onBackground` | `#e8e0d8` | Body text on background |
| `textSecondary` | `#999999` | Secondary text, timestamps, labels |
| `error` | `#dd4444` | Error card border, error text |
| `terminalBg` | `#0a0a0a` | Terminal panel background |

### Claude Mascot Icon (Top-Right Header)

34dp circle with 0.5dp border, 20dp icon inside. Tinted with `primary`.

**Design:** Squat rounded mascot with `><` chevron eyes.
- **Body:** Short rounded rect (14×12 units, rx=4) — wider than tall, friendly proportions
- **Arms:** Nearly-square nubs (3×4 units, rx=0.8) — attached at body midpoint
- **Legs:** Stubby rounded rects (3.5×4 units, rx=1.75) — short, separated by a gap
- **Eyes:** `><` chevrons as EvenOdd cutouts within the body path — punches through the tint color so eyes always match the background
- **Arms:** Float with a visible air gap (1 unit) from the body — not attached

Defined as `AppIcons.ClaudeMascot` in `ui/theme/AppIcons.kt`.

### Launcher Icon (Adaptive)

Cream background (`#f5ede4`), foreground layers:

- **Mascot:** B1 proportions (body 14×12, rx=4) — code-filled variant. Body shape clips a dark (`#1c1c1c`) fill with faint monospace code text (white, ~30-50% alpha). Arms are dark with an air gap from the body (not touching). Right arm raised in a wave (rotated -20°).
- **Sparkles:** Small diamond shapes in corners (sienna, ~30-35% alpha)
- **Terminal prompt:** `>_` below the mascot in sienna (~53% alpha, stroke-width 1). Chevron + underscore cursor line.
- **Eyes:** Cream-colored `><` stroked chevrons over the dark body

Design reference: `icon-drafts/preview-launcher-b1-final.html` (B1 + F2 air gap arms)

### Style Rules
- No left border accent on Claude messages (minimal aesthetic)
- User bubbles: filled with `primary` (#c96442), white text
- Claude messages: `surface` background, `onSurface` text
- Cards: `surface` background, `surfaceBorder` border, 8dp corner radius
- Tool/card accent text: `primary` color for tool names and labels
- Single font hierarchy: system default for UI, monospace for code/terminal

## 3. Output Pipeline

Three-stage pipeline transforms raw PTY output into structured UI.

### Stage 1: Accumulator (Kotlin, PtyBridge)

New component within `PtyBridge.kt` using a coroutine-based debounce.

- Buffer PTY output for 100ms before forwarding to parser
- Flush immediately on:
  - Newline after 500ms+ of silence (track `lastOutputTimestamp`, fire flush when no new output arrives for 500ms after a newline)
  - Known approval pattern detected (regex pre-check runs on accumulated buffer, not each chunk)
  - EOF / process exit
- Sends accumulated chunk as single message to parser via Unix socket
- **Startup race condition:** Accumulator does not flush until EventBridge reports a successful socket connection. Before connection, output accumulates without a time limit. On connect, the entire backlog is flushed as the first chunk. Raw output buffer in PtyBridge captures everything regardless, so the terminal panel works during this window.

### Stage 2: Parser (Node.js sidecar)

- Strips ANSI escape codes from text events (preserves raw for terminal panel)
- Classifies chunks into event types

**Migration from Phase 1 events:**

| Phase 1 Event | Phase 2 Event | Change |
|---|---|---|
| `raw` | `text` | Renamed — "raw" is now the terminal panel's domain |
| `tool_call` | `tool_start` + `tool_end` | Split — enables tracking tool output boundaries |
| `approval_prompt` | `approval_prompt` | No change |
| — | `diff_block`, `code_block`, `error`, `progress` | New content classification events |
| — | `interactive_menu`, `confirmation`, `text_prompt`, `oauth_redirect` | New widget trigger events |

**Event types:**

| Event | Trigger | Data |
|---|---|---|
| `text` | Normal Claude response text | `{ text: string }` |
| `approval_prompt` | "Allow X? (y/n)" patterns | `{ tool: string, summary: string }` |
| `tool_start` | Tool name + args at line start | `{ tool: string, args: string }` |
| `tool_end` | Tool output boundary | `{ tool: string, duration?: number }` |
| `diff_block` | Unified diff format | `{ filename: string, hunks: Hunk[] }` |
| `code_block` | Fenced code (``` markers) | `{ language: string, code: string }` |
| `error` | Stack traces, error patterns | `{ message: string, details: string }` |
| `progress` | "Searching N files..." patterns | `{ message: string }` |
| `interactive_menu` | Unrecognized interactive element | `{ raw: string }` |
| `confirmation` | yes/no question (non-approval) | `{ question: string }` |
| `text_prompt` | Claude waiting for typed input | `{ prompt: string }` |
| `oauth_redirect` | Login URL detected | `{ url: string }` |

- Emits JSON events over Unix socket, one per line

**Parser state machine:** The parser tracks modes across chunks for multi-line constructs:

| Mode | Entry Condition | Exit Condition |
|---|---|---|
| `NORMAL` | Default / exit from any other mode | Entry into another mode |
| `IN_TOOL` | `tool_start` event emitted | Next tool boundary or blank line sequence |
| `IN_DIFF` | `---` + `+++` header lines detected | Next non-diff line (no `+`/`-`/`@`/` ` prefix) |
| `IN_CODE_BLOCK` | Opening ``` fence detected | Closing ``` fence |
| `IN_ERROR` | Stack trace / error pattern detected | Blank line or new tool/text output |

Mode persists across accumulator chunks — the parser maintains state between `processChunk()` calls.

**Detection aggressiveness by event type:**

| Event | Detection | Rationale |
|---|---|---|
| `interactive_menu` | Aggressive | Terminal fallback catches false positives |
| `confirmation` | Aggressive | Same — recoverable via terminal |
| `text_prompt` | Aggressive | Same |
| `oauth_redirect` | Aggressive | URL detection is high-confidence anyway |
| `approval_prompt` | Aggressive | Existing Phase 1 behavior, well-tested |
| `diff_block` | Conservative | Misidentifying text as diff is confusing |
| `code_block` | Conservative | False positive wraps normal text in code card |
| `error` | Conservative | False positive shows red border on non-errors |
| `progress` | Conservative | Low-stakes but keep noise down |
| `tool_start`/`tool_end` | Conservative | Mismatched boundaries corrupt card structure |

### Stage 3: UI Renderer (Kotlin/Compose)

Maps parser events to Compose components. See Smart Cards section below.

## 4. Smart Cards

All cards share common structure: compact by default, tappable to expand. Only one card expanded at a time on phone (tapping a new card collapses the previous).

**Expand state management:** `ChatState.kt` holds a single `expandedCardId: String?`. Each card receives its expansion state as a parameter and reports tap events up to `ChatScreen.kt`. Cards do not manage their own expanded state internally.

### Card Types

**ToolCard**
- Header: tool icon + tool name + primary argument (e.g., "Read src/auth/AuthManager.kt")
- Collapsed: header only (one line)
- Expanded: full arguments, duration

**DiffCard**
- Header: filename + change summary (+N -M)
- Collapsed: first 3 changed lines as preview
- Expanded: full diff with syntax highlighting (green additions, red deletions), scrollable

**CodeCard**
- Header: language label + copy button
- Collapsed: first 5 lines of code
- Expanded: full code with syntax highlighting

**ErrorCard**
- Red `error` border instead of `surfaceBorder`
- Header: "Error" + error type
- Collapsed: first line of error message
- Expanded: full stack trace, monospace

**ProgressCard** (no expand/collapse)
- Single line: spinner + progress text ("Searching 42 files...")
- Replaces itself when progress updates arrive
- Fades out when associated tool completes

**ApprovalCard**
- Header: tool name + summary of request
- Body: Accept / Reject buttons + "View in terminal" link
- Persists in chat stream (scrollable history of approvals)

### Syntax Highlighting
- Simple token-based highlighter for: Kotlin, JavaScript/TypeScript, Python, Bash, JSON
- All other languages: monospace without coloring
- Keeps APK lean — no grammar engine

## 5. Interactive Widgets

Native Android UI replaces terminal interactive elements where possible. Terminal fallback always available.

### Widget Types

**MenuWidget** — arrow-key navigated lists
- Parser detects menu items from PTY output (bracketed options, highlighted lines, numbered items)
- Renders as native radio button list in a card
- Tapping an option sends corresponding keystrokes to PTY (arrow down × N + enter)
- Fallback: if menu structure can't be parsed, pulse terminal badge

**ConfirmationWidget** — yes/no prompts
- Two-button card (Yes/No)
- Sends `y\n` or `n\n` to PTY

**TextPromptWidget** — typed input requests
- Routes normal chat input to PTY stdin
- Parser emits `text_prompt` so UI knows the context

**OAuthWidget** — login flow
- Parser detects URL in "open this link" output
- Renders "Sign in with Claude" button → opens system browser
- After OAuth redirect, callback token passed back or user pastes it

### Detection Philosophy
- Aggressive detection, terminal fallback catches errors
- False positives: annoying but not blocking (user taps terminal)
- False negatives: caught by heuristic — if PTY output stops for 3+ seconds with no event emitted, pulse terminal badge
- Widget accuracy improves over time via pattern refinement

### First-Run Flow
1. Claude Code launches → theme picker → **MenuWidget**
2. Permission mode selector → **MenuWidget**
3. OAuth login → **OAuthWidget**
4. Normal conversation begins → chat mode

## 6. /btw Mini-Chat

- Floating action button (FAB) in Claude sienna, bottom-right above input bar
- Tap: opens bottom sheet (~40% screen height) with its own text input
- Messages prefixed with `/btw` sent to PTY
- Messages tagged `isBtw: true` appear in both main chat (dimmed, "aside" label) and /btw panel
- Close: tap outside or swipe down

## 7. Quick Action Chips (Enhanced)

Current chips: Journal, Inbox, Briefing, Draft Text

Phase 2 changes:
- **Briefing** chip opens inline text field: "Brief me on ___" (type name, sends full command)
- **Draft Text** chip same pattern: "Help me draft a text to ___"
- Chips configurable via `ChipConfig.kt`
- Scroll horizontally above input bar (same as Phase 1)
- Hidden when terminal panel is open

## 8. Git Installation (On-Demand)

Phase 1 spec listed `git` in the first-launch install sequence. Phase 2 changes this: git is deferred to on-demand download because most phone workflows (journaling, inbox, briefings) don't need it.

- Not bundled in APK — downloaded after first install via "Developer Tools" toggle in settings
- Packages: libcurl, libexpat, libiconv, openssl, pcre2, zlib, git
- Same .deb extraction pipeline as existing bootstrap
- ~15-20MB additional download
- Uses existing Bootstrap.kt download/extract infrastructure
- **Bootstrap change:** Phase 2 bootstrap installs only Node.js + dependencies on first launch. rclone remains in initial install (needed for Drive sync). Git is excluded.
- **Missing git behavior:** If Claude Code invokes `git` before it's installed, PTY shows standard "command not found" error. No special handling needed — user can install via Developer Tools toggle.

## Files Modified (Expected)

### New Files
- `ui/TerminalPanel.kt` — terminal canvas + keyboard row
- `ui/cards/CardState.kt` — shared expand/collapse state management
- `ui/cards/ToolCard.kt` — tool call card
- `ui/cards/DiffCard.kt` — diff display card
- `ui/cards/CodeCard.kt` — code block card
- `ui/cards/ErrorCard.kt` — error display card
- `ui/cards/ProgressCard.kt` — progress indicator
- `ui/cards/ApprovalCard.kt` — approval prompt card
- `ui/widgets/MenuWidget.kt` — native menu selector
- `ui/widgets/ConfirmationWidget.kt` — yes/no prompt
- `ui/widgets/OAuthWidget.kt` — login flow
- `ui/BtwSheet.kt` — /btw bottom sheet (supersedes Phase 1's planned `BtwOverlay.kt`, which was never implemented)
- `ui/SyntaxHighlighter.kt` — simple token-based highlighter

### Modified Files
- `ui/theme/Theme.kt` — new color palette
- `ui/ChatScreen.kt` — integrate terminal panel, smart cards, widgets
- `ui/InputBar.kt` — dual mode (chat/terminal keyboard), terminal toggle button
- `ui/MessageBubble.kt` — delegate to card components
- `ui/QuickChips.kt` — enhanced chip patterns
- `runtime/PtyBridge.kt` — output accumulator, escape sequence input
- `parser/EventBridge.kt` — handle new event types
- `parser/ParsedEvent.kt` — new event sealed classes
- `assets/parser/parser.js` — new event classification logic
- `assets/parser/patterns.js` — expanded pattern set
- `runtime/Bootstrap.kt` — on-demand git install support
- `config/ChipConfig.kt` — enhanced chip definitions

## Change Log

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-03-15 | Initial Phase 2 design |
| 1.1 | 2026-03-15 | Address spec review: event migration table, accumulator details, terminal rendering details, parser state machine, detection aggressiveness table, key sequence configurability, card state management, git install clarifications |
| 1.2 | 2026-03-16 | Document Claude mascot icon design (squat rounded body, nub arms, stubby legs, stroked chevron eyes) |
| 1.3 | 2026-03-16 | Eyes use EvenOdd cutouts (not stroked paths) for tint compatibility. Arms have air gap. Add launcher icon design (B1: code-filled body, waving, sparkles, terminal prompt on cream bg) |
