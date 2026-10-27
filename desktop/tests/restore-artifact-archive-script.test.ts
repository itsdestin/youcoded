import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// The owner-run restore script (desktop/scripts/restore-artifact-archive.mjs), run for real against a temp project.
const SCRIPT = path.resolve(__dirname, '../scripts/restore-artifact-archive.mjs');
let root: string;
const rec = (id: string) => ({ id, path: `gone/${id}.md`, kind: 'internal', absolutePath: null, lastModified: '2026-01-01T00:00:00Z', status: 'active',
  versions: [{ id: `v-${id}`, ts: '2026-01-01T00:00:00Z', sessionId: 's', type: 'edit', author: 'agent' }], comments: [], tags: [] });

function setup(sidecar: Record<string, unknown>) {
  const dot = path.join(root, '.youcoded');
  fs.mkdirSync(path.join(dot, 'artifacts-archive'), { recursive: true });
  fs.writeFileSync(path.join(dot, 'artifacts.json'), JSON.stringify(sidecar));
  fs.writeFileSync(path.join(dot, 'artifacts-archive', '2026-01-a.jsonl.gz'), zlib.gzipSync(JSON.stringify(rec('D1')) + '\n'));
  return dot;
}
const run = () => spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-script-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('restore-artifact-archive.mjs', () => {
  it('a corrupt archive file is skipped with a warning naming it, and the good archive is restored', () => {
    const dot = setup({ updatedAt: '2026-01-01T00:00:00Z', artifacts: [] });
    fs.writeFileSync(path.join(dot, 'artifacts-archive', '0000-corrupt.jsonl.gz'), 'not gzip');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('0000-corrupt.jsonl.gz');
    expect(JSON.parse(fs.readFileSync(path.join(dot, 'artifacts.json'), 'utf8')).artifacts.map((a: { id: string }) => a.id)).toEqual(['D1']);
  });

  it.each([['missing', undefined], ['invalid', 'not a date']])('a %s updatedAt no longer crashes after the backup: it gets a valid, current stamp', (_n, bad) => {
    const dot = setup({ ...(bad === undefined ? {} : { updatedAt: bad }), artifacts: [] });
    const before = Date.now();
    const r = run();
    expect(r.status).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(dot, 'artifacts.json'), 'utf8'));
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(after.artifacts.map((a: { id: string }) => a.id)).toEqual(['D1']);
  });

  it('a valid updatedAt in the future still moves strictly forward', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const dot = setup({ updatedAt: future, artifacts: [] });
    expect(run().status).toBe(0);
    expect(Date.parse(JSON.parse(fs.readFileSync(path.join(dot, 'artifacts.json'), 'utf8')).updatedAt)).toBe(Date.parse(future) + 1);
  });
});
