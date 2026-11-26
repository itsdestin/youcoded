// @vitest-environment jsdom
// Card #134 round 4: the open file's "Copy path" in the Project View Files tab says "Couldn't copy the path." when the copy fails
// and stays quiet (ticks "Copied") when it works. The real FilesTab is rendered with a file already selected.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { FilesTab } from '../src/renderer/components/project-view/tabs/FilesTab';
import { folderPageFromRecords } from '../src/shared/artifacts/folder-page';
import { DESKTOP_WINDOW_CAPABILITIES } from '../src/shared/capabilities';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';

const FILES = [{ id: 'f1', kind: 'internal', path: 'notes.md', lastModified: new Date().toISOString() }];
const project = { id: 'p1', path: '/proj', name: 'Proj' } as any;
let got: string[]; const on = (e: Event) => got.push((e as CustomEvent).detail.message);

beforeEach(() => {
  got = []; window.addEventListener(APP_NOTICE_EVENT, on);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  installFiringIntersectionObserver();
  // wide viewport declared: the open file's header shows its tools as labelled buttons
  (window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  (window as any).claude = {
    capabilities: DESKTOP_WINDOW_CAPABILITIES,
    artifacts: {
      listAllFiles: () => Promise.resolve({ ok: true, files: FILES }),
      listFolder: (_id: string, dir: string, opts: any) => Promise.resolve(folderPageFromRecords(FILES as any, dir, opts)),
      listProjectsIndex: () => Promise.resolve({ ok: true, projects: [project] }),
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
      searchContent: () => Promise.resolve({ ok: true, hits: [] }),
    },
    project: { repoInfo: () => Promise.resolve(null) },
    syncSpaces: { status: () => Promise.reject(new Error('no sync in tests')), onEvent: () => () => {} },
    tags: { list: () => Promise.resolve([]) },
    on: {},
  };
});
afterEach(() => { window.removeEventListener(APP_NOTICE_EVENT, on); cleanup(); delete (navigator as any).clipboard; delete (document as any).execCommand; delete (window as any).claude; vi.restoreAllMocks(); });

const clip = (writeText: () => Promise<void>, legacy: boolean) => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  (document as any).execCommand = vi.fn(() => legacy);
};
async function openFile() {
  await act(async () => {
    render(<FilesTab project={project} search="" types={new Set()} sortBy="name" view="list" onViewChange={vi.fn()} refreshKey={0} hidden={false} pvActiveId="f1" artifactDispatch={vi.fn()} />);
  });
  return screen.findByRole('button', { name: /Copy path/ });
}

describe('Files tab: Copy path', () => {
  it('says "Couldn\'t copy the path." when neither way of copying works', async () => {
    clip(() => Promise.reject(new Error('denied')), false);
    const btn = await openFile();
    await act(async () => { fireEvent.click(btn); });
    await vi.waitFor(() => expect(got).toEqual(["Couldn't copy the path."]));
  });
  it('a copy that works ticks "Copied" and says nothing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clip(writeText, false);
    const btn = await openFile();
    await act(async () => { fireEvent.click(btn); });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('/proj/notes.md');
    expect(got).toEqual([]);
  });
});
