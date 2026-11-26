import UIKit
import UserNotifications

/// Notifications: what the backend asks to show, and the "needs you" alerts.
///
/// (Android: Notifier.kt + StatusNotifier.kt.) The backend works out who needs the person
/// (desktop/src/main/background-status.ts) and this only draws it. One difference from Android, forced by iOS:
/// there is no always-on "your assistant is running" notification, because an iPhone app cannot keep running in
/// the background the way an Android foreground service does. The number of sessions waiting is shown as the
/// app icon's badge instead.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// A "needs you" alert was tapped: the session to open.
    var onOpenSession: ((String) -> Void)?
    /// A link notification was tapped (a sign-in link that arrived while the app was off screen).
    var onOpenLink: ((URL) -> Void)?

    private let center = UNUserNotificationCenter.current()
    private var posted = Set<String>() // session ids with a visible "needs you"
    private var askedPermission = false

    func install() {
        center.delegate = self
    }

    /// Asked the first time the backend has something to tell the person, not at launch: a permission box with no
    /// visible reason is the one people refuse.
    private func ensurePermission(_ then: @escaping (Bool) -> Void) {
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                then(true)
            case .notDetermined:
                self.center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in then(granted) }
            default:
                then(false)
            }
        }
    }

    func show(title: String, body: String) {
        ensurePermission { granted in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            self.center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    func showLink(title: String, url: URL) {
        ensurePermission { granted in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = "Tap to open it."
            content.sound = .default
            content.userInfo = ["url": url.absoluteString]
            self.center.add(UNNotificationRequest(identifier: "link-\(UUID().uuidString)", content: content, trigger: nil))
        }
    }

    /// The backend's live summary: `{text, needs: [{sessionId, name, text}]}`.
    func showStatus(_ status: [String: Any], appIsActive: Bool) {
        let needs = (status["needs"] as? [[String: Any]]) ?? []
        var current: [String: [String: Any]] = [:]
        for need in needs {
            if let id = need["sessionId"] as? String, !id.isEmpty { current[id] = need }
        }
        // Answered (or the session ended): take its alert down.
        let gone = posted.filter { current[$0] == nil }
        if !gone.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: gone.map(Self.identifier))
            posted.subtract(gone)
        }
        setBadge(current.count)
        // The app is on screen: the person can see the prompt, so no alert (and any old one goes).
        if appIsActive { cancelNeeds(); return }
        for (id, need) in current where !posted.contains(id) {
            posted.insert(id)
            ensurePermission { granted in
                guard granted else { return }
                let content = UNMutableNotificationContent()
                let name = (need["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "A session"
                content.title = "\(name) needs you"
                content.body = (need["text"] as? String) ?? ""
                content.sound = .default
                content.userInfo = ["sessionId": id]
                // iOS hides the body on a locked phone when the person has previews set to "When Unlocked" (the
                // default on Face ID phones), which is the same protection Android's public version gives.
                self.center.add(UNNotificationRequest(identifier: Self.identifier(id), content: content, trigger: nil))
            }
        }
    }

    /// The app came on screen.
    func cancelNeeds() {
        guard !posted.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: posted.map(Self.identifier))
        posted.removeAll()
    }

    private func setBadge(_ count: Int) {
        DispatchQueue.main.async {
            if #available(iOS 17.0, *) {
                self.center.setBadgeCount(count)
            } else {
                UIApplication.shared.applicationIconBadgeNumber = count
            }
        }
    }

    private static func identifier(_ sessionId: String) -> String { "needs-\(sessionId)" }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        await MainActor.run {
            if let sessionId = info["sessionId"] as? String {
                self.onOpenSession?(sessionId)
            } else if let link = info["url"] as? String, let url = URL(string: link) {
                self.onOpenLink?(url)
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // Something the backend chose to announce while the app is open still shows as a banner.
        [.banner, .sound]
    }
}
