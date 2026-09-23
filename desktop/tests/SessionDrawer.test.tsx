// @vitest-environment jsdom
// SessionDrawer — the per-session file pane, rendered inside the REAL ArtifactContext.
// WHY a second file: SessionDrawer-scripted-state.test.tsx replaces ArtifactContext
// with a file-wide vi.mock, and a vi.mock cannot be scoped to part of a file.
import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../src/shared/artifacts/types';
import { COPY, providerLabel, type ResolvedConversation } from '../src/shared/chatsearch-refs';
import { __resetMissingArtifactsCache } from '../src/renderer/hooks/useMissingArtifacts';

// theme-context reads localStorage / matchMedia / queryLocalFonts on mount and
// doesn't export its raw Context, so mock the hook to the fields SessionDrawer
// actually consumes.
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
import { previewPage } from './helpers/preview-page';

// WHY the cache reset after every case: each section below was its own file, so
// each started with a fresh useMissingArtifacts cache; resetting it keeps one
// section's checks from leaking into the next.
afterEach(() => { cleanup(); __resetMissingArtifactsCache(); });
// WHY: previews observe visibility in browsers, while jsdom has no
// IntersectionObserver. Structure tests keep thumbnails below the fetch gate.
beforeAll(() => {
  (window as any).IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  };
});

// A file whose only version in THIS session is 'delivered' is labelled
// "delivered" in the Session Drawer — not "viewed" (it is more than a view)
// and not "created" (it was not modified). Spec 2026-08-25 §4.2.
describe('SessionDrawer — delivered label', () => {
  it('centers filename and status beside an 84×48 preview without hiding the remove action', async () => {
    const artifact: ArtifactRecord = {
      id: 'preview', path: 'out/chart.png', kind: 'internal', absolutePath: null,
      lastModified: new Date().toISOString(), status: 'active',
      versions: [{ id: 'v1', ts: new Date().toISOString(), sessionId: 'sess', type: 'delivered', author: 'agent' }],
      comments: [], tags: [],
    };
    const state = { ...initialArtifactState, sessionArtifacts: { sess: [artifact] }, drawerOpenBySession: { sess: true }, activeArtifactBySession: {} };
    (window as any).claude = { artifacts: { get: vi.fn(), checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }) } };
    const { container } = render(<ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
      <SessionDrawer sessionId="sess" projectRoot="/home/u/proj" cwd="/home/u/proj" projectId="proj-1" projectName="proj" />
    </ArtifactContext.Provider>);
    const row = await screen.findByRole('button', { name: /^chart\.png/ });
    const preview = row.querySelector('.w-21');
    expect(preview).toBeTruthy();
    expect(preview?.className).toContain('h-12');
    expect(row.querySelector('.justify-center.gap-1')).toBeTruthy();
    expect(container.querySelector('[data-session-files-scroll].scroll-fade')).toBeTruthy();
    expect(container.querySelector('[data-session-files-header]')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Remove chart\.png from this list/ })).toBeInTheDocument();
    // A clipped card would shrink the remove button's coarse-pointer hit target.
    expect(row.closest('.group')?.className).not.toContain('overflow-hidden');
  });

  it('labels a delivered-only file "delivered"', async () => {
    const artifact: ArtifactRecord = {
      id: 'a1', path: 'out/chart.png', kind: 'internal', absolutePath: null,
      lastModified: new Date().toISOString(), status: 'active',
      versions: [{ id: 'v1', ts: new Date().toISOString(), sessionId: 'sess', type: 'delivered', author: 'agent', toolUseId: 'toolu_1' }],
      comments: [], tags: [],
    };
    const state = {
      ...initialArtifactState,
      sessionArtifacts: { sess: [artifact] },
      drawerOpenBySession: { sess: true },
      activeArtifactBySession: {},
    };
    (window as any).claude = {
      artifacts: { get: vi.fn(), checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }), onChanged: undefined },
    };
    const { container } = render(
      <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
        <SessionDrawer sessionId="sess" projectRoot="/home/u/proj" cwd="/home/u/proj" projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    // Read the label div directly (same approach as the row-labels section
    // below). jsdom's `textContent`
    // concatenates sibling elements with NO separator — "chart.png" (the
    // filename span) runs straight into "delivered" (the label div) as one
    // unbroken run of letters, so a container-wide `\bdelivered\b` regex
    // never finds a word boundary before the "d" and always fails, pass or
    // fail state. Isolating the label div sidesteps that entirely; there is
    // only one row in this fixture so the class selector is unambiguous.
    // The list holds one frame while the on-disk check settles (the drawer no
    // longer paints rows it may be about to remove — see useMissingArtifacts),
    // so the row arrives on the next tick rather than synchronously.
    await waitFor(() => expect(container.querySelector('.text-3xs')).toBeTruthy());
    const label = container.querySelector('.text-3xs')?.textContent ?? '';
    expect(label).toMatch(/^delivered\b/);
    expect(label).not.toMatch(/^(created|viewed|edited)\b/);
  });
});

