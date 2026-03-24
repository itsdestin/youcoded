package com.destin.code.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.CascadiaMono
import java.io.File

/**
 * In-app directory browser. Shows subdirectories of [root].
 * User navigates into directories and selects one.
 * [root] is the navigation ceiling — cannot go above it.
 */
@Composable
fun DirectoryBrowserDialog(
    root: File,
    title: String = "Browse",
    pathPrefix: String = "~",
    onDismiss: () -> Unit,
    onSelect: (File) -> Unit,
) {
    var currentDir by remember { mutableStateOf(root) }
    val subdirs = remember(currentDir) {
        currentDir.listFiles()
            ?.filter { it.isDirectory && !it.name.startsWith(".") }
            ?.sortedBy { it.name.lowercase() }
            ?: emptyList()
    }
    val canGoUp = currentDir != root

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text(title, fontSize = 16.sp)
                Text(
                    currentDir.absolutePath.replace(root.absolutePath, pathPrefix)
                        .ifEmpty { pathPrefix },
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                    fontFamily = CascadiaMono,
                )
            }
        },
        text = {
            LazyColumn(
                modifier = Modifier.heightIn(max = 300.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (canGoUp) {
                    item {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { currentDir = currentDir.parentFile!! }
                                .padding(vertical = 8.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Go up",
                                modifier = Modifier.size(18.dp),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Text("..", fontSize = 13.sp, fontFamily = CascadiaMono)
                        }
                    }
                }
                if (subdirs.isEmpty()) {
                    item {
                        Text(
                            "No subdirectories",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                            modifier = Modifier.padding(8.dp),
                        )
                    }
                }
                items(subdirs) { dir ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { currentDir = dir }
                            .padding(vertical = 8.dp, horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(
                            Icons.Default.Folder,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        )
                        Text(dir.name, fontSize = 13.sp, fontFamily = CascadiaMono)
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onSelect(currentDir) }) {
                Text("Select This Directory")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
