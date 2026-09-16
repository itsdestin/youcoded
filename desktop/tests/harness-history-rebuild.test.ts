// Task 10 — the RESUME contract (spec §2.5). rebuildHistory() must reconstruct
// the SAME ModelMessage[] the driver accumulated live, from nothing but the
// persisted transcript events. The deep-equal assertions below are the ARBITER
// of every grouping choice in both harness-session.ts (the live pushes) and
// history-rebuild.ts (the replay): if the two ever diverge on a COMPLETED turn,
// one side is wrong. Interrupt partials are the one documented exception —
// pinned as semantic (same text), not byte-identical, form (see that test).
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HarnessSession, type HarnessSessionOpts } from '../src/main/harness/harness-session';
import { rebuildHistory } from '../src/main/harness/history-rebuild';
import { NativeHome } from '../src/main/native-home';
import { SessionStore, type NativeSessionHeader } from '../src/main/harness/session-store';
import type { HarnessManifest } from '../src/shared/harness-manifest';
import type { NativeTool } from '../src/main/harness/tools/types';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type { AskDecision } from '../src/main/harness/permission-broker';
import { MockLanguageModelV4 } from 'ai/test';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { EMPTY_SKILL_CATALOG } from './helpers/harness-fakes';

// Permissive fake tool (mirrors the loop suite's helper) — records executions,
// subject undefined so tool-layer guards are skipped and decide() is the gate.
function fakeTool(name: string, over: { onExecute?: (a: any, c: any) => any } = {}): NativeTool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: z.object({ file_path: z.string() }),
    permissionSubject: () => undefined,
    async execute(args, ctx) {
      if (over.onExecute) return over.onExecute(args, ctx);
      return { text: `${name} ran` };
    },
  };
}

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

const HARNESS: HarnessManifest = {
  schema: 1, id: 'agent', name: 'Agent', systemPrompt: 'sys', tools: [],
  permissionPolicy: 'ask', limits: { maxTokens: 256 },
};
function makeOpts(over: Partial<HarnessSessionOpts>): HarnessSessionOpts {
  return {
    // See EMPTY_SKILL_CATALOG: keeps the tool set off the real ~/.claude.
    skillCatalog: EMPTY_SKILL_CATALOG,
    sessionId: 's-1', cwd: 'C:/x', harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],
    ...over,
  } as HarnessSessionOpts;
}
const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

const HEADER: NativeSessionHeader = {
  v: 1, sessionId: 's-1', harnessId: 'chat',
  binding: { providerId: 'openrouter', modelId: 'm' }, cwd: 'C:/proj', createdAt: 1,
};

/** Persist the emitted events through a REAL SessionStore and read them back —
 *  this is exactly what NativeSessionHost.resume feeds rebuildHistory (deltas
 *  coalesced per partId, tool events verbatim). Proves the production resume
 *  path — not just the raw in-memory stream — reconstructs history faithfully. */