// Bug: the Session Drawer is a per-session activity log, but its row labels
// (status word + timestamp) were computed from the artifact RECORD's whole
// history — every session that ever touched the file, not just this one. A
// file edited weeks ago in another session and merely READ in today's
// session showed "edited · 7/26/2026": the word came from a record-global
// version count, the date from the record-global lastModified cache. Neither
// describes what THIS session did.
//
// Pinned here: a record with edits in other sessions and exactly one 'read'
// version in the CURRENT session renders "viewed" + that read's own
describe('SessionDrawer row labels are scoped to THIS session', () => {
  const SESSION = 'sess-current';
  const OTHER_SESSION_1 = 'sess-old-1';
  const OTHER_SESSION_2 = 'sess-old-2';
  const ROOT = '/home/u/proj';

  // jsdom has no matchMedia — the preview header's narrow-viewport collapse
  // (spec 2026-08-26 A4) calls useNarrowViewport() unconditionally on every
  // SessionDrawer render now, same stub shape as use-narrow-viewport.test.tsx.
  (window as any).matchMedia = (window as any).matchMedia || ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
  }));

  it('shows "viewed" and the read\'s own timestamp for a file only read in this session, ignoring edits from other sessions', async () => {
    const now = Date.now();
    const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const threeWeeksAgo = new Date(now - 21 * 24 * 60 * 60 * 1000).toISOString();

    const artifact: ArtifactRecord = {
      id: 'a1',
      path: 'PITFALLS.md',
      kind: 'internal',
      absolutePath: null,
      // Record-global cache — stale/misleading for THIS session's row; the fix
      // must not read this field when this session has its own version(s).
      lastModified: sevenDaysAgo,
      status: 'active',
      versions: [
        // Edited weeks ago, in a DIFFERENT session — must not count toward
        // this session's status word or supply this session's timestamp.
        { id: 'v1', ts: threeWeeksAgo, sessionId: OTHER_SESSION_1, type: 'create', author: 'agent' },
        { id: 'v2', ts: sevenDaysAgo, sessionId: OTHER_SESSION_2, type: 'edit', author: 'agent' },
        // The ONLY version event belonging to the current session: a read.
        { id: 'v3', ts: threeHoursAgo, sessionId: SESSION, type: 'read', author: 'agent' },
      ],
      comments: [],
      tags: [],
    };

    const state = {
      ...initialArtifactState,
      sessionArtifacts: { [SESSION]: [artifact] },
      drawerOpenBySession: { [SESSION]: true },
      // No active artifact selected — renders the list-only branch, which
      // needs no artifacts.get mock for content.
      activeArtifactBySession: {},
    };

    (window as any).claude = {
      artifacts: {
        get: vi.fn(),
        checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
        onChanged: undefined,
      },
      // SessionDrawer's preview header (spec 2026-08-26 A1/A2/A4) calls
      // useTagRegistry() UNCONDITIONALLY — not just while a preview is
      // showing — so every SessionDrawer render needs this, even a test like
      // this one that never opens a preview.
      tags: { list: vi.fn().mockResolvedValue([]) },
    };

    const { container } = render(
      <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
        <SessionDrawer
          sessionId={SESSION}
          projectRoot={ROOT}
          cwd={ROOT}
          projectId="proj-1"
          projectName="proj"
        />
      </ArtifactContext.Provider>,
    );

    // Row label format is "{statusWord} · {relTime}" — rendered in its own
    // div (ArtifactListItem's "text-3xs" line), separate from the filename
    // div, so target it directly rather than a parent whose textContent
    // would concatenate the filename in front of the label.
    // The list holds one frame while the on-disk check settles (the drawer no
    // longer paints rows it may be about to remove — see useMissingArtifacts),
    // so the row arrives on the next tick rather than synchronously.
    await waitFor(() => expect(container.querySelector('.text-3xs')).toBeTruthy());
    const labelEl = container.querySelector('.text-3xs');
    const label = labelEl?.textContent ?? null;

    expect(label).toBeTruthy();
    // The word must be "viewed" (only a read in THIS session) — NOT "edited",
    // which is what the record-global version count (2 non-read versions,
    // both in OTHER sessions) would wrongly report.
    expect(label).toMatch(/^viewed · /);
    // The timestamp must be THIS session's read (~3h ago), not the
    // record-global lastModified cache (7 days ago, which would render as a
    // locale date string, not "Xh ago").
    expect(label).toMatch(/^viewed · 3h ago$/);
  });
});

