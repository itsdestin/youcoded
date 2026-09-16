// Edit and Write on the SAME file never interleave, now that their reads and
// writes are asynchronous (2026-09-16 C4). Two overlapping Edits must both
// land, the second seeing the first's bytes; two Writes must end with the
// last one's content and a fingerprint the model can Edit against.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/main/harness/tools/read';
import { EditTool } from '../src/main/harness/tools/edit';
import { WriteTool } from '../src/main/harness/tools/write';
import { withPathLock, __pathLocksHeld } from '../src/main/harness/tools/path-lock';
import type { ToolContext } from '../src/main/harness/tools/types';

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-path-lock-'));
  ctx = { sessionId: 'lock-test', cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [] } as ToolContext;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('withPathLock', () => {
  it('serialises work on one key and releases the chain afterwards', async () => {
    const order: string[] = [];
    const slow = withPathLock('k', async () => { await new Promise((r) => setTimeout(r, 15)); order.push('slow'); });
    const fast = withPathLock('k', async () => { order.push('fast'); });
    const other = withPathLock('other', async () => { order.push('other'); });
    await Promise.all([slow, fast, other]);
    expect(order).toEqual(['other', 'slow', 'fast']);
    await new Promise((r) => setTimeout(r, 0));
    expect(__pathLocksHeld()).toBe(0);
  });

  it('a rejected operation does not block the next one on the same key', async () => {
    await expect(withPathLock('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(withPathLock('k', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('overlapping Edits and Writes on one file', () => {
  it('two parallel Edits both land', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'alpha\nbeta\ngamma\n');
    await ReadTool.execute({ file_path: 'f.txt' }, ctx);
    const [a, b] = await Promise.all([
      EditTool.execute({ file_path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }, ctx),
      EditTool.execute({ file_path: 'f.txt', old_string: 'gamma', new_string: 'GAMMA' }, ctx),
    ]);
    expect(a.isError ?? false).toBe(false);
    expect(b.isError ?? false).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  it('two parallel Writes end with the last content and a current fingerprint', async () => {
    fs.writeFileSync(path.join(dir, 'w.txt'), 'start\n');
    await ReadTool.execute({ file_path: 'w.txt' }, ctx);
    await Promise.all([
      WriteTool.execute({ file_path: 'w.txt', content: 'first\n' }, ctx),
      WriteTool.execute({ file_path: 'w.txt', content: 'second\n' }, ctx),
    ]);
    expect(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8')).toBe('second\n');
    // The registry holds the LAST write's fingerprint, so an Edit is accepted.
    const r = await EditTool.execute({ file_path: 'w.txt', old_string: 'second', new_string: 'third' }, ctx);
    expect(r.isError ?? false).toBe(false);
  });
});
