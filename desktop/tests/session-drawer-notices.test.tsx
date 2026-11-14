// @vitest-environment jsdom
// Card #134 round 4 (part 1): the file pane's buttons say so when they fail, rendered through the REAL SessionDrawer in the real
// ArtifactContext. Copy path, Open with the default app, Remove from list (toasts) and rename (the field stays open with
// "Couldn't rename this file."). Each has a real-failure test and a no-false-alarm test.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../src/shared/artifacts/types';
import { __resetMissingArtifactsCache } from '../src/renderer/hooks/useMissingArtifacts';
import { DESKTOP_WINDOW_CAPABILITIES } from '../src/shared/capabilities';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';

// useTheme reads storage/matchMedia/fonts on mount; give SessionDrawer only the fields it reads (as SessionDrawer.test.tsx does).
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ hideCodeAndConfigs: false, setHideCodeAndConfigs: vi.fn(), showDeletedArtifacts: false, setShowDeletedArtifacts: vi.fn(), drawerWidth: 420, setDrawerWidth: vi.fn(), resetDrawerWidth: vi.fn() }),
}));
import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
let t: ReturnType<typeof toasts>;
const unsupported = Object.assign(new Error('remote-unsupported: shell:open-path'), { code: 'REMOTE_UNSUPPORTED' });
// settle: for negative assertions, let any late toast arrive first.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

const artifact: ArtifactRecord = {
  id: 'a1', path: 'notes.md', kind: 'internal', absolutePath: null, lastModified: new Date().toISOString(), status: 'active',
  versions: [{ id: 'v1', ts: new Date().toISOString(), sessionId: 'sess', type: 'create', author: 'agent' }], comments: [], tags: [],
};

beforeAll(() => { (window as any).IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } }; });
beforeEach(() => {
  t = toasts();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // wide viewport declared: the drawer branches on width (list vs stacked)
  (window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => { t.off(); cleanup(); __resetMissingArtifactsCache(); delete (window as any).claude; vi.restoreAllMocks(); });

function mount(artifacts: Record<string, any> = {}, shell: Record<string, any> = {}) {
  const dispatch = vi.fn();
  const api = {
    get: vi.fn(() => new Promise(() => {})),
    checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
    listSession: vi.fn().mockResolvedValue({ ok: true, artifacts: [artifact] }),
    onChanged: undefined,
    ...artifacts,
  };
  (window as any).claude = { capabilities: DESKTOP_WINDOW_CAPABILITIES, artifacts: api, shell };
  const state = { ...initialArtifactState, sessionArtifacts: { sess: [artifact] }, drawerOpenBySession: { sess: true }, activeArtifactBySession: { sess: 'a1' } };
  render(<ArtifactContext.Provider value={{ state, dispatch }}>
    <SessionDrawer sessionId="sess" projectRoot="/home/u/proj" cwd="/home/u/proj" projectId="proj-1" projectName="proj" />
  </ArtifactContext.Provider>);
  return { dispatch, api };
}
const press = (name: string | RegExp) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });

describe('Copy path', () => {
  const clip = (writeText: () => Promise<void>, legacy: boolean) => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    (document as any).execCommand = vi.fn(() => legacy);
  };
  afterEach(() => { delete (navigator as any).clipboard; delete (document as any).execCommand; });
  it('says "Couldn\'t copy the path." when neither way of copying works', async () => {
    clip(() => Promise.reject(new Error('denied')), false);
    mount();
    await press('Copy path');
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't copy the path."]));
  });
  it('a copy that works ticks "Copied" and says nothing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clip(writeText, false);
    mount();
    await press('Copy path');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('/home/u/proj/notes.md');
    expect(t.got).toEqual([]);
  });
});

