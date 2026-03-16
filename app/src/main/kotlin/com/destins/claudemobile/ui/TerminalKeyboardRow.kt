package com.destins.claudemobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

data class TerminalKey(val label: String, val sequence: String)

val terminalKeys = listOf(
    TerminalKey("Esc", "\u001b"),
    TerminalKey("Tab", "\t"),
    TerminalKey("↑", "\u001b[A"),
    TerminalKey("↓", "\u001b[B"),
    TerminalKey("←", "\u001b[D"),
    TerminalKey("→", "\u001b[C"),
    TerminalKey("Ctrl", ""),
    TerminalKey("⏎", "\r"),
)

@Composable
fun TerminalKeyboardRow(
    onKeyPress: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var ctrlActive by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .background(MaterialTheme.colorScheme.surface),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        terminalKeys.forEach { key ->
            val isCtrlButton = key.label == "Ctrl"
            val isHighlighted = isCtrlButton && ctrlActive

            TextButton(
                onClick = {
                    if (isCtrlButton) {
                        ctrlActive = !ctrlActive
                    } else if (ctrlActive) {
                        // Send Ctrl+key: char codes 1-26 for a-z
                        val sequence = key.sequence
                        val ctrlSequence = if (sequence.length == 1 && sequence[0] in 'a'..'z') {
                            (sequence[0].code - 'a'.code + 1).toChar().toString()
                        } else if (sequence.length == 1 && sequence[0] in 'A'..'Z') {
                            (sequence[0].code - 'A'.code + 1).toChar().toString()
                        } else {
                            sequence
                        }
                        onKeyPress(ctrlSequence)
                        ctrlActive = false
                    } else {
                        onKeyPress(key.sequence)
                    }
                },
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight(),
                contentPadding = PaddingValues(0.dp),
            ) {
                Text(
                    text = key.label,
                    fontSize = 14.sp,
                    color = if (isHighlighted)
                        MaterialTheme.colorScheme.primary
                    else
                        MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}
