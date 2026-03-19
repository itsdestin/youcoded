# Git + GitHub CLI via Dynamic Package Resolution

**Date:** 2026-03-17
**Status:** Approved design
**Goal:** Make git and GitHub CLI (gh) work reliably in DestinCode, with dynamic package version resolution so binaries never go stale.

---

## Problem Statement

Git and the GitHub CLI don't work in DestinCode despite binaries being present (or expected to be present) on device. Three root causes:

1. **Stale package URLs** — `Bootstrap.kt` hardcodes Termux deb URLs with specific versions (e.g., `git_2.49.0`). Termux regularly removes old versions, causing 404s. The current `installDeb` silently fails on HTTP errors, so the binary simply doesn't get installed.
2. **Missing `gh` package** — GitHub CLI is not in the bootstrap package list at all.
3. **Wrapper bypass for bare command names** — `claude-wrapper.js` only intercepts commands with full paths matching `PREFIX/...`. When Claude Code calls `spawn("git", ...)` (bare name, no path), the wrapper doesn't intercept it, and direct `execve("git")` fails due to SELinux.

## Design

### 1. Dynamic Package Resolution

Replace hardcoded deb URLs with runtime resolution from the Termux Packages index.

**Index source:** `https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages`
- ~500KB plaintext, same file `apt update` fetches
- Contains every package's current version, filename, SHA256, and dependency list

**Resolution flow:**
```
Bootstrap.installPackages()
  1. Download Packages index (or use cached copy if < 24h old)
  2. Parse into Map<String, PackageInfo>
     PackageInfo = { version, filename, sha256, depends }
  3. For each required package name:
     a. Look up PackageInfo from index
     b. Check installed.properties for current installed version
     c. If not installed or version differs → download, verify SHA256, extract
     d. Record version in installed.properties
```

**Required packages** (names only, no URLs):
```kotlin
val requiredPackages = listOf(
    // Node.js runtime + deps
    "c-ares", "libicu", "libsqlite", "nodejs", "npm",
    // SELinux exec bypass
    "termux-exec",
    // Git + deps
    "openssl", "libcurl", "libexpat", "libiconv", "pcre2", "zlib", "git",
    // GitHub CLI + deps
    "gh", "openssh"
)
```

**Index caching:**
- Cache at `$PREFIX/var/lib/claude-mobile/Packages` with a timestamp
- Re-fetch if: file missing, older than 24 hours, or a required binary is missing from disk
- On fetch failure (no network), fall back to cached copy if available; if no cache, fail with clear error

**Version tracking:**
- Store installed package versions in `$PREFIX/var/lib/claude-mobile/installed.properties`
- Format: `git=2.53.0`, `gh=2.88.1`, etc.
- Checked during `installPackages` to detect when Termux has a newer version

### 2. Packages Index Parser

The Termux Packages file is RFC 822-style: blank-line-separated stanzas, each with `Key: Value` lines. Example:

```
Package: git
Version: 2.53.0
Filename: pool/main/g/git/git_2.53.0_aarch64.deb
SHA256: 540e6495...
Depends: libcurl, libexpat, libiconv, less, openssl, pcre2, zlib
```

**Parser output:** `Map<String, PackageInfo>` where:
```kotlin
data class PackageInfo(
    val version: String,
    val filename: String,  // relative path for download URL
    val sha256: String,
    val depends: List<String>
)
```

We only need `Package`, `Version`, `Filename`, `SHA256`, and `Depends` fields. Skip all other fields.

### 3. SHA256 Verification

Currently `installDeb` downloads and extracts with no integrity check. Add verification:

```
1. Download .deb to temp file
2. Compute SHA256 of downloaded file
3. Compare against PackageInfo.sha256 from the index
4. If mismatch → delete temp file, throw IOException
5. If match → proceed with extraction
```

### 4. Error Handling in installDeb

Current behavior: `URL(url).openStream()` on a 404 returns an HTML error page, which the ar parser fails to parse silently.

**Fix:** Check HTTP response code before reading:
```kotlin
val connection = URL(url).openConnection() as HttpURLConnection
if (connection.responseCode != 200) {
    throw IOException("Failed to download $debPath: HTTP ${connection.responseCode}")
}
```

This surfaces the failure immediately instead of silently producing a broken install.

### 5. Git Environment Variables

Git requires environment variables to find its helper programs and templates. Termux's git has hardcoded paths to `/data/data/com.termux/files/usr/...` which don't match our relocated prefix. Without these, `git clone`, `git push`, `git fetch`, and any operation that invokes helpers will fail.

**Add to `buildRuntimeEnv()`:**
- `GIT_EXEC_PATH` = `$PREFIX/libexec/git-core` — where git finds `git-remote-https`, `git-upload-pack`, etc.
- `GIT_TEMPLATE_DIR` = `$PREFIX/share/git-core/templates` — init templates

