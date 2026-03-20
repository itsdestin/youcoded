# Generic Menu Parser & Terminal UX Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded prompt detection with a generic Ink Select menu parser, and improve terminal-mode UX with floating arrow keys and a Shift+Tab permissions button.

**Architecture:** A regex-based parser detects Ink Select menus (`❯ N. Label` / `  N. Label`) in PTY output, extracts options, and generates arrow-key navigation sequences. A small title override map provides custom titles for known prompts. Terminal keyboard row is restructured with floating up/down arrows above the send button and a new Shift+Tab pill.

**Tech Stack:** Kotlin, Jetpack Compose, Regex

---

### Task 1: Create the Generic Menu Parser

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/parser/InkSelectParser.kt`

This parser extracts menu options from Ink Select component output. Ink renders menus like:

```
❯ 1. Yes, I trust this folder
  2. No, exit
```

Or without numbers:
```
❯ Dark mode
  Light mode
  Dark (colorblind-friendly)
```

The `❯` (U+276F) marks the currently selected item. All items are indented with `  ` (two spaces) except the selected one.

- [ ] **Step 1: Create InkSelectParser.kt**

```kotlin
package com.destin.code.parser

data class ParsedMenu(
    val id: String,
    val title: String,
    val options: List<String>,
    val selectedIndex: Int,  // which option is currently highlighted by ❯
)

object InkSelectParser {

    // Matches the selected line: starts with ❯ (U+276F), optionally followed by number
    private val SELECTED_LINE = Regex("""^❯\s*(?:\d+\.\s+)?(.+)$""")
    // Matches unselected lines: starts with 2+ spaces, optionally followed by number
    private val UNSELECTED_LINE = Regex("""^\s{2,}(?:\d+\.\s+)?(.+)$""")

    // Title overrides for known prompts — keyed by lowercase keyword found in context
    private val TITLE_OVERRIDES = mapOf(
        "trust" to "Trust This Folder?",
        "theme" to "Choose a Theme",
        "login method" to "Select Login Method",
        "dangerously-skip-permissions" to "Skip Permissions Warning",
        "skip all permission" to "Skip Permissions Warning",
    )

    /**
     * Attempt to parse an Ink Select menu from combined screen+raw PTY output.
     * Returns null if no menu is detected.
     */
    fun parse(screenText: String): ParsedMenu? {
        val lines = screenText.lines()

        // Find the selected-item line (starts with ❯)
        val selectorIndex = lines.indexOfLast { line ->
            SELECTED_LINE.matches(line.trimEnd())
        }
        if (selectorIndex < 0) return null

        // Gather contiguous option lines around the selector
        val options = mutableListOf<String>()
        val optionIndices = mutableListOf<Int>()

        // Walk backward from selector to find earlier options
        for (i in (selectorIndex - 1) downTo 0) {
            val match = UNSELECTED_LINE.matchEntire(lines[i].trimEnd()) ?: break
            options.add(0, match.groupValues[1].trim())
            optionIndices.add(0, i)
        }
        // Add the selected item
        val selectedMatch = SELECTED_LINE.matchEntire(lines[selectorIndex].trimEnd()) ?: return null
        val selectedIndex = options.size  // index within our collected options list
        options.add(selectedMatch.groupValues[1].trim())
        optionIndices.add(selectorIndex)
        // Walk forward from selector+1 to find later options
        for (i in (selectorIndex + 1) until lines.size) {
            val match = UNSELECTED_LINE.matchEntire(lines[i].trimEnd()) ?: break
            options.add(match.groupValues[1].trim())
            optionIndices.add(i)
        }

        // Need at least 2 options for a valid menu
        if (options.size < 2) return null

        // Filter out noise — each option should be relatively short (< 120 chars)
        if (options.any { it.length > 120 }) return null

        // Extract title from context above the menu
        val title = extractTitle(lines, optionIndices.first(), screenText)

        // Generate a stable ID from the options
        val id = "menu_" + options.joinToString("_") { it.take(10) }
            .lowercase().replace(Regex("[^a-z0-9_]"), "")

        return ParsedMenu(id = id, title = title, options = options, selectedIndex = selectedIndex)
    }

