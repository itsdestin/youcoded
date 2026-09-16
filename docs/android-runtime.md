---
origin: youcoded-dev@1f60c2a:docs/android-runtime.md
---

> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rule in youcoded-dev/.claude/rules/android-runtime.md is the terse always-injected layer; this doc is the depth.

# Android Runtime

The Android app runs Claude Code (a Node.js CLI) inside a Termux-derived environment. Several non-obvious constraints apply.

## System Fundamentals

### `LD_LIBRARY_PATH` is mandatory
The app relocates Termux binaries from `/data/data/com.termux/files/usr` to `context.filesDir/usr`, so `DT_RUNPATH` baked into binaries is stale. `LD_LIBRARY_PATH` overrides it. Set in `Bootstrap.buildRuntimeEnv()`. **Do not remove.**

### All binaries route through `/system/bin/linker64`
SELinux W^X bypass (Android 10+). Three layers, each with a distinct role:

1. **LD_PRELOAD (`libtermux-exec-ld-preload.so`)** — intercepts `execve()` in C/Rust programs, routes through linker64
2. **`claude-wrapper.js`** — NOT exec routing. Handles /tmp rewriting, fs.accessSync bypass, shell path fixing, BASH_ENV injection
3. **`linker64-env.sh`** — bash function wrappers for Go binaries (gh, fzf, micro) that bypass LD_PRELOAD

**Use the linker variant of termux-exec.** Bootstrap.kt copies `libtermux-exec-linker-ld-preload.so` over `libtermux-exec-ld-preload.so` after installing `termux-exec`.

### No `/tmp`
Use `$HOME/.cache/tmpdir` via `TMPDIR` and `CLAUDE_CODE_TMPDIR`. The specific path (`$HOME/.cache/tmpdir`, not `$HOME/tmp`) avoids Termux Node.js's compiled-in `/tmp` rewriting from double-applying.

### No glibc
Bionic only. The `native/execve-interceptor.c` research artifact was deleted in `e94154b3` (never deployed).

### Go binaries can't exec scripts in `~/.claude-mobile/`
The `linker64-env.sh` bash wrappers only cover binaries YOU invoke from bash. They do NOT protect a Go binary's OWN `fork/exec` calls: Go issues a raw `SYS_execve` syscall that bypasses termux-exec's LD_PRELOAD intercept (the shim only patches libc `execve`). So any script under `~/.claude-mobile/*` (e.g. an `xdg-open`/`open` shim on PATH, or a helper script) exec'd by a Go child fails with `EACCES` at fork/exec. Hit in the wild by rclone's Google Drive OAuth auto-browser-open — fixed in youcoded `6469e058` (`authGdriveWithBrowserIntent` streams stderr and opens the URL via `PlatformBridge.openUrl` / `Intent.ACTION_VIEW`). Two safe paths for any future Go integration: (1) spawn the Go process FROM bash with the linker64 wrappers so only the Go binary itself runs, and (2) route any URL-open / native UI through `PlatformBridge` or a `CompletableDeferred` native-UI bridge — never a `~/.claude-mobile/` shim. Reference implementation: the rclone fix, `authGdriveWithBrowserIntent` in `SyncService.kt` (called from `SessionService.kt`).

## Canonical sources

- `claude-wrapper.js` — canonical at `app/src/main/assets/claude-wrapper.js`. Deployed at every PTY start (inline in `PtyBridge.start()` at `PtyBridge.kt:129-132` — reads the asset and writes it to `$HOME/.claude-mobile/claude-wrapper.js` before each launch). There is no separate `Bootstrap.deployWrapperJs()` method. **Edit the asset file directly.**

## Vendored Termux terminal-emulator

Android depends on a **vendored copy** of Termux's `terminal-emulator` at `youcoded/terminal-emulator-vendored/` (Maven coordinate would be `com.github.termux.termux-app:terminal-emulator:v0.118.1`, but we build it locally). The vendor drop is patched to expose a `RawByteListener` on `TerminalEmulator.append()` — used by `PtyBridge.rawByteFlow` and broadcast as `pty:raw-bytes` WebSocket push events for the React xterm renderer.

Source of truth for the origin tag and patch shape: `terminal-emulator-vendored/VENDORED.md`. Never edit this module outside the documented patch.

The vendored emulator is **headless** as of Tier 2. The native Termux `TerminalView` UI was removed from `ChatScreen.kt` and the `terminal-view:v0.118.1` Maven dependency dropped. `TerminalSession` still owns the PTY fork + JNI waitpid loop + emulator processing; only the rendering layer changed.

## Terminal rendering (Tier 2)

