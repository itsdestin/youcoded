import { describe, it, expect } from 'vitest';
import { gitChipLabel } from '../src/renderer/state/git-chip-label';

// The Git Branch chip names the repo first and drops the generic "session/" prefix (Destin, 2026-10-16).
describe('gitChipLabel', () => {
  it('puts the repo first and drops session/', () => {
    expect(gitChipLabel('youcoded-dev/session/work-cards-20261014')).toBe('youcoded-dev · work-cards-20261014');
  });
  it('keeps prefixes that say something', () => {
    expect(gitChipLabel('youcoded/feat/specialists-plans-ui')).toBe('youcoded · feat/specialists-plans-ui');
  });
  it('leaves a plain branch on master alone apart from the separator', () => {
    expect(gitChipLabel('youcoded/master')).toBe('youcoded · master');
  });
  it('shows a label with no repo part as it is', () => {
    expect(gitChipLabel('main')).toBe('main');
  });
});
