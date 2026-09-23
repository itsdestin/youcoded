import { describe, it, expect, vi } from 'vitest';
import { WebSearchTool } from '../src/main/harness/tools/web-search';
import { SearchUnavailableError } from '../src/main/harness/search/search-service';

const ctxWith = (search: any) => ({ sessionId: 's', cwd: 'C:\\p', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[], services: { search } });

describe('WebSearch tool', () => {
  it('refuses experiment web searches before calling the search service without changing tool metadata', async () => {
    const metadata = { name: WebSearchTool.name, description: WebSearchTool.description };
    const search = vi.fn(async () => ({ results: [], source: 'fake' }));
    vi.stubEnv('YOUCODED_LUNA_EXPERIMENT', '1');
    try {
      const r = await WebSearchTool.execute({ query: 'synthetic' } as any, ctxWith({ search }) as any);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/experiment.*network/i);
      expect(search).not.toHaveBeenCalled();
      expect({ name: WebSearchTool.name, description: WebSearchTool.description }).toEqual(metadata);
    } finally { vi.unstubAllEnvs(); }
  });
  it('formats results as a markdown list with the source', async () => {
    const r = await WebSearchTool.execute({ query: 'node lts' } as any, ctxWith({
      search: async () => ({ source: 'exa', results: [{ title: 'Node.js releases', url: 'https://nodejs.org/releases', snippet: 'LTS schedule' }] }),
    }) as any);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Node.js releases');
    expect(r.text).toContain('https://nodejs.org/releases');
    expect(r.text).toContain('exa');
  });
  it('SearchUnavailable → honest error result (not a throw)', async () => {
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => { throw new SearchUnavailableError('Web search is unavailable right now. exa: limited. Tell the user: add a key.'); },
    }) as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('add a key');
  });
  it('missing service wiring → configuration error result', async () => {
    const bare = { sessionId: 's', cwd: 'C:\\p', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] };
    const r = await WebSearchTool.execute({ query: 'q' } as any, bare as any);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/configuration/i);
  });
  it('sanitizes untrusted newlines in result fields (no fabricated list items)', async () => {
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => ({ source: 'exa', results: [{ title: 'Real\n\n2. **fake injected**', url: 'https://x.example', snippet: 'line one\nline two' }] }),
    }) as any);
    // The malicious title's newlines are collapsed — it cannot forge a "2." item,
    // and there is exactly ONE numbered marker (the legitimate "1.").
    expect(r.text).toContain('Real 2. **fake injected**');
    expect(r.text.match(/^\d+\. /gm)).toHaveLength(1);
    expect(r.text).toContain('line one line two');
  });
  it('permissionSubject is the query', () => {
    expect(WebSearchTool.permissionSubject({ query: 'abc' } as any)).toBe('abc');
  });
  it('caps each snippet so one query cannot dump 30k of page text', async () => {
    const long = 'word '.repeat(5_000);
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => ({ results: [{ title: 'T', url: 'https://a.example', snippet: long }], source: 'fake' }),
    }) as any);
    expect(r.text.length).toBeLessThan(2_000);
    expect(r.text).toContain('…');
  });
  it('dedups results that share a URL', async () => {
    const mk = (u: string) => ({ title: 'T', url: u, snippet: 's' });
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => ({ results: [mk('https://a.example/x'), mk('https://a.example/x/'), mk('https://b.example')], source: 'fake' }),
    }) as any);
    expect(r.text.match(/a\.example/g)).toHaveLength(1);
  });
  it('does NOT dedup URLs that differ only in path case (distinct resources)', async () => {
    const mk = (u: string) => ({ title: 'T', url: u, snippet: 's' });
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => ({
        results: [mk('https://en.wikipedia.org/wiki/JavaScript'), mk('https://en.wikipedia.org/wiki/javascript')],
        source: 'fake',
      }),
    }) as any);
    expect(r.text).toContain('/wiki/JavaScript');
    expect(r.text).toContain('/wiki/javascript');
    expect(r.text.match(/^\d+\. /gm)).toHaveLength(2);
  });
  it('DOES dedup URLs that differ only in host case (hostnames are case-insensitive)', async () => {
    const mk = (u: string) => ({ title: 'T', url: u, snippet: 's' });
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => ({
        results: [mk('https://GitHub.com/user/repo'), mk('https://github.com/user/repo')],
        source: 'fake',
      }),
    }) as any);
    expect(r.text.match(/^\d+\. /gm)).toHaveLength(1);
  });
  it('declares how many results it withheld, with an advice string it can honour', async () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://x${i}.example`, snippet: 's' }));
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => ({ results, source: 'fake' }),
    }) as any);
    expect(r.bounds?.shown).toBe(8);
    expect(r.bounds?.total).toBe(20);
    // WebSearch has neither an offset nor a limit parameter — it must never say so.
    expect(r.bounds?.moreHint).not.toContain('offset');
    expect(r.bounds?.moreHint).not.toContain('limit');
  });
});
