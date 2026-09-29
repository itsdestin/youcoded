// IPC channel constants for the document-comments surface (T3, design
// docs/active/specs/2026-09-26-doc-comments-build-design.md §1.6). A
// dedicated, separately-imported map — same convention as ARTIFACT_IPC/
// GIT_IPC, not shared/types.ts's IPC const — since preload.ts inlines these
// as literal strings anyway (Electron's sandbox forbids the relative import).
// Comment rule: never put a single-quoted string inside a comment in this
// file family — parity tests harvest every quoted token as a channel name.
export const DOC_COMMENTS_IPC = {
  LIST: 'docComments:list',
  ADD: 'docComments:add',
  REPLY: 'docComments:reply',
  RESOLVE: 'docComments:resolve',
  REOPEN: 'docComments:reopen',
  MOVE: 'docComments:move',
  // Edit/delete build (2026-09-28, design doc §"Edit and delete").
  EDIT: 'docComments:edit',
  EDIT_REPLY: 'docComments:edit-reply',
  DELETE: 'docComments:delete',
  DELETE_REPLY: 'docComments:delete-reply',
  WATCH: 'docComments:watch',
  UNWATCH: 'docComments:unwatch',
  CHANGED: 'docComments:changed', // push event
} as const;
