# Unified UI Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile Compose chat UI with the desktop's shared React chat UI running in an Android WebView, connected via a local WebSocket bridge server.

**Architecture:** A Kotlin `LocalBridgeServer` runs on `localhost:9901`, speaking the same WebSocket protocol as the desktop's `remote-server.ts`. The React app (built by Vite, bundled into APK assets) connects via the existing `remote-shim.ts`. The native Termux terminal is untouched. View switching between WebView (chat) and native terminal is handled by Android visibility toggling.

**Tech Stack:** Kotlin/Android (OkHttp WebSocket server), React/TypeScript (existing desktop renderer), Vite (build), Tailwind CSS (styling)

**Spec:** `docs/superpowers/specs/2026-03-30-unified-ui-architecture-design.md`

---

## File Map

### Mobile: New Files

| File | Responsibility |
|---|---|
| `app/src/main/kotlin/com/destin/code/bridge/LocalBridgeServer.kt` | WebSocket server on localhost:9901, message routing |
| `app/src/main/kotlin/com/destin/code/bridge/MessageRouter.kt` | Maps protocol messages to Kotlin runtime calls |
| `app/src/main/kotlin/com/destin/code/bridge/TranscriptSerializer.kt` | Converts TranscriptEvent → desktop JSON format |
| `app/src/main/kotlin/com/destin/code/bridge/HookSerializer.kt` | Converts HookEvent → desktop JSON format |
| `app/src/main/kotlin/com/destin/code/bridge/PlatformBridge.kt` | File picker, clipboard, URL opening intents |
| `app/src/main/kotlin/com/destin/code/ui/WebViewHost.kt` | WebView setup, configuration, lifecycle |
| `app/src/test/kotlin/com/destin/code/bridge/TranscriptSerializerTest.kt` | Unit tests for transcript JSON format |
| `app/src/test/kotlin/com/destin/code/bridge/HookSerializerTest.kt` | Unit tests for hook event JSON format |
| `app/src/test/kotlin/com/destin/code/bridge/MessageRouterTest.kt` | Unit tests for protocol message routing |
| `app/src/main/assets/web/` | (gitignored) Built React app bundle |

### Mobile: Modified Files

| File | Change |
|---|---|
| `app/build.gradle.kts` | Add OkHttp + org.json dependencies |
| `app/src/main/kotlin/com/destin/code/runtime/SessionService.kt` | Start/stop LocalBridgeServer |
| `app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt` | Remove ChatReducer/ChatState, add bridge event forwarding |
| `app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt` | Replace Compose chat with WebView + native terminal host |
| `.gitignore` | Add `app/src/main/assets/web/` |

### Mobile: Deleted Files (Task 8)

All Compose chat UI files listed in the spec's migration section.

### Desktop: Modified Files

| File | Change |
|---|---|
| `desktop/src/renderer/remote-shim.ts` | Add `platform` field, set `window.__PLATFORM__` |
| `desktop/src/renderer/App.tsx` | Read `__PLATFORM__`, pass to components, handle `switch-view` |
| `desktop/src/renderer/styles/globals.css` | Safe area rules, touch overrides |
| `desktop/src/renderer/components/InputBar.tsx` | Platform-aware file picker |
| `desktop/src/renderer/components/HeaderBar.tsx` | Touch-friendly sizes on android |
| `desktop/src/renderer/components/ToolCard.tsx` | Larger touch targets, always-visible buttons |
| `desktop/src/renderer/components/QuickChips.tsx` | Larger chips on android |
| `desktop/src/renderer/components/SettingsPanel.tsx` | Hide desktop-only items on android |
| `desktop/src/renderer/components/CommandDrawer.tsx` | Touch-friendly sizing |
| `desktop/src/main/remote-server.ts` | Include `platform: 'desktop'` in auth response |

---

## Task 1: Add OkHttp Dependency and WebSocket Scaffold

**Files:**
- Modify: `app/build.gradle.kts`
- Modify: `.gitignore`
- Create: `app/src/main/kotlin/com/destin/code/bridge/LocalBridgeServer.kt`

- [ ] **Step 1: Add OkHttp dependency to build.gradle.kts**

In `app/build.gradle.kts`, add after the `org.commonmark` dependency (line 85):

```kotlin
    // WebSocket server for React UI bridge
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:mockwebserver:4.12.0")
```

- [ ] **Step 2: Add assets/web/ to .gitignore**

Append to the project root `.gitignore`:

```
# Built React UI bundle (copied from desktop build)
app/src/main/assets/web/
```

- [ ] **Step 3: Create LocalBridgeServer scaffold**

Create `app/src/main/kotlin/com/destin/code/bridge/LocalBridgeServer.kt`:

```kotlin
package com.destin.code.bridge

import android.util.Log
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * WebSocket server on localhost:9901 that speaks the same protocol
 * as the desktop's remote-server.ts. The React UI connects via
 * remote-shim.ts and sees the same API regardless of platform.
 */
class LocalBridgeServer(
    private val port: Int = 9901
) {
    companion object {
        private const val TAG = "LocalBridgeServer"
    }

    private var server: ServerWebSocket? = null
    private val clients = ConcurrentHashMap<String, WebSocket>()
    private val clientIdCounter = AtomicInteger(0)
    private var messageRouter: MessageRouter? = null
    private var scope: CoroutineScope? = null

    fun start(router: MessageRouter, coroutineScope: CoroutineScope) {
        messageRouter = router
        scope = coroutineScope
        // Server implementation in Task 3 after serializers are ready
        Log.i(TAG, "LocalBridgeServer starting on port $port")
    }

    fun stop() {
        clients.values.forEach { it.close(1000, "Server stopping") }
        clients.clear()
        server?.close()
        Log.i(TAG, "LocalBridgeServer stopped")
    }

    /** Send a push event to all connected clients */
    fun broadcast(type: String, payload: JSONObject) {
        val msg = JSONObject().apply {
            put("type", type)
            put("payload", payload)
        }.toString()
        clients.values.forEach { ws ->
            try {
                ws.send(msg)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to broadcast to client: ${e.message}")
            }
        }
    }

    /** Send a response to a specific request */
    fun respond(ws: WebSocket, type: String, id: String, payload: Any?) {
        val msg = JSONObject().apply {
            put("type", "${type}:response")
            put("id", id)
            put("payload", payload ?: JSONObject.NULL)
        }.toString()
        ws.send(msg)
    }
}

/** Placeholder for the actual OkHttp WebSocket server — see note below.
 *  OkHttp's MockWebServer can act as a real WebSocket server for localhost use.
 *  Alternatively, we use the raw ServerSocket + OkHttp WebSocket upgrade approach.
 *  Implementation completed in Task 3. */
private class ServerWebSocket : AutoCloseable {
    override fun close() {}
}
```

- [ ] **Step 4: Sync Gradle and verify build**

Run: `cd /c/Users/desti/destincode && ./gradlew app:compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 5: Commit**

```bash
git add app/build.gradle.kts .gitignore app/src/main/kotlin/com/destin/code/bridge/LocalBridgeServer.kt
git commit -m "feat(bridge): add OkHttp dependency and LocalBridgeServer scaffold"
```

---

## Task 2: Transcript and Hook Serializers

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/bridge/TranscriptSerializer.kt`
- Create: `app/src/main/kotlin/com/destin/code/bridge/HookSerializer.kt`
- Create: `app/src/test/kotlin/com/destin/code/bridge/TranscriptSerializerTest.kt`
- Create: `app/src/test/kotlin/com/destin/code/bridge/HookSerializerTest.kt`

