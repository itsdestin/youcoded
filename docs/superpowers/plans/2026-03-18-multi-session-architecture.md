# Multi-Session Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Claude Mobile from a single-session app into a multi-session client with process persistence, Termux terminal-view integration, and boot self-test.

**Architecture:** New `SessionRegistry` manages a map of `ManagedSession` objects, each bundling a PtyBridge + ChatState. `SessionService` holds the registry + wake lock. The existing `SessionManager` is renamed to `ServiceBinder`. Termux's `terminal-view` library replaces the custom `TerminalPanel.kt` Canvas renderer.

**Tech Stack:** Kotlin, Jetpack Compose, Termux terminal-emulator + terminal-view, Android Foreground Service, PowerManager WakeLock, FileObserver

**Spec:** `docs/superpowers/specs/2026-03-18-multi-session-architecture-design.md`

---

### Task 1: Add terminal-view dependency and WAKE_LOCK permission

**Files:**
- Modify: `app/build.gradle.kts:48` (add terminal-view dep)
- Modify: `app/src/main/AndroidManifest.xml:4-7` (add WAKE_LOCK permission)

- [ ] **Step 1: Add terminal-view dependency to build.gradle.kts**

After the existing `terminal-emulator` line (line 48), add:
```kotlin
implementation("com.github.termux.termux-app:terminal-view:v0.118.1")
```

- [ ] **Step 2: Add WAKE_LOCK permission to AndroidManifest.xml**

After the existing `POST_NOTIFICATIONS` permission (line 7), add:
```xml
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

- [ ] **Step 3: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL (terminal-view resolves from same JitPack repo as terminal-emulator)

- [ ] **Step 4: Commit**

```bash
git add app/build.gradle.kts app/src/main/AndroidManifest.xml
git commit -m "feat: add terminal-view dependency and WAKE_LOCK permission"
```

---

### Task 2: Rename SessionManager to ServiceBinder

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/SessionManager.kt` → rename to `ServiceBinder.kt`
- Modify: `app/src/main/kotlin/com/destins/claudemobile/MainActivity.kt:15,64,74,78`

- [ ] **Step 1: Rename SessionManager.kt to ServiceBinder.kt**

Rename the file and change the class name, sealed class name, and all internal references:
- `class SessionManager` → `class ServiceBinder`
- `SessionManager.SessionState` → `ServiceBinder.SessionState`

Full file content for `ServiceBinder.kt`:
```kotlin
package com.destins.claudemobile.runtime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first

class ServiceBinder(private val context: Context) {
    private var service: SessionService? = null
    private val _state = MutableStateFlow<SessionState>(SessionState.Disconnected)
    val state: StateFlow<SessionState> = _state
    private val serviceBound = MutableStateFlow<SessionService?>(null)

    sealed class SessionState {
        data object Disconnected : SessionState()
        data object Connecting : SessionState()
        data class Connected(val service: SessionService) : SessionState()
        data class Error(val message: String) : SessionState()
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as SessionService.LocalBinder).service
            service = svc
            serviceBound.value = svc
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            serviceBound.value = null
            _state.value = SessionState.Disconnected
        }
    }

    fun bind() {
        val intent = Intent(context, SessionService::class.java)
        context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    suspend fun startService(bootstrap: Bootstrap, apiKey: String? = null) {
        _state.value = SessionState.Connecting
        val intent = Intent(context, SessionService::class.java)
        context.startForegroundService(intent)

        try {
            val svc = serviceBound.filterNotNull().first()
            _state.value = SessionState.Connected(svc)
        } catch (e: Exception) {
            _state.value = SessionState.Error(e.message ?: "Failed to start service")
        }
    }

    fun stopService() {
        service?.destroyAllSessions()
        _state.value = SessionState.Disconnected
    }

    fun unbind() {
        try {
            context.unbindService(connection)
        } catch (_: Exception) {}
    }
}
```

Note: `Connected` now holds the `SessionService` reference instead of a single `PtyBridge`, since the service manages multiple sessions via `SessionRegistry`. The `startSession`/`stopSession` methods become `startService`/`stopService`.

- [ ] **Step 2: Update MainActivity.kt references**

Replace all `SessionManager` references with `ServiceBinder`. The activity will be further refactored in Task 7 when `ChatScreen` is updated, but for now make it compile:

```kotlin
// Line 15: import
import com.destins.claudemobile.runtime.ServiceBinder

// Line 64: construction
val serviceBinder = remember { ServiceBinder(applicationContext) }
val serviceState by serviceBinder.state.collectAsState()

// Line 68-71: lifecycle
DisposableEffect(Unit) {
    serviceBinder.bind()
    onDispose { serviceBinder.unbind() }
}

// Line 73-104: state matching — update to use ServiceBinder.SessionState
// This is a temporary placeholder; Task 7 will refactor to use SessionRegistry
```

- [ ] **Step 3: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename SessionManager to ServiceBinder"
```

---

### Task 3: Create ManagedSession and SessionStatus

**Files:**
- Create: `app/src/main/kotlin/com/destins/claudemobile/runtime/ManagedSession.kt`

- [ ] **Step 1: Create ManagedSession.kt**

```kotlin
package com.destins.claudemobile.runtime

