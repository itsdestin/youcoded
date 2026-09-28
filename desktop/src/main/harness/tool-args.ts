import type { NativeTool } from './tools/types';

/** WHY: the pre-write guidance gate must see exactly the same validated,
 * normalized path as execution; invalid args remain ordinary tool errors. */
export function parseToolArgs(tool: NativeTool, input: unknown): ReturnType<NativeTool['inputSchema']['safeParse']> {
  let parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success && typeof input === 'string') {
    try {
      const recovered: unknown = JSON.parse(input);
      if (recovered && typeof recovered === 'object') {
        const reparsed = tool.inputSchema.safeParse(recovered);
        if (reparsed.success) parsed = reparsed;
      }
    } catch { /* Let the normal argument-error result explain the invalid input. */ }
  }
  return parsed;
}
