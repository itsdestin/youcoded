# Known Issues & Planned Updates

Tracked limitations in the DestinCode Android runtime that cannot be fully resolved with current architecture. Each entry includes context on why it exists, its user-visible impact, and the planned mitigation or fix direction.

---

## Active Known Issues

### 1. `export -f` bash functions invisible to non-bash processes

**Status:** Mitigated, not fully resolved
**Severity:** Medium — affects edge cases in tool execution

**Problem:** The linker64 SELinux bypass relies on bash shell functions (generated in `linker64-env.sh`) that wrap every binary through `/system/bin/linker64`. These functions are propagated to subshells via `export -f`, which is a bash-only feature. Any process that isn't bash — including `#!/system/bin/sh` scripts, Go programs calling `exec()`, Rust `Command::new()`, and Python `subprocess.run()` — cannot see or use these functions. When such a process tries to execute a binary directly, SELinux blocks it.

**Current mitigation:** `exec-wrappers/` directory (added in commit `dbf9310`) contains real shell scripts (`#!/system/bin/sh`) for ~11 commonly-exec'd binaries (`git`, `ssh`, `node`, `rclone`, `python3`, etc.) that Go/Rust programs find via `PATH` before the raw ELF binaries. Additionally, `termux-exec` `LD_PRELOAD` library intercepts `execve()` in C-linked programs (but not Go, which uses raw syscalls).

**Gap:** Only ~11 of hundreds of binaries have script wrappers. If a Go/Rust/Python program tries to exec an unwrapped binary (e.g., `tar`, `gzip`, `less`, `file`), it will fail with "permission denied". Adding every binary to exec-wrappers would work but creates maintenance burden and startup cost.

**Planned fix direction:**
- Option A: Generate script wrappers for ALL ELF binaries in `$PREFIX/bin/` during `deployBashEnv()`, not just the curated list. Place in `exec-wrappers/` which is already on PATH before `$PREFIX/bin`. Cost: ~200 small files, <1ms each to create at startup.
- Option B: Investigate Android-specific `seccomp` or `prctl` approaches that could allow direct exec from the app data directory without linker64.
- Option C: Build a native `LD_PRELOAD` library specifically for Go programs that intercepts the raw `execve` syscall via `ptrace` or `seccomp-bpf` user notification.

---

### 2. 77KB `linker64-env.sh` sourced on every `bash -c` invocation

**Status:** Low priority — functional but adds latency
**Severity:** Low — adds ~20-50ms to each short-lived bash command

**Problem:** Every `bash -c "..."` command spawned by Claude Code sources the full `linker64-env.sh` via `BASH_ENV` (or `injectEnv()` prepending `. "$BASH_ENV_FILE";` to the command). This ~994-line, 77KB script defines wrapper functions for every binary, `__fix_tmp()`, package manager overrides, and `export -f` calls. For frequent short commands (e.g., `echo test`, `cat file`), the sourcing overhead is measurable.

**Current behavior:** Claude Code spawns many `bash -c` subprocesses for tool execution. Each one pays the BASH_ENV sourcing cost. Profiling shows ~20-50ms overhead per invocation on typical Android hardware.

**Planned fix direction:**
- Lazy loading: split `linker64-env.sh` into a minimal bootstrap (~10 lines) that defines `command_not_found_handle()` or a PATH-based autoloader. Full function definitions are only loaded when a wrapped binary is actually invoked.
- Alternatively: rely entirely on script-based exec-wrappers (see issue #1) and remove the function-based approach, eliminating BASH_ENV sourcing entirely.

---

### 3. seccomp sandbox binaries missing for `arm64-android`

**Status:** Not fixable without custom build
**Severity:** Low — reduces security hardening, no functional impact

**Problem:** Claude Code sandboxes tool execution using seccomp-BPF filters applied via a vendored `apply-seccomp` binary and `unix-block.bpf` filter. These are shipped for standard platforms (`arm64-darwin`, `arm64-linux`, `x64-*`) but not `arm64-android`. Without them, Claude Code's tool sandbox runs without seccomp restrictions — tools have full syscall access.

**User impact:** No functional difference — tools work identically. The security boundary is weaker: a malicious tool execution could make syscalls that would normally be blocked (e.g., network access from a sandboxed context, raw file I/O outside the working directory).

**Why it can't be auto-fixed:** The `arm64-linux` seccomp binary cannot be symlinked like ripgrep or tree-sitter because:
- Android's seccomp implementation differs from desktop Linux (different kernel config, different default policies)
- The BPF filter may reference syscall numbers that differ between Android and desktop Linux kernels
- `apply-seccomp` may use `prctl(PR_SET_SECCOMP)` which requires specific kernel capabilities that Android app processes don't have

**Planned fix direction:**
- Build a custom `apply-seccomp` binary targeting Android's bionic libc and arm64 syscall table
- Test against Android kernel seccomp support (available since Android 8.0/API 26)
- May need to use `seccomp-bpf` user notification mode instead of strict filtering, since Android app sandbox restricts `prctl` capabilities

---

## Recently Fixed (reference)

These were identified and fixed in the same audit session. Listed here for context on the class of issues this codebase is prone to.

| Commit | Fix | Root Cause |
|--------|-----|------------|
| `50fd5e9` | `fixTmpInShellCmd` regex double-prefix | Regex `/\/tmp\b/g` matched `/tmp` inside already-correct `$HOME/tmp` paths |
| `dbf9310` | exec-wrappers for Go programs | Go bypasses `LD_PRELOAD`, so `gh` couldn't exec `git` |
| `dbf9310` | ripgrep vendor symlink | Claude Code Grep/Glob expect `vendor/ripgrep/arm64-android/rg` |
| `1145ea1` | TMPDIR → `.cache/tmpdir` | Termux Node.js binary has compiled-in `/tmp` rewriting |
| `1145ea1` | tree-sitter-bash vendor symlink | Missing arm64-android variant; arm64-linux is ABI-compatible |
| `1145ea1` | `isEB()`/`fixPath()` symlink mismatch | `/data/user/0/` vs `/data/data/` caused path matching failures |
| `1145ea1` | ripgrep moved to core packages | Was DEVELOPER-tier only; Claude Code's core tools depend on it |
