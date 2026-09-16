import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { HarnessSession } from '../src/main/harness/harness-session';
import { chatGptMiddleware } from '../src/main/providers/chatgpt-model';
import {
  bindOpenAIContinuationModel,
  continuationEstimate,
  openAIContinuationMessages,
} from '../src/main/harness/openai-continuation';
import { planCompaction } from '../src/main/harness/compaction';
import { fakeTool, HARNESS, makeOpts } from './helpers/harness-fakes';
import { completed, richToolStep, sse, textStep } from './helpers/responses-fakes';

function harnessWithFetch(fetchImpl: typeof fetch, bindingIdentity: string | (() => string) = 'chatgpt\u0000gpt-test\u0000account-a\u00001'): HarnessSession {
  const read = fakeTool('Read', {
    schema: z.object({ file_path: z.string() }),
    onExecute: ({ file_path }) => ({ text: `local result ${file_path}` }),
  });
  return new HarnessSession(makeOpts({
    harness: { ...HARNESS, tools: ['Read'] },
    binding: { providerId: 'chatgpt', modelId: 'gpt-test' },
    tools: [read],
    decide: async () => ({ action: 'allow', denyListed: false }),
  }), async () => {
    const provider = createOpenAI({ apiKey: 'fake', baseURL: 'https://fake.invalid/v1', fetch: fetchImpl });
    const model = wrapLanguageModel({ model: provider.responses('gpt-test'), middleware: chatGptMiddleware('session') });
    return bindOpenAIContinuationModel(model, bindingIdentity);
  });
}

