// REGRESSION: "Invalid prompt: messages must not be empty" after a large tool read.
//
// Found by Destin dogfooding Plan C on 2026-07-26: asking Qwen3.6-35B to read
// ROADMAP.md produced a 100 KB tool result (read.ts deliberately raises its own
// output cap to 100_000 chars) and the very next step died with the AI SDK's
// "messages must not be empty".
//
// Mechanism — two correct-looking rules that combine into a bug:
//   1. fitToContext's size loop ALWAYS keeps the newest message, even when it
//      alone blows the budget (`kept.length > 0 &&` skips the check on the first
//      iteration). Its comment states the intent explicitly: "history collapses
//      to that single message rather than erroring".
//   2. The pair-aware front trim that runs immediately after drops any leading
//      role:'tool' message as an orphaned tool-result.
// When the oversized survivor IS a tool result, rule 2 deletes the one message
// rule 1 promised to keep, and the driver sends an empty messages array.
//
// So the code contradicts its own documented invariant. These tests pin the
// invariant, not the current behavior.
import { describe, it, expect } from 'vitest';
import { HarnessSession, truncateToolMessage } from '../src/main/harness/harness-session';
import { ASSISTANT_PRESET } from '../src/shared/harness-manifest';
import { MockLanguageModelV4 } from 'ai/test';
import type { ModelMessage } from 'ai';
import { EMPTY_SKILL_CATALOG } from './helpers/harness-fakes';

// A realistically-sized assembled system prompt. prompt-assembly.ts appends the
// nearest AGENTS.md/CLAUDE.md truncated at 20_000 chars on top of the preamble,
// preset body and <env> block — and fitToContext counts that against the SAME
// budget, so a synthetic near-empty prompt hides the failure. ~24k chars ≈ 6k tokens.
const REALISTIC_SYSTEM_PROMPT = 'S'.repeat(24_000);

function session(contextLength: number) {
  return new HarnessSession(
    { skillCatalog: EMPTY_SKILL_CATALOG, sessionId: 's-1', cwd: '/tmp/x', harness: ASSISTANT_PRESET, binding: { providerId: 'local', modelId: 'Qwen3.6-35B-A3B' }, contextLength, systemPrompt: REALISTIC_SYSTEM_PROMPT } as any,
    async () => new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) as any }) }) as any,
  );
}

/** The exact shape Destin hit: one small user turn, one tool call, one enormous result. */
function oversizedReadHistory(resultChars: number): ModelMessage[] {
  return [
    { role: 'user', content: 'please read through all of roadmap.md' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: { file_path: 'ROADMAP.md' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: 'x'.repeat(resultChars) } }] },
  ] as ModelMessage[];
}

describe('fitToContext — never returns an empty message list', () => {
  it('keeps something when a single tool result dwarfs the whole context window', () => {
    // 100k chars ≈ 25k tokens against a 32,768-token window: the result alone
    // exceeds the budget, so the size loop keeps only it — and the front trim
    // then removed it, leaving nothing. This is Destin's exact repro.
    const s = session(32_768);
    const fitted = (s as any).fitToContext(oversizedReadHistory(100_000)) as ModelMessage[];
    expect(fitted.length).toBeGreaterThan(0);
  });

  it('never starts on an orphaned tool-result even while staying non-empty', () => {
    // The pairing invariant must SURVIVE the fix — a leading role:'tool' is an
    // unpaired tool_call that real providers 400 on. Staying non-empty must not
    // be bought by reintroducing that.
    const s = session(32_768);
    const fitted = (s as any).fitToContext(oversizedReadHistory(100_000)) as ModelMessage[];
    expect(fitted[0].role).not.toBe('tool');
  });

  it('holds for a tiny window too (the degenerate case the comment calls out)', () => {
    const s = session(4_096);
    const fitted = (s as any).fitToContext(oversizedReadHistory(100_000)) as ModelMessage[];
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted[0].role).not.toBe('tool');
  });

  it('an oversized PLAIN assistant message is still kept (the path that already worked)', () => {
    const s = session(32_768);
    const fitted = (s as any).fitToContext([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'y'.repeat(200_000) },
    ] as ModelMessage[]) as ModelMessage[];
    expect(fitted.length).toBeGreaterThan(0);
  });

  it('leaves a comfortably-fitting history completely alone', () => {
    const s = session(200_000);
    const history = oversizedReadHistory(1_000);
    const fitted = (s as any).fitToContext(history) as ModelMessage[];
    expect(fitted).toHaveLength(3);
    expect(fitted[0].role).toBe('user');
  });

  it('salvage keeps the tool-call PAIRED with its result, not a bare fragment', () => {
    // Dropping the result would leave the model looking at its own unanswered
    // request — it re-runs the identical call until the doom-loop guard trips.
    const s = session(32_768);
    const fitted = (s as any).fitToContext(oversizedReadHistory(100_000)) as ModelMessage[];
    const roles = fitted.map((m) => m.role);
    expect(roles).toContain('tool');
    // The assistant tool-call must sit immediately before its result.
    expect(roles[roles.indexOf('tool') - 1]).toBe('assistant');
    // ...and the user turn that explains WHY it ran is cheap enough to keep.
    expect(roles[0]).toBe('user');
  });

  it('5b review: salvage keeps the REAL user turn, never a history-only note after it', () => {
    // A plan Comment's follow-up turn is the user's words followed by a
    // model-only <plan-comment> note. That note is not what started the
    // exchange; picking it would drop the user's actual words.
    const s = session(32_768);
    const [user, call, result] = oversizedReadHistory(100_000);
    const fitted = (s as any).fitToContext([
      user,
      { role: 'user', content: '<plan-comment>\nAnswer with propose_plan.\n</plan-comment>' },
      call, result,
    ] as ModelMessage[]) as ModelMessage[];
    expect(fitted[0]).toEqual(user);
  });

  it('salvage TELLS the model the output was cut, and actually shrinks it', () => {
    // Without the notice a model reads a hard-cut file as complete and answers
    // confidently from a fragment.
    const s = session(32_768);
    const fitted = (s as any).fitToContext(oversizedReadHistory(100_000)) as ModelMessage[];
    const tool = fitted.find((m) => m.role === 'tool')!;
    const value = (tool.content as any[])[0].output.value as string;
    expect(value).toContain('truncated');
    expect(value.length).toBeLessThan(100_000);
  });
});

