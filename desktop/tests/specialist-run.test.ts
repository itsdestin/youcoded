import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { scriptedModel, stream, textChunks, multiDeltaTextChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist, type SpecialistDefinition, type SpecialistRoster } from '../src/main/harness/specialists/registry';
import { createTaskTool } from '../src/main/harness/tools/task';
import { SPECIALIST_IDLE_STALE_MS, SPECIALIST_IN_TOOL_STALE_MS } from '../src/main/harness/specialists/limits';
import { OWNER, RAW_REPORT_CAP_CHARS } from '../src/main/harness/specialists/delegation-ledger';
import { computeReportBudget } from '../src/main/harness/specialists/report-budget';
import { APPROX_CHARS_PER_TOKEN } from '../src/main/harness/message-size';

/** Remove a temp root a live NativeSessionHost was writing into.
 *
 *  `destroyAll()` does not drain the delegation ledger's writes — they are
 *  fire-and-forget by design (native-session-host.ts documents this: a failed
 *  bookkeeping write must never cost the user their session). So a `mutateJson`
 *  can still land inside `<root>/.youcoded/sessions` a tick after teardown
 *  begins, and a plain recursive remove then dies with
 *  `ENOTEMPTY: directory not empty` — a file appeared during its own walk.
 *  `force: true` does NOT cover that; it only swallows ENOENT.
 *
 *  Observed on ubuntu CI 2026-08-28 (a run otherwise fully green), failing a
 *  test that had already passed, because the teardown throws INTO the test.
 *
 *  maxRetries is Node's own answer: fs.rm retries EBUSY/EMFILE/ENFILE/ENOTEMPTY
 *  /EPERM with a linear backoff. Nothing is masked — a root that is genuinely
 *  un-removable still throws after the retries.
 */
function rmHostRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}


// ---- Task 7: the FOREGROUND specialist run ----------------------------------
// spawnSpecialist mints a child (Task 5), delivers the brief as its first turn,
// re-emits DISPLAY copies of its three subagent-visible event types under the
// PARENT's session id, and returns the child's last message as a
// headroom-capped report. These tests drive the whole path through the real
// host, a real SessionStore, and a real (scripted) HarnessSession.

const EXPLORER = resolveSpecialist('explorer')!;

// The three types the reducer's applySubagentEvent consumes (chat-reducer.ts).
// Anything else must NEVER be re-emitted stamped — see the "no stamped
// turn-complete" test below for what that would break.
const DISPLAY_TYPES = ['tool-use', 'tool-result', 'assistant-text'];

