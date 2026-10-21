import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { createIndexWorkerRunner } from '../src/main/chatsearch-index/index-worker-runner';
import { refreshChatsearchIndex, resolveTranscriptPathTwoStep } from '../src/main/chatsearch-index/refresh-core';
import { createConversationStore } from '../src/main/conversations/conversation-store';
import { createTagRegistry } from '../src/main/conversations/tag-registry';
import { ccProjectSlug, nativeStoreSlug } from '../src/main/slug-encoding';
import type { ConversationRecord } from '../src/main/conversations/store-core';

let tmp: string;
let runner: ReturnType<typeof createIndexWorkerRunner>;
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const stamp = '2026-07-26T18:04:11.000Z';

// WHY compile the real dependency graph: a mocked Worker cannot catch a missing
// sibling entry, an Electron dependency leaking into Node, or divergent output.
// Emit only into this test's temporary directory, never desktop/dist or user data.
function compileWorker(out: string): string {
  const compiled = new Set<string>();
  function compile(source: string): string {
    const target = path.join(out, path.relative(sourceRoot, source).replace(/\.ts$/, '.js'));
    if (compiled.has(source)) return target;
    compiled.add(source);
    const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code);
    for (const match of code.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      compile(path.resolve(path.dirname(source), match[1] + '.ts'));
    }
    return target;
  }
  return compile(path.join(sourceRoot, 'main/chatsearch-index/index-worker.ts'));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-index-worker-test-'));
  const entry = compileWorker(path.join(tmp, 'compiled'));
  runner = createIndexWorkerRunner({ spawn: (job) => new Worker(entry, { workerData: job }) });
});
afterEach(() => {
  runner.stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('chatsearch worker output', () => {
  it('preserves both lanes, tag folding, path safety, incremental repair and the shared lock', async () => {
    const storeRoot = path.join(tmp, 'records');
    const tagsRoot = path.join(tmp, 'tags');
    const coreHome = path.join(tmp, 'core');
    const workerHome = path.join(tmp, 'worker');
    const store = createConversationStore(storeRoot);
    const localPath = (home: string, provider: string, rec: ConversationRecord) => provider === 'claude'
      ? path.join(home, '.claude', 'projects', ccProjectSlug(rec.originalPath), `${rec.id}.jsonl`)
      : path.join(home, '.youcoded', 'sessions', nativeStoreSlug(rec.originalPath), `${rec.id}.jsonl`);
    const transcript = (provider: string, id: string) => path.join(storeRoot, provider, 'transcripts', 'project', `${id}.jsonl`);
    const line = (provider: string, n: number) => JSON.stringify(provider === 'claude'
      ? { type: 'user', uuid: `u${n}`, promptId: `p${n}`, timestamp: stamp, message: { role: 'user', content: `searchable turn ${n}` } }
      : { type: 'user-message', timestamp: Date.parse(stamp), data: { text: `searchable turn ${n}` } }) + '\n';
    const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    const records: ConversationRecord[] = [];
    for (const provider of ['claude', 'native']) {
      for (const id of ['synced', 'local-first', 'local-missing', 'missing', 'escape', 'wrong-lane', 'linked']) {
        if (id === 'linked' && process.platform === 'win32') continue;
        const rec: ConversationRecord = {
          schema: 1, id, provider, projectName: 'project', originalPath: id.startsWith('local-') ? '/projects/local history' : '',
          title: 'Synthetic conversation', lastActive: stamp, device: 'fixture',
          flags: { 'tag:tag1': { value: true, updatedAt: stamp } }, createdAt: stamp, note: '', noteUpdatedAt: stamp,
          transcriptRef: id === 'escape' ? '../outside.jsonl' : id === 'wrong-lane'
            ? `${provider === 'claude' ? 'native' : 'claude'}/transcripts/project/synced.jsonl`
            : `${provider}/transcripts/project/${id}.jsonl`,
        };
        records.push(rec);
        write(path.join(storeRoot, provider, `${id}.json`), JSON.stringify(rec));
        const header = provider === 'native' ? '{"version":1}\n' : '';
        if (id === 'synced' || id.startsWith('local-')) write(transcript(provider, id), header + line(provider, 0));
        if (id === 'local-first') for (const home of [coreHome, workerHome]) write(localPath(home, provider, rec), header + line(provider, 1) + line(provider, 2));
        if (id === 'linked') fs.symlinkSync('synced.jsonl', transcript(provider, id));
      }
    }
    const tag = { schema: 1, id: 'tag1', label: 'Old label', labelUpdatedAt: stamp, createdAt: stamp };
    write(path.join(tagsRoot, 'tag1.json'), JSON.stringify(tag));
    write(path.join(tagsRoot, 'tag1-conflict.json'), JSON.stringify({ ...tag, label: 'Folded label', labelUpdatedAt: '2026-07-27T18:04:11.000Z' }));
    write(path.join(tagsRoot, 'corrupt.json'), '{broken');
    const snapshot = (home: string) => {
      const dir = path.join(home, '.youcoded/chatsearch');
      return Object.fromEntries(fs.readdirSync(dir).filter(name => !name.includes('.tmp-')).sort().map(name => {
        const raw = fs.readFileSync(path.join(dir, name), 'utf8');
        if (!name.endsWith('-meta.json')) return [name, raw];
        const data = JSON.parse(raw);
        delete data.refreshedAt;
        for (const rec of Object.values(data.conversations) as { transcriptPath: string }[]) rec.transcriptPath = rec.transcriptPath.replace(home, '<home>');
        return [name, data];
      }));
    };
    const parity = async (root: string | null = tagsRoot) => {
      const lanes = await Promise.all((['claude', 'native'] as const).map(async provider => ({
        provider, lane: provider, records: await store.list(provider),
        resolveTranscriptPath: (rec: ConversationRecord) => resolveTranscriptPathTwoStep(rec, localPath(coreHome, provider, rec), storeRoot),
      })));
      const tags = root === null ? [] : await createTagRegistry(root).list().catch(() => []);
      expect(await refreshChatsearchIndex({ homeRoot: coreHome, storeRoot, lanes, tagLabels: new Map(tags.map(tag => [tag.id, tag.label])) })).toBe(true);
      expect(await runner.run({ homeRoot: workerHome, storeRoot, tagsRoot: root })).toBe(true);
      expect(snapshot(workerHome)).toEqual(snapshot(coreHome));
    };
    await parity();
    for (const provider of ['claude', 'native']) {
      const data = snapshot(workerHome)[`${provider}-meta.json`];
      expect(data.conversations.synced.turnCount).toBe(1);
      expect(data.conversations.synced.tags).toEqual(['Folded label']);
      expect(data.conversations['local-first'].turnCount).toBe(2);
      expect(data.conversations['local-first'].transcriptPath).toBe(localPath(workerHome, provider, data.conversations['local-first']).replace(workerHome, '<home>'));
      expect(data.conversations['local-missing'].turnCount).toBe(1);
      expect(data.conversations['local-missing'].transcriptPath).toBe(transcript(provider, 'local-missing'));
      expect(data.conversations.missing.tombstone).toBe(true);
      expect(data.conversations['wrong-lane']).toBeUndefined();
      if (process.platform !== 'win32') expect(data.conversations.linked.turnCount).toBe(0);
    }
    await parity(null);
    expect(snapshot(workerHome)['claude-meta.json'].conversations.synced.tags).toEqual([]);
    await parity(path.join(tmp, 'absent-tags'));
    await parity(); // unchanged
    for (const provider of ['claude', 'native']) fs.appendFileSync(transcript(provider, 'synced'), line(provider, 3));
    await parity(); // growing
    for (const provider of ['claude', 'native']) write(transcript(provider, 'synced'), (provider === 'native' ? '{"version":1}\n' : '') + line(provider, 0));
    await parity(); // shrunk
    for (const home of [coreHome, workerHome]) for (const provider of ['claude', 'native']) fs.appendFileSync(path.join(home, '.youcoded/chatsearch', `${provider}-turns.jsonl`), '{"orphaned":"interrupted append"}\n');
    await parity();
    for (const provider of ['claude', 'native']) fs.unlinkSync(transcript(provider, 'synced'));
    await parity();
    const before = snapshot(workerHome);
    const lock = path.join(workerHome, '.youcoded/chatsearch/.build-lock');
    write(path.join(lock, 'owner'), 'other builder');
    expect(await runner.run({ homeRoot: workerHome, storeRoot, tagsRoot })).toBe(false);
    expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toBe('other builder');
    fs.rmSync(lock, { recursive: true });
    expect(snapshot(workerHome)).toEqual(before);
    for (const rec of records) fs.unlinkSync(path.join(storeRoot, rec.provider, `${rec.id}.json`));
    await parity();
    expect(snapshot(workerHome)['claude-meta.json'].conversations).toEqual(before['claude-meta.json'].conversations);
  });
});
