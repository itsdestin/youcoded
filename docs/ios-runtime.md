# iPhone runtime

How the iPhone app runs YouCoded. It is the Android app's design carried to a second phone system: the phone
runs **the desktop's own backend**, headless, and shows **the desktop's own page**; the Swift code is a thin
shell. Read [Android runtime](android-runtime.md) first — this page is mostly the differences.

Status: built on `session/89-iphone-app` (card #89). Started for real in an iPhone simulator by CI
(`.github/workflows/ios-ci.yml`); not yet run on a physical iPhone.

## Shape

```
iPhone app (one .app)
├─ Swift shell  ios/YouCoded/
│   AppDelegate / RootViewController  the one screen: "starting…", then the page; or "couldn't start"
│   BackendRunner       starts Node IN THIS PROCESS (nodejs-mobile), hands it its keys, watches for "ready"
│   AppWebView          WKWebView on youcoded-app://app/index.html?bridgeToken=…&bridgePort=… (files served by a
│                       WKURLSchemeHandler from the app bundle; theme-asset:// served the same way)
│   HostJsBridge        window.YouCodedHost: the page's phone-only calls (voice, saved computers, QR, attach, version)
│   HostSocketServer    the backend's calls to the phone (open a link, keep awake, notify, status)
│   UrlPolicy           which links load / download / leave the app; the Tailscale-only rule for plain http
│   VoiceRecognizer, QrScannerViewController, Notifier, AttachmentStore, SecretKeyStore, SignInLinks
├─ WKWebView: the shared React page, remote-shim in "android-local" mode → ws://localhost:<port>, token sign-in
└─ Node 18 (nodejs-mobile, a library): backend/dist/main/headless/ios-main.js — the desktop backend as ONE bundle
```

## What iOS forbids, and the answer to each

| iOS rule | Answer |
|---|---|
| An app may not start any other program (no fork/exec at all) | Node runs as a library inside the app (`node_start` on its own thread, `BackendRunner.swift`). Everything that IS "start a program" does not exist on an iPhone: Claude Code, the terminal, the real git, a computer's shell, ripgrep, local models. (The assistant's `Bash` tool still works: it runs a shell that is part of the app — see "The built-in command line".) One question answers it everywhere: `canRunPrograms()` (backend, `headless/host-bridge.ts`) and `capabilities.programs` (page, `shared/capabilities.ts`). |
| No runtime code generation (no JIT) | nodejs-mobile is built with V8's JIT off. A JIT-less V8 has **no WebAssembly**, so Node 18's built-in `fetch` cannot work (its HTTP parser is WebAssembly): `headless/ios-fetch.ts` is `fetch` rebuilt on `http`/`https`. |
| The only Node for iOS is nodejs-mobile's Node 18, built without ICU | `headless/ios-compat.ts` fills what the backend uses and Node 18 lacks (`globalThis.crypto`, `File`, `AbortSignal.any`, `toSorted`, `Object.groupBy`, …). No ICU means V8 rejects `\p{…}` in regular expressions, so the build bakes the needed Unicode tables in (below). |
| Node 18 cannot `require()` an ES module; an app is a signed, read-only bundle | The backend ships as one esbuild bundle per entry (`ios/runtime/build-backend.mjs`), not Android's tree of ~17,000 files. |
| Node can be started once per process, and `exit()` ends the whole app | No "restart the backend": a stopped backend shows "close and reopen YouCoded". `process.exit` is replaced inside the app (`installInProcessGuards`): it prints `YOUCODED_HEADLESS_EXIT`, which the shell shows as that screen, and holds the thread. |
| An app may only write inside Documents, Library and tmp | `HOME` is the app's Documents folder (also what the Files app shows as "On My iPhone › YouCoded"); `userData` is under Application Support. `AppPaths.swift`. |
| No abstract sockets; a socket file's path must fit 104 bytes | The backend calls the app over a loopback TCP port (`YOUCODED_HOST_SOCKET=tcp:<port>`), opening with a per-run token (`YOUCODED_HOST_TOKEN`), because other apps can reach loopback ports. |
| A page can only be served from the app through a private scheme | `youcoded-app://app/…` (`IOS_PAGE_ORIGIN` in `shared/android-page-origin.ts`; must match `AppWebView.swift`). The backend's origin check allows it (`remote-origin.ts`). |
| Background apps are suspended within seconds | The big one, and only partly answered — see "Background" below. |
| Unsigned apps cannot use the Keychain | Even simulator builds are signed "to run locally" (identity `-`); see the workflow. |

## The page thinks it is "the phone app"

