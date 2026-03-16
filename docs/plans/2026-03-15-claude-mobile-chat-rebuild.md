# Chat View Rebuild Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile PTY-parsing chat pipeline with a hooks-based architecture that receives structured JSON events directly from Claude Code.

**Architecture:** Claude Code hooks relay structured JSON (tool calls, responses, notifications) over a Unix socket to EventBridge, which routes events to ChatState for rendering as Compose cards and bubbles. The terminal view is unchanged. The Node.js parser sidecar and all heuristic filtering code are deleted.

**Tech Stack:** Kotlin/Jetpack Compose, Node.js (hook relay), Claude Code hooks API, Unix sockets (Android LocalSocket)

**Spec:** `docs/specs/2026-03-15-claude-mobile-chat-rebuild-design.md`

---

## Chunk 1: Hook Infrastructure

### Task 1: Create hook-relay.js

**Files:**
- Create: `app/src/main/assets/hook-relay.js`

- [ ] **Step 1: Write hook-relay.js**

```javascript
const net = require('net');
const fs = require('fs');
const socket = process.env.CLAUDE_MOBILE_SOCKET;
if (!socket) process.exit(0);
const input = fs.readFileSync(0, 'utf8');
try {
  const conn = net.connect(socket);
  conn.on('error', () => process.exit(0));
  conn.end(input + '\n');
} catch (e) {
  process.exit(0);
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/assets/hook-relay.js
git commit -m "feat: add hook-relay.js for forwarding Claude Code hook events to app socket"
```

