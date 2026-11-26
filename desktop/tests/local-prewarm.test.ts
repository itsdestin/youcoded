// Reading a local chat's opening in the background (harness/local-prewarm.ts).
//
// WHY these cases: measured on the real engine, a message sent while the
// background read is still going reads the whole opening a SECOND time beside
// it (140 s instead of ~80 s). The turn must wait for the read and reuse it,
// a Stop must still stop, and the read must send exactly what the next
// request starts with — otherwise it buys nothing.
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { LocalPrewarm, type WarmRead } from '../src/main/harness/local-prewarm';
import { makeSession } from './helpers/harness-fakes';
import { textChunks, finishChunk, stream } from './helpers/scripted-model';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}
const READ: WarmRead = { prefix: [], modelId: 'm', promptTokens: 100 };

describe('LocalPrewarm', () => {
  it('a turn that starts during the read waits for it, then gets what it covered', async () => {
    const g = gate();
    const w = new LocalPrewarm();
    w.start(async () => { await g.opened; return READ; });
    await Promise.resolve(); // the read begins on the next tick
    await new Promise((r) => setImmediate(r));
    let waited = false;
    const turn = w.beforeTurn(new AbortController().signal, () => { waited = true; });
    let settled = false;
    void turn.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r)); // settle
    expect(waited).toBe(true);
    expect(settled).toBe(false);
    g.open();
    expect(await turn).toBe(READ);
  });

  it('Stop while waiting ends the wait and the read', async () => {
    const w = new LocalPrewarm();
    let readSignal!: AbortSignal;
    w.start((signal) => { readSignal = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); });
    await new Promise((r) => setImmediate(r));
    const stop = new AbortController();
    const turn = w.beforeTurn(stop.signal, () => {});
    stop.abort();
    expect(await turn).toBeNull();
    expect(readSignal.aborted).toBe(true);
  });

  it('one read at a time across chats; a chat whose read has not begun does not wait for it', async () => {
    const g = gate();
    const a = new LocalPrewarm();
    const b = new LocalPrewarm();
    let bStarted = false;
    a.start(async () => { await g.opened; return READ; });
    b.start(async () => { bStarted = true; return READ; });
    await new Promise((r) => setImmediate(r));
    expect(bStarted).toBe(false); // queued behind a
    let waited = false;
    expect(await b.beforeTurn(new AbortController().signal, () => { waited = true; })).toBeNull();
    expect(waited).toBe(false);
    g.open();
    await new Promise((r) => setImmediate(r)); // settle
    expect(bStarted).toBe(false); // cancelled, never runs
  });

  it('a failed read just means no head start', async () => {
    const w = new LocalPrewarm();
    w.start(async () => { throw new Error('engine stopped'); });
    await new Promise((r) => setImmediate(r));
    expect(await w.beforeTurn(new AbortController().signal, () => {})).toBeNull();
  });
});

/** A model whose first call (the background read) is held until `release`. */
function heldFirstCallModel(release: Promise<void>, calls: any[]) {
  return new MockLanguageModelV4({
    doStream: async (options: any) => {
      calls.push(options);
      const first = calls.length === 1;
      const chunks = first ? stream(finishChunk('length')) : stream(...textChunks('t', 'hello back'), finishChunk('stop'));
      return {
        stream: new ReadableStream<any>({
          async start(c) {
            if (first) {
              await Promise.race([release, new Promise((r) => options.abortSignal?.addEventListener('abort', r))]);
              if (options.abortSignal?.aborted) { c.error(new Error('aborted')); return; }
            }
            for (const ch of chunks) c.enqueue(ch);
            c.close();
          },
        }),
      };
    },
  });
}

describe('HarnessSession.prewarm', () => {
  it('reads the same system text and tools the first message then sends, with a placeholder message', async () => {
    const g = gate();
    const calls: any[] = [];
    const session = makeSession({ model: heldFirstCallModel(g.opened, calls), systemPrompt: 'SYSTEM TEXT' });
    session.prewarm();
    await waitForCalls(calls, 1);
    g.open();
    await session.send('hello');
    expect(calls).toHaveLength(2);
    const [warm, real] = calls;
    expect(warm.maxOutputTokens).toBe(1);
    expect(warm.prompt[0]).toEqual(real.prompt[0]); // the system message
    expect(JSON.stringify(warm.tools)).toBe(JSON.stringify(real.tools));
    expect(JSON.stringify(warm.prompt.at(-1).content)).toContain('"."');
    expect(JSON.stringify(real.prompt.at(-1).content)).toContain('hello');
  });

  it('a message sent during the read waits for it instead of reading beside it', async () => {
    const g = gate();
    const calls: any[] = [];
    const session = makeSession({ model: heldFirstCallModel(g.opened, calls) });
    session.prewarm();
    await waitForCalls(calls, 1);
    const sent = session.send('hello');
    await new Promise((r) => setTimeout(r, 0)); // settle
    expect(calls).toHaveLength(1); // the real request has not gone out
    g.open();
    await sent;
    expect(calls).toHaveLength(2);
  });

  it('Stop while the message waits ends the turn and the read', async () => {
    const calls: any[] = [];
    const session = makeSession({ model: heldFirstCallModel(new Promise(() => {}), calls) });
    session.prewarm();
    await waitForCalls(calls, 1);
    const sent = session.send('hello');
    await new Promise((r) => setTimeout(r, 0)); // settle
    session.interrupt();
    await sent;
    expect(calls[0].abortSignal.aborted).toBe(true);
  });

  it('switching model drops a read of the old one', async () => {
    const calls: any[] = [];
    const session = makeSession({ model: heldFirstCallModel(new Promise(() => {}), calls) });
    session.prewarm();
    await waitForCalls(calls, 1);
    session.setBinding({ providerId: 'openrouter', modelId: 'other' });
    expect(calls[0].abortSignal.aborted).toBe(true);
  });
});

async function waitForCalls(calls: unknown[], n: number): Promise<void> {
  await vi.waitFor(() => expect(calls.length).toBe(n));
}
