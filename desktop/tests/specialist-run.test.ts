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
import { looseData } from '../src/shared/transcript-event-types';

// WHY maxRetries: destroyAll() does not drain the delegation ledger's fire-and-forget
// writes, so one can land mid-removal and a plain rm dies with ENOTEMPTY (ubuntu CI 2026-08-28),
// throwing INTO a test that already passed.
function rmHostRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

/** A host over a scripted model (or a model factory). `model` is a model instance or a factory. */
function makeHost(store: SessionStore, model: any, home?: NativeHome, contextLength: number | null = null): NativeSessionHost {
  const factory = typeof model === 'function' ? model : async () => model;
  return new NativeSessionHost(
    store, factory, async () => ({ contextLength, totalSlots: null }), async () => null, async () => null,
    undefined, undefined, undefined, undefined, undefined, undefined, home,
  );
}

/** Foreground-run the explorer with the standard brief; `over` replaces any spawn option. */
function spawnExplorer(host: NativeSessionHost, root: string, over: Record<string, unknown> = {}) {
  return host.spawnSpecialist('root-1', {
    specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
    parentToolCallId: 'tc-1', description: 'test task', token: { parentId: 'root-1', writer: false }, ...over,
  } as any);
}

const EXPLORER = resolveSpecialist('explorer')!;

/** The ledger row for one child. */
const recOf = (ledger: any, root: string, childId: string) =>
  ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);

// The foreground specialist run, driven through the real host, a real SessionStore and a scripted HarnessSession.


// The three types the reducer's applySubagentEvent consumes (chat-reducer.ts).
// Anything else must NEVER be re-emitted stamped — see the "no stamped
// turn-complete" test below for what that would break.
const DISPLAY_TYPES = ['tool-use', 'tool-result', 'assistant-text'];

