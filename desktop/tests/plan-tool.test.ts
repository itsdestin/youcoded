import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createProposePlanTool } from '../src/main/harness/tools/propose-plan';
import { BUILTIN_ROSTER } from '../src/main/harness/specialists/registry';
import { CLOUD_DEFAULT, resolveProfile } from '../src/main/harness/capability-profile';
import { HarnessSession } from '../src/main/harness/harness-session';
import { HARNESS, EMPTY_SKILL_CATALOG, FAKE_SESSION_CWD } from './helpers/harness-fakes';
import { finishChunk, stream, textChunks, toolCallChunk, toolInputChunks } from './helpers/scripted-model';
import type { PlanView } from '../src/shared/types';

const VALID = {
  goal: 'Review the source files.',
  steps: [{ id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}.', budget_tokens: 500, items: ['a.ts', 'b.ts'] }],
};

const proposed = (toolUseId: string): PlanView => ({
  planId: 'plan-1', toolUseId, title: VALID.goal, status: 'proposed',
  steps: [{ id: 'review', kind: 'map', title: 'Review {item}.', specialist: 'reviewer', fanOut: 2, budgetTokens: 500, status: 'pending' }],
  ceilingTokens: 1_000, ceilingUsd: null, model: { label: 'Test model' }, seq: 1,
});

function scriptedSession(scripts: any[][], over: Record<string, unknown> = {}) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: scripts[Math.min(call++, scripts.length - 1)] }) }),
  });
  const events: any[] = [];
  const propose = vi.fn(async ({ toolUseId, commit }: { toolUseId: string; commit(): boolean }) => {
    if (!commit()) throw new Error('commit refused');
    return proposed(toolUseId);
  });
  const session = new HarnessSession({
    sessionId: 's-1', cwd: FAKE_SESSION_CWD, harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'model' }, providerType: 'openrouter',
    profile: CLOUD_DEFAULT, tools: [], skillCatalog: EMPTY_SKILL_CATALOG, mcpServers: [],
    specialistRoster: BUILTIN_ROSTER, toolServices: { plans: { propose } },
    decide: async () => ({ action: 'allow', denyListed: false }), retryDelays: [],
    ...over,
  } as any, async () => model as any);
  session.on('transcript-event', (event) => events.push(event));
  return { session, events, propose, calls: () => call };
}

