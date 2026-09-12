// IPC channel constants for artifact viewer subsystem
export const ARTIFACT_IPC = {
  LIST_SESSION: 'artifacts:list-session',
  // CORE PRINCIPLE — two distinct concepts, never merged. (No apostrophes or
  // single quotes in this comment: the parity test treats any single-quoted
  // string here as a channel name.)
  //   LIST_PROJECT   = ARTIFACTS: files Claude directly created/edited (tracked
  //                    sidecar entries, internal or included-external).
  //   LIST_ALL_FILES = ALL FILES: the project folder real documents on disk
  //                    (full-browser view), independent of what Claude touched.
  LIST_PROJECT: 'artifacts:list-project',
  LIST_ALL_FILES: 'artifacts:list-all-files',
  GET: 'artifacts:get',
  // Read a file as base64 bytes — for binary viewers (xlsx/docx/pdf/images) that
  // cannot fetch a file URL from the renderer origin. Takes an absolute path.
  READ_BINARY: 'artifacts:read-binary',
  SAVE: 'artifacts:save',
  // Fix: wire the data-flow gap — renderer calls this when it observes a
  // Write/Edit/MultiEdit tool-use event so the central index and sidecar are
  // populated even when the user never manually opens the artifact drawer.
  APPEND_VERSION: 'artifacts:append-version',
  // Copy or move a picked file INTO the project folder (see artifacts/import-file.ts).
  // Powers the + Add file button, which no longer pins externals.
  IMPORT_FILE: 'artifacts:import-file',
  // DEPRECATED 2026-07-23 — no caller since + Add file became an import. The
  // handler stays so existing sidecar manualIncludes entries keep round-tripping
  // and rule 1 keeps legacy pins visible. See the file-merge spec.
  INCLUDE_EXTERNAL: 'artifacts:include-external',
  EXCLUDE: 'artifacts:exclude',
  CHANGED: 'artifacts:changed', // push event
  LIST_PROJECTS_INDEX: 'artifacts:list-projects-index',
  // Task 7.3: remove a project from the central index (and optionally its sidecar)
  DELETE_PROJECT: 'artifacts:delete-project',
  // Resolves each tracked path and runs fs.access on it in parallel, returning
  // the IDs whose file is missing, so the renderer can fold "file not on disk"
  // into the same "deleted" UI state as sidecar-tracked delete versions and the
  // user only sees one concept. The ONE renderer caller is the shared
  // useMissingArtifacts cache (hooks/useMissingArtifacts.ts), which the Session
  // Drawer list and the header file badge both read; they used to call this
  // separately and could disagree. (The comment here named Project View as a
  // caller until 2026-08-30 — it has had none since its Files tab moved to
  // on-disk discovery, which cannot list a file that is not there.)
  // (No apostrophes in this comment — the ipc-channels parity test scans for
  // single-quoted strings and any stray apostrophe would be treated as a channel.)
  CHECK_EXISTENCE: 'artifacts:check-existence',
  // Rename an artifact: renames the file on disk (extension preserved) and
  // updates the sidecar record so version history follows the file. The new
  // name is a basename without extension; collisions are rejected.
  RENAME: 'artifacts:rename',
  // Remove an artifact RECORD from the sidecar — the tracking entry only,
  // never the file on disk. Powers the Session Drawer per-row remove (clears
  // accidental pill-click tracks and dead orphan rows). Claude editing the
  // file again re-creates a fresh record.
  REMOVE_RECORD: 'artifacts:remove-record',
  // Subscribe/unsubscribe this renderer to external-change events for a project
  // root (filesystem watcher in main, refcounted per webContents — see
  // artifacts/project-watcher.ts). Events arrive on the CHANGED channel with
  // by external, meaning changed on disk by something other than this app.
  WATCH_PROJECT: 'artifacts:watch-project',
  UNWATCH_PROJECT: 'artifacts:unwatch-project',
  // Project-wide content search over bundled ripgrep (desktop-only; the Files
  // tab ranks these hits BELOW filename matches in one unified list).
  SEARCH_CONTENT: 'artifacts:search-content',
  // Resolve ONE file path tapped in chat to the record the drawer opens (a
  // tracked record, or the discovered record for an on-disk file inside the
  // folder). Replaces downloading the whole project list to find one file;
  // see resolveArtifactPath in read-service.ts. A read, bridged over remote.
  // (No apostrophes in this comment — the parity test reads quoted strings.)
  RESOLVE_PATH: 'artifacts:resolve-path',
} as const;

export type ArtifactIpcChannel = typeof ARTIFACT_IPC[keyof typeof ARTIFACT_IPC];
