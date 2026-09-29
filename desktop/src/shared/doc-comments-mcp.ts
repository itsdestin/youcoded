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
//
// WHY the server id is NOT a fixed constant (adversarial review 2026-09-27,
// finding #2): `shouldAutoApproveDocComment` decides purely from the hook
// payload's `tool_name` STRING. A fixed, public id (this is an open-source
// repo) is guessable by anything that can also get an MCP server config
// loaded for the same project — e.g. a project-level `.mcp.json` checked
// into an untrusted repo the user opens — declaring its OWN server under the
// SAME name with its own tools also named `AddComment`/`ReplyToComment`/etc.
// would be indistinguishable to the auto-approve check from this app's own
// server (this session could not verify Claude Code's exact config-merge
// precedence for a same-named collision without a paid live CLI run — see
// youcoded/docs/cc-dependencies.md's own entry on this). Generating a fresh,
// per-deployment random id (`randomDocCommentsMcpServerId()`,
// claude-code-doc-comments-mcp.ts) and threading THAT id through both the
// deploy config and the permission check closes the "checked into a repo
// ahead of time" version of this risk structurally: nothing can predict a
// value generated fresh after the session already started.
export const DOC_COMMENTS_MCP_SERVER_PREFIX = 'youcoded-doc-comments';

/** Bare tool names — identical to the native harness tool names (design §5's
 *  table: "same names/semantics on both surfaces"). Not exported: nothing
 *  outside this file needs the raw list itself, only the composed-name
 *  helpers below it builds. */
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
 *  `mcp__{server}__{tool}` (youcoded/docs/cc-dependencies.md). `serverId` is
 *  the PER-DEPLOYMENT random id (see this file's own header), never the bare
 *  prefix alone — every caller below takes it as an explicit argument rather
 *  than closing over a module-level constant, so nothing here can silently
 *  drift back to a single, guessable, cross-session value. */
export function docCommentsMcpToolName(serverId: string, bare: DocCommentsBareToolName): string {
  return `mcp__${serverId}__${bare}`;
}

/** The one tool that is always pre-approved via `--allowedTools`, on every
 *  target type — a read never mutates the source file or its comment store
 *  (same posture as the native tool's `permissionSubject: () => undefined`,
 *  doc-comments-tools.ts's own `ReadFileCommentsTool`). */
export function docCommentsMcpReadTool(serverId: string): string {
  return docCommentsMcpToolName(serverId, 'ReadFileComments');
}

/** The five tools whose target CAN be a Word/Excel file's own bytes (§5.2a,
 *  decided option 1) — never allow-listed, since the same tool name also
 *  serves a plain-text/markdown/code target that must stay frictionless.
 *  main.ts's permission-auto-approve wiring uses this set (rebuilt from the
 *  CALLING session's own `serverId`, looked up by session id — never a
 *  cross-session-shared value) to recognize a PermissionRequest for one of
 *  these and decide by the call's OWN `path` argument — see
 *  claude-code-doc-comments-mcp.ts's own header for the one part of §5.2a's
 *  intent this surface cannot fully replicate. */
export function docCommentsMcpMutatorTools(serverId: string): readonly string[] {
  return (['ReplyToComment', 'ResolveComment', 'ReopenComment', 'AddComment', 'MoveComment'] as const)
    .map((bare) => docCommentsMcpToolName(serverId, bare));
}

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

/** Env var carrying this session's own per-deployment secret (adversarial
 *  review 2026-09-27, finding #1): every `PendingMutationRequest` this
 *  script submits must carry the SAME value, so the main-process queue
 *  (pending-mutation-queue.ts) can refuse anything it didn't itself hand out
 *  — a file planted by ANYTHING else with filesystem write access to the
 *  project (another tool call, a malicious skill, a file already sitting in
 *  a cloned/downloaded project before this session ever existed) cannot know
 *  a value generated fresh at THIS session's own spawn time. Compared with
 *  `crypto.timingSafeEqual`, never `===`, on both ends. */
export const YOUCODED_MCP_TOKEN_ENV = 'YOUCODED_MCP_TOKEN';
