---
origin: youcoded-dev@1f60c2a:docs/chat-reducer.md
---

> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rule in youcoded-dev/.claude/rules/chat-reducer.md is the terse always-injected layer; this doc is the depth.

# Chat Reducer Architecture

Chat state lives in `youcoded/desktop/src/renderer/state/chat-reducer.ts` with types in `chat-types.ts`. A few non-obvious invariants govern how tool activity and turns are scoped.

## Tool activity scoping

`toolCalls` is a **session-lifetime Map** — never cleared. ToolCards need old results for display, so entries persist. Individual entries are updated in-place (status flipped to `failed`), but the Map never resets.

To prevent stale `running` / `awaiting-approval` entries from old turns affecting status indicators, `activeTurnToolIds` (a Set) tracks which tools belong to the current turn. All status checks — StatusDot color, ThinkingIndicator visibility, attention classifier — scan this Set only, not the full Map.

## endTurn() helper

`endTurn()` in `chat-reducer.ts:270` is the shared path for ending a turn. It:

- Iterates `activeTurnToolIds` and marks any `running` or `awaiting-approval` tool as `failed` with error `'Turn ended'` — **except** a native `preparing` card, which is **deleted** instead (`removePreparingTool`). The model was still composing that call's arguments, so no tool was ever invoked and "failed" would name an event that did not happen. Deleting also prunes the group it emptied and that group's turn segment, or an empty group renders as a stray bar.
- Returns a fresh empty `activeTurnToolIds: new Set()`
- Clears `isThinking`, `streamingText`, `currentGroupId`, `currentTurnId`, and resets `attentionState: 'ok'`
- Returns `toolGroups` and `assistantTurns` too, because of that pruning — see the trap below

**Always use this helper when adding a new turn-ending code path.** Don't manually clear these fields.

**Trap: `endTurn()` returns `assistantTurns`, so spreading it LAST discards your own edit to that map.** Any caller that builds its own `assistantTurns` must pass it in as the third argument (`endTurn(session, message, assistantTurns)`) rather than writing `{...session, assistantTurns, ...endTurn(session)}`. Two callers do this today: `TRANSCRIPT_TURN_COMPLETE` (stamps usage/model/stopReason) and `TRANSCRIPT_INTERRUPT` (stamps `stopReason: 'interrupted'`). This was true the moment preparing-card reaping landed, and it broke the interrupt footer immediately — caught by `chat-reducer.test.ts` → "chatReducer TRANSCRIPT_INTERRUPT".

`SESSION_PROCESS_EXITED` spreads `endTurn()` and then overrides `attentionState: 'session-died'` — one of two cases where the post-endTurn attention is not `'ok'`. The other is `NATIVE_SESSION_ERROR` (native runtime, PR Plan A), which spreads `endTurn()` then overrides `attentionState: 'error'` + `errorMessage`; both follow the same spread-then-override pattern.

## Attention classifier

The old 30-second `thinkingTimedOut` watchdog was replaced by a per-session `attentionState` enum driven by three independent signals:

