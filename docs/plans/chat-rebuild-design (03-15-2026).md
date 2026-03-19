# DestinCode Chat View Rebuild — Design Spec

**Version:** 1.1
**Date:** 2026-03-15
**Status:** Draft
**Supersedes:** Chat view sections of `2026-03-15-claude-mobile-phase2-design.md`
**Related:** `2026-03-15-claude-mobile-phase2-status.md` (problem diagnosis)

## Problem Statement

The Phase 2 chat view attempts to reconstruct structured meaning from Claude Code's terminal text stream. A Node.js parser sidecar classifies PTY output line-by-line, and the Kotlin UI layers on additional heuristics (noise filtering, URL accumulation, menu detection, follow-up polling). The result is a fragile pipeline where every new Claude Code output pattern requires a new ad-hoc filter. The status spec documents 6 specific failure modes and recommends a rebuild.

The terminal view is fully functional and production-ready. The chat view is unusable.

## Core Insight

Claude Code's terminal output is a rendered representation of structured data that Claude Code already has internally — tool calls, responses, approvals, errors. The current parser tries to reconstruct that structure from rendered text. Instead, we should tap into Claude Code's structured event system (hooks) and bypass terminal parsing entirely.

## Architecture: Hooks-Only Chat

The rebuild replaces the 3-stage pipeline (Accumulator → Parser Sidecar → UI Renderer) with a direct hook-to-UI pipeline:

```
Claude Code hooks ──→ Unix socket ──→ EventBridge ──→ ChatState ──→ Compose UI
                                                          ↑
PTY byte counter ───────────────────────── activity signal
```

The terminal view is completely unchanged — it reads the PTY screen buffer directly and remains the ground truth for all Claude Code output.

### What Gets Deleted

**Removed entirely:**
- `parser/parser.js` — Node.js sidecar process
- `parser/patterns.js` — regex pattern library
- `parser/PATTERNS.md` — pattern documentation
- `parser/package.json` — sidecar dependencies
- `parser/capture-output.sh` — output capture utility
- Output accumulator in PtyBridge (100ms debounce + socket forwarding)
- `ParsedEvent.kt` — all 12 sealed class variants

**Gutted and rewritten:**
- `EventBridge.kt` — same socket server, new JSON schema (hook payloads)
- `ChatScreen.kt` — all accumulator state, noise filtering, menu detection, URL reconstruction, follow-up menu polling removed
- `ChatState.kt` — 12 `MessageContent` variants reduced to 6, all heuristic state fields removed

**Unchanged:**
- `TerminalPanel.kt`, `TerminalKeyboardRow.kt` — terminal view untouched
- `ui/cards/*` — smart card composables reused
- `ui/theme/*` — untouched
- `ui/widgets/*` — retained but not actively used (first-run is terminal-only)

**New files:**
- `assets/hook-relay.js` — ~10 line Node.js socket relay
- `parser/HookEvent.kt` — sealed class for hook payloads (replaces `ParsedEvent.kt`)

**Net effect:** ~400-500 lines of fragile heuristic code removed, replaced by ~50 lines of hook plumbing.

## Hook Event Pipeline

### Registered Hooks

All hooks use the same command: `node /path/to/hook-relay.js`

| Hook Event | Matcher | Chat UI Result |
|---|---|---|
| `PreToolUse` | `.*` | ToolCard in "running" state (spinner + tool name + args) |
| `PostToolUse` | `.*` | ToolCard updated to "complete" with result; renders as DiffCard, CodeCard, etc. based on `tool_name` |
| `PostToolUseFailure` | `.*` | ToolCard updated to "failed" state (error display) |
| `Stop` | `.*` | Full assistant response text rendered as Claude bubble with markdown |
| `Notification` | `.*` | System notice, or approval detection signal (see Approval Handling) |

**Hooks not registered:** `SessionStart`, `SessionEnd`, `PreCompact`, `UserPromptSubmit`, `SubagentStop`. These don't produce user-facing chat content.

### Hook Payload Format

