export const SIDECAR_SCHEMA_VERSION = 1;
export const INDEX_SCHEMA_VERSION = 1;

export type ArtifactKind = 'internal' | 'external';
export type ArtifactStatus = 'active' | 'deleted';
export type VersionAuthor = 'agent' | 'user';
// 'read' marks a document Claude opened (Read tool) but did not modify — it
// makes the file appear as a session artifact so it's openable from the tool
// card, without fabricating fake edit history. Only document-type files get a
// 'read' version (see the artifact tracker in App.tsx); code/config reads are
// not tracked.
// 'delivered' (2026-08-25) marks a file the assistant handed to the user via
// SendUserFile. Non-read — so an in-project file a script produced becomes
// visible in Project View — but, like 'read', it never bumps lastModified:
// delivery is not modification. Kotlin mirror is a String typealias, so an
// older client reads it fine (labels it "created"; cosmetic).
export type VersionType = 'create' | 'edit' | 'delete' | 'read' | 'delivered';

export interface VersionEvent {
  id: string;            // ULID
  ts: string;            // ISO 8601
  sessionId: string;
  type: VersionType;
  author: VersionAuthor;
  // The transcript tool_use id that produced this version (Write/Edit/Read
  // tool calls). Optional and additive — records written before 2026-08-15
  // don't have it. It is the identity appendVersion dedupes on: opening an old
  // conversation replays its whole transcript through the artifact tracker
  // (see App.tsx / transcript-watcher's offset-0 read), and without a stable
  // per-tool-call id every re-open appended the same edits again, so
  // artifacts.json grew without bound (14k versions / 4.4 MB in youcoded-dev,
  // measured 2026-08-15). Mirrored in Android's SidecarSchema.kt VersionEvent.
  // SCOPE (review 2026-08-15): the dedupe key is (sessionId, toolUseId) and
  // sessionId is the DESKTOP session id. Native sessions keep their id across
  // resumes, so they are fully idempotent; a Claude Code `--resume` mints a
  // fresh desktop id (session-manager.ts), so a resumed CC conversation is
  // re-recorded ONCE PER RESUME under the new id — bounded and crash-free
  // (memory is capped by the append queue), but not growth-free. Making CC
  // resumes idempotent needs a conversation-stable id threaded through the
  // record, LIST_SESSION and the drawer's per-session helpers — ROADMAP item.
  toolUseId?: string;
  // The CONVERSATION this version belongs to, when it differs from the desktop
  // session: a Claude Code session's own id (a `--resume` keeps it, while the
  // desktop id above is fresh each launch). Optional and additive. LIST_SESSION
  // matches it as well as sessionId, so a resumed Claude Code conversation's
  // files list still holds what it touched before the resume — it used to show
  // only the new turns. Versions written before this field existed have none.
  // Mirrored in Android's SidecarSchema.kt VersionEvent.
  conversationId?: string;
}

export interface ArtifactRecord {
  id: string;            // ULID (tracked) OR canonical relative path (discovered)
  path: string;          // canonical, relative if kind='internal'
  kind: ArtifactKind;
  absolutePath: string | null;  // canonical, set when kind='external'
  lastModified: string;  // cache, advisory
  status: ArtifactStatus; // cache, derived from latest version
  versions: VersionEvent[];
  comments: unknown[];    // empty in v1
  tags: string[];         // empty in v1
  // Synthesized at list time for files found on disk that Claude never tracked
  // (on-disk document discovery). NEVER persisted to the sidecar. Consumers must
  // treat discovered files as always-present (skip orphan/existence checks) and
  // resolve their content by PATH (id == canonical relative path), not by sidecar
  // lookup.
  discovered?: boolean;
}

export interface ManualInclude {
  path: string;          // canonical absolute
  addedAt: string;
  addedBy: 'user';
}

export interface ProjectSidecar {
  $schema: typeof SIDECAR_SCHEMA_VERSION;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  artifacts: ArtifactRecord[];
  manualExcludes: string[];     // canonical paths
  manualIncludes: ManualInclude[];
}

// Max length of a user-written project description. Enforced in BOTH setters
// (synced registry + saved folders) and as maxLength on the input, so a pasted
// document can never bloat a file that syncs to every device.
export const PROJECT_DESCRIPTION_MAX = 200;

export interface CentralIndexProject {
  id: string;
  name: string;
  path: string;           // canonical absolute
  lastIndexed: string;
  lastSession: string | null;
  contentTypes: ('artifacts' | 'conversations')[];
  // ARTIFACTS count — files Claude directly created/edited (tracked). In the fast
  // (no-withCounts) list this is the cheap sidecar count; withCounts makes it the
  // authoritative non-deleted, on-disk artifact count.
  stats: { artifactCount: number };
  // Computed at list time (only when LIST_PROJECTS_INDEX is called withCounts) —
  // NOT persisted to the index. Powers the project switcher's "files · chats" hint.
  // fileCount = ALL FILES (the project folder's on-disk documents — the full-browser
  // count), distinct from stats.artifactCount above. conversationCount = number of
  // past sessions in the folder.
  fileCount?: number;
  // True when discovery hit a cap computing fileCount — the UI renders "N+"
  // instead of letting a truncated sample pose as an exact total. Gated roots
  // (home dir / drive root) get NO fileCount at all (no scan runs there).
  fileCountTruncated?: boolean;
  conversationCount?: number;
  // The LOCAL-folder description, overlaid at list time from the saved-folders
  // record exactly as `name` already is from `nickname` (saved-folder-projects.ts:53).
  // A SYNCED project's description arrives instead on the syncSpaces status
  // payload, mirroring how `displayName` is overlaid there — the hero prefers
  // the synced one.
  description?: string | null;
}

export interface CentralIndex {
  $schema: typeof INDEX_SCHEMA_VERSION;
  projects: CentralIndexProject[];
}
