// Task — delegate one focused piece of work to a specialist subagent, which
// works independently and reports back once (spec §1/§5, plan 1a). This is
// the MODEL-FACING half of NativeSessionHost.createChild (Task 5): it
// resolves the requested specialist, enforces the weak-model prompt floor,
// checks the per-parent slot + single-writer invariants, and only THEN hands
// the spawn to the host via ToolServices.specialists (native-session-host.ts's
// toolWiring — the same injection pattern WebSearch's SearchService uses).
// The host-side run loop that actually drives the child turn (runSpecialist)
// is Task 7 — this file only ever gets as far as calling services.spawn().
//
// Only ever attached when profile.canDelegate is true AND the session is not
// itself a specialist child (harness-session.ts's syncTaskTool) — delegation
// depth is capped at 1 by construction (two independent gates), never by
// convention.
import { z } from 'zod';
import { defineTool } from './registry';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';
import { resolveP, toPosix } from './guards';
import { BUILTIN_ROSTER, type SpecialistRoster, type SpecialistDefinition } from '../specialists/registry';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS, SPECIALIST_SPAWN_BUDGET_PER_SESSION } from '../specialists/limits';
import {
  resolveDelegatedBinding, resolveRequestedModel, DelegatedModelRefused, type DelegatedTier,
} from '../specialists/delegated-models';
import type { CatalogModel, ModelBinding } from '../../../shared/provider-types';

// Minimal weak-model hardening (plan 1a): a specialist has NO access to the
// parent conversation, so a one-line prompt like "do the thing" leaves it to
// guess the entire brief. This is a floor, not a quality bar — the full pass
// (rubric-checked briefs) is plan 1b.
const MIN_PROMPT_LENGTH = 40;

// Task 12, item 2 (plan 1b, spec §3): reject placeholder prompts — TODO, "task
// 1", unexpanded template markers. This is layered ON TOP of the 40-char floor
// above, not instead of it: a bare "todo"/"tbd"/"fixme" is already caught by
// the floor, but a PADDED marker like "{{TASK_DESCRIPTION_GOES_HERE_PLEASE_FILL}}"
// clears 40 chars while still being nothing but an unexpanded template — an
// observed weak-model failure mode (platform research), not speculation.
// Deliberately NARROW and tested against the WHOLE TRIMMED PROMPT ONLY (never
// per-line) — external review 2026-08-12 flagged the false-positive risk of a
// per-line variant, which would catch a real multi-line brief that happens to
// contain a "TODO:" note among real content. See task-tool.test.ts's pinned
// ~45-char real-sentence boundary test.
const PLACEHOLDER_RE = /^(?:todo|tbd|task ?\d*|fixme|<[^>]*>|\{\{[^}]*\}\}|\.{3}|xxx+)[.!]?$/i;

// Task 6 (spec §5, own-children-only) — verbatim per the plan, and reused
// EVERYWHERE a task_id turns out not to be this parent's own child: a foreign
// task_id and a nonexistent one must read identically, so the wording can
// never be used to probe for another session's child ids.
const REFUSED_NOT_OWN_CHILD = 'Refused: that task_id does not belong to a specialist of this session.';

// Task 6 — the writer-busy / at-capacity refusal copy, unchanged verbatim
// from plan 1a/1b, now shared by BOTH the new-spawn reservation (below) and
// the task_id resume reservation (a resumed child re-takes a slot exactly
// like a new spawn) — one function so the two paths cannot drift apart on
// wording.
function reservationRefusalText(reservation: { reason: 'writer-busy' } | { reason: 'at-capacity'; max: number }): string {
  if (reservation.reason === 'writer-busy') {
    return 'Refused: another specialist with write access is running under this session. '
      + 'Wait for it to finish, or delegate to a read-only specialist (e.g. explorer, researcher, reviewer) instead.';
  }
  // Task 13: reservation.max is the RESOLVED ceiling reserveSpecialist
  // actually enforced (a local session's engine-measured cap can be smaller
  // than the hosted constant) — never a hardcoded constant, per
  // error-message-standards.md ("must be specific and accurate").
  return `Refused: this session is at capacity (max ${reservation.max} concurrent specialists). `
    + 'Wait for one of the running specialists to finish before starting another.';
}

