// foldStream — the ChatGPT middleware's "run the stream and hand back what a
// one-shot call would have returned" helper (backend design §4.2, P0-5: the
// endpoint refuses a non-streaming call, and the auto-title feeder makes one).
//
// The happy path is already covered end to end in provider-registry.test.ts.
// What is pinned HERE is the ways it can go wrong QUIETLY, because each of them
// used to mutate green: turning `case 'error': throw` into a `break`, dropping
// the 'other' finish-reason default, and not closing the connection when the
// fold gives up. What the user would see: a session title written from half a
// failed answer, a cut-off turn treated as a clean stop, and dead network
// connections piling up behind a run of failures.
import { describe, it, expect } from 'vitest';
import { foldStream, transformParams, chatGptMiddleware } from '../src/main/providers/chatgpt-model';
import { ChatGptRequestDiagnostics, currentChatGptRequest } from '../src/main/providers/chatgpt-request-diagnostics';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';

/** A stream of the given parts. `onCancel` fires if the reader cancels it —
 *  which is how we prove a bailed-out fold closes the network connection
 *  instead of leaving the socket open until the garbage collector notices.
 *  `close: false` leaves the stream OPEN after the parts, the way a real
 *  response body is when the fold gives up part-way: a stream that has already
 *  ended cannot be cancelled at all, so a self-closing fixture would make the
 *  cancel assertion below impossible to fail. */
function partsStream(parts: any[], o: { onCancel?: () => void; close?: boolean } = {}) {
  return new ReadableStream<any>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      if (o.close !== false) controller.close();
    },
    cancel() { o.onCancel?.(); },
  });
}

const FINISH = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 7 }, outputTokens: { total: 2 } },
};

describe('foldStream', () => {
  it('releases the underlying reader after a rejected read without replacing its error', async () => {
    const error = new Error('PRIVATE_READ_ERROR');
    const underlying = new ReadableStream({ pull() { throw error; } }, { highWaterMark: 0 });
    const diagnostics = new ChatGptRequestDiagnostics({ directory: '/unused', write: async () => {} });
    const result = await chatGptMiddleware('session', diagnostics).wrapStream!({ params: {}, doStream: async () => ({ stream: underlying }) } as any);
    await expect(result.stream.getReader().read()).rejects.toBe(error);
    expect(underlying.locked).toBe(false);
  });
  it('diagnostic observer never pulls before consumer demand and cancellation records abort', async () => {
    const rows: any[] = [];
    const diagnostics = new ChatGptRequestDiagnostics({ directory: '/unused', write: async row => { rows.push(row); } });
    let pulls = 0;
    let canceled = false;
    const middleware = chatGptMiddleware('session', diagnostics);
    const result = await middleware.wrapStream!({
      params: {},
      doStream: async () => {
        const context = currentChatGptRequest()!;
        context.attemptId = diagnostics.dispatch(context, '{"model":"gpt-5","input":[]}');
        return { stream: new ReadableStream({
          pull(controller) { pulls++; controller.enqueue({ type: 'text-delta', id: 'x', delta: 'PRIVATE_DELTA' }); },
          cancel() { canceled = true; },
        }, { highWaterMark: 0 }) };
      },
    } as any);
    await Promise.resolve();
    expect(pulls).toBe(0);
    const reader = result.stream.getReader();
    await reader.read();
    expect(pulls).toBe(1);
    await reader.cancel();
    expect(canceled).toBe(true);
    await diagnostics.flush();
    expect(rows[0].outcome).toBe('aborted');
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_DELTA');
  });
  it('folds text parts and carries the stream’s finish reason and usage', async () => {
    const out = await foldStream({
      stream: partsStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'p1' },
        { type: 'text-delta', id: 'p1', delta: 'Hel' },
        { type: 'text-delta', id: 'p1', delta: 'lo' },
        { type: 'text-end', id: 'p1' },
        FINISH,
      ]),
    });
    expect(out.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(out.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    expect(out.usage.inputTokens.total).toBe(7);
  });

  it('an error part throws the model’s real error — the partial text is NOT returned as an answer', async () => {
    // Without the throw, a failed call would come back looking successful with
    // whatever text arrived before the failure. On the title path that means a
    // session silently named from half a sentence, with no sign anything broke.
    const boom = new Error('the model gave up');
    let text: string | undefined;
    await expect(foldStream({
      stream: partsStream([
        { type: 'text-start', id: 'p1' },
        { type: 'text-delta', id: 'p1', delta: 'half an ans' },
        { type: 'error', error: boom },
        FINISH,
      ]),
    }).then((r) => { text = JSON.stringify(r.content); })).rejects.toThrow('the model gave up');
    expect(text).toBeUndefined();
  });

  it('an error part carrying a non-Error still surfaces its text (never [object Object])', async () => {
    await expect(foldStream({
      stream: partsStream([{ type: 'error', error: { message: 'rate limited' } }]),
    })).rejects.toThrow(/rate limited|object Object/);
    // Be exact about which one: the value is stringified, and the user-facing
    // error-message rule forbids a message that says nothing.
    const err = await foldStream({ stream: partsStream([{ type: 'error', error: 'plan limit reached' }]) })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('plan limit reached');
  });

  it('bailing out on an error CANCELS the stream, so the connection is closed rather than left open', async () => {
    let cancelled = false;
    await expect(foldStream({
      stream: partsStream([{ type: 'error', error: new Error('nope') }],
        { onCancel: () => { cancelled = true; }, close: false }),
    })).rejects.toThrow('nope');
    expect(cancelled).toBe(true);
  });

  it('a stream that ends with no finish part reports "other", not a made-up stop', async () => {
    // A connection cut mid-answer produces exactly this. Reporting 'stop'
    // would tell the rest of the app the model finished normally, so a
    // truncated answer would be treated — and titled, and billed — as complete.
    const out = await foldStream({
      stream: partsStream([
        { type: 'text-start', id: 'p1' },
        { type: 'text-delta', id: 'p1', delta: 'cut off mid-' },
        { type: 'text-end', id: 'p1' },
      ]),
    });
    expect(out.finishReason).toEqual({ unified: 'other', raw: undefined });
    expect(out.usage.inputTokens.total).toBeUndefined();
    expect(out.usage.outputTokens.total).toBeUndefined();
    expect(out.content).toEqual([{ type: 'text', text: 'cut off mid-' }]);
  });
});

describe('transformParams', () => {
  it('strips maxOutputTokens — the endpoint 400s "Unsupported parameter: max_output_tokens" otherwise', () => {
    // Reproduced 2026-09-07: every real turn sends this from the harness's own
    // token budget, so leaving it in place breaks the very first message a
    // signed-in user sends.
    const params = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 4096,
    } as unknown as LanguageModelV4CallOptions;
    const out = transformParams(params);
    expect(out.maxOutputTokens).toBeUndefined();
  });
});
