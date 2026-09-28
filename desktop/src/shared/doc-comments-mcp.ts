// Shared vocabulary for the doc-comments Claude Code MCP server (T9a/T9b),
// mirroring send-user-link.ts's own shape: names two surfaces that may not
// import each other must still agree on — the native harness tools
// (main/harness/tools/doc-comments-tools.ts) and the deployed MCP server
// (main/claude-code-doc-comments-mcp.ts, a hand-copied dependency-free plain-
// JS string with no access to this file, same constraint as claude-code-
// mcp.ts's LINK_SERVER_JS). This file is imported by main.ts's own
// permission-auto-approve wiring, which DOES run in the real main process and
// needs the exact composed tool names to recognize a PermissionRequest hook
// payload for one of these six tools.
export const DOC_COMMENTS_MCP_SERVER_ID = 'youcoded-doc-comments';

/** Bare tool names — identical to the native harness tool names (design §5's
 *  table: "same names/semantics on both surfaces"). Not exported: nothing
 *  outside this file needs the raw list itself, only the two composed-name
 *  constants below it builds. */
const DOC_COMMENTS_BARE_TOOL_NAMES = [
  'ReadFileComments',
  'ReplyToComment',
  'ResolveComment',
  'ReopenComment',
  'AddComment',
  'MoveComment',
] as const;
type DocCommentsBareToolName = (typeof DOC_COMMENTS_BARE_TOOL_NAMES)[number];

/** Claude Code's own naming convention for an attached MCP tool:
 *  `mcp__{server}__{tool}` (youcoded/docs/cc-dependencies.md). Not exported —
 *  see DOC_COMMENTS_MCP_READ_TOOL/DOC_COMMENTS_MCP_MUTATOR_TOOLS below, which
 *  are the composed names every other caller (main.ts, session-manager.ts,
 *  tests) actually needs. */
function docCommentsMcpToolName(bare: DocCommentsBareToolName): string {
  return `mcp__${DOC_COMMENTS_MCP_SERVER_ID}__${bare}`;
}

/** The one tool that is always pre-approved via `--allowedTools`, on every
 *  target type — a read never mutates the source file or its comment store
 *  (same posture as the native tool's `permissionSubject: () => undefined`,
 *  doc-comments-tools.ts's own `ReadFileCommentsTool`). */
export const DOC_COMMENTS_MCP_READ_TOOL = docCommentsMcpToolName('ReadFileComments');

/** The five tools whose target CAN be a Word/Excel file's own bytes (§5.2a,
 *  decided option 1) — never allow-listed, since the same tool name also
 *  serves a plain-text/markdown/code target that must stay frictionless.
 *  main.ts's permission-auto-approve wiring uses this set to recognize a
 *  PermissionRequest for one of these and decide by the call's OWN `path`
 *  argument — see claude-code-doc-comments-mcp.ts's own header for the one
 *  part of §5.2a's intent this surface cannot fully replicate. */
export const DOC_COMMENTS_MCP_MUTATOR_TOOLS: readonly string[] = (
  ['ReplyToComment', 'ResolveComment', 'ReopenComment', 'AddComment', 'MoveComment'] as const
).map(docCommentsMcpToolName);

/** Env var the app sets on the deployed server's spawn config (§1.5): the
 *  ONE trusted project root for this Claude Code session, chosen by the app
 *  itself at session creation (`session-manager.ts`'s own `resolvedCwd`) —
 *  never derived from model-controlled tool-call input. Because of that, this
 *  script has no "is this projectRoot itself legitimate" attack surface the
 *  way a caller-supplied `projectRoot` argument would (§1.5's
 *  `refuseUnknownProjectRoot` gate exists precisely for THAT case, and this
 *  script structurally cannot hit it — see claude-code-doc-comments-mcp.ts's
 *  own header for the full reasoning). A `path` argument from the model is
 *  still untrusted and is containment-checked against this root on every call. */
export const YOUCODED_PROJECT_ROOT_ENV = 'YOUCODED_PROJECT_ROOT';

/** Test-only override for the pending-mutation queue's poll timeout (default
 *  production value: 8000ms, benchmarked — see
 *  claude-code-doc-comments-mcp.ts's own header). Never set by
 *  session-manager.ts's real deploy call. */
export const DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV = 'YOUCODED_DOC_COMMENTS_MCP_POLL_TIMEOUT_MS';
