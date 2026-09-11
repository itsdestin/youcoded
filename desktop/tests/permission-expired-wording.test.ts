/**
 * An expired approval says what happened, in words a person can use.
 *
 * Error inventory 2026-09-10, false message 3. PERMISSION_EXPIRED marked the tool failed
 * with "Permission request expired — socket closed before a response was sent". "Socket"
 * is transport machinery, and "before a response was sent" claimed to know no answer was
 * ever sent — which was also dispatched when an answer merely got no reply. Rejections no
 * longer reach this action (permission-answer-unconfirmed.test.tsx); what does reach it —
 * the host saying the request is closed, or the hook relay's own expiry — is a request
 * that closed before any answer reached it.
 */
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';

const SESSION = 's1';

function errorAfterExpiry(): string | undefined {
  let state: any = new Map();
  state = chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION } as any);
  state = chatReducer(state, {
    type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-1',
  } as any);
  state = chatReducer(state, { type: 'PERMISSION_EXPIRED', sessionId: SESSION, requestId: 'req-1' } as any);
  const tools = [...state.get(SESSION).toolCalls.values()] as Array<{ status: string; error?: string }>;
  return tools.find((t) => t.status === 'failed')?.error;
}

describe('PERMISSION_EXPIRED wording', () => {
  it('names a request that closed before an answer reached it, without transport jargon', () => {
    const error = errorAfterExpiry();
    expect(error, 'the expired request is marked failed with an explanation').toBeDefined();
    expect(error).not.toMatch(/socket/i);
    expect(error).toMatch(/closed before an answer reached it/i);
  });
});