// The Session Drawer holds its file list for one frame while the on-disk check
// settles, so it never paints rows it is about to remove (the "deleted files
// flash", 2026-08-30). A hold has a failure mode the flash does not: a list
// that never appears at all. These cases pin both escapes — no folder to check
// against, and a check that never answers — because a permanently blank file
// pane is a far worse outcome than the cosmetic flash it replaced.
const artifact: ArtifactRecord = {
  id: 'a1', path: 'out/report.md', kind: 'internal', absolutePath: null,
  lastModified: new Date().toISOString(), status: 'active',
  versions: [{ id: 'v1', ts: new Date().toISOString(), sessionId: 'sess', type: 'create', author: 'agent', toolUseId: 'toolu_1' }],
  comments: [], tags: [],
};

const state = {
  ...initialArtifactState,
  sessionArtifacts: { sess: [artifact] },
  drawerOpenBySession: { sess: true },
  activeArtifactBySession: {},
};

function renderDrawer(cwd: string) {
  return render(
    <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
      <SessionDrawer sessionId="sess" projectRoot="/home/u/proj" cwd={cwd} projectId="proj-1" projectName="proj" />
    </ArtifactContext.Provider>,
  );
}

describe('SessionDrawer settle hold', () => {
  it('does not hold when there is no folder to check against', () => {
    // cwd is optional on BOTH call sites (ChatView, TerminalRightSlot) and
    // arrives as ''. Holding on a check that can never be issued would blank
    // the list forever.
    (window as any).claude = {
      artifacts: { get: vi.fn(), checkExistence: vi.fn(), onChanged: undefined },
    };
    const { container } = renderDrawer('');
    expect(container.querySelector('.text-3xs')).toBeTruthy();   // the row, on frame one
    expect((window as any).claude.artifacts.checkExistence).not.toHaveBeenCalled();
  });

  it('paints anyway when the check never answers', async () => {
    (window as any).claude = {
      artifacts: { get: vi.fn(), checkExistence: vi.fn(() => new Promise(() => {})), onChanged: undefined },
    };
    const { container } = renderDrawer('/home/u/proj');
    expect(container.querySelector('.text-3xs')).toBeFalsy();    // held, briefly
    await waitFor(() => expect(container.querySelector('.text-3xs')).toBeTruthy(), { timeout: 3000 });
  });
});

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
describe('SessionDrawer previewing a past conversation', () => {

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


  // jsdom does not implement scrollIntoView; the chat components the preview
  // renders may call it. jsdom also has no matchMedia — the preview header's narrow-viewport
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

  const SESSION = 'sess-preview';
  const ROOT = '/home/u/proj';
  // WHY the widened provider: one case previews an assistant-lane ('native') conversation.
  const PREVIEW: { provider: 'claude' | 'native'; id: string; title: string } = { provider: 'claude', id: 'abc', title: 'A conversation about the drawer' };

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
        read: vi.fn(async (req: { id: string }) => previewPage(req.id, [])),
        // The preview header (A1/A2/A4) resolves the previewed id for Resume's
        // enabled/disabled state. Answering 'unknown' keeps these pre-existing
        // header-shape tests indifferent to Resume — they assert on the title/
        // close-button/list-toggle behaviour this file exists to pin, not on
        // Resume, which has its own test file.
        resolve: vi.fn().mockResolvedValue({ ok: true, results: [{ status: 'unknown', query: '' }] }),
      },
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }) },
      tags: { list: vi.fn().mockResolvedValue([]) },
      // The resume card mounts ModelPicker, which asks for the model
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
          <SessionDrawer cwd="" sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
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
          <SessionDrawer cwd="" sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
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
          <SessionDrawer cwd="" sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
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
          <SessionDrawer cwd="" sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
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
        read: vi.fn(async (req: { id: string }) => previewPage(req.id, [])),
        resolve: vi.fn().mockResolvedValue({ ok: true, results: row ? [row] : [] }),
      },
      session: {
        getMeta: opts.getMeta ?? vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }),
        setTag: opts.setTag ?? vi.fn().mockResolvedValue({ ok: true }),
        setNote: opts.setNote ?? vi.fn().mockResolvedValue({ ok: true }),
      },
      tags: { list: vi.fn().mockResolvedValue(TAGS), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      // The resume card mounts ModelPicker, which asks for the model
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
        <SessionDrawer cwd="" sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
  }

  // Resume lives in a card at the foot of the preview since 2026-09-16 (Destin:
  // "make the session artifact pane preview match this styling" — the Projects
  // preview, which carries the Resume browser's own action card). The top bar
  // keeps the tag button and gains Complete; it no longer carries Resume.
  describe('Resume card at the foot of the preview (spec A2 reasons)', () => {
    const resumeButton = () => screen.queryByRole('button', { name: 'Resume Session' });

    it('offers the model picker and Resume Session when the conversation resolves resumable, and nothing in the top bar', async () => {
      mockWindowClaudeFor(okRow());
      renderDrawerWithPreview();
      await waitFor(() => expect(resumeButton()).toBeTruthy());
      expect(resumeButton()).not.toBeDisabled();
      expect(screen.getByText('Model')).toBeTruthy();
      // A resume from here always opens a tab (chat search's path), so there is
      // no new-window switch.
      expect(screen.queryByRole('switch', { name: 'Launch in New Window' })).toBeNull();
      // The old top-bar button is gone.
      expect(screen.queryByRole('button', { name: COPY.resume })).toBeNull();
    });

    it('says why, and offers no Resume, when the project folder is absent', async () => {
      mockWindowClaudeFor(okRow({ missingProject: true, projectSlug: '', projectPath: '' }));
      renderDrawerWithPreview();
      await waitFor(() => expect(screen.getAllByText(COPY.resumeMissingProject).length).toBeGreaterThan(0));
      expect(resumeButton()).toBeNull();
    });

    it('says why, and offers no Resume, when the transcript has not synced to this device', async () => {
      mockWindowClaudeFor(okRow({ notSyncedYet: true }));
      renderDrawerWithPreview();
      await waitFor(() => expect(screen.getAllByText(COPY.resumeNotSynced).length).toBeGreaterThan(0));
      expect(resumeButton()).toBeNull();
    });

    it('keeps Resume off on the assistant lane until a model is picked — that lane never launches without one', async () => {
      mockWindowClaudeFor(okRow({ provider: 'native' }));
      renderDrawerWithPreview({ ...PREVIEW, provider: 'native' });
      await waitFor(() => expect(resumeButton()).toBeTruthy());
      expect(resumeButton()).toBeDisabled();
      // Skip Permissions is Claude-Code-only.
      expect(screen.queryByRole('switch', { name: 'Skip Permissions' })).toBeNull();
    });

    it('Resume Session dispatches youcoded:resume-session with the conversation and the picked options', async () => {
      mockWindowClaudeFor(okRow({ projectSlug: 'my-slug', projectPath: '/my/path' }));
      renderDrawerWithPreview();
      await waitFor(() => expect(resumeButton()).toBeTruthy());

      const heard = vi.fn();
      const listen = (e: any) => heard(e.detail);
      window.addEventListener('youcoded:resume-session', listen);
      fireEvent.click(resumeButton()!);
      window.removeEventListener('youcoded:resume-session', listen);

      // requestResume (tool-views/SessionRefActions.tsx) is reused verbatim —
      // the same shape App.tsx's listener expects. `binding` stays undefined on
      // the Claude lane.
      await waitFor(() => expect(heard).toHaveBeenCalledWith({
        claudeSessionId: PREVIEW.id,
        projectSlug: 'my-slug',
        projectPath: '/my/path',
        provider: 'claude',
        model: 'sonnet',
        dangerous: false,
        binding: undefined,
      }));
    });

    it('shows Complete in the top bar as the meta store has it, and toggling it writes the flag', async () => {
      const setFlag = vi.fn().mockResolvedValue({ ok: true });
      mockWindowClaudeFor(okRow(), { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: { complete: true } }) });
      (window as any).claude.session.setFlag = setFlag;
      renderDrawerWithPreview();
      const done = await screen.findByRole('button', { name: `Mark ${PREVIEW.title} not complete` });
      fireEvent.click(done);
      expect(setFlag).toHaveBeenCalledWith(PREVIEW.id, 'complete', false);
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
});


// Project View dropped "Show deleted" on 2026-07-23 (deleted records carry no
// content — VersionEvent has no content field — so they were tombstones, not a
// recovery path). The SESSION drawer keeps it: seeing everything Claude did in a
// session, deletions included, is that view's whole purpose. A cleanup pass that
// removes the now-"unused" flag would silently break it and drop a synced pref.
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('showDeletedArtifacts survives the project-view merge', () => {
  it('is still consumed by SessionDrawer', () => {
    expect(read('src/renderer/components/SessionDrawer.tsx')).toContain('showDeletedArtifacts');
  });

  it('is still persisted as a synced appearance preference', () => {
    const ctx = read('src/renderer/state/theme-context.tsx');
    expect(ctx).toContain('showDeletedArtifacts');
    expect(ctx).toContain('persistAppearance({ showDeletedArtifacts');
  });

  it('is gone from project view', () => {
    expect(read('src/renderer/components/project-view/ProjectView.tsx')).not.toContain('showDeletedArtifacts');
    expect(read('src/renderer/components/project-view/tabs/FilesTab.tsx')).not.toContain('showDeletedArtifacts');
  });
});
