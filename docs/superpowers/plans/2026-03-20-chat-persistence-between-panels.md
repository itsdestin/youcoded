# Chat Persistence Between Panels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat messages and input text persist across Chat/Terminal/Shell mode switches within a session.

**Architecture:** Add `inputDraft` field to ChatState (per-session Compose state). Convert TerminalInputBar from self-contained to controlled component. Terminal sends also create ChatMessage entries. Remove Enter pill from TerminalKeyboardRow.

**Tech Stack:** Kotlin, Jetpack Compose

**Spec:** `docs/superpowers/specs/2026-03-19-chat-persistence-between-panels-design.md`

---

### Task 1: Add `inputDraft` to ChatState

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/ui/ChatState.kt:66-75`

- [ ] **Step 1: Add the inputDraft field**

Add after line 68 (`var expandedCardId`) in `ChatState`:

```kotlin
/** Draft text in the input bar — shared across Chat/Terminal/Shell modes */
var inputDraft by mutableStateOf("")
```

- [ ] **Step 2: Verify the app builds**

Run: `./gradlew assembleDebug 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/ChatState.kt
git commit -m "feat: add inputDraft field to ChatState for cross-mode persistence"
```

---

### Task 2: Wire ChatScreen chat mode to `chatState.inputDraft`

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt:68,393-395,413,448,459,463,480`

- [ ] **Step 1: Remove the local `chatInputText` variable**

Delete line 68:
```kotlin
var chatInputText by remember { mutableStateOf("") }
```

- [ ] **Step 2: Replace all `chatInputText` references with `chatState.inputDraft`**

There are 9 occurrences in ChatScreen.kt (plus 1 in QuickChips handled in Step 3). Replace each one:

| Line | Old | New |
|------|-----|-----|
| 394 | `value = chatInputText,` | `value = chatState.inputDraft,` |
| 395 | `onValueChange = { chatInputText = it },` | `onValueChange = { chatState.inputDraft = it },` |
| 413 | `if (chatInputText.isEmpty())` | `if (chatState.inputDraft.isEmpty())` |
| 448 | `if (chatInputText.isNotBlank() \|\| attachmentPath != null)` | `if (chatState.inputDraft.isNotBlank() \|\| attachmentPath != null)` |
| 454 | `append(chatInputText)` | `append(chatState.inputDraft)` |
| 457 | `attachmentPath != null && chatInputText.isBlank() -> "[image]"` | `attachmentPath != null && chatState.inputDraft.isBlank() -> "[image]"` |
| 458 | `attachmentPath != null -> "[image] $chatInputText"` | `attachmentPath != null -> "[image] ${chatState.inputDraft}"` |
| 459 | `else -> chatInputText` | `else -> chatState.inputDraft` |
| 463 | `chatInputText = ""` | `chatState.inputDraft = ""` |

- [ ] **Step 3: Update QuickChips reference**

Line 480 — replace:
```kotlin
chatInputText = chip.prompt
```
with:
```kotlin
chatState.inputDraft = chip.prompt
```

- [ ] **Step 4: Verify the app builds**

Run: `./gradlew assembleDebug 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt
git commit -m "feat: wire chat mode input to chatState.inputDraft"
```

---

