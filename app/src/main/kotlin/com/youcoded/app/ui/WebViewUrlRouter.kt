package com.youcoded.app.ui

import java.net.URI
import java.net.URLDecoder

/**
 * What the app's WebView does with a URL it is asked to open (remote access
 * batch 3, technical design 2026-09-10 §10, Android column).
 *
 * WHY this exists: the page is the bundled file:// UI, and when it is paired to
 * a desktop the Download button opens http://<desktop>/download/<token>/<name>.
 * WebViewHost used to send every non-local URL to ACTION_VIEW, so that link
 * opened in Chrome as a page instead of saving into the phone's Downloads
 * (contract R9, R20: always saved, never displayed).
 *
 * Kept free of android.* on purpose so a JVM unit test can drive it
 * (WebViewUrlRouterTest). The unit tests run against a stubbed android.jar that
 * answers null for android.net.Uri, so java.net.URI does the parsing here.
 */
enum class UrlDecision { LOAD, DOWNLOAD, OPEN_EXTERNALLY }

object WebViewUrlPolicy {
    private const val DOWNLOAD_ROUTE = "/download/"
    private const val FALLBACK_NAME = "download"
    private const val MAX_NAME_CHARS = 200

    /**
     * `/download/<token>` on ANY http(s) host is a download. WHY no host check:
     * Kotlin cannot see the paired host (it lives in the WebView's storage), and
     * the 256-bit token in the path is the whole secret, so a host check would
     * add nothing (design review R3-5). Checked before "local" so a download
     * from a dev host on localhost still downloads.
     */
    fun decide(url: String): UrlDecision {
        if (isDownloadLink(url)) return UrlDecision.DOWNLOAD
        if (isLocal(url)) return UrlDecision.LOAD
        return UrlDecision.OPEN_EXTERNALLY
    }

    /**
     * The one plain file name to save as. It lands in
     * setDestinationInExternalPublicDir(DIRECTORY_DOWNLOADS, name), so it must
     * never carry a directory (`../`), a control character, or a character
     * Android's shared storage refuses (the FAT set FileUtils.buildValidFatFilename
     * replaces). Anything unusable falls back to "download".
     */
    fun downloadFileName(url: String): String {
        val rawPath = parse(url)?.rawPath ?: return FALLBACK_NAME
        if (!rawPath.startsWith(DOWNLOAD_ROUTE)) return FALLBACK_NAME
        val afterToken = rawPath.removePrefix(DOWNLOAD_ROUTE)
        val slash = afterToken.indexOf('/')
        if (slash < 0) return FALLBACK_NAME
        // URLDecoder turns '+' into a space; a path's '+' is a literal plus.
        val decoded = try {
            URLDecoder.decode(afterToken.substring(slash + 1).replace("+", "%2B"), "UTF-8")
        } catch (_: IllegalArgumentException) {
            return FALLBACK_NAME
        }
        val base = decoded.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base
            .replace(Regex("[\\u0000-\\u001f\\u007f\"*:<>?|]"), "_")
            .trim()
            .take(MAX_NAME_CHARS)
        return if (cleaned.isEmpty() || cleaned.all { it == '.' }) FALLBACK_NAME else cleaned
    }

    // Exactly the rule WebViewHost applied before downloads existed: the bundled
    // page and the dev servers load in place; everything else leaves the app.
    private fun isLocal(url: String): Boolean =
        url.startsWith("file://") || url.startsWith("http://localhost") || url.startsWith("http://10.0.2.2")

    private fun isDownloadLink(url: String): Boolean {
        val uri = parse(url) ?: return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        if (uri.rawAuthority.isNullOrEmpty()) return false
        val path = uri.rawPath ?: return false
        if (!path.startsWith(DOWNLOAD_ROUTE)) return false
        return path.removePrefix(DOWNLOAD_ROUTE).substringBefore('/').isNotEmpty()
    }

    private fun parse(url: String): URI? = try { URI(url) } catch (_: Exception) { null }
}

/**
 * Both WebView entry points feed this one router, so a download can never go
 * dark on either path: shouldOverrideUrlLoading (the route a cross-origin
 * `<a download>` click from the file:// page takes) and setDownloadListener
 * (the route a same-origin click, or a response that turns out to be an
 * attachment, takes). The Actions are the framework calls, injected so the
 * routing is testable.
 */
class WebViewUrlRouter(private val actions: Actions) {
    interface Actions {
        fun download(url: String, fileName: String)
        fun openExternally(url: String)
    }

    /** Returns true when the WebView must NOT load the URL itself. */
    fun onNavigation(url: String): Boolean = when (WebViewUrlPolicy.decide(url)) {
        UrlDecision.DOWNLOAD -> { actions.download(url, WebViewUrlPolicy.downloadFileName(url)); true }
        UrlDecision.OPEN_EXTERNALLY -> { actions.openExternally(url); true }
        UrlDecision.LOAD -> false
    }

    fun onDownloadRequested(url: String) {
        when (WebViewUrlPolicy.decide(url)) {
            UrlDecision.DOWNLOAD -> actions.download(url, WebViewUrlPolicy.downloadFileName(url))
            UrlDecision.OPEN_EXTERNALLY -> actions.openExternally(url)
            // A download of the bundled page's own file:// content: the app
            // offers none, and there is nothing outside the app to hand it to.
            UrlDecision.LOAD -> Unit
        }
    }
}