These serializers convert mobile event types to the exact JSON format the desktop's React app expects.

- [ ] **Step 1: Write TranscriptSerializer tests**

Create `app/src/test/kotlin/com/destin/code/bridge/TranscriptSerializerTest.kt`:

```kotlin
package com.destin.code.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TranscriptSerializerTest {

    @Test
    fun `serializeUserMessage produces desktop format`() {
        val json = TranscriptSerializer.userMessage(
            sessionId = "sess-1",
            uuid = "uuid-abc",
            timestamp = 1711800000000L,
            text = "hello world"
        )
        assertEquals("user-message", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("sess-1", payload.getString("sessionId"))
        assertEquals("uuid-abc", payload.getString("uuid"))
        assertEquals("hello world", payload.getString("text"))
        assertTrue(payload.has("timestamp"))
    }

    @Test
    fun `serializeAssistantText produces desktop format`() {
        val json = TranscriptSerializer.assistantText(
            sessionId = "sess-1",
            uuid = "uuid-def",
            timestamp = 1711800001000L,
            text = "I'll help with that."
        )
        assertEquals("assistant-text", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("I'll help with that.", payload.getString("text"))
    }

    @Test
    fun `serializeToolUse produces desktop format`() {
        val input = JSONObject().put("command", "ls -la")
        val json = TranscriptSerializer.toolUse(
            sessionId = "sess-1",
            uuid = "uuid-ghi",
            timestamp = 1711800002000L,
            toolUseId = "tu-1",
            toolName = "Bash",
            toolInput = input
        )
        assertEquals("tool-use", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("tu-1", payload.getString("toolUseId"))
        assertEquals("Bash", payload.getString("toolName"))
        assertEquals("ls -la", payload.getJSONObject("toolInput").getString("command"))
    }

    @Test
    fun `serializeToolResult produces desktop format`() {
        val json = TranscriptSerializer.toolResult(
            sessionId = "sess-1",
            uuid = "uuid-jkl",
            timestamp = 1711800003000L,
            toolUseId = "tu-1",
            result = "file1.txt\nfile2.txt",
            isError = false
        )
        assertEquals("tool-result", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("tu-1", payload.getString("toolUseId"))
        assertEquals("file1.txt\nfile2.txt", payload.getString("result"))
        assertFalse(payload.getBoolean("isError"))
    }

    @Test
    fun `serializeToolResult with error flag`() {
        val json = TranscriptSerializer.toolResult(
            sessionId = "sess-1",
            uuid = "uuid-mno",
            timestamp = 1711800004000L,
            toolUseId = "tu-2",
            result = "Permission denied",
            isError = true
        )
        val payload = json.getJSONObject("payload")
        assertTrue(payload.getBoolean("isError"))
    }

    @Test
    fun `serializeTurnComplete produces desktop format`() {
        val json = TranscriptSerializer.turnComplete(
            sessionId = "sess-1",
            uuid = "uuid-pqr",
            timestamp = 1711800005000L
        )
        assertEquals("turn-complete", json.getString("type"))
    }

    @Test
    fun `serializeStreamingText produces desktop format`() {
        val json = TranscriptSerializer.streamingText(
            sessionId = "sess-1",
            text = "partial response..."
        )
        assertEquals("streaming-text", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("partial response...", payload.getString("text"))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/Users/desti/destincode && ./gradlew app:testDebugUnitTest --tests "com.destin.code.bridge.TranscriptSerializerTest" 2>&1 | tail -10`
Expected: FAIL — `TranscriptSerializer` class not found

- [ ] **Step 3: Implement TranscriptSerializer**

Create `app/src/main/kotlin/com/destin/code/bridge/TranscriptSerializer.kt`:

```kotlin
package com.destin.code.bridge

import org.json.JSONObject

/**
 * Converts mobile TranscriptEvent data into the JSON format expected by
 * the desktop React app's transcript:event handler.
 *
 * Desktop format: { type: "transcript:event", payload: { type: "<event-type>", payload: { ... } } }
 * The outer wrapper is added by LocalBridgeServer.broadcast().
 * This class produces the inner { type, payload } object.
 */
object TranscriptSerializer {

    fun userMessage(sessionId: String, uuid: String, timestamp: Long, text: String): JSONObject {
        return JSONObject().apply {
            put("type", "user-message")
            put("payload", JSONObject().apply {
                put("sessionId", sessionId)
                put("uuid", uuid)
                put("timestamp", timestamp)
                put("text", text)
            })
        }
    }

    fun assistantText(sessionId: String, uuid: String, timestamp: Long, text: String): JSONObject {
        return JSONObject().apply {
            put("type", "assistant-text")
            put("payload", JSONObject().apply {
                put("sessionId", sessionId)
                put("uuid", uuid)
                put("timestamp", timestamp)
                put("text", text)
            })
        }
    }

    fun toolUse(
        sessionId: String, uuid: String, timestamp: Long,
        toolUseId: String, toolName: String, toolInput: JSONObject
    ): JSONObject {
        return JSONObject().apply {
            put("type", "tool-use")
            put("payload", JSONObject().apply {
                put("sessionId", sessionId)
                put("uuid", uuid)
                put("timestamp", timestamp)
                put("toolUseId", toolUseId)
                put("toolName", toolName)
                put("toolInput", toolInput)
            })
        }
    }

    fun toolResult(
        sessionId: String, uuid: String, timestamp: Long,
        toolUseId: String, result: String, isError: Boolean
    ): JSONObject {
        return JSONObject().apply {
            put("type", "tool-result")
            put("payload", JSONObject().apply {
                put("sessionId", sessionId)
                put("uuid", uuid)
                put("timestamp", timestamp)
                put("toolUseId", toolUseId)
                put("result", result)
                put("isError", isError)
            })
        }
    }

    fun turnComplete(sessionId: String, uuid: String, timestamp: Long): JSONObject {
        return JSONObject().apply {
            put("type", "turn-complete")
            put("payload", JSONObject().apply {
                put("sessionId", sessionId)
                put("uuid", uuid)
                put("timestamp", timestamp)
            })
        }
    }

    fun streamingText(sessionId: String, text: String): JSONObject {
        return JSONObject().apply {
            put("type", "streaming-text")
            put("payload", JSONObject().apply {
                put("sessionId", sessionId)
                put("text", text)
            })
        }
    }
}
```

- [ ] **Step 4: Run TranscriptSerializer tests**