describe('propose_plan tool', () => {
  it('validates semantically and persists only through the injected callback', async () => {
    const propose = vi.fn(async ({ toolUseId, commit }: { toolUseId: string; commit(): boolean }) => {
      if (!commit()) throw new Error('commit refused');
      return proposed(toolUseId);
    });
    const tool = createProposePlanTool(BUILTIN_ROSTER);
    const result = await tool.execute(VALID, {
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, signal: new AbortController().signal,
      toolCallId: 'call-1', readRegistry: new Map(), todos: [], services: { plans: { propose } },
    });
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-1', toolUseId: 'call-1', document: VALID,
      maximumAttempts: 2, ceilingTokens: 1_000, maxFanOut: 2,
    }));
    expect(result).toMatchObject({ isError: false, plan: { status: 'proposed', toolUseId: 'call-1' } });
  });

  it('aborts before crossing the persistence callback', async () => {
    const propose = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const tool = createProposePlanTool(BUILTIN_ROSTER);
    const result = await tool.execute(VALID, {
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, signal: controller.signal,
      toolCallId: 'call-1', readRegistry: new Map(), todos: [], services: { plans: { propose } },
    });
    expect(result).toMatchObject({ isError: true, plan: { toolUseId: 'call-1', status: 'stopped' } });
    expect(result.text).toMatch(/canceled/i);
    expect(propose).not.toHaveBeenCalled();
  });

  it('threads an abort signal and one-shot commit guard across the persistence seam', async () => {
    const controller = new AbortController();
    let firstCommit: boolean | undefined;
    let secondCommit: boolean | undefined;
    let receivedSignal: AbortSignal | undefined;
    const propose = vi.fn(async (proposal: any) => {
      receivedSignal = proposal.signal;
      firstCommit = proposal.commit();
      secondCommit = proposal.commit();
      return proposed(proposal.toolUseId);
    });
    const tool = createProposePlanTool(BUILTIN_ROSTER);
    const result = await tool.execute(VALID, {
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, signal: controller.signal,
      toolCallId: 'call-1', binding: { providerId: 'openrouter', modelId: 'model' },
      readRegistry: new Map(), todos: [], services: { plans: { propose } },
    });
    expect(result.isError).toBe(false);
    expect(receivedSignal).toBe(controller.signal);
    expect(firstCommit).toBe(true);
    expect(secondCommit).toBe(false);
  });

  it('fails the commit guard when interruption wins the persistence race', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let commits = 0;
    const propose = vi.fn(async (proposal: any) => {
      await held;
      if (proposal.commit()) commits++;
      return proposed(proposal.toolUseId);
    });
    const tool = createProposePlanTool(BUILTIN_ROSTER);
    const pending = tool.execute(VALID, {
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, signal: controller.signal,
      toolCallId: 'call-1', binding: { providerId: 'openrouter', modelId: 'model' },
      readRegistry: new Map(), todos: [], services: { plans: { propose } },
    });
    controller.abort();
    release();
    const result = await pending;
    expect(commits).toBe(0);
    expect(result).toMatchObject({ isError: true, plan: { status: 'stopped' } });
  });

  it.each([
    ['missing service', undefined],
    ['callback throw', { propose: async () => { throw new Error('disk exploded'); } }],
  ])('terminates the projection on %s', async (_name, plans) => {
    const tool = createProposePlanTool(BUILTIN_ROSTER);
    const result = await tool.execute(VALID, {
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, signal: new AbortController().signal,
      toolCallId: 'call-1', binding: { providerId: 'openrouter', modelId: 'model' },
      readRegistry: new Map(), todos: [], ...(plans ? { services: { plans } } : {}),
    } as any);
    expect(result).toMatchObject({ isError: true, plan: { toolUseId: 'call-1', status: 'failed' } });
  });

  it('returns validator issues and creates no proposal for invalid arguments', async () => {
    const propose = vi.fn();
    const tool = createProposePlanTool(BUILTIN_ROSTER);
    const result = await tool.execute({ ...VALID, steps: [{ ...VALID.steps[0], specialist: 'missing' }] }, {
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, signal: new AbortController().signal,
      toolCallId: 'call-1', readRegistry: new Map(), todos: [], services: { plans: { propose } },
    });
    expect(result).toMatchObject({ isError: true, planArgsInvalid: true });
    expect(result.text).toMatch(/unknown specialist/i);
    expect(propose).not.toHaveBeenCalled();
  });
});