// Task 4 (plan 1c): the schema used to be built ONCE at module load, with the
// `agent` field's enum text baked from the (then-only) built-in roster. The
// roster is now per project folder (SpecialistCatalog) — a module-level
// schema would show every session on the machine the exact same specialist
// list, so this moved inside createTaskTool(), built fresh from THAT call's
// roster every time.
function buildSchema(roster: SpecialistRoster) {
  return z.object({
    // Task 6: these four were unconditionally required through plan 1a/1b —
    // now optional because a task_id call (steer/resume/interrupt an EXISTING
    // specialist) needs none of them; execute() enforces "required unless
    // task_id is set" itself, below, with a typed refusal rather than a bare
    // schema-validation failure.
    description: z.string().optional().describe(
      'A short (3-6 word) label for this delegated task, shown in the launch card (e.g. "Find the auth bug"). '
      + 'Required when starting a new specialist; omit when managing one by task_id.',
    ),
    prompt: z.string().optional().describe(
      'Starting a new specialist: the complete, self-contained brief — it has NO access to this conversation, '
      + 'so include everything it needs: what to do, relevant file paths, and what "done" looks like. '
      + 'Managing one by task_id: the steer message, or its next brief on resume. Omit only when interrupt is true.',
    ),
    agent: z.string().optional().describe(
      `Which specialist to run. One of: ${roster.list().map((s) => s.id).join(', ')}. `
      + 'Required when starting a new specialist; omit when managing one by task_id — the specialist type follows the task_id.',
    ),
    work_dir: z.string().optional().describe(
      'The directory the specialist works in — usually the project root you are working in. '
      + 'Passing a subdirectory narrows what the specialist can read (and, for a read-write specialist, edit). '
      + 'Required when starting a new specialist; omit when managing one by task_id.',
    ),
    // Task 4 (plan 1b) — background execution. Optional so every existing 1a
    // call (which always blocks until the report comes back) keeps working
    // unchanged; only setting this true opts into the detached-run path. Also
    // read on a task_id RESUME (Task 6): same meaning, applied to the resumed
    // run instead of a new one.
    background: z.boolean().optional().describe(
      'Set true only when you have other useful, non-overlapping work to do while the specialist runs; the report is '
      + 'delivered to you when it finishes. If you would only be waiting for it, leave this false and let the report '
      + 'come back as this call\'s result. On a task_id resume, applies to the resumed run.',
    ),
    // Task 14: verbatim per the spec ruling — the only two named tiers, plus an
    // escape hatch for a user-directed specific id. Omitting this (the default
    // for every existing call and every built-in specialist) is unchanged
    // behavior: run on the parent's own model. Not read on a task_id call — a
    // steer/resume/interrupt keeps the child's own model.
    // Item 13 (2026-09-09 transcript audit): the model once sent `"budget}},{"`
    // — a fragment of its own JSON — and the tool only refused it a resolve
    // later, as "not an available model". A model id is letters, digits and
    // a few separators; anything else is a malformed call and is refused at
    // the schema, where the error names the field and the accepted shape.
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/, 'model must be "budget", "frontier", or a model id (letters, digits, . _ : @ / -)').optional().describe(
      'Optional: "budget" or "frontier" to use the models the user designated in Settings, or a specific '
      + 'model id — only name a specific model when the user asked for it. Omit to run the specialist on '
      + "this conversation's model. Not used with task_id — a resumed specialist keeps its own model.",
    ),
    // Task 6 — the task_id management surface. Semantics documented verbatim in
    // the tool description below (TASK_ID_DOCTRINE).
    task_id: z.string().optional().describe(
      'The task_id from an earlier launch, to manage that specialist instead of starting a new one. If it is '
      + 'still RUNNING, "prompt" is delivered as a steer at its next natural pause. If it has FINISHED or was '
      + 'INTERRUPTED, it resumes — its state is rebuilt cold from its own transcript — with "prompt" as its next '
      + 'brief, foreground or background per "background". Combine with interrupt: true to cancel it instead (no '
      + '"prompt" needed). A task_id that is not one of THIS conversation\'s own specialists is refused, whether it '
      + "belongs to a different conversation or never existed at all — you can only manage specialists you yourself started.",
    ),
    interrupt: z.boolean().optional().describe('With task_id: cancel that specialist instead of steering or resuming it.'),
    // 2026-09-09 — replaces the per-turn `<specialists-status>` block. Codex
    // (list_agents) and Hermes (action='list') give the model a list it asks
    // for; none of the harnesses we compared remind it every turn.
    list: z.boolean().optional().describe(
      'Alone, with no other fields: list this conversation\'s specialists and their state (running, finished with report '
      + 'pending, failed, interrupted). Ask once when you need it — never in a loop; you are told when a report arrives.',
    ),
  }).strict(); // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
}

type TaskArgs = z.infer<ReturnType<typeof buildSchema>>;

