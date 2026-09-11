package com.youcoded.app.ui

import com.youcoded.app.runtime.PairedDeviceStore
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
 * http://<paired computer>/download/<43-char token>/<name>. Before T8, every URL
 * that was not local went to ACTION_VIEW, so a Download landed in Chrome as a
 * page. The decision is a pure function so it can be driven here without a
 * device; the framework call (DownloadManager) is not.
 *
 * Hardened after the T8 review: a download needs the EXACT token shape AND a
 * host:port the phone has paired with. "Any http(s) host" let any link in the
 * chat, or a previewed HTML page, drop a stranger's file into Downloads.
 */
class WebViewUrlRouterTest {

    private val token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"

    /** The phone's paired computers, as the store would answer. */
    private val paired: (String, Int) -> Boolean = { host, port ->
        (host == "100.64.0.9" && port == 9900) ||
            (host == "desk.tailnet.ts.net" && port == 443) ||
            (host == "fd7a:115c::1" && port == 9900)
    }

    private fun decide(url: String) = WebViewUrlPolicy.decide(url, paired)

    private class FakeActions : WebViewUrlRouter.Actions {
        val downloads = mutableListOf<Pair<String, String>>()
        val external = mutableListOf<String>()
        override fun download(url: String, fileName: String) { downloads += url to fileName }
        override fun openExternally(url: String) { external += url }
    }

    @Test fun `the token is the shape the desktop mints`() {
        assertEquals(43, token.length)
    }

    @Test fun `a download link from a paired computer is a download`() {
        for (url in listOf(
            "http://100.64.0.9:9900/download/$token/report.pdf",
            "https://desk.tailnet.ts.net/download/$token/a.zip",
            "http://100.64.0.9:9900/download/$token",
            "http://100.64.0.9:9900/download/$token/report.pdf?x=1#part",
            "http://[fd7a:115c::1]:9900/download/$token/notes.md",
        )) {
            assertEquals(url, UrlDecision.DOWNLOAD, decide(url))
        }
    }

    @Test fun `a download-shaped link from anywhere else opens outside the app, as before`() {
        for (url in listOf(
            // A stranger's server: never saved silently into Downloads.
            "https://example.com/download/$token/setup.apk",
            // The paired computer's address on another port.
            "http://100.64.0.9:9901/download/$token/report.pdf",
            // An ordinary website's download page, not a minted link.
            "http://100.64.0.9:9900/download/setup/app.zip",
            "http://100.64.0.9:9900/download/$token/extra/segment",
            "http://100.64.0.9:9900/download/",
            "http://100.64.0.9:9900/download",
            // Credentials in the link, or a scheme the download manager rejects.
            "http://user@100.64.0.9:9900/download/$token/report.pdf",
            "HTTP://100.64.0.9:9900/download/$token/report.pdf",
        )) {
            assertEquals(url, UrlDecision.OPEN_EXTERNALLY, decide(url))
        }
    }

    @Test fun `the bundled page and the dev servers load in place`() {
        for (url in listOf(
            "file:///android_asset/web/index.html?bridgePort=9901",
            "http://localhost:5173/",
            "http://10.0.2.2:5173/src/main.tsx",
            "http://localhost:9950/download/$token/x.bin",
        )) {
            assertEquals(url, UrlDecision.LOAD, decide(url))
        }
    }

    // Before, "local" was a text prefix, so these replaced the app's own page
    // with an outside site inside the app window (T8 review, finding 6).
    @Test fun `lookalike local addresses are not local`() {
        for (url in listOf(
            "http://localhost.evil.com/",
            "http://localhost@evil.com/",
            "http://10.0.2.2.evil.com/",
            "http://10.0.2.20/",
            "https://localhost/",
        )) {
            assertEquals(url, UrlDecision.OPEN_EXTERNALLY, decide(url))
        }
    }

    @Test fun `every other link opens outside the app`() {
        for (url in listOf(
            "https://github.com/itsdestin/youcoded",
            "http://100.64.0.9:9900/",
            "https://example.com/some/download/nested",
            "mailto:someone@example.com",
            "intent://scan/#Intent;scheme=zxing;end",
        )) {
            assertEquals(url, UrlDecision.OPEN_EXTERNALLY, decide(url))
        }
    }