`renderer/android-page.ts` → `isAndroidAppPage()` answers true on the iPhone page too, so `__PLATFORM__` is
`'android'` there and every look-and-feel rule written for the Android app applies. That name means "the phone
app's own page"; it was kept because renaming ~40 call sites would collide with every branch in flight. The few
real differences ask `phoneOs()` (same file) or `capabilities.programs`.

The page's phone-only calls keep their `android:*` message names for the same reason; the iPhone shell answers
the same list (`HostJsBridge.types`), pinned against the page and against Android's by `desktop/tests/ios-shell.test.ts`.

## What an iPhone cannot do (and what shows instead)

- **Claude Code sessions, and so a Claude plan.** `claude-code:status` answers `not-possible`; the model menu
  greys Claude models with "Needs a computer", the Claude card says where it does work, and setup leaves out
  "Log in with Claude". A Claude plan is used from the phone by connecting to a computer (remote access today,
  the Mesh later).
- **A computer's shell.** There is no `/bin/bash`, no installer, no Python or Node, no `sudo`. The `Bash`, `BashOutput`
  and `KillShell` tools ARE offered, but they run the app's own built-in command line (next section); the prompt says so, and
  that the person cannot run commands themselves either.
- **Grep** works: where ripgrep cannot be started the same search runs in-process and prints ripgrep's own
  output format (`harness/tools/in-process-search.ts`), so there is one Grep tool.
- **Marketplace installs** work without git: `plugin-installer.ts` → `runGit` is answered from GitHub's commit
  archives (`main/git-snapshot.ts`) where no program can run. It trusts GitHub over TLS to serve the commit asked
  for (and checks the commit id written in the archive) where git verifies every object itself.
- **The git panel, the terminal view, the Files-tab content search, local models, the built-in Browser, Office, the buddy.**
  Off through `IOS_LOCAL_CAPABILITIES` (`git: false` is the real git program the panel and sync use; the assistant's own
  `git` command is the built-in one). GitHub-based sync does not run; the Mesh is the phone's sync.
- **App updates.** Only Apple updates an iPhone app; `getUpdateStatus()` never reports one there.

## The built-in command line

An iPhone app may not start any other program, but it may carry its own command interpreter (a-Shell is on the store).
So the assistant's `Bash` tool, on an iPhone, runs **just-bash** (Apache-2.0; a bash written in JavaScript with ~80
commands) with **just-git** (MIT) as its `git`. Design and the three rounds of testing behind it:
`docs/active/specs/2026-11-26-iphone-in-app-command-line.md` (workspace).

**Where it lives.** Everything that imports the two packages is in `ios/runtime/shell/`; they are `devDependencies` of
`ios/runtime/package.json` only. Desktop and Android never see them (`desktop/package.json` is untouched).
- `worker.ts` — runs ONE command on a worker thread (bundled to `dist/ios-shell/worker.js`).
- `adapter.ts` — makes that thread look like a started program (`stdout`, `stderr`, `kill()`, `exitCode`, `'exit'` then
  `'close'`, no pid), the way `tools/in-process-search.ts` does for Grep. No packages, so desktop tests can use it.
- `register.ts` — plugs the adapter into `shell-registry.ts` through `setInAppSpawner`. **Mechanism:** the iPhone build
  injects this one file in front of the backend bundle (`inject` in `build-backend.mjs`); desktop source never names it.
- `deny-fs.ts`, `git-guard.ts`, `stubs.ts` — the credential layer, the git index guard, the "not available here" sentences.
- `conformance.json` + `conformance-run.mjs` + `selftest.ts` — the proof (below).

**Desktop-side hooks (the only desktop changes).** `spawnDetached` returns the plugged-in spawner's result when
`!canRunPrograms()`; `killTree` calls `child.kill()` for a handle with no pid; `getShell()` answers `bash (built-in)`
(so the working-folder tracking, time limit, background runs, `BashOutput`, `KillShell`, spill files and the permission
cards all work unchanged); `deviceTools()` offers the tools; `persistent_env: true` is refused with a sentence; the Bash
description and the prompt's environment block describe this shell, say "iPhone (iOS)" instead of "linux", and drop the
git line. `github-client.ts` no longer tries to run `gh` where no program can run.