1. **Process liveness** — main-process `session-exit` forwards `exitCode` via IPC; App.tsx dispatches `SESSION_PROCESS_EXITED`. If a turn was in flight OR the exit was nonzero, the reducer calls `endTurn()` and sets `attentionState: 'session-died'`. Clean exits during idle are no-ops.
2. **PTY buffer classifier** — `useAttentionClassifier` ticks every 1s while `isThinking && !hasRunningTools && !hasAwaitingApproval && visible`. It reads the xterm buffer via `getScreenText`, passes the last 40 lines to the pure `classifyBuffer` function (`src/renderer/state/attention-classifier.ts`), and dispatches `ATTENTION_STATE_CHANGED` only when the mapped state differs from the current one. Reset to `'ok'` on unmount.
3. **Transcript corroboration** — `TRANSCRIPT_USER_MESSAGE`, `TRANSCRIPT_ASSISTANT_TEXT`, `TRANSCRIPT_TOOL_USE`, `TRANSCRIPT_TOOL_RESULT`, `PERMISSION_REQUEST`, `TRANSCRIPT_THINKING_HEARTBEAT` (payload-less `assistant-thinking` events — CC's watcher always emits these with `data: {}`), and `TRANSCRIPT_ASSISTANT_REASONING` (added 2026-07-10, PR #115: `assistant-thinking` events WITH `data.text` — per-token reasoning deltas merged into one `reasoning` segment by `partId`, rendered as a collapsed "Show reasoning" disclosure by AssistantTurnBubble; dormant for CC sessions, fires for the Phase 2 native harness) clear `attentionState` back to `'ok'`.

`ChatView` renders `<ThinkingIndicator />` when `attentionState === 'ok' && isThinking`, and shows `<AttentionBanner state={attentionState} />` when `attentionState !== 'ok'`. The banner gate is NOT purely `isThinking`-scoped: the mid-turn state `'stuck'` renders while thinking, but the two **terminal** states (`'session-died'`, `'error'`) render *after* `endTurn()` has cleared `isThinking` — the gate explicitly allows terminal attention through regardless of `isThinking`, else the banner for a turn-ending failure could never appear. The reachable states are `'ok' | 'stuck' | 'session-died' | 'error'` — `'stuck'` covers spinner-glyph-flat-for-30s with no counter advancement, and no-liveness-signal-for-20s (no glyph and no advancing counter); `'session-died'` is set by `SESSION_PROCESS_EXITED` only; `'error'` is set by `NATIVE_SESSION_ERROR` only (native-runtime provider/stream failures — CC sessions never enter it), and its human-readable message rides `SessionChatState.errorMessage`, rendered in preference to the generic banner copy.

The classifier matches `<glyph> <single- or multi-word Gerund>…` (e.g. `* Installing + verifying on device…`). Active vs. stalled is decided by glyph rotation OR seconds-counter advancement across ticks: same glyph for ≥30s AND counter not advancing ⇒ stalled; any glyph rotation OR counter advancement ⇒ active. CC's paren-wrapped `(Nm Ns · …)` / `(Ns · …)` counter is matched by a parallel `COUNTER_RE` so a CC version that pauses glyph rotation but keeps the counter live still classifies as active. The 2026-04-30 empirical audit confirmed the gerund body now allows multi-word phrases. The classifier's patterns are Claude Code CLI-version sensitive — see the version-anchor comment at the top of `attention-classifier.ts`, and re-run `test-conpty/test-spinner-fullcapture.mjs` + `test-conpty/test-attention-states.mjs` whenever CC visuals change.

## Deduplication

User timeline entries carry a `pending?: boolean` flag. `USER_PROMPT` always appends a new entry with `pending: true`. `TRANSCRIPT_USER_MESSAGE` finds the **oldest** pending entry with matching content and clears its flag — confirming the optimistic bubble rather than adding a duplicate. If no pending match exists (remote/replay client, or user typed directly in the terminal), the transcript event appends a new `pending: false` entry.

Replaces the prior content-match-against-last-10-entries approach, which silently dropped legitimate rapid-fire duplicates (e.g. "yes" sent twice within five turns). Pending/confirmed correctly distinguishes "transcript confirms a send already shown" from "two distinct sends that happen to have identical text."

### Tool cards dedup STRUCTURALLY, never by uuid

`TRANSCRIPT_TOOL_USE` deliberately has **no `seenUuids` guard**, unlike `TRANSCRIPT_USER_MESSAGE` / `TRANSCRIPT_ASSISTANT_TEXT`. CC rewrites a JSONL line as the assistant message grows, and a rewrite can carry **new** `tool_use` blocks under the already-seen line uuid — so the watcher re-emits tool-use on repeats by design (`transcript-watcher.ts` `readNewLines`). A uuid guard here would silently swallow those tools; missing cards are far worse than doubled ones.
<!-- verify: {"path": "youcoded/desktop/src/renderer/state/chat-reducer.ts", "contains": "IDEMPOTENT by tool id"} -->

Instead every write on this path is idempotent by `toolUseId`:

- the `toolCalls` Map — `Map.set` overwrites;
- **group placement** — `placeToolInCurrentGroup` scans `toolGroups` for the id first and no-ops if already placed, so neither the append nor the new-group branch can double it. A re-emit must also leave `currentGroupId` untouched, or it would retarget where subsequent new tools land. This is a shared helper, not inline in the handler: `NATIVE_TOOL_PREPARING` (the native runtime's preparing card, drawn while a tool call's arguments are still streaming) places its card through the **same** function under the provider's real tool call id, which is what lets the later `TRANSCRIPT_TOOL_USE` supersede it in place rather than render a second card beside it. If the two paths ever place differently, that is the bug;
- `injectPlanSegment` (ExitPlanMode) — dedups by `toolUseId`, updating in place so a later, fuller emit still refreshes content.

`PERMISSION_REQUEST` matches only `running` tools, so a re-delivery for a tool already flipped to `awaiting-approval` would fall through to the synthetic-placeholder branch; it bails first if any tool already carries that `requestId`.
<!-- verify: {"path": "youcoded/desktop/src/renderer/state/chat-reducer.ts", "contains": "never synthesize a SECOND placeholder"} -->

Guard: `chat-reducer.test.ts` → "chatReducer tool card duplication". Historically this surfaced as **duplicate AskUserQuestion prompts appearing once answered** — `AssistantTurnBubble` hides `awaiting-approval` tools from groups (they render as a bottom bubble instead), so a doubled group entry stayed invisible until the answer cleared that status.

## Per-turn metadata

`AssistantTurn` carries four fields populated from the JSONL transcript:

- `stopReason: string | null` — set only for non-`end_turn` completions (`max_tokens`, `refusal`, `stop_sequence`, `pause_turn`, `interrupted`, `question_dismissed`, and the native harness's `empty_response` — an open set: unknown values render via the footer's generic fallback). Rendered inline as a footer under the affected turn; `null` means the turn completed normally. The transcript-watcher filters `tool_use` upstream; `end_turn` reaches the reducer but is filtered at the `AssistantTurnBubble` render gate (it's the normal case — no note needed). The single definition of "abnormal" is `abnormalStopReason` (exported from `chat-types.ts`), shared by the reducer's turn-complete mint gate, the bubble's footer gates, and — via `shouldRenderAssistantTurn` in the same file — the ChatView/BubbleFeed timeline gates.

**A turn is NOT guaranteed to have segments** (2026-08-21, empty-step recovery): turns are normally minted by content actions, but `TRANSCRIPT_TURN_COMPLETE` mints a **segment-less** turn when it arrives with `currentTurnId === null` and an abnormal `stopReason`, so a fully-contentless turn (the `empty_response` worst case) still gets its footer row instead of unexplained silence. That mint is idempotent by the action's `uuid` via `seenUuids` (the watcher re-emits turn-complete and replay re-delivers it; without the guard each replay would append a ghost turn). Consumers must not index `segments[0]` unchecked, and the ChatView/BubbleFeed gates drop a segment-less turn only when its stopReason is normal/absent.
- `model: string | null` — Anthropic model ID (e.g. `claude-opus-4-7`). Captured on the first `TRANSCRIPT_ASSISTANT_TEXT` action (Task 2.4) and reconfirmed on `TRANSCRIPT_TURN_COMPLETE`. Drives (a) the opt-in per-turn metadata strip and (b) a reconciliation `useEffect` in App.tsx that silently updates the session-pill `sessionModels` when the transcript reveals drift (user typed `/model X` in the terminal, rate-limit downshift, session resume).
- `usage: TurnUsage | null` — `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }` from `message.usage`. Populated on `TRANSCRIPT_TURN_COMPLETE`. Displayed only when the `showTurnMetadata` theme-context preference is on (default off — follows the "default hidden" precedent set by the derived StatusBar widgets).
- `anthropicRequestId: string | null` — `req_…` from the transcript line's outer `requestId` field. Surfaced in `AttentionBanner` when state is `session-died` or `error` so the user can reference it when reporting issues.

**Distinct from the permission-flow `requestId`** on `ToolCallState` (used by `PERMISSION_REQUEST` / `PERMISSION_RESPONSE`). The permission `requestId` is a YouCoded-internal approval-flow ID; `anthropicRequestId` is the Anthropic API request ID. Don't conflate — the distinctive name prevents silent cross-wiring.

All four fields default to `null` on turn creation. The reducer's `TRANSCRIPT_TURN_COMPLETE` handler builds the metadata-stamped `assistantTurns` first and then **hands that map to `endTurn()` as its third argument**. It must not spread `endTurn()` over its own `assistantTurns`: since preparing-card reaping landed, `endTurn()` returns an `assistantTurns` of its own (it prunes the turn segment of any group it empties), so a trailing spread would silently drop the metadata this section is about. See the trap under [endTurn() helper](#endturn-helper).

## PITFALLS-triage additions (2026-07-15)

### Transcript watcher read-integrity (`transcript-watcher.ts`, `subagent-watcher.ts`)

- **`readNewLines` must isolate each emit in try/catch.** `session.offset` advances before the emit loop, so a throwing listener aborting the loop strands every subsequent chunk in the batch (next `readNewLines` reads from the advanced offset forward). A root cause of "rare Claude message not appearing." Keep the per-emit try/catch — do NOT collapse to a batch-level wrapper.
- **`readNewLines` is SERIALIZED per session (`reading` flag + coalesced rerun)** (2026-07-10, both watchers). The read is async (stat → open → read) and triggered concurrently by fs.watch bursts, the global poll, and manual calls. Un-serialized, two overlapping reads consumed the same byte range (duplicate user bubbles, tool cards flapping back to `running`) and — because the read POSITION was re-evaluated after the first read advanced the offset while `bytesRead` was ignored — a short/empty second read decoded its zero-filled buffer into the partial-line carry, wedging NUL bytes in and dropping the next message at `JSON.parse`. The other root cause of "rare missing Claude message." Pinned in `transcript-watcher.test.ts → read integrity`.
- **The incomplete-line carry is BYTES (`partialBytes: Buffer`), not a decoded string.** A string carry decodes each half of a multi-byte UTF-8 char to U+FFFD independently — emoji/CJK split across a read boundary garbled permanently. Stitch bytes before decoding. Don't "simplify" back to `partialLine: string`.
- **`getHistory` replay dedups by uuid with the SAME semantics as the live path** (skip repeated `assistant-text`, first write wins; tool-use/result/turn-complete still emit). The reducer absorbs the re-emitted tool events structurally, not by uuid — see "Deduplication" below. If replay semantics change, change the live path in the same commit.
- **`usePromptDetector` reads `getVisibleScreenText` (screen + margin), NOT the full scrollback; the classifier's IPC eval passes a 120-row tail.** Serializing the whole 1000+-row buffer per rAF flush was the top renderer CPU cost while streaming. The tail walk-back in `terminal-registry.getScreenText` never starts mid-wrapped-line — keep it. Load-bearing side effect: menus that scrolled into scrollback can no longer shadow a live Ink menu.
- **SubagentWatcher polls are slow (5s) safety nets by design — the fast paths are event-driven.** `TranscriptWatcher` calls `kickScan()` when a parent Agent tool_use lands (instant discovery of the subagents dir/new files) and `settleByParent()` when the parent's tool-result lands (final read, then the per-file stat poll stops; fs.watch stays attached). Don't speed the polls up "for responsiveness" (regresses idle-CPU accumulation) and don't remove the kick/settle calls.
- **`<local-command-stdout>`/`<local-command-stderr>` are STRIPPED ENTIRELY in `stripSystemTags` — DO NOT switch back to unwrapping.** CC writes these as dimmed status echoes. After every `/compact` it writes a follow-up user-type line `<local-command-stdout>[2mCompacted (ctrl+o to see full summary)[22m</local-command-stdout>`. Unwrapping let CC's echo reach `TRANSCRIPT_USER_MESSAGE`'s "no pending match" path, which BOTH appended a fake "Compacted…" user bubble AND set `isThinking:true` with no turn to ever clear it (chat permanently stuck thinking after compaction). Both TS and Kotlin parsers strip these entirely; `transcript-watcher.test.ts` pins the JSONL fixture line. Route any new slash-command output through a NEW event type — don't reintroduce the user-message path.
- **The `compact-summary` transcript event carries the full summary text in `data.summary`.** `SystemMarker.tsx` renders click-to-expand on the thin "Compacted · freed X tokens" divider. Both `App.tsx` and `BubbleFeed.tsx` forward `event.data.summary` into `COMPACTION_COMPLETE`; the reducer stores it on `SystemMarker.summary`. Aborted/watchdog completions carry no summary — keep the `expandable = !!marker.summary` gate.

### Rule-overflow additions (2026-08-12, migrated verbatim from the path-scoped rule)

- **A permission ask binds ONLY to a running tool with a MATCHING NAME** (input-match, then name-match). There is deliberately no name-agnostic fallback — one existed until 2026-08-09 and let an ask that arrived before its own `tool_use` hijack an unrelated card, so the card named Bash while its buttons approved Read. *Why:* showing one tool's identity on a card that authorizes another is a CONSENT bug, not a cosmetic one. Guard: `chat-reducer.test.ts` → "PERMISSION_REQUEST tool identity".
- **`TRANSCRIPT_REPLAY_COMPLETE` reaps tools a replayed transcript left `running`, and ONLY when `sessionIdle`** — a transcript ends wherever the process died, so its last `tool_use` may have no result. Orphans are marked **failed, never complete** (we don't know if the tool finished). The idle gate exists because the same replay fires on a live re-dock, where the running tool is real; only `NativeSessionHost.isIdle()` can affirm it, so CC sessions report false and keep the orphan. Guard: `chat-reducer.test.ts` → "TRANSCRIPT_REPLAY_COMPLETE".

### Spinner classifier regex-anchoring (`attention-classifier.ts`)

- **Spinner classifier matches glyph + gerund + ellipsis ONLY — no seconds counter, no "esc to interrupt".** CC v2.1.119 emits `<glyph> Gerund…` with no suffix. The old regex required `(Ns · esc to interrupt)` and silently failed on every real turn → the no-spinner-20s escalation flashed the wrong "Still waiting on Claude" banner during every long thinking turn. Active-vs-stalled is decided by glyph rotation (same glyph ≥30s = stalled, threshold raised from 10s after CC was observed holding one glyph 10–20s during silent thinking). Since 2026-04-30 (`669fc86d`) a parallel paren-wrapped `(Nm Ns · …)` `COUNTER_RE` gives an independent OR liveness signal; `previousCounterSeconds` feeds back through `ClassifierContext` so the no-signal-20s escalation gates on BOTH glyph absence AND counter non-advancement. `SPINNER_RE` was widened `[A-Za-z]+…` → `[A-Za-z][A-Za-z +\-]*…` for multi-word gerunds.
- **`SPINNER_RE` is anchored to start of line — DO NOT remove the `^`.** The false-match probe (`test-conpty/test-attention-false-match.mjs`, `@xterm/headless` for production-accurate rendering) confirmed that without the anchor the classifier matches Claude's response text containing `* Loading…` bullets, echoed prompts with literal spinner glyphs (`❯ Output…: ✻ Pondering…`), and `●`-prefixed assistant turns. Real CC spinner lines always have the glyph at column 0. The pattern STOPS at `…` so it still matches the hook-execution variant `✶ Channelling… (running stop hook · 3s · ↓ 1 tokens)`. If you tighten further (e.g. requiring trailing whitespace), the hook variant silently stops matching. Verify on a CC bump: `test-conpty/test-spinner-fullcapture.mjs` + `test-conpty/test-attention-states.mjs` (both wired into `cc-dependencies.md` "PTY spinner regex").

### Terminal byte stream — Android xterm-in-WebView (`terminal-emulator-vendored/`, `usePtyRawBytes.ts`, `TerminalView.tsx`)

- **`terminal-emulator-vendored/` is pinned to Termux v0.118.1 with a single documented patch** (a `RawByteListener` hook on `TerminalEmulator.append()`). `VENDORED.md` is the source of truth. Never edit outside the documented patch.
- **The vendored emulator is HEADLESS as of Tier 2.** The native Termux `TerminalView` Compose block was removed from `ChatScreen.kt` + the `terminal-view:v0.118.1` Maven dep dropped. `TerminalSession` still owns the PTY fork + JNI waitpid loop + `TerminalEmulator.append()`; `RawByteListener` is the single tap point feeding bytes to React xterm via `pty:raw-bytes`. Don't reintroduce a native render path.
- **`RawByteListener` fires on the terminal thread** (same thread that calls `append()`). Implementations MUST copy bytes before any async work — Termux reuses the same `byte[]` across PTY reads. `PtyBridge.rawByteFlow` uses `tryEmit` on a bounded `MutableSharedFlow` so a slow consumer drops bytes rather than blocking the terminal thread.
- **`pty:raw-bytes` payload is base64-encoded** (JSON can't carry binary; UTF-8 corrupts high-bit ANSI bytes). Never change the encoding without updating `raw-byte-listener-contract.test.ts` + every consumer at once. Full three-surface parity: `preload.ts` (no-op stub), `remote-shim.ts` (real per-session dispatch), `SessionService.kt` — asserted by `ipc-channels.test.ts` (no `ipc-handlers.ts` entry — it's a push event).
- **xterm display-only on touch.** `TerminalView` passes `disableStdin:true` on touch platforms (Android + remote browser) and skips `terminal.onData → sendInput`; typing flows through InputBar minimal-mode `<textarea>`. Don't reintroduce xterm-side touch input (re-exposes xterm.js #2403 IME issues). Single-finger touch scroll is custom capture-phase JS routing to `terminal.scrollLines()` (xterm's mouse selection bypassed via `preventDefault`); text selection on touch is unavailable — don't "fix" by removing the handlers.
- **`shared-fixtures/attention-classifier/` is the contract** — adding a `BufferClass` or tweaking a `classifyBuffer` regex requires a fixture change in the same commit; `attention-classifier-parity.test.ts` enforces it.
- **xterm scrollback can show duplicated TUI chrome** — CC (Ink) redraws its full TUI on certain events; when it exceeds visible rows, older content scrolls into xterm's scrollback. No xterm option discards programmatically-scrolled content (alt-screen would lose ALL scrollback). Mitigation deferred (bumping `scrollback` to 5000+ would let history coexist with banner duplicates).

## The `stalled` attention state and the Retry erase (2026-08-16, youcoded master `28d3f82e`)

The renderer half of "a stalled turn waits for you". Main-process half:
`youcoded/docs/native-runtime.md` → "A stalled turn parks instead of dying". Spec:
`youcoded-dev/docs/archive/specs/2026-08-16-stalled-turn-never-dies-design.md`.

### `AttentionState` gained a fifth state

The union is now `'ok' | 'stuck' | 'session-died' | 'error' | 'stalled'`, and every
member still has exactly one writer — the rule that keeps dead `AttentionBanner` branches
from accumulating. `TRANSCRIPT_THINKING_HEARTBEAT` writes three of them, in descending
severity:

| Heartbeat payload | `attentionState` | Dot | What the user sees |
|---|---|---|---|
| `{stalled: true}` | `'stalled'` | RED | The park card: "Provider may have stalled", counting up, Retry + Stop |
| `{stallWarning: …}` | `'stuck'` | AMBER | The countdown warning |
| payload-less | `'ok'` | — | Activity resumed; clears both |

Before this change the warning branch wrote `'ok'`, so the dot stayed GREEN for the whole
countdown — the app asserting health while telling the user it might be hanging. `'stuck'`
already meant exactly "something may be wrong and I don't know", which is what a warning
is, so the warning was routed there rather than given a state of its own. Consequence
worth knowing: `RED_ATTENTION` is `{stalled, session-died, error}`, which leaves `'stuck'`
as the only amber state. `attentionDotColor()` is the single source for those colours —
the buddy `AttentionStrip` had drifted to a private table painting `'stuck'` red and now
defers to it, which moved four pill colours (`stalled` blue→red, `session-died` grey→red,
`error` blue→red, `stuck` red→amber).

### `stalledSince` — stamped once, held, and cleared at the one write site

The card counts up from `stalledSince` on THIS client's clock (see `chat-types.ts` on the
cross-device skew note: a phone hydrating a parked desktop session gets the desktop's
stamp). A repeat `stalled` heartbeat must not restart the count, so the stamp is held —
but held *only while the session was already `'stalled'`*:

```ts
stalledSince: action.stalled
  ? (session.attentionState === 'stalled' ? (session.stalledSince ?? Date.now()) : Date.now())
  : null,
```

The naive `session.stalledSince ?? Date.now()` is wrong because **fourteen places in the
reducer write `attentionState: 'ok'` and only five of them also clear the stamp.** The
other nine (both `TRANSCRIPT_USER_MESSAGE` branches, both `NATIVE_TOOL_PREPARING`
branches, both `TRANSCRIPT_TOOL_USE` branches, `TRANSCRIPT_TOOL_RESULT`, and both
`PERMISSION_REQUEST` branches) leave it set, so any of them landing between two parks left
the SECOND card counting from the FIRST park — "no response for 6m 12s" three seconds in.
Gating on the state the stamp belongs to closes the whole family at the ONE place the
field is written, instead of adding nine `stalledSince: null` lines and forgetting the
tenth. `AttentionBanner` is the only reader, which is what makes that safe.

`endTurn()` clears `attentionState`, `stallWarning` AND `stalledSince`, and every turn
boundary (`turn-complete` / `user-interrupt` / `session-error`) spreads it — so a parked
card cannot outlive its turn and the harness needs no extra "un-park" event.

### `NATIVE_PARTS_DROPPED` erases only the TRAILING run

Manual Retry abandons an attempt whose text is already on screen. Without an erase, the
re-run's deltas merge into the same segment by `partId` and the user reads the half
sentence twice — which is precisely why the *automatic* retry has always refused to run
after content streamed.

The first implementation filtered the whole turn by `partId`. That was a worse bug than
the one it fixed: **part ids are not unique within a turn.** The AI SDK falls back to the
literal `text-0` when the provider omits an id, and a turn spans many steps (each tool
call starts a new one), so the same id legitimately appears on an earlier, already-finished
step. A whole-list `.filter()` therefore deleted finished paragraphs the user had already
read.

The shipped rule walks from the END and removes only the trailing run of matching
segments, stopping at the first non-match. What makes it safe is that a tool-group (or
plan) segment carries no `partId` at all, so it always counts as non-matching and stops
the walk — and a tool-group segment always separates one text step from the next. The
merge check only ever inspects `segments[length-1]`, so an earlier finished segment is
architecturally unreachable for accidental re-merge.

**Accepted limitation:** if ONE attempt produced text → a tool-preparing card → more text
before stalling, the tool-group separator stops the walk and the re-run re-emits the
earlier text, leaving a duplicate. Strictly better than the alternative — duplicated text
beats deleted text. It needs a model that resumes prose after starting a tool call and
then stalls. Guard: `attention-reducer.test.ts` → the `stalled turn` describe (four `NATIVE_PARTS_DROPPED` cases, including the reused-partId regression).

Ordering is guaranteed end to end without any explicit sequencing: the harness emits
`dropPart` BEFORE returning its retry sentinel, and `App.tsx` / `BubbleFeed.tsx` dispatch
`NATIVE_PARTS_DROPPED` from a block placed above the heartbeat dispatch in the same
handler, with both dispatch queues plain FIFO.

### The PTY classifier must not reset a state it never set

`useAttentionClassifier`'s cleanup branch dispatched `ATTENTION_STATE_CHANGED → 'ok'` for
ANY non-ok state at mount. For a NATIVE session `active` is constant-false, so it fired
exactly once at `ChatView` mount and threw away whatever attention state was already
there. Both `'ok'` dispatch sites are now gated on `hasBuffer` (`provider === undefined ||
provider === 'claude'`), and `hasBuffer` is a real dependency rather than a stale closure
read; the currently-unreachable teardown site is guarded too so the pair cannot drift.

Blast radius before the fix was narrow but real: `chat:hydrate` is REMOTE-ONLY (the
desktop path deliberately does not serve it), so ordinary desktop mounts with `'ok'` long
before any park. What broke was **a phone reconnecting to an already-parked desktop
session** — hydrate carried `attentionState: 'stalled'` correctly and the classifier
discarded it, so the user saw a spinner instead of the card with the buttons. Claude Code
behaviour is byte-identical, because `hasBuffer` is true for every CC session. Guard:
`useAttentionClassifier.test.tsx` (a `renderHook` probe), plus a live CDP probe against
the workbench at `?stalled=1` that showed `card:false` with the fix reverted.

### Declared behaviour change: the composer Stop button while `'stuck'`

`useStreamingGate` required `attentionState === 'ok'`, so the square Stop button vanished
the moment the stall warning fired — and `StopButton` exists specifically for touch/phone
users with no ESC key, making a phone turn un-stoppable during the countdown. The positive
test became a negative `TURN_IS_OVER` set, which `'stuck'` and `'stalled'` are not in. That also changes CLAUDE CODE behaviour, since `'stuck'` is CC-only
via the classifier: a stuck CC session now shows Stop where master hid it. Kept
deliberately — it is the same safety argument, and the click writes exactly `'\x1b'`,
byte-identical to ESC, beside a still-enabled Send. Spec §12 was amended rather than the
behaviour reverted, and both directions are pinned by tests.

### Rule-overflow additions (2026-08-16, migrated from the path-scoped rule)

Room for the above was made in `.claude/rules/chat-reducer.md` by dropping or compressing
bullets whose full text this document already carried: `getHistory` replay parity, and the
rationale clauses of `readNewLines`-is-serialized, the bytes carry, `stripSystemTags`, the
spinner regex, `TRANSCRIPT_REPLAY_COMPLETE`'s `isIdle()` gate, the permission-ask
input-then-name match order, the `pending`-flag dedup, and the vendored-emulator /
xterm-touch notes. Each was grep-verified present here before removal; no claim was lost.
The `subagent-watcher.ts` poll-cadence bullet and the `shared-fixtures/` contract were
deliberately KEPT in the rule despite also living here, because both of their globs are in
the rule's own `paths:` list — dropping them would have left an editor of those exact
files with no always-loaded invariant.

## Paged history (perf cycle 2, shipped 2026-08-28 — PR #349, `a09b58c6`)

Opening, resuming, re-docking or reloading a conversation renders only its most recent
`PAGE_TURNS` (30) turns. Older turns arrive when a 1px sentinel above the first entry
scrolls into view. Before this, every one of those paths replayed the WHOLE transcript:
21.6 s and a 14.5 s app-wide freeze on a 7,000-entry conversation.

**The reader.** `main/transcript-page.ts` → `readTranscriptPage({ jsonlPath, sessionId,
endOffset, subagentsDir })` returns the last ≤30 turns (≤2 MB) ending before a byte
offset, plus an opaque `{ path, offset, sizeAtRead }` cursor. It snaps page boundaries to
real user prompts — decided by asking `parseTranscriptLine` whether the line yields a
`user-message`, NOT by sniffing `promptId`, because a `tool_result` is also a
`type:"user"` line carrying one and snapping there would tear a tool call from its
result. The scan window is bounded by `PAGE_MAX_BYTES`, so it is one `pread` rather than
a backward chunk walk. A cursor pointing past the current file size (a `/clear` or
`/compact` rewrite) returns an empty final page rather than serving turns from a file
state the cursor never described. Subagent events are included only for `Agent`
tool_uses INSIDE the page: a throwaway `SubagentIndex` is primed from the page and
`SubagentWatcher.getHistory` skips whatever it cannot bind.

**Which file a page is read from** is a separate question from how it is read, and it has
its own module (`main/transcript-page-source.ts`). `TranscriptWatcher.pageSourceFor`
answers only for a session it is actively tailing, and there are three ordinary moments
when it is not: before CC's `SessionStart` hook reports the transcript path on a resume,
after `session-exit` tears the watcher down (the conversation stays on screen and
scrollable), and in the buddy floater, which never watched one. So the resolved path is
remembered per session — from a validated request locator, or read back from the watcher
when the hook starts it — and any later request answers from memory. Only the FIRST page
request carries a locator; every one after it has just a cursor.
<!-- verify: {"path": "youcoded/desktop/src/main/transcript-page-source.ts", "contains": "rememberLocator"} -->

**"Could not locate it" is not "this is the beginning."** Both were an empty page with
`hasMore: false` until 2026-09-07, and the renderer records the second — dropping the
cursor and the scroll-up sentinel for good, so the rest of the conversation became
unreachable in that window. `TranscriptPageResult.unresolved` separates them, on
`ipc-handlers.ts` AND `remote-server.ts` (the same React renderer runs over the remote
bridge). Callers retry rather than record: `ChatView` on a bounded backoff — at the top of
the list there is no scroll gesture left to re-trigger the sentinel, so it must heal on a
timer — and `App`/the buddy floater through `renderer/state/first-page-retry.ts`.
<!-- verify: {"path": "youcoded/desktop/src/shared/types.ts", "contains": "unresolved[?]: true"} -->

**No overlap, by construction.** `startWatching` starts the live tailer at end-of-file
for an existing file (it used to start at byte 0, re-emitting the whole transcript on
every resume) and `getStartOffset()` is the byte the first page reads UP TO. Page =
`[boundary, startOffset)`, live = `[startOffset, ∞)`.

**Native sessions** page over the already-MERGED event array (`NativeSessionHost
.getHistoryPage`), because `mergeChildEvents` interleaves delegated children and slicing
before the merge would drop a child whose parent card is in the page. Their cursor's
`offset` carries an array index; the renderer never inspects it.

**Idempotency is cursor discipline, not id identity.** Reducer ids are module counters
that only grow, so a prepended page cannot collide with what is on screen. One in-flight
page per session (`history.loading`, set BEFORE the await). The scratch replay is seeded
with the live session's `seenUuids` so the per-event handlers' existing dedup fires —
without it, a prompt the user had just sent came back from the transcript as a second
identical bubble.

**Scroll anchoring** is to an ELEMENT, not a height delta. `ChatView` records the topmost
visible `.timeline-entry` and its offset from the scroller's top edge one statement
before the prepend, then restores that element's position in a `useLayoutEffect` and
keeps re-applying for `ANCHOR_SETTLE_MS` (700 ms) as markdown and code blocks lay out,
releasing on the first `wheel`/`touchstart`/`keydown`. Height arithmetic was the first
attempt and Destin's verdict was "a little jumpy": the number was captured a network
round-trip early, applied once, and fought Chromium's own scroll anchoring. Prepending
also had to stop re-arming the "user sent a message" auto-scroll — the reducer spreads
the existing tail, so comparing last-entry IDENTITY tells a prepend from an append.

**What paging broke, and the rule it produced.** Four features depended on whole-file
replay as a SIDE EFFECT, and none of ~7,000 passing tests noticed: first-load history was
requested from three specific call sites (any other entry path rendered an empty
conversation — now a session-list effect covers every route); the Files drawer's list was
only refreshed because the artifact tool-use tracker sees replayed tool events (it now
lists on open, against the resolved `projectRoot`); the duplicate-bubble bug above; and
`session-totals`, whose own comment said it was "rebuilt for free when a resumed session
replays its record" (each page now folds its totals in via `mergeTotals`). Before
removing a broadcast, enumerate its listeners by CHANNEL and ask what each does when it
stops. Every fix was to make the consumer ASK rather than wait to be told.

**Still open:** eviction of off-screen turns (cycle 3 — it will amend
`toolcalls-never-cleared`, since paging itself never clears `toolCalls`), Android
on-device paging, and a re-docked session still paying a full replay because
`TRANSCRIPT_REPLAY` also re-sends broker-held asks and specialist runs that live only in
main's memory.

**Measured** (three consecutive rig runs): huge resume 21550 → 614 ms, medium 14049 →
644 ms, switch p95 10052 → 233 ms, PSS after six sessions 7004 → 1721 MB, medium replay
stall 14491 → 0 ms. Small conversations cost ~240 ms more (405 → 643) — the IPC
round-trip they now pay where the tailer used to stream them.
