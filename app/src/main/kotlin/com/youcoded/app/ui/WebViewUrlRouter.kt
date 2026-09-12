package com.youcoded.app.ui

import java.net.URI
import java.net.URLDecoder

/**
 * What the app's WebView does with a URL it is asked to open (remote access
 * batch 3, technical design 2026-09-10 §10, Android column).
 *
 * WHY this exists: the page is the bundled file:// UI, and when it is paired to
 * a desktop the Download button opens
 * http://<paired computer>/download/<43-char token>/<name>. WebViewHost used to
 * send every non-local URL to ACTION_VIEW, so that link opened in Chrome as a
 * page instead of saving into the phone's Downloads (contract R9, R20: always
 * saved, never displayed).
 *
 * Kept free of android.* on purpose so a JVM unit test can drive it
 * (WebViewUrlRouterTest). The unit tests run against a stubbed android.jar that
 * answers null for android.net.Uri, so java.net.URI does the parsing here.
 */
enum class UrlDecision {
    /** The WebView loads it in place: the bundled page, or a dev server. */
    LOAD,
    /** Saved into Downloads through DownloadManager. */
    DOWNLOAD,
    /** Handed to another app (a browser, a mail app). */
    OPEN_EXTERNALLY,
    /** Neither loaded nor handed out: a file:// address other than the bundled page. */
    BLOCK,
}

object WebViewUrlPolicy {
    private const val DOWNLOAD_ROUTE = "/download/"
    private const val FALLBACK_NAME = "download"
    private const val ASSET_PREFIX = "file:///android_asset/"

    /**
     * Android caps a file name at 255 BYTES. A little under, so the download
     * manager's own " (1)" for a name that already exists still fits.
     */
    const val MAX_NAME_BYTES = 240

    /** An extension (dot included) longer than this is treated as part of the name. */
    private const val MAX_EXTENSION_CHARS = 33

    /** The exact path the desktop mints (remote-download.ts ROUTE): a 43-char base64url token, an optional name. */
    private val MINTED_PATH = Regex("^/download/[A-Za-z0-9_-]{43}(/[^/]*)?$")

    /**
     * Characters that show as nothing, or as a blank, and are dropped outright:
     * soft hyphen, the combining grapheme joiner, the Hangul and halfwidth
     * fillers, the Khmer inherent vowels, the Mongolian selectors, the braille
     * blank and the variation selectors (T8 re-review, finding 2).
     */
    private val INVISIBLE_FILLERS = Regex("[\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u2800\\u3164\\uFE00-\\uFE0F\\uFFA0]")

    /**
     * Control and formatting characters (a right-to-left override can show an
     * .apk as a .pdf; T8 review, finding 5), plus the characters Android's shared
     * storage refuses (the FAT set FileUtils.buildValidFatFilename replaces).
     */
    private val UNSAFE_NAME_CHARS = Regex("[\\p{Cc}\\p{Cf}\"*:<>?|]")

    /**
     * Every kind of space, and line and paragraph separators, in runs. Each run
     * shows as one ordinary space, so "invoice.pdf", a separator and ".apk" can
     * never push the real extension out of sight (T8 re-review, finding 2).
     */
    private val SEPARATOR_RUNS = Regex("\\p{Z}+")

    private val LOCAL_DEV_HOSTS = setOf("localhost", "10.0.2.2")
    private val PLAIN_HOST = Regex("^[A-Za-z0-9._-]+$")

    /**
     * A link is a download only when it has the exact minted shape AND comes
     * from a computer this phone paired with. WHY the host check (T8 review,
     * finding 1): with "any http(s) host", a link in the chat or a previewed
     * HTML page could save a stranger's file into the shared Downloads folder
     * under a name of their choosing. The token protects files on the paired
     * computer; only the host check protects the phone.
     *
     * A file:// address loads in place only inside the bundled page's own asset
     * folder. WHY (T8 re-review, finding 1): a tapped file:///…/Download/x.html
     * used to load AS the app's page, sharing its storage — which holds the
     * pairing credential — and its file access. Any other file:// address is
     * refused, not handed out: no other app can open a file:// URL from here.
     */
    fun decide(url: String, isPairedHost: (host: String, port: Int) -> Boolean): UrlDecision {
        val uri = parse(url)
        if (uri != null && isMintedDownload(uri, isPairedHost)) return UrlDecision.DOWNLOAD
        if (url.startsWith("file:")) return if (isBundledAsset(url)) UrlDecision.LOAD else UrlDecision.BLOCK
        if (isDevServer(uri)) return UrlDecision.LOAD
        return UrlDecision.OPEN_EXTERNALLY
    }