Run: `cd /c/Users/desti/destincode && ./gradlew app:testDebugUnitTest --tests "com.destin.code.bridge.TranscriptSerializerTest" 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 5: Write HookSerializer tests**

Create `app/src/test/kotlin/com/destin/code/bridge/HookSerializerTest.kt`:

```kotlin
package com.destin.code.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HookSerializerTest {

    @Test
    fun `serializePermissionRequest produces desktop format`() {
        val input = JSONObject().put("command", "rm -rf /tmp/test")
        val json = HookSerializer.permissionRequest(
            sessionId = "sess-1",
            requestId = "req-1",
            toolName = "Bash",
            toolInput = input,
            suggestions = listOf("Bash(rm *)")
        )
        assertEquals("hook:event", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("PermissionRequest", payload.getString("hook_event_name"))
        assertEquals("req-1", payload.getString("requestId"))
        assertEquals("Bash", payload.getString("toolName"))
        assertEquals("rm -rf /tmp/test", payload.getJSONObject("toolInput").getString("command"))
        assertEquals(1, payload.getJSONArray("suggestions").length())
    }

    @Test
    fun `serializePermissionExpired produces desktop format`() {
        val json = HookSerializer.permissionExpired(
            sessionId = "sess-1",
            requestId = "req-1"
        )
        assertEquals("hook:event", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("PermissionExpired", payload.getString("hook_event_name"))
        assertEquals("req-1", payload.getString("requestId"))
    }

    @Test
    fun `serializeNotification produces desktop format`() {
        val json = HookSerializer.notification(
            sessionId = "sess-1",
            message = "Task complete"
        )
        assertEquals("hook:event", json.getString("type"))
        val payload = json.getJSONObject("payload")
        assertEquals("Notification", payload.getString("hook_event_name"))
        assertEquals("Task complete", payload.getString("message"))
    }
}
```

- [ ] **Step 6: Run HookSerializer tests to verify they fail**

Run: `cd /c/Users/desti/destincode && ./gradlew app:testDebugUnitTest --tests "com.destin.code.bridge.HookSerializerTest" 2>&1 | tail -10`
Expected: FAIL — `HookSerializer` class not found

- [ ] **Step 7: Implement HookSerializer**

Create `app/src/main/kotlin/com/destin/code/bridge/HookSerializer.kt`:

```kotlin
package com.destin.code.bridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * Converts mobile HookEvent data into the JSON format expected by
 * the desktop React app's hook:event handler.
 *
 * Desktop format: { type: "hook:event", payload: { hook_event_name, ... } }
 * This class produces the complete message (including outer type),
 * ready for LocalBridgeServer.broadcast().
 */
object HookSerializer {

    fun permissionRequest(
        sessionId: String,
        requestId: String,
        toolName: String,
        toolInput: JSONObject,
        suggestions: List<String> = emptyList()
    ): JSONObject {
        return JSONObject().apply {
            put("type", "hook:event")
            put("payload", JSONObject().apply {
                put("hook_event_name", "PermissionRequest")
                put("sessionId", sessionId)
                put("requestId", requestId)
                put("toolName", toolName)
                put("toolInput", toolInput)
                put("suggestions", JSONArray(suggestions))
            })
        }
    }

    fun permissionExpired(sessionId: String, requestId: String): JSONObject {
        return JSONObject().apply {
            put("type", "hook:event")
            put("payload", JSONObject().apply {
                put("hook_event_name", "PermissionExpired")
                put("sessionId", sessionId)
                put("requestId", requestId)
            })
        }
    }

    fun notification(sessionId: String, message: String): JSONObject {
        return JSONObject().apply {
            put("type", "hook:event")
            put("payload", JSONObject().apply {
                put("hook_event_name", "Notification")
                put("sessionId", sessionId)
                put("message", message)
            })
        }
    }
}
```

- [ ] **Step 8: Run all serializer tests**

Run: `cd /c/Users/desti/destincode && ./gradlew app:testDebugUnitTest --tests "com.destin.code.bridge.*" 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/bridge/TranscriptSerializer.kt \
       app/src/main/kotlin/com/destin/code/bridge/HookSerializer.kt \
       app/src/test/kotlin/com/destin/code/bridge/TranscriptSerializerTest.kt \
       app/src/test/kotlin/com/destin/code/bridge/HookSerializerTest.kt
git commit -m "feat(bridge): add transcript and hook event serializers with tests"
```

---

## Task 3: MessageRouter and Full WebSocket Server

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/bridge/MessageRouter.kt`
- Create: `app/src/test/kotlin/com/destin/code/bridge/MessageRouterTest.kt`
- Modify: `app/src/main/kotlin/com/destin/code/bridge/LocalBridgeServer.kt`

- [ ] **Step 1: Write MessageRouter tests**

Create `app/src/test/kotlin/com/destin/code/bridge/MessageRouterTest.kt`:

```kotlin
package com.destin.code.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MessageRouterTest {

    @Test
    fun `parseMessage extracts type id and payload`() {
        val raw = """{"type":"session:list","id":"msg-1","payload":{}}"""
        val msg = MessageRouter.parseMessage(raw)
        assertNotNull(msg)
        assertEquals("session:list", msg!!.type)
        assertEquals("msg-1", msg.id)
    }

    @Test
    fun `parseMessage handles fire-and-forget without id`() {
        val raw = """{"type":"session:input","payload":{"sessionId":"s1","text":"hello\r"}}"""
        val msg = MessageRouter.parseMessage(raw)
        assertNotNull(msg)
        assertEquals("session:input", msg!!.type)
        assertNull(msg.id)
        assertEquals("s1", msg.payload.getString("sessionId"))
    }

    @Test
    fun `parseMessage returns null for invalid JSON`() {
        val msg = MessageRouter.parseMessage("not json")
        assertNull(msg)
    }

    @Test
    fun `parseMessage handles auth message`() {
        val raw = """{"type":"auth","password":"test123"}"""
        val msg = MessageRouter.parseMessage(raw)
        assertNotNull(msg)
        assertEquals("auth", msg!!.type)
    }

    @Test
    fun `buildAuthOkResponse has correct format`() {
        val json = MessageRouter.buildAuthOkResponse("android")
        assertEquals("auth:ok", json.getString("type"))
        assertEquals("android", json.getString("platform"))
        assertTrue(json.has("token"))
    }

    @Test
    fun `buildSessionInfo produces expected shape`() {
        val info = MessageRouter.buildSessionInfo(
            id = "s1",
            name = "New Session",
            cwd = "/home",
            status = "running",
            permissionMode = "normal",
            dangerous = false
        )
        assertEquals("s1", info.getString("id"))
        assertEquals("New Session", info.getString("name"))
        assertEquals("/home", info.getString("cwd"))
        assertEquals("running", info.getString("status"))
        assertEquals("normal", info.getString("permissionMode"))
        assertFalse(info.getBoolean("dangerous"))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/Users/desti/destincode && ./gradlew app:testDebugUnitTest --tests "com.destin.code.bridge.MessageRouterTest" 2>&1 | tail -10`
Expected: FAIL — `MessageRouter` class not found

- [ ] **Step 3: Implement MessageRouter**

Create `app/src/main/kotlin/com/destin/code/bridge/MessageRouter.kt`:

```kotlin
package com.destin.code.bridge

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Parses incoming WebSocket messages and provides response builders.
 * Matches the protocol defined by desktop's remote-server.ts.
 *
 * Protocol:
 * - Request/response: { type, id, payload } → { type: "${type}:response", id, payload }
 * - Fire-and-forget: { type, payload } (no id, no response)
 * - Push events: { type, payload } (server → client)
 */
object MessageRouter {

    data class ParsedMessage(
        val type: String,
        val id: String?,
        val payload: JSONObject
    )

    fun parseMessage(raw: String): ParsedMessage? {
        return try {
            val json = JSONObject(raw)
            ParsedMessage(
                type = json.getString("type"),
                id = json.optString("id", null),
                payload = json.optJSONObject("payload") ?: JSONObject()
            )
        } catch (e: Exception) {
            null
        }
    }

    fun buildAuthOkResponse(platform: String): JSONObject {
        return JSONObject().apply {
            put("type", "auth:ok")
            put("token", UUID.randomUUID().toString())
            put("platform", platform)
        }
    }

    fun buildSessionInfo(
        id: String,
        name: String,
        cwd: String,
        status: String,
        permissionMode: String,
        dangerous: Boolean
    ): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("name", name)
            put("cwd", cwd)
            put("status", status)
            put("permissionMode", permissionMode)
            put("dangerous", dangerous)
        }
    }

    fun buildSessionListResponse(sessions: List<JSONObject>): JSONObject {
        return JSONObject().apply {
            put("sessions", JSONArray(sessions))
        }
    }

    fun buildErrorResponse(error: String): JSONObject {
        return JSONObject().apply {
            put("error", error)
        }
    }
}
```

- [ ] **Step 4: Run MessageRouter tests**

Run: `cd /c/Users/desti/destincode && ./gradlew app:testDebugUnitTest --tests "com.destin.code.bridge.MessageRouterTest" 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 5: Implement the full WebSocket server in LocalBridgeServer**

Replace the contents of `app/src/main/kotlin/com/destin/code/bridge/LocalBridgeServer.kt`:

```kotlin
package com.destin.code.bridge

import android.util.Log
import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONObject
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * WebSocket server on localhost:9901 speaking the same protocol as
 * desktop's remote-server.ts. The React UI connects via remote-shim.ts.
 *
 * Uses OkHttp's WebSocket for the client-side upgrade handshake.
 * For serving, we use a lightweight approach: a raw ServerSocket that
 * performs the WebSocket upgrade handshake manually, then delegates
 * to OkHttp-compatible message handling.
 *
 * NOTE: OkHttp does not provide a WebSocket SERVER out of the box.
 * We use the Java-WebSocket library instead. Added as a dependency.
 */
class LocalBridgeServer(
    private val port: Int = 9901
) {
    companion object {
        private const val TAG = "LocalBridgeServer"
    }

    private var server: org.java_websocket.server.WebSocketServer? = null
    private val clients = ConcurrentHashMap<String, org.java_websocket.WebSocket>()
    private val clientIdCounter = AtomicInteger(0)
    private var router: MessageRouter? = null
    private var onMessage: ((org.java_websocket.WebSocket, MessageRouter.ParsedMessage) -> Unit)? = null

    /**
     * Start the WebSocket server. The [handleMessage] callback is invoked
     * for every parsed message from a client. It runs on the WS server thread —
     * use withContext(Dispatchers.Main) for Compose state access.
     */
    fun start(
        handleMessage: (ws: org.java_websocket.WebSocket, msg: MessageRouter.ParsedMessage) -> Unit
    ) {
        onMessage = handleMessage

        server = object : org.java_websocket.server.WebSocketServer(
            InetSocketAddress("127.0.0.1", port)
        ) {
            override fun onOpen(conn: org.java_websocket.WebSocket, handshake: org.java_websocket.handshake.ClientHandshake) {
                val clientId = "client-${clientIdCounter.incrementAndGet()}"
                clients[clientId] = conn
                conn.setAttachment(clientId)
                Log.i(TAG, "Client connected: $clientId")

                // Auto-auth for localhost — send auth:ok immediately
                val authOk = MessageRouter.buildAuthOkResponse("android")
                conn.send(authOk.toString())
            }

            override fun onClose(conn: org.java_websocket.WebSocket, code: Int, reason: String, remote: Boolean) {
                val clientId = conn.getAttachment<String>()
                if (clientId != null) clients.remove(clientId)
                Log.i(TAG, "Client disconnected: $clientId")
            }

            override fun onMessage(conn: org.java_websocket.WebSocket, message: String) {
                val parsed = MessageRouter.parseMessage(message)
                if (parsed == null) {
                    Log.w(TAG, "Unparseable message: ${message.take(200)}")
                    return
                }

                // Skip auth messages — we auto-auth localhost clients in onOpen
                if (parsed.type == "auth") return

                onMessage?.invoke(conn, parsed)
            }

            override fun onError(conn: org.java_websocket.WebSocket?, ex: Exception) {
                Log.e(TAG, "WebSocket error: ${ex.message}", ex)
            }

            override fun onStart() {
                Log.i(TAG, "LocalBridgeServer listening on 127.0.0.1:$port")
            }
        }

        server?.isReuseAddr = true
        server?.start()
    }

    fun stop() {
        try {
            server?.stop(1000)
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping server: ${e.message}")
        }
        clients.clear()
        Log.i(TAG, "LocalBridgeServer stopped")
    }

    /** Send a push event to all connected clients */
    fun broadcast(message: JSONObject) {
        val msg = message.toString()
        clients.values.forEach { ws ->
            try {
                ws.send(msg)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to broadcast: ${e.message}")
            }
        }
    }

    /** Send a response to a specific request */
    fun respond(ws: org.java_websocket.WebSocket, type: String, id: String, payload: Any?) {
        val msg = JSONObject().apply {
            put("type", "${type}:response")
            put("id", id)
            put("payload", payload ?: JSONObject.NULL)
        }.toString()
        ws.send(msg)
    }

    val isRunning: Boolean get() = server != null
}
```

- [ ] **Step 6: Add Java-WebSocket dependency**

In `app/build.gradle.kts`, replace the OkHttp mockwebserver line with:

```kotlin
    // WebSocket server for React UI bridge
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.java-websocket:Java-WebSocket:1.5.6")
```

- [ ] **Step 7: Sync Gradle and verify build**

Run: `cd /c/Users/desti/destincode && ./gradlew app:compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 8: Run all bridge tests**

Run: `cd /c/Users/desti/destincode && ./gradlew app:testDebugUnitTest --tests "com.destin.code.bridge.*" 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add app/build.gradle.kts \
       app/src/main/kotlin/com/destin/code/bridge/MessageRouter.kt \
       app/src/main/kotlin/com/destin/code/bridge/LocalBridgeServer.kt \
       app/src/test/kotlin/com/destin/code/bridge/MessageRouterTest.kt
git commit -m "feat(bridge): implement MessageRouter and WebSocket server"
```

---

## Task 4: PlatformBridge — Android Native Operations

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/bridge/PlatformBridge.kt`

- [ ] **Step 1: Create PlatformBridge**

Create `app/src/main/kotlin/com/destin/code/bridge/PlatformBridge.kt`:

```kotlin
package com.destin.code.bridge

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import kotlinx.coroutines.CompletableDeferred
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Handles Android-specific operations triggered by WebSocket messages
 * from the React UI. Each method returns a JSONObject response matching
 * the desktop's response format.
 */
class PlatformBridge(
    private val context: Context,
    private val homeDir: File
) {
    companion object {
        private const val TAG = "PlatformBridge"
    }

    // Deferred for file picker result — set by Activity when picker completes
    private var filePickerDeferred: CompletableDeferred<List<String>>? = null

    /** Called by the Activity when file picker returns results */
    fun onFilePickerResult(uris: List<Uri>) {
        val paths = uris.mapNotNull { uri -> copyToAttachments(uri) }
        filePickerDeferred?.complete(paths)
        filePickerDeferred = null
    }

    /** Called by the Activity when file picker is cancelled */
    fun onFilePickerCancelled() {
        filePickerDeferred?.complete(emptyList())
        filePickerDeferred = null
    }

    /**
     * Launch the Android file picker. Returns file paths once the user
     * selects files or cancels. The [launchPicker] callback should trigger
     * the ActivityResultLauncher.
     */
    suspend fun openFile(launchPicker: () -> Unit): JSONObject {
        filePickerDeferred = CompletableDeferred()
        launchPicker()
        val paths = filePickerDeferred!!.await()
        return JSONObject().apply {
            put("paths", JSONArray(paths))
        }
    }

    /** Save clipboard image to temp file, return path */
    fun saveClipboardImage(): JSONObject {
        try {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = clipboard.primaryClip ?: return JSONObject().put("path", JSONObject.NULL)
            if (clip.itemCount == 0) return JSONObject().put("path", JSONObject.NULL)

            val item = clip.getItemAt(0)
            val uri = item.uri ?: return JSONObject().put("path", JSONObject.NULL)

            val attachDir = File(homeDir, "attachments").apply { mkdirs() }
            val dest = File(attachDir, "clipboard-${System.currentTimeMillis()}.png")

            context.contentResolver.openInputStream(uri)?.use { input ->
                val bitmap = BitmapFactory.decodeStream(input)
                if (bitmap != null) {
                    FileOutputStream(dest).use { out ->
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                    }
                    return JSONObject().put("path", dest.absolutePath)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to save clipboard image: ${e.message}")
        }
        return JSONObject().put("path", JSONObject.NULL)
    }

    /** Open a URL in the system browser */
    fun openUrl(url: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to open URL: ${e.message}")
        }
    }

    /** Get the home directory path */
    fun getHomePath(): String = homeDir.absolutePath

    private fun copyToAttachments(uri: Uri): String? {
        return try {
            val attachDir = File(homeDir, "attachments").apply { mkdirs() }
            val mimeType = context.contentResolver.getType(uri) ?: "application/octet-stream"
            val ext = when {
                mimeType.startsWith("image/png") -> "png"
                mimeType.startsWith("image/jpeg") || mimeType.startsWith("image/jpg") -> "jpg"
                mimeType.startsWith("image/gif") -> "gif"
                mimeType.startsWith("image/webp") -> "webp"
                mimeType.startsWith("text/") -> "txt"
                else -> "bin"
            }
            val dest = File(attachDir, "attach-${System.currentTimeMillis()}.$ext")
            context.contentResolver.openInputStream(uri)?.use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
            dest.absolutePath
        } catch (e: Exception) {
            Log.w(TAG, "Failed to copy attachment: ${e.message}")
            null
        }
    }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /c/Users/desti/destincode && ./gradlew app:compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/bridge/PlatformBridge.kt
git commit -m "feat(bridge): add PlatformBridge for Android-native operations"
```

---

## Task 5: Wire LocalBridgeServer into SessionService

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/runtime/SessionService.kt`
- Modify: `app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt`

This task connects the bridge server to the existing session runtime, forwarding transcript and hook events from ManagedSession through LocalBridgeServer to the React UI.

- [ ] **Step 1: Add bridge server to SessionService**

In `app/src/main/kotlin/com/destin/code/runtime/SessionService.kt`, add these fields after `val sessionRegistry` (line 21):

```kotlin
    val bridgeServer = LocalBridgeServer()
    var platformBridge: PlatformBridge? = null
```

Add imports at the top:

```kotlin
import com.destin.code.bridge.*
import org.json.JSONObject
```

- [ ] **Step 2: Start bridge server in onStartCommand**

In `SessionService.onStartCommand()`, after `startForeground(...)` (line 43), add:

```kotlin
        // Initialize platform bridge
        val homeDir = bootstrap?.homeDir ?: filesDir
        platformBridge = PlatformBridge(applicationContext, homeDir)

        // Start the WebSocket bridge server for React UI
        bridgeServer.start { ws, msg ->
            serviceScope.launch {
                handleBridgeMessage(ws, msg)
            }
        }
```

- [ ] **Step 3: Add handleBridgeMessage method to SessionService**

Add this method to `SessionService`:

```kotlin
    private suspend fun handleBridgeMessage(
        ws: org.java_websocket.WebSocket,
        msg: MessageRouter.ParsedMessage
    ) {
        when (msg.type) {
            "session:create" -> {
                val cwd = msg.payload.optString("cwd", bootstrap?.homeDir?.absolutePath ?: "")
                val dangerous = msg.payload.optBoolean("skipPermissions", false)
                val session = createSession(java.io.File(cwd), dangerous, null)
                val info = MessageRouter.buildSessionInfo(
                    id = session.id,
                    name = session.name.value,
                    cwd = cwd,
                    status = "running",
                    permissionMode = "normal",
                    dangerous = dangerous
                )
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, info) }
                // Broadcast session:created to all clients
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "session:created")
                    put("payload", info)
                })
            }

            "session:destroy" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                destroySession(sessionId)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "session:destroyed")
                    put("payload", JSONObject().put("sessionId", sessionId))
                })
            }

            "session:list" -> {
                val sessions = sessionRegistry.sessions.value.map { (id, session) ->
                    MessageRouter.buildSessionInfo(
                        id = id,
                        name = session.name.value,
                        cwd = session.cwd?.absolutePath ?: "",
                        status = session.status.value.name.lowercase(),
                        permissionMode = session.chatReducer.state.permissionMode.value,
                        dangerous = session.dangerousMode
                    )
                }
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, MessageRouter.buildSessionListResponse(sessions))
                }
            }

            "session:input" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                val text = msg.payload.optString("text", "")
                val session = sessionRegistry.sessions.value[sessionId]
                session?.writeInput(text)
            }

            "session:resize" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                val cols = msg.payload.optInt("cols", 80)
                val rows = msg.payload.optInt("rows", 24)
                val session = sessionRegistry.sessions.value[sessionId]
                session?.bridge?.resize(cols, rows)
            }

            "permission:respond" -> {
                val requestId = msg.payload.optString("requestId", "")
                val decision = msg.payload.optJSONObject("decision") ?: JSONObject()
                // Find the session that owns this requestId and respond via EventBridge
                sessionRegistry.sessions.value.values.forEach { session ->
                    session.bridge?.getEventBridge()?.respond(requestId, decision)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }

            "skills:list" -> {
                // Return empty list for now — skills are managed by Claude Code
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, JSONObject().put("skills", org.json.JSONArray()))
                }
            }

            "get-home-path" -> {
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, platformBridge?.getHomePath() ?: "")
                }
            }

            "dialog:open-file" -> {
                // Trigger file picker — response sent asynchronously when picker completes
                // This requires the Activity to wire up the picker launcher
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, JSONObject().put("paths", org.json.JSONArray()))
                }
            }

            "clipboard:save-image" -> {
                val result = platformBridge?.saveClipboardImage() ?: JSONObject().put("path", JSONObject.NULL)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }

            else -> {
                android.util.Log.w("SessionService", "Unknown bridge message type: ${msg.type}")
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, MessageRouter.buildErrorResponse("Unknown type: ${msg.type}"))
                }
            }
        }
    }
```

- [ ] **Step 4: Stop bridge server in onDestroy**

In `SessionService.onDestroy()`, add before existing cleanup:

```kotlin
        bridgeServer.stop()
```

- [ ] **Step 5: Add event forwarding to ManagedSession**

In `app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt`, add a `bridgeServer` property:

```kotlin
    var bridgeServer: LocalBridgeServer? = null
```

In `startBackgroundCollectors()`, in the transcript event collector coroutine (around line 188), add after the existing `routeTranscriptEvent(event)` call:

```kotlin
                    // Forward to bridge server for React UI
                    bridgeServer?.let { server ->
                        val serialized = when (event) {
                            is TranscriptEvent.UserMessage -> TranscriptSerializer.userMessage(event.sessionId, event.uuid, event.timestamp, event.text)
                            is TranscriptEvent.AssistantText -> TranscriptSerializer.assistantText(event.sessionId, event.uuid, event.timestamp, event.text)
                            is TranscriptEvent.ToolUse -> TranscriptSerializer.toolUse(event.sessionId, event.uuid, event.timestamp, event.toolUseId, event.toolName, event.toolInput)
                            is TranscriptEvent.ToolResult -> TranscriptSerializer.toolResult(event.sessionId, event.uuid, event.timestamp, event.toolUseId, event.result, event.isError)
                            is TranscriptEvent.TurnComplete -> TranscriptSerializer.turnComplete(event.sessionId, event.uuid, event.timestamp)
                            is TranscriptEvent.StreamingText -> TranscriptSerializer.streamingText(event.sessionId, event.text)
                        }
                        server.broadcast(JSONObject().apply {
                            put("type", "transcript:event")
                            put("payload", serialized)
                        })
                    }
```

In the hook event collector coroutine (around line 165), add after the existing `routeHookEventToReducer(event)` call:

```kotlin
                    // Forward to bridge server for React UI
                    bridgeServer?.let { server ->
                        when (event) {
                            is HookEvent.PermissionRequest -> {
                                server.broadcast(HookSerializer.permissionRequest(
                                    sessionId = id,
                                    requestId = event.requestId,
                                    toolName = event.toolName,
                                    toolInput = event.toolInput,
                                    suggestions = event.suggestions
                                ))
                            }
                            is HookEvent.Notification -> {
                                server.broadcast(HookSerializer.notification(
                                    sessionId = id,
                                    message = event.message
                                ))
                            }
                            else -> {} // Other hook events handled by transcript watcher
                        }
                    }
```

- [ ] **Step 6: Wire bridgeServer into SessionRegistry.createSession**

In `SessionRegistry.createSession()`, after `ManagedSession` is constructed, add:

```kotlin
        session.bridgeServer = parentService?.bridgeServer
```

(Where `parentService` is a reference to `SessionService` — check how the registry currently accesses the service.)

- [ ] **Step 7: Verify build**

Run: `cd /c/Users/desti/destincode && ./gradlew app:compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 8: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/runtime/SessionService.kt \
       app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt
git commit -m "feat(bridge): wire LocalBridgeServer into session runtime"
```

---

## Task 6: WebView Host Component

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/ui/WebViewHost.kt`

- [ ] **Step 1: Create WebViewHost composable**

Create `app/src/main/kotlin/com/destin/code/ui/WebViewHost.kt`:

```kotlin
package com.destin.code.ui

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Hosts the React chat UI in a WebView. Loads the built React app
 * from assets (production) or a dev server (development).
 *
 * The WebView connects to LocalBridgeServer via remote-shim.ts
 * on ws://localhost:9901.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewHost(
    modifier: Modifier = Modifier,
    devUrl: String? = null // Set to "http://10.0.2.2:5173" for dev mode
) {
    var webView by remember { mutableStateOf<WebView?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            webView?.destroy()
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )

                setBackgroundColor(Color.parseColor("#111111"))

                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    allowFileAccess = true
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    // Enable hardware acceleration
                    setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
                    // Allow the React app to use viewport meta
                    useWideViewPort = true
                    loadWithOverviewMode = true
                    // Disable zoom — React app handles its own scaling
                    setSupportZoom(false)
                    builtInZoomControls = false
                    displayZoomControls = false
                }

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        // Open external links in system browser
                        val url = request.url.toString()
                        if (!url.startsWith("file://") && !url.startsWith("http://localhost") && !url.startsWith("http://10.0.2.2")) {
                            context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url))
                            return true
                        }
                        return false
                    }
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                        android.util.Log.d(
                            "WebViewHost",
                            "${consoleMessage.messageLevel()}: ${consoleMessage.message()} " +
                                    "[${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}]"
                        )
                        return true
                    }
                }

                // Load the React app
                val url = devUrl ?: "file:///android_asset/web/index.html"
                loadUrl(url)

                webView = this
            }
        }
    )
}
```

- [ ] **Step 2: Verify build**

Run: `cd /c/Users/desti/destincode && ./gradlew app:compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/WebViewHost.kt
git commit -m "feat(ui): add WebViewHost composable for React chat UI"
```

---

## Task 7: Desktop React App — Platform Detection and Mobile Adaptations

**Files:**
- Modify: `desktop/src/renderer/remote-shim.ts`
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `desktop/src/renderer/styles/globals.css`
- Modify: `desktop/src/renderer/components/InputBar.tsx`
- Modify: `desktop/src/renderer/components/HeaderBar.tsx`
- Modify: `desktop/src/renderer/components/ToolCard.tsx`
- Modify: `desktop/src/renderer/components/QuickChips.tsx`
- Modify: `desktop/src/main/remote-server.ts`

This task is done in the **desktop repo** (`destinclaude`), on a matching branch.

- [ ] **Step 1: Create branch in desktop repo**

```bash
cd /path/to/destinclaude
git checkout -b unified-ui-architecture
```

- [ ] **Step 2: Add platform field to remote-server.ts auth response**

In `desktop/src/main/remote-server.ts`, find the auth success response (where `auth:ok` is sent) and add the `platform` field:

```typescript
// In the auth success handler, modify the response to include platform:
ws.send(JSON.stringify({ type: 'auth:ok', token, platform: 'desktop' }))
```

- [ ] **Step 3: Update remote-shim.ts to set window.__PLATFORM__**

In `desktop/src/renderer/remote-shim.ts`, in the `connect()` function's auth:ok handler, add:

```typescript
// After storing the token in localStorage:
const platform = data.platform || 'browser';
(window as any).__PLATFORM__ = platform;
```

Also add a default for Electron mode. In the main `index.tsx` or at the top of `App.tsx`, add:

```typescript
// In Electron mode (not using remote-shim), set platform to electron
if (!((window as any).__PLATFORM__)) {
  (window as any).__PLATFORM__ = 'electron';
}
```

- [ ] **Step 4: Add platform utility function**

In `desktop/src/renderer/App.tsx` (or a new `desktop/src/renderer/platform.ts`), add:

```typescript
export function getPlatform(): 'electron' | 'android' | 'browser' {
  return (window as any).__PLATFORM__ || 'electron'
}

