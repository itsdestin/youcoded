package com.youcoded.app

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.youcoded.app.bridge.HostJsBridge
import com.youcoded.app.runtime.BackendService
import com.youcoded.app.runtime.RuntimeInstaller
import com.youcoded.app.ui.AppWebView
import com.youcoded.app.ui.QrScannerOverlay
import com.youcoded.app.ui.theme.AppTheme

/**
 * The app's one screen: a short "starting" view while the backend comes up, then the shared YouCoded page.
 *
 * WHY (2026-10-14, Android clean rebuild): everything the app does lives in the backend (BackendService) and
 * the shared page; this Activity only hosts the page and does what needs a screen — the QR scanner, the
 * microphone prompt, the file picker, the back button. The WebView is created once and kept across
 * configuration changes (the manifest lists them) so a rotation never reloads the page. A backend restart
 * changes the sign-in token, so the page is reloaded with the new one.
 */
class MainActivity : ComponentActivity(), HostJsBridge.Ui {

    private var webView: WebView? = null
    private var loadedToken: String? = null
    private lateinit var host: HostJsBridge
    private val showQr = mutableStateOf<((String?) -> Unit)?>(null)
    private var pendingMic: ((Boolean?) -> Unit)? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() { host.pressBack() }
    }

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pendingMic?.invoke(granted); pendingMic = null
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private val filePicker = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pendingFiles?.onReceiveValue(uris.toTypedArray()); pendingFiles = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        onBackPressedDispatcher.addCallback(this, backCallback)
        host = HostJsBridge(applicationContext, this)
        BackendService.start(applicationContext)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            AppTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
                        val state by BackendService.state.collectAsStateWithLifecycle()
                        when (val s = state) {
                            is BackendService.State.Ready -> Page(s)
                            is BackendService.State.Starting -> if (loadedToken == null) Starting(s.message) else Page(null)
                            is BackendService.State.Failed -> Failed(s.message)
                        }
                        showQr.value?.let { done ->
                            QrScannerOverlay(
                                onScanned = { url -> showQr.value = null; done(url) },
                                onDismiss = { showQr.value = null; done(null) },
                            )
                        }
                    }
                }
            }
        }
    }

    /** The page. Kept while the backend restarts (it reconnects by itself); reloaded when the token changes. */
    @Composable
    private fun Page(ready: BackendService.State.Ready?) {
        AndroidView(modifier = Modifier.fillMaxSize(), factory = {
            webView ?: AppWebView.create(this, host, RuntimeInstaller(applicationContext).home) { cb ->
                pendingFiles?.onReceiveValue(null)
                pendingFiles = cb
                filePicker.launch("*/*")
            }.also { webView = it }
        })
        LaunchedEffect(ready?.token) {
            if (ready != null && ready.token != loadedToken) {
                loadedToken = ready.token
                host.expectedToken = ready.token
                webView?.loadUrl(AppWebView.pageUrl(ready.port, ready.token))
            }
        }
    }

    @Composable
    private fun Starting(message: String) {
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            Spacer(Modifier.height(16.dp))
            Text(message, textAlign = TextAlign.Center)
        }
    }

    /** The backend could not start. Shows what it said last (its own words, not a guess) and a Retry. */
    @Composable
    private fun Failed(detail: String) {
        val retrying = remember { mutableStateOf(false) }
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text("YouCoded couldn’t start its assistant", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
            Text(detail, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
            Spacer(Modifier.height(20.dp))
            Button(enabled = !retrying.value, onClick = { retrying.value = true; BackendService.start(applicationContext, restart = true) }) {
                // WHY "Try again": every retry button in YouCoded reads exactly this (error-notices-1#EN-Q1).
                Text(if (retrying.value) "Trying again…" else "Try again")
            }
        }
    }

    // --- HostJsBridge.Ui ---------------------------------------------------------------------------------

    override fun evaluate(js: String) { webView?.evaluateJavascript(js, null) }

    override fun scanQr(done: (String?) -> Unit) {
        showQr.value?.invoke(null)
        showQr.value = done
    }

    override fun ensureMicPermission(done: (Boolean?) -> Unit) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { done(true); return }
        if (isFinishing || isDestroyed) { done(null); return }
        pendingMic?.invoke(null)
        pendingMic = done
        micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    override fun setBackStackEmpty(empty: Boolean) { backCallback.isEnabled = !empty }

    companion object {
        /** On screen right now (Android lets a visible app open links in other apps; BackendService checks this). */
        @Volatile var visible = false
            private set
    }

    override fun onStart() { super.onStart(); visible = true }
    override fun onStop() { visible = false; super.onStop() }

    override fun onDestroy() {
        if (isFinishing) { host.release(); webView?.destroy(); webView = null }
        super.onDestroy()
    }
}
