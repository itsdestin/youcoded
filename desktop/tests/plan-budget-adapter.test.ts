// Specialists plans, Task 3 — the conservative complete-request budget adapter.
// Pins: the WHOLE request is counted (system, every message, every tool schema,
// fixed framing), content the adapter cannot bound is refused BEFORE anything
// is sent, a tighter provider adapter can never widen authorization, and which
// provider routes get an adapter at all.
import { describe, it, expect, afterEach } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  GENERIC_BYTES_PER_TOKEN, REQUEST_FRAMING_TOKENS, PER_MESSAGE_FRAMING_TOKENS, PER_TOOL_FRAMING_TOKENS,
  genericInputBound, budgetAdapterFor, tightenedAdapter, checkAdapterConformance, authoritativeTokens, setupBound,
  disableAdapterForPlans, adapterDisabledReason, resetDisabledAdaptersForTests, type PlanWireRequest,
} from '../src/main/harness/plans/budget-adapter';

const bytes = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

const TOOL = { name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } };

function req(over: Partial<PlanWireRequest> = {}): PlanWireRequest {
  return {
    system: 'You are a specialist.',
    messages: [{ role: 'user', content: 'Review a.ts' }],
    tools: [TOOL],
    ...over,
  };
}

afterEach(() => resetDisabledAdaptersForTests());

describe('genericInputBound — the complete request is counted', () => {
  it('counts system, every message, every tool schema, and the fixed framing — nothing is sampled', () => {
    const r = req({
      messages: [
        { role: 'user', content: 'Review a.ts' },
        { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'a.ts' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value: 'x'.repeat(5000) } }] },
      ] as ModelMessage[],
    });
    const result = genericInputBound(r);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contentBytes = bytes(r.system) + r.messages.reduce((n, m) => n + bytes(m), 0) + r.tools.reduce((n, t) => n + bytes(t), 0);
    expect(result.tokens).toBe(
      Math.ceil(contentBytes / GENERIC_BYTES_PER_TOKEN)
      + REQUEST_FRAMING_TOKENS + 3 * PER_MESSAGE_FRAMING_TOKENS + 1 * PER_TOOL_FRAMING_TOKENS,
    );
    // A certified bound: at least one token per UTF-8 byte of everything sent.
    expect(result.tokens).toBeGreaterThanOrEqual(contentBytes);
  });

  it('grows with every added message and every added tool (no part of the request is free)', () => {
    const base = genericInputBound(req());
    const moreMessages = genericInputBound(req({ messages: [{ role: 'user', content: 'Review a.ts' }, { role: 'user', content: 'and b.ts' }] }));
    const moreTools = genericInputBound(req({ tools: [TOOL, { ...TOOL, name: 'Grep' }] }));
    if (!base.ok || !moreMessages.ok || !moreTools.ok) throw new Error('unexpected refusal');
    expect(moreMessages.tokens).toBeGreaterThan(base.tokens + PER_MESSAGE_FRAMING_TOKENS);
    expect(moreTools.tokens).toBeGreaterThan(base.tokens + PER_TOOL_FRAMING_TOKENS);
  });

  it('multi-byte text is charged per byte, not per character', () => {
    const ascii = genericInputBound(req({ messages: [{ role: 'user', content: 'aaaa' }] }));
    const cjk = genericInputBound(req({ messages: [{ role: 'user', content: '漢漢漢漢' }] }));
    if (!ascii.ok || !cjk.ok) throw new Error('unexpected refusal');
    expect(cjk.tokens - ascii.tokens).toBe(8); // 4 chars × (3 bytes − 1 byte)
  });

  it.each<[string, ModelMessage]>([
    ['an image part', { role: 'user', content: [{ type: 'image', image: new Uint8Array([1, 2, 3]) }] } as ModelMessage],
    ['a file part', { role: 'user', content: [{ type: 'file', data: 'aGk=', mediaType: 'application/pdf' }] } as ModelMessage],
    ['a reasoning part', { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] } as ModelMessage],
    ['a media tool result', { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'x' }] } }] } as ModelMessage],
    ['raw binary anywhere', { role: 'user', content: [{ type: 'text', text: 'x', providerOptions: { x: { blob: Buffer.from('zz') } } }] } as unknown as ModelMessage],
  ])('refuses %s with a specific reason instead of guessing a bound', (_label, message) => {
    const result = genericInputBound(req({ messages: [message] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/can't (be )?measure|can't safely/i);
  });

  it('accepts plain text, tool calls and text/json tool results', () => {
    const result = genericInputBound(req({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'Read', input: {} }] },
        { role: 'tool', content: [
          { type: 'tool-result', toolCallId: 'c', toolName: 'Read', output: { type: 'json', value: { a: 1 } } },
          { type: 'tool-result', toolCallId: 'd', toolName: 'Read', output: { type: 'error-text', value: 'no' } },
        ] },
      ] as ModelMessage[],
    }));
    expect(result.ok).toBe(true);
  });
});

