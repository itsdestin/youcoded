# Native Binary on Android — Session 2 Research Notes

**Date:** 2026-03-17
**Status:** Interpreter-mode loader compiled and deployed; argv passing issue blocks final test
**Prior session:** `docs/plans/native-binary-research (03-16-2026).md`

---

## Intention

Run Claude Code's **native installer binary** (222MB, Bun/JavaScriptCore, glibc-linked, aarch64 ET_EXEC) directly on Android, replacing the slower npm/Node.js wrapper currently used in the app.

## Three Fundamental Blockers

1. **SELinux blocks `execve()`** on `app_data_file` context
2. **Android's linker64 rejects `ET_EXEC`** — only accepts `ET_DYN` (PIE)
3. **No glibc on Android** — Android uses bionic libc

---

## Edits & Solutions Applied

### 1. TLS Alignment Fix (Path D — Binary Patching)

**Problem:** Even after patching `e_type` to ET_DYN, bionic's linker64 rejected the binary due to TLS alignment. `p_vaddr=0x69412D0` is only 16-byte aligned; bionic requires `p_align >= 64` AND `p_vaddr % p_align == 0`. No valid `p_align >= 64` satisfies this.

**Solution:** Relocated the 56-byte TLS init template within the binary:
- Found a 64-byte-aligned zero region at file offset `0x8fc0` (vaddr `0x208fc0`) inside LOAD segment 2
- Copied 56 bytes of TLS init data from `0x67212d0` to `0x8fc0`
- Patched PT_TLS header: `p_offset=0x8fc0`, `p_vaddr=0x208fc0`, `p_paddr=0x208fc0`, `p_align=64`
- Patched `e_type` from `ET_EXEC(2)` to `ET_DYN(3)`

**Result:** Bionic's linker64 now **accepts and loads** the binary. All glibc symbols resolve correctly. But crashes in glibc's `__libc_start_main` because bionic's linker can't properly initialize glibc's runtime (TLS model incompatible, `_rtld_global` uninitialized, etc.).

**Files:** `native/claude-native-patched` on device, patch script `patch.sh`

### 2. glibc ld-linux PT_PHDR Patch

**Problem:** Running `linker64 ld-linux-aarch64.so.1 <program>` fails with "Could not find a PHDR: broken executable?" — bionic's linker64 requires PT_PHDR in the program headers, but glibc's ld-linux doesn't include one.

**Solution:** Replaced ld-linux's NOTE segment (seg 3, offset `0xe8`) with a PT_PHDR entry describing the phdr table itself.

**Result:** Bionic accepts ld-linux. But ld-linux segfaults because bionic already relocated it (double-relocation corrupts GOT pointers).

**Files:** `ld-linux-patched.so.1` on device

### 3. glibc-loader (Bionic Launcher — Path B)

**Problem:** Need to load ld-linux WITHOUT relocation (like the kernel does), so ld-linux can self-bootstrap correctly.

**Solution:** Wrote `native/glibc-loader.c` — a static-PIE musl binary (~950KB) that:
- Is loaded by bionic's linker64 (ET_DYN, no glibc dependencies)
- Manually `mmap()`s ld-linux's LOAD segments from file (no relocation)
- Constructs proper auxv (AT_PHDR, AT_BASE, AT_ENTRY, AT_RANDOM, etc.)
- Jumps to ld-linux's entry point via assembly

**Result:** ld-linux bootstraps and runs! `--help` output works perfectly.

**Files:** `native/glibc-loader.c`, compiled binary on device

### 4. ld-linux Assertion Patch

**Problem:** In "invoked as command" mode (ld-linux opens the program from argv), an assertion fires: `l->l_prev == NULL || (mode & __RTLD_AUDIT) != 0` at `dl-load.c:1201`.

**Solution:** Binary-patched ld-linux at offset `0x6f00`: changed `cbz x0, #0x6b00` to `b #0x6b00` (unconditional skip of assertion).

**Result:** ld-linux gets past the assertion and tries to load the target binary. Fails with "failed to map segment from shared object" — likely `mmap(PROT_EXEC)` on the file, or ET_EXEC fixed-address conflict.

**Files:** `ld-linux-patched2.so.1` on device

