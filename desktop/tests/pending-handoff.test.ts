import { describe, expect, it, vi } from 'vitest';
import { PendingHandoff } from '../src/renderer/state/pending-handoff';
import type { HandoffAttemptResult } from '../src/shared/types';

const waiting = { id: 'attempt-1', status: 'waiting' } as const;
const incomplete = { id: 'attempt-1', status: 'incomplete', cause: 'receipt-missing' } as const;
function setup() {
  let finish!: (result: HandoffAttemptResult) => void;
  const api = {
    begin: vi.fn(async () => waiting as HandoffAttemptResult),
    status: vi.fn(async () => ({ id: 'attempt-1', status: 'failed' } as HandoffAttemptResult)),
    wait: vi.fn(() => new Promise<HandoffAttemptResult>((resolve) => { finish = resolve; })),
    retry: vi.fn(async () => waiting as HandoffAttemptResult),
    savedCopy: vi.fn(async () => incomplete as HandoffAttemptResult),
    force: vi.fn(async () => incomplete as HandoffAttemptResult),
    cancel: vi.fn(async () => ({ id: 'attempt-1', status: 'cancelled' as const })),
  };
  const changes: (HandoffAttemptResult | null)[] = [];
  const admitted = vi.fn();
  const pending = new PendingHandoff(api, (result) => changes.push(result), admitted);
  return { api, changes, admitted, pending, finish: (result: HandoffAttemptResult) => finish(result) };
}
const session = { id: 'real-session', provider: 'claude' as const, name: 'Saved', cwd: '/project', permissionMode: 'normal' as const, skipPermissions: false, status: 'active' as const, createdAt: Date.now() };

