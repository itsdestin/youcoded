package com.youcoded.app.skills

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL

/**
 * Kotlin port of desktop's marketplace-file-reader.ts. Reads raw markdown for a
 * plugin's SKILL.md / command / agent file so the in-app file viewer can render
 * it. Tries the on-disk install first, then falls back to a raw GitHub URL
 * derived from the marketplace entry's sourceType/sourceRef.
 *
 * We glob instead of assuming a fixed layout — youcoded-core lays skills out
 * under core/skills/, life/skills/, productivity/skills/, while single-layer
 * plugins use skills/<name>/SKILL.md flat.
 */
object MarketplaceFileReader {
    private const val REGISTRY_BASE =
        "https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/master"

    /**
     * Returns `{content, source, path}` on success or `{error}` on failure —
     * shape matches desktop's readComponent() exactly so the renderer can
     * treat both platforms identically.
     */
    fun readComponent(
        homeDir: File,
        pluginId: String,
        kind: String,
        name: String,
        marketplaceIndex: JSONArray,
    ): JSONObject {
        val relatives = relativePathsFor(kind, name)

        // Local first — cheap and works offline.
        val installDir = resolvePluginDir(homeDir, pluginId)
        if (installDir != null) {
            for (rel in relatives) {
                val hit = findLocalFile(installDir, rel)
                if (hit != null) {
                    return JSONObject().apply {
                        put("content", hit.readText())
                        put("source", "local")
                        put("path", hit.absolutePath)
                    }
                }
            }
        }

        // Remote fallback — need the registry entry for sourceType/sourceRef.
        val entry = findEntry(marketplaceIndex, pluginId)
            ?: return JSONObject().put("error", "Plugin not found in marketplace: $pluginId")

        for (rel in relatives) {
            for (url in buildRemoteCandidates(entry, rel)) {
                val content = fetchText(url)
                if (content != null) {
                    return JSONObject().apply {
                        put("content", content)
                        put("source", "remote")
                        put("path", url)
                    }
                }
            }
        }
        return JSONObject().put("error", "File not found: $kind \"$name\" in $pluginId")
    }

    // Core toolkit lives at ~/.claude/plugins/<id>/ (cloned by install.sh);
    // marketplace-installed plugins live under the marketplaces/ subtree.
    private fun resolvePluginDir(homeDir: File, id: String): File? {
        val root = File(homeDir, ".claude/plugins")
        val topLevel = File(root, id)
        if (topLevel.exists()) return topLevel
        val marketplace = File(root, "marketplaces/youcoded/plugins/$id")
        if (marketplace.exists()) return marketplace
        return null
    }

    private fun relativePathsFor(kind: String, name: String): List<String> = when (kind) {
        "skill" -> listOf("skills/$name/SKILL.md")
        "command" -> listOf("commands/$name.md")
        else -> listOf("agents/$name.md")
    }

    // BFS up to maxDepth=4, which covers youcoded-core's
    // core/skills/, life/skills/, productivity/skills/ layouts without
    // descending into node_modules or hidden dirs.
    private fun findLocalFile(rootDir: File, relative: String, maxDepth: Int = 4): File? {
        val direct = File(rootDir, relative)
        if (direct.exists()) return direct

        data class Node(val dir: File, val depth: Int)
        val queue = ArrayDeque<Node>().apply { add(Node(rootDir, 0)) }
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.depth >= maxDepth) continue
            val children = try { node.dir.listFiles() ?: emptyArray() } catch (_: Exception) { emptyArray() }
            for (child in children) {
                if (!child.isDirectory) continue
                if (child.name.startsWith(".") || child.name == "node_modules") continue
                val candidate = File(child, relative)
                if (candidate.exists()) return candidate
                queue.add(Node(child, node.depth + 1))
            }
        }
        return null
    }

    private fun findEntry(index: JSONArray, pluginId: String): JSONObject? {
        for (i in 0 until index.length()) {
            val entry = index.optJSONObject(i) ?: continue
            if (entry.optString("id") == pluginId) return entry
        }
        return null
    }

    // Builds raw.githubusercontent.com URL candidates covering both flat
    // layouts and youcoded-core's layered core/life/productivity prefixes.
    private fun buildRemoteCandidates(entry: JSONObject, relative: String): List<String> {
        val prefixes = listOf("", "core/", "life/", "productivity/")
        val sourceType = entry.optString("sourceType")
        val sourceRef = entry.optString("sourceRef")
        if (sourceRef.isEmpty()) return emptyList()

        if (sourceType == "local") {
            // Plugin lives at <marketplace-repo>/<sourceRef>/...
            return prefixes.map { p -> "$REGISTRY_BASE/$sourceRef/$p$relative" }
        }

        if (sourceType == "url" || sourceType == "git-subdir") {
            val parsed = parseGithubRepo(sourceRef) ?: return emptyList()
            val (owner, repo, branch) = parsed
            val subdir = if (sourceType == "git-subdir") {
                val raw = entry.optString("sourceSubdir").trimEnd('/')
                if (raw.isEmpty()) "" else "$raw/"
            } else ""
            val base = "https://raw.githubusercontent.com/$owner/$repo/$branch"
            return prefixes.map { p -> "$base/$subdir$p$relative" }
        }
        return emptyList()
    }

    private fun parseGithubRepo(url: String): Triple<String, String, String>? {
        val m = Regex("""github\.com/([^/]+)/([^/#]+?)(?:\.git)?(?:#(.+))?$""").find(url) ?: return null
        val branch = m.groupValues[3].ifEmpty { "master" }
        return Triple(m.groupValues[1], m.groupValues[2], branch)
    }

    // Returns body on HTTP 200, null on any failure (404, network, etc).
    // URL().readText() throws on non-2xx, so any exception means "try next".
    private fun fetchText(url: String): String? = try {
        URL(url).readText()
    } catch (_: Exception) {
        null
    }
}
