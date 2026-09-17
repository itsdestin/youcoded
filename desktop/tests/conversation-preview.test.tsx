// @vitest-environment jsdom
// This repo defaults vitest to the 'node' environment per-file — jsdom is
// opt-in via this docblock (must be line 1), or `document`/`window` don't exist.
//
// Project View's preview is the shared SessionPreviewPane (2026-09-16): it
// must read the conversation through chatsearch:read with the row's own lane
// and folder, and keep Resume as its only action.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConversationPreview } from '../src/renderer/components/project-view/ConversationPreview';
import { previewSessionKey } from '../src/shared/chatsearch-refs';
import type { PastSession } from '../src/shared/types';

afterEach(cleanup);

const session: PastSession = {
  sessionId: 'sess-1',
  name: 'Fix the sync bug',
  projectSlug: 'proj',
  projectPath: '/home/user/proj',
  lastModified: Date.now(),
  size: 1234,
};

beforeEach(() => {
  const sessionId = previewSessionKey('sess-1');
  (window as any).claude = {
    // The resume controls and the tag sheet read these on open.
    providers: { list: vi.fn().mockResolvedValue([]), catalog: vi.fn().mockResolvedValue([]) },
    tags: { list: vi.fn().mockResolvedValue([]) },
    session: {
      getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', flags: { complete: true } }),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
    },
    chatsearch: { read: vi.fn().mockResolvedValue({
    ok: true, cursor: null, hasMore: false,
    events: [
      { type: 'user-message', sessionId, uuid: 'u1', timestamp: 1, data: { text: 'why is sync broken' } },
      { type: 'assistant-text', sessionId, uuid: 'a1', timestamp: 2, data: { text: 'checking the logs now' } },
    ],
  }) },
  };
});

describe('ConversationPreview', () => {
  it('shows the conversation through the shared preview, read by lane and folder', async () => {
    render(<ConversationPreview session={session} onClose={() => {}} onResume={() => {}} />);
    expect(await screen.findByText('why is sync broken')).toBeTruthy();
    expect(screen.getByText('checking the logs now')).toBeTruthy();
    expect((window as any).claude.chatsearch.read).toHaveBeenCalledWith({ provider: 'claude', id: 'sess-1', projectSlug: 'proj' });
    // The old 20-message cap and its button are gone: older messages load on scroll.
    expect(screen.queryByRole('button', { name: /full transcript/i })).toBeNull();
  });

  it('Resume hands the row back to the parent', async () => {
    const onResume = vi.fn();
    render(<ConversationPreview session={{ ...session, provider: 'claude' }} onClose={() => {}} onResume={onResume} />);
    await screen.findByText('why is sync broken');
    fireEvent.click(screen.getByRole('button', { name: 'Resume Session' }));
    // App's own resume arguments: id, folder, then the picked launch choices.
    expect(onResume).toHaveBeenCalledWith('sess-1', 'proj', '/home/user/proj', expect.any(String), false, false, 'claude', undefined);
  });
});

describe('ConversationPreview organize controls', () => {
  it('shows Complete as the stored state, and toggling it writes the flag', async () => {
    render(<ConversationPreview session={session} onClose={() => {}} onResume={() => {}} />);
    // getMeta says complete; the list row did not know.
    const done = await screen.findByRole('button', { name: `Mark ${session.name} not complete` });
    fireEvent.click(done);
    expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('sess-1', 'complete', false);
  });

  it('puts the date in the action card at the foot, with the Resume button', async () => {
    const { container } = render(<ConversationPreview session={{ ...session, lastModified: Date.now() - 3 * 3600_000 }} onClose={() => {}} onResume={() => {}} />);
    await screen.findByText('why is sync broken');
    const resume = screen.getByRole('button', { name: 'Resume Session' });
    const date = screen.getByText('3h ago');
    // Same card: the date sits above the Resume button, not under the title.
    const card = resume.closest('.bg-panel');
    expect(card && card.contains(date)).toBe(true);
    expect(container.querySelector('header')?.textContent).not.toContain('3h ago');
  });
});
