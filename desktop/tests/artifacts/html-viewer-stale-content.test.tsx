// @vitest-environment jsdom
// html-viewer-stale-content.test.tsx
//
// Pins the fix for the "second HTML preview renders blank" bug (2026-07-19).
//
// The viewer subtree is keyed by artifact.id (ViewerErrorBoundary), so switching
// files remounts HtmlView with a FRESH <iframe>. If the host still holds the
// previous file's content at that moment, the new iframe receives a srcDoc write
// for the old document and a second one milliseconds later for the new one. That
// aborted-then-restarted opaque-origin navigation leaves the frame permanently
// white — which is why the FIRST html opened always worked (content started
// null) but every subsequent one did not.
//
// The invariant: a viewer must NEVER be handed a different file's content. The
// host nulls content before the read resolves, so HtmlView renders its Loading
// state (no iframe at all) and the eventual iframe gets exactly one srcDoc.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ArtifactContext } from '../../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../../src/shared/artifacts/types';

// theme-context reads localStorage / matchMedia / queryLocalFonts on mount and
// doesn't export its raw Context, so mock the hook to the fields SessionDrawer
// actually consumes.
vi.mock('../../src/renderer/state/theme-context', () => ({
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

import { SessionDrawer } from '../../src/renderer/components/SessionDrawer';

const SESSION = 'sess-1';
const ROOT = '/home/u/proj';

function htmlArtifact(id: string, path: string): ArtifactRecord {
  return {
    id,
    path,
    kind: 'internal',
    absolutePath: null,
    lastModified: '2026-07-19T00:00:00.000Z',
    status: 'created',
    versions: [],
    comments: [],
    tags: [],
  };
}

const PAGE_A = '<html><body><h1>Page A</h1></body></html>';
const PAGE_B = '<html><body><h1>Page B</h1></body></html>';

// Hand-resolved promises so the test controls exactly when each read lands —
// the bug lives in the window between "switched file" and "new content arrived".
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function renderDrawer(activeId: string) {
  const state = {
    ...initialArtifactState,
    sessionArtifacts: {
      [SESSION]: [htmlArtifact('a', 'a.html'), htmlArtifact('b', 'b.html')],
    },
    drawerOpenBySession: { [SESSION]: true },
    activeArtifactBySession: { [SESSION]: activeId },
  };
  return render(
    <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
      <SessionDrawer
        sessionId={SESSION}
        projectRoot={ROOT}
        projectId="proj-1"
        projectName="proj"
      />
    </ArtifactContext.Provider>,
  );
}

function iframeSrcDoc(container: HTMLElement): string | null {
  const frame = container.querySelector('iframe');
  return frame ? frame.getAttribute('srcdoc') : null;
}

describe('HTML artifact viewer — stale content across file switches', () => {
  beforeEach(() => {
    (window as any).claude = {
      artifacts: {
        get: vi.fn(),
        checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
        onChanged: undefined,
      },
      // SessionDrawer's preview header (spec 2026-08-26 A1/A2/A4) calls
      // useTagRegistry() unconditionally on every render, file-viewing or not.
      tags: { list: vi.fn().mockResolvedValue([]) },
    };
    // WHY: the Session Files list now mounts lazy thumbnails beside filenames;
    // jsdom cannot observe their visibility, and the viewer test does not need to.
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    });
    // jsdom has no matchMedia; the header's narrow-viewport collapse calls
    // useNarrowViewport() unconditionally too (same stub as
    // use-narrow-viewport.test.tsx).
    (window as any).matchMedia = (window as any).matchMedia || ((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
    }));
  });

  it('never shows the previous file’s content after switching artifacts', async () => {
    const readA = deferred<any>();
    (window as any).claude.artifacts.get.mockReturnValueOnce(readA.promise);

    const { container, rerender } = renderDrawer('a');

    await act(async () => { readA.resolve({ ok: true, content: PAGE_A }); });
    expect(iframeSrcDoc(container)).toBe(PAGE_A);

    // Switch to b.html but leave its read IN FLIGHT — this is the exact moment
    // the bug manifested: the remounted iframe held Page A's srcDoc.
    const readB = deferred<any>();
    (window as any).claude.artifacts.get.mockReturnValueOnce(readB.promise);

    const state = {
      ...initialArtifactState,
      sessionArtifacts: {
        [SESSION]: [htmlArtifact('a', 'a.html'), htmlArtifact('b', 'b.html')],
      },
      drawerOpenBySession: { [SESSION]: true },
      activeArtifactBySession: { [SESSION]: 'b' },
    };
    await act(async () => {
      rerender(
        <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
          <SessionDrawer
            sessionId={SESSION}
            projectRoot={ROOT}
            projectId="proj-1"
            projectName="proj"
          />
        </ArtifactContext.Provider>,
      );
    });

    // The regression assertion: no iframe carrying the OLD document. HtmlView
    // renders its Loading state instead, so the frame that eventually mounts
    // receives Page B as its one and only srcDoc.
    expect(iframeSrcDoc(container)).not.toBe(PAGE_A);
    expect(iframeSrcDoc(container)).toBeNull();

    await act(async () => { readB.resolve({ ok: true, content: PAGE_B }); });
    expect(iframeSrcDoc(container)).toBe(PAGE_B);
  });
});
