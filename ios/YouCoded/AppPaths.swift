import Foundation

/// Where the iPhone app keeps things. One place, so the backend's environment (BackendRunner) and the shell agree.
///
/// WHY HOME is the Documents folder: an iPhone app may only write inside Documents, Library and tmp — never the
/// container's root, which is where `~` points by default, so every `~/.claude`, `~/.youcoded` and `~/YouCoded`
/// write would fail. Documents is also the one folder the Files app can show ("On My iPhone › YouCoded"), so the
/// projects and files the assistant makes are the person's own to open, copy and back up — the folders whose names
/// start with a dot (settings, conversations) stay hidden there, as on a computer.
enum AppPaths {
    private static let fm = FileManager.default

    /// The backend's HOME.
    static let home: URL = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]

    private static let support: URL = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]

    /// The backend's userData (Electron's word): caches, sealed secrets, its log. Never shown in Files.
    static let userData: URL = support.appendingPathComponent("userdata", isDirectory: true)

    static let tmp: URL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)

    /// Copies of files picked with the paperclip (AttachmentStore).
    static let attachments: URL = tmp.appendingPathComponent("attachments", isDirectory: true)

    /// The backend's console (stdout + stderr), the first thing to read when something is wrong.
    static let backendLog: URL = userData.appendingPathComponent("backend.log")

    /// The bundled backend (ios/runtime/build-backend.mjs output), read-only inside the app.
    static let backendDir: URL = Bundle.main.resourceURL!.appendingPathComponent("backend", isDirectory: true)

    /// The bundled page (the desktop renderer, `npm run build:web`).
    static let webDir: URL = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)

    /// Installed themes' pictures (theme-asset:// links).
    static let themesDir: URL = home.appendingPathComponent(".claude/wecoded-themes", isDirectory: true)

    static func ensureDirectories() {
        for dir in [home, userData, tmp, attachments] {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        // The backend's private files must not ride along in device backups of other apps' data, but they SHOULD be
        // in the person's own iCloud/computer backup, so nothing is excluded here on purpose.
    }

    static var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
    }

    static var buildNumber: String {
        (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? "0"
    }
}