    @Test fun `the navigation override downloads, loads, or hands out`() {
        val actions = FakeActions()
        val router = WebViewUrlRouter(actions, paired)
        assertTrue(router.onNavigation("http://100.64.0.9:9900/download/$token/report%20final.pdf"))
        assertFalse(router.onNavigation("file:///android_asset/web/index.html"))
        assertTrue(router.onNavigation("https://example.com/download/$token/setup.apk"))
        assertEquals(listOf("http://100.64.0.9:9900/download/$token/report%20final.pdf" to "report final.pdf"), actions.downloads)
        assertEquals(listOf("https://example.com/download/$token/setup.apk"), actions.external)
    }

    // The path a same-origin click, or a response that turns out to be an
    // attachment, takes — so the download can never go dark on that route.
    @Test fun `the download listener routes the same links, and ignores what nothing outside can open`() {
        val actions = FakeActions()
        val router = WebViewUrlRouter(actions, paired)
        router.onDownloadRequested("https://desk.tailnet.ts.net/download/$token/a.zip")
        router.onDownloadRequested("https://example.com/elsewhere.zip")
        router.onDownloadRequested("file:///android_asset/web/index.html")
        router.onDownloadRequested("blob:file:///6c1a2b3c-0000-4000-8000-000000000000")
        router.onDownloadRequested("data:text/plain;base64,aGk=")
        assertEquals(listOf("https://desk.tailnet.ts.net/download/$token/a.zip" to "a.zip"), actions.downloads)
        assertEquals(listOf("https://example.com/elsewhere.zip"), actions.external)
    }