export function isAndroid(): boolean {
  return getPlatform() === 'android'
}

export function isTouchDevice(): boolean {
  return getPlatform() === 'android' || getPlatform() === 'browser'
}
```

- [ ] **Step 5: Add mobile CSS adaptations to globals.css**

In `desktop/src/renderer/styles/globals.css`, add at the end:

```css
/* Android safe area handling */
@supports (padding-top: env(safe-area-inset-top)) {
  .android-safe-area-top {
    padding-top: env(safe-area-inset-top);
  }
  .android-safe-area-bottom {
    padding-bottom: env(safe-area-inset-bottom);
  }
}

/* Touch device overrides — disable hover effects */
.touch-device .hover-reveal {
  opacity: 1 !important;
}

.touch-device .hover\:bg-gray-800:hover {
  background-color: transparent;
}

/* Active states for touch */
.touch-device .touch-active:active {
  background-color: rgba(255, 255, 255, 0.05);
}
```

- [ ] **Step 6: Update HeaderBar for touch targets**

In `desktop/src/renderer/components/HeaderBar.tsx`, add the platform import and apply conditional classes:

```typescript
import { isAndroid } from '../platform'

// For the settings gear icon container, change:
// From: className="p-1 rounded hover:bg-gray-800"
// To:
className={`rounded ${isAndroid() ? 'p-2' : 'p-1 hover:bg-gray-800'}`}

