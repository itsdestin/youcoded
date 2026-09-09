// HarnessSession Phase 2 — the multi-step agentic turn driver (Plan A, Task 9).
// These tests DEFINE the contract for the tool loop: emitted transcript-event
// ORDER, history grouping, the exact permission sequencing (validate → doom →
// guards → decide → ask → execute), budgets (max_steps), doom-loop detection,
// step-level retry, and interrupt semantics. The v0 emit surface is FROZEN —
// this suite only ever asserts existing TranscriptEventType values; max_steps
// and doom_loop surface as permission ASKS (askUser), never as new events.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessSession } from '../src/main/harness/harness-session';
import { MAX_IMAGES_PER_TURN, MAX_IMAGE_BYTES_PER_TURN, MAX_ATTACHMENT_BYTES } from '../src/main/harness/image-support';
import type { HarnessManifest } from '../src/shared/harness-manifest';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type { AskRequest, AskDecision } from '../src/main/harness/permission-broker';
// Scripted-mock builders live in a shared helper — the history-rebuild test
// (Task 10) drives the same mock model so its deep-equal contract exercises the
// exact grouping this suite pins.
import { textChunks, toolCallChunk, toolInputChunks, finishChunk, stream, scriptedModel, reasoningChunks } from './helpers/scripted-model';
// Direct MockLanguageModelV4 construction — only the postSteer tests below need
// a per-call SIDE EFFECT (posting a steer from inside doStream) that the
// scripted-model helpers don't support; everything else in this suite goes
// through scriptedModel/scriptModel.
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
// Session-construction scaffolding (HARNESS/makeOpts/fakeTool) lives in a shared
// helper so the profile-driven driver test (Task 5) reuses the exact same setup.
// makeSession/scriptModel/drainTurn (2026-08-11 review fixes) reused from the
// compaction suite's own scaffolding rather than hand-rolling a second way to
// force the summarize branch.
import { HARNESS, makeOpts, fakeTool, makeSession, scriptModel, drainTurn, FAKE_SESSION_CWD } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}
function types(events: TranscriptEvent[]) { return events.map((e) => e.type); }

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

