package com.youcoded.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import com.youcoded.app.BuildConfig
import com.youcoded.app.bridge.HostJsBridge
import com.youcoded.app.runtime.PairedDeviceStore
import java.io.File

/**
 * The WebView that shows the shared YouCoded page (the desktop's own React UI, bundled into assets/web).
 *
 * WHY (2026-10-14, Android clean rebuild): the page talks to the backend over ws://localhost:<port> with
 * this run's token (both in its query string, which the shim reads), and to the app through the
 * `YouCodedHost` object. Links, downloads and theme images keep the rules the old host had
 * (WebViewUrlRouter; theme-asset:// served from ~/.claude/wecoded-themes with no path escapes).
 * The page itself comes from WebViewAssetLoader at https://appassets.androidplatform.net/assets/web/ (2026-10-30 audit A2), not file://.
 * `<input type=file>` opens Android's picker, which is how the page attaches files.
 */
object AppWebView {
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    fun create(
        context: Context,
        host: HostJsBridge,
        homeDir: File,
        pickFiles: (ValueCallback<Array<Uri>>) -> Unit,
    ): WebView {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        return WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(Color.TRANSPARENT)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                // WHY file access is OFF (2026-10-30 security audit A2): the page is now served by WebViewAssetLoader from
                // https://appassets.androidplatform.net, so nothing needs file:// any more, and a script that ever ran in the page can no
                // longer read the app's private files by address.
                allowFileAccess = false
                allowContentAccess = false
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = false
                // WHY always-allow: the page is https now, and Android treats the plain ws:// link to a paired computer on Tailscale
                // as "mixed content" and would block it (a file:// page was never subject to that). The real rule is enforced
                // elsewhere: shouldInterceptRequest below refuses every plain http request except loopback/Tailscale, the page's
                // own security policy limits what it may fetch, and the page refuses to dial plain ws:// anywhere but Tailscale.
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                mediaPlaybackRequiresUserGesture = false
            }
            setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
            addJavascriptInterface(host, "YouCodedHost")

            val urlRouter = WebViewUrlRouter(object : WebViewUrlRouter.Actions {
                override fun download(url: String, fileName: String) {
                    try {
                        val request = android.app.DownloadManager.Request(Uri.parse(url))
                            .setTitle(fileName)
                            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                            .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, fileName)
                        android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(fileName.substringAfterLast('.', "").lowercase())
                            ?.let { request.setMimeType(it) }
                        (context.getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(request)
                    } catch (e: Exception) {
                        android.widget.Toast.makeText(context, "Couldn’t start the download.", android.widget.Toast.LENGTH_LONG).show()
                    }
                }
                override fun openExternally(url: String) {
                    runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url))) }
                }
            }, isPairedHost = { h, port -> PairedDeviceStore.isPaired(context, h, port) }, devServersInApp = BuildConfig.DEBUG)
            setDownloadListener { url, _, _, _, _ -> urlRouter.onDownloadRequested(url) }

            val themesDir = File(homeDir, ".claude/wecoded-themes")
            // WHY only web/ (not the whole assets folder): the app's assets also hold the bundled programs; the page needs just its own files.
            val assetLoader = WebViewAssetLoader.Builder()
                .setDomain(PAGE_HOST)
                .addPathHandler("/assets/", PageAssetsHandler(WebViewAssetLoader.AssetsPathHandler(context)))
                .build()
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) { LegacyStorageMigration.onPageLoaded(context) }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    return urlRouter.onNavigation(request.url.toString())
                }

                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    val uri = request?.url ?: return null
                    if (uri.scheme == "theme-asset") return themeAsset(themesDir, uri)
                    assetLoader.shouldInterceptRequest(uri)?.let { return it }
                    // WHY (2026-10-30 audit A1, "Tailscale only"): any plain http request the page makes (a picture, a fetch) to a
                    // host other than the phone itself or Tailscale is refused here, in code, because Android's network config
                    // cannot name an address range. Encrypted (https) requests are untouched.
                    if (!CleartextPolicy.isAllowed(uri.scheme, uri.host)) {
                        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, "Blocked".byteInputStream())
                    }
                    return null
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    android.util.Log.d("AppWebView", "${m.messageLevel()}: ${m.message()} [${m.sourceId()}:${m.lineNumber()}]")
                    return true
                }
                override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>, params: FileChooserParams?): Boolean {
                    pickFiles(callback)
                    return true
                }
            }
        }
    }

    /** The private name the page is served from. Must match ANDROID_PAGE_ORIGIN in renderer/android-page.ts and WebViewUrlPolicy.PAGE_ORIGIN. */
    const val PAGE_HOST = "appassets.androidplatform.net"
    const val PAGE_ORIGIN = "https://$PAGE_HOST"

    fun pageUrl(port: Int, token: String): String =
        "$PAGE_ORIGIN/assets/web/index.html?bridgeToken=$token&bridgePort=$port"

    /** Serves only paths under web/ (no ".."), and gives the file types the page's scripts and workers need their correct names. */
    private class PageAssetsHandler(private val inner: WebViewAssetLoader.PathHandler) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            if (!path.startsWith("web/") || path.contains("..") || path.contains('\\')) return null
            val response = inner.handle(path) ?: return null
            val type = when (path.substringBefore('?').substringAfterLast('.', "").lowercase()) {
                "js", "mjs" -> "text/javascript"; "css" -> "text/css"; "html" -> "text/html"; "json" -> "application/json"
                "wasm" -> "application/wasm"; "svg" -> "image/svg+xml"; "woff2" -> "font/woff2"; "woff" -> "font/woff"; "ttf" -> "font/ttf"
                else -> null
            }
            if (type != null) response.mimeType = type
            return response
        }
    }

    private fun themeAsset(themesDir: File, uri: Uri): WebResourceResponse {
        fun text(code: Int, reason: String) = WebResourceResponse("text/plain", "utf-8", code, reason, null, reason.byteInputStream())
        val slug = uri.host ?: return text(404, "Not Found")
        val rel = uri.path?.trimStart('/') ?: return text(404, "Not Found")
        val file = File(themesDir, "$slug/$rel")
        if (!file.canonicalPath.startsWith(themesDir.canonicalPath + File.separator)) return text(403, "Forbidden")
        if (!file.isFile) return text(404, "Not Found")
        val mime = when (file.extension.lowercase()) {
            "jpg", "jpeg" -> "image/jpeg"; "png" -> "image/png"; "webp" -> "image/webp"; "svg" -> "image/svg+xml"
            "css" -> "text/css"; "json" -> "application/json"; "gif" -> "image/gif"; else -> "application/octet-stream"
        }
        return runCatching { WebResourceResponse(mime, null, file.inputStream()) }.getOrElse { text(500, "Internal Error") }
    }
}
