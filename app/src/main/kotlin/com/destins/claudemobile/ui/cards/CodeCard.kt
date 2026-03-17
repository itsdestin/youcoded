package com.destins.claudemobile.ui.cards

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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.SyntaxHighlighter
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme

@Composable
fun CodeCard(
    cardId: String,
    language: String,
    code: String,
    isExpanded: Boolean,
    onToggle: (String) -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val lines = code.lines()
    val highlighted = remember(code, language) { SyntaxHighlighter.highlight(code, language) }
    val previewHighlighted = remember(code, language) {
        SyntaxHighlighter.highlight(lines.take(5).joinToString("\n"), language)
    }

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
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                language.ifEmpty { "code" },
                color = ClaudeMobileTheme.extended.textSecondary,
                fontSize = 11.sp,
            )
            Spacer(Modifier.weight(1f))
            Text(
                "Copy",
                color = MaterialTheme.colorScheme.primary,
                fontSize = 11.sp,
                modifier = Modifier.clickable {
                    clipboard.setText(AnnotatedString(code))
                },
            )
        }

        Spacer(Modifier.height(4.dp))

        // Content
        val displayText = if (isExpanded) highlighted
            else SyntaxHighlighter.highlight(previewLines.joinToString("\n"), language)

        Box(
            modifier = Modifier.horizontalScroll(rememberScrollState())
        ) {
            Text(
                displayText,
                fontSize = 12.sp,
                lineHeight = 16.sp,
            )
        }

        if (!isExpanded && lines.size > 5) {
            Text(
                "... ${lines.size - 5} more lines",
                color = ClaudeMobileTheme.extended.textSecondary,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}
