// Which Claude Code permission asks main answers "allow" without showing a card.
import { describe, it, expect } from 'vitest';
import { shouldAutoApprove, shouldAutoApproveDocComment } from '../src/main/permission-auto-approve';
import { PERMISSION_OVERRIDES_DEFAULT } from '../src/shared/types';
import { docCommentsMcpToolName } from '../src/shared/doc-comments-mcp';

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
// a Word/Excel target is deliberately left to the ordinary ask. `serverId`
// (adversarial review 2026-09-27, finding #2) is a stand-in for the random,
// per-session id `deployClaudeCodeDocCommentsMcp` mints for real — these
// tests exercise the MATCHING logic against a fixed id so results are
// deterministic; `claude-code-doc-comments-mcp.test.ts` covers the id itself
// actually being random per deployment.
describe('shouldAutoApproveDocComment', () => {
  const SERVER_ID = 'youcoded-doc-comments-deadbeef';
  const OTHER_SERVER_ID = 'youcoded-doc-comments-c0ffee00';
  const REPLY_TOOL = docCommentsMcpToolName(SERVER_ID, 'ReplyToComment');
  const ADD_TOOL = docCommentsMcpToolName(SERVER_ID, 'AddComment');
  const RESOLVE_TOOL = docCommentsMcpToolName(SERVER_ID, 'ResolveComment');
  const REOPEN_TOOL = docCommentsMcpToolName(SERVER_ID, 'ReopenComment');
  const MOVE_TOOL = docCommentsMcpToolName(SERVER_ID, 'MoveComment');
  const READ_TOOL = docCommentsMcpToolName(SERVER_ID, 'ReadFileComments');

  it('auto-approves a plain-text/markdown/code target, unconditionally — no override needed', () => {
    expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'notes.md' }, undefined, SERVER_ID)).toBe(true);
    expect(shouldAutoApproveDocComment(ADD_TOOL, { path: 'src/app.ts' }, undefined, SERVER_ID)).toBe(true);
    expect(shouldAutoApproveDocComment(RESOLVE_TOOL, { path: 'README' }, undefined, SERVER_ID)).toBe(true);
    expect(shouldAutoApproveDocComment(REOPEN_TOOL, { path: 'docs/plan.md' }, undefined, SERVER_ID)).toBe(true);
    expect(shouldAutoApproveDocComment(MOVE_TOOL, { path: 'notes.md' }, undefined, SERVER_ID)).toBe(true);
  });

  it('never auto-approves a Word/Excel target — it falls through to the ordinary ask', () => {
    expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, undefined, SERVER_ID)).toBe(false);
    expect(shouldAutoApproveDocComment(ADD_TOOL, { path: 'reports/q3.XLSX' }, undefined, SERVER_ID)).toBe(false);
    expect(shouldAutoApproveDocComment(MOVE_TOOL, { path: 'docs/report.DOCX' }, undefined, SERVER_ID)).toBe(false);
  });

  it('ignores any tool it does not recognize, including the read-only tool (never allow-listed alongside it)', () => {
    expect(shouldAutoApproveDocComment(READ_TOOL, { path: 'notes.md' }, undefined, SERVER_ID)).toBe(false);
    expect(shouldAutoApproveDocComment('Write', { path: 'notes.md' }, undefined, SERVER_ID)).toBe(false);
    expect(shouldAutoApproveDocComment('mcp__some-other-server__AddComment', { path: 'notes.md' }, undefined, SERVER_ID)).toBe(false);
  });

  it('never approves when `path` is missing or not a string — a malformed hook payload refuses closed', () => {
    expect(shouldAutoApproveDocComment(REPLY_TOOL, {}, undefined, SERVER_ID)).toBe(false);
    expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 42 as unknown as string }, undefined, SERVER_ID)).toBe(false);
    expect(shouldAutoApproveDocComment(REPLY_TOOL, undefined, undefined, SERVER_ID)).toBe(false);
  });

  // Adversarial review 2026-09-27, finding #2: a tool name composed under a
  // DIFFERENT session's server id (or one this session has no record of at
  // all) must never match, even for a plain-text target — this is what
  // makes the auto-approve unambiguous per session rather than a fixed,
  // guessable string.
  describe('server-id matching (finding #2)', () => {
    it('a tool name composed under a DIFFERENT session\'s server id never matches, even for a plain-text target', () => {
      const otherSessionsReplyTool = docCommentsMcpToolName(OTHER_SERVER_ID, 'ReplyToComment');
      expect(shouldAutoApproveDocComment(otherSessionsReplyTool, { path: 'notes.md' }, undefined, SERVER_ID)).toBe(false);
    });

    it('fails closed when no server id is known for this session at all (serverId undefined)', () => {
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'notes.md' }, undefined, undefined)).toBe(false);
    });
  });

  // Claude Code's own live `permission_mode` (verified against the installed
  // 2.1.283 CLI binary's embedded hook-input schema — see
  // youcoded/docs/cc-dependencies.md's "Hook payload permission_mode field"
  // entry) is what §5.2a's "same tier as Edit/Write" actually turns on for a
  // Word/Excel target. A plain-text target ignores it entirely (already
  // covered above with no mode argument at all — these cases confirm mode
  // still doesn't matter there either).
  describe('with Claude Code\'s live permission_mode', () => {
    it('auto-approves a Word/Excel target in acceptEdits mode — matches Edit/Write\'s own auto-accept', () => {
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, 'acceptEdits', SERVER_ID)).toBe(true);
      expect(shouldAutoApproveDocComment(ADD_TOOL, { path: 'reports/q3.xlsx' }, 'acceptEdits', SERVER_ID)).toBe(true);
      expect(shouldAutoApproveDocComment(MOVE_TOOL, { path: 'docs/report.DOCX' }, 'acceptEdits', SERVER_ID)).toBe(true);
    });

    it('auto-approves a Word/Excel target in bypassPermissions mode too (defensive — Claude Code normally never fires this hook under bypass at all)', () => {
      expect(shouldAutoApproveDocComment(RESOLVE_TOOL, { path: 'docs/report.docx' }, 'bypassPermissions', SERVER_ID)).toBe(true);
    });

    it('never auto-approves a Word/Excel target in plan mode — no execution happens there', () => {
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, 'plan', SERVER_ID)).toBe(false);
    });

    it('never auto-approves a Word/Excel target in default mode — that is the ordinary "always ask" mode', () => {
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, 'default', SERVER_ID)).toBe(false);
    });

    it('never auto-approves a Word/Excel target for dontAsk or auto — neither is a documented unconditional file-edit accept', () => {
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, 'dontAsk', SERVER_ID)).toBe(false);
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, 'auto', SERVER_ID)).toBe(false);
    });

    it('never auto-approves a Word/Excel target for an unrecognized mode string or a missing field — never guessed', () => {
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, 'some-future-mode', SERVER_ID)).toBe(false);
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'docs/report.docx' }, undefined, SERVER_ID)).toBe(false);
    });

    it('a plain-text target stays auto-approved regardless of mode, including plan', () => {
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'notes.md' }, 'plan', SERVER_ID)).toBe(true);
      expect(shouldAutoApproveDocComment(REPLY_TOOL, { path: 'notes.md' }, 'default', SERVER_ID)).toBe(true);
    });

    // A real-shaped PermissionRequest hook payload (per the CLI's own
    // embedded schema: the common base fields intersected with the
    // PermissionRequest-specific ones) — proves the exact snake_case field
    // name main.ts reads (`permission_mode`) against something closer to
    // what actually arrives on the wire, not just a bare string argument.
    it('reads a realistic full PermissionRequest hook payload the same way main.ts extracts it', () => {
      const realShapedPayload = {
        session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        transcript_path: '/home/user/.claude/projects/-home-user-project/a1b2c3d4.jsonl',
        cwd: '/home/user/project',
        permission_mode: 'acceptEdits',
        hook_event_name: 'PermissionRequest',
        tool_name: REPLY_TOOL,
        tool_input: { path: 'docs/quarterly-report.docx', commentId: 'w-3', text: 'Addressed in the latest revision.' },
      };
      const toolName = realShapedPayload.tool_name;
      const toolInput = realShapedPayload.tool_input as Record<string, unknown>;
      const permissionMode = realShapedPayload.permission_mode as string | undefined;
      expect(shouldAutoApproveDocComment(toolName, toolInput, permissionMode, SERVER_ID)).toBe(true);
    });

    it('the same realistic payload in plan mode falls through to the ordinary ask', () => {
      const realShapedPayload = {
        session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        transcript_path: '/home/user/.claude/projects/-home-user-project/a1b2c3d4.jsonl',
        cwd: '/home/user/project',
        permission_mode: 'plan',
        hook_event_name: 'PermissionRequest',
        tool_name: ADD_TOOL,
        tool_input: { path: 'docs/quarterly-report.docx', selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Q3 revenue', prefix: '', suffix: '', occurrence: 0 } }, text: 'Double-check this figure.' },
      };
      expect(shouldAutoApproveDocComment(realShapedPayload.tool_name, realShapedPayload.tool_input as Record<string, unknown>, realShapedPayload.permission_mode, SERVER_ID)).toBe(false);
    });

    // A payload with `permission_mode` absent entirely (the CLI's own schema
    // marks it optional — some hosts/versions may omit it) fails closed.
    it('a payload with no permission_mode field at all falls through to the ordinary ask', () => {
      const payloadWithoutMode = {
        session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        transcript_path: '/home/user/.claude/projects/-home-user-project/a1b2c3d4.jsonl',
        cwd: '/home/user/project',
        hook_event_name: 'PermissionRequest',
        tool_name: RESOLVE_TOOL,
        tool_input: { path: 'docs/quarterly-report.docx', commentId: 'w-3' },
      } as Record<string, unknown>;
      const permissionMode = (payloadWithoutMode as { permission_mode?: string }).permission_mode;
      expect(shouldAutoApproveDocComment(payloadWithoutMode.tool_name as string, payloadWithoutMode.tool_input as Record<string, unknown>, permissionMode, SERVER_ID)).toBe(false);
    });
  });
});
