import XCTest

/// The whole app, started for real in a simulator: Node boots the desktop backend, the page loads from the app's
/// private address, signs in to the backend over its loopback socket and draws. This is the iPhone's version of
/// "does the Android Dev copy start" — the one check no unit test can stand in for.
///
/// Screenshots go to $SCREENSHOT_DIR when set (CI passes TEST_RUNNER_SCREENSHOT_DIR), so a person can see what the
/// app looked like in the run.
final class LaunchTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func snap(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testAppStartsAndShowsThePage() {
        let app = XCUIApplication()
        app.launch()
        snap("01-launch")

        // The loading screen goes away only when the page says it is ready (or the backend failed).
        let loading = app.otherElements["loading"]
        let failed = app.otherElements["failed"]
        let deadline = Date().addingTimeInterval(150)
        while Date() < deadline {
            if failed.exists { break }
            if !loading.exists, app.webViews.firstMatch.exists { break }
            Thread.sleep(forTimeInterval: 1)
        }
        snap("02-after-start")

        if failed.exists {
            // Put the backend's own words in the test log.
            app.buttons["Show details"].tap()
            snap("02-failed-details")
            XCTFail("The app showed its failed screen: \(app.textViews.firstMatch.value as? String ?? "(no details)")")
            return
        }
        XCTAssertFalse(loading.exists, "the loading screen never went away")
        let page = app.webViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "no page was shown")

        // The page drew something a person can read (the welcome screen, or the app itself).
        let anyText = page.staticTexts.firstMatch
        XCTAssertTrue(anyText.waitForExistence(timeout: 60), "the page is blank")
        Thread.sleep(forTimeInterval: 3)
        snap("03-page")

        let words = page.staticTexts.allElementsBoundByIndex.prefix(40).map(\.label).filter { !$0.isEmpty }
        print("PAGE TEXT: \(words.joined(separator: " | "))")
    }
}
