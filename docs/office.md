# Office — depth

> Word, Excel and PowerPoint editing inside the desktop app. The editors are Euro-Office (an AGPL fork of OnlyOffice) in a **separate add-on** (`itsdestin/youcoded-office`); the app (MIT) only converts files, serves the editor, and relays small messages. The terse rule is `.claude/rules/office.md` in the workspace. Decisions and trial evidence: `docs/archive/specs/2026-09-28-office-build-design.md`, `docs/archive/investigations/2026-09-24-office-suite.md`, plans in `docs/archive/plans/2026-09-28-office-build-plan.md` and `2026-09-29-office-finish-plan.md`, design decks in `docs/archive/design/2026-09-27-office/`. **Where those documents and this one disagree, this one (checked against code on 2026-10-02) is right** — see "Differences from the original design" at the end.

## What the person gets

- An **Office page** (built-in, pinnable; the header briefcase goes to it): Home (New document / spreadsheet / presentation, Recent, this project's files) and one tab per open document. A **Versions** button lists kept copies.
- **Edit** on a `.docx`/`.xlsx`/`.pptx` in the session drawer or Project View opens a *slim* editor (the editor's own chrome hidden, the app's one-row bar instead); *Open in Office* hands it to the full page.
- Autosave, crash recovery, Save As / Export / PDF, Print, pictures, comments the assistant can add to an open file, the app's theme and fonts.
- **Desktop only.** The remote browser and the phone refuse every `office:*` call (`remote-shim.ts`, `SessionService.kt`), and the renderer hides every Office entry point unless `office.status()` says `available` (`office-availability.ts`). On a platform with no add-on (Linux ARM) Office is hidden and files open with the default app.
- Only `.docx`, `.xlsx`, `.pptx` open in Office (`formatFor` in `x2t.ts`; `isOfficeEditable` in `office-files.ts`). Older (`.doc`/`.xls`/`.ppt`), OpenDocument and `.csv` files are **not** opened.

## Architecture

```
renderer (app origin)                                  add-on page  office://<token>/index.html
  OfficeView / OfficeInlineEditor / office-store         Euro-Office editors + euro-office-lite's bridge.js (patched at build time)
  EditorFrame  <iframe sandbox>  ──postMessage──▶        tauri-relay.js  (fake window.__TAURI__)
     │  window.claude.office.invoke(token, cmd, args)     yc-bridge.js / yc-early.js / yc-comments.js
     ▼  IPC
main  ipc/office.ts (the channel table's office:* entries) → office/: office-ipc.ts → office-commands.ts → x2t.ts (native converter, spawned)
      office-protocol.ts serves the editor and the document's media
```

- **Main converts; the page never touches a file.** The editor asks (`open_file`, `write_editor_bin`, `save_file`…) and main runs the bundled native `x2t` (`x2t.ts`): file ⇄ the editor's own form `Editor.bin`, plus PDF/ODF/RTF/TXT/CSV exports.
- **One sealed origin per open document.** `office:open` mints a 128-bit random token (`office-sessions.ts`); the editor loads from `office://<token>/index.html`. The scheme is registered `standard, secure, supportFetchAPI` only — no `bypassCSP`, no service workers (`main.ts`). Every response carries `OFFICE_CSP` (`'self'` only — no network; `form-action 'none'`), `nosniff`, and the document's own pictures get a stricter sandbox CSP (`office-protocol.ts`). Two documents cannot read each other's storage or media: the token is the hostname, and `/asc/docmedia/` is served only from that session's temp folder with `realpath` confinement. `office-frame-guard.ts` (wired by `sealOfficeFrames` in `main.ts`) cancels any attempt by an Office frame to navigate off `office:` — CSP cannot stop that.
- **Relay.** The add-on's `tauri-relay.js` turns the editor's Tauri calls into `{yc:'rpc', id, cmd, args}` posts to the parent. `EditorFrame.tsx` accepts a message only if `e.origin === this document's origin` and `e.source === its own iframe`, then calls `window.claude.office.invoke`. Host→editor: `{yc:'rpc-result'}`, `{yc:'event'}`, and `yc:office-*` messages (theme, slim mode, comments). The frame has `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"`; `allow-same-origin` is a reviewed ast-grep exception for `EditorFrame.tsx` only (it grants the editor its *own* origin, never the app's). The editor cannot reach `window.claude`.
- **Main is the guard, not the renderer.** The renderer relays any `cmd`; `office-ipc.ts` `invoke` refuses it unless it is in `OFFICE_COMMANDS` (28 names, pinned by `tests/office/office-commands.test.ts`) **and** the token's session belongs to the asking window (`event.sender.id`); `office-commands.ts` checks the allow-list again. A few commands (`open_dialog`, `save_dialog`, `save_file_as`, `print_document`, `save_editor_settings`) are answered in `office-ipc.ts` because they need the asking window.
<!-- verify: {"path": "youcoded/desktop/src/main/office/office-ipc.ts", "contains": "OFFICE_COMMANDS[.]has[(]cmd[)]"} -->
- **The frame is never told folder paths.** `get_current_path` and the open-file payload carry the file *name* only; dialogs answer opaque handles (`yc-picked/<random>/<name>`, `yc-save/<random>/<name>`) that only main maps to real paths, per document; errors reaching the frame are fixed human sentences (`toEditorError`), never fs errors or x2t output.
- **One queue per document.** `office-commands.ts` runs every command of a session through one promise chain (`queues`), so a second `write_editor_bin` can never replace `Editor.bin` while x2t reads it. Saves requested back to back join the one not yet started. Closing a document waits for its queue (`CLOSE_DRAIN_MS` = x2t's 60 s + 5 s), then aborts and removes the temp folder. A restore marks the session `replaced`, and its saves are refused until the editor reloads.
- **Open rules.** `office:open` takes the real path, runs `authorizeArtifactWrite` (same boundary as the artifact editor: `.git`, credentials, confirm-tier paths are refused), refuses files over `OFFICE_MAX_BYTES` (200 MB, `shared/office-types.ts`), and refuses a file already open in *another window*. The editor's translated form may reach `EDITOR_BIN_MAX_BYTES` (1 GB).

## The add-on (`itsdestin/youcoded-office`, AGPL, separate repo)

Contents (read its `README.md` for build details): `bridge/` = `tauri-relay.js`, `yc-bridge.js` (theme, slim mode, commands, quiet editor), `yc-early.js` (first script in every editor page: external-links warning, settings seed), `yc-comments.js` (comment operations); `build/patch.mjs` (the patches to euro-office-lite's `bridge.js`/`editor-patches.js`/`index.html` — a pattern found zero or twice **fails the build**); `build/gen-themes.mjs` (PowerPoint's slide themes); `build/package-platform.sh`; `build/check-win-imports.sh` (fails the Windows build if `x2t.exe` or a DLL needs a DLL that is neither shipped nor in every Windows install); `test/` (node tests per bridge file, `smoke-x2t.mjs`); `PIN.json` (the add-on's version and the pinned euro-office-lite tag).

A release tarball per platform holds `manifest.json`, `editors/`, `converter/` (x2t + libraries + font list), `templates/blank.{docx,xlsx,pptx}`, `LICENSE`, `NOTICE`. The **Windows bundle ships the Visual C++ runtime DLLs** (`vcruntime140`, `vcruntime140_1`, `msvcp140`) — a clean Windows PC lacks them and x2t dies with 0xC0000135 (v0.1.40, found on a clean Windows 11 VM). CI (`.github/workflows/bundle.yml`) builds Linux, derives Mac/Windows converters from euro-office-lite's installers, **runs each converter on its own OS (smoke) before publishing**, then publishes `youcoded-office-<ver>-<platform>.tar.gz` + `SHA256SUMS` on a `v*` tag.

### How to ship an add-on change

1. Edit the add-on repo; run `node --test test/*.test.mjs` (and `build/build-linux.sh` first for the bundle tests).
2. Bump `version` in the add-on's `PIN.json` (the tarball names and `manifest.json` come from it; it must equal the tag).
3. Commit to `main`, push tag `vX.Y.Z`. CI builds, smokes each OS, publishes the release.
4. In the app's `desktop/office-pin.json`, set `version` and, for **each of the four platforms**, the `url` and `sha256` (take the hashes from that release's `SHA256SUMS`).
5. `node scripts/fetch-office.mjs` (dev copy into `desktop/office-addon/`, checksum-verified, atomic swap), then check the add-on in a dev instance (`bash scripts/run-dev.sh`).
6. Run `bash scripts/verify.sh`. Skipping the pin edit leaves the app on the old add-on; a pin that disagrees with the installed `manifest.json` makes `officeAvailable()` false, so Office disappears.

`npm run build` runs `fetch-office.mjs --release --required` (every arch pinned for the build OS into `desktop/office-build/<platform>-<arch>/`); `electron-builder.yml` packs that as `resources/office`. `office-pin.json` is packed into the asar because `office-root.ts` requires it at startup. Current pin: **v0.1.41**.

## Platforms

`linux-x64`, `darwin-x64`, `darwin-arm64`, `win32-x64`. There is no Linux ARM converter upstream, so no bundle: the build succeeds without Office and the app falls back to the default app (`docs/roadmap/files.md`, ARM Linux entry). **Mac:** the converter must be signed or Apple silicon refuses to run it — `electron-builder.yml` `signIgnore` skips every add-on file except `converter/x2t` and `*.dylib`, which are re-signed with the app; `scripts/verify-mac-signature.sh` checks them, and `scripts/office-packaged-smoke.mjs` runs the x2t *inside* each packaged `.app` (Mac CI jobs in `desktop-release.yml` / `desktop-test-build.yml`; the Intel copy under Rosetta when available).

## Saving, autosave, versions, recovery

- **Autosave** (`EditorFrame.tsx`): the editor reports a change; the host asks for a save `autosaveDelay()` later — 3 s after the last change, longer for big documents (10 × how long the editor froze handing over its bytes, capped at 20 s). Closing a tab and Done save at once; a closing window or a quit relies on the journal below. "Saved" in the strip reflects the last successful write; a failed one shows the error with Retry, **Save a copy…** and Close without saving (`OfficeSaveFailed.tsx`).
<!-- verify: {"path": "youcoded/desktop/src/renderer/components/office/EditorFrame.tsx", "contains": "AUTOSAVE_MAX_DELAY_MS = 20_000"} -->
- **A save** (`saveFile`): translate `Editor.bin` into a private `0700` folder `.<name>.office-save-<random>` beside the file (same disk), validate the output, re-check `authorizeArtifactWrite`, then one atomic rename; permissions of the original are kept; a read-only file stays read-only. Stale save folders are swept at the next save (older than 1 h). The write goes through `noteOwnWrite`, but **there is no modified-time (CAS) check** and Office does not watch the open file.
- **Versions** (`versions.ts`): `<userData>/office-versions/<sha1 of real path>/` with `index.json` and one whole copy per version. Kept when a file is opened (unless identical to the newest), on an autosave at most once per 10 minutes (the file as it was just before), and before a restore. Pruning: everything from the last 24 h, then the newest per day for 30 days, at most 50 per file, 1 GB across all files; it runs 30 s after startup and after new versions (spaced ≥ 5 min), never on the save path. Restore snapshots the current file, then replaces it and sends `office:changed` so the editor reloads.
- **Crash-recovery journal** (`office-recovery.ts`): the editor streams every batch of edits (`save_changes`, about once a second while typing); main appends them to `<userData>/office-recovery/<first 32 hex of sha256(real path)>/` (`info.json`, `base.bin`, `media/`, `changes.log`), written lazily on the first real edit. A save that holds every edit so far (`savedRev`) makes the journal "all saved". Closing or quitting removes an all-saved journal and **keeps one with edits the file never got**. The next open replays it through the editor's own recovery (`recovery_candidates`/`recovery_load`; strip says "Recovered changes…"). If the file changed outside Office since the journal was written, the journal is set aside (`<key>.held`) and the strip offers **Recover / Discard** instead of replaying over someone else's change. A restore or "Close without saving" discards the journal. Startup prunes journals whose file is gone or untouched 30 days. Before a window closes, `office-journal-sync.ts` asks its editors to send their newest edits (≤ 1.5 s cap); quit waits ≤ 5 s for saves (`quitOfficeSessions`), kills converters, and leaves unsaved journals. An unsaved Office document still counts in the one "unsaved files" quit prompt (`unsaved-quit.ts`).

## Pictures, Save As / Export, Print

- **Pictures** (`office-pictures.ts`): *From file* — main shows the dialog and hands back handles; `copy-to-media` copies only a granted file into the session's `media/` under a fresh name. *From a web address* — `download-to-media`: http(s) only, **public addresses only** (the resolved addresses are checked against loopback/private/link-local/etc. ranges in `public-address.ts`, each of at most 5 redirects re-checked), image types only (png, jpg, gif, bmp, webp, svg, ico), 25 MB (`PICTURE_MAX_BYTES`), 20 s, fetched with Electron's `net` (system proxy). Dropped pictures arrive as bytes at `upload/drop`. TIFF/EMF/WMF are not accepted.
<!-- verify: {"path": "youcoded/desktop/src/main/office/office-pictures.ts", "contains": "PICTURE_MAX_BYTES = 25"} -->
- **Save As / Download as / Export to PDF** write a *copy* (the open document stays on its file, like "Save a copy"): `save_dialog` records the chosen target under a handle, `save_file_as` writes only to that handle's target, refuses the open file itself and files open in Office, and uses the same private-folder-then-rename path. Formats (`EXPORTS` in `x2t.ts`): docx → docx/odt/rtf/txt/pdf; xlsx → xlsx/ods/csv/pdf; pptx → pptx/odp/pdf. CSV encoding/delimiter and a workbook PDF's print range reach x2t; TXT encoding does not. PDFs use the computer's installed fonts (x2t's `-create-allfonts`, made once per run).
- **Print** (`print_document`; `office-print.ts`): PDF via x2t into a private temp folder, shown in a hidden window's PDF viewer and printed with the OS dialog; if that cannot be shown, a specific message and an offer to save the PDF. One print at a time; "print only the selection" is refused (x2t prints from the saved document).
- **x2t hardening** (`x2t.ts`): every job runs in a **fresh** folder (never reused between open and save — a reused folder merged old chart parts in) nested 42 levels deep, and the editor bytes are scanned for runs of `../` deeper than `CONTAIN_DEPTH` (40), so a picture name cannot make x2t read outside the job; 60 s timeout (`X2T_TIMEOUT_MS`); on **Linux** x2t runs under `unshare -rn` (empty network namespace) when the kernel allows it, so a web-address picture name is not fetched during a save. Proxy variables pointing at a closed port are set everywhere, but x2t ignores them on Linux — **Mac/Windows have no network block** (roadmap, `docs/roadmap/files.md`, security entry).
<!-- verify: {"path": "youcoded/desktop/src/main/office/x2t.ts", "contains": "CONTAIN_DEPTH = 40"} -->

## Comments, editor settings, theme

- **Live assistant comments.** A comment written into a file Office has open would be erased by the editor's next autosave, so `doc-comments-dispatch.ts` asks `live-comments.ts`, which — when `getOfficeSessions()` holds the file — sends each add/reply/resolve/edit/delete/list to the owning window (`office-comments.ts`: `office:comments-request` → EditorFrame → `yc-comments.js` → the editor's comment API) and returns the editor's answer; the editor's autosave writes it. If the editor cannot answer within 3 s (opening, a cell being edited) the change is kept per file in order, retried every 1.5 s (dropped after 10 min, max 50 per file), and written to the file if the editor closes first; reads are never kept (they read the file). Word comment ids are `oo-<editor id>` while open; Excel's keep their file id `xt-<sheetId>-<cell>-<guid>`. The person's own comments are named "You". The editor reports changes (`office:comments-changed`) so reading views refresh.
- **Editor settings** (`editor-settings.ts`): Advanced Settings / view toggles are remembered in `<userData>/office-editor-settings.json` through an **allow-list of keys** (checked on write and on read; values ≤ 64 chars; never document content, identity or recent lists; theme and rulers are deliberately excluded because YouCoded sets them). Served to the next editor at `office://<token>/yc-settings.json` and seeded by `yc-early.js`.
- **Theme.** The renderer reads the live tokens (`office-theme.ts`) and posts `yc:office-theme` into the frame; `yc-bridge.js` maps them onto the editor's CSS variables, with the result cached between theme changes. **Never use `:has()` in the add-on's CSS**: three `body:has()` rules made every style recalculation ~23× slower (6.2 ms vs 0.27 ms on a 69-page document); the add-on now sets classes from script and a test (`yc-bridge-perf.test.mjs`, `yc-bridge-quiet.test.mjs`) fails if `:has(` returns. Theme web fonts: the editor cannot fetch them (CSP), so main fetches from Google's two font hosts only and serves them at `/yc-fonts/…` (`theme-fonts.ts`, cached in `<userData>/office-font-cache/`, 512 KB CSS / 10 MB file caps).

## On-disk state

| Where | What |
|---|---|
| `<userData>/office-versions/<sha1>/` | kept versions (above) |
| `<userData>/office-recovery/<sha256-32>/` (+ `.held`) | crash-recovery journals |
| `<userData>/office-recent.json` | Recent list (12 entries) |
| `<userData>/office-editor-settings.json` | remembered editor settings |
| `<userData>/office-font-cache/` | theme web fonts |
| `os.tmpdir()/youcoded-office-<random>/` | this run's sessions (`doc-*`, served media), x2t `job-*`, `print-*`, font list; removed at quit; a fresh random folder per app instance so a dev app and the live app never share one |
| `<file's folder>/.<name>.office-save-<random>/` | a save in flight (removed after; stale ones swept at the next save) |
| `desktop/office-addon/`, `desktop/office-build/` | gitignored add-on copies from `fetch-office.mjs` |

## Tests

`youcoded/desktop/tests/office/` (one file per module: protocol, commands, sessions, ipc, recovery, versions, x2t, pictures, print, dialogs, comments, editor settings, frame guard, journal sync, theme fonts, fetch-office pin and signing config, plus `editor-frame*.test.tsx` and `office-no-lost-edits.test.tsx` for the renderer) with fixtures in `tests/office/fixtures/`; `tests/doc-comments-live.test.ts` for live comments; `tests/channel-table-office.test.ts` pins the table entries (`main/ipc/office.ts`: computer-only, one object per request); the `office:*` block of `tests/ipc-channels.test.ts` pins channel parity across `preload.ts`, `remote-shim.ts`, `office-ipc.ts` and `SessionService.kt`. Tests that run the real converter need `node scripts/fetch-office.mjs` first and skip without it. The add-on has its own suite (`node --test test/*.test.mjs` in that repo). The comment views Office's live comments feed (`CommentsMargin`, `ReadingHighlights`) are pinned by counted work, not CPU time, in `tests/CommentsMargin.test.tsx` and `tests/ReadingHighlights.test.tsx`. Dev loop: `bash scripts/run-workbench.sh` + `node scripts/office-workbench-server.mjs` (fake backend), or `bash scripts/run-dev.sh` (real); screens `office/*` for `shoot`.

## Known limits

Tracked in `docs/roadmap/files.md` (Office entries); the load-bearing ones:

- Only docx/xlsx/pptx; no legacy/ODF/CSV open.
- Office does not notice the open file changing on disk, and saves have no modified-time check: another program's (or the assistant's file-tool) edit to an open document is overwritten by the editor's next autosave. Only comments are routed through the editor. The open-time journal check is the only outside-change handling.
- Tabs never sleep: every open document keeps its editor mounted (hidden when not in front) — memory grows with each open document.
- No Linux ARM bundle; no network block for x2t on Mac/Windows; a printed selection and the editor's printer/copies rows are not offered.
- Windows converter folder permissions are inherited from the document's folder (roadmap).

## Differences from the original design

The spec/plans (archived) describe intent; the code differs in these places: the editor page is `index.html`, not `editor.html`; bundles are `.tar.gz`, not `.tar.zst`; there is no `office-files.ts`/`templates/` module in main (`office-home.ts` + the add-on's `templates/`), saves are rename-based with no `casWrite`; legacy/ODF/CSV open flows (R21–R24), outside-change detection (spec §4a), tab sleep (R8) and the user-fonts overlay (`userData/office-fonts/`) were **not built**; the renderer does not check the allow-list (main does, twice); close/quit no longer flushes saves — the journal replaced that (`office-flush.ts`, `abandoned-saves.ts` are gone); the x2t job folder is `<instance temp>/job-*`, not `os.tmpdir()/youcoded-office/<job>`.
