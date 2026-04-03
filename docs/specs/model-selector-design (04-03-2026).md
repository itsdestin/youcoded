# Model Selector Chip — Design Spec

**Date:** 2026-04-03
**Status:** Approved
**Scope:** DestinCode Android app + DestinCode Desktop app

## Overview

A cycling chip in the StatusBar that lets users switch between Claude models (Sonnet, Opus, Haiku) with a single tap. Optimistic UI with deferred verification via transcript JSONL.

## UI Component

### StatusBar Cycling Chip

- Lives in the StatusBar alongside usage, context %, and sync status
- Displays the current model's short friendly name: **Sonnet**, **Opus**, **Haiku**
- Tapping cycles through models in fixed order: Sonnet → Opus → Haiku → Sonnet → ...
- Each model has a distinct subtle color for at-a-glance identification:
  - **Sonnet:** default gray (the "normal" model)
  - **Opus:** indigo/purple tint (the "premium" model)
  - **Haiku:** teal/cyan tint (the "fast" model)
- Fully optimistic on tap — immediately shows the next model with no loading/pending state

### Model List (Hardcoded)

| Short Name | `--model` value | Color |
|---|---|---|
| Sonnet | `sonnet` | Gray |
| Opus | `opus` | Indigo/purple |
| Haiku | `haiku` | Teal/cyan |

Short aliases are used (`sonnet`, `opus`, `haiku`). Claude Code resolves these to the latest version automatically, so the list stays current without app updates.

## Model Selection Lifecycle

### At Session Launch

1. Read the user's default model from DestinCode's own preference store (e.g., `~/.claude-mobile/model-preference.json` on Android, app-level storage on desktop)
2. Pass `--model <selected>` as a flag in the launch command (`PtyBridge.start()` on Android, session spawn on desktop)
3. Chip displays the selected model immediately — no verification needed since we control the launch

### Mid-Session Switch

1. User taps chip → UI instantly cycles to next model name and color
2. App sends `/model <name>\r` through the PTY
3. App records the "pending model" and a timestamp
4. On the next assistant response (detected by a new transcript JSONL entry with `type: "assistant"` and a `message.model` field), compare against the pending model
5. **Match → confirmed.** Clear pending state. Update the persisted default.
6. **Mismatch → revert.** Chip snaps back to the actual model from the transcript. Show toast: "Couldn't switch to [Model]"
7. **No response yet → stay optimistic.** Verification happens whenever the next response arrives. No timeout-based expiry.

### Error Escalation

- **First failure:** Chip reverts + brief toast with the error
- **Second consecutive failure:** Chip reverts + toast with guidance: "Model switch failed again. Ask Claude to diagnose with `/model`, or report a bug."

### Persisting the Default

- Every confirmed switch writes to DestinCode's own preference file
- This is NOT `~/.claude/settings.json` (Claude Code's config) — it's DestinCode's own preference
- New sessions use the persisted default automatically

## Transcript Verification Mechanism

### Reading the Transcript

- The Claude Code session ID is available from hook events (`session_id` field) flowing through EventBridge
- Transcript path: `~/.claude/projects/<project-key>/<session-id>.jsonl`
- Each assistant response is a JSON line with `"type": "assistant"` and `message.model` containing the actual model ID (e.g., `"claude-opus-4-6"`)
- Read from the end of the file (tail last few lines) — no need to parse the entire JSONL

### Model ID Matching

The transcript records full model IDs (e.g., `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). Verification checks whether the transcript model ID **contains** the short alias:
- `"claude-opus-4-6"` contains `"opus"` → matches Opus
- `"claude-sonnet-4-6"` contains `"sonnet"` → matches Sonnet
- `"claude-haiku-4-5-20251001"` contains `"haiku"` → matches Haiku

This substring match is resilient to version changes without requiring a lookup table.

### Platform Implementation

- **Desktop (Electron):** Main process reads the transcript file. Can extend `buildStatusData()` in `ipc-handlers.ts` or use a targeted file watcher
- **Android:** Kotlin reads the file from the filesystem. Can use `FileObserver` (same pattern as the existing URL observer) or poll on a timer

### Edge Cases

- **No assistant response yet:** Chip shows the launch model from `--model` flag. No verification needed.
- **Multiple cycles before a response:** Only the latest pending model matters. Earlier ones are discarded.
- **Session dies/restarts:** Chip resets to the launch model of the new session.

## Integration Points

### Android (`destincode` repo)

| File | Change |
|------|--------|
| `runtime/PtyBridge.kt` | Add `model` parameter, append `--model <name>` to `launchCmd` |
| `runtime/SessionRegistry.kt` | Pass selected model when creating sessions |
| `web/components/StatusBar.js` | Add model chip component with click handler |
| `web/App.js` | Wire model state, cycling logic, persist/read preference |
| `web/remote-shim.js` | Add `model:switch` message type for chip → native communication |
| New: model preference store | Persist default model selection |

### Desktop (`destinclaude/desktop` repo)

| File | Change |
|------|--------|
| `src/main/ipc-handlers.ts` | Add model to `buildStatusData()`, transcript reading for verification |
| `src/main/preload.ts` | Expose model switch IPC channel |
| Shared web UI `StatusBar.js` | Same chip component as Android |
| Session launch logic | Pass `--model` flag |

## What We're NOT Building

- No dropdown or menu — tap to cycle only
- No model descriptions in the UI beyond the chip name
- No per-conversation model memory — all sessions share one default, overridable by cycling
- No manual model ID entry — hardcoded list only
- No settings panel for model selection — the chip IS the selector
- No model info in the HeaderBar (the existing dead `statusData.model` label gets removed)