All hooks receive JSON via stdin with common fields:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.txt",
  "cwd": "/current/working/dir",
  "permission_mode": "ask",
  "hook_event_name": "PreToolUse"
}
```

Event-specific additions:
- **PreToolUse:** `tool_name` (string), `tool_input` (object), `tool_use_id` (string — unique ID for correlating Pre/Post events)
- **PostToolUse:** `tool_name` (string), `tool_input` (object), `tool_response` (object — structured result, not a plain string), `tool_use_id` (string)
- **PostToolUseFailure:** Same fields as `PostToolUse`, but `tool_response` contains error information
- **Stop:** `last_assistant_message` (string — the full assistant response text), `stop_hook_active` (boolean — ignored by the app, used internally by Claude Code to prevent infinite loops)
- **Notification:** `message` (string), `title` (optional string), `notification_type` (one of `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`)

### hook-relay.js

A single Node.js file installed during bootstrap. All hook commands point to the same file. It reads stdin and relays to the app's Unix socket:

```javascript
const net = require('net');
const fs = require('fs');
const socket = process.env.CLAUDE_MOBILE_SOCKET;
if (!socket) process.exit(0); // Fail silently if app not running
const input = fs.readFileSync(0, 'utf8');
try {
  const conn = net.connect(socket);
  conn.on('error', () => process.exit(0)); // Fail silently on connection error
  conn.end(input + '\n');
} catch (e) {
  process.exit(0); // Fail silently — don't disrupt Claude Code
}
```

The `CLAUDE_MOBILE_SOCKET` environment variable is set by PtyBridge when launching Claude Code.

### Event Flow

1. Claude Code fires hook → `hook-relay.js` reads stdin JSON, writes to Unix socket
2. EventBridge receives JSON line, deserializes into `HookEvent` sealed class
3. ChatState routes based on `hook_event_name`:
   - `PreToolUse` → add ToolCard in "running" state
   - `PostToolUse` → find matching ToolCard by `tool_use_id`, update to "complete" with result. Render as DiffCard (for `Edit`), CodeCard (for `Bash`), collapsible text (for `Read`), etc.
   - `PostToolUseFailure` → find matching ToolCard by `tool_use_id`, update to "failed" state with error
   - `Stop` → render `last_assistant_message` as markdown Claude bubble
   - `Notification` → if `notification_type` is `permission_prompt`, trigger approval state on the active ToolCard; otherwise render as system notice

### Content Classification

Classification is now trivial because `tool_name` tells us what the content is:

| `tool_name` | Card Type | Notes |
|---|---|---|
| `Edit` | DiffCard | `tool_response` object contains structured diff data |
| `Write` | DiffCard or CodeCard | New file content |
| `Read` | Collapsible text | File contents, collapsed by default |
| `Bash` | CodeCard | Command + output |
| `Glob`, `Grep` | Collapsible text | Search results |
| `Agent` | ToolCard | Subagent summary |
| `WebSearch`, `WebFetch` | Collapsible text | Web results |
| All others | ToolCard | Generic tool display |

Note: `tool_response` is a structured object, not a plain string. The rendering logic for each tool type extracts relevant fields from this object. Exact field shapes should be validated during implementation against live hook output.

No heuristic pattern matching. No noise filtering.

## Chat Message Model

### MessageContent Variants

| Variant | Source | Renders As |
|---|---|---|
| `Text(text)` | User input bar | User bubble (sienna) |
| `Response(markdown)` | `Stop` hook | Claude bubble (surface) with basic markdown |
| `ToolRunning(id, tool, args)` | `PreToolUse` hook | ToolCard with animated spinner |
| `ToolAwaitingApproval(id, tool, args)` | `Notification(permission_prompt)` hook, with PTY silence as fallback | ToolCard with live mini-terminal + Accept/Reject buttons |
| `ToolComplete(id, tool, args, result)` | `PostToolUse` hook | ToolCard (collapsed), DiffCard, CodeCard, etc. |
| `ToolFailed(id, tool, args, error)` | `PostToolUseFailure` hook | ToolCard with error display |
| `SystemNotice(text)` | `Notification` hook (non-permission types) | Dimmed text, no bubble |

### ToolCard State Progression

A ToolCard progresses through states, tied together by `tool_use_id`:

```
PreToolUse arrives              → ToolRunning (spinner + tool name + args)
Notification(permission_prompt) → ToolAwaitingApproval (live mini-terminal + Accept/Reject)
  (fallback: 2s + PTY quiet)