describe('specialist foreground run', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  // ONE shared scripted model instance across every doStream call, so a script
  // spanning MORE THAN ONE TURN (the empty-report nudge) advances rather than
  // restarting — the factory is called once per turn, and a fresh instance per
  // call would replay script[0] forever.
  function boot(scripts: any[][]) {
    const model = scriptedModel(scripts);
    store = new SessionStore(new NativeHome(root));
    host = makeHost(store, model);
    return model;
  }
  async function withParent(scripts: any[][]) {
    boot(scripts);
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

  it('returns a normal multi-tool final report without a step-limit suffix or report nudge', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const events = collect();

    const { childId, report } = await spawnExplorer(host, root);

    // Child events reach the renderer as display copies under the PARENT's sessionId. 'subagent-usage' is excluded: it is the
    // parent's own bookkeeping (spend), persisted to the parent's record (tests/subagent-usage-event.test.ts).
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
    const childMessages = childEvents.filter((e) => e.type === 'user-message');
    expect(childMessages).toHaveLength(1); // final report means runSpecialist never sends EMPTY_REPORT_NUDGE
    expect(childMessages[0].data.text).not.toContain('Your final message is your report');
    expect(childEvents.every((e) => e.sessionId === childId)).toBe(true);

    // (d) the parent's file contains NO child-stamped events (display-only
    // re-emission — the copy is for the renderer, never for the parent's disk
    // record, which must stay a faithful record of the parent's own turns).
    await host.drain('root-1');
    const parentFile = store.readEvents('root-1', root);
    expect(parentFile.filter((e) => looseData(e).agentId && e.type !== 'subagent-usage')).toHaveLength(0);
    // The ONE agentId-bearing event that DOES belong on the parent's disk: the
    // specialist's spend. It has to persist, or a resumed session would forget
    // every specialist it ever paid for (spec §2, consequence 3).
    expect(parentFile.filter((e) => e.type === 'subagent-usage')).toHaveLength(1);

    // The report is wrapped with a title header (match the shape, the title is generated) and a `[specialist session <id>]` footer.
    expect(report).toContain('REPORT: found it');
    expect(report).not.toContain('Your final message is your report');
    expect(report).toMatch(new RegExp(`## Report from \\w+ the \\w+ Explorer \\(${EXPLORER.id}\\)`));
    expect(report).toContain(`[specialist session ${childId}]`);
  });

  // Reasoning text reaches the child's card via the real reasoning-delta path; only assistant-thinking WITH data.text is re-emitted.
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

    const { childId } = await spawnExplorer(host, root);

    const thinking = events.find((e) => e.type === 'assistant-thinking' && e.data?.agentId === childId);
    expect(thinking).toBeDefined();
    expect(thinking!.data.text).toBe('weighing which file to check first');
    expect(thinking!.sessionId).toBe('root-1');
    expect(thinking!.data.parentAgentToolUseId).toBe('tc-1');
  });

  // Text-less assistant-thinking shapes (heartbeat, stallWarning, toolPreparing) must never be re-emitted, or they render as the PARENT's status.
  // Emitted directly on the child's session emitter so the scripted stream does not matter.
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
    host = makeHost(store, model);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const { childId } = await spawnExplorer(host, root);

    const thinking = events.filter((e) => e.type === 'assistant-thinking' && e.data?.agentId === childId);
    expect(thinking).toEqual([]);
  });

  // The harness emits one assistant-text per stream DELTA; the reducer coalesces by partId, so re-stamping must carry the child's partId.
  it('re-stamped assistant-text display events carry the partId the reducer needs to coalesce', async () => {
    await withParent([
      stream(...multiDeltaTextChunks('t', 'REPORT: found it ', 'at src/x.ts'), finishChunk('stop')),
    ]);
    const events = collect();

    const { childId } = await spawnExplorer(host, root);

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

    const { childId } = await spawnExplorer(host, root);

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

  // The child's JSONL is on disk, but store.list() hides children by default (every list()-based surface inherits this).
  it('a completed run leaves only the root visible to store.list()', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const { childId } = await spawnExplorer(host, root);

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
    // The error part throws (not retryable, no HTTP status) and surfaces as a session-error event; awaiting the child's drain alone would look clean.
    await withParent([
      stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
      stream({ type: 'error', error: new Error('llama-server dropped the connection') }),
    ]);
    const events = collect();
    // The failure path must release the same things the success path does: childrenOf entry and model ref.
    const released: string[] = [];
    host.setModelReleasedHandler((id) => released.push(id));

    await expect(spawnExplorer(host, root)).rejects.toThrow(/llama-server dropped the connection/);

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
      // Turn 1 needs TWO empty streams (attempt + the harness's silent retry) before the delegation layer's nudge fires.
      stream(finishChunk('stop')),                                              // turn 1, attempt 1: empty
      stream(finishChunk('stop')),                                              // turn 1, silent retry: still empty
      stream(...textChunks('t', 'REPORT: after the nudge'), finishChunk('stop')), // turn 2: the real report
    ]);

    const { childId, report } = await spawnExplorer(host, root);

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

    await expect(spawnExplorer(host, root)).rejects.toThrow(/no final message|without producing a report/i);
  });

  it('caps the report against the specialist budget and says what it cut', async () => {
    // A report far over the explorer's 2000-token static cap. The parent has no
    // measured occupancy in this test, so the static cap is the binding one.
    const huge = 'x'.repeat(60_000);
    await withParent([
      stream(...textChunks('t', `REPORT: found it\n${huge}`), finishChunk('stop')),
    ]);

    const { report } = await spawnExplorer(host, root);

    expect(report).toContain('REPORT: found it');            // the head survives
    expect(report.length).toBeLessThan(huge.length / 2);     // ...but the bulk did not
    expect(report).toMatch(/truncated/i);                    // and the cut is stated, never silent
  });

  // Real NativeHome here (withParent has none), so the spill file and footer pointer are checkable on disk.
  describe('report overflow spills to a file', () => {
    async function withHomeParent(scripts: any[][]) {
      const model = scriptedModel(scripts);
      const home = new NativeHome(root);
      store = new SessionStore(new NativeHome(root));
      host = makeHost(store, model, home);
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

      const { childId, report } = await spawnExplorer(host, root);

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
      const rec = recOf(ledger, root, childId);
      expect(rec.reportPath).toBe(spilledPath);
    });

    it('does not spill a file when the report fits the budget', async () => {
      await withHomeParent([stream(...textChunks('t', 'REPORT: found it at src/x.ts'), finishChunk('stop'))]);

      const { childId, report } = await spawnExplorer(host, root);

      expect(report).not.toMatch(/truncated/i);
      expect(report).not.toContain('saved to');
      expect(report).toContain(`[specialist session ${childId}]`);

      const ledger = (host as any).ledger;
      const rec = recOf(ledger, root, childId);
      expect(rec.reportPath).toBeUndefined();
    });

    it('degrades honestly when the spill write itself fails — the footer never claims a file that is not there', async () => {
      const big = 'y'.repeat(20_000);
      const home = await withHomeParent([stream(...textChunks('t', `REPORT: found it\n${big}`), finishChunk('stop'))]);
      vi.spyOn(home, 'writeSessionArtifact').mockImplementation(() => {
        throw new Error('simulated disk full');
      });

      const { report } = await spawnExplorer(host, root);

      expect(report).toMatch(/truncated/i);
      // The exact opposite of the success case: no path, no false claim.
      expect(report).not.toContain('saved to:');
      expect(report).not.toContain('Read it if you need the rest');
    });
  });

  // A ledger write can throw (lock exhaustion) in spawnSpecialist; neither point may corrupt a real run. Real ledger, monkeypatched to throw.
  describe('a ledger write failure never corrupts a real run', () => {
    async function withLedgerParent(scripts: any[][]) {
      const model = scriptedModel(scripts);
      const home = new NativeHome(root);
      store = new SessionStore(new NativeHome(root));
      host = makeHost(store, model, home);
      await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    }

    it('a completion-write failure does not discard the report or relabel a successful run "failed"', async () => {
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

      const { childId, report } = await spawnExplorer(host, root);

      expect(sawCompletedWrite).toBe(true); // sanity: the throwing write path actually ran
      // The report the child genuinely produced is still returned...
      expect(report).toContain('REPORT: found it at src/x.ts');
      expect(childId).toBeTruthy();
      // ...and the run is not relabeled a failure on disk because the
      // completion write blew up on the way out.
      const rec = recOf(ledger, root, childId);
      expect(rec?.status).not.toBe('failed');
    });

    it('a recordStart failure still tears the child down — no leaked live entry, childrenOf, or model ref', async () => {
      await withLedgerParent(TWO_TOOLS_THEN_REPORT);
      const ledger = (host as any).ledger;
      ledger.recordStart = async () => { throw new Error('simulated lock exhaustion'); };

      const released: string[] = [];
      host.setModelReleasedHandler((id) => released.push(id));

      await expect(spawnExplorer(host, root)).rejects.toThrow(/simulated lock exhaustion/);

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

// Compaction-finalize: on the SECOND auto-compaction the listener posts one steer telling the child to write up. Synthetic `compact-summary`
// events on the child's emitter drive it (compaction math is in harness-compaction.test.ts).
describe('compaction-finalize steer', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-finalize-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  const FINALIZE_STEER = 'You are running low on room even after summarizing. Stop new exploration — '
    + 'write up what you have and finish with your report now.';

  // Fires compactionsPerCall[n] auto compact-summary events on the child's emitter at each model call, with a postSteer spy installed first.
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
    host = makeHost(store, model);
    return () => postSteerSpy!;
  }

  const TWO_TOOLS_THEN_REPORT = [
    stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
    stream(toolCallChunk('c2', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls')),
    stream(...textChunks('t', 'REPORT: found it at src/x.ts'), finishChunk('stop')),
  ];

  // Auto-compactions per model call -> how many finalize steers the child gets (only the SECOND counts, once).
  it.each([
    ['posts once on the SECOND auto-compaction', [1, 1, 0], 1],
    ['still posts only once with a third later', [1, 1, 1], 1],
    ['never steers after a single auto-compaction', [1, 0, 0], 0],
  ])('finalize steer: %s', async (_name, perCall, steers) => {
    const getSpy = bootWithFakeCompactions(TWO_TOOLS_THEN_REPORT, perCall);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await spawnExplorer(host, root);
    expect(getSpy()).toHaveBeenCalledTimes(steers);
    if (steers) expect(getSpy()).toHaveBeenCalledWith(FINALIZE_STEER);
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
    host = makeHost(store, model);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await spawnExplorer(host, root);

    expect(postSteerSpy).not.toHaveBeenCalled();
  });
});

// Heartbeat staleness flags, never kills: liveness is heartbeat-based, the interval only flips `stale` on the ledger record.
// Fake timers; the first doStream hangs until release() so synthetic events fire at controlled offsets.
describe('heartbeat staleness', () => {
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

  // Scoped fake timers: faking setImmediate would wedge every turn before its first doStream call (send() defers one setImmediate).
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
    host = makeHost(store, model, home);
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
    host = makeHost(store, model, home);
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

    const runPromise = spawnExplorer(host, root);
    await started;
    const childId = getChildId();

    // Still under the idle threshold: not yet stale.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IDLE_STALE_MS - 10_000);
    await waitForWrite();
    expect(recOf(ledger, root, childId)?.stale).not.toBe(true);

    // Cross it — the next poll tick flags it.
    await vi.advanceTimersByTimeAsync(20_000);
    await waitForWrite();
    expect(recOf(ledger, root, childId)?.stale).toBe(true);

    // The child's NEXT event (fired directly on its own session emitter, the
    // exact channel runSpecialist's onEvent listens on) unflags it.
    getEntry().session.emit('transcript-event', {
      type: 'assistant-text', sessionId: childId, uuid: 'evt-unflag', timestamp: Date.now(),
      data: { text: 'still working', partId: 't2' },
    });
    await waitForWrite();
    expect(recOf(ledger, root, childId)?.stale).toBe(false);

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

    const runPromise = spawnExplorer(host, root);
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
    expect(recOf(ledger, root, childId)?.stale).not.toBe(true);

    // Sanity: the mechanism is not permanently exempted — with no further
    // heartbeats it does eventually trip once genuinely 120s pass.
    await vi.advanceTimersByTimeAsync(40_000);
    await waitForWrite();
    expect(recOf(ledger, root, childId)?.stale).toBe(true);

    release();
    await runPromise;
  });

  it('an unresolved tool call uses the longer in-tool threshold', async () => {
    fakeStaleTimers();
    const { release, toolStarted, getChildId } = bootHangingTool();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = spawnExplorer(host, root);
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
    expect(recOf(ledger, root, childId)?.stale).not.toBe(true);

    // Past the in-tool threshold (300s total) — now it flags.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IN_TOOL_STALE_MS - (SPECIALIST_IDLE_STALE_MS + 60_000) + 10_000);
    await waitForWrite();
    expect(recOf(ledger, root, childId)?.stale).toBe(true);

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

    const runPromise = spawnExplorer(host, root);
    await toolStarted;
    const childId = getChildId();

    // Go well stale — long past the (longer, since a tool is open) threshold.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IN_TOOL_STALE_MS + 60_000);
    await waitForWrite();
    expect(recOf(ledger, root, childId)?.stale).toBe(true);

    // Staleness is proven; return to the real clock before waiting: vi.waitFor advances the fake clock on every check and perturbs
    // the staleness logic it waits on (measured 2026-08-28: it never saw 'completed').
    vi.useRealTimers();

    release();
    const { report } = await runPromise;
    expect(report).toContain('REPORT: done');

    // The ledger completion write is fire-and-forget behind the report, so a one-shot read races it (macOS CI 2026-08-28).
    await vi.waitFor(() => {
      const pending = recOf(ledger, root, childId);
      expect(pending?.status).toBe('completed');
    });
    const rec = recOf(ledger, root, childId);
    expect(rec?.status).toBe('completed');
    // Torn down normally, same as every other successful run in this file.
    expect((host as any).live.has(childId)).toBe(false);
  });
});

// Background: spawnSpecialistBackground resolves at LAUNCH and the un-awaited chain's report is injected as a user-role turn only at
// an idle boundary, never mid-turn. Real ledger (NativeHome at the tmp root).
describe('background execution + idle-boundary delivery', () => {
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
    // send() defers dispatch one macrotask, so the child cannot have started when this resolves; asserting `inFlight` pins "still running".
    const model = scriptedModel([
      stream(...textChunks('t', 'REPORT: done'), finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

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
      const rec = recOf((host as any).ledger, root, childId);
      expect(rec?.status).toBe('completed');
    });
    // WHY also wait for the report to reach the parent, then for that pass to end (ubuntu CI 2026-10-21:
    // ENOTEMPTY in teardown): a finished child kicks an idle delivery pass on root-1, which writes under
    // .youcoded/sessions. "completed" lands BEFORE that pass, so ending here let its write race
    // teardown's remove on a slow runner. The injected report, then the pass's own promise, are the signal.
    await vi.waitFor(() => expect(events.some((e) => e.sessionId === 'root-1' && e.data?.injected === 'specialist-report')).toBe(true));
    await (host as any).live.get('root-1')?.running;
  });

  it('a background completion is injected as a user-role turn when the parent goes idle — never mid-turn', async () => {
    // The parent's turn is gated so it stays in flight while a background child finishes; modelFactory routes the first call to the parent.
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
    host = makeHost(store, factory, home);
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
      const rec = recOf((host as any).ledger, root, childId);
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
    host = makeHost(store, model, home, 3500);
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
    host = makeHost(store, model, home);
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
    const rec = recOf((host as any).ledger, root, childId);
    expect(rec.status).toBe('failed');
    expect(rec.failureText).toMatch(/llama-server dropped the connection/);
  });

  it('a background completion whose report exceeds the ledger cap spills the full body to a file', async () => {
    // The ledger caps rawReport on every write and nothing else sees the full body again, so completion must spill it to disk first.
    const huge = 'y'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    const ledger = (host as any).ledger;
    await vi.waitFor(() => {
      const rec = recOf(ledger, root, childId);
      expect(rec?.status).toBe('completed');
    });
    const rec = recOf(ledger, root, childId);
    expect(rec.rawReport.length).toBe(RAW_REPORT_CAP_CHARS); // capped copy in the ledger
    expect(rec.reportPath).toBeTruthy();
    const spilled = fs.readFileSync(rec.reportPath, 'utf8');
    expect(spilled.length).toBe(huge.length); // the FULL, uncapped body
    expect(spilled.startsWith(huge.slice(0, 200))).toBe(true);
  });

  it('a report already spilled at completion time is not spilled a SECOND time by delivery', async () => {
    // `huge` exceeds both the ledger cap and the explorer budget; reportPath lets delivery recognise "already spilled" and not write twice.
    const huge = 'w'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    const writeSpy = vi.spyOn(home, 'writeSessionArtifact');
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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

  it('delivery never overwrites a spill path it just failed to read, and never claims it as the full report', async () => {
    // The spill file is unreadable by delivery time (restart, cleanup). The READ is mocked and the write left real, so a re-spill that
    // clobbers the file with the capped copy (a data-loss bug) is caught.
    const huge = 'q'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    const writeSpy = vi.spyOn(home, 'writeSessionArtifact');
    vi.spyOn(home, 'readSessionArtifact').mockReturnValue(null);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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
    // The footer must not claim the unreadable path holds the full report, nor claim a save failed (none was attempted).
    expect(injected.data.text).not.toContain(`Full report saved to: ${rec.reportPath}`);
    expect(injected.data.text).not.toContain('Full report saved to:');
    expect(injected.data.text).not.toContain('could not be saved to disk');
    // Plain, honest, model-facing: this is a shortened copy and the rest is
    // gone, full stop — no path implied to exist.
    expect(injected.data.text).toContain('[Truncated to fit. The full report is no longer available');
  });

  // ---- Fix pass (external review, 2026-08-12): three follow-on gaps ----------

  it('delivery of a spilled oversized report reads the FULL body back from disk, not the capped ledger copy', async () => {
    // The ledger copy is capped, so the truncation notice must cite the FULL body's length (bigger than the cap).
    const huge = 'z'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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

  it('a background completion whose ledger write ALWAYS fails still reaches the parent via the in-memory fallback lane, exactly once, and the ledger record is left honestly stranded', async () => {
    // A retry through the same store reproduces a systemic failure, so ledger.update throws on EVERY completion-shaped call:
    // delivery must not depend on any ledger write landing.
    const model = scriptedModel([
      stream(...textChunks('t', 'REPORT: done via background'), finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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
    const rec = recOf(ledger, root, childId);
    expect(rec.status).toBe('running');
    expect(rec.delivered).toBe(false);

    // No duplicate delivery: a later idle-boundary pass must not re-inject
    // the same report — the fallback entry was consumed on delivery, not
    // left behind for a second pass to find again.
    (host as any).queueDelivery('root-1');
    // WHY await the kicked pass itself (not one setImmediate): the idle pass
    // runs runTurns, which still writes under .youcoded/sessions. Ending the
    // test while it ran let that write land during teardown's rmSync —
    // ENOTEMPTY on Linux CI. Its promise is the real "the pass is over" signal.
    await (host as any).live.get('root-1')?.running;
    expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
  });

  it('a destroy() racing the delivery loop leaves the report claimable again, never falsely confirmed', async () => {
    // destroy() can land mid-delivery; HarnessSession.destroy() aborts without throwing, so an orphaned runNotice() completes normally
    // having shown the report to nobody. Simulated with a gated runNotice stub, destroying the parent while paused.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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
      const rec = recOf(ledger, root, 'child-x');
      expect(rec?.claimedBy).toBeUndefined();
    });
    const rec = recOf(ledger, root, 'child-x');
    expect(rec.status).toBe('completed');
    expect(rec.delivered).toBe(false);
  });

  it('claimUndelivered throwing does not wedge the session, and an in-memory fallback report still delivers in the same pass', async () => {
    // An unguarded claimUndelivered throw used to skip the tail `inFlight = false` and the in-memory fallback lane. Neither may happen.
    const model = scriptedModel([
      stream(...textChunks('t', 'still here')), stream(finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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

  it('a releaseClaim throw on a liveness-mismatch path is swallowed by releaseClaimSafely, not merely papered over by runTurns\' outer finally', async () => {
    // Calls runTurns directly: queueDelivery's `entry.running` swallows rejections. releaseClaimSafely's job is that the delivery pass
    // settles WITHOUT throwing (inFlight alone would also be cleared by runTurns' outer finally).
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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

  it('in-memory fallback entries for a parent are dropped once that parent session is destroyed', async () => {
    // Pre-fix, `inMemoryFallback` was never swept on destroy() or
    // destroyAll() — an entry for a parent torn down before its next idle
    // boundary stayed in the map forever, holding a full specialist report
    // in memory for a session that can never come back to read it.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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

  it('a background completion landing AFTER a plain destroy() of its parent is not leaked into inMemoryFallback', async () => {
    // destroy()'s sweep only covers entries present at call time; a completion `.then` stashing AFTER destroy must be refused by
    // stashFallbackIfParentAlive (tested directly rather than racing).
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.destroy('root-1'); // parent gone BEFORE the late completion arrives

    (host as any).stashFallbackIfParentAlive('root-1', 'child-late', {
      childId: 'child-late', parentToolCallId: 'tc', agentType: EXPLORER.id, title: 'Test child-late', workDir: root,
      description: 'a test brief', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
      steps: 1, rawReport: 'REPORT: arrived too late', delivered: false, owner: OWNER, missedSteers: [],
    });

    expect((host as any).inMemoryFallback.has('child-late')).toBe(false);
  });

  it('a background report is never delivered twice when runNotice succeeds but the follow-up confirmDelivered write fails', async () => {
    // Two identical-looking on-disk states (delivered:false, claim cleared) differ: claim landed but runNotice never ran (safe retry) vs
    // runNotice ran and only confirmDelivered failed (retrying shows the user the report twice). The second must never be retried.
    const model = scriptedModel([stream(...textChunks('t', 'REPORT: done once'), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = makeHost(store, model, home);
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
      const rec = recOf(ledger, root, childId);
      expect(rec?.claimedBy).toBeUndefined();
    });
    const rec = recOf(ledger, root, childId);
    expect(rec.injectionAttempted).toBe(true);
    expect(rec.delivered).toBe(false);

    // A second delivery pass must NOT re-inject.
    (host as any).queueDelivery('root-1');
    await (host as any).live.get('root-1').running;
    expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
  });
});

// A running child keeps the definition it was spawned with: its tool list is built once at construction and never re-reads a roster.
describe('a running child keeps its spawn-time definition', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-r12-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  it('a running child keeps its spawn-time definition when the roster changes mid-run: its tool set stays what it was hired with, and only the NEXT Task description reflects the change', async () => {
    const SPEC_V1: SpecialistDefinition = {
      id: 'custom-helper', displayName: 'Custom Helper', description: 'A file-defined helper.',
      systemPrompt: 'Help with reading files.', allowedTools: ['Read'], charter: 'read-only',
      reportBudgetTokens: 500, source: 'personal', grantScope: 'user',
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
    host = makeHost(store, model, home);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: SPEC_V1, prompt: 'read and summarize the config', workDir: root,
      parentToolCallId: 'tc-1', description: 'read config', token: { parentId: 'root-1', writer: false },
    });

    // Exactly what SPEC_V1.allowedTools named — no Bash, no Write, no Edit.
    expect(capturedTools).toEqual(['Read']);

    // The roster changes mid-run: a second definition for the same id, as the catalog would hand the NEXT createTaskTool() build.
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

// Every specialist turn goes through send() -> runTurns(), so the turn-start ensureFresh(cwd) would cache a catalog entry for a cwd
// nobody reads. It must fire for the root's turn only. Driven through the real path, with a child cwd distinct from root's.
describe('turn-start ensureFresh is root-only for real', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-turnstart-')); });
  afterEach(async () => { await host?.destroyAll(); rmHostRoot(root); });

  // Root replies plainly; the child reports on its FIRST turn, so runSpecialist calls send(childId) exactly once.
  const ROOT_REPLY = stream(...textChunks('t', 'sure, one moment'), finishChunk('stop'));
  const CHILD_REPORT = stream(...textChunks('t', 'REPORT: done'), finishChunk('stop'));

  it("ensureFresh runs for the root session's own turn, and never for a specialist child's turn — driven through the real send()/runTurns() path, not a boolean check", async () => {
    const model = scriptedModel([ROOT_REPLY, CHILD_REPORT]);
    store = new SessionStore(new NativeHome(root));
    host = makeHost(store, model);
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
      description: 'test task',
    });
    expect(report).toContain('REPORT: done');
    expect(childId).toBeDefined();

    // The child's turn DID go through runTurns via send(); what must hold is that it never called ensureFresh with the child's cwd.
    const childCwdCalls = ensureFreshSpy.mock.calls.filter(([cwd]) => cwd === childWorkDir);
    expect(childCwdCalls).toEqual([]);

    // Root's own tally is unaffected by the child's turn(s) running afterward.
    const finalRootCalls = ensureFreshSpy.mock.calls.filter(([cwd]) => cwd === root).length;
    expect(finalRootCalls).toBe(rootCallsAfterRootTurn);
  });
});