// For the view toggle icons:
// From: className="w-3.5 h-3.5"
// To:
className={isAndroid() ? 'w-4 h-4' : 'w-3.5 h-3.5'}
```

- [ ] **Step 7: Update ToolCard for touch targets**

In `desktop/src/renderer/components/ToolCard.tsx`, update the PermissionButtons:

```typescript
import { isAndroid } from '../platform'

// For approval buttons, change:
// From: className="px-3 py-1 text-xs font-medium rounded..."
// To:
className={`px-3 ${isAndroid() ? 'py-2' : 'py-1'} text-xs font-medium rounded...`}
```

- [ ] **Step 8: Update QuickChips for touch targets**

In `desktop/src/renderer/components/QuickChips.tsx`:

```typescript
import { isAndroid } from '../platform'

// For chip elements, change:
// From: className="shrink-0 h-6 px-2.5 rounded..."
// To:
className={`shrink-0 ${isAndroid() ? 'h-8 px-3' : 'h-6 px-2.5'} rounded...`}
```

- [ ] **Step 9: Update InputBar for platform-aware file picker**

In `desktop/src/renderer/components/InputBar.tsx`, the `handleAttachClick` function:

```typescript
import { getPlatform } from '../platform'

const handleAttachClick = async () => {
  const paths = await window.claude.dialog.openFile()
  // On Android, LocalBridgeServer handles the file picker intent
  // and returns paths the same way. No change needed here —
  // the protocol handles it.
  if (paths.length > 0) {
    setAttachments(prev => [...prev, ...paths.map(p => ({ path: p, type: 'file' as const }))])
  }
}
```

- [ ] **Step 10: Handle switch-view action in App.tsx**

In `desktop/src/renderer/App.tsx`, in the `uiAction` handler:

```typescript
window.claude.on.uiAction((action: any) => {
  if (action.action === 'switch-view') {
    // On Android, this message is handled by the Kotlin host
    // to toggle WebView/TerminalView visibility.
    // On desktop, we can use it to switch view modes too.
    if (action.mode === 'terminal' || action.mode === 'chat') {
      setViewModes(prev => {
        const next = new Map(prev)
        if (sessionId) next.set(sessionId, action.mode)
        return next
      })
    }
  }
})
```

- [ ] **Step 11: Build and verify**

```bash
cd /path/to/destinclaude/desktop
npm run build
```
Expected: Build succeeds with no errors

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(ui): add platform detection and mobile touch adaptations"
```