describe('Open with the default app', () => {
  it('says "Couldn\'t open the file." when the computer answers with an error text', async () => {
    const openPath = vi.fn().mockResolvedValue('No application is associated with this file');
    mount({}, { openPath });
    await press('Open with the default app');
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't open the file."]));
    expect(openPath).toHaveBeenCalledWith('/home/u/proj/notes.md');
  });
  it('says it for a rejected call too', async () => {
    mount({}, { openPath: vi.fn().mockRejectedValue(new Error('ipc closed')) });
    await press('Open with the default app');
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't open the file."]));
  });
  it('an empty answer (opened fine) says nothing', async () => {
    const openPath = vi.fn().mockResolvedValue('');
    mount({}, { openPath });
    await press('Open with the default app');
    await vi.waitFor(() => expect(openPath).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection says nothing', async () => {
    const openPath = vi.fn().mockRejectedValue(unsupported);
    mount({}, { openPath });
    await press('Open with the default app');
    await vi.waitFor(() => expect(openPath).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});

describe('Remove from list', () => {
  // The list column is collapsed while a file is open; show it, then press the row's remove button.
  // The drawer reads the list itself on mount, so wait for that read and clear the mocks first: only calls made BY the removal count.
  const remove = async (m?: { api: any; dispatch: any }) => { await press('Show list'); if (m) { await vi.waitFor(() => expect(m.api.listSession).toHaveBeenCalled()); await settle(); m.api.listSession.mockClear(); m.dispatch.mockClear(); } await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^Remove notes\.md from this list/ })); }); };
  it('a refusal says "Couldn\'t remove this from the list." and leaves the list alone', async () => {
    const m = mount({ removeRecord: vi.fn().mockResolvedValue({ ok: false, error: 'write conflict' }) });
    const { dispatch, api } = m;
    await remove(m);
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't remove this from the list."]));
    expect(api.listSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ACTIVE_ARTIFACT_CLEARED' }));
  });
  it('a rejected call says it too', async () => {
    mount({ removeRecord: vi.fn().mockRejectedValue(new Error('ipc closed')) });
    await remove();
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't remove this from the list."]));
  });
  it('a removal that works re-reads the list and says nothing', async () => {
    const m = mount({ removeRecord: vi.fn().mockResolvedValue({ ok: true }) });
    const { api, dispatch } = m;
    await remove(m);
    await vi.waitFor(() => expect(api.listSession).toHaveBeenCalled());
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SESSION_ARTIFACTS_LOADED' })));
    expect(t.got).toEqual([]);
  });
  it('a phone with no removeRecord at all stays quiet (nothing was attempted)', async () => {
    const m = mount({ removeRecord: undefined });
    const { api } = m;
    await remove(m);
    // settle: nothing to wait on when nothing is attempted.
    await settle();
    expect(api.listSession).not.toHaveBeenCalled();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection says nothing', async () => {
    const removeRecord = vi.fn().mockRejectedValue(unsupported);
    mount({ removeRecord });
    await remove();
    await vi.waitFor(() => expect(removeRecord).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});

describe('rename', () => {
  async function rename(renameImpl: any) {
    const m = mount({ rename: renameImpl });
    await act(async () => { fireEvent.click(document.querySelector('button.cursor-text')!); });
    const input = document.querySelector('input[autofocus], input.bg-canvas') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'renamed' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    return { ...m, input };
  }
  it('a rejected rename keeps the field open and says "Couldn\'t rename this file."', async () => {
    const { input } = await rename(vi.fn().mockRejectedValue(new Error('ipc closed')));
    expect(await screen.findByText("Couldn't rename this file.")).toBeInTheDocument();
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('renamed');
  });
  it('a host refusal with a reason shows that reason, not the generic line', async () => {
    await rename(vi.fn().mockResolvedValue({ ok: false, error: 'name-taken' }));
    await vi.waitFor(() => expect(document.querySelector('.text-destructive, [role="alert"]')).not.toBeNull());
    expect(screen.queryByText("Couldn't rename this file.")).toBeNull();
  });
  it('a rename that works closes the field, re-reads the list and shows no error', async () => {
    const { api } = await rename(vi.fn().mockResolvedValue({ ok: true }));
    await vi.waitFor(() => expect(api.listSession).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.querySelector('input.bg-canvas')).toBeNull());
    expect(screen.queryByText("Couldn't rename this file.")).toBeNull();
    expect(t.got).toEqual([]);
  });
});
