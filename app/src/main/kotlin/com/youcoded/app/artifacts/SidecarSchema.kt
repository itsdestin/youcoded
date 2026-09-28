// Mirror of desktop/src/shared/artifacts/types.ts.
// Uses org.json for marshalling (consistent with the rest of the Android codebase).
// All ISO 8601 timestamps use Instant.now().toString() which produces the same
// format as JS new Date().toISOString() (e.g. "2026-05-22T01:23:45.678Z").
package com.youcoded.app.artifacts

import org.json.JSONArray
import org.json.JSONObject

// ── Schema version constants (mirror of types.ts) ───────────────────────────

const val SIDECAR_SCHEMA_VERSION = 1
const val INDEX_SCHEMA_VERSION   = 1

// ── Enum-style type aliases (kept as strings to avoid cross-boundary issues) ─

typealias ArtifactKind   = String  // "internal" | "external"
typealias ArtifactStatus = String  // "active" | "deleted"
typealias VersionAuthor  = String  // "agent" | "user"
typealias VersionType    = String  // "create" | "edit" | "delete" | "read" | "delivered"

// ── Data classes ─────────────────────────────────────────────────────────────

data class VersionEvent(
    val id:        String,  // ULID
    val ts:        String,  // ISO 8601
    val sessionId: String,
    val type:      VersionType,
    val author:    VersionAuthor,
    // Mirror of types.ts VersionEvent.toolUseId (2026-08-15): the transcript
    // tool_use id behind this version, optional and additive. appendVersion
    // dedupes on (sessionId, toolUseId) so re-opening a conversation — which
    // replays every tool call through the tracker — no longer appends the same
    // edits again. Android runs the same React tracker against its own
    // per-device sidecar, so it needs the same key, round-tripped through
    // toJson/toVersionEvent (org.json marshalling drops unknown fields).
    val toolUseId: String? = null,
    // Mirror of types.ts VersionEvent.conversationId: the conversation's own id
    // when it differs from sessionId (a Claude Code session's id, which a
    // resume keeps). Desktop stamps it; round-tripped here so a record never
    // loses it (org.json marshalling drops unknown fields).
    val conversationId: String? = null,
)

data class ArtifactRecord(
    val id:           String,          // ULID
    val path:         String,          // canonical, relative if kind='internal'
    val kind:         ArtifactKind,
    val absolutePath: String?,         // canonical, set when kind='external'
    var lastModified: String,          // cache, advisory
    var status:       ArtifactStatus,  // derived from latest version
    val versions:     MutableList<VersionEvent> = mutableListOf(),
    val comments:     MutableList<Any> = mutableListOf(),  // empty in v1
    val tags:         MutableList<String> = mutableListOf(),
)

data class ManualInclude(
    val path:    String,  // canonical absolute
    val addedAt: String,
    val addedBy: String = "user",
)

data class ProjectSidecar(
    val schema:         Int    = SIDECAR_SCHEMA_VERSION,  // maps to $schema in JSON
    val projectId:      String,
    val name:           String,
    val createdAt:      String,
    var updatedAt:      String,
    val artifacts:      MutableList<ArtifactRecord> = mutableListOf(),
    val manualExcludes: MutableList<String> = mutableListOf(),
    val manualIncludes: MutableList<ManualInclude> = mutableListOf(),
)

data class CentralIndexProject(
    val id:           String,
    val name:         String,
    val path:         String,           // canonical absolute
    val lastIndexed:  String,
    val lastSession:  String?,
    val contentTypes: List<String>,     // "artifacts" | "conversations"
    val stats:        IndexStats,
)

data class IndexStats(
    val artifactCount: Int,
)

data class CentralIndex(
    val schema:   Int = INDEX_SCHEMA_VERSION,  // maps to $schema in JSON
    val projects: MutableList<CentralIndexProject> = mutableListOf(),
)

// ── JSON serialisation helpers ───────────────────────────────────────────────

// VersionEvent ↔ JSONObject

fun VersionEvent.toJson(): JSONObject = JSONObject().apply {
    put("id",        id)
    put("ts",        ts)
    put("sessionId", sessionId)
    put("type",      type)
    put("author",    author)
    // Omitted when absent (not written as null) so records that never had one
    // stay byte-identical to what desktop writes.
    if (toolUseId != null) put("toolUseId", toolUseId)
    if (conversationId != null) put("conversationId", conversationId)
}

fun JSONObject.toVersionEvent() = VersionEvent(
    id        = getString("id"),
    ts        = getString("ts"),
    sessionId = getString("sessionId"),
    type      = getString("type"),
    author    = getString("author"),
    toolUseId = if (has("toolUseId") && !isNull("toolUseId")) getString("toolUseId") else null,
    conversationId = if (has("conversationId") && !isNull("conversationId")) getString("conversationId") else null,
)

// ArtifactRecord ↔ JSONObject

