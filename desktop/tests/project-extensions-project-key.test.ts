import { describe, it, expect, afterEach } from 'vitest';
import { resolveProjectKey, type ProjectKeyCandidate } from '../src/main/project-extensions/project-key';

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
afterEach(() => setPlatform(realPlatform));

describe('resolveProjectKey', () => {
  it('returns null for an undefined/empty cwd', () => {
    expect(resolveProjectKey(undefined, [])).toBeNull();
    expect(resolveProjectKey('', [])).toBeNull();
  });

  it('returns null (B-1) when no candidate matches', () => {
    const candidates: ProjectKeyCandidate[] = [{ path: '/home/dest/Other' }];
    expect(resolveProjectKey('/home/dest/Project', candidates)).toBeNull();
  });

  it('resolves an unsynced folder to its canonical path', () => {
    const candidates: ProjectKeyCandidate[] = [{ path: '/home/dest/Project' }];
    expect(resolveProjectKey('/home/dest/Project', candidates)).toBe('/home/dest/Project');
  });

  it('resolves a synced project to its sync name, not its path', () => {
    const candidates: ProjectKeyCandidate[] = [{ path: '/home/dest/YouCoded/Projects/Recipes', syncName: 'Recipes' }];
    expect(resolveProjectKey('/home/dest/YouCoded/Projects/Recipes', candidates)).toBe('Recipes');
  });

  it('matches EXACTLY, never as a prefix — "proj" must not match "project" or vice versa', () => {
    const candidates: ProjectKeyCandidate[] = [{ path: '/home/dest/proj' }];
    expect(resolveProjectKey('/home/dest/project', candidates)).toBeNull();
    expect(resolveProjectKey('/home/dest/project/sub', candidates)).toBeNull();

    const reversed: ProjectKeyCandidate[] = [{ path: '/home/dest/project' }];
    expect(resolveProjectKey('/home/dest/proj', reversed)).toBeNull();
  });

  it('never matches a subdirectory of a saved folder (no ancestor climbing)', () => {
    // WHY this matters more than it looks: the app seeds a "Home" saved
    // folder at the user's home directory. An ancestor rule here would match
    // every cwd under $HOME to Home and defeat B-1 for nearly everything.
    const candidates: ProjectKeyCandidate[] = [{ path: '/home/dest' }];
    expect(resolveProjectKey('/home/dest/some/nested/project', candidates)).toBeNull();
  });

  it('normalizes backslashes so a Windows-spelled cwd matches a forward-slash folder', () => {
    const candidates: ProjectKeyCandidate[] = [{ path: 'C:\\Users\\dest\\Project' }];
    expect(resolveProjectKey('C:\\Users\\dest\\Project', candidates)).toBe('c:/Users/dest/Project');
  });

  it('matches case-insensitively on Windows only', () => {
    setPlatform('win32');
    const candidates: ProjectKeyCandidate[] = [{ path: 'C:\\Users\\Dest\\Project' }];
    expect(resolveProjectKey('c:\\users\\dest\\project', candidates)).toBe('c:/Users/Dest/Project');
  });

  it('is case-SENSITIVE off Windows — same spelling difference does not match', () => {
    setPlatform('linux');
    const candidates: ProjectKeyCandidate[] = [{ path: '/home/Dest/Project' }];
    expect(resolveProjectKey('/home/dest/project', candidates)).toBeNull();
  });

  it('picks the first matching candidate', () => {
    const candidates: ProjectKeyCandidate[] = [
      { path: '/home/dest/A', syncName: 'A' },
      { path: '/home/dest/A', syncName: 'ADuplicate' },
    ];
    expect(resolveProjectKey('/home/dest/A', candidates)).toBe('A');
  });
});
