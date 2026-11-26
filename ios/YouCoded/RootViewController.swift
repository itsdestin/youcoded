import Network
import PhotosUI
import QuickLook
import SafariServices
import UIKit
import UniformTypeIdentifiers
import WebKit

/// The app's one screen: "starting…", then the shared page; or a plain message when the backend cannot run.
/// (Android: MainActivity.kt.) Also the place every phone-only thing the page or the backend asks for is shown:
/// the QR scanner, the attach menu, sign-in pages, downloads.
final class RootViewController: UIViewController {
    private let bridge = HostJsBridge()
    private let hostToken = SecretKeyStore.randomTokenHex()
    private lazy var hostSocket = HostSocketServer(token: hostToken)
    private var webView: WKWebView!
    private let loadingView = BrandLoadingView()
    private var failedView: FailedView?
    private var pageReadyTimer: Timer?
    private var pageShown = false
    private var loadedToken: String?
    private var backStackEmpty = true
    private var signInBrowser: SFSafariViewController?
    private var keepAwake = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var pickCompletion: (([URL]) -> Void)?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var previewItem: URL?
    private var lastImeOffset: CGFloat = -1
    private var barStyle: UIStatusBarStyle = .default

    override var preferredStatusBarStyle: UIStatusBarStyle { barStyle }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        bridge.ui = self
        webView = AppWebView.make(bridge: bridge)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.delegate = self
        webView.configuration.userContentController.add(ChromeColorReceiver { [weak self] color in self?.applyChromeColor(color) }, name: "youcodedChrome")
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: Self.chromeColorScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView.alpha = 0
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        loadingView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(loadingView)

