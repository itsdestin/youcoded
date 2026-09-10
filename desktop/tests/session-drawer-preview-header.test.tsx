// @vitest-environment jsdom
//
// Bug: when the drawer previews a past conversation, its own top bar still
// rendered (title-less, since no artifact is active) AND SessionPreviewPane
// drew a second header directly beneath it — title, subtitle, and its own ✕.
// Two headers, two close buttons, the top one blank. Destin: "two headers
// with x's is weird tho." The fix reuses the drawer's existing top bar for a
// preview exactly the way it's already used for an open file: the
// conversation title takes the filename's slot, and the bar's one ✕ is the
// only close control. This file pins that arrangement at the DRAWER level —
// SessionPreviewPane no longer takes title/onClose props at all, so those
// assertions can't live in its own test file anymore (see the note atop
// tests/session-preview-pane.test.tsx).
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { COPY, providerLabel, type ResolvedConversation } from '../src/shared/chatsearch-refs';

// Same reason as session-drawer-session-scoped-labels.test.tsx: theme-context
// touches localStorage/matchMedia/queryLocalFonts on mount and doesn't export
// its raw Context, so mock the hook to the fields SessionDrawer reads.
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({
    hideCodeAndConfigs: false,
    setHideCodeAndConfigs: vi.fn(),
    showDeletedArtifacts: false,
    setShowDeletedArtifacts: vi.fn(),
    drawerWidth: 420,
    setDrawerWidth: vi.fn(),
    resetDrawerWidth: vi.fn(),
  }),
}));

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

/**
 * Find a control by the words of its hover hint.
 *
 * These were `getByTitle` / `findByTitle`. The hints are the app's own
 * <Tooltip> now rather than the browser's `title=` bubble, so the words sit on
 * the control as `data-hint`. What each test asserts is unchanged.
 */
const hintSel = (t: string) => `[data-hint="${t.replace(/"/g, '\\"')}"]`;
const allByHint = (t: string) => Array.from(document.querySelectorAll(hintSel(t))) as HTMLElement[];
const getByHint = (t: string): HTMLElement => {
  const found = allByHint(t);
  if (found.length !== 1) throw new Error(`expected one control hinted ${JSON.stringify(t)}, found ${found.length}`);
  return found[0];
};
const findByHint = async (t: string): Promise<HTMLElement> => {
  await waitFor(() => expect(allByHint(t).length).toBe(1));
  return getByHint(t);
};

// jsdom does not implement scrollIntoView; ConversationTranscript (rendered
// inside SessionPreviewPane) calls it to jump to the newest message.
// jsdom also has no matchMedia — the preview header's narrow-viewport
// collapse (spec A4) now calls useNarrowViewport() unconditionally on every
// SessionDrawer render, same pattern as use-narrow-viewport.test.tsx's own
// stub. `matches: false` keeps these header-shape assertions on the WIDE
// (labelled) rendering, which is what they're pinning.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  (window as any).matchMedia = (window as any).matchMedia || ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
  }));
});

afterEach(cleanup);

const SESSION = 'sess-preview';
const ROOT = '/home/u/proj';
const PREVIEW = { provider: 'claude' as const, id: 'abc', title: 'A conversation about the drawer' };

function stateWithPreview() {
  return {
    ...initialArtifactState,
    // sessionArtifacts must be a REAL (even empty) array here, not the
    // fallback `[]` SessionDrawer computes inline when the key is absent —
    // that fallback is a fresh literal every render, which starves the
    // orphan-check effect's dependency array and free-spins. The real app
    // never hits this: App.tsx/ChatView.tsx always dispatch
    // SESSION_ARTIFACTS_LOADED (seeding this key, even to []) before the
    // drawer can open. Mirror that precondition here rather than the
    // key-absent shape a real render never starts from.
    sessionArtifacts: { [SESSION]: [] },
    drawerOpenBySession: { [SESSION]: true },
    activeSessionPreviewBySession: { [SESSION]: PREVIEW },
  };
}

function mockWindowClaude() {
  (window as any).claude = {
    artifacts: { get: vi.fn(), checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }) },
    chatsearch: {
      read: vi.fn().mockResolvedValue({ ok: true, messages: [], hasMore: false }),
      // The preview header (A1/A2/A4) resolves the previewed id for Resume's
      // enabled/disabled state. Answering 'unknown' keeps these pre-existing
      // header-shape tests indifferent to Resume — they assert on the title/
      // close-button/list-toggle behaviour this file exists to pin, not on
      // Resume, which has its own test file.
      resolve: vi.fn().mockResolvedValue({ ok: true, results: [{ status: 'unknown', query: '' }] }),
    },
    session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }) },
    tags: { list: vi.fn().mockResolvedValue([]) },
  // The Resume options popover mounts ModelPicker, which asks for the model
    // lists on mount. Without these it throws on the undefined `.providers`
    // before anything renders.
    providers: { list: vi.fn().mockResolvedValue([]), catalog: vi.fn().mockResolvedValue([]) },
    defaults: { get: vi.fn().mockResolvedValue({ model: 'sonnet', skipPermissions: false }) },
  };
}

