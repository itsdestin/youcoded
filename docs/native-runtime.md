> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rule in youcoded-dev/.claude/rules/native-runtime.md is the terse always-injected layer; this doc is the depth.

# Multi-model native runtime — depth

`SessionProvider = 'claude' | 'native' | 'shell'`. The third member arrived 2026-09-05 with the local engine's set-up flow: a `'shell'` session is a plain terminal running the user's own `$SHELL` (`powershell.exe` on Windows) with **no AI in it at all** — no hook pipe, no transcript watcher, no model, no binding. It exists so the app can offer "Run in terminal" for a set-up command (`engine:run-in-terminal`, minted only by `prepareRunInTerminal` in `session-manager.ts`) instead of sending the user off to find a terminal. It is never offered in the new-session form, but the button SELECTS the session it makes, so every renderer branch that reads a provider can see it. The native runtime is a cloud-first + local slice layered so a native session emits the exact `TranscriptEventType` shapes CC does, letting the shared chat reducer/UI render it unchanged. `native.supported=true` in production as of 2026-07-16 (env kill switch: `YOUCODED_NATIVE=0`) — known Phase 2 Plan B/C gaps still apply (see roadmap spec). Modules: `desktop/src/main/harness/`, `desktop/src/main/providers/`, `native-home.ts`, `desktop/src/renderer/components/native-send.ts`. Governing specs: `docs/active/specs/2026-07-09-platform-vision-roadmap.md`, the archived phase0/phase1 design docs, ADRs 006–010. Empirical couplings: `youcoded/docs/provider-dependencies.md`.

## Provider seam (Phase 0, PR #115)

- **`'native'` has NO runtime in Phase 0.** `SessionManager.createSession` throws loudly for any non-claude provider — a deliberate guard so a stray native create (e.g. from a remote client payload) fails instead of spawning a broken PTY. Phase 1 branches BEFORE the PTY worker spawn.
- **`window.claude.native.supported` is the ONLY gate** (no settings flag, decided 2026-07-10). preload computes it as `true` by default since 2026-07-16 (`YOUCODED_NATIVE=0` is the kill switch); remote-shim still hardcodes `false` (remote/Providers-UI parity gap not yet reconciled — see Plan A note below); shape parity pinned in `ipc-channels.test.ts` ("native runtime capability parity"). It is a plain boolean, NOT an IPC channel — no ipc-handlers/SessionService.kt row exists on purpose.
- **Sandboxed preload DOES have `process.env`** (verified empirically 2026-07-10 against the built preload in a production-identical sandboxed window). The sandbox blocks module imports, not Electron's polyfilled `process`.
- **The Runtime selector** (`Claude Code | YouCoded`) renders in the new-session form ONLY when `native.supported`; the YouCoded option is disabled until Phase 1; `handleCreate` is hardwired to `'claude'` — wiring the selector into create is a Phase 1 task.
- **Reasoning segments are dormant on the CC path — don't "light them up" casually.** `assistant-thinking` events WITH `data.text` dispatch `TRANSCRIPT_ASSISTANT_REASONING` (per-token deltas merged by `partId` — UNLIKE the text path, which appends whole blocks); payload-less events remain heartbeats. CC's transcript-watcher emits `data:{}`, so no CC user sees the disclosure today. Making the watcher emit thinking text needs a parity-fixture update AND a UX decision first. App.tsx and BubbleFeed.tsx MUST use the identical predicate (`event.data?.text` truthiness) — divergence puts main and buddy windows out of sync.
- **Phase 1 must route chat-view PTY send paths through the harness for native sessions.** Cataloged in PR #115's body: InputBar send, `guardedPtySend`, ESC interrupt, `useSubmitConfirmation` retry, ChatView Ink-menu keys, ToolCard permission keys, TrustGate, BubbleFeed send; also gate the Shift+Tab permission-cycle handler; subagent reasoning needs `parentAgentToolUseId` routing in the reasoning reducer case.
- **`feat/opencode-mvp` is ARCHIVED, not dead** — `OPENCODE-MVP-ARCHIVED.md` on that branch lists what Phase 1/2 should mine (event-translation patterns, subprocess supervision + tests, OllamaDetector, capability probe). Do not merge it; do not delete it.

## Native chat sessions (Plan A, merged 2026-07-13, youcoded master `e964a5cc`, PR #119)

Cloud-first slice: `~/.youcoded/` home, provider registry + keychain keys, `HarnessSession` v0 (streamText, no tools), native session store + resume, provider-aware send routing, Providers settings panel. `native.supported` is `true` in production as of 2026-07-16 (see above); Phase 2 Plan B/C (web tools, AskUserQuestion, presets, local reliability, compaction, StatusBar usage bridge) are still in flight — see the platform vision roadmap spec for current status.

- **API-key storage** — `safeStorage`-encrypted in `userData/native-secrets.json`, NEVER in `~/.youcoded/`. `providers.json` holds only a `secretRef`. `SecretsStore` encrypts BEFORE the file write (no path can serialize plaintext) and refuses to store keys when `safeStorage.isEncryptionAvailable()` is false — no plaintext fallback. `list()` never returns key material. Machine-bound ciphertext must not enter a syncable home; per-profile `userData` is deliberate.
- **`NativeHome` write path** — all `~/.youcoded/` JSON writes go through `mutateFileUnderLock`; it THROWS on lock exhaustion, never silently drops (dev + built app share the home — same cross-process race as the artifact index). `readJson` absorbs ENOENT only and rethrows other I/O errors. `readSessionHead` (256KB bounded head-read) is what `list()` uses so a huge session file can't throw-then-vanish from the Resume Browser; `readSessionLines` (full read) is only for replay.
- **`SessionStore` delta coalescing** — same-`partId` `assistant-text`/`assistant-thinking` deltas coalesce into ONE persisted event before disk (~50× smaller; replay reproduces the identical merged reducer segment). **Display-only is a family, not a single event, and the filter is structural.** `SessionStore.append` drops (a) `session-error`, and (b) any `assistant-thinking` carrying **neither `text` nor `partId`** — which is what keeps `stallWarning`, `promptProcessing`, and `toolPreparing` (streaming tool-argument progress, the preparing-tool-card feed) off disk. Because the filter keys on the *absence* of those two fields rather than on a payload name, **adding `text` or `partId` to any of those payloads silently starts persisting it** — that is the regression shape to watch for, not a forgotten allow-list entry. The two halves differ on flushing: `session-error` IS a turn boundary and flushes the open streaming part first (a stale error banner on resume would be wrong); the heartbeats are NOT boundaries and must leave the open part buffered, since the stream may resume the same `partId`. Guard: `session-store.test.ts` pins both halves, including a `toolPreparing` case asserting the surrounding deltas still coalesce into one event. `SessionStore.append()` and `HarnessSession.send()` both require the CALLER to serialize per session — `NativeSessionHost` enforces a per-session append promise chain (forward-to-renderer is synchronous and NOT gated on the disk write); HarnessSession hard-throws on a re-entrant `send()`.
- **`NativeSessionHost` lifecycle** — `send()` still never throws; it now returns a `NativeSendResult` synchronously (`{status:'sent'|'queued'}` or `{status:'failed', reason}`) instead of blocking on the turn. `'sent'` means dispatched, not completed — turn failures arrive later as `session-error` events, not as a rejected call. The dispatch is deferred one `setImmediate` so the invoke ack reaches the renderer before the `user-message` event does (ordering the UI depends on). `destroy()` order is load-bearing: `session.destroy()` (abort + removeAllListeners — synchronous, this stops re-enqueue, NOT the map delete) → await the append chain → `store.dispose()` (flush open part) → `live.delete`. App-quit calls `destroyAll()` (best-effort flush; bounded to one in-flight part).
- **Step limits are explicit snapshots, never model guesses.** `HarnessSession` applies the existing `max_steps` continuation ask only when its manifest has `limits.maxSteps`. For an ordinary root, `NativeSessionHost` reads `native.stepGuard` once at fresh creation, persists that normalized value in `NativeSessionHeader.stepGuard`, and resumes from the header only; changing Settings cannot alter an existing session, and an old header means no guard. Specialist children continue to use their definition-owned `stepCap`; evaluator runs explicitly use `maxSteps: 100`. There is no model-name or model-tier fallback.
- **`quiesce(id)` (M2) is a SEPARATE, STRONGER teardown than `interrupt()` — cross-device takeover only, never the Stop button.** `interrupt()` aborts only the in-flight turn and leaves the M1 send queue draining (a queued message starts a new turn right after). `quiesce()` additionally clears the queue synchronously, awaits one macrotask (lets a same-tick `send()` finish its deferred dispatch before the abort), and awaits the turn settling + append chain — its postcondition is "no further appends until a new `send()`", which a cross-device transcript flush depends on. `createHolderTakeover` (conversations/takeover.ts) branches to it for a native holder instead of sending the ESC byte. Depth + full 5-step order: `docs/conversations.md` → "Native provider participation".
- **M1 send queue** — per-session FIFO capped at `SEND_QUEUE_LIMIT` (10) in the host; drains ONLY on the dispatched `send()`'s turn settling, one queued message per drain step. Interrupt aborts the current turn only — the queue is untouched and still drains after. Past the cap, `send()` refuses honestly (`{status:'failed', reason:'queue-full'}`) rather than silently accepting. Pinned: `native-session-host.test.ts` "send queue (M1)" block.
- **`native:send` is an `ipcMain.handle` invoke on ALL transports** (desktop IPC and remote WS) over the SAME transcript-event pipe CC uses — same `NativeSendResult` shape either side, no throw-vs-`{ok:false}` divergence (contrast the provider IPC parity gap above). Emits `user-message`/`assistant-text`/`assistant-thinking`/`turn-complete`/`user-interrupt`/`session-error`, forwarded via `sendForSession(…, IPC.TRANSCRIPT_EVENT, …)` + `remoteServer.broadcast`. `TRANSCRIPT_REPLAY` falls through `nativeHost.getHistory(id) ?? transcriptWatcher.getHistory(id)`.
- **Renderer send branch** — `sendChatMessage` (`native-send.ts`): native → `window.claude.native.send(sessionId, text)` with NO `\r`, no 56-byte chunking, no echo wait, no `FILE_GAP_MS` paste timing, no `hasPendingInteraction` gate. **The native send string MUST equal `buildOutgoingMessage(...).content`** or the optimistic USER_PROMPT bubble never dedups (permanent pending bubble). ESC → `native.interrupt`. `useSubmitConfirmation` is gated OFF for native. The entire claude/PTY path is byte-unchanged below the native early-return.
- **`createSession` native branch** builds NO PTY worker (`ManagedSession.worker` is now optional — guard every `session.worker.X`). Requires a `binding` UNLESS `resumeSessionId` is set (resume reads the binding from the stored header). On a resume whose stored header is gone, `SESSION_CREATE` emits a `session-error` event so the user gets the banner, not a silent empty chat.
- **Provider IPC error semantics differ by transport** (latent parity gap, reconcile before Phase 2 ungates the Providers UI on remote): desktop `ipcMain.handle` THROWS → renderer promise REJECTS; remote WS resolves `{ok:false, error}`. `ProvidersSection`'s `safeProviders` normalizes BOTH into a thrown error for one try/catch — except `test()`, where `ok:false` is a real result to display. preload passes provider args positionally; remote-shim wraps them as objects (`{id}`, `{id,key}`).
- **AI SDK is v7** (`ai@7`, `@ai-sdk/openai-compatible@3`, first-party `@ai-sdk/anthropic|openai|google@4`, explicit `zod`). `streamText().fullStream` parts carry the chunk in `part.text` (NOT `part.delta` — the raw provider-level field); usage via `result.usage` (`totalUsage` deprecated); mock is `MockLanguageModelV4` from `ai/test`. `HarnessSession` maps SDK usage → the fixed transcript `usage` shape `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, tokensPerSecond}` (native adds `tokensPerSecond` from stream timing — CC never reports it).
- **`ModelCatalog` (models.dev + OpenRouter, 24h disk cache in `userData`) re-stamps `fetchedAt` ONLY when BOTH sources succeed** — a partial refresh keeps the expired stamp so the next call retries the dead source (else a first-fetch with one source down freezes an empty picker for 24h). Pricing is gated on a non-empty STRING before `Number()` (`Number(null)`/`Number('')` are 0 → would map JSON-null to "free").

## Conversation store, resume & auto-title participation (Plan M2, 2026-07-22)

Native sessions now write through the same Conversation Store (`conversations/service.ts`) CC sessions use, riding `sessionProvider='native'`. Full invariants (lane assertion, `PortableModelRef`, meta-write buffering) live in `docs/conversations.md` → "Native provider participation"; this is the native-runtime-specific surface.

