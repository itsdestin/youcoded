package com.destin.code.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.config.WorkingDir
import com.destin.code.config.WorkingDirStore
import com.destin.code.ui.theme.CascadiaMono
import java.io.File

/**
 * Screen for managing custom working directories.
 * Home (~) is always shown but not deletable.
 */
@Composable
fun ManageDirectoriesScreen(
    homeDir: File,
    workingDirStore: WorkingDirStore,
    onBack: () -> Unit,
) {
    val customDirs by workingDirStore.dirs.collectAsState()

    AlertDialog(
        onDismissRequest = onBack,
        title = { Text("Working Directories", fontSize = 16.sp) },
        text = {
            LazyColumn(
                modifier = Modifier.heightIn(max = 400.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                // Home — always present, not deletable
                item {
                    DirectoryRow(
                        label = "Home (~)",
                        path = homeDir.absolutePath,
                        exists = true,
                        deletable = false,
                        onDelete = {},
                    )
                }
                items(customDirs) { wd ->
                    DirectoryRow(
                        label = wd.label,
                        path = wd.path,
                        exists = File(wd.path).isDirectory,
                        deletable = true,
                        onDelete = { workingDirStore.remove(wd.path) },
                    )
                }
                if (customDirs.isEmpty()) {
                    item {
                        Text(
                            "No custom directories added yet.\nAdd directories when creating a new session.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                            modifier = Modifier.padding(8.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onBack) { Text("Done") }
        },
    )
}

@Composable
private fun DirectoryRow(
    label: String,
    path: String,
    exists: Boolean,
    deletable: Boolean,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(label, fontSize = 13.sp, fontFamily = CascadiaMono)
                if (!exists) {
                    Icon(
                        Icons.Default.Warning,
                        contentDescription = "Directory missing",
                        modifier = Modifier.size(14.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
            }
            Text(
                path,
                fontSize = 10.sp,
                fontFamily = CascadiaMono,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                maxLines = 1,
            )
        }
        if (deletable) {
            IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = "Remove directory",
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.error.copy(alpha = 0.7f),
                )
            }
        }
    }
}
