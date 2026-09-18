// ---------------------------------------------------------------------------
// INVARIANT: which mechanism carries a session pill OUT of its window is chosen
// from FACTS about the host, and the session id rides in the drag's own
// payload under a private MIME type — which is also how "is this drag ours" is
// answered mid-drag, when the value itself is still withheld.
//
// Why this is pinned: the cross-window half of session detach reads screen
// coordinates, and on Linux/Wayland every one of those is zero (see
// session-drag-model.ts for the measurements). The fork below is what keeps
// that half working there. An earlier attempt at this fix disabled the POINTER
// path on Wayland too, which would have thrown away the strip's in-strip motion
// to fix a cross-window problem — hence the test that says what is NOT chosen.
// ---------------------------------------------------------------------------
//
// WHY no preload source-scan cases here any more (Plan B, 2026-09-16): "preload
// reports facts, not a verdict" is the ast-grep rule preload-no-drag-model-decision
// in the workspace's scripts/ast-grep/rules/.
import { describe, it, expect } from 'vitest';
import {
  chooseTearOffModel,
  SESSION_DRAG_MIME,
  dragCarriesSession,
  writeSessionDrag,
  readSessionDrag,
  beginLocalSessionDrag,
  endLocalSessionDrag,
  localSessionDrag,
} from '../src/renderer/session-drag-model';

describe('chooseTearOffModel', () => {
  it('lets the browser own the gesture on Linux + Wayland, where coordinates are all zero', () => {
    expect(chooseTearOffModel({ platform: 'linux', wayland: true })).toBe('html-drag');
  });

  it('keeps the live tear-off everywhere it actually works', () => {
    expect(chooseTearOffModel({ platform: 'win32', wayland: false })).toBe('live-window');
    expect(chooseTearOffModel({ platform: 'darwin', wayland: false })).toBe('live-window');
    // Linux on X11 can read and set window positions, so it keeps the animation.
    expect(chooseTearOffModel({ platform: 'linux', wayland: false })).toBe('live-window');
  });

  it('falls back to the live tear-off where nothing is reported', () => {
    // Browser tab, Android, workbench: single-window surfaces where the strip's
    // cross-window paths are inert either way.
    expect(chooseTearOffModel(null)).toBe('live-window');
    expect(chooseTearOffModel(undefined)).toBe('live-window');
  });
});

/** jsdom has no DataTransfer; this is what the real one does with types/data. */
function fakeTransfer() {
  const data = new Map<string, string>();
  return {
    get types() { return Array.from(data.keys()); },
    setData: (t: string, v: string) => { data.set(t, v); },
    getData: (t: string) => data.get(t) ?? '',
  };
}

describe('the drag payload', () => {
  it('round-trips a session id through the private MIME type', () => {
    const dt = fakeTransfer();
    writeSessionDrag(dt, '9f1c0b6e-1c2d-4a3b-9e8f-0a1b2c3d4e5f');
    expect(dt.types).toEqual([SESSION_DRAG_MIME]);
    expect(dragCarriesSession(dt)).toBe(true);
    expect(readSessionDrag(dt)).toBe('9f1c0b6e-1c2d-4a3b-9e8f-0a1b2c3d4e5f');
  });

  it('is recognisable mid-drag from types alone, before the value is readable', () => {
    // The browser withholds getData until the drop; types are visible throughout.
    expect(dragCarriesSession({ types: [SESSION_DRAG_MIME] })).toBe(true);
  });

  it('refuses anything that is not one of ours, so a real file drop is not eaten', () => {
    expect(dragCarriesSession({ types: ['Files'] })).toBe(false);
    expect(dragCarriesSession({ types: ['text/plain', 'text/uri-list'] })).toBe(false);
    expect(dragCarriesSession({ types: [] })).toBe(false);
    expect(dragCarriesSession(null)).toBe(false);
    expect(readSessionDrag({ types: ['Files'], getData: () => 'x' })).toBeNull();
    // Ours by type but empty: still not a session.
    expect(readSessionDrag({ types: [SESSION_DRAG_MIME], getData: () => '' })).toBeNull();
  });
});

describe('the drag this window started', () => {
  it('is visible while in flight and gone after', () => {
    expect(localSessionDrag()).toBeNull();
    beginLocalSessionDrag({ sessionId: 'a', lone: false });
    expect(localSessionDrag()).toEqual({ sessionId: 'a', lone: false });
    endLocalSessionDrag();
    expect(localSessionDrag()).toBeNull();
  });
});
