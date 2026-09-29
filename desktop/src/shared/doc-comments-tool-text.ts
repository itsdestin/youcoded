// The six document-comment tools' exact description text — design
// docs/active/specs/2026-09-26-doc-comments-build-design.md §5's table,
// §5.1's R4-mandated `AddComment` wording ("sparingly... never to narrate").
//
// WHY this is its own shared file (unlike send-user-link.ts's one-line
// description, which is duplicated by hand with no drift risk worth a shared
// constant): the native harness surface (T8,
// harness/tools/doc-comments-tools.ts) and the Claude Code MCP surface (T9a,
// claude-code-doc-comments-mcp.ts) both have to show the model IDENTICAL text
// — design §9's own T8 task-table warning is explicit that "AddComment's
// description drifting from the exact 'sparingly' wording is how R4 quietly
// regresses later." The MCP server is a dependency-free plain-JS string (§9)
// that cannot `import` this file, so it hand-copies this text verbatim into
// its own template — `claude-code-doc-comments-mcp.test.ts` pins the two
// copies against each other so a future edit to one is caught if the other
// isn't updated too.
export const READ_FILE_COMMENTS_DESCRIPTION =
  'Every comment on a file, with status (anchored/detached), replies, and resolve history. '
  + 'Read this before replying to, resolving, reopening, or moving any comment — the ids and '
  + 'current state it returns are what those tools need.';

export const REPLY_TO_COMMENT_DESCRIPTION =
  'Reply to a comment the user (or a previous turn) left on this file — for a plain-text/markdown/code '
  + 'comment thread, or a real Word/Excel comment. Use it to answer a question they left, or to say what '
  + 'you did about something they flagged.';

export const RESOLVE_COMMENT_DESCRIPTION =
  "Mark a comment resolved — recorded in its history as resolved by the assistant. Use this once you've "
  + 'addressed what a comment asked for; R6 (nothing silently lost) is why the resolve/reopen history stays visible.';

export const REOPEN_COMMENT_DESCRIPTION =
  "Reopen a comment that was marked resolved — clears its resolved state so it shows as open again. Use this "
  + "if a resolved comment's issue turns out not to be fully addressed.";

// R4 (§5.1) — pre-written, signed constraint text. Never paraphrase.
export const ADD_COMMENT_DESCRIPTION =
  "Leave a comment on this file — sparingly. Use this only for something that clearly needs the user's "
  + 'attention or a decision from them, never to narrate what you just did or are about to do. If you\'re '
  + "explaining your own edit, say so in your reply to them instead; if nothing needs their decision, don't "
  + 'add a comment at all.';

export const MOVE_COMMENT_DESCRIPTION =
  "Repoint a comment to a new location in the file, after the text or cell it was attached to moved or "
  + 'changed. This is the re-anchor half of R6 (nothing silently lost): after you fix what a comment asked '
  + 'for, use this — together with ReplyToComment/ResolveComment as appropriate — so the comment keeps '
  + 'pointing at something real instead of going quietly detached.';
