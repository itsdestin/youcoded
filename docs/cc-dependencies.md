# Claude Code Dependencies

This doc tracks every place YouCoded couples to Claude Code's behavior — every silent point of failure when CC changes. It's both a navigational hub for humans and the input to the `review-cc-changes` release agent that maps CC CHANGELOG entries to code that might break.

> **Sibling registries:** `engine-dependencies.md` (bundled llama.cpp) and
> `provider-dependencies.md` (cloud provider APIs + AI SDK) track the
> non-Claude backends introduced by the platform roadmap (Phase 0 seam:
> `SessionProvider = 'claude' | 'native' | 'shell'` — 'shell' is a plain terminal with
> no assistant in it, added 2026-09-05, and couples to nothing in Claude Code).

## When to update

When you add code that parses CC output, consumes a CC file, depends on CLI behavior, or matches a CC text pattern, add an entry below. An omitted touchpoint silently downgrades the release agent to free-reasoning-only mode for that area — don't rely on the agent to notice a coupling that isn't documented here.

Each entry has three fields:

- **Files:** one or more code paths
- **Depends on:** plain-English description of the CC aspect this code relies on
- **Break symptom:** observable user-facing failure if CC changes this

## Verification tooling

Drift detection beats discovering breakage from a user bug report. Several tools exist; use them on every CC version bump and as part of `/audit`.

**Methodology guide:** `desktop/test-conpty/README.md` documents how to write new probes against the live `claude` binary — pre-trusting cwds, detecting "ready" / "submitted" / "stuck" from stdout, ANSI-stripping conventions, cost control, and the pitfalls that consumed the most time the first time around. Read it before adding a new probe. Reusable for any future PTY/Ink/Claude-input/output question, not just chat-submit.

| Tool | What it captures | When to run |
|------|------------------|-------------|
| `desktop/test-conpty/cc-snapshot.mjs` | CC version, paste-classification length threshold (bisected), input-bar echo behavior. Writes JSON to `test-conpty/snapshots/cc-<version>.json` for diffing across releases. | Each CC version bump. Compare new snapshot to prior. |
| `desktop/test-conpty/test-multiline-submit.mjs` | End-to-end submit scenarios against the real `claude` binary — paste threshold, multi-line submit, bug-state recovery. | When changing the worker write protocol (`pty-worker.js`, `PtyBridge.kt`, `useSubmitConfirmation.ts`). |
| `rg -o -a '<field>[^,}]{0,80}' "$(readlink -f "$(which claude)")"` | What a CC JSON field actually MEANS — the binary is not stripped, so the expression that builds a field is greppable out of it (this is how `context_window.total_input_tokens` was settled: `total_input_tokens:x?x.input_tokens+x.cache_creation_input_tokens+x.cache_read_input_tokens:0`). Free, offline, no CC run, no tokens. | Any time a CC payload field's scope or units are in doubt — BEFORE writing a comment that asserts them. Two shipped bugs (youcoded#405, #411) came from asserting instead. |
| `desktop/test-conpty/harness.mjs` | Bracketed-paste viability on Windows ConPTY. Empirical disproof of the marker-based-submit path. | Only re-run if someone proposes resurrecting bracketed paste. |
| `desktop/test-conpty/test-attention-states.mjs` | End-to-end attention classifier behavior against real CC — drives idle/quick/long thinking scenarios and verifies no false-stuck dispatches. Captures observed glyph + gerund sets per scenario. | When changing `attention-classifier.ts` SPINNER_RE, the staleness threshold, or the hook driver. |
| `desktop/test-conpty/test-spinner-fullcapture.mjs` | Captures the full raw byte stream from welcome through response and grep-probes for "esc to interrupt" / "esc to cancel" / `(Ns ·` patterns. Confirms whether CC's spinner format has changed. | Each CC version bump. |
| `desktop/test-conpty/test-attention-false-match.mjs` | Production-accurate false-match probe (uses `@xterm/headless` for buffer rendering) — drives Claude prompts that nudge spinner-shape text into the response, verifies SPINNER_RE doesn't false-match. | When changing the SPINNER_RE shape or the `^` anchor. |
| `shared-fixtures/attention-classifier/*.json` | Pinned classifier inputs + expected outputs. Drives `attention-classifier-parity.test.ts`. | Whenever the spinner regex or classifier behavior changes. Add a fixture in the same commit. |
| `shared-fixtures/transcript-parity/` | Pinned transcript JSONL inputs + expected event streams for the parser. Drives `desktop/tests/transcript-parity.test.ts` and gates the Android Node-CLI parity. | Whenever transcript-watcher logic changes. |
| `shared-fixtures/raw-byte-listener/` | Raw-byte payload contract for the Android terminal-emulator vendor patch. Drives `raw-byte-listener-contract.test.ts`. | Whenever the terminal-emulator vendor patch or `pty:raw-bytes` payload changes. |
| `desktop/tests/ipc-channels.test.ts` | Cross-platform IPC parity matrix — every `window.claude.*` API present in `preload.ts` must be present in `remote-shim.ts` and reachable via a Kotlin `SessionService.kt` handler. | Auto-runs in `npm test`; fails CI if parity drifts. |
| `/audit` slash command | Drift between docs and code. Outputs `docs/AUDIT.md` + carries open items into `docs/knowledge-debt.md`. | Before any release; periodically. |

The most rigorous CC-version drift catch is: re-run `cc-snapshot.mjs` against the new CC, diff the resulting JSON against the prior snapshot, and treat any field change as a release-blocker until the affected coupling entry below is reviewed.

## Current verified baseline

| Field | Value |
|-------|-------|
| Claude Code CLI version | **2.1.123** (April 2026) |
| Paste-classification length threshold | **64 bytes** — atomic write ≥64 bytes ending in `\r` is paste-classified, `\r` becomes literal newline |
| Spinner glyph set | `✻ ✽ ✢ ✳ ✶ * ⏺ ◉ ·` (empirical; not from a documented contract) |
| Input-bar echo delay | ~6.75 s on cold start (Ink batches renders; warm session is faster) |
| Anthropic model ID convention | dotted-hyphen, e.g. `claude-opus-4-7` |
| CC-composed assistant lines | `"model": "<synthetic>"` — angle-bracketed sentinel, not a model id |

Update this table when you re-run snapshots after a CC version bump. Anything that doesn't match the current snapshot needs an audit before the release ships.

## Touchpoints

### Transcript JSONL shape
- **Files:** `desktop/src/main/transcript-watcher.ts`, `desktop/src/renderer/state/chat-reducer.ts`
- **Depends on:** JSONL entries in `~/.claude/projects/<hash>/*.jsonl` with fields `type`, `message.role`, `message.content[]` (including `text`, `tool_use`, `tool_result`, `thinking` block shapes), `message.usage`, `requestId`, `stop_reason`, and per-turn heartbeats for extended-thinking models
- **Break symptom:** Transcript events stop dispatching; chat UI goes silent while CC still runs. Per-turn metadata (model, usage, requestId, stopReason) disappears from turn bubbles and attention banners.

