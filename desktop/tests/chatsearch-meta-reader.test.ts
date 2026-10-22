/**
 * The in-app reader for the meta index the app itself writes. Until this feature
 * the only consumer was the standalone chatsearch CLI, which parses the JSON in
 * its own process; the session-reference cards need the same lookup in-process,
 * keyed by the short id PREFIXES the CLI prints in its table.
 *
 * Everything here is driven off a real temp directory rather than a mocked `fs`,
 * because the two failure modes that matter — no index yet, and a half-written
 * index — are both filesystem states, not call patterns.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMetaFile, resolveShortIds } from '../src/main/chatsearch-index/meta-reader';

const A = 'a3f2aaaa-0000-4000-8000-000000000000';
const B = 'a3f2bbbb-0000-4000-8000-000000000000';
const C = 'c0ffee00-0000-4000-8000-000000000000';

function entry(id: string, over: Record<string, unknown> = {}) {
  return {
    id, provider: 'claude', projectName: 'youcoded', originalPath: '/nope/youcoded',
    title: 'T ' + id.slice(0, 4), lastActive: '2026-07-26T00:00:00Z', createdAt: '2026-07-25T00:00:00Z',
    complete: false, priority: false, tags: ['x'], note: '',
    transcriptPath: `/space/claude/transcripts/youcoded/${id}.jsonl`,
    tombstone: false, sizeBytes: 1, turnCount: 1, firstTurnTs: '', lastTurnTs: '', ...over,
  };
}

function tmpIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-meta-'));
  fs.writeFileSync(path.join(dir, 'claude-meta.json'), JSON.stringify({
    v: 1, provider: 'claude', refreshedAt: '',
    conversations: { [A]: entry(A), [B]: entry(B), [C]: entry(C, { tombstone: true }) },
  }));
  fs.writeFileSync(path.join(dir, 'native-meta.json'), JSON.stringify({
    v: 1, provider: 'native', refreshedAt: '', conversations: {},
  }));
  return dir;
}

const deps = {
  resolveLocal: (rec: { projectName: string; originalPath: string }) => (rec.projectName === 'youcoded' ? '/local/youcoded' : null),
  transcriptExistsLocally: (_p: string, localPath: string, id: string) => id === A && localPath === '/local/youcoded',
  slugFor: (provider: string, localPath: string) => `${provider}:${localPath}`,
};

describe('readMetaFile', () => {
  it('returns null for a missing or unparseable file, never throws', async () => {
    // Both are ordinary states, not bugs: no index has been built yet, or a
    // refresh was interrupted mid-write. Throwing here would take down the
    // whole resolve call, and with it every card in the message.
    expect(readMetaFile('/nonexistent', 'claude')).toBeNull();
    const dir = tmpIndex();
    fs.writeFileSync(path.join(dir, 'claude-meta.json'), '{not json');
    expect(readMetaFile(dir, 'claude')).toBeNull();
  });

  it('returns null for JSON that parses but is not a meta file', async () => {
    const dir = tmpIndex();
    fs.writeFileSync(path.join(dir, 'claude-meta.json'), JSON.stringify({ v: 1, provider: 'claude' }));
    expect(readMetaFile(dir, 'claude')).toBeNull();
  });

  it('reads a well-formed file', async () => {
    expect(Object.keys(readMetaFile(tmpIndex(), 'claude')!.conversations)).toHaveLength(3);
  });
});

describe('resolveShortIds', () => {
  it('resolves exact, unique-prefix, ambiguous, and unknown', async () => {
    const r = await resolveShortIds([A, 'c0ff', 'a3f2', 'zzzz'], { dir: tmpIndex(), ...deps });
    expect(r[0]).toMatchObject({ status: 'ok', id: A, projectSlug: 'claude:/local/youcoded', projectPath: '/local/youcoded', missingProject: false, notSyncedYet: false });
    expect(r[1]).toMatchObject({ status: 'ok', id: C, tombstone: true });
    // 'a3f2' prefixes BOTH A and B — the CLI prints short ids, so this is a
    // routine collision, not an error state.
    expect(r[2]).toEqual({ status: 'ambiguous', query: 'a3f2', candidates: [A, B] });
    expect(r[3]).toEqual({ status: 'unknown', query: 'zzzz' });
  });

  it('prefers an exact id over a longer id it happens to prefix', async () => {
    // A full id that is also a prefix of nothing else must never come back
    // ambiguous just because some other row starts with the same characters.
    const dir = tmpIndex();
    const long = A + 'x';
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'claude-meta.json'), 'utf8'));
    file.conversations[long] = entry(long);
    fs.writeFileSync(path.join(dir, 'claude-meta.json'), JSON.stringify(file));
    expect((await resolveShortIds([A], { dir, ...deps }))[0]).toMatchObject({ status: 'ok', id: A });
  });

  it('reports notSyncedYet when the folder exists but the transcript is not materialized', async () => {
    expect((await resolveShortIds([B], { dir: tmpIndex(), ...deps }))[0]).toMatchObject({ status: 'ok', missingProject: false, notSyncedYet: true });
  });

  it('reports missingProject with empty slug/path when the folder is absent', async () => {
    expect((await resolveShortIds([A], { dir: tmpIndex(), ...deps, resolveLocal: () => null }))[0])
      .toMatchObject({ status: 'ok', missingProject: true, notSyncedYet: false, projectSlug: '', projectPath: '' });
  });

  it('refuses a query that is not hex — an id is the only thing this accepts', async () => {
    expect((await resolveShortIds(['../etc'], { dir: tmpIndex(), ...deps }))[0]).toEqual({ status: 'unknown', query: '../etc' });
    expect((await resolveShortIds(['abc'], { dir: tmpIndex(), ...deps }))[0]).toEqual({ status: 'unknown', query: 'abc' });
  });

  it('answers "unknown" for every query when no index exists at all, rather than throwing', async () => {
    const r = await resolveShortIds([A, 'c0ff'], { dir: '/nonexistent', ...deps });
    expect(r).toEqual([{ status: 'unknown', query: A }, { status: 'unknown', query: 'c0ff' }]);
  });

  it('searches BOTH lanes, and reports the lane it found the conversation on', async () => {
    const dir = tmpIndex();
    const nid = '7a21eeee-0000-4000-8000-000000000000';
    fs.writeFileSync(path.join(dir, 'native-meta.json'), JSON.stringify({
      v: 1, provider: 'native', refreshedAt: '',
      conversations: { [nid]: entry(nid, { provider: 'native' }) },
    }));
    expect((await resolveShortIds(['7a21'], { dir, ...deps }))[0]).toMatchObject({ status: 'ok', id: nid, provider: 'native' });
  });
});
