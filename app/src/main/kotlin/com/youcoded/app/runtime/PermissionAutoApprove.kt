package com.youcoded.app.runtime

import org.json.JSONObject

// Which Claude Code permission asks the app answers "allow" without showing a card.
// Mirror of desktop/src/main/permission-auto-approve.ts — keep the two in lockstep
// (desktop/tests/permission-auto-approve-parity.test.ts reads both never-allow lists).
//
// WHY its own file (2026-09-24): the decision used to live inline in ManagedSession's
// hook collector, where only AskUserQuestion was excluded. With "approve all" on, an
// ExitPlanMode ask was auto-allowed — but Claude Code IGNORES a hook allow for plans
// (measured on 2.1.281, desktop fixture tests/fixtures/plan-menu/
// cc-2.1.281-hook-allow-only-120x40.json: the menu stays up). So the plan card
// vanished while the plan menu still waited in the terminal. A pure function is
// what lets a unit test pin that, without a PTY or a bridge.

// In bypass mode, Claude Code still fires PermissionRequest for protected paths,
// compound cd commands, and AskUserQuestion. These regexes classify each request
// so the user's per-category overrides can selectively auto-approve them.
private val TITLE_HOOK_RE = Regex("""[>|].*[/\\]\.claude[/\\]topics[/\\]topic-""")
private val CONFIG_FILE_RE = Regex("""\.(bashrc|bash_profile|zshrc|zprofile|profile|gitconfig|gitmodules|ripgreprc)\b|\.mcp\.json|\.claude\.json""")
private val PROTECTED_DIR_RE = Regex("""[/\\]\.git[/\\]|[/\\]\.claude[/\\]""")
private val CD_REDIRECT_RE = Regex("""\bcd\b.*[>]""")
private val CD_GIT_RE = Regex("""\bcd\b.*\bgit\b""")

/** Tools that need the user's OWN answer. Claude Code ignores a hook "allow" for
 *  them, so auto-allowing one only hides the card while the question is still
 *  waiting in the terminal. Same set as desktop's NEEDS_THE_USERS_OWN_ANSWER. */
val NEEDS_THE_USERS_OWN_ANSWER: Set<String> = setOf("AskUserQuestion", "ExitPlanMode")

internal fun classifyPermission(toolName: String, toolInput: JSONObject): String {
    val cmd = toolInput.optString("command", "")
    val filePath = toolInput.optString("file_path", "")
    val target = cmd.ifEmpty { filePath }

    if (toolName == "Bash" && TITLE_HOOK_RE.containsMatchIn(cmd)) return "titleHook"
    if (toolName == "Bash") {
        if (CD_GIT_RE.containsMatchIn(cmd)) return "compoundCdGit"
        if (CD_REDIRECT_RE.containsMatchIn(cmd)) return "compoundCdRedirect"
    }
    if (CONFIG_FILE_RE.containsMatchIn(target)) return "protectedConfigFiles"
    if (PROTECTED_DIR_RE.containsMatchIn(target)) return "protectedDirectories"
    return "unknown"
}

/** Should the app answer this PermissionRequest "allow" without showing a card? */
fun shouldAutoApprove(toolName: String, toolInput: JSONObject, overrides: JSONObject): Boolean {
    // Checked FIRST, before approve-all and the title hook — see the file header.
    if (toolName in NEEDS_THE_USERS_OWN_ANSWER) return false
    val category = classifyPermission(toolName, toolInput)
    // Title hooks are always auto-approved (they fire every few minutes).
    if (category == "titleHook") return true
    if (overrides.optBoolean("approveAll", false)) return true
    return category != "unknown" && overrides.optBoolean(category, false)
}
