package com.destin.code.ui.cards

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.DestinCodeTheme

data class DiffHunk(val header: String, val lines: String)

@Composable
fun DiffCard(
    cardId: String,
    filename: String,
    hunks: List<DiffHunk>,
    isExpanded: Boolean,
    onToggle: (String) -> Unit,
) {
    val allLines = hunks.flatMap { it.lines.lines() }
    val additions = allLines.count { it.startsWith("+") }
    val deletions = allLines.count { it.startsWith("-") }
    val previewLines = allLines.take(3)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onToggle(cardId) }
            .padding(10.dp)
    ) {
        // Header
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                filename,
                color = MaterialTheme.colorScheme.primary,
                fontSize = 13.sp,
                maxLines = 1,
            )
            Spacer(Modifier.width(8.dp))
            Text("+$additions", color = Color(0xFF44DD44), fontSize = 11.sp)
            Spacer(Modifier.width(4.dp))
            Text("-$deletions", color = Color(0xFFDD4444), fontSize = 11.sp)
        }

        // Preview (collapsed)
        if (!isExpanded && previewLines.isNotEmpty()) {
            Column(modifier = Modifier.padding(top = 4.dp)) {
                for (line in previewLines) {
                    DiffLine(line)
                }
            }
        }

        // Full diff (expanded)
        AnimatedVisibility(visible = isExpanded) {
            Column(
                modifier = Modifier
                    .padding(top = 6.dp)
                    .horizontalScroll(rememberScrollState())
            ) {
                for (line in allLines) {
                    DiffLine(line)
                }
            }
        }
    }
}

@Composable
private fun DiffLine(line: String) {
    val color = when {
        line.startsWith("+") -> Color(0xFF44DD44)
        line.startsWith("-") -> Color(0xFFDD4444)
        line.startsWith("@") -> Color(0xFF6897BB)
        else -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
    }
    Text(
        line,
        color = color,
        fontFamily = com.destin.code.ui.theme.CascadiaMono,
        fontSize = 11.sp,
        maxLines = 1,
    )
}