---

## Task 8: Mobile — Replace Compose Chat with WebView

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt`
- Delete: 18 Compose UI files (listed in spec)

This is the big migration step. We gut `ChatScreen.kt` and replace the Compose chat rendering with the WebView host, while keeping the native terminal untouched.

- [ ] **Step 1: Delete Compose chat UI files**

```bash
cd /c/Users/desti/destincode
rm app/src/main/kotlin/com/destin/code/ui/state/ChatReducer.kt
rm app/src/main/kotlin/com/destin/code/ui/state/ChatTypes.kt
rm app/src/main/kotlin/com/destin/code/ui/AssistantTurnBubble.kt
rm app/src/main/kotlin/com/destin/code/ui/UserMessageBubble.kt
rm app/src/main/kotlin/com/destin/code/ui/cards/ToolCardV2.kt
rm app/src/main/kotlin/com/destin/code/ui/cards/PromptCardV2.kt
rm app/src/main/kotlin/com/destin/code/ui/cards/CodeCard.kt
rm app/src/main/kotlin/com/destin/code/ui/MarkdownRenderer.kt
rm app/src/main/kotlin/com/destin/code/ui/SyntaxHighlighter.kt
rm app/src/main/kotlin/com/destin/code/ui/UnifiedTopBar.kt
rm app/src/main/kotlin/com/destin/code/ui/SessionSwitcher.kt
rm app/src/main/kotlin/com/destin/code/ui/QuickChips.kt
rm app/src/main/kotlin/com/destin/code/ui/ThinkingIndicator.kt
rm app/src/main/kotlin/com/destin/code/ui/BrailleSpinner.kt
rm app/src/main/kotlin/com/destin/code/ui/NewSessionDialog.kt
rm app/src/main/kotlin/com/destin/code/ui/theme/DesktopColors.kt
rm app/src/main/kotlin/com/destin/code/ui/theme/AppIcons.kt
rm app/src/main/kotlin/com/destin/code/config/ChipConfig.kt
```

- [ ] **Step 2: Rewrite ChatScreen.kt**

Replace the contents of `app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt` with a thin shell that hosts the WebView and native terminal:

```kotlin
package com.destin.code.ui