async function throughStore(events: TranscriptEvent[]): Promise<TranscriptEvent[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-rebuild-'));
  try {
    const store = new SessionStore(new NativeHome(root));
    await store.create(HEADER);
    for (const e of events) await store.append(HEADER.cwd, { ...e, sessionId: 's-1' } as any);
    await store.flushAll();
    return store.readEvents('s-1', HEADER.cwd);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

describe('rebuildHistory — the resume deep-equal contract', () => {
  it('two-step tool turn: rebuild(emitted) deep-equals the live history', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'Let me read.'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'All done.'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const live = (session as any).history as any[];

    // (1) Raw emitted stream rebuilds to the live history byte-for-byte. (The
    // single-delta mock means each partId appears once, so the raw stream
    // already matches what the store coalesces.)
    expect(rebuildHistory(events)).toEqual(live);

    // (2) The PRODUCTION path — events persisted and read back through the store
    // — rebuilds identically. This is what resume() actually does.
    expect(rebuildHistory(await throughStore(events))).toEqual(live);

    // Sanity: the live history really is the multi-step tool shape we expect.
    expect(live).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me read.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'x.ts' } },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value: 'Read ran' } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] },
    ]);
  });

  it('multi-step: step 2 text does NOT merge into step 1 assistant message', async () => {
    // Two tool steps then a text stop → three assistant/tool boundaries. The
    // tool-result between steps must flush step 1, so step 2 opens a fresh
    // assistant message (the exact grouping bug rebuildHistory is designed against).
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'step1'), toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'step2'), toolCallChunk('c2', 'Read', { file_path: 'b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('c', 'final'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const live = (session as any).history as any[];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt).toEqual(live);
    // 'step2' lives in its OWN assistant message, never appended to 'step1'.
    const assistantTexts = rebuilt
      .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
      .map((m) => (m.content as any[]).filter((p) => p.type === 'text').map((p) => p.text).join(''));
    expect(assistantTexts).toEqual(['step1', 'step2', 'final']);
  });

  it('parallel calls in ONE step: rebuild deep-equals live (raw + through-store)', async () => {
    // The seam fix's payoff: two tool calls in a SINGLE step, emitted as
    // use(c1),use(c2),result(c1),result(c2), must rebuild to ONE assistant
    // message [text, c1, c2] + ONE tool message [r1, r2] — exactly the live shape.
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(
        ...textChunks('a', 'reading two'),
        toolCallChunk('c1', 'Read', { file_path: 'a.ts' }),
        toolCallChunk('c2', 'Read', { file_path: 'b.ts' }),
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const live = (session as any).history as any[];
    expect(rebuildHistory(events)).toEqual(live);
    expect(rebuildHistory(await throughStore(events))).toEqual(live);
    expect(live).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [
        { type: 'text', text: 'reading two' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'Read', input: { file_path: 'b.ts' } },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value: 'Read ran' } },
        { type: 'tool-result', toolCallId: 'c2', toolName: 'Read', output: { type: 'text', value: 'Read ran' } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]);
  });

  it('parallel calls, canceled ask on c1: BOTH results back-filled; rebuild deep-equals live', async () => {
    // Cancel on the FIRST of two calls in one step: the back-fill synthesizes
    // canceled results for c1 AND c2 (both tool-use events were already emitted
    // up front), so the persisted transcript carries a matching result for every
    // tool-call and rebuildHistory reconstructs a valid (non-dangling) history.
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(
        toolCallChunk('c1', 'Write', { file_path: 'a.ts' }),
        toolCallChunk('c2', 'Write', { file_path: 'b.ts' }),
        finishChunk('tool-calls'),
      ),
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    // Both uses up front, then both canceled results — the ordering the rebuild relies on.
    const toolEvents = events.filter((e) => e.type === 'tool-use' || e.type === 'tool-result');
    expect(toolEvents.map((e) => `${e.type}:${e.data.toolUseId}`)).toEqual([
      'tool-use:c1', 'tool-use:c2', 'tool-result:c1', 'tool-result:c2',
    ]);
    const rebuilt = rebuildHistory(await throughStore(events));
    expect(rebuilt).toEqual((session as any).history);
    // Every assistant tool-call has a matching tool-result (no dangling tool_call → no provider 400).
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of rebuilt) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as any[]) {
        if (part?.type === 'tool-call') callIds.add(part.toolCallId);
        if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
      }
    }
    expect([...callIds].sort()).toEqual(['c1', 'c2']);
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
  });

  it('text-only turn rebuilds exactly like v0 (plain user/assistant exchange)', async () => {
    const model = scriptedModel([stream(...textChunks('a', 'Hi there'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any); // no tools → v0 path
    const events = collect(session);
    await session.send('hi');
    const live = (session as any).history as any[];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt).toEqual(live);
    // Semantically identical to v0's bare-string assistant message. Bare-string
    // assistant content is an inherent ModelMessage form, exercised by the v0
    // suite (harness-session.test.ts); Task 1 pins the array / tool-result form.
    // streamText accepts both, so the array form here is equivalent.
    expect(rebuilt).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
    ]);
  });

  it('skips event types that never enter model history (thinking, compact-summary, unknown)', () => {
    const mk = (type: string, data: any): TranscriptEvent => ({ type: type as any, sessionId: 's-1', uuid: type, timestamp: 0, data });
    const rebuilt = rebuildHistory([
      mk('user-message', { text: 'q' }),
      mk('assistant-thinking', { text: 'reasoning...', partId: 'r1' }), // reasoning never entered history
      mk('assistant-text', { text: 'answer', partId: 'p1' }),
      mk('compact-summary', { summary: 'compacted' }),                  // display-only marker
      mk('future-unknown-type', { text: 'ignore me' }),                // forward-compat: skipped
      mk('turn-complete', { stopReason: 'end_turn' }),
    ]);
    expect(rebuilt).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
  });

  it('multi-part step text (two partIds) coalesces into ONE assistant text part — deep-equals live', async () => {
    // The store persists ONE assistant-text event per partId, so a step that
    // streamed two text blocks (distinct partIds) arrives as TWO events — but the
    // driver concatenated them into ONE text part live. rebuildHistory must
    // coalesce consecutive text parts to restore the deep-equal contract.
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(
        ...textChunks('p1', 'Hello '),
        ...textChunks('p2', 'world'),
        toolCallChunk('c1', 'Read', { file_path: 'x.ts' }),
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('p3', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    // Two distinct-partId assistant-text events really were emitted for step 1.
    expect(events.filter((e) => e.type === 'assistant-text' && (e.data.partId === 'p1' || e.data.partId === 'p2'))).toHaveLength(2);
    const live = (session as any).history as any[];
    expect(rebuildHistory(events)).toEqual(live);
    expect(rebuildHistory(await throughStore(events))).toEqual(live);
    // The step-1 assistant message carries ONE 'Hello world' text part, not two.
    expect(live[1].content).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'x.ts' } },
    ]);
  });

  it('CRASH truncated tail: unpaired tool-use at end → synthetic tool-result back-filled (no dangling call)', async () => {
    // Process died after the tool-use line persisted but BEFORE its tool-result
    // (a wide window during Bash/Edit). The stream ends on an unpaired tool-use;
    // without back-fill the first resumed send() ships a dangling tool_call → 400.
    const events: TranscriptEvent[] = [
      { type: 'user-message', sessionId: 's-1', uuid: 'u', timestamp: 0, data: { text: 'go' } },
      { type: 'assistant-text', sessionId: 's-1', uuid: 'a', timestamp: 0, data: { text: 'running', partId: 'p1' } },
      { type: 'tool-use', sessionId: 's-1', uuid: 'tu', timestamp: 0, data: { toolUseId: 'c1', toolName: 'Bash', toolInput: { command: 'sleep 9' } } },
      // ...crash. No tool-result, no turn-complete.
    ];
    const check = (rebuilt: any[]) => {
      // The assistant tool-call is immediately followed by a tool message that
      // covers c1 with a synthetic isError-style result.
      expect(rebuilt).toEqual([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [
          { type: 'text', text: 'running' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'Bash', input: { command: 'sleep 9' } },
        ] },
        { role: 'tool', content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'Bash', output: { type: 'text', value: expect.stringContaining('the app was closed mid-execution') } },
        ] },
      ]);
      // Invariant: no dangling tool-call.
      const callIds = new Set<string>(); const resultIds = new Set<string>();
      for (const m of rebuilt) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (part?.type === 'tool-call') callIds.add(part.toolCallId);
          if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
        }
      }
      for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    };
    check(rebuildHistory(events));
    check(rebuildHistory(await throughStore(events)));
  });

  it('CRASH mid-stream orphan: tool-use directly before a later user-message → back-filled', async () => {
    // After a crash the session was resumed and MORE events appended, so an
    // unpaired tool-use sits in the MIDDLE (assistant tool-call followed directly
    // by a user-message). The store is never healed — rebuild must pair it.
    const events: TranscriptEvent[] = [
      { type: 'user-message', sessionId: 's-1', uuid: 'u1', timestamp: 0, data: { text: 'go' } },
      { type: 'tool-use', sessionId: 's-1', uuid: 'tu', timestamp: 0, data: { toolUseId: 'c1', toolName: 'Edit', toolInput: { file_path: 'a.ts' } } },
      // ...crash mid-edit, resumed, next turn appended:
      { type: 'user-message', sessionId: 's-1', uuid: 'u2', timestamp: 0, data: { text: 'again' } },
      { type: 'assistant-text', sessionId: 's-1', uuid: 'a2', timestamp: 0, data: { text: 'reply', partId: 'p2' } },
      { type: 'turn-complete', sessionId: 's-1', uuid: 't2', timestamp: 0, data: {} },
    ];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'Edit', input: { file_path: 'a.ts' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Edit', output: { type: 'text', value: expect.stringContaining('the app was closed mid-execution') } }] },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    ]);
    // The orphaned tool-call now sits directly before its synthetic tool message,
    // NOT before the user-message.
    expect(rebuilt[1].role).toBe('assistant');
    expect(rebuilt[2].role).toBe('tool');
  });

  it('seedHistory clears readRegistry + todos on resume (read-registry is NOT reconstructed)', async () => {
    // The reset-on-resume ruling (spec §2.5): read-before-edit mtimes and the
    // todo list are per-session RUNTIME state, never persisted. A resumed
    // session must start with neither — a stale mtime could wrongly satisfy the
    // read-before-edit gate on the first edit after resume.
    const session = new HarnessSession(makeOpts({ tools: [fakeTool('Read')] }), async () => ({} as any));
    (session as any).readRegistry.set('C:/proj/a.ts', '3:stale-fingerprint');
    (session as any).todos.push({ content: 'stale', status: 'pending', activeForm: 'x' });

    const events: TranscriptEvent[] = [
      { type: 'user-message', sessionId: 's-1', uuid: 'u', timestamp: 0, data: { text: 'hi' } },
      { type: 'assistant-text', sessionId: 's-1', uuid: 'a', timestamp: 0, data: { text: 'ok', partId: 'p1' } },
      { type: 'turn-complete', sessionId: 's-1', uuid: 't', timestamp: 0, data: {} },
    ];
    session.seedHistory(rebuildHistory(events));

    expect((session as any).readRegistry.size).toBe(0); // NOT reconstructed
    expect((session as any).todos.length).toBe(0);
    // History itself WAS seeded from the events.
    expect((session as any).history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
  });

  it('interrupt partial: SEMANTIC equivalence (same text), not byte-identical form', async () => {
    // Live: the interrupt path pushes a BARE-STRING assistant message (the
    // partial). Rebuild produces the ARRAY form ([{type:'text',text}]) from the
    // emitted assistant-text event. Bare-string assistant content is an inherent
    // ModelMessage form (exercised by the v0 suite, harness-session.test.ts);
    // Task 1 pins the array / tool-result form. streamText accepts both, so this
    // divergence is acceptable — but ONLY for interrupt partials, and the
    // assertion here is honest about it: same text content, different container.
    const never = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'p1' });
        controller.enqueue({ type: 'text-delta', id: 'p1', delta: 'partial answer' });
        // never closes → the turn stays in flight until interrupt()
      },
    });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = new HarnessSession(makeOpts({ tools: [] }), async () => model as any);
    const events = collect(session);
    const p = session.send('go');
    // Wait until the partial delta has been emitted, then interrupt.
    while (!events.some((e) => e.type === 'assistant-text')) await new Promise((r) => setTimeout(r, 2));
    session.interrupt();
    await p;

    const live = (session as any).history as any[];
    const rebuilt = rebuildHistory(events);

    // Byte-identical form does NOT hold here (bare string vs array) — that's the
    // documented exception.
    expect(rebuilt).not.toEqual(live);

    // Semantic equivalence DOES: same roles, same flattened text per message.
    const flatten = (m: any): string =>
      typeof m.content === 'string' ? m.content
        : (m.content as any[]).filter((p) => p.type === 'text').map((p) => p.text).join('');
    expect(rebuilt.map((m) => m.role)).toEqual(live.map((m) => m.role));
    expect(rebuilt.map(flatten)).toEqual(live.map(flatten));
    expect(flatten(rebuilt[rebuilt.length - 1])).toBe('partial answer');
  });

  it('canceled-ask back-fill round-trips: dangling tool-call gets its tool-result', async () => {
    // The CRITICAL regression from the loop suite, seen through the RESUME lens:
    // a canceled permission ask back-fills a canceled tool-result event, so the
    // persisted transcript carries a matching result for the assistant tool-call.
    // rebuildHistory must therefore reconstruct a valid (non-dangling) history.
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const rebuilt = rebuildHistory(await throughStore(events));
    // Every assistant tool-call has a matching tool-result in the rebuilt history
    // (a dangling tool_call would make the next provider request 400).
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of rebuilt) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as any[]) {
        if (part?.type === 'tool-call') callIds.add(part.toolCallId);
        if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
      }
    }
    expect(callIds.size).toBeGreaterThan(0);
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    expect(rebuilt).toEqual((session as any).history);
  });
});