describe('specialist foreground run (Task 7)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  // ONE shared scripted model instance across every doStream call, so a script
  // spanning MORE THAN ONE TURN (the empty-report nudge) advances rather than
  // restarting — the factory is called once per turn, and a fresh instance per
  // call would replay script[0] forever.
  // `askHoldMs` (Task 8): overrides specialistAskHoldMs for a test that drives
  // a routed ask (max_steps/doom_loop/deny-listed) all the way to its
  // timeout — undefined keeps the real 5-minute production default, which
  // every OTHER test in this file relies on never actually firing.
  function boot(scripts: any[][], askHoldMs?: number) {
    const model = scriptedModel(scripts);
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, askHoldMs,
    );
    return model;
  }
  async function withParent(scripts: any[][], askHoldMs?: number) {
    boot(scripts, askHoldMs);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
  }
  // Every event the HOST emitted (what ipc-handlers forwards to the renderer).
  function collect(): any[] {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    return seen;
  }

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-run-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  // Two tool steps (distinct inputs, so the doom-loop guard can't trip) then a
  // final report message.
  const TWO_TOOLS_THEN_REPORT = [
    stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
    stream(toolCallChunk('c2', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls')),
    stream(...textChunks('t', 'REPORT: found it at src/x.ts'), finishChunk('stop')),
  ];

  it('re-stamps the child\'s display events onto the parent and returns its report', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const events = collect();

    const { childId, report } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    // (a) display re-stamping: child events arrive under the PARENT's sessionId
    //
    // 'subagent-usage' is excluded from this filter throughout: it is NOT a
    // stamped copy of a child event, it is the PARENT's own bookkeeping event
    // (the finished specialist's total spend, spec §2). It carries agentId only
    // to name which child the money belongs to, and unlike a display copy it IS
    // persisted to the parent's own record. Covered by
    // tests/subagent-usage-event.test.ts.
    const childStamped = events.filter((e) => e.data?.agentId === childId && e.type !== 'subagent-usage');
    expect(childStamped.length).toBeGreaterThan(0);
    for (const e of childStamped) {
      expect(e.sessionId).toBe('root-1');
      expect(e.data.parentAgentToolUseId).toBe('tc-1');
      expect(DISPLAY_TYPES).toContain(e.type);
    }
    // Both tool steps and the final text all made it through.
    expect(childStamped.filter((e) => e.type === 'tool-use')).toHaveLength(2);
    expect(childStamped.filter((e) => e.type === 'tool-result')).toHaveLength(2);
    expect(childStamped.some((e) => e.type === 'assistant-text')).toBe(true);

    // (b) NO stamped turn-complete/session-error ever reaches the host emitter —
    // a stamped turn-complete would hit the conversation-record ipc listener
    // (noteModelUsed) and the title feeder under the PARENT's id.
    expect(childStamped.find((e) => e.type === 'turn-complete')).toBeUndefined();
    // Stronger form of the same guard: the child's run must not put ANY
    // turn-complete / session-error / user-message on the host at all (the
    // parent ran no turn of its own during this test), stamped or not.
    expect(events.filter((e) => e.type === 'turn-complete')).toEqual([]);
    expect(events.filter((e) => e.type === 'session-error')).toEqual([]);
    expect(events.filter((e) => e.type === 'user-message')).toEqual([]);
    // Task 5's pin still holds: nothing is forwarded RAW under the child's id.
    expect(events.filter((e) => e.sessionId === childId)).toEqual([]);

    // (c) persistence separation: the child's own JSONL holds its transcript
    // under childId — including the turn-complete that was never re-emitted.
    const childEvents = store.readEvents(childId, root);
    expect(childEvents.length).toBeGreaterThan(1);
    expect(childEvents.map((e) => e.type)).toContain('turn-complete');
    expect(childEvents.map((e) => e.type)).toContain('user-message');
    expect(childEvents.every((e) => e.sessionId === childId)).toBe(true);

    // (d) the parent's file contains NO child-stamped events (display-only
    // re-emission — the copy is for the renderer, never for the parent's disk
    // record, which must stay a faithful record of the parent's own turns).
    await host.drain('root-1');
    const parentFile = store.readEvents('root-1', root);
    expect(parentFile.filter((e) => e.data?.agentId && e.type !== 'subagent-usage')).toHaveLength(0);
    // The ONE agentId-bearing event that DOES belong on the parent's disk: the
    // specialist's spend. It has to persist, or a resumed session would forget
    // every specialist it ever paid for (spec §2, consequence 3).
    expect(parentFile.filter((e) => e.type === 'subagent-usage')).toHaveLength(1);

    // (e) the report comes back, wrapped with a header and a transcript pointer
    // — Task 8: the header carries the child's assigned fun title, not the
    // bare displayName, so match the title shape rather than a fixed string.
    // Task 10: the UNTRUNCATED footer is the short `[specialist session <id>]`
    // tag (1c's card-linking anchor) — 1a's "[full transcript: ...]" wording
    // is now reserved for the truncated case's real file pointer below.
    expect(report).toContain('REPORT: found it');
    expect(report).toMatch(new RegExp(`## Report from \\w+ the \\w+ Explorer \\(${EXPLORER.id}\\)`));
    expect(report).toContain(`[specialist session ${childId}]`);
  });

  // Task 7 (plan 1c): a helper's REASONING belongs in its own card's Thinking
  // row (R6) — the widened predicate (isSubagentDisplayEvent) re-emits an
  // `assistant-thinking` event ONLY when it carries data.text, using the
  // harness's REAL reasoning-delta stream path (harness-session.ts) rather
  // than a synthetic event, so this pins the whole path end to end.
  it('a child\'s assistant-thinking WITH text reaches the parent as a stamped copy (parentAgentToolUseId + agentId)', async () => {
    await withParent([
      stream(
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'weighing which file to check first' },
        { type: 'reasoning-end', id: 'r1' },
        ...textChunks('t', 'REPORT: found it at src/x.ts'),
        finishChunk('stop'),
      ),
    ]);
    const events = collect();

    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });

    const thinking = events.find((e) => e.type === 'assistant-thinking' && e.data?.agentId === childId);
    expect(thinking).toBeDefined();
    expect(thinking!.data.text).toBe('weighing which file to check first');
    expect(thinking!.sessionId).toBe('root-1');
    expect(thinking!.data.parentAgentToolUseId).toBe('tc-1');
  });

  // Task 7 (plan 1c): the three NON-text-bearing shapes `assistant-thinking`
  // actually carries in production (harness-session.ts) — a payload-less
  // watchdog heartbeat, a stallWarning countdown, and a toolPreparing notice —
  // must never re-emit. Any of them showing up under the parent's id would
  // render as the PARENT's own status (a stall/prepare notice that isn't
  // happening to the parent at all), which is exactly what the predicate's
  // `data.text` check exists to prevent. Emitted directly on the child's own
  // session emitter (the same technique the heartbeat-staleness suite below
  // uses) so this is independent of whatever the scripted model's real stream
  // happens to produce.
  it('a payload-less heartbeat, a stallWarning, and a toolPreparing thinking event never do', async () => {
    const REPORT = stream(...textChunks('t', 'REPORT: done'), finishChunk('stop'));
    let fired = false;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (!fired) {
          fired = true;
          const entry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1')!;
          const [liveChildId, liveEntry] = entry as [string, { session: any }];
          liveEntry.session.emit('transcript-event', {
            type: 'assistant-thinking', sessionId: liveChildId, uuid: 'evt-hb', timestamp: Date.now(), data: {},
          });
          liveEntry.session.emit('transcript-event', {
            type: 'assistant-thinking', sessionId: liveChildId, uuid: 'evt-stall', timestamp: Date.now(),
            data: { stallWarning: { retryInMs: 5000, willRetry: true } },
          });
          liveEntry.session.emit('transcript-event', {
            type: 'assistant-thinking', sessionId: liveChildId, uuid: 'evt-prep', timestamp: Date.now(),
            data: { toolPreparing: { toolCallId: 'tc-x', toolName: 'Glob', chars: 3 } },
          });
        }
        return { stream: simulateReadableStream({ chunks: REPORT, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });

    const thinking = events.filter((e) => e.type === 'assistant-thinking' && e.data?.agentId === childId);
    expect(thinking).toEqual([]);
  });

  // Fix: harness-session.ts:1769 emits one assistant-text event per STREAM
  // DELTA for native models, not per whole message — the reducer's
  // applySubagentEvent (chat-reducer.ts) coalesces same-partId deltas back
  // into one segment, but that only works if the display re-stamping this
  // host does (spawnSpecialist's re-emit under the parent's sessionId)
  // actually carries the child's partId through. Pin that here at the host
  // level rather than only in the reducer unit tests.
  it('re-stamped assistant-text display events carry the partId the reducer needs to coalesce', async () => {
    await withParent([
      stream(...multiDeltaTextChunks('t', 'REPORT: found it ', 'at src/x.ts'), finishChunk('stop')),
    ]);
    const events = collect();

    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    const textEvents = events.filter((e) => e.data?.agentId === childId && e.type === 'assistant-text');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    // Every delta for this text block shares the SAME partId ('t', from the
    // script) — the exact signal the reducer keys its merge on.
    const partIds = new Set(textEvents.map((e) => e.data.partId));
    expect(partIds.size).toBe(1);
    expect([...partIds][0]).toBeTruthy();
  });

  it('tears the child down after a successful run (no live entry, no model ref, no writer lock)', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const released: string[] = [];
    host.setModelReleasedHandler((id) => released.push(id));

    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    expect((host as any).live.has(childId)).toBe(false);
    expect((host as any).childrenOf.get('root-1')?.has(childId)).toBeFalsy();
    // WHY read the map directly: isSpecialistWriterBusy was removed as dead
    // production code (only tests called it) — activeWriterChild is still
    // the source of truth this assertion verifies.
    expect((host as any).activeWriterChild.has('root-1')).toBe(false);
    // The child gave back its model ref: the parent is now 'm''s only user.
    expect(host.sessionsForModel('m')).toEqual(['root-1']);
    await host.destroy('root-1');
    expect(released).toEqual(['m']);
  });

  // Exclusion sweep pin (Task 8): the child's JSONL IS on disk after a
  // completed run (persistence is real — see the persistence-separation
  // assertion above), but SessionStore.list()'s default (includeChildren
  // false) must still hide it from every default listing surface. This is
  // the one behavior every list()-based consumer (Resume Browser via
  // NativeSessionHost.list(), NATIVE_SESSIONS_LIST) inherits for free — see
  // task-8-report.md for the full per-surface sweep this pin backs.
  it('a completed run leaves only the root visible to store.list()', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    // The child file genuinely exists on disk (persistence happened)...
    expect(store.readEvents(childId, root).length).toBeGreaterThan(0);
    // ...but the default (hidden-children) listing shows only the root.
    const visible = store.list();
    expect(visible.map((r) => r.sessionId)).toEqual(['root-1']);
    // Asking explicitly for children still finds it — this is a default, not
    // a deletion.
    expect(store.list({ includeChildren: true }).some((r) => r.sessionId === childId)).toBe(true);
  });

  it('a mid-run provider failure rejects with the real reason and still tears the child down', async () => {
    // Step 1 calls a tool; step 2's stream surfaces an error part, which the
    // driver throws (not retryable — no HTTP status) and reports as a
    // session-error transcript event. Awaiting the child's drain alone would
    // see a clean resolution here, which is exactly why runSpecialist listens
    // for the error event instead.
    await withParent([
      stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
      stream({ type: 'error', error: new Error('llama-server dropped the connection') }),
    ]);
    const events = collect();
    // Fix (Task 7 review, restoring Task 6 coverage lost in the foreground-run
    // rewrite): the success-path leak guard (native-session-host.test.ts "a
    // completed spawnSpecialist run does not leak the minted child") pins
    // childrenOf de-registration AND model-ref release; the failure path needs
    // the identical two assertions so a mid-run throw can't leave the child
    // wired into the parent's children set or holding a phantom model ref.
    const released: string[] = [];
    host.setModelReleasedHandler((id) => released.push(id));

    await expect(host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    })).rejects.toThrow(/llama-server dropped the connection/);

    // The failure reason is RELAYED, never replaced by a guess
    // (error-message-standards.md) — and no session-error was stamped onto the
    // parent's stream on the way out.
    expect(events.filter((e) => e.type === 'session-error')).toEqual([]);
    // No leak: the child that failed mid-run is gone from the live map.
    const childRow = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1');
    expect(childRow).toBeDefined();
    expect((host as any).live.has(childRow!.sessionId)).toBe(false);
    // WHY read the map directly: isSpecialistWriterBusy was removed as dead
    // production code (only tests called it) — activeWriterChild is still
    // the source of truth this assertion verifies.
    expect((host as any).activeWriterChild.has('root-1')).toBe(false);
    // De-registered from the parent's live children set (mirrors the
    // success-path leak guard) — a leaked child would still show up here.
    expect((host as any).childrenOf.get('root-1')?.has(childRow!.sessionId)).toBeFalsy();
    // The child's model ref did not leak either: destroying the parent (its
    // only remaining user of 'm') fully releases it exactly once.
    await host.destroy('root-1');
    expect(released).toEqual(['m']);
  });

  it('nudges EXACTLY once when the child ends with no report, and accepts the second answer', async () => {
    await withParent([
      // Turn 1 must end with no report DESPITE the harness's own empty-step
      // retry (spec 2026-08-21) — so it takes TWO consecutive empty streams
      // (attempt + silent retry → the turn ends 'empty_response'). Only then
      // does the delegation layer's nudge fire. This also pins the layered
      // recovery: step-level retry first, turn-level nudge second.
      stream(finishChunk('stop')),                                              // turn 1, attempt 1: empty
      stream(finishChunk('stop')),                                              // turn 1, silent retry: still empty
      stream(...textChunks('t', 'REPORT: after the nudge'), finishChunk('stop')), // turn 2: the real report
    ]);

    const { childId, report } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    expect(report).toContain('REPORT: after the nudge');
    // EXACTLY one nudge — retry budget 1 (spec §3). Two user messages in the
    // child's transcript: the brief, then the single reminder.
    const userMessages = store.readEvents(childId, root).filter((e) => e.type === 'user-message');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1].data.text).toMatch(/final message is your report/i);
  });

  it('fails typed when the child is still silent after its one nudge', async () => {
    await withParent([
      stream(finishChunk('stop')),   // scriptedModel replays its last script forever → both turns silent
    ]);

    await expect(host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    })).rejects.toThrow(/no final message|without producing a report/i);
  });

  it('caps the report against the specialist budget and says what it cut', async () => {
    // A report far over the explorer's 2000-token static cap. The parent has no
    // measured occupancy in this test, so the static cap is the binding one.
    const huge = 'x'.repeat(60_000);
    await withParent([
      stream(...textChunks('t', `REPORT: found it\n${huge}`), finishChunk('stop')),
    ]);

    const { report } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    expect(report).toContain('REPORT: found it');            // the head survives
    expect(report.length).toBeLessThan(huge.length / 2);     // ...but the bulk did not
    expect(report).toMatch(/truncated/i);                    // and the cut is stated, never silent
  });

  // ---- Task 10 (plan 1b): oversized reports spill to a readable file --------
  // `withParent` above never wires a nativeHome, so the truncation notice is
  // as far as those tests can check — these use a real NativeHome (same shape
  // as `withLedgerParent` below) so the spill file and its footer pointer are
  // both real and checkable on disk.
  describe('report overflow spills to a file', () => {
    async function withHomeParent(scripts: any[][]) {
      const model = scriptedModel(scripts);
      const home = new NativeHome(root);
      store = new SessionStore(new NativeHome(root));
      host = new NativeSessionHost(
        store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      return home;
    }

    it('spills the full body to a file when the report is truncated, and the footer names the real path', async () => {
      // Comfortably over EXPLORER's 2000-token static budget (~8000 chars)
      // but far under RAW_REPORT_CAP_CHARS (64,000) — isolates this
      // truncation-time spill from the separate completion-time one (Task 4).
      const big = 'y'.repeat(20_000);
      const full = `REPORT: found it\n${big}`;
      await withHomeParent([stream(...textChunks('t', full), finishChunk('stop'))]);

      const { childId, report } = await host.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });

      expect(report).toMatch(/truncated/i);
      const m = report.match(/Full report saved to: (.+) — Read it if you need the rest\.\]/);
      expect(m).toBeTruthy();
      const spilledPath = m![1];
      expect(fs.existsSync(spilledPath)).toBe(true);
      expect(fs.readFileSync(spilledPath, 'utf8')).toBe(full); // the FULL, untruncated body

      // Task 10's own doc comment on DelegationRecord.reportPath: "written at
      // COMPLETION ... or at delivery on budget truncation (Task 10)" — the
      // ledger record must carry the same path the footer names.
      const ledger = (host as any).ledger;
      const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec.reportPath).toBe(spilledPath);
    });

    it('does not spill a file when the report fits the budget', async () => {
      await withHomeParent([stream(...textChunks('t', 'REPORT: found it at src/x.ts'), finishChunk('stop'))]);

      const { childId, report } = await host.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });

      expect(report).not.toMatch(/truncated/i);
      expect(report).not.toContain('saved to');
      expect(report).toContain(`[specialist session ${childId}]`);

      const ledger = (host as any).ledger;
      const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec.reportPath).toBeUndefined();
    });

    it('degrades honestly when the spill write itself fails — the footer never claims a file that is not there', async () => {
      const big = 'y'.repeat(20_000);
      const home = await withHomeParent([stream(...textChunks('t', `REPORT: found it\n${big}`), finishChunk('stop'))]);
      vi.spyOn(home, 'writeSessionArtifact').mockImplementation(() => {
        throw new Error('simulated disk full');
      });

      const { report } = await host.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });

      expect(report).toMatch(/truncated/i);
      // The exact opposite of the success case: no path, no false claim.
      expect(report).not.toContain('saved to:');
      expect(report).not.toContain('Read it if you need the rest');
    });
  });

  // ---- Review round 2, Findings 1 & 2: a ledger write can throw (mutateJson
  // is lock-guarded — NativeHome.mutateJson throws on lock exhaustion) at two
  // points in spawnSpecialist, and neither may corrupt what a real run does.
  // These tests boot a host WITH a real ledger wired in (the plain `boot`/
  // `withParent` helpers above never pass a nativeHome, so `host.ledger` is
  // undefined there and none of this file's other tests exercise these
  // paths) and monkeypatch the ledger's methods to throw, the same fault-
  // injection shape `throwOnceFactory` uses elsewhere in this suite for the
  // model factory.
  describe('a ledger write failure never corrupts a real run (review round 2)', () => {
    async function withLedgerParent(scripts: any[][]) {
      const model = scriptedModel(scripts);
      const home = new NativeHome(root);
      store = new SessionStore(new NativeHome(root));
      host = new NativeSessionHost(
        store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    }

    it('Finding 1: a completion-write failure does not discard the report or relabel a successful run "failed"', async () => {
      await withLedgerParent(TWO_TOOLS_THEN_REPORT);
      const ledger = (host as any).ledger;
      const realUpdate = ledger.update.bind(ledger);
      let sawCompletedWrite = false;
      // Fail ONLY the completion write (status: 'completed') — recordStart
      // (before the run) still works, so the record genuinely exists.
      ledger.update = async (...args: any[]) => {
        if (args[3]?.status === 'completed') {
          sawCompletedWrite = true;
          throw new Error('simulated lock exhaustion');
        }
        return realUpdate(...args);
      };

      const { childId, report } = await host.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });

      expect(sawCompletedWrite).toBe(true); // sanity: the throwing write path actually ran
      // The report the child genuinely produced is still returned...
      expect(report).toContain('REPORT: found it at src/x.ts');
      expect(childId).toBeTruthy();
      // ...and the run is not relabeled a failure on disk because the
      // completion write blew up on the way out.
      const rec = ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(rec?.status).not.toBe('failed');
    });

    it('Finding 2: a recordStart failure still tears the child down — no leaked live entry, childrenOf, or model ref', async () => {
      await withLedgerParent(TWO_TOOLS_THEN_REPORT);
      const ledger = (host as any).ledger;
      ledger.recordStart = async () => { throw new Error('simulated lock exhaustion'); };

      const released: string[] = [];
      host.setModelReleasedHandler((id) => released.push(id));

      await expect(host.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      })).rejects.toThrow(/simulated lock exhaustion/);

      // The child that createChild minted before recordStart ever ran must
      // still be torn down — the LEAK GUARD (spawnSpecialist's finally) has
      // to cover this path too.
      const childRow = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1');
      expect(childRow).toBeDefined();
      expect((host as any).live.has(childRow!.sessionId)).toBe(false);
      expect((host as any).childrenOf.get('root-1')?.has(childRow!.sessionId)).toBeFalsy();
      expect((host as any).activeWriterChild.has('root-1')).toBe(false);
      await host.destroy('root-1');
      expect(released).toEqual(['m']); // the child's model ref did not leak either
    });
  });
});