import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import com.destin.code.runtime.SessionService

/**
 * Main screen — hosts either the React WebView (chat mode)
 * or the native Termux terminal (terminal mode).
 *
 * The React app handles its own header bar, session switching,
 * settings, and chat rendering. This composable only manages
 * the WebView/Terminal visibility toggle.
 */
@Composable
fun ChatScreen(service: SessionService) {
    val context = LocalContext.current

    // Track which view is active — React UI sends switch-view actions
    // via the bridge server when the user taps the view toggle
    var showTerminal by remember { mutableStateOf(false) }

    // Listen for view switch actions from the bridge server
    // (This will be wired to LocalBridgeServer's ui:action handler)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF111111))
    ) {
        // WebView — always alive, visibility toggled
        if (!showTerminal) {
            WebViewHost(
                modifier = Modifier.fillMaxSize(),
                devUrl = if (com.destin.code.BuildConfig.DEBUG) {
                    // For dev: point to Vite dev server on host machine
                    // Set to null for production (loads from assets)
                    null // Change to "http://10.0.2.2:5173" during active development
                } else null
            )
        }

        // Native terminal — shown when toggled
        if (showTerminal) {
            // Reuse existing TerminalPanel + TerminalKeyboardRow
            val sessions = service.sessionRegistry.sessions.collectAsState()
            val currentId = service.sessionRegistry.currentSessionId.collectAsState()
            val currentSession = currentId.value?.let { sessions.value[it] }
            val bridge = currentSession?.bridge

            Column(modifier = Modifier.fillMaxSize()) {
                // Terminal view takes remaining space
                if (bridge != null) {
                    TerminalPanel(
                        bridge = bridge,
                        modifier = Modifier.weight(1f)
                    )
                }

                // Terminal keyboard row at bottom
                TerminalKeyboardRow(
                    onKeyPress = { key -> bridge?.writeInput(key) },
                    permissionMode = currentSession?.chatState?.permissionMode ?: "Normal",
                    hasBypassMode = currentSession?.dangerousMode == true,
                    onPermissionCycle = { mode ->
                        currentSession?.chatState?.permissionMode = mode
                        bridge?.writeInput("\u001b[Z")
                    }
                )
            }
        }
    }
}
```

**Note:** This is a simplified version. The actual implementation will need to:
1. Wire the `showTerminal` state to the bridge server's `ui:action` messages
2. Preserve references to `TerminalPanel` and `TerminalKeyboardRow` (these files are NOT deleted)
3. Handle the `chatState` reference — since ChatReducer is deleted, permission mode tracking may need to move to ManagedSession directly

- [ ] **Step 3: Fix compilation errors from deleted files**

After deleting the Compose UI files, there will be compilation errors in files that reference them. The main areas:

1. **ManagedSession.kt** — references `ChatReducer` and `ChatState`. Remove these constructor parameters and replace with simpler permission mode tracking:

```kotlin
// Replace:
//   val chatState: ChatState = ChatState()
//   val chatReducer: ChatReducer = ChatReducer()
// With:
var permissionMode: String = "Normal"
```

2. **SessionService.kt** — references to `chatReducer` in the bridge message handler need to use the simpler `permissionMode` property instead.

3. **Any remaining imports** of deleted classes — search for and remove them.

- [ ] **Step 4: Verify build compiles**

Run: `cd /c/Users/desti/destincode && ./gradlew app:compileDebugKotlin 2>&1 | tail -20`
Expected: BUILD SUCCESSFUL (may require iterating on compilation fixes)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ui): replace Compose chat UI with React WebView host

Delete 18 Compose UI files (ChatReducer, ToolCardV2, AssistantTurnBubble,
etc.) and replace ChatScreen with thin WebView + native terminal shell.
Chat rendering now handled by shared React app via LocalBridgeServer."
```

