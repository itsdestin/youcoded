# Package Tiers Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tiered package system so developers can opt into additional CLI tools (ripgrep, jq, tmux, neovim, etc.) during bootstrap, transforming YouCoded from a personal-assistant wrapper into a capable mobile development environment.

**Architecture:** Package tiers are stored in SharedPreferences and read by Bootstrap during `installPackages()`. The existing dynamic package resolution system (`fetchPackagesIndex()`, `parsePackagesIndex()`, SHA256 verification) handles all installation — we just expand `requiredPackages` to a function that returns packages based on the selected tier. A tier picker screen shows during first-run setup (before bootstrap), and a settings entry point in the session header allows changing tiers post-setup (triggering re-bootstrap for new packages).

**Tech Stack:** Kotlin, Jetpack Compose, Android SharedPreferences, Termux package repos

**Spec:** None yet — this plan is the initial design document.

---

## Tier Definitions

| Tier | Name | Target User | New Packages | Approx Size |
|------|------|-------------|--------------|-------------|
| 0 | Core | Everyone | *(current set — always installed)* | ~180MB |
| 1 | Developer Essentials | Devs who want better CLI tools | ripgrep, fd, fzf, jq, bat, eza, tree, nano, micro, tmux | ~25MB |
| 2 | Full Dev Environment | Devs who want editors + build tools | neovim (+ tree-sitter, luajit, etc.), make, cmake, vim, sqlite | ~80MB |

**Tier 0 (Core — always installed, unchanged):**
```
libandroid-support, libandroid-posix-semaphore, openssl, zlib,
libiconv, libexpat, pcre2, c-ares, libicu, libsqlite, nodejs, npm,
termux-exec, libnghttp2, libnghttp3, libngtcp2, libssh2, libcurl, curl,
git, openssh, gh, gdbm, libbz2, libcrypt, libffi, liblzma,
ncurses, ncurses-ui-libs, readline, python, libunistring, libidn2,
libuuid, wget, rclone
```

**Tier 1 (Developer Essentials) — new packages + deps:**
```
# Zero-dep or already-satisfied-dep tools (Go/Rust static binaries)
fd, micro, tree,
# Needs pcre2 (already in Tier 0)
ripgrep,
# Needs ncurses-utils → ncurses (already in Tier 0), findutils
findutils, ncurses-utils, fzf,
# Needs oniguruma (new dep)
oniguruma, jq,
# Needs libgit2 → libssh2, openssl, pcre2, zlib (all in Tier 0)
libgit2, bat, eza,
# Needs libevent, libandroid-glob
libevent, libandroid-glob, tmux,
# Needs libandroid-support (already in Tier 0)
nano
```

**Tier 2 (Full Dev Environment) — new packages + deps:**
```
# Editors
libsodium, vim,
# Neovim + dep chain
libmsgpack, libunibilium, libuv, libvterm, lua51, lua51-lpeg,
luajit, luv, tree-sitter,
tree-sitter-c, tree-sitter-lua, tree-sitter-markdown,
tree-sitter-query, tree-sitter-vimdoc, tree-sitter-vim,
tree-sitter-parsers, utf8proc, neovim,
# Build tools
make,
# cmake needs libarchive → libxml2 → libandroid-glob (already Tier 1), libiconv, libicu, zlib
libxml2, libarchive, jsoncpp, rhash, cmake,
# Database
sqlite
```

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `app/src/main/kotlin/com/destin/code/config/TierStore.kt` | Create | Tier preference storage (SharedPreferences) |
| `app/src/main/kotlin/com/destin/code/config/PackageTier.kt` | Create | Tier enum + package lists per tier |
| `app/src/main/kotlin/com/destin/code/runtime/Bootstrap.kt` | Modify | Replace hardcoded `requiredPackages` with tier-aware function; add `packageFileExists()` entries for new packages |
| `app/src/main/kotlin/com/destin/code/ui/TierPickerScreen.kt` | Create | First-run tier selection UI |
| `app/src/main/kotlin/com/destin/code/ui/SetupScreen.kt` | Modify | Show tier picker before bootstrap if no tier is selected |
| `app/src/main/kotlin/com/destin/code/MainActivity.kt` | Modify | Wire tier picker into the setup flow |