// Task 3 (#290 follow-up fix 2): user-attached images vanished on resume
// because send() only ever persisted { text }. attachments now ride the
// event as paths (events carry no binary) and rebuildHistory re-reads them
// via an injected reader — kept out of history-rebuild.ts's imports so the
// module stays pure and this suite needs no filesystem.
describe('attachment resume (#290 follow-up fix 2)', () => {
  const ev = (type: string, data: any) => ({ type, sessionId: 's', uuid: crypto.randomUUID(), timestamp: 1, data }) as any;
  const fakeReader = (p: string) => p.endsWith('ok.png') ? { mediaType: 'image/png', data: Buffer.from('png!') } : null;

  it('re-reads persisted attachment paths into user-message parts', () => {
    const out = rebuildHistory([ev('user-message', { text: 'see /tmp/ok.png', attachments: ['/tmp/ok.png'] })], fakeReader);
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'see /tmp/ok.png' }, { type: 'file', mediaType: 'image/png', data: Buffer.from('png!') }] }]);
  });

  it('a vanished attachment degrades to the plain-string shape (path still in text)', () => {
    const out = rebuildHistory([ev('user-message', { text: 'see /tmp/gone.png', attachments: ['/tmp/gone.png'] })], fakeReader);
    expect(out).toEqual([{ role: 'user', content: 'see /tmp/gone.png' }]);
  });

  it('no reader (pure/legacy call) keeps today\'s exact behavior', () => {
    const out = rebuildHistory([ev('user-message', { text: 'hi', attachments: ['/tmp/ok.png'] })]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('mixed attachments: one resolves, one is gone — the readable image survives, message does NOT collapse to plain-string', () => {
    // Per-path degrade, same as imagePartsFor's live skip-don't-throw semantics:
    // one vanished attachment among several must not sink the whole message
    // back to the bare-string shape and lose the image that IS still there.
    const out = rebuildHistory([ev('user-message', { text: 'see both', attachments: ['/tmp/ok.png', '/tmp/gone.png'] })], fakeReader);
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'see both' }, { type: 'file', mediaType: 'image/png', data: Buffer.from('png!') }] }]);
  });
});

