// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  describeImportFailure,
  importResultTitle,
  matchProjectByPath,
  ProjectView,
} from '../src/renderer/components/project-view/ProjectView';
import { needsSetupRowDomId } from '../src/renderer/components/project-view/SkillsToolsTab';
import { ArtifactProvider, createArtifactStore } from '../src/renderer/state/ArtifactContext';

// ── Which project the view opens on ─────────────────────────────────────────
// Project view homes to the FOCUSED conversation's folder every time it opens,
// rather than restoring whatever project was browsed last (the component never
// unmounts, so the old code's `prev` branch made the selection sticky for the
// life of the app run). `matchProjectByPath` is the lookup that decision rests
// on; the open-time effect in ProjectView falls back to projects[0] when it
// returns null.
//
// The spellings matter: a project's `path` comes off the central index, the cwd
// comes off the live session, and on Windows those two can disagree on
// separators and case for the SAME folder. A miss here is invisible — the view
// just silently opens on the wrong project.
describe('matchProjectByPath', () => {
  const P = (path: string) => ({ path });

  it('finds the project whose folder is the cwd', () => {
    const projects = [P('/home/d/alpha'), P('/home/d/beta')];
    expect(matchProjectByPath(projects, '/home/d/beta')).toBe(projects[1]);
  });

  it('matches a Windows cwd against a forward-slash indexed path', () => {
    const projects = [P('C:/Users/d/proj')];
    expect(matchProjectByPath(projects, 'C:\\Users\\d\\proj')).toBe(projects[0]);
  });

  it('matches a lowercased indexed path (canonicalized Windows entries)', () => {
    const projects = [P('c:/users/d/proj')];
    expect(matchProjectByPath(projects, 'C:\\Users\\d\\proj')).toBe(projects[0]);
  });

  // Both of these hand the caller its projects[0] fallback rather than a wrong
  // project — a conversation can live in a folder that was never saved as a
  // project, and the welcome screen has no focused conversation at all.
  it('returns null when the cwd is not an indexed project', () => {
    expect(matchProjectByPath([P('/home/d/alpha')], '/home/d/somewhere-else')).toBeNull();
  });

  it('returns null when there is no focused conversation', () => {
    expect(matchProjectByPath([P('/home/d/alpha')], undefined)).toBeNull();
  });

  it('returns null against an empty index', () => {
    expect(matchProjectByPath([], '/home/d/alpha')).toBeNull();
  });
});

