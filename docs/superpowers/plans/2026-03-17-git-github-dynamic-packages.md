# Git + GitHub CLI via Dynamic Package Resolution — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make git and GitHub CLI (gh) work reliably in Claude Mobile by replacing hardcoded Termux package URLs with dynamic resolution and fixing the command wrapper.

**Architecture:** Add a Termux Packages index parser to Bootstrap that resolves current package URLs at runtime. Fix the JS wrapper to catch bare command names. Add git environment variables and zstd decompression support.

**Tech Stack:** Kotlin (Android), JavaScript (Node.js wrapper), Termux package ecosystem, zstd-jni

**Spec:** `docs/superpowers/specs/2026-03-17-git-github-dynamic-packages-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `app/build.gradle.kts` | Modify | Add zstd-jni dependency |
| `app/src/main/kotlin/.../runtime/Bootstrap.kt` | Modify | Package index parser, dynamic resolution, SHA256 verification, version tracking, zstd support, git env vars, gh+openssh in package list |
| `app/src/main/kotlin/.../runtime/PtyBridge.kt` | Modify | Add `resolveCmd()` to wrapper.js for bare command names |

Full paths under `app/src/main/kotlin/com/destins/claudemobile/`.

---

### Task 1: Add zstd-jni Dependency

**Files:**
- Modify: `app/build.gradle.kts:50-52`

- [ ] **Step 1: Add zstd-jni to build.gradle.kts**

After the existing xz dependency line, add:

```kotlin
implementation("com.github.luben:zstd-jni:1.5.6-3")
```

The block should read:
```kotlin
// Apache Commons Compress for extracting .deb packages (ar + tar + xz + zstd)
implementation("org.apache.commons:commons-compress:1.27.1")
implementation("org.tukaani:xz:1.10")
implementation("com.github.luben:zstd-jni:1.5.6-3")
```

- [ ] **Step 2: Sync gradle**

Run: `./gradlew --no-daemon dependencies --configuration releaseRuntimeClasspath | grep zstd`
Expected: Line showing zstd-jni resolved.

- [ ] **Step 3: Commit**

```bash
git add app/build.gradle.kts
git commit -m "deps: add zstd-jni for Termux package decompression"
```

---

### Task 2: Packages Index Parser

**Files:**
- Modify: `app/src/main/kotlin/.../runtime/Bootstrap.kt` (add inside the class, after `termuxRepo` val)

- [ ] **Step 1: Add PackageInfo data class and parser**

Add these members to the `Bootstrap` class, after the `termuxRepo` val (line 149):

```kotlin
data class PackageInfo(
    val name: String,
    val version: String,
    val filename: String,
    val sha256: String,
    val depends: List<String>
)

/**
 * Parse the Termux Packages index (RFC 822-style stanzas).
 * Returns map of package name to PackageInfo.
 */
private fun parsePackagesIndex(text: String): Map<String, PackageInfo> {
    val packages = mutableMapOf<String, PackageInfo>()
    val stanzas = text.replace("\r\n", "\n").split("\n\n")
    for (stanza in stanzas) {
        val fields = mutableMapOf<String, String>()
        var currentKey = ""
        for (line in stanza.lines()) {
            if (line.startsWith(" ") || line.startsWith("\t")) {
                fields[currentKey] = (fields[currentKey] ?: "") + "\n" + line.trim()
            } else if (":" in line) {
                val (key, value) = line.split(":", limit = 2)
                currentKey = key.trim()
                fields[currentKey] = value.trim()
            }
        }
        val name = fields["Package"] ?: continue
        val version = fields["Version"] ?: continue
        val filename = fields["Filename"] ?: continue
        val sha256 = fields["SHA256"] ?: continue
        val depends = fields["Depends"]
            ?.split(",")
            ?.map { it.trim().split("\\s+".toRegex()).first() }
            ?: emptyList()
        packages[name] = PackageInfo(name, version, filename, sha256, depends)
    }
    return packages
}
```

- [ ] **Step 2: Add index download + caching**

Add below the parser:

```kotlin
private val indexDir get() = File(usrDir, "var/lib/claude-mobile").also { it.mkdirs() }
private val cachedIndexFile get() = File(indexDir, "Packages")
private val installedVersionsFile get() = File(indexDir, "installed.properties")

private fun loadInstalledVersions(): MutableMap<String, String> {
    val map = mutableMapOf<String, String>()
    if (installedVersionsFile.exists()) {
        for (line in installedVersionsFile.readLines()) {
            val parts = line.split("=", limit = 2)
            if (parts.size == 2) map[parts[0]] = parts[1]
        }
    }
    return map
}