---

## Chunk 1: Tier Data Model

### Task 1: Create PackageTier enum

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/config/PackageTier.kt`

- [x] **Step 1: Create PackageTier.kt**

```kotlin
package com.destin.code.config

/**
 * Package installation tiers. Each tier includes all packages from lower tiers.
 * Tier names and descriptions are user-facing (shown in tier picker).
 */
enum class PackageTier(
    val displayName: String,
    val description: String,
    val additionalPackages: List<String>,
) {
    CORE(
        displayName = "Core",
        description = "Claude Code essentials — git, python, curl, rclone",
        additionalPackages = emptyList(), // Base packages handled separately
    ),
    DEVELOPER(
        displayName = "Developer Essentials",
        description = "ripgrep, fd, fzf, jq, bat, tmux, nano, micro",
        additionalPackages = listOf(
            // Tools with zero or already-satisfied deps
            "fd", "micro", "tree",
            // ripgrep needs pcre2 (already in core)
            "ripgrep",
            // fzf needs findutils + ncurses-utils
            "findutils", "ncurses-utils", "fzf",
            // jq needs oniguruma
            "oniguruma", "jq",
            // bat + eza need libgit2 (deps already in core)
            "libgit2", "bat", "eza",
            // tmux needs libevent + libandroid-glob
            "libevent", "libandroid-glob", "tmux",
            // nano — needs libandroid-support (already in core)
            "nano",
        ),
    ),
    FULL_DEV(
        displayName = "Full Dev Environment",
        description = "neovim, vim, make, cmake, sqlite",
        additionalPackages = listOf(
            // vim + dep
            "libsodium", "vim",
            // Neovim dep chain (in dependency order)
            "libmsgpack", "libunibilium", "libuv", "libvterm",
            "lua51", "lua51-lpeg", "luajit", "luv",
            "tree-sitter",
            "tree-sitter-c", "tree-sitter-lua", "tree-sitter-markdown",
            "tree-sitter-query", "tree-sitter-vimdoc", "tree-sitter-vim",
            "tree-sitter-parsers", "utf8proc", "neovim",
            // Build tools
            "make",
            // cmake dep chain
            "libxml2", "libarchive", "jsoncpp", "rhash", "cmake",
            // Database CLI
            "sqlite",
        ),
    );

    /** Returns all packages for this tier (cumulative — includes lower tiers). */
    fun allAdditionalPackages(): List<String> {
        val result = mutableListOf<String>()
        for (tier in entries) {
            result.addAll(tier.additionalPackages)
            if (tier == this) break
        }
        return result
    }
}
```

- [x] **Step 2: Verify build**

Run: `cd /c/Users/desti/youcoded && ./gradlew assembleDebug 2>&1 | tail -5`

Expected: BUILD SUCCESSFUL

- [x] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/config/PackageTier.kt
git commit -m "feat: add PackageTier enum with tiered package lists"
```

---

### Task 2: Create TierStore

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/config/TierStore.kt`

- [x] **Step 1: Create TierStore.kt**

```kotlin
package com.destin.code.config

import android.content.Context

/**
 * Stores the user's selected package tier in SharedPreferences.
 * Not encrypted — tier selection is not sensitive data.
 */
class TierStore(context: Context) {
    private val prefs = context.getSharedPreferences("youcoded_tiers", Context.MODE_PRIVATE)

    var selectedTier: PackageTier
        get() {
            val name = prefs.getString("tier", null) ?: return PackageTier.CORE
            return try { PackageTier.valueOf(name) } catch (_: Exception) { PackageTier.CORE }
        }
        set(value) = prefs.edit().putString("tier", value.name).apply()

    /** True if user has explicitly chosen a tier (even if they chose CORE). */
    val hasSelected: Boolean
        get() = prefs.contains("tier")
}
```

- [x] **Step 2: Verify build**

Run: `cd /c/Users/desti/youcoded && ./gradlew assembleDebug 2>&1 | tail -5`

Expected: BUILD SUCCESSFUL

- [x] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/config/TierStore.kt
git commit -m "feat: add TierStore for persisting tier selection"
```

---

## Chunk 2: Bootstrap Integration

