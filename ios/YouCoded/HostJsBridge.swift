import UIKit
import WebKit

/// `window.YouCodedHost` — what the shared page asks the phone app itself
/// (desktop/src/renderer/android-local-bridge.ts).
///
/// The iPhone copy of Android's HostJsBridge.kt, answering the SAME message names. WHY the names still say
/// "android:": they are identifiers on the wire between the page and whichever phone app hosts it, not words a
/// person sees, and renaming them would mean changing the page, the Android app and every branch in flight for no
/// change in behaviour. A call arrives as `{id, type, payload, token}`; the answer goes back through
/// `window.__youcodedHost.reply(id, json, error?)` and pushes (voice words, back swipes) through
/// `window.__youcodedHost.event(type, json)`.
///
/// Every type the page may send is in `types`; desktop/tests/ios-host-channels.test.ts pins that list against the
/// page and against Android's.
final class HostJsBridge: NSObject, WKScriptMessageHandler {
    /// What only the screen can do. Called on the main thread.
    protocol UI: AnyObject {
        func evaluate(_ js: String)
        func scanQr(_ done: @escaping (String?) -> Void)
        /// Show the attach menu (photos or files); `done` gets the chosen files (empty: cancelled).
        func pickFiles(_ done: @escaping ([URL]) -> Void)
        func setBackStackEmpty(_ empty: Bool)
        func showToast(_ text: String)
    }

    static let types: [String] = [
        "android:get-tier", "android:set-tier", "android:get-about", "android:get-paired-devices",
        "android:save-paired-device", "android:remove-paired-device", "android:scan-qr", "android:pick-files",
        "android:tailscale-status", "android:open-tailscale",
        "android:take-pending-session", "system:notify-stack-state", "voice:status", "voice:download", "voice:start", "voice:stop", "voice:cancel",
    ]

    weak var ui: UI?
    /// This run's page token (set when the page is loaded). A call without it is ignored.
    var expectedToken = ""