describe('SessionDrawer: one header for a previewed conversation', () => {
  it('shows the conversation title in the top bar and exactly one close control', async () => {
    mockWindowClaude();
    render(
      <ArtifactContext.Provider value={{ state: stateWithPreview(), dispatch: vi.fn() }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );

    // Title occupies the same top-bar slot the filename does for a file.
    expect(await screen.findByText(PREVIEW.title)).toBeTruthy();

    // Exactly one close control on the whole pane — the drawer's, not a
    // second one from the pane. (Before the fix there were two: the drawer's
    // title-less bar plus the pane's own ✕.)
    expect(allByHint('Close')).toHaveLength(1);

    // The read-only/lane line the old pane header carried is still shown
    // somewhere (now a quiet caption inside the scroll area), just not as a
    // second header. Destin, 2026-08-27 gate (M-caption): "remove 'past
    // conversation'. put read-only to the right of the assistant." — so the
    // lane name leads and "read-only" trails it.
    expect(await screen.findByText(new RegExp(`${providerLabel(PREVIEW.provider)}.*read-only`))).toBeTruthy();
    expect(screen.queryByText(/Past conversation/)).toBeNull();
  });

  it('the ☰ list toggle and the bar layout work the same as they do for a file', async () => {
    mockWindowClaude();
    const { container } = render(
      <ArtifactContext.Provider value={{ state: stateWithPreview(), dispatch: vi.fn() }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    await screen.findByText(PREVIEW.title);

    const list = container.querySelector('.drawer-list') as HTMLElement;
    expect(list.className).toContain('w-0'); // collapsed by default, same as a freshly-opened file

    fireEvent.click(getByHint('Show list'));
    expect(list.className).toContain('w-[210px]');
  });

  it('clicking the bar close button closes the whole drawer for a preview — same action a file\'s close performs', async () => {
    mockWindowClaude();
    const dispatch = vi.fn();
    render(
      <ArtifactContext.Provider value={{ state: stateWithPreview(), dispatch }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    await screen.findByText(PREVIEW.title);

    fireEvent.click(getByHint('Close'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'DRAWER_CLOSED', sessionId: SESSION });
  });

  it('falls back to the shared "Untitled conversation" copy when a referenced conversation has no title', async () => {
    mockWindowClaude();
    const state = {
      ...initialArtifactState,
      sessionArtifacts: { [SESSION]: [] }, // see stateWithPreview() comment above
      drawerOpenBySession: { [SESSION]: true },
      activeSessionPreviewBySession: { [SESSION]: { provider: 'native' as const, id: 'xyz', title: '' } },
    };
    render(
      <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    expect(await screen.findByText(COPY.untitled)).toBeTruthy();
  });
});

// ── Resume + tag/note sheet (spec 2026-08-26-conversation-preview-header-
// design.md, A1/A2/A4) ──
type Ok = Extract<ResolvedConversation, { status: 'ok' }>;

function okRow(overrides: Partial<Ok> = {}): Ok {
  return {
    status: 'ok',
    id: PREVIEW.id,
    provider: 'claude',
    title: PREVIEW.title,
    projectName: 'proj',
    originalPath: '/home/u/proj',
    lastActive: '2026-08-20T00:00:00.000Z',
    createdAt: '2026-08-19T00:00:00.000Z',
    tags: [],
    complete: false,
    tombstone: false,
    projectSlug: 'proj-slug',
    projectPath: '/home/u/proj',
    missingProject: false,
    notSyncedYet: false,
    ...overrides,
  };
}

const TAGS = [{ id: 'tag_work', label: 'work', color: 'tag-blue', archived: false, createdAt: '' }];

function mockWindowClaudeFor(row: ResolvedConversation | null, opts: {
  getMeta?: ReturnType<typeof vi.fn>; setTag?: ReturnType<typeof vi.fn>; setNote?: ReturnType<typeof vi.fn>;
} = {}) {
  (window as any).claude = {
    artifacts: { get: vi.fn(), checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }) },
    chatsearch: {
      read: vi.fn().mockResolvedValue({ ok: true, messages: [], hasMore: false }),
      resolve: vi.fn().mockResolvedValue({ ok: true, results: row ? [row] : [] }),
    },
    session: {
      getMeta: opts.getMeta ?? vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }),
      setTag: opts.setTag ?? vi.fn().mockResolvedValue({ ok: true }),
      setNote: opts.setNote ?? vi.fn().mockResolvedValue({ ok: true }),
    },
    tags: { list: vi.fn().mockResolvedValue(TAGS), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  // The Resume options popover mounts ModelPicker, which asks for the model
    // lists on mount. Without these it throws on the undefined `.providers`
    // before anything renders.
    providers: { list: vi.fn().mockResolvedValue([]), catalog: vi.fn().mockResolvedValue([]) },
    defaults: { get: vi.fn().mockResolvedValue({ model: 'sonnet', skipPermissions: false }) },
  };
}

function renderDrawerWithPreview(preview: typeof PREVIEW = PREVIEW) {
  const state = { ...stateWithPreview(), activeSessionPreviewBySession: { [SESSION]: preview } };
  return render(
    <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
      <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
    </ArtifactContext.Provider>,
  );
}

describe('Resume button (spec A2)', () => {
  it('is enabled with the continue-in-a-tab hint when the conversation resolves resumable', async () => {
    mockWindowClaudeFor(okRow());
    renderDrawerWithPreview();
    const btn = await findByHint(COPY.resumeHint);
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent(COPY.resume);
  });

  it('is disabled with the missing-project reason when the project folder is absent', async () => {
    mockWindowClaudeFor(okRow({ missingProject: true, projectSlug: '', projectPath: '' }));
    renderDrawerWithPreview();
    const btn = await findByHint(COPY.resumeMissingProject);
    expect(btn).toBeDisabled();
  });

  it('is disabled with the not-synced reason when the transcript has not synced to this device', async () => {
    mockWindowClaudeFor(okRow({ notSyncedYet: true }));
    renderDrawerWithPreview();
    const btn = await findByHint(COPY.resumeNotSynced);
    expect(btn).toBeDisabled();
  });

  it('labels the assistant lane "Resume…" — that lane opens a model picker before it launches', async () => {
    mockWindowClaudeFor(okRow({ provider: 'native' }));
    renderDrawerWithPreview({ ...PREVIEW, provider: 'native' });
    const btn = await findByHint(COPY.resumeNativeHint);
    expect(btn).toHaveTextContent(COPY.resumeNative);
    expect(btn).not.toBeDisabled();
  });

  // Destin, 2026-08-27 gate (M-header): Resume no longer launches on click. It
  // opens a small options popover — model, skip-permissions, then a confirm —
  // "same as resume menus used elsewhere". The click itself must therefore
  // dispatch NOTHING; the confirm inside the popover is what resumes.
  it('clicking an enabled Resume opens the options popover instead of resuming', async () => {
    mockWindowClaudeFor(okRow({ projectSlug: 'my-slug', projectPath: '/my/path' }));
    renderDrawerWithPreview();
    const btn = await findByHint(COPY.resumeHint);

    const heard = vi.fn();
    window.addEventListener('youcoded:resume-session', (e: any) => heard(e.detail));
    fireEvent.click(btn);

    expect(await screen.findByRole('dialog', { name: 'Resume options' })).toBeTruthy();
    expect(heard).not.toHaveBeenCalled();
  });

  it('the popover\'s confirm dispatches youcoded:resume-session with the conversation and the picked options', async () => {
    mockWindowClaudeFor(okRow({ projectSlug: 'my-slug', projectPath: '/my/path' }));
    renderDrawerWithPreview();
    fireEvent.click(await findByHint(COPY.resumeHint));
    await screen.findByRole('dialog', { name: 'Resume options' });

    const heard = vi.fn();
    window.addEventListener('youcoded:resume-session', (e: any) => heard(e.detail));
    fireEvent.click(screen.getByRole('button', { name: /Resume Session/ }));

    // requestResume (tool-views/SessionRefActions.tsx) is reused verbatim —
    // the same shape App.tsx's listener expects, now carrying what the popover
    // collected. `binding` stays undefined on the Claude lane.
    expect(heard).toHaveBeenCalledWith({
      claudeSessionId: PREVIEW.id,
      projectSlug: 'my-slug',
      projectPath: '/my/path',
      provider: 'claude',
      model: 'sonnet',
      dangerous: false,
      binding: undefined,
    });
  });

  it('a disabled Resume (missing project) never dispatches the event — positive control above', async () => {
    mockWindowClaudeFor(okRow({ missingProject: true, projectSlug: '', projectPath: '' }));
    renderDrawerWithPreview();
    const btn = await findByHint(COPY.resumeMissingProject);

    const heard = vi.fn();
    window.addEventListener('youcoded:resume-session', (e: any) => heard(e.detail));
    fireEvent.click(btn);

    expect(heard).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Resume options' })).toBeNull();
  });
});

describe('Preview header tag/note sheet (spec A1) — reads/writes through the meta store', () => {
  it('opens from the tag glyph and shows what session:get-meta answered, not the search index', async () => {
    mockWindowClaudeFor(okRow(), {
      getMeta: vi.fn().mockResolvedValue({ tags: ['tag_work'], note: 'a note', supported: true, flags: {} }),
    });
    renderDrawerWithPreview();
    await screen.findByText(PREVIEW.title);
    fireEvent.click(screen.getByRole('button', { name: `Organize ${PREVIEW.title}` }));

    expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'work' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByPlaceholderText('A note for later — shows under All Sessions')).toHaveValue('a note');
  });

  it('applies a tag optimistically and keeps it applied once session:set-tag confirms', async () => {
    const setTag = vi.fn().mockResolvedValue({ ok: true });
    mockWindowClaudeFor(okRow(), { setTag });
    renderDrawerWithPreview();
    await screen.findByText(PREVIEW.title);
    fireEvent.click(screen.getByRole('button', { name: `Organize ${PREVIEW.title}` }));
    const tagBtn = await screen.findByRole('button', { name: 'work' });
    expect(tagBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(tagBtn);
    expect(tagBtn).toHaveAttribute('aria-pressed', 'true'); // optimistic, before the write resolves
    await waitFor(() => expect(setTag).toHaveBeenCalledWith(PREVIEW.id, 'tag_work', true));
    expect(tagBtn).toHaveAttribute('aria-pressed', 'true'); // still applied — the write succeeded
  });

  it('rolls back an optimistic tag apply when session:set-tag reports {ok:false} — negative case for the test above', async () => {
    const setTag = vi.fn().mockResolvedValue({ ok: false });
    mockWindowClaudeFor(okRow(), { setTag });
    renderDrawerWithPreview();
    await screen.findByText(PREVIEW.title);
    fireEvent.click(screen.getByRole('button', { name: `Organize ${PREVIEW.title}` }));
    const tagBtn = await screen.findByRole('button', { name: 'work' });

    fireEvent.click(tagBtn);
    expect(tagBtn).toHaveAttribute('aria-pressed', 'true'); // optimistic
    // A failed write must not look like it succeeded (spec risk note) — the
    // chip un-applies once the refusal comes back.
    await waitFor(() => expect(tagBtn).toHaveAttribute('aria-pressed', 'false'));
  });

  it('rolls back a note edit when session:set-note reports {ok:false}', async () => {
    const setNote = vi.fn().mockResolvedValue({ ok: false });
    mockWindowClaudeFor(okRow(), {
      getMeta: vi.fn().mockResolvedValue({ tags: [], note: 'original', supported: true, flags: {} }),
      setNote,
    });
    renderDrawerWithPreview();
    await screen.findByText(PREVIEW.title);
    fireEvent.click(screen.getByRole('button', { name: `Organize ${PREVIEW.title}` }));
    const noteField = await screen.findByPlaceholderText('A note for later — shows under All Sessions');
    expect(noteField).toHaveValue('original');

    fireEvent.change(noteField, { target: { value: 'edited' } });
    fireEvent.blur(noteField);
    await waitFor(() => expect(setNote).toHaveBeenCalledWith(PREVIEW.id, 'edited'));
    // The UI must not keep a change the backend rejected.
    await waitFor(() => expect(screen.getByPlaceholderText('A note for later — shows under All Sessions')).toHaveValue('original'));
  });

  it('keeps a note edit once session:set-note confirms it — positive control for the rollback test above', async () => {
    const setNote = vi.fn().mockResolvedValue({ ok: true });
    mockWindowClaudeFor(okRow(), {
      getMeta: vi.fn().mockResolvedValue({ tags: [], note: 'original', supported: true, flags: {} }),
      setNote,
    });
    renderDrawerWithPreview();
    await screen.findByText(PREVIEW.title);
    fireEvent.click(screen.getByRole('button', { name: `Organize ${PREVIEW.title}` }));
    const noteField = await screen.findByPlaceholderText('A note for later — shows under All Sessions');

    fireEvent.change(noteField, { target: { value: 'edited' } });
    fireEvent.blur(noteField);
    await waitFor(() => expect(setNote).toHaveBeenCalledWith(PREVIEW.id, 'edited'));
    expect(screen.getByPlaceholderText('A note for later — shows under All Sessions')).toHaveValue('edited');
  });
});
