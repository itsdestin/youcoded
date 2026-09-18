// @vitest-environment jsdom
// Pins the Files tab's LIST view (design decks 2026-09-03: file-views.questions
// Q-1/Q-3, file-views-round2 R-2/R-3). The grid was the only way to see a
// project's files for a year; the list is the other half, and the two draw from
// exactly the same data, so a change that only fixes the grid can silently
// break the list. Pinned here:
//   1. A file row carries its filename, its kind and a relative modified time.
//   2. A folder row carries its file COUNT and no date — a folder has no single
//      modified time of its own, and borrowing one file's would read as the
//      folder's.
//   3. Loose files come before folders, matching the grid's order.
//   4. The switch is per-app, not per-project: the chosen view is written to
//      localStorage so the next project opens the same way.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { FilesTab } from '../src/renderer/components/project-view/tabs/FilesTab';
import { REVEAL_CHUNK } from '../src/renderer/hooks/use-chunked-reveal';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';

const listAllFiles = vi.fn();

// Two loose files and two files nested one folder deep, so listDir has both a
// file list and a folder to roll up.
const FILES = [
  { id: 'f1', kind: 'internal', path: 'notes.md', lastModified: new Date(Date.now() - 3 * 3600_000).toISOString() },
  { id: 'f2', kind: 'internal', path: 'chart.png', lastModified: new Date(Date.now() - 2 * 3600_000).toISOString() },
  { id: 'f3', kind: 'internal', path: 'docs/spec.md', lastModified: new Date().toISOString() },
  { id: 'f4', kind: 'internal', path: 'docs/plan.md', lastModified: new Date().toISOString() },
];

const project = { id: 'p1', path: '/proj', name: 'Proj' } as any;

function renderTab(view: 'grid' | 'list', search = '') {
  return render(
    <FilesTab
      project={project}
      search={search}
      types={new Set()}
      sortBy="name"
      view={view}
      onViewChange={vi.fn()}
      refreshKey={0}
      pvActiveId={null}
      artifactDispatch={vi.fn()}
    />,
  );
}

let io: ReturnType<typeof installFiringIntersectionObserver>;
beforeEach(() => {
  // The grid's thumbnails gate their reads on an IntersectionObserver, which
  // jsdom doesn't implement — without a stub the grid render throws and the
  // "cards, not rows" assertion fails for the wrong reason. A FIRING stub, not
  // a no-op: flat results now draw in chunks as a sentinel scrolls into view,
  // and a no-op observer would strand them at the first chunk unnoticed.
  io = installFiringIntersectionObserver();
  listAllFiles.mockResolvedValue({ ok: true, files: FILES });
  (window as any).claude = {
    artifacts: {
      listAllFiles,
      // The tab subscribes to file-change events and renders thumbnails; both
      // are irrelevant here, and both tolerate a rejected/absent channel.
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
      searchContent: () => Promise.resolve({ ok: true, hits: [] }),
    },
  };
});
afterEach(() => { cleanup(); io.restore(); vi.clearAllMocks(); });