describe('HarnessSession — multi-step turn driver', () => {
  it('happy path: emits user-message → text → tool-use → tool-result → text → turn-complete IN ORDER', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'Let me read.'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'All done.'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(types(events)).toEqual([
      'user-message', 'assistant-text', 'tool-use', 'tool-result', 'assistant-text', 'turn-complete',
    ]);
    // Distinct partIds per step's text bubble.
    const texts = events.filter((e) => e.type === 'assistant-text');
    expect(texts[0].data.partId).toBeTruthy();
    expect(texts[1].data.partId).toBeTruthy();
    expect(texts[1].data.partId).not.toBe(texts[0].data.partId);
    // tool-use / tool-result carry the Read call.
    const use = events.find((e) => e.type === 'tool-use')!;
    expect(use.data.toolName).toBe('Read');
    expect(use.data.toolInput).toEqual({ file_path: 'x.ts' });
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.toolName).toBe('Read');
    expect(res.data.isError).toBe(false);
    expect(res.data.toolResult).toBe('Read ran');
    // The tool actually executed.
    expect((read as any).calls).toHaveLength(1);
  });

  it('builds history: user / assistant(text+tool-call) / tool(result) / assistant(text)', async () => {
    const read = fakeTool('Read');
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');
    // The SECOND step's prompt is the accumulated history — it must contain the
    // assistant tool-call and the tool-result output value.
    const p = JSON.stringify(seen[1]);
    expect(p).toContain('go');            // user
    expect(p).toContain('reading');       // assistant text
    expect(p).toContain('tool-call');     // assistant tool-call part
    expect(p).toContain('Read ran');      // tool-result output value
  });

  it('parallel calls in ONE step: ALL tool-use events precede ALL tool-result events; history is assistant[text,c1,c2] + tool[r1,r2]', async () => {
    // Task 10 seam fix: a multi-call step must emit use(c1),use(c2) FIRST, then
    // result(c1),result(c2) — NOT interleaved use→result→use→result. This is
    // what lets rebuildHistory (pure event-adjacency) reconstruct the SAME
    // step-grouped history the driver pushes (one assistant message with both
    // tool-calls, one tool message with both results).
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
    // Event order: both uses, THEN both results (in call order).
    const toolEvents = events.filter((e) => e.type === 'tool-use' || e.type === 'tool-result');
    expect(toolEvents.map((e) => `${e.type}:${e.data.toolUseId}`)).toEqual([
      'tool-use:c1', 'tool-use:c2', 'tool-result:c1', 'tool-result:c2',
    ]);
    // History: ONE assistant message [text, c1, c2], then ONE tool message [r1, r2].
    const history = (session as any).history as any[];
    expect(history[1].role).toBe('assistant');
    expect(history[1].content.map((p: any) => p.type)).toEqual(['text', 'tool-call', 'tool-call']);
    expect(history[1].content.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId)).toEqual(['c1', 'c2']);
    expect(history[2].role).toBe('tool');
    expect(history[2].content.map((p: any) => p.toolCallId)).toEqual(['c1', 'c2']);
    expect((read as any).calls).toHaveLength(2);   // both executed serially
  });

  it('decide() deny → isError tool-result with the blocked message; model sees refusal; loop continues', async () => {
    const write = fakeTool('Write');
    const seen: any[] = [];
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'deny', denyListed: false }) }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/blocked by a permission rule/);
    expect((write as any).calls).toHaveLength(0);       // never executed
    expect(JSON.stringify(seen[1])).toMatch(/blocked by a permission rule/); // model receives it
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);       // loop continued to completion
  });

  // Specialists (plan 1a, Task 5): a deny MAY carry its own model-facing reason.
  // When it does, that reason replaces the generic copy in the tool result —
  // otherwise a child refused a tool ("not available to this specialist") would
  // read a generic "blocked by a permission rule" and simply retry the same call.
  it('decide() deny WITH a message surfaces that message verbatim instead of the generic copy', async () => {
    const write = fakeTool('Write');
    const seen: any[] = [];
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(
      makeOpts({ tools: [write], decide: async () => ({ action: 'deny', denyListed: false, message: 'The Write tool is not available to this specialist.' }) }),
      async () => model as any,
    );
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toBe('The Write tool is not available to this specialist.');
    expect(res.data.toolResult).not.toMatch(/blocked by a permission rule/);
    expect(JSON.stringify(seen[1])).toMatch(/not available to this specialist/); // model receives the REASON
    expect((write as any).calls).toHaveLength(0);
  });

  it('decide() ask → askUser; allow executes, deny returns "user declined" and does NOT execute', async () => {
    // Scenario A: ask → allow → executes.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      expect(askUser).toHaveBeenCalledTimes(1);
      expect(askUser.mock.calls[0][0].toolName).toBe('Write');
      expect((write as any).calls).toHaveLength(1);
      expect(events.find((e) => e.type === 'tool-result')!.data.isError).toBe(false);
    }
    // Scenario B: ask → deny → refusal, not executed.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'deny' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/user declined/i);
      expect((write as any).calls).toHaveLength(0);
    }
  });

  it('askUser canceled → user-interrupt, turn ends, NO turn-complete', async () => {
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
    expect((write as any).calls).toHaveLength(0);
  });

  it('invalid args (schema mismatch) → isError corrective result, tool NOT executed, loop continues', async () => {
    const write = fakeTool('Write', { schema: z.object({ file_path: z.string() }) });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 123 }), finishChunk('tool-calls')),  // wrong type
      stream(...textChunks('b', 'fixed'), finishChunk('stop')),
    ]);
    const decide = vi.fn(async () => ALLOW);
    const session = new HarnessSession(makeOpts({ tools: [write], decide }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/Invalid arguments/);
    expect((write as any).calls).toHaveLength(0);
    expect(decide).not.toHaveBeenCalled();               // validation precedes permission
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('unknown parameter → corrective result naming the valid parameters; the corrected call runs; no doom-loop misfire', async () => {
    // Ledger D-2: a strict schema turns a Claude-Code-shaped `Grep {"-i": true}`
    // into an error the model can act on. The corrected call has DIFFERENT
    // arguments, so it must not count toward the doom-loop window — and an
    // invalid call never enters that window at all (it returns before the
    // signature is recorded), so even two identical wrong tries + one right
    // one must never trip the ask.
    const grep = fakeTool('Grep', { schema: z.object({ pattern: z.string(), ignore_case: z.boolean().optional() }).strict() });
    const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
    const wrong = () => stream(toolCallChunk('c', 'Grep', { pattern: 'x', '-i': true }), finishChunk('tool-calls'));
    const model = scriptedModel([
      wrong(), wrong(),
      stream(toolCallChunk('c3', 'Grep', { pattern: 'x', ignore_case: true }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'found it'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [grep], decide: async () => ALLOW, askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const results = events.filter((e) => e.type === 'tool-result');
    expect(results).toHaveLength(3);
    expect(results[0].data.isError).toBe(true);
    expect(results[0].data.toolResult).toBe(
      'Invalid arguments for Grep: unknown parameter(s) "-i". Valid parameters: pattern, ignore_case. Fix the arguments and call again.',
    );
    expect(results[2].data.isError).toBeFalsy();
    expect((grep as any).calls).toEqual([{ pattern: 'x', ignore_case: true }]);   // only the corrected call executed
    expect(askUser.mock.calls.some((c) => c[0].toolName === 'doom_loop')).toBe(false);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);           // the turn continued, no crash
  });

  it('doom loop: 3 identical calls → askUser(doom_loop); allow resets window, deny → corrective error', async () => {
    // deny path: three identical Read calls, then the doom ask denies.
    {
      const read = fakeTool('Read');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'deny' }));
      const dup = () => stream(toolCallChunk('c', 'Read', { file_path: 'same.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([dup(), dup(), dup(), stream(...textChunks('z', 'stop'), finishChunk('stop'))]);
      const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      const doomAsk = askUser.mock.calls.find((c) => c[0].toolName === 'doom_loop');
      expect(doomAsk).toBeTruthy();
      const results = events.filter((e) => e.type === 'tool-result');
      const last = results[results.length - 1];
      expect(last.data.isError).toBe(true);
      expect(last.data.toolResult).toMatch(/repeated 3 times/);   // threshold-accurate (default profile → 3)
      expect((read as any).calls).toHaveLength(2);       // 3rd never executed (doom denied)
    }
    // allow path: doom ask allows, window resets, tool executes.
    {
      const read = fakeTool('Read');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
      const dup = () => stream(toolCallChunk('c', 'Read', { file_path: 'same.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([dup(), dup(), dup(), stream(...textChunks('z', 'stop'), finishChunk('stop'))]);
      const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW, askUser }), async () => model as any);
      collect(session);
      await session.send('go');
      expect(askUser.mock.calls.some((c) => c[0].toolName === 'doom_loop')).toBe(true);
      expect((read as any).calls).toHaveLength(3);        // 3rd executed after allow
    }
  });

  it.each([
    { modelId: 'm', steps: 26, tier: 'default (25-step)' },
    { modelId: 'anthropic/claude-opus-4-8', steps: 51, tier: 'frontier (50-step)' },
  ])('specialist children bypass the $tier root fallback without a max_steps ask', async ({ modelId, steps }) => {
    const read = fakeTool('Read');
    const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'deny' }));
    const toolStep = (i: number) => stream(
      toolCallChunk(`c${i}`, 'Read', { file_path: `file-${i}.ts` }),
      finishChunk('tool-calls'),
    );
    const model = scriptedModel([
      ...Array.from({ length: steps }, (_, i) => toolStep(i + 1)),
      stream(...textChunks('done', 'REPORT: complete'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(
      makeOpts({
        binding: { providerId: 'openrouter', modelId },
        tools: [read],
        decide: async () => ALLOW,
        askUser,
        isSpecialistChild: true,
      }),
      async () => model as any,
    );
    const events = collect(session);

    await session.send('go');

    expect((read as any).calls).toHaveLength(steps);
    expect(askUser.mock.calls.some((call) => call[0].toolName === 'max_steps')).toBe(false);
    expect(events.find((event) => event.type === 'turn-complete')?.data.stopReason).toBe('end_turn');
  });

  it('root sessions retain the default 25-step fallback when no explicit maxSteps is set', async () => {
    const read = fakeTool('Read');
    const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'deny' }));
    const toolStep = (i: number) => stream(
      toolCallChunk(`c${i}`, 'Read', { file_path: `file-${i}.ts` }),
      finishChunk('tool-calls'),
    );
    const model = scriptedModel(Array.from({ length: 25 }, (_, i) => toolStep(i + 1)));
    const session = new HarnessSession(
      makeOpts({ tools: [read], decide: async () => ALLOW, askUser }),
      async () => model as any,
    );
    const events = collect(session);

    await session.send('go');

    expect(askUser.mock.calls.some((call) => call[0].toolName === 'max_steps')).toBe(true);
    expect(events.find((event) => event.type === 'turn-complete')?.data.stopReason).toBe('max_steps');
  });

  it('maxSteps: allow → loop continues (counter resets); deny → turn-complete stopReason max_steps', async () => {
    const twoStepHarness: HarnessManifest = { ...HARNESS, limits: { maxSteps: 2, maxTokens: 256 } };
    // deny path: two tool-calls hit the budget, ask denies → stopReason max_steps.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'deny' }));
      const tc = () => stream(toolCallChunk('c', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([tc(), tc(), tc()]);
      const session = new HarnessSession(makeOpts({ harness: twoStepHarness, tools: [write], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      expect(askUser.mock.calls.some((c) => c[0].toolName === 'max_steps')).toBe(true);
      const done = events.find((e) => e.type === 'turn-complete')!;
      expect(done.data.stopReason).toBe('max_steps');
    }
    // allow path: budget ask allows, counter resets, model then stops normally.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
      const tc = () => stream(toolCallChunk('c', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([tc(), tc(), stream(...textChunks('z', 'stop'), finishChunk('stop'))]);
      const session = new HarnessSession(makeOpts({ harness: twoStepHarness, tools: [write], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      expect(askUser.mock.calls.some((c) => c[0].toolName === 'max_steps')).toBe(true);
      const done = events.find((e) => e.type === 'turn-complete')!;
      expect(done.data.stopReason).toBe('end_turn');    // continued past the budget, ended normally
    }
  });

  it('usage: per-step usages SUM into the turn-complete usage', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls', 5, 3)),
      stream(...textChunks('b', 'done'), finishChunk('stop', 7, 4)),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.usage).toMatchObject({ inputTokens: 12, outputTokens: 7 });
    expect(typeof done.data.usage!.tokensPerSecond).toBe('number');
  });

  it('interrupt mid-execute: tool sees aborted signal; user-interrupt emitted, no turn-complete', async () => {
    let started = false;
    // A tool that blocks until the abort signal fires (i.e. until interrupt()).
    const slow = fakeTool('Write', {
      onExecute: (_args, ctx) => new Promise((resolve) => {
        started = true;
        ctx.signal.addEventListener('abort', () => resolve({ text: 'Canceled: the user interrupted this operation.', isError: true }));
      }),
    });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'unreached'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [slow], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    const p = session.send('go');
    // Wait for the tool to start executing, then interrupt.
    while (!started) await new Promise((r) => setTimeout(r, 2));
    session.interrupt();
    await p;
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
  });

  it('retry: attempt 1 errors immediately, attempt 2 streams clean → completes, no dup events', async () => {
    const retryable = Object.assign(new Error('temporary upstream'), { statusCode: 503 });
    const model = scriptedModel([
      stream({ type: 'error', error: retryable }),                    // attempt 1: immediate error, emits nothing
      stream(...textChunks('a', 'Hello!'), finishChunk('stop')),      // attempt 2: clean
    ]);
    const session = new HarnessSession(makeOpts({ tools: [], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const texts = events.filter((e) => e.type === 'assistant-text');
    expect(texts.map((e) => e.data.text).join('')).toBe('Hello!');    // no duplicate from attempt 1
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
    expect(events.some((e) => e.type === 'session-error')).toBe(false);
  });

  it('tool-layer guard: path OUTSIDE cwd forces an ask even when decide() allows (external_directory)', async () => {
    // permissionSubject returns an absolute path outside the session cwd (C:/x)
    // → checkPathGuard verdict 'external' → forced ask, short-circuiting decide().
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'C:/other/secrets-elsewhere.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [write], decide, askUser }), async () => model as any);
    collect(session);
    await session.send('go');
    expect(askUser).toHaveBeenCalledTimes(1);            // external forced the ask
    expect(askUser.mock.calls[0][0].toolName).toBe('Write');
    expect(decide).not.toHaveBeenCalled();               // external short-circuits configured decision
    expect((write as any).calls).toHaveLength(1);        // ask allowed → executed
  });

  // 2026-08-16 stuck-session investigation. A local model Globbed "ROADMAP.md"
  // (Glob returns workspace-RELATIVE paths) and then invented an absolute path
  // from the project's name — "/youcoded-dev/ROADMAP.md" — which is outside the
  // workspace and exists nowhere. That forced an external_directory ask about a
  // fictional location, and the turn hung on it. The model is told the truth
  // and retries instead; only a path we can CONFIRM inside the workspace
  // short-circuits the ask.
  describe('an invented outside path that is really a workspace file', () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-path-'));
      fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# roadmap');
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

    it('Read: no ask at all — the model is told the real workspace path', async () => {
      const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'Read', { file_path: `/${path.basename(root)}/ROADMAP.md` }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ cwd: root, tools: [read], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');

      expect(askUser).not.toHaveBeenCalled();
      expect((read as any).calls).toHaveLength(0);       // NOT executed — the path is fiction
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toContain('ROADMAP.md');       // names the real path
      expect(res.data.toolResult).not.toMatch(/declined|permission rule/i); // never blames the user
    });

    it('Write is NOT diverted — creating a new file outside the workspace is a real request', async () => {
      // "Doesn't exist yet" is normal for Write, so nonexistence cannot mean
      // "the model must have meant the workspace copy". This one still asks.
      const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: `/${path.basename(root)}/ROADMAP.md` }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ cwd: root, tools: [write], decide: async () => ALLOW, askUser }), async () => model as any);
      collect(session);
      await session.send('go');

      expect(askUser).toHaveBeenCalledTimes(1);
      expect(askUser.mock.calls[0][0]).toMatchObject({ external: true });
    });

    // 2026-09-05: a REAL file outside the workspace is READ with no card at all
    // (READ_ONLY_PATH_TOOLS). The property this case has always existed to pin —
    // that the invented-path divert is not a jail hole — is now carried by Edit,
    // which is the half of the pair that can still change something.
    it('a REAL file outside the workspace is read with no ask, and the same file still asks for Edit', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genuinely-outside-'));
      const target = path.join(outside, 'ROADMAP.md');
      fs.writeFileSync(target, '# a real external file');
      try {
        const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
        const askRead = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
        const readModel = scriptedModel([
          stream(toolCallChunk('c1', 'Read', { file_path: target }), finishChunk('tool-calls')),
          stream(...textChunks('b', 'ok'), finishChunk('stop')),
        ]);
        const readSession = new HarnessSession(makeOpts({ cwd: root, tools: [read], decide: async () => ALLOW, askUser: askRead }), async () => readModel as any);
        collect(readSession);
        await readSession.send('go');
        expect(askRead).not.toHaveBeenCalled();          // looking at it changes nothing
        expect((read as any).calls).toHaveLength(1);     // and it really ran

        const edit = fakeTool('Edit', { permissionSubject: (a: any) => a.file_path });
        const askEdit = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
        const editModel = scriptedModel([
          stream(toolCallChunk('c1', 'Edit', { file_path: target }), finishChunk('tool-calls')),
          stream(...textChunks('b', 'ok'), finishChunk('stop')),
        ]);
        const editSession = new HarnessSession(makeOpts({ cwd: root, tools: [edit], decide: async () => ALLOW, askUser: askEdit }), async () => editModel as any);
        collect(editSession);
        await editSession.send('go');
        expect(askEdit).toHaveBeenCalledTimes(1);        // the jail still holds for writes
        expect(askEdit.mock.calls[0][0]).toMatchObject({ external: true });
      } finally {
        fs.rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      }
    });

    // The "no guessing" property: when nothing in the workspace matches, the
    // harness must NOT invent a replacement path. Read now proves that by
    // EXECUTING the call the model actually made (no ask, no divert message);
    // Edit proves the ask still fires for the same unmatched outside path.
    it('an outside path with NO workspace match is not diverted — no guessing', async () => {
      const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
      const askRead = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
      const readModel = scriptedModel([
        stream(toolCallChunk('c1', 'Read', { file_path: '/nowhere-at-all/NOPE.md' }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const readSession = new HarnessSession(makeOpts({ cwd: root, tools: [read], decide: async () => ALLOW, askUser: askRead }), async () => readModel as any);
      const events = collect(readSession);
      await readSession.send('go');
      expect(askRead).not.toHaveBeenCalled();
      expect((read as any).calls).toHaveLength(1);
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.toolResult).not.toMatch(/inside the workspace — retry/); // no invented replacement

      const edit = fakeTool('Edit', { permissionSubject: (a: any) => a.file_path });
      const askEdit = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
      const editModel = scriptedModel([
        stream(toolCallChunk('c1', 'Edit', { file_path: '/nowhere-at-all/NOPE.md' }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const editSession = new HarnessSession(makeOpts({ cwd: root, tools: [edit], decide: async () => ALLOW, askUser: askEdit }), async () => editModel as any);
      collect(editSession);
      await editSession.send('go');
      expect(askEdit).toHaveBeenCalledTimes(1);
    });
  });

  // 2026-09-05, Destin: "permissions boundaries should only really be for
  // actions that change things (write, edit, bash, etc)." Reads outside the
  // workspace no longer raise a card in ANY mode — Ask First included. Every
  // other harness draws the line here too (Codex/Hermes fence writes only).
  describe('reads outside the workspace never ask (READ_ONLY_PATH_TOOLS)', () => {
    const OUTSIDE = 'C:/other/nothing-like-it-here.md';   // outside makeOpts' cwd, no workspace twin
    const readCases = [
      { name: 'Read', input: { file_path: OUTSIDE }, schema: undefined },
      { name: 'Grep', input: { path: OUTSIDE }, schema: z.object({ path: z.string() }) },
      { name: 'Glob', input: { path: OUTSIDE }, schema: z.object({ path: z.string() }) },
    ] as const;

    for (const c of readCases) {
      it(`${c.name}: an outside path runs with no ask, in every mode`, async () => {
        const tool = fakeTool(c.name, {
          ...(c.schema ? { schema: c.schema } : {}),
          permissionSubject: (a: any) => a.file_path ?? a.path,
        });
        const decide = vi.fn(async () => ALLOW);
        const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
        const model = scriptedModel([
          stream(toolCallChunk('c1', c.name, c.input), finishChunk('tool-calls')),
          stream(...textChunks('b', 'ok'), finishChunk('stop')),
        ]);
        const session = new HarnessSession(makeOpts({ tools: [tool], decide, askUser }), async () => model as any);
        collect(session);
        await session.send('go');
        expect(askUser).not.toHaveBeenCalled();          // the whole point
        expect(decide).toHaveBeenCalledTimes(1);         // configured rules STILL consulted
        expect((tool as any).calls).toHaveLength(1);
      });

      it(`${c.name}: an explicit deny rule still wins over the outside path`, async () => {
        // The guard stopped forcing an ask; it did not start forcing an allow.
        const tool = fakeTool(c.name, {
          ...(c.schema ? { schema: c.schema } : {}),
          permissionSubject: (a: any) => a.file_path ?? a.path,
        });
        const decide = vi.fn(async () => ({ action: 'deny', denyListed: false } as PermissionDecision));
        const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
        const model = scriptedModel([
          stream(toolCallChunk('c1', c.name, c.input), finishChunk('tool-calls')),
          stream(...textChunks('b', 'ok'), finishChunk('stop')),
        ]);
        const session = new HarnessSession(makeOpts({ tools: [tool], decide, askUser }), async () => model as any);
        collect(session);
        await session.send('go');
        expect((tool as any).calls).toHaveLength(0);     // refused
        expect(askUser).not.toHaveBeenCalled();
      });
    }

    it('a credential path is STILL hard-denied for Read — the secret block is untouched', async () => {
      const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
      const secret = path.join(os.homedir(), '.ssh', 'id_rsa');
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'Read', { file_path: secret }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      expect((read as any).calls).toHaveLength(0);       // never ran
      expect(askUser).not.toHaveBeenCalled();            // and never offered as a choice
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/credential|secret/i);
    });
  });

  // A URL is not a path. Before 2026-09-05 WebFetch's subject was canonicalized
  // against the cwd, so a page whose last segment looked like a secret file was
  // refused as "a credential or secret file" — a wrong, alarming error for an
  // ordinary web request (docs/error-message-standards.md).
  it('WebFetch: a URL that ends in a credential-looking name is not path-guarded', async () => {
    const fetchTool = fakeTool('WebFetch', {
      schema: z.object({ url: z.string() }),
      permissionSubject: (a: any) => a.url,
    });
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'WebFetch', { url: 'https://example.com/docs/.env.example' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [fetchTool], decide, askUser }), async () => model as any);
    collect(session);
    await session.send('go');
    expect((fetchTool as any).calls).toHaveLength(1);    // fetched, not refused as a secret
    expect(askUser).not.toHaveBeenCalled();
  });

  // Task 10 (plan 1b): the parent has to be able to Read the spill file its
  // own truncated specialist report was written to, without the guard
  // treating that path like any other file outside the workspace — otherwise
  // the footer's "Read it if you need the rest" advice hits the exact same
  // ask/block wall the Bash spill-file fix (guards.ts) already closed for
  // Bash's own output. internalReadRoots is how NativeSessionHost wires that
  // exemption in per-session, scoped to this one session's own artifact dir.
  it('tool-layer guard: internalReadRoots lets the parent Read its own spill path without an ask', async () => {
    const spillDir = 'C:/spill/session-1';
    const read = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Read', { file_path: `${spillDir}/child-1.report.md` }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(
      makeOpts({ tools: [read], decide, askUser, internalReadRoots: [spillDir] }), async () => model as any,
    );
    collect(session);
    await session.send('go');
    expect(askUser).not.toHaveBeenCalled();                          // internal root → no forced ask
    expect(decide).toHaveBeenCalledWith('Read', `${spillDir}/child-1.report.md`); // reaches decide() normally
  });

  // Driven by EDIT, deliberately. Since 2026-09-05 no read outside the workspace
  // forces an ask (READ_ONLY_PATH_TOOLS), so a Read here would pass whether the
  // exemption were correctly scoped or wide open — it would pin nothing. Edit is
  // the tool for which "is this path inside the exempted root?" still has a
  // visible consequence, so it is the one that can still catch a widening.
  it('tool-layer guard: internalReadRoots does not widen to a sibling directory — a write there still asks', async () => {
    const spillDir = 'C:/spill/session-1';
    const edit = fakeTool('Edit', { permissionSubject: (a: any) => a.file_path });
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Edit', { file_path: 'C:/spill/not-our-session/x.txt' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(
      makeOpts({ tools: [edit], decide, askUser, internalReadRoots: [spillDir] }), async () => model as any,
    );
    collect(session);
    await session.send('go');
    expect(askUser).toHaveBeenCalledTimes(1);   // sibling directory outside the exempted root still forces an ask
  });

  // Task 6 review fix 4: Task's permission subject became a CHARTER-SCOPED
  // consent key (`${charter}:${work_dir}`, tools/task.ts) rather than a bare
  // path — so 'Task' had to join NON_PATH_SUBJECT_TOOLS (Bash/Skill's set)
  // alongside that change, or checkPathGuard would try to canonicalize the
  // charter prefix AS a path. Pinned indirectly (the set itself isn't
  // exported): a subject shaped like a charter-scoped key that ALSO happens to
  // look like a path outside cwd would force the 'external directory' ask
  // above if Task were still running through the path guard — this proves it
  // isn't, mirroring the sibling test one case up.
  // Task 4 (plan 1c): syncTaskTool now rebuilds 'Task' from the roster
  // UNCONDITIONALLY every turn (no has()-guard), so a fake tool injected
  // under the name 'Task' via opts.tools no longer survives past the first
  // buildAiTools() call — the REAL createTaskTool() output takes its place,
  // same as production. This test now drives THAT real tool (profile.canDelegate
  // defaults to true — CLOUD_DEFAULT) with an absolute work_dir chosen to
  // reproduce the exact subject the old fake hardcoded ('read-write:/etc/x' —
  // 'worker' is read-write). NOTE: this comment used to continue "and '/etc/x'
  // is already absolute, so resolveP returns it unchanged regardless of cwd",
  // which is a POSIX-only claim stated as a universal one — on Windows
  // path.resolve('/etc/x') attaches the current drive and yields 'D:/etc/x', so
  // the hardcoded expectation below was red on that CI leg. It is now computed
  // the same way the tool computes it — resolved against FAKE_SESSION_CWD
  // ('C:/x'), which is the session's cwd and therefore the base resolveP uses.
  // Resolving against process.cwd() instead was still wrong on Windows: it
  // picked up the RUNNER's drive ('D:/etc/x') while the session produced
  // 'C:/etc/x'.
  it('tool-layer guard: Task is exempt (NON_PATH_SUBJECT_TOOLS) — its subject is a consent key, not a path', async () => {
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Task', { agent: 'worker', work_dir: '/etc/x' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ decide, askUser }), async () => model as any);
    collect(session);
    await session.send('go');
    // Consulted DIRECTLY (never short-circuited to a forced ask) — the guard
    // never ran checkPathGuard against "read-write:/etc/x" as though it were
    // an absolute path outside C:/x.
    expect(decide).toHaveBeenCalledWith('Task', `read-write:${path.resolve(FAKE_SESSION_CWD, '/etc/x').replace(/\\/g, '/')}`);
    expect(askUser).not.toHaveBeenCalled();
  });

  // Phase 3 of the permissions-management plan (spec 2026-08-11, finding 3).
  // An external-directory path forces the ask AND skips decide() on every future
  // call, so a rule remembered here could never be consulted — storing one tells
  // the user "you won't be asked again" and then asks them every single time.
  describe('"Always allow" on an external-directory ask', () => {
    // permissionSubject returns the raw path so checkPathGuard sees it; cwd is
    // C:/x (makeOpts), so C:/other/... is external and C:/x/... is not.
    const pathTool = () => fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const oneWriteTo = (filePath: string) => scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: filePath }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);

    it('does not emit remember-rule when an external path forced the ask', async () => {
      const write = pathTool();
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow', always: true }));
      const model = oneWriteTo('C:/other/secrets-elsewhere.ts');
      const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ALLOW, askUser }), async () => model as any);
      const remembered: unknown[] = [];
      session.on('remember-rule', (r) => remembered.push(r));
      collect(session);
      await session.send('go');
      expect(askUser).toHaveBeenCalledTimes(1);            // the ask still happens
      expect(remembered).toEqual([]);                      // …but nothing is persisted
    });

    it('marks an external-directory ask so the UI can suppress Always-allow', async () => {
      const write = pathTool();
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
      const model = oneWriteTo('C:/other/secrets-elsewhere.ts');
      const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ALLOW, askUser }), async () => model as any);
      collect(session);
      await session.send('go');
      expect(askUser.mock.calls[0][0]).toMatchObject({ external: true });
    });

    // The control: an in-project ask still records the rule, and is NOT flagged
    // external — without this, deleting the emit entirely would pass the test above.
    it('still remembers a rule for an in-project ask, and does not flag it external', async () => {
      const write = pathTool();
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow', always: true }));
      const model = oneWriteTo('C:/x/in-project.ts');
      const session = new HarnessSession(
        makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }),
        async () => model as any,
      );
      const remembered: unknown[] = [];
      session.on('remember-rule', (r) => remembered.push(r));
      collect(session);
      await session.send('go');
      // match:'exact' — a file path containing '*' was a wildcard grant on this
      // exact code path until M5 2c.
      expect(remembered).toEqual([{ tool: 'Write', pattern: 'C:/x/in-project.ts', action: 'allow', match: 'exact' }]);
      expect(askUser.mock.calls[0][0].external).toBe(false);
    });
  });

  // M5 2c: the RENDERER never names a pattern — it sends a width selector and the
  // session re-derives from the tool call it already holds. A renderer that could
  // name its own pattern could grant itself anything, because remembered rules are
  // the final precedence layer, above the destructive deny-list.
  describe('"Always allow" derives the rule it stores', () => {
    const bashTool = () => fakeTool('Bash', {
      schema: z.object({ command: z.string() }),
      permissionSubject: (a: any) => a.command,
    });
    const oneBash = (command: string) => scriptedModel([
      stream(toolCallChunk('c1', 'Bash', { command }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);

    /** Drive one gated Bash call answered with "Always allow" at `grantScope`. */
    async function rulesFor(command: string, grantScope?: 'exact' | 'wide'): Promise<unknown[]> {
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow', always: true, grantScope }));
      const session = new HarnessSession(
        makeOpts({
          tools: [bashTool()],
          decide: async () => ({ action: 'ask', denyListed: false }) as PermissionDecision,
          askUser,
        }),
        async () => oneBash(command) as any,
      );
      const remembered: unknown[] = [];
      session.on('remember-rule', (r) => remembered.push(r));
      collect(session);
      await session.send('go');
      return remembered;
    }

    it('an exact grant stores the literal command with match:exact', async () => {
      expect(await rulesFor('rm *.log', 'exact'))
        .toEqual([{ tool: 'Bash', pattern: 'rm *.log', action: 'allow', match: 'exact' }]);
    });

    it('a wide grant stores the DERIVED rule, not the raw command', async () => {
      expect(await rulesFor('git push origin feat/x', 'wide'))
        .toEqual([{ tool: 'Bash', pattern: 'git push*origin feat/x', action: 'allow', match: 'glob' }]);
    });

    it('a renderer asking for "wide" on a command with no wide rung gets the narrow one', async () => {
      expect(await rulesFor('rm -rf build', 'wide'))
        .toEqual([{ tool: 'Bash', pattern: 'rm -rf build', action: 'allow', match: 'exact' }]);
    });

    it('a renderer asking for "wide" on a WITHHELD rung gets the narrow one', async () => {
      // 'Any git command' is withheld because it would cover pushes and resets.
      expect(await rulesFor('git --no-pager log', 'wide'))
        .toEqual([{ tool: 'Bash', pattern: 'git --no-pager log', action: 'allow', match: 'exact' }]);
    });

    it('nothing is remembered when the command offers no grant at all', async () => {
      // Bare `git push` sends whatever branch is checked out AT RUN TIME.
      expect(await rulesFor('git push', 'exact')).toEqual([]);
    });

    it('a missing selector is treated as the narrowest option', async () => {
      expect(await rulesFor('npm run build', undefined))
        .toEqual([{ tool: 'Bash', pattern: 'npm run build', action: 'allow', match: 'exact' }]);
    });
  });

  // Fix (Critical 1, final review): a Task task_id call (steer/resume/interrupt
  // an EXISTING specialist) omits work_dir entirely, so permissionSubject
  // returns undefined for it — the SAME shape as a genuinely subject-less tool
  // (TodoWrite). Before this fix rememberedRuleFor treated undefined subject as
  // "tool has no meaningful subject, so remember tool-wide" for EVERY tool,
  // which was safe when Task always had a `${charter}:${work_dir}` subject
  // (work_dir was required) but became a hole once task_id calls made work_dir
  // optional: an "Always allow" on a task_id management call would persist a
  // pattern-less `{tool:'Task', action:'allow'}` rule that then silently
  // pre-approves EVERY future Task call, including a brand-new read-write spawn
  // at any directory. Task must never mint a tool-wide rule — mirrors the
  // existing "no grant possible" precedent for a Bash command with no safe
  // width (rulesFor('git push', ...) above).
  it('never remembers a tool-wide rule for a Task call with no subject (task_id management)', async () => {
    const task = fakeTool('Task', { permissionSubject: () => undefined, schema: z.object({ task_id: z.string() }) });
    const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow', always: true }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Task', { task_id: 'abc' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(
      makeOpts({ tools: [task], decide: async () => ({ action: 'ask', denyListed: false }) as PermissionDecision, askUser }),
      async () => model as any,
    );
    const remembered: unknown[] = [];
    session.on('remember-rule', (r) => remembered.push(r));
    collect(session);
    await session.send('go');
    expect(askUser).toHaveBeenCalledTimes(1);   // the one-time approval still happens
    expect(remembered).toEqual([]);              // …but nothing tool-wide is ever persisted
  });

  it('tool-layer guard: a secret path hard-denies BEFORE any permission consultation', async () => {
    // C:/x/.env is a dotenv file → isSensitivePath → checkPathGuard 'deny'.
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'C:/x/.env' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [write], decide, askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/blocked/i);
    expect(decide).not.toHaveBeenCalled();               // guard precedes configuration
    expect(askUser).not.toHaveBeenCalled();
    expect((write as any).calls).toHaveLength(0);         // never executed
  });

  it('CRITICAL regression: a canceled ask back-fills tool-results so the NEXT send ships valid history', async () => {
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),  // turn 1 step 1
      stream(...textChunks('b', 'ok'), finishChunk('stop')),                                    // turn 2 step 1
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    // A synthesized canceled tool-result was emitted (transcript agrees with history).
    const synth = events.find((e) => e.type === 'tool-result' && e.data.toolResult === 'Canceled: the user interrupted this action.');
    expect(synth).toBeTruthy();
    expect(synth!.data.isError).toBe(true);
    expect(synth!.data.toolUseId).toBe('c1');

    // History-shape invariant: NO assistant tool-call without a following tool
    // message carrying a matching toolCallId (a dangling tool_call → provider 400).
    const history = (session as any).history as any[];
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of history) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part?.type === 'tool-call') callIds.add(part.toolCallId);
        if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
      }
    }
    expect(callIds.size).toBeGreaterThan(0);
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);

    // And the follow-up turn must complete cleanly on that valid history.
    await session.send('again');
    expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(1);
  });

  it('absent askUser on an ask decision → decline RESULT (config error), not an interrupt', async () => {
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    // decide → ask, but NO askUser handler wired.
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }) }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/No approval handler is wired/);
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(false);   // NOT masqueraded as a cancel
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);     // loop continues
    expect((write as any).calls).toHaveLength(0);
  });

  describe('interactive tools (AskUserQuestion)', () => {
    // A minimal interactive fake matching the AskUserQuestion contract the driver
    // reads: interactive:true, a questions schema, no permission subject. execute
    // RECORDS so we can prove it is never reached.
    function fakeInteractive(over: Partial<NativeTool> & { schema?: z.ZodType } = {}): NativeTool {
      const calls: any[] = [];
      const t: NativeTool = {
        name: 'AskUserQuestion',
        description: 'ask',
        inputSchema: over.schema ?? z.object({
          questions: z.array(z.object({
            question: z.string().min(1),
            header: z.string().min(1).max(12),
            options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(2).max(4),
            multiSelect: z.boolean(),
          })).min(1).max(4),
        }),
        permissionSubject: () => undefined,
        interactive: true,
        async execute(args) { calls.push(args); return { text: 'execute reached' }; },
      };
      (t as any).calls = calls;
      return t;
    }
    const oneQuestion = () => ({
      questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] }],
    });

    it('routes to askUser, skips decide, returns formatted answers; call/result pair recorded; turn ends', async () => {
      const ask = fakeInteractive();
      const decide = vi.fn(async () => ALLOW);
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({
        behavior: 'allow', updatedInput: { questions: [], answers: { 'Which color?': 'Blue' } },
      }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', oneQuestion()), finishChunk('tool-calls')),
        stream(...textChunks('b', 'thanks'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');

      expect(askUser).toHaveBeenCalledTimes(1);
      expect(askUser.mock.calls[0][0].toolName).toBe('AskUserQuestion');
      expect(decide).not.toHaveBeenCalled();          // interactive skips decide
      expect((ask as any).calls).toHaveLength(0);      // execute() never reached
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBeFalsy();
      expect(res.data.toolResult).toContain('Blue');
      expect(res.data.toolResult).toContain('Which color?');
      // call/result pair present in history.
      const history = (session as any).history as any[];
      const callIds = new Set<string>(); const resultIds = new Set<string>();
      for (const m of history) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (part?.type === 'tool-call') callIds.add(part.toolCallId);
          if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
        }
      }
      expect(callIds.has('c1')).toBe(true);
      expect(resultIds.has('c1')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(true);   // turn ended
    });

    it('deny (dismissal) → records the result, ends the turn as question_dismissed, takes NO further step', async () => {
      const ask = fakeInteractive();
      // `dismissed` is what PermissionBroker.respond stamps on a HUMAN "no" —
      // the flag that separates a person closing the card from a policy refusal.
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'deny', dismissed: true }));
      const seen: any[] = [];
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', oneQuestion()), finishChunk('tool-calls')),
        // If the loop wrongly continued it would consume this second step and
        // emit its text — which is exactly the guessing behavior this change removes.
        stream(...textChunks('b', 'GUESSED ANYWAY'), finishChunk('stop')),
      ], seen);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');

      // The dismissal is a REAL tool result on the real call id — pairing holds.
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.toolUseId).toBe('c1');
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toBe('The user closed this question without answering and took over. Stop here and wait for their next message.');
      // The loop STOPPED: the model was consulted exactly once.
      expect(seen).toHaveLength(1);
      expect(events.some((e) => e.type === 'assistant-text' && e.data.text === 'GUESSED ANYWAY')).toBe(false);
      // ORDERLY end — turn-complete with the new reason, never a user-interrupt.
      const done = events.find((e) => e.type === 'turn-complete')!;
      expect(done.data.stopReason).toBe('question_dismissed');
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(false);
    });

    it('multi-call step, dismissal on the FIRST call → sibling marked not-run, both paired, turn ends', async () => {
      // A step with two tool-calls where the first is the question. The sibling
      // must still get a tool-result or it dangles → provider 400 on the next
      // send. It must NOT get the interrupt copy: the user did not interrupt.
      const ask = fakeInteractive();
      const read = fakeTool('Read');
      const askUser = async (): Promise<AskDecision> => ({ behavior: 'deny', dismissed: true });
      const model = scriptedModel([
        stream(
          toolCallChunk('c1', 'AskUserQuestion', oneQuestion()),
          toolCallChunk('c2', 'Read', { file_path: 'x.ts' }),
          finishChunk('tool-calls'),
        ),
        stream(...textChunks('b', 'unreached'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask, read], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');

      const results = events.filter((e) => e.type === 'tool-result');
      expect(results.map((e) => e.data.toolUseId)).toEqual(['c1', 'c2']);
      expect(results[1].data.toolResult).toBe('Not run: the turn ended when the user closed the question.');
      expect(results[1].data.toolResult).not.toMatch(/interrupted/i);
      expect(results[1].data.isError).toBe(true);
      expect((read as any).calls).toHaveLength(0);   // sibling never executed

      // Pairing invariant: every tool-call in history has a matching tool-result.
      const history = (session as any).history as any[];
      const callIds = new Set<string>(); const resultIds = new Set<string>();
      for (const m of history) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (part?.type === 'tool-call') callIds.add(part.toolCallId);
          if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
        }
      }
      expect([...callIds].sort()).toEqual(['c1', 'c2']);
      expect([...resultIds].sort()).toEqual(['c1', 'c2']);
      expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('question_dismissed');
    });

    it('POLICY deny (no `dismissed`) → corrective text and the loop CONTINUES', async () => {
      // The discrimination test for the whole feature. Two askUser
      // implementations have no human behind them — childAskPolicy() and the
      // harness evaluator's fixture jail — and for both, deny means "you may not
      // ask, carry on and finish". The evaluator's wrap-up turn REQUIRES this:
      // it denies AskUserQuestion so the model answers instead, and ending the
      // turn there loses the review outright.
      const ask = fakeInteractive();
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'deny' }));
      const seen: any[] = [];
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', oneQuestion()), finishChunk('tool-calls')),
        stream(...textChunks('b', 'fine, here is the answer'), finishChunk('stop')),
      ], seen);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');

      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/without answering/i);
      // The loop CONTINUED: the model was consulted twice and produced its answer.
      expect(seen).toHaveLength(2);
      expect(events.some((e) => e.type === 'assistant-text' && e.data.text === 'fine, here is the answer')).toBe(true);
      // A normal completion — NOT the dismissal reason.
      expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).not.toBe('question_dismissed');
    });

    it('canceled (interrupt) → back-filled canceled result + user-interrupt, no turn-complete', async () => {
      const ask = fakeInteractive();
      const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', oneQuestion()), finishChunk('tool-calls')),
        stream(...textChunks('b', 'unreached'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      // Same unwind as a canceled permission ask: back-filled canceled tool-result + user-interrupt.
      const synth = events.find((e) => e.type === 'tool-result' && e.data.toolResult === 'Canceled: the user interrupted this action.');
      expect(synth).toBeTruthy();
      expect(synth!.data.toolUseId).toBe('c1');
      expect(synth!.data.isError).toBe(true);
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
    });

    it('multi-call step, interactive cancel on the FIRST call → BOTH calls back-filled canceled + user-interrupt', async () => {
      // A step with two tool-calls; the first is AskUserQuestion and its ask is
      // canceled. The unwind must back-fill canceled results for the AskUserQuestion
      // AND the still-un-executed second call (the "this call AND every remaining
      // call in the step" invariant), else the second tool-call dangles → 400.
      const ask = fakeInteractive();
      const read = fakeTool('Read');
      const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
      const model = scriptedModel([
        stream(
          toolCallChunk('c1', 'AskUserQuestion', oneQuestion()),
          toolCallChunk('c2', 'Read', { file_path: 'x.ts' }),
          finishChunk('tool-calls'),
        ),
        stream(...textChunks('b', 'unreached'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask, read], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      // BOTH calls get a back-filled canceled tool-result.
      const canceled = events.filter((e) => e.type === 'tool-result' && e.data.toolResult === 'Canceled: the user interrupted this action.');
      expect(canceled.map((e) => e.data.toolUseId).sort()).toEqual(['c1', 'c2']);
      expect(canceled.every((e) => e.data.isError === true)).toBe(true);
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
      expect((read as any).calls).toHaveLength(0);   // second call never executed
      // Pairing invariant: every tool-call in history has a matching tool-result.
      const history = (session as any).history as any[];
      const callIds = new Set<string>(); const resultIds = new Set<string>();
      for (const m of history) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (part?.type === 'tool-call') callIds.add(part.toolCallId);
          if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
        }
      }
      for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    });

    it('invalid questions shape → corrective validation result; askUser NOT called', async () => {
      const ask = fakeInteractive();
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', { questions: [] }), finishChunk('tool-calls')),  // zero questions
        stream(...textChunks('b', 'fixed'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/Invalid arguments/);
      expect(askUser).not.toHaveBeenCalled();          // validation precedes the interactive ask
    });
  });

  it('no tools configured (tools absent) → v0 plain-text turn; no tool plumbing invoked', async () => {
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([stream(...textChunks('a', 'Hi there'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({ decide, askUser }), async () => model as any); // no `tools`
    const events = collect(session);
    await session.send('hi');
    expect(types(events)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect(events.some((e) => e.type === 'tool-use')).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(askUser).not.toHaveBeenCalled();
  });

  it('emits a toolPreparing heartbeat at tool-input-start, before the tool-call completes', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(
        ...toolInputChunks('c1', 'Read', '{"file_path":', '"x.ts"}'),
        toolCallChunk('c1', 'Read', { file_path: 'x.ts' }),
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('b', 'Done.'), finishChunk('stop')),
    ]);
    const session = makeSession({ model, tools: [read], decide: async () => ALLOW });
    const events = collect(session);
    await drainTurn(session, 'go');

    const prep = events.filter((e) => e.data?.toolPreparing);
    // The FIRST preparing event must precede the tool-use card entirely.
    expect(prep.length).toBeGreaterThan(0);
    expect(prep[0].type).toBe('assistant-thinking');
    expect(prep[0].data.toolPreparing).toMatchObject({ toolCallId: 'c1', toolName: 'Read', chars: 0 });
    expect(events.indexOf(prep[0])).toBeLessThan(events.findIndex((e) => e.type === 'tool-use'));
  });

  it('preparing heartbeats carry no text and no partId, so SessionStore drops them', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(
        ...toolInputChunks('c1', 'Read', '{"file_path":"x.ts"}'),
        toolCallChunk('c1', 'Read', { file_path: 'x.ts' }),
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('b', 'Done.'), finishChunk('stop')),
    ]);
    const session = makeSession({ model, tools: [read], decide: async () => ALLOW });
    const events = collect(session);
    await drainTurn(session, 'go');

    for (const e of events.filter((ev) => ev.data?.toolPreparing)) {
      expect(e.data.text).toBeUndefined();
      expect(e.data.partId).toBeUndefined();
    }
  });

  it('throttles argument-progress emits to one per TOOL_PREPARING_EMIT_MS per call', async () => {
    // 40 deltas arrive back-to-back within one tick. Unthrottled that is 41
    // events; throttled it is the unconditional start plus at most a couple of
    // window crossings. Asserting "far fewer than the delta count" pins the
    // throttle without pinning wall-clock timing, which is flaky in CI.
    const read = fakeTool('Read');
    const deltas = Array.from({ length: 40 }, (_, i) => `chunk${i}`);
    const model = scriptedModel([
      stream(
        ...toolInputChunks('c1', 'Read', ...deltas),
        toolCallChunk('c1', 'Read', { file_path: 'x.ts' }),
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('b', 'Done.'), finishChunk('stop')),
    ]);
    const session = makeSession({ model, tools: [read], decide: async () => ALLOW });
    const events = collect(session);
    await drainTurn(session, 'go');

    const prep = events.filter((e) => e.data?.toolPreparing);
    expect(prep.length).toBeLessThan(10);
    expect(prep.length).toBeGreaterThan(0);
  });

  it('tool-input-end emits nothing on its own', async () => {
    // The completed tool-call part follows immediately and supersedes the card;
    // an event here would be pure noise on every single tool call.
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(
        { type: 'tool-input-start', id: 'c1', toolName: 'Read' },
        { type: 'tool-input-end', id: 'c1' },
        toolCallChunk('c1', 'Read', { file_path: 'x.ts' }),
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('b', 'Done.'), finishChunk('stop')),
    ]);
    const session = makeSession({ model, tools: [read], decide: async () => ALLOW });
    const events = collect(session);
    await drainTurn(session, 'go');

    expect(events.filter((e) => e.data?.toolPreparing).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tok/s measures GENERATION, not the turn's wall-clock. Found by the 2026-07-28
// audit: `startedAt` is stamped at the top of the turn and the denominator was
// (now - startedAt), so prefill, tool execution and permission waits all diluted
// it. A turn that generated 300 tokens in 10s of decoding but spent 30s in a
// Bash call reported ~7 tok/s instead of ~30.
// ---------------------------------------------------------------------------
describe('turn-complete tokensPerSecond', () => {
  it('excludes time spent OUTSIDE the stream (tool execution)', async () => {
    const slowTool = fakeTool('Read', {
      onExecute: async () => { await new Promise((r) => setTimeout(r, 120)); return { text: 'done' }; },
    });
    const model = scriptedModel([
      stream(...textChunks('a', 'x'.repeat(80)), toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls', 10, 100)),
      stream(...textChunks('b', 'y'.repeat(80)), finishChunk('stop', 10, 100)),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [slowTool], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const usage = events.find((e) => e.type === 'turn-complete')!.data.usage as any;
    // 200 output tokens. The tool alone burned 120ms of wall-clock; if that were
    // in the denominator the rate would be dragged toward ~1,600 tok/s or below.
    // Generation time is a small fraction of the turn, so the rate must be HIGHER
    // than the wall-clock rate would give.
    expect(usage.tokensPerSecond).toBeGreaterThan(0);
    const wallClockRate = 200 / 0.12;   // an upper bound on what wall-clock could yield
    expect(usage.tokensPerSecond).toBeGreaterThan(wallClockRate);
  });

  it('a turn with no output reports 0 rather than dividing by zero', async () => {
    const model = scriptedModel([stream(finishChunk('stop', 10, 0))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const usage = events.find((e) => e.type === 'turn-complete')!.data.usage as any;
    expect(Number.isFinite(usage.tokensPerSecond)).toBe(true);
    expect(usage.tokensPerSecond).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Image tool-results (2026-08-11 spec, Task 5): the driver turns a tool's
// promised image PATHS (ToolResultPayload.images, Task 4) into a canonical
// content-type tool-result output, charging a per-turn budget and deduping
// repeat fetches of an unchanged file — every skip gets a NAMED note in the
// same text the model and transcript both see, so promise and delivery can
// never disagree.
// ---------------------------------------------------------------------------
describe('image tool-results (2026-08-11 spec)', () => {
  // Real files on disk: resolveToolImages calls fs.statSync/readFileSync
  // directly (no injection seam like history-rebuild's fakeReader), so the
  // dedupe/vanish contracts need a real mtime and a real disappearance.
  function tmpImage(dir: string, name: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])); // bytes are arbitrary — readImageFromDisk never decodes
    return p;
  }

  // Fix 7 (2026-08-11 review): every it() below made its own mkdtempSync and
  // never removed it, leaking into os.tmpdir() on every run (one leaves nine
  // files). Track every dir created via mkTmpDir() and sweep them after each
  // test, whether it passed or threw.
  const tmpDirs: string[] = [];
  function mkTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-img-'));
    tmpDirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('a delivered image lands as a content-type output AND its path on the event', async () => {
    const dir = mkTmpDir();
    const imgPath = tmpImage(dir, 'x.png');
    const read = fakeTool('Read', { onExecute: () => ({ text: 'Read image', images: [imgPath] }) });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: imgPath }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    // findLast is ES2023; this file's tsconfig lib target doesn't guarantee it
    // (brief note) — manual reverse-scan via filter().pop() instead.
    const history = (session as any).history as any[];
    const toolMsg = history.filter((m) => m.role === 'tool').pop();
    const output = toolMsg.content[0].output;
    expect(output.type).toBe('content');
    expect(output.value[0]).toEqual({ type: 'text', text: expect.stringContaining('Read image') });
    // filename (Fix 3) is the file's own basename, not the tool's name — this
    // is what lets wire-adapter.ts label a multi-image result with each
    // image's real name instead of N identical "Read" placeholders.
    expect(output.value[1]).toEqual({ type: 'file', mediaType: 'image/png', filename: 'x.png', data: { type: 'data', data: expect.any(Buffer) } });

    const ev = events.find((e) => e.type === 'tool-result');
    expect(ev!.data.images).toEqual([imgPath]);
  });

  it('an unchanged re-fetch is deduped with a named note, no second copy', async () => {
    const dir = mkTmpDir();
    const imgPath = tmpImage(dir, 'x.png');
    const read = fakeTool('Read', { onExecute: () => ({ text: 'Read image', images: [imgPath] }) });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: imgPath }), finishChunk('tool-calls')), // turn 1 step 1
      stream(...textChunks('b', 'done'), finishChunk('stop')),                                                               // turn 1 step 2
      stream(...textChunks('c', 'reading again'), toolCallChunk('c2', 'Read', { file_path: imgPath }), finishChunk('tool-calls')), // turn 2 step 1
      stream(...textChunks('d', 'done again'), finishChunk('stop')),                                                         // turn 2 step 2
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');
    await session.send('go again');   // same unchanged file, requested again in a second turn

    const history = (session as any).history as any[];
    const toolMsgs = history.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    const secondToolMsg = toolMsgs[toolMsgs.length - 1];   // last tool message of turn 2
    expect(secondToolMsg.content[0].output.type).toBe('text');   // deduped → no second image, stays text-only
    expect(secondToolMsg.content[0].output.value).toContain('already visible earlier');
  });

  it('the per-turn image count budget skips with a named note', async () => {
    const dir = mkTmpDir();
    // MAX_IMAGES_PER_TURN distinct, never-before-seen images fill the budget
    // exactly; one more in the SAME turn must be skipped with a budget note.
    const paths = Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, (_, i) => tmpImage(dir, `img${i}.png`));
    const read = fakeTool('Read', { onExecute: (args: any) => ({ text: `Read ${args.file_path}`, images: [args.file_path] }) });
    const toolCalls = paths.map((p, i) => toolCallChunk(`c${i}`, 'Read', { file_path: p }));
    const model = scriptedModel([
      stream(...toolCalls, finishChunk('tool-calls')),   // one step, N+1 parallel calls — same turn, shared budget
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');

    const history = (session as any).history as any[];
    const toolMsg = history.filter((m) => m.role === 'tool').pop();
    const lastOutput = toolMsg.content[toolMsg.content.length - 1].output;   // the (N+1)th call's result — the one over budget
    expect(lastOutput.type).toBe('text');   // budget skip → no image attached, stays text-only
    expect(lastOutput.value).toContain('images-per-turn budget');
    // Fix 6 (2026-08-11 review): the assertion above alone would also pass an
    // implementation that skipped EVERY image (not just the over-budget one) —
    // it never checks the calls that were WITHIN budget. Pin that the first
    // MAX_IMAGES_PER_TURN calls really did deliver content.
    const firstOutputs = toolMsg.content.slice(0, MAX_IMAGES_PER_TURN).map((c: any) => c.output);
    expect(firstOutputs.every((o: any) => o.type === 'content')).toBe(true);
  });

  it('a file that vanished between promise and delivery gets a named note, not silence', async () => {
    const dir = mkTmpDir();
    const goneP = path.join(dir, 'gone.png');
    fs.writeFileSync(goneP, Buffer.from([1, 2, 3]));
    // Simulate the tool having stat'd the file before promising it, but the
    // file vanishing before the DRIVER delivers it: delete it inside execute()
    // itself, right before returning the promise — the driver's own
    // fs.statSync (resolveToolImages) then finds nothing.
    const read = fakeTool('Read', {
      onExecute: () => { fs.unlinkSync(goneP); return { text: 'Read image', images: [goneP] }; },
    });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: goneP }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');

    const history = (session as any).history as any[];
    const toolMsg = history.filter((m) => m.role === 'tool').pop();
    const output = toolMsg.content[0].output;
    expect(output.type).toBe('text');   // no image attached
    expect(output.value).toContain('no longer readable');
  });

  // Fix 4 (2026-08-11 review): readImageFromDisk returns null for THREE
  // distinct reasons (undeliverable format, oversized, or a read that threw)
  // that the driver previously collapsed into one guessed "vanished or
  // exceeds the per-image size limit" note — an unverified-cause message this
  // repo's error standard forbids, and this branch had no test coverage at
  // all. Each case below calls resolveToolImages directly (same private-method
  // pattern the byte-budget test already uses) so it can construct the exact
  // filesystem shape that isolates one cause from the other two.
  describe('readImageFromDisk-null skip reasons are named, not guessed (Fix 4)', () => {
    it('an undeliverable format (e.g. .bmp) is named as unsupported', () => {
      const dir = mkTmpDir();
      // deliverableImageMediaType keys off the extension only — a real .bmp
      // file (not in IMAGE_MEDIA_TYPES) exercises this branch with no mocking.
      const imgPath = path.join(dir, 'x.bmp');
      fs.writeFileSync(imgPath, Buffer.from([1, 2, 3]));
      const session = new HarnessSession(makeOpts({ decide: async () => ALLOW }), async () => ({}) as any);
      const result = (session as any).resolveToolImages({ text: 'Read image', images: [imgPath] }, { count: 0, bytes: 0 });
      expect(result.images).toHaveLength(0);
      expect(result.text).toContain('not a deliverable image format');
    });

    it('a file over MAX_ATTACHMENT_BYTES is named with the size limit', () => {
      const dir = mkTmpDir();
      const imgPath = path.join(dir, 'big.png');
      // A sparse file: truncateSync reports the target size in stat() without
      // actually writing MAX_ATTACHMENT_BYTES of real data to disk (avoids the
      // exact ">20 MB of fixture data" cost the byte-budget test above already
      // steers around). readImageFromDisk's own stat check rejects it before
      // ever calling readFileSync, so the hole is never read either.
      fs.closeSync(fs.openSync(imgPath, 'w'));
      fs.truncateSync(imgPath, MAX_ATTACHMENT_BYTES + 1);
      const session = new HarnessSession(makeOpts({ decide: async () => ALLOW }), async () => ({}) as any);
      const result = (session as any).resolveToolImages({ text: 'Read image', images: [imgPath] }, { count: 0, bytes: 0 });
      expect(result.images).toHaveLength(0);
      expect(result.text).toContain('MB per-image size limit');
    });

    it('a read that throws behind a successful stat is named as unreadable, not guessed as vanished', () => {
      const dir = mkTmpDir();
      // A directory named like an image: fs.statSync succeeds (real mtime,
      // small reported size) so it clears both of resolveToolImages' own
      // checks and readImageFromDisk's format/size checks, but
      // fs.readFileSync(directory) throws EISDIR — the one genuine "could not
      // be read" case, isolated from the format and size branches above.
      const dirLikeImage = path.join(dir, 'x.png');
      fs.mkdirSync(dirLikeImage);
      const session = new HarnessSession(makeOpts({ decide: async () => ALLOW }), async () => ({}) as any);
      const result = (session as any).resolveToolImages({ text: 'Read image', images: [dirLikeImage] }, { count: 0, bytes: 0 });
      expect(result.images).toHaveLength(0);
      expect(result.text).toContain('could not be read');
    });
  });

  // The count budget (tested above) and the byte budget are two DISTINCT `if`
  // branches in resolveToolImages — a passing count-budget test gives zero
  // coverage of the byte one. Driving it through a full turn would mean
  // writing >20 MB of fixture images to disk per run; instead this calls the
  // private method directly (same pattern this file already uses for
  // `(session as any).history`) with the budget pre-loaded to just under the
  // cap, so one small image is enough to tip it over.
  it('the per-turn image byte budget skips with a named note, independent of the count budget', () => {
    const dir = mkTmpDir();
    const imgPath = tmpImage(dir, 'x.png');
    const fileSize = fs.statSync(imgPath).size;
    const session = new HarnessSession(makeOpts({ decide: async () => ALLOW }), async () => ({}) as any);
    const budget = { count: 0, bytes: MAX_IMAGE_BYTES_PER_TURN - fileSize + 1 };   // one byte short of room for this file
    const result = (session as any).resolveToolImages({ text: 'Read image', images: [imgPath] }, budget);
    expect(result.images).toHaveLength(0);
    expect(result.text).toContain('MB-per-turn image budget');
  });

  // Fix 5 (2026-08-11 review): the test above pre-loads budget.bytes and only
  // ever asserts the GUARD fires — it gives zero coverage of the accumulation
  // itself (`budget.bytes += img.data.length`). Deleting that line leaves
  // every other test in this file passing, because the count-budget test only
  // pins budget.count. Assert the accumulation directly, starting from an
  // empty budget.
  it('a delivered image adds its real byte length to the shared budget', () => {
    const dir = mkTmpDir();
    const imgPath = tmpImage(dir, 'x.png');
    const fileSize = fs.statSync(imgPath).size;
    const session = new HarnessSession(makeOpts({ decide: async () => ALLOW }), async () => ({}) as any);
    const budget = { count: 0, bytes: 0 };
    const result = (session as any).resolveToolImages({ text: 'Read image', images: [imgPath] }, budget);
    expect(result.images).toHaveLength(1);
    expect(budget.bytes).toBe(fileSize);
    expect(budget.count).toBe(1);
  });
});

// Fixes 1 (CRITICAL) and 2 (2026-08-11 review): shownImages must not outlive
// the history it vouches for. /clear (Fix 1) and compaction's summarize step
// (Fix 2, both the automatic maybeCompact and the manual compactNow) each
// discard part or all of model history — an un-cleared cache then answers
// "already visible earlier in this conversation" for an image that is no
// longer there, which is both a permanent non-delivery AND a false claim.
describe('shown-image cache reset on history-discarding events (Fixes 1 & 2, 2026-08-11 review)', () => {
  function tmpImage(dir: string, name: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    return p;
  }
  const tmpDirs: string[] = [];
  function mkTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-img-clear-'));
    tmpDirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('Fix 1: /clear resets the dedupe cache — a re-Read of the same unchanged file after /clear delivers again, not "already visible"', async () => {
    const dir = mkTmpDir();
    const imgPath = tmpImage(dir, 'x.png');
    const read = fakeTool('Read', { onExecute: () => ({ text: 'Read image', images: [imgPath] }) });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: imgPath }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
      stream(...textChunks('c', 'reading again'), toolCallChunk('c2', 'Read', { file_path: imgPath }), finishChunk('tool-calls')),
      stream(...textChunks('d', 'done again'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    await session.send('go');
    expect((session as any).shownImages.has(imgPath)).toBe(true);   // sanity: the first delivery actually populated the cache

    const cleared = session.clearHistory();
    expect(cleared).toEqual({ ok: true });

    await session.send('go again');   // same unchanged file, requested again after /clear

    const history = (session as any).history as any[];
    const toolMsg = history.filter((m) => m.role === 'tool').pop();
    const output = toolMsg.content[0].output;
    // The image really is gone from history after /clear (rebuildHistory
    // treats context-clear as a hard barrier), so a re-Read must deliver a
    // REAL image again — the dedupe note would be a FALSE "already visible".
    expect(output.type).toBe('content');
    expect(output.value[1]).toEqual({ type: 'file', mediaType: 'image/png', filename: 'x.png', data: { type: 'data', data: expect.any(Buffer) } });
  });

  it('Fix 2: automatic compaction (maybeCompact) resets the dedupe cache along with the summarized span', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ text: 'SUMMARY: user wants X; did Y.' }, { text: 'here is the answer' }]),
    });
    // Seed the cache as if an image had been delivered earlier in the
    // (about to be summarized) history — resolveToolImages itself is not
    // exercised here; this isolates the cache-reset behavior maybeCompact
    // owns from the delivery path already covered above.
    (session as any).shownImages.set('/fake/already-shown.png', 111);
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);   // sanity: summarize actually fired
    expect((session as any).shownImages.size).toBe(0);
  });

  it('Fix 2: manual compaction (compactNow) resets the dedupe cache along with the discarded span', async () => {
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'SUMMARY: ok' }]) });
    // At least 2 user-delimited turns so summarizeCutIndex() finds a
    // condensable span (compactNow has no MIN_SUMMARIZE_SPAN thrash guard, so
    // small content is enough — unlike the maybeCompact test above).
    session.seedHistory([
      { role: 'assistant', content: 'a1' } as any,
      { role: 'user', content: 'u1' } as any,
      { role: 'assistant', content: 'a2' } as any,
      { role: 'user', content: 'u2' } as any,
    ]);
    (session as any).shownImages.set('/fake/already-shown.png', 111);
    const result = await session.compactNow();
    expect(result).toEqual({ ok: true });
    expect((session as any).shownImages.size).toBe(0);
  });
});

