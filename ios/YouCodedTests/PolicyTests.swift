import XCTest
@testable import YouCoded

/// The shell's pure rules: which addresses load, download or leave the app, which hosts may be reached without
/// encryption, how a picked file is named and kept. These mirror the Android tests (CleartextPolicyTest,
/// WebViewUrlRouterTest, AttachmentStoreTest): the two phones must decide the same way.
final class PolicyTests: XCTestCase {
    private let token = String(repeating: "a", count: 43)
    private func paired(_ host: String, _ port: Int) -> Bool { host == "100.101.102.103" && port == 9900 }
    private func never(_ host: String, _ port: Int) -> Bool { false }

    func testCleartextOnlyToThisPhoneAndTailscale() {
        for host in ["localhost", "127.0.0.1", "::1", "[::1]", "100.64.0.1", "100.127.255.255", "my-pc.tailnet-1234.ts.net", "fd7a:115c:a1e0::1", "MY-PC.Example.TS.NET."] {
            XCTAssertTrue(CleartextPolicy.isAllowedHost(host), host)
        }
        for host in ["", "192.168.1.10", "10.0.0.1", "100.63.255.255", "100.128.0.1", "example.com", "ts.net", "evil.ts.net.example.com", "0x64.0x40.1.1", "256.1.1.1", "fd7a:115c:a1e1::1", "localhost.evil.com"] {
            XCTAssertFalse(CleartextPolicy.isAllowedHost(host), host)
        }
        XCTAssertTrue(CleartextPolicy.isAllowed(scheme: "https", host: "example.com"))
        XCTAssertFalse(CleartextPolicy.isAllowed(scheme: "http", host: "example.com"))
        XCTAssertFalse(CleartextPolicy.isAllowed(scheme: "ws", host: "192.168.1.5"))
    }

    func testOnlyTheBundledPageLoadsInPlace() {
        XCTAssertEqual(WebViewUrlPolicy.decide("youcoded-app://app/index.html?bridgeToken=x&bridgePort=1", isPairedHost: never), .load)
        XCTAssertEqual(WebViewUrlPolicy.decide("youcoded-app://app/assets/index-abc.js", isPairedHost: never), .load)
        // No way out of the folder, and no other host on the private scheme.
        XCTAssertEqual(WebViewUrlPolicy.decide("youcoded-app://app/../secrets", isPairedHost: never), .block)
        XCTAssertEqual(WebViewUrlPolicy.decide("youcoded-app://app/%2e%2e/secrets", isPairedHost: never), .block)
        XCTAssertEqual(WebViewUrlPolicy.decide("youcoded-app://other/index.html", isPairedHost: never), .block)
        XCTAssertEqual(WebViewUrlPolicy.decide("file:///private/var/x.html", isPairedHost: never), .block)
        // A dev server the assistant started must never replace the app's page.
        XCTAssertEqual(WebViewUrlPolicy.decide("http://localhost:5173/", isPairedHost: never), .openExternally)
    }

    func testOnlyWebAndMailLinksLeaveTheApp() {
        XCTAssertEqual(WebViewUrlPolicy.decide("https://example.com/a", isPairedHost: never), .openExternally)
        XCTAssertEqual(WebViewUrlPolicy.decide("MAILTO:someone@example.com", isPairedHost: never), .openExternally)
        for link in ["tel:+15551234567", "sms:+15551234567", "itms-apps://apps.apple.com/app/id1", "tailscale://", " https://example.com", "javascript:alert(1)", "data:text/html,hi"] {
            XCTAssertEqual(WebViewUrlPolicy.decide(link, isPairedHost: never), .block, link)
        }
    }

    func testADownloadIsOnlyAMintedLinkFromAPairedComputer() {
        let good = "http://100.101.102.103:9900/download/\(token)/report.pdf"
        XCTAssertEqual(WebViewUrlPolicy.decide(good, isPairedHost: paired), .download)
        // Same link, but the phone never paired with that computer: a web link like any other.
        XCTAssertEqual(WebViewUrlPolicy.decide(good, isPairedHost: never), .openExternally)
        // Wrong token length, credentials in the address, or a plain-http host that is not Tailscale.
        XCTAssertEqual(WebViewUrlPolicy.decide("http://100.101.102.103:9900/download/short/report.pdf", isPairedHost: paired), .openExternally)
        XCTAssertEqual(WebViewUrlPolicy.decide("http://user:pw@100.101.102.103:9900/download/\(token)/report.pdf", isPairedHost: paired), .openExternally)
        XCTAssertEqual(WebViewUrlPolicy.decide("http://192.168.1.5:9900/download/\(token)/report.pdf", isPairedHost: { _, _ in true }), .openExternally)
    }

