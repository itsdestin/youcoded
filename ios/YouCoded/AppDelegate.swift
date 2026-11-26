import UIKit

/// The iPhone app: a thin shell around the desktop's own backend and page (see docs/ios-runtime.md).
/// One window, one screen (RootViewController). No scenes: there is nothing to show in a second window.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Notifier.shared.install()
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = RootViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
