# Known Issues & Planned Updates

Tracked limitations in the DestinCode Android runtime that cannot be fully resolved with current architecture. Each entry includes context on why it exists, its user-visible impact, and the planned mitigation or fix direction.

---

## Active Known Issues

### 1. Go binaries cannot exec subprocesses (raw syscall bypass)

**Status:** Mitigated for gh/fzf/micro; general case remains
**Severity:** Medium — affects Go programs that spawn subprocesses

**Root cause:** Android SELinux denies `execve()` on files with the `app_data_file` label. The `termux-exec` v2.4 LD_PRELOAD library intercepts libc's `execve()` and routes through `/system/bin/linker64` — this works for all **C and Rust** programs (which use libc). However, **Go** programs use raw `SYS_execve` syscalls via hand-written assembly stubs (`syscall.forkExec`, `syscall.rawVforkSyscall`), completely bypassing LD_PRELOAD interception. Even with CGo enabled (Go programs link libc), `os/exec.Command` still uses raw syscalls.

**What works (via termux-exec):**
- C programs calling exec: git → git-remote-https, ssh → ssh-agent, python → subprocess, etc.
- Rust programs calling `Command::new()`: fd, bat, eza, ripgrep — all use libc execvp.
- Node.js child_process: termux-exec intercepts Node's libc exec calls.
- Bash functions: route through linker64 directly via BASH_ENV wrappers.

**What doesn't work:**
- Go programs calling `exec.Command()`: gh → git, fzf → $SHELL, micro → $SHELL.

**Affected binaries:** Only 4 Go binaries across all package tiers:
| Binary | Tier | Subprocess | Fix |
|--------|------|-----------|-----|
| `gh` | Core | git, ssh | Bash wrapper rewrites `gh repo clone` → `git clone`; `.netrc` for auth |
| `rclone` | Core | browser-open | Already handled by `claude-wrapper.js` URL interception |
| `fzf` | Developer | `$SHELL -c "cmd"` | Bash wrapper sets `SHELL=/system/bin/sh` (system binary Go can exec) |
| `micro` | Developer | `$SHELL`, linters | Bash wrapper sets `SHELL=/system/bin/sh` |

**How the fzf/micro SHELL fix works:** Setting `SHELL=/system/bin/sh` lets Go's raw `execve` succeed (system binary). `/system/bin/sh` finds commands via PATH → exec-wrappers. When sh can't directly exec a wrapper (SELinux), it falls back to reading the `#!/system/bin/sh` shebang and spawning a new sh to interpret the script — which then runs `exec /system/bin/linker64 ...`.

**Remaining gap:** If a new Go binary is added that execs subprocesses, it will need a custom bash wrapper. The long-term fix would be a ptrace-based or seccomp-BPF exec supervisor, but the current targeted approach covers all known cases.

---

### 2. BASH_ENV sourcing overhead per `bash -c` invocation

**Status:** Significantly reduced (was ~994 lines / 77KB, now ~150 lines)
**Severity:** Low — much reduced from previous 20-50ms overhead

**Problem:** Every `bash -c "..."` command spawned by Claude Code sources `linker64-env.sh` via `BASH_ENV`. Previously this was a ~994-line script defining wrapper functions for every binary. Now that termux-exec handles exec routing, the script only contains `/tmp` rewriting, package manager overrides, Go binary wrappers, and filesystem fixes.

**Current overhead:** ~5-10ms per `bash -c` invocation (down from 20-50ms).

---

### 3. seccomp sandbox binaries missing for `arm64-android`

**Status:** Not fixable without custom build
**Severity:** Low — reduces security hardening, no functional impact

**Problem:** Claude Code sandboxes tool execution using seccomp-BPF filters applied via a vendored `apply-seccomp` binary and `unix-block.bpf` filter. These are shipped for standard platforms (`arm64-darwin`, `arm64-linux`, `x64-*`) but not `arm64-android`. Without them, Claude Code's tool sandbox runs without seccomp restrictions — tools have full syscall access.

