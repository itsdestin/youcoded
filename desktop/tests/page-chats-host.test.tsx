// @vitest-environment jsdom
// Pages read and change chats, and run programs (spec 2026-10-16): PageHost between a page's
// `youcoded.chats.*` / `youcoded.program.run` and the app. What is pinned is who may ask and what they get:
// only this page's own frame, only with an APPROVED line, only the chats inside the line's scope, changes only
// with access "full", opening a chat only right after a real click, and never a word that was said in a chat.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';
import { resetPageChatsCache } from '../src/renderer/components/pages/page-chats';
import type { PageChatScope, PageConnectionStatus } from '../src/shared/pages-types';

const snapshot = vi.hoisted(() => ({ current: { pages: [] as any[], loaded: true, failed: false } }));
vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => snapshot.current,
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
}));

const TAGS = [
  { id: 'tag_work', label: 'Work', color: 'tag-blue', archived: false, createdAt: '' },
  { id: 'tag_home', label: 'Home', color: 'tag-green', archived: false, createdAt: '' },
];
// What session.browse({ includeOpen: true }) answers. Deliberately carries fields a page must never see
// (size, projectSlug, device) to prove the page's copy is built from a short list, not passed through.
const ROWS = [
  { sessionId: 'c-lab1', name: 'Fix the login', projectSlug: 'lab', projectPath: '/home/me/Lab', lastModified: Date.parse('2026-10-15T10:00:00Z'), size: 9000, device: 'laptop', provider: 'claude',
    tags: ['tag_work', 'tag_gone'], note: 'next: tests', flags: { priority: true }, lastUsedModel: { modelId: 'claude-opus-5-20260101', providerType: 'claude-code', providerLabel: 'Claude Code' },
    branch: '12-login-fix', created: Date.parse('2026-10-01T08:00:00Z'), open: true },
  { sessionId: 'c-lab2', name: 'Old idea', projectSlug: 'lab', projectPath: '/home/me/Lab', lastModified: Date.parse('2026-09-01T10:00:00Z'), size: 100, flags: { complete: true } },
  { sessionId: 'c-notes', name: 'Groceries', projectSlug: 'notes', projectPath: '/home/me/Notes', lastModified: Date.parse('2026-10-10T10:00:00Z'), size: 100, tags: ['tag_home'] },
  { sessionId: 'c-away', name: 'From another computer', projectSlug: '', projectPath: '/Users/x/Away', lastModified: Date.parse('2026-10-09T10:00:00Z'), size: 0, missingProject: true },
];

const PAGE_ID = 'p:board';
function chatsLine(access: 'lookup' | 'full', scope: PageChatScope = { all: true }, approved = true): PageConnectionStatus {
  return { id: 'chats', kind: 'chats', access, scope, approved };
}
function pageDoc(connections: PageConnectionStatus[]) {
  return { id: PAGE_ID, name: 'Work board', description: '', icon: 'page', home: { kind: 'personal' }, pinned: false, updatedAt: '', htmlStamp: 1, connections, html: '<p>board</p>', data: null };
}
let current = pageDoc([]);
function use(connections: PageConnectionStatus[]) {
  current = pageDoc(connections);
  snapshot.current.pages = [{ ...current, html: undefined }];
}

let session: Record<string, ReturnType<typeof vi.fn>>;
let pagesApi: Record<string, ReturnType<typeof vi.fn>>;

function Host() {
  return (
    <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: true, openPageId: PAGE_ID }, dispatch: vi.fn() }}>
      <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
    </ArtifactProvider>
  );
}

beforeEach(() => {
  resetPageChatsCache();
  Object.defineProperty(window.navigator, 'userActivation', { value: { isActive: true }, configurable: true });
  session = {
    browse: vi.fn(async () => ROWS.map((r) => ({ ...r }))),
    setTag: vi.fn(async () => ({ ok: true })),
    setNote: vi.fn(async () => ({ ok: true })),
    setFlag: vi.fn(async () => ({ ok: true })),
  };
  pagesApi = {
    get: vi.fn(async () => ({ ok: true, page: current })),
    setData: vi.fn(async () => ({ ok: true })),
    list: vi.fn(async () => []),
    runProgram: vi.fn(async () => ({ ok: true, output: 'done', exitCode: 0 })),
    stopPrograms: vi.fn(async () => ({ ok: true })),
  };
  (window as any).claude = { pages: pagesApi, session, tags: { list: vi.fn(async () => TAGS) } };
  use([chatsLine('lookup')]);
});
afterEach(() => { delete (window as any).claude; delete (window.navigator as any).userActivation; });

