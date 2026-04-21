package com.youcoded.app.runtime

import com.youcoded.app.skills.LocalSkillProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// Mirrors desktop/src/main/command-provider.ts. Kept in sync manually —
// see docs/cc-dependencies.md entry "CC built-in command list" and
// docs/superpowers/specs/2026-04-21-command-drawer-search-commands-design.md.
//
// Last verified against Claude Code CLI v2.1.116 — 2026-04-21.
class CommandProvider(
  private val homeDir: File,
  private val skillProvider: LocalSkillProvider,
  private val getProjectCwd: () -> String?,
) {
  private var cache: JSONArray? = null

  fun invalidateCache() {
    cache = null
  }

  fun getCommands(): JSONArray {
    cache?.let { return it }

    val claudeDir = File(homeDir, ".claude")
    val entries = mutableListOf<JSONObject>()

    // Source 1: YouCoded-handled (hardcoded)
    entries.addAll(YOUCODED_COMMANDS)

    // Source 2: filesystem — user + project + plugin
    entries.addAll(scanCommandsFromDir(File(claudeDir, "commands"), null))
    getProjectCwd()?.let { cwd ->
      entries.addAll(scanCommandsFromDir(File(File(cwd), ".claude/commands"), null))
    }
    entries.addAll(scanPluginCommands(claudeDir))

    // Source 3: CC built-ins (hardcoded)
    entries.addAll(CC_BUILTIN_COMMANDS)

    // Dedup by name with precedence youcoded > filesystem > cc-builtin.
    // A command whose name matches an existing skill is dropped.
    val sourcePriority = mapOf("youcoded" to 0, "filesystem" to 1, "cc-builtin" to 2)
    val byName = linkedMapOf<String, JSONObject>()
    for (entry in entries) {
      val name = entry.getString("name")
      val existing = byName[name]
      if (existing == null ||
          sourcePriority[entry.getString("source")]!! < sourcePriority[existing.getString("source")]!!) {
        byName[name] = entry
      }
    }

    // Drop commands that collide with skills by name.
    val skillNames = mutableSetOf<String>()
    val skillList = skillProvider.getInstalled()
    for (i in 0 until skillList.length()) {
      val s = skillList.getJSONObject(i)
      skillNames.add("/" + s.getString("displayName"))
    }
    for (name in skillNames) byName.remove(name)

    val result = JSONArray()
    for (entry in byName.values) result.put(entry)
    cache = result
    return result
  }

  private fun scanCommandsFromDir(dir: File, pluginSlug: String?): List<JSONObject> {
    if (!dir.isDirectory) return emptyList()
    val out = mutableListOf<JSONObject>()
    for (file in dir.listFiles { f -> f.isFile && f.name.endsWith(".md") } ?: return emptyList()) {
      val stem = file.nameWithoutExtension
      val description = extractFrontmatterDescription(file.readText())
      val name = if (pluginSlug != null) "/$pluginSlug:$stem" else "/$stem"
      out.add(JSONObject().apply {
        put("name", name)
        put("description", description)
        put("source", "filesystem")
        put("clickable", true)
      })
    }
    return out
  }

  private fun scanPluginCommands(claudeDir: File): List<JSONObject> {
    val marketplaces = File(claudeDir, "plugins/marketplaces")
    if (!marketplaces.isDirectory) return emptyList()
    val out = mutableListOf<JSONObject>()
    for (mp in marketplaces.listFiles { f -> f.isDirectory } ?: return emptyList()) {
      val plugins = File(mp, "plugins")
      if (!plugins.isDirectory) continue
      for (plugin in plugins.listFiles { f -> f.isDirectory } ?: continue) {
        out.addAll(scanCommandsFromDir(File(plugin, "commands"), plugin.name))
      }
    }
    return out
  }

  private fun extractFrontmatterDescription(content: String): String {
    // Normalize CRLF → LF so Windows-authored files don't trip the fence
    // detection or leave \r in captured values (mirrors the desktop fix).
    val normalized = content.replace("\r\n", "\n")
    if (!normalized.startsWith("---")) return ""
    val end = normalized.indexOf("\n---", 3)
    if (end == -1) return ""
    val block = normalized.substring(3, end)
    val match = Regex("(?m)^\\s*description\\s*:\\s*(.+?)\\s*$").find(block) ?: return ""
    var value = match.groupValues[1].trim()
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.substring(1, value.length - 1)
    }
    return value
  }

  companion object {
    private val YOUCODED_COMMANDS: List<JSONObject> = listOf(
      youcoded("/compact",  "Compact conversation with native spinner card"),
      youcoded("/clear",    "Clear conversation timeline with native marker"),
      youcoded("/reset",    "Clear conversation timeline with native marker"),
      youcoded("/new",      "Clear conversation timeline with native marker"),
      youcoded("/model",    "Open native model picker"),
      youcoded("/fast",     "Toggle fast mode"),
      youcoded("/effort",   "Open effort-level picker"),
      youcoded("/copy",     "Copy assistant response to clipboard"),
      youcoded("/resume",   "Open native Resume Browser"),
      youcoded("/config",   "Open Preferences popup"),
      youcoded("/settings", "Open Preferences popup"),
      youcoded("/cost",     "Show native Usage card"),
      youcoded("/usage",    "Show native Usage card"),
    )

    private val CC_BUILTIN_COMMANDS: List<JSONObject> = listOf(
      ccBuiltin("/help",            "Show Claude Code help"),
      ccBuiltin("/status",          "Show session, config, and auth status"),
      ccBuiltin("/permissions",     "Manage tool permissions"),
      ccBuiltin("/memory",          "Edit CLAUDE.md memory files"),
      ccBuiltin("/agents",          "Manage subagents"),
      ccBuiltin("/mcp",             "Manage MCP servers"),
      ccBuiltin("/plugin",          "Manage plugins"),
      ccBuiltin("/hooks",           "Manage hooks"),
      ccBuiltin("/doctor",          "Diagnose the installation"),
      ccBuiltin("/logout",          "Sign out of your Anthropic account"),
      ccBuiltin("/context",         "Show current context-window usage"),
      ccBuiltin("/review",          "Review a pull request"),
      ccBuiltin("/security-review", "Review pending changes for security issues"),
      ccBuiltin("/init",            "Initialize a CLAUDE.md file"),
      ccBuiltin("/extra-usage",     "Show detailed usage data"),
      ccBuiltin("/heapdump",        "Dump a heap snapshot"),
      ccBuiltin("/insights",        "Show session insights"),
      ccBuiltin("/team-onboarding", "Team setup flow"),
    )

    private fun youcoded(name: String, description: String) = JSONObject().apply {
      put("name", name); put("description", description)
      put("source", "youcoded"); put("clickable", true)
    }

    private fun ccBuiltin(name: String, description: String) = JSONObject().apply {
      put("name", name); put("description", description)
      put("source", "cc-builtin"); put("clickable", false)
      put("disabledReason", "Please run $name in Terminal View.")
    }
  }
}
