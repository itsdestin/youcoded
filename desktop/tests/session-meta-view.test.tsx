// @vitest-environment jsdom
// The session menu's rows read tags/pin/note from ONE shared copy per session: fetched once, shared by every reader,
// kept across menu reopens, refreshed when the backend says meta changed. (Every open used to cost two backend reads
// per row, each landing mid-animation as chips popping in.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import React from 'react';
import { useSessionMetaView, resetSessionMetaViewForTests } from '../src/renderer/state/session-meta-view';

let metaChanged: (() => void) | null = null;
const getMeta = vi.fn(async (id: string) => ({ tags: [`tag-of-${id}`], note: '', flags: { priority: id === 'a' } }));

function Row({ id }: { id: string }) {
  const m = useSessionMetaView(id);
  return <span data-testid={`row-${id}`}>{[...m.tags].join(',')}|{m.flags.priority ? 'pinned' : ''}</span>;
}

beforeEach(() => {
  resetSessionMetaViewForTests();
  getMeta.mockClear();
  metaChanged = null;
  (window as any).claude = {
    session: { getMeta },
    on: { sessionMetaChanged: (cb: () => void) => { metaChanged = cb; return () => {}; } },
  };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('useSessionMetaView', () => {
  it('asks the backend once per session however many readers show it', async () => {
    render(<><Row id="a" /><Row id="a" /><Row id="b" /></>);
    await vi.waitFor(() => expect(screen.getAllByTestId('row-a')[0].textContent).toBe('tag-of-a|pinned'));
    expect(getMeta.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
  });

  it('a menu reopened shows the chips on its first render, with no new backend read', async () => {
    const first = render(<Row id="a" />);
    await vi.waitFor(() => expect(screen.getByTestId('row-a').textContent).toBe('tag-of-a|pinned'));
    first.unmount();
    render(<Row id="a" />);
    expect(screen.getByTestId('row-a').textContent).toBe('tag-of-a|pinned');   // synchronously, first render
    expect(getMeta).toHaveBeenCalledTimes(1);
  });

  it('refreshes what is shown when the backend says meta changed', async () => {
    render(<Row id="a" />);
    await vi.waitFor(() => expect(screen.getByTestId('row-a').textContent).toBe('tag-of-a|pinned'));
    getMeta.mockImplementationOnce(async () => ({ tags: ['renamed'], note: '', flags: {} }));
    await act(async () => { metaChanged?.(); });
    await vi.waitFor(() => expect(screen.getByTestId('row-a').textContent).toBe('renamed|'));
  });
});