// Task 7: model-initiated tool-delivered images (e.g. Read on a picture) must
// survive resume the same way user attachments do (Task 3 above) — the event
// carries the path, never the binary, and rebuildHistory re-reads it through
// the injected reader into the exact live content-output shape (Task 5).
describe('image tool-result resume', () => {
  const fakeReader = (p: string) => p.endsWith('ok.png') ? { mediaType: 'image/png', data: Buffer.from('png!') } : null;
  const ev = (type: string, data: any) => ({ type, sessionId: 's', uuid: crypto.randomUUID(), timestamp: 1, data }) as any;
  const pair = (images: string[]) => [
    ev('tool-use', { toolUseId: 't1', toolName: 'Read', toolInput: { file_path: images[0] } }),
    ev('tool-result', { toolUseId: 't1', toolName: 'Read', toolResult: 'Read image', images }),
    ev('turn-complete', {}),
  ];

  it('re-reads a persisted image into the exact live content-output shape', () => {
    const out = rebuildHistory(pair(['/tmp/ok.png']), fakeReader);
    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content[0].output).toEqual({
      type: 'content',
      // filename (Fix 3, 2026-08-11 review): the resumed shape must carry the
      // same basename-derived filename harness-session.ts's live path does —
      // otherwise a resumed session labels images differently from a live one.
      value: [{ type: 'text', text: 'Read image' }, { type: 'file', mediaType: 'image/png', filename: 'ok.png', data: { type: 'data', data: Buffer.from('png!') } }],
    });
  });

  it('a vanished image degrades to text WITH a named note — never a silent dangling reference', () => {
    const out = rebuildHistory(pair(['/tmp/gone.png']), fakeReader);
    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content[0].output.type).toBe('text');
    expect(toolMsg.content[0].output.value).toContain('[image no longer available: /tmp/gone.png]');
  });

  // Brief's title had an unescaped apostrophe inside single quotes (a syntax
  // error) — reworded rather than escaped so it stays readable.
  it('no reader means plain text output, today’s shape', () => {
    const out = rebuildHistory(pair(['/tmp/ok.png']));
    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content[0].output).toEqual({ type: 'text', value: 'Read image' });
  });

  it('partial availability: some images present, some gone — both handled in one result', () => {
    const out = rebuildHistory(
      [
        ev('tool-use', { toolUseId: 't1', toolName: 'Read', toolInput: {} }),
        ev('tool-result', { toolUseId: 't1', toolName: 'Read', toolResult: 'Read images', images: ['/tmp/ok.png', '/tmp/gone.png'] }),
        ev('turn-complete', {}),
      ],
      fakeReader,
    );
    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content[0].output).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Read images\n[image no longer available: /tmp/gone.png]' },
        { type: 'file', mediaType: 'image/png', filename: 'ok.png', data: { type: 'data', data: Buffer.from('png!') } },
      ],
    });
  });
});
