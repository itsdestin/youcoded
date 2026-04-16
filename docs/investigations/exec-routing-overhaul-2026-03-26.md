# Exec Routing Overhaul Investigation

**Date:** 2026-03-26
**Branch:** `fix/termux-exec-and-go-workarounds`
**Participants:** Destin + Claude (Opus 4.6)

---

## Context

This investigation began as a comparative analysis of the YouCoded mobile app vs the YouCoded desktop app, evolved into a deep diagnosis of a `gh repo clone` SELinux failure, and ultimately led to a fundamental architectural change: stripping redundant exec routing layers and properly configuring `termux-exec` as the primary execution mechanism.

---

## Part 1: Comparative Analysis (Mobile vs Desktop)

### Architecture Comparison

| Dimension | Mobile | Desktop |
|-----------|--------|---------|
| Framework | Kotlin + Jetpack Compose | Electron + React 19 + TypeScript |
| Terminal | Termux terminal-emulator (native canvas) | xterm.js (WebGL) |
| PTY | Direct Termux `TerminalSession` fork | `node-pty` in separate worker process |
| Hook Relay | Unix abstract sockets | Named pipes (cross-platform) |
| State | Kotlin StateFlow/SharedFlow | React Context + useReducer |

### Key Findings

- Both apps solve similar platform-specific process spawning constraints with indirection layers
- The hook relay protocol is nearly identical — only the transport differs
- Desktop has remote browser access, skill discovery, and Connect-Four game; mobile has Material You theming, foreground service, and 3-tier package management
- Mobile is the more technically impressive achievement (fighting Android SELinux); desktop is the more polished product

---

## Part 2: The `gh repo clone` Failure

### Initial Error

Screenshot showed two failures:
1. `git clone` via HTTPS: "could not read Username — No such device or address" (no TTY for credential prompt)
2. `gh repo clone`: "fork/exec exec-wrappers/git: permission denied" (SELinux blocking)

### Diagnosis Process

#### Hypothesis 1: LD_PRELOAD not loaded in linker64 processes
**Status: WRONG (race condition in test)**

Initial `/proc/PID/maps` tests showed termux-exec NOT loaded for git, gh, etc. This was a **false negative** — the processes exited before maps could be read. Retesting with long-lived processes (using `GIT_PAGER="sleep 5"` and `gh api` with paginated output) confirmed termux-exec IS loaded in ALL linker64-launched binaries.

#### Hypothesis 2: Go uses raw syscalls, bypassing LD_PRELOAD
**Status: CONFIRMED**

