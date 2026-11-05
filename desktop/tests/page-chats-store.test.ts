// Which chats belong to which page (pages-finish step 3): the page reopens its last chat and lists earlier ones.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PageChatsStore } from '../src/main/pages/page-chats-store';

let dir: string;
// WHY a fixed path per test, not one read from `dir` at write time: a store's save is queued, and a test that
// ends with one still queued would otherwise write into the NEXT test's folder.
let file: () => string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'page-chats-'));
  const fixed = path.join(dir, 'page-assistant-chats.json');
  file = () => fixed;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('page chats', () => {
  it('records a new chat, learns its conversation, and lists the one used last first', async () => {
    const store = new PageChatsStore(file);
    await store.started('personal:money', 's1', 'claude', '/home/x/YouCoded/Personal');
    await store.conversationKnown('s1', 'c1');
    await store.started('personal:money', 's2', 'claude', '/home/x/YouCoded/Personal');
    await store.conversationKnown('s2', 'c2');
    await store.used('s1');
    const list = await store.list('personal:money');
    expect(list.map((c) => [c.conversationId, c.live])).toEqual([['c1', true], ['c2', true]]);
    expect(await store.pageOf('s2')).toBe('personal:money');
    expect(await store.list('personal:other')).toEqual([]);
  });

  it('an ended chat stays to be reopened; one that never got a conversation is forgotten', async () => {
    const store = new PageChatsStore(file);
    await store.started('personal:money', 's1', 'claude', '/p');
    await store.conversationKnown('s1', 'c1');
    await store.started('personal:money', 's2', 'claude', '/p');
    await store.ended('s1');
    await store.ended('s2');
    const list = await store.list('personal:money');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ conversationId: 'c1', live: false });
    expect(list[0].sessionId).toBeUndefined();
  });

  it('reopening a conversation updates its row instead of adding one, and survives a restart', async () => {
    const store = new PageChatsStore(file);
    await store.started('personal:money', 's1', 'claude', '/p');
    await store.conversationKnown('s1', 'c1');
    await store.ended('s1');
    await store.started('personal:money', 's9', 'claude', '/p', 'c1');
    expect(await store.list('personal:money')).toHaveLength(1);
    await store.whenSaved();
    const again = new PageChatsStore(file);
    const list = await again.list('personal:money');
    expect(list).toHaveLength(1);
    // A session id from an earlier run of the app names a program that is gone.
    expect(list[0]).toMatchObject({ conversationId: 'c1', live: false });
  });
});
