package com.destins.claudemobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import com.destins.claudemobile.runtime.Bootstrap
import com.destins.claudemobile.ui.SetupScreen
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val bootstrap = Bootstrap(applicationContext)

        setContent {
            ClaudeMobileTheme {
                var isReady by remember { mutableStateOf(bootstrap.isBootstrapped) }
                var progress by remember { mutableStateOf<Bootstrap.Progress?>(null) }
                var apiKeyReady by remember { mutableStateOf(false) }

                if (isReady) {
                    // Replaced in Task 9, Step 3 with full ChatScreen wiring
                    androidx.compose.material3.Text("Chat goes here")
                } else {
                    SetupScreen(progress)
                    LaunchedEffect(Unit) {
                        bootstrap.setup { p ->
                            progress = p
                            if (p is Bootstrap.Progress.Complete) {
                                isReady = true
                            }
                        }
                    }
                }
            }
        }
    }
}
