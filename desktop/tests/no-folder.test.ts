// Pins "No folder" (first-run guide round 2, N-6): the renderer's sentinel
// becomes <userData>/No folder, created on demand; any real cwd passes
// through untouched — including an empty one, which keeps its existing
// "fall back to home" meaning in the session manager.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveNoFolderCwd } from '../src/main/no-folder';
import { NO_FOLDER_CWD, NO_FOLDER_DIR_NAME, isNoFolderCwd } from '../src/shared/no-folder';

describe('No folder sessions', () => {
  it('recognises only the sentinel', () => {
    expect(isNoFolderCwd(NO_FOLDER_CWD)).toBe(true);
    expect(isNoFolderCwd('')).toBe(false);
    expect(isNoFolderCwd('/home/someone/No folder')).toBe(false);
  });

  it('swaps the sentinel for an app-owned folder that then exists', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-no-folder-'));
    try {
      const out = resolveNoFolderCwd({ cwd: NO_FOLDER_CWD, name: 'x' }, userData);
      expect(out.cwd).toBe(path.join(userData, NO_FOLDER_DIR_NAME));
      expect(fs.statSync(out.cwd!).isDirectory()).toBe(true);
      expect(out.name).toBe('x');
      // The name is what every header and pill shows for the session.
      expect(path.basename(out.cwd!)).toBe('No folder');
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('leaves every other cwd alone, empty included', () => {
    const a = { cwd: '/some/project' };
    expect(resolveNoFolderCwd(a, '/ud')).toBe(a);
    const b = { cwd: '' };
    expect(resolveNoFolderCwd(b, '/ud')).toBe(b);
  });
});
