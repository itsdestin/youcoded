// Guard for ledger D-2 (2026-08-26 native-tools investigation): when a model
// sends a tool arguments the schema rejects, the text it gets back must NAME
// the problem in the model's own vocabulary — which parameter is unknown, which
// is missing, which has the wrong type — and, for an unknown parameter, list
// the parameters that DO exist so the fix is one retry away. Before this, an
// unknown key (`Grep {pattern, "-i": true}`) was silently dropped and a missing
// key produced zod's raw "Invalid input: expected string, received undefined".
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { formatArgErrors, parseToolCallInput, TOOL_INPUT_STRING_RECOVERY_LIMIT } from '../src/main/harness/tools/arg-errors';

const grepLike = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  ignore_case: z.boolean().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  '-A': z.number().int().nonnegative().optional(),
}).strict();

function fail(schema: z.ZodType, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('expected the parse to fail');
  return r.error;
}

describe('formatArgErrors', () => {
  it('an unknown parameter is named, and the valid parameter list follows it', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', '-i': true }), grepLike);
    expect(msg).toBe(
      'Invalid arguments for Grep: unknown parameter(s) "-i". '
      + 'Valid parameters: pattern, path, ignore_case, output_mode, -A. Fix the arguments and call again.',
    );
  });

  it('several unknown parameters are listed together, once', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', '-i': true, case_sensitive: false }), grepLike);
    expect(msg).toContain('unknown parameter(s) "-i", "case_sensitive"');
    expect(msg.match(/Valid parameters:/g)).toHaveLength(1);
  });

  it('a missing required parameter says so, with the expected type', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, {}), grepLike);
    expect(msg).toBe('Invalid arguments for Grep: missing required parameter "pattern" (expected string). Fix the arguments and call again.');
  });

  it('a wrong-type parameter names the field, the expected type, and what was received', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', '-A': 'two' }), grepLike);
    expect(msg).toContain('"-A" must be a number (received string)');
  });

  it('a bad enum value lists the allowed values', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', output_mode: 'lines' }), grepLike);
    expect(msg).toContain('"output_mode" must be one of "content", "files_with_matches", "count"');
  });

  it('nested paths are dotted so a bad item inside an array is still locatable', () => {
    const todo = z.object({ todos: z.array(z.object({ content: z.string() })) }).strict();
    const msg = formatArgErrors('TodoWrite', fail(todo, { todos: [{ content: 'a' }, {}] }), todo);
    expect(msg).toContain('missing required parameter "todos.1.content"');
  });

  it('several problems are joined with "; " and the valid list is only appended for unknown keys', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { '-A': 'two' }), grepLike);
    expect(msg).toContain('missing required parameter "pattern"');
    expect(msg).toContain('"-A" must be a number');
    expect(msg).toContain('; ');
    expect(msg).not.toContain('Valid parameters');
  });

  it('a schema with no introspectable shape (not a z.object) still produces a usable message', () => {
    const anyObj = z.record(z.string(), z.number());
    const msg = formatArgErrors('X', fail(anyObj, { a: 'no' }), anyObj);
    expect(msg).toMatch(/^Invalid arguments for X: /);
    expect(msg).not.toContain('Valid parameters');
  });
});

// The double-encoded-arguments seam (2026-09-18). Some providers hand the whole
// arguments object through as a STRING one level further in — `"{\"a\":1}"`
// where an object belongs. runOneTool recovers that at ONE shared seam for
// every native tool, so propose_plan, recommend_plan_action and the file tools
// all get the same treatment. Evidence it is real: two of Destin's sessions
// recorded `toolInput` as a string for propose_plan (2026-09-17).
describe('parseToolCallInput — the shared double-encoded-arguments seam', () => {
  const schema = z.object({ goal: z.string(), count: z.number() }).strict();

  it('accepts a string-wrapped document and yields the same data as the object form', () => {
    const object = { goal: 'ship it', count: 2 };
    const fromObject = parseToolCallInput(schema, object);
    const fromString = parseToolCallInput(schema, JSON.stringify(object));
    expect(fromObject).toEqual({ ok: true, data: object });
    expect(fromString).toEqual(fromObject);
  });

  it('a string that is not JSON fails with the unparseable reason, not a type complaint', () => {
    // The real shape: arguments cut off mid-string by the output-token cap.
    const result = parseToolCallInput(schema, '{"goal":"ship it","count":');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stringFailure).toBe('unparseable');
  });

  it('a string whose JSON fails the schema reports the PARSED document\'s errors', () => {
    // WHY: reporting the outer "must be a object (received string)" here told
    // the model its arguments were the wrong TYPE when they were the wrong
    // SHAPE — it repaired the wrong thing and spent its one plan repair.
    const result = parseToolCallInput(schema, JSON.stringify({ goal: 'ship it' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stringFailure).toBeUndefined();
      const message = formatArgErrors('X', result.error, schema);
      expect(message).toContain('missing required parameter "count"');
      expect(message).not.toContain('received string');
    }
  });

  it('an oversized string is refused without being parsed at all', () => {
    const result = parseToolCallInput(schema, 'x'.repeat(TOOL_INPUT_STRING_RECOVERY_LIMIT + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stringFailure).toBe('oversize');
  });

  it('an input that is already an object is parsed once and never JSON.parsed', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const safeParse = vi.fn(schema.safeParse.bind(schema));
    const result = parseToolCallInput({ safeParse } as any, { goal: 'ship it', count: 2 });
    expect(result.ok).toBe(true);
    expect(safeParse).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('a non-string, non-object input still reports the schema error and never re-parses', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const result = parseToolCallInput(schema, 42);
    expect(result.ok).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('a JSON string holding a bare scalar is unparseable, not a silent object', () => {
    // `"\"hello\""` parses fine but is not an arguments object.
    const result = parseToolCallInput(schema, JSON.stringify('hello'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stringFailure).toBe('unparseable');
  });
});