    /**
     * The one plain, visible, openable file name to save as. It lands in the
     * Downloads folder, so it never carries a directory (`../`), an invisible,
     * control or formatting character, or a character shared storage refuses;
     * it never starts with a dot (a hidden file nobody can find); and it is cut
     * by BYTES on character boundaries, keeping its extension, so the file still
     * opens (T8 review, finding 4). Anything unusable falls back to "download".
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
        var cleaned = INVISIBLE_FILLERS.replace(base, "")
        cleaned = UNSAFE_NAME_CHARS.replace(cleaned, "_")
        cleaned = SEPARATOR_RUNS.replace(cleaned, " ").trim()
        if (cleaned.isEmpty() || cleaned.all { it == '.' }) return FALLBACK_NAME
        // A leading dot would save a hidden file (T8 re-review, finding 7).
        cleaned = cleaned.replace(Regex("^\\.+"), "_")
        return fitBytes(cleaned)
    }

    private fun isMintedDownload(uri: URI, isPairedHost: (String, Int) -> Boolean): Boolean {
        // Exact lowercase schemes: DownloadManager.Request rejects anything else.
        val scheme = uri.scheme ?: return false
        if (scheme != "http" && scheme != "https") return false
        // A link carrying credentials is never a minted link.
        if (uri.rawUserInfo != null) return false
        val path = uri.rawPath ?: return false
        if (!MINTED_PATH.matches(path)) return false
        val (host, port) = hostAndPort(uri, scheme) ?: return false
        return isPairedHost(host, port)
    }

    /**
     * java.net.URI answers a null host for a name it will not treat as a server
     * name — one with an underscore, common for local machines — so the raw
     * authority is read directly then, accepting only a plain name and a port
     * (T8 re-review, finding 6).
     */
    private fun hostAndPort(uri: URI, scheme: String): Pair<String, Int>? {
        val defaultPort = if (scheme == "https") 443 else 80
        val parsedHost = uri.host
        if (parsedHost != null) {
            val host = parsedHost.removePrefix("[").removeSuffix("]")
            if (host.isEmpty()) return null
            return host to (if (uri.port != -1) uri.port else defaultPort)
        }
        val authority = uri.rawAuthority ?: return null
        val colon = authority.lastIndexOf(':')
        val host = if (colon >= 0) authority.substring(0, colon) else authority
        val port = if (colon >= 0) (authority.substring(colon + 1).toIntOrNull() ?: return null) else defaultPort
        if (!PLAIN_HOST.matches(host)) return null
        return host to port
    }

    /** Inside the bundled asset folder, with no way back out of it. */
    private fun isBundledAsset(url: String): Boolean {
        if (!url.startsWith(ASSET_PREFIX)) return false
        val path = url.substring(ASSET_PREFIX.length).substringBefore('?').substringBefore('#')
        val lower = path.lowercase()
        return !lower.contains("..") && !lower.contains("%2e") && !lower.contains("%2f") &&
            !lower.contains("%5c") && !path.contains('\\')
    }

    /**
     * The two dev-server hosts, compared EXACTLY. WHY not a text prefix (the old
     * rule): "http://localhost.evil.com/" and "http://localhost@evil.com/" both
     * start with "http://localhost", and loaded an outside site in place of the
     * app's own page (T8 review, finding 6).
     */
    private fun isDevServer(uri: URI?): Boolean {
        if (uri == null || uri.scheme != "http" || uri.rawUserInfo != null) return false
        return uri.host in LOCAL_DEV_HOSTS
    }

    private fun fitBytes(name: String): String {
        if (name.toByteArray(Charsets.UTF_8).size <= MAX_NAME_BYTES) return name
        val dot = name.lastIndexOf('.')
        val ext = if (dot > 0 && name.length - dot <= MAX_EXTENSION_CHARS) name.substring(dot) else ""
        val stem = if (ext.isEmpty()) name else name.substring(0, dot)
        val budget = MAX_NAME_BYTES - ext.toByteArray(Charsets.UTF_8).size
        val out = StringBuilder()
        var used = 0
        var i = 0
        while (i < stem.length) {
            val codePoint = stem.codePointAt(i)
            val bytes = String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8).size
            if (used + bytes > budget) break
            out.appendCodePoint(codePoint)
            used += bytes
            i += Character.charCount(codePoint)
        }
        val kept = out.toString().trimEnd()
        return (if (kept.isEmpty()) FALLBACK_NAME else kept) + ext
    }

    private fun parse(url: String): URI? = try { URI(url) } catch (_: Exception) { null }
}

/**
 * Both WebView entry points feed this one router, so a download can never go
 * dark on either path: shouldOverrideUrlLoading (the route a cross-origin
 * `<a download>` click from the file:// page takes) and setDownloadListener
 * (the route a same-origin click, or a response that turns out to be an
 * attachment, takes). The Actions are the framework calls and isPairedHost is
 * the paired-device lookup, both injected so the routing is testable.
 */
class WebViewUrlRouter(
    private val actions: Actions,
    private val isPairedHost: (host: String, port: Int) -> Boolean,
) {
    interface Actions {
        fun download(url: String, fileName: String)
        fun openExternally(url: String)
    }

    /** Returns true when the WebView must NOT load the URL itself. */
    fun onNavigation(url: String): Boolean = when (WebViewUrlPolicy.decide(url, isPairedHost)) {
        UrlDecision.DOWNLOAD -> { actions.download(url, WebViewUrlPolicy.downloadFileName(url)); true }
        UrlDecision.OPEN_EXTERNALLY -> { actions.openExternally(url); true }
        UrlDecision.BLOCK -> true
        UrlDecision.LOAD -> false
    }

    fun onDownloadRequested(url: String) {
        when (WebViewUrlPolicy.decide(url, isPairedHost)) {
            UrlDecision.DOWNLOAD -> actions.download(url, WebViewUrlPolicy.downloadFileName(url))
            // A download from an ordinary website goes to the browser, as a tap
            // on its link would. A blob: or data: download is page-made content
            // that nothing outside the app can open, so it is left alone.
            UrlDecision.OPEN_EXTERNALLY ->
                if (url.startsWith("http://") || url.startsWith("https://")) actions.openExternally(url)
            // The bundled page's own content, or a refused file:// address:
            // nothing to save and nothing outside the app to hand it to.
            UrlDecision.LOAD, UrlDecision.BLOCK -> Unit
        }
    }
}
