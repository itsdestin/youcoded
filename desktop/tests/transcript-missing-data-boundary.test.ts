// M5 review fix F1: the readers of events off DISK must survive a line that has a
// `type` and `uuid` but NO `data` object, exactly as they did before the union
// (they read `event.data?.x`). `looseData` once returned `event.data` as-is, so
// each of these threw — a failed resume for that session.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { SessionStore, validatedDeltaReferences, type NativeSessionHeader } from '../src/main/harness/session-store';
import { AcceptedHistoryStore } from '../src/main/harness/accepted-history-store';
import { restorePortableHistory } from '../src/main/harness/history-rebuild';
import { compactionSourceDigest } from '../src/main/harness/compaction-record';
import { looseData } from '../src/shared/types';
import { malformedEv } from './helpers/transcript-events';

const noData = (type: string, uuid: string) => {
  const e: any = malformedEv(type, undefined, { uuid, sessionId: 's-1', timestamp: 0 });
  delete e.data;
  return e;
};

describe('looseData', () => {
  it('reads a data-less event as an empty payload', () => {
    expect(looseData(noData('user-message', 'u1'))).toEqual({});
  });
});

describe('SessionStore with a data-less line on disk', () => {
  let root: string;
  const HEADER: NativeSessionHeader = { v: 1, sessionId: 's-1', harnessId: 'h', binding: { providerId: 'p', modelId: 'm' }, cwd: '/tmp/proj', createdAt: 1 };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-nodata-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('validatedDeltaReferences answers null', () => {
    expect(validatedDeltaReferences(noData('assistant-text', 'u1'))).toBeNull();
  });
  it('hydrateReferences does not throw', () => {
    const store = new SessionStore(new NativeHome(root));
    expect(() => store.hydrateReferences('s-1', [noData('user-message', 'u1'), noData('assistant-text', 'u2')])).not.toThrow();
  });
  it('append of a data-less event does not throw', async () => {
    const store = new SessionStore(new NativeHome(root));
    await store.create(HEADER);
    await expect(store.append(HEADER.cwd, noData('user-message', 'u1'))).resolves.toBeUndefined();
  });
});

describe('history-rebuild with a data-less anchor', () => {
  it('restores exactly as it does for an anchor whose data is {}', () => {
    const run = (anchor: any) => {
      const ref = { eventUuid: 'tail', anchorUuid: 'tail', type: 'user-message', start: 0, end: 2 };
      const old = malformedEv('user-message', { text: 'old' }, { uuid: 'old', sessionId: 's-1', timestamp: 0 });
      const record: any = { v: 1, generation: 1, sourceRevision: 2, resumeFrom: ref, coveredThrough: { ...ref, eventUuid: 'old', anchorUuid: 'old', end: JSON.stringify(old.data).length } };
      const marker: any = malformedEv('compact-summary', { summary: 'memory', compactionRecord: record }, { uuid: 'sum', sessionId: 's-1', timestamp: 0 });
      record.sourceDigest = compactionSourceDigest([old, anchor], 'memory', record);
      return restorePortableHistory([old, anchor, marker]);
    };
    const withEmpty = malformedEv('user-message', {}, { uuid: 'tail', sessionId: 's-1', timestamp: 0 });
    expect(() => run(noData('user-message', 'tail'))).not.toThrow();
    expect(run(noData('user-message', 'tail'))).toEqual(run(withEmpty));
  });
});

describe('AcceptedHistoryStore with a data-less line on disk', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-nodata-ah-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  it('publish and restore treat it as an empty payload, not a crash', async () => {
    const transcript = path.join(root, 'session.jsonl');
    const run = async (line: object, tag: string) => {
      fs.writeFileSync(transcript, [JSON.stringify({ v: 1, sessionId: 's' }), JSON.stringify(line), ''].join('\n'));
      const store = new AcceptedHistoryStore(path.join(root, `ud-${tag}`));
      const revision = await store.invalidate('s', 'history-mutation');
      const published = await store.publish({
        sessionId: 's', transcriptPath: transcript, binding: 'b', assemblyDigest: 'a', revision,
        references: [{ eventUuid: 'u1', anchorUuid: 'u1', type: 'user-message', start: 0, end: 2 }],
        messages: [{ role: 'user', content: '' }] as any,
      });
      const restored = published.ok ? await store.restore({ sessionId: 's', transcriptPath: transcript, binding: 'b', assemblyDigest: 'a' }) : published;
      return { published, restored };
    };
    const base = { type: 'user-message', sessionId: 's', uuid: 'u1', timestamp: 0 };
    await expect(run(base, 'a')).resolves.toBeDefined();
    expect(await run(base, 'b')).toEqual(await run({ ...base, data: {} }, 'c'));
  });
});