// ---- Task 12, item 4: compaction-finalize ----------------------------------
// A small local window can force the child to auto-compact MORE THAN ONCE
// during one delegated run (spec §3: a designed path for small windows, not an
// edge case). On the SECOND auto-compaction, runSpecialist's listener posts a
// steer telling the child to stop exploring and write up what it has — via
// postSteer (Task 3's primitive), never a prompt edit. These tests drive the
// listener directly by emitting synthetic `compact-summary` events on the
// child's OWN session emitter (the exact channel runSpecialist listens on),
// rather than engineering a real tiny-context compaction trigger — the
// compaction MATH itself is already pinned in harness-compaction.test.ts; this
// suite is about the LISTENER's count-to-two-then-steer-once behavior.
describe('compaction-finalize steer (Task 12, item 4)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-finalize-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  const FINALIZE_STEER = 'You are running low on room even after summarizing. Stop new exploration — '
    + 'write up what you have and finish with your report now.';

  // Builds a host whose model, on every doStream call, looks up the freshly
  // minted specialist child (the one live entry that is not the root) and
  // fires `fakeCompactionCalls` synthetic compact-summary(autoCompaction:true)
  // events on the CHILD's own session emitter — the same 'transcript-event'
  // channel runSpecialist's onEvent listens on — before returning that step's
  // real scripted chunks. A spy on the child's postSteer is installed the
  // first time the child is found, so it is in place before any steer could
  // possibly fire.
  function bootWithFakeCompactions(scripts: any[][], compactionsPerCall: number[]) {
    let call = 0;
    let postSteerSpy: ReturnType<typeof vi.spyOn> | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const childEntry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
        if (childEntry) {
          const [childId, entry] = childEntry as [string, { session: any }];
          if (!postSteerSpy) postSteerSpy = vi.spyOn(entry.session, 'postSteer');
          const n = compactionsPerCall[call] ?? 0;
          for (let i = 0; i < n; i++) {
            entry.session.emit('transcript-event', {
              type: 'compact-summary',
              sessionId: childId,
              uuid: `fake-compaction-${call}-${i}`,
              timestamp: Date.now(),
              data: { summary: 'fake summary', autoCompaction: true },
            });
          }
        }
        const chunks = scripts[Math.min(call, scripts.length - 1)];
        call += 1;
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null);
    return () => postSteerSpy!;
  }

  const TWO_TOOLS_THEN_REPORT = [
    stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
    stream(toolCallChunk('c2', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls')),
    stream(...textChunks('t', 'REPORT: found it at src/x.ts'), finishChunk('stop')),
  ];

  it('posts the finalize steer exactly once, on the SECOND auto-compaction', async () => {
    // One auto-compaction on step 1 (no steer yet), the second on step 2
    // (steer fires here), none on step 3.
    const getSpy = bootWithFakeCompactions(TWO_TOOLS_THEN_REPORT, [1, 1, 0]);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    const postSteerSpy = getSpy();
    expect(postSteerSpy).toHaveBeenCalledTimes(1);
    expect(postSteerSpy).toHaveBeenCalledWith(FINALIZE_STEER);
  });

  it('still posts only ONCE per child even with a third auto-compaction later in the same run', async () => {
    const getSpy = bootWithFakeCompactions(TWO_TOOLS_THEN_REPORT, [1, 1, 1]);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    expect(getSpy()).toHaveBeenCalledTimes(1);
  });

  it('never steers when auto-compaction happens only once in the whole run', async () => {
    const getSpy = bootWithFakeCompactions(TWO_TOOLS_THEN_REPORT, [1, 0, 0]);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    expect(getSpy()).not.toHaveBeenCalled();
  });

  it('a manual (non-auto) compact-summary event never counts toward the finalize steer', async () => {
    // Same shape as maybeCompact's manual-/compact path (harness-session.ts
    // line ~1083): compact-summary WITHOUT autoCompaction. Two of these must
    // not add up to a steer — only autoCompaction:true events count.
    let call = 0;
    let postSteerSpy: ReturnType<typeof vi.spyOn> | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const childEntry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
        if (childEntry) {
          const [childId, entry] = childEntry as [string, { session: any }];
          if (!postSteerSpy) postSteerSpy = vi.spyOn(entry.session, 'postSteer');
          entry.session.emit('transcript-event', {
            type: 'compact-summary', sessionId: childId, uuid: `fake-manual-${call}`, timestamp: Date.now(),
            data: { summary: 'fake summary' },   // NO autoCompaction flag
          });
        }
        const chunks = TWO_TOOLS_THEN_REPORT[Math.min(call, TWO_TOOLS_THEN_REPORT.length - 1)];
        call += 1;
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    expect(postSteerSpy).not.toHaveBeenCalled();
  });
});

