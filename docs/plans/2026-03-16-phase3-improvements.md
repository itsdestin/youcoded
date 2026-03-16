# Phase 3 Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add markdown rendering in chat, bundle git at bootstrap, and enable image attachment from photo library.

**Architecture:** Three independent features modifying different files. Markdown adds commonmark-java parser + new Compose renderer. Git moves existing deb URLs earlier in bootstrap. Image input adds Android photo picker + input bar icon + prompt injection.

**Tech Stack:** Kotlin, Jetpack Compose, commonmark-java 0.24.0, Android ActivityResultContracts, BitmapFactory

**Spec:** `docs/specs/2026-03-16-phase3-improvements-design.md` (v1.2)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `app/build.gradle.kts` | Modify | Add commonmark-java dependency |
| `app/src/main/kotlin/.../ui/MarkdownRenderer.kt` | Create | Parse markdown AST → Compose UI |
| `app/src/main/kotlin/.../ui/MessageBubble.kt` | Modify | Route Response content to MarkdownRenderer |
| `app/src/main/kotlin/.../runtime/Bootstrap.kt` | Modify | Move git debs into installPackages, remove installGit |
| `app/src/main/kotlin/.../ui/ChatScreen.kt` | Modify | Photo picker, input bar icon, thumbnail preview, prompt injection |

Base path for all Kotlin files: `app/src/main/kotlin/com/destins/claudemobile`

---

## Chunk 1: Git at Bootstrap

### Task 1: Move git packages into installPackages

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt`

- [ ] **Step 1: Add git dependency debs to installPackages()**

In `Bootstrap.kt`, find the comment `// Git is deferred to on-demand installation via installGit()` at the end of `installPackages()` (around line 203). Replace that comment block with the git package installations, using the same sentinel-file-check + `installDeb()` pattern as the existing packages.

Note: `installPackages()` is called from `setup()` which already runs on `Dispatchers.IO` via `withContext`, so no dispatcher change is needed despite the removed `installGit()` having its own `withContext(Dispatchers.IO)` wrapper.

```kotlin
        // Git and its runtime dependencies
        // TODO: Resolve exact .deb paths from Termux API (currently hardcoded URLs)
        if (!File(usrDir, "lib/libssl.so").exists()) {
            onProgress(Progress.Installing("openssl"))
            installDeb("pool/main/o/openssl/openssl_3.5.0_aarch64.deb")
        }
        if (!File(usrDir, "lib/libcurl.so").exists()) {
            onProgress(Progress.Installing("libcurl"))
            installDeb("pool/main/c/curl/libcurl_8.13.0_aarch64.deb")
        }
        if (!File(usrDir, "lib/libexpat.so").exists()) {
            onProgress(Progress.Installing("libexpat"))
            installDeb("pool/main/e/expat/libexpat_2.7.1_aarch64.deb")
        }
        if (!File(usrDir, "lib/libiconv.so").exists()) {
            onProgress(Progress.Installing("libiconv"))
            installDeb("pool/main/libi/libiconv/libiconv_1.18_aarch64.deb")
        }
        if (!File(usrDir, "lib/libpcre2-8.so").exists()) {
            onProgress(Progress.Installing("pcre2"))
            installDeb("pool/main/p/pcre2/libpcre2_10.45_aarch64.deb")
        }
        if (!File(usrDir, "lib/libz.so").exists()) {
            onProgress(Progress.Installing("zlib"))
            installDeb("pool/main/z/zlib/zlib_1.3.1_aarch64.deb")
        }
        if (!File(usrDir, "bin/git").exists()) {
            onProgress(Progress.Installing("git"))
            installDeb("pool/main/g/git/git_2.49.0_aarch64.deb")
        }
```

- [ ] **Step 2: Remove installGit() function**

Delete the entire `installGit()` function (lines 215-263 approximately) — the `suspend fun installGit(onProgress: (Progress) -> Unit)` function and its contents.

- [ ] **Step 3: Verify no remaining references to installGit**

Run: search Kotlin source files (`app/src/main/kotlin/`) for `installGit` to confirm no callers exist.

Expected: zero matches in Kotlin source files. (Doc/spec files may reference the name — those are informational, not callers.)

- [ ] **Step 4: Verify the project builds**

Run: `cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug`

