# Blocking Relay Protocol — Handoff Prompt

> Paste this entire document as a prompt to a new Claude session working in the `destinclaude-desktop` project.

---

## Context

We evaluated the desktop app's permission approval system and discovered it has **two layers** for handling interactive prompts. We then designed, prototyped, and validated a protocol upgrade to add structured blocking hook support. Your job is to evaluate this proposal against the current codebase, then implement if appropriate.

## Current State: Two Approval Systems

### System 1: PTY-based Ink Menu Detection (IMPLEMENTED, WORKING)

The app intercepts Claude Code's interactive terminal prompts by screen-scraping the xterm.js buffer:

- `src/renderer/hooks/usePromptDetector.ts` — fires on every PTY output event, reads the rendered xterm.js screen buffer
- `src/renderer/parser/ink-select-parser.ts` — parses for `❯`-prefixed numbered select menus, extracts options
- `src/renderer/components/PromptCard.tsx` — renders styled buttons with intent classification (accept=green, reject=red, neutral=gray)
- `src/renderer/components/TrustGate.tsx` — full-screen overlay variant for the initial "trust this folder?" prompt
- When user clicks a button, it sends **arrow key + enter keystrokes** to the PTY (simulating human input)
- This catches ALL Ink menus: trust gates, permission prompts, theme selection, login, skip-permissions warnings

**Strengths:** Catches everything, no protocol changes needed, graceful degradation (terminal still works if parsing fails).
**Weaknesses:** Fragile screen-parsing, no structured data about WHAT is being approved (just label text), timing races possible, keystroke simulation is indirect.

### System 2: Hook Relay (IMPLEMENTED, but fire-and-forget only)

- `hook-scripts/relay.js` — Claude Code spawns this per hook event, receives JSON on stdin, forwards over a Windows named pipe
- `src/main/hook-relay.ts` — named pipe server in Electron main process, parses events, emits to renderer via IPC
- **Currently fire-and-forget:** relay.js writes payload and immediately exits 0. Never waits for a response. The server (`socket.end()` on line 45 of hook-relay.ts) closes the connection immediately after parsing.
- This feeds the chat view with structured tool call data (PreToolUse, PostToolUse, Stop events) but CANNOT block or deny tool execution.

## Proposal: Hybrid Blocking Protocol

Keep PTY detection as the catch-all (for trust gates, non-hook menus), but add structured blocking for tool approval via hooks. The relay script becomes bidirectional.

### Protocol Design (Option 3 — server decides whether to block)

The relay writes its payload and **waits**. The server decides what happens:
- **Fire-and-forget:** Server closes socket without writing → relay sees `end` → exits 0 (backward compatible)
- **Blocking allow:** Server holds socket, writes `{"allow":true}\n` → relay exits 0
- **Blocking deny:** Server holds socket, writes `{"allow":false}\n` → relay exits 2
- **Timeout safety:** Relay has a configurable timeout (default 30s, via `CLAUDE_RELAY_TIMEOUT` env var). If server goes silent → relay exits 0 (fail-open)

Key property: **relay doesn't need to know which hooks are blocking.** The server decides. This means adding new blocking hook types only requires server-side changes.

### Spike Test Results (VALIDATED, 4/4 PASS)

We created `hook-scripts/relay-blocking.js` (the new relay) and `scripts/test-blocking-relay.js` (test harness). Results:

```
=== Blocking Relay Protocol Spike Test ===
[TEST] Fire-and-forget (server closes immediately)... PASS (exit=0, expected=0, 413ms)
[TEST] Blocking allow (server sends allow=true)...    PASS (exit=0, expected=0, 853ms)
[TEST] Blocking deny (server sends allow=false)...    PASS (exit=2, expected=2, 853ms)
[TEST] Timeout (server holds, relay fails open)...    PASS (exit=0, expected=0, 3365ms)
```

The pipe protocol works on Windows. Backward compatibility confirmed.

## Implementation Plan

### Step 1: Replace relay.js with relay-blocking.js
- `relay-blocking.js` is a drop-in replacement — when server closes without writing back, behavior is identical to current `relay.js`
- Rename or replace; update any references in `scripts/install-hooks.js` or hook config

