package com.youcoded.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Remote access batch 3, design test 12 — the Android app's WebView downloads
 * (technical design 2026-09-10 §10, Android column; contract rows R9, R20).
 *
 * The phone's page is file://, and the Download button opens
 * http://<desktop>/download/<token>/<name>. Before this, every URL that was not
 * local went to ACTION_VIEW, so a Download landed in Chrome as a page instead of
 * in the phone's Downloads folder. The decision is a pure function so it can be
 * driven here without a device; the framework call (DownloadManager) is not.
 */
class WebViewUrlRouterTest {

    private class FakeActions : WebViewUrlRouter.Actions {
        val downloads = mutableListOf<Pair<String, String>>()
        val external = mutableListOf<String>()
        override fun download(url: String, fileName: String) { downloads += url to fileName }
        override fun openExternally(url: String) { external += url }
    }

    @Test fun `a download link on any http or https host is a download`() {
        for (url in listOf(
            "http://100.64.0.9:9900/download/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/report.pdf",
            "https://desk.tailnet.ts.net/download/tok/a.zip",
            "HTTP://192.168.1.20:9900/download/tok/notes.md",
            "http://localhost:9950/download/tok/x.bin",
        )) {
            assertEquals(url, UrlDecision.DOWNLOAD, WebViewUrlPolicy.decide(url))
        }
    }

    @Test fun `the bundled page and the local bridge load in place`() {
        for (url in listOf(
            "file:///android_asset/web/index.html?bridgePort=9901",
            "http://localhost:5173/",
            "http://10.0.2.2:5173/src/main.tsx",
        )) {
            assertEquals(url, UrlDecision.LOAD, WebViewUrlPolicy.decide(url))
        }
    }

    @Test fun `every other link opens outside the app, as before`() {
        for (url in listOf(
            "https://github.com/itsdestin/youcoded",
            "http://100.64.0.9:9900/",
            "http://100.64.0.9:9900/downloads/not-the-route",
            "https://example.com/some/download/nested",
            "mailto:someone@example.com",
        )) {
            assertEquals(url, UrlDecision.OPEN_EXTERNALLY, WebViewUrlPolicy.decide(url))
        }
    }

    @Test fun `a download needs a token after the route`() {
        assertEquals(UrlDecision.OPEN_EXTERNALLY, WebViewUrlPolicy.decide("http://100.64.0.9:9900/download/"))
        assertEquals(UrlDecision.OPEN_EXTERNALLY, WebViewUrlPolicy.decide("http://100.64.0.9:9900/download"))
    }

    @Test fun `the navigation override routes a download and consumes it`() {
        val actions = FakeActions()
        val router = WebViewUrlRouter(actions)
        val consumed = router.onNavigation("http://100.64.0.9:9900/download/tok/report%20final.pdf")
        assertTrue(consumed)
        assertEquals(listOf("http://100.64.0.9:9900/download/tok/report%20final.pdf" to "report final.pdf"), actions.downloads)
        assertEquals(emptyList<String>(), actions.external)
    }

    @Test fun `the navigation override leaves the local page alone and hands other links out`() {
        val actions = FakeActions()
        val router = WebViewUrlRouter(actions)
        assertFalse(router.onNavigation("file:///android_asset/web/index.html"))
        assertTrue(router.onNavigation("https://github.com/"))
        assertEquals(listOf("https://github.com/"), actions.external)
        assertEquals(emptyList<Pair<String, String>>(), actions.downloads)
    }

    // The path a same-origin click (or a response that turned out to be an
    // attachment) takes — so the download can never go dark on that route.
    @Test fun `the download listener routes the same links the same way`() {
        val actions = FakeActions()
        val router = WebViewUrlRouter(actions)
        router.onDownloadRequested("https://desk.tailnet.ts.net/download/tok/a.zip")
        router.onDownloadRequested("https://example.com/elsewhere.zip")
        router.onDownloadRequested("file:///android_asset/web/index.html")
        assertEquals(listOf("https://desk.tailnet.ts.net/download/tok/a.zip" to "a.zip"), actions.downloads)
        assertEquals(listOf("https://example.com/elsewhere.zip"), actions.external)
    }

    // The name lands in setDestinationInExternalPublicDir(DIRECTORY_DOWNLOADS, name):
    // it must be one plain file name, whatever the link says.
    @Test fun `the saved file name is one safe name`() {
        assertEquals("report.pdf", WebViewUrlPolicy.downloadFileName("http://h/download/tok/report.pdf"))
        // Android's shared storage refuses the FAT-reserved set ("*:<>?|); the
        // emoji, the space and the semicolon are fine.
        assertEquals("odd_; name 🎉.txt", WebViewUrlPolicy.downloadFileName("http://h/download/tok/" + "odd%22%3B%20name%20%F0%9F%8E%89.txt"))
        assertEquals("a_b_c.txt", WebViewUrlPolicy.downloadFileName("http://h/download/tok/a%3Ab%3Fc.txt"))
        assertEquals("c++ notes.md", WebViewUrlPolicy.downloadFileName("http://h/download/tok/c++%20notes.md"))
        assertEquals("passwd", WebViewUrlPolicy.downloadFileName("http://h/download/tok/..%2F..%2Fetc%2Fpasswd"))
        assertEquals("evil.sh", WebViewUrlPolicy.downloadFileName("http://h/download/tok/a%5Cb%5Cevil.sh"))
        assertEquals("line_break.txt", WebViewUrlPolicy.downloadFileName("http://h/download/tok/line%0Abreak.txt"))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("http://h/download/tok/.."))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("http://h/download/tok"))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("http://h/download/tok/"))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("not a url at all"))
    }

    /**
     * Both framework entry points must feed the router. A source check, because
     * the WebView itself cannot be constructed in a JVM test — anchored to the
     * two exact calls, so a WebViewHost that stops delegating either fails here.
     * Gradle runs unit tests from the module directory (app/).
     */
    @Test fun `WebViewHost drives the router from both the override and the download listener`() {
        val src = File("src/main/kotlin/com/youcoded/app/ui/WebViewHost.kt").readText()
            .replace(Regex("//[^\n]*"), "")
        assertTrue("shouldOverrideUrlLoading must return router.onNavigation(url)",
            Regex("""override fun shouldOverrideUrlLoading\([^)]*\): Boolean \{\s*return urlRouter\.onNavigation\(""").containsMatchIn(src))
        assertTrue("setDownloadListener must call router.onDownloadRequested(url)",
            Regex("""setDownloadListener \{ url, [^}]*->\s*urlRouter\.onDownloadRequested\(url\)""").containsMatchIn(src))
        // The old blanket ACTION_VIEW for every non-local URL is gone from the override.
        assertFalse("the override still hands every non-local URL to ACTION_VIEW",
            Regex("""shouldOverrideUrlLoading[\s\S]{0,400}Intent\.ACTION_VIEW""").containsMatchIn(src))
    }
}