// ── "+ Add file" import result wording ──────────────────────────────────────
// Pins the "+ Add file" import result WORDING — the project's error-message
// standards surface for this flow (docs/error-message-standards.md). Two rules
// it has to keep obeying:
//   - specific and accurate, or general and non-committal; NEVER a guessed
//     cause. Unknown codes fall through carrying the real code + detail.
//   - the sentence names the file the user picked, not whatever path main
//     happened to refuse (for a destination-folder refusal that path is a
//     FOLDER, and a 3-file batch printed the same folder three times).
// Plus the modal title, which used to read "Import failed" over bodies
// reporting a partial success or a plain no-op.
describe('describeImportFailure', () => {
  describe('needs-confirm', () => {
    it('names the picked file AND the protected destination', () => {
      const msg = describeImportFailure(
        { error: 'needs-confirm', detail: '/home/d/proj/.claude' },
        '/home/d/Downloads/settings.json',
      );
      expect(msg).toContain('settings.json');
      expect(msg).toContain('/home/d/proj/.claude');
      expect(msg).toContain('NOT imported');
    });

    it('gives a different line per file in a batch', () => {
      // The destination is the same folder for every file in a batch, so a
      // message built from `detail` alone printed identical lines.
      const lines = ['/a/one.md', '/a/two.md'].map((s) =>
        describeImportFailure({ error: 'needs-confirm', detail: '/home/d/proj/.claude' }, s));
      expect(new Set(lines).size).toBe(2);
    });

    it('stays truthful when no source is available', () => {
      const msg = describeImportFailure({ error: 'needs-confirm', detail: '/p/.env' });
      expect(msg).toContain('That file');
      expect(msg).toContain('/p/.env');
    });
  });

  describe('MOVE_SOURCE_NOT_REMOVED', () => {
    it('reports the PARTIAL outcome — the copy landed, the original stayed', () => {
      const msg = describeImportFailure(
        { error: 'MOVE_SOURCE_NOT_REMOVED', detail: 'EPERM: operation not permitted' },
        '/home/d/Downloads/budget.xlsx',
      );
      expect(msg).toContain('budget.xlsx');
      expect(msg).toContain('copied into the project');
      expect(msg).toContain('both copies exist now');
      // The real OS error is surfaced, not paraphrased into a guess.
      expect(msg).toContain('EPERM: operation not permitted');
      // It must NOT claim the import failed outright — half of it succeeded.
      expect(msg).not.toMatch(/was NOT imported/);
    });

    it('omits the parenthetical when main reported no detail', () => {
      const msg = describeImportFailure({ error: 'MOVE_SOURCE_NOT_REMOVED' }, '/a/notes.md');
      expect(msg).toBe(
        'notes.md was copied into the project, but the original could not be removed — both copies exist now.',
      );
    });
  });

  describe('fallthrough (every other code)', () => {
    it('surfaces the REAL code and detail rather than guessing a cause', () => {
      const msg = describeImportFailure({ error: 'ENOSPC', detail: 'no space left on device' }, '/a/big.iso');
      expect(msg).toContain('big.iso');
      expect(msg).toContain('ENOSPC');
      expect(msg).toContain('no space left on device');
    });

    it('still returns the bare code when there is no detail', () => {
      expect(describeImportFailure({ error: 'COPY_INCOMPLETE' })).toBe('COPY_INCOMPLETE');
    });

    it('does not invent wording for a code it has never seen', () => {
      // A future code must pass through verbatim — anything else would be a
      // hardcoded guess at a cause nobody verified.
      const msg = describeImportFailure({ error: 'EXDEV', detail: 'cross-device link' });
      expect(msg).toBe('EXDEV: cross-device link');
    });
  });
});

describe('importResultTitle', () => {
  it('says failed only when something actually failed', () => {
    expect(importResultTitle({ hardFailures: 1, partial: 0, alreadyInPlace: 0 })).toBe('Import failed');
  });

  it('calls a half-done move partly finished, not failed', () => {
    // The body reads "copied into the project, but the original could not be
    // removed" — titling that "Import failed" contradicted its own text.
    expect(importResultTitle({ hardFailures: 0, partial: 1, alreadyInPlace: 0 }))
      .toBe('Import partly finished');
  });

  it('calls a self-import no-op nothing to import', () => {
    expect(importResultTitle({ hardFailures: 0, partial: 0, alreadyInPlace: 2 }))
      .toBe('Nothing to import');
  });

  it('a real failure outranks a partial or a no-op in the same batch', () => {
    expect(importResultTitle({ hardFailures: 1, partial: 1, alreadyInPlace: 1 })).toBe('Import failed');
    expect(importResultTitle({ hardFailures: 0, partial: 1, alreadyInPlace: 1 }))
      .toBe('Import partly finished');
  });
});

// ── PROJECT_VIEW_OPEN_SKILLS_TAB (T4 review F1/F6) ──────────────────────────
// A REAL store (createArtifactStore, the same reducer App uses), not a
// scripted `{ state, dispatch }` value — F1's bug is specifically that the
// EFFECT CHAIN inside ProjectView failed to react to a second dispatch, so a
// mock dispatch that doesn't run the reducer would not exercise it at all.
const PROJECT_A = { id: 'pa', path: '/home/d/alpha', name: 'Alpha' } as any;
const PROJECT_B = { id: 'pb', path: '/home/d/beta', name: 'Beta' } as any;

