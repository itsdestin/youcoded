import Foundation

/// Which hosts the app may reach WITHOUT encryption (http:// and ws://): the phone itself and Tailscale addresses.
///
/// The same rule as Android's CleartextPolicy.kt and desktop/src/shared/cleartext-hosts.ts (2026-10-30 security
/// audit A1, "Tailscale only"): Tailscale already encrypts everything between two devices, so a plain connection
/// is acceptable only to this phone's own backend and to Tailscale addresses (100.64.0.0/10,
/// fd7a:115c:a1e0::/48, *.ts.net). Like the Kotlin copy it does no address normalisation: odd spellings are
/// refused, not interpreted. Pure Swift, unit tested (UrlPolicyTests).
enum CleartextPolicy {
    /// What the person sees when a computer is refused. Same words as the page's TAILSCALE_ONLY_MESSAGE.
    static let message = "YouCoded only connects to your computer over Tailscale, and this address isn’t one. Turn on Tailscale on both devices and add the computer again using its Tailscale address."

    static func isAllowedHost(_ raw: String?) -> Bool {
        guard var host = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return false }
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host.hasSuffix(".") { host = String(host.dropLast()) }
        if host.isEmpty { return false }
        if host == "localhost" || host == "::1" { return true }

        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isASCIIDigit) }) {
            let octets = parts.compactMap { Int($0) }
            if octets.count != 4 || octets.contains(where: { $0 > 255 }) { return false }
            return octets[0] == 127 || (octets[0] == 100 && (64...127).contains(octets[1]))
        }
        if host.contains(":") { return isTailscaleV6(host) }
        // A Tailscale machine name: labels of letters, digits and hyphens, ending in .ts.net.
        guard host.hasSuffix(".ts.net") else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        return labels.count >= 3 && labels.allSatisfy { label in
            !label.isEmpty && label.allSatisfy { $0.isASCIILowercaseLetter || $0.isASCIIDigit || $0 == "-" }
        }
    }

    private static func isTailscaleV6(_ host: String) -> Bool {
        guard host.allSatisfy({ $0.isASCIIDigit || ("a"..."f").contains($0) || $0 == ":" }) else { return false }
        let halves = host.components(separatedBy: "::")
        if halves.count > 2 { return false }
        let left = halves[0].isEmpty ? [] : halves[0].components(separatedBy: ":")
        let right = (halves.count == 2 && !halves[1].isEmpty) ? halves[1].components(separatedBy: ":") : []
        var groups: [String]
        if halves.count == 2 {
            let fill = 8 - left.count - right.count
            if fill < 0 { return false }
            groups = left + Array(repeating: "0", count: fill) + right
        } else {
            groups = left
        }
        guard groups.count == 8, groups.allSatisfy({ (1...4).contains($0.count) }) else { return false }
        let values = groups.compactMap { Int($0, radix: 16) }
        return values.count == 8 && values[0] == 0xfd7a && values[1] == 0x115c && values[2] == 0xa1e0
    }

    /// Encrypted addresses always pass; plain http/ws only to an allowed host; other schemes are not this rule's.
    static func isAllowed(scheme: String?, host: String?) -> Bool {
        switch scheme?.lowercased() {
        case "https", "wss": return true
        case "http", "ws": return isAllowedHost(host)
        default: return true
        }
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
    var isASCIILowercaseLetter: Bool { ("a"..."z").contains(self) }
}

/// What the app's web view does with an address it is asked to open. The iPhone copy of Android's
/// WebViewUrlPolicy (WebViewUrlRouter.kt) — same decisions, for the same reasons recorded there:
///  - the bundled page loads in place, and nothing else ever replaces it (it holds the bridge to the app);
///  - a download link minted by a PAIRED computer is saved, never displayed;
///  - only web and mail links are handed to other apps (never tel:, sms:, or another app's own scheme);
///  - everything else is refused.
enum UrlDecision: Equatable {
    case load
    case download
    case openExternally
    case block
}

enum WebViewUrlPolicy {
    static let maxNameBytes = 240
    private static let fallbackName = "download"

    static func decide(_ url: String, isPairedHost: (_ host: String, _ port: Int) -> Bool) -> UrlDecision {
        let components = URLComponents(string: url)
        if let components, isMintedDownload(components, isPairedHost: isPairedHost) { return .download }
        if url.lowercased().hasPrefix("file:") { return .block }
        if isBundledPage(url) { return .load }
        if components?.scheme?.lowercased() == AppWebView.pageScheme { return .block }
        // A dev server the assistant started (http://localhost:5173) must never replace the app's own page.
        return url.range(of: "^(https?|mailto):", options: [.regularExpression, .caseInsensitive]) != nil ? .openExternally : .block
    }

