package com.destins.claudemobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.File

data class NewSessionConfig(
    val cwd: File,
    val dangerousMode: Boolean,
)

@Composable
fun NewSessionDialog(
    knownDirs: List<Pair<String, File>>,
    onDismiss: () -> Unit,
    onCreate: (NewSessionConfig) -> Unit,
) {
    var selectedDir by remember { mutableStateOf(knownDirs.firstOrNull()?.second) }
    var dangerousMode by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New Session", fontSize = 16.sp) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Working Directory:", fontSize = 13.sp)
                knownDirs.forEach { (label, dir) ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(
                                selected = selectedDir == dir,
                                onClick = { selectedDir = dir },
                                role = Role.RadioButton,
                            )
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = selectedDir == dir, onClick = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(label, fontSize = 13.sp)
                    }
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(top = 8.dp),
                ) {
                    Checkbox(checked = dangerousMode, onCheckedChange = { dangerousMode = it })
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("Skip permissions", fontSize = 13.sp)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    selectedDir?.let { dir ->
                        onCreate(NewSessionConfig(dir, dangerousMode))
                    }
                },
                shape = RoundedCornerShape(8.dp),
            ) { Text("Create") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