### Step 2: Modify HookRelay server to support blocking responses
- In `src/main/hook-relay.ts`, `createServer` currently does `socket.end()` immediately after parsing
- For blocking hook types (e.g., `PreToolUse` when not in skip-permissions mode), **hold the socket open**
- Stash the socket in a `Map<string, net.Socket>` keyed by a request ID (tool_use_id or generated UUID)
- Emit the event as before, but include the request ID so the renderer can respond
- Add a `respond(requestId: string, allow: boolean)` method that looks up the socket, writes `{"allow": allow}\n`, and closes it
- Add cleanup: if socket disconnects before response (relay timeout), remove from map

### Step 3: Add IPC channel for approval decisions
- New IPC channel: renderer sends `{ sessionId, toolUseId, allow: boolean }` → main process calls `hookRelay.respond()`
- Wire this into `src/main/ipc-handlers.ts`
- Add to preload bridge in `src/main/preload.ts`

### Step 4: Add "Awaiting Approval" state to ToolCard
- `src/shared/types.ts` — add `'awaiting-approval'` to the ToolCallState status union
- `src/renderer/state/chat-reducer.ts` — new action or modify `PRE_TOOL_USE` to set status based on whether the hook is blocking
- `src/renderer/components/ToolCard.tsx` — add Accept/Reject buttons when `status === 'awaiting-approval'`
- Clicking Accept/Reject calls the new IPC channel
- On response, transition to `'running'` (if allowed) or `'denied'` (if rejected)

### Step 5: Determine which hooks should block
- In `HookRelay.createServer`, decide based on `hook_event_name`:
  - `PreToolUse` → block (hold socket open, show approval UI)
  - Everything else → fire-and-forget (close socket immediately)
- Later: could add `PermissionRequest` if Claude Code exposes it as a hook
- When running with `--dangerously-skip-permissions`, PreToolUse hooks still fire but approval is automatic — server should auto-respond `{"allow": true}` immediately without showing UI

## Files to Read Before Starting

1. `hook-scripts/relay-blocking.js` — the new relay script (already written)
2. `hook-scripts/relay.js` — the current relay (for comparison)
3. `scripts/test-blocking-relay.js` — the spike test (run it first to verify)
4. `src/main/hook-relay.ts` — the pipe server (needs modification)
5. `src/main/ipc-handlers.ts` — IPC wiring (needs new channel)
6. `src/main/preload.ts` — IPC bridge (needs new channel exposed)
7. `src/renderer/state/chat-reducer.ts` — state management (needs new status)
8. `src/renderer/state/chat-types.ts` — type definitions
9. `src/renderer/components/ToolCard.tsx` — tool card UI (needs approval buttons)
10. `src/renderer/hooks/usePromptDetector.ts` — PTY detection (keep as-is, this is the fallback)
11. `src/shared/types.ts` — shared type definitions (ToolCallState)

## Your Task

1. **Read the current versions** of all files listed above. The codebase may have changed since this proposal was written.
2. **Evaluate** whether this proposal still makes sense given the current code. Specifically:
   - Has relay.js already been updated?
   - Has HookRelay already been made bidirectional?
   - Are there new hook types or IPC channels that overlap with this proposal?
   - Does the ToolCard already have approval states?
3. **Report** what's still needed vs. what's already done.
4. **Implement** the remaining steps, testing as you go. Run `scripts/test-blocking-relay.js` first to verify the spike still passes. After implementation, verify the app builds with `npm run build`.

## Design Constraints

- PTY-based Ink detection (`usePromptDetector`, `PromptCard`, `TrustGate`) must remain as the fallback for non-hook interactive prompts. Do not remove or break it.
- The protocol must fail-open (exit 0) on timeout or error — Claude Code must never deadlock waiting for a response that will never come.
- `relay-blocking.js` must remain backward-compatible with the current fire-and-forget server behavior.
- The spec is at `~/.claude/specs/claude-desktop-ui-spec.md` — update the "Planned updates" section when done to reflect that blocking approval flow is implemented.