import android.os.FileObserver
import com.destins.claudemobile.parser.HookEvent
import com.destins.claudemobile.ui.ChatState
import com.destins.claudemobile.ui.MessageContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

enum class SessionStatus { Active, AwaitingApproval, Idle, Dead }

class ManagedSession(
    val id: String = UUID.randomUUID().toString(),
    val cwd: File,
    val dangerousMode: Boolean,
    val ptyBridge: PtyBridge,
    val chatState: ChatState = ChatState(),
    val createdAt: Long = System.currentTimeMillis(),
    private val titleFile: File,
    private val scope: CoroutineScope,
    /** Callback when session enters AwaitingApproval (for notification posting). */
    var onApprovalNeeded: ((sessionId: String, sessionName: String) -> Unit)? = null,
    /** Callback when session leaves AwaitingApproval (for notification clearing). */
    var onApprovalCleared: ((sessionId: String) -> Unit)? = null,
) {
    private val _name = MutableStateFlow(cwd.name)
    val name: StateFlow<String> = _name

    private var titleObserver: FileObserver? = null

    // Status uses combine + a periodic isRunning check (isRunning is not reactive).
    // A 5-second polling coroutine feeds _isRunningFlow to make Dead detection reactive.
    private val _isRunningFlow = MutableStateFlow(true)

    val status: StateFlow<SessionStatus> = combine(
        ptyBridge.lastPtyOutputTime,
        _isRunningFlow,
    ) { lastOutput, isRunning ->
        when {
            !isRunning -> SessionStatus.Dead
            isAwaitingApproval() -> SessionStatus.AwaitingApproval
            System.currentTimeMillis() - lastOutput < 2000 -> SessionStatus.Active
            else -> SessionStatus.Idle
        }
    }.stateIn(scope, SharingStarted.WhileSubscribed(5000), SessionStatus.Idle)

    private fun isAwaitingApproval(): Boolean {
        val lastMsg = chatState.messages.lastOrNull() ?: return false
        return lastMsg.content is MessageContent.ToolAwaitingApproval
    }

    /**
     * Start background collectors that run for the session's entire lifetime.
     * This includes: hook event collection, isRunning polling, approval notifications.
     */
    fun startBackgroundCollectors() {
        // 1. Per-session hook event collector — runs regardless of which session is "current".
        //    All ChatState mutations dispatched to Main to avoid snapshot state race conditions.
        scope.launch {
            // Wait for EventBridge to become available
            var eventBridge = ptyBridge.getEventBridge()
            while (eventBridge == null) {
                delay(200)
                eventBridge = ptyBridge.getEventBridge()
            }
            eventBridge.events.collect { event ->
                withContext(Dispatchers.Main) {
                    routeHookEvent(event)
                }
            }
        }

        // 2. isRunning poller — makes Dead status reactive.
        scope.launch {
            while (true) {
                delay(5000)
                _isRunningFlow.value = ptyBridge.isRunning
                if (!ptyBridge.isRunning) break // Stop polling once dead
            }
        }

        // 3. Approval notification observer — fires callbacks when status changes.
        scope.launch {
            var wasAwaiting = false
            status.collect { s ->
                val isAwaiting = s == SessionStatus.AwaitingApproval
                if (isAwaiting && !wasAwaiting) {
                    onApprovalNeeded?.invoke(id, _name.value)
                } else if (!isAwaiting && wasAwaiting) {
                    onApprovalCleared?.invoke(id)
                }
                wasAwaiting = isAwaiting
            }
        }
    }

    /**
     * Route a hook event to this session's ChatState.
     * Must be called on Main dispatcher (ChatState uses Compose snapshot state).
     */
    private fun routeHookEvent(event: HookEvent) {
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
                    val lastRunning = chatState.messages.lastOrNull {
                        it.content is MessageContent.ToolRunning
                    }
                    val toolUseId = (lastRunning?.content as? MessageContent.ToolRunning)?.toolUseId
                    if (toolUseId != null) {
                        val hasAlways = ptyBridge.hasAlwaysAllowOption()
                        chatState.updateToolToApproval(toolUseId, hasAlways)
                    }
                } else {
                    chatState.addSystemNotice(event.message)
                }
            }
        }
    }

    fun startTitleObserver() {
        titleFile.parentFile?.mkdirs()
        if (!titleFile.exists()) titleFile.writeText("")

        // Use File-based constructor (non-deprecated on API 29+)
        titleObserver = object : FileObserver(titleFile, CLOSE_WRITE or MODIFY) {
            override fun onEvent(event: Int, path: String?) {
                try {
                    val newName = titleFile.readText().trim()
                    if (newName.isNotBlank()) {
                        _name.value = newName
                    }
                } catch (_: Exception) {}
            }
        }
        titleObserver?.startWatching()
    }

    fun destroy() {
        titleObserver?.stopWatching()
        titleObserver = null
        ptyBridge.stop()
        try { titleFile.delete() } catch (_: Exception) {}
    }
}
```

**Key design decisions in ManagedSession:**
- **Per-session hook event collection:** `startBackgroundCollectors()` launches a coroutine that collects from this session's EventBridge for the session's entire lifetime — not just while it's the "current" session. Background sessions continue receiving and processing hook events.
- **Main dispatcher for ChatState:** All `routeHookEvent()` calls are dispatched to `Dispatchers.Main` because `ChatState` uses Compose's `mutableStateListOf` which is only safe on the main thread.
- **Dead detection:** A 5-second polling coroutine checks `ptyBridge.isRunning` and feeds `_isRunningFlow`, making the `Dead` status reactive even when no PTY output occurs.
- **Approval notifications:** Status changes are observed via a collector that fires `onApprovalNeeded`/`onApprovalCleared` callbacks, which SessionService wires to `postApprovalNotification()`/`clearApprovalNotification()`.
- **FileObserver:** Uses `FileObserver(File, Int)` constructor (non-deprecated on API 29+, minSdk is 28 but targetSdk is 35).

- [ ] **Step 2: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/ManagedSession.kt
git commit -m "feat: add ManagedSession and SessionStatus"
```