**Git helper binary execution:** Files in `$PREFIX/libexec/git-core/` are ELF binaries that git invokes via `execve()`. They face the same SELinux restriction. The `termux-exec` LD_PRELOAD library (`libtermux-exec-ld-preload.so`) intercepts `execve()` at the libc level and routes through linker64, which should cover these calls. The `TERMUX__PREFIX` env var (already set) tells termux-exec where our prefix is. This must be verified during implementation — if termux-exec doesn't handle the relocated prefix for libexec paths, `linker64-env.sh` must be extended to scan `$PREFIX/libexec/git-core/` in addition to `$PREFIX/bin/`.

### 6. Zstandard Decompression Support

The current `installDeb` hardcodes XZ decompression (`XZInputStream`). Termux has been migrating packages to `data.tar.zst` (Zstandard). If a required package ships as zst, extraction silently fails.

**Fix:** Check the data.tar entry name and use the appropriate decompressor:
- `data.tar.xz` → `XZInputStream` (existing)
- `data.tar.zst` → Zstandard decompressor (add `com.github.luben:zstd-jni` dependency)
- `data.tar.gz` → `GZIPInputStream` (fallback)

### 7. Wrapper Fix — Bare Command Name Resolution

**Current bug:** `isEB("git")` returns `false` because `"git"` doesn't start with `PREFIX + "/"`.

**Fix in `spawnFix`:** Before the existing `isEB(command)` check, add bare-name resolution:

```javascript
// Resolve bare command names against PREFIX/bin/
function resolveCmd(cmd) {
    if (cmd && cmd.indexOf('/') === -1) {
        var resolved = PREFIX + '/bin/' + cmd;
        try { fs.accessSync(resolved, fs.constants.R_OK); return resolved; }
        catch(e) { return cmd; }
    }
    return cmd;
}
```

Then in `spawnFix`, at the top:
```javascript
command = resolveCmd(String(command));
```

This makes `spawn("git", ["status"])` resolve to `spawn("/data/.../usr/bin/git", ["status"])`, which `isEB` then catches and routes through linker64.

**Same fix needed in `execFileSync` and `execFile`** — add `file = resolveCmd(file)` before the `isEB(file)` check.

### 8. GitHub Authentication

**Approach:** `gh auth login` device flow only. No app-level settings or token storage.

**How it works:**
1. User opens Shell view in the app
2. Runs `gh auth login`
3. `gh` prints a one-time code and a URL (github.com/login/device)
4. User opens the URL in their phone browser, enters the code, authorizes
5. `gh` stores the token in `~/.config/gh/hosts.yml`
6. `gh` automatically registers itself as git's credential helper
7. Both `gh` and `git` operations now work with GitHub

**Requirements:** The PTY must support the interactive prompts (arrow key selection) — it already does. `openssh` must be installed for SSH-based flows.

No changes to the app's Kotlin code needed for auth — it's entirely handled by `gh` at runtime.

## Files Modified

| File | Changes |
|------|---------|
| `Bootstrap.kt` | New: `TermuxPackageIndex` parser class, `resolvePackage()` method, SHA256 verification, version tracking, `gh`+`openssh` in package list, HTTP error handling, zstd decompression, `GIT_EXEC_PATH`/`GIT_TEMPLATE_DIR` env vars |
| `PtyBridge.kt` | Wrapper.js: add `resolveCmd()` helper, apply in `spawnFix`, `execFileSync`, `execFile` |
| `build.gradle.kts` | Add `com.github.luben:zstd-jni` dependency for zstandard decompression |

## Files Created

| File | Purpose |
|------|---------|
| (at runtime) `$PREFIX/var/lib/claude-mobile/Packages` | Cached Termux package index |
| (at runtime) `$PREFIX/var/lib/claude-mobile/installed.properties` | Installed version tracking |

## Not In Scope

- **Native Claude binary (Bun)** — separate effort, different problem (glibc on Android)
- **Offline package installation** — still requires network on first boot
- **Auto-upgrading packages** — only installs/upgrades during bootstrap, not in background
- **Dependency resolution** — we list all required packages explicitly rather than walking the dependency tree. This is intentional: Termux's dependency graph is large and we only need a known set.
- **App settings UI for GitHub** — users authenticate via `gh auth login` in the terminal

## Implementation Notes

**Package installation order matters.** Dependencies must be extracted before dependents (e.g., `openssl` before `libcurl`, `libcurl` before `git`). The `requiredPackages` list is in dependency order — preserve this during implementation.

**Install consistency.** If the app crashes between extraction and writing `installed.properties`, the package appears uninstalled but files are partially present. Use a dual check: skip installation only if BOTH the version matches in `installed.properties` AND the expected binary exists on disk.

**gh is a Go binary.** It may behave unexpectedly under linker64 since Go uses its own syscall layer. Smoke test `gh --version` and `gh auth login` after implementation. SELinux still blocks direct `execve()` regardless of static vs dynamic linking, so linker64 routing is still required.

**Auth persistence.** `gh auth login` stores tokens in `~/.config/gh/hosts.yml` (inside app private storage). Tokens survive app restarts but are lost on app uninstall/data clear. This is expected Android behavior.
