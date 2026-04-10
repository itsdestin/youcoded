package com.destin.code.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.destin.code.runtime.BaseTerminalViewClient
import com.destin.code.runtime.SessionService
import com.termux.view.TerminalView

/** Apply dark terminal colors to a terminal emulator. */
private fun applyTerminalColors(session: com.termux.terminal.TerminalSession?) {
    val emulator = session?.emulator ?: return
    emulator.mColors.tryParseColor(256, "#E0E0E0") // foreground
    emulator.mColors.tryParseColor(257, "#0A0A0A") // background
    emulator.mColors.tryParseColor(258, "#E0E0E0") // cursor
}

enum class ScreenMode { Chat, Terminal }

@Composable
fun ChatScreen(service: SessionService) {
    val sessions by service.sessionRegistry.sessions.collectAsState()
    val currentSessionId by service.sessionRegistry.currentSessionId.collectAsState()
    val currentSession = currentSessionId?.let { sessions[it] }

    var screenMode by remember { mutableStateOf(ScreenMode.Chat) }

    // React UI and native code send view switch requests via SharedFlow
    LaunchedEffect(Unit) {
        service.viewModeRequest.collect { mode ->
            when (mode) {
                "terminal" -> screenMode = ScreenMode.Terminal
                "chat" -> screenMode = ScreenMode.Chat
            }
        }
    }

    // Auto-switch to terminal for shell sessions
    LaunchedEffect(currentSession?.shellMode) {
        if (currentSession?.shellMode == true) {
            screenMode = ScreenMode.Terminal
        }
    }

    // Layout insets from React UI (header and bottom bar heights in px)
    var headerHeightPx by remember { mutableIntStateOf(0) }
    var bottomBarHeightPx by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        service.layoutInsets.collect { insets ->
            headerHeightPx = insets.headerPx
            bottomBarHeightPx = insets.bottomPx
        }
    }

    val density = LocalDensity.current
    val headerHeightDp = with(density) { headerHeightPx.toDp() }
    val bottomBarHeightDp = with(density) { bottomBarHeightPx.toDp() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF111111))
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        // Layer 1 (behind): Native terminal — padded to fit the React UI "hole"
        if (currentSession != null && screenMode == ScreenMode.Terminal) {
            key(currentSessionId) {
                val termViewClient = remember { BaseTerminalViewClient() }
                val termScreenVersion by currentSession.screenVersion.collectAsState()
                var userScrolledUp by remember { mutableStateOf(false) }
                var attachedSession by remember { mutableStateOf<com.termux.terminal.TerminalSession?>(null) }

                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(top = headerHeightDp, bottom = bottomBarHeightDp)
                ) {
                    AndroidView(
                        factory = { ctx ->
                            val termSession = currentSession.getTerminalSession()
                            TerminalView(ctx, null).apply {
                                setTextSize((12 * resources.displayMetrics.scaledDensity).toInt())
                                setTerminalViewClient(termViewClient)
                                isFocusable = true
                                isFocusableInTouchMode = true
                                termSession?.let {
                                    attachSession(it)
                                    attachedSession = it
                                }
                            }
                        },
                        update = { view ->
                            val session = currentSession.getTerminalSession()
                            if (session != null && session !== attachedSession) {
                                view.attachSession(session)
                                attachedSession = session
                            }
                            applyTerminalColors(session)
                            view.setBackgroundColor(0xFF0A0A0A.toInt())
                            @Suppress("UNUSED_EXPRESSION")
                            termScreenVersion
                            try {
                                val wasScrolledUp = view.topRow < 0
                                if (wasScrolledUp) userScrolledUp = true
                                if (userScrolledUp && wasScrolledUp) {
                                    val saved = view.topRow
                                    view.onScreenUpdated()
                                    view.topRow = saved
                                } else {
                                    userScrolledUp = false
                                    view.onScreenUpdated()
                                }
                            } catch (_: Exception) {
                                // Termux TerminalBuffer throws during resize race — safe to ignore
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            } // key(currentSessionId)
        }

        // Layer 2 (on top): WebView — ALWAYS full size, transparent middle lets terminal show through
        // Security: pass bridge auth token so WebView can authenticate with LocalBridgeServer
        WebViewHost(
            modifier = Modifier.fillMaxSize(),
            bridgeAuthToken = service.bridgeServer.authToken
        )
    }
}