---

### Task 4: Parameterize PtyBridge (socket name, CWD, dangerousMode)

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/PtyBridge.kt:13-19,83-131,194-197`

- [ ] **Step 1: Update PtyBridge constructor**

Change constructor from:
```kotlin
class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
)
```

To:
```kotlin
class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
    private val socketName: String = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock",
    private val cwd: File = bootstrap.homeDir,
    private val dangerousMode: Boolean = false,
)
```

- [ ] **Step 2: Update socketPath to use socketName**

Change line 19 from:
```kotlin
val socketPath: String get() = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock"
```

To:
```kotlin
val socketPath: String get() = socketName
```

- [ ] **Step 3: Update start() to use cwd and dangerousMode**

In the `start()` method, change the CWD in the TerminalSession constructor (line ~122):
```kotlin
// Change: bootstrap.homeDir.absolutePath → cwd.absolutePath
session = TerminalSession(
    "/system/bin/sh",
    cwd.absolutePath,  // was: bootstrap.homeDir.absolutePath
    arrayOf("sh", "-c", launchCmd),
    envArray,
    200,
    sessionClient
)
```

And update the launch command construction to include `--dangerously-skip-permissions` when flagged. Change the `launchCmd` variable (around line 112):
```kotlin
val dangerousFlag = if (dangerousMode) " --dangerously-skip-permissions" else ""
val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${wrapperPath.absolutePath} ${claudePath.absolutePath}$dangerousFlag"
```

- [ ] **Step 4: Keep createDirectShell() on PtyBridge for now**

Do NOT delete `createDirectShell()` yet — ChatScreen still calls it. It will be migrated to `SessionRegistry` in Task 5 and the call site updated in Task 10. Leaving it here avoids breaking the build mid-plan.

- [ ] **Step 5: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL. All existing code still works; new params have defaults.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/PtyBridge.kt
git commit -m "refactor: parameterize PtyBridge for multi-session support"
```

---

### Task 5: Create SessionRegistry

**Files:**
- Create: `app/src/main/kotlin/com/destins/claudemobile/runtime/SessionRegistry.kt`

- [ ] **Step 1: Create SessionRegistry.kt**

```kotlin
package com.destins.claudemobile.runtime

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File

class SessionRegistry {
    private val _sessions = MutableStateFlow<Map<String, ManagedSession>>(emptyMap())
    val sessions: StateFlow<Map<String, ManagedSession>> = _sessions

    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId

    fun getCurrentSession(): ManagedSession? {
        val id = _currentSessionId.value ?: return null
        return _sessions.value[id]
    }

    fun createSession(
        bootstrap: Bootstrap,
        cwd: File,
        dangerousMode: Boolean,
        apiKey: String?,
        titlesDir: File,
    ): ManagedSession {
        val sessionId = java.util.UUID.randomUUID().toString()
        val socketName = "parser-$sessionId"
        val titleFile = File(titlesDir, sessionId)

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        val bridge = PtyBridge(
            bootstrap = bootstrap,
            apiKey = apiKey,
            socketName = socketName,
            cwd = cwd,
            dangerousMode = dangerousMode,
        )

        val session = ManagedSession(
            id = sessionId,
            cwd = cwd,
            dangerousMode = dangerousMode,
            ptyBridge = bridge,
            titleFile = titleFile,
            scope = scope,
        )

        // Start EventBridge BEFORE Claude Code — hooks fire immediately on launch
        bridge.startEventBridge(scope)
        bridge.start()
        session.startTitleObserver()

        // Wire approval notification callbacks (set by SessionService after creation)
        // These are set externally via session.onApprovalNeeded / onApprovalCleared

        // Start background collectors (hook events, status polling, approval observer)
        session.startBackgroundCollectors()

        _sessions.update { it + (sessionId to session) }
        _currentSessionId.value = sessionId

        return session
    }

    fun switchTo(sessionId: String) {
        if (_sessions.value.containsKey(sessionId)) {
            _currentSessionId.value = sessionId
        }
    }

    fun destroySession(sessionId: String) {
        val session = _sessions.value[sessionId] ?: return
        session.destroy()
        _sessions.update { it - sessionId }
        // If we destroyed the current session, switch to another or null
        if (_currentSessionId.value == sessionId) {
            _currentSessionId.value = _sessions.value.keys.firstOrNull()
        }
    }

    fun destroyAll() {
        _sessions.value.values.forEach { it.destroy() }
        _sessions.value = emptyMap()
        _currentSessionId.value = null
    }

    fun relaunchSession(
        sessionId: String,
        bootstrap: Bootstrap,
        apiKey: String?,
        titlesDir: File,
    ): ManagedSession? {
        val old = _sessions.value[sessionId] ?: return null
        destroySession(sessionId)
        return createSession(bootstrap, old.cwd, old.dangerousMode, apiKey, titlesDir)
    }

    /** Create a standalone bash shell (global, not per-session). */
    fun createDirectShell(bootstrap: Bootstrap): DirectShellBridge {
        return DirectShellBridge(bootstrap).also { it.start() }
    }

    val sessionCount: Int get() = _sessions.value.size
}
```

