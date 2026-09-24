// Which Claude Code permission asks main answers "allow" without showing a card.
import { describe, it, expect } from 'vitest';
import { shouldAutoApprove } from '../src/main/permission-auto-approve';
import { PERMISSION_OVERRIDES_DEFAULT } from '../src/shared/types';

const ALL_ON = { ...PERMISSION_OVERRIDES_DEFAULT, approveAll: true };

describe('shouldAutoApprove', () => {
  it('never auto-allows a plan approval or a question, even with approve-all on — they need the user\'s own answer', () => {
    expect(shouldAutoApprove('ExitPlanMode', { plan: 'x' }, ALL_ON)).toBe(false);
    expect(shouldAutoApprove('AskUserQuestion', { questions: [] }, ALL_ON)).toBe(false);
  });

  it('approve-all still covers ordinary tools', () => {
    expect(shouldAutoApprove('Bash', { command: 'ls' }, ALL_ON)).toBe(true);
    expect(shouldAutoApprove('Write', { file_path: '/tmp/x' }, ALL_ON)).toBe(true);
  });

  it('with nothing enabled only the title hook is auto-allowed', () => {
    expect(shouldAutoApprove('Bash', { command: 'echo t > ~/.claude/topics/topic-1' }, PERMISSION_OVERRIDES_DEFAULT)).toBe(true);
    expect(shouldAutoApprove('Bash', { command: 'ls' }, PERMISSION_OVERRIDES_DEFAULT)).toBe(false);
  });

  it('a per-category override allows only its category', () => {
    const git = { ...PERMISSION_OVERRIDES_DEFAULT, compoundCdGit: true };
    expect(shouldAutoApprove('Bash', { command: 'cd repo && git status' }, git)).toBe(true);
    expect(shouldAutoApprove('Write', { file_path: '/home/u/.bashrc' }, git)).toBe(false);
  });
});
