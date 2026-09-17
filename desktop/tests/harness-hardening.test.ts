// Hardening pins for the two invariants spec §4.5 calls out explicitly:
//   1. Interrupt WHILE A TOOL IS EXECUTING (not during a permission ask — that
//      canceled-ask case is already pinned in harness-session-loop.test.ts). The
//      guarantee under test: when the user interrupts mid-execute, send() still
//      resolves, a user-interrupt event fires, AND the persisted history ends
//      fully PAIRED (every assistant tool-call has a matching tool-result), so
//      the NEXT send() ships history a provider API won't 400 on.
//   2. A model swap (setBinding) re-resolves the live capability profile, so a
//      swap to a small-local profile tightens the doom-loop window and flips
//      tool presentation for the next turn.
// Both are DRIVER-level guarantees, so they're pinned against the real
// HarnessSession over scripted-model fakes — no real subprocess involved.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { TranscriptEvent } from '../src/shared/types';
import { makeSession, scriptModel, fakeTool, makeOpts } from './helpers/harness-fakes';
import { HarnessSession } from '../src/main/harness/harness-session';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import type { PermissionDecision } from '../src/shared/permission-types';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { BashTool } from '../src/main/harness/tools/bash';

describe('HarnessSession hardening — interrupt-during-tool-execute', () => {
  it('interrupt while a tool is EXECUTING: send() resolves, user-interrupt fires, history stays fully paired', async () => {
    // An abortable fake tool: execute() blocks until ctx.signal aborts, then
    // RESOLVES with a normal result (exactly how the real Bash tool behaves on
    // abort). `started` lets the test wait until execute() has actually been
    // reached before interrupting — so the interrupt lands DURING execution, not
    // before it, and the pin is deterministic (no timing guesswork).
    let started = false;
    const slow = fakeTool('Slow', {
      onExecute: (_args, ctx) => new Promise((resolve) => {
        started = true;
        ctx.signal.addEventListener(
          'abort',
          () => resolve({ text: 'Canceled: the tool was interrupted mid-execute.', isError: true }),
          { once: true },
        );
      }),
    });
    // Step 1 emits the tool-call; step 2 would run only if the turn continued
    // (it must NOT, because we interrupt during step 1's tool execution).
    const model = scriptModel([
      { toolCalls: [{ name: 'Slow', input: { file_path: 'x.ts' } }] },
      { text: 'unreached' },
    ]);
    // decide defaults to allow-all in makeSession, so the tool is ALLOWED and
    // actually reaches execute() and blocks.
    const session = makeSession({ model, tools: [slow] });
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    const p = session.send('go');
    // Wait for execute() to actually start, then interrupt mid-execution.
    while (!started) await new Promise((r) => setTimeout(r, 2));
    session.interrupt();
    await p;   // must RESOLVE — a hang here would fail the test by timing out.

    // A user-interrupt was emitted and the turn did NOT complete normally.
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(false);

    // History-shape invariant (the high-value guard): every assistant tool-call
    // has a matching tool-result — no dangling tool_call that a provider API
    // would 400 on when the next send() ships this history.
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

    // And the LAST role:'tool' message is all tool-result parts (the back-filled/
    // real results the driver pushes when the step's tools resolve on abort).
    const toolMsgs = history.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThan(0);
    const lastToolMsg = toolMsgs[toolMsgs.length - 1];
    expect(lastToolMsg.content.every((p: any) => p.type === 'tool-result')).toBe(true);
  });

  // Bash-abort verification (spec §2.1 interrupt-mid-tool ruling). bash.ts ALREADY
  // kills its spawned child on ctx.signal abort — see src/main/harness/tools/bash.ts
  // lines 66-72: onAbort() calls child.kill('SIGKILL') and resolves the canceled
  // result, and the `if (ctx.signal.aborted) onAbort()` guard covers a signal that
  // fired before the listener attached. This test exercises that exact branch
  // deterministically and portably by passing an ALREADY-aborted signal: the tool
  // must kill the child and resolve the canceled result WITHOUT hanging (no
  // long-running subprocess — the child is killed immediately). `echo hi` is
  // portable across Git Bash, PowerShell, and /bin/bash.
  it('Bash kills its child and resolves the canceled result when ctx.signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await BashTool.execute(
      { command: 'echo hi' } as any,
      {
        sessionId: 's', cwd: process.cwd(), signal: ctrl.signal,
        readRegistry: new Map<string, string>(), todos: [],
      } as any,
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Canceled: the user interrupted this operation/);
  });
});