Terminal rendering on Android happens in xterm.js inside the WebView, not in a native Termux `TerminalView`. The pipeline:

1. `PtyBridge` runs the PTY in `TerminalSession` (vendored emulator). Bytes from `pty.read()` reach `TerminalEmulator.append()`.
2. The `RawByteListener` patch fires on the terminal thread before the emulator processes the bytes. `PtyBridge.rawByteFlow` (a `MutableSharedFlow` with `tryEmit`) carries them.
3. `SessionService.launchRawByteBroadcast` collects from `rawByteFlow`, batches at ~16ms / 8KB, base64-encodes, and broadcasts `pty:raw-bytes` over the WebSocket.
4. In React, `remote-shim.ts` dispatches per-session events. `usePtyRawBytes` (`desktop/src/renderer/hooks/usePtyRawBytes.ts`) decodes base64 → `Uint8Array` and feeds `terminal.write()` on xterm.
5. xterm renders to canvas in the WebView. The React `TerminalView` component (`desktop/src/renderer/components/TerminalView.tsx`) is the same component desktop uses — the touch-platform branch sets `disableStdin: true`, skips `terminal.onData`, swaps to `usePtyRawBytes`, uses 12px font, and registers a one-finger touch-scroll handler.

Typing on touch flows through `InputBar` minimal-mode `<textarea>` → `sendInput(text + '\r')`, NOT through xterm's hidden textarea (which is suppressed by `disableStdin`). Special keys (Esc, Tab, Ctrl, ←/→, ↑/↓ scroll buttons) come from `TerminalToolbar` and `TerminalScrollButtons`.