- [ ] **Step 2: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/SessionRegistry.kt
git commit -m "feat: add SessionRegistry for multi-session management"
```

---

### Task 6: Update SessionService (SessionRegistry, wake lock, dual notifications)

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/SessionService.kt`

- [ ] **Step 1: Rewrite SessionService.kt**

```kotlin
package com.destins.claudemobile.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.PowerManager
import com.destins.claudemobile.MainActivity
import java.io.File

class SessionService : Service() {
    private val binder = LocalBinder()
    val sessionRegistry = SessionRegistry()
    private var wakeLock: PowerManager.WakeLock? = null
    var bootstrap: Bootstrap? = null
        private set

    inner class LocalBinder : Binder() {
        val service: SessionService get() = this@SessionService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildSessionNotification())
        return START_STICKY
    }

    fun initBootstrap(bs: Bootstrap) {
        bootstrap = bs
        // Create titles directory at init time (FileObserver needs it to exist)
        titlesDir.mkdirs()
    }

    val titlesDir: File get() = File(bootstrap?.homeDir ?: File("/"), ".claude-mobile/titles")

    fun createSession(cwd: File, dangerousMode: Boolean, apiKey: String?): ManagedSession {
        val bs = bootstrap ?: throw IllegalStateException("Bootstrap not initialized")
        val session = sessionRegistry.createSession(bs, cwd, dangerousMode, apiKey, titlesDir)

        // Wire approval notification callbacks
        session.onApprovalNeeded = { sessionId, sessionName ->
            postApprovalNotification(sessionId, sessionName)
        }
        session.onApprovalCleared = { sessionId ->
            clearApprovalNotification(sessionId)
        }

        acquireWakeLock()
        updateNotification()
        return session
    }

    fun destroySession(sessionId: String) {
        sessionRegistry.destroySession(sessionId)
        if (sessionRegistry.sessionCount == 0) {
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        } else {
            updateNotification()
        }
    }

    fun destroyAllSessions() {
        sessionRegistry.destroyAll()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ClaudeMobile::Session").apply {
                acquire(4 * 60 * 60 * 1000L) // 4 hour timeout
            }
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        val sessionChannel = NotificationChannel(
            CHANNEL_SESSION, "Claude Code Sessions", NotificationManager.IMPORTANCE_LOW
        ).apply { description = "Active Claude Code sessions" }

        val approvalChannel = NotificationChannel(
            CHANNEL_APPROVAL, "Approval Prompts", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "Claude Code permission prompts" }

        manager.createNotificationChannel(sessionChannel)
        manager.createNotificationChannel(approvalChannel)
    }

    private fun buildSessionNotification(): Notification {
        val count = sessionRegistry.sessionCount
        val text = if (count <= 1) "Session active" else "$count sessions active"

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)

        return Notification.Builder(this, CHANNEL_SESSION)
            .setContentTitle("Claude Code")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    fun postApprovalNotification(sessionId: String, sessionName: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("session_id", sessionId)
        }
        val pending = PendingIntent.getActivity(
            this, sessionId.hashCode(), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = Notification.Builder(this, CHANNEL_APPROVAL)
            .setContentTitle("$sessionName: waiting for approval")
            .setContentText("Tap to review permission request")
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(APPROVAL_NOTIFICATION_BASE + sessionId.hashCode(), notification)
    }

    fun clearApprovalNotification(sessionId: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.cancel(APPROVAL_NOTIFICATION_BASE + sessionId.hashCode())
    }

    private fun updateNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildSessionNotification())
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep service running when user swipes app from recents
        // Sessions survive. User returns via notification.
    }

    override fun onDestroy() {
        sessionRegistry.destroyAll()
        releaseWakeLock()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL_SESSION = "claude_session"
        const val CHANNEL_APPROVAL = "claude_approval"
        const val NOTIFICATION_ID = 1
        const val APPROVAL_NOTIFICATION_BASE = 1000
    }
}
```