### Queued messages, slash-command lines and image placeholders
- **Files:** `desktop/src/main/transcript-watcher.ts` (`queuedPromptText`, `slashCommandText`), `desktop/src/renderer/state/chat-reducer.ts` (`sameUserMessage`, `slashCommand` on `TRANSCRIPT_USER_MESSAGE`), `app/src/main/kotlin/com/youcoded/app/parser/TranscriptWatcher.kt` (mirror)
- **Depends on:** (1) a message typed while a turn is running is written ONLY as `{type:"attachment", attachment:{type:"queued_command", prompt, commandMode:"prompt", origin:{kind:"human"}}}`. Measured 2026-09-11 on the 400 newest local transcripts: 84 such lines (82 `origin.kind:"human"`, 2 `"peer"` sent by another Claude Code session), 1,218 `commandMode:"task-notification"`, and no ordinary user line repeating a queued message within three lines. (2) a slash command is a `type:"user"` line with `promptId` whose content is `<command-name>/name</command-name><command-message>…</command-message><command-args>…</command-args>`. (3) a pasted image is recorded as `[Image #N]` in the user line's text.
- **Break symptom:** a message typed mid-reply, a slash command, or a message with a picture stays pinned unconfirmed at the bottom of the sending device's chat, while other devices never show it or show it in a different place. If Claude Code starts also writing an ordinary user line for a queued message, that message appears twice.

