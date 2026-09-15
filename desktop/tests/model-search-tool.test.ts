// ModelSearch (Task 14) — read-only catalog lookup so the orchestrating model
// can name a SPECIFIC model id for a Task delegation, when the user asked for
// one. Mirrors web-search-tool.test.ts's ctxWith() pattern.
import { describe, it, expect } from 'vitest';
import { ModelSearchTool } from '../src/main/harness/tools/model-search';
import type { CatalogModel } from '../src/shared/provider-types';

const ctxWith = (models: any) => ({
  sessionId: 's', cwd: 'C:\\p', signal: new AbortController().signal,
  readRegistry: new Map(), todos: [] as any[], services: { models },
});

function catalogOf(entries: CatalogModel[]) {
  return { designated: undefined as any, catalog: async () => entries };
}

const CATALOG: CatalogModel[] = [
  { id: 'openai/gpt-5', providerId: 'openrouter', label: 'GPT-5', pricing: { in: 10, out: 30 }, contextLength: 200_000 },
  { id: 'anthropic/claude-opus-5', providerId: 'openrouter', label: 'Claude Opus 5', pricing: { in: 5, out: 25 }, contextLength: 1_000_000 },
  { id: 'anthropic/claude-haiku-5', providerId: 'openrouter', label: 'Claude Haiku 5', pricing: { in: 0.25, out: 1.25 }, contextLength: 200_000 },
  { id: 'google/gemini-3-flash', providerId: 'openrouter', label: 'Gemini 3 Flash', pricing: { in: 0.1, out: 0.4 }, contextLength: 1_000_000 },
];

describe('ModelSearch tool', () => {
  it('matches case-insensitively against id AND display name', async () => {
    const r = await ModelSearchTool.execute({ query: 'CLAUDE' } as any, ctxWith(catalogOf(CATALOG)) as any);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('anthropic/claude-opus-5');
    expect(r.text).toContain('anthropic/claude-haiku-5');
    expect(r.text).not.toContain('gpt-5');
  });

  it('matches on a substring of the display name too', async () => {
    const r = await ModelSearchTool.execute({ query: 'flash' } as any, ctxWith(catalogOf(CATALOG)) as any);
    expect(r.text).toContain('google/gemini-3-flash');
  });

  it('sorts matches by prompt price ascending (cheapest first)', async () => {
    const r = await ModelSearchTool.execute({ query: 'claude' } as any, ctxWith(catalogOf(CATALOG)) as any);
    const haikuIdx = r.text.indexOf('claude-haiku-5');
    const opusIdx = r.text.indexOf('claude-opus-5');
    expect(haikuIdx).toBeGreaterThanOrEqual(0);
    expect(opusIdx).toBeGreaterThanOrEqual(0);
    expect(haikuIdx).toBeLessThan(opusIdx); // haiku ($0.25) is cheaper than opus ($5)
  });

  it('formats a line as "id — name · in $X/M tok · out $Y/M tok · ctx N"', async () => {
    const r = await ModelSearchTool.execute({ query: 'gpt' } as any, ctxWith(catalogOf(CATALOG)) as any);
    expect(r.text).toContain('openai/gpt-5 — GPT-5 · in $10/M tok · out $30/M tok · ctx 200000');
  });

  it('caps at 20 results with a "+N more — narrow the query" footer', async () => {
    const big: CatalogModel[] = Array.from({ length: 25 }, (_, i) => ({
      id: `provider/model-${i}`, providerId: 'openrouter', label: `Model ${i}`,
      pricing: { in: i, out: i * 2 }, contextLength: 100_000,
    }));
    const r = await ModelSearchTool.execute({ query: 'model' } as any, ctxWith(catalogOf(big)) as any);
    expect(r.text.split('\n').filter((l) => l.startsWith('provider/'))).toHaveLength(20);
    expect(r.text).toContain('+5 more — narrow the query');
  });

  it('no footer when everything fits under the cap', async () => {
    const r = await ModelSearchTool.execute({ query: 'claude' } as any, ctxWith(catalogOf(CATALOG)) as any);
    expect(r.text).not.toContain('more — narrow the query');
  });

  it('no catalog loaded (services.models absent) → the exact "unavailable" copy', async () => {
    const bare = { sessionId: 's', cwd: 'C:\\p', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] };
    const r = await ModelSearchTool.execute({ query: 'claude' } as any, bare as any);
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Model list is unavailable right now (catalog not loaded). Use the automatic Budget/Frontier tier, or explicitly request the conversation model.',
    );
  });

  it('no catalog loaded (catalog() resolves null) → the same exact copy', async () => {
    const r = await ModelSearchTool.execute(
      { query: 'claude' } as any,
      ctxWith({ designated: undefined, catalog: async () => null }) as any,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Model list is unavailable right now (catalog not loaded). Use the automatic Budget/Frontier tier, or explicitly request the conversation model.',
    );
  });

  it('refuses a too-short query', async () => {
    const r = await ModelSearchTool.execute({ query: 'a' } as any, ctxWith(catalogOf(CATALOG)) as any);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/at least 2 characters/i);
  });

  it('a query that matches nothing says so plainly', async () => {
    const r = await ModelSearchTool.execute({ query: 'zzz-nonexistent' } as any, ctxWith(catalogOf(CATALOG)) as any);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('No models match');
  });

  it('permissionSubject is always undefined — no per-argument subject', () => {
    expect(ModelSearchTool.permissionSubject({ query: 'claude' } as any)).toBeUndefined();
  });
});
