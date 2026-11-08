import { describe, it, expect } from 'vitest';
import { commentTargetFor } from '../src/renderer/components/comments/comment-target';

describe('where a file\'s comments are kept', () => {
  it('a file in the project keeps its comments under the project, by its project path', () => {
    expect(commentTargetFor({ kind: 'internal', path: 'docs/plan.md', absolutePath: null }, '/home/me/proj'))
      .toEqual({ path: 'docs/plan.md', projectRoot: '/home/me/proj' });
  });

  it('a file outside the project keeps its comments by its real location, never under the project by name', () => {
    expect(commentTargetFor({ kind: 'external', path: 'roundup.md', absolutePath: '/home/me/other/roundup.md' }, '/home/me/proj'))
      .toEqual({ path: '/home/me/other/roundup.md', projectRoot: undefined });
  });
});
