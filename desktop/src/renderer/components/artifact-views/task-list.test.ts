import { describe, it, expect } from 'vitest';
import { findTaskMarkers, setTaskChecked } from './task-list';

describe('task list ticking', () => {
  const md = '# Plants\n- [ ] water\n- [x] prune\n  - [ ] nested\n\n```\n- [ ] not a task\n```\n1. [ ] numbered\n';
  it('finds markers in order and skips code fences', () => {
    expect(findTaskMarkers(md)).toHaveLength(4);
  });
  it('ticks and unticks exactly the chosen item', () => {
    expect(setTaskChecked(md, 0, true)).toContain('- [x] water');
    expect(setTaskChecked(md, 1, false)).toContain('- [ ] prune');
    const out = setTaskChecked(md, 3, true)!;
    expect(out).toContain('1. [x] numbered');
    expect(out).toContain('- [ ] not a task');
  });
  it('returns null for a missing item', () => {
    expect(setTaskChecked(md, 9, true)).toBeNull();
  });
});