fun ArtifactRecord.toJson(): JSONObject = JSONObject().apply {
    put("id",           id)
    put("path",         path)
    put("kind",         kind)
    if (absolutePath != null) put("absolutePath", absolutePath) else put("absolutePath", JSONObject.NULL)
    put("lastModified", lastModified)
    put("status",       status)
    put("versions",     JSONArray(versions.map { it.toJson() }))
    put("comments",     JSONArray())  // empty in v1
    put("tags",         JSONArray(tags))
}

fun JSONObject.toArtifactRecord(): ArtifactRecord {
    val versionsArr = optJSONArray("versions") ?: JSONArray()
    val vList = (0 until versionsArr.length()).map { versionsArr.getJSONObject(it).toVersionEvent() }
    val tagsArr = optJSONArray("tags") ?: JSONArray()
    val tList  = (0 until tagsArr.length()).map { tagsArr.getString(it) }
    return ArtifactRecord(
        id           = getString("id"),
        path         = getString("path"),
        kind         = getString("kind"),
        absolutePath = if (isNull("absolutePath")) null else optString("absolutePath"),
        lastModified = getString("lastModified"),
        status       = getString("status"),
        versions     = vList.toMutableList(),
        tags         = tList.toMutableList(),
    )
}

// ManualInclude ↔ JSONObject

fun ManualInclude.toJson(): JSONObject = JSONObject().apply {
    put("path",    path)
    put("addedAt", addedAt)
    put("addedBy", addedBy)
}

fun JSONObject.toManualInclude() = ManualInclude(
    path    = getString("path"),
    addedAt = getString("addedAt"),
    addedBy = optString("addedBy", "user"),
)

// ProjectSidecar ↔ JSONObject

fun ProjectSidecar.toJson(): JSONObject = JSONObject().apply {
    put("\$schema",       schema)
    put("projectId",      projectId)
    put("name",           name)
    put("createdAt",      createdAt)
    put("updatedAt",      updatedAt)
    put("artifacts",      JSONArray(artifacts.map { it.toJson() }))
    put("manualExcludes", JSONArray(manualExcludes))
    put("manualIncludes", JSONArray(manualIncludes.map { it.toJson() }))
}

fun JSONObject.toProjectSidecar(): ProjectSidecar {
    val artArr  = optJSONArray("artifacts")      ?: JSONArray()
    val exArr   = optJSONArray("manualExcludes") ?: JSONArray()
    val incArr  = optJSONArray("manualIncludes") ?: JSONArray()
    return ProjectSidecar(
        schema         = optInt("\$schema", SIDECAR_SCHEMA_VERSION),
        projectId      = getString("projectId"),
        name           = getString("name"),
        createdAt      = getString("createdAt"),
        updatedAt      = getString("updatedAt"),
        artifacts      = (0 until artArr.length()).map { artArr.getJSONObject(it).toArtifactRecord() }.toMutableList(),
        manualExcludes = (0 until exArr.length()).map  { exArr.getString(it) }.toMutableList(),
        manualIncludes = (0 until incArr.length()).map { incArr.getJSONObject(it).toManualInclude() }.toMutableList(),
    )
}

// CentralIndexProject ↔ JSONObject

fun CentralIndexProject.toJson(): JSONObject = JSONObject().apply {
    put("id",           id)
    put("name",         name)
    put("path",         path)
    put("lastIndexed",  lastIndexed)
    if (lastSession != null) put("lastSession", lastSession) else put("lastSession", JSONObject.NULL)
    put("contentTypes", JSONArray(contentTypes))
    put("stats",        JSONObject().apply { put("artifactCount", stats.artifactCount) })
}

fun JSONObject.toCentralIndexProject(): CentralIndexProject {
    val ctArr = optJSONArray("contentTypes") ?: JSONArray()
    val statsObj = optJSONObject("stats")
    return CentralIndexProject(
        id           = getString("id"),
        name         = getString("name"),
        path         = getString("path"),
        lastIndexed  = getString("lastIndexed"),
        lastSession  = if (isNull("lastSession")) null else optString("lastSession"),
        contentTypes = (0 until ctArr.length()).map { ctArr.getString(it) },
        stats        = IndexStats(artifactCount = statsObj?.optInt("artifactCount", 0) ?: 0),
    )
}

// CentralIndex ↔ JSONObject

fun CentralIndex.toJson(): JSONObject = JSONObject().apply {
    put("\$schema", schema)
    put("projects", JSONArray(projects.map { it.toJson() }))
}

fun JSONObject.toCentralIndex(): CentralIndex {
    val projArr = optJSONArray("projects") ?: JSONArray()
    return CentralIndex(
        schema   = optInt("\$schema", INDEX_SCHEMA_VERSION),
        projects = (0 until projArr.length()).map { projArr.getJSONObject(it).toCentralIndexProject() }.toMutableList(),
    )
}