describe('HarnessSession plan integration', () => {
  it('dynamically attaches for eligible roots, but not children or ineligible local models', () => {
    const eligible = scriptedSession([stream(finishChunk('stop'))]).session as any;
    expect(Object.keys(eligible.buildAiTools())).toContain('propose_plan');

    const child = scriptedSession([stream(finishChunk('stop'))], { isSpecialistChild: true }).session as any;
    expect(Object.keys(child.buildAiTools())).not.toContain('propose_plan');

    const localProfile = resolveProfile({ providerType: 'local-engine', modelId: 'Qwen3.5-2B-Q8_0', contextLength: 32_768 });
    const local = scriptedSession([stream(finishChunk('stop'))], {
      providerType: 'local-engine', binding: { providerId: 'local', modelId: 'Qwen3.5-2B-Q8_0' }, profile: localProfile,
    }).session as any;
    expect(Object.keys(local.buildAiTools())).not.toContain('propose_plan');
  });

  it('projects writing at tool-input-start and replaces it on success using ordinary tool events', async () => {
    const { session, events, propose } = scriptedSession([
      stream(...toolInputChunks('plan-call', 'propose_plan', '{"goal":"Review"}'), toolCallChunk('plan-call', 'propose_plan', VALID), finishChunk('tool-calls')),
      stream(finishChunk('stop')),
    ]);
    await session.send('make a plan');
    const use = events.find((event) => event.type === 'tool-use' && event.data.plan?.status === 'writing');
    const result = events.find((event) => event.type === 'tool-result' && event.data.toolUseId === 'plan-call');
    expect(use?.data).toMatchObject({ toolUseId: 'plan-call', toolName: 'propose_plan', plan: { toolUseId: 'plan-call', status: 'writing' } });
    expect(result?.data.plan).toMatchObject({ toolUseId: 'plan-call', status: 'proposed' });
    expect(events.indexOf(use)).toBeLessThan(events.indexOf(result));
    expect(events.filter((event) => event.type === 'tool-use' && event.data.toolUseId === 'plan-call')).toHaveLength(1);
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('allows one plan-specific model repair, then ends after exhausted invalid args without persistence or writing state', async () => {
    const bad = { ...VALID, steps: [{ ...VALID.steps[0], specialist: 'missing' }] };
    const { session, events, propose, calls } = scriptedSession([
      stream(...toolInputChunks('bad-1', 'propose_plan', '{}'), toolCallChunk('bad-1', 'propose_plan', bad), finishChunk('tool-calls')),
      stream(...toolInputChunks('bad-2', 'propose_plan', '{}'), toolCallChunk('bad-2', 'propose_plan', bad), finishChunk('tool-calls')),
      stream(finishChunk('stop')),
    ]);
    await session.send('make a plan');
    expect(calls()).toBe(2);
    expect(propose).not.toHaveBeenCalled();
    const results = events.filter((event) => event.type === 'tool-result' && event.data.toolName === 'propose_plan');
    expect(results).toHaveLength(2);
    expect(results[0].data.toolResult).toMatch(/one plan-specific repair opportunity/i);
    expect(results[1].data.toolResult).toMatch(/repair exhausted/i);
    expect(results.every((event) => event.data.plan.status === 'failed')).toBe(true);
  });

  it('terminalizes a retryable failed attempt before retrying under a new plan tool id', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: call++ === 0
          ? new ReadableStream<any>({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'tool-input-start', id: 'retry-plan-old', toolName: 'propose_plan' });
              },
              pull(controller) {
                const error = Object.assign(new Error('temporarily unavailable'), { statusCode: 503 });
                controller.error(error);
              },
            })
          : simulateReadableStream({ chunks: call === 2
              ? stream(
                  ...toolInputChunks('retry-plan-new', 'propose_plan', '{}'),
                  toolCallChunk('retry-plan-new', 'propose_plan', VALID),
                  finishChunk('tool-calls'),
                )
              : stream(finishChunk('stop')) }),
      }),
    });
    const events: any[] = [];
    const propose = vi.fn(async ({ toolUseId, commit }: any) => {
      expect(commit()).toBe(true);
      return proposed(toolUseId);
    });
    const session = new HarnessSession({
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, harness: HARNESS,
      binding: { providerId: 'openrouter', modelId: 'model' }, providerType: 'openrouter',
      profile: CLOUD_DEFAULT, tools: [], skillCatalog: EMPTY_SKILL_CATALOG, mcpServers: [],
      specialistRoster: BUILTIN_ROSTER, toolServices: { plans: { propose } },
      retryDelays: [0],
    } as any, async () => model as any);
    session.on('transcript-event', (event) => events.push(event));

    await session.send('make a plan');

    const oldResult = events.find((event) => event.type === 'tool-result' && event.data.toolUseId === 'retry-plan-old');
    const newUse = events.find((event) => event.type === 'tool-use' && event.data.toolUseId === 'retry-plan-new');
    const newResult = events.find((event) => event.type === 'tool-result' && event.data.toolUseId === 'retry-plan-new');
    expect(oldResult?.data).toMatchObject({ isError: true, plan: { status: 'failed' } });
    expect(events.indexOf(oldResult)).toBeLessThan(events.indexOf(newUse));
    expect(newResult?.data.plan).toMatchObject({ status: 'proposed' });
    expect(propose).toHaveBeenCalledTimes(1);
    const writingIds = events
      .filter((event) => event.type === 'tool-use' && event.data.plan?.status === 'writing')
      .map((event) => event.data.toolUseId);
    const terminalIds = new Set(events
      .filter((event) => event.type === 'tool-result' && event.data.plan?.status !== 'writing')
      .map((event) => event.data.toolUseId));
    expect(writingIds.filter((id) => !terminalIds.has(id))).toEqual([]);
  });

  it('pairs and fails a writing plan when the provider stream rejects', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: call++ === 0
          ? new ReadableStream<any>({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'tool-input-start', id: 'errored-plan', toolName: 'propose_plan' });
              },
              pull(controller) { controller.error(new Error('provider disconnected')); },
            })
          : simulateReadableStream({ chunks: stream(finishChunk('stop')) }),
      }),
    });
    const events: any[] = [];
    const session = new HarnessSession({
      sessionId: 's-1', cwd: FAKE_SESSION_CWD, harness: HARNESS,
      binding: { providerId: 'openrouter', modelId: 'model' }, providerType: 'openrouter',
      profile: CLOUD_DEFAULT, tools: [], skillCatalog: EMPTY_SKILL_CATALOG, mcpServers: [],
      specialistRoster: BUILTIN_ROSTER, toolServices: { plans: { propose: vi.fn() } },
      retryDelays: [],
    } as any, async () => model as any);
    session.on('transcript-event', (event) => events.push(event));
    await session.send('make a plan');
    const results = events.filter((event) => event.type === 'tool-result' && event.data.toolUseId === 'errored-plan');
    expect(results).toHaveLength(1);
    expect(results[0].data).toMatchObject({ isError: true, plan: { status: 'failed' } });
    expect(events.some((event) => event.type === 'session-error')).toBe(true);
  });

  it('gives invalid propose_plan siblings one shared repair turn', async () => {
    const bad = { ...VALID, steps: [{ ...VALID.steps[0], specialist: 'missing' }] };
    const { session, events, propose, calls } = scriptedSession([
      stream(
        toolCallChunk('bad-a', 'propose_plan', bad),
        toolCallChunk('bad-b', 'propose_plan', bad),
        finishChunk('tool-calls'),
      ),
      stream(toolCallChunk('fixed', 'propose_plan', VALID), finishChunk('tool-calls')),
      stream(...textChunks('done', 'Plan ready.'), finishChunk('stop')),
    ]);
    await session.send('make a plan');
    expect(calls()).toBe(3);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'tool-result' && event.data.toolUseId === 'bad-a')?.data.toolResult).toMatch(/repair opportunity/i);
    expect(events.find((event) => event.type === 'tool-result' && event.data.toolUseId === 'bad-b')?.data.toolResult).toMatch(/not run.*sibling/i);
    expect(events.find((event) => event.type === 'tool-result' && event.data.toolUseId === 'fixed')?.data.plan.status).toBe('proposed');
  });

  it('removes and restores propose_plan across actual setBinding eligibility transitions', () => {
    const { session } = scriptedSession([stream(finishChunk('stop'))]);
    const tools = () => Object.keys((session as any).buildAiTools());
    expect(tools()).toContain('propose_plan');

    const small = resolveProfile({ providerType: 'local-engine', modelId: 'Qwen3.5-2B-Q8_0', contextLength: 32_768 });
    session.setBinding({ providerId: 'local', modelId: 'Qwen3.5-2B-Q8_0' }, 32_768, small, null, true, 'local-engine');
    expect(tools()).not.toContain('propose_plan');

    session.setBinding({ providerId: 'openrouter', modelId: 'model-2' }, null, CLOUD_DEFAULT, null, false, 'openrouter');
    expect(tools()).toContain('propose_plan');
  });

  it('fails closed when providerType is absent', () => {
    const { session } = scriptedSession([stream(finishChunk('stop'))], { providerType: undefined });
    expect(Object.keys((session as any).buildAiTools())).not.toContain('propose_plan');
  });

  it('pairs and terminates a truncated plan input without calling the model again or persisting', async () => {
    const { session, events, propose, calls } = scriptedSession([
      stream(...toolInputChunks('cut-plan', 'propose_plan', '{"goal":'), finishChunk('length')),
      stream(finishChunk('stop')),
    ]);
    await session.send('make a plan');
    expect(calls()).toBe(1);
    expect(propose).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'tool-use' && event.data.toolUseId === 'cut-plan')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool-result' && event.data.toolUseId === 'cut-plan')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool-result' && event.data.toolUseId === 'cut-plan')?.data.plan.status).toBe('failed');
  });
});
