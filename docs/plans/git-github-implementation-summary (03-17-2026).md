# Git + GitHub CLI Implementation Summary

**Date:** 2026-03-17
**Status:** Complete — deployed and testing

---

## What We Did

Made git and GitHub CLI (`gh`) work in DestinCode by replacing the broken hardcoded package system with dynamic resolution from the Termux package index, fixing the JavaScript wrapper to catch bare command names, and adding missing git environment variables.

## Problems Solved

1. **Git binary missing** — `git_2.49.0` was a 404 on Termux repos (version removed). `installDeb` silently failed on HTTP errors, so git was never installed.
2. **GitHub CLI missing** — `gh` was never in the bootstrap package list. The version previously installed manually was ET_EXEC (rejected by linker64). Current Termux `gh` 2.88.1 is ET_DYN (PIE) and works.
3. **Bare command names not intercepted** — `claude-wrapper.js` only caught full-path commands (`/data/.../usr/bin/git`). When Claude Code called `spawn("git", ...)`, the wrapper missed it and `execve("git")` failed due to SELinux.
4. **Missing git environment variables** — `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR` weren't set, so git couldn't find its helper programs (`git-remote-https`, etc.) at the relocated prefix.
5. **Progress bar stuck at 68%** — The setup screen showed a determinate bar for extraction then switched to an indeterminate spinner for package installation, making it look frozen.

## Changes Made

### `app/build.gradle.kts`
- Added `com.github.luben:zstd-jni:1.5.6-3` dependency for Zstandard decompression (Termux migrating from `.xz` to `.zst`)

### `app/src/main/kotlin/.../runtime/Bootstrap.kt`
- **PackageInfo data class** — holds name, version, filename, sha256, depends
- **parsePackagesIndex()** — RFC 822 parser for the Termux Packages index (~500KB plaintext listing all packages with current versions and SHA256 hashes)
- **fetchPackagesIndex()** — downloads and caches the index with 24h TTL, falls back to cache on network failure
- **Version tracking** — `installed.properties` file records installed package versions; compared against index to detect upgrades
- **installPackages() rewrite** — replaced 15 hardcoded `installDeb("pool/main/...")` calls with a loop over `requiredPackages` list that resolves URLs dynamically from the index
- **installDeb(PackageInfo) rewrite** — HTTP error checking (no more silent 404 failures), SHA256 verification, zstd/xz/gz decompression support, proper `HttpURLConnection.disconnect()`, symlink overwrite on upgrade (`target.delete()` before `createSymbolicLink`), skip non-usr tar entries
- **New packages added** — `gh` (GitHub CLI) and `openssh` (SSH for git/gh)
- **Git env vars** — `GIT_EXEC_PATH=$PREFIX/libexec/git-core` and `GIT_TEMPLATE_DIR=$PREFIX/share/git-core/templates` in `buildRuntimeEnv()`
- **Progress reporting** — `Installing` now carries `overallPercent`; weighted 0-30% extraction, 30-80% packages, 80-100% claude-code

### `app/src/main/kotlin/.../runtime/PtyBridge.kt`
- **resolveCmd()** — new function in `claude-wrapper.js` that resolves bare command names (e.g., `"git"`) against `$PREFIX/bin/` using `fs.accessSync`
- Applied in `execFileSync`, `execFile`, and `spawnFix` — all three paths now catch bare names

### `app/src/main/kotlin/.../ui/SetupScreen.kt`
- Installing phase now shows a determinate progress bar with percentage (when `overallPercent >= 0`) instead of an indeterminate spinner

## GitHub Authentication Flow

No app code changes needed. Users authenticate via:
1. Open Shell view → run `gh auth login`
2. `gh` prints a one-time code + URL (github.com/login/device)
3. Open URL in phone browser, enter code, authorize
4. `gh` stores token in `~/.config/gh/hosts.yml` and registers as git credential helper
5. Both `gh` and `git` operations work with GitHub

## Design & Plan Documents

- **Spec:** `docs/superpowers/specs/2026-03-17-git-github-dynamic-packages-design.md`
- **Plan:** `docs/superpowers/plans/2026-03-17-git-github-dynamic-packages.md`

## Key Technical Findings

1. **Termux `gh` 2.88.1 is ET_DYN (PIE)** — the old version was ET_EXEC which linker64 rejects. Simply updating to the current version fixes the binary loading issue.
2. **Termux removed `git` 2.49.0** — hardcoded package URLs go stale. Dynamic resolution from the Packages index is the correct long-term solution.
3. **The wrapper's `isEB()` only matches full paths** — Claude Code sometimes passes bare command names to `child_process.spawn()`. The `resolveCmd()` function bridges this gap by probing `$PREFIX/bin/<name>` before the `isEB` check.
4. **Git has hardcoded Termux paths** — compiled-in paths to `libexec/git-core/` and `share/git-core/templates` don't match our relocated prefix. `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR` env vars override them.
5. **Termux is migrating to Zstandard** — newer packages use `data.tar.zst` instead of `data.tar.xz`. The `zstd-jni` library handles this.

## Runtime File Locations

| File | Purpose |
|------|---------|
| `$PREFIX/var/lib/claude-mobile/Packages` | Cached Termux package index |
| `$PREFIX/var/lib/claude-mobile/installed.properties` | Installed version tracking |
| `~/.config/gh/hosts.yml` | GitHub auth token (written by `gh auth login`) |
