# Native Claude Code Binary on Android — Research Notes

**Date:** 2026-03-16
**Status:** Blocked on TLS alignment; two viable R&D paths identified
**Goal:** Run Claude Code's native installer binary (Bun-compiled, glibc-linked) on Android, replacing the npm-installed Node.js version for better performance and no "install native" nag.

---

## Background

Claude Code offers a "native installer" (`claude install`) that downloads a standalone binary. On desktop Linux, this binary runs directly. On Android, our app runs the npm-installed version through a Node.js wrapper (`claude-wrapper.js`) that monkey-patches `child_process` to route all subprocess exec calls through `/system/bin/linker64` (bypassing SELinux's execute permission denial on `app_data_file` context).

The user ran `claude install` in the Shell view. It downloaded successfully but the running Terminal view session still prompted for native install (the session was started before the install). The native binary can't actually run due to the issues documented below.

## The Native Binary

- **Location:** `~/.local/share/claude/versions/2.1.76` (symlinked from `~/.local/bin/claude`)
- **Size:** 222 MB
- **Type:** ELF 64-bit aarch64, `ET_EXEC` (statically positioned), dynamically linked against glibc
- **Runtime:** Bun (JavaScriptCore/WebKit) — confirmed via string scan (`Bun v`, `BUN_`, `webkit`)
- **Dependencies:** `ld-linux-aarch64.so.1`, `libc.so.6`, `libm.so.6`, `libpthread.so.0`, `libdl.so.2`, `librt.so.1` — all glibc components that don't exist on Android (bionic)

## Why It Can't Run Directly

1. **SELinux blocks `execve()`** on binaries in `app_data_file` context (our app's data directory)
2. **Android's `linker64` rejects `ET_EXEC`** — it only loads `ET_DYN` (PIE) binaries
3. **No glibc on Android** — Android uses bionic libc, not glibc

## What Already Transfers from the npm Setup

These components work with ANY runtime (not tied to Node.js):

| Component | Status | Notes |
|---|---|---|
| `linker64-env.sh` (BASH_ENV shell functions) | Ready | Pure bash — once bash is running, ALL binaries (git, node, etc.) work via shell functions |
| Environment variables | Ready | `CLAUDE_CODE_SHELL`, `PATH`, `TMPDIR`, SSL certs, etc. |
| `apt.conf` + package manager wrappers | Ready | Config files + shell functions |
| Hook relay (`hook-relay.js` + `EventBridge`) | Ready | Runs via embedded Node.js, independent of Claude Code's runtime |

## What Doesn't Transfer

| Component | Why | Needed Replacement |
|---|---|---|
| `claude-wrapper.js` | Monkey-patches Node.js `child_process`. Bun uses JavaScriptCore, different internals. | glibc `LD_PRELOAD` interceptor OR fix the binary loading issue so bionic handles exec |
| `termux-exec` LD_PRELOAD | Compiled against bionic; also has hardcoded Termux paths that don't work for our prefix | Same — need glibc version or eliminate the need |

## Experiments Performed

### Experiment 1: glibc Linker Chain

**Approach:** `linker64 → ld-linux-aarch64.so.1 → claude-native`

Android's linker64 loads the glibc dynamic linker (which IS `ET_DYN`/PIE), and glibc's linker in turn loads the `ET_EXEC` native binary.

**Setup:**
- Downloaded glibc 2.39 aarch64 from Ubuntu noble (`libc6_2.39-0ubuntu8_arm64.deb`)
- Extracted essential libs: `ld-linux-aarch64.so.1` (204KB), `libc.so.6` (1.7MB), `libm.so.6` (592KB), `libdl.so.2`, `libpthread.so.0`, `librt.so.1` — total 2.7MB
- Deployed to `~/.claude-mobile/glibc/` on device

**Command tested:**
```
/system/bin/linker64 $GLIBC/ld-linux-aarch64.so.1 --library-path $GLIBC $NATIVE --version
```

**Result:** `Could not find a PHDR: broken executable? Aborted`

**Root cause:** When bionic's linker64 loads glibc's `ld-linux-aarch64.so.1` as a shared library, it sets up the auxiliary vector (`AT_PHDR`) pointing to its own program headers, not glibc ld-linux's. Glibc's `_dl_start()` reads `AT_PHDR` to self-initialize and can't find its own segments → abort.

**Viable fix (not yet attempted):** Write a small bionic-compiled launcher that:
1. Uses `mmap()` to load `ld-linux-aarch64.so.1` into memory manually
2. Constructs a proper auxiliary vector with `AT_PHDR` pointing to ld-linux's actual program headers
3. Jumps to ld-linux's entry point with the correct auxv

### Experiment 2: ELF Header Patching (e_type ET_EXEC → ET_DYN)

**Approach:** Patch the native binary's ELF header to change `e_type` from `ET_EXEC (0x02)` to `ET_DYN (0x03)`, making linker64 accept it directly — no glibc linker chain needed.

**Patch 1 — e_type:**
- File offset `0x10`, change byte from `0x02` to `0x03`
- **Result:** linker64 accepted it! New error: `TLS segment is underaligned: alignment is 8 (skew 0), needs to be at least 64 for ARM64 Bionic`

**Patch 2 — PT_TLS p_align:**
- PT_TLS program header at file offset `0x158`
- `p_align` at file offset `0x188`, changed from `0x08` to `0x40` (8 → 64)
- **Result:** `TLS segment is underaligned: alignment is 64 (skew 16), needs to be at least 64 for ARM64 Bionic`

**Root cause:** Bionic requires `p_vaddr % p_align == 0` (zero skew). The PT_TLS segment's `p_vaddr = 0x069412D0`, which is only 16-byte aligned (largest power-of-2 divisor is 16). No `p_align >= 64` can satisfy the zero-skew constraint without relocating the TLS segment data — which requires relinking the binary.

**Key finding:** The e_type patch WORKS. linker64 accepts the binary as ET_DYN. The ONLY remaining blocker is TLS alignment, which is a Bun compiler choice (glibc default is 8-byte TLS alignment; bionic requires 64).

### Experiment 3: glibc LD_PRELOAD Interceptor (Compiled, Not Tested)

**Approach:** Write a glibc-compiled `LD_PRELOAD` library that intercepts `execve()` at the C library level and routes embedded binaries through linker64. This is the glibc equivalent of `termux-exec`.

**Implementation:** `native/execve-interceptor.c` — ~100 lines of C that:
- Intercepts `execve()` and `execvp()` via `dlsym(RTLD_NEXT, ...)`
- Checks if target path starts with `$PREFIX`
- If so, prepends `/system/bin/linker64` to argv
- For bash specifically: strips `-l` flag and injects BASH_ENV sourcing
- Uses static buffer for command injection (64KB)

**Compiled with Zig** (cross-compilation from Windows):
```
zig cc -target aarch64-linux-gnu -shared -fPIC -O2 -o libexec-intercept.so execve-interceptor.c -ldl
```
- Output: `native/libexec-intercept.so` — 14KB ELF 64-bit aarch64 shared library
- Deployed to `~/.claude-mobile/glibc/libexec-intercept.so` on device
- **Not yet tested** — requires the native binary to actually load first

## Files Created

```
native/execve-interceptor.c          — glibc LD_PRELOAD source (committed)
native/libexec-intercept.so          — compiled aarch64 glibc .so (14KB)
native/glibc-libs/                   — extracted Ubuntu glibc runtime (2.7MB)
native/glibc-root/                   — full Ubuntu libc6 extraction (can be deleted)
native/libc6-arm64.deb               — downloaded Ubuntu package (can be deleted)
```

On device (`~/.claude-mobile/glibc/`):
```
ld-linux-aarch64.so.1   — glibc dynamic linker (204KB)
libc.so.6               — glibc C library (1.7MB)
libm.so.6               — glibc math library (592KB)
libdl.so.2              — glibc dynamic loading (67KB)
libpthread.so.0         — glibc pthreads (67KB)
librt.so.1              — glibc realtime (68KB)
libexec-intercept.so    — our execve interceptor (14KB)
```

Also on device (`~/.claude-mobile/claude-native-patched`):
- The native binary with e_type=ET_DYN and p_align=64 patches applied (for testing)

## Compilation Environment

- **Zig 0.13.0** for Windows x86_64 — downloaded to `/tmp/zig-extract/`
- Zig bundles glibc headers for cross-compilation, no separate toolchain needed
- Compile command: `zig cc -target aarch64-linux-gnu -shared -fPIC -O2 -o libexec-intercept.so execve-interceptor.c -ldl`
- No WSL, Docker, or Android NDK required

## Two Viable R&D Paths Forward

### Path A: Custom Bionic Linker (Relax TLS Check)

Build a modified `linker64` from AOSP source that either:
- Lowers the TLS alignment requirement from 64 to 16 (or removes the check entirely)
- Auto-adjusts TLS alignment at load time by over-allocating and aligning the TLS block

**Pros:** One binary to maintain; fixes the problem at the root
**Cons:** Needs AOSP build setup; must be rebuilt for each Android version; deploying a custom linker is complex (can't replace `/system/bin/linker64`)

**Deployment approach:** Name it `linker64-glibc` and deploy to app directory. Use it instead of `/system/bin/linker64` specifically for the native binary. Since the custom linker itself would be ET_DYN (it's a shared library on Android), the system linker64 can load it.

Wait — linker64 is special. It's loaded by the kernel, not by itself. A custom linker deployed as a regular binary would need to be invoked via the real linker64. So the chain would be: `/system/bin/linker64 → custom-linker → native-binary`. The custom linker would essentially be a "loader" program that does what linker64 does but with relaxed checks.

**Estimated effort:** Medium-high. AOSP linker is ~10K lines of C++.

### Path B: Bionic Launcher for glibc ld-linux (Fix PHDR Issue)

Write a small (~200 line) bionic-compiled C program that:
1. `mmap()`s `ld-linux-aarch64.so.1` into memory at the correct address
2. Builds a proper auxiliary vector with `AT_PHDR` pointing to ld-linux's mapped program headers
3. Sets `AT_ENTRY` to the native binary's entry point
4. Sets `LD_LIBRARY_PATH` and `LD_PRELOAD` in the environment
5. Jumps to ld-linux's entry point

**Pros:** Small code; doesn't require AOSP; works with standard glibc
**Cons:** Fragile (depends on glibc ld-linux internals); must understand ELF loading in detail

**Key question:** Can we `mmap()` app_data_file with `PROT_EXEC`? If linker64 can (which it clearly does for node/bash), then our launcher running in the same process context should also be able to. Need to verify this isn't a linker64-specific SELinux exception.

**Estimated effort:** Medium. The ELF loading code is well-documented and there are reference implementations (musl's dynlink.c, for example).

### Path C (Bonus): Ask Anthropic to Compile with PIE + 64-byte TLS

If Anthropic compiled the native binary as `ET_DYN` (PIE) with `-Wl,-z,max-page-size=65536` and 64-byte TLS alignment, our e_type patch wouldn't be needed and the TLS issue vanishes. The binary would load directly through linker64 on Android with zero modifications.

This could be filed as a feature request: "Please compile native installer binaries as PIE with 64-byte TLS alignment for Android compatibility."

## Recommendation for Next Session

**Path B is the most promising.** The glibc libraries are already deployed on device, the interceptor .so is compiled, and the approach avoids modifying AOSP code. The launcher is a self-contained ~200-line C program that can be cross-compiled with Zig.

If Path B works, the full native launch chain would be:
```
/system/bin/linker64 → bionic-launcher → ld-linux-aarch64.so.1 → claude-native
                                          (with LD_PRELOAD=libexec-intercept.so)
```

And inside the native binary, when it spawns bash:
```
execve("/prefix/bin/bash", ...)
  → intercepted by libexec-intercept.so
  → execve("/system/bin/linker64", ["/prefix/bin/bash", ...])
  → bash sources BASH_ENV (linker64-env.sh)
  → all shell commands work via existing shell function wrappers
```

## Other Changes Made This Session

Unrelated to native binary research, this session also completed:
- **Priority 18:** Flipped up/down arrows in `TerminalKeyboardRow.kt` (← ↑ ↓ → order)
- **Priority 6:** Deleted 7 dead code files from parser era + empty `widgets/` directory
- **Terminal input unification:** Removed visible text input + Send button from Terminal/Shell modes; added invisible `BasicTextField` that forwards keystrokes to PTY in real time; tap terminal to open keyboard; unified Enter button
- Spec updated to v2.5 with all changes