function installWindowClaude() {
  (globalThis as any).IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  (window as any).claude = {
    artifacts: {
      listAllFiles: () => Promise.resolve({ ok: true, files: [] }),
      listFolder: () => Promise.resolve({ ok: true, entries: [], hasMore: false }),
      listProjectsIndex: () => Promise.resolve({ ok: true, projects: [PROJECT_A, PROJECT_B] }),
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
      searchContent: () => Promise.resolve({ ok: true, hits: [] }),
    },
    project: {
      listConversations: () => Promise.resolve({ ok: true, conversations: [] }),
      listContext: () => Promise.resolve({ ok: true, groups: [] }),
      repoInfo: () => Promise.resolve(null),
    },
    syncSpaces: {
      status: () => Promise.reject(new Error('no sync in tests')),
      onEvent: () => () => {},
    },
    projectExtensions: {
      // Each project's needs-setup row is named after its OWN project so a
      // test can tell which project's Skills & tools tab actually rendered.
      get: (path: string) => Promise.resolve({
        ok: true,
        view: {
          projectKey: path,
          builtIn: [], installed: [], personal: [],
          needsSetup: [{ key: `mcp:${path}`, displayName: `Tool for ${path}`, kind: 'tool-connection', projectKey: path }],
        },
      }),
      set: vi.fn(),
      importSkill: vi.fn(),
    },
    dialog: { openFile: vi.fn() },
  };
}

function renderProjectView(store: ReturnType<typeof createArtifactStore>) {
  return render(
    <ArtifactProvider store={store}>
      <ProjectView
        onNewConversation={vi.fn()}
        onResumeConversation={vi.fn() as any}
        settingsOpen={false}
        onToggleSettings={vi.fn()}
      />
    </ArtifactProvider>,
  );
}

// jsdom has no rAF-with-real-frames, and under a loaded full-suite run the
// REAL one can take far longer than a `waitFor` budget to fire (test-suite-
// hygiene.md: "under load the work hasn't started") — drive it manually
// instead, the same recipe as zoom-loupe.test.tsx.
let frames: FrameRequestCallback[] = [];
function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => { pending.forEach((cb) => cb(0)); });
}

