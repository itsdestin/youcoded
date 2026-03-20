# Chat Persistence Between Panels

**Date:** 2026-03-19
**Status:** Approved

## Problem

Chat messages and text input do not persist when switching between Chat, Terminal, and Shell modes. Text typed in the input field is lost on mode switch. Messages sent in Terminal mode don't appear in the Chat view.

## Requirements

1. **Shared input draft** — one text field state per session, persists across Chat/Terminal/Shell mode switches
2. **Terminal input captured to ChatState** — every Send in terminal mode creates a user message bubble
3. **Claude responses already sync** — hook events flow to ChatState regardless of mode (no change needed)
4. **Remove Enter pill** — remove the `⏎` button from TerminalKeyboardRow; Send button and Gboard IME action are the only submit mechanisms
5. **Send requires text** — no empty sends in any mode
6. **Per-session drafts** — switching sessions restores that session's draft; drafts are in-memory only

## Approach: Lift draft into ChatState

ChatState already serves as the per-session UI state container (messages, processing flags, expanded card state). Adding `inputDraft` follows the existing pattern.

### Changes

#### 1. ChatState

Add one field:

```kotlin
var inputDraft by mutableStateOf("")
```

#### 2. ChatScreen — Chat mode input

- Replace local `chatInputText` with `chatState.inputDraft`
- Remove the `var chatInputText by remember { mutableStateOf("") }` declaration
- Send button clears `chatState.inputDraft = ""`

#### 3. ChatScreen — Terminal mode input

- `TerminalInputBar` becomes a controlled component: receives `chatState.inputDraft` as parameter and an `onDraftChange` callback
- On send: `chatState.addUserMessage(text)` → `bridge.writeInput(text + "\r")` → clear draft
- Send guard: require `isNotBlank()`

#### 4. ChatScreen — Shell mode input

- Shell mode also uses `TerminalInputBar`, so it shares the same `chatState.inputDraft` — draft persists across all three modes
- Shell mode does NOT capture input to ChatState (no `addUserMessage`) — Shell is a standalone bash session, not a Claude conversation, so chat messages would be meaningless
- Send still writes to `shell.writeInput(text + "\r")` as before

#### 5. ChatScreen — QuickChips

- Update chip tap references from `chatInputText = chip.prompt` to `chatState.inputDraft = chip.prompt`

#### 6. ChatScreen — Attachment handling

- `attachmentPath`/`attachmentBitmap` remain in local `remember` state — they are only relevant in Chat mode (Terminal/Shell have no image attachment UI)
- Chat mode send guard remains `isNotBlank() || attachmentPath != null` to allow attachment-only sends
- Terminal/Shell mode send guard is `isNotBlank()` only

#### 7. TerminalKeyboardRow

- Remove the `⏎` Enter pill (lines 76-83)
- Remaining keys: Ctrl, Esc, Tab, ←, ↑, ↓, →
- **Deliberate limitation:** bare Enter (empty `\r`) cannot be sent in Terminal mode. This was a conscious user decision. If needed later, the Enter pill can be restored.

### Data Flow

```
User types in any mode
        ↓
chatState.inputDraft (shared, per-session)
        ↓
User taps Send / Gboard Send
        ↓
chatState.addUserMessage(text)  ← message bubble created
bridge.writeInput(text + "\r")  ← sent to PTY
chatState.inputDraft = ""       ← draft cleared
        ↓
Claude processes in PTY
        ↓
Hook events → chatState (already working)
        ↓
Chat view shows full conversation
regardless of which mode it was sent from
```

### What's NOT changing

- No disk persistence for drafts (matches current behavior — messages aren't persisted either)
- No changes to hook event routing
- No changes to session lifecycle
- TerminalKeyboardRow special keys (Ctrl, Esc, Tab, arrows) still bypass the text field via `onKeyPress`
- Attachment state stays local to Chat mode (not lifted into ChatState)
- Both input bars already use `ImeAction.Send` — no IME configuration changes needed