Expected: BUILD SUCCESSFUL

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt
git commit -m "feat: bundle git in bootstrap instead of on-demand install"
```

---

## Chunk 2: Markdown Rendering

### Task 2: Add commonmark-java dependency

**Files:**
- Modify: `app/build.gradle.kts`

- [ ] **Step 1: Add commonmark dependency**

In `app/build.gradle.kts`, add to the `dependencies` block after the Apache Commons Compress entries:

```kotlin
    // Markdown parsing for chat view
    implementation("org.commonmark:commonmark:0.24.0")
```

- [ ] **Step 2: Sync and verify build**

Run: `cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug`

Expected: BUILD SUCCESSFUL (dependency downloads then compiles)

- [ ] **Step 3: Commit**

```bash
git add app/build.gradle.kts
git commit -m "deps: add commonmark-java for markdown rendering"
```

### Task 3: Create MarkdownRenderer composable

**Files:**
- Create: `app/src/main/kotlin/com/destins/claudemobile/ui/MarkdownRenderer.kt`

- [ ] **Step 1: Create MarkdownRenderer.kt**

Create the file with the full implementation. The composable parses markdown via commonmark-java, then walks the AST to emit Compose UI:

```kotlin
package com.destins.claudemobile.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.cards.CodeCard
import com.destins.claudemobile.ui.theme.CascadiaMono
import org.commonmark.node.*
import org.commonmark.parser.Parser

private val URL_PATTERN = Regex("""https?://[^\s)>\]"'`]+""")
private val LINK_COLOR = Color(0xFF66AAFF)
private val INLINE_CODE_BG = Color(0xFF222222)
private val INLINE_CODE_COLOR = Color(0xFFc96442)
private val BLOCKQUOTE_BORDER = Color(0xFFc96442)
private val BLOCKQUOTE_TEXT = Color(0xFF999999)
private val HR_COLOR = Color(0xFF333333)

/**
 * Renders markdown text as Compose UI.
 * Replaces LinkableText for Claude Response messages.
 */
@Composable
fun MarkdownRenderer(
    markdown: String,
    textColor: Color = MaterialTheme.colorScheme.onSurface,
    expandedCardId: String? = null,
    onToggleCard: (String) -> Unit = {},
) {
    val parser = remember { Parser.builder().build() }
    val document = remember(markdown) { parser.parse(markdown) }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var node = document.firstChild
        while (node != null) {
            RenderBlock(node, textColor, expandedCardId, onToggleCard)
            node = node.next
        }
    }
}

@Composable
private fun RenderBlock(
    node: Node,
    textColor: Color,
    expandedCardId: String?,
    onToggleCard: (String) -> Unit,
) {
    when (node) {
        is Paragraph -> {
            RenderInlineContent(node, textColor)
        }
        is Heading -> {
            val fontSize = when (node.level) {
                1 -> 18.sp
                2 -> 16.sp
                else -> 14.sp
            }
            val annotated = buildInlineAnnotatedString(node, textColor)
            Text(
                text = annotated,
                fontSize = fontSize,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 4.dp, bottom = 2.dp),
            )
        }
        is FencedCodeBlock -> {
            val lang = node.info?.takeIf { it.isNotBlank() } ?: ""
            val code = node.literal.trimEnd('\n')
            val cardId = "code_${code.hashCode()}"
            CodeCard(
                cardId = cardId,
                language = lang,
                code = code,
                isExpanded = expandedCardId == cardId,
                onToggle = onToggleCard,
            )
        }
        is IndentedCodeBlock -> {
            val code = node.literal.trimEnd('\n')
            val cardId = "code_${code.hashCode()}"
            CodeCard(
                cardId = cardId,
                language = "",
                code = code,
                isExpanded = expandedCardId == cardId,
                onToggle = onToggleCard,
            )
        }
        is BlockQuote -> {
            val borderColor = BLOCKQUOTE_BORDER
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .drawBehind {
                        drawLine(
                            color = borderColor,
                            start = Offset(0f, 0f),
                            end = Offset(0f, size.height),
                            strokeWidth = 2.dp.toPx(),
                        )
                    }
                    .padding(start = 12.dp),
            ) {
                Column {
                    var child = node.firstChild
                    while (child != null) {
                        RenderBlock(child, BLOCKQUOTE_TEXT, expandedCardId, onToggleCard)
                        child = child.next
                    }
                }
            }
        }
        is BulletList -> {
            Column(modifier = Modifier.padding(start = 8.dp)) {
                var item = node.firstChild
                while (item != null) {
                    if (item is ListItem) {
                        Row(modifier = Modifier.padding(vertical = 1.dp)) {
                            Text("•  ", color = textColor, fontSize = 14.sp)
                            Column(modifier = Modifier.weight(1f)) {
                                var child = item.firstChild
                                while (child != null) {
                                    RenderBlock(child, textColor, expandedCardId, onToggleCard)
                                    child = child.next
                                }
                            }
                        }
                    }
                    item = item.next
                }
            }
        }
        is OrderedList -> {
            Column(modifier = Modifier.padding(start = 8.dp)) {
                var index = node.startNumber
                var item = node.firstChild
                while (item != null) {
                    if (item is ListItem) {
                        Row(modifier = Modifier.padding(vertical = 1.dp)) {
                            Text("$index. ", color = textColor, fontSize = 14.sp)
                            Column(modifier = Modifier.weight(1f)) {
                                var child = item.firstChild
                                while (child != null) {
                                    RenderBlock(child, textColor, expandedCardId, onToggleCard)
                                    child = child.next
                                }
                            }
                        }
                    }
                    index++
                    item = item.next
                }
            }
        }
        is ThematicBreak -> {
            HorizontalDivider(
                color = HR_COLOR,
                thickness = 1.dp,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
    }
}

