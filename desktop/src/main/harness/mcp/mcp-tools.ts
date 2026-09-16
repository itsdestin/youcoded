// MCP tool adapter (spec: native MCP phase 1, Task 5). Turns the tools a
// ReadyServer (Task 4) hands back into ordinary NativeTools — the driver
// (Task 9), permission UI, and ToolCard renderer never know a tool came from
// an MCP server rather than being built into the app. Task 6 attaches the
// result to a session within estimateToolSchemaTokens' budget.
import { z } from 'zod';
import { defineTool } from '../tools/registry';
import type { NativeTool } from '../tools/types';
import type { ReadyServer } from './mcp-manager';

export function mcpToolsFor(server: ReadyServer): NativeTool[] {
  return server.tools.map((t) => defineTool({
    name: `mcp__${server.id}__${t.name}`,
    description: t.description ?? `${server.label}: ${t.name}`,
    // MCP servers are external programs; their output is data, not instruction.
    untrusted: server.label,
    // Permissive on purpose: the SERVER validates its own arguments and returns a
    // real error. A lossy local re-validation could reject a valid call.
    inputSchema: z.object({}).passthrough(),
    rawInputSchema: t.inputSchema,
    // undefined subject → a remembered "always allow" grants exactly this one
    // namespaced tool (subject-glob.ts:6). Deliberate: a server update can add a
    // destructive tool, and there is no revocation UI until M5 item 3. The
    // server's own annotations (readOnlyHint, destructiveHint) are IGNORED here
    // on purpose — a server is not a trusted authority about its own danger.
    permissionSubject: () => undefined,
    // Fix: an MCP tool's result size is decided by the SERVER, not this file —
    // there is no per-call way for execute() below to know how much the server
    // held back, so `bounds` can never be set here and every MCP tool hit
    // composeNotice's no-`bounds` fallback with no `moreHint`, which used to
    // mean a bare "[output truncated: showing N of M chars]" with zero
    // widening advice. That is the COMMON case for MCP tools (unbounded by
    // construction), not an edge one. This is the STATIC fallback (types.ts
    // NativeTool.moreHint) for exactly that branch. It deliberately names NO
    // parameter: the schema in `rawInputSchema` belongs to the server, this
    // file never validates it (see inputSchema above), and guessing a
    // parameter name here would reintroduce the exact bug Task 1 removed the
    // shared advice string to prevent — advice a tool's own schema can't back.
    moreHint: `ask ${server.label}'s ${t.name} tool for a smaller result, or split the request into more, narrower calls to this server`,
    execute: async (args, ctx) => {
      const r = await server.call(t.name, args, ctx.signal);
      return { text: r.text, isError: r.isError };
    },
  }));
}

/** What a tool set costs in the request schema on EVERY turn. chars/4, the same
 *  deliberate estimate fitToContext uses (harness-session.ts, APPROX_CHARS_PER_TOKEN)
 *  — consistency with the budget it competes against matters more than accuracy here. */
export function estimateToolSchemaTokens(tools: NativeTool[]): number {
  const chars = tools.reduce((sum, t) =>
    sum + t.name.length + t.description.length + JSON.stringify(t.rawInputSchema ?? {}).length, 0);
  return Math.ceil(chars / 4);
}