// ---- Task 7: heartbeat staleness — flags, never kills -----------------------
// Liveness is heartbeat-based, never wall-clock (spec §3): runSpecialist's
// listener tracks lastActivityAt + an open-tool-call set and polls them on an
// interval that only ever flips a `stale` flag on the ledger record (read by
// Task 5's status block) — it never aborts, interrupts, or fails the child.
// These tests use vitest fake timers and a model whose FIRST doStream call
// hangs until the test calls `release()`, so a synthetic event can be fired
// directly on the child's OWN session emitter (same technique the
// compaction-finalize suite above uses) at controlled fake-timer offsets,
// with no live model turn racing the assertions. `release()` always lets that
// turn finish normally, so every test proves the child actually completes.
describe('heartbeat staleness (Task 7)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-stale-')); });
  afterEach(async () => {
    vi.useRealTimers();
    await host?.destroyAll();
    rmHostRoot(root);
  });

  const REPORT_CHUNKS = stream(...textChunks('t', 'REPORT: done'), finishChunk('stop'));

  // Scoped fake-timer allowlist (never the bare `vi.useFakeTimers()`): the
  // host's send() intentionally defers the actual turn by one setImmediate
  // macrotask (native-session-host.ts:1430-1431, "let a same-tick send
  // dispatch" elsewhere in this same file), and `ai`'s simulateReadableStream
  // used below skips its own real/fake setTimeout(0) pacing via explicit null
  // delays — so setImmediate never needs to be faked here. Faking it anyway
  // would wedge every turn before its first doStream call ever runs (verified
  // empirically while writing these tests).
  const fakeStaleTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

  /** Boots a host with a REAL ledger wired in (the plain `boot`/`withParent`
   *  helpers elsewhere in this file never pass a NativeHome) and a model
   *  whose first doStream call locates the freshly-minted child, then hangs
   *  on `releasePromise` until the test calls `release()`. */
  function bootHangingChild() {
    let childId: string | undefined;
    let childEntry: { session: any } | undefined;
    let startedResolve: () => void;
    const startedPromise = new Promise<void>((r) => { startedResolve = r; });
    let releaseResolve: () => void;
    const releasePromise = new Promise<void>((r) => { releaseResolve = r; });
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call === 0) {
          const entry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
          if (entry) { childId = entry[0] as string; childEntry = entry[1] as { session: any }; }
          startedResolve();
          await releasePromise;
        }
        call += 1;
        return { stream: simulateReadableStream({ chunks: REPORT_CHUNKS, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    return {
      release: () => releaseResolve(),
      started: startedPromise,
      getChildId: () => childId!,
      getEntry: () => childEntry!,
    };
  }

  /** Boots the SAME kind of host, but hangs REAL TOOL EXECUTION rather than
   *  doStream. Tests 3/4 need to sit silent for 300s+ of (fake) time — long
   *  enough to cross the harness session's OWN per-step prefill watchdog
   *  (harness-session.ts's armWatchdog, ~240s+ by default), which would fire
   *  its own heartbeat and reset OUR clock too if a doStream call were still
   *  open (that overlap is real and correct — see the "open model request is
   *  never stale" test above). The genuinely realistic shape of "an
   *  unresolved tool call" is the model having ALREADY gotten its tool-call
   *  chunk back (the step's stream is fully drained, so the per-step watchdog
   *  is torn down — harness-session.ts:1840-1845 clears it in every step's
   *  `finally`) and the REAL tool execution just taking a long time — so this
   *  helper patches the child's real Glob tool to hang on `releasePromise`
   *  instead, letting the REST of the driver (permissions, the real tool-use
   *  event, doom-loop bookkeeping) run unmodified. */
  function bootHangingTool() {
    let childId: string | undefined;
    let toolStartedResolve: () => void;
    const toolStartedPromise = new Promise<void>((r) => { toolStartedResolve = r; });
    let releaseResolve: () => void;
    const releasePromise = new Promise<void>((r) => { releaseResolve = r; });
    const TOOL_CALL_CHUNKS = stream(toolCallChunk('t1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls'));
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call === 0) {
          const entry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
          if (entry) {
            childId = entry[0] as string;
            const session = (entry[1] as { session: any }).session;
            // Patch installed BEFORE this call returns, so it is in place
            // before the driver can possibly reach the real execute() below —
            // no race with when the test resumes after `started`/`toolStarted`.
            const tool = session.toolByName.get('Glob');
            const realExecute = tool.execute.bind(tool);
            tool.execute = async (...args: any[]) => {
              toolStartedResolve();
              await releasePromise;
              return realExecute(...args);
            };
          }
          call += 1;
          return { stream: simulateReadableStream({ chunks: TOOL_CALL_CHUNKS, initialDelayInMs: null, chunkDelayInMs: null }) };
        }
        call += 1;
        return { stream: simulateReadableStream({ chunks: REPORT_CHUNKS, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    return {
      release: () => releaseResolve(),
      toolStarted: toolStartedPromise,
      getChildId: () => childId!,
    };
  }

  /** Monkeypatches ledger.updateIfRunning (the write path staleness uses,
   *  same as the review-round-2 fault-injection tests above) so the test can
   *  deterministically AWAIT the real write the interval fires — a bare
   *  `await vi.advanceTimersByTimeAsync(...)` gives no guarantee the
   *  fire-and-forget disk write it triggered has actually landed yet. */
  function trackStaleWrites() {
    const ledger = (host as any).ledger;
    const real = ledger.updateIfRunning.bind(ledger);
    let lastWrite: Promise<void> = Promise.resolve();
    ledger.updateIfRunning = async (...args: any[]) => {
      lastWrite = real(...args);
      return lastWrite;
    };
    return { waitForWrite: () => lastWrite, ledger };
  }

  it('a silent child is flagged stale after the idle threshold and unflagged by its next event', async () => {
    fakeStaleTimers();
    const { release, started, getChildId, getEntry } = bootHangingChild();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    await started;
    const childId = getChildId();

    // Still under the idle threshold: not yet stale.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IDLE_STALE_MS - 10_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).not.toBe(true);

    // Cross it — the next poll tick flags it.
    await vi.advanceTimersByTimeAsync(20_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    // The child's NEXT event (fired directly on its own session emitter, the
    // exact channel runSpecialist's onEvent listens on) unflags it.
    getEntry().session.emit('transcript-event', {
      type: 'assistant-text', sessionId: childId, uuid: 'evt-unflag', timestamp: Date.now(),
      data: { text: 'still working', partId: 't2' },
    });
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(false);

    // The run still finishes normally — staleness never touched it.
    release();
    const { report } = await runPromise;
    expect(report).toContain('REPORT: done');
  });

  it('watchdog heartbeat events (text-less assistant-thinking) count as activity — an open model request is never stale', async () => {
    fakeStaleTimers();
    const { release, started, getChildId, getEntry } = bootHangingChild();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    await started;
    const childId = getChildId();

    // 90s of silence (under the 120s idle threshold)...
    await vi.advanceTimersByTimeAsync(90_000);
    // ...then the streaming watchdog's text-less, partId-less heartbeat
    // arrives — session-store.ts:93-95 drops it from disk, but the emitter
    // still fires, and that is exactly what must count as activity here (a
    // slow local prefill must never be flagged stale).
    getEntry().session.emit('transcript-event', {
      type: 'assistant-thinking', sessionId: childId, uuid: 'evt-heartbeat', timestamp: Date.now(),
      data: {},
    });
    await waitForWrite();

    // Another 90s since the heartbeat (180s total since the run started, but
    // only 90s since the last activity) — still must NOT be stale.
    await vi.advanceTimersByTimeAsync(90_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).not.toBe(true);

    // Sanity: the mechanism is not permanently exempted — with no further
    // heartbeats it does eventually trip once genuinely 120s pass.
    await vi.advanceTimersByTimeAsync(40_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    release();
    await runPromise;
  });

  it('an unresolved tool call uses the longer in-tool threshold', async () => {
    fakeStaleTimers();
    const { release, toolStarted, getChildId } = bootHangingTool();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    // Waits for the REAL Glob execute() to actually start — at that point the
    // REAL tool-use event has already fired (openTools now holds 't1') and
    // the model's step-level stream is fully drained, so there is no
    // per-step watchdog running underneath this wait.
    await toolStarted;
    const childId = getChildId();

    // Past the plain idle threshold (120s) but under the in-tool one (300s):
    // an open tool call must NOT be flagged yet.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IDLE_STALE_MS + 60_000); // 180s
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).not.toBe(true);

    // Past the in-tool threshold (300s total) — now it flags.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IN_TOOL_STALE_MS - (SPECIALIST_IDLE_STALE_MS + 60_000) + 10_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    // The tool result arrives — the run finishes normally afterward.
    release();
    const { report } = await runPromise;
    expect(report).toContain('REPORT: done');
  });

  it('staleness never interrupts, kills, or fails the child', async () => {
    fakeStaleTimers();
    const { release, toolStarted, getChildId } = bootHangingTool();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    await toolStarted;
    const childId = getChildId();

    // Go well stale — long past the (longer, since a tool is open) threshold.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IN_TOOL_STALE_MS + 60_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    // The child completes normally afterward — no abort, no interrupt, no
    // typed failure. spawnSpecialist resolves with its real report.
    // Staleness is proven; everything below is the ordinary completion path, so
    // hand time back to the real clock BEFORE waiting on it. Waiting under fake
    // timers does not work here: vi.waitFor advances the fake clock on every
    // check, so a 15s budget drives ~300 synthetic clock jumps through a system
    // whose staleness logic is driven by that same clock — the wait perturbs the
    // thing it is waiting for. Measured 2026-08-28: with fake timers still
    // installed this wait ran its full budget and never saw 'completed'.
    vi.useRealTimers();

    release();
    const { report } = await runPromise;
    expect(report).toContain('REPORT: done');

    // spawnSpecialist resolves on the REPORT; the ledger's completion write is
    // fire-and-forget behind it (same reason destroyAll does not drain — a
    // bookkeeping write must never cost the user their session). Reading the
    // status one-shot therefore races that write: macOS CI failed here with
    // `expected 'running' to be 'completed'` on 2026-08-28 while the report
    // assertion above passed.
    await vi.waitFor(() => {
      const pending = ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(pending?.status).toBe('completed');
    });
    const rec = ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
    expect(rec?.status).toBe('completed');
    // Torn down normally, same as every other successful run in this file.
    expect((host as any).live.has(childId)).toBe(false);
  });
});

// ---- Task 4: BACKGROUND specialist execution + idle-boundary delivery ------
// spawnSpecialistBackground resolves at LAUNCH (createChild + a 'running'
// ledger row) and hands the rest of the run to an un-awaited chain
// (runDelegation). The chain's eventual report (or typed failure) is injected
// into the parent's OWN conversation as a synthetic user-role turn — but ONLY
// once the parent reaches an idle boundary (queueDelivery / runTurns' tail),
// never spliced into a turn the parent is still running. All of these tests
// need a REAL ledger (a NativeHome pointed at the test's tmp root), since the
// delivery loop reads/writes it directly — same `home` pattern the "ledger
// write failure" describe block above uses.
describe('background execution + idle-boundary delivery (Task 4)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  function collect(): any[] {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    return seen;
  }

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-bg-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  it('background Task resolves immediately with a task_id while the child is still running', async () => {
    // No gating needed: send()'s dispatch is deferred one macrotask
    // (setImmediate), and spawnSpecialistBackground returns BEFORE its
    // un-awaited runDelegation chain ever reaches that dispatch — so by
    // construction the child cannot have started running yet at the moment
    // this call resolves. Asserting `inFlight` on the child's own live entry
    // (rather than just "the call resolved fast") is what actually pins
    // "still running", not just "hasn't finished".
    const model = scriptedModel([
      stream(...textChunks('t', 'REPORT: done'), finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const { childId, title } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    expect(childId).toBeTruthy();
    expect(title).toBeTruthy();
    // The parent itself was never touched — background delegation must not
    // block or busy the delegating session.
    expect(host.isIdle('root-1')).toBe(true);
    // The child, on the other hand, is genuinely mid-run: send() already set
    // inFlight synchronously, before this call ever returned.
    expect((host as any).live.get(childId)?.inFlight).toBe(true);

    // Let the child's run actually finish so afterEach's destroyAll() doesn't
    // race a live turn.
    await vi.waitFor(() => {
      const rec = (host as any).ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec?.status).toBe('completed');
    });
  });

  it('a background completion is injected as a user-role turn when the parent goes idle — never mid-turn', async () => {
    // The PARENT's own turn is gated (manually resolved) so it stays
    // in-flight for as long as the test needs — long enough for an
    // independently-triggered background child to run to completion while
    // the parent is still busy. The child gets a SEPARATE scripted model
    // instance; modelFactory routes the FIRST call (guaranteed to be the
    // parent's own turn, confirmed via `parentEntered` before the child is
    // ever spawned) to it and everything after to the child's model.
    let parentEntered = false;
    let releaseParent: () => void = () => {};
    const parentGate = new Promise<void>((res) => { releaseParent = res; });
    const parentModel = new MockLanguageModelV4({
      doStream: async () => {
        parentEntered = true;
        await parentGate;
        return { stream: simulateReadableStream({ chunks: stream(...textChunks('t', 'parent turn done'), finishChunk('stop')) }) };
      },
    });
    const childModel = scriptedModel([
      stream(...textChunks('t', 'REPORT: child done'), finishChunk('stop')),
    ]);
    let calls = 0;
    const factory = async () => (calls++ === 0 ? parentModel : childModel) as any;

    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, factory, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const sendResult = host.send('root-1', 'go');
    expect(sendResult.status).toBe('sent');
    await vi.waitFor(() => expect(parentEntered).toBe(true));

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      const rec = (host as any).ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec?.status).toBe('completed');
    });

    // The child finished, but the PARENT is still mid-turn — nothing may be
    // injected yet.
    expect(events.filter((e) => e.data?.injected === 'specialist-report')).toEqual([]);
    expect(host.isIdle('root-1')).toBe(false);

    releaseParent();
    await (host as any).live.get('root-1').running;

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.type).toBe('user-message');
    expect(injected.data.text).toContain('## Report from');

    // Ordering: the parent's own turn-complete happened strictly BEFORE the
    // injected notice — never spliced mid-turn.
    const turnCompleteIdx = events.findIndex((e) => e.type === 'turn-complete' && !e.data?.agentId);
    const injectedIdx = events.indexOf(injected);
    expect(turnCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(injectedIdx).toBeGreaterThan(turnCompleteIdx);
  });

  it('the injected report is formatted at DELIVERY time with concurrentReporters = number of pending deliveries', async () => {
    // Seed the ledger directly with TWO already-completed, undelivered
    // records (rather than racing two real specialist children to finish at
    // exactly the same moment) — the delivery loop only ever reads the
    // ledger, so this exercises the exact same code path deterministically.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    // A real (non-Infinity) remaining window is required — computeReportBudget
    // degrades to the static per-specialist cap when remaining is Infinity,
    // which would hide any difference concurrentReporters makes.
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: 3500, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // Force a KNOWN occupancy so `remaining` is deterministic instead of
    // whatever the chars/4 estimate of the assembled system prompt happens to
    // be — same private-field test seam this suite already uses for `live`.
    ((host as any).live.get('root-1').session as any)._contextUsedTokens = 500;

    const ledger = (host as any).ledger;
    const huge = 'x'.repeat(60_000);
    for (const childId of ['child-a', 'child-b']) {
      await ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc', agentType: EXPLORER.id, title: `Test ${childId}`, workDir: root,
        description: 'a test brief', background: true, status: 'running', startedAt: Date.now(),
        delivered: false, owner: OWNER, missedSteers: [],
      });
      await ledger.update(root, 'root-1', childId, { status: 'completed', endedAt: Date.now(), steps: 3, rawReport: huge });
    }

    const events = collect();
    (host as any).queueDelivery('root-1');
    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(2);
    });

    // remaining = window(3500) - used(500) = 3000. Same formula the code uses.
    const remaining = 3000;
    const budgetSolo = computeReportBudget({ staticCapTokens: EXPLORER.reportBudgetTokens, parentRemainingTokens: remaining, concurrentReporters: 1 });
    const budgetShared = computeReportBudget({ staticCapTokens: EXPLORER.reportBudgetTokens, parentRemainingTokens: remaining, concurrentReporters: 2 });
    expect(budgetShared).toBeLessThan(budgetSolo); // sanity: the split genuinely differs

    const injected = events.filter((e) => e.data?.injected === 'specialist-report');
    expect(injected).toHaveLength(2);
    for (const e of injected) {
      const len = (e.data.text as string).length;
      // Definitively NOT the single-reporter budget (which would be ~2x bigger)...
      expect(len).toBeLessThan(budgetSolo * APPROX_CHARS_PER_TOKEN);
      // ...and roughly consistent with the 2-way split, not near-zero.
      expect(len).toBeGreaterThan(budgetShared * APPROX_CHARS_PER_TOKEN * 0.5);
    }
  });

  it('a background child that dies mid-run delivers a typed failure notice, not silence', async () => {
    const model = scriptedModel([
      stream({ type: 'error', error: new Error('llama-server dropped the connection') }),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.data.text).toMatch(/failed/i);
    expect(injected.data.text).toContain(childId);

    // The failure is durable, not just relayed once: the ledger record itself
    // reads 'failed', and (Task 2's invariant) with the real thrown reason.
    const rec = (host as any).ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
    expect(rec.status).toBe('failed');
    expect(rec.failureText).toMatch(/llama-server dropped the connection/);
  });

  it('a background completion whose report exceeds the ledger cap spills the full body to a file', async () => {
    // External review (2026-08-12): the ledger caps rawReport at
    // RAW_REPORT_CAP_CHARS on every write — for a background run, nothing
    // ELSE ever sees the uncapped body again (the child is torn down right
    // after), so the completion handler must spill the full text to disk
    // BEFORE that cap silently discards it.
    const huge = 'y'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    const ledger = (host as any).ledger;
    await vi.waitFor(() => {
      const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec?.status).toBe('completed');
    });
    const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
    expect(rec.rawReport.length).toBe(RAW_REPORT_CAP_CHARS); // capped copy in the ledger
    expect(rec.reportPath).toBeTruthy();
    const spilled = fs.readFileSync(rec.reportPath, 'utf8');
    expect(spilled.length).toBe(huge.length); // the FULL, uncapped body
    expect(spilled.startsWith(huge.slice(0, 200))).toBe(true);
  });

  it('Task 10: a report already spilled at completion time is not spilled a SECOND time by delivery', async () => {
    // `huge` blows BOTH thresholds — RAW_REPORT_CAP_CHARS (64,000, the
    // ledger's completion-time spill) and EXPLORER's much smaller report
    // budget (formatSpecialistReport's own truncation-time spill, Task 10) —
    // so without reuse this would write the identical full body to disk
    // twice. `reportPath` on the ledger record (passed into formatDelivery)
    // is what lets Task 10's formatting step recognize "already spilled" and
    // skip its own write.
    const huge = 'w'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    const writeSpy = vi.spyOn(home, 'writeSessionArtifact');
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });

    // ONE write total: runDelegation's completion-time spill. Delivery must
    // reuse that same path rather than writing the full body a second time.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.data.text).toContain('Full report saved to:');
  });

  it('Critical fix pass 2 (2026-08-13): delivery never overwrites a spill path it just failed to read, and never claims it as the full report', async () => {
    // Simulates the completion-time spill file being unreadable by delivery
    // time (process restart, external cleanup — exactly what
    // readSessionArtifact's own doc comment anticipates). Mocking the READ
    // (rather than deleting the real file) is what makes this test able to
    // catch a re-spill: `writeSessionArtifact` is left REAL (spied, not
    // mocked), so if delivery re-writes the ledger's capped copy to the same
    // path, the file on disk actually changes underneath the still-genuinely-
    // full body a real reader could otherwise have recovered by, say, retrying
    // the read a moment later. Fix pass 1 (the prior "Critical fix" test this
    // one replaces) asserted the OPPOSITE of what's correct here — it treated
    // a second write that clobbers the real file with the capped copy as the
    // desired outcome, which is the exact data-loss bug this pass fixes.
    const huge = 'q'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    const writeSpy = vi.spyOn(home, 'writeSessionArtifact');
    vi.spyOn(home, 'readSessionArtifact').mockReturnValue(null);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });

    // ONE write total: runDelegation's completion-time spill. Delivery must
    // NOT re-spill the ledger's capped copy over it just because the read
    // failed — that would silently downgrade a possibly-still-good file to a
    // truncated one with no way back.
    expect(writeSpy).toHaveBeenCalledTimes(1);

    const ledger = (host as any).ledger;
    const rec = ledger.listFor(root, 'root-1')[0];
    expect(rec.reportPath).toBeTruthy();

    // The file on disk must be untouched by delivery: still the FULL
    // original body, not the ledger's capped copy. This is the assertion
    // fix pass 1's test never made — it checked footer wording only, so it
    // could not detect that the named file's content had been clobbered.
    const onDisk = fs.readFileSync(rec.reportPath, 'utf8');
    expect(onDisk.length).toBe(huge.length);
    expect(onDisk).toBe(huge);

    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    // The footer must not name rec.reportPath as holding the full report —
    // the code just proved it could not read that path, so claiming it does
    // is exactly the false claim under test. It must also not claim a SAVE
    // failed, since no save was attempted (attempting one is what would have
    // clobbered the file above).
    expect(injected.data.text).not.toContain(`Full report saved to: ${rec.reportPath}`);
    expect(injected.data.text).not.toContain('Full report saved to:');
    expect(injected.data.text).not.toContain('could not be saved to disk');
    // Plain, honest, model-facing: this is a shortened copy and the rest is
    // gone, full stop — no path implied to exist.
    expect(injected.data.text).toContain('[Truncated to fit. The full report is no longer available');
  });

  // ---- Fix pass (external review, 2026-08-12): three follow-on gaps ----------

  it('Finding 1: delivery of a spilled oversized report reads the FULL body back from disk, not the capped ledger copy', async () => {
    // The ledger's own rawReport is capped at RAW_REPORT_CAP_CHARS on every
    // write (delegation-ledger.ts's update()) — formatting delivery from
    // THAT copy alone understates the report's true size in
    // formatSpecialistReport's truncation notice for anything the completion
    // handler had to spill to disk. Proof: the notice must cite the FULL
    // body's length (bigger than the cap), not the capped copy's.
    const huge = 'z'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    // The notice must cite the REAL total (the spilled file's length), not
    // the ledger's capped copy — proof delivery read reportPath back rather
    // than formatting from rec.rawReport alone.
    expect(injected.data.text).toContain(`of ${huge.length} chars`);
    expect(injected.data.text).not.toContain(`of ${RAW_REPORT_CAP_CHARS} chars`);
  });

  it('Finding 2 (fix pass 2): a background completion whose ledger write ALWAYS fails still reaches the parent via the in-memory fallback lane, exactly once, and the ledger record is left honestly stranded', async () => {
    // Fix pass 1 responded to this finding by firing a SECOND write
    // (ledger.updateIfRunning) synchronously right after the first failed —
    // re-review rejected that: it's the same write against the same store
    // (both methods bottom out in NativeHome.mutateJson), so a systemic cause
    // (disk full, permissions, corrupt file, lock exhaustion) reproduces on
    // the retry identically. This test mocks ledger.update to throw on EVERY
    // call matching the completion shape (no mockImplementationOnce, and any
    // OTHER update() call is treated as a test bug via the else-throw) so a
    // retry through the same method could not possibly have recovered here —
    // proving delivery no longer depends on any ledger write landing at all.
    const model = scriptedModel([
      stream(...textChunks('t', 'REPORT: done via background'), finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const ledger = (host as any).ledger;
    let completionWriteAttempts = 0;
    vi.spyOn(ledger, 'update').mockImplementation(async (...args: any[]) => {
      const [, , , patch] = args as [string, string, string, any];
      if (patch.status === 'completed' && patch.rawReport !== undefined) {
        completionWriteAttempts++;
        throw new Error('simulated disk failure while recording specialist completion');
      }
      throw new Error(`unexpected ledger.update call in this test: ${JSON.stringify(patch)}`);
    });

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    // The parent still learns the truth even though the ledger never landed
    // the completion — delivered exactly once, via the in-memory fallback.
    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.data.text).toContain('REPORT: done via background');

    // The write failed exactly once — no retry against the same broken store.
    expect(completionWriteAttempts).toBe(1);

    // Honesty about what's lost: with the ledger unwritable, the record
    // itself is genuinely stranded at 'running' forever — this run cannot
    // survive a restart. The parent already has the report IN THIS SESSION,
    // which is the only guarantee the fallback lane makes.
    const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
    expect(rec.status).toBe('running');
    expect(rec.delivered).toBe(false);

    // No duplicate delivery: a later idle-boundary pass must not re-inject
    // the same report — the fallback entry was consumed on delivery, not
    // left behind for a second pass to find again.
    (host as any).queueDelivery('root-1');
    await new Promise((r) => setImmediate(r));
    expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
  });

  it('Finding 3: a destroy() racing the delivery loop leaves the report claimable again, never falsely confirmed', async () => {
    // The pre-existing queue-drain loop rechecks `this.live.get(sessionId)
    // !== entry` after every turn because destroy() can land mid-turn. The
    // delivery loop reused the same captured `entry` across three awaits
    // with no equivalent recheck — HarnessSession.destroy() aborts and
    // removeAllListeners()s (which is what actually stops appends being
    // persisted) WITHOUT throwing and WITHOUT setting any flag runNotice
    // checks, so an orphaned runNotice() call completes normally, having
    // shown the report to nobody. Simulate that exact "resolves normally on
    // a dead session" shape directly (rather than fighting HarnessSession's
    // real abort timing) by overriding the live session's own runNotice with
    // a manually-gated stub, destroying the parent while it's paused
    // mid-call, then releasing it.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const ledger = (host as any).ledger;
    await ledger.recordStart(root, 'root-1', {
      childId: 'child-x', parentToolCallId: 'tc', agentType: EXPLORER.id, title: 'Test child-x', workDir: root,
      description: 'a test brief', background: true, status: 'running', startedAt: Date.now(),
      delivered: false, owner: OWNER, missedSteers: [],
    });
    await ledger.update(root, 'root-1', 'child-x', { status: 'completed', endedAt: Date.now(), steps: 1, rawReport: 'REPORT: done' });

    const entry = (host as any).live.get('root-1');
    let enteredNotice = false;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => { releaseGate = res; });
    // Replace the live session's runNotice with a stub that pauses mid-call
    // (mirrors runNotice being suspended on an in-flight provider stream) and
    // then RESOLVES NORMALLY (no throw) once released — exactly the "no
    // throw" shape the WHY comment on the fix names.
    entry.session.runNotice = vi.fn(async () => { enteredNotice = true; await gate; });

    (host as any).queueDelivery('root-1');
    await vi.waitFor(() => expect(enteredNotice).toBe(true));

    // destroy() lands WHILE the delivery loop is awaiting runNotice — the
    // exact race the fix closes.
    await host.destroy('root-1');
    releaseGate();

    // The record must come back CLAIMABLE (not confirmed delivered): status
    // stays 'completed', delivered stays false, and the lease was released
    // rather than left dangling.
    await vi.waitFor(() => {
      const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === 'child-x');
      expect(rec?.claimedBy).toBeUndefined();
    });
    const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === 'child-x');
    expect(rec.status).toBe('completed');
    expect(rec.delivered).toBe(false);
  });

  it('Fix pass 3: claimUndelivered throwing does not wedge the session, and an in-memory fallback report still delivers in the same pass', async () => {
    // Pre-fix, `await this.ledger.claimUndelivered(...)` at the top of the
    // delivery loop was unguarded. A throw there propagated straight out of
    // runTurns (no try/finally existed), so the bare `entry.inFlight = false`
    // at the tail was never reached — the session stayed "in flight" forever,
    // and worse, a report already sitting safely in the in-memory fallback
    // lane was never even attempted this pass (the ledger lane runs first,
    // every iteration). This test proves both: the throw doesn't wedge the
    // session, AND the fallback lane still gets its turn in the SAME pass.
    const model = scriptedModel([
      stream(...textChunks('t', 'still here')), stream(finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const ledger = (host as any).ledger;
    vi.spyOn(ledger, 'claimUndelivered').mockRejectedValue(new Error('simulated ledger read failure'));

    // Seed the fallback lane directly with a report the child genuinely
    // produced — this is the exact state fix pass 2 leaves behind when the
    // ledger's completion write didn't land. This test's job is to prove a
    // THROWING ledger (not just an empty one) still lets this lane through.
    (host as any).inMemoryFallback.set('child-fb', {
      parentId: 'root-1',
      rec: {
        childId: 'child-fb', parentToolCallId: 'tc', agentType: EXPLORER.id, title: 'Test child-fb', workDir: root,
        description: 'a test brief', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
        steps: 1, rawReport: 'REPORT: from the fallback lane', delivered: false, owner: OWNER, missedSteers: [],
      },
    });

    (host as any).queueDelivery('root-1');

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.data.text).toContain('REPORT: from the fallback lane');

    // Not wedged: the entry the delivery pass ran on cleared inFlight, and
    // the session accepts (not queues-behind-forever) a subsequent send.
    await vi.waitFor(() => expect(host.isIdle('root-1')).toBe(true));
    const result = host.send('root-1', 'are you still there?');
    expect(result.status).toBe('sent');
  });

  it('Fix pass 4: a releaseClaim throw on a liveness-mismatch path is swallowed by releaseClaimSafely, not merely papered over by runTurns\' outer finally', async () => {
    // This replaces an earlier "Fix pass 3" version of this test that only
    // asserted `entry.inFlight` ends up `false`. That assertion does NOT
    // discriminate: runTurns' own outer try/finally (fix pass 3, unrelated to
    // releaseClaimSafely) clears `inFlight` on ANY throw escaping
    // drainDeliveries, guard or no guard — so the old test would still pass
    // even if releaseClaimSafely were reverted to a bare, unguarded
    // `await this.ledger.releaseClaim(...)`. It re-proved the structural fix
    // an earlier test ("claimUndelivered throwing does not wedge the
    // session…") already covers, not anything specific to this guard.
    //
    // The one thing that's ONLY true when the per-call guard exists: the
    // delivery pass itself completes WITHOUT throwing — releaseClaimSafely's
    // whole job is to swallow the ledger's throw so drainDeliveries (and the
    // runTurns call that awaits it) settle normally instead of rejecting.
    // Calling runTurns directly and awaiting its own returned promise (rather
    // than going through queueDelivery's `entry.running`, which is built with
    // `.then(resolve, resolve)` and would swallow a rejection before this
    // test could ever observe it) is what makes that difference observable.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const ledger = (host as any).ledger;
    await ledger.recordStart(root, 'root-1', {
      childId: 'child-x', parentToolCallId: 'tc', agentType: EXPLORER.id, title: 'Test child-x', workDir: root,
      description: 'a test brief', background: true, status: 'running', startedAt: Date.now(),
      delivered: false, owner: OWNER, missedSteers: [],
    });
    await ledger.update(root, 'root-1', 'child-x', { status: 'completed', endedAt: Date.now(), steps: 1, rawReport: 'REPORT: done' });
    vi.spyOn(ledger, 'releaseClaim').mockRejectedValue(new Error('simulated ledger write failure'));

    const entry = (host as any).live.get('root-1');
    let enteredNotice = false;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => { releaseGate = res; });
    entry.session.runNotice = vi.fn(async () => { enteredNotice = true; await gate; });

    // Drive runTurns directly (not via queueDelivery) so its returned promise
    // is the one this test awaits — the same delivery-loop code path, just
    // without the fire-and-forget wrapper that would hide a rejection.
    (host as any).pendingDeliveryParents.add('root-1');
    const pass = (host as any).runTurns('root-1', entry, async () => {}) as Promise<void>;
    await vi.waitFor(() => expect(enteredNotice).toBe(true));

    // destroy() lands while runNotice is paused — the delivery loop's second
    // liveness recheck (right after runNotice resolves) finds the entry
    // stale and calls releaseClaimSafely, which is mocked here to fail.
    await host.destroy('root-1');
    releaseGate();

    // Only true with the per-call guard in place: the pass resolves cleanly.
    // Without it, this same mocked failure would make `pass` reject.
    await expect(pass).resolves.toBeUndefined();
  });

  it('Fix pass 3: in-memory fallback entries for a parent are dropped once that parent session is destroyed', async () => {
    // Pre-fix, `inMemoryFallback` was never swept on destroy() or
    // destroyAll() — an entry for a parent torn down before its next idle
    // boundary stayed in the map forever, holding a full specialist report
    // in memory for a session that can never come back to read it.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    (host as any).inMemoryFallback.set('child-fb', {
      parentId: 'root-1',
      rec: {
        childId: 'child-fb', parentToolCallId: 'tc', agentType: EXPLORER.id, title: 'Test child-fb', workDir: root,
        description: 'a test brief', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
        steps: 1, rawReport: 'REPORT: never delivered', delivered: false, owner: OWNER, missedSteers: [],
      },
    });

    await host.destroy('root-1');

    const stillHeld = [...(host as any).inMemoryFallback.values()].some((e: any) => e.parentId === 'root-1');
    expect(stillHeld).toBe(false);
  });

  it('Fix pass 4: a background completion landing AFTER a plain destroy() of its parent is not leaked into inMemoryFallback', async () => {
    // The test above covers destroy()'s own sweep, which only removes
    // entries present AT CALL TIME. This covers the gap that sweep can't
    // reach: a background completion whose `.then` handler stashes a
    // fallback entry AFTER that destroy() already dropped the parent from
    // `this.live` — the same race destroyAll()'s own comment describes, but
    // previously patched only there. Exercised directly against
    // stashFallbackIfParentAlive (the guard spawnSpecialistBackground's
    // `.then` handlers route every stash through) rather than trying to win
    // a real async race, since the point under test is the guard itself.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.destroy('root-1'); // parent gone BEFORE the late completion arrives

    (host as any).stashFallbackIfParentAlive('root-1', 'child-late', {
      childId: 'child-late', parentToolCallId: 'tc', agentType: EXPLORER.id, title: 'Test child-late', workDir: root,
      description: 'a test brief', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
      steps: 1, rawReport: 'REPORT: arrived too late', delivered: false, owner: OWNER, missedSteers: [],
    });

    expect((host as any).inMemoryFallback.has('child-late')).toBe(false);
  });

  it('Fix pass 5: a background report is never delivered twice when runNotice succeeds but the follow-up confirmDelivered write fails', async () => {
    // Two on-disk states look identical (delivered: false, claimedBy cleared
    // or self) but mean opposite things: the claim landed but runNotice() was
    // never called — safe to retry, the exact scenario fix pass 4's
    // self-reclaim exists for — vs runNotice() already ran (the report is
    // already in the parent's conversation) and only the follow-up
    // confirmDelivered write failed — retrying calls runNotice() a SECOND
    // time, showing the model and the user the same report twice. Before fix
    // pass 5, nothing on disk told these two states apart. This proves the
    // second case is never retried, even though releaseClaimSafely's own
    // real releaseClaim call (not mocked here) succeeds and clears claimedBy
    // — which is exactly the condition that used to make this record look
    // like "never claimed" again.
    const model = scriptedModel([stream(...textChunks('t', 'REPORT: done once'), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const ledger = (host as any).ledger;
    vi.spyOn(ledger, 'confirmDelivered').mockRejectedValue(new Error('simulated ledger write failure'));

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const firstInjection = events.filter((e) => e.data?.injected === 'specialist-report');
    expect(firstInjection[0].data.text).toContain('REPORT: done once');

    // The ledger record: injection was durably marked attempted, but never
    // confirmed delivered (the mocked write failed), and the lease WAS
    // cleared for real.
    await vi.waitFor(() => {
      const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec?.claimedBy).toBeUndefined();
    });
    const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
    expect(rec.injectionAttempted).toBe(true);
    expect(rec.delivered).toBe(false);

    // A second delivery pass must NOT re-inject.
    (host as any).queueDelivery('root-1');
    await (host as any).live.get('root-1').running;
    expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
  });
});

