package com.destin.code.parser

import android.os.FileObserver
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap

/**
 * Watches Claude Code's JSONL transcript files and emits [TranscriptEvent]s.
 * Mirrors the desktop's transcript-watcher.ts.
 *
 * Claude Code writes incremental JSONL to:
 *   ~/.claude/projects/{projectSlug}/{sessionId}.jsonl
 *
 * Each line is a JSON object with a unique `uuid`. We track file byte offset
 * to read only new content, and deduplicate by uuid.
 */
class TranscriptWatcher(
    private val projectsDir: File, // e.g., $HOME/.claude/projects/
    private val scope: CoroutineScope,
) {
    companion object {
        private const val TAG = "TranscriptWatcher"
        private const val POLL_INTERVAL_MS = 500L

        /** Strip internal XML tags and ANSI escapes that should never appear in rendered content.
         *  - system-reminder: injected system context
         *  - command-name/message/args: slash-command metadata (strip entirely)
         *  - local-command-stdout/stderr: command output (keep inner text)
         */
        private val STRIP_ENTIRELY_REGEX = Regex(
            """<(system-reminder|command-name|command-message|command-args)>[\s\S]*?</\1>""",
        )
        private val UNWRAP_REGEX = Regex(
            """<(local-command-stdout|local-command-stderr)>([\s\S]*?)</\1>""",
        )
        private val ANSI_REGEX = Regex("""\u001b\[[0-9;]*[a-zA-Z]""")

        fun stripSystemTags(text: String): String {
            var result = STRIP_ENTIRELY_REGEX.replace(text, "")
            result = UNWRAP_REGEX.replace(result) { it.groupValues[2] }
            result = ANSI_REGEX.replace(result, "")
            return result.trim()
        }

        /**
         * Convert a working directory path to Claude Code's project slug.
         * Mirrors desktop's cwdToProjectSlug(): replace \, :, / with -. Leading dash is preserved.
         */
        fun cwdToProjectSlug(cwdPath: String): String {
            return cwdPath
                .replace('\\', '-')
                .replace(':', '-')
                .replace('/', '-')
        }
    }

    private val _events = MutableSharedFlow<TranscriptEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<TranscriptEvent> = _events

    /** Active watchers keyed by mobile session ID */
    private val watchers = ConcurrentHashMap<String, WatcherState>()

    private class WatcherState(
        val jsonlFile: File,
        val mobileSessionId: String,
        var fileOffset: Long = 0L,
        val seenUuids: MutableSet<String> = mutableSetOf(),
        var job: Job? = null,
        var fileObserver: FileObserver? = null,
        val mutex: Mutex = Mutex(),
        var accumulatedStreamingText: String = "",
    )

    /**
     * Begin watching a transcript file for a session using the path provided by Claude Code.
     * Uses FileObserver when available, with polling fallback if file doesn't exist yet.
     */
    fun startWatching(mobileSessionId: String, transcriptPath: String) {
        if (watchers.containsKey(mobileSessionId)) return

        val jsonlFile = File(transcriptPath)

        val state = WatcherState(
            jsonlFile = jsonlFile,
            mobileSessionId = mobileSessionId,
        )
        watchers[mobileSessionId] = state

        Log.d(TAG, "Watching transcript: ${jsonlFile.absolutePath}")

        // Start polling loop — also sets up FileObserver once file appears
        state.job = scope.launch(Dispatchers.IO) {
            // Wait for file to appear (Claude Code creates it on first message)
            while (isActive && !jsonlFile.exists()) {
                delay(POLL_INTERVAL_MS)
            }
            if (!isActive) return@launch

            // Initial read of existing content
            readNewLines(state)

            // Set up FileObserver on the file's parent directory
            val parentDir = jsonlFile.parentFile ?: return@launch
            val fileName = jsonlFile.name
            state.fileObserver = object : FileObserver(parentDir, MODIFY or CLOSE_WRITE) {
                override fun onEvent(event: Int, path: String?) {
                    if (path == fileName) {
                        scope.launch(Dispatchers.IO) {
                            readNewLines(state)
                        }
                    }
                }
            }
            state.fileObserver?.startWatching()

            // Polling fallback — FileObserver can miss events on some Android devices
            while (isActive) {
                delay(POLL_INTERVAL_MS)
                readNewLines(state)
            }
        }
    }

    /** Read new lines appended since last read, parse and emit events. */
    private suspend fun readNewLines(state: WatcherState) = state.mutex.withLock {
        val file = state.jsonlFile
        if (!file.exists()) return@withLock

        val fileLength = file.length()

        // /clear truncates the JSONL. If it shrank below our offset, reset to 0
        // so subsequent writes are read correctly. Without this, we'd silently
        // skip every new event until the new writes pass the old offset.
        if (fileLength < state.fileOffset) {
            state.fileOffset = 0L
        }
        if (fileLength <= state.fileOffset) return@withLock

        try {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(state.fileOffset)
                val newBytes = ByteArray((fileLength - state.fileOffset).toInt())
                raf.readFully(newBytes)

                // Find last newline byte (0x0A is unambiguous in UTF-8)
                val lastNewline = newBytes.lastIndexOf(0x0A.toByte())
                if (lastNewline < 0) return@withLock  // no complete lines yet

                // Only advance offset past complete lines
                state.fileOffset += lastNewline + 1

                val completeContent = String(newBytes, 0, lastNewline + 1, Charsets.UTF_8)
                for (line in completeContent.lineSequence()) {
                    if (line.isBlank()) continue
                    parseLine(line, state)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error reading transcript", e)
        }
    }

    /**
     * Parse a single JSONL line and emit TranscriptEvents.
     * Mirrors the desktop's parseTranscriptLine().
     *
     * JSONL line format:
     * - type: "user" | "assistant" | "progress" | "file-history-snapshot"
     * - uuid: unique line identifier
     * - message.content: array of content blocks
     * - message.stop_reason: null | "end_turn" | "tool_use"
     */
    private fun parseLine(line: String, state: WatcherState) {
        val obj = try { JSONObject(line) } catch (_: Exception) { return }

        val uuid = obj.optString("uuid", "").ifBlank { return }
        if (uuid in state.seenUuids) return
        state.seenUuids.add(uuid)

        val type = obj.optString("type", "")
        val timestamp = parseTimestamp(obj.optString("timestamp", ""))
        val sessionId = state.mobileSessionId

        when (type) {
            "user" -> parseUserLine(obj, sessionId, uuid, timestamp, state)
            "assistant" -> parseAssistantLine(obj, sessionId, uuid, timestamp)
            "progress" -> parseProgressLine(obj, sessionId, state)
            // "file-history-snapshot" — skip
        }
    }

    private fun parseUserLine(
        obj: JSONObject,
        sessionId: String,
        uuid: String,
        timestamp: Long,
        state: WatcherState,
    ) {
        state.accumulatedStreamingText = ""
        val message = obj.optJSONObject("message") ?: return
        val content = message.opt("content")

        // String content = simple user message
        if (content is String) {
            // Only emit if this is a real user prompt (has promptId), not a tool result
            if (obj.has("promptId")) {
                val cleaned = stripSystemTags(content)
                if (cleaned.isNotBlank()) {
                    _events.tryEmit(TranscriptEvent.UserMessage(sessionId, uuid, timestamp, cleaned))
                }
            }
            return
        }

        // Array content — check for tool_result or user text
        if (content is JSONArray) {
            var hasToolResult = false
            for (i in 0 until content.length()) {
                val block = content.optJSONObject(i) ?: continue
                when (block.optString("type")) {
                    "tool_result" -> {
                        hasToolResult = true
                        val toolUseId = block.optString("tool_use_id", "")
                        if (toolUseId.isBlank()) continue

                        // Content can be string or array of content blocks
                        val resultContent = block.opt("content")
                        val resultText = when (resultContent) {
                            is String -> resultContent
                            is JSONArray -> {
                                // Extract text from content blocks
                                val parts = mutableListOf<String>()
                                for (j in 0 until resultContent.length()) {
                                    val part = resultContent.optJSONObject(j)
                                    if (part?.optString("type") == "text") {
                                        parts.add(part.optString("text", ""))
                                    }
                                }
                                parts.joinToString("\n")
                            }
                            else -> ""
                        }

                        val isError = block.optBoolean("is_error", false)
                        _events.tryEmit(TranscriptEvent.ToolResult(
                            sessionId, uuid, timestamp, toolUseId, resultText, isError,
                        ))
                    }
                }
            }

            // If no tool_result and has promptId, it's a user message
            if (!hasToolResult && obj.has("promptId")) {
                // Extract text from content blocks
                val text = stripSystemTags(extractTextFromContent(content))
                if (text.isNotBlank()) {
                    _events.tryEmit(TranscriptEvent.UserMessage(sessionId, uuid, timestamp, text))
                }
            }
        }
    }

    private fun parseAssistantLine(
        obj: JSONObject,
        sessionId: String,
        uuid: String,
        timestamp: Long,
    ) {
        val message = obj.optJSONObject("message") ?: return
        val content = message.optJSONArray("content") ?: return
        val stopReason = message.optString("stop_reason", "")
        val model = message.optString("model", null)

        // Process each content block in the message
        for (i in 0 until content.length()) {
            val block = content.optJSONObject(i) ?: continue
            when (block.optString("type")) {
                "text" -> {
                    val raw = block.optString("text", "")
                    val text = stripSystemTags(raw)
                    if (text.isNotBlank()) {
                        _events.tryEmit(TranscriptEvent.AssistantText(
                            sessionId, uuid, timestamp, text, model,
                        ))
                    }
                }
                "tool_use" -> {
                    val toolUseId = block.optString("id", "")
                    val toolName = block.optString("name", "")
                    val toolInput = block.optJSONObject("input") ?: JSONObject()
                    if (toolUseId.isNotBlank()) {
                        _events.tryEmit(TranscriptEvent.ToolUse(
                            sessionId, uuid, timestamp, toolUseId, toolName, toolInput,
                        ))
                    }
                }
                "thinking" -> {
                    // Currently unused — could show thinking indicator
                }
            }
        }

        // Emit turn-complete for any definitive stop reason except tool_use
        // (tool_use means Claude is waiting for tool results, not actually done)
        if (stopReason.isNotEmpty() && stopReason != "tool_use") {
            _events.tryEmit(TranscriptEvent.TurnComplete(sessionId, uuid, timestamp))
        }
    }

    private fun parseProgressLine(obj: JSONObject, sessionId: String, state: WatcherState) {
        val content = obj.optJSONArray("content") ?: return
        val text = buildString {
            for (i in 0 until content.length()) {
                val block = content.optJSONObject(i) ?: continue
                if (block.optString("type") == "text") {
                    append(block.optString("text", ""))
                }
            }
        }
        if (text.isNotEmpty()) {
            state.accumulatedStreamingText += text
            val cleaned = stripSystemTags(state.accumulatedStreamingText)
            if (cleaned.isNotBlank()) {
                _events.tryEmit(TranscriptEvent.StreamingText(sessionId, cleaned))
            }
        }
    }

    /** Extract text from a JSONArray of content blocks. */
    private fun extractTextFromContent(content: JSONArray): String {
        val parts = mutableListOf<String>()
        for (i in 0 until content.length()) {
            val item = content.opt(i)
            when {
                item is String -> parts.add(item)
                item is JSONObject && item.optString("type") == "text" ->
                    parts.add(item.optString("text", ""))
            }
        }
        return parts.joinToString("\n")
    }

    /** Parse ISO 8601 timestamp to epoch millis. */
    private fun parseTimestamp(iso: String): Long {
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            System.currentTimeMillis()
        }
    }

    fun stopWatching(mobileSessionId: String) {
        val state = watchers.remove(mobileSessionId) ?: return
        state.fileObserver?.stopWatching()
        state.job?.cancel()
    }

}
