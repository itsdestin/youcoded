// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BuddyResumeList } from '../src/renderer/components/buddy/BuddyResumeList';

// Model catalog is unrelated to admission; keep the real gate, row and buttons.
vi.mock('../src/renderer/components/model/ModelPicker', () => ({ default: () => null }));
const create = vi.fn();
const query = vi.fn();
const takeover = vi.fn();
const force = vi.fn();
const openMain = vi.fn();
const row = { sessionId: 'past', name: 'A conversation', projectSlug: 'project', projectPath: '/project', lastModified: 1, provider: 'claude' };

beforeEach(() => {
  vi.resetAllMocks();
  window.matchMedia = vi.fn().mockImplementation((media) => ({ matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  window.claude = {
    session: { browse: vi.fn().mockResolvedValue([row]), create },
    defaults: { get: vi.fn().mockResolvedValue({ model: 'sonnet' }) },
    syncSpaces: { leaseQuery: query, leaseTakeover: takeover, leaseForce: force },
    buddy: { openMain },
  } as any;
  query.mockResolvedValue({ held: false });
});

async function start() {
  const onResumed = vi.fn();
  const view = render(<BuddyResumeList onResumed={onResumed} onCancel={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /A conversation/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  return { ...view, onResumed };
}

describe('BuddyResumeList admission', () => {
  it('shows retry after backend denial and only opens after a successful retry', async () => {
    create.mockResolvedValueOnce({ status: 'lease-denied', device: 'laptop' }).mockResolvedValueOnce({ id: 'opened', status: 'active' });
    const { onResumed } = await start();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onResumed).toHaveBeenCalledWith('opened'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(takeover).not.toHaveBeenCalled();
  });

  it('declining a claim denial never reports a resumed session', async () => {
    create.mockResolvedValue({ status: 'lease-denied', device: 'laptop' });
    const { onResumed } = await start();
    fireEvent.click(await screen.findByRole('button', { name: 'Leave it' }));
    await screen.findByRole('button', { name: 'Resume' });
    expect(onResumed).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it('routes explicit consent to the main pending flow without legacy takeover or create', async () => {
    query.mockResolvedValue({ held: true, device: 'laptop' });
    await start();
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(openMain).toHaveBeenCalledWith({ resume: row.sessionId }));
    expect(takeover).not.toHaveBeenCalled();
    expect(force).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not create while the user is deciding whether to hand off', async () => {
    query.mockResolvedValue({ held: true, device: 'laptop' });
    const { unmount, onResumed } = await start();
    await screen.findByRole('button', { name: 'Take over' });
    expect(create).not.toHaveBeenCalled();
    unmount();
    expect(onResumed).not.toHaveBeenCalled();
    expect(takeover).not.toHaveBeenCalled();
  });
});