        // The page keeps clear of the notch and the home bar: it is laid out inside the safe area, and the strips
        // outside it take the page's own background colour (applyChromeColor), so the app reads as one surface.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            loadingView.topAnchor.constraint(equalTo: view.topAnchor),
            loadingView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            loadingView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            loadingView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // The iPhone's "back": a swipe in from the left edge closes the page's topmost popup or drawer.
        let back = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
        back.edges = .left
        view.addGestureRecognizer(back)

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardDidChange(_:)), name: UIResponder.keyboardDidChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardWillHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)

        Notifier.shared.onOpenSession = { [weak self] sessionId in self?.bridge.openSession(sessionId) }
        Notifier.shared.onOpenLink = { [weak self] url in self?.openLink(url) }

        startBackend()
    }

    // MARK: - Backend

    private func startBackend() {
        hostSocket.handler = { [weak self] method, params, reply in
            guard let self else { reply(.failure(HostSocketServer.HostError(message: "The app is closing."))); return }
            self.handleHostCall(method, params, reply)
        }
        // The backend may connect (or reconnect, after iOS suspended the app) at any time: tell it where things stand.
        hostSocket.onBackendConnected = { [weak self] in self?.tellForeground() }
        guard let hostPort = hostSocket.start() else {
            show(failure: "The app could not open a local connection for the assistant.")
            return
        }
        let runner = BackendRunner.shared
        runner.onState = { [weak self] state in self?.apply(state) }
        runner.start(hostPort: hostPort, hostToken: hostToken)
        apply(runner.state)
    }

    private func apply(_ state: BackendRunner.State) {
        switch state {
        case .starting:
            break
        case .ready(let port, let token):
            guard loadedToken != token else { return }
            loadedToken = token
            bridge.expectedToken = token
            webView.load(URLRequest(url: AppWebView.pageURL(port: port, token: token)))
            waitForPage()
            tellForeground()
        case .failed(let message):
            show(failure: message)
        }
    }

    /// The page says when it is ready (`window.__ycBootReady`, set by App.tsx / remote-gate.tsx); until then the
    /// loading screen stays up. Twenty seconds at most, so a page that never says so is never hidden for good.
    private func waitForPage() {
        let started = Date()
        pageReadyTimer?.invalidate()
        pageReadyTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            if Date().timeIntervalSince(started) > 20 { timer.invalidate(); self.revealPage(); return }
            self.webView.evaluateJavaScript("!!window.__ycBootReady") { value, _ in
                if (value as? Bool) == true { timer.invalidate(); self.revealPage() }
            }
        }
    }

    private func revealPage() {
        guard !pageShown else { return }
        pageShown = true
        UIView.animate(withDuration: 0.25, animations: {
            self.webView.alpha = 1
            self.loadingView.alpha = 0
        }, completion: { _ in
            self.loadingView.stop()
            self.loadingView.removeFromSuperview()
        })
    }

    private func show(failure message: String) {
        pageReadyTimer?.invalidate()
        guard failedView == nil else { return }
        let failed = FailedView(message: message, details: { BackendRunner.shared.logTail() })
        failed.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failed)
        NSLayoutConstraint.activate([
            failed.topAnchor.constraint(equalTo: view.topAnchor),
            failed.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            failed.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            failed.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        failedView = failed
        loadingView.stop()
        loadingView.removeFromSuperview()
        webView.alpha = 0
    }

    // MARK: - What the backend asks of the phone (headless/host-bridge.ts)

    private func handleHostCall(_ method: String, _ params: [String: Any], _ reply: @escaping HostSocketServer.Reply) {
        switch method {
        case "openExternal":
            let text = params["url"] as? String ?? ""
            guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
                reply(.failure(HostSocketServer.HostError(message: "Only web links can be opened.")))
                return
            }
            // iOS does not let an app that is off screen open anything; then the link waits in a notification.
            if UIApplication.shared.applicationState == .active { openLink(url) } else { Notifier.shared.showLink(title: "Open link", url: url) }
            reply(.success(nil))
        case "openPath":
            let path = params["path"] as? String ?? ""
            guard !path.isEmpty else { reply(.failure(HostSocketServer.HostError(message: "No file to open."))); return }
            openPath(URL(fileURLWithPath: path))
            reply(.success(nil))
        // The backend says a sign-in just finished: put YouCoded back in front of the sign-in page.
        case "bringToFront":
            signInBrowser?.dismiss(animated: true)
            signInBrowser = nil
            reply(.success(nil))
        case "keepAwake":
            setKeepAwake((params["on"] as? Bool) ?? false)
            reply(.success(nil))
        case "status":
            tellForeground()
            Notifier.shared.showStatus(params, appIsActive: UIApplication.shared.applicationState == .active)
            reply(.success(nil))
        case "notify":
            Notifier.shared.show(title: params["title"] as? String ?? "", body: params["body"] as? String ?? "")
            reply(.success(nil))
        default:
            reply(.failure(HostSocketServer.HostError(message: "The phone has no '\(method)'.")))
        }
    }

    private func openLink(_ url: URL) {
        // Sign-in pages open INSIDE the app, so the app is still in front (and its backend still running) when the
        // sign-in sends the browser back to the phone's own address, and so "bringToFront" can close the page.
        if SignInLinks.isSignInLink(url) {
            signInBrowser?.dismiss(animated: false)
            let browser = SFSafariViewController(url: url)
            browser.dismissButtonStyle = .cancel
            signInBrowser = browser
            topPresenter().present(browser, animated: true)
        } else {
            UIApplication.shared.open(url)
        }
    }

    /// A file the backend wants shown: a preview of the file, or the Files app for a folder.
    private func openPath(_ url: URL) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return }
        if isDirectory.boolValue {
            // The Files app opens at a folder inside this app's own space through its "shareddocuments" address.
            var components = URLComponents()
            components.scheme = "shareddocuments"
            components.path = url.path
            if let files = components.url { UIApplication.shared.open(files) }
            return
        }
        preview(url)
    }

    private func preview(_ url: URL) {
        previewItem = url
        let controller = QLPreviewController()
        controller.dataSource = self
        topPresenter().present(controller, animated: true)
    }

    /// While the assistant is working, the screen does not dim and lock (a locked iPhone suspends the app within
    /// seconds, which would cut the reply off). If the person leaves the app anyway, iOS is asked for the short
    /// extra time it allows so the reply in progress can finish or pause cleanly.
    private func setKeepAwake(_ on: Bool) {
        keepAwake = on
        UIApplication.shared.isIdleTimerDisabled = on
        if !on { endBackgroundTask() }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func tellForeground() {
        hostSocket.emit(event: "foreground", params: ["on": UIApplication.shared.applicationState == .active])
    }

    // MARK: - App on screen / off screen

    @objc private func didBecomeActive() {
        endBackgroundTask()
        Notifier.shared.cancelNeeds()
        // iOS may have closed the app's own listening sockets while it was suspended (see HostSocketServer and the
        // backend's reviveLocalListener): reopen this side, tell the backend the app is visible (which makes it check
        // its side), and a few seconds later make sure the page can actually reach it.
        hostSocket.reopenIfNeeded()
        tellForeground()
        checkBackendAnswers(attemptsLeft: 4)
        // A page whose connection iOS cut while the app slept reconnects itself; this only nudges it to look now.
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))", completionHandler: nil)
    }

    /// Knock on the backend's door. If nobody answers after it has had time to reopen it, say so plainly rather
    /// than leave a page that looks alive and can do nothing.
    private func checkBackendAnswers(attemptsLeft: Int) {
        guard case .ready(let port, _) = BackendRunner.shared.state, pageShown, failedView == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, UIApplication.shared.applicationState == .active else { return }
            Self.canConnect(port: port) { answered in
                DispatchQueue.main.async {
                    if answered {
                        // The page reconnects by itself; this only makes it look right away.
                        self.webView?.evaluateJavaScript("window.dispatchEvent(new Event('online'))", completionHandler: nil)
                    } else if attemptsLeft > 1 {
                        self.tellForeground()
                        self.checkBackendAnswers(attemptsLeft: attemptsLeft - 1)
                    } else {
                        self.show(failure: "iOS paused YouCoded for too long and its assistant could not carry on. Close YouCoded and open it again; your conversations are saved.")
                    }
                }
            }
        }
    }

    private static func canConnect(port: Int, _ done: @escaping (Bool) -> Void) {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { done(false); return }
        let connection = NWConnection(host: .ipv4(.loopback), port: nwPort, using: .tcp)
        let queue = DispatchQueue(label: "com.youcoded.backend-probe")
        var finished = false
        let finish: (Bool) -> Void = { ok in
            guard !finished else { return }
            finished = true
            connection.cancel()
            done(ok)
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready: finish(true)
            case .failed, .cancelled: finish(false)
            case .waiting: finish(false)
            default: break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 2) { finish(false) }
    }

    @objc private func willResignActive() {
        hostSocket.emit(event: "foreground", params: ["on": false])
    }

    @objc private func didEnterBackground() {
        guard keepAwake, backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "assistant-reply") { [weak self] in
            self?.endBackgroundTask()
        }
    }

    // MARK: - Keyboard

    // The page does not resize for the keyboard; it is told the keyboard's height and lifts its message box itself
    // (desktop/src/renderer/hooks/useVisualViewport.ts, the same path as Android's MainActivity): the FINAL height
    // once as the keyboard starts to slide, and the resting height when the slide ends.
    @objc private func keyboardWillChange(_ note: Notification) { sendIme(note, rest: false) }
    @objc private func keyboardDidChange(_ note: Notification) { sendIme(note, rest: true) }
    @objc private func keyboardWillHide(_ note: Notification) { sendImeOffset(0, rest: false) }

    private func sendIme(_ note: Notification, rest: Bool) {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, let window = view.window else { return }
        let keyboardTop = window.convert(frame, from: nil).minY
        let pageBottom = webView.convert(webView.bounds, to: window).maxY
        // Measured from the page's own bottom edge (which already sits above the home bar), like Android's gapPx.
        sendImeOffset(max(0, pageBottom - keyboardTop), rest: rest)
    }

    private func sendImeOffset(_ offset: CGFloat, rest: Bool) {
        let rounded = offset.rounded()
        if !rest && rounded == lastImeOffset { return }
        lastImeOffset = rounded
        webView.evaluateJavaScript("window.__ycImeOffset&&window.__ycImeOffset(\(Int(rounded))\(rest ? ",true" : ""))", completionHandler: nil)
    }

    @objc private func edgeSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended, !backStackEmpty, gesture.translation(in: view).x > 60 else { return }
        bridge.pressBack()
    }

    // MARK: - The strips outside the page

    private static let chromeColorScript = """
    (function () {
      var last = '';
      var probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden;pointer-events:none;background:var(--canvas)';
      function send() {
        try {
          if (!probe.isConnected && document.body) document.body.appendChild(probe);
          var c = getComputedStyle(probe).backgroundColor;
          if (c && c !== last) { last = c; window.webkit.messageHandlers.youcodedChrome.postMessage(c); }
        } catch (e) {}
      }
      new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
      window.addEventListener('load', send);
      send();
    })();
    """

    private func applyChromeColor(_ css: String) {
        guard let color = UIColor(cssRGB: css) else { return }
        view.backgroundColor = color
        var white: CGFloat = 0
        color.getWhite(&white, alpha: nil)
        let style: UIStatusBarStyle = white < 0.5 ? .lightContent : .darkContent
        if style != barStyle {
            barStyle = style
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    private func topPresenter() -> UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }
}