// This enumeration doubles as the 1a consent copy: it is the text a user sees
// when the envelope ask fires (permissionSubject below), since the pretty
// launch card is plan 1c. Snapshotted once — the built-in roster is static.
// 2026-08-16 (Destin's 1b hands-on, Test 8): each line now NAMES the
// specialist's tools and says outright whether it has a shell. The old copy
// said only "read-only" vs "can edit files", so a parent asked to *run* a
// command (`git log`) reasoned "that's a read → explorer" and hired a helper
// with no Bash at all, which then improvised around the request instead of
// routing an ask. A model can only pick the right helper for "run X" if the
// roster tells it who can run anything.
function charterLabel(s: { charter: string; allowedTools: readonly string[] }): string {
  const hasShell = s.allowedTools.includes('Bash');
  if (s.charter === 'read-write') return hasShell ? 'can edit files and run commands' : 'can edit files';
  return hasShell ? 'read-only, can run commands' : 'read-only';
}
function describeSpecialists(roster: SpecialistRoster): string {
  const specialists = roster.list();
  const lines = specialists
    .map((s) => {
      const hasShell = s.allowedTools.includes('Bash');
      return `- ${s.id} (${charterLabel(s)}; tools: ${s.allowedTools.join(', ')}${hasShell ? '' : ' — no shell'}): ${s.description}`;
    });
  const shellOwners = specialists.filter((s) => s.allowedTools.includes('Bash')).map((s) => s.id);
  const shellRule = shellOwners.length === 1
    ? `Only the ${shellOwners[0]} can run shell commands — a job that needs a command run must go to it, even if the job is otherwise read-only.`
    : shellOwners.length === 0
      ? 'None of your specialists can run shell commands — none of them can be given a job that needs one.'
      : `Only ${shellOwners.join(', ')} can run shell commands — a job that needs a command run must go to one of them.`;
  return `${lines.join('\n')}\n${shellRule}`;
}

// Codex's orchestration-doctrine line: a specialist cannot ask a conversational
// follow-up question (child-ask-router.ts denies AskUserQuestion instantly —
// it routes permission GATES to the parent's card, not interactive questions),
// so the caller must front-load everything into one brief.
// WHY the when/when-not rules (2026-09-09): three days of transcripts showed
// the model hiring a helper for single lookups, then steering it every minute
// ("report now", 72% of all steers) and re-calling Task to pull the report
// instead of waiting. Every other harness we compared (Claude Code, Codex,
// Hermes) spends most of its delegation text on WHEN NOT to delegate; ours
// said nothing about it. The limits are stated up front for the same reason:
// the model used to discover each one only by being refused.
const DOCTRINE =
  'Most work is faster done yourself. Delegate only a self-contained job that also meets one of these: '
  + 'it would fill your context with file contents or search output you only need the conclusion of; '
  + 'it can run while you do something else; or it needs a fresh, unbiased read (a review). '
  + 'Do not delegate a single lookup you could do with one Read, Grep or Glob, a quick edit to a file you have '
  + 'already read, a question that needs the user\'s answer, or the very next step your own work is blocked on.\n'
  + 'Specialists work independently and report back once; give each specialist a complete, self-contained brief — '
  + 'they cannot ask you a follow-up question. Once you have delegated a job, do not also do it yourself, and do not '
  + 'send status requests: the report arrives on its own. When nothing else is left for you to do, tell the user '
  + 'what is still running and end your turn.\n'
  + `Limits: up to ${HOSTED_MAX_CONCURRENT_SPECIALISTS} specialists run at once (fewer on a local engine), only one `
  + 'of them may edit files, specialists cannot start specialists, and each conversation has a budget of '
  + `${SPECIALIST_SPAWN_BUDGET_PER_SESSION} launches. Independent read-only specialists can be started in the same turn.`;

// What a background launch answers with. WHY it says "end your turn": the
// old ack said "Keep working", and the model took that as licence to poll the
// helper and re-run its search itself. The status block at the start of every
// turn is how it knows what is still running — it never needs to ask.
const BACKGROUND_ACK =
  'Their report will be delivered to you when they finish — do not wait, poll, or send status requests, and do not '
  + 'redo the job yourself. Continue with work that does not depend on it; when nothing else is left, tell the user '
  + 'what is still running and end your turn. Task with list: true shows what is still running — once, if you need it.';

// Task 6 — the task_id management surface, documented VERBATIM in the tool
// description (per the plan's own instruction) so a model reads these four
// outcomes as part of learning the tool, not as a refusal it hits by
// surprise later.
const TASK_ID_DOCTRINE =
  'To manage a specialist you already started, pass its task_id instead of agent/work_dir/description:\n'
  + "- Still running: \"prompt\" is delivered as a steer at its next natural pause.\n"
  + '- Finished or interrupted: it resumes — state rebuilt cold from its own transcript — with "prompt" as its '
  + 'next brief, foreground or background per "background".\n'
  + '- Add interrupt: true to cancel it instead (no "prompt" needed).\n'
  + "- A task_id that isn't one of THIS conversation's own specialists is refused the same way whether it "
  + 'belongs to another conversation or never existed — you can only manage specialists you yourself started.';

