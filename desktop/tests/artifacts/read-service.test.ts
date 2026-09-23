import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { appendVersion, writeSidecar } from '../../src/main/artifacts/artifact-store';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';
import { listSessionFiles, readArtifactText, checkArtifactExistence } from '../../src/main/artifacts/read-service';

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

// A record the agent wrote through `../` that was not repaired. It used to read
// "no longer on disk" whether or not the file was there; each refusal now says
// what actually happened.
describe('reading a ../ record', () => {
  let parent: string;
  let projectRoot: string;
  beforeEach(async () => {
    // Under the (sandboxed) home folder: only a project strictly below home can
    // vouch for a `../` record (review 2026-09-23, F1).
    parent = mkdtempSync(join(homedir(), 'rs-dotdot-'));
    projectRoot = join(parent, 'proj');
    mkdirSync(join(projectRoot, '.youcoded'), { recursive: true });
    mkdirSync(join(projectRoot, 'sub'), { recursive: true });
    mkdirSync(join(parent, 'elsewhere', '.ssh'), { recursive: true });
    writeFileSync(join(projectRoot, 'here.md'), 'inside');
    writeFileSync(join(parent, 'elsewhere', 'notes.md'), 'outside');
    writeFileSync(join(parent, 'elsewhere', '.ssh', 'id_rsa'), 'PRIVATE');
    const rec = (id: string, rel: string) => ({
      id, path: rel.split('/').pop(), kind: 'external', absolutePath: rel,
      lastModified: '2026-08-13T00:00:00.000Z', status: 'active', versions: [], comments: [], tags: [],
    });
    await writeSidecar(projectRoot, null, {
      $schema: SIDECAR_SCHEMA_VERSION, projectId: 'p', name: 'proj',
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
      artifacts: [
        rec('inside', 'sub/../here.md'),
        rec('outside', '../elsewhere/notes.md'),
        rec('planted', '../elsewhere/.ssh/id_rsa'),
        rec('gone', '../elsewhere/never-was.md'),
      ],
      manualExcludes: [], manualIncludes: [],
    } as any);
  });
  afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 3 }));

  it('opens one that lands inside the project', async () => {
    expect(await readArtifactText(projectRoot, 'inside')).toMatchObject({ ok: true, content: 'inside' });
  });

  it('refuses one outside every project folder as exactly that — without saying where it is', async () => {
    // The answer also reaches remote browsers (F5): no location rides along.
    expect(await readArtifactText(projectRoot, 'outside')).toEqual({ ok: false, error: 'outside-projects' });
  });

  it('hands the byte viewers the judged location of a trusted one', async () => {
    const r = await readArtifactText(projectRoot, 'inside') as any;
    expect(r.resolvedPath).toMatch(/\/proj\/here\.md$/);
  });

  it('refuses a planted record pointing at a secret as protected, without echoing its path', async () => {
    const r = await readArtifactText(projectRoot, 'planted') as any;
    expect(r).toEqual({ ok: false, error: 'protected-path' });
  });

  it('says a file is gone only when it is', async () => {
    expect(await readArtifactText(projectRoot, 'gone')).toMatchObject({ ok: true, orphan: true });
    const { missingIds } = await checkArtifactExistence(projectRoot, ['inside', 'outside', 'planted', 'gone']);
    expect(missingIds).toEqual(['gone']);
  });
});