**What a command can and cannot do.**
- Sees only two folders: Documents (= HOME, what the Files app shows) and tmp, each mounted at its logical path AND its real
  path (iOS reaches them through `/var` → `/private/var`). The app's key store (`userData`) is not mounted. Links inside a
  folder work; links pointing out are refused. Files over 64 MB cannot be read; output is capped at 16 MB; the step limits
  are 1,000,000 (just-bash's 100,000 stops a real loop) and a command cut short by one ends with exit 126 and a plain line
  saying so (just-bash reports it itself).
- Credential files (`isCredentialPath`, the same list Read/Grep use) look absent and cannot be read, written or copied, links
  included. They show as "No such file or directory" because that is the only refusal just-bash turns into a normal
  command failure (any other error aborts the whole script).
- The environment is built fresh (HOME, USER, SHELL, TMPDIR, PATH, NO_COLOR, LANG); the backend's own never reaches it.
- Network: `curl` and `git` use the app's own `iosFetch` through two small adapters — same reach as the other web tools,
  and, like desktop's Bash, no private-address block. `git push` and private clones: the app's saved GitHub sign-in
  (`github-client.ts`, the token the in-app Connect GitHub flow stores) is read WITHOUT starting a program and handed to the
  worker as `{ 'github.com': token }`; it answers git's own password question and never enters the environment, command text
  or output. No saved sign-in, no credentials.
- git index guard: a repository whose index is not version 2, or is a split index, is refused (`git -C` included) — just-git
  misreads those and wrote a silent bad commit in testing.
- Absent: Python, Node, `npm`/`pip`, `sudo`, compilers, installers, `sqlite3` (needs WebAssembly), zip/unzip, output that
  streams while running. Stubs are NOT registered, so `which`/`command -v`/`type` say "absent"; when a command ends with
  "command not found" for one of the known names, that line is replaced by a sentence saying what to use instead.
- Not yet: the git panel, sync, plugins that need to start a program.

**Engines note.** just-bash declares Node >=20.19; it runs on 18 here behind our prelude (`ios-prelude.ts`), with
`defenseInDepth` off (its optional JavaScript/Python runtimes, which that guards, are never enabled, and it crashes on 18).
Its own ES build imports `undici`, so the bundle uses its CommonJS build (an alias in `build-backend.mjs`);
`@mongodb-js/zstd`, `node-liblzma` (LGPL), `sql.js`, `typescript` and `guarded-fetch` are left out. The licence texts of
everything in the shell's bundle are copied to `legal/` next to `dist/` in the app.

**Proof.** `conformance.json` is ~45 command lines with exact expected output (everyday commands, honest gaps, credential
hiding, git, the index guard, a loop past the old limit). It runs (1) on any machine: `NODE18_BIN=<node18> node
ios/runtime/shell/conformance-run.mjs <built dir>` (adds `--jitless`, a symlinked HOME like iOS's); the desktop test
`tests/ios-shell-conformance.test.ts` builds the bundle and does that when `ios/runtime` has its packages installed; (2) in
CI under Node 18 (`ios-ci.yml`); (3) inside the real app in the simulator: with `YOUCODED_IOS_SHELL_SELFTEST=1` the build also
bundles `selftest.ts`, which runs the list through the real `Bash` path at start-up and writes `SHELL_SELFTEST PASS n/n` (or
`FAIL <command>: <why>`) to `backend.log`; the workflow fails without PASS. A release build never contains the list.

## Background

iOS suspends an app shortly after it leaves the screen: the Node thread stops, sockets die, a reply in progress
is cut off. What the shell does today:

- While the assistant is working (the backend's `keepAwake`), the screen does not dim and lock.
- If the person leaves the app anyway, the shell asks iOS for its short grace period (about 30 seconds).
- "Needs you" alerts and the icon badge are shown from the backend's `status` call, but only while the app is
  still running; nothing can wake a suspended app without a push service, which YouCoded does not have.

- **Coming back.** iOS can take a suspended app's listening sockets away, so on return the shell reopens its own
  listener on the same port (`HostSocketServer.reopenIfNeeded`), tells the backend the app is visible, and the
  backend knocks on its own door and reopens it if nobody answers (`RemoteServer.reviveLocalListener`); the page
  reconnects by itself. If the backend still cannot be reached after a few tries the shell says so ("iOS paused
  YouCoded for too long…"). None of this can be reproduced in a simulator: it is the first thing to try on a phone.

So an iPhone is a device you use, not one that works on its own: scheduled automations run only while the app
is open (missed runs are handled by each job's own setting when it next opens), and a phone hosting a Mesh chat
can only do so in the foreground. Running on a computer that is on — reached through the Mesh — is the answer
for anything long.

## The backend bundle (`ios/runtime/build-backend.mjs`)

- The app starts `dist/main/headless/ios-boot.js`, a few lines the build writes that load the real bundle inside a
  `try`. If the phone's V8 could not even parse the bundle, nothing in it would run — including the exit guard — and
  Node's own reaction (exit) would close the app without a word; the loader turns that into the failed screen.
- `undici` is aliased to `headless/ios-undici.ts` (the `Agent` + `fetch` pair `net-guard` uses, on `ios-fetch`).
- One bundle per entry: the backend (`headless/ios-main.ts`) and each worker thread (`WORKER_ENTRIES`), laid out
  where Android's compiled tree would have them, so path lookups agree. Each source file's `__dirname` /
  `__filename` is rewritten to its compiled-tree path.
- `electron` is aliased to `headless/electron-headless.ts` at build time (Android does it with a runtime hook).
- `headless/ios-prelude.ts` is injected into every bundle so the fills run before any module.
- **Unicode tables.** The build finds every `\p{Name}` the bundle mentions, computes each property's code-point
  ranges on the build machine (whose Node has ICU), and bakes them in as `__YC_UNICODE_TABLES__`;
  `installRegExpPropertyFallback` rewrites patterns as they reach `new RegExp`. Regex LITERALS that name a
  property are turned into `new RegExp(…)` calls by the build (found with the TypeScript parser), because on the
  phone such a literal is a syntax error for the whole file.
- `node-pty`, `koffi`, `playwright-core` and `*.node` files are left out; they are reached only on paths a phone
  never runs.
- The built-in command line adds a fifth bundle (`dist/ios-shell/worker.js`, from `ios/runtime/shell/`, outside
  `desktop/src`) and one injected file in the backend bundle; see its section.

## Building

A Mac is required for the app itself (Xcode). Everything else builds anywhere (`ios/runtime` installs its own packages: `npm ci --ignore-scripts`, not `--omit=optional`, which would remove esbuild's compiler):

- `bash ios/build-resources.sh` — the page (`npm run build:web`), the backend bundle, Node for iOS
  (`runtime/fetch-node.sh`, checksum-pinned in `runtime/pins.env`), then `xcodegen generate` from
  `ios/project.yml` (the `.xcodeproj` is never committed).
- CI: `.github/workflows/ios-ci.yml` builds, runs the Swift unit tests (`ios/YouCodedTests`) and starts the whole
  app in a simulator (`ios/YouCodedUITests`), uploading screenshots, `backend.log` and `page.log`.
- The Dev copy is `com.youcoded.app.dev` ("YouCoded Dev"), installed beside the real app like Android's.
- Logs on a device: `Library/Application Support/userdata/backend.log` (the backend's console) and `page.log`
  (the page's errors and warnings).

### Testing the backend without a Mac

The bundle runs on any Node 18. To imitate the phone on Linux:

```
node ios/runtime/build-backend.mjs /tmp/ios-backend
cd /tmp/ios-backend && HOME=/tmp/h YOUCODED_USER_DATA=/tmp/u YOUCODED_HOST_OS=ios \
  YOUCODED_HEADLESS_PORT=9977 YOUCODED_HEADLESS_TOKEN=<32+ chars> YOUCODED_SECRET_KEY=<64 hex> \
  node18 --jitless dist/main/headless/ios-main.js
```

`--jitless` removes WebAssembly, as on the phone. A Node 18 built `--with-intl=none` also removes ICU.

## With the branches in flight (checked 2026-11-25)

- **Mesh (`session/64-mesh-sync-build`)** merges with this branch without conflicts; the bundle builds (the Unicode
  pass picks up its extra properties by itself) and the Mesh starts on Node 18 `--jitless` in its test mode. Two
  lines there still say Android: `headless-boot.ts` passes `platform: 'android'` to `startMeshIfEnabled` (should be
  `hostOs()`), and the Mesh accepts only `android_keystore` as a phone's secret store (the shell sends `ios_keychain`).
- **Automations (`session/90-pages-finish`)** overlaps this branch in three files (`shared/capabilities.ts` — it adds
  `pageFiles`, which `IOS_LOCAL_CAPABILITIES` then needs; `harness/tools/index.ts`; the generated `preload.ts`).
  Its `net-guard.ts` imports `undici`, which the alias above covers. Its Claude engine (`claude -p`) cannot exist on
  an iPhone; `canRunPrograms()` is the question to ask where it offers Claude models.

## Not done yet

- A run on a physical iPhone, and signing/TestFlight (needs the Apple account; the app's bundle id is not
  registered yet).
- The counting service does not accept an `ios` platform, so iPhones send no daily heartbeat
  (`headless-boot.ts`).
- YouCoded Mesh accepts only `android_keystore` as a phone's secret store; the shell sends `ios_keychain`.
- `shared/device-table.ts` has no iPhone column; iPhone differences live in `IOS_LOCAL_CAPABILITIES`.
- Node 18 is past its end of life upstream; a newer nodejs-mobile is the fix when one is released.
