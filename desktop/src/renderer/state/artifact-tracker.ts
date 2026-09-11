import type { ArtifactRecord } from '../../shared/artifacts/types';
import type { ArtifactAction } from './artifact-actions';

export interface ArtifactState {
  sessionArtifacts: Record<string, ArtifactRecord[]>; // by sessionId
  sessionCwd: Record<string, string>;                 // sessionId → working dir
  projectArtifacts: Record<string, ArtifactRecord[]>; // by projectRoot
  // A pill click that couldn't resolve (per session). SessionDrawer shows this
  // instead of the "no files yet" empty state; cleared on the next pill click,
  // a successful selection, or drawer close.
  pillError: Record<string, string | null>;
  // A tapped file still being looked up (per session): the file's name as the
  // chat shows it. WHY (2026-09-11, the owner's phone): the drawer opened onto
  // "Nothing here yet" for as long as the lookup took, contradicting the file
  // just tapped. SessionDrawer shows "Opening <name>…" instead. Every way a
  // lookup ends clears it — the file opened, it could not open, the drawer
  // closed, or a new tap started.
  pillPending: Record<string, string | null>;
  // Drawer open/closed is scoped per session and remembered across switches.
  // A new/unseen session has no entry → closed by default. Consumers read the
  // ACTIVE session's flag; the open/close actions carry the sessionId.
  drawerOpenBySession: Record<string, boolean>;
  drawerExpanded: boolean;                            // panel fills the content region
  projectViewOpen: boolean;
  // Selected artifact is scoped per session (keyed by sessionId), so each
  // session's drawer remembers which file was open across session switches.
  // ProjectView uses the literal 'project-view' key for its own selection.
  activeArtifactBySession: Record<string, string | null>;
  /** Per-session: the drawer is showing the git review sub-view for the active file. */
  gitReviewBySession: Record<string, boolean>;
  // Session references (spec 2026-08-10 §D). A previewed past conversation
  // occupies the drawer's content pane INSTEAD of an artifact. Two fields, one
  // rule: setting either clears the other (pinned by artifact-tracker-preview
  // test), so the pane never has two things to show.
  activeSessionPreviewBySession: Record<string, { provider: 'claude' | 'native'; id: string; title: string } | null>;
  // Every conversation previewed during this session, newest first — the
  // drawer's "Referenced conversations" list. Not persisted (v1).
  referencedSessionsBySession: Record<string, Array<{ provider: 'claude' | 'native'; id: string; title: string; lastActive: string }>>;
}

export const initialArtifactState: ArtifactState = {
  sessionArtifacts: {},
  sessionCwd: {},
  projectArtifacts: {},
  pillError: {},
  pillPending: {},
  drawerOpenBySession: {},
  drawerExpanded: false,
  projectViewOpen: false,
  activeArtifactBySession: {},
  gitReviewBySession: {},
  activeSessionPreviewBySession: {},
  referencedSessionsBySession: {},
};