// MARK: - HostJsBridge.UI

extension RootViewController: HostJsBridge.UI {
    func evaluate(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func scanQr(_ done: @escaping (String?) -> Void) {
        topPresenter().present(QrScannerViewController(done: done), animated: true)
    }

    func setBackStackEmpty(_ empty: Bool) {
        backStackEmpty = empty
    }

    func showToast(_ text: String) {
        let alert = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        topPresenter().present(alert, animated: true)
    }

    /// The paperclip: photos live in the Photos app and everything else in Files, and iOS has a separate picker
    /// for each, so the person chooses which first.
    func pickFiles(_ done: @escaping ([URL]) -> Void) {
        pickCompletion?([])
        pickCompletion = done
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Photo Library", style: .default) { [weak self] _ in
            var configuration = PHPickerConfiguration()
            configuration.selectionLimit = 0
            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            self?.topPresenter().present(picker, animated: true)
        })
        sheet.addAction(UIAlertAction(title: "Choose Files", style: .default) { [weak self] _ in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            self?.topPresenter().present(picker, animated: true)
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.finishPick([]) })
        // An action sheet on an iPad needs something to point at.
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
        topPresenter().present(sheet, animated: true)
    }

    private func finishPick(_ urls: [URL]) {
        let completion = pickCompletion
        pickCompletion = nil
        completion?(urls)
    }
}

