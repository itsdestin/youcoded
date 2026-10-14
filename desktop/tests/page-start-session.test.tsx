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
import { render, act, waitFor, renderHook } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';
import { usePageCreate } from '../src/renderer/components/pages/PageCreateDialog';
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
let onStartSession: ReturnType<typeof vi.fn<(req: unknown) => boolean>>;

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
  onStartSession = vi.fn<(req: unknown) => boolean>(() => true);
  // The person just clicked (review F2): the host checks its own window's
  // activation, which a click inside the frame also sets. jsdom has none.
  Object.defineProperty(window.navigator, 'userActivation', { value: { isActive: true }, configurable: true });
  use(pageDoc(PROJECT_HOME, [SESSION]));
  (window as any).claude = {
    pages: { get: vi.fn(async () => ({ ok: true, page: current })), setData: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => []) },
    folders: { list: vi.fn(async () => [{ path: '/home/me/Lab' }, { path: '/home/me/Notes' }]) },
  };
});
afterEach(() => { delete (window as any).claude; delete (window.navigator as any).userActivation; });

/** Render, wait for the frame, and capture what the host answers into it. */
async function mount() {
  const view = render(<Host />);
  await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  // The frame can be in the document a beat before the host's listener effect
  // has run (the page loaded outside act); flush effects before the page asks.
  await act(async () => {});
  const frame = document.querySelector('iframe') as HTMLIFrameElement;
  // The click that asked was inside the page, so the page holds the focus.
  frame.focus();
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
    await waitFor(() => expect(answers).toContainEqual({ type: 'youcoded:session:start:result', id: 'q1', result: { ok: false, reason: expect.stringMatching(/not been allowed/) } }));
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
    // Review F6: another spelling of the same saved folder still matches, and
    // the answer is the person's own entry as saved, not the page's spelling.
    ask({ prompt: 'spelt oddly', project: '\\HOME\\me\\notes\\', id: 'c' });
    await waitFor(() => expect(onStartSession).toHaveBeenCalledWith({ prompt: 'spelt oddly', cwd: '/home/me/Notes', pageName: 'Frontier Lab' }));
    view.unmount();
  });

  // Review F1: posted straight from page code, past the bootstrap's own check.
  it('refuses a message carrying hidden characters, and says why', async () => {
    const { view, answers, ask } = await mount();
    ask({ prompt: 'Summarise this\u{E0061}\u{E0064}', id: 'a' });
    ask({ prompt: 'looks​fine', id: 'b' });
    ask({ prompt: 'abc‮dcb', id: 'c' });
    await waitFor(() => expect(answers).toHaveLength(3));
    for (const a of answers) expect(a).toMatchObject({ result: { ok: false, reason: expect.stringMatching(/hidden characters/) } });
    expect(onStartSession).not.toHaveBeenCalled();
    view.unmount();
  });

  // Review F2: a page on a timer, or one reopening the window right after
  // Cancel, has no fresh click inside the page behind it.
  it('refuses without a fresh click, or when the click was not in the page', async () => {
    const { view, answers, ask } = await mount();
    Object.defineProperty(window.navigator, 'userActivation', { value: { isActive: false }, configurable: true });
    ask({ prompt: 'on a timer', id: 'a' });
    Object.defineProperty(window.navigator, 'userActivation', { value: { isActive: true }, configurable: true });
    // The click was on the app (e.g. Cancel), and focus is no longer in the page.
    (document.activeElement as HTMLElement | null)?.blur();
    ask({ prompt: 'after cancel', id: 'b' });
    await waitFor(() => expect(answers).toHaveLength(2));
    for (const a of answers) expect(a).toMatchObject({ result: { ok: false, reason: expect.stringMatching(/click/) } });
    expect(onStartSession).not.toHaveBeenCalled();
    view.unmount();
  });

  it('tells the page when the window is already open, rather than replacing it', async () => {
    onStartSession.mockReturnValue(false);
    const { view, answers, ask } = await mount();
    ask({ prompt: 'second' });
    await waitFor(() => expect(answers).toContainEqual({ type: 'youcoded:session:start:result', id: 'q1', result: { ok: false, reason: expect.stringMatching(/already open/) } }));
    view.unmount();
  });

  // Review F3: Remove pressed on the session line while the folder list was read.
  it('does not open the window if the approval was removed while the folder was looked up', async () => {
    use(pageDoc({ kind: 'personal' }, [SESSION]));
    let release: (v: unknown) => void = () => {};
    (window as any).claude.folders.list = vi.fn(() => new Promise((r) => { release = r; }));
    const { view, answers, ask } = await mount();
    ask({ prompt: 'in notes', project: '/home/me/Notes' });
    const gets = (window as any).claude.pages.get.mock.calls.length;
    use(pageDoc({ kind: 'personal' }, [{ ...SESSION, approved: false }]));
    view.rerender(<Host />);
    await waitFor(() => expect((window as any).claude.pages.get.mock.calls.length).toBeGreaterThan(gets));
    await act(async () => {});
    await act(async () => { release([{ path: '/home/me/Notes' }]); });
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ result: { ok: false } });
    expect(onStartSession).not.toHaveBeenCalled();
    view.unmount();
  });
});

// Review F2: App's side. A second request while the window is open is turned
// down, never swapped in — it would change the message under the person's eyes
// and put back the folder, model and toggle they had just changed.
describe('the new-conversation window a page opens', () => {
  const req = (prompt: string) => ({ prompt, cwd: undefined, pageName: 'Frontier Lab' });
  it('opens once, keeps the first request while open, and opens again after it closes', () => {
    const { result } = renderHook(() => usePageCreate());
    let first = false; let second = true;
    act(() => {
      // Back to back in one tick: the second must still see the window as open.
      first = result.current[2](req('one'));
      second = result.current[2](req('two'));
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(result.current[0]).toMatchObject({ initialInput: 'one', title: 'Start a conversation', subtitle: 'From Frontier Lab' });
    act(() => { result.current[1](null); });
    let third = false;
    act(() => { third = result.current[2](req('three')); });
    expect(third).toBe(true);
    expect(result.current[0]).toMatchObject({ initialInput: 'three' });
  });

  it('does not let a page replace a Create a page window either', () => {
    const { result } = renderHook(() => usePageCreate());
    act(() => { result.current[1]({ title: 'Create a page', initialInput: '/page-builder ' }); });
    let ok = true;
    act(() => { ok = result.current[2](req('sneaky')); });
    expect(ok).toBe(false);
    expect(result.current[0]).toMatchObject({ title: 'Create a page' });
  });
});