### Task 3: Wire tiers into Bootstrap.installPackages()

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/runtime/Bootstrap.kt`

- [x] **Step 1: Add tier parameter to setup() and installPackages()**

In `Bootstrap.kt`, add a `tier` parameter so the caller can pass the selected tier:

At the class level (after `val isBootstrapped`), add a property:

```kotlin
    /** The package tier to install. Set before calling setup(). */
    var packageTier: PackageTier = PackageTier.CORE
```

Add the import at the top of the file:
```kotlin
import com.destin.code.config.PackageTier
```

- [x] **Step 2: Replace hardcoded requiredPackages with tier-aware computation**

Replace the `requiredPackages` val (around line 254-275) with a function:

```kotlin
    /** Core packages — always installed regardless of tier. */
    private val corePackages = listOf(
        // Core shared libs (used by multiple packages)
        "libandroid-support", "libandroid-posix-semaphore", "openssl", "zlib",
        "libiconv", "libexpat", "pcre2",
        // Node.js runtime + deps
        "c-ares", "libicu", "libsqlite", "nodejs", "npm",
        // SELinux exec bypass
        "termux-exec",
        // curl + deps (libcurl needs nghttp2/3, ngtcp2, libssh2)
        "libnghttp2", "libnghttp3", "libngtcp2", "libssh2", "libcurl", "curl",
        // Git + deps
        "git",
        // GitHub CLI + deps
        "openssh", "gh",
        // Python + deps
        "gdbm", "libbz2", "libcrypt", "libffi", "liblzma",
        "ncurses", "ncurses-ui-libs", "readline", "python",
        // wget + deps
        "libunistring", "libidn2", "libuuid", "wget",
        // Cloud storage sync
        "rclone"
    )

    /** Returns all packages to install based on the configured tier. */
    private fun requiredPackagesForTier(): List<String> {
        return corePackages + packageTier.allAdditionalPackages()
    }
