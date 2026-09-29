// Phase 2 permission model (spec §2.4). Shared: main evaluates, renderer
// displays mode labels and the deny-listed Always-allow warning.
export type PermissionAction = 'allow' | 'ask' | 'deny';

// Session-level mode for NATIVE sessions (distinct from CC's PermissionMode —
// CC's is PTY-scraped; this is real state owned by NativeSessionHost).
export type NativePermissionMode = 'ask' | 'auto-edit' | 'full-auto';

export interface PermissionRule {
  /** Tool name or '*'; also the synthetic subjects 'doom_loop' | 'max_steps' | 'external_directory'. */
  tool: string;
  /** Glob over the SUBJECT (Bash: command string; file tools: relative path). Absent = matches any. */
  pattern?: string;
  action: PermissionAction;
  /** How `pattern` is compared. ABSENT MEANS 'glob' — that default is load-bearing:
   *  every DESTRUCTIVE_DENY_LIST entry and every mode/preset rule omits this field
   *  and must keep globbing. Only remembered rules ever set it.
   *
   *  WHY a field instead of escaping '*' inside the pattern: subjectMatches escapes
   *  '\' as a regex literal, so a backslash escape syntax would break Windows
   *  commands like `del C:\foo\*`. A discriminator sidesteps that entirely. */
  match?: 'exact' | 'glob';
  /** Task 11: the specialist agentType (e.g. 'worker') this rule is scoped to.
   *  Absent means the rule is the ROOT session's own grant — a plain
   *  PermissionRule from before specialists existed, or a preset/deny-list/
   *  mode-baseline entry, none of which are ever specialist-scoped. Rule
   *  IDENTITY is the QUINT (tool, pattern, action, match, specialist)
   *  everywhere a remembered rule is deduped, removed, matched, or displayed —
   *  declared here on the base type (not only on StoredRule below) because the
   *  scope filter that keeps a specialist-keyed grant from leaking to the
   *  root session or a different specialist type (native-session-host.ts's
   *  buildDecide) has to read it off the SAME rule objects decidePermission
   *  consumes, not a separate UI-only shape. */
  specialist?: string;
}

/** A rule read off disk, in the semantics it was WRITTEN with.
 *
 *  WHY: every rule ever persisted came from harness-session's `remember-rule`,
 *  which stored the raw tool subject — an exact command or path that was then
 *  evaluated as a glob. So `rm *.tmp` became a wildcard grant nobody asked for.
 *  Reading a match-less rule as 'exact' restores the promise the user was shown
 *  ("Always allow this exact command") and only ever ALLOWS LESS.
 *
 *  Apply this to REMEMBERED rules only. A deny-list or mode rule has no `match`
 *  on purpose (see the field's doc) and must never be run through here. */
export function normalizeRule<T extends PermissionRule>(rule: T): T {
  return rule.match ? rule : { ...rule, match: 'exact' };
}

/** Rule identity: the QUINT (tool, pattern, action, match, specialist). Two grants
 *  that differ only in `match` are different grants — collapsing them makes Settings
 *  revoke the wrong one. Two grants that differ only in `specialist` are ALSO
 *  different grants — collapsing THOSE would let a specialist's own grant satisfy
 *  (or get revoked by) the root session's, which is exactly the leak Task 11 added
 *  `specialist` to prevent. `grantedAt` is deliberately excluded so re-approving
 *  something does not look like a fresh grant.
 *
 *  Normalizes BOTH sides, so a rule read straight off disk (no `match`) compares
 *  equal to the same rule after a read through PermissionStore (`match: 'exact'`).
 *  Callers therefore never have to remember to normalize first — one default for
 *  an absent `match`, in one place. `specialist` needs no such normalization:
 *  absent already means "root session's own grant" on both sides of any read path. */
export function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  const x = normalizeRule(a);
  const y = normalizeRule(b);
  return x.tool === y.tool && x.pattern === y.pattern && x.action === y.action &&
    x.match === y.match && x.specialist === y.specialist;
}

/** The ONE bucket key in permissions.json that is not a project folder.
 *
 *  Its key contains a SPACE, and nativeStoreSlug (src/main/slug-encoding.ts)
 *  ALWAYS collapses ':', '\\', '/' and spaces to '-'. So no real cwd can ever
 *  slug to this string — the reservation is structural, not a naming
 *  convention someone could collide with by opening a folder called
 *  "all projects". */