PostToolUse arrives             → ToolComplete (collapsed result card)
PostToolUseFailure arrives      → ToolFailed (error display)
```

If `PostToolUse` arrives before any approval signal, the card skips directly from Running to Complete.

### State Cleanup

**Deleted from ChatState:**
- `menuAccumulator`, `menuFlushJob`, `shownMenuHashes`, `pendingMenuScan`
- `urlAccumulator`, `urlFlushJob`
- `isWaitingForApproval`, `approvalSummary`

**Deleted from ChatScreen:**
- All noise filtering heuristics (noise character counting, regex patterns, hardcoded strings)
- URL fragment accumulation and `getTranscriptText()` URL reconstruction
- Menu option accumulation with 300ms flush
- Follow-up menu transcript polling (5 polls over 5 seconds)

## Approval Handling

### Detection Strategy

**Primary signal:** The `Notification` hook with `notification_type: "permission_prompt"` fires exactly when Claude Code is waiting for permission. This is a structured, reliable signal — no heuristics needed. When received, the most recent `ToolRunning` card transitions to `ToolAwaitingApproval`.

**Fallback signal:** If the `Notification` hook doesn't fire for some reason (e.g., Claude Code version difference), fall back to the PTY-silence heuristic: when `PreToolUse` fires and no `PostToolUse` follows within 2 seconds AND PTY output has gone quiet (no bytes for 2+ seconds), transition to awaiting approval.

### Awaiting Approval UI

The ToolCard expands to show:

```
┌─ ToolCard ────────────────────────────┐
│ ⏳ Edit  src/auth.kt                  │
│ ┌───────────────────────────────────┐ │
│ │ (live terminal canvas, ~6 rows)   │ │
│ │ Shows actual Claude Code prompt   │ │
│ └───────────────────────────────────┘ │
│     [ Accept ]         [ Reject ]     │
└───────────────────────────────────────┘
```

**Live mini-terminal:** Reuses `TerminalPanel` composable with height constraints (~6 rows). Reads from the same `TerminalEmulator` screen buffer as the full-screen terminal. Always shows exactly what Claude Code is displaying.

**Buttons:**
- Accept sends `y\r` to PTY via `PtyBridge.writeInput()`
- Reject sends `n\r` to PTY
- If the detection was wrong (not actually an approval), the keystroke is harmless

**Mini-terminal disappears** when `PostToolUse` arrives and the card collapses to completed state.

## Activity Indicator

While waiting for the `Stop` hook (Claude's text response), the user needs to know Claude is working. The `Stop` hook only fires when a full turn completes, which can be 10-60 seconds.

### Signal Source

`PtyBridge` tracks `lastPtyOutputTime` — updated on every `onTextChanged` callback. No content parsing, just timestamp tracking.

A Compose-derived state: if `now - lastPtyOutputTime < 2 seconds` → active.

### Rendering

An animated indicator below the last message:

- **Default:** `Working...` with animating dots (one dot → two → three → reset)
- **When `PreToolUse` arrives:** switches to tool-specific text: `Reading file...`, `Editing...`, `Searching...` with the same dot animation
- **Disappears** when `Stop` hook arrives with the response text

## Inline Terminal Embeds

For output that doesn't map cleanly to cards (ANSI-colored bash output, complex tool results), the ToolCard's expanded state includes a mini-terminal canvas — the same live `TerminalPanel` used in the approval flow.

This is not a separate component. The approval-state mini-terminal and the inline-embed mini-terminal are the same thing: a height-constrained `TerminalPanel` inside a card. The approval state just adds Accept/Reject buttons below it.

## First-Run Flow

First-run setup (theme picker, login method, OAuth, permission mode) uses terminal-interactive ink menus that don't fire hooks. These are handled entirely in terminal mode.

1. App starts → terminal mode (full screen)
2. Bootstrap runs → installs Node.js, `hook-relay.js`, writes hook config to Claude Code settings
3. Claude Code launches → user completes setup in terminal
4. Setup complete → app sets `firstRunComplete` flag in SharedPreferences
5. Subsequent launches → app starts in chat mode

## Bootstrap Changes

Bootstrap.kt adds two steps after Node.js installation:

### 1. Install hook-relay.js

Copy `hook-relay.js` from app assets to the runtime directory (same mechanism as existing parser.js installation).

### 2. Write Hook Configuration

Write to `$HOME/.claude/settings.json` on the device:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{"type": "command", "command": "node /path/to/hook-relay.js"}]
    }],
    "PostToolUse": [{
      "matcher": ".*",
      "hooks": [{"type": "command", "command": "node /path/to/hook-relay.js"}]
    }],
    "PostToolUseFailure": [{
      "matcher": ".*",
      "hooks": [{"type": "command", "command": "node /path/to/hook-relay.js"}]
    }],
    "Stop": [{
      "matcher": ".*",
      "hooks": [{"type": "command", "command": "node /path/to/hook-relay.js"}]
    }],
    "Notification": [{
      "matcher": ".*",
      "hooks": [{"type": "command", "command": "node /path/to/hook-relay.js"}]
    }]
  }
}
```

