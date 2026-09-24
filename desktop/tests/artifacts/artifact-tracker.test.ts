// artifactReducer — the renderer's per-session file-pane state: loaded artifacts,
// the drawer, conversation previews and the git review view.
import { describe, expect, it } from 'vitest';
import {
  initialArtifactState,
  artifactReducer,
} from '../../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../../src/shared/artifacts/types';

const sampleArtifact: ArtifactRecord = {
  id: 'art_1',
  path: 'a.md',
  kind: 'internal',
  absolutePath: null,
  lastModified: 'now',
  status: 'active',
  versions: [{ id: 'v1', ts: 'now', sessionId: 's1', type: 'create', author: 'agent' }],
  comments: [],
  tags: [],
};

describe('artifactReducer', () => {
  it('SESSION_ARTIFACTS_LOADED replaces sessionArtifacts', () => {
    const next = artifactReducer(initialArtifactState, {
      type: 'SESSION_ARTIFACTS_LOADED',
      sessionId: 's1',
      artifacts: [sampleArtifact],
    });
    expect(next.sessionArtifacts['s1']).toEqual([sampleArtifact]);
  });

  // The loading state for a tapped file (2026-09-11): while the lookup runs the
  // drawer said "Nothing here yet", contradicting the file just tapped. The
  // pending name lives here; every way a lookup can end clears it.
  it('PILL_RESOLVE_STARTED records the tapped name per session; every ending clears it', () => {
    const started = artifactReducer(initialArtifactState, { type: 'PILL_RESOLVE_STARTED', sessionId: 's1', name: 'CLAUDE.md' });
    expect(started.pillPending['s1']).toBe('CLAUDE.md');
    expect(started.pillPending['s2']).toBeUndefined();
    for (const end of [
      { type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'a1' },
      { type: 'PILL_RESOLVE_FAILED', sessionId: 's1', message: 'Couldn’t open CLAUDE.md' },
      { type: 'DRAWER_CLOSED', sessionId: 's1' },
      { type: 'PILL_ERROR_CLEARED', sessionId: 's1' },
    ] as const) {
      expect(artifactReducer(started, end).pillPending['s1'], end.type).toBeNull();
    }
  });

  it('PILL_RESOLVE_STARTED clears nothing else about the drawer', () => {
    const before = artifactReducer(initialArtifactState, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'a1' });
    const after = artifactReducer(before, { type: 'PILL_RESOLVE_STARTED', sessionId: 's1', name: 'x.md' });
    expect(after.activeArtifactBySession['s1']).toBe('a1');
  });

  it('PILL_RESOLVE_FAILED stores a per-session note; cleared on selection', () => {
    let s = artifactReducer(initialArtifactState, {
      type: 'PILL_RESOLVE_FAILED',
      sessionId: 's1',
      message: 'Couldn’t open x.md',
    });
    expect(s.pillError['s1']).toBe('Couldn’t open x.md');
    // A successful open supersedes the failure note.
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'a1' });
    expect(s.pillError['s1']).toBeNull();
  });

  it('PILL_ERROR_CLEARED and DRAWER_CLOSED clear the note', () => {
    let s = artifactReducer(initialArtifactState, {
      type: 'PILL_RESOLVE_FAILED', sessionId: 's1', message: 'nope',
    });
    s = artifactReducer(s, { type: 'PILL_ERROR_CLEARED', sessionId: 's1' });
    expect(s.pillError['s1']).toBeNull();
    s = artifactReducer(s, { type: 'PILL_RESOLVE_FAILED', sessionId: 's1', message: 'nope' });
    s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: 's1' });
    expect(s.pillError['s1']).toBeNull();
  });

  it('DRAWER_OPENED sets the per-session open flag', () => {
    const next = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED', sessionId: 'sess_a' });
    expect(next.drawerOpenBySession['sess_a']).toBe(true);
  });

  it('drawer open state is scoped per session', () => {
    let s = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED', sessionId: 'sess_a' });
    // A different session stays closed (no entry → undefined → treated as closed).
    expect(s.drawerOpenBySession['sess_a']).toBe(true);
    expect(s.drawerOpenBySession['sess_b']).toBeUndefined();
    // Opening B doesn't disturb A.
    s = artifactReducer(s, { type: 'DRAWER_OPENED', sessionId: 'sess_b' });
    expect(s.drawerOpenBySession['sess_a']).toBe(true);
    expect(s.drawerOpenBySession['sess_b']).toBe(true);
  });

  it('DRAWER_CLOSED clears that session and its selection', () => {
    let s = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED', sessionId: 'sess_a' });
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 'sess_a', artifactId: 'art_1' });
    s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: 'sess_a' });
    expect(s.drawerOpenBySession['sess_a']).toBe(false);
    expect(s.activeArtifactBySession['sess_a']).toBeNull();
  });

  it('selected artifact is scoped per session', () => {
    let s = artifactReducer(initialArtifactState, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 'sess_a', artifactId: 'art_1' });
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 'sess_b', artifactId: 'art_2' });
    expect(s.activeArtifactBySession['sess_a']).toBe('art_1');
    expect(s.activeArtifactBySession['sess_b']).toBe('art_2');
    // Clearing one session leaves the other intact.
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: 'sess_a' });
    expect(s.activeArtifactBySession['sess_a']).toBeNull();
    expect(s.activeArtifactBySession['sess_b']).toBe('art_2');
  });
});

