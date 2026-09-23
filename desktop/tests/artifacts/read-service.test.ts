import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendVersion } from '../../src/main/artifacts/artifact-store';
import { listSessionFiles } from '../../src/main/artifacts/read-service';

// A resumed Claude Code conversation runs under a NEW desktop session id, so
// its files list used to hold only what the new turns touched. Versions now
// carry the conversation id too, and the list matches either.
describe('listSessionFiles', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rs-list-'));
    mkdirSync(join(projectRoot, '.youcoded'));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3 }));

  const write = (path: string, sessionId: string, conversationId?: string) =>
    appendVersion(projectRoot, 'proj', 'proj', {
      path, kind: 'internal', absolutePath: null, sessionId, type: 'create', author: 'agent',
      toolUseId: `toolu_${path}`, ...(conversationId ? { conversationId } : {}),
    });

  it('includes files written before a resume, under the earlier desktop session', async () => {
    await write('before.md', 'desk-1', 'claude-X');
    await write('after.md', 'desk-2', 'claude-X');
    await write('unrelated.md', 'desk-3', 'claude-Y');
    const r = await listSessionFiles('desk-2', projectRoot, 'claude-X');
    expect(r.artifacts.map((a) => a.path).sort()).toEqual(['after.md', 'before.md']);
  });

  it('matches the desktop session alone when no conversation id is known', async () => {
    await write('before.md', 'desk-1', 'claude-X');
    await write('after.md', 'desk-2');
    const r = await listSessionFiles('desk-2', projectRoot);
    expect(r.artifacts.map((a) => a.path)).toEqual(['after.md']);
  });
});
