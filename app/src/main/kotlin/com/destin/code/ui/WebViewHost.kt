package com.destin.code.ui

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewHost(
    modifier: Modifier = Modifier,
    devUrl: String? = null
) {
    var webView by remember { mutableStateOf<WebView?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            webView?.destroy()
        }
    }

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
                    allowFileAccessFromFileURLs = false // Security: block cross-origin file reads
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

                val url = devUrl ?: "file:///android_asset/web/index.html"
                loadUrl(url)

                webView = this
            }
        }
    )
}
