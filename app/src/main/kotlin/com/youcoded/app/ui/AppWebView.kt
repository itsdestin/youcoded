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
                allowFileAccess = true // the bundled page is file:///android_asset/web
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
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
            }, isPairedHost = { h, port -> PairedDeviceStore.isPaired(context, h, port) })
            setDownloadListener { url, _, _, _, _ -> urlRouter.onDownloadRequested(url) }

            val themesDir = File(homeDir, ".claude/wecoded-themes")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    return urlRouter.onNavigation(request.url.toString())
                }

                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    val uri = request?.url ?: return null
                    if (uri.scheme != "theme-asset") return null
                    return themeAsset(themesDir, uri)
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

    fun pageUrl(port: Int, token: String): String =
        "file:///android_asset/web/index.html?bridgeToken=$token&bridgePort=$port"

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
