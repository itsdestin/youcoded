import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSessionTranscriptMetaCached, __clearTranscriptMetaCacheForTests } from '../src/main/session-browser';

const line = (o: object) => JSON.stringify(o) + '\n';
function write(p: string, text: string) {
  fs.writeFileSync(p, line({ type: 'user', timestamp: '2026-09-18T00:00:00Z', message: { role: 'user', content: text } }) + 'x'.repeat(600));
}

describe('transcript meta cache', () => {
  let dir: string;
  beforeEach(() => { __clearTranscriptMetaCacheForTests(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmc-')); });

  // WHY: root can still read a chmod-000 file, and Windows ignores POSIX mode
  // bits entirely — CI runs both, so this variant is skipped there. The
  // open-spy test below proves the same "no second read" behavior everywhere.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'returns the same object for an unchanged file without re-reading it',
    async () => {
      const p = path.join(dir, 'a.jsonl'); write(p, 'hello');
      const st = fs.statSync(p);
      const a = await readSessionTranscriptMetaCached(p, st, true);
      fs.chmodSync(p, 0o000); // a second READ would now fail and return nulls
      try {
        const b = await readSessionTranscriptMetaCached(p, st, true);
        expect(b).toBe(a);
      } finally { fs.chmodSync(p, 0o644); }
    },
  );

  it('re-reads when size or mtime change', async () => {
    const p = path.join(dir, 'a.jsonl'); write(p, 'hello');
    const a = await readSessionTranscriptMetaCached(p, fs.statSync(p), true);
    write(p, 'a different and longer first message');
    const b = await readSessionTranscriptMetaCached(p, fs.statSync(p), true);
    expect(b).not.toBe(a);
  });

  it('two scans asking at the same moment share ONE read (Projects open starts two)', async () => {
    const p = path.join(dir, 'a.jsonl'); write(p, 'hello');
    const st = fs.statSync(p);
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const [a, b] = await Promise.all([
        readSessionTranscriptMetaCached(p, st, true),
        readSessionTranscriptMetaCached(p, st, true),
      ]);
      expect(b).toBe(a);
      expect(open.mock.calls.filter((c) => c[0] === p).length).toBe(1);
    } finally { open.mockRestore(); }
  });

  it('does not remember a failed read', async () => {
    const p = path.join(dir, 'gone.jsonl');
    const st = { size: 900, mtimeMs: 1 };
    const a = await readSessionTranscriptMetaCached(p, st, true);   // file absent → all nulls
    expect(a.lastTimestampMs).toBeNull();
    write(p, 'now it exists');
    const b = await readSessionTranscriptMetaCached(p, st, true);   // SAME stat on purpose
    expect(b.lastTimestampMs).not.toBeNull();
  });
});