**User impact:** No functional difference — tools work identically. The security boundary is weaker: a malicious tool execution could make syscalls that would normally be blocked (e.g., network access from a sandboxed context, raw file I/O outside the working directory).

**Planned fix direction:**
- Build a custom `apply-seccomp` binary targeting Android's bionic libc and arm64 syscall table
- Test against Android kernel seccomp support (available since Android 8.0/API 26)
- May need to use `seccomp-bpf` user notification mode instead of strict filtering, since Android app sandbox restricts `prctl` capabilities

---

### 4. Stray `u` character at top-left of terminal on startup

**Status:** Not fixable without forking terminal emulator
**Severity:** Low — cosmetic only

**Problem:** Claude Code sends `\e[>1u` at startup to enable the Kitty progressive keyboard enhancement protocol. The Termux terminal emulator library (`v0.118.1`) does not recognize this CSI sequence. When it encounters the unhandled sequence, it discards the escape/CSI prefix but renders the trailing `u` as a literal visible character at the cursor position.

**User impact:** A stray `u` character appears at the top-left corner of the terminal when Claude Code starts. No functional impact — keyboard input and all other terminal features work normally.

**Planned fix direction:**
- Option A: Fork `com.github.termux.termux-app:terminal-emulator` and add a no-op handler for `CSI > Ps u` (Kitty keyboard protocol) sequences. Proper fix but adds dependency maintenance burden.
- Option B: Intercept PTY output before it reaches the emulator and strip `\e[>...u` sequences. Avoids forking but is fragile.
- Option C: Set an environment variable or terminal capability that tells Claude Code not to enable Kitty keyboard protocol (if such an option exists upstream).

---

## Architecture Notes

### Exec routing layers (current)

| Layer | Role | Handles |
|-------|------|---------|
| **termux-exec LD_PRELOAD** | Primary exec routing | All C/Rust program exec calls → linker64 |
| **claude-wrapper.js** | Node.js quirk patches | /tmp rewriting, fs.accessSync X_OK, shell path fixing, browser-open |
| **linker64-env.sh (BASH_ENV)** | Bash-level fixes | /tmp rewriting, Go wrappers (gh/fzf/micro), package managers, make |
| **exec-wrappers** | /system/bin/sh fallback | Shebang fallback for fzf/micro SHELL=/system/bin/sh |
| **.netrc** | Git HTTPS auth | Avoids credential helper exec chain |

### Key fix: TERMUX_APP__LEGACY_DATA_DIR

termux-exec v2.4 does a string prefix match to decide whether a binary is under the app data directory. `context.filesDir` resolves to `/data/user/0/...` but binary canonical paths resolve to `/data/data/...` (symlink). Setting `TERMUX_APP__LEGACY_DATA_DIR=/data/data/<pkg>/files` provides both path forms so the match succeeds.

---

## Recently Fixed (reference)

| Commit | Fix | Root Cause |
|--------|-----|------------|
| `50fd5e9` | `fixTmpInShellCmd` regex double-prefix | Regex `/\/tmp\b/g` matched `/tmp` inside already-correct `$HOME/tmp` paths |
| `dbf9310` | exec-wrappers for Go programs | Go bypasses `LD_PRELOAD`, so `gh` couldn't exec `git` |
| `dbf9310` | ripgrep vendor symlink | Claude Code Grep/Glob expect `vendor/ripgrep/arm64-android/rg` |
| `1145ea1` | TMPDIR → `.cache/tmpdir` | Termux Node.js binary has compiled-in `/tmp` rewriting |
| `1145ea1` | tree-sitter-bash vendor symlink | Missing arm64-android variant; arm64-linux is ABI-compatible |
| `1145ea1` | `isEB()`/`fixPath()` symlink mismatch | `/data/user/0/` vs `/data/data/` caused path matching failures |
| `1145ea1` | ripgrep moved to core packages | Was DEVELOPER-tier only; Claude Code's core tools depend on it |
