// Kotlin port of desktop/src/main/artifacts/artifact-store.ts.
//
// Provides readSidecar, writeSidecar, and appendVersion — the three
// operations that mutate the per-project .youcoded/artifacts.json sidecar.
//
// CAS concurrency model is identical to the TS implementation:
//   - Read the current sidecar to get the expectedUpdatedAt
//   - Mutate in memory
//   - casWrite with the old updatedAt as the CAS guard
//   - Retry up to MAX_RETRIES times on CAS conflict
//
// ULID note: this port uses a minimal Crockford-base32 ULID generator
// (~30 lines) because there is no ULID library already in the project deps.
// The generator produces spec-compliant ULIDs (48-bit ms timestamp +
// 80-bit cryptographically random suffix, Crockford alphabet) that are
// compatible with the desktop side's `ulid` npm package output.
package com.youcoded.app.artifacts

import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.time.Instant

const val SIDECAR_RELATIVE = ".youcoded/artifacts.json"

private const val MAX_RETRIES = 5

// ── ULID generation ──────────────────────────────────────────────────────────
// Crockford Base32 alphabet (lowercase not used — ULID spec uses uppercase)
private val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
private val rng = SecureRandom()

/**
 * Generate a spec-compliant ULID.
 * Format: 10 timestamp chars (48-bit ms) + 16 random chars (80-bit) = 26 chars.
 * Matches the output format of the `ulid` npm package used on the desktop side.
 */
fun generateUlid(): String {
    val ms = System.currentTimeMillis()
    val sb = StringBuilder(26)

    // Encode 48-bit timestamp into 10 Crockford-base32 chars (big-endian)
    var ts = ms
    val tsPart = CharArray(10)
    for (i in 9 downTo 0) {
        tsPart[i] = CROCKFORD[(ts and 0x1F).toInt()]
        ts = ts shr 5
    }
    sb.append(tsPart)

    // Encode 80 random bits into 16 Crockford-base32 chars
    val randBytes = ByteArray(10)
    rng.nextBytes(randBytes)
    // Pack 10 bytes (80 bits) into 16 base32 chars via 5-bit windows
    var bits = 0L
    var bitCount = 0
    for (b in randBytes) {
        bits = (bits shl 8) or (b.toLong() and 0xFF)
        bitCount += 8
        while (bitCount >= 5) {
            bitCount -= 5
            sb.append(CROCKFORD[((bits shr bitCount) and 0x1F).toInt()])
        }
    }

    return sb.toString()
}

fun newArtifactId(): String = "art_${generateUlid()}"
fun newVersionId():  String = "ver_${generateUlid()}"
fun newProjectId():  String = generateUlid()

// ── ReadResult ───────────────────────────────────────────────────────────────

sealed class ReadResult {
    data class Ok(val sidecar: ProjectSidecar) : ReadResult()
    object Missing : ReadResult()
    object Corrupted : ReadResult()
}

// ── Core operations ──────────────────────────────────────────────────────────

/**
 * Read the sidecar for [projectRoot], returning null when the file does not
 * exist. On JSON parse failure, backs up the corrupt file and returns
 * ReadResult.Corrupted (mirrors the TS `{ corrupted: true }` branch).
 */
fun readSidecar(projectRoot: String): ReadResult {
    val file = File(projectRoot, SIDECAR_RELATIVE)
    if (!file.exists()) return ReadResult.Missing
    val raw = try {
        file.readText(Charsets.UTF_8)
    } catch (e: Exception) {
        return ReadResult.Missing
    }
    return try {
        val obj = JSONObject(raw)
        ReadResult.Ok(obj.toProjectSidecar())
    } catch (_: Exception) {
        // Corruption detected — back up and signal recovery
        val ts = Instant.now().toString().replace(":", "-").replace(".", "-")
        try { file.copyTo(File("${file.absolutePath}.bak.$ts"), overwrite = true) } catch (_: Exception) {}
        ReadResult.Corrupted
    }
}

/**
 * Advance [candidate] past [expected] when the two would collide. Mirrors
 * bumpPastExpected() in desktop/src/main/artifacts/artifact-store.ts — see that
 * file for the full rationale.
 *
 * Short version: updatedAt is the CAS comparand and it has millisecond
 * resolution, so two writers inside one millisecond used to leave the on-disk
 * token identical to the value a concurrent reader had already read. That
 * reader's CAS then passed on stale data (ABA) and clobbered the other record.
 * Making every committed write strictly increase the token removes the race.
 *
 * Unlike the TS side, this compares parsed Instants rather than strings:
 * Instant.toString() omits trailing zero sub-second digits, so its output is
 * NOT fixed-width and lexicographic comparison would be wrong.
 */
private fun bumpPastExpected(candidate: String, expected: String?): String {
    if (expected == null) return candidate
    val exp = try { Instant.parse(expected) } catch (_: Exception) { return candidate }
    val cand = try { Instant.parse(candidate) } catch (_: Exception) { return candidate }
    return if (cand.isAfter(exp)) candidate else exp.plusMillis(1).toString()
}

/**
 * Write [next] to the sidecar, guarded by CAS on [expectedUpdatedAt].
 * Returns committed=false on CAS conflict (caller should re-read and retry).
 */