export const CROSS_PROJECT_SLUG = 'all projects';

/** True for a remembered rule that must apply in EVERY project, not just the
 *  one it was approved in.
 *
 *  WHY the pattern is the discriminator: for a hire, the Task SUBJECT *is* the
 *  grant width (tools/task.ts). A `user`-scoped file-defined specialist — one
 *  living in a folder the user owns (`~/.youcoded/specialists/`,
 *  `~/.claude/agents/`) — gets `${charter}:file:${id}@${fp}`, with no work dir
 *  in it at all. That shape, and only that shape, belongs in the cross-project
 *  bucket. A PROJECT-scoped helper's subject is `${charter}:${workDir}:file:…`,
 *  where `file:` is NOT immediately after the charter, so it does not match and
 *  stays filed under its own folder — which is the whole point of the
 *  distinction (a repo's own helper must never travel).
 *
 *  Read the pattern, not a separately-threaded flag: the store, the revoke
 *  path and Settings all handle rules that were read back off disk, where a
 *  flag would have to have been persisted and could disagree with the subject
 *  it sits next to. The subject cannot disagree with itself. */
export function isCrossProjectRule(rule: Pick<PermissionRule, 'tool' | 'pattern'>): boolean {
  return rule.tool === 'Task' && /^(read-only|read-write):file:/.test(rule.pattern ?? '');
}

/** A remembered rule as STORED — the engine's PermissionRule plus provenance
 *  the engine never reads. `grantedAt` is absent on every rule written before
 *  the management UI existed; the UI shows no date rather than inventing one. */
export interface StoredRule extends PermissionRule {
  /** ISO-8601. Absent on pre-existing rules. */
  grantedAt?: string;
}

/** One project's slice of permissions.json, as the management UI reads it.
 *  `cwd` is absent for entries written before the UI existed: nativeStoreSlug
 *  collapses ':', '\', '/' AND spaces all to '-', so the original path is NOT
 *  recoverable from the slug. That is why removal keys by slug, not cwd. */
export interface StoredProject {
  slug: string;
  cwd?: string;
  rules: StoredRule[];
}

export interface PermissionDecision {
  action: PermissionAction;
  /** True when the winning rule came from the destructive deny-list — drives
   *  the consequence-gated "Always allow" warning (spec §2.4 precedence ruling). */
  denyListed: boolean;
  /** Optional model-facing refusal detail. When absent, harness-session renders
   *  its generic "blocked by a permission rule" copy — which is what every
   *  existing caller (decidePermission) still gets. Added for specialists
   *  (plan 1a): a child refused a tool needs to know WHY ("not available to this
   *  specialist") or a weak model will just retry the same call until its step
   *  budget runs out. Model-facing text, not user-facing error copy. */
  message?: string;
}

// The destructive deny-list: CONFIGURATION, not a tool-layer guard. Ships in
// every mode baseline (Full-auto included). An explicit remembered user rule
// wins over it (spec review ruling #2) — that's why these are 'ask', not 'deny':
// the user stays sovereign, the model never proceeds silently.
// Each base pattern has a '* …' compound variant because the Task-3 matcher
// anchors patterns ^…$, so a bare 'git push*' won't catch 'cd repo && git push'.
// Over-matching is fail-safe here because the action is only 'ask': an
// unnecessary ask is merely annoying, while a missed destructive command in
// Full-auto is the failure that actually matters.
export const DESTRUCTIVE_DENY_LIST: PermissionRule[] = [
  { tool: 'Bash', pattern: 'rm *', action: 'ask' },
  { tool: 'Bash', pattern: '* rm *', action: 'ask' },
  { tool: 'Bash', pattern: 'rmdir *', action: 'ask' },
  { tool: 'Bash', pattern: '* rmdir *', action: 'ask' },
  { tool: 'Bash', pattern: 'del *', action: 'ask' },
  { tool: 'Bash', pattern: '* del *', action: 'ask' },
  { tool: 'Bash', pattern: 'git push*', action: 'ask' },
  { tool: 'Bash', pattern: '* git push*', action: 'ask' },
  { tool: 'Bash', pattern: 'git reset --hard*', action: 'ask' },
  { tool: 'Bash', pattern: '* git reset --hard*', action: 'ask' },
  { tool: 'Bash', pattern: 'sudo *', action: 'ask' },
  { tool: 'Bash', pattern: '* sudo *', action: 'ask' },
  { tool: 'Bash', pattern: 'format *', action: 'ask' },
  { tool: 'Bash', pattern: '* format *', action: 'ask' },
];