    /// The page's own address: exactly the private scheme and host, with no way out of the folder.
    static func isBundledPage(_ url: String) -> Bool {
        let prefix = AppWebView.pageOrigin + "/"
        guard url.hasPrefix(prefix) else { return false }
        var path = String(url.dropFirst(prefix.count))
        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<cut]) }
        let lower = path.lowercased()
        return !lower.contains("..") && !lower.contains("%2e") && !lower.contains("%2f") && !lower.contains("%5c") && !path.contains("\\")
    }

    private static func isMintedDownload(_ c: URLComponents, isPairedHost: (String, Int) -> Bool) -> Bool {
        guard let scheme = c.scheme, scheme == "http" || scheme == "https" else { return false }
        // A link carrying credentials is never a minted link.
        if c.user != nil || c.password != nil { return false }
        // The exact path the desktop mints (remote-download.ts ROUTE): a 43-char base64url token, an optional name.
        guard c.percentEncodedPath.range(of: "^/download/[A-Za-z0-9_-]{43}(/[^/]*)?$", options: .regularExpression) != nil else { return false }
        guard var host = c.host, !host.isEmpty else { return false }
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        let port = c.port ?? (scheme == "https" ? 443 : 80)
        // The token travels in the address, so a plain http link is trusted only on a Tailscale address.
        guard CleartextPolicy.isAllowed(scheme: scheme, host: host) else { return false }
        return isPairedHost(host, port)
    }

    /// The one plain, visible, openable file name to save a minted download as: no folders, no invisible or
    /// direction-switching characters, never hidden (leading dot), cut by BYTES keeping its extension.
    static func downloadFileName(_ url: String) -> String {
        guard let c = URLComponents(string: url) else { return fallbackName }
        let raw = c.percentEncodedPath
        guard raw.hasPrefix("/download/") else { return fallbackName }
        let afterToken = raw.dropFirst("/download/".count)
        guard let slash = afterToken.firstIndex(of: "/") else { return fallbackName }
        guard let decoded = String(afterToken[afterToken.index(after: slash)...]).removingPercentEncoding else { return fallbackName }
        return cleanFileName(decoded)
    }

    static func cleanFileName(_ name: String) -> String {
        var base = name
        if let cut = base.lastIndex(where: { $0 == "/" || $0 == "\\" }) { base = String(base[base.index(after: cut)...]) }
        var scalars = String.UnicodeScalarView()
        var lastWasSpace = false
        for scalar in base.unicodeScalars {
            if invisibleFillers.contains(scalar) { continue }
            let properties = scalar.properties
            let category = properties.generalCategory
            if category == .spaceSeparator || category == .lineSeparator || category == .paragraphSeparator {
                // Every kind of space, in runs, shows as ONE ordinary space: a separator can never push the real
                // extension out of sight.
                if !lastWasSpace { scalars.append(" ") }
                lastWasSpace = true
                continue
            }
            lastWasSpace = false
            if category == .control || category == .format || "\"*:<>?|".unicodeScalars.contains(scalar) {
                scalars.append("_")
            } else {
                scalars.append(scalar)
            }
        }
        var cleaned = String(scalars).trimmingCharacters(in: .whitespaces)
        if cleaned.isEmpty || cleaned.allSatisfy({ $0 == "." }) { return fallbackName }
        if cleaned.hasPrefix(".") {
            let dots = cleaned.prefix(while: { $0 == "." })
            cleaned = "_" + String(cleaned.dropFirst(dots.count))
        }
        return fitBytes(cleaned)
    }

    private static let invisibleFillers: Set<Unicode.Scalar> = {
        var set: Set<Unicode.Scalar> = ["\u{00AD}", "\u{034F}", "\u{115F}", "\u{1160}", "\u{17B4}", "\u{17B5}", "\u{2800}", "\u{3164}", "\u{FFA0}"]
        for value in 0x180B...0x180F { set.insert(Unicode.Scalar(value)!) }
        for value in 0xFE00...0xFE0F { set.insert(Unicode.Scalar(value)!) }
        return set
    }()

    private static func fitBytes(_ name: String) -> String {
        if name.utf8.count <= maxNameBytes { return name }
        var ext = ""
        var stem = name
        if let dot = name.lastIndex(of: "."), dot != name.startIndex, name.distance(from: dot, to: name.endIndex) <= 33 {
            ext = String(name[dot...])
            stem = String(name[..<dot])
        }
        let budget = maxNameBytes - ext.utf8.count
        var kept = ""
        var used = 0
        for character in stem {
            let bytes = String(character).utf8.count
            if used + bytes > budget { break }
            kept.append(character)
            used += bytes
        }
        kept = kept.trimmingCharacters(in: .whitespaces)
        return (kept.isEmpty ? fallbackName : kept) + ext
    }
}

/// Is host:port one of the computers this phone paired with? (Android: PairedDeviceStore.matches.)
enum PairedDevices {
    static let defaultPort = 9900

    static func matches(devicesJSON: String, host: String, port: Int) -> Bool {
        let wanted = normalize(host)
        guard !wanted.isEmpty,
              let list = try? JSONSerialization.jsonObject(with: Data(devicesJSON.utf8)) as? [[String: Any]] else { return false }
        return list.contains { device in
            let stored = normalize(device["host"] as? String ?? "")
            let storedPort = (device["port"] as? NSNumber)?.intValue ?? defaultPort
            return !stored.isEmpty && stored == wanted && storedPort == port
        }
    }

    private static func normalize(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespaces).lowercased()
        if h.hasPrefix("[") { h.removeFirst() }
        if h.hasSuffix("]") { h.removeLast() }
        return h
    }
}