    private var voice: VoiceRecognizer?
    private var pendingSession: String?
    private let io = DispatchQueue(label: "com.youcoded.host-bridge", qos: .userInitiated)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the app's own page, in the main frame. (The object is injected into the main frame only, and the
        // token check below is the second lock, as on Android.)
        guard message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let type = body["type"] as? String,
              let token = body["token"] as? String,
              !expectedToken.isEmpty, HostSocketServer.constantTimeEquals(token, expectedToken) else { return }
        let payloadText = body["payload"] as? String ?? "null"
        let payload = (try? JSONSerialization.jsonObject(with: Data(payloadText.utf8), options: [.fragmentsAllowed])) as? [String: Any] ?? [:]
        handle(id: id, type: type, payload: payload)
    }

    private func handle(id: String, type: String, payload p: [String: Any]) {
        switch type {
        // The old Android app had install "tiers"; the page still asks. One answer, as on Android.
        case "android:get-tier":
            reply(id, ["tier": "CORE"])
        case "android:set-tier":
            reply(id, ["restartRequired": false])
        case "android:get-about":
            reply(id, ["version": AppPaths.appVersion, "build": AppPaths.buildNumber])

        case "android:get-paired-devices":
            reply(id, ["devices": readDevices()])
        case "android:save-paired-device":
            let host = p["host"] as? String ?? ""
            let port = (p["port"] as? NSNumber)?.intValue ?? PairedDevices.defaultPort
            // A computer is saved only at an address the app may reach without encryption (2026-10-30 audit A1);
            // the page shows this message as "Couldn’t save <name>: ...".
            guard CleartextPolicy.isAllowedHost(host) else { reply(id, nil, error: CleartextPolicy.message); return }
            var kept = without(readDevices(), host: host, port: port)
            kept.append(["name": p["name"] as? String ?? "Computer", "host": host, "port": port, "password": p["password"] as? String ?? ""])
            guard writeDevices(kept) else { reply(id, nil, error: "The iPhone could not save this computer."); return }
            reply(id, true)
        case "android:remove-paired-device":
            let kept = without(readDevices(), host: p["host"] as? String ?? "", port: (p["port"] as? NSNumber)?.intValue ?? PairedDevices.defaultPort)
            _ = writeDevices(kept)
            reply(id, true)

        case "android:tailscale-status":
            reply(id, ["on": TailscaleProbe.isOn().map { $0 as Any } ?? NSNull()])
        case "android:open-tailscale":
            // The Tailscale app if it is installed, else its App Store page.
            let app = URL(string: "tailscale://")!
            let store = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!
            UIApplication.shared.open(app, options: [:]) { [weak self] opened in
                if opened { self?.reply(id, ["opened": true]); return }
                UIApplication.shared.open(store, options: [:]) { openedStore in self?.reply(id, ["opened": openedStore]) }
            }

        case "android:scan-qr":
            guard let ui else { reply(id, ["url": NSNull()]); return }
            ui.scanQr { [weak self] text in self?.reply(id, ["url": text.map { $0 as Any } ?? NSNull()]) }

        case "android:pick-files":
            guard let ui else { reply(id, ["paths": [String]()]); return }
            ui.pickFiles { [weak self] urls in
                self?.io.async {
                    // Old copies go first so the folder cannot grow without limit; each file then succeeds or
                    // fails on its own, and every file left out is named on screen.
                    AttachmentStore.sweep(root: AppPaths.attachments)
                    var paths: [String] = []
                    var refused: [String] = []
                    for url in urls {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        do {
                            let copy = try AttachmentStore.save(root: AppPaths.attachments, name: AttachmentStore.safeName(url.lastPathComponent), source: url)
                            paths.append(copy.path)
                        } catch let error as AttachmentStore.Refused {
                            refused.append(error.message)
                        } catch {
                            refused.append("A file could not be attached.")
                        }
                    }
                    DispatchQueue.main.async {
                        if !refused.isEmpty { self?.ui?.showToast(refused.joined(separator: "\n")) }
                        self?.reply(id, ["paths": paths])
                    }
                }
            }

        // A tapped "needs you" alert: the page asks once for the session to open (and the phone forgets it).
        case "android:take-pending-session":
            let session = pendingSession
            pendingSession = nil
            reply(id, ["sessionId": session.map { $0 as Any } ?? NSNull()])

        case "system:notify-stack-state":
            ui?.setBackStackEmpty((p["empty"] as? Bool) ?? true)
            reply(id, nil)

        case "voice:status":
            reply(id, VoiceRecognizer.readiness())
        // The iPhone listens itself: nothing to download.
        case "voice:download":
            reply(id, ["ok": true])
        case "voice:start":
            VoiceRecognizer.requestPermissions { [weak self] refusal in
                guard let self else { return }
                if let refusal {
                    // The message box reads a pushed error to return to idle (a reply alone looks like success).
                    self.push("voice:event", ["type": "readiness", "readiness": VoiceRecognizer.readiness()])
                    self.push("voice:event", ["type": "error", "message": refusal])
                    self.reply(id, ["ok": false, "error": refusal])
                    return
                }
                let recognizer = self.voice ?? VoiceRecognizer { [weak self] event in self?.push("voice:event", event) }
                self.voice = recognizer
                recognizer.start()
                self.reply(id, ["ok": true])
            }
        case "voice:stop":
            voice?.stop()
            reply(id, ["ok": true])
        case "voice:cancel":
            voice?.cancel()
            reply(id, ["ok": true])

        default:
            reply(id, nil, error: "The phone has no '\(type)'.")
        }
    }

    /// An alert was tapped: remember the session and nudge the page (which may not be loaded yet, hence the memory).
    func openSession(_ sessionId: String) {
        pendingSession = sessionId
        push("system:open-session", [:])
    }

    /// A swipe from the left edge — the iPhone's "back" — for the page's overlay stack.
    func pressBack() {
        push("system:back", [:])
    }

    func release() {
        voice?.release()
        voice = nil
    }

    // MARK: - Saved computers

    private func readDevices() -> [[String: Any]] {
        let text = SecretKeyStore.pairedDevicesJSON()
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]]) ?? []
    }

    private func writeDevices(_ devices: [[String: Any]]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: devices) else { return false }
        return SecretKeyStore.setPairedDevicesJSON(String(decoding: data, as: UTF8.self))
    }

    private func without(_ list: [[String: Any]], host: String, port: Int) -> [[String: Any]] {
        list.filter { device in
            (device["host"] as? String) != host || ((device["port"] as? NSNumber)?.intValue ?? PairedDevices.defaultPort) != port
        }
    }

    // MARK: - Talking to the page

    /// A value as a JavaScript string literal holding JSON text. Values reach the page as text inside a string,
    /// never as code.
    private static func quoted(_ text: String) -> String {
        // JSON-encoding a one-element array and dropping the brackets yields a correctly escaped string literal;
        // U+2028/2029 are legal in JSON but end a line in JavaScript source, so they are escaped too.
        guard let data = try? JSONSerialization.data(withJSONObject: [text]) else { return "\"\"" }
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    private static func jsonText(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) {
            return String(decoding: data, as: UTF8.self)
        }
        return "null"
    }

    private func reply(_ id: String, _ value: Any?, error: String? = nil) {
        let json = Self.jsonText(value)
        let tail = error.map { "," + Self.quoted($0) } ?? ""
        let js = "window.__youcodedHost&&window.__youcodedHost.reply(\(Self.quoted(id)),\(Self.quoted(json))\(tail))"
        DispatchQueue.main.async { self.ui?.evaluate(js) }
    }

    private func push(_ type: String, _ payload: [String: Any]) {
        let js = "window.__youcodedHost&&window.__youcodedHost.event(\(Self.quoted(type)),\(Self.quoted(Self.jsonText(payload))))"
        DispatchQueue.main.async { self.ui?.evaluate(js) }
    }
}

/// Is Tailscale connected on this phone? An app cannot ask another app, but it can see the phone's network
/// interfaces: Tailscale's tunnel carries an address in 100.64.0.0/10. nil when the phone would not say.
/// (Android: TailscaleProbe.kt.)
enum TailscaleProbe {
    static func isOn() -> Bool? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  (entry.pointee.ifa_flags & UInt32(IFF_UP)) != 0 else { continue }
            let name = String(cString: entry.pointee.ifa_name)
            guard name.hasPrefix("utun") || name.hasPrefix("ipsec") else { continue }
            let ipv4 = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            let high = (ipv4 >> 24) & 0xFF, next = (ipv4 >> 16) & 0xFF
            if high == 100 && (64...127).contains(next) { return true }
        }
        return false
    }
}
