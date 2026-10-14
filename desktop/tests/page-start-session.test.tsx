// @vitest-environment jsdom
// Page start session (spec 2026-10-14, §2 and §4): PageHost between a page's
// `youcoded.startSession({ prompt, project? })` and App's new-session window.
// What is pinned is who may ask and where the conversation starts: only this
// page's own frame, only with an approved `session` line, only a sane message;
// a project page starts in its own project, a personal page on the saved
// default unless it suggests one of the person's own project folders.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';
import type { PageConnectionStatus, PageHome } from '../src/shared/pages-types';

const snapshot = vi.hoisted(() => ({ current: { pages: [] as any[], loaded: true, failed: false } }));
vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => snapshot.current,
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
}));

const SESSION: PageConnectionStatus = { id: 'start-session', kind: 'session', approved: true };
const PROJECT_HOME: PageHome = { kind: 'project', path: '/home/me/Lab', name: 'Lab' };

function pageDoc(home: PageHome, connections: PageConnectionStatus[]) {
  return { id: 'p:lab', name: 'Frontier Lab', description: '', icon: 'page', home, pinned: false, updatedAt: '', htmlStamp: 1, connections, html: '<p>lab</p>', data: null };
}

let current = pageDoc(PROJECT_HOME, [SESSION]);
let onStartSession: ReturnType<typeof vi.fn<(req: unknown) => void>>;

function Host() {
  return (
    <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: true, openPageId: 'p:lab' }, dispatch: vi.fn() }}>
      <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} onStartSession={onStartSession} />
    </ArtifactProvider>
  );
}

function use(doc: ReturnType<typeof pageDoc>) {
  current = doc;
  snapshot.current.pages = [{ ...doc, html: undefined }];
}

beforeEach(() => {
  onStartSession = vi.fn<(req: unknown) => void>();
  use(pageDoc(PROJECT_HOME, [SESSION]));
  (window as any).claude = {
    pages: { get: vi.fn(async () => ({ ok: true, page: current })), setData: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => []) },
    folders: { list: vi.fn(async () => [{ path: '/home/me/Lab' }, { path: '/home/me/Notes' }]) },
  };
});
afterEach(() => { delete (window as any).claude; });

/** Render, wait for the frame, and capture what the host answers into it. */
async function mount() {
  const view = render(<Host />);
  await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  // The frame can be in the document a beat before the host's listener effect
  // has run (the page loaded outside act); flush effects before the page asks.
  await act(async () => {});
  const frame = document.querySelector('iframe') as HTMLIFrameElement;
  const answers: unknown[] = [];
  (frame.contentWindow as Window).postMessage = ((m: unknown) => { answers.push(m); }) as Window['postMessage'];
  const ask = (data: Record<string, unknown>, source: unknown = frame.contentWindow) => {
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'youcoded:session:start', id: 'q1', ...data }, source: source as Window })); });
  };
  return { view, answers, ask };
}

describe('a page asking to open a new conversation', () => {
  it('opens the window in a project page\'s own project, with the message waiting, and tells the page', async () => {
    const { view, answers, ask } = await mount();
    // The page's own suggestion never moves a project page out of its project.
    ask({ prompt: 'Run the weekly update', project: '/home/me/Notes' });
    await waitFor(() => expect(onStartSession).toHaveBeenCalledWith({ prompt: 'Run the weekly update', cwd: '/home/me/Lab', pageName: 'Frontier Lab' }));
    await waitFor(() => expect(answers).toContainEqual({ type: 'youcoded:session:start:result', id: 'q1', result: { ok: true } }));
    view.unmount();
  });

  it('ignores a message that did not come from this page\'s frame', async () => {
    const { view, answers, ask } = await mount();
    ask({ prompt: 'from elsewhere' }, null);
    ask({ prompt: 'from the app' }, window);
    ask({ prompt: 'the real one', id: 'q2' });
    await waitFor(() => expect(onStartSession).toHaveBeenCalledTimes(1));
    expect(onStartSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'the real one' }));
    expect(answers).toHaveLength(1);
    view.unmount();
  });

  it('refuses a page whose manifest does not declare it', async () => {
    use(pageDoc(PROJECT_HOME, []));
    const { view, answers, ask } = await mount();
    ask({ prompt: 'please' });
    await waitFor(() => expect(answers).toContainEqual({ type: 'youcoded:session:start:result', id: 'q1', result: { ok: false } }));
    expect(onStartSession).not.toHaveBeenCalled();
    view.unmount();
  });

  it('refuses an empty or over-long message even when posted straight from page code', async () => {
    const { view, answers, ask } = await mount();
    ask({ prompt: '  ', id: 'a' });
    ask({ prompt: 'x'.repeat(20_001), id: 'b' });
    ask({ prompt: 7, id: 'c' });
    await waitFor(() => expect(answers).toHaveLength(3));
    for (const a of answers) expect(a).toMatchObject({ result: { ok: false } });
    expect(onStartSession).not.toHaveBeenCalled();
    view.unmount();
  });

  it('starts a personal page on the saved default — no folder chosen for it', async () => {
    use(pageDoc({ kind: 'personal' }, [SESSION]));
    const { view, ask } = await mount();
    ask({ prompt: 'hello' });
    await waitFor(() => expect(onStartSession).toHaveBeenCalledWith({ prompt: 'hello', cwd: undefined, pageName: 'Frontier Lab' }));
    view.unmount();
  });

  it('lets a personal page suggest one of the person\'s own project folders, and nothing else', async () => {
    use(pageDoc({ kind: 'personal' }, [SESSION]));
    const { view, ask } = await mount();
    ask({ prompt: 'in notes', project: '/home/me/Notes', id: 'a' });
    await waitFor(() => expect(onStartSession).toHaveBeenCalledWith({ prompt: 'in notes', cwd: '/home/me/Notes', pageName: 'Frontier Lab' }));
    ask({ prompt: 'somewhere odd', project: '/etc', id: 'b' });
    await waitFor(() => expect(onStartSession).toHaveBeenCalledWith({ prompt: 'somewhere odd', cwd: undefined, pageName: 'Frontier Lab' }));
    view.unmount();
  });
});
