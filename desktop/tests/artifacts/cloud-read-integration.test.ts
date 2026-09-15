import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ read: vi.fn(), probe: vi.fn() }));
vi.mock('../../src/main/cloud-files/path-access', () => ({
  readPath: io.read,
  pathAvailability: io.probe,
  passiveRead: vi.fn(async () => null),
}));
vi.mock('../../src/main/artifacts/artifact-store', () => ({ readSidecarShared: vi.fn(async () => null), runSidecarMigration: vi.fn() }));
vi.mock('../../src/main/artifacts/write-authorization', () => ({
  authorizeArtifactRead: vi.fn(async (_root, target) => ({ ok: true, realPath: target })),
  isAbsoluteRecorded: vi.fn(() => true),
}));
vi.mock('../../src/main/saved-folders', () => ({ readFolders: () => [{ path: '/project' }] }));
vi.mock('../../src/main/artifacts/central-index', () => ({ listProjects: async () => [] }));
import { readArtifactText, readArtifactBytes } from '../../src/main/artifacts/read-service';
import fs from 'fs';
import { EDIT_MAX_BYTES } from '../../src/shared/artifacts/editable-path-policy';

describe('production artifact content gate', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('returns needs-download without touching content, including default preview callers', async () => {
    const blocked = { ok: false, error: 'needs-download', path: '/project/online.md', name: 'online.md', operationToken: 'server-token' };
    io.read.mockResolvedValue(blocked);
    const content = vi.spyOn(fs.promises, 'readFile');
    const result = await readArtifactText('/project', 'online.md');
    expect(result).toEqual(blocked);
    expect(content).not.toHaveBeenCalled();
    expect(io.read).toHaveBeenCalledWith('/project/online.md', expect.objectContaining({ intent: 'preview' }));
    content.mockRestore();
  });
  it('Windows preview preserves the text prefix and real size instead of claiming a full read', async () => {
    io.read.mockResolvedValue({ ok: true, bytes: Buffer.from('prefix text'), sizeBytes: EDIT_MAX_BYTES + 1, mtimeMs: 42 });
    const result = await readArtifactText('/project', 'large.md');
    expect(result).toMatchObject({ ok: true, truncated: true, sizeBytes: EDIT_MAX_BYTES + 1 });
    expect(io.read).toHaveBeenCalledWith('/project/large.md', expect.objectContaining({ prefix: { bytes: EDIT_MAX_BYTES } }));
  });
  it('binary production service also refuses before reading bytes', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath').mockImplementation(async p => String(p));
    const content = vi.spyOn(fs.promises, 'readFile');
    io.read.mockResolvedValue({ ok: false, error: 'needs-download', path: '/project/photo.png', name: 'photo.png' });
    expect(await readArtifactBytes('/project/photo.png')).toMatchObject({ ok: false, error: 'needs-download' });
    expect(content).not.toHaveBeenCalled();
    expect(io.read).toHaveBeenCalledWith('/project/photo.png', expect.objectContaining({ intent: 'preview' }));
    content.mockRestore(); realpath.mockRestore();
  });
  it('passes exact-operation consent through the same authorized production path', async () => {
    io.read.mockResolvedValue({ ok: true, bytes: Buffer.from('approved file'), sizeBytes: 13, mtimeMs: 42 });
    const result = await readArtifactText('/project', 'online.md', { intent: 'explicit', operationToken: 'server-token', owner: 'window:1' } as any);
    expect(result).toMatchObject({ ok: true, content: 'approved file' });
    expect(io.read).toHaveBeenCalledWith('/project/online.md', expect.objectContaining({ intent: 'explicit', operationToken: 'server-token', owner: 'window:1' }));
  });
});