### 5. Interpreter Mode Loader (v2)

**Problem:** "Command mode" has state corruption issues. Need "interpreter mode" where the loader maps BOTH ld-linux AND the program, then ld-linux just does relocation.

**Solution:** Rewrote `glibc-loader.c` to map both binaries and set up auxv in interpreter mode (AT_PHDR → program's phdrs, AT_BASE → ld-linux's bias).

**Current Status:** Compiled and deployed but hitting argv passing issues (`run-as` strips arguments). The actual loader logic is untested.

---

## Current Status

| Component | Status |
|-----------|--------|
| Claude binary e_type patch | Working — bionic loads it |
| Claude binary TLS relocation | Working — bionic accepts alignment |
| glibc libs on device | Deployed (2.7MB total) |
| glibc-loader (musl static PIE) | Compiled, deploys, runs on Android |
| ld-linux bootstrap via loader | Working (`--help` prints correctly) |
| ld-linux loading a program | **Blocked** — "failed to map segment" in command mode |
| Interpreter mode loader (v2) | **Untested** — argv passing issue with `run-as` |
| execve interceptor (`libexec-intercept.so`) | Compiled, deployed, untested |

## Errors Encountered

- `adb server version mismatch` (×3) — killed/restarted adb, required phone re-authorization
- LIEF can't parse Linux ELF on Windows — used manual struct parsing instead
- `run-as` heredocs fail with "can't create temporary file" — used pipe instead
- `run-as` + `sh -c` drops arguments after the first quoted block — need wrapper scripts
- Shell escaping issues with `printf '\x..'` through multiple shell layers — wrote patch scripts to device first

## Key Technical Findings

1. **TLS relocations are TP-relative on aarch64** — changing PT_TLS `p_vaddr` only affects where the loader reads the init template, NOT runtime TLS access. This makes TLS relocation safe.

2. **bionic's "Could not find a PHDR" is from linker64, not ld-linux** — glibc's ld-linux simply doesn't include a PT_PHDR segment. Adding one fixes the error.

3. **Double-relocation is the core issue** — bionic's linker64 relocates ld-linux as a shared library, then ld-linux tries to self-relocate during bootstrap → GOT corruption → segfault. The glibc-loader solves this by mmap'ing ld-linux without relocation.

4. **glibc's "invoked as command" mode has assertion issues** — the `l->l_prev` assertion in `_dl_map_object_from_fd` fires because the link_map state is subtly wrong after bootstrap. Patching the assertion leads to "failed to map segment" errors.

5. **Interpreter mode is the correct approach** — loader maps both binaries (ld-linux + program), sets AT_PHDR → program, AT_BASE → ld-linux bias, then ld-linux handles relocation and dependency loading without needing to open/map files itself.

## Files Created This Session

```
native/glibc-loader.c           — bionic launcher (interpreter mode, v2)
native/glibc-loader              — compiled static-PIE musl aarch64 binary (950KB)
native/hello-glibc.c             — test glibc program
native/hello-glibc               — compiled PIE glibc test binary
native/ldlinux-head.b64          — base64-encoded ld-linux for analysis
native/ldlinux-head.bin          — raw ld-linux binary (204KB)
```

On device (`~/.claude-mobile/`):
```
glibc-loader                     — deployed launcher
hello-glibc                      — deployed test binary
glibc/ld-linux-patched.so.1      — PT_PHDR patch only
glibc/ld-linux-patched2.so.1     — PT_PHDR + assertion skip
claude-native-patched            — ET_DYN + TLS relocation
run-loader.sh                    — wrapper script (argv issue)
patch.sh                         — native binary patcher
patch-ldlinux.sh                 — ld-linux patcher
patch-assert.sh                  — assertion patcher
```

## Next Steps

1. **Fix argv passing** in `run-loader.sh` (the `"$@"` isn't expanding through `run-as`)
2. **Test interpreter-mode loader** with `hello-glibc` — this is the critical test
3. If hello-glibc works, test with full Claude native binary (may need the e_type+TLS patched version since ld-linux would need to handle ET_EXEC at fixed addresses vs ET_DYN)
4. If all works, integrate into the app's launch flow (replace `claude-wrapper.js` with `glibc-loader` chain)