describe('FilesTab list view', () => {
  it('gives each file a name, a kind and a relative time', async () => {
    const { findByTitle } = renderTab('list');
    const row = await findByTitle('notes.md');
    expect(row.textContent).toContain('notes.md');
    expect(row.textContent).toContain('Document');
    expect(row.textContent).toMatch(/ago|just now/);
  });

  it('gives a folder its file count and no date', async () => {
    const { findByTitle } = renderTab('list');
    const row = await findByTitle('docs');
    expect(row.textContent).toContain('2 files');
    expect(row.textContent).not.toMatch(/ago|just now/);
  });

  it('lists loose files before folders, as the grid does', async () => {
    const { container, findByTitle } = renderTab('list');
    await findByTitle('docs');
    const titles = [...container.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
    expect(titles.indexOf('chart.png')).toBeLessThan(titles.indexOf('docs'));
    expect(titles.indexOf('notes.md')).toBeLessThan(titles.indexOf('docs'));
  });

  // Which element scrolls, and why it matters. Both halves were live findings
  // on 2026-09-03, in this order:
  //   1. "there are no folders appearing in list view… or maybe it just isnt
  //      scrollable" — the box had taken the column's height and clipped every
  //      row past the fold (folders draw last), and the column saw no overflow
  //      so no scrollbar appeared. Measured at 1440x560: 9 rows, 3 visible.
  //   2. "this scrollbar is weird and sits outside the container it scrolls
  //      through" — the fix for (1) made the COLUMN scroll, which drew the bar
  //      in the gutter beside the rounded border instead of against the rows.
  // Browsing: the box scrolls itself, bar inside the border. Searching: the box
  // is natural height and the column scrolls, so headers, name matches and
  // content matches move as one. jsdom does no layout, so classes are the pin.
  const rowParent = (container: HTMLElement) =>
    container.querySelector('button[title="notes.md"]')!.parentElement!;

  it('scrolls inside its own border while browsing folders', async () => {
    const { container, findByTitle } = renderTab('list');
    await findByTitle('docs');
    const scroller = rowParent(container);
    expect(scroller.className).toContain('overflow-y-auto');
    // shrink-0 here would stop it taking the available height, so the COLUMN
    // would scroll again and the bar would leave the border.
    expect(scroller.className).not.toContain('shrink-0');
  });

  it('wraps the scroller in the rounded clip, so the bar cannot cross the corners', async () => {
    // Chromium paints a scrollbar in a gutter that its OWN border-radius does
    // not clip, so with the border and the scrolling on one element the thumb
    // ran over the rounded corners at the ends of its travel. An ancestor's
    // rounded overflow-hidden does clip it — hence two elements, not one.
    const { container, findByTitle } = renderTab('list');
    await findByTitle('docs');
    const wrap = rowParent(container).parentElement!;
    expect(wrap.className).toContain('rounded-lg');
    expect(wrap.className).toContain('overflow-hidden');
    expect(wrap.className).toContain('border');
  });

  it('hands scrolling back to the column when searching', async () => {
    const { container, findByTitle } = renderTab('list', 'notes');
    await findByTitle('notes.md');
    const box = rowParent(container);
    // Natural height: the name matches, their header and the content matches
    // below have to scroll together, not each in their own little window.
    expect(box.className).toContain('shrink-0');
    expect(box.className).not.toContain('overflow-y-auto');
  });

  it('draws cards, not rows, in grid view', async () => {
    const { container, findByTitle } = renderTab('grid');
    await findByTitle('notes.md');
    // The thumbnail is the card's defining part and the list has none.
    expect(container.querySelector('.h-44')).not.toBeNull();
  });
});

describe('flat search results', () => {
  // WHY both views: grid and list are separate draw sites over the same window.
  // Pinned on list alone, the grid (the default view, and what the DOM-size
  // sweep opens) could draw every match and this test stayed green — proven by
  // a break-it run in the render-cost consolidation's closing check (2026-09-18).
  it.each(['list', 'grid'] as const)('draw a chunk at a time and the rest as you scroll (%s view)', async (view) => {
    // A search over a big project is the 2,000-card case; drawing every match
    // at once is what made typing in the search box stall.
    const many = Array.from({ length: REVEAL_CHUNK * 2 + 20 }, (_, i) => ({
      id: `m${i}`, kind: 'internal', path: `match-${String(i).padStart(3, '0')}.md`,
      lastModified: new Date().toISOString(),
    }));
    listAllFiles.mockResolvedValue({ ok: true, files: many });
    const { container, findByTitle } = renderTab(view, 'match');
    await findByTitle('match-000.md');
    const rows = () => container.querySelectorAll('button[title^="match-"]').length;
    expect(rows()).toBe(REVEAL_CHUNK);
    act(() => io.fireAll());
    await waitFor(() => expect(rows()).toBe(REVEAL_CHUNK * 2));
    act(() => io.fireAll());
    await waitFor(() => expect(rows()).toBe(many.length));
  });
});

describe('the view preference', () => {
  it('is stored app-wide, not against a project id', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src/renderer/components/project-view/ProjectView.tsx'), 'utf8');
    // The key must not be interpolated with a project id — Q-4a chose ONE
    // answer to "what view am I in", not one per project.
    expect(src).toContain("const FILE_VIEW_KEY = 'youcoded.projectView.fileView'");
    expect(src).toMatch(/localStorage\.setItem\(FILE_VIEW_KEY, fileView\)/);
  });
});