export function artifactReducer(s: ArtifactState, a: ArtifactAction): ArtifactState {
  switch (a.type) {
    case 'SESSION_ARTIFACTS_LOADED':
      return { ...s, sessionArtifacts: { ...s.sessionArtifacts, [a.sessionId]: a.artifacts } };
    case 'SESSION_ARTIFACT_UPSERTED': {
      const existing = s.sessionArtifacts[a.sessionId] ?? [];
      const i = existing.findIndex((x) => x.id === a.artifact.id);
      const next = i >= 0
        ? existing.map((x, j) => (j === i ? a.artifact : x))
        : [...existing, a.artifact];
      return { ...s, sessionArtifacts: { ...s.sessionArtifacts, [a.sessionId]: next } };
    }
    case 'SET_SESSION_CWD':
      return { ...s, sessionCwd: { ...s.sessionCwd, [a.sessionId]: a.cwd } };
    case 'PILL_RESOLVE_STARTED':
      return { ...s, pillPending: { ...s.pillPending, [a.sessionId]: a.name } };
    case 'PILL_RESOLVE_FAILED':
      // The lookup ended — the failure note replaces the "Opening …" note.
      return {
        ...s,
        pillError: { ...s.pillError, [a.sessionId]: a.message },
        pillPending: { ...s.pillPending, [a.sessionId]: null },
      };
    case 'PILL_ERROR_CLEARED':
      return {
        ...s,
        pillError: { ...s.pillError, [a.sessionId]: null },
        pillPending: { ...s.pillPending, [a.sessionId]: null },
      };
    case 'DRAWER_OPENED':
      return { ...s, drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: true } };
    case 'DRAWER_CLOSED':
      // Reset expand + clear this session's selection (and any pill-error note)
      // so a re-opened drawer starts at its normal width on the list. Also
      // resets the git-review flag so a re-opened drawer lands on the file
      // view, not back inside a stale review sub-view.
      return {
        ...s,
        drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: false },
        drawerExpanded: false,
        activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: null },
        pillError: { ...s.pillError, [a.sessionId]: null },
        // A re-opened drawer must not say "Opening …" for a tap the person closed on.
        pillPending: { ...s.pillPending, [a.sessionId]: null },
        gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: false },
        // Closing the drawer must also drop a live preview — the exclusivity
        // rule (only one of active-artifact/preview at a time) still applies
        // once neither is showing.
        activeSessionPreviewBySession: { ...s.activeSessionPreviewBySession, [a.sessionId]: null },
      };
    case 'DRAWER_EXPAND_TOGGLED':
      return { ...s, drawerExpanded: !s.drawerExpanded };
    case 'ACTIVE_ARTIFACT_SET':
      return {
        ...s,
        activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: a.artifactId },
        // A successful open supersedes any earlier failure note.
        pillError: { ...s.pillError, [a.sessionId]: null },
        // …and ends any lookup that was still showing "Opening …".
        pillPending: { ...s.pillPending, [a.sessionId]: null },
        // Clicking a file in the list always lands on the file view — the review
        // view belongs to the file it was opened from, not the newly selected one.
        gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: false },
        // Opening a real artifact always wins over a live preview — the pane
        // and the artifact view never both show at once.
        activeSessionPreviewBySession: { ...s.activeSessionPreviewBySession, [a.sessionId]: null },
      };
    // Back gesture in detail view: return to list without closing the drawer.
    case 'ACTIVE_ARTIFACT_CLEARED':
      return { ...s, activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: null } };
    case 'PROJECT_VIEW_OPENED':
      return { ...s, projectViewOpen: true };
    case 'PROJECT_VIEW_CLOSED':
      return { ...s, projectViewOpen: false };
    case 'GIT_REVIEW_OPENED':
      return { ...s, gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: true } };
    case 'GIT_REVIEW_CLOSED':
      return { ...s, gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: false } };
    // Preview a past conversation in the drawer's content pane. Opens the
    // drawer (so a Preview click from anywhere in the chat, before the
    // drawer exists, still shows something) and clears any real artifact +
    // git-review sub-view so the pane is the only thing on screen.
    case 'SESSION_PREVIEW_SET':
      return {
        ...s,
        drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: true },
        activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: null },
        activeSessionPreviewBySession: { ...s.activeSessionPreviewBySession, [a.sessionId]: { provider: a.provider, id: a.id, title: a.title } },
        gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: false },
      };
    case 'SESSION_PREVIEW_CLEARED':
      return { ...s, activeSessionPreviewBySession: { ...s.activeSessionPreviewBySession, [a.sessionId]: null } };
    // Dedupe by provider+id (the same conversation re-previewed moves to the
    // top rather than appearing twice), newest first.
    case 'SESSION_REFERENCED': {
      const prev = s.referencedSessionsBySession[a.sessionId] ?? [];
      const rest = prev.filter((r) => !(r.provider === a.ref.provider && r.id === a.ref.id));
      return { ...s, referencedSessionsBySession: { ...s.referencedSessionsBySession, [a.sessionId]: [a.ref, ...rest] } };
    }
    default:
      return s;
  }
}
