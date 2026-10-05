// Shared vocabulary for the doc-comments Claude Code MCP server on Android —
// the Kotlin half of desktop/src/shared/doc-comments-mcp.ts (T9c/T20, docs/
// active/specs/2026-09-26-doc-comments-build-design.md §5.3, §9.2). Names two
// Android surfaces that can't import each other must still agree on: the
// deployed server (ClaudeCodeDocCommentsMcp.kt, which writes the byte-
// identical `doc-comments-mcp.js` asset per session) and the permission-auto-
// approve wiring (DocCommentsPermission.kt / ManagedSession.kt) that has to
// recognize a PermissionRequest hook payload for one of these six tools by
// its composed `mcp__{server}__{tool}` name.
//
// WHY the server id is per-deployment random, not this prefix alone
// (adversarial review 2026-09-27, finding #2, ported from the TS file's own
// header): a fixed, public id is guessable by anything that can get its own
// MCP server declared under the same name for the same project. Every real
// server id is `${SERVER_PREFIX}-<8 random hex chars>`, minted fresh per
// session by ClaudeCodeDocCommentsMcp.deploy — this object only builds names
// FROM a caller-supplied id, it never mints one itself.
package com.youcoded.app.doccomments

object DocCommentsMcpNames {
    /** Cosmetic prefix only — matches DOC_COMMENTS_MCP_SERVER_PREFIX in
     *  desktop/src/shared/doc-comments-mcp.ts. The real per-session id is this
     *  plus random hex, minted by ClaudeCodeDocCommentsMcp.deploy. */
    const val SERVER_PREFIX = "youcoded-doc-comments"

    private val MUTATOR_BARE_NAMES = listOf(
        "ReplyToComment",
        "ResolveComment",
        "ReopenComment",
        "AddComment",
        "MoveComment",
    )

    /** Claude Code's own naming convention for an attached MCP tool. */
    fun toolName(serverId: String, bare: String): String = "mcp__${serverId}__$bare"

    /** The one tool always pre-approved via --allowedTools on every target —
     *  a read never mutates the source file or its comment store. */
    fun readTool(serverId: String): String = toolName(serverId, "ReadFileComments")

    /** The five tools whose target CAN be a Word/Excel file's own bytes
     *  (§5.2a, decided option 1) — never allow-listed at spawn time, since the
     *  same tool name also serves a plain-text/markdown/code target that must
     *  stay frictionless. DocCommentsPermission.kt uses this set (rebuilt
     *  from the CALLING session's own serverId, never a cross-session value)
     *  to recognize a PermissionRequest for one of these. */
    fun mutatorTools(serverId: String): List<String> = MUTATOR_BARE_NAMES.map { toolName(serverId, it) }
}