/** Mode baselines (spec §2.4 layer 2). Reads + web are free in EVERY preset and
 *  mode (spec §3.4 "reads + web free"): local reads (Read/Glob/Grep), TodoWrite,
 *  and the web pair (WebFetch/WebSearch) never prompt at the baseline. Higher
 *  layers (deny-list, remembered/denied rules) still override via last-match-wins. */
export function rulesForMode(mode: NativePermissionMode): PermissionRule[] {
  const alwaysAllowed: PermissionRule[] = [
    { tool: 'Read', action: 'allow' },
    { tool: 'Glob', action: 'allow' },
    { tool: 'Grep', action: 'allow' },
    { tool: 'TodoWrite', action: 'allow' },
    { tool: 'WebFetch', action: 'allow' },
    { tool: 'WebSearch', action: 'allow' },
    // Skill is a READ, and a narrower one than Read itself: it opens exactly one
    // file, in a directory the app discovered, chosen from a list the app itself
    // advertised. Returning that text has no side effect — every action a skill
    // INSTRUCTS is performed by some other tool, which is gated on its own terms.
    // Prompting here would add friction with no safety gained, and would train the
    // user to click through prompts that never matter (M3 item 1).
    { tool: 'Skill', action: 'allow' },
    // Task 14: ModelSearch reads public catalog metadata only (no provider
    // keys, no session state) and attaches only alongside Task — same
    // "narrow read, never worth an ask" reasoning as Skill just above.
    { tool: 'ModelSearch', action: 'allow' },
    // SendUserFile (2026-08-25) reads and writes nothing: it names files the
    // user should look at, and the viewer's own read guards apply when they
    // open. Nothing to ask about, in any mode.
    { tool: 'SendUserFile', action: 'allow' },
    // SendUserLink (2026-09-02) is the same shape for URLs: it only names
    // links for the user to click. Opening happens through
    // shell.openExternal's own scheme allowlist AT CLICK TIME — the model
    // never triggers navigation itself. Nothing to ask about, in any mode.
    { tool: 'SendUserLink', action: 'allow' },
    // G-1 (2026-08-28): the Bash companions read a log the session already
    // owns, or stop a command the session itself started — nothing to ask
    // about; asking would train click-through (spec §4.2/4.3 "never asks").
    { tool: 'BashOutput', action: 'allow' },
    { tool: 'KillShell', action: 'allow' },
    // Doc-comments follow-up (product decision, 2026-09-27): "the assistant
    // asks before changing comments ONLY on Word/Excel files, and never asks
    // for plain text/markdown/code comments or for reading comments."
    // ReadFileComments is a pure read (same reasoning as Read/Skill/
    // ModelSearch above) — free in every mode, no target-type exception.
    { tool: 'ReadFileComments', action: 'allow' },
    // The five comment-MUTATION tools default to allow HERE, with NO pattern
    // — matching ANY subject, including a Word/Excel path — because a plain-
    // text/markdown/code comment only ever touches the inert
    // `.youcoded/comments/` sidecar (never the user's real file bytes) and
    // must stay frictionless in every mode, the same "internal app metadata"
    // reasoning SendUserFile above already gets. This pattern-less allow is
    // deliberately the FIRST word on these five tool names, not the last:
    // the 'ask' case below appends narrower, LATER (last-match-wins) rules
    // that override this default specifically when the subject is a Word/
    // Excel path — see that case's own WHY. auto-edit/full-auto add no such
    // override, so a Word/Excel-targeted mutation resolves to 'allow' there
    // too, deliberately matching Edit/Write's own tier in those two modes.
    { tool: 'ReplyToComment', action: 'allow' },
    { tool: 'ResolveComment', action: 'allow' },
    { tool: 'ReopenComment', action: 'allow' },
    { tool: 'AddComment', action: 'allow' },
    { tool: 'MoveComment', action: 'allow' },
  ];
  switch (mode) {
    case 'ask':
      return [{ tool: '*', action: 'ask' }, ...alwaysAllowed,
        // A Word/Excel-targeted comment mutation writes DIRECTLY into that
        // file's own bytes (design doc-comments-build-design.md §3.3/§4.3a) —
        // functionally the same act as an Edit/Write call on that file, which
        // already asks under THIS mode (Edit/Write get no allow rule until
        // auto-edit, below). These ten rules are LAST-MATCH-WINS overrides of
        // the pattern-less allow just above, narrowed to a subject ENDING in
        // .docx/.xlsx: `subjectMatches` (shared/subject-glob.ts) compiles '*'
        // to `[\s\S]*` and matches case-INSENSITIVELY, so this covers a
        // relative or absolute path, a Windows backslash path, and an
        // upper-case extension (BRIEF.DOCX) alike — verified in
        // permission-engine.test.ts. Every OTHER subject (a plain-text
        // sidecar target, or the empty-string subject a plain-text/markdown/
        // code call's `permissionSubject: () => undefined` carries into
        // decidePermission) never matches '*.docx'/'*.xlsx' and keeps the
        // frictionless allow above. A remembered "Always allow" grant for one
        // exact Word/Excel file (rememberedRules — the LAST layer
        // decidePermission consults, review ruling #2) still wins over this
        // ask, exactly like it already does for a remembered Edit grant.
        { tool: 'ReplyToComment', pattern: '*.docx', action: 'ask' },
        { tool: 'ReplyToComment', pattern: '*.xlsx', action: 'ask' },
        { tool: 'ResolveComment', pattern: '*.docx', action: 'ask' },
        { tool: 'ResolveComment', pattern: '*.xlsx', action: 'ask' },
        { tool: 'ReopenComment', pattern: '*.docx', action: 'ask' },
        { tool: 'ReopenComment', pattern: '*.xlsx', action: 'ask' },
        { tool: 'AddComment', pattern: '*.docx', action: 'ask' },
        { tool: 'AddComment', pattern: '*.xlsx', action: 'ask' },
        { tool: 'MoveComment', pattern: '*.docx', action: 'ask' },
        { tool: 'MoveComment', pattern: '*.xlsx', action: 'ask' },
      ];
    case 'auto-edit':
      return [{ tool: '*', action: 'ask' }, ...alwaysAllowed,
        { tool: 'Edit', action: 'allow' }, { tool: 'Write', action: 'allow' },
        // Task (Task 6, spec §5 walk-away autonomy — a PINNED decision, not an
        // accident): delegating to a specialist grants that specialist nothing
        // beyond what THIS mode already grants the parent directly. auto-edit
        // already lets the parent Edit/Write itself with no ask, so spawning a
        // write-capable specialist to do the same work needs no extra ask
        // either. Deliberately absent from `alwaysAllowed` (the 'ask' baseline
        // below): under 'ask' mode, the Task call itself IS the one moment the
        // user consents to the whole delegated envelope — see permissionSubject
        // in tools/task.ts.
        { tool: 'Task', action: 'allow' },
        // D1 (2026-08-26) — the allow above is pattern-less, so before this rule
        // it covered EVERY hire, including a specialist defined by a file some
        // repo shipped. In auto-edit that meant no card rendered at all, which
        // silently bypassed BOTH halves of the plan-1c safety design (the
        // file-scoped subject in tools/task.ts, and the renderer's consent card)
        // — neither can protect anyone if the engine answers before either runs.
        // Last-match-wins (permission-engine.ts) makes this narrower rule beat
        // the broad allow just above for exactly the file-defined case.
        // ':file:' is present in a file-defined hire's subject and in no
        // built-in's; a work dir that somehow contained that literal text would
        // only cause an EXTRA ask, which is the safe direction to be wrong in.
        { tool: 'Task', pattern: '*:file:*', action: 'ask' }];
    case 'full-auto':
      return [{ tool: '*', action: 'allow' }];
  }
}