    // The name lands in setDestinationInExternalPublicDir(DIRECTORY_DOWNLOADS, name):
    // it must be one plain, openable file name, whatever the link says.
    @Test fun `the saved file name is one safe name`() {
        val base = "http://h/download/$token/"
        assertEquals("report.pdf", WebViewUrlPolicy.downloadFileName(base + "report.pdf"))
        // Android's shared storage refuses the FAT-reserved set ("*:<>?|); the
        // emoji, the space and the semicolon are fine.
        assertEquals("odd_; name 🎉.txt", WebViewUrlPolicy.downloadFileName(base + "odd%22%3B%20name%20%F0%9F%8E%89.txt"))
        assertEquals("a_b_c.txt", WebViewUrlPolicy.downloadFileName(base + "a%3Ab%3Fc.txt"))
        assertEquals("c++ notes.md", WebViewUrlPolicy.downloadFileName(base + "c++%20notes.md"))
        assertEquals("passwd", WebViewUrlPolicy.downloadFileName(base + "..%2F..%2Fetc%2Fpasswd"))
        assertEquals("evil.sh", WebViewUrlPolicy.downloadFileName(base + "a%5Cb%5Cevil.sh"))
        assertEquals("line_break.txt", WebViewUrlPolicy.downloadFileName(base + "line%0Abreak.txt"))
        assertEquals("download", WebViewUrlPolicy.downloadFileName(base + ".."))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("http://h/download/$token"))
        assertEquals("download", WebViewUrlPolicy.downloadFileName(base))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("not a url at all"))
    }

    // A right-to-left override shows "invoicekpa.pdf" for an .apk (T8 review, finding 5).
    @Test fun `invisible and formatting characters cannot disguise the name`() {
        val base = "http://h/download/$token/"
        assertEquals("invoice_fdp.apk", WebViewUrlPolicy.downloadFileName(base + "invoice%E2%80%AEfdp.apk"))
        assertEquals("a_b.txt", WebViewUrlPolicy.downloadFileName(base + "a%C2%85b.txt"))
        assertEquals("a_b.txt", WebViewUrlPolicy.downloadFileName(base + "a%E2%80%8Fb.txt"))
    }

    // Android caps a file name at 255 BYTES; a long name must stay valid and
    // keep its extension so the file still opens (T8 review, finding 4).
    @Test fun `a long name is cut by bytes, on character boundaries, keeping the extension`() {
        val base = "http://h/download/$token/"
        for (stem in listOf("a".repeat(300), "文".repeat(200), "🎉".repeat(120))) {
            val encoded = java.net.URLEncoder.encode("$stem.pdf", "UTF-8").replace("+", "%20")
            val name = WebViewUrlPolicy.downloadFileName(base + encoded)
            assertTrue(name, name.endsWith(".pdf"))
            assertTrue("${name.toByteArray(Charsets.UTF_8).size} bytes", name.toByteArray(Charsets.UTF_8).size <= WebViewUrlPolicy.MAX_NAME_BYTES)
            assertTrue("a split surrogate pair", name.indices.none { i ->
                val c = name[i]
                (Character.isHighSurrogate(c) && (i + 1 >= name.length || !Character.isLowSurrogate(name[i + 1]))) ||
                    (Character.isLowSurrogate(c) && (i == 0 || !Character.isHighSurrogate(name[i - 1])))
            })
        }
    }

    @Test fun `a link matches a paired computer by host and port`() {
        val json = """[{"name":"Desk","host":"100.64.0.9","port":9900,"password":"x"},{"host":"Desk.Tailnet.ts.net","port":443}]"""
        assertTrue(PairedDeviceStore.matches(json, "100.64.0.9", 9900))
        assertFalse(PairedDeviceStore.matches(json, "100.64.0.9", 9901))
        assertFalse(PairedDeviceStore.matches(json, "100.64.0.10", 9900))
        assertTrue("host names are case-insensitive", PairedDeviceStore.matches(json, "desk.tailnet.ts.net", 443))
        assertTrue("IPv6 brackets are not part of the host",
            PairedDeviceStore.matches("""[{"host":"[fd7a:115c::1]","port":9900}]""", "fd7a:115c::1", 9900))
        assertFalse(PairedDeviceStore.matches(null, "100.64.0.9", 9900))
        assertFalse(PairedDeviceStore.matches("not json", "100.64.0.9", 9900))
        assertFalse(PairedDeviceStore.matches("""[{"port":9900}]""", "", 9900))
    }

    /**
     * Both framework entry points must feed the router. A source check, because
     * the WebView itself cannot be constructed in a JVM test. Comments are
     * stripped (never the `//` inside "file://"), and the override's BODY is
     * extracted by brace matching, so a reformat does not break the check and an
     * ACTION_VIEW moved anywhere into the override still fails it.
     * Gradle runs unit tests from the module directory (app/).
     */
    @Test fun `WebViewHost drives the router from both the override and the download listener`() {
        val src = File("src/main/kotlin/com/youcoded/app/ui/WebViewHost.kt").readText()
            .replace(Regex("""/\*[\s\S]*?\*/"""), "")
            .replace(Regex("""(?<!:)//[^\n]*"""), "")
        val sig = src.indexOf("fun shouldOverrideUrlLoading(")
        assertTrue("no shouldOverrideUrlLoading override", sig >= 0)
        val open = src.indexOf('{', src.indexOf(')', sig))
        var depth = 0
        var close = -1
        for (i in open until src.length) {
            if (src[i] == '{') depth++
            if (src[i] == '}') { depth--; if (depth == 0) { close = i; break } }
        }
        val body = src.substring(open, close + 1)
        assertTrue("the override must delegate to urlRouter.onNavigation", body.contains("urlRouter.onNavigation("))
        assertFalse("the override still opens links itself", body.contains("ACTION_VIEW") || body.contains("startActivity"))

        val listeners = Regex("""setDownloadListener""").findAll(src).count()
        assertEquals("exactly one download listener", 1, listeners)
        assertTrue("the download listener must call urlRouter.onDownloadRequested",
            Regex("""setDownloadListener\s*\{[^}]*urlRouter\.onDownloadRequested\(""").containsMatchIn(src))
        assertTrue("the router must be told which computers are paired",
            Regex("""WebViewUrlRouter\([\s\S]*PairedDeviceStore\.isPaired\(""").containsMatchIn(src))
    }
}