- [ ] **Step 2: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/SessionService.kt
git commit -m "feat: update SessionService with SessionRegistry, wake lock, dual notification channels"
```

---

### Task 7: Create ClaudeTerminalViewClient

**Files:**
- Create: `app/src/main/kotlin/com/destins/claudemobile/runtime/ClaudeTerminalViewClient.kt`

- [ ] **Step 1: Create ClaudeTerminalViewClient.kt**

This implements the `TerminalViewClient` interface required by Termux's `TerminalView`. Check the actual API of `com.termux.view.TerminalViewClient` at implementation time — the interface methods may differ slightly from what the spec describes. The key callbacks are:

```kotlin
package com.destins.claudemobile.runtime

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalViewClient

class ClaudeTerminalViewClient(
    private val context: Context,
    private val onTextInput: ((String) -> Unit)? = null,
) : TerminalViewClient {

    override fun onTextChanged(changedSession: TerminalSession) {}

    override fun onTitleChanged(changedSession: TerminalSession) {}

    override fun onSessionFinished(finishedSession: TerminalSession) {}

    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Terminal", text))
    }

    override fun onPasteTextFromClipboard(session: TerminalSession) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = clipboard.primaryClip?.getItemAt(0)?.text?.toString() ?: return
        session.write(text)
    }

    override fun onBell(session: TerminalSession) {}

    override fun onColorsChanged(session: TerminalSession) {}

    override fun onTerminalCursorStateChange(state: Boolean) {}

    override fun getTerminalCursorStyle(): Int? = null

    // Key handling
    override fun onKeyDown(keyCode: Int, e: KeyEvent?, session: TerminalSession): Boolean = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent?): Boolean = false

    // Scale (pinch-to-zoom) — return false to let TerminalView handle default behavior
    override fun onScale(scale: Float): Float = scale

    // Long press — return false to let TerminalView show text selection
    override fun onLongPress(event: MotionEvent): Boolean = false

    // Scroll events
    override fun onSingleTapUp(e: MotionEvent?) {}

    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}
}
```

**CRITICAL:** The code above is illustrative, NOT copy-paste ready. `TerminalViewClient` and `TerminalSessionClient` are separate interfaces in Termux. The code above may mix methods from both. At implementation time:
1. Check the actual `com.termux.view.TerminalViewClient` interface source in the terminal-view library
2. Use the IDE's "implement members" feature to get the exact signatures
3. Only implement clipboard (copy/paste) and input forwarding; return defaults for everything else
4. The `TerminalSessionClient` callbacks (onTextChanged, onBell, etc.) are already handled by PtyBridge's sessionClient — do NOT duplicate them here

Also create a read-only variant for card embeds:
```kotlin
class ReadOnlyTerminalViewClient(context: Context) : ClaudeTerminalViewClient(context) {
    override fun onKeyDown(keyCode: Int, e: KeyEvent?, session: TerminalSession) = true // consume
    override fun onLongPress(event: MotionEvent) = true // consume
}
```

- [ ] **Step 2: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL. If `TerminalViewClient` interface methods differ, fix signatures to match.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/ClaudeTerminalViewClient.kt
git commit -m "feat: add ClaudeTerminalViewClient for Termux TerminalView integration"
```

---

### Task 8: Create SessionSwitcher and NewSessionDialog UI

**Files:**
- Create: `app/src/main/kotlin/com/destins/claudemobile/ui/SessionSwitcher.kt`
- Create: `app/src/main/kotlin/com/destins/claudemobile/ui/NewSessionDialog.kt`

- [ ] **Step 1: Create SessionSwitcher.kt**

```kotlin
package com.destins.claudemobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.runtime.ManagedSession
import com.destins.claudemobile.runtime.SessionStatus
import com.destins.claudemobile.ui.theme.CascadiaMono

@Composable
fun SessionSwitcherPill(
    currentSession: ManagedSession?,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val name by currentSession?.name?.collectAsState() ?: remember { mutableStateOf("No Session") }
    val status by currentSession?.status?.collectAsState() ?: remember { mutableStateOf(SessionStatus.Dead) }

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .clickable { onToggle() }
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StatusDot(status)
        Text(
            "▾",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )
        Text(
            name,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface,
            fontFamily = CascadiaMono,
            maxLines = 1,
        )
    }
}

@Composable
fun SessionDropdown(
    expanded: Boolean,
    onDismiss: () -> Unit,
    sessions: Map<String, ManagedSession>,
    currentSessionId: String?,
    onSelect: (String) -> Unit,
    onDestroy: (String) -> Unit,
    onRelaunch: (String) -> Unit,
    onNewSession: () -> Unit,
) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        offset = DpOffset(0.dp, 4.dp),
    ) {
        sessions.entries.sortedBy { it.value.createdAt }.forEach { (id, session) ->
            val name by session.name.collectAsState()
            val status by session.status.collectAsState()
            val isCurrent = id == currentSessionId

            DropdownMenuItem(
                text = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StatusDot(status)
                        Text(
                            name,
                            fontSize = 13.sp,
                            fontFamily = CascadiaMono,
                            color = if (isCurrent) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                        if (status == SessionStatus.Dead) {
                            TextButton(onClick = { onRelaunch(id); onDismiss() }) {
                                Text("Relaunch", fontSize = 11.sp)
                            }
                        } else {
                            Icon(
                                Icons.Default.Close,
                                contentDescription = "Close session",
                                modifier = Modifier
                                    .size(18.dp)
                                    .clickable { onDestroy(id); onDismiss() },
                                tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                            )
                        }
                    }
                },
                onClick = { onSelect(id); onDismiss() },
            )
        }

        HorizontalDivider()

        DropdownMenuItem(
            text = {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("New Session", fontSize = 13.sp)
                }
            },
            onClick = { onNewSession(); onDismiss() },
        )
    }
}

@Composable
fun StatusDot(status: SessionStatus, modifier: Modifier = Modifier) {
    val color = when (status) {
        SessionStatus.Active -> Color(0xFF4CAF50)
        SessionStatus.AwaitingApproval -> Color(0xFFFF9800)
        SessionStatus.Idle -> Color(0xFF666666)
        SessionStatus.Dead -> Color(0xFFDD4444)
    }
    Box(
        modifier = modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
    )
}
```

