// A specialist's spend belongs to the session that delegated it (spec §2). It
// cannot ride the child's own turn-complete: SUBAGENT_DISPLAY_TYPES excludes
// that deliberately, because a stamped copy would end the PARENT's turn in the
// reducer and attribute the child's model to the parent.
//
// Two halves are pinned here:
//   (1) the REDUCER half — a `subagent-usage` action folds one finished
//       specialist into the parent's totals exactly ONCE, mints nothing for a
//       session this window doesn't hold, and touches neither the timeline nor
//       the turn;
//   (2) the PRODUCER half — a real (scripted) specialist run through the real
//       NativeSessionHost emits exactly one such event on the PARENT's stream,
//       priced at the CHILD's own model, and persists it to the PARENT's
//       record so a resume replays it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { SUBAGENT_DISPLAY_TYPES, NativeSessionHost } from '../src/main/harness/native-session-host';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { scriptedModel, stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import * as logger from '../src/main/logger';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

const SID = 'p1';
const start = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });

const subagentUsage = (uuid: string, usage: any) => ({
  type: 'TRANSCRIPT_SUBAGENT_USAGE' as const,
  sessionId: SID, uuid, timestamp: 1,
  parentAgentToolUseId: 'task-1', agentId: 'child-1',
  usage,
});

describe('subagent-usage — the reducer half', () => {
  it('is not smuggled in as a forwarded child turn-complete', () => {
    expect(SUBAGENT_DISPLAY_TYPES.has('turn-complete')).toBe(false);
  });

  it('folds a finished specialist into the parent session totals', () => {
    let s = start();
    s = chatReducer(s, subagentUsage('su1', {
      inputTokens: 5000, outputTokens: 400, cacheReadTokens: 100, cacheCreationTokens: 0, costUsd: 0.05, free: false,
    }) as any);
    const t = s.get(SID)!.totals;
    expect(t.inputTokens).toBe(5000);
    expect(t.outputTokens).toBe(400);
    expect(t.cacheReadTokens).toBe(100);
    expect(t.costUsd).toBeCloseTo(0.05, 10);
    expect(t.specialistCostUsd).toBeCloseTo(0.05, 10);
    expect(t.specialistRuns).toBe(1);
    expect(t.anyPriced).toBe(true);
  });

  it('marks the session unpriced when the specialist model has no published price', () => {
    let s = start();
    s = chatReducer(s, subagentUsage('su2', {
      inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, free: false,
    }) as any);
    expect(s.get(SID)!.totals.anyUnpriced).toBe(true);
    expect(s.get(SID)!.totals.costUsd).toBe(0);
  });

  it('marks the session free when the specialist ran on a local engine', () => {
    // The addition beyond the plan: `free` is resolved for the SPECIALIST's own
    // model, so a metered parent that delegates to a local specialist still
    // reports that some of its work cost nothing to run.
    let s = start();
    s = chatReducer(s, subagentUsage('su3', {
      inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, free: true,
    }) as any);
    const t = s.get(SID)!.totals;
    expect(t.anyFree).toBe(true);
    expect(t.anyPriced).toBe(false);     // free is never a $0.00 bill
    expect(t.costUsd).toBe(0);
    expect(t.specialistRuns).toBe(1);
    // Free is NOT a spelling of "no published price". The emitted shape here is
    // exactly the one a free PARENT turn carries (costUsd: null AND free: true —
    // costForUsage returns null for a free model), so the specialist path and
    // the turn path must reach the same verdict.
    expect(t.anyUnpriced).toBe(false);
  });

  it('counts one specialist exactly once, even on a duplicate delivery (replay overlapping live)', () => {
    let s = start();
    const ev = subagentUsage('su4', {
      inputTokens: 5000, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.05, free: false,
    });
    s = chatReducer(s, ev as any);
    s = chatReducer(s, ev as any);   // the same event again — resume replays what live already delivered
    const t = s.get(SID)!.totals;
    expect(t.inputTokens).toBe(5000);
    expect(t.costUsd).toBeCloseTo(0.05, 10);
    expect(t.specialistRuns).toBe(1);
  });

  it('an ORPHAN report — for a session this window does not hold — changes nothing and mints nothing', () => {
    const s = start();
    const after = chatReducer(s, {
      ...subagentUsage('su5', { inputTokens: 999999, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 9.99, free: false }),
      sessionId: 'a-session-this-window-never-had',
    } as any);
    expect(after).toBe(s);                              // same object — no snapshot churn
    expect(after.has('a-session-this-window-never-had')).toBe(false);
    expect(after.get(SID)!.totals.inputTokens).toBe(0);
  });

  // Task 23 item 3. The orphan branch drops a real dollar figure on the floor.
  // It should never happen (SESSION_INIT runs before any transcript event), so
  // if it ever does, the only trace anyone will have is this line.
  it('warns when an orphan report is dropped — that is money nothing counted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chatReducer(start(), {
      ...subagentUsage('su7', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5, free: false }),
      sessionId: 'a-session-this-window-never-had',
    } as any);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a-session-this-window-never-had'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('subagent-usage'));
    warn.mockRestore();
  });

  // The other half of the same rule, and the one that matters more: a SECOND
  // delivery of the same report is expected and normal (a resume replays what
  // the live stream already delivered). Warning there would print on ordinary
  // healthy use, which is exactly how a warning stops being read.
  it('stays silent on a duplicate delivery — that one is normal, not a fault', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let s = start();
    const ev = subagentUsage('su8', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5, free: false });
    s = chatReducer(s, ev as any);
    s = chatReducer(s, ev as any);
    expect(warn).not.toHaveBeenCalled();
    expect(s.get(SID)!.totals.specialistRuns).toBe(1);
    warn.mockRestore();
  });

  it('is bookkeeping, not conversation: no timeline entry, and the parent turn stays open', () => {
    let s = start();
    s = chatReducer(s, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SID, uuid: 'a1', timestamp: 1, text: 'working on it',
    } as any);
    const before = s.get(SID)!;
    expect(before.currentTurnId).not.toBeNull();
    s = chatReducer(s, subagentUsage('su6', {
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, free: false,
    }) as any);
    const after = s.get(SID)!;
    expect(after.timeline).toEqual(before.timeline);          // nothing added to the chat
    expect(after.currentTurnId).toBe(before.currentTurnId);   // the turn did NOT end
    expect(after.assistantTurns).toBe(before.assistantTurns);
    expect(after.totals.inputTokens).toBe(100);
  });

  it('is ignored by model-history rebuild — it is bookkeeping, not conversation', async () => {
    const { rebuildHistory } = await import('../src/main/harness/history-rebuild');
    const before = rebuildHistory([]);
    const after = rebuildHistory([{
      type: 'subagent-usage', sessionId: SID, uuid: 'x', timestamp: 1,
      data: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } },
    } as any]);
    expect(after).toEqual(before);
  });
});