describe('HarnessSession hardening — model-swap re-resolves the capability profile', () => {
  it('setBinding(newBinding, ctx, newProfile) updates the live profile and binding', () => {
    const session = makeSession({});
    // Baseline: the default profile is the full cloud posture.
    expect((session as any).profile.doomLoopThreshold).toBe(CLOUD_DEFAULT.doomLoopThreshold);
    expect((session as any).profile.maxToolPresentation).toBe('full');

    // Swap to a small-local binding + profile (crosses a capability tier).
    session.setBinding(
      { providerId: 'local', modelId: 'small' },
      8192,
      { ...CLOUD_DEFAULT, maxToolPresentation: 'simplified', promptVariant: 'local-small', doomLoopThreshold: 2, supportsParallelToolCalls: false, constrainToolArgs: true },
    );

    // The live profile now reflects the small-local tuning...
    expect((session as any).profile.doomLoopThreshold).toBe(2);
    expect((session as any).profile.maxToolPresentation).toBe('simplified');
    expect((session as any).profile.supportsParallelToolCalls).toBe(false);
    // ...and the binding/contextLength were re-pointed too.
    expect(session.binding.modelId).toBe('small');
    expect((session as any).opts.contextLength).toBe(8192);

    // In-flight-turn guarantee (covered by comment, not asserted — expressing it
    // cleanly needs a modelFactory override makeSession doesn't expose): send()
    // constructs `model = await this.modelFactory(this.binding, ...)` ONCE at the
    // top of a turn (harness-session.ts, in send()), so a setBinding() that lands
    // mid-turn cannot swap the model under the running turn — the new binding
    // takes effect only on the NEXT send(). (The profile fields read live inside
    // runOneTool — e.g. doomLoopThreshold — are the intentional exception, but the
    // MODEL itself is turn-stable.)
  });
});

// 2026-09-16 (docs/roadmap/native-harness.md → cost): swapping models while a
// turn was still streaming used to re-price every token the OLD model had
// already produced at the NEW model's rate and label the turn with the new
// model's name — measured 2026-08-27 as a $7 turn reported as $70. The rate
// card and model id are now snapshotted at turn start.
describe('HarnessSession hardening — a mid-turn model swap never re-prices the running turn', () => {
  const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

  it('turn-complete carries the rate card and model that STARTED the turn, while the swap still takes for the next one', async () => {
    let session!: HarnessSession;
    // The swap lands from INSIDE the turn — a tool call between two model
    // steps — which is exactly the window the old code re-priced.
    const swap = fakeTool('Swap', {
      schema: z.object({}),
      onExecute: () => {
        session.setBinding({ providerId: 'openrouter', modelId: 'm-dear' }, undefined, undefined, { in: 10, out: 10 }, false);
        return { text: 'swapped' };
      },
    });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Swap', {}), finishChunk('tool-calls', 100, 100)),
      stream(...textChunks('b', 'done'), finishChunk('stop', 100, 100)),
    ]);
    session = new HarnessSession(
      makeOpts({ tools: [swap], decide: async () => ALLOW, pricing: { in: 1, out: 1 }, free: false }),
      async () => model as any,
    );
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');

    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done).toBeDefined();
    // 400 tokens at $1/M (the card the turn started on) — NOT at $10/M.
    expect(done.data.usage?.costUsd).toBeCloseTo(400 / 1e6, 12);
    expect(done.data.model).toBe('m');
    // The swap itself was honoured: the NEXT turn runs on the new binding.
    expect(session.binding.modelId).toBe('m-dear');
    expect((session as any).opts.pricing).toEqual({ in: 10, out: 10 });
  });
});
