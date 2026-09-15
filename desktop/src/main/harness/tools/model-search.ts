// ModelSearch (Task 14) — read-only lookup over the live model catalog, so the
// orchestrating model can name a SPECIFIC model id for a Task delegation when
// the user asked for one. It attaches only alongside Task (harness-session.ts's
// syncTaskTool, same canDelegate && !isSpecialistChild gate) and reads public
// catalog metadata only — no provider keys, no session state, nothing else.
import { z } from 'zod';
import { defineTool } from './registry';
import type { ToolContext } from './types';
import { matchesQuery } from '../../../shared/text-match';

const inputSchema = z.object({
  query: z.string().describe(
    'Words to match against model ids and display names (case-insensitive, any order, '
    + 'punctuation-insensitive — "gpt 5.6" finds "gpt-5.6"). '
    + 'Use this to find the exact id of a specific model the user asked for — not for routine delegation.',
  ),
}).strict(); // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)

const MAX_RESULTS = 20;
const MIN_QUERY_CHARS = 2;

const NO_CATALOG_TEXT = 'Model list is unavailable right now (catalog not loaded). '
  + 'Use the automatic Budget/Frontier tier, or explicitly request the conversation model.';

export const ModelSearchTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'ModelSearch',
  description:
    'Look up available model ids by name, for delegating a Task to a SPECIFIC model. '
    + 'Only use this when the user asked for a particular model — routine delegation should '
    + 'use "budget" or "frontier" (the user\'s choices or safe provider defaults), or omit the model '
    + 'for the automatic Budget tier. Returns up to 20 matches, cheapest first, '
    + 'with id, display name, price per million tokens, and context length.',
  shortDescription: 'Find a specific model id, for delegating a Task to it by name (user-directed only).',
  inputSchema,
  moreHint: 'narrow the query',
  // Read-only, no per-argument subject — matches the tool-name-only "always
  // allowed" grant permission-types.ts gives it (it can never prompt).
  permissionSubject: () => undefined,
  async execute(args, ctx: ToolContext) {
    // Redundant with any schema-level check a future driver validation pass
    // might add — same reasoning as task.ts's own MIN_PROMPT_LENGTH floor:
    // this tool is exercised directly in tests (bypassing driver-side schema
    // parsing), so the floor has to live here to be a real guarantee.
    const query = args.query.trim();
    if (query.length < MIN_QUERY_CHARS) {
      return { text: `Search query must be at least ${MIN_QUERY_CHARS} characters.`, isError: true };
    }

    const models = ctx.services?.models;
    const catalog = models ? await models.catalog() : null;
    if (!catalog) return { text: NO_CATALOG_TEXT, isError: true };

    // Word-by-word, punctuation-insensitive — a model spelled "gpt-5.6" has to
    // be findable by the query "gpt 5.6", which a plain substring test missed.
    const matches = catalog.filter((m) => matchesQuery(query, m.id, m.label));
    // Sorted by PROMPT price ascending (pricing.in) — a model with no listed
    // pricing sorts last rather than first, so an unpriced row never crowds
    // out real cheap-to-expensive ordering.
    const sorted = [...matches].sort((a, b) => (a.pricing?.in ?? Infinity) - (b.pricing?.in ?? Infinity));

    if (sorted.length === 0) {
      return { text: `No models match "${args.query}".` };
    }

    const shown = sorted.slice(0, MAX_RESULTS);
    const lines = shown.map((m) => {
      const price = m.pricing ? `in $${m.pricing.in}/M tok · out $${m.pricing.out}/M tok` : 'price unlisted';
      const ctxPart = m.contextLength != null ? `ctx ${m.contextLength}` : 'ctx unknown';
      return `${m.id} — ${m.label} · ${price} · ${ctxPart}`;
    });
    const footer = sorted.length > MAX_RESULTS ? `\n+${sorted.length - MAX_RESULTS} more — narrow the query` : '';
    return { text: lines.join('\n') + footer };
  },
});