The socket path is passed via `CLAUDE_MOBILE_SOCKET` environment variable, set by PtyBridge when launching the Claude Code process.

## Two-View Architecture

### Chat Mode (Default after first-run)

Primary interaction mode. Shows structured hook events as chat bubbles and cards. Input bar sends text to PTY as `text + "\r"`. Quick chips available below input.

### Terminal Mode (Full-screen toggle)

One-tap toggle from chat mode via terminal icon in toolbar. Full `TerminalPanel` canvas with keyboard row. Unchanged from Phase 2 implementation.

### Relationship

The terminal is always the ground truth. The chat view is a structured interpretation layer built from hook events. When the chat view can't handle something (first-run, unrecognized interactive elements, complex terminal UI), the user taps into terminal mode.

## Files Modified (Expected)

### New Files
- `assets/hook-relay.js` — Socket relay (~10 lines)
- `parser/HookEvent.kt` — Sealed class for hook events (replaces ParsedEvent.kt)

### Modified Files
- `runtime/Bootstrap.kt` — Install hook-relay.js, write hook config
- `runtime/PtyBridge.kt` — Remove accumulator, add `lastPtyOutputTime` activity signal, set `CLAUDE_MOBILE_SOCKET` env var
- `parser/EventBridge.kt` — Accept hook JSON schema instead of parser events
- `ui/ChatScreen.kt` — Remove all heuristic state, route hook events to ChatState
- `ui/ChatState.kt` — New MessageContent variants, remove heuristic state fields
- `ui/MessageBubble.kt` — Route new content types to cards
- `ui/cards/ToolCard.kt` — Add Running/AwaitingApproval/Complete states, embed mini-terminal
- `ui/cards/ApprovalCard.kt` — May merge into ToolCard or remain as delegate

### Deleted Files
- `parser/parser.js`
- `parser/patterns.js`
- `parser/PATTERNS.md`
- `parser/package.json`
- `parser/capture-output.sh`

### Unchanged Files
- `ui/TerminalPanel.kt`
- `ui/TerminalKeyboardRow.kt`
- `ui/SyntaxHighlighter.kt`
- `ui/cards/DiffCard.kt`, `CodeCard.kt`, `ErrorCard.kt`, `ProgressCard.kt`
- `ui/cards/CardState.kt`
- `ui/widgets/*` (retained, not actively used)
- `ui/theme/*`
- `ui/InputBar.kt`, `ui/QuickChips.kt`
- `runtime/SessionManager.kt`, `runtime/SessionService.kt`
- `config/*`

## Change Log

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-03-15 | Initial chat rebuild design |
| 1.1 | 2026-03-15 | Fix hook payload field names (`last_assistant_message`, `tool_response`, `tool_use_id`), add `PostToolUseFailure` hook, add `Notification(permission_prompt)` as primary approval signal, add error handling to hook-relay.js, note `tool_response` is structured object |