private fun saveInstalledVersions(versions: Map<String, String>) {
    installedVersionsFile.writeText(
        versions.entries.joinToString("\n") { "${it.key}=${it.value}" }
    )
}

/**
 * Fetch (or use cached) Termux Packages index.
 * Re-fetches if cache is missing, stale (>24h), or force=true.
 */
private fun fetchPackagesIndex(force: Boolean = false): Map<String, PackageInfo> {
    val cacheMaxAge = 24 * 60 * 60 * 1000L
    val cacheValid = cachedIndexFile.exists() &&
        (System.currentTimeMillis() - cachedIndexFile.lastModified()) < cacheMaxAge

    if (!force && cacheValid) {
        return parsePackagesIndex(cachedIndexFile.readText())
    }

    val indexUrl = "$termuxRepo/dists/stable/main/binary-aarch64/Packages"
    try {
        val connection = java.net.URL(indexUrl).openConnection() as java.net.HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 30000
        if (connection.responseCode != 200) {
            throw IOException("Failed to fetch package index: HTTP ${connection.responseCode}")
        }
        val text = connection.inputStream.bufferedReader().readText()
        cachedIndexFile.parentFile?.mkdirs()
        cachedIndexFile.writeText(text)
        return parsePackagesIndex(text)
    } catch (e: Exception) {
        if (cachedIndexFile.exists()) {
            return parsePackagesIndex(cachedIndexFile.readText())
        }
        throw IOException("Cannot fetch package index and no cache available: ${e.message}", e)
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `./gradlew --no-daemon :app:compileReleaseKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt
git commit -m "feat: add Termux Packages index parser and caching"
```

---

### Task 3: Rewrite installDeb + installPackages (Atomic)

These two changes MUST happen together — `installDeb` changes its signature from `String` to `PackageInfo`, and `installPackages` is the only caller. Splitting them would break compilation.

**Files:**
- Modify: `app/src/main/kotlin/.../runtime/Bootstrap.kt` — rewrite both `installDeb` (lines 247-313) and `installPackages` (lines 157-233)

- [ ] **Step 1: Add imports**

At the top of Bootstrap.kt, add:

```kotlin
import android.util.Log
import java.security.MessageDigest
import com.github.luben.zstd.ZstdInputStream
```

- [ ] **Step 2: Add requiredPackages list and packageFileExists**

Replace the entire `installPackages` method and the `// TODO` comment above the git deps section (lines 157-233) with:

```kotlin
/** Packages required for Claude Mobile, in dependency order. */
private val requiredPackages = listOf(
    // Node.js runtime + deps
    "c-ares", "libicu", "libsqlite", "nodejs", "npm",
    // SELinux exec bypass
    "termux-exec",
    // Git + deps (deps first)
    "openssl", "libcurl", "libexpat", "libiconv", "pcre2", "zlib", "git",
    // GitHub CLI + deps
    "openssh", "gh"
)

/** Check files that indicate a package is properly installed. */
private fun packageFileExists(name: String): Boolean {
    val checkFile = when (name) {
        "c-ares" -> "lib/libcares.so"
        "libicu" -> return usrDir.resolve("lib").listFiles()
            ?.any { it.name.startsWith("libicuuc.so") } == true
        "libsqlite" -> "lib/libsqlite3.so"
        "nodejs" -> "bin/node"
        "npm" -> "lib/node_modules/npm"
        "termux-exec" -> "lib/libtermux-exec-linker-ld-preload.so"
        "openssl" -> "lib/libssl.so"
        "libcurl" -> "lib/libcurl.so"
        "libexpat" -> "lib/libexpat.so"
        "libiconv" -> "lib/libiconv.so"
        "pcre2" -> "lib/libpcre2-8.so"
        "zlib" -> "lib/libz.so"
        "git" -> "bin/git"
        "gh" -> "bin/gh"
        "openssh" -> "bin/ssh"
        else -> return false
    }
    return File(usrDir, checkFile).exists()
}

private fun installPackages(onProgress: (Progress) -> Unit) {
    val index = fetchPackagesIndex()
    val installed = loadInstalledVersions()

    for (name in requiredPackages) {
        val pkg = index[name]
        if (pkg == null) {
            Log.w("Bootstrap", "Package '$name' not found in Termux index — skipping")
            continue
        }

        val fileExists = packageFileExists(name)
        val versionMatch = installed[name] == pkg.version

        // Skip only if BOTH version matches AND binary exists (crash-safe)
        if (fileExists && versionMatch) continue

        onProgress(Progress.Installing(name))
        installDeb(pkg)
        installed[name] = pkg.version
        saveInstalledVersions(installed)
    }

    // termux-exec postinst: copy linker variant to primary .so
    val linkerSo = File(usrDir, "lib/libtermux-exec-linker-ld-preload.so")
    val primarySo = File(usrDir, "lib/libtermux-exec-ld-preload.so")
    if (linkerSo.exists() && !primarySo.exists()) {
        linkerSo.inputStream().use { input ->
            primarySo.outputStream().use { output -> input.copyTo(output) }
        }
        primarySo.setExecutable(true)
    }
}
```

- [ ] **Step 3: Rewrite installDeb to accept PackageInfo**

Delete the existing `installDeb(debPath: String)` method entirely (lines 247-313) and replace with:

```kotlin
/**
 * Download a .deb from Termux repos, verify SHA256, and extract.
 * Supports data.tar.xz, data.tar.zst, and data.tar.gz compression.
 */
private fun installDeb(pkg: PackageInfo) {
    val url = "$termuxRepo/${pkg.filename}"
    val tmpDeb = File(context.cacheDir, "tmp.deb")
    var connection: java.net.HttpURLConnection? = null
    try {
        // Download with HTTP error checking
        connection = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 60000
        if (connection.responseCode != 200) {
            throw IOException("Failed to download ${pkg.name}: HTTP ${connection.responseCode} from $url")
        }
        connection.inputStream.use { input ->
            tmpDeb.outputStream().use { output -> input.copyTo(output) }
        }
        connection.disconnect()
        connection = null

        // SHA256 verification
        if (pkg.sha256.isNotEmpty()) {
            val digest = MessageDigest.getInstance("SHA-256")
            tmpDeb.inputStream().use { input ->
                val buf = ByteArray(8192)
                var n: Int
                while (input.read(buf).also { n = it } != -1) {
                    digest.update(buf, 0, n)
                }
            }
            val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
            if (actualSha256 != pkg.sha256) {
                throw IOException(
                    "SHA256 mismatch for ${pkg.name}: expected ${pkg.sha256}, got $actualSha256"
                )
            }
        }

        // Parse ar archive to find data.tar
        ArArchiveInputStream(BufferedInputStream(tmpDeb.inputStream())).use { arStream ->
            var arEntry = arStream.nextEntry
            while (arEntry != null) {
                if (arEntry.name.startsWith("data.tar")) {
                    val decompressed: java.io.InputStream = when {
                        arEntry.name.contains(".xz") -> XZInputStream(arStream)
                        arEntry.name.contains(".zst") -> ZstdInputStream(arStream)
                        arEntry.name.contains(".gz") -> java.util.zip.GZIPInputStream(arStream)
                        else -> arStream
                    }
                    val tarStream = TarArchiveInputStream(decompressed)
                    var tarEntry = tarStream.nextEntry
                    while (tarEntry != null) {
                        val termuxPrefix = "data/data/com.termux/files/usr/"
                        var entryPath = tarEntry.name.removePrefix("./").removePrefix("/")
                        if (entryPath.startsWith(termuxPrefix)) {
                            entryPath = entryPath.removePrefix(termuxPrefix)
                        }
                        val absPrefix = "/data/data/com.termux/files/usr/"
                        if (tarEntry.name.startsWith(absPrefix)) {
                            entryPath = tarEntry.name.removePrefix(absPrefix)
                        }
                        if (entryPath.isEmpty()) {
                            tarEntry = tarStream.nextEntry
                            continue
                        }
                        val target = File(usrDir, entryPath)

                        if (tarEntry.isDirectory) {
                            target.mkdirs()
                        } else if (tarEntry.isSymbolicLink) {
                            target.parentFile?.mkdirs()
                            try {
                                java.nio.file.Files.createSymbolicLink(
                                    target.toPath(),
                                    java.nio.file.Paths.get(tarEntry.linkName)
                                )
                            } catch (_: Exception) {}
                        } else {
                            target.parentFile?.mkdirs()
                            target.outputStream().use { out ->
                                tarStream.copyTo(out)
                            }
                            target.setExecutable(true)
                        }
                        tarEntry = tarStream.nextEntry
                    }
                    break
                }
                arEntry = arStream.nextEntry
            }
        }
    } finally {
        connection?.disconnect()
        tmpDeb.delete()
    }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `./gradlew --no-daemon :app:compileReleaseKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt
git commit -m "feat: dynamic package resolution with SHA256 verification and zstd support"
```

Note: The `isFullySetup` property (line 20-22) is intentionally NOT changed — it gates on node/npm/claude-code, not git/gh. Git and gh are best-effort packages that don't block app startup.

---

### Task 4: Add Git Environment Variables

**Files:**
- Modify: `app/src/main/kotlin/.../runtime/Bootstrap.kt` — `buildRuntimeEnv()` method (lines 674-712)

- [ ] **Step 1: Add GIT_EXEC_PATH and GIT_TEMPLATE_DIR**

In `buildRuntimeEnv()`, after the `TERMUX_PREFIX` entry (line 706), add:

```kotlin
// Git helper programs (git-remote-https, git-upload-pack, etc.)
// have Termux paths baked in — override with our relocated prefix.
put("GIT_EXEC_PATH", "$usr/libexec/git-core")
put("GIT_TEMPLATE_DIR", "$usr/share/git-core/templates")
```

- [ ] **Step 2: Verify it compiles**

Run: `./gradlew --no-daemon :app:compileReleaseKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/Bootstrap.kt
git commit -m "fix: add GIT_EXEC_PATH and GIT_TEMPLATE_DIR for relocated prefix"
```

---

### Task 6: Fix Wrapper — Bare Command Name Resolution

**Files:**
- Modify: `app/src/main/kotlin/.../runtime/PtyBridge.kt` — `WRAPPER_JS` constant (lines 213-336)

- [ ] **Step 1: Add resolveCmd function to wrapper**

In the WRAPPER_JS string, after the `fixPath` function definition (line 224), add:

```javascript
function resolveCmd(c) {
    if (c && c.indexOf('/') === -1) {
        var r = PREFIX + '/bin/' + c;
        try { _as.call(null, r, fs.constants.R_OK); return r; }
        catch(e) { return c; }
    }
    return c;
}
```

Note: `_as` is the saved original `fs.accessSync` (already defined on line 230). The `resolveCmd` definition must appear AFTER `_as` is defined. Place it after line 234 (after the `fs.accessSync` patch).

- [ ] **Step 2: Apply resolveCmd in execFileSync**

Change the `execFileSync` patch to resolve bare names. The current code (line 243):
```javascript
child_process.execFileSync = function(file) {
    if (isEB(file)) {
```

Becomes:
```javascript
child_process.execFileSync = function(file) {
    file = resolveCmd(file);
    if (isEB(file)) {
```

- [ ] **Step 3: Apply resolveCmd in execFile**

Change the `execFile` patch similarly. The current code (line 255):
```javascript
child_process.execFile = function(file) {
    if (isEB(file)) {
```

Becomes:
```javascript
child_process.execFile = function(file) {
    file = resolveCmd(file);
    if (isEB(file)) {
```

- [ ] **Step 4: Apply resolveCmd in spawnFix**

Add resolution at the top of `spawnFix`. The current code (line 275):
```javascript
function spawnFix(orig, command, args, options) {
    var o = Array.isArray(args) ? options : args;
```

Becomes:
```javascript
function spawnFix(orig, command, args, options) {
    command = resolveCmd(String(command));
    var o = Array.isArray(args) ? options : args;
```

- [ ] **Step 5: Verify it compiles**

Run: `./gradlew --no-daemon :app:compileReleaseKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add app/src/main/kotlin/com/destins/claudemobile/runtime/PtyBridge.kt
git commit -m "fix: resolve bare command names in wrapper.js for git/gh"
```

---

### Task 7: Build + Smoke Test

- [ ] **Step 1: Full build**

Run: `./gradlew --no-daemon assembleDebug 2>&1 | tail -10`
Expected: BUILD SUCCESSFUL

- [ ] **Step 2: Deploy to device and test**

Install the debug APK. On first launch after clearing data, verify:
1. Bootstrap installs git and gh (watch progress messages)
2. Shell view: `git --version` prints version
3. Shell view: `gh --version` prints version
4. Shell view: `gh auth login` starts the device flow
5. After auth: `git clone https://github.com/<user>/<small-repo>.git ~/tmp/test-repo`
6. Claude Code: ask it to run `git status` — should work via wrapper

- [ ] **Step 3: Commit any fixes from smoke testing**