- [ ] **Step 2: Create NewSessionDialog.kt**

```kotlin
package com.destins.claudemobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.File

data class NewSessionConfig(
    val cwd: File,
    val dangerousMode: Boolean,
)

@Composable
fun NewSessionDialog(
    knownDirs: List<Pair<String, File>>,
    onDismiss: () -> Unit,
    onCreate: (NewSessionConfig) -> Unit,
) {
    var selectedDir by remember { mutableStateOf(knownDirs.firstOrNull()?.second) }
    var dangerousMode by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New Session", fontSize = 16.sp) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Working Directory:", fontSize = 13.sp)
                knownDirs.forEach { (label, dir) ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(
                                selected = selectedDir == dir,
                                onClick = { selectedDir = dir },
                                role = Role.RadioButton,
                            )
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = selectedDir == dir, onClick = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(label, fontSize = 13.sp)
                    }
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(top = 8.dp),
                ) {
                    Checkbox(checked = dangerousMode, onCheckedChange = { dangerousMode = it })
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("Skip permissions", fontSize = 13.sp)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    selectedDir?.let { dir ->
                        onCreate(NewSessionConfig(dir, dangerousMode))
                    }
                },
                shape = RoundedCornerShape(8.dp),
            ) { Text("Create") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
```

- [ ] **Step 3: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/ui/SessionSwitcher.kt \
       app/src/main/kotlin/com/destins/claudemobile/ui/NewSessionDialog.kt
git commit -m "feat: add SessionSwitcher dropdown and NewSessionDialog"
```

---

### Task 9: Replace TerminalPanel with TerminalView in ChatScreen

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`
- Delete: `app/src/main/kotlin/com/destins/claudemobile/ui/TerminalPanel.kt`

- [ ] **Step 1: Replace TerminalPanel usages in ChatScreen.kt**

This is the largest change. In `ChatScreen.kt`, replace all `TerminalPanel(...)` calls with `AndroidView` wrapping Termux's `TerminalView`.

Add imports at the top:
```kotlin
import androidx.compose.ui.viewinterop.AndroidView
import com.termux.view.TerminalView
import com.destins.claudemobile.runtime.ClaudeTerminalViewClient
```

Replace the `TerminalPanel` composable calls in `ScreenMode.Terminal` (around line 199) and `ScreenMode.Shell` (around line 257) with:

```kotlin
// In ScreenMode.Terminal:
val terminalViewClient = remember { ClaudeTerminalViewClient(context) }

AndroidView(
    factory = { ctx ->
        TerminalView(ctx, null).apply {
            setTerminalViewClient(terminalViewClient)
            bridge.getSession()?.let { attachSession(it) }
        }
    },
    update = { view ->
        bridge.getSession()?.let { view.attachSession(it) }
    },
    modifier = Modifier.fillMaxSize(),
)
```

Do the same replacement for `ScreenMode.Shell` using the shell bridge's session.

Remove the `scrollOffset` state variables that were specific to the custom `TerminalPanel`.

- [ ] **Step 2: Delete TerminalPanel.kt**

Delete the file entirely — all functionality is now provided by Termux's `TerminalView`.

- [ ] **Step 3: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: replace TerminalPanel with Termux TerminalView"
```

---

### Task 10: Wire multi-session into ChatScreen and MainActivity

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/ChatScreen.kt`
- Modify: `app/src/main/kotlin/com/destins/claudemobile/MainActivity.kt`

This is the integration task that connects all the pieces.

- [ ] **Step 1: Update ChatScreen signature and header**

Change `ChatScreen` to accept `SessionService` instead of a single `PtyBridge`:

```kotlin
@Composable
fun ChatScreen(service: SessionService) {
    val sessions by service.sessionRegistry.sessions.collectAsState()
    val currentSessionId by service.sessionRegistry.currentSessionId.collectAsState()
    val currentSession = currentSessionId?.let { sessions[it] }
    val bridge = currentSession?.ptyBridge
    val chatState = currentSession?.chatState ?: remember { ChatState() }
```

