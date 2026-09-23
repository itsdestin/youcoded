import { describe, expect, it, vi } from 'vitest';
import { createHandoffTransport } from '../src/main/conversations/handoff-transport';

const create = { name: 'Resume', cwd: '/not-authoritative', skipPermissions: false, resumeSessionId: 'abc', provider: 'native' };
function fixture() {
  const controller = {
    begin: vi.fn(() => ({ id: 'attempt', status: 'waiting' })),
    status: vi.fn(() => ({ id: 'attempt', status: 'incomplete' })),
    wait: vi.fn(async () => ({ id: 'attempt', status: 'incomplete' })),
    setCreateParams: vi.fn(), retry: vi.fn(async () => ({ id: 'attempt', status: 'incomplete' })),
    savedCopy: vi.fn(async () => ({ id: 'attempt', status: 'incomplete' })),
    cancel: vi.fn(() => ({ id: 'attempt', status: 'cancelled' })), cancelOwner: vi.fn(),
    force: vi.fn(async () => ({ id: 'attempt', status: 'incomplete' })),
  };
  return { controller, route: createHandoffTransport(controller as unknown as Parameters<typeof createHandoffTransport>[0]) };
}

describe('handoff transport', () => {
  it('starts waiting without invoking startup and derives the owner from the transport', async () => {
    const { controller, route } = fixture();
    expect(await route('window:7', 'begin', { owner: 'window:8', conversationId: 'abc', provider: 'native', create })).toEqual({ id: 'attempt', status: 'waiting' });
    expect(controller.begin).toHaveBeenCalledWith('window:7', 'abc', 'native', create);
    expect(controller.wait).not.toHaveBeenCalled();
  });
  it('passes the transport owner to every action, never a payload owner', async () => {
    const { controller, route } = fixture();
    await route('remote:one', 'status', { id: 'attempt', owner: 'remote:two' });
    await route('remote:one', 'wait', { id: 'attempt' });
    await route('remote:one', 'retry', { id: 'attempt' });
    await route('remote:one', 'saved-copy', { id: 'attempt', consent: true });
    await route('remote:one', 'cancel', { id: 'attempt' });
    expect(controller.status).toHaveBeenCalledWith('remote:one', 'attempt');
    expect(controller.wait).toHaveBeenCalledWith('remote:one', 'attempt');
    expect(controller.retry).toHaveBeenCalledWith('remote:one', 'attempt');
    expect(controller.savedCopy).toHaveBeenCalledWith('remote:one', 'attempt', true);
    expect(controller.cancel).toHaveBeenCalledWith('remote:one', 'attempt');
  });
  it('rejects malformed create, id, action and consent before entering the controller', async () => {
    const { controller, route } = fixture();
    for (const payload of [null, { conversationId: '../abc', provider: 'native' },
      { conversationId: 'abc', provider: 'shell' },
      { conversationId: 'abc', provider: 'native', create: { ...create, resumeSessionId: 'other' } },
      { conversationId: 'abc', provider: 'native', create: { ...create, initialCommand: 'bad' } }]) {
      await expect(route('window:7', 'begin', payload)).rejects.toThrow();
    }
    for (const action of ['status', 'retry', 'saved-copy', 'cancel', 'unknown'])
      await expect(route('window:7', action, { id: '../bad', consent: true })).rejects.toThrow();
    await expect(route('window:7', 'saved-copy', { id: 'attempt', consent: 'true' })).rejects.toThrow();
    expect(controller.begin).not.toHaveBeenCalled();
    expect(controller.savedCopy).not.toHaveBeenCalled();
  });
  it('requires separately confirmed force and a bounded expected holder; saved copy never forces', async () => {
    const { controller, route } = fixture();
    for (const consent of [false, 'true', undefined])
      await expect(route('remote:one', 'force', { id: 'attempt', expectedHolderId: 'original', consent })).rejects.toThrow();
    for (const expectedHolderId of [undefined, '../bad', 'x'.repeat(101)])
      await expect(route('remote:one', 'force', { id: 'attempt', expectedHolderId, consent: true })).rejects.toThrow();
    await route('remote:one', 'saved-copy', { id: 'attempt', consent: true, expectedHolderId: 'original' });
    expect(controller.force).not.toHaveBeenCalled();
    await route('remote:one', 'force', { id: 'attempt', consent: true, expectedHolderId: 'original', owner: 'remote:other' });
    expect(controller.force).toHaveBeenCalledWith('remote:one', 'attempt', true, 'original');
  });
  it('refuses missing backend rather than pretending a fresh attempt exists', async () => {
    await expect(createHandoffTransport(null)('window:1', 'begin', { conversationId: 'abc', provider: 'native' })).rejects.toThrow(/unavailable/i);
  });
  it('cancels only pending attempts of a disconnected connection', () => {
    const { controller, route } = fixture();
    route.cancelOwner('remote:one');
    expect(controller.cancelOwner).toHaveBeenCalledWith('remote:one');
  });
});
