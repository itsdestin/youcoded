package com.youcoded.app.runtime

import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Scans Claude Code's project directories for past session JSONL files
 * and loads conversation history for resume. Mirrors the desktop's
 * session-browser.ts module.
 */
object SessionBrowser {
    private const val TAG = "SessionBrowser"
    /** Minimum file size to consider a session (skip empty/aborted). Desktop uses 500. */
    private const val MIN_SESSION_SIZE = 500L
    /** Regex for safe session/slug IDs — prevents path traversal. */
    /** Allow dots for Android package names in slugs (e.g., com.youcoded.app). */
    private val SAFE_ID_RE = Regex("^[a-zA-Z0-9._-]+$")

    data class PastSession(
        val sessionId: String,
        val projectSlug: String,
        val name: String,
        val lastModified: Long,
        val projectPath: String,
        val size: Long,
    )

    data class HistoryMessage(
        val role: String, // "user" or "assistant"
        val content: String,
        val timestamp: Long,
    )

    /**
     * List all past sessions from ~/.claude/projects/ grouped by project.
     * Excludes currently active session IDs and sessions < 500 bytes.
     * Mirrors the desktop's listPastSessions() — no per-call limit (the UI
     * does its own client-side filtering / search / grouping). A previous
     * hardcoded 30-session cap here silently truncated restore results to
     * the 30 most-recent conversations across ALL projects, so a user who
     * just pulled hundreds of JSONLs from Drive saw "about 30" in the
     * Resume Browser regardless of how many actually synced.
     */
    fun listPastSessions(
        projectsDir: File,
        topicsDir: File,
        activeIds: Set<String> = emptySet(),
    ): List<PastSession> {
        if (!projectsDir.exists()) return emptyList()

        val sessions = mutableListOf<PastSession>()

        val projectDirs = projectsDir.listFiles { f -> f.isDirectory } ?: return emptyList()
        for (projectDir in projectDirs) {
            val slug = projectDir.name
            val jsonlFiles = projectDir.listFiles { f ->
                f.extension == "jsonl" && f.length() >= MIN_SESSION_SIZE
            } ?: continue

            for (jsonlFile in jsonlFiles) {
                val sessionId = jsonlFile.nameWithoutExtension
                if (sessionId in activeIds) continue

                // Read topic name if available
                val topicFile = File(topicsDir, "topic-$sessionId")
                val name = if (topicFile.exists()) {
                    topicFile.readText().trim().ifBlank { "Untitled" }
                } else {
                    "Untitled"
                }

                sessions.add(PastSession(
                    sessionId = sessionId,
                    projectSlug = slug,
                    name = name,
                    lastModified = jsonlFile.lastModified(),
                    projectPath = slugToPath(slug),
                    size = jsonlFile.length(),
                ))
            }
        }

        // Dedup on sessionId (parity with desktop session-browser.ts:181).
        // The sync aggregator symlinks/copies project-specific JSONLs into
        // the home-slug project dir, so the same sessionId can appear under
        // two slugs. Prefer the entry with the longest slug — that's the
        // real project dir, so Resume opens with the correct cwd instead
        // of defaulting to $HOME.
        val deduped = HashMap<String, PastSession>()
        for (s in sessions) {
            val existing = deduped[s.sessionId]
            if (existing == null || s.projectSlug.length > existing.projectSlug.length) {
                deduped[s.sessionId] = s
            }
        }
        return deduped.values.sortedByDescending { it.lastModified }
    }

    data class HistoryResult(
        val messages: List<HistoryMessage>,
        val hasMore: Boolean,
    )

    /**
     * Load the last N conversational messages from a session's JSONL file.
     * Only includes user prompts (with promptId, not isMeta) and assistant
     * end_turn messages (text blocks only, no tool calls).
     * Returns messages + whether more exist (single parse, no double read).
     * Mirrors the desktop's loadHistory().
     */
    fun loadHistory(
        projectsDir: File,
        projectSlug: String,
        sessionId: String,
        count: Int = 10,
        all: Boolean = false,
    ): HistoryResult {
        if (!SAFE_ID_RE.matches(projectSlug) || !SAFE_ID_RE.matches(sessionId)) {
            Log.w(TAG, "Invalid slug or sessionId")
            return HistoryResult(emptyList(), false)
        }

        val jsonlFile = File(projectsDir, "$projectSlug/$sessionId.jsonl")
        if (!jsonlFile.exists()) return HistoryResult(emptyList(), false)

        val allMessages = parseConversationalMessages(jsonlFile)
        return if (all) {
            HistoryResult(allMessages, false)
        } else {
            HistoryResult(allMessages.takeLast(count), allMessages.size > count)
        }
    }

