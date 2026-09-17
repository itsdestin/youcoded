// YouCoded Pages — the page view's state machine (artifact-tracker.ts).
//
// Pins Destin's 2026-09-17 decisions: a pinned button opens its page in
// FOCUS (no panel); the Pages button brings the panel back with the page
// still open; Projects and Pages replace each other; leaving resets focus.
import { describe, it, expect } from 'vitest';
import { artifactReducer, initialArtifactState } from '../src/renderer/state/artifact-tracker';

describe('page view state', () => {
  it('a pinned button opens the page focused; the Pages button un-focuses without closing it', () => {
    let s = artifactReducer(initialArtifactState, { type: 'PAGE_OPENED', pageId: 'personal:timer', focus: true });
    expect(s).toMatchObject({ pageViewOpen: true, pageFocus: true, openPageId: 'personal:timer', pagesViewOpen: false });
    s = artifactReducer(s, { type: 'PAGE_VIEW_OPENED' });
    expect(s).toMatchObject({ pageViewOpen: true, pageFocus: false, openPageId: 'personal:timer' });
  });

  it('a panel row or card opens without focus', () => {
    const s = artifactReducer(initialArtifactState, { type: 'PAGE_OPENED', pageId: 'personal:timer' });
    expect(s.pageFocus).toBe(false);
  });

  it('leaving the view, or opening Projects, clears the page and its focus', () => {
    const open = artifactReducer(initialArtifactState, { type: 'PAGE_OPENED', pageId: 'p', focus: true });
    expect(artifactReducer(open, { type: 'PAGE_VIEW_CLOSED' })).toMatchObject({ pageViewOpen: false, pageFocus: false, openPageId: null });
    const projects = artifactReducer(open, { type: 'PROJECT_VIEW_OPENED' });
    expect(projects).toMatchObject({ projectViewOpen: true, pageViewOpen: false, pageFocus: false, openPageId: null });
    // …and back: Pages replaces Projects in place.
    expect(artifactReducer(projects, { type: 'PAGE_VIEW_OPENED' })).toMatchObject({ projectViewOpen: false, pageViewOpen: true });
  });
});
