// WebSearch (spec §3.2): thin over the injected SearchService — ONE stable tool
// interface regardless of which backend answered. Result is a markdown string
// (the WebSearchView + collapsed header read input.query / a text response).
import { z } from 'zod';
import { defineTool } from './registry';
import { SearchUnavailableError } from '../search/search-service';

const inputSchema = z.object({ query: z.string().min(1).describe('The search query') }).strict(); // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)

export const WebSearchTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'WebSearch',
  untrusted: 'WebSearch',
  description: 'Search the web. Returns titles, URLs, and snippets — use WebFetch to read a promising result in full. Use this whenever fresh or current information matters.',
  // Compact form for small local models (simplified presentation).
  shortDescription: 'Search the web and return titles, URLs, and snippets for a query.',
  inputSchema,
  // Static fallback for composeNotice's no-bounds branch (Task 19): `bounds`
  // below is undefined whenever `unique.length <= 8` (nothing was withheld at
  // the RESULT-COUNT level), but an untrimmed title/URL in one of those <= 8
  // results could still push the joined text past the pipeline's default
  // 30k-char cap. Verbatim copy of the `bounds.moreHint` string below.
  moreHint: 'narrow the query, or WebFetch a result to read it in full',
  permissionSubject: (args) => args.query,
  async execute(args, ctx) {
    if (!ctx.services?.search) {
      return { text: 'Web search is not wired for this session; this is a configuration error.', isError: true };
    }
    try {
      const { results, source } = await ctx.services.search.search(args.query, ctx.signal);
      // Result fields are UNTRUSTED web content interpolated into a numbered
      // markdown list. Collapse internal whitespace/newlines so a title like
      // "\n\n2. **fake**" can't fabricate extra list items or inject
      // instruction-shaped lines into the model-facing text.
      const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
      // WHY a snippet cap (2026-08-01 review): the exa backend returns near-complete
      // page bodies, and one contextBridge query came back at 34,377 chars carrying
      // the same type-support table three times. Deep results are the point; 25k of
      // one page is not.
      const SNIPPET_CHARS = 500;
      const trim = (s: string) => (s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS)}…` : s);
      // Dedup by normalized URL — backends routinely return the same page twice
      // under a trailing-slash or scheme variant. Only the scheme+host are
      // lowercased; hostnames are case-insensitive but paths often aren't
      // (en.wikipedia.org/wiki/JavaScript vs .../javascript, or
      // github.com/User/Repo vs github.com/user/repo are different pages) —
      // lowercasing the whole URL previously collapsed those into one and
      // silently dropped a real result. When two URLs do collide, we keep
      // whichever came first, since backends return results in relevance
      // order and the first occurrence is the best-ranked one.
      const key = (u: string) => {
        try {
          const parsed = new URL(u);
          const host = parsed.host.toLowerCase();
          const path = parsed.pathname.replace(/\/+$/, '') + parsed.search + parsed.hash;
          return `${host}${path}`;
        } catch {
          // Untrusted backend string wasn't a parseable URL — dedup it only
          // against an exact repeat of itself rather than throwing (a throw
          // here would fail the whole tool call).
          return u;
        }
      };
      const seen = new Set<string>();
      const unique = results.filter((r) => {
        const k = key(r.url);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const shown = unique.slice(0, 8);
      const lines = shown.map((r, i) =>
        `${i + 1}. **${clean(r.title)}**\n   ${clean(r.url)}${r.snippet ? `\n   ${trim(clean(r.snippet))}` : ''}`);
      return {
        text: `Web search results for "${args.query}" (via ${source}):\n\n${lines.join('\n\n')}`,
        bounds: unique.length > shown.length
          ? { shown: shown.length, total: unique.length, unit: 'results' as const, moreHint: 'narrow the query, or WebFetch a result to read it in full' }
          : undefined,
      };
    } catch (err: any) {
      if (err instanceof SearchUnavailableError) return { text: err.message, isError: true };
      throw err; // defineTool catch → actionable error / abort labeling
    }
  },
});