- [ ] **Step 2: Add session switcher to the header bar**

In the Chat mode top bar (around line 279), replace the existing header content with the session switcher pill centered between Terminal toggle and Claude mascot:

```kotlin
var switcherExpanded by remember { mutableStateOf(false) }
var showNewSessionDialog by remember { mutableStateOf(false) }

// In the top bar Box:
Box(modifier = Modifier.align(Alignment.Center)) {
    SessionSwitcherPill(
        currentSession = currentSession,
        expanded = switcherExpanded,
        onToggle = { switcherExpanded = !switcherExpanded },
    )
    SessionDropdown(
        expanded = switcherExpanded,
        onDismiss = { switcherExpanded = false },
        sessions = sessions,
        currentSessionId = currentSessionId,
        onSelect = { service.sessionRegistry.switchTo(it) },
        onDestroy = { service.destroySession(it) },
        onRelaunch = {
            service.sessionRegistry.relaunchSession(
                it, service.bootstrap!!, null, service.titlesDir
            )
        },
        onNewSession = { showNewSessionDialog = true },
    )
}
```

- [ ] **Step 3: Add NewSessionDialog**

At the bottom of the `ChatScreen` composable, add the dialog:

```kotlin
if (showNewSessionDialog) {
    val knownDirs = listOf(
        "Home (~)" to service.bootstrap!!.homeDir,
        "claude-mobile" to File(service.bootstrap!!.homeDir, "claude-mobile"),
        "destin-claude" to File(service.bootstrap!!.homeDir, "destin-claude"),
    )
    NewSessionDialog(
        knownDirs = knownDirs,
        onDismiss = { showNewSessionDialog = false },
        onCreate = { config ->
            showNewSessionDialog = false
            service.createSession(config.cwd, config.dangerousMode, null)
        },
    )
}

// Session limit warning
if (showNewSessionDialog && service.sessionRegistry.sessionCount >= 5) {
    // Show warning before the dialog, or integrate into the dialog
}
```

- [ ] **Step 4: REMOVE the hook event collection LaunchedEffect entirely**

The `LaunchedEffect` that collects hook events (around line 110-151) is NO LONGER NEEDED. Hook event collection now happens inside `ManagedSession.startBackgroundCollectors()` (Task 3), which runs for each session's entire lifetime regardless of which session is "current". Delete the entire `LaunchedEffect(bridge)` block that calls `eventBridge.events.collect`.

Also REMOVE the fallback approval detection LaunchedEffect (around line 153-173) — this heuristic is now handled per-session inside `ManagedSession` via the status flow and approval callbacks.

- [ ] **Step 5: Update DirectShellBridge creation**

Replace `bridge.createDirectShell()` (around line 298) with:
```kotlin
directShellBridge = service.sessionRegistry.createDirectShell(service.bootstrap!!)
```

- [ ] **Step 6: Update all `bridge.` references to use `bridge?.`**

Since `bridge` can now be null (no session selected), add null safety throughout. Key patterns:
- `bridge.writeInput(...)` → `bridge?.writeInput(...)`
- `bridge.getSession()` → `bridge?.getSession()`
- `bridge.sendApproval(...)` → `bridge?.sendApproval(...)`

- [ ] **Step 7: Update MainActivity.kt**

Refactor to pass `SessionService` to `ChatScreen` and auto-create first session:

```kotlin
// In the Connected branch (replacing the old single-PtyBridge pattern):
is ServiceBinder.SessionState.Connected -> {
    val svc = (serviceState as ServiceBinder.SessionState.Connected).service

    // Auto-create first session if none exist
    LaunchedEffect(svc) {
        if (svc.sessionRegistry.sessionCount == 0) {
            svc.initBootstrap(bootstrap)
            svc.createSession(bootstrap.homeDir, dangerousMode = false, apiKey = null)
        }
    }

    ChatScreen(svc)
}
```

- [ ] **Step 8: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: wire multi-session into ChatScreen and MainActivity"
```

---

### Task 11: Add mini-terminal embed to ApprovalCard

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/ui/cards/ApprovalCard.kt`

- [ ] **Step 1: Add TerminalView embed to ApprovalCard**

Update `ApprovalCard` to accept a `TerminalSession?` parameter and show a live terminal preview:

```kotlin
@Composable
fun ApprovalCard(
    tool: String,
    summary: String,
    session: TerminalSession?,
    onAccept: () -> Unit,
    onReject: () -> Unit,
    onViewTerminal: () -> Unit,
) {
    // ... existing Column structure ...
    // After the summary Text, before the buttons Row:

    if (session != null) {
        val context = LocalContext.current
        val readOnlyClient = remember { ReadOnlyTerminalViewClient(context) }
        AndroidView(
            factory = { ctx ->
                TerminalView(ctx, null).apply {
                    setTerminalViewClient(readOnlyClient)
                    attachSession(session)
                    isEnabled = false
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(120.dp)
                .padding(vertical = 4.dp)
                .clip(RoundedCornerShape(4.dp)),
        )
    }

    // ... existing buttons ...
}
```