- **`session:get-meta`/`session:browse` are provider-aware on desktop IPC and the remote WS** — the 2026-07-19 hardcoded native refusal is retired. The renderer sentinel string survives the rename `NATIVE_META_UNSUPPORTED` → `META_UNSUPPORTED_FALLBACK` (still exercised by the Android stub below) rather than being deleted, so no renderer branch needed to change.
- **Resume ALWAYS offers the unified `ModelPicker` (`components/model/ModelPicker.tsx`, which replaced `NativeModelSelect`), pre-filled from the stored record's `lastUsedModel`.** This holds from every native-resume entry point (inline ResumeBrowser, MovedGate's `onResume`, ProjectView's `onResumeConversation` — the latter two pre-existing 3-arg callers wired through App.tsx's `pendingNativeResume` modal). The selection is applied as `resume(id, cwd, bindingOverride?)`'s `bindingOverride`, which wins over the stored header's binding, and is applied BEFORE the eager transcript load so the UI never flashes the stale binding.
- **Naming (`session-namer.ts`, 2026-09-09) is shared with the CC lane** and replaced `native-title-feeder.ts`. A native session's reviews use the separately chosen naming model if there is one, else the session's own bound model (`providerRegistry.languageModel` + `generateText`, 15s abort, 3 attempts per review, synchronous in-flight guard), on the Off/Basic/AI policy in `naming-settings.ts`. It writes through the store's title path exactly like a CC auto-title and never touches the native session's own JSONL — titles are store-only metadata, not part of the replay log. Name ownership and the review schedule live in a separate synced sidecar: `docs/conversations.md` → Session name ownership.
- **Takeover quiesces instead of interrupting** — see the `quiesce(id)` bullet above. The native session lease acquire (SessionStart-equivalent for native) is re-enabled behind `isSyncSpacesEnabled()` with warn-on-denied, mirroring the CC lease-acquire path; `pushMoved` now carries `provider` so the requester's resume flow launches the correct runtime.
- **Android has none of this.** No Android Kotlin code reads the Conversation Store, `~/.youcoded/`, or `lastUsedModel` — native provider support is desktop-only as of M2 (Android's `session:browse`/`get-meta` still answer from the legacy `~/.claude/conversation-index.json` + local project scan only; see `SessionService.kt`).
> **Backfill gap:** Phase 2 Plan A (agent loop + core tools + permissions, PR #149) and Plan B (web tools + AskUser + presets, PR #156) NARRATIVE depth is NOT yet written here — this doc skips from Phase 1 straight to M2 and Plan C. The backfill item was closed 2026-09-01 (workspace `docs/roadmap/shipped.md`): the two rule-overflow sections below are what exists; a fuller walkthrough was never written. The section below carries the Plan A/B rule bullets' depth verbatim, migrated 2026-08-12 when the path-scoped rule was trimmed to its word budget (and split into `native-runtime.md` + `harness-tools.md` in `youcoded-dev/.claude/rules/`); it is the rule-overflow layer, not the full backfill.

## Agent loop, core tools & permissions (Plan A) — rule overflow (2026-08-12)

- **HarnessSession's emit surface is FROZEN** — the tool loop only emits existing `TranscriptEventType` values; new loop states MUST map onto existing events (max_steps/doom_loop are permission asks, NOT new event types). *Why:* the chat reducer/UI render native and CC through one pipe — a new event type is dead on arrival. Guard: `harness-session-loop.test.ts` + `harness-sdk-toolcall-contract.test.ts`.
- **Permission precedence is two-tier:** tool-layer guards (secret paths, `external_directory`) sit BELOW all configuration and never yield; the destructive deny-list is CONFIG — an explicit remembered Always-allow beats it (by design, consequence-gated in UI, surfaced via the `denyListed` flag on the ask). Guard: `permission-engine.test.ts`.
- **`external_directory` costs a card for WRITES ONLY** (2026-09-05). A path outside the session cwd still returns the `'external'` verdict, but `harness-session.ts` charges it only to Write/Edit; Read/Grep/Glob run with no ask in every permission mode, Ask First included. *Why:* reading changes nothing, and the line above means Bash could already `cat` the same bytes with no card — the prompt only ever taxed the polite tools. Secret-path hard-denies are unaffected and still absolute. Set: `READ_ONLY_PATH_TOOLS`. Guard: `harness-session-loop.test.ts` → "reads outside the workspace never ask".
- **A URL is not a path.** `WebSearch`/`WebFetch` are in `NON_PATH_SUBJECT_TOOLS`, so their subjects never reach `checkPathGuard`. Before 2026-09-05 they did, and a URL ending in a credential-looking segment (`/.env.example`) was refused as "a credential or secret file" — a wrong cause in a user-facing error. Guard: `harness-session-loop.test.ts` → "WebFetch: a URL that ends in a credential-looking name is not path-guarded".
- **The Bash tool bypasses the file-tool guards** — secret-path denial and the cwd jail live in the file tools; `cat .env` through Bash defeats them, and the command-glob deny-list can't catch every phrasing. ACCEPTED limitation (CC has the same hole); the guards are honest friction, not a sandbox. Don't present them as a security boundary, and don't try to glob your way to one. (Migrated from workspace `docs/PITFALLS.md`.)
- **`PERMISSION_RESPOND` routes by `native-` id prefix** — native ask ids are `native-`-prefixed so the handler tries `nativeHost.respondPermission(requestId, …)` FIRST, then falls through to `hookRelay.respond` (which may be absent in native-only sessions). Don't collapse the two brokers into one. Verify: `src/main/ipc-handlers.ts` (`respondPermission` before `hookRelay`).
- **The serialization contract now also covers ask-pauses** — `HarnessSession.send()` still hard-throws when a turn is in flight, but an ask PAUSES the turn, it does NOT end it: the same in-flight turn resumes on `respondPermission`. Callers must not re-`send()` while an ask is open. Guard: `harness-session-loop.test.ts` (canceled-ask regression). **One carve-out since 2026-08-13: a HUMAN dismissal of an interactive ask ends the turn** — see "A dismissed question ends the turn" below.

### A dismissed question ends the turn (2026-08-13)

Denying an ordinary permission ask returns "the user declined this action" and the
model may try a different approach — still true. An interactive ask is different:
the user closing an `AskUserQuestion` card is them taking the turn back, so the
driver records `DISMISSED_TOOL_TEXT` as that call's real result, back-fills any
un-executed siblings in the step with `NOT_RUN_TOOL_TEXT`, and `break turnLoop`s
to `turn-complete` with `stopReason: 'question_dismissed'`. `AssistantTurnBubble`
renders that as *"Question closed — waiting for you."*

**A human "no" and a policy "no" are different things wearing one word, and the
driver must not confuse them.** There are exactly three `askUser` implementations:
`native-session-host.ts` (~:2496 → `PermissionBroker.ask`, the only one with a person
behind it), `childAskRouter()` (`specialists/child-ask-router.ts`), and the harness evaluator's fixture jail
(`eval/run-case.ts`). Only the first can produce a dismissal, so
`PermissionBroker.respond` stamps `dismissed: true` on a deny and the driver keys
the end-turn on THAT, not on `behavior === 'deny'`. For the two policies a deny
still means "you may not ask, carry on and finish" and returns `REFUSED_ASK_TEXT`.
This is not theoretical: the evaluator's wrap-up turn denies `AskUserQuestion`
precisely so the model answers instead of asking, and an early version that ended
the turn on any deny lost the review outright (`harness-review-runner.test.ts`).
Guard: `harness-session-loop.test.ts` → "POLICY deny (no `dismissed`)".

Three more things are load-bearing. It is `turn-complete`, not `user-interrupt`:
an interrupted turn skips the usage payload and the reducer stamps
`stopReason: 'interrupted'`, and a dismissal should report usage and let queued
messages drain (typing during the turn IS taking over). The sibling copy is its
own string, because `CANCELED_TOOL_TEXT` names a cause — "the user interrupted
this action" — that did not happen. And the signal is a driver-private
`EndTurnResult` wrapper rather than a field on `ToolResultPayload`, so an ordinary
tool cannot end a turn.
- **Tool-call/result pairing is an invariant EVERYWHERE** — the driver back-fills canceled/interrupted calls, `rebuildHistory` back-fills crash-truncated ones, and `fitToContext` trims pair-aware. *Why:* a dangling tool_call 400s on real providers and bricks the session. Guards: `harness-session-loop.test.ts` + `harness-history-rebuild.test.ts` (truncated-tail).
- **The driver emits ALL of a step's tool-use events BEFORE executing** (not interleaved) — `rebuildHistory` groups by event adjacency and relies on this ordering; don't "fix" it back to interleaved. Guard: `harness-session-loop.test.ts`.
- **The read-before-edit registry RESETS on resume** — files change while a session is closed, so a stored Read can't stand in for a fresh one. Don't "optimize" the registry back from persisted Read events. Guard: `harness-session-loop.test.ts`.
- **Bash cwd is SCOPED-PERSISTENT; the file tools are not** — `HarnessSession.shellCwd` tracks the shell dir across calls (read back via a `__YC_CWD__` sentinel `printf`ed on its own **newline-terminated** line, with `exit $__yc_rc` preserving the exit code); a `cd` outside `ctx.cwd` is reverted AND announced. Only cwd persists — env/aliases don't — and it resets on resume like readRegistry. Read/Edit/Write/Glob/Grep still resolve relative paths against `ctx.cwd`, so `cd sub` does NOT move them. *Why:* stateless-and-silent cost ~6 wasted tool calls in one session (the upstream complaint in CC #35058/#42837); the sentinel's trailing newline and the uncapped tail buffer are both load-bearing — without them a background writer corrupts the path and a chatty command drops the `cd`. PowerShell (Windows sans Git Bash) stays stateless by design. Guard: `harness-tools-core.test.ts` ("scoped cwd persistence").
- **Harness tools emit FORWARD SLASHES; Bash reports its cwd in the ROOT'S SPELLING** — `toPosix()` (`tools/guards.ts`) is the one output normalizer; `rebaseReportedCwd()` re-expresses the shell's physical `pwd` in `ctx.cwd`'s vocabulary. *Why:* one file must not come back `src/a.ts` from Glob and `src\a.ts` from Grep, and the `[cwd: …]` line can only relate Bash to the file tools if both name the root the same way. Four traps, each of which has already bitten: (1) rg's `--path-separator /` rewrites **stdout only** — locally-built strings (`grepErrorMessage`, the match-cap label) bypass it and need `toPosix` too, while rg's positional target stays platform-native; (2) containment is checked **before** the rebase, or `path.join` pulls an escaped path back inside and voids the scope guard; (3) that check's `+ path.sep` is what rejects a prefix-sibling (`/a/bc` vs root `/a/b`); (4) `toPosix` is **not** `canonicalize()`, which lowercases on win32. **`ctx.cwd` is never canonicalized** — the permission store is keyed by it, so a spelling change orphans remembered grants. **These guards are VACUOUS on Linux** except the symlink block and the `grepErrorMessage` case: they only fail on Windows/macOS CI, which is why `eba51705` left master red for 2 days against a green `verify.sh`. Guards: `harness-tool-guards.test.ts`, `harness-tool-bounds.test.ts`, `harness-tools-core.test.ts` ("Bash cwd vocabulary"). Depth: `docs/archive/specs/2026-08-11-harness-cross-platform-path-vocabulary.md` (youcoded-dev workspace).
- **Images travel canonically inside the tool result; `wire-adapter.ts`'s `adaptForWire` splits it per wire at request-build time** — pass-through on direct Anthropic (which carries images natively inside `tool_result`), placeholder text plus a synthetic follow-up user message on OpenAI-compatible wires, a full pixel strip for a non-vision model. *Why:* it runs every request rather than at push time, so a mid-session swap to a blind model can never leak pixels — a push-time gate could. Guard: `wire-adapter.test.ts`.

## Web tools, AskUserQuestion & presets (Plan B) — rule overflow (2026-08-12)

- **WebFetch/WebSearch follow redirects MANUALLY and re-validate every hop** (scheme + literal IP + DNS answer) — a public URL 302ing to a private/loopback/metadata address (incl. the hex-form `[::ffff:127.0.0.1]` that `new URL` normalizes to `::ffff:7f00:1`) is the SSRF bypass class. Honest friction, not a boundary (TOCTOU rebind possible). Never `redirect:'follow'`. Guard: `net-guard.test.ts`.
- **WebSearch walks a data-driven backend chain** (tavily-keyed → exa-keyless → ddg) that ships in-app AND refreshes from `raw.githubusercontent.com/itsdestin/youcoded/master/search-chain.json` (curated-catalog pattern; versioned cache, memoized hot-path). DDG `202` = rate-limited → honest error, NEVER retried (the 2025 breakage waves came from clients hammering it; the chain moves to the next backend and reports honestly). Backend ids from untrusted IPC are whitelisted before indexing. Guards: `search-chain.test.ts`, `search-backends.test.ts`, `search-service.test.ts`.
- **Search API keys are `safeStorage`-encrypted; `~/.youcoded/search-providers.json` holds only `secretRef` pointers** (same split as `providers.json`). New IPC family `search:*` (list/set-key/remove-key/test) has full 5-surface parity; `search:test` is never-throws `{ok,message}`. Guards: `search-key-store.test.ts`, `ipc-channels.test.ts`.
- **AskUserQuestion rides the existing permission-ask rail** — the broker threads `decision.updatedInput` (the answers) through, and `formatAnswers` is TOTAL (never throws on untrusted answer shapes — a throw there escapes the "never throws" tool loop → dangling tool_call → bricked session). Interactive tools are driver-routed (skip guards/decide). Guards: `native-permission-broker.test.ts`, `ask-user-question-tool.test.ts`, `harness-session-loop.test.ts`.
- **Presets (Assistant/Coder) express permission posture as the `modeFor` SEED, not presetRules** — mode rules outrank preset rules in the engine layering, so a preset's "edits allow" only works as a STARTING mode (`auto-edit` for Coder). `modeFor` is seeded once at create/resume and never overwritten by the preset afterward; an explicit `setPermissionMode` always wins. Legacy `harnessId:'chat'` maps to Assistant read-side (the stored header is never rewritten). `CORE_TOOLS` ≡ manifest `NATIVE_TOOL_NAMES` — presets advertise their suite via the names, and the prompt bodies reference tools by them; advertising an unregistered tool makes a preset instruct the model to call something that doesn't exist. Guards: `preset-registry.test.ts`, `native-session-host.test.ts`, `tool-registry-manifest.test.ts`.

## Local reliability, compaction, status (Plan C, rebased onto master 2026-07-24 — pending Linux acceptance)

Makes the harness usable on locally-hosted models: capability profiles, REAL context-window enforcement, grammar-constrained tool args, per-tier prompt steering, two-stage compaction, and live StatusBar chips. Spec §4. Still gated on `native.supported`.

- **Capability profiles resolve in THREE layers and never branch on a model name.** `resolveProfile(discovered, registry)` composes: (1) *discovered truth* — provider type + the real context window; (2) a *curated family registry* (`known-models.ts`) matched by a case-insensitive regex on the modelId — **the ONLY place a model name influences behavior**; (3) a *conservative fallback*. Output: `{maxToolPresentation, promptVariant, doomLoopThreshold, supportsParallelToolCalls, constrainToolArgs, supportsTools}`. Tools are NEVER removed for a tools-capable model (small local models are used precisely for web tasks — spec decision 9); only a registry `supportsTools:false` drops the tool set (`buildAiTools` returns `{}` → plain-chat model). *Why the registry exists:* a window-size heuristic cannot tell a 35B MoE from a 9B dense at the same window. **Registry facts are PROVISIONAL** — `maxContextWindow`/`supportsTools` were sourced from model cards by a web-search pass, carry `// UNVERIFIED` notes, and are re-checked against real GGUF quants at acceptance. They are safe-by-construction: a wrong ceiling only ever clamps DOWN from the real `/props` window (cannot overflow), and a wrong `supportsTools` degrades to conservative behavior.
- **KNOWN LIMITATION — capability and context are conflated, and cloud is one tier.** Every non-local model resolves to `CLOUD_DEFAULT` (full presentation, parallel calls, doom-3), so a small HOSTED model (Haiku-class, Flash-Lite, a cheap OpenRouter model) gets frontier treatment and chokes for the same reasons a small local one does. And the local FALLBACK tiers by context window, a poor capability proxy — an unknown 9B with a 256k window resolves "large → full presentation" (known models are patched by their registry entry; unknown ones are not). The right model is two orthogonal axes — *capability* (params for local, cost/benchmarks for cloud) driving presentation/steering, and *context budget* driving compaction/instruction/history sizing — plus runtime deciding the constraint mechanism. Tracked in the workspace roadmap, `docs/roadmap/native-harness.md` → `## sessions` ("capability and context budget want to be two separate axes"). Not a regression: the prior status quo had no tiering at all.
- **A local model's context window is READ and enforced, never guessed.** `EngineManager.effectiveContextWindow(modelId)` boots the engine if needed, reads llama-server **`/props?model=<id>`** (2026-09-05, design §C3 — the bare `/props` is the ROUTER's own dummy and answers `n_ctx: 0` even while a model is loaded; named, the router forwards the question to that model's child), and `clampContextWindow` takes `min(loaded, GGUF-trained)`; `effectiveContextForModel` then clamps to the registry `maxContextWindow` ceiling (local bindings ONLY — a hosted model whose id happens to match a local family must NOT be capped). **`/props` field drifts across llama.cpp builds** — read `default_generation_settings.n_ctx` then top-level `n_ctx`, defensively. `/props` is a ROOT management endpoint, not under `/v1` (same convention as `/health`, `/models`); read it with plain fetch, not `trackedFetch`, so a status read does not bump the idle-shutdown clock. **`trainedContextFor` returns null today** — so that half of the clamp is inert and the registry ceiling is the pragmatic stand-in. **The old reason for this is DEAD (corrected 2026-09-06): a GGUF header reader now exists** (`models/gguf-header.ts` parses `<arch>.context_length` into `GgufHeader.contextLength`, with a cache in userData), and the memory estimator already uses it. What is missing is only the WIRE: `cache-scan.ts` still exposes id/size/state, so `EngineManager` has no trained max to hand back. Do not build a second parser — wire this one. `effectiveContextWindow` NEVER throws (a status read must not break session create). **Its fallback is `contextLengthFor(modelId)` — the model's OWN configured length, falling back to the engine-wide one — never the bare engine-wide value**, or a model the user set to 128k would be sized at the engine's default whenever it happens to be asleep. **The ONE-number principle:** this single clamped value feeds profile tiering, the compaction trigger, AND the StatusBar context chip — the spec forbids the gauge and the threshold disagreeing.
- **Constrained decoding is `--jinja` tool grammar + `parallel_tool_calls:false` — NEVER a top-level `json_schema`.** A top-level schema/`response_format` would force JSON on EVERY reply and break the "plain-text answers always legal" invariant (spec §4.2). llama.cpp `--jinja` (in the spawn args since Phase 1 Plan B) already grammar-constrains emitted tool-call ARGS; the lever we own is serial-only, injected via `@ai-sdk/openai-compatible@3.0.7` `transformRequestBody` config hook on the LOCAL branch only, gated on `profile.constrainToolArgs && !supportsParallelToolCalls`. The hook is stored on the model `config` (reachable at runtime as `(model as any).config`; pinned by `provider-registry.test.ts`) — **if the openai-compatible config API drops/renames `transformRequestBody`, the constraint silently stops applying**; re-verify on any bump. This whole mechanism is llama.cpp-specific and does NOT transfer to a hosted endpoint. Round-trip proven by `test-engine/probe-tools.mjs` (dev-run, engine-bump gated), which also reports the real `n_ctx` and asserts a plain prompt is not force-called.
- **Two-stage compaction: prune, then summarize — and it must fail safe.** Trigger is the REAL last-step `inputTokens` (chars÷4 only as the pre-first-step fallback), checked at the top of every step. Stage 1 PRUNE shrinks old tool-result output TEXT outside a protected recent window — it maps messages 1:1 and never drops one, so no tool-call is orphaned. Stage 2 SUMMARIZE runs only if pruning frees too little; it cuts at the 2nd-to-last `role:'user'` message — a user message is only ever pushed at `send()` entry, so a user index is always a turn boundary and the cut can never split a tool-call/result pair. `protectedFrom` returns `i`, NOT `i+1`: the message that pushes past the budget must itself stay protected, or a single huge recent tool result gets pruned — defeating the point. **The summary stream is abort-raced AND 30s-timeout-bounded.** A bare `for await` here reintroduces the exact un-interruptible hang that `consumeStep`'s iterator race exists to prevent: a local model that stalls without honoring abort parks the turn forever, `send()` never resolves, `this.abort` stays non-null, and every later `send()` hits the re-entrancy guard — a permanent brick. A thrown/empty summary leaves the pruned history (`fitToContext` is the hard floor) and NEVER emits `session-error`. A thrash guard skips summarize when the condensable span is trivial (<500 tokens), or a `keep`-dominated history re-summarizes every step. The summary call usage is deliberately NOT folded into `turnUsage` — awaiting `result.usage` only settles on a clean stream end and would re-open the hang.
- **Native auto-compaction surfaces via `data.autoCompaction`, not the `/compact` gate.** The driver emits the existing frozen `compact-summary` event as `{summary, autoCompaction:true}` — note the field is `summary`, not `text`. The renderer `COMPACTION_COMPLETE` guard bypasses `compactionPending` only when `action.auto`, which ONLY the native harness sets; a blanket ungate would make CC resume-from-summary wrongly insert a marker. Compaction is IN-MEMORY only: `rebuildHistory` reconstructs the full uncompacted history on resume while the persisted `compact-summary` still renders its marker in place — benign (`fitToContext` re-truncates) but the marker implies a durable compaction that did not persist.
- **StatusBar chips read the reducer, not a status:data path.** `selectNativeStatusChips(usage, contextLength)` derives context %/tokens/tokens-per-sec from the active native session's latest `turn-complete` usage (the `useNativeSessionUsage` cached store selector walks the timeline back — it was an `App.tsx` memo over `chatStateMap` until the 2026-07-24 rebase, where AppInner perf tranche 1 had since replaced that reactive value with a ref; a memo over a ref would have frozen the chips); this serves desktop AND remote for free, since the remote reducer gets the same event over WS. `contextLength` rides the `turn-complete` usage payload — a session constant on a per-turn event, the same additive precedent as `tokensPerSecond`, used ONLY as a gauge denominator, never summed into token totals. **A `native:usage-report` renderer→main channel + `buildStatusData().nativeUsageMap` fold was built and then DELETED** — nothing consumed it once the reducer path existed; do not rebuild it without a reader. Chips update at turn END, so a long agentic turn context chip lags until the turn completes (accepted for v1).

## Skills, rules and injection (M3 items 1 / 3 / 5)

- **`scanSkills()` solves discovery, not loading.** It walks three roots and parses each `SKILL.md`'s frontmatter — then returns `prompt: '/<id>'` (a slash-command string for the UI to hand to Claude Code) and, before 2026-07-28, threw the directory away. So nothing in the app could read a skill's actual instructions: Claude Code performs that step itself, and the native harness had no equivalent. `SkillEntry.skillDir` now carries the path the scanner already computed, and `harness/skills/skill-catalog.ts` is the ONE place that knows the `<skillDir>/SKILL.md` layout. Do not add a second. Both failure modes are coded rather than silent: `SkillNotFound` names the skills that DO exist (a bare "not found" strands the model with no way to recover) and `SkillUnreadable` carries the real path and errno (`docs/error-message-standards.md` — specific and accurate, never a guessed cause). A `commands/` entry gets a directory recorded even though it may hold no `SKILL.md`; the catalog then reports "installed but unreadable", which is honest, rather than pretending it has no home on disk.
- **`Skill` is the one CONDITIONAL tool, and that is why it is absent from `NATIVE_TOOL_NAMES`.** Its description lists every offered skill's id and one-liner, and that rides the tool schema on EVERY turn (~1–2k tokens with a normal install). `buildAiTools` attaches it only when `profile.exposeSkillCatalog` AND at least one skill is offerable. The registry↔manifest guard rejected adding it to the advertised set, correctly: its stated reason — "advertised but not registered means a preset instructs the model to call a tool that doesn't exist" — is exactly this case. `CONDITIONAL_TOOL_NAMES` exists so the guard can pin that it is absent from the advertised set AND implemented, so "conditional" cannot quietly decay into "never written". The sync runs per `buildAiTools` rather than once at construction because `setBinding` re-resolves the profile on a model swap: a tool attached under a 128k model must come back OFF at 8k, and back on when the user switches back. An EMPTY catalog attaches no tool at all — a description reading "you may load a skill" followed by nothing still reads as an invitation, and the model burns a step inventing an id.
- **`Skill` is allowed at the permission baseline, alongside the other reads.** It opens exactly one file, in a directory the app discovered, chosen from a list the app itself advertised — strictly narrower than `Read`, which is already free. Every action a skill INSTRUCTS is performed by some other tool that is gated on its own terms, so prompting here would add friction with no safety gained and train the user to click through prompts that never matter. A remembered deny still wins: the baseline is a default posture, never a hard grant.
- **`/skill-name` is the path that works on every model**, because the Skill tool is withheld from small windows. The dispatcher does NOT hold a list of installed skills: an unrecognized slash command rides the EXISTING `handled: false` branch (so a Claude Code session forwards it to the PTY exactly as before) while naming an `invoke-skill` intent for native sessions, whose harness owns the catalog. That avoids plumbing the skill list into two renderer components with no other use for it — at the cost that the dispatcher cannot distinguish "skill not installed" from "a Claude Code command with no native equivalent", so the refusal copy covers both in one sentence rather than guessing. Skills resolve LAST, after every built-in, so a marketplace skill named `clear` can never shadow the `/clear` barrier.
- **`routeSlashResult` owns the ordering, because two callers got it wrong.** InputBar and `App.runSlashResult` each decided independently where a dispatcher result goes, and both checked `handled` BEFORE `nativeAction` — correct while every native action was also a recognized command, and a silent bug the moment `/skill-name` started riding the unhandled branch. It also names the case that used to vanish: `none-native-no-pty` carries the command, so a native session can say WHICH command was unavailable instead of returning into the void (`guardedPtySend` refuses natively and its return value was discarded at three call sites — the dead "Build New Theme with Claude" button was the most visible instance).
- **Nested project instructions and path-scoped rules are ONE mechanism**, which is why they share `harness/injection/path-triggers.ts`: content discovered from a path, delivered as a message, bounded by the profile. The index is built ONCE per session — it is filesystem state, and re-statting the tree per tool call would be a real cost on a large repo. The ROOT `AGENTS.md`/`CLAUDE.md` is deliberately excluded because `prompt-assembly.ts` already puts it in the byte-stable system prompt. Rules come from `<cwd>/.claude/rules/*.md` with `paths:` frontmatter — the convention this workspace already uses on Claude Code, so a repo set up for CC works natively with no new configuration. A rule with **no `paths:` is skipped, never treated as global**: an eager rule rides every turn, the exact cost item 5 exists to control, and the rules README already calls omitting it a mistake — honoring it as "applies everywhere" would reward the error with the most expensive behavior.
- **The glob is deliberately not `shared/subject-glob.ts`.** That matcher exists for bash command strings and lets `*` cross path separators ("git push*" must match "git push origin x"). For a file glob that is wrong: `src/*.ts` would match `src/deep/nested.ts` and inject a rule into work it does not govern. Here `**` crosses separators and `*` does not. That distinction went untested until a mutation survived — every test had used `**` — so it is now pinned explicitly.
- **Injection is messages, once per trigger per session, bounded by the profile.** A mid-session system-prompt edit would discard the KV cache prefix every local model reuses, turning a cheap follow-up turn into a full re-prefill of the whole conversation. Re-sending a rule after every `Read` of a matching file would dominate the conversation and blow the window it was sized against — and repetition does not make a model follow a rule harder. `Bash` is skipped when collecting touched paths: its permission subject is a command string, not a path. `fitInjection` always announces a cut, because a silently truncated procedure is worse than none — the model follows the fragment believing it is whole.
- **Sizing is a function of the WINDOW, not the provider.** `injectionBudgetTokens` and `exposeSkillCatalog` derive from the effective context window (so an 8k model loaded at `-c 128000` is judged on its real ceiling), and an unmeasured window is treated as small. Frontier hosted providers (anthropic/openai/google/openrouter) are exempt: we never DISCOVER their window, so `null` there means "not measured", not "small", and sizing them down would strip the catalog from every cloud session. `openai-compatible` is deliberately NOT exempt — `provider-registry` documents it as the Ollama / LM Studio shape, so an unmeasured one is a local model in disguise.
- **The ROOT project-instruction file is OUTLINED to fit, never tail-cut — `fitProjectInstructions`, never a raw `.slice()`** (migrated 2026-08-12 from the path-scoped rule) — EVERY heading survives at every budget; the budget buys body text (full from the top, then heading + ~200-char elided first lines marked `…`). *Why:* a section the model can't SEE is one it can't know to Read, so its rules silently stop existing — and the elision cap is load-bearing, since uncapped previews of the youcoded-dev workspace's own paragraph-opening sections fit at NO depth and collapsed the outline to bare headings. It sits in the byte-stable prompt, not a message, so it has its own fitter, but shares `injection-budget.ts` (one chars-per-token constant) and `profile.injectionBudgetTokens`. Was `.slice(0, 20_000)` until 2026-08-10 — chars not tokens, same for frontier and 8k, byte-offset, silent (§7 item 3). Guard: `project-instruction-budget.test.ts`.
- **The outline notice says only what actually happened** — "outlined", never "omitted", once every heading survives; it branches on preview depth (depth 0 has no first lines to claim); "headings omitted entirely" is reserved for the ONE path where they truly are. **Sizing is fixed at session start — `setBinding` does NOT re-apply it** (the prompt is never reassembled; that freeze IS the KV-cache prefix), so a mid-session swap leaves instructions sized for the STARTING model. Guard: `project-instruction-budget.test.ts` (notice-accuracy block).
- **`native:*` four-surface parity was only pinned on 2026-07-28.** `ipc-channels.test.ts` covers `remote-shim.ts` and `SessionService.kt` per-PREFIX — `dev:*` and `account:*` each had a block, `native:*` never did. Verified by deleting `native:invoke-skill` from the shim: the whole file still went green. A native command that works on desktop and dies on the remote web client is exactly what program §9 exit criterion (c) forbids, and nothing would have said so.

### Progress, token accounting and /clear — corrections made 2026-07-28/29

These landed in the same PR (#268) but AFTER the section above was written, several of them
because Destin found the bug by using the app. Recorded here because each one is a claim the
earlier text or the code's own comments got wrong.

- **Prefill progress measures THIS STEP'S work, not the whole prompt.** llama.cpp's `total` is
  every token in the request and `cache` is the prefix it reused for free, so on turn 2+ a
  percentage against `total` reads as nearly done before any work starts. `toReport` derives
  `newTotal = total - cache` and bases the fraction AND the rate on that — counting cached
  tokens as processed inflates the rate into promising a finish that cannot happen.
  **UNVERIFIED and written to be correct either way:** every capture we have is `cache: 0`, so
  whether `processed` counts from 0 or from `cache` on a warm prompt has never been observed.
  The dual handling breaks in one direction (cache SMALL relative to new work can under-report
  by up to `cache`); one warm capture settles it.
- **100% is reserved for actually finished.** The label used `Math.round`, which reaches 100 at
  99.5% — and this repo's own captured trace contains a NON-final reading of 5,515/5,519
  (99.93%). It floors to 99 unless `processed >= total`.
- **The displayed value never counts down**, because two things can hand back a lower number
  than last render: `interpolateProcessed` extrapolating past the next real report, and the
  warm-cache ambiguity above. A high-water clamp, reset per prefill run.
- **`prefillSeenAt` compares its `key`.** It always STORED one and never compared it, so the
  render that receives a new report measured elapsed time from the PREVIOUS report's stamp
  (effects run after render) and projected a full batch forward on arrival. Latent and
  self-correcting until the clamp latched the overshoot — which is how a smoothing fix made the
  counter jumpier rather than smoother.
- **`promptProcessing` is cleared when prefill ENDS** — first assistant text, first reasoning, a
  new user turn, and `endTurn()`. It was written in only two reducer cases and cleared by
  nothing, so a generation pause longer than the indicator's 2s streaming window re-rendered the
  old "Reading your prompt — N%" line mid-generation. `chat-types.ts` had documented the correct
  intent ("cleared by any other event") for behavior the reducer never had.
- **`tokensPerSecond` measures GENERATION, not the turn.** The denominator was the whole turn's
  wall-clock, so prefill, tool execution and permission waits all diluted a number labelled
  "output tokens per second" — a turn generating 300 tokens in 10s of decoding but spending 30s
  in a Bash call reported ~7 tok/s instead of ~30. `StepResult.generationMs` runs from each
  step's first real output chunk to the end of its stream, summed.
- **`/clear` FADES the conversation; it does not wipe it.** `CLEAR_TIMELINE` replaced the whole
  timeline with a marker on BOTH providers. Clearing resets the MODEL'S context, not the user's
  ability to re-read what they said, so it now appends the marker and `findArchiveBoundary`
  (`renderer/state/archive-boundary.ts`) makes ChatView fade everything above it exactly as it
  already did for `/compact`. Side effect: the dispatcher's "CLEAR_TIMELINE is irreversible"
  reasoning no longer holds — nothing is destroyed, so a refused clear costs a stray marker
  rather than a conversation. `deferUiEffectsToRuntime` is kept because a marker for a clear that
  never happened would still be a lie, but it is no longer load-bearing against data loss.
- **`NON_PATH_SUBJECT_TOOLS` names the tools whose permission subject is not a path.** The
  driver's rule was spelled inline as `toolName !== 'Bash'`, so `Skill` — whose subject is a
  skill id — was canonicalized against cwd, run through the credential denylist, and matched
  against rule globs the moment it was added.
- **Test sessions must inject a skill catalog.** `syncSkillTool` falls back to a real
  `~/.claude` scan, which made the attached tool set depend on the machine: Ubuntu CI failed
  "expected 10 tools, got 11" while macOS, Windows and local all passed. `EMPTY_SKILL_CATALOG`
  is the default in both shared factories AND in the seven suites that build their own opts.

## Tool output honesty (bounds contract, 2026-08-06)

Branch `fix/harness-tool-honesty`, prompted by the 2026-08-01 multi-model harness
review (`docs/active/investigations/2026-08-01-native-agent-harness-reviews.md` in
the `youcoded-dev` workspace). Every native tool result may carry an optional
`bounds` field (`desktop/src/main/harness/tools/types.ts`) instead of writing its
own truncation sentence into `text`:

```ts
interface ResultBounds {
  shown: number;
  total: number | null;   // null = genuinely unknown (e.g. a walk that stopped early)
  unit: 'lines' | 'chars' | 'bytes' | 'files' | 'matches' | 'results' | 'pages';  // 'pages' added 2026-08-28 for PDF reads
  moreHint: string;       // this tool's own widening vocabulary, this call
}
```

A tool sets `bounds` only on the call where it actually cut its own output.
`defineTool` (`tools/registry.ts`) wraps every tool, truncates the result through a
pipeline cap (`DEFAULT_CAPS.maxChars = 30_000` unless the tool declares its own
`caps`), and hands both bounds — the tool's own and the pipeline's — to
`composeNotice` (`tools/truncate.ts`), which renders **at most one** notice line
appended to the text. `truncateOutput` itself only measures; it no longer writes
advice — that was the bug (one hardcoded "Use offset/limit or a narrower query"
string told every tool's caller the same thing, which is meaningless for Bash and
WebSearch since neither accepts those parameters).

**Two `moreHint`s, deliberately.** `bounds.moreHint` is per-call: it only exists
when the tool bounded something on *this* result. `NativeTool.moreHint` lives on
the tool definition instead of the result and is a static fallback, because the
pipeline's own cap is a separate event with its own schedule — three cases found
during implementation fire the pipeline cap with no tool-level `bounds` at all:
content-mode Grep capped by `maxLines` (not `maxChars`, so nothing sets `bounds`),
Glob capped by `maxChars` while its own hit count is under `RESULT_LIMIT`, and an
oversized Skill body (Skill's `execute()` returns a SKILL.md file verbatim with no
internal cap of its own). Without the static fallback, each of those handed the
model a byte count and no way to widen. `composeNotice` uses `bounds.moreHint` when
present, falls back to the tool's static `moreHint` only when `bounds` is absent,
and prints nothing when neither exists — inventing advice is exactly the failure
mode this contract removes.

**Composition when both bounds can fire** (`composeNotice`):
- Neither present → no notice line.
- Pipeline cap only (no tool `bounds` this call) → `[output truncated: showing X of
  Y chars — <static moreHint>]`, or no advice suffix at all if the tool declared
  none.
- Tool `bounds` only → `[showing S of T <unit> — <bounds.moreHint>]`. When `total`
  is `null` the line reads `[showing S <unit> (more may exist — exact total unknown) — …]`
  instead — "S of at least S" was a tautology, not a warning (`truncate.ts`, `composeNotice`).
- Both → one line naming the pipeline cap first, then the tool's own bound, then
  the tool's `moreHint` once — never two competing notices.

**Each tool's widening vocabulary**, verbatim from its own file:

| Tool | `moreHint` |
|---|---|
| Bash | `Read the saved full-output file; if you must re-run, redirect to a file and print the exit code (cmd > out.txt 2>&1; echo exit=$?)` — the 2026-08-10 wording said "pipe through head/tail"; dropped 2026-08-28 (D-1) because there is no `pipefail`, so `cmd \| tail` hides a failing command's exit code |
| Grep | `narrow the pattern, add a glob filter, or use output_mode: "count"` |
| Glob | `narrow the glob pattern or pass a more specific path` |
| Read | static: `use offset and limit to read a smaller slice of the file (for a PDF, a narrower pages range)`; the per-call `bounds.moreHint` interpolates the exact next offset, `use offset=N to continue` (prefixed `~50 KB cap reached at line N;` when the char cap, not the line cap, stopped it); a PDF over 10 pages declares `unit: 'pages'` with `pass pages="11-20" for the next range` |
| WebSearch | `narrow the query, or WebFetch a result to read it in full` |
| WebFetch | `fetch a more specific URL, or a narrower section of the page` |
| Skill | `load a narrower or different skill instead, or ask the user to split this oversized SKILL.md into smaller skills` |
| Write, Edit, TodoWrite | none declared — each returns a fixed-shape one-line confirmation (Write/Edit's diff rides `structuredPatch`, which truncation never touches) that cannot approach the pipeline cap under normal use |
| AskUserQuestion | none declared — `defineTool` never wraps it; the driver routes it straight to `askUser()` and `execute()` never runs |

The exemptions are enumerated, not implicit, in `tests/tool-registry-manifest.test.ts`'s
`BOUNDS_EXEMPT` map — a test in the same file asserts every exempted name is still a
real, current tool, so a rename or removal can't leave a stale, vacuously-passing
exemption behind.

**What each bounded tool actually withholds**, briefly:
- **Bash** counts every stdout/stderr byte with an unconditional counter and
  retains a bounded head (4,000 chars) plus a rolling tail (4,000 chars) — of which
  the model sees ~2,000 + ~2,000 (50 + 50 lines), the rest spilling to a file — so the
  reported total is the real command output size rather than the length of an
  already-capped buffer (the earlier version reported the capped buffer's own
  length as the "total", which was fabricated).
- **Grep** does the same head/tail accounting (24,000 / 6,000 chars) for its own
  stdout ceiling, and separately — per output mode — reports which files hit
  ripgrep's own `--max-count` of 500 (meaningless in `files_with_matches` mode,
  where `-l` stops at the first match per file, so it's skipped there).
- **Glob** completes its directory walk under an internal 50,000-hit safety
  ceiling, sorts every hit it found by mtime, and only then slices to the 2,000
  hits it returns — so "sorted newest first" is actually true of the returned
  list. `total` is `null` when the 50,000-hit ceiling itself was reached, since
  the real count past that point was never counted.
- **WebSearch** dedups results by normalized URL, caps each snippet at 500 chars,
  and returns the first 8 of whatever's left.
- **Read**'s bound is `more = offset - 1 + limit < totalLines` — true whenever the
  requested slice stops before end of file.

**WebFetch's own caps** (`tools/web-fetch.ts`): a 5 MB fetched-body cap
(`MAX_BODY_BYTES`) always reports `total: null` for a truncated body, since the
server never states how much more content exists past that point. Two structural
guards run before Readability, because Readability's parse is roughly quadratic in
DOM nesting depth and runs synchronously on Electron's main loop — a hang there
can't be caught by `defineTool`'s try/catch, so nothing can recover once it starts:
`MAX_TAGS = 15,000` (a raw count of `<` characters — the only check that runs before
`parseHTML`) and `MAX_DEPTH = 150` (`domTooDeep`, an explicit-stack walk of the parsed DOM
before Readability). A page that trips either guard gets a
linear-scan plain-text fallback capped at `FALLBACK_CHAR_CAP = 200,000` characters,
replacing the earlier hard refusal that left the model with nothing.

**WebFetch's JS-shell detection.** An extraction-coverage ratio cannot tell a
JS-rendered page from a normal one apart — the page that triggered this
investigation (`vitest.dev/config/`) measured 70.3% Readability extraction
coverage, indistinguishable from a known-good server-rendered page's 69.1%.
Detection instead requires BOTH a framework marker
(`__VP_HASH_MAP__|__NEXT_DATA__|__NUXT__|__remixContext|__sveltekit|window.__INITIAL_STATE__`,
or an empty `<div id="root">`/`<div id="app">`/`<div id="__next">`) AND a
visible-text-to-raw-bytes density under `TEXT_DENSITY_FLOOR = 0.10` (10%), where
the denominator deliberately excludes `<script>`/`<style>` bytes so a routine
hydration blob can't deflate the ratio on its own (including it would misfire on a
normal server-rendered Next.js page). Measured against the two committed fixtures
(`tests/fixtures/web/vitest-config.html`, `.../asyncio.html`): vitest-config — the
actual JS-shell page from the original incident — measures 7.18% density and is
flagged; asyncio.org, server-rendered with a near-identical 69% extraction
coverage, measures 19.07% and is not flagged. A simulated SSR page carrying a large
`__NEXT_DATA__` hydration blob measures 89.29% density under this
script/style-excluded denominator versus 7.31% under the naive raw-byte
denominator — confirming the exclusion is what keeps an ordinary hydration blob
from producing a false positive.

On a hit, WebFetch appends a non-committal note stating only what was directly
observed (how much visible text the server actually sent) without guessing what is
missing — never a categorical claim like "this section doesn't exist," since the
tool has no way to know that from a shell it never rendered.

## Native tools — the 2026-08-26 harness-comparison ledger (shipped 2026-08-28)

Source: `docs/active/investigations/2026-08-26-native-tools-vs-other-harnesses.md`
(workspace) — YouCoded's Read/Edit/Write/Bash/Grep against ten other harnesses.
Shipped as youcoded PRs #352, #353, #354, #355. What is now true, and why:

- **Every native tool schema is `.strict()`; an unknown parameter is an error the model
  can act on** (`tools/arg-errors.ts`, called from `runOneTool` step 1). Before, `z.object`
  silently dropped unknown keys, so a Claude-Code-trained model sending `Grep {"-i": true}`
  got a case-*sensitive* search and no error. The message names the bad key AND the valid
  list. MCP tools stay pass-through on purpose — the server validates its own arguments
  (pinned in `tool-registry-manifest.test.ts`). Nested list items (a todo, a question) are
  not strict: a stray key there changes nothing the tool does.
- **Grep** gained `ignore_case` (`-i`), `literal` (`-F`), `type` (`--type=NAME`, one token so a
  value can never be read as a flag; rg validates the name), `multiline`
  (`-U --multiline-dotall`). Flags omitted → the rg command line is byte-identical to before.
- **Read** — (1) a folder returns "is a folder, not a file — use Glob or Bash `ls`" plus the
  first 50 entries under the `bounds` contract, instead of Node's raw `EISDIR`; (2) a second
  per-call cap of 50,000 chars, cut on a line boundary, with the exact `offset=N` to resume —
  the 100k pipeline cap is now a backstop text reads cannot reach; (3) **re-read dedupe**: the
  same `path|offset|limit` slice of a file whose mtime is unchanged returns a one-line
  "unchanged since your earlier Read (N calls ago)" notice. The served-reads map
  (`HarnessSession.servedReads`) is cleared on resume, `/clear`, every automatic compaction
  action (prune AND summarize) and manual `/compact` — the model must never be told "you
  already have it" about content compaction removed; (4) **PDFs** (`harness/pdf-text.ts`):
  text layer only, page by page, `pages="1-5"` (max 20 per call; ≤10 pages read whole; >10
  without `pages` → first 10 + `bounds`), scanned pages named up front ("pages 3–7 contain no
  text layer"), vision models additionally told how to rasterise them, whole-empty → error,
  encrypted/corrupt → pdf.js's own message. Uses the `pdfjs-dist` the renderer's viewer already
  ships (legacy build, lazy `import()` on first PDF), and **extractions are serialized through
  one promise chain** — the 2026-08-27 sidecar OOM was N concurrent parses of one file.
  `offset`/`limit` are ignored for PDFs and the description says so. Desktop-only (Android
  has no native harness). `electron-builder.yml` unpacks `pdfjs-dist/legacy`, `standard_fonts`,
  `cmaps` from the asar — **unverified in a packaged build until someone reads a PDF in an
  installer** (workspace `docs/roadmap/native-harness.md` → `## tools`).
- **Write** — refuses omission placeholders (`detectOmissionPlaceholder`, `tools/write.ts`):
  a comment-only line carrying an ellipsis plus "rest of / existing code / unchanged /
  remaining / omitted", quoting the line. Narrow on purpose (`foo(...args)`, a bare `// ...`,
  prose never trip it) — the bias is toward missing an exotic placeholder over refusing real
  content. Overwrites also preserve CRLF/BOM via Edit's exported `preserveFormat`.
- **Edit** — every parameter described; `old_string` says: exactly once, never include Read's
  `%6d\t` line-number prefix, keep to 1–3 lines. The read-gate refusal names session resume
  as a cause (`readRegistry` resets on resume).
- **Bash** — the description no longer suggests re-running "piped through head/tail" (no
  `pipefail`: `cmd | tail` masks the exit code); it says Read the saved file, or redirect and
  `echo exit=$?`. The same sentence was fixed in the per-call spill notice and the static
  `moreHint`. Adds "prefer Read/Grep/Glob/Edit over cat/grep/find/sed" unconditionally —
  `descriptionFor(caps)` does not know the permission mode (folded into the Bash-output item in the workspace `docs/roadmap/native-harness.md` → `## tools`).
- **Skill** accepts `args` (`$ARGUMENTS` substituted, else a trailing `Arguments:` line).
  **WebFetch**'s `prompt` parameter is gone — it was only echoed as a header.
- **AskUserQuestion** — the card offers an "Other" row and a per-question text box
  (`ToolCard.tsx`); a typed Other answer replaces a label in `answers[q]`, a note on a listed
  choice arrives as `notes[q]` (rendered "Note from the user:") and as Claude Code's own
  `annotations[q].notes`. `formatAnswers` flags an answer that is not one of the offered
  labels as the user's own words. Still TOTAL on any shape.

Guards: `tool-arg-errors.test.ts`, `native-tools-polish.test.ts`, `read-pdf.test.ts`,
`ask-user-question-card-other.test.tsx`, plus the additions in `harness-tools-core`,
`tool-registry-manifest`, `harness-session-loop`.

## MCP in native sessions (M3 item 4, phase 1)

Design: workspace `docs/archive/specs/2026-07-30-native-mcp-design.md`. Nine tasks built a
registry store, a single-server client, a refcounted connection manager, a per-tool adapter,
budget-gated session wiring, and projection into Claude Code's `~/.claude.json` — all on branch
`feat/native-mcp-phase1`, not yet merged to master.

- **Registry** (`harness/mcp/mcp-registry.ts`) persists WHICH servers exist to the synced
  `~/.youcoded/mcp.json`, split the same way `providers.json`/`search-providers.json` are: only
  a `secretRef` pointer is stored; plaintext lives in `SecretsStore` (safeStorage, userData,
  machine-bound). A synced entry without its matching ciphertext on a device resolves with
  `missingSecrets` populated ("needs setup"), never a crash or a half-configured spawn.
- **Client** (`harness/mcp/mcp-client.ts`) owns exactly one server's connection lifecycle:
  connect (stdio via `StdioClientTransport`, or streamable HTTP), list tools, call one, close.
  `stderr: 'pipe'` on the stdio transport is deliberate — the SDK default (`'inherit'`) would
  route a failing server's only diagnostic into the app's own stderr, unreachable by the user;
  the piped stream is buffered (bounded ring, last ~4KB) so a connect failure can quote it. Call
  timeouts thread `signal`+`timeout` into the SDK's own request options at the SDK's
  `(params, resultSchema, options)` position — a "simplified" 2-arg call would silently drop
  both onto the SDK's own 60s default timeout with an error naming neither the server nor the
  bound. A local backstop timer (`callTimeoutMs + 1s`) exists only for the case the SDK itself
  never rejects.
- **Manager** (`harness/mcp/mcp-manager.ts`) pools one live connection per server, refcounted
  across every session that acquires it — two sessions using the same server share one
  subprocess, not two. `acquire()`/`release()` close two overlapping-call race windows (a
  `release()` landing mid-registration, and a resumed session's re-acquire racing an outgoing
  release for the same session id) via a synchronous two-pass registration and a `holderTouch`
  sequence number — see the file's own comments for the exact race shapes. App-quit calls
  `destroyAll()` — see the leaked-subprocess caveat below.
- **Adapter** (`harness/mcp/mcp-tools.ts`) turns a connected server's tools into ordinary
  `NativeTool`s named `mcp__{server}__{tool}` (Claude Code's own convention, so names can't
  collide with the ten built-in tools). Input schemas pass through raw — no local
  re-validation, since the server validates its own arguments and a lossy local check could
  reject a valid call. `permissionSubject` returns `undefined`, so a remembered "always allow"
  grants exactly the one namespaced tool it was granted for, never the whole server —
  deliberate, because a server update can add a destructive tool with no revocation UI until M5
  item 3 ships. The server's own tool annotations (`readOnlyHint`, `destructiveHint`) are read
  and ignored: a server is not a trusted authority about its own danger.
- **Session wiring** (`harness-session.ts`) attaches WHOLE servers only, in registry order,
  dropping from the END once `estimateToolSchemaTokens` (chars/4, the same estimate
  `fitToContext` uses) would exceed `profile.mcpToolBudgetTokens` — never a partial tool set for
  one server — and `droppedMcpServers` records the dropped servers' ids. Re-synced on every
  `buildAiTools()` call (mirrors the Skill tool's per-call resync), gated on the budget value
  plus the `mcpServers` array reference so an unchanged binding doesn't re-tokenize every
  server's schema on every turn.
- **Projection** (`mcp-reconciler.ts`) writes the registry's enabled servers into
  `~/.claude.json`'s `mcpServers` so Claude Code sessions see them too. **Ownership is tracked
  in a TOP-LEVEL `_youcodedOwnedMcpServers: string[]` key, not a per-entry marker** — the
  original plan called for a per-entry flag, but Claude Code's tolerance for an unknown
  top-level key is demonstrated (Destin's real file carries 59 of them), while its tolerance for
  an unknown key inside an individual `mcpServers` entry is unverified; a strict per-entry
  schema could silently break MCP loading. An id already present in `mcpServers` that YouCoded
  did not previously own — hand-written via `claude mcp add`, or scanned from a plugin
  manifest — is SKIPPED, never overwritten, and reported via `skippedCollisions`; that is the
  adopt-candidate case, and adopt itself is phase 2.

**Deliberately deferred, not a phase-1 oversight:**
- The plugin-manifest scan (the pre-existing `~/.claude/plugins/*/mcp-manifest.json` walk that
  has fed `~/.claude.json` since decomposition v3) was **not** migrated to feed the YouCoded
  registry, despite the original plan's own Step 4 saying it would. No production
  registry-write path exists yet (`McpRegistry.upsert()` has zero production callers), and the
  manifest schema (`platform`, `auto`, `command_windows`, `{{plugin_root}}` template expansion)
  has no lossless equivalent in the registry's `McpServerEntry`/`McpTransport` shape.
  **Consequence, stated plainly: a marketplace-installed MCP server is visible in Claude Code
  sessions but NOT in native sessions today** — the stated cross-runtime parity goal is not yet
  met for that path.
- No settings UI, no adopt flow, no `mcp:*` IPC channel. Phase 1 is configured entirely by
  hand-editing `~/.youcoded/mcp.json` — developer-operable only, per the design spec's own
  phasing. The registry is read only in the main process; nothing crosses to the renderer, so
  `ipc-channels.test.ts` has no `mcp:*` row to pin — its absence is not an oversight.
- **Phase 1 cannot configure a secret-bearing server at all.** `McpRegistry.upsert()` — the ONLY
  path that produces a `secretRef` — has zero production callers, so hand-editing a raw
  `env`/`headers` key straight into `~/.youcoded/mcp.json` was, before a fix pass, the one way to
  make a token-requiring server (Gmail, any OAuth-style API) work — and it worked by leaking
  plaintext into the synced registry file, exactly the failure mode envRefs/headerRefs exists to
  prevent. `fromStored()` (`mcp-registry.ts`) now builds a server entry from known fields only, so
  a hand-written `env`/`headers` key is inert (silently dropped, never reaches `resolveEntry`'s
  spread). Net effect: a stdio/http server needing a secret genuinely cannot be configured by hand
  in phase 1 — it needs `upsert()`, which needs a settings UI, which is phase 2. Not a regression
  (there was never a SAFE way to do this), but worth stating plainly since the unsafe way used to
  quietly work.
- **A server excluded from a session (not ready, over budget, or missing its secret) is now
  logged, but still has no UI.** `McpManager.acquire()` logs one `WARN` per server it excludes
  (naming the server and its real `lastError`) and `HarnessSession.syncMcpTools()` logs one for
  the whole dropped-for-budget tail — closing the gap where `status()`/`droppedMcpServers` were
  both accurate and completely unobserved (zero production callers of either). This is a
  `~/.claude/desktop.log` line, not a user-facing surface: no toast, no session banner, no
  settings-panel indicator exists yet. A developer can now grep the log for why a server never
  showed up; an end user still can't tell from inside the app.

**A leaked-subprocess caveat, app-wide and pre-existing — not MCP-specific.**
`McpManager.destroyAll()` runs from `NativeSessionHost.destroyAll()`, which the app reaches only
via its `window-all-closed` handler — the only quit path it is wired to. macOS Cmd+Q, dock
quit, and an OS SIGTERM bypass that handler entirely and leak the spawned MCP subprocess.
`SessionManager.destroyAll()` and `HookRelay.stop()` ride the exact same single hook, so this is
the existing quit-hook gap (closed since — workspace `docs/roadmap/shipped.md`) applying to one more subsystem, not a
new hole this work introduced.

## Specialists (plan 1a)

Design: workspace `docs/active/specs/2026-08-11-native-specialists-design.md`. Eight tasks built
a Task tool that a native session's model can call to delegate a scoped piece of work to a
**specialist** — a short-lived, foreground CHILD `HarnessSession` cold-started with a narrow tool
allowlist, run to completion, and torn down. `harness/native-session-host.ts` (`createChild`,
`spawnSpecialist`, `formatSpecialistReport`) and `harness/specialists/` (`registry.ts`,
`builtins.ts`, `child-permissions.ts`, `limits.ts`, `report-budget.ts`, `names.ts`) were the
whole surface at the time. **Two of the bullets below describe 1a's launch shape and were
superseded by plan 1b** (background execution, durability, steering) — each says so in place
and points to the "Specialists (plan 1b)" section, which is now where the current behavior
lives; `child-ask-policy.ts` named above no longer exists on disk (replaced by
`child-ask-router.ts`, see 1b).

- **A specialist child is an ordinary session, marked by parentage.** `NativeSessionHeader` grows
  three ADDITIVE fields — `parentSessionId`, `sessionKind: 'specialist'`, `agentType` — so v1
  session files need no migration. `createChild` writes them at header-create time; nothing else
  in the persistence layer needed to change for a child to be a real, resumable, on-disk session.
- **Depth-by-omission, not a depth counter.** No `SpecialistDefinition` lists `'Task'` in its
  `allowedTools`, so a child's tool set is structurally incapable of spawning its own children —
  there is no recursion guard to get wrong because there is no path to recurse through. Belt-and-
  suspenders: `isSpecialistChild: true` on the child's `HarnessSessionOpts` is a second,
  independent gate `syncTaskTool` checks before ever offering the Task tool, so a bug in the
  allowlist filtering alone still cannot open depth-2 delegation.
- **Frozen-surface re-emission: exactly three display types, never persisted under the parent.**
  The child's own transcript-event listener does two things per event: (1) persist it, verbatim,
  to the CHILD's own JSONL on the child's own append chain, and (2) if — and only if — the event's
  type is one of `tool-use` / `tool-result` / `assistant-text` (the frozen `SUBAGENT_DISPLAY_TYPES`
  set), re-emit a STAMPED COPY on the host's own event emitter, under the PARENT's `sessionId`,
  carrying `data.agentId` (which child) and `data.parentAgentToolUseId` (which Task call). That
  stamped copy is what the renderer's `applySubagentEvent` (`chat-reducer.ts`) consumes to fill in
  the subagent card live. A `turn-complete` or `session-error` is deliberately NEVER in that set and
  therefore never re-emitted — a stamped `turn-complete` would hit the conversation-record IPC
  listener (`noteModelUsed`) and the title feeder under the PARENT's id, making a specialist's
  internal turn boundary look like the parent finished a turn. The host is NOT wired via `wire()`
  for this same reason: `wire()` is what makes a session mint a Conversation Store record and feed
  the title feeder, and a child must never surface as a conversation the user never started.
- **The envelope + deny-list cut-through.** A child's `decide()` (`child-permissions.ts`) is built
  from the PARENT's fully resolved decide function, capped by the specialist's `charter`
  (`'read-only'` or `'read-write'`) and `allowedTools` — a read-only charter cannot approve Write/
  Edit/Bash even if the parent's own mode would. `envelopeGranted: true` in 1a means the Task-tool
  call itself (which the parent's own permission stack already gated) IS the user's consent for
  everything inside the child's charter — there is no second per-tool ask surface for a child's
  own actions. `DESTRUCTIVE_DENY_LIST` still applies underneath the envelope unmodified: the
  envelope raises what's grantable, it never lowers the floor guards below it already enforce.
- **Charter-scoped consent key.** Remembered "Always allow" rules are built against the PARENT's
  id and the PARENT's cwd (never the child's), because `buildDecide` keys live permission mode by
  session id and remembered rules by cwd — both are properties of the delegating conversation and
  its project, not of a one-shot child that will be gone before the rule could ever be looked up
  again under the child's own id.
- **Per-parent slots and single writer, never host-global.** `specialistSlots` (capped by
  `HOSTED_MAX_CONCURRENT_SPECIALISTS`, `specialists/limits.ts`) and `activeWriterChild` (the
  single-writer invariant — at most one `charter: 'read-write'` child running at a time per
  parent, so two concurrent writers can't race edits to the same files) are BOTH keyed by parent
  session id. An unrelated conversation's specialist fan-out never caps or blocks this one's.
- **Cold-start contract.** A child gets NONE of the parent's conversation history — its system
  prompt is the specialist's own definition body (not the preset's), its `<env>` block describes
  the child's own `workDir`, and both the skill catalog and MCP servers are explicitly suppressed
  (an empty catalog object, not an omission — `syncSkillTool` falls back to the FULL installed
  catalog whenever `opts.skillCatalog` is `undefined`, so leaving it out would silently hand a
  child the user's whole skill library). The entire brief the child ever sees is its first user
  turn, delivered by `spawnSpecialist`.
- **Containment.** A child's `workDir` must resolve to the parent's `cwd` or a subdirectory of it —
  checked through the same `canonicalize`/`isUnderRoot` helpers the tool-layer path guards use, so
  this check and `checkPathGuard` can never disagree about what counts as "inside."
- **The names easter egg (Task 8).** Every child gets an alliterative fun title —
  `"{Name} the {Descriptor} {Role}"` (e.g. "Rowan the Relentless Researcher") — drawn without
  replacement from a shared first-name pool via `specialists/names.ts`'s `assignSpecialistName`,
  scoped per PARENT (`NativeSessionHost`'s `takenNamesOf: Map<parentId, Set<string>>`, cleared
  alongside `childrenOf` when the parent tears down). The descriptor pool alliterates with the
  role (E-words for Explorer, R-words for Researcher/Reviewer, W-words for Worker). A pool
  exhausted mid-conversation falls back to a numbered title (`"Explorer 13"`) rather than crashing
  or repeating a name. The title lands in the child's `NativeSessionHeader.title` field at
  `createChild` time — the existing title-precedence read path in `session-store.ts`'s `list()`
  renders it for free — and `formatSpecialistReport` uses the same title (not the bare
  `SpecialistDefinition.displayName`) in the parent-facing report header, so the model always
  knows WHICH specialist (by name) answered, alongside the role id in parentheses.
- **Children are hidden from every default list, by construction, not by filtering them out
  downstream.** `SessionStore.list()` defaults `includeChildren` to `false` and skips any header
  with `sessionKind === 'specialist'` OR a `parentSessionId` set. Every list-shaped surface in the
  app — `NativeSessionHost.list()` (Resume Browser feed, `NATIVE_SESSIONS_LIST` IPC), the
  Conversation Store's `'native'`/`'claude'` buckets (chat search, session browser overlay) — is
  either downstream of that one default or is itself record-driven and structurally can't see a
  child, because `createChild` never mints a Conversation Store record for one (see the `wire()`
  point above). `createChild` also has no IPC route at all — it's host-internal, called only from
  `spawnSpecialist`, itself called only from the Task tool's implementation — so a child never
  reaches `ipc-handlers.ts`'s session-create path in the first place. (Verified by an exhaustive
  `rg` sweep of every `store.list(`/`SessionStore`/`listSessionFiles`/`cwdToProjectSlug` hit under
  `desktop/src/main`, per-site, as part of landing this section — see the Task 8 commit.)
- **(1a launch shape, SUPERSEDED — see "Specialists (plan 1b)" below.) A child never reached a
  real user ask.** 1a's `askUser: childAskPolicy()` resolved every ask-shaped call synchronously
  with a typed refusal, because a broker ask under the CHILD's session id had no owning renderer
  window and would have hung forever. Plan 1b replaced this with `childAskRouter` — a child's ask
  now DOES reach a real user, routed to the PARENT's own card. `child-ask-policy.ts` no longer
  exists on disk.
- **(1a launch shape, SUPERSEDED — see "Specialists (plan 1b)" below.) The reload tradeoff.** 1a's
  specialist display events were DISPLAY-ONLY re-emissions with nothing to replay them after a
  restart, so a resumed parent's subagent card rendered EMPTY even though the report text itself
  (an ordinary tool result) survived in the parent's own transcript. Plan 1b's `getHistory` merge
  now replays a child's own JSONL back onto a resumed parent, so the card is no longer empty.

**Plan 1b (below) shipped everything deferred here:** background/non-blocking delegation, a
persistent run ledger, heartbeats for a long-running child, and subagent-card replay after resume.
File-based custom specialists and CC-compat with Claude Code's own subagent file format shipped in
**plan 1c** below — see "Specialists (plan 1c — files, chat UI backend, Settings)". Plan 1c also
closed 1b's consent-card copy gap for a `task_id` management call. Still open — a user-visible
deletion/GC path for child transcripts, plus a handful of ideas (promote foreground → background,
a transcript viewer, per-helper cost) — are tracked in the workspace roadmap, `docs/roadmap/native-harness.md` →
`## specialists`, not here.

## Specialists (plan 1b — background, durability, steering)

Design: workspace `docs/active/plans/2026-08-12-native-specialists-plan-1b-background-durability.md`.
Fourteen tasks made specialists background-capable and durable: the parent keeps working while a
child runs, completions arrive as injected turns at an idle boundary, the model can steer a
running child, a blocked child ask routes to the parent's own card, and every piece of state
(undelivered reports, interrupted children, the subagent card) survives an app restart. New
surface: `harness/specialists/delegation-ledger.ts`, `child-ask-router.ts` (replaces
`child-ask-policy.ts`), `delegated-models.ts`; `harness/tools/model-search.ts`.

- **The delegation ledger is the durable record of every spawn.** One sidecar JSON file per
  parent (`sessions/<slug>/<parentId>.delegations.json`), written exclusively through
  `NativeHome.mutateJson` (lock-guarded read-modify-write). A **claim is a lease, not a
  delivery**: `claimUndelivered` stamps `claimedBy`/`claimedAt` but leaves `delivered: false`;
  only `confirmDelivered`, called AFTER the injected turn actually ran, flips it. `isOwnerAlive`
  (an instance-UUID fast path, else `process.kill(pid, 0)`) means a lease held by a crashed
  process is reclaimable — a crash between claim and injection re-delivers the report exactly
  once instead of losing it forever.
  <!-- verify: {"path": "youcoded/desktop/src/main/harness/specialists/delegation-ledger.ts", "contains": "A CLAIM IS A LEASE"} -->
- **Background execution resolves the Task call at LAUNCH; the report is delivered later, never
  mid-turn.** `background: true` on the Task tool detaches the run — `runDelegation` finishes on
  its own schedule, and the completion is queued (`pendingDeliveryParents`). The host's `runTurns`
  drain loop injects it as a `user-message` (`data.injected: 'specialist-report'`, via
  `HarnessSession.runNotice`) only at an idle boundary — after the parent's own turn has fully
  completed, never spliced in. A report too large for the ledger's cap spills to
  `<childId>.report.md` (`NativeHome.writeSessionArtifact`); the parent can `Read` its own spill
  directory without an external-directory ask (`internalReadRoots`).
- **A compact per-turn status block, never polling.** `HarnessSessionOpts.specialistStatus`
  injects one `<specialists-status>` history message before each real user turn, listing running
  and undelivered-finished specialists; the PREVIOUS turn's block is removed first, so exactly one
  ever lives in history — never an accumulating, increasingly stale list.
- **Steering (`postSteer`) lands at the next iteration boundary — a tool call is never cut.**
  Posted text queues and drains as a `<steer>` history message at the top of the next turn-loop
  iteration. A steer posted with no turn in flight, or during the child's own FINAL step (too late
  to drain before the turn ends), is recorded to the ledger's `missedSteers` instead of silently
  dropped, and is prepended to the brief the next time that child is resumed via `task_id`.
- **Heartbeat staleness flags — never kills.** A child silent past `SPECIALIST_IDLE_STALE_MS`
  (2 min) or, mid-tool-call, `SPECIALIST_IN_TOOL_STALE_MS` (5 min) is flagged `stale` on its
  ledger record and surfaces in the status block ("may be stuck"). There is no kill path: only an
  explicit `interrupt: true` (model, via `task_id`) or a future user action ends a stale child.
- **`task_id` re-enters a specialist a model already started — steer, resume, or interrupt.** The
  Task tool's `task_id` branch: running → the prompt is a steer; finished/interrupted → the child
  RESUMES with cold state rebuilt from its own JSONL, `prompt` as its next brief; `interrupt: true`
  cancels it. Own-children-only — a `task_id` belonging to another conversation or nonexistent
  reads identically, so the refusal never leaks whether a foreign id exists. A specialist header
  can never re-enter through the root `resume()` path (it would get the preset's prompt and could
  re-acquire the Task tool) — `resumeSpecialist` is the only door back in.
- **A child's ask now reaches a real user — routed to the parent's card, with a 5-minute
  redirect.** `childAskRouter` replaces 1a's synchronous refusal: a child's `doom_loop` or
  decide-originated ask re-registers on the broker under the PARENT's own sessionId (the existing
  permission card renders it) and holds for `SPECIALIST_ASK_HOLD_MS` (5 minutes,
  `specialists/limits.ts`). Only if nobody answers by then does it resolve with
  `ASK_REDIRECT_MESSAGE` — copy that tells the child to keep working on anything that doesn't
  depend on the blocked action and never route around it — while the ask entry stays answerable
  past the timeout, not canceled. A real answer that lands late either steers the still-live child
  (`APPROVED`/`DENIED`, naming the tool) or, once the child has already ended, queues a parent
  delivery naming the `task_id` to resume.
  <!-- verify: {"path": "youcoded/desktop/src/main/harness/specialists/child-ask-router.ts", "contains": "ASK_REDIRECT_MESSAGE"} -->
- **Permission-store rule identity is now a quad, and the store is versioned.** `specialist?:
  string` (the agentType) joined `(tool, pattern, action)` as identity's fourth axis at every
  comparison site (dedupe, remove, the host's in-memory filter, the UI's `ruleKey`) — a
  specialist-keyed grant never leaks to the root session or a different specialist.
  `~/.youcoded/permissions.json` is `v: 1 | 2`; a v1 file reads as valid v2 with no migration
  step. Full depth: `native-permissions.md` rule.
- **Restart reconcile + card replay.** On parent resume: a `running` record whose owner failed
  `isOwnerAlive` is marked `interrupted` HONESTLY (the child remains an ordinary resumable session
  via `task_id`, never silently discarded); a dead-owner delivery lease is released so the report
  re-delivers instead of vanishing; a `completed && !delivered` record is queued for delivery at
  the next idle boundary. `getHistory` now MERGES each child's own JSONL back into the parent's
  stream — filtered to `SUBAGENT_DISPLAY_TYPES`, re-stamped identically to the live path, and
  spliced immediately after the parent's own Task tool-use event — so the subagent card is no
  longer empty after a restart (see the corrected 1a bullet above).
- **Concurrency is engine-measured locally, profile-fixed hosted.**
  `CapabilityProfile.maxConcurrentSpecialists` is `4` for cloud bindings, `1` for an unrecognized
  local model, and — for a known local engine — the real parallel-slot count read from `/props` at
  runtime (clamped 1–4), never a copied constant. `interrupt(parentId)` (the Stop button) no
  longer cascades to a BACKGROUND child — stopping the parent's own turn should not fire a
  researcher still working — but `destroy`/`quiesce` (teardown, takeover) still take every child
  down regardless of foreground/background, and mark its ledger record `interrupted`.
- **Delegated model tiers — user-designated, never auto-priced.** Two named tiers, `budget` and
  `frontier`, each bound to a concrete model via `DelegatedModels` (`~/.youcoded/delegated-models.json`,
  1c ships the Settings picker). An unset tier falls back to the parent's own model with an honest
  "(No ${tier} model is set — using this conversation's model.)" note, never a silent substitution.
  The orchestrating model can also name a specific model id per hire, but ONLY when the user asked
  for one — an id absent from the live catalog refuses the Task call rather than guessing. The
  `ModelSearch` tool (catalog lookup by substring, price-sorted) rides the identical `canDelegate`
  gate as `Task` and exists only to find ids for that per-hire override.
- **Weak-model hardening, three independent guards.** A single JSON-string tool-arg (`"{\"prompt\":
  ...}"`) is re-parsed once before failing. Placeholder prompts (`todo`, `task 1`, an unexpanded
  `{{...}}` template) are refused against the WHOLE trimmed prompt only, never per-line — a
  narrower check than the 40-char floor alone, which a padded placeholder can clear. Specialists
  have no per-child step cap; the per-parent lifetime spawn budget
  (`SPECIALIST_SPAWN_BUDGET_PER_SESSION`, 30) is the remaining runaway-delegation backstop, not a
  normal-use limit.

## A stalled turn parks instead of dying (2026-08-16, youcoded master `28d3f82e`)

Spec: `youcoded-dev/docs/archive/specs/2026-08-16-stalled-turn-never-dies-design.md`.
Plan + build ledger: `docs/archive/plans/2026-08-16-stalled-turn-never-dies.md` and
`.superpowers/sdd/progress.md`. Terse always-loaded layer: rule `native-runtime.md` →
"Stall watchdog & the park" and rule `chat-reducer.md`.

**What changed for the user.** A provider that holds the socket open but stops sending
(an OpenRouter keep-alive while an upstream stalls, a half-open connection after a
network or suspend blip) used to kill the turn at the 75s mark with a `session-error`,
throwing away whatever had already streamed. It now **parks**: a red "Provider may have
stalled" card counts up in place, offering **Retry** and **Stop**, and a chunk arriving
minutes later still lands in the loop and finishes the turn as if nothing happened.

- **The park works by NOT resolving the stall race — that `return` IS the feature.**
  `consumeStep`'s loop awaits `Promise.race([nextPromise, abortPromise, stallPromise,
  retryPromise])`. The two-stage watchdog's stage 2 normally calls `resolveStall('stall')`,
  which wins the race and runs the teardown path (`iterator.return()`, swallow the
  terminal promises, then retry-or-throw). In the park branch it instead emits
  `assistant-thinking {stalled:true}` and **returns without resolving anything**. Nothing
  is torn down, the stream reader and socket stay open, and the loop simply keeps awaiting
  the same `nextPromise`. Adding a `resolveStall` call to that branch silently restores
  the old kill-the-turn behaviour while leaving every visible symptom of the feature
  (the card still appears) intact — which is exactly why it is pinned by a test rather
  than by a comment. Guard: `tests/harness-stall-watchdog.test.ts`.
- **The park guard, and the clock split it encodes.** Read it off the expression in
  `harness-session.ts`, never off prose — this one boundary was **mis-stated five times**
  during the build, four of them in code comments, and the fifth statement was the first
  accurate one:

  ```ts
  const willRetry = !emittedAny && isFirstAttempt;
  …
  if (!this.opts.isSpecialistChild && (sawFirstChunk || this.turnEverParked) && !willRetry) {
  ```

  The subtlety that keeps getting lost is that **`willRetry` tests `emittedAny`, not
  `sawFirstChunk`.** `sawFirstChunk` flips on *any* real chunk, including
  `tool-input-delta` (tool-argument fragments); `emittedAny` flips only on something
  COUNTABLE — text, reasoning, or a completed tool call. So a first-attempt stall after
  minutes of nothing but tool-argument text has `sawFirstChunk === true` and
  `emittedAny === false`, and therefore takes the **silent auto-retry** branch rather
  than parking. That is deliberate and safe: nothing executed, nothing is on screen, and
  nothing is in `emittedPartIds` for the re-run's deltas to collide with.
- **Clock 1 is deliberately out of scope.** When nothing streamed on this attempt
  (`sawFirstChunk === false`) and the turn has never parked, the countdown still ends the
  turn with the prefill `StreamStallError` ("didn't begin responding within N seconds").
  A model that never sent a first byte has not *stalled* in the sense this feature means —
  it never began, which on a local model usually means it is still doing prefill on a long
  prompt. Spec §8 records the decision; `harness-stall-watchdog.test.ts` pins it with
  "a stall with NOTHING ever streamed still ENDS the turn — Clock 1 is out of scope".
- **`turnEverParked` is per-TURN, not per-step.** It is cleared once at the top of
  `send()` (the only turn entry point — `compactNow`'s own `AbortController` never touches
  the watchdog) and set the first time a step parks. Consequence: once a turn has parked
  and the user has pressed Retry, a LATER step of that same turn that goes silent before
  streaming anything **parks again** instead of dying on Clock 1. A retry the user asked
  for must never die on its own.
- **A specialist child must never park.** A specialist is a full `HarnessSession`, so it
  would inherit parking for free — and that is a trap. `wireChildLive` re-emits only
  `SUBAGENT_DISPLAY_TYPES` (`tool-use` / `tool-result` / `assistant-text`) into the
  parent's view; the parked signal rides `assistant-thinking`, which is filtered out. So a
  parked child would show **no card, no red dot, no Retry, no Stop** — just a spinning
  Agent card forever. Worse, the child's `send()` would never settle, so the parent's
  `Task` tool call would never return, and **nothing else caps a specialist run on
  wall-clock**: the parent hangs too, invisibly. Falling through to the ordinary stall
  path lets the child keep throwing `StreamStallError`, which the parent's `Task` tool
  already catches and reports as a failed run. Found as a Critical by the whole-branch
  review, landed with no test at first, then pinned — delete the `isSpecialistChild`
  clause and `harness-stall-watchdog.test.ts` fails. Surfacing a stalled child's card
  *inside* the parent's Agent card is a real follow-up feature; it is not attempted here.
- **Retry erases the abandoned text in THREE places, and all three are load-bearing.**
  (1) **Screen** — `assistant-thinking {dropPart:{partIds}}` → `NATIVE_PARTS_DROPPED` in
  the reducer, emitted BEFORE `consumeStep` returns the retry sentinel so the ordered
  event stream guarantees the erase precedes the re-run's first delta. (2) **Disk** —
  `SessionStore.append` matches `dropPart` and DISCARDS the buffered open part instead of
  flushing it; this is the only path in the store that drops a buffered part, and it must
  sit ABOVE the display-only early return or the abandoned text gets flushed by the next
  event anyway. (3) **The model's own memory** — `reportPartial('')`, because
  `partialAssistantText` is reset per STEP, not per attempt: without it a re-run that
  throws before emitting anything leaves `send()`'s catch pushing the abandoned
  half-sentence — text the user just watched get erased — back into `this.history` as a
  real assistant message.
- **Timing did not move.** `STALL_WARNING_MS` (60s) and `STALL_RETRY_COUNTDOWN_MS` (15s)
  are byte-identical to their pre-feature values, and `tests/prefill-watchdog.test.ts` is
  unchanged — both were hard constraints on the branch and were verified by diffing
  against master on the merge commit. The prefill budget (`prefillBudgetMs`) still governs
  the FIRST-chunk deadline; `warnMs` only governs gaps after a chunk has arrived.
- **`native:retry` is a new fire-and-forget channel** carrying `{sessionId}`, mirroring
  `native:interrupt` across all five surfaces (`ipc-handlers.ts`, `preload.ts`,
  `remote-shim.ts`, `remote-server.ts` WS, `SessionService.kt` not-implemented-on-mobile).
  Parity is pinned by `tests/ipc-channels.test.ts`. Retry is NOT interrupt:
  `retryStalledStep` resolves one promise, while `interrupt` cascades to foreground
  specialist children and calls `broker.cancelSession`. Android hosts Claude Code sessions
  only, so the channel no-ops there exactly as `native:send` already does; **remote
  (phone → parked desktop) is fully live and must work.**

### Accepted limitations (declared, not bugs)

Each of these was found during the build, judged, and deliberately left. They are
recorded here so they are not rediscovered as defects.

- **Already-flushed text can duplicate ON DISK after a Retry.** The store buffers exactly
  one open part and flushes it the moment any different part opens — a tool call, or a
  reasoning block giving way to visible text (the ordinary shape on the model in the
  2026-08-16 incident, so this is the common case, not the exotic one). If the abandoned
  attempt had already opened a second part, its earlier text was committed to the
  append-only JSONL before the stall and `dropPart` cannot reach back and unwrite it. The
  live screen stays correct; a reload can show that earlier text twice. Rewriting
  committed transcript lines is out of scope.
- **The trailing-run erase can leave one duplicate on a text → tool → text attempt.**
  See rule `chat-reducer.md` and `youcoded/docs/chat-reducer.md`: the reducer stops the
  walk at the first non-matching segment, and a tool-group segment carries no `partId`, so
  it stops the walk. If one attempt produced text, then a tool-preparing card, then more
  text before stalling, the earlier text survives the erase and the re-run re-emits it.
  Strictly better than the alternative — whole-list filtering DELETED finished work, and
  duplicated text beats deleted text. Needs a model that resumes prose after starting a
  tool call and then stalls.
- **A retried attempt suppresses the "reading your prompt" prefill notice.**
  `lastStepPromptTokens` was already stamped by the abandoned attempt, so a local model
  shows a bare spinner right after a stall scare instead of the progress readout.
  Pre-existing for the silent auto-retry; the manual Retry button makes it user-visible.
- **A first-attempt stall after nothing but tool-argument fragments auto-retries silently
  rather than parking.** This is the `emittedAny`-vs-`sawFirstChunk` split above, and it
  is the existing safety property, not an oversight: nothing user-visible streamed, so
  re-running is safe. Do not "fix" it.
- **Quitting the app while a turn is parked loses the trailing partial.** Today the same
  stall ends in `session-error`, which IS a turn boundary and flushes, so this is a narrow
  regression for users who quit instead of pressing Stop. The card is red with both
  buttons visible, and the loss window matches the hard-crash window the store already
  accepts. The general fix (flush open parts on shutdown) is separable and out of scope.
- **Declared behaviour change against spec §12:** the composer Stop button is now
  reachable while a CLAUDE CODE session is `'stuck'`, where master hid it. `'stuck'` is
  CC-only via the PTY classifier, and the stall warning newly maps to `'stuck'` for native
  sessions, so gating `useStreamingGate` on `'ok'` alone would have made a phone turn
  un-stoppable during the countdown (a phone has no ESC key). Kept on the safety argument
  and pinned in both directions; spec §12 was amended rather than the behaviour reverted.

### Rule-overflow additions (2026-08-16, migrated from the path-scoped rule)

Room for the section above was made in `.claude/rules/native-runtime.md` by dropping or
compressing bullets whose full text this document already carried:

- **Above, "Native chat sessions":** AI SDK v7 / `part.text`, `ModelCatalog`'s `fetchedAt`
  stamping, and `TRANSCRIPT_REPLAY`'s `getHistory` fallback.
- **Above, "Local reliability":** constrained decoding (`--jinja` + no top-level
  `json_schema`), the two-stage-compaction detail (abort-race, 30s bound, pruned-history
  fallback), `data.autoCompaction`, capability profiles' three resolution layers, and the
  StatusBar-chip bullet. That last one's rule wording had **DRIFTED**: it described
  `native:usage-report` as a live status channel, but the channel was built and DELETED
  once the reducer path existed (`rg usage-report` finds only three comments saying so).
  It was removed rather than migrated, because the accurate version is already here.
- **Above, "Conversation store, resume & auto-title participation":** `lastUsedModel`
  portability (also in rule `conversations.md`), resume always offering `ModelPicker`,
  auto-titling firing once, and "Android has none of this".
- **Above, "Web tools, AskUserQuestion & presets":** the preset `modeFor` SEED bullet.
- **Above, "Agent loop, core tools & permissions":** `PERMISSION_RESPOND`'s `native-`
  prefix routing (its file, `ipc-handlers.ts`, is not even in the rule's `paths:` globs).
- **Above, "Provider seam" / "Agent loop":** reasoning-segment dormancy on the CC path,
  and `adaptForWire`'s per-wire image split.

Every one was grep-verified present in this document before removal; no claim was lost.

## Specialists (plan 1c — files, chat UI backend, Settings)

Design: workspace `docs/active/specs/2026-08-16-native-specialists-plan-1c-design.md`. Fourteen
tasks let a specialist be defined by a file (personal or Claude-Code-compatible), wired the run
ledger's live state onto the chat card, and gave Settings a real management surface. New surface:
`harness/specialists/catalog.ts`, `definition-files.ts`, `frontmatter.ts`.

**Channel contract** — six new `specialists:*` IPC channels ride all five surfaces (`ipc-handlers`
· `preload` · `remote-shim` · `remote-server` WS · `SessionService.kt` not-implemented), parity
pinned by `ipc-channels.test.ts`, **not** gated on `native.supported` (a phone must still answer an
ask): `specialists:list` (→ `{ definitions, folders: { personal, claudeUser?, project? } }`, always
re-reads the three folders — this is also Settings' Refresh; `{ ensurePersonalFolder: true }` from
Settings only, creating the personal folder + its starter file if absent), `specialists:delegated-get`
/ `-set` (the `budget`/`frontier` tier bindings), `specialists:steer` / `specialists:interrupt` (own-
children-only, checked host-side). The run record itself pushes as `specialists:event { kind:'run',
sessionId, run }` — one emission point (`delegation-ledger.ts`'s private `mutate()`), replayed on
session attach and after a transcript replay. Nested asks ride the existing `hook:event
PermissionRequest`, now carrying `specialist.parentToolCallId`; the 5-minute hold flip adds a new
`PermissionHeld` hook event, itself replayed to a reconnecting client (`pendingEventsFor`) alongside
a `PermissionResolved` purge signal that stops a stale answered ask from replaying with live buttons.

**File formats.** A personal specialist is frontmatter (`name`, `description`, `tools:`, `model:
budget|frontier|parent`, `reportBudgetTokens`) + a system-prompt body, in
`~/.youcoded/specialists/*.md`; `charter` (`read-only`/`read-write`) is always DERIVED from the
mapped tools, never declared. A Claude Code agent file (`~/.claude/agents/*.md` or
`<cwd>/.claude/agents/*.md`) maps through the same pipeline — see the mapping table below. Ids are
unique across all three folders; built-in ids are reserved and a collision is skipped with a
warning rather than shadowing anything. At most 20 non-built-in specialists are offered to the
model per cwd (load order); the catalog is re-read only at conversation open, at turn start when a
per-file fingerprint changed, or on Settings Refresh — there is no directory watcher.

**Claude Code `.claude/agents/*.md` mapping table** — the safety-relevant translation from CC's
frontmatter to a native `SpecialistDefinition` (`Task`/`Agent` always stripped; an omitted `tools:`
maps to read-only; `model: haiku/sonnet/opus` map to `budget`/parent/`frontier`; anything unmappable
produces a warning rather than a silent drop) lives entirely in
`harness/specialists/definition-files.ts`'s `loadClaudeCodeDefinition` — its test file
(`specialist-definition-files.test.ts`) is the authoritative list of every mapped and stripped key;
read the function before assuming a CC field carries over.

**Hire grants for file-defined specialists (D1/D2, 2026-08-26).** `rememberedRuleFor`
(`harness-session.ts`) persists a non-Bash "Always allow" as `{tool, pattern: subject, action:'allow',
match:'exact'}` — byte-exact on the subject — so the subject `tools/task.ts` builds IS the entire
definition of how wide the grant is. The catalog stamps `SpecialistDefinition.grantScope` because it
is the only thing that knows which folder a file came from (`source: 'claude-code'` spans both
`~/.claude/agents/` and `<cwd>/.claude/agents/`; `loadClaudeCodeDefinition` takes it as a required
parameter, no default): built-in → `${charter}:${workDir}` (unchanged from 1b, so no existing grant
is lost); `user` (`~/.youcoded/specialists/`, `~/.claude/agents/`) → `${charter}:file:${id}@${fp}`,
no work dir, so one grant covers every project — these are the files the user owns and reuses;
`project` (`<cwd>/.claude/agents/`) → `${charter}:${workDir}:file:${id}@${fp}`, pinned to the folder,
because a repo's own helper is the untrusted case and a same-id file in another repo must not inherit
it. `fp` is `definitionFingerprint(raw)` — sha256 of the file bytes, first 12 hex — so an edited file
mints a new subject and re-asks (blind spot: the catalog only re-reads a file whose `mtime`/size
changed, so a same-size same-second rewrite keeps the old hash AND the old cached definition — the
grant and the behaviour stay consistent with each other). *D1:* `rulesForMode('auto-edit')` appends
`{tool:'Task', pattern:'*:file:*', action:'ask'}` after the broad Task allow, so a file-defined hire
still shows a card in auto-edit while a remembered exact grant still wins. *Resume:* a `task_id`
call has no work dir, so no subject and no card — the delegation ledger records
`definitionFingerprint` at spawn and `resumeSpecialist` answers `definition-changed` when the current
file no longer matches; the Task tool reports that and tells the model to hire afresh. `createTaskTool`
memoises `roster.resolve` per instance so `permissionSubject` and `execute` see the same definition
even if the catalog reloads between them, and resolves `work_dir` against the session cwd (threaded
from `harness-session.ts`), not `process.cwd()`. The card states the width in words under the buttons
(`alwaysAllowNote`) and still offers no Always-allow while the definition is unknown (nor for a hire
with no `work_dir`, which has no subject to grant); Settings →
Permissions renders a `file:` subject in words via `describeRule` ("Let the docs-writer specialist
edit files in every project"). *Where "every project" actually lives:* `isCrossProjectRule`
(`shared/permission-types.ts`) routes exactly the `user` subject shape into the reserved
`CROSS_PROJECT_SLUG` (`'all projects'`) bucket of `permissions.json` — a key no cwd can ever slug to,
because `nativeStoreSlug` collapses its space — which `PermissionStore.rulesFor` unions into EVERY
project's remembered rules, `NativeSessionHost.revokeRule`/`revokeProject` clear from every live
session (project grants untouched), and Settings lists first as "All projects". Guards: `task-tool.test.ts` ("D2 — grant width follows grantScope"),
`permission-engine.test.ts` (D1), `native-session-host.test.ts` (resume gate + the cross-project
bucket's revoke behaviour), `permission-store.test.ts` (bucket routing and reads),
`specialist-catalog.test.ts` / `specialist-definition-files.test.ts` (folder → `grantScope`),
`permissions-section.test.tsx` ("All projects" card), `describe-rule.test.ts`,
`specialist-envelope.test.tsx`.

Rule: `.claude/rules/native-specialists.md` → "Specialists (plan 1c)".

## Background Bash (ledger G-1, shipped 2026-08-28)

Design: workspace `docs/archive/specs/2026-08-28-bash-background-execution-design.md`; plan
`docs/archive/plans/2026-08-28-bash-background-execution.md`. A native Bash command can outlive its
call: `run_in_background: true` starts it and returns a shell id at once, and a foreground command
still running at its `timeout` is HANDED OFF to the background instead of SIGKILLed (the 10-minute
cap is gone). `BashOutput` reads new output since the last look (or lists this conversation's runs);
`KillShell` stops one. The finished result always arrives on its own.

- **`ShellRegistry` (`harness/shell-registry.ts`) is the one owner of every such run; the HOST
  owns its lifetime.** One per session id in `NativeSessionHost.shellRegistries`, handed to the
  `HarnessSession` as `opts.shells` → `ToolContext.shells`. Why host-owned and not session-owned:
  a remote takeover and the session-exit backstop destroy the session but must leave its commands
  running (D2 — the conversation is still open, elsewhere); those runs still need an owner that
  can kill them at app quit and re-attach them if the same conversation is resumed in this process.
  <!-- verify: {"path": "youcoded/desktop/src/main/harness/native-session-host.ts", "contains": "shellRegistries"} -->
- **Honest family kill, foreground too.** Every Bash child is spawned in its own process group
  (`spawnDetached`); a kill is `SIGTERM` to the group then `SIGKILL` after 2 s (`killTree`),
  `taskkill /PID <pid> /T /F` on Windows. Escape used to kill only the outer bash and orphan a
  `node` it started. `execute` still resolves IMMEDIATELY on abort — only the escalation runs on.
  Pinned by the `sleep 30 & wait` grandchild tests (`shell-registry`, `bash-background`).
  `spawnDetached` is OVERLOADED so a caller that names no `stdio` keeps Node's non-null stream
  types; without that, swapping `spawn()` for it silently widens every `child.stdout`.
  <!-- verify: {"path": "youcoded/desktop/src/main/harness/shell-registry.ts", "contains": "SIGTERM"} -->
- **A time limit hands off; it never kills — except a leading `sleep`.** The same process is
  adopted (`registry.adopt`), stdin is closed (D4: a prompt fails fast instead of hanging in a
  slot forever), no cwd probe or `persistent_env` result is applied (D6 — the registry unlinks the
  env temp file when the command finally exits), and the cwd/env sentinels it prints at exit are
  filtered ON READ (tail, BashOutput, notice) while the raw log keeps them. That last guard is on
  `handedOffTo`, NOT on "the command has not printed its sentinel yet": the timer can fire in the
  same instant the command finishes. The cap (5) counts explicit starts only; a hand-off always
  succeeds (D5).
- **Output: on disk from the first byte, a 200-line ring in memory, 40 lines on the wire.**
  The log reuses the spill naming and the 7-day sweep, which MOVED to `spill-paths.ts` in this
  change so background logs are swept too (in `bash.ts` it only ever fired from a foreground
  spill, so a user whose long commands all ran in the background never swept anything).
  `lastReadBytes` (the log's byte length at the last BashOutput) is the read cursor, and the read
  is POSITIONAL and capped at `READ_MAX_BYTES` — never load a multi-hundred-MB build log into the
  main process to slice off its tail. Carriage-return redraws are normalized to newlines
  (`normalizeNewlines`) so a progress bar cannot grow one unfinished line without bound.
  `'change'` events are debounced to ≤4/s per run and carry a `ShellRunView` with the last 40
  lines — the phone on cellular is the reader.
  <!-- verify: {"path": "youcoded/desktop/src/main/harness/tools/spill-paths.ts", "contains": "sweepOldSpillFiles"} -->
- **Delivery reuses the specialists' idle-boundary path.** `queueHostNotice(parentId, text,
  meta, whyDropped)` → `drainDeliveries` → `runNotice(text, meta)` with `injected:
  'shell-complete'`; `injectedMeta` is the union `SpecialistInjectedMeta | ShellInjectedMeta`, the
  shell shape carrying a LIST of runs because every shell notice ready in one drain goes out as
  ONE turn (D8 — a `runNotice` is a full model turn). `SpecialistInjectedMeta` declares
  `kind?: undefined` so every reader can write `meta.kind === 'shell'`; without it TypeScript
  refuses to read `.kind` off the union at all. KillShell's own result is its notice (none sent);
  a user Stop IS reported; conversation-closed / app-quit have no session left to tell.
  <!-- verify: {"path": "youcoded/desktop/src/main/harness/harness-session.ts", "contains": "shell-complete"} -->
- **`BashOutput` is exempt from the doom-loop window and capped at 8 reads per turn (D7)** —
  a poll is supposed to repeat; the flat cap covers the chatty-build case the old
  "three empty checks" idea missed. Both companions are always-allowed (`rulesForMode`).
- **IPC.** `native:kill-shell` rides the request parity (preload, remote-shim, remote-server WS,
  `SessionService.kt` → not-implemented-on-mobile; pinned in `ipc-channels.test.ts`), NOT gated
  on `native.supported` so a phone can Stop a desktop command. `native:shell-event` is a push in
  the `specialists:event` shape (window + `remoteServer.bufferShellRun` + broadcast; replayed on
  connect, pinned in `remote-server.test.ts`) and re-sent on `TRANSCRIPT_REPLAY` via
  `nativeHost.shellRunsFor`.
- **Resume rule.** After replay, a Bash card whose result announced a shell id and got no live
  record renders "Stopped when the app quit" (`markOrphanedShellRuns`); a card with a
  `shell-complete` turn in the transcript rebuilds its exit from the turn's meta.

### Accepted limitations (declared, not bugs)

- **App crash (not quit) leaves commands running with no owner** — nothing in userland runs on
  SIGKILL or power loss. A close followed by a quit inside the 2 s SIGTERM→SIGKILL window IS
  covered: `drainingShellRegistries` holds the registry until its kill settles.
- **After a restart, a run that was stopped by KillShell or by the Stop button before the quit
  also reads "Stopped when the app quit"** — the run's final state is never persisted; only the
  finished notice is. The same label appears on the OTHER device after a takeover while the
  command keeps running on the first one.
- **Concurrent writes** by a background command to files the assistant is editing are not detected.
- **Windows tree kill** relies on `taskkill /T`; the grandchild test is POSIX-only, the Windows
  path is unit-mocked.
- **The cap of 5 is per registry, and every specialist child gets its own** — a conversation
  running five helpers can hold thirty background commands at once. Deliberate: a helper that
  cannot start its own build cannot do its job, and every one of those runs still dies with its
  child under `conversation-closed`.
- **A read is capped at 1 MB per call** (`READ_MAX_BYTES`). A command printing more than that
  between two `BashOutput` calls has its older lines skipped, not queued — `bounds.total` goes to
  `null` ("at least N") and the hint names the log, which holds everything.

Rule: `.claude/rules/harness-tools.md` → the "Background Bash" bullet.