describe('adapter selection and the conformance contract', () => {
  it.each(['anthropic', 'openai', 'google', 'openrouter', 'openai-compatible', 'local-engine'] as const)(
    '%s gets a bounding adapter', (type) => {
      const found = budgetAdapterFor(type);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.adapter.inputBound(req())).toEqual(genericInputBound(req()));
      expect(found.adapter).toMatchObject({ providerType: type, capsOutput: true });
    },
  );

  it('ChatGPT gets a soft-limit adapter (decision 5): same certified input bound, but no reply cap', () => {
    const found = budgetAdapterFor('chatgpt');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.adapter).toMatchObject({ providerType: 'chatgpt', capsOutput: false });
    expect(found.adapter.inputBound(req())).toEqual(genericInputBound(req()));
  });

  it('a specialist\'s setup cost is the same adapter bound over its prompt and tools alone (decision 4)', () => {
    const found = budgetAdapterFor('anthropic');
    if (!found.ok) throw new Error('unexpected');
    const setup = setupBound(found.adapter, { system: 'You are a specialist.', tools: [TOOL] });
    expect(setup).toEqual(found.adapter.inputBound({ system: 'You are a specialist.', messages: [], tools: [TOOL] }));
    // The first real request (setup + brief) is covered by setup plus the brief's own bytes.
    const first = genericInputBound(req());
    if (!setup.ok || !first.ok) throw new Error('unexpected');
    expect(first.tokens - setup.tokens).toBe(Buffer.byteLength(JSON.stringify(req().messages[0])) + PER_MESSAGE_FRAMING_TOKENS);
  });

  it('a tokenizer adapter may tighten the bound but can never widen it', () => {
    const generic = genericInputBound(req());
    if (!generic.ok) throw new Error('unexpected');
    const base = budgetAdapterFor('anthropic');
    if (!base.ok) throw new Error('unexpected');
    const tighter = tightenedAdapter(base.adapter, 'tight', () => 10);
    const wider = tightenedAdapter(base.adapter, 'wide', () => generic.tokens * 10);
    expect(tighter).toMatchObject({ providerType: 'anthropic', capsOutput: true });
    expect(tighter.inputBound(req())).toEqual({ ok: true, tokens: 10 });
    expect(wider.inputBound(req())).toEqual(generic);
    // …and it never un-refuses content the generic adapter refuses.
    const img = req({ messages: [{ role: 'user', content: [{ type: 'image', image: new Uint8Array([1]) }] } as ModelMessage] });
    expect(tighter.inputBound(img).ok).toBe(false);
  });

  it('conformance fails an adapter whose bound falls below observed provider usage', () => {
    const base = budgetAdapterFor('openai');
    if (!base.ok) throw new Error('unexpected');
    const tight = tightenedAdapter(base.adapter, 'tight', () => 10);
    expect(checkAdapterConformance(tight, [{ request: req(), observedInputTokens: 9 }])).toEqual({ ok: true });
    const failed = checkAdapterConformance(tight, [{ request: req(), observedInputTokens: 11 }]);
    expect(failed.ok).toBe(false);
  });

  it('a disabled adapter stays disabled for plans with its real detail', () => {
    expect(adapterDisabledReason('generic')).toBeUndefined();
    disableAdapterForPlans('generic', 'used 900 tokens against a 500-token bound');
    expect(adapterDisabledReason('generic')).toMatch(/900 tokens/);
  });
});

describe('authoritativeTokens — only a complete provider report counts', () => {
  it('needs both input and output counts', () => {
    expect(authoritativeTokens(undefined)).toBeUndefined();
    expect(authoritativeTokens({ inputTokens: 10, outputTokens: undefined })).toBeUndefined();
    expect(authoritativeTokens({ inputTokens: undefined, outputTokens: 3 })).toBeUndefined();
    expect(authoritativeTokens({ inputTokens: 10, outputTokens: 3 })).toBe(13);
  });

  it('takes the larger of the sum and a reported total (a total can include tokens the split omits)', () => {
    expect(authoritativeTokens({ inputTokens: 10, outputTokens: 3, totalTokens: 20 })).toBe(20);
    expect(authoritativeTokens({ inputTokens: 10, outputTokens: 3, totalTokens: 5 })).toBe(13);
  });
});