    private fun parseConversationalMessages(jsonlFile: File): List<HistoryMessage> {
        val messages = mutableListOf<HistoryMessage>()
        // Track UUIDs — take last occurrence (handles incremental writes)
        val seenUuids = mutableMapOf<String, Int>()

        try {
            val lines = jsonlFile.readLines()
            for (line in lines) {
                if (line.isBlank()) continue
                val obj = try { JSONObject(line) } catch (_: Exception) { continue }

                val uuid = obj.optString("uuid", "")
                val type = obj.optString("type", "")
                val timestamp = parseTimestamp(obj.optString("timestamp", ""))

                when (type) {
                    "user" -> {
                        if (!obj.has("promptId")) continue
                        if (obj.optBoolean("isMeta", false)) continue
                        val message = obj.optJSONObject("message") ?: continue
                        val content = message.opt("content")
                        val text = when (content) {
                            is String -> content
                            is org.json.JSONArray -> extractTextFromContent(content)
                            else -> continue
                        }
                        if (text.isNotBlank()) {
                            if (uuid.isNotBlank() && seenUuids.containsKey(uuid)) {
                                messages[seenUuids[uuid]!!] = HistoryMessage("user", text, timestamp)
                            } else {
                                if (uuid.isNotBlank()) seenUuids[uuid] = messages.size
                                messages.add(HistoryMessage("user", text, timestamp))
                            }
                        }
                    }
                    "assistant" -> {
                        val message = obj.optJSONObject("message") ?: continue
                        val stopReason = message.optString("stop_reason", "")
                        if (stopReason != "end_turn") continue

                        val contentArr = message.optJSONArray("content") ?: continue
                        val text = extractTextFromContent(contentArr)
                        if (text.isNotBlank()) {
                            if (uuid.isNotBlank() && seenUuids.containsKey(uuid)) {
                                messages[seenUuids[uuid]!!] = HistoryMessage("assistant", text, timestamp)
                            } else {
                                if (uuid.isNotBlank()) seenUuids[uuid] = messages.size
                                messages.add(HistoryMessage("assistant", text, timestamp))
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error loading history", e)
        }

        return messages
    }

    /**
     * Convert project slug back to a display path.
     * Desktop format: C--Users-alice → C:/Users/alice
     * Android format: -data-data-com.youcoded.app-files-home-youcoded-dev
     *                  → /data/data/com.youcoded.app/files/home/youcoded-dev
     *
     * Fix: the naive "replace all dashes with /" broke when directory names
     * themselves contain hyphens (e.g. "youcoded-dev" collapsed to "youcoded/dev",
     * so the Resume Browser showed project "dev" and resume() fell back to $HOME
     * because the bogus path didn't exist). Mirrors desktop's
     * resolveSlugToPath/walkSlugParts in session-browser.ts: greedy-match each
     * segment against the real filesystem, extending with hyphens when a single
     * part doesn't resolve to a real directory.
     */
    fun slugToPath(slug: String): String {
        // Check for Windows-style slugs (start with drive letter and double dash)
        val windowsDriveMatch = Regex("^([A-Z])--(.*)")
            .matchEntire(slug)
        val root: String
        val parts: List<String>
        if (windowsDriveMatch != null) {
            // Windows: C--Users-alice-project → root=C:\, parts=[Users, alice, project]
            root = "${windowsDriveMatch.groupValues[1]}:\\"
            parts = windowsDriveMatch.groupValues[2].split('-').filter { it.isNotEmpty() }
        } else {
            // Unix: -home-user-project → root=/, parts=[home, user, project]
            root = "/"
            parts = slug.removePrefix("-").split('-').filter { it.isNotEmpty() }
        }
        if (parts.isEmpty()) return root
        return walkSlugParts(root, parts)
    }

    /**
     * Recursively resolve slug dash-segments against the filesystem. For each
     * position try the shortest group first (1 part); if it doesn't exist on
     * disk as a directory, extend by joining the next dash-part, up to the
     * whole remainder. Longest-matching real directory wins; naive join is
     * the fallback when nothing exists.
     */
    private fun walkSlugParts(base: String, parts: List<String>): String {
        for (len in 1..parts.size) {
            val segment = parts.subList(0, len).joinToString("-")
            val candidate = File(base, segment)
            if (len == parts.size) {
                // Last possible grouping — accept whether or not it exists on disk
                return candidate.path
            }
            try {
                if (candidate.isDirectory) {
                    return walkSlugParts(candidate.path, parts.subList(len, parts.size))
                }
            } catch (_: Exception) {
                // Keep trying longer groupings
            }
        }
        // Unreachable (len == parts.size branch always returns) but keep as a safety net
        return File(base, parts.joinToString("-")).path
    }

    /** Convert project slug to a File, falling back to homeDir if path doesn't exist. */
    fun slugToCwd(slug: String, homeDir: File): File {
        val path = slugToPath(slug)
        val file = File(path)
        return if (file.exists()) file else homeDir
    }

    /** Extract only text content from a JSONArray of content blocks (no tool calls). */
    private fun extractTextFromContent(content: org.json.JSONArray): String {
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

    private fun parseTimestamp(iso: String): Long {
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            System.currentTimeMillis()
        }
    }
}