- [ ] **Step 2: Update ApprovalCard call sites in ChatScreen**

Where ApprovalCard is invoked, pass `bridge?.getSession()` as the session parameter.

- [ ] **Step 3: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add live terminal preview to approval cards"
```

---

### Task 12: Add boot self-test to Bootstrap

**Files:**
- Modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt`
- Modify: `app/src/main/kotlin/com/destins/claudemobile/MainActivity.kt`

- [ ] **Step 1: Add selfTest() to Bootstrap.kt**

Add after the `setup()` method:

```kotlin
data class SelfTestResult(
    val bashOk: Boolean,
    val nodeOk: Boolean,
    val cliExists: Boolean,
) {
    val passed: Boolean get() = bashOk && nodeOk && cliExists
    val failureMessage: String? get() = when {
        !bashOk -> "bash failed to execute through linker64"
        !nodeOk -> "Node.js failed to start"
        !cliExists -> "Claude Code CLI entry point not found"
        else -> null
    }
}

fun selfTest(): SelfTestResult {
    val prefix = usrDir.absolutePath
    val bashOk = try {
        val p = ProcessBuilder("/system/bin/linker64", "$prefix/bin/bash", "--version")
            .redirectErrorStream(true).start()
        p.waitFor() == 0
    } catch (_: Exception) { false }

    val nodeOk = try {
        val p = ProcessBuilder("/system/bin/linker64", "$prefix/bin/node", "-e", "process.exit(0)")
            .redirectErrorStream(true).start()
        p.waitFor() == 0
    } catch (_: Exception) { false }

    val cliExists = File("$prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js").exists()

    return SelfTestResult(bashOk, nodeOk, cliExists)
}
```

Also add titles directory creation to `setupHome()` (or `setup()`):
```kotlin
File(homeDir, ".claude-mobile/titles").mkdirs()
```

- [ ] **Step 2: Add self-test check in MainActivity**

After `isReady = true`, before creating session, run self-test:

```kotlin
// After bootstrap is ready, before showing ChatScreen:
val selfTestResult = remember(isReady) {
    if (isReady) bootstrap.selfTest() else null
}

if (selfTestResult != null && !selfTestResult.passed) {
    // Show diagnostic screen
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Bootstrap Self-Test Failed", style = MaterialTheme.typography.titleLarge)
        Spacer(modifier = Modifier.height(16.dp))
        Text(selfTestResult.failureMessage ?: "Unknown failure", color = MaterialTheme.colorScheme.error)
        Spacer(modifier = Modifier.height(24.dp))
        Button(onClick = {
            // Re-run setup
            isReady = false
            progress = null
        }) { Text("Re-extract") }
    }
} else if (isReady) {
    // ... normal ServiceBinder + ChatScreen flow
}
```

- [ ] **Step 3: Verify build compiles**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add boot self-test for bootstrap verification"
```

---

### Task 13: linker64-env.sh audit (investigation)

**Files:**
- Potentially modify: `app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt`

This is an investigation task, not a guaranteed code change.

- [ ] **Step 1: Create a test script**

On the Android device (via the Shell mode), create a test:
```bash
# Test if LD_PRELOAD alone handles binary execution without linker64-env.sh
# Comment out the BASH_ENV sourcing temporarily and test:
unset BASH_ENV
# Try direct binary execution:
git --version
curl --version
python --version
bash -c "git status"
```

- [ ] **Step 2: Document results**

If all commands work without `linker64-env.sh`:
- Remove `deployBashEnv()` from Bootstrap.kt
- Remove `BASH_ENV` env var from `buildRuntimeEnv()`
- Remove `linker64-env.sh` generation

If some fail:
- Document which commands fail in a comment in Bootstrap.kt
- Keep `deployBashEnv()` but add the documentation

- [ ] **Step 3: Commit results**

```bash
git add -A
git commit -m "investigate: linker64-env.sh audit — [document outcome]"
```

---

### Task 14: Integration testing on device

- [ ] **Step 1: Build and install APK**

Run: `./gradlew installDebug`

- [ ] **Step 2: Test single session (regression)**

- Launch app
- Verify boot self-test passes
- Verify Claude Code session starts
- Send a message, verify chat UI works
- Toggle to terminal mode, verify TerminalView renders
- Verify text selection works in terminal (long-press)
- Switch back to chat mode

- [ ] **Step 3: Test multi-session**

- Tap session name in header → dropdown appears
- Tap "+ New Session" → dialog opens
- Select different CWD, create session
- Verify new session launches and header updates
- Switch between sessions via dropdown
- Verify each session's chat history is independent
- Verify auto-title updates session name

- [ ] **Step 4: Test process persistence**

- With sessions running, press home button
- Wait 30 seconds
- Return to app via notification
- Verify sessions are still alive

- [ ] **Step 5: Test approval notifications**

- Trigger a tool that requires approval
- Background the app
- Verify heads-up notification appears
- Tap notification → returns to correct session

- [ ] **Step 6: Test session cleanup**

- Destroy a session via dropdown ✕
- Verify it disappears
- Destroy all sessions
- Verify service stops (notification disappears)

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes for multi-session architecture"
```