/**
 * Renders a block node's inline children as a single ClickableText
 * with URL detection for both explicit links and bare URLs.
 */
@Composable
private fun RenderInlineContent(node: Node, textColor: Color) {
    val context = LocalContext.current
    val annotated = buildInlineAnnotatedString(node, textColor)

    if (annotated.getStringAnnotations("URL", 0, annotated.length).isEmpty()) {
        Text(text = annotated, style = MaterialTheme.typography.bodyMedium)
    } else {
        ClickableText(
            text = annotated,
            style = MaterialTheme.typography.bodyMedium,
        ) { offset ->
            annotated.getStringAnnotations("URL", offset, offset).firstOrNull()?.let {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it.item)))
            }
        }
    }
}

/**
 * Walks inline children of a block node and builds an AnnotatedString.
 * Handles bold, italic, inline code, explicit links, and bare URL detection.
 */
private fun buildInlineAnnotatedString(
    node: Node,
    textColor: Color,
): AnnotatedString = buildAnnotatedString {
    appendInlineChildren(node, textColor, isBold = false, isItalic = false)
    // Post-processing: detect bare URLs in Text nodes that aren't already linked
    val text = toAnnotatedString()
    val existingUrls = text.getStringAnnotations("URL", 0, text.length)
    val urlMatches = URL_PATTERN.findAll(text.text)
    for (match in urlMatches) {
        val url = match.value.trimEnd('.', ',', ';', ':', '!')
        // Skip if this range is already inside an explicit link annotation
        val alreadyLinked = existingUrls.any { ann ->
            match.range.first >= ann.start && match.range.first < ann.end
        }
        if (!alreadyLinked) {
            addStyle(
                SpanStyle(color = LINK_COLOR, textDecoration = TextDecoration.Underline),
                match.range.first, match.range.last + 1,
            )
            addStringAnnotation("URL", url, match.range.first, match.range.last + 1)
        }
    }
}