// ---- the PRODUCER half: a real specialist run through the real host ---------
const EXPLORER = resolveSpecialist('explorer')!;

describe('subagent-usage — the producer half', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  // The parent runs on 'm' (NO published price); the specialist is delegated to
  // a DIFFERENT model that does have one. That asymmetry is the whole test: if
  // the run were priced with the parent's binding the cost would come back
  // null, so a number here can only have come from the child's own rate.
  const PRICES: Record<string, any> = {
    'm': null,
    'child-model': { in: 3, out: 15 },
    'free-model': { in: 0, out: 0 },
  };

  // providerType defaults to null (→ the host's cloud-safe 'openrouter'
  // fallback). It is a parameter because "free" is resolved from the provider
  // TYPE while the cost is resolved from the rate card — the only way to script
  // the two disagreeing is to set them independently.
  function boot(scripts: any[][], providerType: string | null = null) {
    const model = scriptedModel(scripts);
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }),
      async () => providerType as any, async () => null,
      async (binding) => PRICES[binding.modelId] ?? null,
    );
    return model;
  }

  // Two tool steps then a report — one turn, three steps, so run.usage is a
  // real SUM across steps rather than a single step's numbers.
  const RUN = [
    stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls', 1000, 100)),
    stream(toolCallChunk('c2', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls', 2000, 200)),
    stream(...textChunks('t', 'REPORT: found it'), finishChunk('stop', 3000, 300)),
  ];

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-subusage-')); });
  afterEach(async () => { await host?.destroyAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

  async function runOne(childModelId: string, providerType: string | null = null) {
    boot(RUN, providerType);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      binding: { providerId: 'openrouter', modelId: childModelId },
      token: { parentId: 'root-1', writer: false }, description: 'find it',
    } as any);
    await host.drain('root-1');
    return { seen, childId };
  }

  // Fix 2026-09-16. A specialist that compacts pays for its own summarize call,
  // and that money was counted absolutely nowhere: runSpecialist's accumulator
  // only read `turn-complete`, and a child's `compact-summary` is not in
  // SUBAGENT_DISPLAY_TYPES either, so it never reached the parent's stream to be
  // picked up downstream. Not an edge case — the wrap-up steer in runSpecialist
  // exists precisely because a small local window makes a specialist compact
  // repeatedly mid-run.
  it('folds the CHILD\'s own compaction spend into the run it reports', async () => {
    boot(RUN);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const seen: any[] = [];
    let injected = false;
    host.on('transcript-event', (e: any) => {
      seen.push(e);
      // The first stamped child event names the child; emit a compaction on its
      // OWN session, which is exactly what maybeCompact does mid-run.
      if (injected || !e.data?.agentId) return;
      const child = (host as any).live.get(e.data.agentId);
      if (!child) return;
      injected = true;
      child.session.emit('transcript-event', {
        type: 'compact-summary', sessionId: e.data.agentId, uuid: 'child-compact-1', timestamp: 1,
        data: {
          summary: 'earlier steps condensed', autoCompaction: true,
          usage: { inputTokens: 4000, outputTokens: 120, cacheReadTokens: 0, cacheCreationTokens: 0 },
        },
      });
    });
    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      binding: { providerId: 'openrouter', modelId: 'child-model' },
      token: { parentId: 'root-1', writer: false }, description: 'find it',
    } as any);
    await host.drain('root-1');

    expect(injected).toBe(true);
    const ev = seen.filter((e) => e.type === 'subagent-usage')[0];
    // The run's three steps (6000/600) PLUS the summarize call (4000/120).
    expect(ev.data.usage.inputTokens).toBe(10_000);
    expect(ev.data.usage.outputTokens).toBe(720);
    // …and it is priced, so the parent's Cost chip moves with it.
    expect(ev.data.usage.costUsd).toBeCloseTo((10_000 / 1e6) * 3 + (720 / 1e6) * 15, 10);
  });

  it('reports the finished specialist\'s summed spend to the PARENT, exactly once, priced at the CHILD\'s model', async () => {
    const { seen, childId } = await runOne('child-model');
    const reports = seen.filter((e) => e.type === 'subagent-usage');
    expect(reports).toHaveLength(1);
    const ev = reports[0];
    expect(ev.sessionId).toBe('root-1');            // the PARENT's stream
    expect(ev.data.agentId).toBe(childId);
    expect(ev.data.parentAgentToolUseId).toBe('tc-1');
    expect(ev.data.model).toBe('child-model');
    // Summed across the run's three steps (1000+2000+3000 / 100+200+300).
    expect(ev.data.usage.inputTokens).toBe(6000);
    expect(ev.data.usage.outputTokens).toBe(600);
    // (6000/1e6)*3 + (600/1e6)*15 = 0.018 + 0.009
    expect(ev.data.usage.costUsd).toBeCloseTo(0.027, 10);
    expect(ev.data.usage.free).toBe(false);
    // The child's own turn-complete is NEVER re-emitted under the parent's id —
    // that is what would double-count this exact spend.
    expect(seen.filter((e) => e.type === 'turn-complete')).toEqual([]);
  });

  it('says the specialist was FREE when it ran on a model that costs nothing', async () => {
    const { seen } = await runOne('free-model');
    const ev = seen.find((e) => e.type === 'subagent-usage');
    expect(ev.data.usage.free).toBe(true);
    expect(ev.data.usage.costUsd).toBeNull();   // free is never a $0.00 bill
  });

  it('persists the report on the PARENT\'s record, so a resume replays it', async () => {
    const { childId } = await runOne('child-model');
    const parentEvents = store.readEvents('root-1', root).filter((e) => e.type === 'subagent-usage');
    expect(parentEvents).toHaveLength(1);
    expect(parentEvents[0].data.usage?.inputTokens).toBe(6000);
    expect(parentEvents[0].data.usage?.costUsd).toBeCloseTo(0.027, 10);
    expect(parentEvents[0].data.agentId).toBe(childId);
    // And it comes back out of getHistory() — the exact list the replay handler
    // streams to a resuming window.
    expect(host.getHistory('root-1')!.filter((e) => e.type === 'subagent-usage')).toHaveLength(1);
  });

  // Task 23 item 1 — the specialist-path twin of Task 22 item 1 (which fixed
  // the same contradiction for a parent's own turn-complete, in
  // harness-session.ts). `free` comes from the provider TYPE and `costUsd`
  // comes from the rate card: two independent answers with nothing stopping
  // them disagreeing. A specialist delegated to a model that runs on this
  // machine, whose model id ALSO carries a published rate, reported a run that
  // was billed AND cost nothing to run. The status bar has to trust one of
  // them; `free` wins, and a free run is reported as null, never $0.00.
  it('never reports a specialist run as billed AND free', async () => {
    const { seen } = await runOne('child-model', 'local-engine');
    const ev = seen.find((e) => e.type === 'subagent-usage');
    expect(ev.data.usage.free).toBe(true);
    expect(ev.data.usage.costUsd).toBeNull();
  });

  // Task 23 item 2. The report is only emitted when BOTH sessions are still
  // live — the child must still be in `this.live` for its price card to be
  // readable. That `if` had no `else`, so a teardown race between the run
  // finishing and the report being priced took a path that logged NOTHING: the
  // parent's totals silently went short by a whole delegated run. A cost figure
  // that is quietly short is worse than one that is visibly missing.
  it('says so in the log when a finished specialist\'s spend cannot reach its parent', async () => {
    const logSpy = vi.spyOn(logger, 'log');
    store = new SessionStore(new NativeHome(root));
    let call = 0;
    let childId = '';
    // Drops the PARENT's live entry as the child's final step begins — the
    // teardown race the missing `else` was hiding. Reaching into `live` is the
    // only way to stage it deterministically: the real race is a destroy
    // landing inside a window a test cannot otherwise aim at.
    //
    // Task 25 item 1 — this comment used to say the CHILD half could not
    // genuinely go missing, because runSpecialist's own throwIfEnded notices a
    // missing child. That was wrong, and it invited a future reader to delete a
    // live branch as dead code. throwIfEnded checks `this.live.has(childId)`
    // only DURING the run and never again once runSpecialist has RETURNED,
    // while the spend is priced after that return. Worse, the cascade order
    // makes the child half the MORE likely of the two in production:
    // destroy(parent) awaits destroyChildrenOf(parent) — which destroys each
    // child, deleting the child's own live entry — BEFORE it reaches
    // `this.live.delete(parent)`. A parent teardown landing in that await gap
    // therefore removes the CHILD first and leaves the parent live.
    //
    // So the split here is only about what each test can STAGE, not about what
    // can happen: a doStream hook runs while the run is still going, which is
    // the parent half; the child half needs a hook that fires after
    // runSpecialist resolves, which is the test right below this one.
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const chunks = RUN[Math.min(call, RUN.length - 1)];
        call++;
        if (call === RUN.length) {
          for (const [id, entry] of (host as any).live as Map<string, any>) {
            if (entry.parentSessionId === 'root-1') childId = id;
          }
          (host as any).live.delete('root-1');
        }
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }),
      async () => null, async () => null,
      async (binding) => PRICES[binding.modelId] ?? null,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      binding: { providerId: 'openrouter', modelId: 'child-model' },
      token: { parentId: 'root-1', writer: false }, description: 'find it',
    } as any);
    await host.drain('root-1');

    expect(childId).not.toBe('');
    // Nothing was reported — that is the condition being logged, not a bug here.
    expect(seen.filter((e) => e.type === 'subagent-usage')).toEqual([]);
    // ...and the log names WHICH half was missing. It states only what was
    // looked up and found absent — never a guessed cause
    // (docs/error-message-standards.md).
    expect(logSpy).toHaveBeenCalledWith(
      'ERROR', 'NativeSessionHost',
      "could not report a finished specialist's spend to its parent (the parent session was no longer live) — the parent's session totals will be short by this run",
      expect.objectContaining({ childId, parentId: 'root-1' }),
    );
    logSpy.mockRestore();
  });

  // Task 25 items 1 + 2. The CHILD half of the same race — and the proof that
  // the branch the test above's old comment called unreachable is not only
  // reachable but the more likely one (the cascade order is spelled out there).
  // It also pins a SECOND of the three `missing` phrases: with only the parent
  // phrase pinned, collapsing that three-way ternary to one hardcoded string
  // passed the suite while telling the user the wrong half had gone missing.
  it('names the SPECIALIST half when the child is the session that went missing', async () => {
    const logSpy = vi.spyOn(logger, 'log');
    boot(RUN);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // The post-return hook the comment above describes: wrap runSpecialist so
    // the child's live entry disappears the instant the run RESOLVES — after
    // throwIfEnded's last check, before the spend is priced. That is the exact
    // window destroy() opens by tearing children down ahead of the parent.
    const runSpecialist = (host as any).runSpecialist.bind(host);
    let childId = '';
    (host as any).runSpecialist = async (cid: string, prompt: string) => {
      const result = await runSpecialist(cid, prompt);
      childId = cid;
      (host as any).live.delete(cid);   // the child goes; the parent stays live
      return result;
    };
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      binding: { providerId: 'openrouter', modelId: 'child-model' },
      token: { parentId: 'root-1', writer: false }, description: 'find it',
    } as any);
    await host.drain('root-1');

    expect(childId).not.toBe('');
    expect(seen.filter((e) => e.type === 'subagent-usage')).toEqual([]);
    // Names the CHILD, not the parent — the parent is right there and live, so
    // saying the parent had gone would be a false statement of cause.
    expect(logSpy).toHaveBeenCalledWith(
      'ERROR', 'NativeSessionHost',
      "could not report a finished specialist's spend to its parent (the specialist session was no longer live) — the parent's session totals will be short by this run",
      expect.objectContaining({ childId, parentId: 'root-1' }),
    );
    logSpy.mockRestore();
  });

  // Task 28 item 3. The THIRD `missing` phrase — the one for when BOTH halves
  // are gone. It was the last one left unpinned: with only the parent and child
  // phrases covered (the two tests above), this arm could be rewritten to
  // either of theirs and all 16 tests stayed green, so a teardown that took
  // both sessions would have named ONE of them and implied the other was fine.
  //
  // Reachable by the same cascade as the child half, one step further along it:
  // destroy(parent) deletes the child's live entry (via destroyChildrenOf) and
  // then the parent's, and destroyAll() at app quit walks every live session
  // doing exactly that. A specialist run whose spend is priced after both
  // deletions have landed — the background path in particular, which nothing is
  // awaiting — finds neither session to price it against.
  it('says NEITHER was live when both entries are gone by the time the spend is priced', async () => {
    const logSpy = vi.spyOn(logger, 'log');
    boot(RUN);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // The same post-return hook the test above uses, dropping BOTH entries: the
    // window opens after throwIfEnded's last check and before the spend is
    // priced, which is the only place this arm can be observed.
    const runSpecialist = (host as any).runSpecialist.bind(host);
    let childId = '';
    (host as any).runSpecialist = async (cid: string, prompt: string) => {
      const result = await runSpecialist(cid, prompt);
      childId = cid;
      (host as any).live.delete(cid);        // the child goes...
      (host as any).live.delete('root-1');   // ...and so does the parent
      return result;
    };
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      binding: { providerId: 'openrouter', modelId: 'child-model' },
      token: { parentId: 'root-1', writer: false }, description: 'find it',
    } as any);
    await host.drain('root-1');

    expect(childId).not.toBe('');
    expect(seen.filter((e) => e.type === 'subagent-usage')).toEqual([]);
    // Names BOTH. Picking either half here would be a true sentence that reads
    // as a false one — "the parent session was no longer live" tells the reader
    // the child was still there, and it wasn't.
    expect(logSpy).toHaveBeenCalledWith(
      'ERROR', 'NativeSessionHost',
      "could not report a finished specialist's spend to its parent (neither session was still live) — the parent's session totals will be short by this run",
      expect.objectContaining({ childId, parentId: 'root-1' }),
    );
    logSpy.mockRestore();
  });
});