describe('PROJECT_VIEW_OPEN_SKILLS_TAB', () => {
  beforeEach(() => {
    installWindowClaude();
    Element.prototype.scrollIntoView = vi.fn();
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('closed → open: opens on Skills & tools for the NAMED project', async () => {
    const store = createArtifactStore();
    const view = renderProjectView(store);

    store.dispatch({ type: 'PROJECT_VIEW_OPEN_SKILLS_TAB', projectPath: PROJECT_B.path });

    expect(await view.findByText(`Tool for ${PROJECT_B.path}`)).toBeInTheDocument();
    expect(view.queryByText(`Tool for ${PROJECT_A.path}`)).not.toBeInTheDocument();
  });

  it('already open on a DIFFERENT project: still switches to the named project (F1)', async () => {
    // Open plainly first (re-homes to projects[0] = Alpha, since there is no
    // focused conversation), and let it settle on the Files tab showing Alpha
    // — this is "Project View already open, browsing something else" (the
    // exact scenario the old ref-based code silently failed on).
    const store = createArtifactStore();
    store.dispatch({ type: 'PROJECT_VIEW_OPENED' });
    const view = renderProjectView(store);
    await view.findByText('Alpha');

    store.dispatch({ type: 'PROJECT_VIEW_OPEN_SKILLS_TAB', projectPath: PROJECT_B.path });

    // Must land on BETA's Skills & tools, not silently stay on Alpha showing
    // whatever Alpha's own needs-setup section holds.
    expect(await view.findByText(`Tool for ${PROJECT_B.path}`)).toBeInTheDocument();
    expect(view.queryByText(`Tool for ${PROJECT_A.path}`)).not.toBeInTheDocument();
  });

  it('scrolls to the specific needs-setup ROW named by itemKey, not just the section (F6)', async () => {
    const store = createArtifactStore();
    const view = renderProjectView(store);
    const itemKey = `mcp:${PROJECT_B.path}`;

    store.dispatch({ type: 'PROJECT_VIEW_OPEN_SKILLS_TAB', projectPath: PROJECT_B.path, itemKey });
    await view.findByText(`Tool for ${PROJECT_B.path}`);

    await waitFor(() => { flushFrames(); expect(Element.prototype.scrollIntoView).toHaveBeenCalled(); });
    const scrolledEl = (Element.prototype.scrollIntoView as any).mock.instances[0];
    expect(scrolledEl.id).toBe(needsSetupRowDomId(itemKey));
  });

  it('falls back to the whole section when no itemKey is given (backward compatible)', async () => {
    const store = createArtifactStore();
    const view = renderProjectView(store);

    store.dispatch({ type: 'PROJECT_VIEW_OPEN_SKILLS_TAB', projectPath: PROJECT_B.path });
    await view.findByText(`Tool for ${PROJECT_B.path}`);

    await waitFor(() => { flushFrames(); expect(Element.prototype.scrollIntoView).toHaveBeenCalled(); });
    const scrolledEl = (Element.prototype.scrollIntoView as any).mock.instances[0];
    expect(scrolledEl.id).toBe('project-tools-needing-setup');
  });

  // R14 (2026-09-24 grading pass): live probe against the workbench showed
  // the drawer's unavailable-card click opened Skills & tools but never
  // scrolled — scrollTop stuck at 0, target row off-screen. Root cause: the
  // scroll effect fired exactly ONE requestAnimationFrame, and — whether or
  // not the target row existed yet — unconditionally cleared its own pending
  // flags, so a row that hadn't rendered yet (because it depends on TWO
  // chained async IPC round trips: the projects-index load, then
  // SkillsToolsTab's own lazy per-project projectExtensions:get fetch) was
  // simply never scrolled to. This reproduces that exact timing: the row's
  // data resolves only AFTER a frame has already elapsed.
  it('retries across frames instead of giving up after one, so a row that loads late still gets scrolled to (R14)', async () => {
    const store = createArtifactStore();
    let resolveGet: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { resolveGet = resolve; });
    // WHY delay only projectExtensions.get (not listProjectsIndex): this is
    // specifically the SECOND chained round trip — the one that resolves
    // AFTER the tab has already switched to 'skills' and a frame may already
    // have elapsed.
    (window as any).claude.projectExtensions.get = (path: string) => gate.then(() => ({
      ok: true,
      view: {
        projectKey: path, builtIn: [], installed: [], personal: [],
        needsSetup: [{ key: `mcp:${path}`, displayName: `Tool for ${path}`, kind: 'tool-connection', projectKey: path }],
      },
    }));
    const view = renderProjectView(store);
    const itemKey = `mcp:${PROJECT_B.path}`;

    store.dispatch({ type: 'PROJECT_VIEW_OPEN_SKILLS_TAB', projectPath: PROJECT_B.path, itemKey });

    // Wait for `activeProject` itself to resolve (the hero renders the
    // project's NAME once it's set) — NOT just for the tab pill to read
    // 'skills', which flips synchronously the instant the request is
    // consumed and proves nothing about whether the scroll effect (gated on
    // `activeProject`) has mounted yet. Only once activeProject is real does
    // the scroll effect schedule its first rAF — BEFORE the row's own data
    // has arrived, since that fetch is still gated behind `gate`.
    await view.findByText('Beta');
    act(() => { flushFrames(); });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(view.queryByText(`Tool for ${PROJECT_B.path}`)).not.toBeInTheDocument();

    // NOW the row's data arrives and it renders.
    await act(async () => { resolveGet!(); await gate; });
    await view.findByText(`Tool for ${PROJECT_B.path}`);

    await waitFor(() => { flushFrames(); expect(Element.prototype.scrollIntoView).toHaveBeenCalled(); });
    const scrolledEl = (Element.prototype.scrollIntoView as any).mock.instances[0];
    expect(scrolledEl.id).toBe(needsSetupRowDomId(itemKey));
  });
});