private fun AnnotatedString.Builder.appendInlineChildren(
    node: Node,
    textColor: Color,
    isBold: Boolean,
    isItalic: Boolean,
) {
    var child = node.firstChild
    while (child != null) {
        when (child) {
            is org.commonmark.node.Text -> {
                val style = SpanStyle(
                    color = textColor,
                    fontWeight = if (isBold) FontWeight.Bold else null,
                    fontStyle = if (isItalic) FontStyle.Italic else null,
                )
                withStyle(style) { append(child.literal) }
            }
            is SoftLineBreak -> append(" ")
            is HardLineBreak -> append("\n")
            is Code -> {
                withStyle(SpanStyle(
                    color = INLINE_CODE_COLOR,
                    background = INLINE_CODE_BG,
                    fontFamily = CascadiaMono,
                )) { append(child.literal) }
            }
            is Emphasis -> {
                appendInlineChildren(child, textColor, isBold, isItalic = true)
            }
            is StrongEmphasis -> {
                appendInlineChildren(child, textColor, isBold = true, isItalic)
            }
            is Link -> {
                val linkUrl = (child as Link).destination
                val start = this.length
                appendInlineChildren(child, LINK_COLOR, isBold, isItalic)
                val end = this.length
                addStyle(
                    SpanStyle(textDecoration = TextDecoration.Underline),
                    start, end,
                )
                addStringAnnotation("URL", linkUrl, start, end)
            }
            else -> {
                // For any unhandled inline node, try to walk its children
                appendInlineChildren(child, textColor, isBold, isItalic)
            }
        }
        child = child.next
    }
}
```

- [ ] **Step 2: Verify the project builds**

Run: `cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug`

Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/MarkdownRenderer.kt
git commit -m "feat: add MarkdownRenderer composable with commonmark-java"
```

