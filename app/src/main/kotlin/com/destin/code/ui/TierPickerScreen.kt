package com.destin.code.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.config.PackageTier
import com.destin.code.ui.theme.CascadiaMono

@Composable
fun TierPickerScreen(
    initialTier: PackageTier = PackageTier.DEVELOPER,
    onConfirm: (PackageTier) -> Unit,
) {
    var selected by remember { mutableStateOf(initialTier) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(modifier = Modifier.height(48.dp))
        Text(
            "DestinCode",
            style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "Choose your toolkit",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        Spacer(modifier = Modifier.height(32.dp))

        PackageTier.entries.forEach { tier ->
            val isSelected = tier == selected
            TierCard(
                tier = tier,
                isSelected = isSelected,
                onClick = { selected = tier },
            )
            Spacer(modifier = Modifier.height(12.dp))
        }

        Spacer(modifier = Modifier.weight(1f))

        Button(
            onClick = { onConfirm(selected) },
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
            shape = RoundedCornerShape(8.dp),
        ) {
            Text("Continue", fontSize = 16.sp)
        }
        Spacer(modifier = Modifier.height(16.dp))
    }
}

@Composable
private fun TierCard(
    tier: PackageTier,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    val accentColor = MaterialTheme.colorScheme.primary
    val border = if (isSelected) BorderStroke(2.dp, accentColor) else BorderStroke(1.dp, Color(0xFF333333))
    val bg = if (isSelected) Color(0xFF1a1a1a) else Color(0xFF111111)

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() },
        shape = RoundedCornerShape(10.dp),
        border = border,
        colors = CardDefaults.cardColors(containerColor = bg),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.Top,
        ) {
            RadioButton(
                selected = isSelected,
                onClick = onClick,
                colors = RadioButtonDefaults.colors(selectedColor = accentColor),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    tier.displayName,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                    color = if (isSelected) accentColor else MaterialTheme.colorScheme.onSurface,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    tier.description,
                    fontSize = 13.sp,
                    fontFamily = CascadiaMono,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    lineHeight = 18.sp,
                )
            }
        }
    }
}
