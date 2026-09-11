package com.youcoded.app.ui

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.youcoded.app.BuildConfig
import java.io.File

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewHost(
    modifier: Modifier = Modifier,
    devUrl: String? = null,
    bridgeAuthToken: String? = null,
    // Per-build bridge port. Release uses 9901; debug uses 9951 so the dev APK
    // can run side-by-side with the released app without colliding on the same
    // localhost socket. React reads this from `location.search` in remote-shim.ts.
    bridgePort: Int = BuildConfig.BRIDGE_PORT
) {
    var webView by remember { mutableStateOf<WebView?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            webView?.destroy()
        }
    }

    // Security: only enable WebView debugging in debug builds
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )

                setBackgroundColor(Color.TRANSPARENT)

                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    allowFileAccess = true // needed for file:///android_asset/ bundled UI
                    // ES modules (<script type="module">) use fetch-like loading semantics.
                    // With allowFileAccessFromFileURLs=false, the WebView blocks the bundled
                    // JS chunks from loading via the module system, silently preventing React
                    // from mounting. Must be true for our own bundled assets to work.
                    // Security note: this only allows file:// pages to read other file:// URLs —
                    // since we control all content loaded into this WebView (bundled assets +
                    // theme-asset:// intercepts), there is no cross-origin risk.
                    @Suppress("DEPRECATION")
                    allowFileAccessFromFileURLs = true
                    allowUniversalAccessFromFileURLs = false // Security: enforce same-origin policy for file:// URLs
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
                    useWideViewPort = true
                    loadWithOverviewMode = true
                    setSupportZoom(false)
                    builtInZoomControls = false
                    displayZoomControls = false
                }

                // One router for both ways the WebView can be asked to open a URL
                // (remote access batch 3, design §10). WHY: on a phone paired to a
                // desktop, Download opens http://<desktop>/download/<token>/<name>,
                // and until now every non-local URL went to ACTION_VIEW, so the file
                // opened in Chrome as a page instead of saving to Downloads. The
                // decision is WebViewUrlPolicy (pure, unit-tested in
                // WebViewUrlRouterTest); these are only the framework calls it drives.
                val urlRouter = WebViewUrlRouter(object : WebViewUrlRouter.Actions {
                    override fun download(url: String, fileName: String) {
                        try {
                            val request = android.app.DownloadManager.Request(android.net.Uri.parse(url))
                                .setTitle(fileName)
                                .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                                // Android 10+: the shared Downloads folder needs no permission.
                                request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, fileName)
                            } else {
                                // Android 9 (minSdk 28) would need WRITE_EXTERNAL_STORAGE and a
                                // permission prompt for the shared folder; the app's own
                                // Downloads folder needs none, and the completed-download
                                // notification still opens the file.
                                request.setDestinationInExternalFilesDir(context, android.os.Environment.DIRECTORY_DOWNLOADS, fileName)
                            }
                            val manager = context.getSystemService(android.content.Context.DOWNLOAD_SERVICE) as android.app.DownloadManager
                            manager.enqueue(request)
                        } catch (e: Exception) {
                            // The page already said "Saving…"; say plainly that it did not
                            // start, without guessing why (the log keeps the real reason).
                            android.util.Log.w("WebViewHost", "download could not start: ${e.message}")
                            android.widget.Toast.makeText(context, "Couldn’t start the download.", android.widget.Toast.LENGTH_LONG).show()
                        }
                    }

                    override fun openExternally(url: String) {
                        try {
                            context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                        } catch (_: android.content.ActivityNotFoundException) {
                            // Nothing on this phone opens that kind of link. Before the
                            // router this threw out of the WebView callback.
                        }
                    }
                })
                // The route a same-origin click, or a response that turns out to be an
                // attachment, takes, so a download can never go dark on this path.
                setDownloadListener { url, _, _, _, _ -> urlRouter.onDownloadRequested(url) }

                webViewClient = object : WebViewClient() {
                    // The route a cross-origin <a download> click from the file:// page takes.
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        return urlRouter.onNavigation(request.url.toString())
                    }

                    // Phase 5c: Intercept theme-asset:// URLs — Android equivalent
                    // of Electron's protocol.handle('theme-asset') in theme-protocol.ts.
                    // Resolves theme-asset://<slug>/<path> to files on disk.
                    override fun shouldInterceptRequest(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): WebResourceResponse? {
                        val uri = request?.url ?: return null
                        if (uri.scheme != "theme-asset") return super.shouldInterceptRequest(view, request)

                        val slug = uri.host ?: return WebResourceResponse(
                            "text/plain", "utf-8", 404, "Not Found", null,
                            "Missing theme slug".byteInputStream()
                        )
                        val assetPath = uri.path?.trimStart('/') ?: return WebResourceResponse(
                            "text/plain", "utf-8", 404, "Not Found", null,
                            "Missing asset path".byteInputStream()
                        )

                        // Fix: themes are installed under bootstrap.homeDir, which is
                        // context.filesDir/home (Termux convention — see Bootstrap.kt:31).
                        // Using context.filesDir directly looked in the wrong dir and
                        // every theme asset 404'd, so wallpapers/icons never rendered.
                        val themesDir = File(context.filesDir, "home/.claude/wecoded-themes")
                        val file = File(themesDir, "$slug/$assetPath")

                        // Security: verify canonical path is inside themes dir
                        // to prevent path traversal attacks (e.g., ../../etc/passwd)
                        if (!file.canonicalPath.startsWith(themesDir.canonicalPath + File.separator)
                            && file.canonicalPath != themesDir.canonicalPath) {
                            return WebResourceResponse(
                                "text/plain", "utf-8", 403, "Forbidden", null,
                                "Path traversal blocked".byteInputStream()
                            )
                        }

                        if (!file.exists()) {
                            return WebResourceResponse(
                                "text/plain", "utf-8", 404, "Not Found", null,
                                "File not found".byteInputStream()
                            )
                        }

                        // MIME type detection — matches desktop's theme-protocol.ts
                        val mimeType = when (file.extension.lowercase()) {
                            "jpg", "jpeg" -> "image/jpeg"
                            "png" -> "image/png"
                            "webp" -> "image/webp"
                            "svg" -> "image/svg+xml"
                            "css" -> "text/css"
                            "json" -> "application/json"
                            "gif" -> "image/gif"
                            else -> "application/octet-stream"
                        }

                        return try {
                            WebResourceResponse(mimeType, null, file.inputStream())
                        } catch (_: Exception) {
                            WebResourceResponse(
                                "text/plain", "utf-8", 500, "Internal Error", null,
                                "Failed to read file".byteInputStream()
                            )
                        }
                    }
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                        android.util.Log.d(
                            "WebViewHost",
                            "${consoleMessage.messageLevel()}: ${consoleMessage.message()} " +
                                    "[${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}]"
                        )
                        return true
                    }
                }

                // Security: pass bridge auth token as query param so it's available
                // before any JS runs — avoids race with remote-shim.ts connect().
                // bridgePort piggybacks on the same query-string handoff so the
                // React shim can target the right port for this build variant.
                val baseUrl = devUrl ?: "file:///android_asset/web/index.html"
                val url = buildString {
                    append(baseUrl)
                    val params = mutableListOf<String>()
                    if (bridgeAuthToken != null) params += "bridgeToken=$bridgeAuthToken"
                    params += "bridgePort=$bridgePort"
                    if (params.isNotEmpty()) {
                        append('?')
                        append(params.joinToString("&"))
                    }
                }
                loadUrl(url)

                webView = this
            }
        }
    )
}
