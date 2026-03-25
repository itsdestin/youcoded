package com.destin.code.ui

import androidx.compose.foundation.Canvas
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
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.DestinCodeTheme

data class TerminalKey(val label: String, val sequence: String)

private val MODE_CYCLE_FULL = listOf("Normal", "Auto-Accept", "Plan Mode", "Bypass")
private val MODE_CYCLE_SAFE = listOf("Normal", "Auto-Accept", "Plan Mode")

@Composable
fun TerminalKeyboardRow(
    onKeyPress: (String) -> Unit,
    permissionMode: String = "Normal",
    hasBypassMode: Boolean = false,
    onPermissionCycle: ((String) -> Unit)? = null,
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
            modifier = Modifier.weight(1f).height(36.dp),
        ) { ctrlActive = !ctrlActive }

        // Esc
        SmallPill("Esc", borderColor = borderColor, modifier = Modifier.weight(1f).height(36.dp)) {
            sendKey("\u001b", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Tab
        SmallPill("Tab", borderColor = borderColor, modifier = Modifier.weight(1f).height(36.dp)) {
            sendKey("\t", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Permission mode pill — icon shows current mode, tap cycles to next
        PermissionModePill(
            mode = permissionMode,
            borderColor = borderColor,
            modifier = Modifier.weight(0.85f).height(36.dp),
        ) {
            // Optimistic update: cycle to next mode immediately
            val cycle = if (hasBypassMode) MODE_CYCLE_FULL else MODE_CYCLE_SAFE
            val currentIdx = cycle.indexOf(permissionMode).coerceAtLeast(0)
            val nextMode = cycle[(currentIdx + 1) % cycle.size]
            onPermissionCycle?.invoke(nextMode)
            // Send Shift+Tab to actually cycle Claude Code
            onKeyPress("\u001b[Z")
        }

        // Arrow keys — left/right only (up/down moved to floating arrows)
        ArrowPill(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Left", borderColor, Modifier.weight(0.65f).height(36.dp)) {
            sendKey("\u001b[D", ctrlActive, onKeyPress) { ctrlActive = false }
        }
        ArrowPill(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Right", borderColor, Modifier.weight(0.65f).height(36.dp)) {
            sendKey("\u001b[C", ctrlActive, onKeyPress) { ctrlActive = false }
        }
    }
}

/** Permission mode pill with canvas-drawn play/pause icons. */
@Composable
private fun PermissionModePill(
    mode: String,
    borderColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val isActive = mode != "Normal"
    val bg = if (isActive)
        MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
    else
        MaterialTheme.colorScheme.surface
    val iconColor = if (isActive)
        MaterialTheme.colorScheme.primary
    else
        MaterialTheme.colorScheme.onSurface

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(bg)
            .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .semantics { contentDescription = "Permission mode: $mode. Tap to cycle." },
        contentAlignment = Alignment.Center,
    ) {
        PermissionModeIcon(mode = mode, color = iconColor)
    }
}

/** Draws play/pause icons:
 *  Normal = ▶ (single play)
 *  Auto-Accept = ▶▶ (double play, like fast-forward)
 *  Bypass = ▶▶▶ (triple play)
 *  Plan Mode = ⏸ (pause)
 */
@Composable
private fun PermissionModeIcon(
    mode: String,
    color: androidx.compose.ui.graphics.Color,
) {
    Canvas(modifier = Modifier.size(20.dp)) {
        val h = size.height
        val w = size.width

        when (mode) {
            "Plan Mode" -> {
                // Pause: two vertical bars
                val barW = w * 0.2f
                val gap = w * 0.15f
                val barH = h * 0.6f
                val top = (h - barH) / 2f
                val left1 = (w - barW * 2 - gap) / 2f
                val left2 = left1 + barW + gap
                drawRect(color, topLeft = Offset(left1, top), size = androidx.compose.ui.geometry.Size(barW, barH))
                drawRect(color, topLeft = Offset(left2, top), size = androidx.compose.ui.geometry.Size(barW, barH))
            }
            else -> {
                // Play triangles: 1 for Normal, 2 for Auto-Accept, 3 for Bypass
                val count = when (mode) {
                    "Auto-Accept" -> 2
                    "Bypass" -> 3
                    else -> 1
                }
                val triW = w * 0.32f
                val triH = h * 0.55f
                val overlap = triW * 0.4f
                val totalW = triW + (count - 1) * (triW - overlap)
                val startX = (w - totalW) / 2f
                val centerY = h / 2f

                for (i in 0 until count) {
                    val x = startX + i * (triW - overlap)
                    val path = Path().apply {
                        moveTo(x, centerY - triH / 2f)
                        lineTo(x + triW, centerY)
                        lineTo(x, centerY + triH / 2f)
                        close()
                    }
                    drawPath(path, color)
                }
            }
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
            .clickable(onClick = onClick)
            .semantics {
                contentDescription = if (isActive) "$label key, active" else "$label key"
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 11.sp,
            fontFamily = com.destin.code.ui.theme.CascadiaMono,
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
