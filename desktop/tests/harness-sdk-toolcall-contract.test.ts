// Pins the ai@7 behaviors the Phase 2 turn driver depends on:
//  1. tools WITHOUT execute => fullStream emits a 'tool-call' part and the
//     step finishes with finishReason 'tool-calls' (the SDK does NOT loop).
//  2. the 'tool-call' part carries { toolCallId, toolName, input } where input
//     is the PARSED object (streamText parses the raw JSON-string args for us).
//  3. an assistant message with tool-call parts + a tool message with
//     tool-result parts round-trip through streamText messages.
// If an SDK bump breaks THIS test, fix the driver before anything else.
//
// Verified against ai@7.0.22 (see docs/provider-dependencies.md coupling row).
// Field-name notes discovered empirically for this spike:
//  - RAW provider chunk (LanguageModelV4ToolCall) carries `input` as a
//    STRINGIFIED JSON string; streamText transforms it into a parsed object on
//    the fullStream `tool-call` part (StaticToolCall.input = InferToolInput).
//  - RAW `finish` chunk's finishReason is the V4 OBJECT shape { unified, raw }
//    (a plain 'tool-calls' string does NOT type-check against the mock); the
//    streamText result flattens it back to the 'tool-calls' string.
//  - RAW `finish` usage is the nested V4 shape ({ inputTokens: { total }, ... }).
//  - The tool-result HISTORY message field is `output` (ToolResultPart.output:
//    ToolResultOutput), carrying { type: 'text', value } — NOT `result`.
import { describe, it, expect } from 'vitest';
import { streamText, tool, zodSchema } from 'ai';
// MockLanguageModelV4 + simulateReadableStream confirmed present in ai@7.0.22
// (node_modules/ai/dist/test/index.d.ts), same pattern as harness-session.test.ts.
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { makeSession, scriptModel, fakeTool } from './helpers/harness-fakes';

// RAW LanguageModelV4ToolCall chunk: `input` is a stringified JSON string.
const toolCallChunk = {
  type: 'tool-call' as const,
  toolCallId: 'call-1',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/tmp/x.ts' }),
};

describe('ai@7 tool-call stream contract (provider-dependencies row)', () => {
  it('emits tool-call part and finishReason tool-calls when tool has no execute', async () => {
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Let me read that.' },
              { type: 'text-end', id: 't1' },
              toolCallChunk,
              // V4 finish reason is the { unified, raw } object; usage is nested.
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
            ],
          }),
        }),
      }),
      tools: { Read: tool({ description: 'read', inputSchema: zodSchema(z.object({ file_path: z.string() })) }) },
      prompt: 'read /tmp/x.ts',
    });
    const parts: any[] = [];
    for await (const p of result.fullStream) parts.push(p);
    const call = parts.find((p) => p.type === 'tool-call');
    expect(call).toBeTruthy();
    expect(call.toolName).toBe('Read');
    expect(call.toolCallId).toBe('call-1');
    // streamText parses the raw JSON-string args into an object here.
    expect(call.input).toEqual({ file_path: '/tmp/x.ts' });
    // Result flattens the V4 { unified, raw } object back to the 'tool-calls' string.
    expect(await result.finishReason).toBe('tool-calls');
  });

  it('accepts assistant tool-call + tool-result messages in history', async () => {
    // The teeth: the `result.text` assertion LOOKS tautological, but streamText
    // runs standardizePrompt over `messages` at call time — a wrong field name
    // (e.g. `result` instead of `output`, or a bad part shape) throws
    // AI_InvalidPromptError before the mock stream is ever read. This test fails
    // if the v7 tool-result message shape drifts. Do not weaken or delete it.
    const messages = [
      { role: 'user' as const, content: 'read it' },
      { role: 'assistant' as const, content: [
        { type: 'text' as const, text: 'Reading.' },
        // ToolCallPart.input is `unknown` (object form) in history messages.
        { type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'Read', input: { file_path: '/tmp/x.ts' } },
      ] },
      { role: 'tool' as const, content: [
        // v7 ToolResultPart uses `output: ToolResultOutput` ({ type:'text', value }), NOT `result`.
        { type: 'tool-result' as const, toolCallId: 'call-1', toolName: 'Read', output: { type: 'text' as const, value: '1: hello' } },
      ] },
    ];
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'done' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
          ] }),
        }),
      }),
      tools: { Read: tool({ description: 'read', inputSchema: zodSchema(z.object({ file_path: z.string() })) }) },
      messages,
    });
    expect(await result.text).toBe('done');
  });
});