    /**
     * Look for a title/question in the lines above the menu.
     * First checks TITLE_OVERRIDES, then scans for the nearest question or heading.
     */
    private fun extractTitle(lines: List<String>, firstOptionLine: Int, fullText: String): String {
        val lower = fullText.lowercase()

        // Check title overrides first
        for ((keyword, title) in TITLE_OVERRIDES) {
            if (keyword in lower) return title
        }

        // Scan up to 10 lines above the menu for context
        val searchStart = maxOf(0, firstOptionLine - 10)
        for (i in (firstOptionLine - 1) downTo searchStart) {
            val line = lines[i].trim()
            if (line.isEmpty()) continue
            // Skip ANSI escape sequences for matching
            val clean = line.replace(Regex("\u001b\\[[0-9;]*[a-zA-Z]"), "").trim()
            if (clean.isEmpty()) continue
            // Prefer lines ending with ? or : as titles
            if (clean.endsWith("?") || clean.endsWith(":")) {
                return clean.trimEnd(':', '?').trim() + if (clean.endsWith("?")) "?" else ""
            }
            // Otherwise use the first non-empty line above as the title
            if (clean.length in 3..80) return clean
        }

        return "Select an Option"
    }

    /**
     * Generate PromptButtons from a parsed menu.
     * Sends up-arrows for items above the selector and down-arrows for items below.
     */
    fun toPromptButtons(menu: ParsedMenu): List<PromptButton> {
        val up = "\u001b[A"
        val down = "\u001b[B"
        return menu.options.mapIndexed { index, label ->
            val offset = index - menu.selectedIndex
            val sequence = when {
                offset < 0 -> up.repeat(-offset) + "\r"
                offset > 0 -> down.repeat(offset) + "\r"
                else -> "\r"  // already selected
            }
            PromptButton(label = label, input = sequence)
        }
    }
}

// Re-export for convenience — actual class lives in ChatState.kt
typealias PromptButton = com.destin.code.ui.PromptButton
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /c/Users/desti/destincode && ./gradlew compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/parser/InkSelectParser.kt
git commit -m "feat: add generic Ink Select menu parser"
```

---

### Task 2: Replace Hardcoded Detection with Generic Parser

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt` (lines 132-239)

Replace the entire `detectPrompts()` method body with the generic parser, keeping only the special-case handlers that can't be generically detected (paste_code browser auth, press-enter-to-continue).

- [ ] **Step 1: Rewrite detectPrompts()**

Replace lines 132-239 in ManagedSession.kt with:

```kotlin
    /** Known setup prompts and their button mappings. */
    private fun detectPrompts(screen: String, activePrompts: MutableSet<String>) {
        val lower = screen.lowercase()

        // --- Generic Ink Select menu detection ---
        val parsed = InkSelectParser.parse(screen)
        if (parsed != null) {
            if (parsed.id !in activePrompts && parsed.id !in completedPromptIds) {
                // Clear any previous generic menu that is no longer showing
                val staleMenus = activePrompts.filter { it.startsWith("menu_") }
                for (stale in staleMenus) {
                    activePrompts.remove(stale)
                    chatState.dismissPrompt(stale)
                }
                activePrompts.add(parsed.id)
                chatState.showInteractivePrompt(
                    parsed.id,
                    parsed.title,
                    InkSelectParser.toPromptButtons(parsed),
                )
            }
        } else {
            // No menu detected — dismiss any active generic menus
            val staleMenus = activePrompts.filter { it.startsWith("menu_") }
            for (stale in staleMenus) {
                activePrompts.remove(stale)
                chatState.dismissPrompt(stale)
            }
        }

        // --- Special-case: Browser auth / paste code prompt ---
        // (Not an Ink Select menu — just informational text with no selectable options)
        if (("paste code" in lower || "paste the code" in lower || "browser" in lower) &&
            ("sign" in lower || "code" in lower || "authorize" in lower)) {
            if ("paste_code" !in activePrompts && "paste_code" !in completedPromptIds) {
                activePrompts.add("paste_code")
                chatState.showInteractivePrompt("paste_code", "Complete Sign-In in Your Browser", listOf(
                    com.destin.code.ui.PromptButton("Browser opened — waiting for code...", ""),
                ))
            }
        } else if ("paste_code" in activePrompts) {
            activePrompts.remove("paste_code")
            chatState.dismissPrompt("paste_code")
        }

        // --- Special-case: "Press Enter to continue" ---
        // (Single-action prompt, not an Ink Select menu)
        if ("press enter to continue" in lower) {
            // Auto-collapse the browser sign-in card if still active
            if ("paste_code" in activePrompts) {
                activePrompts.remove("paste_code")
                completedPromptIds.add("paste_code")
                chatState.completePrompt("paste_code", "Signed in")
            }
            val continueKey = when {
                "login successful" in lower -> "continue_login"
                "security" in lower -> "continue_security"
                else -> "continue_other_${continueCounter++}"
            }
            if (continueKey !in activePrompts && continueKey !in completedPromptIds) {
                activePrompts.add(continueKey)
                val title = when {
                    "login successful" in lower -> "Login Successful!"
                    "security" in lower -> "Remember, Claude Can Make Mistakes"
                    else -> "Ready"
                }
                chatState.showInteractivePrompt(continueKey, title, listOf(
                    com.destin.code.ui.PromptButton("Continue", "\r"),
                ))
            }
        }
    }
```

