import UIKit
import WebKit
import UniformTypeIdentifiers

/// Builds the one web view that shows the shared page, and serves that page's files from inside the app.
///
/// The page is the desktop renderer (`npm run build:web`), unchanged. It is served from a private address,
/// `youcoded-app://app/…`, answered by `PageSchemeHandler` below — the iPhone's counterpart of Android's
/// WebViewAssetLoader (AppWebView.kt). The page recognises itself by that address
/// (desktop/src/shared/android-page-origin.ts → IOS_PAGE_ORIGIN; the two must match).
enum AppWebView {
    static let pageScheme = "youcoded-app"
    static let pageHost = "app"
    static let pageOrigin = "\(pageScheme)://\(pageHost)"
    static let hostMessageName = "youcodedHost"

    static func pageURL(port: Int, token: String) -> URL {
        URL(string: "\(pageOrigin)/index.html?bridgeToken=\(token)&bridgePort=\(port)")!
    }

    static func make(bridge: WKScriptMessageHandler) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(PageSchemeHandler(root: AppPaths.webDir), forURLScheme: pageScheme)
        configuration.setURLSchemeHandler(ThemeAssetSchemeHandler(root: AppPaths.themesDir), forURLScheme: "theme-asset")
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false

        // `window.YouCodedHost.invoke(id, type, payloadJson, token)`: the same object Android injects with
        // addJavascriptInterface, so the page's phone calls (android-local-bridge.ts) need no iPhone branch.
        // Main frame only: a previewed HTML file or a Page in an inner frame never sees it (and the per-run
        // token is still checked in HostJsBridge, as on Android).
        let hostObject = """
        (function () {
          if (window.YouCodedHost) return;
          var port = window.webkit.messageHandlers.\(hostMessageName);
          Object.defineProperty(window, 'YouCodedHost', { value: Object.freeze({
            invoke: function (id, type, payloadJson, token) {
              port.postMessage({ id: String(id), type: String(type), payload: String(payloadJson), token: String(token) });
            }
          }), writable: false, configurable: false });
        })();
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: hostObject, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(bridge, name: hostMessageName)

        // The page's errors and warnings go to a small log beside the backend's (Android sends them to logcat):
        // without it a blank or broken screen on a phone leaves nothing to read.
        let consoleTap = """
        (function () {
          var port = window.webkit.messageHandlers.\(PageLog.messageName);
          function send(level, args) {
            try { port.postMessage(level + ': ' + Array.prototype.map.call(args, function (a) {
              if (a instanceof Error) return a.stack || a.message;
              if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
              return String(a);
            }).join(' ').slice(0, 4000)); } catch (e) {}
          }
          ['error', 'warn'].forEach(function (level) {
            var original = console[level];
            console[level] = function () { send(level, arguments); return original.apply(console, arguments); };
          });
          window.addEventListener('error', function (e) { send('uncaught', [e.message + ' @ ' + e.filename + ':' + e.lineno]); });
          window.addEventListener('unhandledrejection', function (e) { send('rejection', [e.reason]); });
        })();
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: consoleTap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(PageLog.shared, name: PageLog.messageName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        // The page is a fixed-height app, not a document: it scrolls inside its own panes. The outer scroll view
        // must never move (WebKit would otherwise slide the whole page up for the keyboard, on top of the page's
        // own keyboard handling — RootViewController sends the keyboard height instead).
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.hideInputAccessoryBar()
        return webView
    }

    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "html": return "text/html"
        case "json", "map": return "application/json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "ogg": return "audio/ogg"
        case "mp4": return "video/mp4"
        case "webm": return "video/webm"
        case "txt": return "text/plain"
        default:
            return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}