extension RootViewController: UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finishPick(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finishPick([])
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else { finishPick([]); return }
        // Each photo or video is handed over as a temporary file that disappears when its callback returns, so it
        // is copied aside first; AttachmentStore then makes the lasting copy.
        let staging = AppPaths.tmp.appendingPathComponent("photo-picks/\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let group = DispatchGroup()
        let lock = NSLock()
        var picked: [(Int, URL)] = []
        for (index, result) in results.enumerated() {
            let provider = result.itemProvider
            let type = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? UTType.movie.identifier : UTType.image.identifier
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                defer { group.leave() }
                guard let url else { return }
                let name = provider.suggestedName.map { "\($0).\(url.pathExtension)" } ?? url.lastPathComponent
                let folder = staging.appendingPathComponent("\(index)", isDirectory: true)
                try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let copy = folder.appendingPathComponent(name)
                if (try? FileManager.default.copyItem(at: url, to: copy)) != nil {
                    lock.lock(); picked.append((index, copy)); lock.unlock()
                }
            }
        }
        group.notify(queue: .main) { [weak self] in
            self?.finishPick(picked.sorted { $0.0 < $1.0 }.map(\.1))
            // The lasting copies are made on the bridge's queue right after this; the staging copies go a little later.
            DispatchQueue.global().asyncAfter(deadline: .now() + 120) { try? FileManager.default.removeItem(at: staging) }
        }
    }
}

// MARK: - Links, downloads, permission prompts

