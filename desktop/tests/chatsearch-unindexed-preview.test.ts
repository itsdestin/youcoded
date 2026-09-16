// @vitest-environment node
// A conversation the Resume browser can list but the search index has not
// reached must still preview. The index is built by the bundled search plugin;
// the Resume list is built from a scan of ~/.claude/projects plus the
// Conversation Store, so the two disagree routinely — and on a fresh install
// there is no index at all. Before the fallback in refs-service.ts, previewing
// one of those answered errNotIndexed, which reads as "this conversation is
// broken" while the transcript sits on disk.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = path.join(os.tmpdir(), `chatsearch-unindexed-${process.pid}`);

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  const pathMod = await import('path');
  const home = pathMod.join(real.tmpdir(), `chatsearch-unindexed-${process.pid}`);
  return { ...real, default: { ...real, homedir: () => home }, homedir: () => home };
});
// Both reach for app state this test has no business touching.
vi.mock('../src/main/sync-spaces/service', () => ({ getManagedRoots: () => null }));
vi.mock('../src/main/conversations/service', () => ({ buildLocalProjectResolver: () => () => null }));

const ID = 'a3f2aaaa-1111-4111-8111-111111111111';
const SLUG = '-home-alice-project';

beforeAll(() => {
  fs.mkdirSync(path.join(HOME, '.claude', 'projects', SLUG), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, '.claude', 'projects', SLUG, `${ID}.jsonl`),
    // Same shape as tests/fixtures/chatsearch/claude-session.jsonl: the reader
    // keys lines by `uuid`, and a user line needs a `promptId` to count as
    // something a person typed rather than a tool result wearing the user role.
    [
      JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: 'why is the build slow' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Two of the three test files re-parse the same fixture.' }] } }),
    ].join('\n'),
  );
});

describe('previewing a conversation the index has not reached', () => {
  it('reads it off disk instead of refusing', async () => {
    const { readConversation } = await import('../src/main/chatsearch-index/refs-service');
    const res = await readConversation({ provider: 'claude', id: ID, tail: 10 } as never);
    expect(res.ok).toBe(true);
    expect((res as { messages: { content: string }[] }).messages.map((m) => m.content))
      .toEqual(['why is the build slow', 'Two of the three test files re-parse the same fixture.']);
  });

  it('still refuses an id with no transcript anywhere', async () => {
    const { readConversation } = await import('../src/main/chatsearch-index/refs-service');
    const res = await readConversation({ provider: 'claude', id: '9c14bbbb-2222-4222-8222-222222222222', tail: 10 } as never);
    expect(res.ok).toBe(false);
  });
});
