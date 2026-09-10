// @vitest-environment jsdom
// Resume browser filter row — the behaviours the decks and reviews promised
// (feature resume-filter-chips, 2026-09-10) that only a mounted browser can show:
//
//   * At phone width the chips live behind the search pill's filter button, in a
//     panel; opening it must not loop. The grader caught "Maximum update depth
//     exceeded" on the branch: a layout effect depended on a position object it
//     rewrote on every run (contract R12).
//   * A dropdown opened from a chip inside the panel keeps the panel open (R13).
//   * A tap outside an open menu closes only that menu; the browser and its
//     filters stay (UX review 2, U2 → contract R21).
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

let narrow = false;
vi.mock('../src/renderer/hooks/use-narrow-viewport', () => ({
  useNarrowViewport: () => narrow,
  NARROW_VIEWPORT_QUERY: '(max-width: 639.98px)',
}));

import ResumeBrowser from '../src/renderer/components/ResumeBrowser';

beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  }
});
afterEach(cleanup);

const TAGS = [
  { id: 'tag_a', label: 'Research', color: 'tag-blue', archived: false, createdAt: '' },
  { id: 'tag_b', label: 'Work', color: 'tag-green', archived: false, createdAt: '' },
];
const SESSIONS = [
  { sessionId: 's1', name: 'Alpha', projectSlug: 'one', projectPath: '/tmp/one', lastModified: 3, size: 1, provider: 'claude', tags: ['tag_a'] },
  { sessionId: 's2', name: 'Beta', projectSlug: 'two', projectPath: '/tmp/two', lastModified: 2, size: 1, provider: 'claude', tags: ['tag_b'] },
  { sessionId: 's3', name: 'Gamma', projectSlug: 'one', projectPath: '/tmp/one', lastModified: 1, size: 1, provider: 'claude', tags: [] },
];

beforeEach(() => {
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue(SESSIONS),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
    },
    tags: { list: vi.fn().mockResolvedValue(TAGS), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
    on: {},
  };
});

const chip = (name: RegExp | string, root: HTMLElement | Document = document) =>
  [...root.querySelectorAll('button')].find((b) => (typeof name === 'string' ? b.textContent?.trim().startsWith(name) : name.test(b.textContent ?? ''))) as HTMLButtonElement;

describe('phone width', () => {
  beforeEach(() => { narrow = true; });

  it('opens the filter panel with the desktop chips inside, without an update loop', async () => {
    const onClose = vi.fn();
    render(<ResumeBrowser open onClose={onClose} onResume={() => {}} />);
    await screen.findByText('Alpha');
    expect(chip('Projects')).toBeUndefined(); // no chips row under the search box
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    expect(chip('Projects', panel)).toBeDefined();
    expect(chip('Tags', panel)).toBeDefined();
    expect(chip('Most recent', panel)).toBeDefined();
    // The panel stays open while a chip's menu opens from inside it, and a pick
    // (which shrinks the list and moves the panel) keeps both.
    fireEvent.click(chip('Projects', panel));
    const options = await screen.findAllByRole('option');
    expect(options.length).toBe(2);
    fireEvent.click(options[1]);
    await screen.findByText('Beta');
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getAllByRole('option').length).toBe(2);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('desktop width', () => {
  beforeEach(() => { narrow = false; });

  it('a tap outside an open menu closes only the menu, and the tap is spent there', async () => {
    const onClose = vi.fn();
    render(<ResumeBrowser open onClose={onClose} onResume={() => {}} />);
    await screen.findByText('Alpha');
    fireEvent.click(chip('Tags'));
    expect((await screen.findAllByRole('option')).length).toBe(2);
    // Something behind the menu that a click would otherwise reach.
    const behind = vi.fn();
    document.body.addEventListener('click', behind);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(behind).not.toHaveBeenCalled(); // swallowed: the scrim never sees it
    expect(onClose).not.toHaveBeenCalled();
    // The next click is an ordinary click again.
    fireEvent.click(document.body);
    expect(behind).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('click', behind);
  });

  it('one pick names the chip; two show a count', async () => {
    render(<ResumeBrowser open onClose={() => {}} onResume={() => {}} />);
    await screen.findByText('Alpha');
    fireEvent.click(chip('Tags'));
    const options = await screen.findAllByRole('option');
    fireEvent.click(options[0]);
    expect(within(chip(/^Research/)).getByText('Research')).toBeInTheDocument();
    fireEvent.click(options[1]);
    expect(chip('Tags').textContent?.replace(/\s+/g, ' ').trim()).toBe('Tags 2');
  });
});
