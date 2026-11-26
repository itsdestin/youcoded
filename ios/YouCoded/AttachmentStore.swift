import Foundation

/// The app's private copies of files picked with the paperclip (tmp/attachments/<pick>/<name>).
///
/// The same rules as Android's AttachmentStore.kt (2026-11-09 final review, Q-15): a copy older than seven days is
/// removed, a file over the limit is refused, and both a refusal and a failure come back as a sentence the app
/// shows — a failed pick must never look like cancelling. Pure Foundation, unit tested (AttachmentStoreTests).
enum AttachmentStore {
    /// Larger than anything the assistant can usefully read; small enough that a few picks cannot fill a phone.
    static let maxBytes: Int64 = 100 * 1024 * 1024
    static let maxAge: TimeInterval = 7 * 24 * 60 * 60
    /// Longest file name kept, in UTF-8 bytes (filesystems limit bytes, not letters).
    static let maxNameBytes = 200

    /// A picked file that was not attached, with the sentence to show.
    struct Refused: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Make a picked file's name safe to use as a file name, keeping letters of every script: only folder
    /// separators, control and invisible direction-switching characters, and characters Windows/FAT refuse are
    /// replaced (the file may later be copied to such a drive).
    static func safeName(_ raw: String?) -> String {
        let fallback = "attachment"
        var name = (raw ?? "").precomposedStringWithCanonicalMapping
        if let cut = name.lastIndex(where: { $0 == "/" || $0 == "\\" }) { name = String(name[name.index(after: cut)...]) }
        var scalars = String.UnicodeScalarView()
        for scalar in name.unicodeScalars {
            let category = scalar.properties.generalCategory
            let bad = scalar.value < 0x20 || scalar.value == 0x7F
                || "\\/:*?\"<>|".unicodeScalars.contains(scalar)
                || category == .control || category == .format || category == .surrogate || category == .unassigned
                || category == .lineSeparator || category == .paragraphSeparator
            scalars.append(bad ? "_" : scalar)
        }
        let trimSet = CharacterSet(charactersIn: ". ")
        name = String(scalars)
        // A leading dot would make a hidden file or ".." traversal; trailing dots/spaces are refused by Windows/FAT.
        while let first = name.unicodeScalars.first, trimSet.contains(first) { name.removeFirst() }
        while let last = name.unicodeScalars.last, trimSet.contains(last) { name.removeLast() }
        if name.isEmpty || name.allSatisfy({ $0 == "_" }) { return fallback }
        if name.utf8.count > maxNameBytes {
            var ext = ""
            if let dot = name.lastIndex(of: "."), dot != name.startIndex, name.distance(from: dot, to: name.endIndex) <= 16 {
                ext = String(name[dot...])
            }
            if ext.utf8.count > 40 { ext = "" }
            var stem = String(name.dropLast(ext.count))
            let budget = maxNameBytes - ext.utf8.count
            // Characters, not bytes, are removed, so a letter is never split in half.
            while !stem.isEmpty, stem.utf8.count > budget { stem.removeLast() }
            while let last = stem.unicodeScalars.last, trimSet.contains(last) { stem.removeLast() }
            name = stem + ext
            if name.isEmpty { name = fallback }
        }
        return name
    }

    /// Remove every pick folder last written more than seven days ago. Never throws: clean-up must not block a pick.
    static func sweep(root: URL, now: Date = Date()) {
        let fm = FileManager.default
        guard let picks = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for pick in picks {
            var newest = (try? pick.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            // The newest file inside decides, so a folder still being written is never removed.
            if let files = try? fm.contentsOfDirectory(at: pick, includingPropertiesForKeys: [.contentModificationDateKey]) {
                for file in files {
                    if let date = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, date > newest { newest = date }
                }
            }
            if now.timeIntervalSince(newest) > maxAge { try? fm.removeItem(at: pick) }
        }
    }

    /// Copy `source` into a new folder under `root` as `name`; returns the copy. Each pick gets its own folder, so
    /// the path's last part is the real file name and two picks of "image.jpg" cannot overwrite each other.
    static func save(root: URL, name: String, source: URL, maxBytes: Int64 = AttachmentStore.maxBytes, now: Date = Date()) throws -> URL {
        let fm = FileManager.default
        if let size = (try? source.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, Int64(size) > maxBytes {
            throw Refused(message: "\(name) is larger than \(maxBytes / (1024 * 1024)) MB, so it was not attached.")
        }
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        let stamp = Int64(now.timeIntervalSince1970 * 1000)
        var folder = root.appendingPathComponent("\(stamp)", isDirectory: true)
        var attempt = 0
        while fm.fileExists(atPath: folder.path) {
            attempt += 1
            if attempt > 1000 { throw Refused(message: "The phone could not make room for \(name).") }
            folder = root.appendingPathComponent("\(stamp)-\(attempt)", isDirectory: true)
        }
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: false)
            let destination = folder.appendingPathComponent(name)
            try fm.copyItem(at: source, to: destination)
            return destination
        } catch {
            try? fm.removeItem(at: folder)
            // The cause is unknown here (storage full, the file's app withdrew access…), so the sentence does not guess.
            throw Refused(message: "The phone could not copy \(name), so it was not attached.")
        }
    }
}