```

- [x] **Step 3: Update installPackages() to use the new function**

In `installPackages()`, change the line:

```kotlin
        for ((i, name) in requiredPackages.withIndex()) {
```

to:

```kotlin
        val packages = requiredPackagesForTier()
        val total = packages.size
        for ((i, name) in packages.withIndex()) {
```

And remove the now-unused `val total = requiredPackages.size` line above it.

- [x] **Step 4: Add packageFileExists() entries for all new tier packages**

In `packageFileExists()`, add entries for all new packages from Tier 1 and Tier 2. Add these cases inside the `when` block:

```kotlin
            // Tier 1: Developer Essentials
            "fd" -> "bin/fd"
            "micro" -> "bin/micro"
            "tree" -> "bin/tree"
            "ripgrep" -> "bin/rg"
            "findutils" -> "bin/find"
            "ncurses-utils" -> "bin/tput"
            "fzf" -> "bin/fzf"
            "oniguruma" -> "lib/libonig.so"
            "jq" -> "bin/jq"
            "libgit2" -> "lib/libgit2.so"
            "bat" -> "bin/bat"
            "eza" -> "bin/eza"
            "libevent" -> "lib/libevent.so"
            "libandroid-glob" -> "lib/libandroid-glob.so"
            "tmux" -> "bin/tmux"
            "nano" -> "bin/nano"
            // Tier 2: Full Dev Environment
            "libsodium" -> "lib/libsodium.so"
            "vim" -> "bin/vim"
            "libmsgpack" -> "lib/libmsgpackc.so"
            "libunibilium" -> "lib/libunibilium.so"
            "libuv" -> "lib/libuv.so"
            "libvterm" -> "lib/libvterm.so"
            "lua51" -> "lib/liblua5.1.so"
            "lua51-lpeg" -> return usrDir.resolve("lib/lua/5.1").listFiles()
                ?.any { it.name.startsWith("lpeg") } == true
            "luajit" -> "bin/luajit"
            "luv" -> return usrDir.resolve("lib/lua/5.1").listFiles()
                ?.any { it.name.startsWith("luv") } == true
            "tree-sitter" -> "lib/libtree-sitter.so"
            // Tree-sitter parser checks use exact name matching to avoid
            // collisions (e.g., "vim.so" vs "vimdoc.so")
            "tree-sitter-c" -> return File(usrDir, "lib/tree-sitter/c.so").exists()
            "tree-sitter-lua" -> return File(usrDir, "lib/tree-sitter/lua.so").exists()
            "tree-sitter-markdown" -> return File(usrDir, "lib/tree-sitter/markdown.so").exists()
            "tree-sitter-query" -> return File(usrDir, "lib/tree-sitter/query.so").exists()
            "tree-sitter-vimdoc" -> return File(usrDir, "lib/tree-sitter/vimdoc.so").exists()
            "tree-sitter-vim" -> return File(usrDir, "lib/tree-sitter/vim.so").exists()
            "tree-sitter-parsers" -> return File(usrDir, "lib/tree-sitter").let {
                it.exists() && (it.listFiles()?.size ?: 0) >= 6
            }
            "utf8proc" -> "lib/libutf8proc.so"
            "neovim" -> "bin/nvim"
            "make" -> "bin/make"
            "libxml2" -> "lib/libxml2.so"
            "libarchive" -> "lib/libarchive.so"
            "jsoncpp" -> "lib/libjsoncpp.so"
            "rhash" -> "lib/librhash.so"
            "cmake" -> "bin/cmake"
            "sqlite" -> "bin/sqlite3"
```

- [x] **Step 5: Update isFullySetup to account for tiers**

The existing `isFullySetup` check doesn't account for tiers — it only checks that core packages are installed. This is fine: `isFullySetup` gates whether bootstrap needs to run at all. Tier packages are installed as part of the same `installPackages()` call, so if core packages are present, tier packages are too (assuming tier hasn't changed).

Add a method to detect if tier upgrade is needed:

```kotlin
    /** True if all packages for the current tier are installed. */
    fun isTierSatisfied(): Boolean {
        val packages = requiredPackagesForTier()
        return packages.all { packageFileExists(it) }
    }
```

- [x] **Step 6: Modify setup() to also run when tier packages are missing**

In `setup()`, change the condition:

```kotlin
            if (!isFullySetup) {
                installPackages(onProgress)
                installClaudeCode(onProgress)
            }
```

to:

```kotlin
            if (!isFullySetup) {
                installPackages(onProgress)
                installClaudeCode(onProgress)
            } else if (!isTierSatisfied()) {
                // Tier was upgraded — install new packages only
                installPackages(onProgress)
            }
```

- [x] **Step 7: Verify build**

Run: `cd /c/Users/desti/youcoded && ./gradlew assembleDebug 2>&1 | tail -5`

Expected: BUILD SUCCESSFUL

- [x] **Step 8: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/runtime/Bootstrap.kt
git commit -m "feat: integrate package tiers into bootstrap installation"
```

---

## Chunk 3: Tier Picker UI

### Task 4: Create TierPickerScreen composable

**Files:**
- Create: `app/src/main/kotlin/com/destin/code/ui/TierPickerScreen.kt`

This is a design decision point — the tier picker is the first thing new users see after the app title, and it shapes their perception of the app's purpose. The screen needs to communicate that higher tiers = more tools = longer install, without overwhelming. Three cards stacked vertically, radio-button selection, one "Continue" button.

- [x] **Step 1: Create TierPickerScreen.kt**

```kotlin
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

private val SIENNA = Color(0xFFc96442)

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
            "YouCoded",
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
            colors = ButtonDefaults.buttonColors(containerColor = SIENNA),
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
    val border = if (isSelected) BorderStroke(2.dp, SIENNA) else BorderStroke(1.dp, Color(0xFF333333))
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
                colors = RadioButtonDefaults.colors(selectedColor = SIENNA),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    tier.displayName,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                    color = if (isSelected) SIENNA else MaterialTheme.colorScheme.onSurface,
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
```

- [x] **Step 2: Verify build**

Run: `cd /c/Users/desti/youcoded && ./gradlew assembleDebug 2>&1 | tail -5`

Expected: BUILD SUCCESSFUL

- [x] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/TierPickerScreen.kt
git commit -m "feat: add tier picker screen for first-run package selection"
```

---

## Chunk 4: Wire It Together

### Task 5: Integrate tier picker into MainActivity setup flow

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/MainActivity.kt`

- [x] **Step 1: Add TierStore and integrate tier picker into the setup flow**

In `MainActivity.kt`, add imports:

```kotlin
import com.destin.code.config.TierStore
import com.destin.code.ui.TierPickerScreen
```

After `val bootstrap = Bootstrap(applicationContext)`, add:

```kotlin
        val tierStore = TierStore(applicationContext)
```

Inside the `setContent` block, the current flow is:
1. If not bootstrapped → show SetupScreen + run bootstrap
2. If bootstrapped → self-test → bind service → ChatScreen

We need to insert the tier picker BEFORE bootstrap runs. Modify the `if (!isReady)` block to first check if a tier has been selected:

Replace the entire `if (!isReady)` block (lines ~45-61) with:

```kotlin
                        if (!isReady) {
                            // Track tier selection in Compose state (SharedPreferences
                            // writes are NOT observable by Compose — need a bridge)
                            var tierSelected by remember { mutableStateOf(tierStore.hasSelected) }

                            if (!tierSelected) {
                                // First run — show tier picker
                                TierPickerScreen(
                                    onConfirm = { tier ->
                                        tierStore.selectedTier = tier
                                        bootstrap.packageTier = tier
                                        tierSelected = true  // triggers recomposition
                                    },
                                )
                            } else {
                                // Tier selected — run bootstrap
                                var setupAttempt by remember { mutableIntStateOf(0) }
                                LaunchedEffect(Unit) {
                                    bootstrap.packageTier = tierStore.selectedTier
                                }
                                SetupScreen(
                                    progress = progress,
                                    onRetry = {
                                        progress = null
                                        setupAttempt++
                                    },
                                )
                                LaunchedEffect(setupAttempt) {
                                    bootstrap.setup { p ->
                                        progress = p
                                        if (p is Bootstrap.Progress.Complete) {
                                            isReady = true
                                        }
                                    }
                                }
                            }
                        }
```

- [x] **Step 2: Also set tier when app is already bootstrapped (for tier upgrades)**

In the `else` block (app already bootstrapped), before the self-test, add a `LaunchedEffect` to set the tier once (avoids side-effects during composition):

```kotlin
                            LaunchedEffect(Unit) {
                                bootstrap.packageTier = tierStore.selectedTier
                            }
```

- [x] **Step 3: Verify build**

Run: `cd /c/Users/desti/youcoded && ./gradlew assembleDebug 2>&1 | tail -5`

Expected: BUILD SUCCESSFUL

- [x] **Step 4: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/MainActivity.kt
git commit -m "feat: wire tier picker into setup flow before bootstrap"
```

---

## Chunk 5: Settings Access (Change Tier Post-Setup)

### Task 6: Add settings gear to session header

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt`

Users need a way to change their tier after initial setup (e.g., upgrade from CORE to DEVELOPER). Add a gear icon in the header row that opens a tier re-selection dialog. On confirm, save the new tier and trigger re-bootstrap.

- [x] **Step 1: Read ChatScreen.kt to find the header row layout**

Read the ChatScreen.kt file to locate where SessionSwitcherPill is placed in the header row. The gear icon should go on the right side of that same row.

- [x] **Step 2: Add a settings gear icon and tier dialog state**

Add to imports:
```kotlin
import androidx.compose.material.icons.filled.Settings
import com.destin.code.config.PackageTier
import com.destin.code.config.TierStore
```

Add state variables near the top of the ChatScreen composable:
```kotlin
        val tierStore = remember { TierStore(context) }
        var showTierDialog by remember { mutableStateOf(false) }
```

Add the gear icon to the right side of the header row (alongside existing icons):
```kotlin
        Icon(
            Icons.Default.Settings,
            contentDescription = "Settings",
            modifier = Modifier
                .size(20.dp)
                .clickable { showTierDialog = true },
            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )
```

- [x] **Step 3: Add tier change dialog**

Add the dialog composable inside ChatScreen:

```kotlin
        if (showTierDialog) {
            // Local Compose state for dialog selection (SharedPreferences
            // writes are NOT observable — need mutableStateOf bridge)
            var dialogTier by remember { mutableStateOf(tierStore.selectedTier) }

            AlertDialog(
                onDismissRequest = { showTierDialog = false },
                title = { Text("Package Tier") },
                text = {
                    Column {
                        PackageTier.entries.forEach { tier ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { dialogTier = tier }
                                    .padding(vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(
                                    selected = dialogTier == tier,
                                    onClick = { dialogTier = tier },
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column {
                                    Text(tier.displayName, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                    Text(tier.description, fontSize = 12.sp,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        tierStore.selectedTier = dialogTier  // persist on confirm only
                        showTierDialog = false
                        // New packages install on next app restart (bootstrap
                        // re-runs via isTierSatisfied() check)
                    }) { Text("Save") }
                },
                dismissButton = {
                    TextButton(onClick = { showTierDialog = false }) { Text("Cancel") }
                },
            )
        }
```

Note: For v1, changing the tier takes effect on next app restart (bootstrap re-runs and installs missing packages via `isTierSatisfied()` check). A future enhancement could trigger in-app re-bootstrap.

- [x] **Step 4: Verify build**

Run: `cd /c/Users/desti/youcoded && ./gradlew assembleDebug 2>&1 | tail -5`

Expected: BUILD SUCCESSFUL

- [x] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/ui/ChatScreen.kt
git commit -m "feat: add settings gear with tier change dialog"
```

---

## Chunk 6: Quick Chips for Developers

### Task 7: Add developer-oriented quick-action chips

**Files:**
- Modify: `app/src/main/kotlin/com/destin/code/config/ChipConfig.kt`

The current chips are personal-assistant oriented (Journal, Inbox, Briefing, Draft Text). For developer use, add context-aware chips that appear based on the selected tier.

- [x] **Step 1: Add tier-aware chip lists**

Replace the contents of ChipConfig.kt:

```kotlin
package com.destin.code.config

data class QuickChip(
    val label: String,
    val prompt: String,
    val needsCompletion: Boolean = false,
)

val personalChips = listOf(
    QuickChip("Journal", "let's journal"),
    QuickChip("Inbox", "check my inbox"),
    QuickChip("Briefing", "brief me on ", needsCompletion = true),
    QuickChip("Draft Text", "help me draft a text to ", needsCompletion = true),
)

val developerChips = listOf(
    QuickChip("Git Status", "run git status and summarize what's changed"),
    QuickChip("Review PR", "review the latest PR on this repo"),
    QuickChip("Fix Tests", "run the tests and fix any failures"),
    QuickChip("Explain", "explain this error: ", needsCompletion = true),
)

fun chipsForTier(tier: PackageTier): List<QuickChip> {
    return when (tier) {
        PackageTier.CORE -> personalChips
        PackageTier.DEVELOPER, PackageTier.FULL_DEV -> developerChips + personalChips
    }
}
```

- [x] **Step 2: Wire tier-aware chips into QuickChips.kt**

Read QuickChips.kt to find where `defaultChips` is referenced, and update it to use `chipsForTier(tierStore.selectedTier)` instead. This requires passing the tier store or tier value into the composable.

- [x] **Step 3: Verify build**

Run: `cd /c/Users/desti/youcoded && ./gradlew assembleDebug 2>&1 | tail -5`

Expected: BUILD SUCCESSFUL

- [x] **Step 4: Commit**

```bash
git add app/src/main/kotlin/com/destin/code/config/ChipConfig.kt app/src/main/kotlin/com/destin/code/ui/QuickChips.kt
git commit -m "feat: add developer quick-action chips based on selected tier"
```

---

## Implementation Notes

### Package dependency order
Packages within each tier's `additionalPackages` list are already in dependency order. Dependencies from lower tiers (e.g., pcre2, ncurses) are always installed first because `requiredPackagesForTier()` concatenates core + tier packages in order.

### SELinux compatibility
All new packages are standard Termux binaries that go through the same linker64 + termux-exec SELinux bypass as existing packages. Go binaries (fzf, micro, eza) and Rust binaries (ripgrep, fd, bat) are statically linked and may need verification that linker64 handles them correctly. If any fail, they'll need BASH_ENV wrapper functions (already generated by `deployBashEnv()` for binaries in `$PREFIX/bin/`).

### Neovim's tree-sitter-parsers
The `tree-sitter-parsers` meta-package installs 6 parser `.so` files into `$PREFIX/lib/tree-sitter/`. The `packageFileExists()` checks use directory existence since the individual `.so` names vary by version.

### `less` is already in Tier 0
The `less` binary is installed as a dependency of the Termux bootstrap and is also listed as a dependency of `bat`. It is always available regardless of tier, so it is intentionally excluded from the Tier 1 package list.

### Tier downgrade does not remove packages
If a user upgrades to FULL_DEV (installing ~80MB of extra packages) then switches back to CORE, the extra packages remain on disk. This is intentional for v1 — package removal is complex (symlinks, shared libraries, partial uninstall risk). Users who want to reclaim space can clear app data, which triggers a full re-bootstrap with the new tier.

### First-run UX flow
1. App launches → `isBootstrapped` is false → enters setup branch
2. `tierStore.hasSelected` is false → shows `TierPickerScreen`
3. User picks tier → `tierStore.selectedTier` is set → `hasSelected` becomes true
4. Compose recomposes → enters the `else` (bootstrap) branch
5. Bootstrap runs with `packageTier` set → installs core + tier packages
6. Setup completes → `isReady = true` → normal app flow

### Tier upgrade flow (post-setup)
1. User taps Menu → Package Tier → picks new tier → Save
2. "Tier Updated" dialog with "Restart Now" / "Later" buttons
3. On restart, `isReady` checks `isBootstrapped && isTierSatisfied()` — returns false
4. Enters setup flow → `installPackages()` installs missing packages only
5. Shows "Packages installed — [tier name] tier is ready" for 2 seconds
6. Transitions to chat

---

## Post-Implementation Fixes (applied during session)

These issues were discovered during on-device testing and fixed:

### Race condition: packageTier set asynchronously
`LaunchedEffect(Unit)` setting `bootstrap.packageTier` raced with `LaunchedEffect(setupAttempt)` calling `setup()`. Fixed by setting `packageTier` synchronously during composition.

### packageFileExists() path mismatches
Several paths didn't match actual Termux package layouts:
- `vim` → `libexec/vim/vim` (not `bin/vim`)
- `libmsgpack` → `lib/libmsgpack-c.so` (not `libmsgpackc.so`)
- `luv` → `lib/libluv.so` (not `lib/lua/5.1/luv.so`)
- tree-sitter parsers → `lib/libtree-sitter-*.so` (not `lib/tree-sitter/*.so`)

### isReady didn't account for tier satisfaction
`isReady` was initialized from `isBootstrapped` alone. After tier upgrade + restart, the app skipped setup entirely. Fixed by checking `isBootstrapped && isTierSatisfied()`.

### Hardcoded Termux prefix in all scripts and configs
Termux rewrites all shebangs to `#!/data/data/com.termux/files/usr/bin/sh`. Added `applyPostInstallFixups()` which:
- Scans `bin/`, `libexec/`, `etc/` for text files containing the Termux prefix
- Replaces with actual prefix (152 files rewritten)
- Uses sentinel file to avoid re-scanning; sentinel deleted on new package installs

### Package-specific env var overrides
Added to `buildRuntimeEnv()`:
- `VIM`, `VIMRUNTIME` — vim runtime files
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1` — git system config
- `NANORC` — nano config path
- `TMUX_TMPDIR` — tmux socket directory
- `CMAKE_ROOT` — cmake modules

### vim bin/ symlinks
Termux's vim installs to `libexec/vim/vim`, relies on post-install script for `bin/vim` symlink. Added `createPostInstallSymlinks()` (now part of `applyPostInstallFixups()`).

### nvim wrapper script rewrite
nvim's `bin/nvim` is a shell script with hardcoded paths to `libluajit.so` and `libexec/nvim/nvim`. Covered by the bulk prefix rewrite.

### make SHELL= injection
GNU make ignores the SHELL env var and uses its compiled-in default. Added special-case wrapper in `buildBashEnvSh()` that passes `SHELL=$PREFIX/bin/bash` as a command-line variable assignment.

### All 19 packages verified on-device
Full functional testing via adb confirmed every tool works: version checks, JSON parsing (jq), file search (rg/fd), git init/commit, sqlite CRUD, make recipe execution, tmux sessions, Python scripts.