describe('pending handoff', () => {
  const create = { name: 'Resuming session...', cwd: '/project', skipPermissions: false,
    resumeSessionId: 'conversation', provider: 'claude' as const };

  it('starts a new attempt after a rejected begin without losing the tab or draft key', async () => {
    const x = setup();
    x.api.begin.mockRejectedValueOnce(new Error('disconnected'));
    await x.pending.begin('conversation', 'claude', create);
    const tab = x.pending.active!;
    expect(tab.phase).toBe('failed');
    expect(tab.tabId).toMatch(/^pending-handoff:/);
    expect(x.api.retry).not.toHaveBeenCalled();
    expect(x.api.savedCopy).not.toHaveBeenCalled();
    await x.pending.retry(tab.tabId);
    expect(x.api.begin).toHaveBeenCalledTimes(2);
    expect(x.pending.active?.tabId).toBe(tab.tabId);
    expect(x.pending.active?.phase).toBe('waiting');
  });

  it('rechecks an unknown wait failure before retrying its still-live attempt', async () => {
    const x = setup();
    x.api.wait.mockRejectedValueOnce(new Error('connection dropped'));
    x.api.status.mockResolvedValueOnce(waiting);
    await x.pending.begin('conversation', 'claude', create);
    await vi.waitFor(() => expect(x.pending.active?.phase).toBe('failed'));
    await x.pending.retry(x.pending.active!.tabId);
    expect(x.api.begin).toHaveBeenCalledTimes(1);
    expect(x.api.status).toHaveBeenCalledWith('attempt-1');
    expect(x.pending.active?.phase).toBe('waiting');
  });

  it('starts a fresh attempt for a terminal backend failure instead of retrying its released reservation', async () => {
    const x = setup();
    await x.pending.begin('conversation', 'claude', create);
    x.finish({ id: 'attempt-1', status: 'failed', cause: 'startup-failed' });
    await vi.waitFor(() => expect(x.pending.active?.phase).toBe('failed'));
    const tab = x.pending.active!.tabId;
    await x.pending.savedCopy(tab);
    expect(x.api.savedCopy).not.toHaveBeenCalled();
    await x.pending.retry(tab);
    expect(x.api.retry).not.toHaveBeenCalled();
    expect(x.api.begin).toHaveBeenCalledTimes(2);
    expect(x.pending.active?.tabId).toBe(tab);
  });

  it('retains the saved title and detach intent through retry, detaching only a non-reused admission', async () => {
    const x = setup();
    await x.pending.begin('conversation', 'claude', create, 'project-slug', 'Saved title', true);
    expect(x.pending.active?.name).toBe('Saved title');
    x.finish(incomplete);
    await vi.waitFor(() => expect(x.pending.active?.phase).toBe('incomplete'));
    const tab = x.pending.active!.tabId;
    await x.pending.retry(tab);
    x.finish({ id: 'attempt-1', status: 'admitted', source: 'confirmed', session });
    await vi.waitFor(() => expect(x.admitted).toHaveBeenCalledWith(tab, session, true));
    const y = setup();
    await y.pending.begin('conversation', 'claude', create, 'project-slug', 'Saved title', true);
    y.finish({ id: 'attempt-1', status: 'admitted', source: 'saved-copy', session: { ...session, reused: true } } as HandoffAttemptResult);
    await vi.waitFor(() => expect(y.admitted).toHaveBeenCalledWith(y.admitted.mock.calls[0][0], expect.anything(), false));
  });

  it('opens locally before begin answers and never creates a writer for preview', async () => {
    const x = setup();
    const started = x.pending.begin('conversation', 'claude', { name: 'Saved', cwd: '/project', skipPermissions: false, resumeSessionId: 'conversation', provider: 'claude' });
    expect(x.pending.active?.conversationId).toBe('conversation');
    expect(x.pending.active?.phase).toBe('waiting');
    expect(x.api.begin).toHaveBeenCalledTimes(1);
    await started;
    x.finish(incomplete);
    await vi.waitFor(() => expect(x.changes.at(-1)).toEqual(incomplete));
    expect(x.admitted).not.toHaveBeenCalled();
  });

  it('keeps the same tab and attempt on retry, admitting only a real session', async () => {
    const x = setup();
    await x.pending.begin('conversation', 'claude', { name: 'Saved', cwd: '/project', skipPermissions: false, resumeSessionId: 'conversation', provider: 'claude' });
    x.finish(incomplete);
    await vi.waitFor(() => expect(x.pending.active?.phase).toBe('incomplete'));
    const tab = x.pending.active?.tabId;
    await x.pending.retry(tab!);
    expect(x.pending.active?.tabId).toBe(tab);
    expect(x.api.retry).toHaveBeenCalledWith('attempt-1');
    x.finish({ id: 'attempt-1', status: 'admitted', source: 'confirmed', session });
    await vi.waitFor(() => expect(x.admitted).toHaveBeenCalledWith(tab, session, false));
    expect(x.pending.active).toBeNull();
  });

  it('invalidates close synchronously even before begin answers and cancels its late attempt', async () => {
    let finishBegin!: (result: HandoffAttemptResult) => void;
    const x = setup();
    x.api.begin.mockImplementationOnce(() => new Promise((resolve) => { finishBegin = resolve; }));
    const started = x.pending.begin('conversation', 'claude', { name: 'Saved', cwd: '/project', skipPermissions: false, resumeSessionId: 'conversation', provider: 'claude' });
    const tab = x.pending.active!.tabId;
    x.pending.close(tab);
    expect(x.pending.active).toBeNull();
    finishBegin(waiting);
    await started;
    expect(x.api.cancel).toHaveBeenCalledWith('attempt-1');
    expect(x.api.wait).not.toHaveBeenCalled();
    expect(x.admitted).not.toHaveBeenCalled();
  });

  it('ignores a late admission after close and sends cancellation', async () => {
    const x = setup();
    await x.pending.begin('conversation', 'claude', { name: 'Saved', cwd: '/project', skipPermissions: false, resumeSessionId: 'conversation', provider: 'claude' });
    const tab = x.pending.active!.tabId;
    x.pending.close(tab);
    x.finish({ id: 'attempt-1', status: 'admitted', source: 'confirmed', session });
    await vi.waitFor(() => expect(x.api.cancel).toHaveBeenCalledWith('attempt-1'));
    expect(x.admitted).not.toHaveBeenCalled();
  });

  it('does not force on saved-copy denial until separate consent uses the expected holder id', async () => {
    const x = setup();
    await x.pending.begin('conversation', 'claude', { name: 'Saved', cwd: '/project', skipPermissions: false, resumeSessionId: 'conversation', provider: 'claude' });
    x.finish({ ...incomplete, holder: { deviceId: 'original-holder', device: 'Laptop' } });
    await vi.waitFor(() => expect(x.pending.active?.phase).toBe('incomplete'));
    x.api.savedCopy.mockResolvedValue({ ...incomplete, cause: 'lease-denied', holder: { deviceId: 'original-holder', device: 'Laptop' } });
    const tab = x.pending.active!.tabId;
    const ask = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await x.pending.continueWithSavedCopy(tab, ask);
    expect(x.api.savedCopy).toHaveBeenCalledWith('attempt-1', true);
    expect(ask).toHaveBeenCalledWith('Laptop');
    expect(x.api.force).not.toHaveBeenCalled();
    const refused = vi.fn();
    await x.pending.continueWithSavedCopy(tab, ask, refused);
    expect(x.api.force).toHaveBeenCalledWith('attempt-1', true, 'original-holder');
    // The mocked force answers incomplete: the confirmed click must not look ignored.
    expect(refused).toHaveBeenCalledOnce();
  });
});