// Task 4 (plan 1c): `roster` defaults to BUILTIN_ROSTER so every pre-existing
// caller (and every test that constructs this tool with no argument) keeps
// seeing exactly the four built-ins, unchanged. The REAL caller
// (harness-session.ts's syncTaskTool) now passes the session's own per-cwd
// roster (SpecialistCatalog.roster(cwd)) and calls this fresh at the start of
// EVERY turn — never once at module load — because the roster can change
// between turns (a file dropped into a specialists folder) and a stale
// module-level tool would keep offering the OLD list forever.
// `sessionCwd` is the SESSION's folder. D2 fix (2026-08-26, review Major):
// permissionSubject resolved a relative `work_dir` against `process.cwd()` —
// the Electron process's own directory, which has nothing to do with the
// conversation. Two consequences, both bad once a grant is pinned to that
// path: the remembered rule named a folder the user was never in (so the
// grant they were told was saved never fired again), and `work_dir: '.'`
// produced the SAME subject in every project, which let a project-scoped
// grant travel between projects — exactly what D2 exists to prevent.
// createChild already resolves against the parent session's cwd
// (native-session-host.ts), so this makes the two agree.
export function createTaskTool(
  rawRoster: SpecialistRoster = BUILTIN_ROSTER,
  sessionCwd?: string,
): NativeTool<TaskArgs> {
  // D2 fix (2026-08-26, review Major — check-then-use). permissionSubject and
  // execute() each resolved the specialist independently, and `resolve` reads
  // the catalog's LIVE state: `specialists:list` calls catalog.reload(), which
  // the renderer fires while a consent card is on screen. So the definition
  // whose fingerprint the user approved could be a different object from the
  // one that then spawned — the whole "the hash pins what you approved"
  // guarantee is about resolution time, and there were two of those.
  //
  // Resolve once per id and reuse it for the life of THIS tool instance. That
  // is exactly one turn (the Task tool is rebuilt at every turn start), which
  // is already the granularity the catalog's own no-watcher design promises:
  // a definition change takes effect at the next turn, never mid-turn.
  const memo = new Map<string, SpecialistDefinition | undefined>();
  const roster: SpecialistRoster = {
    list: () => rawRoster.list(),
    resolve: (id) => {
      if (!memo.has(id)) memo.set(id, rawRoster.resolve(id));
      return memo.get(id);
    },
  };
  return defineTool<TaskArgs>({
    name: 'Task',
    description:
      'Delegate one focused piece of work to a specialist subagent. The specialist works independently '
      + "and reports back when it's done. Available specialists:\n"
      + describeSpecialists(roster) + '\n\n' + DOCTRINE + '\n\n' + TASK_ID_DOCTRINE,
    // Simplified presentation (small local models): ids + charter only, no
    // per-role descriptions — mirrors skill.ts's shortDescription trim.
    shortDescription:
      'Delegate a focused task to a specialist subagent. Specialists: '
      + roster.list().map((s) => `${s.id} (${charterLabel(s)}${s.allowedTools.includes('Bash') ? '' : ', no shell'})`).join(', '),
    inputSchema: buildSchema(roster),
    // The envelope ask's subject (spec §1a/§5) — CHARTER-SCOPED (Fix 4, review
    // round 1): `${charter}:${work_dir}`, e.g. "read-only:/home/x/proj". Before
    // this the subject was the bare work_dir, so a remembered "Always allow" for
    // a read-only explorer at a path silently pre-approved a future read-write
    // worker at the SAME path too — the charter is the unit of envelope consent
    // (spec §5), so a standing grant must never cross charters. Unknown agent
    // name falls back to the bare work_dir: execute() above already refuses an
    // unknown specialist before ever spawning, so this text is only ever shown
    // on an ask that is about to be declined anyway, never a real standing grant.
    // Task 11 (ROADMAP fold-in): resolve work_dir before it becomes part of
    // the remembered-rule key. Before this, '.', './x', and the absolute form
    // of the SAME directory each minted a DIFFERENT envelope pattern, so
    // approving one left the other two spellings still asking every time.
    //
    // Fix pass (Finding 1): this used to call guards.ts's `canonicalize()`,
    // which — per that function's own doc comment — case-folds the WHOLE path
    // on win32. That was right for the sensitive-path comparison sets it was
    // built for, but wrong here: this string becomes the rule's stored
    // `pattern`, which describe-rule.ts slices straight into what the
    // permissions screen renders, so a real path like "C:/Users/Destin/Proj"
    // was showing up lowercased to the user. Switched to `resolveP` + toPosix
    // — guards.ts's own display-safe pair, documented there as the one to use
    // for "anything a user or model reads back" — which still resolves
    // `.`/`./x`/absolute forms to ONE key (same `path.resolve` guards.ts's
    // canonicalize uses internally) without folding case. Matching an
    // existing grant still works: subject-glob.ts's subjectMatches always
    // matches case-insensitively (the 'i' regex flag), so a rule written
    // under the OLD lowercased pattern still matches a NEW real-cased ask
    // subject computed here — no grant is lost by this change.
    // permissionSubject has no session cwd to resolve a relative work_dir
    // against (the NativeTool contract passes only the raw args), so it
    // resolves against the process's own cwd, same as canonicalize did.
    // Task 6: a task_id management call may omit work_dir entirely (it isn't
    // starting anything new — see the schema's own comment) — undefined here
    // means tool-name-only matching (NativeTool.permissionSubject's own
    // documented contract), never a crash on a path that was never given.
    //
    // Task 4 (plan 1c) — the subject now also carries the specialist's OWN id
    // when it isn't a built-in: `${charter}:${workDir}:file:${id}`, never the
    // bare `${charter}:${workDir}` a built-in still gets. WHY: a grant
    // remembered for the built-in Worker must never auto-hire a helper some
    // repo shipped — the file can say anything, and the provenance line on
    // the consent card only helps if the card is actually shown, which a
    // matching remembered rule skips entirely (decide() answers before any
    // card renders). Built-ins keep the OLD shape so no grant a user already
    // has is lost.
    // D2 (2026-08-26) — the subject is ALSO what an "Always allow" is remembered
    // as, byte-exact (harness-session.ts's rememberedRuleFor). So the shape here
    // is the entire definition of how wide such a grant is; there is no second
    // place that widens or narrows it:
    //   builtin -> `${charter}:${workDir}`                  (unchanged from 1c)
    //   user    -> `${charter}:file:${id}@${fp}`            NO work dir, so one
    //              grant covers every project — what Destin asked for, and safe
    //              because the file lives in a folder only he writes to.
    //   project -> `${charter}:${workDir}:file:${id}@${fp}` work-dir-pinned, so
    //              always-allowing `code-reviewer` in repo X can never pre-approve
    //              a DIFFERENT `code-reviewer.md` that repo Y happens to ship.
    // `@${fp}` is the file's content hash: edit the file to widen its tools and
    // the subject changes, so the standing grant stops matching and the user is
    // asked again. Without it, "always allow" would be a promise about a name,
    // not about the thing that was actually approved.
    permissionSubject: (a) => {
      if (!a.work_dir) return undefined;
      const specialist = a.agent ? roster.resolve(a.agent) : undefined;
      const workDir = toPosix(resolveP(a.work_dir, sessionCwd ?? process.cwd()));
      if (!specialist) return workDir;
      if (specialist.grantScope === 'builtin') return `${specialist.charter}:${workDir}`;
      // Unreachable via the catalog — both file loaders always stamp a
      // fingerprint (definition-files.ts) — so this only catches a definition
      // built by hand in a test or a future code path. It does NOT make the
      // grant un-rememberable (a rule minted from this subject would match it
      // again); what it guarantees is SEPARATION: 'unverified' can never equal
      // a real hash, so a grant approved for a fingerprinted file never covers
      // an unverifiable one, and the reverse. Settings renders such a subject in
      // the same sentence as any other filed grant (describe-rule.ts reads
      // everything after the final '@' as the hash) — it does not call the case
      // out, it just does not leak raw syntax.
      const fp = specialist.fingerprint ?? 'unverified';
      return specialist.grantScope === 'user'
        ? `${specialist.charter}:file:${specialist.id}@${fp}`
        : `${specialist.charter}:${workDir}:file:${specialist.id}@${fp}`;
    },
    moreHint: 'narrow the brief, pick a different specialist, or split the work across more than one Task call',
    async execute(args, ctx: ToolContext): Promise<ToolResultPayload> {
      const services = ctx.services?.specialists;
      if (!services) {
        // A configuration gap (Task attached but its host callbacks were not
        // wired), never a model mistake — say so plainly rather than guessing.
        // Checked FIRST (moved ahead of every args-shaped refusal below, Task
        // 6): both the task_id branch and the new-spawn branch need it, and
        // no existing test pins the OLD relative order against an unknown
        // specialist / trivial prompt.
        return { text: 'Task failed: no specialist services are wired for this session (configuration error).', isError: true };
      }
      const parentId = ctx.sessionId;
      if (args.list) {
        const status = services.listStatus(parentId);
        return { text: status ?? 'No specialists are running or awaiting delivery in this conversation.' };
      }

      // ---- Task 6: task_id management surface — checked BEFORE the spawn
      // path entirely (order per the plan): steer a running child, resume a
      // finished/interrupted one, or interrupt one outright. Never reaches
      // the unknown-specialist / prompt-floor / placeholder / budget checks
      // below, which only make sense for STARTING something new. ----
      if (args.task_id) {
        const taskId = args.task_id;

        // interrupt is checked before steer/resume (order per the plan).
        if (args.interrupt) {
          const result = services.interruptSpecialist(parentId, taskId);
          if (result.status === 'not-yours') return { text: REFUSED_NOT_OWN_CHILD, isError: true };
          if (result.status === 'not-running') {
            return {
              text: `task_id ${taskId} is not currently running — there is nothing to interrupt. `
                + 'Call Task again with the same task_id and no "interrupt" to resume it instead.',
              isError: true,
            };
          }
          return { text: `Interrupted ${result.title}${result.description ? ` — it was: ${result.description}` : ''}.` };
        }

        // Steer and resume both need a prompt (the message, or the next
        // brief) — interrupt above is the only task_id use that doesn't.
        if (!args.prompt?.trim()) {
          return {
            text: 'Steering or resuming a specialist needs "prompt" — the message to deliver, or its next brief. '
              + 'Omit "prompt" only when interrupt is true.',
            isError: true,
          };
        }
        const trimmedPrompt = args.prompt.trim();

        const steerResult = services.steerSpecialist(parentId, taskId, trimmedPrompt);
        if (steerResult.status === 'not-yours') return { text: REFUSED_NOT_OWN_CHILD, isError: true };
        if (steerResult.status === 'ok') {
          return { text: `Steer delivered to ${steerResult.title}.` };
        }

        // steerResult.status === 'not-running' — the child is this parent's
        // own, but has finished or been interrupted: resume it. Its charter
        // comes from the ledger's own recorded agentType (steerResult), NOT
        // from args.agent — a resume never re-reads the model's own claim
        // about which specialist this is, it re-reads the ORIGINAL one.
        const specialist = roster.resolve(steerResult.agentType);
        if (!specialist) {
          return {
            text: `Refused: the specialist type "${steerResult.agentType}" that ${taskId} was running is no longer `
              + 'available — it may have been removed from the roster.',
            isError: true,
          };
        }

        // A resumed child re-takes a reservation exactly like a new spawn —
        // including the writer lock if its charter is read-write (plan's own
        // instruction: "a resumed Worker re-takes the writer lock").
        const reservation = services.reserve(parentId, { writer: specialist.charter === 'read-write' });
        if (!reservation.ok) return { text: reservationRefusalText(reservation), isError: true };

        if (args.background) {
          try {
            const result = await services.resumeSpecialist(parentId, {
              childId: taskId, prompt: trimmedPrompt, background: true,
              parentToolCallId: ctx.toolCallId ?? '', reservation: reservation.token,
            });
            if (result.status === 'not-yours') {
              services.release(reservation.token);
              return { text: REFUSED_NOT_OWN_CHILD, isError: true };
            }
            if (result.status === 'still-running') {
              services.release(reservation.token);
              return { text: `${taskId} started running again before this resume could take effect — nothing to do.`, isError: true };
            }
            // D2 fix (review Critical): the definition changed since consent.
            // Says exactly what happened and names the ONE path that re-asks.
            if (result.status === 'definition-changed') {
              services.release(reservation.token);
              return { text: `The definition file for "${result.agentType}" has changed since this specialist was hired, so resuming would run a version the user never approved. Hire it again with a fresh Task call (no task_id) — that goes through the user's consent card — or continue the work yourself.`, isError: true };
            }
            // result.status === 'ok-background' (the only remaining case,
            // since this call requested background: true) — ownership of the
            // reservation transferred to the detached chain, same as a fresh
            // background spawn; this call site does NOT release it. The
            // `status === 'ok'` guard below is belt-and-suspenders for the
            // type checker (SpecialistResumeOutcome has two 'ok' shapes) —
            // resumeSpecialist itself never returns the foreground shape here.
            if (result.status === 'ok') throw new Error(`resumeSpecialist returned a foreground result for a background request (task_id ${taskId}) — this is a host bug, not a refusal.`);
            return {
              text: `${result.title} (${specialist.id}) is now working in the background (task_id: ${result.childId}). `
                + BACKGROUND_ACK,
            };
          } catch (err: any) {
            services.release(reservation.token);
            return { text: `The ${specialist.displayName} specialist failed to resume in the background: ${err?.message ?? String(err)}`, isError: true };
          }
        }

        try {
          const result = await services.resumeSpecialist(parentId, {
            childId: taskId, prompt: trimmedPrompt, background: false,
            parentToolCallId: ctx.toolCallId ?? '', reservation: reservation.token,
          });
          if (result.status === 'not-yours') return { text: REFUSED_NOT_OWN_CHILD, isError: true };
          if (result.status === 'still-running') {
            return { text: `${taskId} started running again before this resume could take effect — nothing to do.`, isError: true };
          }
          if (result.status === 'definition-changed') {
            return { text: `The definition file for "${result.agentType}" has changed since this specialist was hired, so resuming would run a version the user never approved. Hire it again with a fresh Task call (no task_id) — that goes through the user's consent card — or continue the work yourself.`, isError: true };
          }
          // result.status === 'ok' (the only remaining case, since this call
          // requested background: false) — belt-and-suspenders throw for the
          // type checker, mirroring the background branch above.
          if (result.status === 'ok-background') throw new Error(`resumeSpecialist returned a background result for a foreground request (task_id ${taskId}) — this is a host bug, not a refusal.`);
          return { text: result.report };
        } catch (err: any) {
          return { text: `The ${specialist.displayName} specialist failed to resume: ${err?.message ?? String(err)}`, isError: true };
        } finally {
          services.release(reservation.token);
        }
      }

      // ---- Starting a NEW specialist (unchanged from plan 1a/1b, gated on
      // the four fields task_id calls above deliberately omit). ----
      if (!args.agent || !args.work_dir || !args.description || !args.prompt) {
        return {
          text: 'Starting a new specialist needs "agent", "work_dir", "description", and "prompt". '
            + 'Omit all four and pass "task_id" instead to steer, resume, or interrupt a specialist you already started.',
          isError: true,
        };
      }

      const specialist = roster.resolve(args.agent);
      if (!specialist) {
        const available = roster.list().map((s) => s.id).join(', ');
        return { text: `Unknown specialist "${args.agent}". Available specialists: ${available}.`, isError: true };
      }

      const trimmedPrompt = args.prompt.trim();
      if (trimmedPrompt.length < MIN_PROMPT_LENGTH) {
        return {
          text: `That prompt is too short to be a self-contained brief (needs at least ${MIN_PROMPT_LENGTH} characters). `
            + 'The specialist has no access to this conversation — include what to do, relevant file paths, and what "done" looks like.',
          isError: true,
        };
      }

      if (PLACEHOLDER_RE.test(trimmedPrompt)) {
        return {
          text: 'That prompt looks like an unexpanded placeholder. Write the actual self-contained brief: '
            + 'what to do, relevant paths, what "done" looks like.',
          isError: true,
        };
      }

      // Task 14: resolve what model this child runs on. 'parent' — no
      // args.model AND no specialist.modelPreference, the default for every
      // existing call and every built-in specialist — needs nothing beyond
      // ctx.binding, so a session that never touches this feature never
      // needs ToolServices.models wired at all. Only a tier or a specific id
      // reaches resolveDelegatedBinding.
      const requestedModel = resolveRequestedModel(args.model, specialist.modelPreference);
      let resolvedBinding: ModelBinding | undefined;
      let fallbackNote = '';
      // Hoisted out of the `if` below (Task 5, plan 1c) so the model-record
      // computation after it can read `resolution?.fellBack` — undefined
      // (never entered the block) reads the same as "no fallback happened",
      // which is correct: the 'parent' path never falls back to anything.
      let resolution: { binding: ModelBinding; fellBack: boolean; reason?: string } | undefined;
      if (requestedModel !== 'parent') {
        if (!ctx.binding) {
          return { text: 'Task failed: no model binding is wired for this session (configuration error).', isError: true };
        }
        const models = ctx.services?.models;
        if (!models) {
          return { text: 'Task failed: no model catalog is wired for this session (configuration error).', isError: true };
        }
        // Catalog is fetched ONLY for a specific-id request — a tier lookup
        // never needs it (DelegatedModels.get is the whole answer), so the
        // common tier path pays no catalog-fetch cost.
        const catalog: CatalogModel[] | null = typeof requestedModel === 'object'
          ? (await models.catalog()) ?? null
          : null;
        try {
          resolution = resolveDelegatedBinding({
            requested: requestedModel, parent: ctx.binding, designated: models.designated, catalog,
          });
        } catch (err) {
          // A user-directed specific model id that couldn't be confirmed —
          // never silently substituted (spec ruling). Rethrow anything else:
          // an unexpected throw here is a bug, not a refusal to render.
          if (err instanceof DelegatedModelRefused) return { text: err.message, isError: true };
          throw err;
        }
        resolvedBinding = resolution.binding;
        if (resolution.fellBack) {
          // requestedModel is a DelegatedTier here — the { modelId } branch
          // above either resolves or throws, it never falls back.
          //
          // Final-review fix (Finding 6): this used to say "is set in
          // Settings" — this release ships no Settings UI for designating a
          // budget/frontier model (plan 1c, not yet written), so it pointed
          // the model AND the user at a control neither can find. Matches
          // resolveDelegatedBinding's own reason string (delegated-models.ts)
          // — state the fact, not a place to fix it that doesn't exist yet.
          fallbackNote = `\n\n(No ${requestedModel as DelegatedTier} model is designated — using this conversation's model.)`;
        }
      }

      // Task 5 (plan 1c) — the model actually used, recorded onto the ledger
      // row/run view alongside the delegation itself. `label` is the RAW
      // model id, deliberately not a pretty display name: it is the only
      // honest label available at this point in the pipeline — Settings
      // resolves pretty names from the live catalog later, and inventing one
      // here would be a name this run was never actually confirmed to be
      // running under. `modelLabel` is undefined only when no binding is
      // wired at all (a bare test/one-off ToolContext) — the real driver
      // (harness-session.ts) always sets ctx.binding, so a production
      // delegation always gets a model on its record.
      const modelLabel = resolvedBinding?.modelId ?? ctx.binding?.modelId;
      const model = modelLabel
        ? {
            label: modelLabel,
            via: requestedModel === 'parent' ? 'parent' as const : typeof requestedModel === 'object' ? 'named' as const : requestedModel,
            fallback: !!resolution?.fellBack,
          }
        : undefined;

      // Per-conversation spawn budget (Task 12, item 3): a LIFETIME cap,
      // distinct from the concurrency slot below — checked BEFORE reserving a
      // slot so a budget refusal never needs to release one. A runaway-loop
      // backstop for a model that keeps delegating without end, not a normal
      // capacity limit; the user's fix is a fresh conversation, not "wait".
      if (!services.trySpendSpawnBudget(parentId)) {
        return {
          text: `Refused: this conversation has reached its specialist budget (${SPECIALIST_SPAWN_BUDGET_PER_SESSION}). `
            + 'This is a runaway guard — the user can start a fresh conversation to continue delegating.',
          isError: true,
        };
      }

      // Task 1 (plan 1b): ONE synchronous reserve-or-refuse call, folding the
      // single-writer check and the slot check into the same step (host-side:
      // reserveSpecialist). 1a's split — check isWriterBusy() here, then set
      // the lock after an await deep inside spawnSpecialist — was safe only
      // under serial tool execution; two Task calls issued in one parallel
      // tool-call step could both pass the check before either set the lock.
      // The refusal copy below is unchanged from 1a (verbatim, per
      // error-message-standards.md) — only WHEN it fires moved.
      const reservation = services.reserve(parentId, { writer: specialist.charter === 'read-write' });
      if (!reservation.ok) return { text: reservationRefusalText(reservation), isError: true };

      // Task 4 (plan 1b) — background: the reservation's release ownership
      // moves off THIS call site the moment spawnBackground actually returns:
      // the detached delivery chain (native-session-host.ts's
      // spawnSpecialistBackground) releases it once the run settles, however
      // long that takes. Its OWN try/catch, separate from the foreground path
      // below, because the two paths must NOT share one `finally` — a shared
      // finally would release on the happy path too, undoing the ownership
      // transfer the whole background design depends on. Only a THROWN launch
      // (the promise rejects — the child never came into existence, or its
      // ledger row never got recorded) means ownership never transferred
      // anywhere, so this catch is the one place background still releases.
      if (args.background) {
        try {
          const { childId, title } = await services.spawnBackground(parentId, {
            specialist,
            prompt: args.prompt,
            workDir: args.work_dir,
            parentToolCallId: ctx.toolCallId ?? '',
            description: args.description,
            token: reservation.token,
            ...(model ? { model } : {}),
          });
          return {
            text: `${title} (${args.agent}) is now working in the background (task_id: ${childId}). ${BACKGROUND_ACK}`,
          };
        } catch (err: any) {
          services.release(reservation.token);
          // Specific and accurate (error-message-standards.md): the real
          // thrown message, never a guessed cause — same relay discipline as
          // the foreground catch below.
          return { text: `The ${specialist.displayName} specialist failed to start in the background: ${err?.message ?? String(err)}`, isError: true };
        }
      }

      try {
        const { report } = await services.spawn(parentId, {
          specialist,
          prompt: args.prompt,
          workDir: args.work_dir,
          parentToolCallId: ctx.toolCallId ?? '',
          description: args.description,
          token: reservation.token,
          ...(resolvedBinding ? { binding: resolvedBinding } : {}),
          ...(model ? { model } : {}),
        });
        // Task 14: the one honest line a tier fallback earns — appended to the
        // report, never folded into it, so the child's own words stay intact.
        return { text: fallbackNote ? `${report}${fallbackNote}` : report };
      } catch (err: any) {
        // Every failure path must resolve a tool result — never a dangling
        // call. err.message is expected to already name the child id when one
        // was minted (native-session-host.ts's spawnSpecialist crafts it that
        // way), so this stays a plain relay rather than a second guess at cause.
        return { text: `The ${specialist.displayName} specialist failed: ${err?.message ?? String(err)}`, isError: true };
      } finally {
        // Sole owner of the release, whether spawn succeeded, threw, or never
        // ran (this finally covers both): the tool reserves, spawnSpecialist
        // only BINDS the reservation to the real childId, this releases it.
        services.release(reservation.token);
      }
    },
  });
}
