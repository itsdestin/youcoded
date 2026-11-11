import { describe, it, expect } from 'vitest';
import { isHiddenPath } from './hidden-files';

describe('isHiddenPath', () => {
  it('hides dot-named files and anything inside a dot-named folder, nothing else', () => {
    expect(isHiddenPath('.claude.json')).toBe(true);
    expect(isHiddenPath('docs/.gitignore')).toBe(true);
    expect(isHiddenPath('.github/workflows/ci.yml')).toBe(true);
    expect(isHiddenPath('src\\.env')).toBe(true);
    expect(isHiddenPath('README.md')).toBe(false);
    expect(isHiddenPath('notes/v1.2.md')).toBe(false);
  });
});