extension RootViewController: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UIScrollViewDelegate, QLPreviewControllerDataSource {
    private func isPaired(_ host: String, _ port: Int) -> Bool {
        PairedDevices.matches(devicesJSON: SecretKeyStore.pairedDevicesJSON(), host: host, port: port)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let text = url.absoluteString
        let mainFrame = action.targetFrame?.isMainFrame ?? true

        // Content the page itself made (an export, a saved picture): handed to the share sheet as a file.
        if action.shouldPerformDownload, url.scheme == "blob" || url.scheme == "data" {
            decisionHandler(.download)
            return
        }
        // Inner frames (an HTML preview, a Page) load their own content; they can never replace the app's page.
        // Plain http inside them still obeys the Tailscale-only rule.
        if !mainFrame {
            let scheme = url.scheme?.lowercased()
            if scheme == "about" || scheme == "blob" || scheme == "data" || text.hasPrefix(AppWebView.pageOrigin + "/") {
                decisionHandler(.allow)
            } else if scheme == "https" || (scheme == "http" && CleartextPolicy.isAllowedHost(url.host)) {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
            return
        }

        switch WebViewUrlPolicy.decide(text, isPairedHost: isPaired) {
        case .load:
            decisionHandler(.allow)
        case .download:
            decisionHandler(.cancel)
            saveMintedDownload(url)
        case .openExternally:
            decisionHandler(.cancel)
            // Only a link somebody tapped leaves the app; a page (or an inner frame) cannot send the person to
            // another app on its own.
            if action.navigationType == .linkActivated || action.targetFrame == nil { UIApplication.shared.open(url) }
        case .block:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open / target=_blank: there are no other windows; a tapped web link opens in the browser.
        if let url = action.request.url, action.navigationType == .linkActivated,
           WebViewUrlPolicy.decide(url.absoluteString, isPairedHost: isPaired) == .openExternally {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = AppPaths.tmp.appendingPathComponent("downloads/\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(WebViewUrlPolicy.cleanFileName(suggestedFilename))
        downloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) { share(file) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        showToast("Couldn’t save the file.")
    }

    /// A file from a paired computer (its Download button): fetched, then offered through the share sheet, where
    /// "Save to Files" is the iPhone's Downloads folder.
    private func saveMintedDownload(_ url: URL) {
        let name = WebViewUrlPolicy.downloadFileName(url.absoluteString)
        let task = URLSession.shared.downloadTask(with: url) { [weak self] temporary, response, _ in
            let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            guard ok, let temporary else {
                DispatchQueue.main.async { self?.showToast("Couldn’t start the download.") }
                return
            }
            let folder = AppPaths.tmp.appendingPathComponent("downloads/\(UUID().uuidString)", isDirectory: true)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent(name)
            guard (try? FileManager.default.moveItem(at: temporary, to: destination)) != nil else {
                DispatchQueue.main.async { self?.showToast("Couldn’t save the file.") }
                return
            }
            DispatchQueue.main.async { self?.share(destination) }
        }
        task.resume()
    }

    private func share(_ file: URL) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        topPresenter().present(sheet, animated: true)
    }

    // The page's own camera/microphone use (not voice typing, which the app does itself): allowed for the app's
    // own page only; iOS still asks the person the first time.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let ownPage = frame.isMainFrame && origin.protocol == AppWebView.pageScheme && origin.host == AppWebView.pageHost
        decisionHandler(ownPage ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topPresenter().present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        topPresenter().present(alert, animated: true)
    }

    /// iOS ended the page's process (memory pressure while the app was off screen): load the page again rather
    /// than leave a blank screen. The backend, and every conversation, is untouched.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if case .ready(let port, let token) = BackendRunner.shared.state {
            webView.load(URLRequest(url: AppWebView.pageURL(port: port, token: token)))
        }
    }

    // The outer scroll view never moves (see AppWebView.make): the page handles the keyboard itself.
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView.contentOffset != .zero { scrollView.contentOffset = .zero }
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewItem == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        (previewItem ?? AppPaths.tmp) as NSURL
    }
}

/// Receives the page's background colour (a small script reports it whenever the theme changes).
private final class ChromeColorReceiver: NSObject, WKScriptMessageHandler {
    private let apply: (String) -> Void
    init(_ apply: @escaping (String) -> Void) { self.apply = apply }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.frameInfo.isMainFrame, let css = message.body as? String { apply(css) }
    }
}

extension UIColor {
    /// "rgb(12, 34, 56)" / "rgba(12, 34, 56, 0.5)" as browsers report computed colours.
    convenience init?(cssRGB css: String) {
        let numbers = css.split(whereSeparator: { !("0"..."9").contains($0) && $0 != "." }).compactMap { Double($0) }
        guard numbers.count >= 3 else { return nil }
        // A fully transparent answer means the page has not painted its theme yet.
        if numbers.count >= 4, numbers[3] == 0 { return nil }
        self.init(red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, alpha: 1)
    }
}
