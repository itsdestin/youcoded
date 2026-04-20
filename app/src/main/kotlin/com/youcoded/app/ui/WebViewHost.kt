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
    bridgeAuthToken: String? = null
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

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url.toString()
                        if (!url.startsWith("file://") && !url.startsWith("http://localhost") && !url.startsWith("http://10.0.2.2")) {
                            context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url))
                            return true
                        }
                        return false
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
                // before any JS runs — avoids race with remote-shim.ts connect()
                val baseUrl = devUrl ?: "file:///android_asset/web/index.html"
                val url = if (bridgeAuthToken != null) "$baseUrl?bridgeToken=$bridgeAuthToken" else baseUrl
                loadUrl(url)

                webView = this
            }
        }
    )
}