### Task 3: Convert TerminalInputBar to controlled component and capture terminal sends

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt:159-163,203-206,574-665`

- [ ] **Step 1: Update TerminalInputBar signature**

Change the function signature (line 574) from:
```kotlin
private fun TerminalInputBar(
    focusRequester: FocusRequester,
    onSend: (String) -> Unit,
    onKeyPress: (String) -> Unit,
) {
    var text by remember { mutableStateOf("") }
```

to:
```kotlin
private fun TerminalInputBar(
    focusRequester: FocusRequester,
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: (String) -> Unit,
    onKeyPress: (String) -> Unit,
) {
```

- [ ] **Step 2: Replace all `text` references inside TerminalInputBar**

Replace every occurrence of the local `text` variable with the controlled props.

**Note:** `isNotEmpty()` → `isNotBlank()` is intentional — it prevents sending whitespace-only input, aligning with spec requirement 5.

IME handler (lines 613-618) — replace entire block:
```kotlin
// Before:
keyboardActions = KeyboardActions(onSend = {
    if (text.isNotEmpty()) {
        onSend(text)
        text = ""
    }
}),

// After:
keyboardActions = KeyboardActions(onSend = {
    if (draft.isNotBlank()) {
        onSend(draft)
    }
}),
```

Send button click handler (lines 646-651) — replace entire block:
```kotlin
// Before:
.clickable {
    if (text.isNotEmpty()) {
        onSend(text)
        text = ""
    }
},

// After:
.clickable {
    if (draft.isNotBlank()) {
        onSend(draft)
    }
},
```

Remaining simple replacements:

| Location | Old | New |
|----------|-----|-----|
| Line 601 | `value = text,` | `value = draft,` |
| Line 602 | `onValueChange = { text = it },` | `onValueChange = onDraftChange,` |
| Line 625 | `if (text.isEmpty())` | `if (draft.isEmpty())` |

- [ ] **Step 3: Update Terminal mode call site to pass draft and capture messages**

Replace the TerminalInputBar call in Terminal mode (lines 159-163):

```kotlin
TerminalInputBar(
    focusRequester = termFocusRequester,
    onSend = { text -> bridge?.writeInput(text + "\r") },
    onKeyPress = { seq -> bridge?.writeInput(seq) },
)
```

with:

```kotlin
TerminalInputBar(
    focusRequester = termFocusRequester,
    draft = chatState.inputDraft,
    onDraftChange = { chatState.inputDraft = it },
    onSend = { text ->
        chatState.addUserMessage(text)
        bridge?.writeInput(text + "\r")
        chatState.inputDraft = ""
    },
    onKeyPress = { seq -> bridge?.writeInput(seq) },
)
```

- [ ] **Step 4: Update Shell mode call site to pass draft (no message capture)**

Replace the TerminalInputBar call in Shell mode (lines 203-206):

```kotlin
TerminalInputBar(
    focusRequester = shellFocusRequester,
    onSend = { text -> shell.writeInput(text + "\r") },
    onKeyPress = { seq -> shell.writeInput(seq) },
)
```

with:

```kotlin
TerminalInputBar(
    focusRequester = shellFocusRequester,
    draft = chatState.inputDraft,
    onDraftChange = { chatState.inputDraft = it },
    onSend = { text ->
        shell.writeInput(text + "\r")
        chatState.inputDraft = ""
    },
    onKeyPress = { seq -> shell.writeInput(seq) },
)
```

- [ ] **Step 5: Verify the app builds**

Run: `./gradlew assembleDebug 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt
git commit -m "feat: share input draft across modes, capture terminal sends to ChatState"
```

---

### Task 4: Remove Enter pill from TerminalKeyboardRow

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/ui/TerminalKeyboardRow.kt:75-83`

- [ ] **Step 1: Remove the Enter pill**

Delete lines 75-83 from `TerminalKeyboardRow`:

```kotlin
        // Enter
        SmallPill(
            "⏎",
            isPrimary = true,
            borderColor = borderColor,
            modifier = Modifier.weight(0.85f).height(36.dp),
        ) {
            sendKey("\r", ctrlActive, onKeyPress) { ctrlActive = false }
        }
```

- [ ] **Step 2: Verify the app builds**

Run: `./gradlew assembleDebug 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/TerminalKeyboardRow.kt
git commit -m "feat: remove Enter pill from TerminalKeyboardRow — Send button is the only submit"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Install and test**

Build and install on device:
```bash
./gradlew installDebug
```

Manual test checklist:
1. Type text in Chat mode → switch to Terminal → text is still there
2. Type text in Terminal mode → switch to Chat → text is still there
3. Send a message in Terminal mode → switch to Chat → see the user message bubble
4. Send a message in Chat mode → switch to Terminal → chat history shows in Chat when switching back
5. Switch between sessions → each session has its own draft
6. QuickChips that set prompt text work correctly
7. Image attachment + send still works in Chat mode
8. TerminalKeyboardRow no longer has Enter pill
9. Ctrl, Esc, Tab, arrow keys still work in Terminal/Shell mode

- [ ] **Step 2: Final commit if any fixes needed**