describe('conversation preview', () => {
  const S = 'sess';
  const ref = { provider: 'claude' as const, id: 'abc', title: 'T', lastActive: '2026-07-26T00:00:00Z' };

  describe('session preview exclusivity', () => {
    it('SESSION_PREVIEW_SET clears the active artifact and opens the drawer', () => {
      let s = artifactReducer(initialArtifactState, { type: 'ACTIVE_ARTIFACT_SET', sessionId: S, artifactId: 'art1' });
      s = artifactReducer(s, { type: 'SESSION_PREVIEW_SET', sessionId: S, provider: 'claude', id: 'abc', title: 'T' });
      expect(s.activeArtifactBySession[S]).toBeNull();
      expect(s.activeSessionPreviewBySession[S]).toEqual({ provider: 'claude', id: 'abc', title: 'T' });
      expect(s.drawerOpenBySession[S]).toBe(true);
    });
    it('ACTIVE_ARTIFACT_SET clears the preview', () => {
      let s = artifactReducer(initialArtifactState, { type: 'SESSION_PREVIEW_SET', sessionId: S, provider: 'claude', id: 'abc', title: 'T' });
      s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: S, artifactId: 'art1' });
      expect(s.activeSessionPreviewBySession[S]).toBeNull();
      expect(s.activeArtifactBySession[S]).toBe('art1');
    });
    it('DRAWER_CLOSED clears both', () => {
      let s = artifactReducer(initialArtifactState, { type: 'SESSION_PREVIEW_SET', sessionId: S, provider: 'claude', id: 'abc', title: 'T' });
      s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: S });
      expect(s.activeSessionPreviewBySession[S]).toBeNull();
      expect(s.activeArtifactBySession[S]).toBeNull();
    });
    it('SESSION_REFERENCED dedupes by provider+id, newest first', () => {
      let s = artifactReducer(initialArtifactState, { type: 'SESSION_REFERENCED', sessionId: S, ref });
      s = artifactReducer(s, { type: 'SESSION_REFERENCED', sessionId: S, ref: { ...ref, id: 'def' } });
      s = artifactReducer(s, { type: 'SESSION_REFERENCED', sessionId: S, ref });
      expect(s.referencedSessionsBySession[S].map((r) => r.id)).toEqual(['abc', 'def']);
    });
  });
});

describe('git review', () => {
  const open = (s = initialArtifactState) =>
    artifactReducer(s, { type: 'GIT_REVIEW_OPENED', sessionId: 's1' } as any);

  describe('git review view state', () => {
    it('defaults closed', () => {
      expect(initialArtifactState.gitReviewBySession).toEqual({});
    });

    it('GIT_REVIEW_OPENED / GIT_REVIEW_CLOSED flip the per-session flag', () => {
      let s = open();
      expect(s.gitReviewBySession['s1']).toBe(true);
      s = artifactReducer(s, { type: 'GIT_REVIEW_CLOSED', sessionId: 's1' } as any);
      expect(s.gitReviewBySession['s1']).toBe(false);
    });

    it('DRAWER_CLOSED clears the flag for that session', () => {
      let s = open();
      s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: 's1' } as any);
      expect(s.gitReviewBySession['s1']).toBeFalsy();
    });

    it('selecting a different artifact exits review (view follows the file)', () => {
      let s = open();
      s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'a2' } as any);
      expect(s.gitReviewBySession['s1']).toBe(false);
    });

    it('is per-session', () => {
      const s = open();
      expect(s.gitReviewBySession['s2']).toBeUndefined();
    });
  });
});

