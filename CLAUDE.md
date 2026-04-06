# DestinCode — Project Guide

Android app that runs Claude Code natively using Termux's terminal-emulator library
and package ecosystem, with a multi-layer SELinux bypass for SDK 35+.

## Architecture Overview

- **UI**: Jetpack Compose chat interface + Termux TerminalView for raw shell
- **Runtime**: PtyBridge (Claude Code sessions) and DirectShellBridge (standalone bash)
- **Bootstrap**: Downloads pre-compiled .deb packages from Termux repos, extracts to app-private storage
- **SELinux bypass**: 3-layer system (JS wrapper → C LD_PRELOAD → bash shell functions), all routing through `/system/bin/linker64`
- **Events**: Unix socket relay (hook-relay.js → EventBridge) for structured tool call/response rendering

## Two Terminal Views

All runtime fixes (environment, shell functions, process lifecycle) must work in **both**:
1. **PtyBridge** — Claude Code sessions (JS wrapper + hooks + EventBridge)
2. **DirectShellBridge** — standalone bash shell (no Claude Code, no parser)

Both share `Bootstrap.buildRuntimeEnv()` and `Bootstrap.deployBashEnv()`. When adding
environment variables, shell functions, or process lifecycle improvements, always verify
they apply to both bridges.

## System Fundamentals — Strict Rules

### LD_LIBRARY_PATH is REQUIRED (relocated prefix)

Standard Termux doesn't need `LD_LIBRARY_PATH` because their install prefix matches
the compile-time prefix baked into `DT_RUNPATH`. **DestinCode is different** — we
relocate binaries from `/data/data/com.termux/files/usr` to `context.filesDir/usr`,
so `DT_RUNPATH` points to a non-existent directory. `LD_LIBRARY_PATH` overrides the
stale `DT_RUNPATH` and is required for all binary execution.

Do NOT remove `LD_LIBRARY_PATH` — without it, bash and node fail to find their shared
libraries and the bootstrap self-test fails.

### DO NOT poll isRunning for process death detection

The Termux `TerminalSession` fires `onSessionFinished()` via a JNI `waitpid()` thread
the instant the child process exits. Use the reactive `sessionFinished` StateFlow on
both PtyBridge and DirectShellBridge. Never add polling loops for death detection.

### DO NOT link against glibc

All binaries running in the app must be compiled against Android's **Bionic** libc (what
Termux uses). glibc and Bionic cannot coexist in the same process — symbol conflicts,
missing kernel interfaces, and FHS path expectations make glibc on Android inherently
fragile. The `native/execve-interceptor.c` is a glibc-targeted research artifact; do not
deploy glibc-linked binaries in production.

### DO NOT use /tmp or /var/tmp directly

Android has no `/tmp`. All temp paths must redirect to `$HOME/tmp`:
- **Shell**: `cd()` function override in linker64-env.sh
- **Node.js**: `fixTmp()` in claude-wrapper.js patches fs and child_process
- **Environment**: `TMPDIR` and `CLAUDE_CODE_TMPDIR` point to `$HOME/tmp`

When adding new code that references temp directories, use these env vars — never
hardcode `/tmp`.

### DO keep the JS wrapper (claude-wrapper.js) as an asset file

The wrapper lives in `app/src/main/assets/claude-wrapper.js` — this is the **canonical
source**. It is deployed to `~/.claude-mobile/claude-wrapper.js` at every launch by
`Bootstrap.deployWrapperJs()`. Do NOT duplicate this content as an inline Kotlin string.

The wrapper monkey-patches Node.js `child_process` and `fs` modules. It is tightly
coupled to Node.js internals. When upgrading the `nodejs` package, verify the wrapper
still functions correctly.

### DO route all binary execution through linker64

Every ELF binary under `$PREFIX` must be executed as:
```
/system/bin/linker64 /path/to/binary [args...]
```
This bypasses SELinux's `app_data_file` execute restriction (W^X policy, Android 10+).
Three layers enforce this:
1. **claude-wrapper.js** — patches Node.js child_process (Claude Code level)
2. **libtermux-exec-ld-preload.so** — intercepts execve() in bash subprocesses (C level)
3. **linker64-env.sh** — shell function wrappers for every binary (bash level)

### DO use the linker variant of termux-exec

After installing the `termux-exec` package, always copy
`libtermux-exec-linker-ld-preload.so` over `libtermux-exec-ld-preload.so`.
The default "direct" variant only fixes paths but doesn't route through linker64,
causing "Permission denied" when binaries fork+exec helpers.

## Package System

- Packages are downloaded from `https://packages.termux.dev/apt/termux-main`
- Only aarch64 architecture is supported
- SHA256 verification on individual .deb files (hashes come from the HTTPS-fetched index)
- No GPG signature verification on the package index itself (acceptable for now; HTTPS provides transport security)
- Package index cached for 24 hours
- Required packages listed in `Bootstrap.requiredPackages` in dependency order

## Key Files

| File | Purpose |
|------|---------|
| `runtime/Bootstrap.kt` | Package management, environment setup, shell function generation |
| `runtime/PtyBridge.kt` | Claude Code terminal session (PTY + event bridge) |
| `runtime/DirectShellBridge.kt` | Standalone bash shell session |
| `runtime/ManagedSession.kt` | Session lifecycle, status, approval flow, prompt detection |
| `runtime/SessionRegistry.kt` | Multi-session management |
| `assets/claude-wrapper.js` | Node.js monkey-patch for SELinux bypass (CANONICAL SOURCE) |
| `assets/hook-relay.js` | Unix socket event relay for structured hook events |
| `skills/LocalSkillProvider.kt` | Skill marketplace backend (discovery, install, config, sharing) |
| `skills/PluginInstaller.kt` | Installs Claude Code plugins to `~/.claude/plugins/<name>/` via git clone/copy |
| `skills/SkillConfigStore.kt` | Reads/writes `~/.claude/destincode-skills.json` (favorites, chips, overrides, installed plugins) |
| `skills/MarketplaceFetcher.kt` | HTTP fetch + cache of GitHub marketplace registry |
| `skills/SkillScanner.kt` | Discovers installed skills from `~/.claude/plugins/` |
| `skills/SkillShareCodec.kt` | Base64url encode/decode for `destincode://` deep links |
| `native/execve-interceptor.c` | glibc LD_PRELOAD research artifact (not deployed) |