describe('OpenAI Responses continuation through HarnessSession', () => {
  it('round-trips completed ordered reasoning/text/tool parts into the next SDK wire body without duplicate local results', async () => {
    const bodies: any[] = [];
    const replies = [richToolStep(), textStep('msg-step-2', 'done')];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse(replies.shift()!);
    };
    const session = harnessWithFetch(fetchImpl as typeof fetch);
    await session.send('inspect both');

    expect(bodies).toHaveLength(2);
    const nextInput = bodies[1].input;
    const continuation = nextInput.slice(1, -2);
    expect(continuation.map((item: any) => item.type ?? `${item.role}:${item.phase}`)).toEqual([
      'reasoning', 'assistant:commentary', 'function_call', 'function_call', 'assistant:final_answer',
    ]);
    expect(continuation[0]).toMatchObject({ id: 'rs-1', encrypted_content: 'CIPHERTEXT'.repeat(10_000), summary: [{ type: 'summary_text', text: 'brief reason' }] });
    expect(continuation[1]).toMatchObject({ id: 'msg-commentary', phase: 'commentary', content: [{ type: 'output_text', text: 'checking ' }] });
    expect(continuation[4]).toMatchObject({ id: 'msg-final', phase: 'final_answer', content: [{ type: 'output_text', text: 'both files' }] });
    expect(JSON.stringify(nextInput)).not.toContain('must-not-round-trip');
    expect(nextInput.filter((item: any) => item.type === 'function_call_output')).toEqual([
      expect.objectContaining({ call_id: 'call-1', output: 'local result a.txt' }),
      expect.objectContaining({ call_id: 'call-2', output: 'local result b.txt' }),
    ]);
  });

  it('reasoning-only completed responses keep empty-step retry semantics and never commit private continuation', async () => {
    const bodies: any[] = [];
    const reasoningOnly = (id: string) => [
      { type: 'response.created', response: { id: `resp-${id}`, model: 'gpt-test', created_at: 1 } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id, encrypted_content: `cipher-${id}` } },
      { type: 'response.reasoning_summary_part.added', item_id: id, output_index: 0, summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', item_id: id, output_index: 0, summary_index: 0, delta: 'private summary' },
      { type: 'response.reasoning_summary_part.done', item_id: id, output_index: 0, summary_index: 0 },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id, encrypted_content: `cipher-${id}` } },
      completed({ output_tokens_details: { reasoning_tokens: 2 } }),
    ];
    const replies = [reasoningOnly('empty-1'), reasoningOnly('empty-2'), textStep('later', 'visible')];
    const session = harnessWithFetch((async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse(replies.shift()!);
    }) as typeof fetch);
    await session.send('silent');
    expect(bodies).toHaveLength(2); // exactly one silent retry
    await session.send('again');
    expect(JSON.stringify(bodies[2].input)).not.toContain('cipher-empty');
  });

  it('an interrupted SDK stream keeps visible partial text but never commits incomplete reasoning or calls', async () => {
    const bodies: any[] = [];
    let release!: () => void;
    const session = harnessWithFetch((async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const first = init && bodies.length === 1;
      if (!first) return sse(textStep('after-interrupt', 'done'));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const events = [
            { type: 'response.created', response: { id: 'resp-interrupt', model: 'gpt-test', created_at: 1 } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'partial-rs', encrypted_content: 'partial-cipher' } },
            { type: 'response.reasoning_summary_part.added', item_id: 'partial-rs', output_index: 0, summary_index: 0 },
            { type: 'response.reasoning_summary_text.delta', item_id: 'partial-rs', output_index: 0, summary_index: 0, delta: 'unfinished reason' },
            { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'partial-text', role: 'assistant', phase: 'commentary', content: [] } },
            { type: 'response.output_text.delta', item_id: 'partial-text', output_index: 1, content_index: 0, delta: 'visible partial' },
          ];
          controller.enqueue(encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
          release = () => controller.close();
        },
        cancel() { release = () => {}; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch);
    const turn = session.send('interrupt me');
    await new Promise<void>(resolve => session.on('transcript-event', event => {
      if (event.type === 'assistant-text') resolve();
    }));
    session.interrupt();
    release();
    await turn;
    await session.send('continue');
    const next = JSON.stringify(bodies[1].input);
    expect(next).toContain('visible partial');
    expect(next).not.toContain('partial-cipher');
    expect(next).not.toContain('unfinished reason');
  });

  it('fences a same-account reauth at the next dispatch and a mid-flight switch at response acceptance', async () => {
    const bodies: any[] = [];
    let identity = 'chatgpt\u0000gpt-test\u0000same-account\u00001';
    let closeFirst!: () => void;
    const session = harnessWithFetch((async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          const encoder = new TextEncoder();
          const events = textStep('stale-midflight', 'old generation');
          controller.enqueue(encoder.encode(events.slice(0, -1).map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
          closeFirst = () => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(events.at(-1))}\n\ndata: [DONE]\n\n`));
            controller.close();
          };
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return sse(textStep(`fresh-${bodies.length}`, 'fresh generation'));
    }) as typeof fetch, () => identity);
    const first = session.send('one');
    await new Promise<void>(resolve => session.on('transcript-event', event => {
      if (event.type === 'assistant-text') resolve();
    }));
    identity = 'chatgpt\u0000gpt-test\u0000same-account\u00002';
    closeFirst();
    await first;
    await session.send('two');
    expect(JSON.stringify(bodies[1].input)).not.toContain('stale-midflight');

    identity = 'chatgpt\u0000gpt-test\u0000same-account\u00003';
    await session.send('three');
    expect(JSON.stringify(bodies[2].input)).not.toContain('fresh-2');
  });

  it('round-trips an actual SDK-expanded parallel wrapper as validated child calls/results on next wire', async () => {
    const bodies: any[] = [];
    const wrapperInput = JSON.stringify({ tool_uses: [
      { recipient_name: 'functions.Read', parameters: { file_path: 'a.txt' } },
      { recipient_name: 'functions.Read', parameters: { file_path: 'b.txt' } },
    ] });
    const wrapper = [
      { type: 'response.created', response: { id: 'parallel-response', model: 'gpt-test', created_at: 1 } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'parallel-item', call_id: 'parallel-call', name: 'parallel', arguments: '' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'parallel-item', call_id: 'parallel-call', name: 'parallel', arguments: wrapperInput, status: 'completed' } },
      completed(),
    ];
    const replies = [wrapper, textStep('after-parallel', 'done')];
    const session = harnessWithFetch((async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse(replies.shift()!);
    }) as typeof fetch);
    await session.send('parallel read');
    const wrapperCalls = bodies[1].input.filter((item: any) => item.type === 'function_call');
    const wrapperResults = bodies[1].input.filter((item: any) => item.type === 'function_call_output');
    // With store:false and no previous-response id, the pinned converter sends
    // the validated expansion as ordinary child calls while retaining exact pairing.
    expect(wrapperCalls).toEqual([
      expect.objectContaining({ call_id: 'parallel-call_0', name: 'Read', arguments: '{"file_path":"a.txt"}' }),
      expect.objectContaining({ call_id: 'parallel-call_1', name: 'Read', arguments: '{"file_path":"b.txt"}' }),
    ]);
    expect(wrapperResults).toEqual([
      expect.objectContaining({ call_id: 'parallel-call_0', output: 'local result a.txt' }),
      expect.objectContaining({ call_id: 'parallel-call_1', output: 'local result b.txt' }),
    ]);
  });

  it('isolates continuation when the model factory observes an account change without setBinding', async () => {
    const bodies: any[] = [];
    const identities = ['chatgpt\u0000gpt-test\u0000account-a', 'chatgpt\u0000gpt-test\u0000account-b'];
    const replies = [textStep('account-a-text', 'first'), textStep('account-b-text', 'second')];
    let turn = 0;
    const session = new HarnessSession(makeOpts({ binding: { providerId: 'chatgpt', modelId: 'gpt-test' } }), async () => {
      const provider = createOpenAI({ apiKey: 'fake', baseURL: 'https://fake.invalid/v1', fetch: (async (_u: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse(replies.shift()!);
      }) as typeof fetch });
      return bindOpenAIContinuationModel(wrapLanguageModel({ model: provider.responses('gpt-test'), middleware: chatGptMiddleware('session') }), identities[turn++]);
    });
    await session.send('one');
    await session.send('two');
    const next = JSON.stringify(bodies[1].input);
    expect(next).toContain('first'); // ordinary visible history survives isolation
    expect(next).not.toContain('account-a-text'); // incompatible provider item id is stripped
  });
});

describe('OpenAI continuation adapter and sizing', () => {
  it('allowlists assistant fields and treats large ciphertext as seven reasoning tokens, not chars/4', () => {
    const messages = openAIContinuationMessages([{
      role: 'assistant',
      content: [{
        type: 'reasoning', text: 'brief reason',
        providerOptions: { openai: { itemId: 'rs-1', reasoningEncryptedContent: 'x'.repeat(4_000_000), secretFutureField: 'no' } },
      }],
    }] as any, 7);
    const estimate = continuationEstimate(messages[0]);
    expect(estimate).toEqual({ tokens: 7, incomplete: false });
    expect(JSON.stringify(messages)).not.toContain('secretFutureField');
    expect(JSON.stringify(messages).length).toBeGreaterThan(4_000_000);
    expect(planCompaction(messages, {
      contextLength: 100, triggerTokens: 75, protectedTokens: 10,
      minPruneSavings: 10, pruneToChars: 100,
    }, 0)).toEqual({ action: 'none' });
  });

  it('marks unknown reasoning usage incomplete and falls back to visible summary size', () => {
    const messages = openAIContinuationMessages([{
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'r'.repeat(400), providerOptions: { openai: { itemId: 'rs' } } }],
    }] as any, undefined);
    expect(continuationEstimate(messages[0])).toEqual({ tokens: 100, incomplete: true });
    // Unknown reasoning must create real conservative pressure rather than only
    // exposing a flag: with no measured occupancy this crosses the threshold.
    expect(planCompaction(messages, {
      contextLength: 120, triggerTokens: 90, protectedTokens: 10,
      minPruneSavings: 10, pruneToChars: 100,
    }, 0)).toEqual({ action: 'summarize' });
    // A measured provider prompt is preferred when available, even if lower.
    expect(planCompaction(messages, {
      contextLength: 120, triggerTokens: 90, protectedTokens: 10,
      minPruneSavings: 10, pruneToChars: 100,
    }, 50)).toEqual({ action: 'none' });
  });
});