// Perf, 2026-09-23: a closed session's entries were never freed, so a day of
// opening and closing tabs kept every closed session's file list and drawer
// flags in memory until restart. App dispatches SESSION_REMOVED where it drops
// a session (session:destroyed, removeSessionLocally).
describe('SESSION_REMOVED', () => {
  const ref = (id: string) => ({ provider: 'claude' as const, id, title: 'T', lastActive: 'now' });
  // Every per-session record holds an entry for the closing session 'gone', the
  // surviving session 'kept' and Project View's own 'project-view' key.
  const populated = () => {
    let s = initialArtifactState;
    for (const sid of ['gone', 'kept', 'project-view']) {
      s = artifactReducer(s, { type: 'SESSION_ARTIFACTS_LOADED', sessionId: sid, artifacts: [sampleArtifact] });
      s = artifactReducer(s, { type: 'SET_SESSION_CWD', sessionId: sid, cwd: '/p' });
      s = artifactReducer(s, { type: 'DRAWER_OPENED', sessionId: sid });
      s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: sid, artifactId: 'art_1' });
      s = artifactReducer(s, { type: 'GIT_REVIEW_OPENED', sessionId: sid });
      s = artifactReducer(s, { type: 'PILL_RESOLVE_STARTED', sessionId: sid, name: 'x' });
      s = artifactReducer(s, { type: 'PILL_RESOLVE_FAILED', sessionId: sid, message: 'no' });
      s = artifactReducer(s, { type: 'SESSION_PREVIEW_SET', sessionId: sid, provider: 'claude', id: 'conv-gone', title: 'T' });
      s = artifactReducer(s, { type: 'SESSION_REFERENCED', sessionId: sid, ref: ref('conv-gone') });
    }
    return s;
  };
  const PER_SESSION = [
    'sessionArtifacts', 'sessionCwd', 'pillError', 'pillPending', 'drawerOpenBySession',
    'activeArtifactBySession', 'gitReviewBySession', 'activeSessionPreviewBySession',
    'referencedSessionsBySession',
  ] as const;

  it('deletes the session\'s key from all nine per-session records', () => {
    const s = artifactReducer(populated(), { type: 'SESSION_REMOVED', sessionId: 'gone' });
    for (const field of PER_SESSION) {
      expect(Object.keys(s[field]), field).not.toContain('gone');
    }
  });

  it('the nine are every per-session record the state has (a new one must be added to the case)', () => {
    const recordFields = Object.entries(initialArtifactState)
      .filter(([k, v]) => v && typeof v === 'object' && k !== 'projectArtifacts')
      .map(([k]) => k)
      .sort();
    expect(recordFields).toEqual([...PER_SESSION].sort());
  });

  it('leaves other sessions and Project View untouched — including previews that name the same conversation', () => {
    const before = populated();
    const s = artifactReducer(before, { type: 'SESSION_REMOVED', sessionId: 'gone' });
    for (const field of PER_SESSION) {
      expect(s[field]['kept'], field).toBe(before[field]['kept']);
      expect(s[field]['project-view'], field).toBe(before[field]['project-view']);
    }
    // The referenced list names CONVERSATIONS, not tabs: 'kept' can still
    // preview the conversation even though the tab that made it closed.
    expect(s.referencedSessionsBySession['kept'].map((r) => r.id)).toEqual(['conv-gone']);
    expect(s.activeSessionPreviewBySession['kept']?.id).toBe('conv-gone');
  });

  it('returns the same state when the session had no entries (no reader wakes)', () => {
    const before = populated();
    expect(artifactReducer(before, { type: 'SESSION_REMOVED', sessionId: 'never-seen' })).toBe(before);
  });
});
