package com.destin.code.ui.cards

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun ErrorCard(
    cardId: String,
    message: String,
    details: String,
    isExpanded: Boolean,
    onToggle: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, MaterialTheme.colorScheme.error, RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onToggle(cardId) }
            .padding(10.dp)
    ) {
        Text(
            "Error",
            color = MaterialTheme.colorScheme.error,
            fontSize = 12.sp,
        )
        Text(
            message.lines().first(),
            color = MaterialTheme.colorScheme.onSurface,
            fontFamily = com.destin.code.ui.theme.CascadiaMono,
            fontSize = 12.sp,
            maxLines = if (isExpanded) Int.MAX_VALUE else 1,
        )
        AnimatedVisibility(visible = isExpanded && details.isNotBlank()) {
            Text(
                details,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                fontFamily = com.destin.code.ui.theme.CascadiaMono,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