---

## Task 9: Build and Bundle React App

**Files:**
- Modify: `app/build.gradle.kts` (add copy task)
- Create: `scripts/build-web-ui.sh`

- [ ] **Step 1: Create build script**

Create `scripts/build-web-ui.sh` at the mobile repo root:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Build the React UI from the desktop repo and copy into mobile assets.
# Usage: ./scripts/build-web-ui.sh /path/to/destinclaude

DESKTOP_REPO="${1:?Usage: $0 /path/to/destinclaude}"
ASSETS_DIR="app/src/main/assets/web"

echo "Building React UI from $DESKTOP_REPO/desktop..."
cd "$DESKTOP_REPO/desktop"
npm ci
npm run build

echo "Copying build output to $ASSETS_DIR..."
cd -
rm -rf "$ASSETS_DIR"
mkdir -p "$ASSETS_DIR"
cp -r "$DESKTOP_REPO/desktop/dist/renderer/"* "$ASSETS_DIR/"

echo "Done. React UI bundled at $ASSETS_DIR/"
ls -lah "$ASSETS_DIR/"
```

- [ ] **Step 2: Make script executable**

```bash
chmod +x scripts/build-web-ui.sh
```

- [ ] **Step 3: Create a placeholder index.html for development**

Create `app/src/main/assets/web/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no">
    <title>DestinCode</title>
    <style>
        body {
            background: #111111;
            color: #E0E0E0;
            font-family: 'Cascadia Mono', monospace;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
    </style>
</head>
<body>
    <div>
        <p>React UI not bundled yet.</p>
        <p>Run: <code>./scripts/build-web-ui.sh /path/to/destinclaude</code></p>
    </div>
</body>
</html>
```

**Note:** This placeholder will be replaced by the actual React build. It's NOT gitignored because it serves as a fallback for development. The `.gitignore` entry for `assets/web/` should be updated to only ignore the built files but keep this placeholder. Alternatively, just gitignore the entire directory and accept that a build step is required.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-web-ui.sh app/src/main/assets/web/index.html
git commit -m "build: add script to bundle React UI from desktop repo"
```

---

## Task 10: Integration Testing

This task verifies the full pipeline works end-to-end.

- [ ] **Step 1: Build the React UI**

```bash
cd /c/Users/desti/destincode
./scripts/build-web-ui.sh /path/to/destinclaude
```

- [ ] **Step 2: Build and install the APK**

```bash
./gradlew app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 3: Test — WebView loads React app**

Launch the app. Verify:
- The React UI renders (header bar, input bar, "No Active Session" state)
- No white flash on startup (background should be #111111)
- Console logs appear in Logcat under `WebViewHost` tag

- [ ] **Step 4: Test — Create session and send message**

Create a new session via the React UI. Verify:
- Session appears in the session strip
- Type a message and send — verify it appears in the chat
- Claude Code receives the message (check PTY output in Logcat)

- [ ] **Step 5: Test — Tool approval flow**

Trigger a tool call that requires approval. Verify:
- Tool card renders with Yes/Always Allow/No buttons
- Tapping "Yes" sends the approval and Claude Code continues
- Tool card updates to complete state

- [ ] **Step 6: Test — Terminal switching**

Tap the Terminal toggle in the header bar. Verify:
- WebView hides, native terminal appears
- Terminal keyboard row shows
- Can type in terminal
- Tapping Chat toggle returns to WebView with state preserved

- [ ] **Step 7: Test — Multiple sessions**

Create 2-3 sessions. Verify:
- Session strip shows all sessions with status dots
- Switching between sessions shows correct chat history
- Closing a session removes it from the strip

- [ ] **Step 8: Commit any fixes discovered during testing**

```bash
git add -A
git commit -m "fix: integration test fixes for unified UI"
```

---

---

## Follow-Up Tasks (after core pipeline works)

These are spec requirements not covered in the initial 10 tasks. Implement after verifying the core message/approval/terminal pipeline works:

### Follow-Up A: session:browse and session:history

Implement JSONL parsing in `handleBridgeMessage` for `session:browse` (list past sessions from `~/.claude/projects/` directories) and `session:history` (parse a specific session's JSONL transcript into messages). Use the desktop's `TranscriptWatcher.parseTranscriptLine()` format as the target shape.

### Follow-Up B: session:renamed push events

Add a FileObserver on title/topic files in ManagedSession. When a session name changes, broadcast `{ type: "session:renamed", payload: { sessionId, name } }` via LocalBridgeServer.

### Follow-Up C: status:data periodic push

Add a 10-second interval coroutine in SessionService that reads Claude Code's usage cache files (if they exist at `~/.claude/usage/`) and broadcasts `{ type: "status:data", payload: { ... } }`. Include version and session count always; rate limits and context % only when cache files are present.

### Follow-Up D: dialog:open-folder

Wire `dialog:open-folder` messages to Android's Storage Access Framework directory picker via `ActivityResultContracts.OpenDocumentTree()`.

### Follow-Up E: Back gesture handling

In the Activity, intercept `onBackPressed`. If the React app has a settings panel or command drawer open, send a close action via WebSocket. Otherwise, allow normal Android back behavior. This requires the React app to report its modal state to the bridge.

### Follow-Up F: Version handshake

On WebSocket connect, LocalBridgeServer sends a `capabilities` object listing supported protocol methods. The React app's remote-shim checks this and gracefully hides features whose methods aren't available.

---

## Summary

| Task | What it builds | Estimated complexity |
|---|---|---|
| 1 | OkHttp dependency + LocalBridgeServer scaffold | Low |
| 2 | Transcript + Hook serializers with tests | Medium |
| 3 | MessageRouter + full WebSocket server | Medium |
| 4 | PlatformBridge (file picker, clipboard) | Medium |
| 5 | Wire bridge into SessionService + ManagedSession | High |
| 6 | WebViewHost composable | Low |
| 7 | Desktop React app — platform detection + touch | Medium |
| 8 | Delete Compose UI + rewrite ChatScreen | High |
| 9 | Build script + React bundle | Low |
| 10 | Integration testing | Medium |
| A-F | Follow-up tasks for full spec coverage | Medium each |
