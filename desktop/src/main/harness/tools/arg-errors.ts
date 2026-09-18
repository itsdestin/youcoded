// Turns a zod validation failure on a tool call into ONE sentence the model can
// act on. This is the only place tool-argument errors are worded — the driver
// (harness-session.ts runOneTool, step 1) calls it for every failed safeParse.
//
// WHY (ledger D-2, 2026-08-26 native-tools investigation): every native tool
// schema is now `.strict()`, so a parameter the tool does not know — e.g. a
// Claude-Code-trained model sending `Grep {"-i": true}` — is an ERROR instead
// of being silently dropped. An error is only useful if it says which name was
// wrong AND which names are right, so the model's next call is the fixed one.
// The other failure kinds (missing / wrong type / bad enum value) get the same
// treatment: name the field in plain words rather than zod's raw
// "Invalid input: expected string, received undefined".
import type { z } from 'zod';

/** The parameter names a schema accepts, when it is a plain object schema.
 *  zod v4 exposes `.shape` directly on ZodObject; anything else (records,
 *  unions, the MCP passthrough) has no fixed list, so we return undefined and
 *  the message simply omits the list rather than guessing one. */
export function validParameterNames(schema: z.ZodType): string[] | undefined {
  const shape = (schema as { shape?: unknown }).shape;
  return shape && typeof shape === 'object' ? Object.keys(shape as object) : undefined;
}

function label(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

export function formatArgErrors(toolName: string, error: z.ZodError, schema: z.ZodType): string {
  const problems: string[] = [];
  const unknown: string[] = [];
  let unknownAtTopLevel = false;
  for (const issue of error.issues) {
    const field = label(issue.path);
    switch (issue.code) {
      case 'unrecognized_keys': {
        // One issue may carry several keys; collect them and word them once below.
        if (field === '') unknownAtTopLevel = true;
        for (const k of issue.keys) unknown.push(field ? `${field}.${k}` : k);
        break;
      }
      case 'invalid_type': {
        // zod v4 does not expose the received type as a field — only in its
        // message ("…expected string, received undefined"). "received undefined"
        // is the missing-required case, which deserves its own wording.
        const received = /received (\w+)/.exec(issue.message)?.[1];
        if (received === 'undefined') problems.push(`missing required parameter "${field}" (expected ${issue.expected})`);
        else problems.push(`"${field}" must be a ${issue.expected}${received ? ` (received ${received})` : ''}`);
        break;
      }
      case 'invalid_value': {
        // Enum mismatch: list the allowed values verbatim so the fix is a copy.
        problems.push(`"${field}" must be one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`);
        break;
      }
      default:
        // Anything else (min/max, regex, custom refinements): zod's own message,
        // prefixed with the field so it can still be located.
        problems.push(field ? `"${field}": ${issue.message}` : issue.message);
    }
  }
  if (unknown.length > 0) {
    let s = `unknown parameter(s) ${unknown.map((k) => `"${k}"`).join(', ')}`;
    // The valid list only makes sense for top-level keys — it IS the top-level shape.
    const valid = unknownAtTopLevel ? validParameterNames(schema) : undefined;
    if (valid) s += `. Valid parameters: ${valid.join(', ')}`;
    problems.unshift(s);
  }
  return `Invalid arguments for ${toolName}: ${problems.join('; ')}. Fix the arguments and call again.`;
}

/** Why a string-wrapped arguments blob could not be read back. `undefined`
 *  means the string WAS a JSON object — its schema errors are the real ones. */
export type ToolInputStringFailure = 'unparseable' | 'oversize';

export type ToolInputParse<T> =
  | { ok: true; data: T }
  | { ok: false; error: z.ZodError; stringFailure?: ToolInputStringFailure };

/** The bound on the one recovery `JSON.parse`. A runaway tool call can be
 *  hundreds of kilobytes (one real propose_plan call was 210 KB), and parsing
 *  an arbitrarily large blob on a doomed call buys nothing. Comfortably above
 *  any honest arguments object. */
export const TOOL_INPUT_STRING_RECOVERY_LIMIT = 1_000_000;

/**
 * Read a tool call's raw arguments, accepting the double-encoded form.
 *
 * WHY this is ONE shared seam rather than a fix inside propose_plan: the
 * provider decides the shape, not the tool. The ai SDK normally parses a
 * tool-call's stringified arguments into an object for us, but when it cannot —
 * or when a model nests the whole object one level further in as a string — the
 * raw STRING arrives as `call.input` for whichever tool was called. Verified
 * 2026-09-18 against ai@7: a double-encoded argument string is passed straight
 * through, so every native tool and every MCP tool can meet this.
 *
 * Rules: an already-valid input is parsed ONCE and never re-parsed; only a
 * string gets the single bounded recovery attempt; and when the string does
 * hold a JSON object, that object's schema errors are what we report — the
 * outer "must be a object (received string)" describes the envelope, not the
 * mistake the model has to fix.
 */
export function parseToolCallInput<T>(schema: z.ZodType<T>, raw: unknown): ToolInputParse<T> {
  const first = schema.safeParse(raw);
  if (first.success) return { ok: true, data: first.data };
  if (typeof raw !== 'string') return { ok: false, error: first.error };
  if (raw.length > TOOL_INPUT_STRING_RECOVERY_LIMIT) return { ok: false, error: first.error, stringFailure: 'oversize' };

  let recovered: unknown;
  try {
    recovered = JSON.parse(raw);
  } catch {
    // Not JSON at all — most often arguments cut off before they finished.
    return { ok: false, error: first.error, stringFailure: 'unparseable' };
  }
  // A bare scalar ("hello", 3, null) is not an arguments object; treating it as
  // one would hand the schema a value it can only reject for the same reason.
  if (!recovered || typeof recovered !== 'object') return { ok: false, error: first.error, stringFailure: 'unparseable' };

  const second = schema.safeParse(recovered);
  return second.success ? { ok: true, data: second.data } : { ok: false, error: second.error };
}

/** The model-facing sentence for a string the seam could not read back. Kept
 *  beside formatArgErrors so all tool-argument wording lives in one file. */
export function formatStringArgFailure(toolName: string, failure: ToolInputStringFailure): string {
  return failure === 'oversize'
    ? `Invalid arguments for ${toolName}: the arguments arrived as text too large to read back. Call again with a much shorter set of arguments.`
    : `Invalid arguments for ${toolName}: the arguments arrived as text that is not valid JSON, so they could not be read. If they were long, they were probably cut off before they finished — call again with a shorter, complete set of arguments.`;
}