// Task 3: postSteer — mid-run course corrections drained at turn-loop
// iteration boundaries, never mid-step (a tool call is never cut).
describe('HarnessSession — postSteer', () => {
  it('postSteer lands as a user-role message before the NEXT model step, never mid-step', async () => {
    const seen: any[] = [];
    let session!: HarnessSession;
    // Hook mid-STEP-1 tool execution — the earliest a caller could plausibly
    // course-correct a running child. postSteer must report success (a turn
    // IS in flight) but must not be visible in step 1's request, since that
    // request was already sent before the tool ran.
    const read = fakeTool('Read', {
      onExecute: async () => {
        expect(session.postSteer('focus on X')).toBe(true);
        return { text: 'Read ran' };
      },
    });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    // Step 1's request predates the steer — it can't be in there.
    expect(JSON.stringify(seen[0])).not.toContain('<steer>');
    // Step 2's request has it, positioned AFTER step 1's tool result — proof
    // it landed at the iteration boundary, not mid-step.
    const p2 = JSON.stringify(seen[1]);
    expect(p2).toContain('<steer>');
    expect(p2).toContain('focus on X');
    expect(p2.indexOf('Read ran')).toBeLessThan(p2.indexOf('<steer>'));
    // History-only, like injectPathTriggers: no new transcript event type, and
    // nothing on the existing events references it — the frozen emit surface
    // is untouched.
    expect(JSON.stringify(events)).not.toContain('<steer>');
  });

  it('postSteer with no turn in flight returns false and injects nothing', () => {
    const session = new HarnessSession(
      makeOpts({ decide: async () => ALLOW }),
      async () => { throw new Error('model factory should not be called — no turn is ever started'); },
    );
    expect(session.postSteer('late note')).toBe(false);
    expect((session as any).history).toHaveLength(0);
    expect(session.drainUnappliedSteers()).toEqual([]);
  });

  it('a steer posted during the FINAL step never lands — drainUnappliedSteers returns it after the turn', async () => {
    const read = fakeTool('Read');
    const seen: any[] = [];
    let session!: HarnessSession;
    let call = 0;
    // Custom model (not scriptedModel): the side effect must fire from INSIDE
    // doStream for the second, LAST step (a plain-text end) — after that
    // iteration's steer-drain check has already run and with no further
    // iteration for a freshly-posted steer to land in.
    const model = new MockLanguageModelV4({
      doStream: async (req: any) => {
        seen.push(req.prompt);
        call++;
        if (call === 2) {
          expect(session.postSteer('the steer')).toBe(true);
        }
        const chunks = call === 1
          ? stream(toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls'))
          : stream(...textChunks('t2', 'done'), finishChunk('stop'));
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    await session.send('go');

    expect(session.drainUnappliedSteers()).toEqual(['the steer']);
    // Never reached any model request, nor persisted history.
    expect(seen.some((p) => JSON.stringify(p).includes('<steer>'))).toBe(false);
    expect(JSON.stringify((session as any).history)).not.toContain('<steer>');
    // Draining empties the queue.
    expect(session.drainUnappliedSteers()).toEqual([]);
  });
});

describe('HarnessSession — specialist status block (Task 5, MOIM pattern)', () => {
  it('a non-null specialistStatus is injected before the user message, and a null one REMOVES the stale block', async () => {
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...textChunks('a', 'ok'), finishChunk('stop')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ], seen);
    // Turn 1: a specialist is running. Turn 2: nothing left to report.
    const statuses = ['Nadia (researcher): running — step 3, 12s', null];
    let call = 0;
    const session = new HarnessSession(
      makeOpts({ decide: async () => ALLOW, specialistStatus: () => statuses[call++] }),
      async () => model as any,
    );
    await session.send('go');
    await session.send('again');

    // Turn 1's request carries the status block, positioned BEFORE the typed
    // user text — the model reads "here's what's running" before "here's what
    // you asked".
    const p1 = JSON.stringify(seen[0]);
    expect(p1).toContain('<specialists-status>');
    expect(p1.indexOf('<specialists-status>')).toBeLessThan(p1.indexOf('go'));

    // Turn 2's specialistStatus returned null — the block from turn 1 must be
    // GONE, not merely un-added-to.
    const p2 = JSON.stringify(seen[1]);
    expect(p2).not.toContain('<specialists-status>');
  });

  it('exactly ONE status block ever lives in history — turn N replaces turn N-1', async () => {
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...textChunks('a', 'ok'), finishChunk('stop')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ], seen);
    const statuses = ['Nadia (researcher): running — step 1, 5s', 'Nadia (researcher): running — step 3, 40s'];
    let call = 0;
    const session = new HarnessSession(
      makeOpts({ decide: async () => ALLOW, specialistStatus: () => statuses[call++] }),
      async () => model as any,
    );
    await session.send('go');
    await session.send('again');

    const p2 = JSON.stringify(seen[1]);
    const blockCount = (p2.match(/<specialists-status>/g) ?? []).length;
    expect(blockCount).toBe(1);
    expect(p2).toContain('step 3');
    expect(p2).not.toContain('step 1');
  });

  // Fix pass, Finding 4: opts.specialistStatus?.() runs in beginTurn AFTER
  // emit() (the user-message transcript event has already fired) but BEFORE
  // this.abort is set. The real callback reaches NativeHome.readJson, which
  // deliberately RETHROWS any non-ENOENT I/O error (permissions, disk full,
  // AV lock) — an uncaught throw here would escape beginTurn entirely: no
  // assistant reply, no error surfaced, and the re-entrancy guard (this.abort)
  // never gets set, stranding the session on every future send(). Pin that a
  // throwing callback degrades to "no status block" instead.
  it('a specialistStatus callback that throws degrades to no status block instead of stranding the turn', async () => {
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...textChunks('a', 'ok'), finishChunk('stop')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(
      makeOpts({
        decide: async () => ALLOW,
        specialistStatus: () => { throw new Error('EACCES: permission denied'); },
      }),
      async () => model as any,
    );

    // Must not throw / must not hang — the turn completes normally.
    await expect(session.send('go')).resolves.toBeUndefined();

    // No status block was injected — the callback never produced a value.
    expect(JSON.stringify(seen[0])).not.toContain('<specialists-status>');

    // Re-entrancy guard cleared: a second turn on the same session still
    // works (this.abort was set and released normally by the first turn).
    await expect(session.send('again')).resolves.toBeUndefined();
    expect(seen.length).toBe(2);
  });

  // Fix pass, Finding 6: a session that never delegates (opts.specialistStatus
  // stays undefined — true for every specialist child, and any root session
  // wire() never touched) must pay literally nothing for this feature, not
  // just "no history mutation" but no scan of history at all.
  //
  // Final-review fix (Finding 5): the ORIGINAL version of this test only
  // asserted `expect(spy).not.toHaveBeenCalled()` for the UNWIRED session —
  // an assertion that also passes if the whole guarded-scan feature were
  // deleted outright (no specialistStatus handling anywhere in beginTurn),
  // since then findIndex would never be called for ANY session, wired or
  // not. Added a positive control: a second, WIRED session (specialistStatus
  // present) must still call findIndex — proving the "zero cost when unwired"
  // claim is actually the guard skipping REAL work, not the absence of the
  // feature entirely. A regression that deletes the whole
  // `if (this.opts.specialistStatus) { ... }` block now fails the wired
  // assertion below instead of passing both.
  it('a session with no specialistStatus wired never scans history for a status block (Finding 6: zero cost)', async () => {
    const model = scriptedModel([stream(...textChunks('a', 'ok'), finishChunk('stop'))], []);
    const session = new HarnessSession(makeOpts({ decide: async () => ALLOW }), async () => model as any);
    const historyRef = (session as any).history;
    const spy = vi.spyOn(historyRef, 'findIndex');

    await session.send('go');

    expect(spy).not.toHaveBeenCalled();

    // Positive control: an otherwise-identical WIRED session DOES scan —
    // same model script, same decide, only specialistStatus differs.
    const wiredModel = scriptedModel([stream(...textChunks('a', 'ok'), finishChunk('stop'))], []);
    const wiredSession = new HarnessSession(
      makeOpts({ decide: async () => ALLOW, specialistStatus: () => null }),
      async () => wiredModel as any,
    );
    const wiredHistoryRef = (wiredSession as any).history;
    const wiredSpy = vi.spyOn(wiredHistoryRef, 'findIndex');

    await wiredSession.send('go');

    expect(wiredSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 14 — ModelSearch attaches/detaches under the IDENTICAL gate as Task
// (syncTaskTool in harness-session.ts runs both add-or-withhold decisions
// together): profile.canDelegate AND !isSpecialistChild. It never attaches
// alone — a session that cannot delegate has nothing for it to name a model
// FOR. Mirrors skill-tool-gating.test.ts's Task ON/OFF pattern.
// ---------------------------------------------------------------------------
describe('ModelSearch attachment mirrors Task\'s gate (Task 14)', () => {
  const toolNames = (s: HarnessSession) => Object.keys((s as any).buildAiTools());

  it('canDelegate: true attaches BOTH Task and ModelSearch', () => {
    const s = new HarnessSession(
      makeOpts({ profile: { ...CLOUD_DEFAULT, canDelegate: true } }),
      async () => ({} as any),
    );
    expect(toolNames(s)).toContain('Task');
    expect(toolNames(s)).toContain('ModelSearch');
  });

  it('canDelegate: false withholds BOTH', () => {
    const s = new HarnessSession(
      makeOpts({ profile: { ...CLOUD_DEFAULT, canDelegate: false } }),
      async () => ({} as any),
    );
    expect(toolNames(s)).not.toContain('Task');
    expect(toolNames(s)).not.toContain('ModelSearch');
  });

  it('canDelegate: true but isSpecialistChild: true STILL withholds both (depth-1 guard)', () => {
    const s = new HarnessSession(
      makeOpts({ profile: { ...CLOUD_DEFAULT, canDelegate: true }, isSpecialistChild: true }),
      async () => ({} as any),
    );
    expect(toolNames(s)).not.toContain('Task');
    expect(toolNames(s)).not.toContain('ModelSearch');
  });

  it('a model swap re-gates ModelSearch exactly like Task', () => {
    const s = new HarnessSession(
      makeOpts({ profile: { ...CLOUD_DEFAULT, canDelegate: true } }),
      async () => ({} as any),
    );
    expect(toolNames(s)).toContain('ModelSearch');
    s.setBinding({ providerId: 'local', modelId: 'tiny' }, 8_192, { ...CLOUD_DEFAULT, canDelegate: false });
    expect(toolNames(s)).not.toContain('ModelSearch');
    s.setBinding({ providerId: 'openrouter', modelId: 'big' }, 200_000, { ...CLOUD_DEFAULT, canDelegate: true });
    expect(toolNames(s)).toContain('ModelSearch');
  });
});

// Empty-step recovery (spec: docs/archive/specs/2026-08-21-empty-final-step-
// turn-recovery-design.md, §6). A step with no text and no tool calls that
// claims an orderly finish gets ONE silent re-run; a second consecutive empty
// step ends the turn honestly as 'empty_response'. History must never gain an
// empty assistant message, and usage must bill every attempt.
describe('HarnessSession — empty final step recovery', () => {
  it('case 1: empty final step after a tool result → ONE silent re-run → real content → end_turn', async () => {
    const read = fakeTool('Read');
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(finishChunk('stop')),                                  // the degenerate empty step
      stream(...textChunks('b', 'recovered'), finishChunk('stop')), // the silent re-run's real answer
    ], seen);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(3);   // exactly ONE extra model call
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.stopReason).toBe('end_turn');
    expect(events.filter((e) => e.type === 'assistant-text').map((e) => e.data.text)).toEqual(['reading', 'recovered']);
    // History is exactly user / assistant(text+call) / tool / assistant(text) —
    // the empty step contributed NOTHING (that is what makes the re-run safe).
    const history = (session as any).history as any[];
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(JSON.stringify(history.at(-1))).toContain('recovered');
  });

  it('case 2: empty twice consecutively → empty_response; usage sums BOTH attempts; no empty history', async () => {
    const seen: any[] = [];
    const model = scriptedModel([
      stream(finishChunk('stop', 10, 2)),
      stream(finishChunk('stop', 11, 3)),
    ], seen);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(2);   // bounded: two attempts, never a third
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.stopReason).toBe('empty_response');
    expect(done.data.usage).toMatchObject({ inputTokens: 21, outputTokens: 5 }); // both attempts billed
    // Neither empty step pushed an assistant message.
    expect(((session as any).history as any[]).map((m) => m.role)).toEqual(['user']);
  });

  it('case 3: counter resets on a non-empty step — a later empty step gets its own retry', async () => {
    const read = fakeTool('Read');
    const seen: any[] = [];
    const model = scriptedModel([
      stream(finishChunk('stop')),                                  // empty #1 → retry
      stream(...textChunks('a', 'ok'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')), // real step → counter resets
      stream(finishChunk('stop')),                                  // empty #2 → retry AGAIN (consecutive semantics)
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(4);   // both empties retried — the counter reset in between
    expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('end_turn');
    expect((read as any).calls).toHaveLength(1);
  });

  it('case 4: first-step empty (no tools all turn) → same ladder', async () => {
    const seen: any[] = [];
    const model = scriptedModel([
      stream(finishChunk('stop')),
      stream(...textChunks('a', 'hello'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(2);
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.stopReason).toBe('end_turn');
    expect(events.filter((e) => e.type === 'assistant-text').map((e) => e.data.text)).toEqual(['hello']);
  });

  it('case 5: reasoning-only step is classified empty and retried; history untouched', async () => {
    // StepResult has NO reasoning field (spec §3) — a step that thinks and then
    // stops is loop-indistinguishable from total silence, and BY DESIGN gets the
    // same retry: nothing was pushed to history, so the re-run is history-safe.
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...reasoningChunks('r1', 'pondering'), finishChunk('stop')),
      stream(...textChunks('a', 'answer'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(2);   // retried despite having streamed thinking
    // The thinking WAS emitted to the transcript (stays on screen — accepted cost).
    expect(events.some((e) => e.type === 'assistant-thinking' && e.data.text === 'pondering')).toBe(true);
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.stopReason).toBe('end_turn');
    // History: user + the ONE real assistant answer. The reasoning-only attempt
    // pushed nothing (the push gates on text/toolCalls only).
    const history = (session as any).history as any[];
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(history[1])).toContain('answer');
  });

  it('case 6: empty step with finishReason length → NO retry, ends max_tokens', async () => {
    // The finishReason gate: 'length' means truncation — a retry would hit the
    // same output limit, so today's mapStopReason path must be kept EXACTLY.
    // NOTE: this test passes BEFORE the production change too — it is the
    // regression pin that proves the new code does not widen past the gate.
    const seen: any[] = [];
    const model = scriptedModel([stream(finishChunk('length'))], seen);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(1);   // no retry
    expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('max_tokens');
  });

  it('case 7: interrupt during the retry attempt → user-interrupt wins, no turn-complete', async () => {
    // Same direct-mock pattern as the postSteer tests above (including the
    // `let session!:` definite-assignment declaration): a per-call side effect
    // fires the interrupt while the RETRY attempt (call 2) is running.
    let session!: HarnessSession;
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call++;
        if (call === 2) session.interrupt();
        return { stream: simulateReadableStream({ chunks: stream(finishChunk('stop')) }) };
      },
    });
    session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(call).toBe(2);           // the retry attempt DID start…
    expect(types(events)).toContain('user-interrupt');          // …but the interrupt won
    expect(types(events)).not.toContain('turn-complete');       // never 'empty_response'
  });

  // Spec case 8 — a specialist child gets the SAME bounded retry. The child
  // never-park rule (harness-stall-watchdog.test.ts) is about the watchdog
  // leaving send() unsettled; a synchronous capped re-run settles normally.
  // `await child.send()` completing IS the settle assertion — a regression to an
  // unbounded loop trips this file's test timeout instead of hanging a parent.
  it('case 8a: specialist child — empty then content settles send() with end_turn', async () => {
    const seen: any[] = [];
    const model = scriptedModel([
      stream(finishChunk('stop')),
      stream(...textChunks('a', 'report'), finishChunk('stop')),
    ], seen);
    const child = new HarnessSession(makeOpts({ isSpecialistChild: true }), async () => model as any);
    const events = collect(child);
    await child.send('go');

    expect(seen).toHaveLength(2);
    expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('end_turn');
    expect(events.filter((e) => e.type === 'assistant-text').map((e) => e.data.text)).toEqual(['report']);
  });

  it('case 8b: specialist child — empty twice settles send() with empty_response', async () => {
    // scriptedModel REPLAYS its last script when calls outrun it, so this one
    // empty script feeds every attempt — the assertion that only TWO calls
    // happened is what pins the bound (an unbounded retry would spin here).
    const seen: any[] = [];
    const model = scriptedModel([stream(finishChunk('stop'))], seen);
    const child = new HarnessSession(makeOpts({ isSpecialistChild: true }), async () => model as any);
    const events = collect(child);
    await child.send('go');

    expect(seen).toHaveLength(2);
    expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('empty_response');
  });

  it('whitespace-only step: classified empty AND kept out of history (review fix)', async () => {
    // The history push and the retry gate MUST share one emptiness predicate.
    // If the push used truthiness ('\n\n' is truthy) while the retry used
    // trim(), the whitespace step would be pushed to history AND retried — the
    // re-run's request would end in a dangling whitespace assistant message,
    // which Anthropic-shaped endpoints reject with a 400.
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...textChunks('a', '\n  \n'), finishChunk('stop')),   // whitespace-only step
      stream(...textChunks('b', 'recovered'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(2);   // retried like a fully-silent step
    expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('end_turn');
    // History: user + ONLY the real answer — the whitespace step pushed nothing.
    const history = (session as any).history as any[];
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(history[1])).toContain('recovered');
  });

  it("finishReason 'tool-calls' with ZERO parsed calls: orderly → retried, preparing card withdrawn (review fix)", async () => {
    // A stream that announces tool use but whose every call was dropped as
    // malformed/truncated leaves toolCalls empty with finishReason
    // 'tool-calls' — the likeliest empty-step shape on small local models.
    // Excluding it from ORDERLY_EMPTY_FINISHES ended the turn with the raw
    // passthrough stopReason 'tool-calls' (meaningless to the user) instead of
    // the retry ladder. And because this shape almost always put a "Preparing…"
    // card on screen (tool-input-start with no completed tool-call), the retry
    // must WITHDRAW that card before re-running — the step re-runs inside the
    // same turn, so endTurn's reaping never fires and the orphan would spin
    // beside the retry's own cards (same rule as the manual/stall retry paths).
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...toolInputChunks('c1', 'Read', '{"file_pa'), finishChunk('tool-calls')),
      stream(...textChunks('a', 'recovered'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(2);   // one retry, then the real answer
    expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('end_turn');
    // The dead attempt's preparing card was explicitly withdrawn.
    const cleared = events.filter((e) => e.type === 'assistant-thinking' && e.data.toolPreparing?.cleared);
    expect(cleared.map((e) => e.data.toolPreparing.toolCallId)).toEqual(['c1']);
  });

  it('ROADMAP L241: an orphan preparing card is withdrawn on a step that ALSO ran a real tool', async () => {
    // The mixed step: one call the model completed (c1, executes normally) and
    // one it announced and then dropped (c2, tool-input-start with no
    // completed tool-call). Before this fix the withdrawal only ran on the
    // empty-step RETRY path, and endTurn's reaping only fires at turn end — so
    // c2's "Preparing…" card spun beside c1's real card for the rest of the
    // turn.
    const read = fakeTool('Read', { schema: z.object({ file_path: z.string() }).strict(), onExecute: () => ({ text: 'contents' }) });
    const model = scriptedModel([
      stream(
        ...toolInputChunks('c2', 'Write', '{"file_pa'),          // announced, never completed
        toolCallChunk('c1', 'Read', { file_path: 'x.ts' }),      // the real one
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('a', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const cleared = events.filter((e) => e.type === 'assistant-thinking' && e.data.toolPreparing?.cleared);
    expect(cleared.map((e) => e.data.toolPreparing.toolCallId)).toEqual(['c2']);

    // …and the withdrawal lands BEFORE the real card goes up, so the two never
    // share the screen.
    const clearedAt = events.findIndex((e) => e.type === 'assistant-thinking' && e.data.toolPreparing?.cleared);
    const useAt = events.findIndex((e) => e.type === 'tool-use');
    expect(clearedAt).toBeGreaterThanOrEqual(0);
    expect(clearedAt).toBeLessThan(useAt);

    // The real call still ran — the withdrawal must not touch a completed call,
    // whose card transitions in place under the same id.
    expect(events.filter((e) => e.type === 'tool-result')).toHaveLength(1);
  });

  it('G-1: BashOutput is exempt from the doom-loop window — nine identical polls raise no ask, the 9th hits the per-turn cap', async () => {
    const poll = fakeTool('BashOutput', { schema: z.object({ shell_id: z.string().optional() }).strict(), onExecute: () => ({ text: 'sh-1 · running · 1s\nline' }) });
    const calls = Array.from({ length: 9 }, (_, i) => stream(toolCallChunk(`c${i}`, 'BashOutput', { shell_id: 'sh-1' }), finishChunk('tool-calls')));
    const model = scriptedModel([...calls, stream(...textChunks('b', 'done'), finishChunk('stop'))]);
    const askUser = vi.fn(async () => ({ behavior: 'allow' as const }));
    const session = new HarnessSession(makeOpts({ tools: [poll], decide: async () => ALLOW, askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    expect(askUser.mock.calls.some((c) => (c[0] as any).toolName === 'doom_loop')).toBe(false);
    const results = events.filter((e) => e.type === 'tool-result');
    expect(results).toHaveLength(9);
    expect((poll as any).calls).toHaveLength(8);
    expect(results[8].data!.isError).toBe(true);
    expect(results[8].data!.toolResult).toBe('You have read background output 8 times this turn. Do NOT use this tool again without instruction from the user. Do NOT attempt to continuously poll for outputs — the finished notice arrives automatically.');
  });

  it('G-1: the BashOutput cap resets on the next turn', async () => {
    const poll = fakeTool('BashOutput', { schema: z.object({ shell_id: z.string().optional() }).strict(), onExecute: () => ({ text: 'x' }) });
    const nine = Array.from({ length: 9 }, (_, i) => stream(toolCallChunk(`c${i}`, 'BashOutput', {}), finishChunk('tool-calls')));
    const model = scriptedModel([
      ...nine, stream(...textChunks('a', 'done'), finishChunk('stop')),
      stream(toolCallChunk('d1', 'BashOutput', {}), finishChunk('tool-calls')), stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [poll], decide: async () => ALLOW, askUser: async () => ({ behavior: 'allow' as const }) }), async () => model as any);
    const events = collect(session);
    await session.send('one');
    await session.send('two');
    const results = events.filter((e) => e.type === 'tool-result');
    expect(results[9].data!.isError).toBe(false);
  });

  it('G-1: opts.shells reaches the tool as ctx.shells (absent when not wired)', async () => {
    let seen: unknown = 'unset';
    const probe = fakeTool('Read', { onExecute: (_a, c) => { seen = c.shells; return { text: 'ok' }; } });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const shells = { marker: 'registry' } as any;
    const session = new HarnessSession(makeOpts({ tools: [probe], decide: async () => ALLOW, shells }), async () => model as any);
    collect(session);
    await session.send('go');
    expect(seen).toBe(shells);
  });

  it("empty 'tool-calls' twice → empty_response (the honest end, not the raw passthrough)", async () => {
    const seen: any[] = [];
    const model = scriptedModel([stream(finishChunk('tool-calls'))], seen);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(seen).toHaveLength(2);   // one retry, then the honest end
    expect(events.find((e) => e.type === 'turn-complete')!.data.stopReason).toBe('empty_response');
  });
});

// The session id must reach the model factory as `cacheKey` on EVERY path that
// builds a model. It becomes the ChatGPT endpoint's prompt_cache_key: the
// endpoint remembers the shared opening of a conversation under that key and
// bills the remembered part at a discount. Drop the key and nothing breaks
// loudly — every step of every ChatGPT session re-pays for the whole
// conversation so far against the user's plan allowance, and each turn is
// slower. Nothing else in the suite passes through these two lines, so before
// this test they could both be deleted with the suite still green.
describe('HarnessSession — the model factory always gets the session id as cacheKey', () => {
  function recordingFactory(sink: Array<{ cacheKey?: string }>, model: any) {
    return async (_binding: any, o?: { cacheKey?: string }) => { sink.push({ ...o }); return model as any; };
  }

  it('the turn path passes cacheKey === sessionId', async () => {
    const seen: Array<{ cacheKey?: string }> = [];
    const model = scriptModel([{ text: 'done' }]);
    const session = new HarnessSession(
      makeOpts({ sessionId: 'sess-abc', tools: [], decide: async () => ALLOW }),
      recordingFactory(seen, model),
    );
    await session.send('go');
    expect(seen).toHaveLength(1);
    expect(seen[0].cacheKey).toBe('sess-abc');
  });

  it('the compaction path passes cacheKey === sessionId too', async () => {
    const seen: Array<{ cacheKey?: string }> = [];
    const model = scriptModel([{ text: 'SUMMARY: ok' }]);
    const session = new HarnessSession(
      makeOpts({ sessionId: 'sess-xyz', contextLength: 4096, tools: [], decide: async () => ALLOW }),
      recordingFactory(seen, model),
    );
    // Two user-delimited turns so compactNow finds a span it can condense.
    session.seedHistory([
      { role: 'assistant', content: 'a1' } as any,
      { role: 'user', content: 'u1' } as any,
      { role: 'assistant', content: 'a2' } as any,
      { role: 'user', content: 'u2' } as any,
    ]);
    expect(await session.compactNow()).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].cacheKey).toBe('sess-xyz');
  });
});