Go's `os/exec.Command` uses `syscall.forkExec` → `syscall.rawVforkSyscall` → raw `SYS_execve`. This was confirmed by:
- Finding `syscall.forkExec` and `syscall.rawVforkSyscall` strings in the `gh` binary
- `gh` failing to exec git even though termux-exec was loaded in its process
- Testing with `patchelf --add-needed` to inject termux-exec as a DT_NEEDED dependency — still failed (Go bypasses libc's execve regardless)

#### Hypothesis 3: Layer 3 (termux-exec) has never worked
**Status: WRONG (corrected)**

The user pushed back on the claim that "Layer 3 hasn't been working all along." Retesting with properly long-lived processes showed termux-exec IS loaded and IS intercepting libc exec calls for C/Rust programs. The failure is **specifically and only** Go programs.

### Package Impact Assessment

Classified every installed binary by language:

| Language | Exec Mechanism | termux-exec works? | Affected binaries |
|----------|---------------|--------------------|--------------------|
| C/C++ | libc execve | Yes | git, ssh, curl, python3, node, vim, make, cmake, etc. |
| Rust | libc execvp | Yes | ripgrep, fd, bat, eza |
| Go | raw SYS_execve | **No** | gh, rclone, fzf, micro |

Only 4 Go binaries out of 50+ total are affected. `rclone`'s browser-open is already handled by `claude-wrapper.js`.

---

## Part 3: Proposed Solutions

### Solutions Considered and Ruled Out

| Solution | Status | Why ruled out |
|----------|--------|---------------|
| `patchelf --add-needed` termux-exec on Go binaries | **Ruled out** | Go still uses raw syscalls even if the library is loaded as DT_NEEDED |
| Compile Go binaries with CGo (libc exec) | **Ruled out** | Go's `os/exec` uses raw syscalls regardless of CGo — this is Go's design, not a build flag |
| seccomp-BPF user notification supervisor | **Deferred** | Correct fix but ~200 lines of tricky C, complex ptrace interaction with Go's goroutine threads. Over-engineered for 3 affected binaries. |
| ptrace-based exec interceptor | **Deferred** | Similar to seccomp — correct but expensive for narrow problem |
| `proot` wrapping | **Ruled out** | Significant overhead, complex process tree management |
| `/system/bin/sh` symlink exec-wrappers | **Ruled out** | SELinux blocks execve before kernel reads shebang — confirmed by testing |
| Place exec-wrappers on tmpfs mount | **Ruled out** | `mount()` requires CAP_SYS_ADMIN, not available to regular apps |
| Patch Go runtime upstream | **Ruled out** | Go team explicitly rejected using libc execve (golang/go#3744, filed 2012, closed) |

### Solutions Implemented

1. **`.netrc` for git auth** — already existed in codebase (`syncGhTokenToNetrc`)
2. **`gh` bash wrapper** — intercepts `repo clone` → `git clone`, `repo fork --clone` → fork API + clone
3. **`SHELL=/system/bin/sh` for fzf/micro** — Go CAN exec system binaries; sh finds commands via PATH → exec-wrappers → shebang fallback
4. **Targeted exec-wrappers** — for the shebang fallback mechanism used by fzf/micro

---

## Part 4: The Termux Comparison

### Critical Discovery: `targetSdkVersion`

| App | targetSdkVersion | SELinux exec restricted? |
|-----|-----------------|------------------------|
| Official Termux (F-Droid) | 28 | **No** — `untrusted_app_27` domain is exempted |
| Termux Play Store fork | 35 | Yes |
| YouCoded | 35 | Yes |

Stock Termux (F-Droid) avoids the entire SELinux exec problem by targeting SDK 28, which puts it in an exempted SELinux domain. The Play Store has a **separate fork** (by the original creator @fornwall, not endorsed by the current Termux team) that targets SDK 35 and uses the same `system_linker_exec` approach as YouCoded.

### Were the layers redundant with termux-exec?

**Initial assessment: "Yes, largely redundant."**
**Revised assessment: "They were necessary when written; one env var makes them redundant now."**

The commit history revealed that termux-exec **genuinely didn't work** for YouCoded's relocated prefix when the layers were built (commit `d84302e`, March 17, 2026). The design doc explicitly states: "termux-exec is retained in case a future custom build resolves the prefix issue."

### The Root Cause: Missing `TERMUX_APP__LEGACY_DATA_DIR`

termux-exec v2.4 does a **string prefix match** to check if a binary is under the app data directory:
- `TERMUX_APP__DATA_DIR` = `/data/user/0/com.destin.code/files` (from `context.filesDir`)
- Binary canonical path = `/data/data/com.destin.code/files/usr/bin/git`
- `/data/user/0/` and `/data/data/` are **symlinks to the same location**
- String comparison **fails** → `is_exe_under_termux_app_data_dir: '0'` → no linker64 routing

Setting `TERMUX_APP__LEGACY_DATA_DIR=/data/data/com.destin.code/files` provides the alternate path form. Verified with `TERMUX_EXEC__LOG_LEVEL=5` diagnostic output — exec routing now works for all C/Rust programs.

### What termux-exec handles vs what YouCoded still needs

**termux-exec handles (no longer need custom code for):**
- ELF binary exec routing through linker64
- Shebang script handling (reads `#!`, rewrites interpreter paths)
- `/bin/*` and `/usr/bin/*` prefix rewriting → `$PREFIX/bin/*`
- Environment management (strips LD_PRELOAD for system binaries)

**YouCoded still needs custom code for:**
- `/tmp` path rewriting (Android has no `/tmp` — affects both fs and exec args)
- `fs.accessSync` X_OK bypass (SELinux denies execute check on app data)
- Shell path fixing (Termux Node.js has hardcoded `/data/data/com.termux/` shell path)
- `-l` flag stripping (Claude Code-specific bash invocation quirk)
- `BASH_ENV` injection (ensures linker64-env.sh is sourced in bash -c commands)
- `xdg-open`/browser-open interception (Android has no xdg-open)
- Go binary wrappers (gh, fzf, micro — Go's raw syscalls bypass termux-exec)
- Package manager overrides (apt/dpkg config path redirection)
- `make` wrapper (hardcoded SHELL= override)
- `.netrc` credential management
- Vendor symlink creation (arm64-android → arm64-linux)

---

## Part 5: Changes Made

### Branch: `fix/termux-exec-and-go-workarounds`

**4 files changed, +399/-372 lines (net reduction despite new features)**

#### Bootstrap.kt
1. Added `TERMUX_APP__LEGACY_DATA_DIR` to `buildRuntimeEnv()` — the one-line fix
2. Removed `scanBinDir()` and per-binary wrapper generation from `buildBashEnvSh()` (~100 lines of Kotlin generating ~800 lines of shell)
3. Added Go binary wrappers: `gh()`, `fzf()`, `micro()`
4. Slimmed exec-wrapper generation to targeted list (~17 binaries for shebang fallback)
5. Updated all comments to reflect new architecture

#### PtyBridge.kt
1. Stripped exec routing from WRAPPER_JS (-199 lines)
2. Removed `LINKER64` constant, `isEB()` → linker64 prepend, `resolveCmd()`, shell+EB splitting in `spawnFix()`
3. Kept all /tmp, shell, -l, BASH_ENV, browser-open patches

#### claude-wrapper.js (asset reference copy)
1. Complete rewrite matching the new WRAPPER_JS
2. Added architecture documentation header

#### KNOWN_ISSUES.md
1. Rewritten Issue #1: corrected root cause (Go raw syscalls, not "export -f invisible")
2. Reduced severity of Issue #2 (BASH_ENV overhead: 20-50ms → 5-10ms)
3. Added architecture table showing each layer's role
4. Added section on the TERMUX_APP__LEGACY_DATA_DIR fix

### Performance Impact

| Metric | Before | After |
|--------|--------|-------|
| `linker64-env.sh` size | ~994 lines / 77KB | ~150 lines / ~8KB |
| `BASH_ENV` source time per `bash -c` | 20-50ms | ~5-10ms |
| `claude-wrapper.js` WRAPPER_JS size | ~280 lines | ~80 lines |
| Exec-wrapper files generated | ~11 | ~17 (targeted for shebang fallback) |

---

## Testing Checklist

- [ ] Basic Claude Code startup and message sending
- [ ] Tool execution (Bash, Read, Write, Edit, Grep, Glob)
- [ ] `git clone` public repo
- [ ] `git clone` private repo (tests .netrc)
- [ ] `git push` to private repo
- [ ] `gh repo clone org/repo` (tests bash wrapper interception)
- [ ] `gh pr list`, `gh issue list` (tests passthrough to real binary)
- [ ] Python subprocess execution (tests termux-exec for C programs)
- [ ] Node.js child_process (tests stripped wrapper still works for /tmp, shell)
- [ ] `fzf --preview 'bat {}'` if Developer tier installed
- [ ] `micro` editor shell commands if Developer tier installed
- [ ] Session survival across app backgrounding
- [ ] Multiple concurrent sessions
- [ ] Hook relay events (tool cards, permission approval)

---

## Key Learnings

1. **Always verify assumptions empirically.** Initial maps tests gave false negatives due to race conditions. The claim "termux-exec doesn't load" was wrong; the claim "termux-exec doesn't work for our prefix" was right but for a different reason than assumed.

2. **Read the commit history before calling code redundant.** The layers were a justified response to a real failure, not ignorant duplication. The design doc explicitly acknowledged termux-exec's limitation.

3. **One environment variable can change everything.** `TERMUX_APP__LEGACY_DATA_DIR` was the difference between termux-exec working and not working. ~800 lines of shell wrapper generation existed because of this single missing configuration.

4. **Go's raw syscall design is a known, unsolved platform limitation.** The Go team rejected using libc execve in 2012. Termux documents it as an unsolved problem. The targeted bash wrappers are the practical answer.

5. **The Play Store Termux is a separate fork.** The official Termux avoids SELinux exec restrictions via `targetSdkVersion=28`. YouCoded and the Play Store fork both target modern SDKs and must use `system_linker_exec`.
