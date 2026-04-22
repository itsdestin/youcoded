// desktop/tests/dev-idempotency.test.ts
import { describe, it, expect } from 'vitest';
import { classifyExistingWorkspace } from '../src/main/dev-tools';

describe('classifyExistingWorkspace', () => {
  it('treats https:// remote as the workspace', () => {
    expect(classifyExistingWorkspace('https://github.com/itsdestin/youcoded-dev'))
      .toBe('workspace');
    expect(classifyExistingWorkspace('https://github.com/itsdestin/youcoded-dev.git'))
      .toBe('workspace');
    expect(classifyExistingWorkspace('https://github.com/itsdestin/youcoded-dev/'))
      .toBe('workspace');
  });

  it('treats git@ remote as the workspace', () => {
    expect(classifyExistingWorkspace('git@github.com:itsdestin/youcoded-dev.git'))
      .toBe('workspace');
  });

  it('treats unrelated remote as wrong-remote', () => {
    expect(classifyExistingWorkspace('https://github.com/someone-else/youcoded-dev'))
      .toBe('wrong-remote');
    expect(classifyExistingWorkspace('https://github.com/itsdestin/some-other-repo'))
      .toBe('wrong-remote');
  });

  it('treats empty string (no remote) as not-git', () => {
    expect(classifyExistingWorkspace('')).toBe('not-git');
  });
});
