package com.destin.code.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.DestinCodeTheme

data class TerminalKey(val label: String, val sequence: String)

@Composable
fun TerminalKeyboardRow(
    onKeyPress: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var ctrlActive by remember { mutableStateOf(false) }
    val borderColor = DestinCodeTheme.extended.surfaceBorder

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 6.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Ctrl
        SmallPill(
            label = "Ctrl",
            isActive = ctrlActive,
            borderColor = borderColor,
            modifier = Modifier.weight(0.85f).height(36.dp),
        ) { ctrlActive = !ctrlActive }

        // Esc
        SmallPill("Esc", borderColor = borderColor, modifier = Modifier.weight(0.85f).height(36.dp)) {
            sendKey("\u001b", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Tab
        SmallPill("Tab", borderColor = borderColor, modifier = Modifier.weight(0.85f).height(36.dp)) {
            sendKey("\t", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Arrow keys — half-size left/right, normal up/down
        ArrowPill(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Left", borderColor, Modifier.weight(0.55f).height(36.dp)) {
            sendKey("\u001b[D", ctrlActive, onKeyPress) { ctrlActive = false }
        }
        ArrowPill(Icons.Filled.KeyboardArrowUp, "Up", borderColor, Modifier.weight(0.75f).height(36.dp)) {
            sendKey("\u001b[A", ctrlActive, onKeyPress) { ctrlActive = false }
        }
        ArrowPill(Icons.Filled.KeyboardArrowDown, "Down", borderColor, Modifier.weight(0.75f).height(36.dp)) {
            sendKey("\u001b[B", ctrlActive, onKeyPress) { ctrlActive = false }
        }
        ArrowPill(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Right", borderColor, Modifier.weight(0.55f).height(36.dp)) {
            sendKey("\u001b[C", ctrlActive, onKeyPress) { ctrlActive = false }
        }

    }
}

private fun sendKey(
    sequence: String,
    ctrlActive: Boolean,
    onKeyPress: (String) -> Unit,
    clearCtrl: () -> Unit,
) {
    if (ctrlActive && sequence.length == 1) {
        val ch = sequence[0]
        val code = when {
            ch in 'a'..'z' -> ch.code - 'a'.code + 1
            ch in 'A'..'Z' -> ch.code - 'A'.code + 1
            else -> null
        }
        if (code != null) {
            onKeyPress(code.toChar().toString())
            clearCtrl()
            return
        }
    }
    onKeyPress(sequence)
    if (ctrlActive) clearCtrl()
}

@Composable
private fun SmallPill(
    label: String,
    isActive: Boolean = false,
    isPrimary: Boolean = false,
    borderColor: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color.Gray,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val bg = when {
        isActive -> MaterialTheme.colorScheme.primary
        isPrimary -> MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        else -> MaterialTheme.colorScheme.surface
    }
    val textColor = when {
        isActive -> MaterialTheme.colorScheme.onPrimary
        isPrimary -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurface
    }

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(bg)
            .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = if (isActive || isPrimary) FontWeight.SemiBold else FontWeight.Normal,
            color = textColor,
        )
    }
}

@Composable
private fun ArrowPill(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    borderColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(22.dp),
        )
    }
}