### Post-/compact stdout echo + isCompactSummary line shape
- **Files:** `desktop/src/main/transcript-watcher.ts`, `app/src/main/kotlin/com/youcoded/app/parser/TranscriptWatcher.kt`
- **Depends on:** Two consecutive JSONL lines CC writes when `/compact` completes: (1) an `isCompactSummary: true` user-type line carrying the full conversation summary in `message.content`, and (2) an immediately-following user-type line whose `message.content` is `<local-command-stdout>[2mCompacted (ctrl+o to see full summary)[22m</local-command-stdout>` (CC's dimmed status echo of the local /compact command). The parser strips `<local-command-stdout>` / `<local-command-stderr>` ENTIRELY (not unwrap) — see the long comment on `STRIP_ENTIRELY_RE` in `transcript-watcher.ts`. Unwrapping let CC's dimmed echo reach the reducer's `TRANSCRIPT_USER_MESSAGE` "no pending match" path, which both (a) appended a fake user bubble reading "Compacted (ctrl+o to see full summary)" and (b) set `isThinking: true` with no transcript turn to ever clear it, leaving chat permanently stuck thinking after every `/compact`. The `isCompactSummary` line's `message.content` is what powers the click-to-expand summary inside the thin "Compacted · freed X tokens" marker; if CC stops emitting that line, the marker still appears (driven by COMPACTION_PENDING + the shrink backup path) but loses its expand affordance.
- **Break symptom:** If CC reintroduces a different stdout-echo wrapper tag, the fake bubble + stuck-thinking pair returns. If CC stops setting `isCompactSummary: true`, the COMPACTION_COMPLETE path falls back to the shrink-detection branch in App.tsx — works for typed `/compact` but loses summary text. If CC starts wrapping the summary in something other than plain text in `message.content`, the expandable panel shows the wrong thing or stays empty.

### Per-turn metadata fields
- **Files:** `desktop/src/renderer/state/chat-reducer.ts` (`TRANSCRIPT_TURN_COMPLETE`, `TRANSCRIPT_ASSISTANT_TEXT` handlers)
- **Depends on:** `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, outer `requestId` (Anthropic `req_…`), `stop_reason` values (`end_turn`, `max_tokens`, `refusal`, `stop_sequence`, `pause_turn`), Anthropic model ID in `message.model`
- **Break symptom:** Token usage / request ID footers disappear; stop-reason banners mis-render; session-pill model reconciliation stops working.

### PTY spinner regex (attention-classifier)
- **Files:** `desktop/src/renderer/state/attention-classifier.ts` (`SPINNER_RE`)
- **Depends on:** CC thinking-spinner leading-glyph set `[✻✽✢✳✶*⏺◉·]` (each is one frame of CC's animation) followed by ` <Gerund>…` (any letter-led phrase containing letters, spaces, `+`, or `-`, followed by U+2026 ellipsis — multi-word gerunds like "Installing + verifying on device…" match), anchored to the start of the line (`^`). The glyph set is empirical — discovered by inspecting real CC output, not from any documented contract. CC can introduce a new spinner frame in any release. The previous regex also required `(Ns · esc to interrupt)` after the gerund, but the 2026-04-26 audit confirmed CC v2.1.119 has dropped that suffix entirely; if a future version brings it back, the new regex still matches because the `…` ellipsis is the anchor. The `^` anchor is load-bearing: without it, Claude's response text containing markdown bullets (`* Loading…`) or literal spinner glyphs (`❯ ... ✻ Pondering…`, `● ✻ Pondering…`) triggers false matches. CC also has a hook-execution variant `<glyph> <Gerund>… (running stop hook · 3s · ↓ 1 tokens)` — the regex stops at `…`, so this still matches. As of 2026-04-30 (commit `669fc86d`) a parallel `COUNTER_RE` matches paren-wrapped seconds counters of shape `(Nm Ns · …)` / `(Ns · …)` independently of the spinner regex; an advancing counter is an OR liveness signal.
- **Active vs. stalled detection:** Glyph rotation OR seconds-counter advancement across ticks. Same glyph for ≥30s AND counter not advancing ⇒ `thinking-stalled`. A paren-wrapped seconds counter that ticks up across ticks (`(Nm Ns · …)` / `(Ns · …)`) is now an OR-rescue signal — counter advancement alone keeps state at `thinking-active` even if the glyph never rotated. Verified in `test-conpty/test-attention-states.mjs` and `test-conpty/test-spinner-fullcapture.mjs`. The empirical glyph set captured in 2026-04-26 probes is `{✻ ✽ ✢ ✳ ✶ *}`; `⏺ ◉ ·` come from older traces and remain in the regex pending re-confirmation.
- **Break symptom:** Frame-by-frame intermittent misclassification — `attentionState` flips between `thinking-active` and `'ok'` 1/Nth of the time during a real assistant turn (where N is the spinner frame count). User sees the AttentionBanner flicker; on a well-timed pause CC stays "thinking" but the UI says it's done. Worse: if the regex matches *nothing* during real thinking (e.g. seconds-counter requirement under v2.1.119), the no-spinner-20s escalation in the hook flashes the wrong banner during every long turn. Re-run `node test-conpty/test-spinner-fullcapture.mjs` and `test-conpty/test-attention-states.mjs` on each CC bump to verify.

### PTY worker write protocol — Ink paste threshold
- **Files:** `desktop/src/main/pty-worker.js` (case `'input'`), `app/src/main/.../runtime/PtyBridge.kt` (`writeInput`), `desktop/src/renderer/hooks/useSubmitConfirmation.ts`
- **Depends on:** Two private Ink/CC behaviors that determine whether `body + \r` writes submit a chat message vs. leave a literal newline in the input bar: (1) the **paste-classification length threshold** — atomic writes longer than ~N chars are treated as paste, with trailing `\r` becoming literal newline; the worker's 64-byte chunking + 600 ms Enter-split is designed to keep each individual read below the threshold. Empirically verified: 6-byte atomic `ATEST\r` submits, 101-byte atomic `D + 100×z + \r` does not (CC v2.1.119, April 2026). (2) The **input-bar echo contract** — CC re-renders typed input back through stdout, which the planned echo-driven worker depends on. Both are private Ink internals with no documented contract.
- **Break symptom:** Length-threshold drift makes the chunking workaround stop sufficing — chat sends silently fail to submit (text appears in CC's input bar with literal newline, never reaches Claude) at frequencies that vary with message length and load. `useSubmitConfirmation` retry catches most but adds 5 s recovery latency. Echo-contract drift would break echo-driven send entirely if introduced.

### PTY input-bar echo (input-mirroring)
- **Files:** `desktop/src/main/pty-worker.js` (any future `onData`-watching submit logic)
- **Depends on:** CC echoing typed stdin bytes back into the rendered input bar via stdout, so a programmatic writer can observe consumption before sending the trailing `\r`. This is universal TUI behavior but is technically a CC-internal contract.
- **Break symptom:** If CC stopped echoing input (e.g. switched to a "silent input" mode mid-turn), an echo-driven worker would hang waiting for an echo that never comes; chat sends would never complete. No echo-driven worker is shipped yet — this entry is preventive for the planned change.

### Other PTY attention patterns
- **Files:** `desktop/src/renderer/state/attention-classifier.ts` (regexes for awaiting-input, shell-idle, error, stuck)
- **Depends on:** CC's prompt-boundary phrases and idle markers rendered to the terminal buffer
- **Break symptom:** AttentionBanner states misfire; user sees wrong guidance during PTY-based interactions.

### Permission-mode banner strings
- **Files:** `desktop/src/renderer/App.tsx` (the per-session `pty:output` listener that drives the StatusBar permission pill), `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt` (`detectPermissionMode`)
- **Depends on:** CC's literal banner text emitted after Shift+Tab cycles a mode — `"bypass permissions on"`, `"auto mode on"` (CC v2.1.83+), `"accept edits on"`, `"plan mode on"`, plus the matching `"… off"` strings when cycling back to default. Ordering matters when one substring is a prefix of another. The desktop and Android branches must stay in lockstep — drift between them appears as the same session showing different pill states across platforms.
- **Break symptom:** StatusBar permission pill stops corroborating after a Shift+Tab — UI pill flips optimistically, then either snaps back (no detection) or stays stuck on the wrong state (detection misclassified). Worst case: auto / bypass shown when CC is actually in normal mode, lulling the user into running risky commands they expected to be classifier-checked.

### Auto-mode opt-in popup
- **Files:** `desktop/src/renderer/parser/ink-select-parser.ts` (TITLE_OVERRIDES anchor `'auto mode lets claude'` → `'Enable auto mode?'`), `desktop/src/renderer/hooks/usePromptDetector.ts` (SETUP_PROMPT_TITLES allowlist), `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt` (Android SETUP_PROMPT_TITLES)
- **Depends on:** CC v2.1.83+'s 4-option Ink confirmation menu titled `Enable auto mode?` with body text starting `Auto mode lets Claude…` and options `1. Yes, and make it my default mode` / `2. Yes, enable auto mode` / `3. No, go back` / `4. No, don't ask again`. The body-text anchor is used because the description is word-wrapped and the bare title heuristic can pick a wrapped line as the title.
- **Break symptom:** PromptCard fails to surface (wrong title returned, or title not in the allowlist), so the Ink menu shows in the terminal pane only — confusing for chat-view users. If CC reorders the options, `menuToButtons` still reaches the right one — it sends the number printed next to the option it parsed, not a position (see the keystroke-protocol entry above). A rewording surfaces CC's new label in the chat UI verbatim.

### Ink menu option selection (keystroke protocol)
- **Files:** `desktop/src/renderer/parser/ink-select-parser.ts` (`menuToButtons`), `desktop/src/renderer/state/prompt-input.ts` (`sendPromptInput`), `desktop/src/renderer/components/PromptCard.tsx`, `desktop/src/renderer/components/TrustGate.tsx`, `app/src/main/kotlin/com/youcoded/app/parser/InkSelectParser.kt` (`toPromptButtons`), `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt` (hardcoded login + bypass menus)
- **Depends on:** Two behaviours of CC's Ink select menus, measured against the 2.1.220 CLI on 2026-07-26 (probe method: `node-pty` + `@xterm/headless`, driving `/model`, the real Resume Session prompt, and the folder-trust prompt):
  1. **A bare digit selects AND submits the matching numbered option.** No Enter needed, no dependence on cursor position. This is how every button answers a menu.
  2. **Arrows and `\r` must not share one pty write.** CC discards the arrows and acts on the Enter alone, confirming whatever option is currently highlighted. The arrow *fallback* therefore sends navigation and submit as two writes 150ms apart — split that way, all the arrows land (also measured).
  Also relied on: options are numbered on screen (`1. ` or `1: `) — the parser already requires a numeric prefix to recognise an option line, and the digit is read from that line, never inferred from list position. And: these menus **wrap** (arrow-up at index 0 goes to the last option) rather than clamping.
- **Break symptom:** Buttons answer the WRONG option, silently and with no error. This was live until 2026-07-26: every button on the Resume Session card confirmed option 1 ("Resume from summary"), which runs `/compact`, so every choice compacted the session — and on the folder-trust dialog, clicking "No, exit" trusted the folder. If CC drops digit selection, buttons stop doing anything at all (the digit is swallowed by the menu); guard tests `desktop/tests/keystroke-diagnostic.test.ts`, `prompt-integration.test.ts`, `prompt-card.test.ts` pin the protocol but cannot detect a CC-side change — re-probe on a version bump.

### Setup-prompt TITLE_OVERRIDES anchors (trust / theme / login / model-safeguard)
- **Files:** `desktop/src/renderer/parser/ink-select-parser.ts` (TITLE_OVERRIDES), `desktop/src/renderer/hooks/usePromptDetector.ts` (SETUP_PROMPT_TITLES allowlist), `desktop/src/renderer/components/TrustGate.tsx` (exact-matches the exported `TRUST_PROMPT_TITLE`), `app/src/main/kotlin/com/youcoded/app/parser/InkSelectParser.kt` + `app/src/main/kotlin/com/youcoded/app/runtime/ManagedSession.kt` (Android mirrors — keep in lockstep)
- **Depends on:** Literal CC screen text scanned from the ~10 lines above an Ink menu, plus (since 2026-07-26) exact option labels via `OPTION_TITLE_OVERRIDES`. Verified against the CC 2.1.220 bundle 2026-07-26: folder-trust dialog `Accessing workspace:` / `Quick safety check: Is this a project you created or one you trust?…` / `Claude Code'll be able to read, edit, and execute files here.` plus optional `This folder pre-approves N tool permissions` / `This folder adds … to the workspace in …` (anchors `quick safety check` + `execute files here`, and the option-label anchor `yes, i trust this folder`; options `Yes, I trust this folder` / `No, continue without these permissions` / `No, exit`). The pre-2.1.2xx security note `Important: Only use Claude Code with files you trust.` now belongs **only** to the external-imports dialog `This project's CLAUDE.md imports files outside the current working directory.` (anchor `imports files outside the current working directory` → `Allow External Imports?`; options `Yes, allow external imports` / `No, disable external imports`) — anchoring the trust prompt on it both missed the real prompt and hijacked that one. Also: model-safeguard fallback body `…safeguards flagged this message…` (anchor `safeguards flagged this message`; options `Switch to <model> and continue` / `Edit prompt and retry with <model>`); theme heading `Choose the text style that looks best with your terminal` (anchor `text style that looks best`); login heading `Select login method:` (anchor `select login method`). Anchors are deliberately multi-word phrases: the scan window includes arbitrary conversation output, and a bare keyword (`trust`, `dark mode`) relabeled unrelated menus whenever the word appeared nearby — the 2026-07-16 "safeguard prompt rendered as Trust This Folder?" bug.
- **Break symptom:** A rewording of any anchored phrase makes that setup prompt fall back to the generic title heuristic, drop out of SETUP_PROMPT_TITLES, and stop surfacing as a PromptCard (menu visible in terminal view only; TrustGate no longer takes over for the trust prompt). Buttons keep working regardless — they send the option's printed number. Worse failure mode, seen 2026-07-26: CC *moves* an anchored sentence to a different dialog, so the anchor silently retargets — check for that when re-verifying, not just for disappearance.

### Hook protocol
- **Files:** `app/src/main/assets/hook-relay.js` (Android), `desktop/src/main/hook-relay.ts` (desktop), `youcoded-core/hooks/hooks-manifest.json`
- **Depends on:** CC's hook event JSON shape (`SessionStart`, `PreToolUse`, `Notification`, etc. — fields `tool_name`, `tool_input`, `session_id`, etc.), CC's `settings.json` hooks schema accepted by the loader
- **Break symptom:** Hooks silently stop firing or fail with cryptic errors; write-guard / worktree-guard / statusline stop functioning.

### Statusline hook payload
- **Files:** `desktop/hook-scripts/statusline.sh`, `app/src/main/assets/statusline.sh`
- **Depends on:** CC's statusline JSON payload fields (`model`, `session_id`, `context_window.remaining_percentage`, `cost.*`, and `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` — added in CC 2.1.80; `resets_at` is Unix epoch **seconds**). The 5-hour / 7-day usage chips and `~/.claude/.usage-cache.json` are fed ONLY by `rate_limits` — the old `usage-fetch.js` (OAuth-token call to Anthropic's usage API) was removed because Anthropic's Claude Code terms forbid third-party apps from using that token, and must not come back.
- **Break symptom:** Status bar goes blank or shows stale values; usage chips never appear (a `rate_limits` rename or a switch of `resets_at` to milliseconds would do this); session-context pill loses model/version info.
- **Also depends on the SCOPE of `context_window.*`, which is not what its field names suggest.** Verified against the shipped binary (2.1.259, 2026-09-03): that whole object is built from ONE request's usage — `total_input_tokens` is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of the current request (the "total" is across the three token KINDS, not across the session), `total_output_tokens` is that request's `output_tokens`, and `current_usage` is that request's raw usage. Only the `cost.*` block accumulates over a session. Two shipped bugs came from assuming otherwise: the Reuse chip double-counted cache reads and could never exceed 50% (youcoded#405), and the In:/Out:/Cached:/Speed: chips presented one request's numbers as session totals — 713 output tokens for a 42-hour session (youcoded#411). **The app no longer takes ANY token count from here**; those come from summed transcript usage. If a future CC release makes these genuinely cumulative, that is an opportunity, not a break.

### Plugin registry four-file format
- **Files:** `desktop/src/main/claude-code-registry.ts`, `app/src/main/.../skills/PluginInstaller.kt`
- **Depends on:** Exact file format of (a) `~/.claude/settings.json` `enabledPlugins` entry key shape `"<id>@<marketplace>": true`, (b) `~/.claude/plugins/installed_plugins.json` v2 entry schema with absolute `installPath`, (c) `~/.claude/plugins/known_marketplaces.json`, (d) `~/.claude/plugins/marketplaces/<marketplace>/.claude-plugin/marketplace.json`
- **Break symptom:** Installed plugins invisible to CC loader; skill marketplace installs report success but `/reload-plugins` shows "0 new plugins".

### MCP configuration schema
- **Files:** `desktop/src/main/mcp-reconciler.ts`
- **Depends on:** CC's MCP-server configuration schema in `~/.claude/mcp.json` or `~/.claude/settings.json` (server entries with `command`, `args`, `env`, and any transport/scope fields owned by Claude Code)
- **Break symptom:** MCP reconciliation writes invalid config; CC refuses to load MCP servers after YouCoded touches the file; silent MCP-server drop-offs.

### Slash commands YouCoded references or intercepts
- **Files:** `desktop/src/renderer/state/slash-command-dispatcher.ts`, `desktop/src/renderer/components/InputBar.tsx`, `desktop/src/renderer/components/ModelPickerPopup.tsx`, `desktop/src/shared/model-ids.ts` (canonical `CLAUDE_ALIASES` list — `StatusBar.tsx` re-exports it as `MODELS`), `desktop/src/renderer/App.tsx` (Shift+Space cycle + `/model ${alias}` send)
- **Depends on:** CC's command names stable across releases (`/model`, `/resume`, `/compact`, `/help`, etc.) AND CC's `/model` accepting the alias strings YouCoded sends — `haiku`, `sonnet`, `opus[1m]`, `fable`. The model picker/cycle writes `/model <alias>\r` into the PTY verbatim.
- **Break symptom:** Session-pill reconciliation mis-detects model drift; user-facing tips reference dead commands; a renamed/removed alias (e.g. `fable`) makes the switch silently fail and surfaces the "couldn't switch" toast.

### Anthropic model ID convention
- **Files:** `desktop/src/shared/model-ids.ts` (`claudeAliasForModelId`, the one matcher), and its readers: `desktop/src/renderer/hooks/useActiveSessionModel.ts` (status-bar pill), `desktop/src/renderer/App.tsx` (`matchModelAlias` + the model-switch verify effect), `desktop/src/renderer/components/ResumeBrowser.tsx` (per-row resume prefill), `desktop/src/main/session-browser.ts` (Resume Browser model chip), `desktop/src/renderer/state/chat-reducer.ts` (per-turn metadata)
- **Depends on:** Dotted-hyphen model ID form (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-fable-5`) served by CC in transcript `message.model`. The alias→ID matcher strips `[...]` then substring-matches (`'claude-fable-5'.includes('fable')`), so the served ID must keep containing the alias substring.
- **Break symptom:** Unknown model IDs render raw in session pill; display-name lookup fails silently.

### `<synthetic>` placeholder on CC-composed assistant lines
- **Files:** `desktop/src/shared/model-ids.ts` (`isPlaceholderModelId`), and its five guards: `desktop/src/main/session-browser.ts` (transcript scan), `desktop/src/main/ipc-handlers.ts` (Conversation Store write), `desktop/src/main/conversations/store-core.ts` (`sanitizeModelRef`, the read-side heal), `desktop/src/renderer/hooks/useActiveSessionModel.ts`, `desktop/src/renderer/components/AssistantTurnBubble.tsx`, `desktop/src/renderer/App.tsx` (model-switch verify)
- **Depends on:** CC stamping `"model": "<synthetic>"` — **in angle brackets** — on assistant lines CC composed itself rather than a model: "You've hit your session limit", "You're out of usage credits", "Please run /login · API Error: 401". The guard matches the bracket SHAPE (`/^<.*>$/`), not the literal string, so any future bracketed sentinel is covered. Verified 2026-08-26 against 2,933 local transcripts: `<synthetic>` is the only bracketed value present, and every API-error assistant line carries it.
- **Break symptom:** If CC switches to an UNBRACKETED sentinel (`synthetic`, `none`, `unknown`), all six guards stop working at once with no test failure, and the placeholder returns as a model name in the Resume Browser chip, the per-turn metadata strip, and the status-bar pill — which also stops self-healing off its `unknown` sentinel. A poisoned value written to the Conversation Store then syncs to every other device and overrides the transcript scan there.

### CLI invocation flags
- **Files:** `desktop/src/main/session-manager.ts`, `app/src/main/.../runtime/PtyBridge.kt`
- **Depends on:** `claude` CLI accepting the flags YouCoded passes at launch (notably `--resume <session-id>` and any default flags in the launch command)
- **Break symptom:** Session resume breaks; PTY spawns fail; new sessions launch in unexpected state.

### `--mcp-config` / `--allowedTools` (the SendUserLink tool in CC sessions)
- **Files:** `desktop/src/main/claude-code-mcp.ts`, `desktop/src/main/session-manager.ts`, `app/src/main/.../runtime/ClaudeCodeMcp.kt`, `app/src/main/.../runtime/PtyBridge.kt`, `app/src/main/assets/send-user-link-mcp.js`
- **Depends on:** three CC behaviours. (1) `--mcp-config <file>` loads extra MCP servers for that session, ADDITIVELY — no `--strict-mcp-config` is passed, so the user's own servers still load. (2) `--allowedTools mcp__youcoded__SendUserLink` pre-approves that one tool without restricting any other. (3) CC names an MCP tool `mcp__{server}__{tool}` — the renderer matches that exact composed string to draw a link tile. Also: the server is a hand-rolled JSON-RPC 2.0 stdio server, so it depends on MCP stdio staying newline-delimited JSON (it answers `initialize`, `ping`, `tools/list`, `tools/call`, and echoes back the client's `protocolVersion`).
- **Break symptom:** Renaming or removing either flag makes every Claude Code session fail to launch (an unknown CLI option is fatal). A change to the `mcp__server__tool` naming, or a protocol-version negotiation CC will not accept, is silent instead: links keep arriving as plain text in the reply and the Deliverables card simply never appears.
- **Verified 2026-09-02** against the installed CLI: `claude -p … --mcp-config ./mcp-config.json --allowedTools mcp__youcoded__SendUserLink` called the tool and returned its exact text, with no permission prompt.

### npm package entry-point layout (Android)
- **Files:** `app/src/main/.../runtime/Bootstrap.kt` (`isFullySetup`, `installClaudeCode`, `selfTest`), `app/src/main/.../runtime/PtyBridge.kt` (launch command)
- **Depends on:** `npm install -g @anthropic-ai/claude-code` producing a JS entry at `lib/node_modules/@anthropic-ai/claude-code/cli.js`, launchable via `linker64 node claude-wrapper.js cli.js`. Claude Code is currently pinned to **2.1.112** — the last release with this layout. Bumping the pin requires migrating Android to the native-binary distribution (2.1.113+).
- **Break symptom:** Bootstrap self-test fails with "Claude Code CLI entry point not found"; even bypassing self-test, PtyBridge launch fails because `cli.js` is absent. Observed in Claude Code 2.1.113 when the npm package was repackaged as a native-binary launcher with `bin/claude.exe` + `install.cjs` + per-platform sibling packages (`@anthropic-ai/claude-code-linux-arm64` etc.).

### Native installer bootstrap script (Desktop)
- **Files:** `desktop/src/main/prerequisite-installer.ts` (`installClaude`)
- **Depends on:** `https://claude.ai/install.ps1` (Windows) and `https://claude.ai/install.sh` (macOS/Linux) URLs continuing to redirect to two-stage bootstrap scripts that (a) download a per-version `claude` binary from `downloads.claude.ai/claude-code-releases/<version>/<platform>/`, and (b) invoke `<binary> install` to register `claude` on PATH (HKCU registry on Windows; `~/.zshrc` / `~/.bashrc` on POSIX). Bootstraps verified non-interactive (no `Read-Host` / `read` prompts), require no admin or sudo, exit 0 on success / 1 on failure, and SHA-verify their downloads. Distinct from the Android entry above — desktop migrated off the npm path; Android still uses npm because the Termux runtime relies on the `cli.js` JS-entry shape. Verified 2026-04-28.
- **Break symptom:** First-run wizard reports "Failed to install Claude Code: <stderr from bootstrap>" or "Claude Code installed but is not on this app's PATH yet — restart YouCoded." Existing-user upgrades unaffected (`installClaude` is dormant when `detectClaude` already finds `claude`). New users on clean machines can't get past the first-run installer step. Likely triggers: (a) Anthropic moves distribution to winget-only / Microsoft Store / a custom URL scheme; (b) bootstrap becomes interactive (adds a `Read-Host` prompt — would hang our `runCommand` invocation); (c) the `<binary> install` subcommand is removed or renamed; (d) Anthropic stops auto-redirecting `claude.ai/install.{ps1,sh}` to `downloads.claude.ai`.
- **Also depends on the install LOCATION** `%USERPROFILE%\.local\bin\claude.exe` (Windows) / `~/.local/bin/claude` (POSIX). `detectClaude` falls back to this absolute path, and `main.ts` startup + `refreshPath()` prepend `~/.local/bin` to the process PATH. Why: the bootstrap does **not** always register that dir on the user PATH — verified 2026-05-30, a real install printed *"Native installation exists but C:\Users\…\.local\bin is not in your PATH"*. If Anthropic changes the install dir, detection + the PATH-prepend silently target the wrong place and a successful install reads as not-installed. Re-confirm the location on each CC version review.
- **Bootstrap download path & file-lock retry:** the bootstrap writes `~/.claude/downloads/claude-<version>-<platform>.exe` with an exclusive `Invoke-WebRequest -OutFile` open and has **no retry of its own**. `installClaude` pre-cleans that dir and retries on sharing-violation ("being used by another process"). If the download dir or filename scheme changes, the pre-clean glob (`claude-*` in `~/.claude/downloads`) needs updating.

### Permission flow messages
- **Files:** `desktop/src/renderer/state/hook-dispatcher.ts`, `desktop/src/renderer/hooks/usePromptDetector.ts`, `desktop/src/renderer/state/chat-reducer.ts`
- **Depends on:** CC's approval-request shape in transcript or hook-relay, matching the IPC message YouCoded constructs for `PERMISSION_REQUEST`
- **Break symptom:** Permission prompts don't appear; approvals never propagate back to CC; tool calls hang in `awaiting-approval`.

### Live Ink select menu while a PermissionRequest hook is held (stray-Enter gates)
- **Files:** `desktop/src/renderer/state/pty-input-gate.ts`, `desktop/src/renderer/hooks/useSubmitConfirmation.ts`, `desktop/src/renderer/components/InputBar.tsx`, `desktop/src/main/session-manager.ts` (`broadcastReloadPlugins` gate), `desktop/src/main/hook-relay.ts` (`hasPendingPermission`), `desktop/src/main/pty-worker.js` (echo-timeout CR suppression)
- **Depends on:** CC keeping its native Ink select menu (permission prompt / AskUserQuestion / ExitPlanMode) LIVE in the PTY while the PermissionRequest hook socket is held open — the hook response preempts the menu, but until then any PTY byte is menu input and a bare `\r` selects the highlighted option. Also depends on empty-input-bar `\r` submits being no-ops. The gates defer automated PTY writes (submit-retry nudge, chat sends, `/reload-plugins` broadcast) while a request is pending.
- **Break symptom:** If a CC version stops showing the TUI menu while the hook blocks (gates become over-cautious but harmless) or starts treating stray bytes differently, revisit. If YouCoded ever regresses the gates: AskUserQuestion answers itself with the highlighted option, permission prompts auto-approve, and user text typed during a prompt vanishes — the 2026-07-09 investigation signature.

### Prompt suggestion (force-disabled by app)
- **Files:** `desktop/src/main/disable-prompt-suggestion.ts`, `app/src/main/kotlin/com/youcoded/app/runtime/PromptSuggestionDisabler.kt`, wired in `desktop/src/main/main.ts` (after `reconcileHooks`) and `app/src/main/.../runtime/SessionService.kt` (after the HookReconciler block).
- **Depends on:** CC honouring the `promptSuggestionEnabled: false` setting in `~/.claude/settings.json`. CC v2.1.x ships an opt-out next-prompt suggestion (system prompt: `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]`) that pre-fills ghost text into the input bar; in terminal view Tab / Right Arrow promotes it to real input. Default is enabled (and GrowthBook-gated for initial enablement). YouCoded force-writes the key to `false` on every launch because the ghost text concatenates with our chat→PTY writes and submits on the trailing CR — see `docs/PITFALLS.md → PTY Writes`. Empirical baseline: CC 2.1.143 (May 2026 — v1.2.4 release review confirmed the `promptSuggestionEnabled` key is unchanged across CC 2.1.126→2.1.143 and `disable-prompt-suggestion.test.ts` is green).
- **Break symptom:** If CC renames or removes the `promptSuggestionEnabled` key, the launch-time enforcer becomes a no-op (writes a key CC ignores) and the chat→PTY auto-send-of-suggestion bug returns. Detection: a chat send that the user did not type ends up in the user-message timeline. Mitigation when it triggers: re-investigate against the new CC binary (the original binary-string analysis is in the chat history that produced `2026-05-04`'s `chore/disable-prompt-suggestion` commit).

### Transcript retention (cleanupPeriodDays)
- **Files:** `desktop/src/main/retention-default.ts` (wired in `desktop/src/main/main.ts` after the prompt-suggestion block), `app/src/main/kotlin/com/youcoded/app/runtime/RetentionDefault.kt` (wired in `SessionService.kt` after the PromptSuggestionDisabler call).
- **Depends on:** CC honouring the `cleanupPeriodDays` setting in `~/.claude/settings.json`, and CC's built-in default of **30 days** when the key is unset — CC deletes transcript JSONLs older than the period. YouCoded seeds `cleanupPeriodDays: 365` ONLY when the key is absent (an explicit user value is never overwritten; a corrupt settings.json is never rewritten). Motivation: the 2026-06-12 investigation found 221 named conversations deleted locally by the unset-default cleanup — the Resume Browser lists from these files, so the CC default silently destroys chat history.
- **Break symptom:** If CC renames the key or changes deletion semantics, the seeding becomes a no-op and conversations older than CC's default window silently vanish from the Resume Browser again. Detection: `~/.claude/projects/` shows a sharp age cliff (no transcripts older than ~30 days) despite the seeded setting.

### Session-id rotation semantics (/clear vs --resume vs /compact)
- **Files:** `desktop/src/main/session-id-mapping.ts` (`resolveMappingAction`), the `hookRelay.on('hook-event')` listener in `desktop/src/main/ipc-handlers.ts`
- **Depends on:** Three empirically-verified CC behaviors (2026-06-12, CC ~2.1.14x): (1) `/clear` rotates the session id mid-PTY and fires a `SessionStart` hook with the new `session_id`; (2) `claude --resume <id>` does NOT rotate — it appends the same JSONL under the same id; (3) `/compact` rewrites the SAME transcript file without rotating the id (the transcript-shrink machinery depends on this). The sessionIdMap remap is gated to SessionStart events only, and assumes a rotated transcript starts EMPTY.
- **ALSO depends on the SessionStart `source` field (added 2026-07-26):** CC tags each `SessionStart` hook payload with `source` ∈ `startup | resume | clear | compact` (visible in transcripts as `SessionStart:<source>`; all four observed in the wild). `resolveMappingAction` refuses a REMAP whose source is `startup`, because on an already-mapped desktop session that can only be a FOREIGN `claude` process announcing itself — `CLAUDE_DESKTOP_SESSION_ID` is inherited by every descendant of the PTY, so any nested `claude` run reports our desktop id with its own session id. The read is **fail-open**: a missing or unrecognized `source` falls back to the pre-2026-07-26 behavior (adopt).
- **Break symptom:** If a CC version starts rotating ids on resume or compact, or rotates onto a non-empty transcript, the remap's offset-0 replay would append into an already-populated chat timeline (duplicated bubbles), and close-time flags could land on the wrong session id. If CC stops firing SessionStart on /clear, post-/clear flags/topics regress to landing on the pre-/clear id. If CC **drops or renames `source`**, the guard silently stops refusing foreign `startup` remaps and the 2026-07-26 bug returns: an unrelated conversation replays into the chat view while the terminal stays correct. Detection for all of these: `~/.claude/desktop.log` grep for `SessionMap` — `refused session-id remap` (guard firing) and `remapping session id` (remap accepted).

### Resume Browser transcript head/tail parse
- **Files:** `desktop/src/main/session-browser.ts` (`readTranscriptMeta`), `app/src/main/kotlin/com/youcoded/app/runtime/SessionBrowser.kt` (`readTranscriptMeta`)
- **Depends on:** The transcript JSONL line shape — `type`, `isMeta`, `promptId`, `timestamp` (ISO-8601), and `message.content` (string or text-block array) — the same upstream contract the transcript-watcher parses. The Resume Browser derives fallback session titles from the first real user prompt (bounded 256KB head read) and orders sessions by the last line's `timestamp` (bounded 64KB tail read) instead of sync-clobbered file mtimes. Also skips injected wrapper lines whose text starts with `<` (`<command-name>`, `<local-command-stdout>`, `<system-reminder>`).
- **Break symptom:** If CC renames `promptId`/`timestamp` or changes the content-block shape, fallback titles degrade to "Untitled" and ordering falls back to file mtimes (graceful — never a wrong title, just a missing one). If CC changes its injected-wrapper tags to something not starting with `<`, plumbing text could leak into derived titles.

### JSONL transcript file location
- **Files:** `desktop/src/main/transcript-watcher.ts`
- **Depends on:** Transcript files written at `~/.claude/projects/<encoded-cwd-path>/*.jsonl` with CC's path-encoding scheme
- **Break symptom:** Transcript watcher watches the wrong directory; chat UI silent for all sessions.

### CC built-in command list
- **Files:** `desktop/src/main/cc-builtin-commands.ts`, `app/src/main/kotlin/com/youcoded/app/runtime/CommandProvider.kt` (the `CC_BUILTIN_COMMANDS` companion block)
- **Depends on:** Claude Code's set of built-in slash commands — names and behaviors baked into the compiled `claude` binary. These lists are hand-maintained; the SDK init message's `slash_commands` array omits core meta commands so automated discovery is not viable. Both files carry a version-anchor comment ("Last verified against Claude Code CLI vX.Y.Z — DATE") at the top.
- **Break symptom:** New CC built-ins don't appear in the YouCoded CommandDrawer search. Removed CC built-ins still appear but remain unclickable with a "Run in Terminal View" note, so user impact is minor (they don't work when the user follows that hint in Terminal View). Renamed built-ins show with their old name.

### claude --version output format
- **Files:** `youcoded-admin/skills/release/SKILL.md` (Phase 4 Step 3 and Step 2 baseline-line injection)
- **Depends on:** `claude --version` output containing a parseable `\d+(\.\d+)+` substring
- **Break symptom:** Release skill's CC version capture fails; baseline line not written; next release's `review-cc-changes` agent exits with the "no baseline" notice.

### claude -p stdin mode (Settings → Development summarizer)
- **Files:** `desktop/src/main/dev-tools.ts` (`summarizeIssue`), `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` (`dev:summarize-issue` case)
- **Depends on:** `claude -p` accepting the prompt on stdin (no positional arg) and emitting a parseable JSON envelope on stdout. Reuses the user's Claude Code OAuth token automatically — no separate auth.
- **Break symptom:** Bug-report summarizer degrades to fallback envelope (renderer shows raw description with "Summary unavailable" note). Submission still works, but maintainers see a less-useful issue body. Failure is silent — the user never sees an error.

### gh CLI (Settings → Development bug-report submission)
- **Files:** `desktop/src/main/dev-tools.ts` (`submitIssue`, `isGhAuthenticated`), `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` (`dev:submit-issue` case)
- **Depends on:** `gh auth status` exiting non-zero when the user isn't logged in; `gh issue create --repo … --title … --body-file … --label …` writing the created-issue URL to stdout on success and exiting non-zero on failure; the `--label` flag rejecting unknown labels (which is why `bug`, `enhancement`, `youcoded-app:reported` must pre-exist on `itsdestin/youcoded`). Note: this is `gh` CLI, not Claude Code itself, but it shares the same pattern of "behavior we shell out to and parse" so it lives here.
- **Break symptom:** Issue submission silently falls back to the URL-prefill path (browser opens with prefilled fields) on every call when the auth-check exit code or `issue create` stdout format changes. User can still submit manually in the browser; YouCoded just stops doing it for them.

### Task tool result strings (Open Tasks chip)
- **Files:** `desktop/src/renderer/state/task-state.ts` (`parseTaskCreateResult`, `parseTaskListResult`)
- **Depends on:** Two CC-emitted result strings parsed by the Open Tasks chip data layer. (1) `TaskCreate` response: `"Task #<N> created successfully: <subject>"` — the numeric id is only in this string, not in the tool input. (2) `TaskList` response: newline-separated rows matching `^#<N> \[(pending|in_progress|completed)\] (?:Task \d+: )?<subject>$` — authoritative per-session snapshot.
- **Break symptom:** Open Tasks chip and popup lose visibility into newly-created tasks (they still appear after a subsequent `TaskUpdate` that carries `taskId` directly). If TaskList format changes, the `buildTasksById` authoritative-snapshot path silently stops reconciling status — chip counts drift from what `TaskList` reports until the user triggers an explicit TaskUpdate. Parsers return `null`/`[]` on mismatch, so no render crash — just silent data gaps.

### Android attention classifier

- **What:** `useAttentionClassifier` (renderer) runs on standalone Android by reading screen text via `window.claude.terminal.getScreenText`, which routes to `PtyBridge.readScreenText()` on the Android side. Classifier regex in `classifyBuffer` matches Claude Code CLI spinner glyphs (✻✽✢✳✶*⏺◉·) followed by `<Gerund>…`. The seconds-counter / "esc to interrupt" / "esc to cancel" markers were removed in the 2026-04-26 audit because CC v2.1.119 no longer emits any of them.
- **CC-coupled files:**
  - `desktop/src/renderer/state/attention-classifier.ts` (patterns)
  - `desktop/src/renderer/hooks/useAttentionClassifier.ts` (tick logic)
  - `desktop/tests/attention-classifier-parity.test.ts` + `shared-fixtures/attention-classifier/` (regression coverage)
- **Why coupled:** Patterns must match Claude Code's CLI output. Visual changes to the Ink UI (spinner glyph, prompt copy, error banner color) can break classification silently.
- **Review trigger:** Any Claude Code CHANGELOG entry mentioning TUI / Ink / prompt / spinner / progress updates.

### Terminal rendering surface (Tier 2)

- **What:** xterm.js (in the React WebView) is the sole terminal renderer on both platforms. Bytes flow desktop pty:output (string) → xterm; Android pty:raw-bytes (base64 → Uint8Array) → xterm. The `TerminalView` component is shared — touch platforms run with `disableStdin: true` and consume `pty:raw-bytes` via `usePtyRawBytes`; desktop runs unchanged.
- **CC-coupled files:**
  - `desktop/src/renderer/components/TerminalView.tsx` (renderer)
  - `desktop/src/renderer/hooks/usePtyRawBytes.ts` (Android byte consumer)
  - `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` (`launchRawByteBroadcast`)
  - `terminal-emulator-vendored/` (Termux v0.118.1 + RawByteListener patch)
- **Why coupled:** xterm renders Claude Code's TUI byte stream verbatim. Any CC change that re-ANSI-encodes the TUI differently (e.g. switches Ink to alternate-screen mode `\e[?1049h`, changes how it clears screen / scrolls regions, or starts using sequences xterm doesn't support) affects what users see — including the known-issue scrollback duplication when CC redraws the full TUI. CC switching to alt-screen would actually FIX the scrollback duplication, but would break our `terminal:get-screen-text` IPC if we relied on the main-screen buffer.
- **Review trigger:** CC CHANGELOG entries mentioning terminal rendering, alt-screen, scroll regions, ANSI escape sequence usage, or TUI redraw strategy.

### TranscriptWatcher Write/Edit/Delete event consumption (Desktop + Android)

- **Files:** `desktop/src/renderer/state/artifact-tracker.ts` (Artifact Tracker renderer-side state), `desktop/src/main/ipc-handlers.ts` (file I/O dispatcher), `app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt` (Android bridge handlers)
- **Depends on:** TranscriptWatcher emitting `TRANSCRIPT_TOOL_USE` events for every Write/Edit/MultiEdit tool call CC makes, and the `args` object in each event containing either `file_path` or `path` as a top-level string field identifying the target file.
- **Break symptom:** Artifact Tracker subscribes to `TRANSCRIPT_TOOL_USE` but the filter matching tool names (`tool === 'Write' | 'Edit' | 'MultiEdit'`) sees no matches because CC renamed the tools. The Session Drawer artifact list stays empty even as Claude edits files. External manifestation: user asks "why aren't my edits showing up in the drawer?" and sees a blank list despite successful file operations in the terminal.
- **Detection:** Smoke test by asking Claude to write/edit a file in a session and confirming it appears in the Session Drawer within 1 second. If not, check the tool call in the JSONL transcript and compare the tool names in the Tracker's filter against what CC actually emitted.
- **Review trigger:** CC CHANGELOG entries renaming or retiring Write/Edit/Delete/MultiEdit tools, or changing the `args` shape for file-path parameters in these tools.

### Project View context discovery (Desktop)

- **What:** The Project View Context tab surfaces the agent-context files that shape Claude's behavior in a project. `desktop/src/main/project-context.ts` (+ the pure mapper `desktop/src/main/project/context-discovery.ts`) discovers them by reading Claude Code's on-disk conventions, and `desktop/src/main/project-conversations.ts` lists a project's past sessions by mapping its path to CC's project-slug directory.
- **CC-coupled files:**
  - `desktop/src/main/project-context.ts` — reads project + global `CLAUDE.md`/`AGENTS.md`, `.claude/rules/*.md` (frontmatter `globs:`), and `~/.claude/projects/<slug>/memory/` (`MEMORY.md` index + per-fact notes)
  - `desktop/src/main/project/context-discovery.ts` — pure mapper that classifies each file's load timing
  - `desktop/src/main/project-conversations.ts` — uses `ccProjectSlug` to filter `listPastSessions()` to one project, and `loadHistory()` to read JSONL transcripts for the no-launch preview
  - `desktop/src/shared/project-context-types.ts` — `RECOGNIZED_INSTRUCTION_FILES` (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`)
- **Depends on CC's:** project-slug directory layout (`~/.claude/projects/<slug>/`, encoded by `ccProjectSlug` — `cwdToProjectSlug` was the old four-character mirror, deleted by the 2026-08-11 slug-encoding-repair; see the dedicated coupling entry below); the `CLAUDE.md` / `.claude/rules/` instruction-file + project-memory conventions; the `memory/MEMORY.md` index format; and the JSONL transcript shape consumed by `loadHistory` (already covered by the JSONL transcript-location entry above).
- **Break symptom:** If CC changes the slug encoding, the Context tab shows no memory and the Conversations tab shows no sessions for a project (slug points at a non-existent dir). If CC relocates project memory or changes the instruction-file discovery (e.g. stops reading root `CLAUDE.md`), the Context tab's grouping no longer reflects what actually loads into Claude — the teaching layer silently lies.
- **Review trigger:** CC CHANGELOG entries touching `~/.claude/projects/` layout, memory storage/recall, `CLAUDE.md`/`AGENTS.md`/rules discovery, or the slug-encoding scheme.

### Project-dir slug encoding (Desktop + Android)
- **Files:** `desktop/src/main/slug-encoding.ts` (`ccProjectSlug`), `app/.../runtime/CcProjectSlug.kt`
- **Depends on:** Mirrors CC 2.1.228's `~/.claude/projects/<slug>/` encoding bug-for-bug — every `[^a-zA-Z0-9]` → `-`, slugs over 200 chars truncated and suffixed with `base36(abs(rolling hash of the ORIGINAL path))`. Recovered from the shipped 2.1.228 binary; anchored to `desktop/tests/fixtures/cc-slug-pairs.json` (harvested + probed real `(cwd → directory)` pairs, `ccVersion: "2.1.229"`) — the rule was recovered from the 2.1.228 binary and the fixtures were independently regenerated against 2.1.229; behavior is identical across both versions.
- **Break symptom:** If CC changes the encoding (character class, the 200-char cap, or the hash function), every touchpoint that derives a `~/.claude/projects/<slug>/` path from a cwd silently points at a directory CC never writes — chat view, project memory, conversation sync, and resume all go dark for affected projects. See "Project View context discovery" above for the full call-site list on desktop.
- **Review trigger:** CC CHANGELOG entries touching `~/.claude/projects/` layout or the slug-encoding scheme. On a bump, re-run the spec §8 probe; if any fixture pair changes, update both mirrors (`slug-encoding.ts` + `CcProjectSlug.kt`) and the fixture file together.

### Hook payload `transcript_path`/`cwd` (Desktop + Android)
- **Files:** `desktop/src/main/ipc-handlers.ts` (`hookRelay.on('hook-event')` SessionStart handler), `app/src/main/kotlin/com/youcoded/app/parser/EventBridge.kt`, `app/.../runtime/SyncService.kt` (`pushSession`)
- **Depends on:** `transcript_path` and `cwd` are REQUIRED fields of CC's hook JSON schema (`transcript_path:O(),cwd:O()` in the shipped bundle) and are consumed VERBATIM — no re-derivation. `cwd` is CC's own post-realpath/post-chdir value (the exact string it slugged), so consuming it directly dissolves the symlink hazard the slug mirror would otherwise have to handle. `transcript_path` lets the desktop watcher and Android's `pushSession` skip slug derivation entirely for the life-or-death chat-rendering path (spec §5.0).
- **Break symptom:** If CC drops either field or changes its shape (e.g. relative instead of absolute `transcript_path`), the watcher/store fall back to slug derivation (desktop) or fail silently (Android `pushSession` returns early when the derived path doesn't exist) — chat view goes dark or session-end sync stops uploading, with no error surfaced.
- **Review trigger:** CC CHANGELOG entries touching the hook payload schema, `SessionStart` fields, or `transcript_path`/`cwd` semantics.