The `layoutInsets` SharedFlow, its `LayoutInsets` data class and the React `layout-update` sender were deleted on 2026-09-10 (youcoded#468); `screenMode` and `viewModeRequest` were removed 2026-07-22 (`ChatScreen.kt:17,21` records it). Nothing native reads the chat's chrome geometry any more.

## Shared runtime environment

Runtime fixes MUST work in both `PtyBridge` and `DirectShellBridge`. Both share:
- `Bootstrap.buildRuntimeEnv()` (PtyBridge.kt:115, DirectShellBridge.kt:43)
- `Bootstrap.deployBashEnv()` (PtyBridge.kt:140, DirectShellBridge.kt:49)

## Reactivity

**Do not poll `isRunning`.** Use the reactive `sessionFinished` `StateFlow` (fed by a JNI `waitpid()` thread).

## Native UI Bridge Pattern (Deferred)

When an IPC handler needs native Android UI (file picker, folder picker, QR scanner):

1. `SessionService` creates a `CompletableDeferred<T>` and stores it (e.g., `pendingFolderPicker`)
2. `SessionService` calls a callback (e.g., `onFolderPickerRequested`) to notify the Activity
3. `MainActivity` shows the native UI (Compose dialog or `ActivityResultContract`)
4. On result, `MainActivity` calls `deferred.complete(result)`
5. `SessionService` awaits the deferred and sends the response back via WebSocket

Used by: `dialog:open-file`, `dialog:open-folder`, `android:scan-qr`.

## Key Files

| File | Purpose |
|------|---------|
| `app/.../ui/WebViewHost.kt` | Hosts React UI in WebView, loads bundled web assets |
| `app/.../bridge/LocalBridgeServer.kt` | WebSocket server on :9901, bridges React IPC to Kotlin |
| `app/.../bridge/PlatformBridge.kt` | Android-native operations (file picker, clipboard, URLs) |
| `app/.../runtime/Bootstrap.kt` | Package management, environment setup, shell function generation |
| `app/.../runtime/SessionService.kt` | Main IPC dispatcher — ~200 `"ns:verb" ->` branches |
| `app/.../runtime/PtyBridge.kt` | Claude Code terminal session (PTY + event bridge) |
| `app/.../runtime/DirectShellBridge.kt` | Standalone bash shell session |
| `app/.../runtime/ManagedSession.kt` | Session lifecycle, status, approval flow, prompt detection |
| `app/.../runtime/SessionRegistry.kt` | Multi-session management |
| `app/.../assets/claude-wrapper.js` | Node.js monkey-patch (CANONICAL SOURCE) |
| `app/.../assets/hook-relay.js` | Unix socket event relay for structured hook events |
| `app/.../skills/LocalSkillProvider.kt` | Skill marketplace backend |
| `app/.../skills/PluginInstaller.kt` | Installs Claude Code plugins via git clone/copy |
| `app/.../ui/TierPickerScreen.kt` | First-run package tier selection (Compose) |
| `app/.../ui/SetupScreen.kt` | Bootstrap progress display (Compose) |
| `app/.../ui/FolderPickerDialog.kt` | Native folder browser (Compose) |

## PITFALLS-triage additions (2026-07-15)

### Exec permissions & GitHub auth

- **`~/.claude-mobile/exec-wrappers/*` must be chmod 0755, not 0700.** Java's default `File.setExecutable(true)` gives 0700 under Android's 0077 umask. Those wrappers are exec'd by subprocesses spawned from Go binaries (notably `gh` spawning `git` during `gh auth setup-git`). At 0700 the shebang interpretation path via `/system/bin/sh` fails with EACCES even though the child runs as the same app uid — shebang exec is stricter than a direct `linker64` invocation. Fix: `setReadable(true, false)` + `setExecutable(true, false)` in `Bootstrap.deployBashEnv()`. Wider perms stay inside the uid-isolated app sandbox (`/data/data/<pkg>/`) so nothing new is exposed. Don't "tighten" back to 0700.
- **Git HTTPS auth uses `~/.netrc`, NOT `gh auth setup-git`.** Go's raw-syscall exec breaks `gh auth setup-git` on Android (it configures git's credential-helper subsystem, which re-spawns processes that can't traverse the exec-wrapper path). Instead the OAuth token from `~/.config/gh/hosts.yml` is mirrored into `~/.netrc` as `machine github.com login x-access-token password <token>` (mode 0600). libcurl reads `.netrc` natively, so `git push` over HTTPS needs no credential-helper exec. Two keepers: `Bootstrap.syncGhTokenToNetrc()` during first-run `Bootstrap.setup()` (skipped on already-bootstrapped installs), and the `gh` bash wrapper's `_youcoded_sync_gh_netrc` post-hook after any `gh auth login/logout/refresh/token/switch`. Add any new gh-auth-changing command to the post-hook's case list. Do NOT reintroduce `gh auth setup-git` anywhere — it fails silently or with EACCES.
- **`gh auth login --web` polling is flaky — retry once** if it dies with "error connecting to github.com". The device-flow long-poll Go HTTP call sometimes errors mid-poll on Android even when `curl` to github.com works (most likely Go's HTTP/2 client on Android's network stack, not YouCoded's runtime; ~1-of-3 success in the wild). Treat it as a known transient; don't paper over with a retry wrapper in `gh()` (would double-prompt with a new device code). If it worsens, consider `GODEBUG=http2client=0` to force HTTP/1.1 polling.

### Build-type parity (R8 minification)

Debug and release Android builds are NOT equivalent. The release flavor enables R8 minification (`isMinifyEnabled = true`); debug skips it. Anything that depends on R8-stable behavior works in `assembleDebug` and silently breaks in `assembleRelease`.

- **Don't use string-based reflection against your own code** — `getMethod("name")`, `getDeclaredMethod`, `Class.forName`, `KClass`, `KFunction`, `::class.declaredMembers`. R8 obfuscates the target's name and the lookup throws. The `PluginInstaller.buildEnv()` bug (commit `912f5ca7`, 2026-04-30) was exactly this: `bootstrap.javaClass.getMethod("buildRuntimeEnv")` returned NoSuchMethodException in release, the silent `try/catch` fallback shipped a stripped env without `LD_PRELOAD`, and every marketplace install died with `cannot exec 'remote-https': Permission denied`. Shipped from 2026-03-25 (`e18ab861`, R8 first enabled) through v1.2.2 because every dev/CI build was debug.
- **Direct calls always; reflection only when unavoidable.** When unavoidable (third-party libs, generic IPC), add an explicit `-keep` rule in `app/proguard-rules.pro` for the targeted class/methods. Don't rely on `try { reflection } catch { fallback }` — silent fallbacks mask R8-induced failures.
- **`Bootstrap` has a defensive `-keep` rule** so future code that re-introduces reflection against it can't silently break. Negligible APK cost for one class. Don't remove it without an audit confirming nothing reflects against `Bootstrap`.
- **`./gradlew :app:assembleReleaseTest` is the parity check** — same R8/shrinker/proguard config as production release, signed with the debug keystore, installs side-by-side as `com.youcoded.app.releasetest` ("YouCoded ReleaseTest", bridge port 9961). Runs automatically on every push via `android-ci.yml` and on demand via `android-test-build.yml`. Run it locally before tagging if you've touched reflection, annotation processing, or any symbol-name-dependent code.
- **Don't rely on the GitHub runner image for `node`.** Android workflows `setup-node@v7` explicitly so `bundleWebUi` (which shells to `npm` via `scripts/build-web-ui.sh`) doesn't depend on whatever ubuntu-latest ships.
