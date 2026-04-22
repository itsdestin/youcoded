package com.youcoded.app.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Kotlin equivalent of desktop/src/main/dev-tools.ts. Mirrors the
 * pure-logic helpers and IPC handler bodies. The TS file is the
 * canonical reference for behaviour — keep these in sync.
 *
 * Key differences from the plan sketch:
 * - env parameter is Map<String, String> (Bootstrap.buildRuntimeEnv() returns that, not Array<String>)
 * - cwd-as-File is nullable; null means inherit the caller's cwd
 * - ProcessBuilder.environment() is cleared and repopulated from the map, matching the
 *   pattern used elsewhere in SessionService for hermetic subprocess envs
 *
 * See docs/superpowers/specs/2026-04-21-development-settings-design.md.
 */
object DevTools {
    private val GH_TOKEN_RE = Regex("gh[opsu]_[A-Za-z0-9]{20,}")
    private val ANTHROPIC_KEY_RE = Regex("sk-ant-[A-Za-z0-9_-]{20,}")

    /** Replace the home dir with ~ and strip known secret patterns. */
    fun redactLog(text: String, homeDir: String): String {
        var out = text
        if (homeDir.isNotEmpty()) {
            // Literal replacement — no regex needed, avoids escaping issues with Windows paths.
            out = out.replace(homeDir, "~")
        }
        out = GH_TOKEN_RE.replace(out, "[REDACTED-GH-TOKEN]")
        out = ANTHROPIC_KEY_RE.replace(out, "[REDACTED-ANTHROPIC-KEY]")
        return out
    }

    /**
     * If the log is longer than keepLines, prepend a "N lines omitted" banner
     * and return only the tail. Matches smartTruncateLog() in dev-tools.ts.
     */
    fun smartTruncateLog(text: String, keepLines: Int): String {
        val lines = text.split('\n')
        if (lines.size <= keepLines) return text
        val omitted = lines.size - keepLines
        return "… ($omitted earlier lines omitted)\n${lines.takeLast(keepLines).joinToString("\n")}"
    }

    /**
     * Return one of: "workspace" | "wrong-remote" | "not-git"
     * based on whether the remote URL points at itsdestin/youcoded-dev.
     * Mirrors classifyExistingWorkspace() in dev-tools.ts.
     */
    fun classifyExistingWorkspace(remoteUrl: String): String {
        val trimmed = remoteUrl.trim()
        if (trimmed.isEmpty()) return "not-git"
        return if (Regex("[/:]itsdestin/youcoded-dev(\\.git)?/?$").containsMatchIn(trimmed))
            "workspace" else "wrong-remote"
    }

    /**
     * Read the last maxLines lines of $homeDir/.claude/desktop.log, applying
     * redaction. Returns "" if the log doesn't exist (fresh install).
     * Mirrors readLogTail() in dev-tools.ts.
     */
    fun readLogTail(homeDir: String, maxLines: Int): String {
        val logFile = File(File(homeDir, ".claude"), "desktop.log")
        if (!logFile.exists()) return ""
        return try {
            val raw = logFile.readText()
            val tail = raw.split('\n').takeLast(maxLines).joinToString("\n")
            redactLog(tail, homeDir)
        } catch (e: IOException) {
            ""
        }
    }