/// Serves files under one folder for a private scheme. Refuses anything that would leave the folder.
private class FolderSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    private let queue = DispatchQueue(label: "com.youcoded.scheme-files", qos: .userInitiated)
    /// Tasks still waiting for their answer. WebKit raises an exception if a task is answered after it was stopped,
    /// so a task is answered only while it is in here. WHY the live ones are tracked (not the stopped ones): a
    /// stopped task's memory address can be reused by a later task, which a "stopped" list would then wrongly refuse.
    private var live = Set<ObjectIdentifier>()
    private let lock = NSLock()

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    /// The path under `root` a request names, or nil for "not found". Subclasses map their URL shape.
    func relativePath(for url: URL) -> String? { nil }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); live.insert(ObjectIdentifier(task)); lock.unlock()
        guard let url = task.request.url else { task.didFailWithError(URLError(.badURL)); forget(task); return }
        guard let relative = relativePath(for: url), !relative.contains(".."), !relative.contains("\\") else {
            fail(task, 404); return
        }
        let file = root.appendingPathComponent(relative).standardizedFileURL
        // resolvingSymlinksInPath: a link inside the folder must not lead out of it.
        let resolved = file.resolvingSymlinksInPath().path
        let rootPath = root.resolvingSymlinksInPath().path
        guard resolved.hasPrefix(rootPath + "/") else { fail(task, 403); return }

        queue.async {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: resolved, isDirectory: &isDirectory), !isDirectory.boolValue,
                  let data = try? Data(contentsOf: URL(fileURLWithPath: resolved), options: .mappedIfSafe) else {
                self.fail(task, 404); return
            }
            var headers = [
                "Content-Type": AppWebView.mimeType(forExtension: file.pathExtension),
                // The files only change with an app update, and the address of every script carries its own hash.
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": AppWebView.pageOrigin,
                "Accept-Ranges": "bytes",
            ]
            // Sounds and video are asked for in pieces ("Range: bytes=0-1"); WebKit will not play media from an
            // address that cannot answer a piece.
            var body = data
            var status = 200
            if let range = Self.byteRange(task.request.value(forHTTPHeaderField: "Range"), total: data.count) {
                body = data.subdata(in: range)
                status = 206
                headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(data.count)"
            }
            headers["Content-Length"] = String(body.count)
            guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
                self.fail(task, 500); return
            }
            self.finish(task) {
                task.didReceive(response)
                task.didReceive(body)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        forget(task)
    }

    private func forget(_ task: WKURLSchemeTask) {
        lock.lock(); live.remove(ObjectIdentifier(task)); lock.unlock()
    }

    private func finish(_ task: WKURLSchemeTask, _ body: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.lock.lock()
            let stillWanted = self.live.remove(ObjectIdentifier(task)) != nil
            self.lock.unlock()
            if stillWanted { body() }
        }
    }

    /// "bytes=START-END", "bytes=START-" or "bytes=-LAST" as a range inside `total`, or nil for none/unusable.
    static func byteRange(_ header: String?, total: Int) -> Range<Int>? {
        guard let header, header.hasPrefix("bytes="), total > 0 else { return nil }
        let spec = header.dropFirst("bytes=".count)
        guard !spec.contains(","), let dash = spec.firstIndex(of: "-") else { return nil }
        let first = Int(spec[..<dash]), last = Int(spec[spec.index(after: dash)...])
        if let first {
            guard first < total else { return nil }
            return first..<(min(last ?? (total - 1), total - 1) + 1)
        }
        guard let last, last > 0 else { return nil }
        return max(0, total - last)..<total
    }

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        guard let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": "text/plain", "Content-Length": "0"]) else { return }
        finish(task) {
            task.didReceive(response)
            task.didReceive(Data())
            task.didFinish()
        }
    }
}

/// `youcoded-app://app/<path>` → the bundled page's files.
private final class PageSchemeHandler: FolderSchemeHandler {
    override func relativePath(for url: URL) -> String? {
        guard url.host == AppWebView.pageHost else { return nil }
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return path.isEmpty ? "index.html" : path
    }
}

/// `theme-asset://<theme>/<file>` → an installed theme's picture (same mapping as Android's `themeAsset`).
private final class ThemeAssetSchemeHandler: FolderSchemeHandler {
    override func relativePath(for url: URL) -> String? {
        guard let slug = url.host, !slug.isEmpty else { return nil }
        let rest = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return rest.isEmpty ? nil : "\(slug)/\(rest)"
    }
}

/// The page's own errors and warnings, kept in `userdata/page.log` (started fresh when it passes 1 MB).
final class PageLog: NSObject, WKScriptMessageHandler {
    static let shared = PageLog()
    static let messageName = "youcodedLog"
    private let queue = DispatchQueue(label: "com.youcoded.page-log", qos: .utility)
    private lazy var url = AppPaths.userData.appendingPathComponent("page.log")
    private var handle: FileHandle?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let text = message.body as? String else { return }
        queue.async { self.append(text) }
    }

    private func append(_ text: String) {
        if handle == nil {
            let fm = FileManager.default
            try? fm.createDirectory(at: AppPaths.userData, withIntermediateDirectories: true)
            if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber, size.intValue > 1_000_000 {
                try? fm.removeItem(at: url)
            }
            if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
            handle = try? FileHandle(forWritingTo: url)
            _ = try? handle?.seekToEnd()
        }
        try? handle?.write(contentsOf: Data("\(ISO8601DateFormatter().string(from: Date())) \(text)\n".utf8))
    }
}

// MARK: - The bar above the keyboard

/// WKWebView puts a grey bar with ‹ › and "Done" above the keyboard for every text field. This app is a chat, not a
/// web form: the bar covers a strip of the page (the simulator run showed it cutting through the setup card), and
/// the page already has its own send button and its own way to dismiss the keyboard. WebKit offers no setting for
/// it, so the view that owns the keyboard is given a subclass whose accessory view is nothing — the long-standing
/// approach used by apps that host a web page as their main screen.
private final class NoInputAccessory: NSObject {
    @objc var inputAccessoryView: AnyObject? { nil }
}

extension WKWebView {
    func hideInputAccessoryBar() {
        guard let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let contentClass = object_getClass(content) else { return }
        let name = "\(contentClass)_YouCodedNoAccessory"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let created = objc_allocateClassPair(contentClass, name, 0) {
            if let method = class_getInstanceMethod(NoInputAccessory.self, #selector(getter: NoInputAccessory.inputAccessoryView)) {
                class_addMethod(created, #selector(getter: NoInputAccessory.inputAccessoryView), method_getImplementation(method), method_getTypeEncoding(method))
            }
            objc_registerClassPair(created)
            subclass = created
        }
        if let subclass { object_setClass(content, subclass) }
    }
}