async function mount() {
  const view = render(<Host />);
  await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  await act(async () => {});
  const frame = document.querySelector('iframe') as HTMLIFrameElement;
  frame.focus(); // the click that asked was inside the page
  const answers: any[] = [];
  (frame.contentWindow as Window).postMessage = ((m: unknown) => { answers.push(m); }) as Window['postMessage'];
  let n = 0;
  const ask = (request: Record<string, unknown>, source: unknown = frame.contentWindow) => {
    const id = `q${++n}`;
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'youcoded:chats', id, request }, source: source as Window })); });
    return id;
  };
  const answerFor = async (id: string) => {
    await waitFor(() => expect(answers.some((a) => a.id === id)).toBe(true));
    return answers.find((a) => a.id === id).result;
  };
  return { view, frame, answers, ask, answerFor };
}

describe('a page asking for the chat list', () => {
  it('gets each chat\'s name, dates, tags, note, project, model, marks, branch and whether it is open', async () => {
    const { view, ask, answerFor } = await mount();
    const r = await answerFor(ask({ op: 'list' }));
    expect(r.ok).toBe(true);
    expect(r.chats).toHaveLength(4);
    expect(r.chats[0]).toEqual({
      id: 'c-lab1', name: 'Fix the login', lastActive: '2026-10-15T10:00:00.000Z', created: '2026-10-01T08:00:00.000Z',
      // A tag deleted from the app is left out; the rest carry the app's colour name.
      tags: [{ id: 'tag_work', name: 'Work', color: 'tag-blue' }],
      note: 'next: tests', project: { name: 'Lab', path: '/home/me/Lab' },
      // The Resume card's wording: no release date on the model.
      model: 'claude-opus-5', pinned: true, complete: false, branch: '12-login-fix', open: true,
    });
    expect(r.chats[1]).toMatchObject({ id: 'c-lab2', pinned: false, complete: true, open: false, branch: null, created: null, model: null, tags: [], note: '' });
    view.unmount();
  });

  it('never hands the page anything beyond that short list', async () => {
    const { view, ask, answerFor } = await mount();
    const r = await answerFor(ask({ op: 'list' }));
    const allowed = ['id', 'name', 'lastActive', 'created', 'tags', 'note', 'project', 'model', 'pinned', 'complete', 'branch', 'open'];
    for (const chat of r.chats) expect(Object.keys(chat).sort()).toEqual([...allowed].sort());
    view.unmount();
  });

  it('shares one read between calls made together, and reads fresh after a change', async () => {
    use([chatsLine('full')]);
    const { view, ask, answerFor } = await mount();
    await answerFor(ask({ op: 'list' }));
    await answerFor(ask({ op: 'list' }));
    expect(session.browse).toHaveBeenCalledTimes(1);
    expect(session.browse).toHaveBeenCalledWith({ includeOpen: true });
    await answerFor(ask({ op: 'setNote', chat: 'c-lab1', text: 'x' }));
    await answerFor(ask({ op: 'list' }));
    expect(session.browse).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('lists only chats in the named projects — by the project\'s name or its exact path', async () => {
    use([chatsLine('lookup', { projects: ['Lab', '/home/me/Notes'] })]);
    const { view, ask, answerFor } = await mount();
    const r = await answerFor(ask({ op: 'list' }));
    expect(r.chats.map((c: any) => c.id).sort()).toEqual(['c-lab1', 'c-lab2', 'c-notes']);
    view.unmount();
  });

  it('lists only chats with the named tag — by its name (any case) or its id', async () => {
    use([chatsLine('lookup', { tag: 'work' })]);
    let m = await mount();
    expect((await m.answerFor(m.ask({ op: 'list' }))).chats.map((c: any) => c.id)).toEqual(['c-lab1']);
    m.view.unmount();
    resetPageChatsCache();
    use([chatsLine('lookup', { tag: 'tag_home' })]);
    m = await mount();
    expect((await m.answerFor(m.ask({ op: 'list' }))).chats.map((c: any) => c.id)).toEqual(['c-notes']);
    m.view.unmount();
  });

  it('lists nothing for a tag that does not exist, and refuses when the tag list cannot be read', async () => {
    use([chatsLine('lookup', { tag: 'Nope' })]);
    let m = await mount();
    expect(await m.answerFor(m.ask({ op: 'list' }))).toEqual({ ok: true, chats: [] });
    m.view.unmount();
    resetPageChatsCache();
    (window as any).claude.tags.list = vi.fn(async () => ({ ok: false, error: 'broken' }));
    use([chatsLine('lookup', { tag: 'Work' })]);
    m = await mount();
    expect(await m.answerFor(m.ask({ op: 'list' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be read/) });
    m.view.unmount();
  });

  it('is not even framed while its chats line waits for a yes, so nothing is read', async () => {
    use([chatsLine('lookup', { all: true }, false)]);
    const view = render(<Host />);
    await act(async () => {});
    await waitFor(() => expect(pagesApi.get).toHaveBeenCalled());
    await act(async () => {});
    expect(document.querySelector('iframe')).toBeNull();
    expect(session.browse).not.toHaveBeenCalled();
    view.unmount();
  });

  it('is refused for a page with no chats line at all, even if page code posts the message itself', async () => {
    use([{ id: 'start-session', kind: 'session', approved: true }]);
    const { view, ask, answerFor } = await mount();
    expect(await answerFor(ask({ op: 'list' }))).toEqual({ ok: false, reason: expect.stringMatching(/not been allowed to see your chats/) });
    expect(session.browse).not.toHaveBeenCalled();
    view.unmount();
  });

  it('ignores a message that did not come from this page\'s frame', async () => {
    const { view, answers, ask, answerFor } = await mount();
    ask({ op: 'list' }, null);
    ask({ op: 'list' }, window);
    await answerFor(ask({ op: 'list' }));
    expect(answers).toHaveLength(1);
    view.unmount();
  });

  it('answers a broken request with a plain refusal', async () => {
    const { view, ask, answerFor } = await mount();
    for (const request of [{ op: 'delete', chat: 'c-lab1' }, { op: 'resume' }, { op: 'setTag', chat: 'c-lab1' }, {}]) {
      expect(await answerFor(ask(request))).toEqual({ ok: false, reason: expect.stringMatching(/not understood/) });
    }
    view.unmount();
  });

  it('says so when the chats cannot be read', async () => {
    session.browse.mockRejectedValue(new Error('x'));
    const { view, ask, answerFor } = await mount();
    expect(await answerFor(ask({ op: 'list' }))).toEqual({ ok: false, reason: expect.stringMatching(/could not be read/) });
    view.unmount();
  });
});

describe('a page opening a chat', () => {
  let resumed: any[];
  const onResume = (e: Event) => { resumed.push((e as CustomEvent).detail); };
  beforeEach(() => { resumed = []; window.addEventListener('youcoded:resume-session', onResume); });
  afterEach(() => { window.removeEventListener('youcoded:resume-session', onResume); });

  it('asks the app to resume it, the way chat search does, right after a click', async () => {
    const { view, ask, answerFor } = await mount();
    expect(await answerFor(ask({ op: 'resume', chat: 'c-notes' }))).toEqual({ ok: true });
    expect(resumed).toEqual([{ claudeSessionId: 'c-notes', projectSlug: 'notes', projectPath: '/home/me/Notes', provider: undefined }]);
    view.unmount();
  });

  it('is refused when the person has not just clicked in the page', async () => {
    const { view, frame, ask, answerFor } = await mount();
    (window.navigator as any).userActivation.isActive = false; // a timer, not a person
    expect(await answerFor(ask({ op: 'resume', chat: 'c-notes' }))).toEqual({ ok: false, reason: expect.stringMatching(/click/) });
    (window.navigator as any).userActivation.isActive = true;
    frame.blur(); // a click elsewhere in the app: the page does not hold the focus
    expect(await answerFor(ask({ op: 'resume', chat: 'c-notes' }))).toEqual({ ok: false, reason: expect.stringMatching(/click/) });
    expect(resumed).toEqual([]);
    view.unmount();
  });

  it('is refused for a chat outside the page\'s scope, and for one that cannot be opened here', async () => {
    use([chatsLine('lookup', { projects: ['Lab'] })]);
    const { view, ask, answerFor } = await mount();
    expect(await answerFor(ask({ op: 'resume', chat: 'c-notes' }))).toEqual({ ok: false, reason: expect.stringMatching(/not one of the chats/) });
    expect(await answerFor(ask({ op: 'resume', chat: 'no-such-chat' }))).toEqual({ ok: false, reason: expect.stringMatching(/not one of the chats/) });
    view.unmount();
    resetPageChatsCache();
    use([chatsLine('lookup')]);
    const m = await mount();
    expect(await m.answerFor(m.ask({ op: 'resume', chat: 'c-away' }))).toEqual({ ok: false, reason: expect.stringMatching(/cannot be opened on this computer/) });
    expect(resumed).toEqual([]);
    m.view.unmount();
  });
});

describe('a page changing tags, notes and marks', () => {
  it('is refused with a look-up line — for every kind of change — and nothing is written', async () => {
    const { view, ask, answerFor } = await mount();
    for (const request of [
      { op: 'setTag', chat: 'c-lab1', tag: 'Work', on: false },
      { op: 'setNote', chat: 'c-lab1', text: 'hi' },
      { op: 'setMark', chat: 'c-lab1', mark: 'pinned', on: false },
    ]) {
      expect(await answerFor(ask(request))).toEqual({ ok: false, reason: expect.stringMatching(/look at your chats but has not been allowed to change/) });
    }
    expect(session.setTag).not.toHaveBeenCalled();
    expect(session.setNote).not.toHaveBeenCalled();
    expect(session.setFlag).not.toHaveBeenCalled();
    view.unmount();
  });

  it('with a full line: sets a tag by name or id, a note, and the pinned and complete marks', async () => {
    use([chatsLine('full')]);
    const { view, ask, answerFor } = await mount();
    expect(await answerFor(ask({ op: 'setTag', chat: 'c-notes', tag: 'work', on: true }))).toEqual({ ok: true });
    expect(session.setTag).toHaveBeenLastCalledWith('c-notes', 'tag_work', true);
    expect(await answerFor(ask({ op: 'setTag', chat: 'c-notes', tag: 'tag_home', on: false }))).toEqual({ ok: true });
    expect(session.setTag).toHaveBeenLastCalledWith('c-notes', 'tag_home', false);
    expect(await answerFor(ask({ op: 'setNote', chat: 'c-notes', text: 'buy milk' }))).toEqual({ ok: true });
    expect(session.setNote).toHaveBeenLastCalledWith('c-notes', 'buy milk');
    // "Pinned" is the app's Priority mark ("pins to top").
    expect(await answerFor(ask({ op: 'setMark', chat: 'c-notes', mark: 'pinned', on: true }))).toEqual({ ok: true });
    expect(session.setFlag).toHaveBeenLastCalledWith('c-notes', 'priority', true);
    expect(await answerFor(ask({ op: 'setMark', chat: 'c-notes', mark: 'complete', on: true }))).toEqual({ ok: true });
    expect(session.setFlag).toHaveBeenLastCalledWith('c-notes', 'complete', true);
    view.unmount();
  });

  it('has no way to rename or delete a chat, or to change a mark it does not know', async () => {
    use([chatsLine('full')]);
    const { view, ask, answerFor } = await mount();
    for (const request of [{ op: 'rename', chat: 'c-notes', name: 'x' }, { op: 'delete', chat: 'c-notes' }, { op: 'setMark', chat: 'c-notes', mark: 'helpful', on: true }]) {
      expect(await answerFor(ask(request))).toMatchObject({ ok: false });
    }
    expect(session.setFlag).not.toHaveBeenCalled();
    view.unmount();
  });

  it('refuses a chat outside the scope, a tag the app does not have, and a note over the app\'s limit', async () => {
    use([chatsLine('full', { projects: ['Lab'] })]);
    const { view, ask, answerFor } = await mount();
    expect(await answerFor(ask({ op: 'setNote', chat: 'c-notes', text: 'sneaky' }))).toEqual({ ok: false, reason: expect.stringMatching(/not one of the chats/) });
    expect(await answerFor(ask({ op: 'setTag', chat: 'c-notes', tag: 'Work', on: true }))).toEqual({ ok: false, reason: expect.stringMatching(/not one of the chats/) });
    expect(await answerFor(ask({ op: 'setMark', chat: 'c-notes', mark: 'pinned', on: true }))).toEqual({ ok: false, reason: expect.stringMatching(/not one of the chats/) });
    expect(await answerFor(ask({ op: 'setTag', chat: 'c-lab1', tag: 'Invented', on: true }))).toEqual({ ok: false, reason: expect.stringMatching(/does not exist/) });
    expect(await answerFor(ask({ op: 'setNote', chat: 'c-lab1', text: 'x'.repeat(8001) }))).toEqual({ ok: false, reason: expect.stringMatching(/8,000/) });
    expect(session.setTag).not.toHaveBeenCalled();
    expect(session.setNote).not.toHaveBeenCalled();
    expect(session.setFlag).not.toHaveBeenCalled();
    view.unmount();
  });

  it('passes on the app\'s own reason when it cannot save', async () => {
    use([chatsLine('full')]);
    session.setNote.mockResolvedValue({ ok: false, error: 'the conversation store is busy' });
    const { view, ask, answerFor } = await mount();
    expect(await answerFor(ask({ op: 'setNote', chat: 'c-notes', text: 'hi' }))).toEqual({ ok: false, reason: 'the conversation store is busy' });
    view.unmount();
  });
});

describe('a page running a program', () => {
  const PROGRAM: PageConnectionStatus = { id: 'work', kind: 'program', file: 'work-items.mjs', approved: true };
  async function mountProgram() {
    const m = await mount();
    let n = 0;
    const run = async (data: Record<string, unknown>, source: unknown = m.frame.contentWindow) => {
      const id = `g${++n}`;
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'youcoded:program', id, ...data }, source: source as Window })); });
      await waitFor(() => expect(m.answers.some((a) => a.id === id && a.type === 'youcoded:program:result')).toBe(true));
      return m.answers.find((a) => a.id === id && a.type === 'youcoded:program:result').result;
    };
    return { ...m, run };
  }

  it('runs an allowed file with its input and hands back the answer', async () => {
    use([PROGRAM]);
    const { view, run } = await mountProgram();
    expect(await run({ file: 'work-items.mjs', input: '{"a":1}' })).toEqual({ ok: true, output: 'done', exitCode: 0 });
    expect(pagesApi.runProgram).toHaveBeenCalledWith(PAGE_ID, 'work-items.mjs', '{"a":1}');
    view.unmount();
  });

  it('refuses a file the page has no allowed line for, a bad input, and a message from elsewhere', async () => {
    use([PROGRAM]);
    const { view, answers, run } = await mountProgram();
    expect(await run({ file: 'other.mjs', input: '' })).toEqual({ ok: false, reason: expect.stringMatching(/not been allowed/) });
    expect(await run({ file: 'work-items.mjs', input: 7 })).toEqual({ ok: false, reason: expect.stringMatching(/not valid/) });
    const before = answers.length;
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'youcoded:program', id: 'z', file: 'work-items.mjs', input: '' }, source: window })); });
    expect(answers).toHaveLength(before);
    expect(pagesApi.runProgram).not.toHaveBeenCalled();
    view.unmount();
  });

  it('stops what the page started when the page closes', async () => {
    use([PROGRAM]);
    const { view } = await mountProgram();
    expect(pagesApi.stopPrograms).not.toHaveBeenCalled();
    view.unmount();
    expect(pagesApi.stopPrograms).toHaveBeenCalledWith(PAGE_ID);
  });

  it('asks for nothing to be stopped on a page without a program', async () => {
    use([chatsLine('lookup')]);
    const { view } = await mount();
    view.unmount();
    expect(pagesApi.stopPrograms).not.toHaveBeenCalled();
  });
});
