package com.destins.claudemobile.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.config.defaultChips
import com.destins.claudemobile.parser.ParsedEvent
import com.destins.claudemobile.runtime.DirectShellBridge
import com.destins.claudemobile.runtime.PtyBridge
import kotlinx.coroutines.launch

private enum class ScreenMode { Chat, Terminal, Shell }

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(bridge: PtyBridge) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val chatState = remember { ChatState() }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var prefillText by remember { mutableStateOf("") }
    var chatInputText by remember { mutableStateOf("") }
    val onPrefillConsumed = { prefillText = "" }
    var screenMode by remember { mutableStateOf(ScreenMode.Chat) }
    var directShellBridge by remember { mutableStateOf<DirectShellBridge?>(null) }
    val haptic = LocalHapticFeedback.current
    var hasUnhandledInteractive by remember { mutableStateOf(false) }

    // Menu accumulator — collects numbered options arriving as separate text events
    val menuAccumulator = remember { mutableListOf<String>() }
    var menuFlushJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    val shownMenuHashes = remember { mutableSetOf<Int>() }
    val pendingMenuScan = remember { mutableStateOf(false) }

    // URL accumulator — joins URL fragments split across events
    val urlAccumulator = remember { StringBuilder() }
    var urlFlushJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }

    // Collect screen version to trigger terminal panel recomposition on PTY output
    val screenVersion by bridge.screenVersion.collectAsState()

    LaunchedEffect(bridge) {
        val eventBridge = bridge.getEventBridge()
        if (eventBridge != null) {
            eventBridge.events.collect { event ->
                android.util.Log.d("ChatEvents", "EVENT: ${event::class.simpleName} → ${event.toString().take(200)}")
                when (event) {
                    is ParsedEvent.ApprovalPrompt -> chatState.requestApproval(event.tool, event.summary)
                    is ParsedEvent.ToolStart -> chatState.addToolStart(event.tool, event.args)
                    is ParsedEvent.ToolEnd -> {
                        // Deferred: updating duration on matching ToolCall card
                    }
                    is ParsedEvent.DiffBlock -> chatState.addDiff(event.filename, event.hunks)
                    is ParsedEvent.CodeBlock -> chatState.addCode(event.language, event.code)
                    is ParsedEvent.Error -> chatState.addError(event.message, event.details)
                    is ParsedEvent.Progress -> chatState.addProgress(event.message)
                    is ParsedEvent.Text -> {
                        if (event.text.isNotBlank()) {
                            val text = event.text.trim()

                            // Filter out terminal noise that doesn't belong in chat.
                            // Count how many characters are "noisy" (block/drawing/symbols)
                            val noiseChars = "█▓░▄▀▌▐╌─━═┄┈╍…·╸╺╴╶●○◉◎•▒╌╍┅┉"
                            val alphaCount = text.count { it.isLetter() }
                            val noiseCount = text.count { it in noiseChars }
                            val isNoise =
                                // Pure noise/whitespace
                                text.all { it in noiseChars || it.isWhitespace() || it == '*' || it == '│' || it == '┃' } ||
                                // Mostly noise (less than 30% alphabetic)
                                (text.length > 3 && noiseCount > 0 && alphaCount.toFloat() / text.length < 0.3f) ||
                                // Very short non-words (single chars like "-", "+", decorations)
                                (text.length <= 2 && !text.all { it.isLetterOrDigit() }) ||
                                // Lines starting with line numbers + code (diff preview)
                                text.matches(Regex("""^\d+\s+(function|console|return|var|let|const|if|for)\b.*""")) ||
                                // Short code fragments like "3 }", "1 {", etc.
                                text.matches(Regex("""^\d+\s*[{}()\[\];]?\s*$""")) ||
                                // "Syntax highlighting available only in native build" (ink preview noise)
                                text.contains("Syntax highlighting available only in native") ||
                                // OAuth flow noise
                                text.contains("url below to sign") ||
                                text.contains("Opening browser") ||
                                (text == "in") ||
                                (text == "c to copy") ||
                                // Long alphanumeric-only strings (auth code echoes, hashes, tokens)
                                (text.length > 15 && !text.contains(' ') && text.all { it.isLetterOrDigit() || it in "-_#" })
                            if (isNoise) {
                                // Skip — don't add to chat
                            }
                            // URL accumulator — detect start of URL or continuation fragment
                            else if (text.contains("https://") && !text.contains(' ')) {
                                // Start of a URL — mark as collecting, read full URL from screen later
                                urlAccumulator.clear()
                                urlAccumulator.append("COLLECTING")
                                urlFlushJob?.cancel()
                                urlFlushJob = coroutineScope.launch {
                                    kotlinx.coroutines.delay(1000) // wait for all URL lines to render
                                    urlAccumulator.clear()
                                    val session = bridge.getSession()
                                    val screen = session?.emulator?.screen
                                    if (screen != null) {
                                        val transcript = screen.getTranscriptText()
                                        android.util.Log.d("URLScan", "Transcript last 500: ${transcript.takeLast(500)}")
                                        // getTranscriptText() wraps at column boundaries with newlines.
                                        // Remove newlines that aren't followed by a space to reconstruct URLs.
                                        val cleaned = transcript.replace(Regex("""\n(?=\S)"""), "")
                                        val urlMatch = Regex("""https://[^\s]+""").findAll(cleaned)
                                            .lastOrNull()
                                        android.util.Log.d("URLScan", "Found URL: ${urlMatch?.value?.take(200)}")
                                        if (urlMatch != null) {
                                            val fullUrl = urlMatch.value
                                            if (fullUrl.contains("oauth") || fullUrl.contains("claude") || fullUrl.contains("auth")) {
                                                chatState.addOAuth(fullUrl)
                                            } else {
                                                chatState.addClaudeText(fullUrl)
                                            }
                                        }
                                    }
                                }
                            } else if (urlAccumulator.isNotEmpty() && !text.contains(' ') && text.length > 5 &&
                                text.matches(Regex("""^[a-zA-Z0-9%&=+_./:?#-]+$"""))) {
                                // URL continuation fragment — suppress, the screen reader will get the full URL
                            }
                            // Detect numbered menu options
                            else if (Regex("""^.*\d+\.\s+\S""").containsMatchIn(text) && text.length < 100) {
                                menuAccumulator.add(text.replace(Regex("""^[❯>\s]*"""), "").trim())
                                menuFlushJob?.cancel()
                                menuFlushJob = coroutineScope.launch {
                                    kotlinx.coroutines.delay(300)
                                    if (menuAccumulator.size >= 2) {
                                        val options = menuAccumulator.toList()
                                        shownMenuHashes.add(options.hashCode())
                                        chatState.addMenu(options, options.joinToString("\n"))
                                    } else {
                                        menuAccumulator.forEach { chatState.addClaudeText(it) }
                                    }
                                    menuAccumulator.clear()
                                }
                            } else {
                                // Flush menu accumulator on real content
                                if (menuAccumulator.isNotEmpty() && !text.all { it in noiseChars || it.isWhitespace() }) {
                                    menuFlushJob?.cancel()
                                    if (menuAccumulator.size >= 2) {
                                        chatState.addMenu(menuAccumulator.toList(), menuAccumulator.joinToString("\n"))
                                    } else {
                                        menuAccumulator.forEach { chatState.addClaudeText(it) }
                                    }
                                    menuAccumulator.clear()
                                }
                                chatState.addClaudeText(text)
                            }
                        }
                    }
                    is ParsedEvent.InteractiveMenu -> {
                        // Try to parse menu options from raw text
                        val lines = event.raw.lines().filter { it.isNotBlank() }
                        val options = lines.map { it.trim().removePrefix("❯").removePrefix(">").trim() }
                        if (options.size >= 2) {
                            chatState.addMenu(options, event.raw)
                        } else {
                            chatState.addRawOutput(event.raw)
                            hasUnhandledInteractive = true
                        }
                    }
                    is ParsedEvent.Confirmation -> chatState.addConfirm(event.question)
                    is ParsedEvent.TextPrompt -> chatState.addClaudeText(event.prompt)
                    is ParsedEvent.OAuthRedirect -> {
                        chatState.addOAuth(event.url)
                    }
                }
            }
        } else {
            // Fallback: raw PTY output (parser not connected)
            android.util.Log.d("ChatEvents", "NO PARSER — using raw output fallback")
            bridge.outputFlow.collect { output ->
                if (output.isNotBlank()) {
                    android.util.Log.d("ChatEvents", "RAW: ${output.take(100)}")
                    chatState.addRawOutput(output)
                }
            }
        }
    }

    // Raw output URL watcher removed — auto-opening was truncating URLs.
    // OAuth URLs are now shown as tappable widgets in the chat.

    // Follow-up menu detector — polls transcript after menu selection
    // to find NEW menus that weren't in the previous scan.
    LaunchedEffect(pendingMenuScan.value) {
        if (!pendingMenuScan.value) return@LaunchedEffect
        // Poll a few times with delays to catch ink redraw
        repeat(5) {
            kotlinx.coroutines.delay(1000)
            val session = bridge.getSession() ?: return@LaunchedEffect
            val screen = session.emulator?.screen ?: return@LaunchedEffect
            val transcript = screen.getTranscriptText()

            val menuPattern = Regex("""(?:^|\n)\s*[❯>]?\s*(\d+\.\s+\S.+)""")
            val matches = menuPattern.findAll(transcript).map { it.groupValues[1].trim() }.toList()

            if (matches.size >= 2) {
                val hash = matches.hashCode()
                if (hash !in shownMenuHashes) {
                    shownMenuHashes.add(hash)
                    val hasActiveMenu = chatState.messages.any { it.content is MessageContent.Menu }
                    if (!hasActiveMenu) {
                        chatState.addMenu(matches, matches.joinToString("\n"))
                        pendingMenuScan.value = false
                        return@LaunchedEffect
                    }
                }
            }
        }
        pendingMenuScan.value = false
    }

    LaunchedEffect(chatState.messages.size) {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when (screenMode) {
        ScreenMode.Terminal -> {
            // ── Full-screen terminal mode ──────────────────────────────
            var terminalInput by remember { mutableStateOf("") }

            Column(modifier = Modifier.fillMaxSize()) {
                // Top bar — icon left, centered title, Claude icon right
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                ) {
                    // Chat toggle pill — left
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .height(34.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .clickable { screenMode = ScreenMode.Chat }
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.Chat,
                            contentDescription = "Switch to chat",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    // Centered title
                    Text(
                        "Terminal",
                        fontSize = 15.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    // Claude icon pill — right
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .size(34.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
                            contentDescription = "Claude",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                // Divider below top bar
                HorizontalDivider(color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder, thickness = 0.5.dp)

                // Terminal canvas — fills all available space
                TerminalPanel(
                    session = bridge.getSession(),
                    screenVersion = screenVersion,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

                // Divider above text input
                HorizontalDivider(color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder, thickness = 0.5.dp)

                // Text input row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    // Text field styled as a pill matching the key buttons
                    val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            ),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        BasicTextField(
                            value = terminalInput,
                            onValueChange = { terminalInput = it },
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 13.sp,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (terminalInput.isEmpty()) {
                                    Text(
                                        "Type here...",
                                        fontSize = 13.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                    )
                                }
                                innerTextField()
                            },
                        )
                    }

                    // Send button styled as a key pill
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            )
                            .clickable {
                                if (terminalInput.isNotBlank()) {
                                    bridge.writeInput(terminalInput + "\r")
                                    terminalInput = ""
                                }
                            },
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

                // Special keys row — below text input
                TerminalKeyboardRow(
                    onKeyPress = { seq -> bridge.writeInput(seq) },
                )
            }
        }

        ScreenMode.Shell -> {
            // ── Direct shell mode ─────────────────────────────────────
            val shell = directShellBridge ?: return@Box
            val shellScreenVersion by shell.screenVersion.collectAsState()
            var shellInput by remember { mutableStateOf("") }

            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder
                // Top bar — chat icon left, "Shell" title, terminal icon right
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                ) {
                    // Chat pill — left (back to chat)
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .height(34.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .clickable { screenMode = ScreenMode.Chat }
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.Chat,
                            contentDescription = "Switch to chat",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    // Centered title
                    Text(
                        "Shell",
                        fontSize = 15.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    // Terminal pill — right (switch to Claude terminal)
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .size(34.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.CircleShape)
                            .clickable { screenMode = ScreenMode.Terminal },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
                            contentDescription = "Claude terminal",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Terminal canvas — direct shell
                TerminalPanel(
                    session = shell.getSession(),
                    screenVersion = shellScreenVersion,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Text input row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            ),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        BasicTextField(
                            value = shellInput,
                            onValueChange = { shellInput = it },
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 13.sp,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (shellInput.isEmpty()) {
                                    Text(
                                        "$ ",
                                        fontSize = 13.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                    )
                                }
                                innerTextField()
                            },
                        )
                    }

                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            )
                            .clickable {
                                if (shellInput.isNotBlank()) {
                                    shell.writeInput(shellInput + "\r")
                                    shellInput = ""
                                }
                            },
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

                // Special keys row
                TerminalKeyboardRow(
                    onKeyPress = { seq -> shell.writeInput(seq) },
                )
            }
        }

        ScreenMode.Chat -> {
            // ── Chat mode — mirrors terminal page formatting ─────────
            Column(modifier = Modifier.fillMaxSize()) {
                val borderColor = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.surfaceBorder

                // Top bar — icon left, centered title, Claude icon right
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                ) {
                    // Terminal toggle pill — left: tap = Claude terminal, long-press = direct shell
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .height(34.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .combinedClickable(
                                onClick = { screenMode = ScreenMode.Terminal },
                                onLongClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    if (directShellBridge == null) {
                                        directShellBridge = bridge.createDirectShell()
                                    }
                                    screenMode = ScreenMode.Shell
                                },
                            )
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.Terminal,
                            contentDescription = "Switch to terminal",
                            tint = if (hasUnhandledInteractive)
                                MaterialTheme.colorScheme.primary
                            else
                                MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    // Centered title
                    Text(
                        "Chat",
                        fontSize = 15.sp,
                        color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    // Claude icon pill — right
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .size(34.dp)
                            .clip(androidx.compose.foundation.shape.CircleShape)
                            .background(MaterialTheme.colorScheme.surface)
                            .border(0.5.dp, borderColor.copy(alpha = 0.5f), androidx.compose.foundation.shape.CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot,
                            contentDescription = "Claude",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Chat messages
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(chatState.messages) { message ->
                        MessageBubble(
                            message = message,
                            expandedCardId = chatState.expandedCardId,
                            onToggleCard = { chatState.toggleCard(it) },
                            onApprove = { bridge.sendApproval(true); chatState.resolveApproval() },
                            onReject = { bridge.sendApproval(false); chatState.resolveApproval() },
                            onViewTerminal = { screenMode = ScreenMode.Terminal },
                            onMenuSelect = { index ->
                                val menuMsg = message.content
                                if (menuMsg is MessageContent.Menu) {
                                    val selected = menuMsg.options.getOrElse(index) { "" }
                                    // Track this menu's hash so scanner doesn't re-detect it
                                    shownMenuHashes.add(menuMsg.options.hashCode())
                                    chatState.resolveMenu(selected)
                                }
                                // Send arrow-down × index + enter with delays, then scan
                                coroutineScope.launch {
                                    repeat(index) {
                                        bridge.writeInput("\u001b[B")
                                        kotlinx.coroutines.delay(50)
                                    }
                                    kotlinx.coroutines.delay(100)
                                    bridge.writeInput("\r")
                                    // Trigger follow-up menu scan
                                    pendingMenuScan.value = true
                                }
                            },
                            onConfirmYes = { bridge.writeInput("y\r") },
                            onConfirmNo = { bridge.writeInput("n\r") },
                        )
                    }
                }

                HorizontalDivider(color = borderColor, thickness = 0.5.dp)

                // Input row — above chips, matching terminal layout
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            ),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        BasicTextField(
                            value = chatInputText,
                            onValueChange = { chatInputText = it },
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(
                                fontSize = 14.sp,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp),
                            decorationBox = { innerTextField ->
                                if (chatInputText.isEmpty()) {
                                    Text(
                                        "Type a message...",
                                        fontSize = 14.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                                    )
                                }
                                innerTextField()
                            },
                        )
                    }

                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                            .border(
                                0.5.dp,
                                borderColor.copy(alpha = 0.5f),
                                androidx.compose.foundation.shape.RoundedCornerShape(6.dp)
                            )
                            .clickable {
                                if (chatInputText.isNotBlank()) {
                                    chatState.addUserMessage(chatInputText)
                                    bridge.writeInput(chatInputText + "\r")
                                    chatInputText = ""
                                }
                            },
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

                // Quick chips — below text input, matching terminal pills position
                if (!chatState.isWaitingForApproval) {
                    QuickChips(
                        chips = defaultChips,
                        onChipTap = { chip ->
                            if (chip.needsCompletion) {
                                chatInputText = chip.prompt
                            } else {
                                chatState.addUserMessage(chip.prompt)
                                bridge.writeInput(chip.prompt + "\r")
                            }
                        }
                    )
                }
            }
        }

        } // when
    }
}