// Task 12, item 1 — JSON-string arg recovery (weak-model hardening, spec §3).
// The contract test above proves streamText parses a RAW provider tool-call's
// stringified `input` into an object for us. But a weak local model sometimes
// puts the WHOLE args object as a STRING value one level further in — e.g. the
// model's real intent is `{ prompt: "do X" }`, but what it actually emits as
// the provider-level input is the STRING '{"prompt":"do X"}', which streamText
// faithfully parses into that same string (not an object). The validation seam
// (harness-session.ts's runOneTool, `rg -n 'safeParse'`) gets one extra chance:
// if raw input is a string that itself JSON.parses to an object, re-validate
// THAT object before giving up. One attempt only — never a general coercion
// layer (YAGNI).
describe('JSON-string tool-arg recovery', () => {
  it('recovers when a weak model double-encodes its args as a JSON string', async () => {
    const echo = fakeTool('Echo', { schema: z.object({ prompt: z.string() }) });
    // toolCallChunk() JSON.stringifies whatever `input` we hand it — passing an
    // ALREADY-stringified object here reproduces the double-encoding: streamText's
    // own parse (pinned above) unwraps ONE layer and hands runOneTool the STRING
    // '{"prompt":"do the actual thing now"}', not the object.
    const model = scriptModel([
      { toolCalls: [{ name: 'Echo', input: JSON.stringify({ prompt: 'do the actual thing now' }) }] },
      { text: 'done' },
    ]);
    const session = makeSession({ model, tools: [echo] });
    const events: any[] = [];
    session.on('transcript-event', (e) => events.push(e));

    await session.send('go');

    // The tool actually ran with the RECOVERED object, not the raw string.
    expect((echo as any).calls).toEqual([{ prompt: 'do the actual thing now' }]);
    // No "Invalid arguments" error was ever surfaced for this call.
    const toolResults = events.filter((e) => e.type === 'tool-result');
    expect(toolResults.some((e) => e.data.isError)).toBe(false);
  });

  it('one attempt only: a recovered object that STILL fails validation falls through to the normal arg error', async () => {
    const echo = fakeTool('Echo', { schema: z.object({ prompt: z.string() }) });
    // Valid JSON, valid object shape at the JSON level, but the wrong TYPE for
    // the schema (`prompt` must be a string) — recovery succeeds at JSON.parse,
    // but the re-validate must still fail, and there must be no third attempt.
    const model = scriptModel([
      { toolCalls: [{ name: 'Echo', input: JSON.stringify({ prompt: 12345 }) }] },
      { text: 'done' },
    ]);
    const session = makeSession({ model, tools: [echo] });
    const events: any[] = [];
    session.on('transcript-event', (e) => events.push(e));

    await session.send('go');

    expect((echo as any).calls).toHaveLength(0);   // never executed
    const toolResults = events.filter((e) => e.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].data.isError).toBe(true);
    expect(toolResults[0].data.toolResult).toMatch(/Invalid arguments for Echo/);
  });

  it('a plain non-JSON string falls straight through to the normal arg error (JSON.parse throws, caught, no crash)', async () => {
    const echo = fakeTool('Echo', { schema: z.object({ prompt: z.string() }) });
    const model = scriptModel([
      { toolCalls: [{ name: 'Echo', input: 'not json at all' }] },
      { text: 'done' },
    ]);
    const session = makeSession({ model, tools: [echo] });
    const events: any[] = [];
    session.on('transcript-event', (e) => events.push(e));

    await session.send('go');

    expect((echo as any).calls).toHaveLength(0);
    const toolResults = events.filter((e) => e.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].data.isError).toBe(true);
    expect(toolResults[0].data.toolResult).toMatch(/Invalid arguments for Echo/);
  });
});
