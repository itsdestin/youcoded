import { describe, it, expect } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';
import type { ModelMessage } from 'ai';
import { adaptForWire, encodeImagesForWire, wireBase64Stats } from '../src/main/harness/wire-adapter';

// A real PNG signature so the SDK's own media-type sniffing runs on both forms.
const png = (seed: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40_000, seed)]);
const history = (imgs: Buffer[]): ModelMessage[] => [
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', data: imgs[0] }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'img' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: imgs[1] }, filename: 'a.png' }] } }] },
] as any;

async function capture(kind: 'openai' | 'openai-chat' | 'anthropic', messages: ModelMessage[], native: boolean): Promise<string> {
  let body = '';
  const fetch = (async (_u: any, init: any) => { body = String(init.body); throw new Error('stop'); }) as any;
  const model = kind === 'anthropic' ? createAnthropic({ apiKey: 'k', fetch })('claude-x')
    : kind === 'openai' ? createOpenAI({ apiKey: 'k', fetch }).responses('gpt-x') : createOpenAI({ apiKey: 'k', fetch }).chat('gpt-x');
  const r = streamText({ model, messages, maxRetries: 0, onError: () => {} });
  try { for await (const _ of r.fullStream) { /* drain */ } } catch { /* the fake fetch refuses on purpose */ }
  void native;
  return body;
}

describe('encodeImagesForWire', () => {
  it.each([['openai', false], ['openai-chat', false], ['anthropic', true]] as const)('sends byte-identical %s requests', async (kind, native) => {
    const imgs = [png(1), png(2)];
    const adapted = adaptForWire(history(imgs), { nativeImageToolResults: native, supportsVision: true });
    const before = await capture(kind, adapted, native);
    const after = await capture(kind, encodeImagesForWire(adapted), native);
    expect(before.length).toBeGreaterThan(100_000);
    expect(after).toBe(before);
  });

  it('encodes each image once across steps and never mutates history', () => {
    const imgs = [png(3), png(4)];
    const h = history(imgs);
    const start = wireBase64Stats.encoded;
    for (let step = 0; step < 5; step++) encodeImagesForWire(adaptForWire(h, { nativeImageToolResults: false, supportsVision: true }));
    expect(wireBase64Stats.encoded - start).toBe(2);
    expect(Buffer.isBuffer((h[0] as any).content[1].data)).toBe(true);
  });

  it('returns the same array when there are no image bytes', () => {
    const m: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    expect(encodeImagesForWire(m)).toBe(m);
  });
});
