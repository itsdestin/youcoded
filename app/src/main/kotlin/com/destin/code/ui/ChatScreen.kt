package com.destin.code.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.destin.code.runtime.SessionService

/**
 * Full-screen WebView host. The React app (loaded from assets/web/index.html)
 * owns all UI: empty state, session creation, chat, terminal (xterm.js), menus.
 */
@Composable
fun ChatScreen(service: SessionService) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF111111))
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        WebViewHost(modifier = Modifier.fillMaxSize())
    }
}