    /**
     * Run a shell command with the Bootstrap-built runtime env so that
     * PATH, LD_LIBRARY_PATH, LD_PRELOAD and all Termux overrides are
     * present. Streams stdout+stderr (merged) line-by-line through onLine.
     * Returns (exitCode, combinedOutput).
     *
     * NOTE: Go binaries (gh, fzf) bypass termux-exec LD_PRELOAD — callers
     * that invoke gh must prepend "/system/bin/linker64 <ghPath>" to cmd
     * rather than relying on the linker64 routing provided by LD_PRELOAD.
     * Pure bash/git/node commands work with this helper as-is.
     */
    fun runStreamed(
        env: Map<String, String>,
        cmd: List<String>,
        cwd: File?,
        stdinInput: String? = null,
        onLine: (String) -> Unit,
        timeoutSeconds: Long = 300,
    ): Pair<Int, String> {
        val pb = ProcessBuilder(cmd).redirectErrorStream(true)
        // Wipe inherited env and replace with Bootstrap-built env so that
        // LD_LIBRARY_PATH, LD_PRELOAD, and Termux path overrides are correct.
        pb.environment().clear()
        pb.environment().putAll(env)
        if (cwd != null) pb.directory(cwd)
        val proc = pb.start()

        // Pipe stdin if provided (e.g. `claude -p` reads prompt from stdin
        // rather than a positional arg to avoid shell escaping issues).
        if (stdinInput != null) {
            proc.outputStream.bufferedWriter().use { it.write(stdinInput) }
        }

        val output = StringBuilder()
        proc.inputStream.bufferedReader().useLines { lines ->
            for (line in lines) {
                onLine(line)
                output.append(line).append('\n')
            }
        }
        // Use a bounded wait so runStreamed never hangs indefinitely on a
        // stalled process (e.g. git clone that loses its connection).
        val finished = proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)
        val exit = if (finished) {
            proc.exitValue()
        } else {
            proc.destroyForcibly()
            -1  // Timeout sentinel — callers should treat non-zero as failure.
        }
        return exit to output.toString()
    }

    // ── Issue body builder ────────────────────────────────────────────────

    /**
     * Build the GitHub issue body from the structured SubmitArgs payload.
     * Mirrors buildIssueBody() in desktop/src/main/dev-tools.ts — keep in sync.
     *
     * @param kind         "bug" or "feature"
     * @param summary      one-paragraph summary produced by the summariser
     * @param description  raw user description
     * @param log          redacted log tail (used only for bugs)
     * @param versionName  app versionName from PackageInfo
     * @param osString     e.g. "Android 14"
     */
    fun buildIssueBody(
        kind: String,
        summary: String,
        description: String,
        log: String,
        versionName: String,
        osString: String,
    ): String {
        val header = listOf(
            summary.trim(),
            "",
            "---",
            "**User description:**",
            description.trim(),
            "",
            "**Environment:** YouCoded v$versionName · android · $osString",
        ).joinToString("\n")

        if (kind == "feature") return header

        // Bug reports include a collapsible log block.
        return listOf(
            header,
            "",
            "**Logs:**",
            "<details><summary>desktop.log</summary>",
            "",
            "```",
            log,
            "```",
            "",
            "</details>",
        ).joinToString("\n")
    }

    // ── Summarizer helpers ────────────────────────────────────────────────

    /**
     * Build the prompt string we pass to `claude -p` for summarising a
     * bug report or feature request. Mirrors buildSummarizerPrompt() in
     * dev-tools.ts — keep in sync.
     */
    fun buildSummarizerPrompt(kind: String, description: String, log: String): String {
        val intro = if (kind == "bug")
            "You are summarizing a bug report from a YouCoded user for a GitHub issue."
        else
            "You are summarizing a feature request from a YouCoded user for a GitHub issue."
        val logBlock = if (kind == "bug" && log.isNotEmpty())
            "\n\nThe last lines of their app log are:\n```\n$log\n```"
        else ""
        return buildString {
            append(intro)
            append("\n\nThe user wrote:\n«$description»")
            append(logBlock)
            append("\n\nProduce a JSON object with fields:")
            append("  - title: a one-line GitHub-issue title (≤80 chars)")
            append("  - summary: a one-paragraph summary that captures the user's intent")
            append("  - flagged_strings: an array of strings from the log that look sensitive (paths, IDs, possible secrets)")
            append("\n\nRespond with JSON only — no prose, no markdown fences.")
        }
    }

    /**
     * Parse the JSON envelope emitted by `claude -p`. Falls back gracefully
     * when the model adds ``` fences or when JSON parse fails.
     * Mirrors parseSummary() + fallbackSummary() in dev-tools.ts.
     */
    fun parseSummary(stdout: String, fallbackDescription: String, succeeded: Boolean): JSONObject {
        if (!succeeded) return fallbackSummary(fallbackDescription)
        // Strip ``` fences if the model added them anyway.
        val cleaned = stdout
            .replace(Regex("^```json\\s*", RegexOption.IGNORE_CASE), "")
            .replace(Regex("```\\s*$"), "")
            .trim()
        return try {
            val parsed = JSONObject(cleaned)
            JSONObject().apply {
                put("title", parsed.optString("title", fallbackDescription.take(80)))
                put("summary", parsed.optString("summary", fallbackDescription))
                put("flagged_strings", parsed.optJSONArray("flagged_strings") ?: JSONArray())
            }
        } catch (_: Exception) {
            fallbackSummary(fallbackDescription)
        }
    }

    private fun fallbackSummary(description: String): JSONObject = JSONObject().apply {
        put("title", description.take(80))
        put("summary", description)
        put("flagged_strings", JSONArray())
    }

    // ── Issue URL prefill ─────────────────────────────────────────────────

    /**
     * Build a GitHub new-issue prefill URL for the fallback path when gh
     * is not authenticated. Mirrors buildPrefillUrl() in dev-tools.ts.
     */
    fun buildPrefillUrl(title: String, body: String, label: String): String {
        fun encode(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        return "https://github.com/itsdestin/youcoded/issues/new" +
            "?title=${encode(title)}" +
            "&body=${encode(body)}" +
            "&labels=${encode(label)}"
    }
}
