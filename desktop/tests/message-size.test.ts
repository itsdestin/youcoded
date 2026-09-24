import { describe, it, expect } from 'vitest';
import { messageTokens, messagesTokens, IMAGE_PART_TOKEN_ESTIMATE, requestOccupancy, requestFixedTokens, type UsageAnchor } from '../src/main/harness/message-size';
import { estimateTokens } from '../src/main/harness/compaction';

describe('message-size', () => {
  it('sizes content plus per-message role/envelope framing, without charging the fixed skeleton twice', () => {
    const user = { role: 'user', content: 'a'.repeat(400) } as any;
    const assistant = { role: 'assistant', content: 'b'.repeat(400) } as any;
    const frame = (role: string) => Math.ceil((JSON.stringify({ role, content: null }).length - 'null'.length + 1) / 4);
    expect(messageTokens(user)).toBe(100 + frame('user'));
    expect(messageTokens(assistant)).toBe(100 + frame('assistant'));
    expect(requestFixedTokens('system', {}) + messagesTokens([user, assistant])).toBe(
      requestFixedTokens('system', {}) + 200 + frame('user') + frame('assistant'),
    );
  });

  it('charges a flat estimate for a binary part, not stringified bytes', () => {
    // The #290 bug: JSON.stringify(Buffer) is ~4-5 chars/byte, so 1 MB looked
    // like ~1.1M tokens and fitToContext evicted the entire prior conversation.
    const oneMb = Buffer.alloc(1024 * 1024, 0x89);
    const msg = { role: 'user', content: [{ type: 'text', text: 'see attached' }, { type: 'file', mediaType: 'image/png', data: oneMb }] } as any;
    const tokens = messageTokens(msg);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_PART_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(IMAGE_PART_TOKEN_ESTIMATE + 100);
  });

  it('charges the flat estimate for a Buffer nested in a content-type tool output', () => {
    const msg = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'Read image x.png' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.alloc(500_000) } }] } }] } as any;
    // Lower bound guards against a charSize regression that silently swallows
    // the nested Buffer subtree (e.g. returns 0/undefined) and would otherwise
    // still pass an upper-bound-only assertion.
    const tokens = messageTokens(msg);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_PART_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(IMAGE_PART_TOKEN_ESTIMATE + 200);
  });

  it('sums across messages', () => {
    const msgs = [{ role: 'user', content: 'a'.repeat(40) }, { role: 'user', content: 'b'.repeat(40) }] as any;
    expect(messagesTokens(msgs)).toBe(messageTokens(msgs[0]) + messageTokens(msgs[1]));
  });
});

describe('request fixed sizing', () => {
  it('sizes selected wire schemas and instructions, not the catalog name alone', () => {
    const base = requestFixedTokens('instructions', {});
    const short = requestFixedTokens('instructions', { Read: { description: 'short', inputSchema: { jsonSchema: { type: 'object' } } } });
    const long = requestFixedTokens('instructions', { Read: { description: 'x'.repeat(400), inputSchema: { jsonSchema: { type: 'object' } } } });
    expect(short).toBeGreaterThan(base);
    expect(long - short).toBeGreaterThan(90);
  });
  it('charges request-envelope and tool-declaration wire framing as well as content', () => {
    const system = 'a';
    const tools = { Read: { description: 'b', inputSchema: { jsonSchema: { type: 'object' } } } };
    const rawContent = system.length + 'Read'.length + 'b'.length + JSON.stringify({ type: 'object' }).length;
    expect(requestFixedTokens(system, tools)).toBe(Math.ceil(JSON.stringify({
      system, messages: [], tools: [{ name: 'Read', description: 'b', parameters: { type: 'object' } }],
    }).length / 4));
    expect(requestFixedTokens(system, tools)).toBeGreaterThan(Math.ceil(rawContent / 4));
    // Same request with no tools still has system/message framing, not only text.
    expect(requestFixedTokens(system, {})).toBeGreaterThan(Math.ceil(system.length / 4));
  });
});

describe('request-bound usage anchors', () => {
  const old = { role: 'user', content: 'a'.repeat(400) } as any;
  const reply = { role: 'assistant', content: 'b'.repeat(80) } as any;
  const tool = { role: 'tool', content: [{ type: 'tool-result', output: { type: 'text', value: 'c'.repeat(400) } }] } as any;
  const anchor: UsageAnchor = { inputTokens: 900, identity: 'provider/model/tools/system', history: [old], revision: 1, fixedCost: 100 };
  const size = (history: any[], identity = anchor.identity, revision = 1, fixedCost = 100) =>
    requestOccupancy({ history, identity, revision, fixedCost, anchor });

  it('includes cached input in provider input and adds output, tool results and steers once', () => {
    expect(size([old])).toEqual({ tokens: 900, measured: true });
    // The measured prefix already includes its own wire framing; only the new
    // messages (including their roles/envelopes) may be charged on the suffix.
    expect(size([old, reply])).toEqual({ tokens: 900 + 20 + Math.ceil((JSON.stringify({ role: 'assistant', content: null }).length - 4 + 1) / 4), measured: false });
    expect(messageTokens(reply)).toBeGreaterThan(Math.ceil(reply.content.length / 4));
    expect(size([old, reply, tool, { role: 'user', content: '<steer>go</steer>' }])).toEqual({
      tokens: 900 + messagesTokens([reply, tool, { role: 'user', content: '<steer>go</steer>' } as any]), measured: false,
    });
  });
  it('rejects changed tools, rewritten history, model switch, and non-descendant revisions', () => {
    expect(size([old, reply], 'provider/model/new-tools')).toEqual({ tokens: 100 + messagesTokens([old, reply]), measured: false });
    expect(size([{ ...old }, reply])).toEqual({ tokens: 100 + messagesTokens([old, reply]), measured: false });
    expect(size([old, reply], 'other/model/tools/system')).toEqual({ tokens: 100 + messagesTokens([old, reply]), measured: false });
    expect(size([old, reply], anchor.identity, 0)).toEqual({ tokens: 100 + messagesTokens([old, reply]), measured: false });
    expect(size([old, reply], anchor.identity, 2, 200)).toEqual({ tokens: 200 + messagesTokens([old, reply]), measured: false });
  });
});

describe('sizing regression (#290 image-turn eviction)', () => {
  it('a history with one attached image does not dwarf the text history', () => {
    const history = [
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: [{ type: 'text', text: 'see screenshot' }, { type: 'file', mediaType: 'image/png', data: Buffer.alloc(1024 * 1024) }] },
    ] as any;
    // Before the fix this was ~1.1M tokens; a 32k budget kept ONLY the image
    // message and silently dropped the rest of the conversation. Lower bound
    // brackets the estimate against a charSize regression that silently
    // swallows the image subtree and would otherwise pass an upper-bound-only
    // assertion (a `toBeLessThan` alone is satisfied by 0).
    const tokens = estimateTokens(history);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_PART_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(3_000);
  });
});