- [ ] **Step 2: Add import for InkSelectParser**

Add to the imports at the top of ManagedSession.kt:

```kotlin
import com.destin.code.parser.InkSelectParser
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /c/Users/desti/destincode && ./gradlew compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt
git commit -m "feat: replace hardcoded prompt detection with generic Ink Select parser"
```

---

### Task 3: Restructure Terminal Keyboard Row — Floating Arrows + Shift+Tab

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/ui/TerminalKeyboardRow.kt`
- Modify: `app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt` (TerminalInputBar composable, ~lines 628-733)

The current layout has all keys in one row: `[Ctrl] [Esc] [Tab] [←] [↑] [↓] [→]`

New layout:
- **Bottom row (TerminalKeyboardRow):** `[Ctrl] [Esc] [Tab] [Shift+Tab] [←] [→]`
- **Floating arrows:** Up/Down arrows stacked vertically, floating above the send button in TerminalInputBar

- [ ] **Step 1: Update TerminalKeyboardRow — remove up/down arrows, add Shift+Tab**

Replace the entire `TerminalKeyboardRow` composable in TerminalKeyboardRow.kt with:

```kotlin
@Composable
fun TerminalKeyboardRow(
    onKeyPress: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var ctrlActive by remember { mutableStateOf(false) }
    val borderColor = DestinCodeTheme.extended.surfaceBorder

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 6.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Ctrl
        SmallPill(
            label = "Ctrl",
            isActive = ctrlActive,
            borderColor = borderColor,
            modifier = Modifier.weight(1f).height(36.dp),
        ) { ctrlActive = !ctrlActive }

        // Esc
        SmallPill("Esc", borderColor = borderColor, modifier = Modifier.weight(1f).height(36.dp)) {
            sendKey("\u001b", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Tab
        SmallPill("Tab", borderColor = borderColor, modifier = Modifier.weight(1f).height(36.dp)) {
            sendKey("\t", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Shift+Tab (sends ESC [ Z — reverse tab / backtab)
        SmallPill("⇧Tab", borderColor = borderColor, modifier = Modifier.weight(1f).height(36.dp)) {
            onKeyPress("\u001b[Z")
        }

        // Arrow keys — left/right only (up/down moved to floating arrows)
        ArrowPill(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Left", borderColor, Modifier.weight(0.65f).height(36.dp)) {
            sendKey("\u001b[D", ctrlActive, onKeyPress) { ctrlActive = false }
        }
        ArrowPill(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Right", borderColor, Modifier.weight(0.65f).height(36.dp)) {
            sendKey("\u001b[C", ctrlActive, onKeyPress) { ctrlActive = false }
        }
    }
}
```

- [ ] **Step 2: Add floating up/down arrows to TerminalInputBar**

In ChatScreen.kt, modify the `TerminalInputBar` composable. Replace the outer `Column` content (lines 640-732) so the input row is wrapped in a `Box` that positions floating arrows above the send button:

```kotlin
@Composable
private fun TerminalInputBar(
    focusRequester: FocusRequester,
    draft: TextFieldValue,
    onDraftChange: (TextFieldValue) -> Unit,
    onSend: (String) -> Unit,
    onKeyPress: (String) -> Unit,
    onAttachImage: (() -> Unit)? = null,
    attachmentPath: String? = null,
) {
    val borderColor = com.destin.code.ui.theme.DestinCodeTheme.extended.surfaceBorder

    Column {
        // Input row + floating arrows
        Box(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 6.dp, vertical = 5.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 42.dp, max = 120.dp)
                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.surface)
                        .border(0.5.dp, borderColor.copy(alpha = 0.5f),
                            androidx.compose.foundation.shape.RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.TopStart,
                ) {
                    BasicTextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        singleLine = false,
                        maxLines = 5,
                        textStyle = androidx.compose.ui.text.TextStyle(
                            fontSize = 14.sp,
                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        keyboardOptions = KeyboardOptions(
                            imeAction = ImeAction.Send,
                        ),
                        keyboardActions = KeyboardActions(onSend = {
                            onSend(draft.text)
                        }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 10.dp)
                            .focusRequester(focusRequester),
                        decorationBox = { innerTextField ->
                            Row(
                                verticalAlignment = Alignment.Top,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Box(modifier = Modifier.weight(1f)) {
                                    if (draft.text.isEmpty()) {
                                        Text(
                                            "Type a message\u2026",
                                            fontSize = 14.sp,
                                            fontFamily = com.destin.code.ui.theme.CascadiaMono,
                                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                        )
                                    }
                                    innerTextField()
                                }
                                if (onAttachImage != null) {
                                    Icon(
                                        Icons.Outlined.Image,
                                        contentDescription = "Attach image",
                                        tint = if (attachmentPath != null)
                                            Color(0xFFB0B0B0)
                                        else
                                            Color(0xFF555555),
                                        modifier = Modifier
                                            .size(20.dp)
                                            .clickable { onAttachImage() },
                                    )
                                }
                            }
                        },
                    )
                }

                // Send button
                Box(
                    modifier = Modifier
                        .size(42.dp)
                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                        .border(0.5.dp, borderColor.copy(alpha = 0.5f),
                            androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                        .clickable { onSend(draft.text) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }

            // Floating up/down arrows — stacked vertically above the send button
            Column(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 6.dp, bottom = 52.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                FloatingArrowButton(
                    icon = Icons.Filled.KeyboardArrowUp,
                    contentDescription = "Up",
                    borderColor = borderColor,
                    onClick = { onKeyPress("\u001b[A") },
                )
                FloatingArrowButton(
                    icon = Icons.Filled.KeyboardArrowDown,
                    contentDescription = "Down",
                    borderColor = borderColor,
                    onClick = { onKeyPress("\u001b[B") },
                )
            }
        }

        TerminalKeyboardRow(onKeyPress = onKeyPress)
    }
}

@Composable
private fun FloatingArrowButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    borderColor: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.95f))
            .border(0.5.dp, borderColor.copy(alpha = 0.5f),
                androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(22.dp),
        )
    }
}
```

- [ ] **Step 3: Add missing imports to ChatScreen.kt**

Ensure these imports exist at the top of ChatScreen.kt:

```kotlin
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.KeyboardArrowDown
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /c/Users/desti/destincode && ./gradlew compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/TerminalKeyboardRow.kt
git add app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt
git commit -m "feat: floating up/down arrows above send button, add Shift+Tab pill"
```

---

### Task 4: Build and Verify on Device

- [ ] **Step 1: Build debug APK**

Run: `cd /c/Users/desti/destincode && ./gradlew assembleDebug 2>&1 | tail -10`
Expected: BUILD SUCCESSFUL

- [ ] **Step 2: Manual verification checklist**

After installing on device, verify:
1. Launch Claude Code — trust folder prompt appears as chat menu buttons
2. Theme selection appears as chat menu buttons
3. Login method selection appears as chat menu buttons
4. In terminal mode: up/down arrows float above the send button, stacked vertically
5. In terminal mode: Shift+Tab (⇧Tab) pill appears in the keyboard row
6. In terminal mode: left/right arrows still in keyboard row
7. Pressing ⇧Tab in terminal sends the backtab sequence (changes Claude Code permission mode)
8. Chat menu buttons send correct arrow-key sequences (option 1 = Enter, option 2 = ↓+Enter, etc.)
9. Completed prompts collapse to checkmark + title + selection
