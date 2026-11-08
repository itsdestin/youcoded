import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';
import { trackOutsideComments, judgeCommentAsk, takeCommentAnswer, resetOutsideCommentsForTests } from '../src/main/cc-outside-comments';

const SERVER = 'youcoded-doc-comments-a1b2c3d4';
const PROJECT = path.join(os.tmpdir(), 'yc-project');
const OUTSIDE_FILE = path.join(os.tmpdir(), 'elsewhere', 'roundup.md');

function ask(tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, requestId = 'r1') {
  return { sessionId: 's1', payload: { tool_name: `mcp__${SERVER}__${tool}`, tool_input: input, _requestId: requestId, ...extra } as Record<string, unknown> };
}

describe('Claude Code comment asks for files outside the project', () => {
  let manager: EventEmitter;
  beforeEach(() => {
    resetOutsideCommentsForTests();
    manager = new EventEmitter();
    trackOutsideComments(manager);
    manager.emit('doc-comments-mcp-attached', 's1', PROJECT, 'token', SERVER);
  });

  it('approves an in-project read at once, so it never shows a card', () => {
    expect(judgeCommentAsk(ask('ReadFileComments', { path: 'notes.md' }))).toBe('approve');
    expect(judgeCommentAsk(ask('ReadFileComments', { path: path.join(PROJECT, 'notes.md') }))).toBe('approve');
  });

  it('leaves an in-project comment change to the existing rules', () => {
    expect(judgeCommentAsk(ask('AddComment', { path: 'notes.md' }))).toBe('pass');
  });

  it('asks with the outside-file card for a plain file in another folder', () => {
    const event = ask('ReadFileComments', { path: OUTSIDE_FILE });
    expect(judgeCommentAsk(event)).toBe('ask');
    expect(event.payload.external).toBe(true);
  });

  it('a path that only starts with the project name is still outside', () => {
    expect(judgeCommentAsk(ask('ReadFileComments', { path: `${PROJECT}-other/notes.md` }))).toBe('ask');
  });

  it('"Allow for this chat" approves later outside asks in that chat, and the field never reaches Claude Code', () => {
    judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }));
    const sent = takeCommentAnswer('r1', { decision: { behavior: 'allow' }, allowOutsideCommentsForSession: true });
    expect(sent).toEqual({ decision: { behavior: 'allow' } });
    expect(judgeCommentAsk(ask('AddComment', { path: '/somewhere/else/a.md' }, {}, 'r2'))).toBe('approve');
  });

  it('"Yes" approves only that one call', () => {
    judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }));
    takeCommentAnswer('r1', { decision: { behavior: 'allow' } });
    expect(judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }, {}, 'r2'))).toBe('ask');
  });

  it('"Allow for this chat" on a declined or unrelated ask grants nothing', () => {
    judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }));
    takeCommentAnswer('r1', { decision: { behavior: 'deny' }, allowOutsideCommentsForSession: true });
    takeCommentAnswer('some-other-ask', { decision: { behavior: 'allow' }, allowOutsideCommentsForSession: true });
    expect(judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }, {}, 'r3'))).toBe('ask');
  });

  it('an ask that timed out unanswered is forgotten: a late answer to it grants nothing', () => {
    const relay = new EventEmitter();
    trackOutsideComments(new EventEmitter(), relay);
    judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }));
    relay.emit('permission-expired', 's1', 'r1', 'app-timeout');
    expect(takeCommentAnswer('r1', { decision: { behavior: 'deny' } })).toEqual({ decision: { behavior: 'deny' } });
    takeCommentAnswer('r1', { decision: { behavior: 'allow' }, allowOutsideCommentsForSession: true });
    expect(judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }, {}, 'r2'))).toBe('ask');
  });

  it('the chat-wide choice ends with the chat', () => {
    judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }));
    takeCommentAnswer('r1', { decision: { behavior: 'allow' }, allowOutsideCommentsForSession: true });
    manager.emit('session-exit', 's1');
    manager.emit('doc-comments-mcp-attached', 's1', PROJECT, 'token', SERVER);
    expect(judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }, {}, 'r2'))).toBe('ask');
  });

  it('a helper (subagent) gets the plain card every time and never uses the chat-wide choice', () => {
    judgeCommentAsk(ask('ReadFileComments', { path: OUTSIDE_FILE }));
    takeCommentAnswer('r1', { decision: { behavior: 'allow' }, allowOutsideCommentsForSession: true });
    const event = ask('ReadFileComments', { path: OUTSIDE_FILE }, { agent_id: 'helper-1' }, 'r2');
    expect(judgeCommentAsk(event)).toBe('ask');
    expect(event.payload.external).toBeUndefined();
  });

  it('"No" on an outside-file card tells Claude Code the user declined, instead of a bare refusal', () => {
    judgeCommentAsk(ask('AddComment', { path: OUTSIDE_FILE }));
    const sent = takeCommentAnswer('r1', { decision: { behavior: 'deny' } }) as { decision: { behavior: string; message?: string } };
    expect(sent.decision.behavior).toBe('deny');
    expect(sent.decision.message).toMatch(/user declined/i);
    expect(sent.decision.message).toMatch(/outside this chat's project/i);
  });

  it('a helper\'s "No" carries the same reason', () => {
    judgeCommentAsk(ask('AddComment', { path: OUTSIDE_FILE }, { agent_id: 'helper-1' }));
    const sent = takeCommentAnswer('r1', { decision: { behavior: 'deny' } }) as { decision: { message?: string } };
    expect(sent.decision.message).toMatch(/user declined/i);
  });

  it('leaves other asks\' answers as they were', () => {
    expect(takeCommentAnswer('unrelated', { decision: { behavior: 'deny' } })).toEqual({ decision: { behavior: 'deny' } });
    judgeCommentAsk(ask('AddComment', { path: OUTSIDE_FILE }));
    expect(takeCommentAnswer('r1', { decision: { behavior: 'deny', message: 'own words' } })).toEqual({ decision: { behavior: 'deny', message: 'own words' } });
  });

  it('asks with the same card for a Word or Excel file in another folder', () => {
    for (const name of ['report.docx', 'sales.xlsx']) {
      const event = ask('AddComment', { path: path.join(os.tmpdir(), 'elsewhere', name) });
      expect(judgeCommentAsk(event)).toBe('ask');
      expect(event.payload.external).toBe(true);
    }
  });

  it('ignores another server\'s look-alike tools and sessions it never saw', () => {
    expect(judgeCommentAsk({ sessionId: 's1', payload: { tool_name: 'mcp__youcoded-doc-comments-guessed__ReadFileComments', tool_input: { path: OUTSIDE_FILE }, _requestId: 'x' } })).toBe('pass');
    expect(judgeCommentAsk({ sessionId: 'unknown', payload: { tool_name: `mcp__${SERVER}__ReadFileComments`, tool_input: { path: OUTSIDE_FILE }, _requestId: 'x' } })).toBe('pass');
  });
});
