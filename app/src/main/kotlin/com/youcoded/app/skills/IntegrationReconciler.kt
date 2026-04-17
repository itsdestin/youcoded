package com.youcoded.app.skills

import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Integration Reconciler (decomposition v3, §4)
 *
 * Kotlin mirror of desktop/src/main/integration-reconciler.ts. Scans
 * ~/.claude/plugins/ * /plugin.json for `provides` and `optionalIntegrations`,
 * merges across all installed plugins, and writes ~/.claude/integration-context.md
 * which session-start.sh injects into the session preamble.
 *
 * Output format is locked — see spike-test-scenarios.md. Any change to the
 * markdown table shape must be re-validated against those scenarios.
 */
class IntegrationReconciler(private val homeDir: File) {

    data class Result(val rowCount: Int, val providerCount: Int, val outputPath: String)

    private data class ProviderEntry(val packageName: String)
    private data class Row(
        val capability: String,
        val installed: Boolean,
        val provider: String?,
        val instruction: String,
    )

    private val outputFile = File(homeDir, ".claude/integration-context.md")

    /** Read either <plugin>/.claude-plugin/plugin.json or <plugin>/plugin.json */
    private fun readManifest(pluginDir: File): JSONObject? {
        val candidates = listOf(
            File(pluginDir, ".claude-plugin/plugin.json"),
            File(pluginDir, "plugin.json"),
        )
        for (f in candidates) {
            if (!f.exists()) continue
            try {
                return JSONObject(f.readText())
            } catch (e: Exception) {
                // Malformed JSON — skip this one, keep reconciling the rest
                Log.w(TAG, "Failed to parse manifest: ${f.absolutePath}", e)
            }
        }
        return null
    }

    private fun listManifests(): List<JSONObject> =
        // Walk both the toolkit root and the marketplace subtree.
        ClaudeCodeRegistry.listInstalledPluginDirs(homeDir)
            .mapNotNull { readManifest(it) }
            .filter { it.optString("name").isNotEmpty() }

    /** First-write-wins on capability collisions (shouldn't happen in practice). */
    private fun buildProviderMap(manifests: List<JSONObject>): Map<String, ProviderEntry> {
        val map = mutableMapOf<String, ProviderEntry>()
        for (m in manifests) {
            val provides = m.optJSONObject("provides") ?: continue
            val keys = provides.keys()
            while (keys.hasNext()) {
                val cap = keys.next()
                if (!map.containsKey(cap)) {
                    map[cap] = ProviderEntry(m.optString("name"))
                }
            }
        }
        return map
    }

    private fun buildRows(
        manifests: List<JSONObject>,
        providers: Map<String, ProviderEntry>,
    ): List<Row> {
        val seen = mutableSetOf<String>()
        val rows = mutableListOf<Row>()
        for (m in manifests) {
            val integrations = m.optJSONObject("optionalIntegrations") ?: continue
            val keys = integrations.keys()
            while (keys.hasNext()) {
                val cap = keys.next()
                if (!seen.add(cap)) continue
                val integration = integrations.optJSONObject(cap) ?: continue
                val provider = providers[cap]
                if (provider != null) {
                    rows.add(Row(cap, true, provider.packageName,
                        integration.optString("whenAvailable")))
                } else {
                    rows.add(Row(cap, false, null,
                        integration.optString("whenUnavailable")))
                }
            }
        }
        return rows
    }

    private fun renderContext(rows: List<Row>): String {
        if (rows.isEmpty()) {
            return "## Skill Integration Status\n\nNo cross-skill integrations are currently declared.\n"
        }
        val sb = StringBuilder()
        sb.append("## Skill Integration Status\n\n")
        sb.append("The following cross-skill integrations are active based on installed packages. When a skill or workflow would normally invoke one of these capabilities, follow the instruction in the rightmost column.\n\n")
        sb.append("| Capability | Status | Instruction |\n")
        sb.append("|------------|--------|-------------|\n")
        for (r in rows) {
            val status = if (r.installed) "Installed (${r.provider})" else "Not installed"
            // Escape pipes so the markdown table doesn't split mid-instruction
            val instruction = r.instruction.replace("|", "\\|")
            sb.append("| `${r.capability}` | $status | $instruction |\n")
        }
        sb.append("\n")
        sb.append("When a skill references one of these capabilities in its instructions, follow the instruction in the rightmost column instead of the skill's original reference. If a capability is not listed here, handle the request generically.\n")
        return sb.toString()
    }

    /** tmp + rename so session-start.sh never reads a partial file. */
    private fun writeAtomic(file: File, content: String) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.${android.os.Process.myPid()}.tmp")
        tmp.writeText(content)
        if (!tmp.renameTo(file)) {
            // Fallback: overwrite directly if rename fails (e.g., across partitions)
            file.writeText(content)
            tmp.delete()
        }
    }

    fun reconcile(): Result {
        val manifests = listManifests()
        val providers = buildProviderMap(manifests)
        val rows = buildRows(manifests, providers)
        val content = renderContext(rows)
        writeAtomic(outputFile, content)
        return Result(rows.size, providers.size, outputFile.absolutePath)
    }

    companion object {
        private const val TAG = "IntegrationReconciler"
    }
}
