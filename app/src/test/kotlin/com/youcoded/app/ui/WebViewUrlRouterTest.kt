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
 * Hardened after two T8 reviews: a download needs the EXACT token shape AND a
 * host:port the phone has paired with; only the bundled page loads in place
 * (any other file:// address is refused); and the saved name cannot hide what
 * the file is.
 */
class WebViewUrlRouterTest {

    private val token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"

    /** The phone's paired computers, as the store would answer. */
    private val paired: (String, Int) -> Boolean = { host, port ->
        (host == "100.64.0.9" && port == 9900) ||
            (host == "desk.tailnet.ts.net" && port == 443) ||
            (host == "fd7a:115c::1" && port == 9900) ||
            (host == "my_desk.local" && port == 9900)
    }

    private fun decide(url: String) = WebViewUrlPolicy.decide(url, paired)

    private class FakeActions : WebViewUrlRouter.Actions {
        val downloads = mutableListOf<Pair<String, String>>()
        val external = mutableListOf<String>()
        override fun download(url: String, fileName: String) { downloads += url to fileName }
        override fun openExternally(url: String) { external += url }
    }

    /** Pinned to the desktop's own route, so the two ends cannot drift apart. */
    @Test fun `the token is the shape the desktop mints`() {
        assertEquals(43, token.length)
        val routeLine = File("../desktop/src/main/remote-download.ts").readLines().first { it.startsWith("const ROUTE = ") }
        assertTrue(routeLine, routeLine.contains("[A-Za-z0-9_-]{43}"))
        assertEquals(UrlDecision.OPEN_EXTERNALLY, decide("http://100.64.0.9:9900/download/${token.dropLast(1)}/x.pdf"))
        assertEquals(UrlDecision.OPEN_EXTERNALLY, decide("http://100.64.0.9:9900/download/${token}A/x.pdf"))
    }

    @Test fun `a download link from a paired computer is a download`() {
        for (url in listOf(
            "http://100.64.0.9:9900/download/$token/report.pdf",
            "https://desk.tailnet.ts.net/download/$token/a.zip",
            "http://100.64.0.9:9900/download/$token",
            "http://100.64.0.9:9900/download/$token/report.pdf?x=1#part",
            "http://[fd7a:115c::1]:9900/download/$token/notes.md",
            // java.net.URI will not parse a host with an underscore; the link
            // from a computer named that way must still download.
            "http://my_desk.local:9900/download/$token/notes.md",
        )) {
            assertEquals(url, UrlDecision.DOWNLOAD, decide(url))
        }
    }

    @Test fun `a download-shaped link from anywhere else opens outside the app, as before`() {
        for (url in listOf(
            "https://example.com/download/$token/setup.apk",
            "http://100.64.0.9:9901/download/$token/report.pdf",
            "http://100.64.0.9:9900/download/setup/app.zip",
            "http://100.64.0.9:9900/download/$token/extra/segment",
            "http://100.64.0.9:9900/downloads/not-the-route",
            "http://100.64.0.9:9900/download/",
            "http://100.64.0.9:9900/download",
            "http://user@100.64.0.9:9900/download/$token/report.pdf",
            "http://my_desk.local:9901/download/$token/notes.md",
        )) {
            assertEquals(url, UrlDecision.OPEN_EXTERNALLY, decide(url))
        }
    }

    @Test fun `the bundled page and the dev servers load in place`() {
        for (url in listOf(
            "file:///android_asset/web/index.html?bridgePort=9901",
            "file:///android_asset/web/assets/index-abc123.js",
            "http://localhost:5173/",
            "http://10.0.2.2:5173/src/main.tsx",
            "http://localhost:9950/download/$token/x.bin",
        )) {
            assertEquals(url, UrlDecision.LOAD, decide(url))
        }
    }

    // A downloaded .html in the phone's storage, tapped, used to load AS the
    // app's own page — sharing its storage (which holds the pairing credential)
    // and its file access (T8 re-review, finding 1).
    @Test fun `no other file address loads in the app, or leaves it`() {
        for (url in listOf(
            "file:///storage/emulated/0/Download/report.html",
            "file:///sdcard/Download/x.html",
            "file:///data/data/com.youcoded.app/files/home/secret.txt",
            "file:///android_asset/../../data/data/com.youcoded.app/x",
            "file:///android_asset/%2e%2e/%2e%2e/data/x",
            "file:///android_asset/web%2F..%2F..%2Fx",
            "file:///android_assets/look-alike.html",
        )) {
            assertEquals(url, UrlDecision.BLOCK, decide(url))
        }
        val actions = FakeActions()
        val router = WebViewUrlRouter(actions, paired)
        assertTrue("a refused navigation is consumed", router.onNavigation("file:///sdcard/Download/x.html"))
        router.onDownloadRequested("file:///sdcard/Download/x.html")
        assertEquals(emptyList<String>(), actions.external)
        assertEquals(emptyList<Pair<String, String>>(), actions.downloads)
    }

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

    private val base = "http://h/download/$token/"
    private fun name(encoded: String) = WebViewUrlPolicy.downloadFileName(base + encoded)

    @Test fun `the saved file name is one safe name`() {
        assertEquals("report.pdf", name("report.pdf"))
        assertEquals("odd_; name 🎉.txt", name("odd%22%3B%20name%20%F0%9F%8E%89.txt"))
        assertEquals("a_b_c.txt", name("a%3Ab%3Fc.txt"))
        assertEquals("c++ notes.md", name("c++%20notes.md"))
        assertEquals("passwd", name("..%2F..%2Fetc%2Fpasswd"))
        assertEquals("evil.sh", name("a%5Cb%5Cevil.sh"))
        assertEquals("line_break.txt", name("line%0Abreak.txt"))
        assertEquals("download", name(".."))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("http://h/download/$token"))
        assertEquals("download", WebViewUrlPolicy.downloadFileName(base))
        assertEquals("download", WebViewUrlPolicy.downloadFileName("not a url at all"))
    }

    @Test fun `invisible and formatting characters cannot disguise the name`() {
        assertEquals("invoice_fdp.apk", name("invoice%E2%80%AEfdp.apk"))
        assertEquals("a_b.txt", name("a%C2%85b.txt"))
        assertEquals("a_b.txt", name("a%E2%80%8Fb.txt"))
        // A line or paragraph separator, or a run of spaces, used to push ".apk"
        // out of sight after "invoice.pdf" (T8 re-review, finding 2): each shows
        // as one ordinary space, so the whole name stays in view.
        assertEquals("invoice.pdf .apk", name("invoice.pdf%E2%80%A8.apk"))
        assertEquals("invoice.pdf .apk", name("invoice.pdf%E2%80%A9%E2%80%A9.apk"))
        assertEquals("invoice.pdf .apk", name("invoice.pdf" + "%20".repeat(60) + ".apk"))
        assertEquals("invoice.pdf .apk", name("invoice.pdf%E3%80%80%E3%80%80.apk"))
        // Blank-looking fillers are dropped outright.
        assertEquals("invoice.pdf.apk", name("invoice.pdf%E3%85%A4%E3%85%A4%E1%85%9F%E2%A0%80%CD%8F.apk"))
    }

    // A name that starts with a dot would be saved as a hidden file the person
    // cannot see in Downloads (T8 re-review, finding 7).
    @Test fun `a saved file is never hidden`() {
        assertEquals("_gitignore", name(".gitignore"))
        assertEquals("_x.txt", name("...x.txt"))
    }

    @Test fun `a long name is cut by bytes, on character boundaries, keeping the extension`() {
        for (stem in listOf("a".repeat(300), "文".repeat(200), "🎉".repeat(120))) {
            val encoded = java.net.URLEncoder.encode("$stem.pdf", "UTF-8").replace("+", "%20")
            val cut = name(encoded)
            assertTrue(cut, cut.endsWith(".pdf"))
            assertTrue("${cut.toByteArray(Charsets.UTF_8).size} bytes", cut.toByteArray(Charsets.UTF_8).size <= WebViewUrlPolicy.MAX_NAME_BYTES)
            assertTrue("a split surrogate pair", cut.indices.none { i ->
                val c = cut[i]
                (Character.isHighSurrogate(c) && (i + 1 >= cut.length || !Character.isLowSurrogate(cut[i + 1]))) ||
                    (Character.isLowSurrogate(c) && (i == 0 || !Character.isHighSurrogate(cut[i - 1])))
            })
        }
    }

    @Test fun `the byte limit, a name with no extension, and a long extension`() {
        val max = WebViewUrlPolicy.MAX_NAME_BYTES
        assertEquals("a".repeat(max), name("a".repeat(max)))
        assertEquals("a".repeat(max), name("a".repeat(max + 1)))
        assertEquals("a".repeat(max), name("a".repeat(400)))
        val longExt = ".backup-2026-09-10"   // 18 characters: still the file's extension
        val cut = name("b".repeat(400) + longExt)
        assertTrue(cut, cut.endsWith(longExt))
        assertTrue(cut.toByteArray(Charsets.UTF_8).size <= max)
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

    // Remove edits only the encrypted list; the old unencrypted list is read
    // only when no encrypted list exists yet, exactly when SessionService would
    // migrate it. Reading it always kept a removed computer trusted for good
    // (T8 re-review, finding 3).
    @Test fun `the old unencrypted list counts only until an encrypted one exists`() {
        val legacy = """[{"host":"100.64.0.9","port":9900}]"""
        assertEquals(legacy, PairedDeviceStore.effectiveDevicesJson(null) { legacy })
        assertEquals("[]", PairedDeviceStore.effectiveDevicesJson("[]") { legacy })
        assertEquals("""[{"host":"a","port":1}]""", PairedDeviceStore.effectiveDevicesJson("""[{"host":"a","port":1}]""") { legacy })
        var legacyRead = false
        PairedDeviceStore.effectiveDevicesJson("[]") { legacyRead = true; legacy }
        assertFalse("the old list is not even read once an encrypted list exists", legacyRead)
    }

    /**
     * Both framework entry points must feed the router. A source check, because
     * the WebView itself cannot be constructed in a JVM test. Comments are
     * stripped (never the `//` inside "file://"). The override's body must be
     * exactly the delegation, so "call the router, then return false" (which
     * would download AND load) fails, and the paired lookup is looked for inside
     * the router's own construction, not anywhere later in the file.
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
        assertTrue("the override must be exactly `return urlRouter.onNavigation(request.url.toString())`, got: $body",
            Regex("""^\{\s*return\s+urlRouter\.onNavigation\(\s*request\.url\.toString\(\)\s*\)\s*\}$""").matches(body.trim()))

        assertEquals("exactly one download listener", 1, Regex("""setDownloadListener""").findAll(src).count())
        assertTrue("the download listener must call urlRouter.onDownloadRequested",
            Regex("""setDownloadListener\s*\{[^}]*urlRouter\.onDownloadRequested\(""").containsMatchIn(src))

        val construction = src.indexOf("val urlRouter = WebViewUrlRouter(")
        val listener = src.indexOf("setDownloadListener", construction)
        assertTrue("the router is built before the listener", construction >= 0 && listener > construction)
        assertTrue("the router must be told which computers are paired",
            src.substring(construction, listener).contains("PairedDeviceStore.isPaired("))
    }
}