fun writeSidecar(
    projectRoot:       String,
    expectedUpdatedAt: String?,
    next:              ProjectSidecar,
    // ROADMAP L696: true only for the corruption-recovery path, which means to
    // overwrite an unreadable sidecar. A plain creation leaves this false so
    // casWrite refuses if a sidecar appeared underneath it.
    replaceAny:        Boolean = false,
): Boolean {
    val path = File(projectRoot, SIDECAR_RELATIVE).absolutePath
    // Enforced here, not in callers, so every Android sidecar writer inherits
    // it — same placement as the TS writeSidecar.
    next.updatedAt = bumpPastExpected(next.updatedAt, expectedUpdatedAt)
    val json = next.toJson().toString(2)
    val result = casWrite(
        target            = path,
        expectedUpdatedAt = expectedUpdatedAt,
        content           = json,
        // ROADMAP L696: the extractor goes in whenever there is a token to
        // compare. It used to be dropped for a null expectation, which turned
        // the whole check off — casWrite now decides, and for a null
        // expectation it does a cheap existence check that reads nothing.
        extractUpdatedAt  = if (expectedUpdatedAt == null) null
                            else { raw -> JSONObject(raw).getString("updatedAt") },
        replaceAny        = replaceAny,
    )
    return result.committed
}

/**
 * Input for [appendVersion] — mirrors TS AppendVersionInput.
 */
data class AppendVersionInput(
    val path:         String,   // canonical
    val kind:         String,   // "internal" | "external"
    val absolutePath: String?,
    val sessionId:    String,
    val type:         String,   // "create" | "edit" | "delete" | "read" | "delivered"
    val author:       String,   // "agent" | "user"
    // Replay-dedupe key — see VersionEvent.toolUseId. Null keeps always-append.
    val toolUseId:    String? = null,
)

/**
 * Append a new VersionEvent to the artifact at [input.path], creating the
 * sidecar and/or ArtifactRecord if they do not yet exist.
 *
 * Uses an optimistic CAS retry loop (up to MAX_RETRIES) identical to the TS
 * implementation. Returns true if the version was committed.
 */
fun appendVersion(
    projectRoot: String,
    projectId:   String,
    projectName: String,
    input:       AppendVersionInput,
): Boolean {
    for (attempt in 0 until MAX_RETRIES) {
        // ROADMAP L696: Missing and Corrupted are NOT the same write. Missing
        // means create, and must be refused if a sidecar appeared while we
        // built this one (the lost-record race). Corrupted means a file IS
        // there and replacing it is the point, so it opts in explicitly.
        val (sidecar, expectedUpdatedAt, replaceAny) = when (val current = readSidecar(projectRoot)) {
            is ReadResult.Missing, is ReadResult.Corrupted -> {
                val now = Instant.now().toString()
                val fresh = ProjectSidecar(
                    projectId = projectId,
                    name      = projectName,
                    createdAt = now,
                    updatedAt = now,
                )
                Triple(fresh, null, current is ReadResult.Corrupted)
            }
            is ReadResult.Ok -> Triple(current.sidecar, current.sidecar.updatedAt, false)
        }

        val existing = sidecar.artifacts.find { it.path == input.path && it.kind == input.kind }
        // Replay dedupe (mirror of artifact-store.ts appendVersionsDirect): the
        // same tool call recorded once already ⇒ nothing to add, nothing to
        // write. Same sessionId AND same toolUseId — never toolUseId alone.
        if (existing != null && input.toolUseId != null &&
            existing.versions.any { it.sessionId == input.sessionId && it.toolUseId == input.toolUseId }
        ) return true

        val now = Instant.now().toString()
        val versionEvent = VersionEvent(
            id        = newVersionId(),
            ts        = now,
            sessionId = input.sessionId,
            type      = input.type,
            author    = input.author,
            toolUseId = input.toolUseId,
        )

        if (existing != null) {
            existing.versions.add(versionEvent)
            // Fix (2026-08-25): a 'read' or 'delivered' version is not a modification.
            // Desktop already skips the bump for 'read' (artifact-store.ts); this store
            // bumped unconditionally, so a viewed/delivered file jumped to the top of
            // "recently modified" on the phone and the synced sidecar disagreed across
            // devices. Delivery ≠ modification (spec 2026-08-25 §4.2).
            if (input.type != "read" && input.type != "delivered") existing.lastModified = now
            existing.status = if (input.type == "delete") "deleted" else "active"
        } else {
            sidecar.artifacts.add(
                ArtifactRecord(
                    id           = newArtifactId(),
                    path         = input.path,
                    kind         = input.kind,
                    absolutePath = input.absolutePath,
                    lastModified = now,
                    status       = if (input.type == "delete") "deleted" else "active",
                    versions     = mutableListOf(versionEvent),
                )
            )
        }

        // Retention (mirror of artifact-store.ts appendVersionsDirect). WHY
        // HERE: pruning lives in the writer, in the same cycle that appends, so
        // artifacts.json is bounded BY CONSTRUCTION. That is why there is no
        // migration, no one-shot repair and no startup scan — the first
        // question a reader asks. An already-oversized file heals on its next
        // write; one that is never written again was never growing.
        //
        // It sweeps EVERY record so an oversized file heals in one write rather
        // than file-by-file, and it runs BELOW the dedupe early-return above,
        // so "a re-opened conversation writes nothing" still holds.
        //
        // Policy and safety floor: VersionRetention.kt.
        pruneSidecarVersions(sidecar)

        sidecar.updatedAt = now

        if (writeSidecar(projectRoot, expectedUpdatedAt, sidecar, replaceAny)) return true

        // CAS conflict — backoff mirrors TS: sleep(10 * (attempt + 1))
        if (attempt < MAX_RETRIES - 1) {
            Thread.sleep(10L * (attempt + 1))
        }
    }
    return false
}