### Task 4: Integrate MarkdownRenderer into MessageBubble

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/MessageBubble.kt`

- [ ] **Step 1: Add expandedCardId and onToggleCard parameters to MessageBubble's Response rendering**

In `MessageBubble.kt`, replace the `MessageContent.Response` branch (lines 202-208):

```kotlin
                is MessageContent.Response -> {
                    LinkableText(
                        text = content.markdown,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
```

With:

```kotlin
                is MessageContent.Response -> {
                    MarkdownRenderer(
                        markdown = content.markdown,
                        textColor = MaterialTheme.colorScheme.onSurface,
                        expandedCardId = expandedCardId,
                        onToggleCard = onToggleCard,
                    )
                }
```

No new imports needed — `MarkdownRenderer` is in the same package.

- [ ] **Step 2: Verify the project builds**

Run: `cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug`

Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/MessageBubble.kt
git commit -m "feat: render Claude responses with markdown instead of plain text"
```

---

## Chunk 3: Image Input

### Task 5: Add photo picker and attachment state to ChatScreen

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`

- [ ] **Step 1: Add imports**

At the top of `ChatScreen.kt`, add these imports (skip any that already exist in the file):

```kotlin
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import java.io.File
```

Note: `Icons.Outlined.Image` requires the `material-icons-extended` dependency which is already in `build.gradle.kts`.

- [ ] **Step 2: Add attachment state variables**

Inside the `ChatScreen` composable function, near the existing `var chatInputText` state, add:

```kotlin
        // Image attachment state
        var attachmentPath by rememberSaveable { mutableStateOf<String?>(null) }
        var attachmentBitmap by remember { mutableStateOf<Bitmap?>(null) }

        // Reconstruct thumbnail from saved path on restore
        LaunchedEffect(attachmentPath) {
            attachmentBitmap = attachmentPath?.let { path ->
                try {
                    val opts = BitmapFactory.Options().apply { inSampleSize = 8 }
                    BitmapFactory.decodeFile(path, opts)
                } catch (_: Exception) { null }
            }
        }
```

- [ ] **Step 3: Add photo picker launcher**

After the attachment state, add the picker launcher. This needs access to `bootstrap.homeDir` for the destination path — find where `bootstrap` is accessed in ChatScreen and add nearby:

```kotlin
        val photoPickerLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.PickVisualMedia()
        ) { uri ->
            uri?.let {
                val attachDir = File(bootstrap.homeDir, "attachments").also { it.mkdirs() }
                val timestamp = System.currentTimeMillis()
                val destFile = File(attachDir, "$timestamp.png")
                try {
                    context.contentResolver.openInputStream(it)?.use { input ->
                        destFile.outputStream().use { output -> input.copyTo(output) }
                    }
                    attachmentPath = destFile.absolutePath
                } catch (_: Exception) {
                    // Silently fail — user can retry
                }
            }
        }
```

Note: `context` should already be available via `LocalContext.current` in the composable. If not, add `val context = LocalContext.current`.

- [ ] **Step 4: Verify build compiles (state + launcher only, no UI yet)**

Run: `cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug`

Expected: BUILD SUCCESSFUL (unused variables warnings are OK)

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt
git commit -m "feat: add photo picker launcher and attachment state"
```

### Task 6: Modify input bar with attachment icon and thumbnail preview

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`

- [ ] **Step 1: Add thumbnail preview row above input bar**

Find the `// Input row` comment (around line 426). Insert BEFORE the input Row:

```kotlin
                // Attachment thumbnail preview
                if (attachmentBitmap != null) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        attachmentBitmap?.let { bmp ->
                            Image(
                                bitmap = bmp.asImageBitmap(),
                                contentDescription = "Attached image",
                                modifier = Modifier
                                    .size(48.dp)
                                    .clip(RoundedCornerShape(6.dp)),
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Image attached", fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                        Spacer(modifier = Modifier.weight(1f))
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Remove attachment",
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                            modifier = Modifier
                                .size(20.dp)
                                .clickable {
                                    attachmentPath = null
                                    attachmentBitmap = null
                                },
                        )
                    }
                }
```

- [ ] **Step 2: Add image icon inside the text field's decorationBox**

Find the `decorationBox` lambda in the `BasicTextField` (around line 454). Replace:

```kotlin
                            decorationBox = { innerTextField ->
                                if (chatInputText.isEmpty()) {
                                    Text("Type a message...", fontSize = 14.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                                }
                                innerTextField()
                            },
```

With:

```kotlin
                            decorationBox = { innerTextField ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Box(modifier = Modifier.weight(1f)) {
                                        if (chatInputText.isEmpty()) {
                                            Text("Type a message...", fontSize = 14.sp,
                                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                                        }
                                        innerTextField()
                                    }
                                    Icon(
                                        Icons.Outlined.Image,
                                        contentDescription = "Attach image",
                                        tint = if (attachmentPath != null)
                                            Color(0xFFc96442)
                                        else
                                            Color(0xFF555555),
                                        modifier = Modifier
                                            .size(20.dp)
                                            .clickable {
                                                photoPickerLauncher.launch(
                                                    PickVisualMediaRequest(
                                                        ActivityResultContracts.PickVisualMedia.ImageOnly
                                                    )
                                                )
                                            },
                                    )
                                }
                            },
```

- [ ] **Step 3: Verify build**

Run: `cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug`

Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt
git commit -m "feat: add attachment icon in input bar and thumbnail preview"
```

### Task 7: Implement prompt injection for attached images

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`

- [ ] **Step 1: Modify the send action to include image path**

Find the send button's `clickable` handler (around line 470). Replace:

```kotlin
                            .clickable {
                                if (chatInputText.isNotBlank()) {
                                    chatState.addUserMessage(chatInputText)
                                    bridge.writeInput(chatInputText + "\r")
                                    chatInputText = ""
                                }
                            },
```

With:

```kotlin
                            .clickable {
                                if (chatInputText.isNotBlank() || attachmentPath != null) {
                                    val messageText = buildString {
                                        attachmentPath?.let { path ->
                                            appendLine("[Image attached: $path]")
                                            appendLine()
                                        }
                                        append(chatInputText)
                                    }.trim()
                                    val displayText = when {
                                        attachmentPath != null && chatInputText.isBlank() -> "[image]"
                                        attachmentPath != null -> "[image] $chatInputText"
                                        else -> chatInputText
                                    }
                                    chatState.addUserMessage(displayText)
                                    bridge.writeInput(messageText + "\r")
                                    chatInputText = ""
                                    attachmentPath = null
                                    attachmentBitmap = null
                                }
                            },
```

This sends the absolute path (e.g., `/data/data/com.destins.claudemobile/files/home/attachments/1234567890.png`) which Claude Code's Read tool can resolve. The chat bubble shows `[image]` prefix so the user knows an image was included. Attachment state clears after send.

- [ ] **Step 2: Verify build**

Run: `cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug`

Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt
git commit -m "feat: inject image path into prompt when sending with attachment"
```

---

## Implementation Notes

**Reviewer advisory items addressed:**
- h4-h6 headers: fall through to default 14sp in the `else` branch of the heading `when`
- Image format: copies as-is from content URI (preserves original format despite `.png` extension). For v1 this is acceptable; original MIME type preservation is a future optimization.
- Nested lists: supported — `RenderBlock` recurses into `ListItem` children, which can contain nested `BulletList`/`OrderedList` nodes
- Attachment cleanup: deferred to future version per spec
