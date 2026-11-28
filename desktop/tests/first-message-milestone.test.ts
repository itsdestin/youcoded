// Pins the setup staircase's "sent a message" step on EVERY Claude Code send path.
// WHY (2026-11-25): Claude Code chat sends moved to the host queue in 1.3.1, but the milestone stayed on the
// raw `session:input` channel, so the owner dashboard read "Sent a message: 0" for nearly every Claude Code user.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const noteMilestone = vi.fn();
vi.mock('../src/main/analytics-service', () => ({ noteMilestone: (...a: unknown[]) => noteMilestone(...a) }));
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' } }));

beforeEach(() => noteMilestone.mockReset());

describe('first_message milestone', () => {
  it('counts a message the Claude Code queue accepted', async () => {
    const { wireClaudeQueues } = await import('../src/main/claude-queue-wiring');
    const bridge = Object.assign(new EventEmitter(), { attachQueueTransport: vi.fn(), setQueueInitializer: vi.fn(), isReady: () => true });
    const manager = { claudeBridgeForQueues: () => bridge, getSession: () => undefined, sendInput: vi.fn(), queueWorkerCommand: vi.fn() };
    const records = { noteSend: vi.fn(), facts: () => undefined };
    const runtime = wireClaudeQueues(manager as any, records as any, {} as any, vi.fn() as any, () => '/tmp');
    expect(runtime).toBeDefined();
    // The runtime's only way to report an accepted send is the noteSend option it was built with.
    (runtime as any).options.noteSend('s', 'send-1');
    expect(records.noteSend).toHaveBeenCalledWith('s', 'send-1');
    expect(noteMilestone).toHaveBeenCalledWith('first_message');
  });

  it('counts an accepted control send-text, and not a refused one', async () => {
    const { recordClaudeControlResult } = await import('../src/main/ipc/session');
    const records = { noteSend: vi.fn(), noteSendRefused: vi.fn() };
    const req = { kind: 'send-text', text: 'hi', sendId: 'x' } as any;
    recordClaudeControlResult(records, 's', req, { status: 'rejected' } as any);
    expect(noteMilestone).not.toHaveBeenCalled();
    recordClaudeControlResult(records, 's', req, { status: 'accepted' } as any);
    expect(noteMilestone).toHaveBeenCalledWith('first_message');
  });
});