### Task 2: Add hook installation to Bootstrap.kt

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt`

- [ ] **Step 1: Add installHooks() method to Bootstrap**

Add after the `setupHome()` method. This installs `hook-relay.js` and writes hook configuration into Claude Code's settings.json on the device:

```kotlin
fun installHooks() {
    val mobileDir = File(homeDir, ".claude-mobile")
    mobileDir.mkdirs()

    // Deploy hook-relay.js from assets
    val relayFile = File(mobileDir, "hook-relay.js")
    // Always redeploy — ensures latest version after APK update
    context.assets.open("hook-relay.js").use { input ->
        relayFile.outputStream().use { output -> input.copyTo(output) }
    }

    // Write hook configuration into Claude Code's settings
    val claudeDir = File(homeDir, ".claude")
    claudeDir.mkdirs()
    val settingsFile = File(claudeDir, "settings.json")

    val nodePath = File(usrDir, "bin/node").absolutePath
    val relayPath = relayFile.absolutePath
    val hookCommand = "node $relayPath"

    // Build hook entries for all events we care about
    val hookEvents = listOf(
        "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "Notification"
    )

    // Read existing settings and merge (additive — don't overwrite user hooks)
    val existingJson = if (settingsFile.exists()) {
        try { org.json.JSONObject(settingsFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
    } else {
        org.json.JSONObject()
    }

    val hooksObj = existingJson.optJSONObject("hooks") ?: org.json.JSONObject()

    for (event in hookEvents) {
        val eventArray = hooksObj.optJSONArray(event) ?: org.json.JSONArray()

        // Check if our hook is already registered (avoid duplicates)
        var alreadyRegistered = false
        for (i in 0 until eventArray.length()) {
            val entry = eventArray.optJSONObject(i)
            val hooks = entry?.optJSONArray("hooks")
            if (hooks != null) {
                for (j in 0 until hooks.length()) {
                    val h = hooks.optJSONObject(j)
                    if (h?.optString("command")?.contains("hook-relay.js") == true) {
                        alreadyRegistered = true
                        break
                    }
                }
            }
            if (alreadyRegistered) break
        }

        if (!alreadyRegistered) {
            val hookEntry = org.json.JSONObject()
            hookEntry.put("matcher", ".*")
            val hooksList = org.json.JSONArray()
            val hookDef = org.json.JSONObject()
            hookDef.put("type", "command")
            hookDef.put("command", hookCommand)
            hooksList.put(hookDef)
            hookEntry.put("hooks", hooksList)
            eventArray.put(hookEntry)
        }

        hooksObj.put(event, eventArray)
    }

    existingJson.put("hooks", hooksObj)
    settingsFile.writeText(existingJson.toString(2))
}
```

- [ ] **Step 2: Call installHooks() from setup()**

In `Bootstrap.setup()`, add a call after `installPackages` / `installClaudeCode`:

```kotlin
// After installClaudeCode(onProgress):
installHooks()
```

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt
git commit -m "feat: bootstrap installs hook-relay.js and writes Claude Code hook config"
```

### Task 3: Create HookEvent sealed class

**Files:**
- Create: `app/src/main/kotlin/com/destins/claudemobile/parser/HookEvent.kt`

- [ ] **Step 1: Write HookEvent.kt**

Replaces ParsedEvent.kt with a sealed class mapping Claude Code hook payloads:

```kotlin
package com.destins.claudemobile.parser

import org.json.JSONObject

sealed class HookEvent {
    /** Common fields available on all hook events */
    abstract val sessionId: String
    abstract val hookEventName: String

    data class PreToolUse(
        override val sessionId: String,
        override val hookEventName: String,
        val toolName: String,
        val toolInput: JSONObject,
        val toolUseId: String,
    ) : HookEvent()

    data class PostToolUse(
        override val sessionId: String,
        override val hookEventName: String,
        val toolName: String,
        val toolInput: JSONObject,
        val toolResponse: JSONObject,
        val toolUseId: String,
    ) : HookEvent()

    data class PostToolUseFailure(
        override val sessionId: String,
        override val hookEventName: String,
        val toolName: String,
        val toolInput: JSONObject,
        val toolResponse: JSONObject,
        val toolUseId: String,
    ) : HookEvent()

    data class Stop(
        override val sessionId: String,
        override val hookEventName: String,
        val lastAssistantMessage: String,
    ) : HookEvent()

    data class Notification(
        override val sessionId: String,
        override val hookEventName: String,
        val message: String,
        val title: String?,
        val notificationType: String?,
    ) : HookEvent()

    companion object {
        fun fromJson(json: String): HookEvent? {
            return try {
                val obj = JSONObject(json)
                val sessionId = obj.optString("session_id", "")
                val eventName = obj.optString("hook_event_name", "")

                when (eventName) {
                    "PreToolUse" -> PreToolUse(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        toolName = obj.optString("tool_name", ""),
                        toolInput = obj.optJSONObject("tool_input") ?: JSONObject(),
                        toolUseId = obj.optString("tool_use_id", ""),
                    )
                    "PostToolUse" -> PostToolUse(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        toolName = obj.optString("tool_name", ""),
                        toolInput = obj.optJSONObject("tool_input") ?: JSONObject(),
                        toolResponse = obj.optJSONObject("tool_response") ?: JSONObject(),
                        toolUseId = obj.optString("tool_use_id", ""),
                    )
                    "PostToolUseFailure" -> PostToolUseFailure(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        toolName = obj.optString("tool_name", ""),
                        toolInput = obj.optJSONObject("tool_input") ?: JSONObject(),
                        toolResponse = obj.optJSONObject("tool_response") ?: JSONObject(),
                        toolUseId = obj.optString("tool_use_id", ""),
                    )
                    "Stop" -> Stop(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        lastAssistantMessage = obj.optString("last_assistant_message", ""),
                    )
                    "Notification" -> Notification(
                        sessionId = sessionId,
                        hookEventName = eventName,
                        message = obj.optString("message", ""),
                        title = if (obj.has("title")) obj.getString("title") else null,
                        notificationType = if (obj.has("notification_type")) obj.getString("notification_type") else null,
                    )
                    else -> null
                }
            } catch (e: Exception) {
                null
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/parser/HookEvent.kt
git commit -m "feat: add HookEvent sealed class for deserializing Claude Code hook payloads"
```

### Task 4: Rewrite EventBridge for hook payloads

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/parser/EventBridge.kt`

- [ ] **Step 1: Rewrite EventBridge**

Change EventBridge from a client that connects to the parser sidecar's socket, to a **server** that listens for incoming connections from hook-relay.js. The socket server accepts connections, reads one JSON line per connection, and emits HookEvent:

```kotlin
package com.destins.claudemobile.parser

import android.net.LocalServerSocket
import android.net.LocalSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import java.io.BufferedReader
import java.io.InputStreamReader

class EventBridge(private val socketPath: String) {
    private val _events = MutableSharedFlow<HookEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<HookEvent> = _events

    private var serverSocket: LocalServerSocket? = null
    private var listenJob: Job? = null

    fun startServer(scope: CoroutineScope) {
        // Remove stale socket file if it exists
        try { java.io.File(socketPath).delete() } catch (_: Exception) {}

        listenJob = scope.launch(Dispatchers.IO) {
            try {
                serverSocket = LocalServerSocket(socketPath)
                while (isActive) {
                    val client: LocalSocket = serverSocket!!.accept()
                    launch {
                        handleClient(client)
                    }
                }
            } catch (e: Exception) {
                if (isActive) {
                    android.util.Log.e("EventBridge", "Server error", e)
                }
            }
        }
    }

    private suspend fun handleClient(client: LocalSocket) {
        try {
            client.use { socket ->
                val reader = BufferedReader(InputStreamReader(socket.inputStream))
                val line = reader.readLine() ?: return
                HookEvent.fromJson(line)?.let { _events.emit(it) }
            }
        } catch (e: Exception) {
            android.util.Log.w("EventBridge", "Client error", e)
        }
    }

    fun stop() {
        listenJob?.cancel()
        try { serverSocket?.close() } catch (_: Exception) {}
        try { java.io.File(socketPath).delete() } catch (_: Exception) {}
        serverSocket = null
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/parser/EventBridge.kt
git commit -m "refactor: rewrite EventBridge as socket server accepting hook-relay.js connections"
```

### Task 5: Rewrite PtyBridge — remove parser, add activity signal

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/PtyBridge.kt`

- [ ] **Step 1: Strip parser sidecar and accumulator code from PtyBridge**

Remove: `parserProcess`, `accumulatorBuffer`, `accumulatorJob`, `accumulatorScope`, `socketConnected`, `lastOutputTime`, `approvalPattern`, `onPtyOutput()`, `flushAccumulator()`, `onSocketConnected()`, `startParser()`, `sendPtyOutput()`.

Add: `lastPtyOutputTime` StateFlow for activity indicator, `CLAUDE_MOBILE_SOCKET` env var in launch, EventBridge started as a server.

Replace the full PtyBridge class with:

```kotlin
package com.destins.claudemobile.runtime

import android.content.Context
import com.destins.claudemobile.parser.EventBridge
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
) {
    private var session: TerminalSession? = null
    private var eventBridge: EventBridge? = null
    val socketPath: String get() = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock"

    private val _outputFlow = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 1000)
    val outputFlow: SharedFlow<String> = _outputFlow

    private val _screenVersion = MutableStateFlow(0)
    val screenVersion: StateFlow<Int> = _screenVersion

    /** Timestamp of last PTY output — used by activity indicator */
    private val _lastPtyOutputTime = MutableStateFlow(0L)
    val lastPtyOutputTime: StateFlow<Long> = _lastPtyOutputTime

    private val _rawBuffer = StringBuilder()
    val rawBuffer: String get() = _rawBuffer.toString()
    private var lastTranscriptLength = 0

    val isRunning: Boolean get() = session?.isRunning == true

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) {
            _screenVersion.value++
            _lastPtyOutputTime.value = System.currentTimeMillis()

            val transcript = changedSession.getEmulator()?.getScreen()?.getTranscriptText() ?: return
            if (transcript.length > lastTranscriptLength) {
                val delta = transcript.substring(lastTranscriptLength)
                lastTranscriptLength = transcript.length
                _rawBuffer.append(delta)
                _outputFlow.tryEmit(delta)
            } else if (transcript.length < lastTranscriptLength) {
                lastTranscriptLength = transcript.length
            }
        }

        override fun onTitleChanged(changedSession: TerminalSession) {}
        override fun onSessionFinished(finishedSession: TerminalSession) {}
        override fun onCopyTextToClipboard(session: TerminalSession, text: String) {}
        override fun onPasteTextFromClipboard(session: TerminalSession) {}
        override fun onBell(session: TerminalSession) {}
        override fun onColorsChanged(session: TerminalSession) {}
        override fun onTerminalCursorStateChange(state: Boolean) {}
        override fun getTerminalCursorStyle(): Int? = null
        override fun logError(tag: String?, message: String?) {}
        override fun logWarn(tag: String?, message: String?) {}
        override fun logInfo(tag: String?, message: String?) {}
        override fun logDebug(tag: String?, message: String?) {}
        override fun logVerbose(tag: String?, message: String?) {}
        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
        override fun logStackTrace(tag: String?, e: Exception?) {}
    }

    fun startEventBridge(scope: CoroutineScope) {
        val bridge = EventBridge(socketPath)
        bridge.startServer(scope)
        eventBridge = bridge
    }

    fun start() {
        val env = bootstrap.buildRuntimeEnv().toMutableMap()
        apiKey?.let { env["ANTHROPIC_API_KEY"] = it }

        // Set socket path for hook-relay.js
        env["CLAUDE_MOBILE_SOCKET"] = socketPath

        val claudePath = File(bootstrap.usrDir, "lib/node_modules/@anthropic-ai/claude-code/cli.js")
        val nodePath = File(bootstrap.usrDir, "bin/node")

        val wrapperDir = File(bootstrap.homeDir, ".claude-mobile")
        wrapperDir.mkdirs()
        val wrapperPath = File(wrapperDir, "claude-wrapper.js")
        wrapperPath.writeText(WRAPPER_JS)

        val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${wrapperPath.absolutePath} ${claudePath.absolutePath}"
        File(bootstrap.homeDir, "tmp").mkdirs()
        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()

        session = TerminalSession(
            "/system/bin/sh",
            bootstrap.homeDir.absolutePath,
            arrayOf("sh", "-c", launchCmd),
            envArray,
            200,
            sessionClient
        )
        session?.initializeEmulator(60, 40)
    }

    fun writeInput(text: String) {
        android.util.Log.d("PtyBridge", "writeInput: ${text.map { if (it.code < 32) "\\x${it.code.toString(16)}" else it.toString() }.joinToString("")}")
        session?.write(text)
    }

    fun sendApproval(accepted: Boolean) {
        writeInput(if (accepted) "y\r" else "n\r")
    }

    fun sendBtw(message: String) {
        writeInput("/btw $message\r")
    }

    fun getSession(): TerminalSession? = session

    fun getEventBridge(): EventBridge? = eventBridge

    fun stop() {
        eventBridge?.stop()
        session?.finishIfRunning()
        session = null
    }
}
```

**IMPORTANT:** The existing `PtyBridge.kt` contains a `WRAPPER_JS` string constant (the Node.js wrapper script). This constant must be preserved verbatim at the bottom of the file — it is used by `start()` to deploy `claude-wrapper.js`. Copy it from the current file before replacing the class.

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/PtyBridge.kt
git commit -m "refactor: strip parser/accumulator from PtyBridge, add activity signal and socket env var"
```

### Task 6: Update ChatScreen to call startEventBridge

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt` (just the bridge startup — full rewrite in Chunk 2)

The existing code calls `bridge.startParser(scope, context)` somewhere during initialization. This call site needs to change to `bridge.startEventBridge(scope)`. Find the caller (likely in `SetupScreen.kt` or `MainActivity.kt`) and update it.

- [ ] **Step 1: Find and update the parser startup call**

Search for `startParser` in the codebase and replace with `startEventBridge`:

```kotlin
// Old:
bridge.startParser(scope, context)

// New:
bridge.startEventBridge(scope)
```

The `context` parameter is no longer needed since we don't copy parser assets at runtime anymore (hook-relay.js is installed by Bootstrap).

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: replace startParser call with startEventBridge"
```

### Task 7: Delete parser sidecar files

**Files:**
- Delete: `parser/parser.js`
- Delete: `parser/patterns.js`
- Delete: `parser/PATTERNS.md`
- Delete: `parser/package.json`
- Delete: `parser/capture-output.sh`
- Delete: `app/src/main/kotlin/com/destins/claudemobile/parser/ParsedEvent.kt`
- Delete: `app/src/main/assets/parser/` (if the parser files are also stored as Android assets)

- [ ] **Step 1: Delete files**

```bash
rm -f parser/parser.js parser/patterns.js parser/PATTERNS.md parser/package.json parser/capture-output.sh
rm -f app/src/main/kotlin/com/destins/claudemobile/parser/ParsedEvent.kt
rm -rf app/src/main/assets/parser/
```

- [ ] **Step 2: Fix any remaining references to ParsedEvent**

Search for `ParsedEvent` imports across the codebase and remove them. Files that reference ParsedEvent will be rewritten in Chunk 2.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: delete parser sidecar (parser.js, patterns.js, ParsedEvent.kt)"
```

---

## Chunk 2: Chat View Rebuild

### Task 8: Rewrite ChatState.kt

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatState.kt`

- [ ] **Step 1: Replace ChatState with new message model**

```kotlin
package com.destins.claudemobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

enum class MessageRole { USER, CLAUDE, SYSTEM }

sealed class MessageContent {
    data class Text(val text: String) : MessageContent()
    data class Response(val markdown: String) : MessageContent()
    data class ToolRunning(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
    ) : MessageContent()
    data class ToolAwaitingApproval(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
    ) : MessageContent()
    data class ToolComplete(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
        val result: JSONObject,
    ) : MessageContent()
    data class ToolFailed(
        val cardId: String,
        val toolUseId: String,
        val tool: String,
        val args: String,
        val error: JSONObject,
    ) : MessageContent()
    data class SystemNotice(val text: String) : MessageContent()
}

data class ChatMessage(
    val role: MessageRole,
    val content: MessageContent,
    val isBtw: Boolean = false,
    val timestamp: Long = System.currentTimeMillis(),
)

class ChatState {
    val messages = mutableStateListOf<ChatMessage>()
    var expandedCardId: String? by mutableStateOf(null)

    /** Current tool being worked on — for activity indicator text */
    var activeToolName: String? by mutableStateOf(null)

    private var nextCardId = 0
    private fun nextId(): String = "card-${nextCardId++}"

    fun toggleCard(cardId: String) {
        expandedCardId = if (expandedCardId == cardId) null else cardId
    }

    fun addUserMessage(text: String, isBtw: Boolean = false) {
        messages.add(ChatMessage(MessageRole.USER, MessageContent.Text(text), isBtw = isBtw))
    }

    fun addResponse(markdown: String) {
        if (markdown.isNotBlank()) {
            messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Response(markdown)))
        }
        activeToolName = null
    }

    fun addToolRunning(toolUseId: String, tool: String, args: String) {
        val id = nextId()
        activeToolName = tool
        messages.add(ChatMessage(
            MessageRole.CLAUDE,
            MessageContent.ToolRunning(id, toolUseId, tool, args),
        ))
    }

    fun updateToolToApproval(toolUseId: String) {
        val idx = messages.indexOfLast {
            val c = it.content
            c is MessageContent.ToolRunning && c.toolUseId == toolUseId
        }
        if (idx >= 0) {
            val running = messages[idx].content as MessageContent.ToolRunning
            messages[idx] = messages[idx].copy(
                content = MessageContent.ToolAwaitingApproval(
                    cardId = running.cardId,
                    toolUseId = running.toolUseId,
                    tool = running.tool,
                    args = running.args,
                )
            )
        }
    }

    fun updateToolToComplete(toolUseId: String, result: JSONObject) {
        val idx = messages.indexOfLast {
            val c = it.content
            (c is MessageContent.ToolRunning && c.toolUseId == toolUseId) ||
            (c is MessageContent.ToolAwaitingApproval && c.toolUseId == toolUseId)
        }
        if (idx >= 0) {
            val existing = messages[idx].content
            val (cardId, tool, args) = when (existing) {
                is MessageContent.ToolRunning -> Triple(existing.cardId, existing.tool, existing.args)
                is MessageContent.ToolAwaitingApproval -> Triple(existing.cardId, existing.tool, existing.args)
                else -> return
            }
            messages[idx] = messages[idx].copy(
                content = MessageContent.ToolComplete(cardId, toolUseId, tool, args, result),
            )
            activeToolName = null
        }
    }

    fun updateToolToFailed(toolUseId: String, error: JSONObject) {
        val idx = messages.indexOfLast {
            val c = it.content
            (c is MessageContent.ToolRunning && c.toolUseId == toolUseId) ||
            (c is MessageContent.ToolAwaitingApproval && c.toolUseId == toolUseId)
        }
        if (idx >= 0) {
            val existing = messages[idx].content
            val (cardId, tool, args) = when (existing) {
                is MessageContent.ToolRunning -> Triple(existing.cardId, existing.tool, existing.args)
                is MessageContent.ToolAwaitingApproval -> Triple(existing.cardId, existing.tool, existing.args)
                else -> return
            }
            messages[idx] = messages[idx].copy(
                content = MessageContent.ToolFailed(cardId, toolUseId, tool, args, error),
            )
            activeToolName = null
        }
    }

    fun addSystemNotice(text: String) {
        messages.add(ChatMessage(MessageRole.SYSTEM, MessageContent.SystemNotice(text)))
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatState.kt
git commit -m "refactor: rewrite ChatState with hook-based message model (7 variants, no heuristic state)"
```

### Task 9: Rewrite ChatScreen.kt

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`

- [ ] **Step 1: Rewrite ChatScreen with hook event routing**

Replace the entire ChatScreen composable. Remove all accumulator state, noise filtering, menu detection, URL reconstruction, and follow-up polling. The new version routes HookEvent to ChatState:

```kotlin
package com.destins.claudemobile.ui

import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.config.defaultChips
import com.destins.claudemobile.parser.HookEvent
import com.destins.claudemobile.runtime.PtyBridge
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(bridge: PtyBridge) {
    val chatState = remember { ChatState() }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var chatInputText by remember { mutableStateOf("") }
    var isTerminalMode by remember { mutableStateOf(false) }

    val screenVersion by bridge.screenVersion.collectAsState()
    val lastPtyOutput by bridge.lastPtyOutputTime.collectAsState()

    // Hook event collector
    LaunchedEffect(bridge) {
        val eventBridge = bridge.getEventBridge() ?: return@LaunchedEffect
        eventBridge.events.collect { event ->
            android.util.Log.d("ChatEvents", "HOOK: ${event::class.simpleName}")
            when (event) {
                is HookEvent.PreToolUse -> {
                    val argsSummary = event.toolInput.optString("command",
                        event.toolInput.optString("file_path",
                            event.toolInput.optString("pattern",
                                event.toolInput.toString().take(80))))
                    chatState.addToolRunning(event.toolUseId, event.toolName, argsSummary)
                }
                is HookEvent.PostToolUse -> {
                    chatState.updateToolToComplete(event.toolUseId, event.toolResponse)
                }
                is HookEvent.PostToolUseFailure -> {
                    chatState.updateToolToFailed(event.toolUseId, event.toolResponse)
                }
                is HookEvent.Stop -> {
                    chatState.addResponse(event.lastAssistantMessage)
                }
                is HookEvent.Notification -> {
                    if (event.notificationType == "permission_prompt") {
                        // Find the most recent running tool and transition to approval
                        val lastRunning = chatState.messages.lastOrNull {
                            it.content is MessageContent.ToolRunning
                        }
                        val toolUseId = (lastRunning?.content as? MessageContent.ToolRunning)?.toolUseId
                        if (toolUseId != null) {
                            chatState.updateToolToApproval(toolUseId)
                        }
                    } else {
                        chatState.addSystemNotice(event.message)
                    }
                }
            }
        }
    }

    // Fallback approval detection: PTY silence heuristic
    LaunchedEffect(chatState.messages.size) {
        val lastMsg = chatState.messages.lastOrNull()
        val running = lastMsg?.content as? MessageContent.ToolRunning ?: return@LaunchedEffect
        delay(2000)
        // Check if still in running state and PTY is quiet
        val stillRunning = chatState.messages.lastOrNull {
            val c = it.content
            c is MessageContent.ToolRunning && c.toolUseId == running.toolUseId
        }
        if (stillRunning != null) {
            val now = System.currentTimeMillis()
            val lastOutput = bridge.lastPtyOutputTime.value
            if (now - lastOutput > 2000) {
                chatState.updateToolToApproval(running.toolUseId)
            }
        }
    }

    // Auto-scroll on new messages
    LaunchedEffect(chatState.messages.size) {
        if (chatState.messages.isNotEmpty()) {
            listState.animateScrollToItem(chatState.messages.size - 1)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        if (isTerminalMode) {
            // Terminal mode — completely unchanged from Phase 2
            TerminalModeContent(bridge, screenVersion, onSwitchToChat = { isTerminalMode = false })
        } else {
            // Chat mode
            ChatModeContent(
                bridge = bridge,
                chatState = chatState,
                listState = listState,
                chatInputText = chatInputText,
                onInputChange = { chatInputText = it },
                onSend = {
                    if (chatInputText.isNotBlank()) {
                        chatState.addUserMessage(chatInputText)
                        bridge.writeInput(chatInputText + "\r")
                        chatInputText = ""
                    }
                },
                onSwitchToTerminal = { isTerminalMode = true },
                lastPtyOutput = lastPtyOutput,
                coroutineScope = coroutineScope,
            )
        }
    }
}
```

Add `TerminalModeContent` and `ChatModeContent` as separate composable functions in the same file:

```kotlin
@Composable
private fun TerminalModeContent(
    bridge: PtyBridge,
    screenVersion: Int,
    onSwitchToChat: () -> Unit,
) {
    // Identical to the existing terminal Column in ChatScreen.
    // Moves unchanged — terminal toggle calls onSwitchToChat.
    var terminalInput by remember { mutableStateOf("") }
    val borderColor = ClaudeMobileTheme.extended.surfaceBorder

    Column(modifier = Modifier.fillMaxSize()) {
        // Top bar
        Box(
            modifier = Modifier.fillMaxWidth()
                .background(MaterialTheme.colorScheme.background)
                .padding(horizontal = 6.dp, vertical = 5.dp),
        ) {
            Box(
                modifier = Modifier.align(Alignment.CenterStart).height(34.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                    .clickable { onSwitchToChat() }
                    .padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(com.destins.claudemobile.ui.theme.AppIcons.Chat, "Switch to chat",
                    tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(18.dp))
            }
            Text("Terminal", fontSize = 15.sp,
                color = ClaudeMobileTheme.extended.textSecondary,
                modifier = Modifier.align(Alignment.Center))
            Box(
                modifier = Modifier.align(Alignment.CenterEnd).size(34.dp)
                    .clip(CircleShape).background(MaterialTheme.colorScheme.surface)
                    .border(0.5.dp, borderColor.copy(alpha = 0.5f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot, "Claude",
                    tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            }
        }
        HorizontalDivider(color = borderColor, thickness = 0.5.dp)
        TerminalPanel(session = bridge.getSession(), screenVersion = screenVersion,
            modifier = Modifier.weight(1f).fillMaxWidth())
        HorizontalDivider(color = borderColor, thickness = 0.5.dp)
        // Terminal input row + send button
        Row(modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 6.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(modifier = Modifier.weight(1f).height(42.dp).clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp)),
                contentAlignment = Alignment.CenterStart) {
                BasicTextField(value = terminalInput, onValueChange = { terminalInput = it },
                    singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(
                        fontSize = 13.sp, fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                        color = MaterialTheme.colorScheme.onSurface),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                    decorationBox = { inner ->
                        if (terminalInput.isEmpty()) Text("Type here...", fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                        inner()
                    })
            }
            Box(modifier = Modifier.size(42.dp).clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                .clickable { if (terminalInput.isNotBlank()) { bridge.writeInput(terminalInput + "\r"); terminalInput = "" } },
                contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Filled.Send, "Send",
                    tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
            }
        }
        TerminalKeyboardRow(onKeyPress = { seq -> bridge.writeInput(seq) })
    }
}

@Composable
private fun ChatModeContent(
    bridge: PtyBridge,
    chatState: ChatState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    chatInputText: String,
    onInputChange: (String) -> Unit,
    onSend: () -> Unit,
    onSwitchToTerminal: () -> Unit,
    lastPtyOutput: Long,
    coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
    val borderColor = ClaudeMobileTheme.extended.surfaceBorder
    val screenVersion by bridge.screenVersion.collectAsState()

    Column(modifier = Modifier.fillMaxSize()) {
        // Top bar
        Box(modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 6.dp, vertical = 5.dp)) {
            Box(modifier = Modifier.align(Alignment.CenterStart).height(34.dp)
                .clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.surface)
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                .clickable { onSwitchToTerminal() }.padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center) {
                Icon(com.destins.claudemobile.ui.theme.AppIcons.Terminal, "Switch to terminal",
                    tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(18.dp))
            }
            Text("Chat", fontSize = 15.sp, color = ClaudeMobileTheme.extended.textSecondary,
                modifier = Modifier.align(Alignment.Center))
            Box(modifier = Modifier.align(Alignment.CenterEnd).size(34.dp)
                .clip(CircleShape).background(MaterialTheme.colorScheme.surface)
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), CircleShape),
                contentAlignment = Alignment.Center) {
                Icon(com.destins.claudemobile.ui.theme.AppIcons.ClaudeMascot, "Claude",
                    tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            }
        }
        HorizontalDivider(color = borderColor, thickness = 0.5.dp)

        // Messages + activity indicator
        LazyColumn(state = listState, modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(vertical = 8.dp)) {
            items(chatState.messages, key = { it.timestamp }) { message ->
                MessageBubble(
                    message = message,
                    expandedCardId = chatState.expandedCardId,
                    onToggleCard = { chatState.toggleCard(it) },
                    onAcceptApproval = { bridge.sendApproval(true) },
                    onRejectApproval = { bridge.sendApproval(false) },
                    session = bridge.getSession(),
                    screenVersion = screenVersion,
                )
            }
            // Activity indicator as trailing item
            item {
                var now by remember { mutableStateOf(System.currentTimeMillis()) }
                LaunchedEffect(Unit) { while (true) { delay(500); now = System.currentTimeMillis() } }
                val isActive = (now - lastPtyOutput) < 2000 || chatState.activeToolName != null
                ActivityIndicator(isActive = isActive, toolName = chatState.activeToolName)
            }
        }

        HorizontalDivider(color = borderColor, thickness = 0.5.dp)

        // Input row
        Row(modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 6.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(modifier = Modifier.weight(1f).height(42.dp).clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp)),
                contentAlignment = Alignment.CenterStart) {
                BasicTextField(value = chatInputText, onValueChange = onInputChange,
                    singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(
                        fontSize = 14.sp, fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                        color = MaterialTheme.colorScheme.onSurface),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                    decorationBox = { inner ->
                        if (chatInputText.isEmpty()) Text("Type a message...", fontSize = 14.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                        inner()
                    })
            }
            Box(modifier = Modifier.size(42.dp).clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                .clickable { onSend() },
                contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Filled.Send, "Send",
                    tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
            }
        }
        // Quick chips
        QuickChips(chips = defaultChips, onChipTap = { chip ->
            if (chip.needsCompletion) { onInputChange(chip.prompt) }
            else { chatState.addUserMessage(chip.prompt); bridge.writeInput(chip.prompt + "\r") }
        })
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt
git commit -m "refactor: rewrite ChatScreen with hook event routing, remove all heuristic parsing"
```

### Task 10: Add activity indicator composable

**Files:**
- Create: `app/src/main/kotlin/com/destins/claudemobile/ui/ActivityIndicator.kt`

- [ ] **Step 1: Write ActivityIndicator**

```kotlin
package com.destins.claudemobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme
import kotlinx.coroutines.delay

@Composable
fun ActivityIndicator(
    isActive: Boolean,
    toolName: String?,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = isActive,
        enter = fadeIn(),
        exit = fadeOut(),
        modifier = modifier,
    ) {
        val dotCount by produceState(initialValue = 1) {
            while (true) {
                delay(400)
                value = (value % 3) + 1
            }
        }
        val dots = ".".repeat(dotCount)
        val label = when {
            toolName != null -> "${friendlyToolName(toolName)}$dots"
            else -> "Working$dots"
        }

        Text(
            text = label,
            fontSize = 13.sp,
            color = ClaudeMobileTheme.extended.textSecondary,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
    }
}

private fun friendlyToolName(tool: String): String = when (tool) {
    "Read" -> "Reading"
    "Write" -> "Writing"
    "Edit" -> "Editing"
    "Bash" -> "Running command"
    "Glob" -> "Searching files"
    "Grep" -> "Searching"
    "Agent" -> "Running agent"
    "WebSearch" -> "Searching web"
    "WebFetch" -> "Fetching"
    "Skill" -> "Using skill"
    else -> "Working"
}
```

- [ ] **Step 2: Add ActivityIndicator to ChatModeContent**

In the LazyColumn, after the `items(chatState.messages)` block, add the indicator as a trailing item:

```kotlin
item {
    val now = System.currentTimeMillis()
    val isActive = (now - lastPtyOutput) < 2000 || chatState.activeToolName != null
    ActivityIndicator(
        isActive = isActive,
        toolName = chatState.activeToolName,
    )
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ActivityIndicator.kt
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt
git commit -m "feat: add animated activity indicator (Working.../Reading.../etc.)"
```

### Task 11: Rewrite MessageBubble for new content types

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/MessageBubble.kt`

- [ ] **Step 1: Rewrite MessageBubble**

Remove routing for Menu, MenuResolved, OAuth, Confirm, RawTerminal, ApprovalRequest. Add routing for Response, ToolRunning, ToolAwaitingApproval, ToolComplete, ToolFailed, SystemNotice:

```kotlin
package com.destins.claudemobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.runtime.PtyBridge
import com.destins.claudemobile.ui.cards.*
import com.termux.terminal.TerminalSession

@Composable
fun MessageBubble(
    message: ChatMessage,
    expandedCardId: String? = null,
    onToggleCard: (String) -> Unit = {},
    onAcceptApproval: () -> Unit = {},
    onRejectApproval: () -> Unit = {},
    session: TerminalSession? = null,
    screenVersion: Int = 0,
) {
    when (val content = message.content) {
        is MessageContent.ToolRunning -> {
            ToolCard(
                cardId = content.cardId,
                tool = content.tool,
                args = content.args,
                state = ToolCardState.Running,
                isExpanded = expandedCardId == content.cardId,
                onToggle = onToggleCard,
            )
            return
        }
        is MessageContent.ToolAwaitingApproval -> {
            ToolCard(
                cardId = content.cardId,
                tool = content.tool,
                args = content.args,
                state = ToolCardState.AwaitingApproval,
                isExpanded = true, // Always expanded when awaiting approval
                onToggle = onToggleCard,
                session = session,
                screenVersion = screenVersion,
                onAccept = onAcceptApproval,
                onReject = onRejectApproval,
            )
            return
        }
        is MessageContent.ToolComplete -> {
            // Route to specialized cards based on tool name
            when (content.tool) {
                "Edit" -> {
                    // TODO during implementation: extract diff data from tool_response structure
                    // For now, render as generic ToolCard; upgrade to DiffCard once
                    // tool_response field shapes are validated against live output
                    ToolCard(
                        cardId = content.cardId, tool = content.tool, args = content.args,
                        state = ToolCardState.Complete, result = content.result,
                        isExpanded = expandedCardId == content.cardId, onToggle = onToggleCard,
                        session = session, screenVersion = screenVersion,
                    )
                }
                "Bash" -> {
                    val command = content.result.optString("command", content.args)
                    val output = content.result.optString("stdout",
                        content.result.optString("output", content.result.toString()))
                    CodeCard(
                        cardId = content.cardId,
                        language = "bash",
                        code = "$ $command\n$output",
                        isExpanded = expandedCardId == content.cardId,
                        onToggle = onToggleCard,
                    )
                }
                "Read", "Glob", "Grep", "WebSearch", "WebFetch" -> {
                    // Collapsible text card
                    ToolCard(
                        cardId = content.cardId, tool = content.tool, args = content.args,
                        state = ToolCardState.Complete, result = content.result,
                        isExpanded = expandedCardId == content.cardId, onToggle = onToggleCard,
                        session = session, screenVersion = screenVersion,
                    )
                }
                else -> {
                    ToolCard(
                        cardId = content.cardId, tool = content.tool, args = content.args,
                        state = ToolCardState.Complete, result = content.result,
                        isExpanded = expandedCardId == content.cardId, onToggle = onToggleCard,
                        session = session, screenVersion = screenVersion,
                    )
                }
            }
            return
        }
        is MessageContent.ToolFailed -> {
            ErrorCard(
                cardId = content.cardId,
                message = "${content.tool} failed",
                details = content.error.optString("message", content.error.toString()),
                isExpanded = expandedCardId == content.cardId,
                onToggle = onToggleCard,
            )
            return
        }
        is MessageContent.SystemNotice -> {
            Text(
                text = content.text,
                fontSize = 12.sp,
                color = com.destins.claudemobile.ui.theme.ClaudeMobileTheme.extended.textSecondary,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            )
            return
        }
        else -> Unit
    }

    // Text bubbles (user messages and Claude responses)
    val isUser = message.role == MessageRole.USER
    val bgColor = when {
        message.isBtw -> MaterialTheme.colorScheme.surface.copy(alpha = 0.5f)
        isUser -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.surface
    }
    val alignment = if (isUser) Arrangement.End else Arrangement.Start

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp),
        horizontalArrangement = alignment
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.85f)
                .clip(RoundedCornerShape(12.dp))
                .background(bgColor)
                .padding(10.dp)
        ) {
            if (!isUser) {
                Text(
                    text = if (message.isBtw) "aside" else "Claude",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(bottom = 2.dp)
                )
            }

            when (val content = message.content) {
                is MessageContent.Text -> {
                    Text(
                        text = content.text,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (isUser) Color.White else MaterialTheme.colorScheme.onSurface,
                    )
                }
                is MessageContent.Response -> {
                    // Basic markdown rendering — plain text for now,
                    // add library (mikepenz/multiplatform-markdown-renderer) if needed
                    Text(
                        text = content.markdown,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
                else -> Unit
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/MessageBubble.kt
git commit -m "refactor: rewrite MessageBubble for hook-based content types"
```

### Task 12: Update ToolCard with Running/Approval/Complete states

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/cards/ToolCard.kt`

- [ ] **Step 1: Add ToolCardState enum and rewrite ToolCard**

```kotlin
package com.destins.claudemobile.ui.cards

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.TerminalPanel
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme
import com.termux.terminal.TerminalSession
import kotlinx.coroutines.delay
import org.json.JSONObject

enum class ToolCardState { Running, AwaitingApproval, Complete }

@Composable
fun ToolCard(
    cardId: String,
    tool: String,
    args: String,
    state: ToolCardState,
    result: JSONObject? = null,
    isExpanded: Boolean = false,
    onToggle: (String) -> Unit = {},
    session: TerminalSession? = null,
    screenVersion: Int = 0,
    onAccept: () -> Unit = {},
    onReject: () -> Unit = {},
) {
    val borderColor = when (state) {
        ToolCardState.Running -> MaterialTheme.colorScheme.primary.copy(alpha = 0.3f)
        ToolCardState.AwaitingApproval -> MaterialTheme.colorScheme.primary
        ToolCardState.Complete -> ClaudeMobileTheme.extended.surfaceBorder
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(0.5.dp, borderColor, RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onToggle(cardId) }
            .padding(10.dp)
    ) {
        // Header: status icon + tool name + args
        Row(verticalAlignment = Alignment.CenterVertically) {
            val statusText = when (state) {
                ToolCardState.Running -> "\u23F3" // hourglass
                ToolCardState.AwaitingApproval -> "\u26A0" // warning
                ToolCardState.Complete -> "\u2713" // checkmark
            }
            Text(statusText, fontSize = 13.sp)
            Spacer(Modifier.width(6.dp))
            Text(
                tool,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                args.take(60) + if (args.length > 60) "..." else "",
                color = ClaudeMobileTheme.extended.textSecondary,
                fontSize = 12.sp,
                maxLines = 1,
            )
        }

        // Running: animated dots
        if (state == ToolCardState.Running) {
            val dotCount by produceState(initialValue = 1) {
                while (true) {
                    delay(400)
                    value = (value % 3) + 1
                }
            }
            Text(
                ".".repeat(dotCount),
                color = ClaudeMobileTheme.extended.textSecondary,
                fontSize = 12.sp,
            )
        }

        // Awaiting approval: mini-terminal + buttons
        if (state == ToolCardState.AwaitingApproval && session != null) {
            Spacer(Modifier.height(6.dp))
            TerminalPanel(
                session = session,
                screenVersion = screenVersion,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(160.dp)
                    .clip(RoundedCornerShape(4.dp)),
            )
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.primary)
                        .clickable { onAccept() }
                        .padding(horizontal = 24.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Accept", color = MaterialTheme.colorScheme.onPrimary, fontSize = 14.sp)
                }
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .border(0.5.dp, ClaudeMobileTheme.extended.surfaceBorder, RoundedCornerShape(6.dp))
                        .clickable { onReject() }
                        .padding(horizontal = 24.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Reject", color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp)
                }
            }
        }

        // Complete: expandable result with optional inline terminal embed
        if (state == ToolCardState.Complete) {
            AnimatedVisibility(visible = isExpanded) {
                Column(modifier = Modifier.padding(top = 6.dp)) {
                    // For Bash tool results or anything with ANSI content,
                    // show inline mini-terminal embed
                    if (session != null && tool == "Bash") {
                        TerminalPanel(
                            session = session,
                            screenVersion = screenVersion,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(120.dp)
                                .clip(RoundedCornerShape(4.dp)),
                        )
                    } else {
                        // Text-based result display
                        val resultText = result?.toString(2) ?: ""
                        if (resultText.length > 200) {
                            Text(
                                resultText.take(200) + "...",
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                                fontSize = 11.sp,
                            )
                        } else if (resultText.isNotBlank()) {
                            Text(
                                resultText,
                                fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                                fontSize = 11.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/cards/ToolCard.kt
git commit -m "feat: rewrite ToolCard with Running/AwaitingApproval/Complete states and mini-terminal"
```

---

## Chunk 3: Integration & First-Run

### Task 13: Wire up MessageBubble callbacks in ChatScreen

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`

- [ ] **Step 1: Update the items block to pass new callbacks**

In `ChatModeContent`'s LazyColumn, update the MessageBubble call to pass the new parameters:

```kotlin
items(chatState.messages) { message ->
    MessageBubble(
        message = message,
        expandedCardId = chatState.expandedCardId,
        onToggleCard = { chatState.toggleCard(it) },
        onAcceptApproval = { bridge.sendApproval(true) },
        onRejectApproval = { bridge.sendApproval(false) },
        session = bridge.getSession(),
        screenVersion = screenVersion,
    )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt
git commit -m "feat: wire MessageBubble approval callbacks and terminal session for mini-terminal"
```

### Task 14: Add first-run detection and mode switching

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`

- [ ] **Step 1: Add SharedPreferences check for first-run**

At the top of ChatScreen, add first-run detection:

```kotlin
val context = androidx.compose.ui.platform.LocalContext.current
val prefs = remember { context.getSharedPreferences("claude_mobile", android.content.Context.MODE_PRIVATE) }
val firstRunComplete = remember { mutableStateOf(prefs.getBoolean("first_run_complete", false)) }

// Start in terminal mode if first run hasn't been completed
var isTerminalMode by remember { mutableStateOf(!firstRunComplete.value) }
```

Add a way to mark first-run as complete — a "Switch to Chat" action in terminal mode that also sets the flag:

```kotlin
// In TerminalModeContent, the chat toggle button's onClick:
{
    isTerminalMode = false
    if (!firstRunComplete.value) {
        firstRunComplete.value = true
        prefs.edit().putBoolean("first_run_complete", true).apply()
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt
git commit -m "feat: add first-run detection — starts in terminal mode, remembers after first chat toggle"
```

### Task 15: Build and verify compilation

**Files:** None — verification only.

- [ ] **Step 1: Run a Gradle build to check compilation**

Run from the project root:

```bash
cd C:/Users/desti/claude-mobile && ./gradlew assembleDebug 2>&1 | tail -50
```

- [ ] **Step 2: Fix any compilation errors**

Common issues to expect:
- Missing imports for `HookEvent` in files that referenced `ParsedEvent`
- `WRAPPER_JS` constant may need to be preserved in PtyBridge (check it wasn't deleted)
- `TerminalPanel` signature may need updating if it doesn't accept `modifier` parameter cleanly

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve compilation errors from chat rebuild"
```

### Task 16: Clean up unused widget/card code

**Files:**
- Review: `ui/widgets/MenuWidget.kt`, `ui/widgets/ConfirmationWidget.kt`, `ui/widgets/OAuthWidget.kt`
- Review: `ui/cards/ApprovalCard.kt`

- [ ] **Step 1: Verify no references remain to deleted content types**

Search for references to `Menu`, `MenuResolved`, `OAuth`, `Confirm`, `RawTerminal`, `ApprovalRequest` across the codebase. If no references exist, the widget files are dead code but harmless to keep (as the spec notes, they're retained but not actively used).

- [ ] **Step 2: If ApprovalCard has no remaining callers, consider removing or marking as unused**

The approval UI is now handled by ToolCard's AwaitingApproval state. If ApprovalCard is no longer called from MessageBubble, add a comment noting it's retained for potential future use.

- [ ] **Step 3: Commit cleanup**

```bash
git add -A
git commit -m "chore: clean up unused references to deleted content types"
```
