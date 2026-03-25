package com.destin.code.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.config.PackageTier
import com.destin.code.config.QuickChip
import com.destin.code.config.chipsForTier
import com.destin.code.ui.theme.DestinCodeTheme

@Composable
fun QuickChips(
    tier: PackageTier = PackageTier.CORE,
    chips: List<QuickChip> = chipsForTier(tier),
    onChipTap: (QuickChip) -> Unit,
    modifier: Modifier = Modifier,
) {
    val borderColor = DestinCodeTheme.extended.surfaceBorder
    val bgColor = MaterialTheme.colorScheme.background

    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(bgColor)
            .drawWithContent {
                drawContent()
                val fadeWidth = 24.dp.toPx()
                // Left fade
                drawRect(
                    brush = Brush.horizontalGradient(
                        colors = listOf(bgColor, Color.Transparent),
                        startX = 0f,
                        endX = fadeWidth,
                    ),
                    size = Size(fadeWidth, size.height),
                )
                // Right fade
                drawRect(
                    brush = Brush.horizontalGradient(
                        colors = listOf(Color.Transparent, bgColor),
                        startX = size.width - fadeWidth,
                        endX = size.width,
                    ),
                    topLeft = Offset(size.width - fadeWidth, 0f),
                    size = Size(fadeWidth, size.height),
                )
            },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 6.dp, vertical = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            chips.forEach { chip ->
                Box(
                    modifier = Modifier
                        .height(36.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.surface)
                        .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                        .clickable { onChipTap(chip) }
                        .padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        chip.label,
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}
