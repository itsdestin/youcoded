package com.youcoded.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.youcoded.app.config.PackageTier
import com.youcoded.app.ui.theme.CascadiaMono

@Composable
fun TierPickerScreen(
    initialTier: PackageTier = PackageTier.CORE,
    onConfirm: (PackageTier) -> Unit,
) {
    var selected by remember { mutableStateOf(initialTier) }
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(modifier = Modifier.height(48.dp))
        Text(
            "YouCoded",
            style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "Set up your environment",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        Spacer(modifier = Modifier.height(32.dp))

        // ── Core tier card (always visible, pre-selected) ──
        TierCard(
            tier = PackageTier.CORE,
            isSelected = selected == PackageTier.CORE,
            onClick = { selected = PackageTier.CORE },
        )

        Spacer(modifier = Modifier.height(20.dp))

        // ── "Install Additional Packages" expandable header ──
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded },
            color = Color.Transparent,
        ) {
            Row(
                modifier = Modifier.padding(vertical = 8.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (expanded) Icons.Default.KeyboardArrowUp
                    else Icons.Default.KeyboardArrowDown,
                    contentDescription = if (expanded) "Collapse" else "Expand",
                    tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                    modifier = Modifier.size(20.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    "Install Additional Packages",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                )
            }
        }

        // ── Expandable section ──
        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column {
                Spacer(modifier = Modifier.height(8.dp))

                // Developer Essentials
                TierCard(
                    tier = PackageTier.DEVELOPER,
                    isSelected = selected == PackageTier.DEVELOPER,
                    onClick = { selected = PackageTier.DEVELOPER },
                )
                Spacer(modifier = Modifier.height(12.dp))

                // Full Dev Environment
                TierCard(
                    tier = PackageTier.FULL_DEV,
                    isSelected = selected == PackageTier.FULL_DEV,
                    onClick = { selected = PackageTier.FULL_DEV },
                )
                Spacer(modifier = Modifier.height(12.dp))

                // "Additional Packages — Coming Soon" placeholder
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, Color(0xFF282828)),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF0d0d0d)),
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                "Additional Packages",
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                "Coming soon",
                                fontSize = 13.sp,
                                fontFamily = CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f),
                            )
                        }
                    }
                }
            }
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