    func testDownloadNamesArePlainVisibleAndKeepTheirExtension() {
        func name(_ last: String) -> String { WebViewUrlPolicy.downloadFileName("http://100.101.102.103:9900/download/\(token)/\(last)") }
        XCTAssertEqual(name("report.pdf"), "report.pdf")
        XCTAssertEqual(name("r%C3%A9sum%C3%A9.pdf"), "résumé.pdf")
        XCTAssertEqual(name("..%2F..%2Fetc%2Fpasswd"), "passwd")
        XCTAssertEqual(name(".hidden"), "_hidden")
        // A right-to-left override cannot dress an .exe up as a .pdf: it becomes a visible underscore.
        XCTAssertEqual(name("invoice%E2%80%AEfdp.exe"), "invoice_fdp.exe")
        XCTAssertEqual(WebViewUrlPolicy.downloadFileName("http://100.101.102.103:9900/download/\(token)"), "download")
        let long = name(String(repeating: "x", count: 400) + ".pdf")
        XCTAssertLessThanOrEqual(long.utf8.count, WebViewUrlPolicy.maxNameBytes)
        XCTAssertTrue(long.hasSuffix(".pdf"))
    }

    func testPairedComputerLookup() {
        let json = #"[{"name":"Desk","host":"My-PC.tail.ts.net","port":9900,"password":"x"},{"name":"Six","host":"[fd7a:115c:a1e0::5]"}]"#
        XCTAssertTrue(PairedDevices.matches(devicesJSON: json, host: "my-pc.tail.ts.net", port: 9900))
        XCTAssertFalse(PairedDevices.matches(devicesJSON: json, host: "my-pc.tail.ts.net", port: 9901))
        XCTAssertTrue(PairedDevices.matches(devicesJSON: json, host: "fd7a:115c:a1e0::5", port: 9900))
        XCTAssertFalse(PairedDevices.matches(devicesJSON: "not json", host: "x", port: 1))
        XCTAssertFalse(PairedDevices.matches(devicesJSON: json, host: "", port: 9900))
    }

    func testSignInLinks() {
        for link in [
            "https://claude.ai/oauth/authorize?client_id=x",
            "https://auth.openai.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455",
            "https://openrouter.ai/auth?callback_url=http://127.0.0.1:3000",
            "https://github.com/login/device",
            "https://api.youcoded.ai/auth/github/start-redirect",
        ] {
            XCTAssertTrue(SignInLinks.isSignInLink(URL(string: link)!), link)
        }
        for link in ["https://example.com/oauth", "https://claude.ai/chat/123", "https://github.com/itsdestin/youcoded", "https://evilclaude.ai/oauth"] {
            XCTAssertFalse(SignInLinks.isSignInLink(URL(string: link)!), link)
        }
    }

    func testAttachmentNamesKeepEveryScriptButNothingUnsafe() {
        XCTAssertEqual(AttachmentStore.safeName("résumé.pdf"), "résumé.pdf")
        XCTAssertEqual(AttachmentStore.safeName("报告 2026.docx"), "报告 2026.docx")
        XCTAssertEqual(AttachmentStore.safeName("../../etc/passwd"), "passwd")
        XCTAssertEqual(AttachmentStore.safeName("a:b*c?.txt"), "a_b_c_.txt")
        XCTAssertEqual(AttachmentStore.safeName("...hidden"), "hidden")
        XCTAssertEqual(AttachmentStore.safeName(nil), "attachment")
        XCTAssertEqual(AttachmentStore.safeName("///"), "attachment")
        let long = AttachmentStore.safeName(String(repeating: "й", count: 300) + ".pdf")
        XCTAssertLessThanOrEqual(long.utf8.count, AttachmentStore.maxNameBytes)
        XCTAssertTrue(long.hasSuffix(".pdf"))
    }

    func testAttachmentCopiesAreSeparateSizeLimitedAndSwept() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("attach-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source.txt")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("hello".utf8).write(to: source)
        let store = root.appendingPathComponent("store")
        let now = Date()

        let first = try AttachmentStore.save(root: store, name: "image.jpg", source: source, now: now)
        let second = try AttachmentStore.save(root: store, name: "image.jpg", source: source, now: now)
        XCTAssertNotEqual(first.path, second.path, "two picks of the same name must not overwrite each other")
        XCTAssertEqual(first.lastPathComponent, "image.jpg")

        XCTAssertThrowsError(try AttachmentStore.save(root: store, name: "big.bin", source: source, maxBytes: 2)) { error in
            XCTAssertTrue((error as? AttachmentStore.Refused)?.message.contains("larger than") ?? false)
        }

        AttachmentStore.sweep(root: store, now: now.addingTimeInterval(60))
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path), "a fresh copy survives a sweep")
        AttachmentStore.sweep(root: store, now: now.addingTimeInterval(AttachmentStore.maxAge + 3600))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path), "a copy older than seven days is removed")
    }

    func testVoiceSplitsSolidTextFromTheTail() {
        XCTAssertEqual(VoiceRecognizer.splitAtLastSentenceEnd("Hello there. How are").committed, "Hello there.")
        XCTAssertEqual(VoiceRecognizer.splitAtLastSentenceEnd("Hello there. How are").tail, " How are")
        XCTAssertEqual(VoiceRecognizer.splitAtLastSentenceEnd("no end yet").committed, "")
    }

    func testHostTokenComparison() {
        XCTAssertTrue(HostSocketServer.constantTimeEquals("abc123", "abc123"))
        XCTAssertFalse(HostSocketServer.constantTimeEquals("abc123", "abc124"))
        XCTAssertFalse(HostSocketServer.constantTimeEquals("", ""), "an empty token never matches")
        XCTAssertFalse(HostSocketServer.constantTimeEquals("abc", "abcd"))
    }
}
