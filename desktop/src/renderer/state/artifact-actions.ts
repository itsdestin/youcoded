import type { ArtifactRecord } from '../../shared/artifacts/types';

export type ArtifactAction =
  | { type: 'SESSION_ARTIFACTS_LOADED'; sessionId: string; artifacts: ArtifactRecord[] }
  // Add/replace ONE artifact in a session's list (by id) without clearing the
  // rest. Used when an inline filepath pill resolves a file that wasn't in the
  // session's live list (e.g. edited in a prior session, or on-disk) so it can be
  // shown in the drawer.
  | { type: 'SESSION_ARTIFACT_UPSERTED'; sessionId: string; artifact: ArtifactRecord }
  // Remember a session's working directory so consumers without the cwd prop
  // (the inline filepath pills, rendered deep in markdown) can resolve a clicked
  // path against the project's full artifact set.
  | { type: 'SET_SESSION_CWD'; sessionId: string; cwd: string }
  // A pill click that couldn't resolve to an openable file (unknown cwd, an
  // unexpandable ~/ path, artifactify failure). The drawer shows the message
  // instead of the generic "no files yet" empty state — which would directly
  // contradict the file the user just clicked.
  // (The old ARTIFACT_CHANGED action was removed: it only set a pendingRefresh
  // flag nothing ever read. The artifacts:changed push event's real consumer is
  // ActiveArtifactView's own onChanged subscription for the conflict banner.)
  | { type: 'PILL_RESOLVE_FAILED'; sessionId: string; message: string }
  | { type: 'PILL_ERROR_CLEARED'; sessionId: string }
  // A tapped path is being looked up (click mode only). `name` is the file's
  // name as shown in chat. WHY: while the lookup ran, the drawer opened onto
  // "Nothing here yet", contradicting the file just tapped — the drawer shows
  // "Opening <name>…" instead. Cleared by ACTIVE_ARTIFACT_SET (it opened),
  // PILL_RESOLVE_FAILED (it could not), DRAWER_CLOSED and PILL_ERROR_CLEARED.
  | { type: 'PILL_RESOLVE_STARTED'; sessionId: string; name: string }
  // Open/close is per-session (remembered across session switches), so both
  // carry the sessionId whose drawer is being toggled.
  | { type: 'DRAWER_OPENED'; sessionId: string }
  | { type: 'DRAWER_CLOSED'; sessionId: string }
  // Expand-in-place: the drawer grows to fill the framed-shell content region
  // (chat pane hidden) while the header/input chrome stay put. Toggled by the
  // panel's expand button.
  | { type: 'DRAWER_EXPAND_TOGGLED' }
  // Selected artifact is per-session (keyed by sessionId; ProjectView uses the
  // literal 'project-view' key), so both carry the sessionId being selected in.
  | { type: 'ACTIVE_ARTIFACT_SET'; sessionId: string; artifactId: string }
  // Clears the session's selection back to null (back gesture goes to the list).
  | { type: 'ACTIVE_ARTIFACT_CLEARED'; sessionId: string }
  | { type: 'PROJECT_VIEW_OPENED' }
  | { type: 'PROJECT_VIEW_CLOSED' }
  // Git review sub-view within the drawer, per session (see DRAWER_* above).
  | { type: 'GIT_REVIEW_OPENED'; sessionId: string }
  | { type: 'GIT_REVIEW_CLOSED'; sessionId: string }
  // Session references (spec 2026-08-10 §D): previewing a past conversation
  // in the drawer's pane. Mutually exclusive with an active artifact — see
  // artifact-tracker.ts's SESSION_PREVIEW_SET/ACTIVE_ARTIFACT_SET/DRAWER_CLOSED cases.
  | { type: 'SESSION_PREVIEW_SET'; sessionId: string; provider: 'claude' | 'native'; id: string; title: string }
  | { type: 'SESSION_PREVIEW_CLEARED'; sessionId: string }
  // Records that a conversation was previewed this session, for the drawer's
  // "Referenced conversations" list (cut candidate — see Task 6 brief 6b).
  | { type: 'SESSION_REFERENCED'; sessionId: string; ref: { provider: 'claude' | 'native'; id: string; title: string; lastActive: string } };
