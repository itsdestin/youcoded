---
paths:
  - "app/**"
last_verified: 2026-04-20
---

# Android Runtime Rules

You are editing Android runtime code. Read `docs/android-runtime.md` in the youcoded-dev workspace (or the canonical copy at `~/youcoded-dev/docs/android-runtime.md`) for full context before making changes.

## Hard constraints — DO NOT violate

- **`LD_LIBRARY_PATH` is mandatory** in `Bootstrap.buildRuntimeEnv()`. Termux binaries are relocated; DT_RUNPATH is stale.
- **All exec routes through `/system/bin/linker64`** for SELinux W^X bypass. Three layers with distinct roles:
  - LD_PRELOAD (termux-exec) for C/Rust
  - claude-wrapper.js for /tmp rewriting, fs patches, BASH_ENV injection (NOT exec routing)
  - linker64-env.sh for Go binaries (gh, fzf, micro)
- **`TMPDIR` = `$HOME/.cache/tmpdir`** (NOT `$HOME/tmp` — that path triggers Node.js's compiled-in rewriting)
- **Use the LINKER variant of termux-exec**: `libtermux-exec-linker-ld-preload.so` copied over primary
- **No glibc** — Bionic only. (Earlier glibc-loader / execve-interceptor research is preserved in git history; no deployed native code.)

## Shared env across bridges

Runtime fixes must work in both `PtyBridge` (PTY session) and `DirectShellBridge` (standalone bash). Both share `Bootstrap.buildRuntimeEnv()` and `Bootstrap.deployBashEnv()` — fix once, applies to both. Check both files after any env change.

**PTY writes are NOT symmetric across both bridges.** `PtyBridge.writeInput` implements a 600 ms split-before-Enter workaround for Ink's 500 ms `PASTE_TIMEOUT` (see `docs/PITFALLS.md → PTY Writes`). `DirectShellBridge.writeInput` does NOT adopt this split because it talks to raw bash, not Claude Code's Ink UI. Do not "parity fix" this — bash has no paste-mode timing.

## Reactivity

**Do not poll `isRunning`.** Use the `sessionFinished: StateFlow<Boolean>` in `PtyBridge`/`DirectShellBridge`, fed by the JNI `waitpid()` thread.

## Canonical sources

- `claude-wrapper.js` at `app/src/main/assets/claude-wrapper.js` — edit this file, not any deployed copy
- Deployed to `~/.claude-mobile/claude-wrapper.js` by `Bootstrap.deployWrapperJs()` at every launch

## Per-turn transcript metadata (Android parity)

`TranscriptEvent.TurnComplete` carries `stopReason`, `model`, `usage`, and `anthropicRequestId` to match desktop's transcript-watcher output. If you modify `TranscriptWatcher.parseAssistantLine` or `TranscriptSerializer.turnComplete`, preserve these fields — remote clients depend on them for the per-turn metadata strip, StopReasonFooter, AttentionBanner Request ID readout, and sessionModels reconciliation.

## Native UI Bridge Pattern (Deferred)

When an IPC handler needs native Android UI: SessionService creates a `CompletableDeferred<T>`, calls an Activity callback, MainActivity shows the UI, result calls `deferred.complete()`, SessionService awaits and responds. Used by `dialog:open-file`, `dialog:open-folder`, `android:scan-qr`.
