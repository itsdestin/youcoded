// @vitest-environment jsdom
// Fix: this repo defaults vitest to the 'node' environment per-file — jsdom is
// opt-in via this docblock (must be line 1). Without it `window` doesn't
// exist and every test here fails before rendering anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import ChatsearchFindCard from '../src/renderer/components/tool-views/ChatsearchFindCard';
import ChatsearchShowCard from '../src/renderer/components/tool-views/ChatsearchShowCard';
import { COPY, type ResolvedConversation } from '../src/shared/chatsearch-refs';

const ok = (over: Partial<Extract<ResolvedConversation, { status: 'ok' }>> = {}): ResolvedConversation => ({
  status: 'ok', id: 'a3f2aaaa-0000-4000-8000-000000000000', provider: 'claude', title: 'Permission ask timeout',
  projectName: 'youcoded', originalPath: '/p/youcoded', lastActive: '2026-07-26T03:14:09.000Z', createdAt: '2026-07-25T18:02:11.000Z',
  tags: ['perm'], complete: true, tombstone: false, projectSlug: '-p-youcoded', projectPath: '/p/youcoded', missingProject: false, notSyncedYet: false, ...over,
});

// Fix: the cards resolve tag labels against the tag registry (chatsearch-tags.tsx)
// via window.claude.tags.list() — without this mock, useTagRegistry's reload()
// throws synchronously on the undefined `.tags` before rendering gets anywhere.
beforeEach(() => { (window as any).claude = { chatsearch: { resolve: vi.fn() }, tags: { list: vi.fn().mockResolvedValue([]) }, on: {} }; });
// Fix: this suite mounts several cards; auto-cleanup isn't configured
// globally (see tool-card-preparing.test.tsx), so a leftover DOM tree from
// one test made getByRole find duplicates in the next.
afterEach(cleanup);

describe('ChatsearchFindCard', () => {
  it('resolves ONCE even when the parent re-renders with a fresh ids array', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok()] });
    const { rerender } = render(<ChatsearchFindCard shortIds={['a3f2']} />);
    rerender(<ChatsearchFindCard shortIds={['a3f2']} />);
    rerender(<ChatsearchFindCard shortIds={['a3f2']} />);
    await screen.findByText('Permission ask timeout');
    expect((window as any).claude.chatsearch.resolve).toHaveBeenCalledTimes(1);
  });
  it('renders one row per resolved id with Preview and Resume', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok(), ok({ id: '9c14bbbb-0000-4000-8000-000000000000', title: 'Second' })] });
    render(<ChatsearchFindCard shortIds={['a3f2', '9c14']} />);
    await screen.findByText('Permission ask timeout');
    expect(screen.getAllByRole('button', { name: COPY.preview })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Resume/ })).toHaveLength(2);
  });
  it('disables Resume with the exact Resume Browser wording; Preview stays enabled', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok({ missingProject: true, projectSlug: '', projectPath: '' }), ok({ id: 'x', notSyncedYet: true })] });
    render(<ChatsearchFindCard shortIds={['a3f2', 'x']} />);
    const [a, b] = (await screen.findAllByRole('button', { name: /Resume/ })) as HTMLButtonElement[];
    expect(a.disabled).toBe(true); expect(a.getAttribute("data-hint")).toBe(COPY.resumeMissingProject);
    expect(b.disabled).toBe(true); expect(b.getAttribute("data-hint")).toBe(COPY.resumeNotSynced);
    for (const p of screen.getAllByRole('button', { name: COPY.preview }) as HTMLButtonElement[]) expect(p.disabled).toBe(false);
  });
  it('disables Preview for a tombstone and says why', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok({ tombstone: true })] });
    render(<ChatsearchFindCard shortIds={['a3f2']} />);
    const p = (await screen.findByRole('button', { name: COPY.preview })) as HTMLButtonElement;
    expect(p.disabled).toBe(true); expect(p.getAttribute("data-hint")).toBe(COPY.previewTombstone);
  });
  // Destin, 2026-08-27 gate (M-states): "should just hide dead." A row naming a
  // conversation this device has never heard of is an id and nothing else.
  it('hides an id it could not resolve, and counts it so the header stays honest', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({
      ok: true,
      results: [ok({}), { status: 'unknown', query: 'dead' }],
    });
    render(<ChatsearchFindCard shortIds={['a3f2', 'dead']} />);
    await screen.findByText('Permission ask timeout');
    expect(screen.queryByText(/dead/)).toBeNull();
    expect(screen.queryByText(COPY.unknownId)).toBeNull();
    // The card header counts what the SEARCH returned, so a hidden row must be
    // accounted for here or the card would show fewer than it claims.
    expect(screen.getByText(COPY.hiddenNotHere(1))).toBeTruthy();
  });
  it('shows no footnote when every id resolved', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok({})] });
    render(<ChatsearchFindCard shortIds={['a3f2']} />);
    await screen.findByText('Permission ask timeout');
    expect(screen.queryByText(/not on this device/)).toBeNull();
  });
  it('greys out Resume too when the transcript is gone — resuming reads the same file', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok({ tombstone: true })] });
    render(<ChatsearchFindCard shortIds={['a3f2']} />);
    const r = (await screen.findByRole('button', { name: COPY.resume })) as HTMLButtonElement;
    expect(r.disabled).toBe(true); expect(r.getAttribute("data-hint")).toBe(COPY.previewTombstone);
  });
  it('never shows the raw lane name', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok({ provider: 'native' })] });
    render(<ChatsearchFindCard shortIds={['a3f2']} />);
    await screen.findByText('Permission ask timeout');
    expect(screen.queryByText(/\bnative\b/)).toBeNull();
  });
  it('reports "unavailable" when resolve answers not-implemented (Android)', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: false, error: 'not-implemented-on-mobile' });
    const onUnavailable = vi.fn();
    render(<ChatsearchFindCard shortIds={['a3f2']} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
  });
  it('Preview dispatches youcoded:preview-session; Resume dispatches youcoded:resume-session', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok({ provider: 'native' })] });
    const prev = vi.fn(); const res = vi.fn();
    window.addEventListener('youcoded:preview-session', prev); window.addEventListener('youcoded:resume-session', res);
    render(<ChatsearchFindCard shortIds={['a3f2']} />);
    fireEvent.click(await screen.findByRole('button', { name: COPY.preview }));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect((prev.mock.calls[0][0] as CustomEvent).detail).toEqual({ provider: 'native', id: 'a3f2aaaa-0000-4000-8000-000000000000', title: 'Permission ask timeout' });
    expect((res.mock.calls[0][0] as CustomEvent).detail).toEqual({ claudeSessionId: 'a3f2aaaa-0000-4000-8000-000000000000', projectSlug: '-p-youcoded', projectPath: '/p/youcoded', provider: 'native' });
  });
});

describe('ChatsearchShowCard', () => {
  it('renders the one conversation prominently with both actions', async () => {
    (window as any).claude.chatsearch.resolve.mockResolvedValue({ ok: true, results: [ok()] });
    render(<ChatsearchShowCard id="a3f2aaaa-0000-4000-8000-000000000000" provider="claude" />);
    expect(await screen.findByRole('heading', { name: 'Permission ask timeout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: COPY.preview })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resume/ })).toBeTruthy();
  });
});