// ---- R12 (Task 4, plan 1c) — a running child keeps its spawn-time
// definition when the roster changes mid-run --------------------------------
// spawnSpecialist takes an already-RESOLVED SpecialistDefinition object (the
// Task tool resolves it from the roster once, at the moment the model calls
// Task — task.ts) and threads that exact object into buildSpecialistSession,
// which builds the child's `tools` list ONCE, at construction
// (native-session-host.ts's buildSpecialistSession: `CORE_TOOLS.filter((t) =>
// allowed.has(t.name))`). Nothing about a running child ever re-reads a
// roster. This test pins that by construction: it captures the child's OWN
// tool set while it is genuinely live, then shows a widened SECOND definition
// for the same id (what a re-read catalog would hand back on the NEXT
// Task-tool build) changes nothing about the already-spawned child.
describe('R12 (Task 4, plan 1c) — a running child keeps its spawn-time definition', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-r12-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  it('a running child keeps its spawn-time definition when the roster changes mid-run: its tool set stays what it was hired with, and only the NEXT Task description reflects the change', async () => {
    const SPEC_V1: SpecialistDefinition = {
      id: 'custom-helper', displayName: 'Custom Helper', description: 'A file-defined helper.',
      systemPrompt: 'Help with reading files.', allowedTools: ['Read'], charter: 'read-only',
      reportBudgetTokens: 500, source: 'personal',
    };

    let capturedTools: string[] = [];
    const REPORT_CHUNKS = stream(...textChunks('t', 'REPORT: done'), finishChunk('stop'));
    const model = new MockLanguageModelV4({
      doStream: async () => {
        // Capture the CHILD's own live tool set — proves what it was
        // actually BUILT with, not what a later roster claims.
        const entry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
        if (entry) {
          const session = (entry[1] as { session: any }).session;
          capturedTools = [...session.toolByName.keys()];
        }
        return { stream: simulateReadableStream({ chunks: REPORT_CHUNKS, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: SPEC_V1, prompt: 'read and summarize the config', workDir: root,
      parentToolCallId: 'tc-1', description: 'read config', token: { parentId: 'root-1', writer: false },
    });

    // Exactly what SPEC_V1.allowedTools named — no Bash, no Write, no Edit.
    expect(capturedTools).toEqual(['Read']);

    // "The roster changes mid-run": a repo (or a Settings edit) widens THIS
    // same specialist's file to add Bash. Represented as a second definition
    // object for the same id, since that's exactly what SpecialistCatalog
    // would hand back on the NEXT createTaskTool() build (Task 4) — the
    // catalog re-reads at the START of the next turn, never mid-turn.
    const SPEC_V2: SpecialistDefinition = { ...SPEC_V1, allowedTools: ['Read', 'Bash'], charter: 'read-write' };
    const widenedRoster: SpecialistRoster = {
      list: () => [SPEC_V2],
      resolve: (id) => (id === 'custom-helper' ? SPEC_V2 : undefined),
    };
    const nextDescription = createTaskTool(widenedRoster).description;
    expect(nextDescription).toMatch(/custom-helper[^\n]*Bash/);

    // The already-spawned (by now finished) child was never touched by that
    // widening — it ran with exactly what it was hired with.
    expect(capturedTools).toEqual(['Read']);
  });
});

// Fix pass (Task 4 review, Important finding): the turn-start
// `this.specialistCatalog.ensureFresh(entry.cwd)` at the top of runTurns
// carried a comment claiming a specialist child never reaches runTurns "by
// construction" (runSpecialist supposedly drives the child directly, never
// through send()/this.live's queue). That claim is false: runSpecialist's own
// runTurn() closure calls `this.send(childId, text)`, and send() unconditionally
// dispatches into `this.runTurns(sessionId, entry, ...)` for whatever id it is
// given — here the CHILD's id, with entry.cwd set to the child's own work_dir
// (wireChildLive). So every specialist turn — the opening turn AND the
// empty-report nudge — was re-reading (and permanently caching, on a Map with
// no eviction) a catalog entry for a cwd nothing will ever read a roster for,
// since createChild never calls toolWiring for a child.
//
// This suite proves the call path, not a flag: it drives a REAL root turn and
// a REAL foreground specialist run through the actual send()/runTurns()
// machinery, with a spy on the catalog's ensureFresh, and asserts it fires for
// the root session's turn and never for the child's — using a child cwd
// distinct from the root's so a call bearing it can only have come from the
// child's own turn(s).
describe('Task 4 fix pass — turn-start ensureFresh is root-only for real', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-turnstart-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  // Root replies plainly (no delegation) on its own turn. The child (spawned
  // directly via spawnSpecialist, same technique every other test in this file
  // uses) reports on its FIRST turn — no nudge needed — so runSpecialist's
  // runTurn() closure calls this.send(childId, ...) exactly once: the exact
  // send() -> runTurns() path the finding traces.
  const ROOT_REPLY = stream(...textChunks('t', 'sure, one moment'), finishChunk('stop'));
  const CHILD_REPORT = stream(...textChunks('t', 'REPORT: done'), finishChunk('stop'));

  it("ensureFresh runs for the root session's own turn, and never for a specialist child's turn — driven through the real send()/runTurns() path, not a boolean check", async () => {
    const model = scriptedModel([ROOT_REPLY, CHILD_REPORT]);
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    // Spy AFTER create() so create()'s own one-time ensureFresh(cwd) call
    // (Task 4: the roster must exist before toolWiring() reads it) isn't mixed
    // into what this test checks — the TURN-START call this fix pass is about.
    const ensureFreshSpy = vi.spyOn((host as any).specialistCatalog, 'ensureFresh');

    // --- Root's own turn, dispatched through the public send()/runTurns
    // machinery the finding says a child ALSO reaches. ---
    const sendResult = host.send('root-1', 'go');
    expect(sendResult.status).toBe('sent');
    await (host as any).live.get('root-1').running;

    expect(ensureFreshSpy).toHaveBeenCalledWith(root);
    const rootCallsAfterRootTurn = ensureFreshSpy.mock.calls.filter(([cwd]) => cwd === root).length;
    expect(rootCallsAfterRootTurn).toBeGreaterThan(0);

    // --- A foreground specialist child, hired into a DIFFERENT cwd than
    // root's — so a spy call bearing that cwd can only have come from the
    // child's own turn(s), never from anything root-related. ---
    const childWorkDir = path.join(root, 'child-sub');
    fs.mkdirSync(childWorkDir, { recursive: true });

    const { childId, report } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives',
      workDir: childWorkDir, parentToolCallId: 'tc-1', token: { parentId: 'root-1', writer: false },
    });
    expect(report).toContain('REPORT: done');
    expect(childId).toBeDefined();

    // THE assertion: the child's own turn (runSpecialist's runTurn() closure
    // calling this.send(childId, ...), which dispatches into the SAME
    // runTurns() as root's turn above) must never have called ensureFresh with
    // the child's cwd. A test that only checked "runTurns wasn't invoked for
    // the child" would be worthless here — it WAS invoked, via send(); this is
    // what actually makes the call inside it root-only.
    const childCwdCalls = ensureFreshSpy.mock.calls.filter(([cwd]) => cwd === childWorkDir);
    expect(childCwdCalls).toEqual([]);

    // Root's own tally is unaffected by the child's turn(s) running afterward.
    const finalRootCalls = ensureFreshSpy.mock.calls.filter(([cwd]) => cwd === root).length;
    expect(finalRootCalls).toBe(rootCallsAfterRootTurn);
  });
});
