package com.destin.code.ui.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.DestinCodeTheme

@Composable
fun ApprovalCard(
    tool: String,
    summary: String,
    onAccept: () -> Unit,
    onReject: () -> Unit,
    onViewTerminal: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(10.dp)
    ) {
        if (tool.isNotEmpty()) {
            Text(
                tool,
                color = MaterialTheme.colorScheme.primary,
                fontSize = 13.sp,
            )
        }
        Text(
            summary,
            color = MaterialTheme.colorScheme.onSurface,
            fontSize = 12.sp,
            modifier = Modifier.padding(vertical = 4.dp),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = onAccept,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32)),
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(8.dp),
            ) { Text("Accept", fontSize = 13.sp) }
            Button(
                onClick = onReject,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(8.dp),
            ) { Text("Reject", fontSize = 13.sp) }
        }
        TextButton(onClick = onViewTerminal) {
            Text(
                "View in terminal",
                color = DestinCodeTheme.extended.textSecondary,
                fontSize = 11.sp,
            )
        }
    }
}
