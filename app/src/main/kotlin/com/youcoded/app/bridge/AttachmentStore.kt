package com.youcoded.app.bridge

import java.io.File
import java.io.InputStream

/**
 * The app's private copies of files picked with the paperclip (files/tmp/attachments/<pick>/<name>).
 *
 * WHY (2026-11-09 final review, Q-15): the copies were never deleted, had no size limit, and a failed copy
 * showed nothing at all, as if the person had cancelled. Attaching a long video a few times quietly filled
 * the phone. Now: a copy older than seven days is removed, a file over the limit is refused, and both a refusal
 * and a failure come back as a sentence the app shows. Kept free of Android classes so it is unit-tested.
 */
object AttachmentStore {
    /** Larger than anything the assistant can usefully read; small enough that a few picks cannot fill a phone. */
    const val MAX_BYTES = 100L * 1024 * 1024
    // WHY seven days, not one (Destin, 2026-11-10): coming back to a chat two days later, "the file I sent" was gone.
    const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

    /** Longest file name kept, in UTF-8 bytes (filesystems limit bytes, not letters; 255 is the usual ceiling). */
    const val MAX_NAME_BYTES = 200

    /**
     * Make a picked file's display name safe to use as a file name, keeping letters of every script.
     * WHY (Destin, 2026-11-17: "keep accented letters in file names"): the old rule replaced everything outside
     * A-Z/0-9 with "_", so "résumé.pdf" became "r_sum_.pdf" and Chinese or Russian names became all underscores.
     * Only what is genuinely unsafe is replaced: folder separators, control and invisible direction-switching
     * characters, and characters Windows/FAT/exFAT refuse (\ / : * ? " < > |) because the file may be copied to
     * such a drive. Downstream is fine with Unicode: the desktop backend hands the path to Claude Code as a
     * JSON-quoted string (claude-queue-wire.ts), which carries any Unicode and escapes quotes.
     */
    fun safeName(raw: String?): String {
        val fallback = "attachment"
        var name = java.text.Normalizer.normalize(raw ?: "", java.text.Normalizer.Form.NFC)
        name = name.substringAfterLast('/').substringAfterLast('\\') // no folders
        val sb = StringBuilder()
        var i = 0
        while (i < name.length) {
            val cp = name.codePointAt(i); i += Character.charCount(cp)
            val type = Character.getType(cp)
            val bad = cp < 0x20 || cp == 0x7F || "\\/:*?\"<>|".indexOf(cp.toChar()) >= 0 && cp < 0x80 ||
                type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt() || type == Character.SURROGATE.toInt() ||
                type == Character.UNASSIGNED.toInt() || type == Character.LINE_SEPARATOR.toInt() || type == Character.PARAGRAPH_SEPARATOR.toInt()
            sb.appendCodePoint(if (bad) '_'.code else cp)
        }
        // A leading dot would make a hidden file or ".." traversal; trailing dots/spaces are refused by Windows/FAT.
        name = sb.toString().trimStart('.', ' ').trimEnd('.', ' ')
        if (name.isEmpty() || name.all { it == '_' }) return fallback
        // Cap by bytes, shortening the part before the extension so ".pdf" survives.
        if (name.toByteArray(Charsets.UTF_8).size > MAX_NAME_BYTES) {
            val dot = name.lastIndexOf('.')
            var ext = if (dot > 0 && name.length - dot <= 16) name.substring(dot) else ""
            if (ext.toByteArray(Charsets.UTF_8).size > 40) ext = ""
            var stem = name.substring(0, name.length - ext.length)
            val budget = MAX_NAME_BYTES - ext.toByteArray(Charsets.UTF_8).size
            while (stem.isNotEmpty() && stem.toByteArray(Charsets.UTF_8).size > budget) {
                stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1)) // never split a letter in half
            }
            name = (stem.trimEnd('.', ' ') + ext).ifEmpty { fallback }
        }
        return name
    }

    /** A picked file that was not attached, with the sentence to show. */
    class Refused(message: String) : Exception(message)

    /** Remove every pick folder last written more than seven days ago. Never throws: clean-up must not block a pick. */
    fun sweep(root: File, now: Long = System.currentTimeMillis()) {
        runCatching {
            root.listFiles()?.forEach { pick ->
                // The newest file inside decides, so a folder still being written is never removed.
                val newest = (pick.listFiles()?.maxOfOrNull { it.lastModified() } ?: 0L).coerceAtLeast(pick.lastModified())
                if (now - newest > MAX_AGE_MS) pick.deleteRecursively()
            }
        }
    }

    /**
     * Copy [input] to a new folder under [root] as [name]; returns the copy.
     * Throws [Refused] past [maxBytes] (the size is often unknown up front, so it is counted while copying)
     * and leaves nothing behind when it fails.
     */
    fun save(root: File, name: String, input: InputStream, maxBytes: Long = MAX_BYTES, now: Long = System.currentTimeMillis()): File {
        root.mkdirs()
        // Each pick gets its own folder, so the path's last part is the real file name and two picks of
        // "image.jpg" cannot overwrite each other (2026-11-01 phone test).
        var folder = File(root, "$now")
        var n = 0
        while (!folder.mkdirs()) {
            if (++n > 1000) throw Refused("The phone could not make room for $name.")
            folder = File(root, "$now-$n")
        }
        val out = File(folder, name)
        try {
            input.use { i ->
                out.outputStream().use { o ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val read = i.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > maxBytes) throw Refused("$name is larger than ${maxBytes / (1024 * 1024)} MB, so it was not attached.")
                        o.write(buffer, 0, read)
                    }
                }
            }
            return out
        } catch (e: Exception) {
            folder.deleteRecursively()
            throw e
        }
    }
}