// Task 18: fitToContext's own trim notice (via truncateToolMessage, its salvage
// helper) hardcoded "Re-run with offset/limit, or use Grep" for EVERY tool's
// oversized result — including Bash and WebSearch, which accept neither
// parameter. This is the same defect the bounds contract removed from the
// defineTool pipeline (registry.ts), on the path that fires when a single
// result alone blows the context window, i.e. when the advice is most likely
// to be read and acted on. These pin that the advice is now derived from
// toolName instead of copy-pasted onto every result.
describe('truncateToolMessage — advice matches the tool that produced the result', () => {
  it('does not advise offset/limit for a tool that has neither parameter', () => {
    const msg = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolName: 'Bash',
        output: { type: 'text', value: 'x'.repeat(50_000) },
      }],
    } as any;
    const out = truncateToolMessage(msg, 1_000);
    const value = (out as any).content[0].output.value;
    expect(value).toContain('truncated');
    expect(value).not.toContain('offset/limit');
    expect(value).toMatch(/head|tail|narrower/i);
  });

  it('still advises offset for Read, which does accept it', () => {
    const msg = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolName: 'Read',
        output: { type: 'text', value: 'y'.repeat(50_000) },
      }],
    } as any;
    const value = (truncateToolMessage(msg, 1_000) as any).content[0].output.value;
    expect(value).toContain('offset');
  });

  it('states the true dropped count', () => {
    const msg = {
      role: 'tool',
      content: [{ type: 'tool-result', toolName: 'Bash', output: { type: 'text', value: 'z'.repeat(10_000) } }],
    } as any;
    const value = (truncateToolMessage(msg, 2_000) as any).content[0].output.value;
    // 10,000 in, `per` characters kept — the notice must name the real difference,
    // never a rounded or invented figure.
    expect(value).toMatch(/[\d,]+ more characters/);
  });

  it('says nothing extra for a tool absent from the hint map — a bare fact, not a guessed action', () => {
    // docs/error-message-standards.md: specific+accurate or general+non-committal,
    // never a plausible-sounding guess. A tool we don't have a real hint for must
    // not get one invented for it.
    const msg = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolName: 'SomeFutureTool',
        output: { type: 'text', value: 'w'.repeat(50_000) },
      }],
    } as any;
    const value = (truncateToolMessage(msg, 1_000) as any).content[0].output.value;
    expect(value).toContain('truncated');
    expect(value).not.toContain('offset/limit');
    expect(value).not.toMatch(/re-run/i);
  });
});

// Fix 2 (2026-08-11 review): truncateToolMessage never learned about the AI SDK
// v7 'content' output shape (text + file parts) that image-bearing tool results
// use — it fell through completely untouched, neither shrunk nor stripped, on
// the LAST-RESORT salvage path right before a provider 400. pruneToolOutputs
// (compaction.ts) already collapses this shape; these pin that
// truncateToolMessage now mirrors it, including its "only claim an image was
// dropped when a file part is actually present" guard.
describe('truncateToolMessage — collapses image (content) outputs instead of passing them through', () => {
  it('collapses a content output with a file part to text plus a named note', () => {
    const msg = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolName: 'Read',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'here is the screenshot' },
            { type: 'file', mediaType: 'image/png', data: 'BASE64DATA'.repeat(10_000) },
          ],
        },
      }],
    } as any;
    const out = truncateToolMessage(msg, 1_000) as any;
    const output = out.content[0].output;
    expect(output.type).toBe('text');
    expect(output.value).toContain('here is the screenshot');
    expect(output.value).toContain('[image dropped');
    expect(output.value).toContain('Read');
    // The point of the fix: the base64 payload is actually gone, not just
    // sitting there untouched behind a note.
    expect(output.value).not.toContain('BASE64DATA');
  });

  it('does not invent a dropped-image note when no file part is present', () => {
    const msg = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolName: 'Read',
        output: { type: 'content', value: [{ type: 'text', text: 'just some tool text' }] },
      }],
    } as any;
    const out = truncateToolMessage(msg, 1_000) as any;
    const output = out.content[0].output;
    expect(output.type).toBe('text');
    expect(output.value).toBe('just some tool text');
    expect(output.value).not.toContain('[image dropped');
  });
});
