// Which Claude Code permission asks main answers "allow" without showing a card.
import { describe, it, expect } from 'vitest';
import { shouldAutoApprove, shouldAutoApproveDocComment } from '../src/main/permission-auto-approve';
import { PERMISSION_OVERRIDES_DEFAULT } from '../src/shared/types';
import { DOC_COMMENTS_MCP_SERVER_ID } from '../src/shared/doc-comments-mcp';

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

// §5.2a of the doc-comments build design (decided option 1): a doc-comment
// mutation tool targeting a plain-text file is auto-approved unconditionally;
// a Word/Excel target is deliberately left to the ordinary ask.
describe('shouldAutoApproveDocComment', () => {
  const REPLY_TOOL = `mcp__${DOC_COMMENTS_MCP_SERVER_ID}__ReplyToComment`;
  const ADD_TOOL = `mcp__${DOC_COMMENTS_MCP_SERVER_ID}__AddComment`;
  const RESOLVE_TOOL = `mcp__${DOC_COMMENTS_MCP_SERVER_ID}__ResolveComment`;
  const REOPEN_TOOL = `mcp__${DOC_COMMENTS_MCP_SERVER_ID}__ReopenComment`;
  const MOVE_TOOL = `mcp__${DOC_COMMENTS_MCP_SERVER_ID}__MoveComment`;
  const READ_TOOL = `mcp__${DOC_COMMENTS_MCP_SERVER_ID}__ReadFileComments`;

  it('auto-approves a plain-text/markdown/code target, unconditionally — no override needed', () => {
    expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'notes.md' })).toBe(true);
    expect(shouldAutoApproveDocComment(ADD_TOOL, { path: 'src/app.ts' })).toBe(true);
    expect(shouldAutoApproveDocComment(RESOLVE_TOOL, { path: 'README' })).toBe(true);
    expect(shouldAutoApproveDocComment(REOPEN_TOOL, { path: 'docs/plan.md' })).toBe(true);
    expect(shouldAutoApproveDocComment(MOVE_TOOL, { path: 'notes.md' })).toBe(true);
  });

  it('never auto-approves a Word/Excel target — it falls through to the ordinary ask', () => {
    expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' })).toBe(false);
    expect(shouldAutoApproveDocComment(ADD_TOOL, { path: 'reports/q3.XLSX' })).toBe(false);
    expect(shouldAutoApproveDocComment(MOVE_TOOL, { path: 'docs/report.DOCX' })).toBe(false);
  });

  it('ignores any tool it does not recognize, including the read-only tool (never allow-listed alongside it)', () => {
    expect(shouldAutoApproveDocComment(READ_TOOL, { path: 'notes.md' })).toBe(false);
    expect(shouldAutoApproveDocComment('Write', { path: 'notes.md' })).toBe(false);
    expect(shouldAutoApproveDocComment('mcp__some-other-server__AddComment', { path: 'notes.md' })).toBe(false);
  });

  it('never approves when `path` is missing or not a string — a malformed hook payload refuses closed', () => {
    expect(shouldAutoApproveDocComment(REPLY_TOOL, {})).toBe(false);
    expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 42 as unknown as string })).toBe(false);
    expect(shouldAutoApproveDocComment(REPLY_TOOL, undefined)).toBe(false);
  });
});
