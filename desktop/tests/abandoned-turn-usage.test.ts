// A turn that never reaches turn-complete still spent real money.
//
// `turn-complete` used to be the ONLY event carrying usage, and every abandoned
// exit — interrupt in the loop, a canceled permission ask, a canceled max-steps
// ask, a provider error in the catch — returns before it. So a five-step turn
// that read 300k tokens and wrote 8k before the user pressed Stop contributed
// ZERO to In/Out/Cached/Cost, for requests the provider had already billed.
// Pressing Stop is ordinary working style, so the chip drifted arbitrarily low
// for anyone who does it (fix 2026-09-16).
//
// What this file pins is the CONTRACT: the abandoned exits carry the spend of
// the steps that completed, exactly once, and never a fabricated zero.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type { AskDecision } from '../src/main/harness/permission-broker';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

function collect(session: HarnessSession) {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

describe('an abandoned turn reports what it already spent', () => {
  it('a canceled permission ask carries the completed steps’ usage on user-interrupt', async () => {
    // Step 1 completes and is billed (5 in / 3 out) before the ask that ends the
    // turn. Those tokens are the whole point: they were spent, and no
    // turn-complete will ever mention them.
    const read = fakeTool('Read');
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls', 5, 3)),
      stream(toolCallChunk('c2', 'Write', { file_path: 'y.ts' }), finishChunk('tool-calls', 9, 2)),
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(
      makeOpts({
        tools: [read, write],
        decide: async (t: any) => (t === 'Write' ? { action: 'ask', denyListed: false } : ALLOW) as PermissionDecision,
        askUser,
      }),
      async () => model as any,
    );
    const events = collect(session);
    await session.send('go');

    expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
    const stopped = events.find((e) => e.type === 'user-interrupt')!;
    // Both completed steps, summed — the turn total, which is the right quantity
    // for TOTALS (unlike the context gauge, which needs occupancy).
    expect(stopped.data.usage).toMatchObject({ inputTokens: 14, outputTokens: 5 });
  });

  it('a provider error carries it too — a failed turn is billed like an interrupted one', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls', 11, 4)),
      stream({ type: 'error', error: new Error('provider exploded') } as any),
    ]);
    const session = new HarnessSession(
      makeOpts({ tools: [read], decide: async () => ALLOW, retryDelays: [] }),
      async () => model as any,
    );
    const events = collect(session);
    await session.send('go');

    const failed = events.find((e) => e.type === 'session-error')!;
    expect(failed).toBeDefined();
    expect(failed.data.usage).toMatchObject({ inputTokens: 11, outputTokens: 4 });
  });

  it('reports NO usage key at all when nothing was measured', async () => {
    // A turn abandoned before any step reported tokens. A zero here would read as
    // "we checked and this turn was free" — the false zero
    // docs/error-message-standards.md forbids, and the same asymmetry the status
    // bar's own gates keep (a native zero hides, a Claude Code zero renders).
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'y.ts' }), finishChunk('tool-calls', 0, 0)),
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(
      makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }),
      async () => model as any,
    );
    const events = collect(session);
    await session.send('go');

    const stopped = events.find((e) => e.type === 'user-interrupt')!;
    expect(stopped.data.usage).toBeUndefined();
  });

  it('a turn that COMPLETES reports its usage exactly once, on turn-complete', async () => {
    // The guard against the other failure mode: turn-complete's own emit runs
    // listeners synchronously, and one of them is the host's persistence wire. If
    // it throws, control lands in send()'s catch — which must NOT bill the same
    // tokens a second time under a session-error.
    const model = scriptedModel([stream(...textChunks('a', 'hi'), finishChunk('stop', 100, 20))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events: TranscriptEvent[] = [];
    let thrown = false;
    session.on('transcript-event', (e: TranscriptEvent) => {
      events.push(e);
      if (e.type === 'turn-complete' && !thrown) { thrown = true; throw new Error('persistence wire exploded'); }
    });
    await session.send('go');

    const billed = events.filter((e) => e.data.usage && (e.type === 'turn-complete' || e.type === 'session-error' || e.type === 'user-interrupt'));
    expect(billed).toHaveLength(1);
    expect(billed[0].type).toBe('turn-complete');
  });
});
