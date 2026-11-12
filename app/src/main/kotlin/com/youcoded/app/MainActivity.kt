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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import kotlinx.coroutines.delay
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.youcoded.app.bridge.HostJsBridge
import com.youcoded.app.runtime.BackendService
import com.youcoded.app.runtime.RuntimeInstaller
import com.youcoded.app.ui.AppWebView
import com.youcoded.app.ui.BrandLoadingScreen
import com.youcoded.app.ui.LegacyStorageMigration
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
    /** The page has drawn something real (see Page). Until then the brand loading screen covers it. */
    private val pageReady = mutableStateOf(false)
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
    private var pendingHostPick: ((List<Uri>) -> Unit)? = null
    // The paperclip's picker (HostJsBridge "android:pick-files"): separate from the WebView's own file chooser below.
    private val hostFilePicker = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pendingHostPick?.invoke(uris); pendingHostPick = null
    }
    private val filePicker = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        pendingFiles?.onReceiveValue(uris.toTypedArray()); pendingFiles = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        onBackPressedDispatcher.addCallback(this, backCallback)
        host = HostJsBridge(applicationContext, this)
        current = this
        openSessionFrom(intent)
        BackendService.start(applicationContext)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            AppTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val state by BackendService.state.collectAsStateWithLifecycle()
                    val s0 = state
                    // WHY one loading screen until the page is really ready (Destin, 2026-11-02: "on the first launch after
                    // reinstall, there are still a lot of jumps to screens with differently positioned brand name/loading
                    // lines"): a screen recording showed the brand screen, then a black frame, a grey page with a faint
                    // spinner and the page's own "Starting YouCoded…" with the logo near the top, before the app. The page
                    // now loads UNDER this screen, which fades away only once the page says it is ready (pageReady).
                    val covered = !pageReady.value && s0 !is BackendService.State.Failed
                    if (!(s0 is BackendService.State.Starting && loadedToken == null)) Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                        when (val s = state) {
                            is BackendService.State.Ready -> Page(s)
                            is BackendService.State.Starting -> Page(null)
                            is BackendService.State.Failed -> Failed(s.message)
                        }
                        showQr.value?.let { done ->
                            QrScannerOverlay(
                                onScanned = { url -> showQr.value = null; done(url) },
                                onDismiss = { showQr.value = null; done(null) },
                            )
                        }
                    }
                    // Outside the padded box: the brand screen fills the whole display, behind the status and navigation bars.
                    AnimatedVisibility(visible = covered, enter = EnterTransition.None, exit = fadeOut(tween(180))) {
                        Starting(if (s0 is BackendService.State.Starting) s0.message else "Starting the assistant…")
                    }
                }
            }
        }
    }

    // WHY (2026-11-01 phone test): a "needs you" alert put the session id on its intent but nothing read it. The activity is
    // single-top, so a tap while the app is open arrives in onNewIntent; a tap from a closed app arrives in onCreate.
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openSessionFrom(intent)
    }

    private fun openSessionFrom(intent: android.content.Intent?) {
        intent?.getStringExtra(com.youcoded.app.runtime.StatusNotifier.EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() }?.let {
            host.openSession(it)
            // Handled: a later rotation or recreate must not replay it.
            intent.removeExtra(com.youcoded.app.runtime.StatusNotifier.EXTRA_SESSION_ID)
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
        // WHY no imePadding (Destin, 2026-11-02: "the app responds to the keyboard slowly"): padding the page by the keyboard
        // resized the whole WebView on every frame of the keyboard's slide — 25 resizes in 340 ms, each re-allocating the
        // page's surfaces and redrawing all of it, so the graphics thread was busy 370 ms of a 340 ms animation (measured
        // with a timeline trace on a Galaxy Z Flip7). The page keeps its size; the keyboard covers its bottom, and the
        // page is told the keyboard's height each frame. The page was built for exactly this (hooks/useVisualViewport.ts,
        // the --vvp-offset rules in globals.css): the message box rides up on a transform, which costs no redraw.
        // Measured from the bottom of the navigation bar, which the Box above already keeps clear of.
        val density = LocalDensity.current
        // The keyboard's FINAL height, known as soon as it starts to slide (imeAnimationTarget), sent once — the page
        // glides there by itself (keyboard.css). Sending every frame of the slide kept the page restyling every frame
        // and still trailed the keyboard (Destin: "still feels a bit stuttery/flickery").
        @OptIn(ExperimentalLayoutApi::class)
        val ime = WindowInsets.imeAnimationTarget
        val nav = WindowInsets.navigationBars
        // The page's own bottom edge is what the message box sits on, so the keyboard's top is measured from it (the
        // navigation bar inset alone said the same on a Z Flip7, but the page's edge is the one that matters).
        val imeNow = WindowInsets.ime
        val gapPx = {
            val wv = webView
            if (wv != null && wv.isLaidOut) {
                val loc = IntArray(2).also { wv.getLocationInWindow(it) }
                wv.rootView.height - (loc[1] + wv.height)
            } else nav.getBottom(density)
        }
        LaunchedEffect(Unit) {
            snapshotFlow { ime.getBottom(density) }
                .distinctUntilChanged()
                .collect { target ->
                    val dp = (target - gapPx()).coerceAtLeast(0) / density.density
                    webView?.evaluateJavascript("window.__ycImeOffset&&window.__ycImeOffset($dp)", null)
                }
        }
        // WHY the keyboard's RESTING height is sent too, once its slide ends (Destin, 2026-11-03: "the frame/input area
        // still slightly overshoots the keyboard sometimes before falling back down"; a temporary log caught it): Samsung's
        // keyboard on a Z Flip7 often announces its final height as 284 dp when it starts to slide and corrects it to
        // 255 dp a third of a second later, after the slide — so the page glided to 284 and fell back. The page cannot
        // know at the start; with the resting height it corrects at once AND remembers the pair, so the next open
        // aims at 255 straight away (useVisualViewport.ts). Read per frame here (no page work), sent only when the
        // slide has come to rest (the current height equals the announced one).
        LaunchedEffect(Unit) {
            snapshotFlow { imeNow.getBottom(density) to ime.getBottom(density) }
                .filter { (now, target) -> now == target }
                .map { it.first }
                .distinctUntilChanged()
                .collect { rest ->
                    val dp = (rest - gapPx()).coerceAtLeast(0) / density.density
                    webView?.evaluateJavascript("window.__ycImeOffset&&window.__ycImeOffset($dp,true)", null)
                }
        }
        // Ask the page whether it is ready (it sets window.__ycBootReady once the app or a sign-in/trouble screen is up,
        // App.tsx / remote-gate.tsx). Polled, not a bridge message: it is one boolean read every 150 ms only while the
        // loading screen shows. Twenty seconds at most, so a page that never says so is never hidden for good.
        LaunchedEffect(ready?.token) {
            if (ready == null || pageReady.value) return@LaunchedEffect
            val started = System.currentTimeMillis()
            while (!pageReady.value) {
                delay(150)
                webView?.evaluateJavascript("!!window.__ycBootReady") { if (it == "true") pageReady.value = true }
                if (System.currentTimeMillis() - started > 20_000) pageReady.value = true
            }
        }
        LaunchedEffect(ready?.token) {
            if (ready != null && ready.token != loadedToken) {
                loadedToken = ready.token
                host.expectedToken = ready.token
                val view = webView
                if (view != null) {
                    // WHY (2026-10-30 audit A2): the page moved from a file:// address to an https one, and saved look settings are kept
                    // per address, so they are copied across once first. Always opens the page, even if the copy fails.
                    LegacyStorageMigration.prepare(applicationContext, view) { view.loadUrl(AppWebView.pageUrl(ready.port, ready.token)) }
                }
            }
        }
    }

    /** The brand loading screen (ui/BrandLoading.kt). Dark status-bar icons while it shows, so they read on the lavender;
     *  the page sets its own once it loads, so the previous setting is put back when this screen goes. */
    @Composable
    private fun Starting(message: String) {
        val view = LocalView.current
        DisposableEffect(Unit) {
            val bars = WindowCompat.getInsetsController(window, view)
            val wasLight = bars.isAppearanceLightStatusBars to bars.isAppearanceLightNavigationBars
            bars.isAppearanceLightStatusBars = true
            bars.isAppearanceLightNavigationBars = true
            onDispose { bars.isAppearanceLightStatusBars = wasLight.first; bars.isAppearanceLightNavigationBars = wasLight.second }
        }
        BrandLoadingScreen(message)
    }

    /**
     * The backend could not start. WHY (2026-11-01 phone test, docs/error-message-standards.md): the old screen dumped
     * raw log text. Now: a plain sentence that claims no cause, the technical text folded away under "Show details",
     * Try again, and Report bug (says what a report holds, then opens a prefilled GitHub issue).
     */
    @Composable
    private fun Failed(detail: String) {
        val retrying = remember { mutableStateOf(false) }
        val showDetails = remember { mutableStateOf(false) }
        // WHY (2026-11-09 final review, Q-14): Report bug used to open a public ticket with app log lines already
        // in it, unannounced. It now opens this panel first: what the report holds, the exact log lines, and a
        // tick to leave them out, like the bug-report step in the rest of the app.
        val reporting = remember { mutableStateOf(false) }
        val includeLog = remember { mutableStateOf(true) }
        val logLines = remember(detail) { startupLogLines(detail) }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp),
            verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("YouCoded couldn’t start its assistant", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
            Text(
                "Something went wrong while starting up. Your chats and files are safe. Trying again often fixes it; if it keeps happening, send us a report.",
                style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(16.dp))
            TextButton(onClick = { showDetails.value = !showDetails.value }) { Text(if (showDetails.value) "Hide details" else "Show details") }
            if (showDetails.value) {
                Text(detail, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Start)
            }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { reporting.value = !reporting.value }) { Text("Report bug") }
                Button(enabled = !retrying.value, onClick = { retrying.value = true; BackendService.start(applicationContext, restart = true) }) {
                    // WHY "Try again": every retry button in YouCoded reads exactly this (error-notices-1#EN-Q1).
                    Text(if (retrying.value) "Trying again…" else "Try again")
                }
            }
            if (reporting.value) {
                Spacer(Modifier.height(16.dp))
                Text(
                    "A report opens a public page on GitHub in your browser, where you can edit it before sending. It holds this app’s version, your Android version and your phone’s model.",
                    style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Start,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = includeLog.value, onCheckedChange = { includeLog.value = it })
                    Text("Include the app’s log, shown below. It can contain folder and file names.", style = MaterialTheme.typography.bodyMedium)
                }
                if (includeLog.value) {
                    Text(logLines.joinToString("\n"), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Start)
                    Spacer(Modifier.height(8.dp))
                }
                Button(onClick = { reportStartupBug(if (includeLog.value) logLines else emptyList()) }) { Text("Open report") }
            }
        }
    }

    /** The end of the backend's log, cut to what fits in a link (GitHub rejects very long ones): what a report would carry. */
    private fun startupLogLines(detail: String): List<String> {
        var lines = runCatching {
            java.io.File(RuntimeInstaller(applicationContext).userData, "backend.log").readLines().takeLast(40)
        }.getOrElse { listOf(detail) }.ifEmpty { listOf(detail) }.map { it.take(400) }
        while (Uri.encode(lines.joinToString("\n")).length > 5500 && lines.size > 1) lines = lines.drop(1)
        return lines
    }

    /** Open a prefilled GitHub issue: app + Android version, and [logLines] only when the person left the tick on. */
    private fun reportStartupBug(logLines: List<String>) {
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "unknown"
        val body = "The assistant could not start.\n\nApp version: $version\nAndroid: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}\n" +
            if (logLines.isEmpty()) "" else "\nLast lines of backend.log:\n```\n${logLines.joinToString("\n")}\n```\n"
        val url = "https://github.com/itsdestin/youcoded/issues/new?title=" + Uri.encode("Android: assistant couldn’t start") + "&body=" + Uri.encode(body)
        runCatching { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url))) }
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

    override fun pickFiles(done: (List<Uri>) -> Unit) {
        if (isFinishing || isDestroyed) { done(emptyList()); return }
        pendingHostPick?.invoke(emptyList())
        pendingHostPick = done
        hostFilePicker.launch("*/*")
    }

    override fun setBackStackEmpty(empty: Boolean) { backCallback.isEnabled = !empty }

    companion object {
        /** On screen right now (Android lets a visible app open links in other apps; BackendService checks this). */
        @Volatile var visible = false
            private set
        /** The live window, so the background service can open a sign-in tab on top of it (SignInReturn). */
        @Volatile var current: MainActivity? = null
            private set
    }

    override fun onStart() { super.onStart(); visible = true }
    override fun onStop() { visible = false; super.onStop() }

    override fun onDestroy() {
        if (current === this) current = null
        if (isFinishing) { host.release(); webView?.destroy(); webView = null }
        super.onDestroy()
    }
}
