package com.destin.code.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.CascadiaMono

@Composable
fun AboutScreen(onBack: () -> Unit) {
    AlertDialog(
        onDismissRequest = onBack,
        title = { Text("About DestinCode", fontSize = 16.sp, fontFamily = CascadiaMono) },
        text = {
            LazyColumn(
                modifier = Modifier.heightIn(max = 500.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { VersionSection() }
                item { Divider() }
                item { DisclaimerSection() }
                item { Divider() }
                item { PrivacySection() }
                item { Divider() }
                item { LicensesSection() }
            }
        },
        confirmButton = {
            TextButton(onClick = onBack) { Text("Done") }
        },
    )
}

@Composable
private fun VersionSection() {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            "DestinCode v1.0.0",
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = CascadiaMono,
        )
        Text(
            "Claude Code on Android",
            fontSize = 12.sp,
            fontFamily = CascadiaMono,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
    }
}

@Composable
private fun DisclaimerSection() {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionHeader("Disclaimer")
        SectionBody(
            "DestinCode is an independent, community-built project. " +
            "It is not affiliated with, endorsed by, or officially supported by Anthropic."
        )
        SectionBody(
            "\"Claude\" and \"Claude Code\" are trademarks of Anthropic, PBC."
        )
        SectionBody(
            "Thanks to the Anthropic team for building Claude Code. " +
            "This project exists because of their work."
        )
    }
}

@Composable
private fun PrivacySection() {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionHeader("Privacy")
        SectionBody(
            "Your API key is stored locally on your device using Android Keystore " +
            "encryption. It is never transmitted to or collected by DestinCode."
        )
        SectionBody(
            "DestinCode does not collect, transmit, or store any personal data. " +
            "All Claude Code interactions happen directly between the on-device " +
            "CLI and Anthropic's API servers using your own API key."
        )
        SectionBody(
            "During initial setup, Termux runtime packages are downloaded from " +
            "packages.termux.dev over HTTPS with SHA256 verification."
        )
    }
}

@Composable
private fun LicensesSection() {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionHeader("Licenses")
        SectionBody(
            "DestinCode is licensed under the GNU General Public License v3.0 (GPLv3)."
        )
        Spacer(Modifier.height(4.dp))
        LicenseRow("Termux terminal-emulator", "GPLv3", "github.com/termux/termux-app")
        LicenseRow("Termux terminal-view", "GPLv3", "github.com/termux/termux-app")
        LicenseRow("AndroidX / Jetpack Compose", "Apache 2.0", "developer.android.com")
        LicenseRow("Apache Commons Compress", "Apache 2.0", "commons.apache.org")
        LicenseRow("CommonMark", "BSD 2-Clause", "github.com/commonmark/commonmark-java")
        LicenseRow("XZ for Java", "Public Domain", "tukaani.org/xz")
        LicenseRow("Zstd-JNI", "BSD", "github.com/luben/zstd-jni")
        LicenseRow("Cascadia Mono", "SIL OFL", "github.com/microsoft/cascadia-code")
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = CascadiaMono,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
private fun SectionBody(text: String) {
    Text(
        text,
        fontSize = 11.sp,
        fontFamily = CascadiaMono,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
        lineHeight = 16.sp,
    )
}

@Composable
private fun LicenseRow(library: String, license: String, source: String) {
    Column(modifier = Modifier.padding(start = 8.dp, bottom = 4.dp)) {
        Text(
            library,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = CascadiaMono,
        )
        Text(
            "$license  ·  $source",
            fontSize = 10.sp,
            fontFamily = CascadiaMono,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
        )
    }
}

@Composable
private fun Divider() {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f),
        thickness = 0.5.dp,
    )
}
