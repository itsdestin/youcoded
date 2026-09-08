// Task 6 — the Task tool's own gating: unknown specialist / trivial prompt /
// at-capacity / writer-busy typed refusals. Drives execute() directly against
// a fake ToolContext, mirroring harness-tools-core.test.ts's makeCtx pattern —
// the actual spawn (Task 7's runSpecialist) is stubbed per-test via the fake
// ToolServices.specialists.spawn, since none of these tests are meant to
// reach it (each refuses before ever calling spawn).
//
// Task 1 (plan 1b): the fake reserve()/release() below stand in for the host's
// real reserveSpecialist()/releaseReservation() (native-session-host.ts) — the
// pair that folds the slot AND writer-busy checks into one synchronous
// reserve-or-refuse step. These fakes intentionally do NOT re-implement that
// atomicity (there is nothing to race against in a single synchronous test
// call); they only need to hand execute() the same shaped answers the real
// host would, so task.ts's reason-mapping and release-in-finally logic is what
// gets exercised.
import { describe, it, expect, vi } from 'vitest';
import { createTaskTool } from '../src/main/harness/tools/task';
import type { ToolContext } from '../src/main/harness/tools/types';
import { SPECIALIST_SPAWN_BUDGET_PER_SESSION, HOSTED_MAX_CONCURRENT_SPECIALISTS } from '../src/main/harness/specialists/limits';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { NativeHome } from '../src/main/native-home';
import type { CatalogModel, ModelBinding } from '../src/shared/provider-types';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
// Task 6 — the "belongs to a DIFFERENT parent" refusal is only a REAL test
// against the real host: a fake that always answers 'not-yours' would prove
// nothing about own-children-only actually holding. NativeSessionHost/
// SessionStore drive that one test; every other Task 6 test below stays on
// fakes, same as the rest of this file.
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { SessionStore } from '../src/main/harness/session-store';
import { resolveSpecialist as resolveRealSpecialist, type SpecialistDefinition, type SpecialistRoster } from '../src/main/harness/specialists/registry';
// Task 4 (plan 1c) — the permission-subject test below drives the REAL
// matcher (never a string comparison stand-in for it), so a passing test
// actually proves a remembered grant does/doesn't apply, not just that the
// two subject strings look different to a human reader.
import { ruleMatches } from '../src/shared/subject-glob';
import type { PermissionRule } from '../src/shared/permission-types';

// Windows resolves a POSIX-absolute fixture path onto the CURRENT DRIVE
// (`/proj` -> `D:\proj`), which `toPosix` then renders as `D:/proj`. Hardcoding
// '/proj' in an expectation therefore asserts POSIX, not the tool's contract —
// that was 7 of the 19 tests red on the Windows CI leg, whose redness had been
// written off as "pre-existing". Resolve the fixture exactly the way
// permissionSubject does (`toPosix(resolveP(work_dir, sessionCwd ?? cwd))`) so
// the assertion states the contract on both platforms and is unchanged on POSIX.
const subjectDir = (workDir: string, sessionCwd?: string): string =>
  path.resolve(sessionCwd ?? process.cwd(), workDir).replace(/\\/g, '/');


interface RunOpts {
  slotFree?: boolean;
  writerBusy?: boolean;
  spawn?: ReturnType<typeof vi.fn>;
  release?: ReturnType<typeof vi.fn>;
  // Task 12, item 3: the per-conversation spawn budget is a SEPARATE gate from
  // the concurrency slot above (reserve) — default true (budget available)
  // so every existing test in this file, which never cares about the budget,
  // keeps passing unmodified.
  budgetOk?: boolean;
  // Task 14 — both undefined by default so every pre-Task-14 test in this
  // file (which never touches model resolution: no args.model, and every
  // built-in specialist's modelPreference is unset) keeps compiling and
  // passing with the exact same behavior as before this task: task.ts only
  // reaches for ctx.binding / ctx.services.models when a tier or specific id
  // was actually requested.
  binding?: ModelBinding;
  models?: { designated: DelegatedModels; catalog: () => Promise<CatalogModel[] | null> };
  // Task 4 (plan 1c) — undefined means "use BUILTIN_ROSTER" (createTaskTool's
  // own default), so every pre-Task-4 test in this file keeps testing the
  // built-in roster unmodified; only the new per-cwd-roster tests below pass
  // a fake one.
  roster?: SpecialistRoster;
}

function runTaskTool(args: Record<string, unknown>, opts: RunOpts = {}) {
  const tool = createTaskTool(opts.roster);
  const spawn = opts.spawn ?? vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
  const release = opts.release ?? vi.fn();
  const ctx: ToolContext = {
    sessionId: 'parent-1',
    cwd: '/work',
    signal: new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
    ...(opts.binding ? { binding: opts.binding } : {}),
    services: {
      specialists: {
        reserve: (parentId: string, reserveOpts: { writer: boolean }) => {
          if (reserveOpts.writer && opts.writerBusy) return { ok: false, reason: 'writer-busy' } as const;
          // Task 13: the real reserveSpecialist() now carries the RESOLVED
          // ceiling on an at-capacity refusal (native-session-host.ts) —
          // this fake mirrors that shape so task.ts's copy-interpolation
          // (`reservation.max`) is what actually gets exercised here.
          if (opts.slotFree === false) return { ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS } as const;
          return { ok: true, token: { parentId, writer: reserveOpts.writer } } as const;
        },
        release,
        trySpendSpawnBudget: () => opts.budgetOk !== false,
        spawn,
      },
      ...(opts.models ? { models: opts.models } : {}),
    },
  };
  return tool.execute(
    { description: 'test task', prompt: 'a'.repeat(50), work_dir: '.', ...args } as any,
    ctx,
  );
}

describe('Task tool — typed refusals (plan 1a)', () => {
  it('refuses an unknown specialist with the available list', async () => {
    const r = await runTaskTool({ agent: 'wizard' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown specialist/i);
    expect(r.text).toMatch(/explorer/);   // names what IS available
  });

  it('refuses a trivial or placeholder prompt with a typed error', async () => {
    const r = await runTaskTool({ agent: 'explorer', prompt: 'do the thing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/self-contained brief/i);   // minimal weak-model hardening; full pass is plan 1b
  });

  // Task 12, item 2 — placeholder prompt rejection (spec §3). The regex only
  // matches the WHOLE trimmed prompt, so a bare "todo"/"tbd"/"fixme" is already
  // caught by the 40-char floor above — these cases specifically pin the ones
  // the floor MISSES: longer placeholder-shaped junk that clears 40 chars
  // while still being nothing but an unexpanded marker (never real content
  // padded around a real marker — that would legitimately not match, by design).
  describe('placeholder prompt rejection (Task 12, item 2)', () => {
    const PLACEHOLDER_PROMPTS = [
      '<placeholder text goes right here please>',      // <[^>]*>
      '{{TASK_DESCRIPTION_GOES_HERE_PLEASE_FILL}}',      // the exact padded example from the brief
      'x'.repeat(45),                                    // xxx+
      `task ${'1'.repeat(40)}`,                           // task ?\d*
    ];
    for (const prompt of PLACEHOLDER_PROMPTS) {
      it(`rejects ${JSON.stringify(prompt)}`, async () => {
        expect(prompt.length).toBeGreaterThanOrEqual(40);   // sanity: actually clears the floor
        const r = await runTaskTool({ agent: 'explorer', prompt });
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
          'That prompt looks like an unexpanded placeholder. Write the actual self-contained brief: '
          + 'what to do, relevant paths, what "done" looks like.',
        );
      });
    }

    // The pinned false-positive boundary (external review 2026-08-12): a real,
    // self-contained ~45-char sentence must NOT be caught by the narrow regex.
    it('a real ~45-char sentence is NOT rejected as a placeholder', async () => {
      const realPrompt = 'Find every call site of parseConfig() in src/.';   // 46 chars
      expect(realPrompt.length).toBeGreaterThanOrEqual(45);
      const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
      const r = await runTaskTool({ agent: 'explorer', prompt: realPrompt }, { spawn });
      expect(r.isError).toBeFalsy();
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  // Task 12, item 3 — per-conversation spawn budget: a runaway-loop backstop
  // distinct from the concurrency slot (HOSTED_MAX_CONCURRENT_SPECIALISTS) —
  // this one is a LIFETIME cap per parent conversation, never released.
  it('refuses once the per-conversation spawn budget is exhausted, naming the budget', async () => {
    const r = await runTaskTool({ agent: 'explorer' }, { budgetOk: false });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      `Refused: this conversation has reached its specialist budget (${SPECIALIST_SPAWN_BUDGET_PER_SESSION}). `
      + 'This is a runaway guard — the user can start a fresh conversation to continue delegating.',
    );
  });

  it('spawns normally when the budget still has room', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool({ agent: 'explorer' }, { budgetOk: true, spawn });
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('returns a typed at-capacity result when this parent has no slot free', async () => {
    const r = await runTaskTool({ agent: 'explorer' }, { slotFree: false });
    expect(r.isError).toBe(true);
    // Relaxed to not require the paren to close right after the digits — the
    // copy fix moved "concurrent specialists" inside the parenthetical
    // ("at capacity (max N concurrent specialists)"), and this regex should
    // survive that phrasing rather than pin the exact punctuation.
    expect(r.text).toMatch(/at capacity \(max \d+/i);
    expect(r.text).toMatch(/wait/i);      // tells the model what it CAN do
  });

  it('returns a typed writer-busy result for a second concurrent write-capable specialist under the same parent', async () => {
    const r = await runTaskTool({ agent: 'worker' }, { writerBusy: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/another specialist with write access is running/i);
  });

  it('a read-only specialist is unaffected by writer-busy', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool({ agent: 'explorer' }, { writerBusy: true, spawn });
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('happy path: resolves, reserves a slot, spawns, releases the reservation, and returns the report', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'the report' }));
    const r = await runTaskTool({ agent: 'worker', prompt: 'a'.repeat(60), work_dir: 'src' }, { spawn });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('the report');
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      workDir: 'src',
      specialist: expect.objectContaining({ id: 'worker' }),
      token: expect.objectContaining({ parentId: 'parent-1', writer: true }),
    }));
  });

  it('a thrown spawn error resolves an isError result naming what happened — never a dangling call', async () => {
    const spawn = vi.fn(async () => { throw new Error('specialist child-9 was created but Task 7 is not implemented yet'); });
    const r = await runTaskTool({ agent: 'explorer' }, { spawn });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/child-9/);
  });

  // ---- Task 6 review fix 4: the consent key is CHARTER-SCOPED, not a bare
  // work_dir. Before this fix `permissionSubject` returned only `a.work_dir`,
  // so a remembered "Always allow" for a read-only explorer at a path silently
  // pre-approved a future read-write worker at the SAME path — the charter is
  // the unit of envelope consent (spec §5). ----
  describe('permissionSubject — charter-scoped consent key (Fix 4)', () => {
    it('prefixes the subject with the resolved specialist\'s charter', () => {
      const tool = createTaskTool();
      // explorer is read-only (specialists/builtins.ts); worker is read-write.
      expect(tool.permissionSubject({ agent: 'explorer', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe(`read-only:${subjectDir('/proj')}`);
      expect(tool.permissionSubject({ agent: 'worker', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe(`read-write:${subjectDir('/proj')}`);
    });

    it('falls back to the bare work_dir for an unresolvable agent name', () => {
      // execute() above already refuses an unknown specialist before ever
      // spawning, so this text is only ever shown on an ask that's about to be
      // declined anyway — never a real standing grant.
      const tool = createTaskTool();
      expect(tool.permissionSubject({ agent: 'wizard', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe(subjectDir('/proj'));
    });

    // Task 11 (ROADMAP fold-in): '.', './x', and the absolute form of the SAME
    // directory used to mint THREE different remembered-rule keys — approving
    // one left the other two spellings still asking every time. permissionSubject
    // has no session cwd to resolve a relative work_dir against (the NativeTool
    // contract passes only the raw args), so it normalizes against the process's
    // own cwd — the same base a bare path.resolve(p) would use.
    it('canonicalizes work_dir so "." and process.cwd() mint the SAME consent key', () => {
      const tool = createTaskTool();
      expect(tool.permissionSubject({ agent: 'wizard', work_dir: '.', description: 'd', prompt: 'p' } as any))
        .toBe(tool.permissionSubject({ agent: 'wizard', work_dir: process.cwd(), description: 'd', prompt: 'p' } as any));
    });

    it('canonicalizes work_dir for a resolved-agent (charter-prefixed) subject too', () => {
      const tool = createTaskTool();
      expect(tool.permissionSubject({ agent: 'explorer', work_dir: '.', description: 'd', prompt: 'p' } as any))
        .toBe(tool.permissionSubject({ agent: 'explorer', work_dir: process.cwd(), description: 'd', prompt: 'p' } as any));
    });

    // Fix pass, Finding 1: the consent key doubles as DISPLAY TEXT — describe-
    // rule.ts slices this exact string into what the permissions screen
    // renders. The old implementation reused guards.ts's `canonicalize()`,
    // which case-folds the WHOLE path on win32 (right for the sensitive-path
    // comparison sets it was built for, wrong for anything a user reads back
    // — see that function's own doc comment). Forced via a platform stub
    // since canonicalize's lowercasing branch only engages when
    // `process.platform === 'win32'`, which this test suite normally isn't.
    it('preserves the real casing of work_dir even on win32 (Fix 1 — the key doubles as display text)', () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const tool = createTaskTool();
        const subject = tool.permissionSubject({ agent: 'wizard', work_dir: '/Proj/MixedCase', description: 'd', prompt: 'p' } as any);
        expect(subject).toContain('MixedCase');
        expect(subject).not.toBe(subject.toLowerCase());
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    });
  });

  // ---- Task 4: background: true dispatches through spawnBackground, not
  // spawn, and the reservation's release ownership moves off this call site
  // (the detached delivery chain releases it once the run settles) — the ONE
  // exception is a THROWN launch, where ownership never transferred anywhere.
  describe('background: true (Task 4)', () => {
    it('calls spawnBackground (not spawn) and returns the launch ack without releasing the reservation', async () => {
      const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
      const spawnBackground = vi.fn(async () => ({ childId: 'child-9', title: 'Rusty the Explorer' }));
      const release = vi.fn();
      const tool = createTaskTool();
      const token = { parentId: 'parent-1', writer: false };
      const ctx: ToolContext = {
        sessionId: 'parent-1', cwd: '/work', signal: new AbortController().signal,
        readRegistry: new Map(), todos: [],
        services: { specialists: { reserve: () => ({ ok: true, token }), release, spawn, spawnBackground, trySpendSpawnBudget: () => true } },
      };
      const r = await tool.execute(
        { description: 'find the bug', prompt: 'a'.repeat(60), agent: 'explorer', work_dir: '.', background: true } as any,
        ctx,
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnBackground).toHaveBeenCalledWith('parent-1', expect.objectContaining({
        description: 'find the bug', workDir: '.', token,
        specialist: expect.objectContaining({ id: 'explorer' }),
      }));
      expect(r.isError).toBeFalsy();
      expect(r.text).toMatch(/working in the background/);
      expect(r.text).toMatch(/task_id: child-9/);
      // Ownership transferred: this call site does NOT release on the
      // successful-launch path — the detached chain does, once it settles.
      expect(release).not.toHaveBeenCalled();
    });

    it('a thrown background launch still releases the reservation — ownership never transferred', async () => {
      const spawnBackground = vi.fn(async () => { throw new Error('createChild blew up'); });
      const release = vi.fn();
      const tool = createTaskTool();
      const token = { parentId: 'parent-1', writer: false };
      const ctx: ToolContext = {
        sessionId: 'parent-1', cwd: '/work', signal: new AbortController().signal,
        readRegistry: new Map(), todos: [],
        services: { specialists: { reserve: () => ({ ok: true, token }), release, spawn: vi.fn(), spawnBackground, trySpendSpawnBudget: () => true } },
      };
      const r = await tool.execute(
        { description: 'x', prompt: 'a'.repeat(60), agent: 'explorer', work_dir: '.', background: true } as any,
        ctx,
      );
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/createChild blew up/); // the real thrown reason, never a guess
      expect(release).toHaveBeenCalledWith(token);
    });
  });

  it('releases the reservation even when spawn throws', async () => {
    const release = vi.fn();
    const tool = createTaskTool();
    const token = { parentId: 'parent-1', writer: false };
    const ctx: ToolContext = {
      sessionId: 'parent-1',
      cwd: '/work',
      signal: new AbortController().signal,
      readRegistry: new Map(),
      todos: [],
      services: {
        specialists: {
          reserve: () => ({ ok: true, token }),
          release,
          trySpendSpawnBudget: () => true,
          spawn: async () => { throw new Error('boom'); },
        },
      },
    };
    await tool.execute({ description: 'x', prompt: 'a'.repeat(50), agent: 'explorer', work_dir: '.' } as any, ctx);
    expect(release).toHaveBeenCalledWith(token);
  });
});

// ---------------------------------------------------------------------------
// Task 14 — the `model` input's resolution. Every test in this block sets
// opts.binding + opts.models explicitly; every test ABOVE this block
// deliberately does not, and stays green unmodified, because 'parent' (the
// default when no args.model and no specialist.modelPreference) never
// touches either.
// ---------------------------------------------------------------------------
// 2026-08-16 (Destin's 1b hands-on, Test 8): the parent model hired the
// read-only explorer to run `git log` because the roster said only
// "read-only" vs "can edit files" — nothing told it the explorer has NO
// SHELL. The description a model reads must name each specialist's tools,
// and say plainly which one can run commands.
describe('Task tool — roster names each specialist\'s tools (2026-08-16)', () => {
  it('lists every built-in specialist\'s allowedTools and singles out the shell', () => {
    const tool = createTaskTool();
    const desc = tool.description;
    // Each roster line carries the tool list verbatim.
    expect(desc).toContain('explorer (read-only; tools: Read, Glob, Grep, WebFetch, WebSearch — no shell)');
    expect(desc).toContain('researcher (read-only; tools: Read, Glob, Grep, WebFetch, WebSearch — no shell)');
    expect(desc).toContain('reviewer (read-only; tools: Read, Glob, Grep — no shell)');
    expect(desc).toContain('worker (can edit files and run commands; tools: Read, Write, Edit, Bash, Glob, Grep)');
    // And the one-line rule a model needs when the job is "run X".
    expect(desc).toContain('Only the worker can run shell commands');
    // The trimmed presentation for small models keeps the same fact in fewer words.
    expect(tool.shortDescription).toContain('worker (can edit files and run commands)');
    expect(tool.shortDescription).toContain('explorer (read-only, no shell)');
  });
});

// ---------------------------------------------------------------------------
// Task 4 (plan 1c) — createTaskTool(roster) is now built from the CALLER's
// roster, never a module-level snapshot of the built-ins: the roster is
// per-project-folder (SpecialistCatalog, Task 3), so a module-level enum
// would show every session on the machine the same specialist list. Every
// test above this block passes createTaskTool() with no argument and keeps
// exercising BUILTIN_ROSTER unmodified (the default) — these are the only
// tests that inject a different one.
// ---------------------------------------------------------------------------
describe('Task tool — per-cwd roster (Task 4, plan 1c)', () => {
  const DOCS_WRITER: SpecialistDefinition = {
    id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes and edits project docs.',
    systemPrompt: 'Write docs.', allowedTools: ['Read', 'Write'], charter: 'read-write',
    reportBudgetTokens: 500, source: 'personal',
    grantScope: 'user', fingerprint: 'aaaaaaaaaaaa',
  };
  const FAKE_ROSTER: SpecialistRoster = {
    list: () => [DOCS_WRITER],
    resolve: (id) => (id === 'docs-writer' ? DOCS_WRITER : undefined),
  };

  it('createTaskTool(roster) enumerates THAT roster in the description, the schema enum text, and shortDescription', () => {
    const tool = createTaskTool(FAKE_ROSTER);
    expect(tool.description).toContain('docs-writer');
    expect(tool.description).toContain('Writes and edits project docs.');
    // Never the built-in roster this fake roster doesn't include — proves
    // this really came FROM the injected roster, not BUILTIN_ROSTER leaking
    // through a stale default somewhere.
    expect(tool.description).not.toContain('explorer');
    // The schema's own `agent` field description is what the model actually
    // reads to pick a value — built inside createTaskTool (buildSchema),
    // never at module load, so it enumerates THIS roster's ids too.
    const agentFieldDescription = (tool.inputSchema as any).shape.agent.description as string;
    expect(agentFieldDescription).toContain('docs-writer');
    expect(agentFieldDescription).not.toContain('explorer');
    expect(tool.shortDescription).toContain('docs-writer');
    expect(tool.shortDescription).not.toContain('explorer');
  });

  it('permissionSubject uses the roster to find the charter', () => {
    const tool = createTaskTool(FAKE_ROSTER);
    const subject = tool.permissionSubject!({ agent: 'docs-writer', work_dir: '/proj' } as any);
    // docs-writer's charter (read-write, from its allowedTools) drives the
    // subject prefix — this fake roster is the ONLY place that charter comes
    // from, since 'docs-writer' isn't a built-in.
    // D2: a PERSONAL-folder specialist is 'user'-scoped, so the work dir is
    // deliberately absent — that is what makes one grant cover every project.
    expect(subject).toBe('read-write:file:docs-writer@aaaaaaaaaaaa');
  });

  // The two-mechanism reasoning this pins (global-constraints.md, "Hire
  // grants — do not simplify this into one mechanism"): permissionSubject is
  // half (a) — it stops an OLD remembered grant (minted before this file ever
  // existed) from silently covering a specialist a repository just shipped.
  // Half (b) (the renderer suppressing Always-allow on a non-builtin hire) is
  // a DIFFERENT file's job (Task 10) — this test only proves half (a) by
  // driving the real decision-path matcher, never a string comparison.
  // eslint-disable-next-line no-template-curly-in-string -- the title quotes the permission-subject FORMAT, not an interpolation.
  it('permissionSubject: a built-in hire is `${charter}:${workDir}` (unchanged — old grants still match); a file-defined hire is `${charter}:${workDir}:file:${id}` (a remembered read-write grant for the Worker does NOT cover it)', () => {
    const BUILTIN_WORKER = resolveRealSpecialist('worker')!; // source: 'builtin', charter: 'read-write'
    const FILE_WORKER: SpecialistDefinition = {
      id: 'repo-worker', displayName: 'Repo Worker', description: 'A worker a repo shipped.',
      systemPrompt: 'Do repo work.', allowedTools: ['Read', 'Write', 'Bash'], charter: 'read-write',
      reportBudgetTokens: 2000, source: 'claude-code',
      grantScope: 'project', fingerprint: 'bbbbbbbbbbbb',
    };
    const MIXED_ROSTER: SpecialistRoster = {
      list: () => [BUILTIN_WORKER, FILE_WORKER],
      resolve: (id) => (id === 'worker' ? BUILTIN_WORKER : id === 'repo-worker' ? FILE_WORKER : undefined),
    };
    const tool = createTaskTool(MIXED_ROSTER);
    const builtinSubject = tool.permissionSubject!({ agent: 'worker', work_dir: '/proj' } as any);
    const fileSubject = tool.permissionSubject!({ agent: 'repo-worker', work_dir: '/proj' } as any);
    expect(builtinSubject).toBe(`read-write:${subjectDir('/proj')}`);                    // unchanged shape — old grants still match
    expect(fileSubject).toBe(`read-write:${subjectDir('/proj')}:file:repo-worker@bbbbbbbbbbbb`); // file's own id AND its contents

    // A user's PRE-EXISTING remembered grant for the built-in Worker at this
    // path (the exact shape harness-session.ts's remember-rule persists).
    const workerGrant: PermissionRule = { tool: 'Task', pattern: `read-write:${subjectDir('/proj')}`, action: 'allow', match: 'exact' };
    expect(ruleMatches(workerGrant, builtinSubject!)).toBe(true);   // still covers the built-in it was granted for
    expect(ruleMatches(workerGrant, fileSubject!)).toBe(false);     // must NOT auto-approve a repo-shipped helper
  });

  // ---- D2 (2026-08-26): how wide an "Always allow" on a hire may be. ----
  // These drive the REAL decision-path matcher (ruleMatches) against the REAL
  // shape harness-session.ts's rememberedRuleFor persists, so they fail if
  // either end drifts — a string comparison here would prove nothing.
  describe('D2 — grant width follows grantScope, not the helper\'s name', () => {
    const mk = (over: Partial<SpecialistDefinition>): SpecialistDefinition => ({
      id: 'code-reviewer', displayName: 'code-reviewer', description: 'Reviews code.',
      systemPrompt: 'Review.', allowedTools: ['Read', 'Grep'], charter: 'read-only',
      reportBudgetTokens: 500, source: 'claude-code',
      grantScope: 'project', fingerprint: 'f1f1f1f1f1f1', ...over,
    });
    const rosterOf = (d: SpecialistDefinition): SpecialistRoster =>
      ({ list: () => [d], resolve: (id) => (id === d.id ? d : undefined) });
    // Exactly what a remembered "Always allow" becomes on disk.
    const grantFor = (subject: string): PermissionRule =>
      ({ tool: 'Task', pattern: subject, action: 'allow', match: 'exact' });

    it('a USER-folder helper: one grant covers every project (what Destin asked for)', () => {
      const tool = createTaskTool(rosterOf(mk({ grantScope: 'user' })));
      const inRepoX = tool.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoX' } as any)!;
      const inRepoY = tool.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoY' } as any)!;
      expect(inRepoX).toBe(inRepoY);                      // no work dir in the subject at all
      expect(ruleMatches(grantFor(inRepoX), inRepoY)).toBe(true);
    });

    it('a PROJECT helper: the grant stays in the repo it was given in', () => {
      const tool = createTaskTool(rosterOf(mk({ grantScope: 'project' })));
      const inRepoX = tool.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoX' } as any)!;
      const inRepoY = tool.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoY' } as any)!;
      expect(inRepoX).not.toBe(inRepoY);
      // THE hazard this exists for: repo Y ships its own code-reviewer.md under
      // the same id. Always-allowing repo X's must never pre-approve it.
      expect(ruleMatches(grantFor(inRepoX), inRepoY)).toBe(false);
    });

    it('editing the file revokes the grant — the fingerprint rides in the subject', () => {
      const before = createTaskTool(rosterOf(mk({ grantScope: 'user', fingerprint: 'aaaa11112222' })));
      const subjectBefore = before.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoX' } as any)!;
      const granted = grantFor(subjectBefore);
      expect(ruleMatches(granted, subjectBefore)).toBe(true);

      // Same id, same folder, same charter — only the file's CONTENTS changed
      // (e.g. someone added Bash to its tools). The standing grant must not
      // carry over to a definition the user never saw.
      const after = createTaskTool(rosterOf(mk({ grantScope: 'user', fingerprint: 'bbbb33334444' })));
      const subjectAfter = after.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoX' } as any)!;
      expect(ruleMatches(granted, subjectAfter)).toBe(false);
    });

    it('a user-folder grant never covers a project file of the same id, or vice versa', () => {
      const userTool = createTaskTool(rosterOf(mk({ grantScope: 'user', fingerprint: 'cccc11112222' })));
      const projTool = createTaskTool(rosterOf(mk({ grantScope: 'project', fingerprint: 'dddd33334444' })));
      const userSubject = userTool.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoX' } as any)!;
      const projSubject = projTool.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoX' } as any)!;
      expect(ruleMatches(grantFor(userSubject), projSubject)).toBe(false);
      expect(ruleMatches(grantFor(projSubject), userSubject)).toBe(false);
    });

    it('a built-in keeps its 1c subject exactly — no grant anyone already has is lost', () => {
      const worker = resolveRealSpecialist('worker')!;
      const tool = createTaskTool(rosterOf(worker));
      expect(tool.permissionSubject!({ agent: 'worker', work_dir: '/proj' } as any))
        .toBe(`read-write:${subjectDir('/proj')}`);
    });
  });

  it('an unknown agent id is refused naming the roster\'s ids', async () => {
    const r = await runTaskTool({ agent: 'wizard' }, { roster: FAKE_ROSTER });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown specialist/i);
    expect(r.text).toContain('docs-writer');       // names what IS available — from the injected roster
    expect(r.text).not.toContain('explorer');       // never the built-in roster's ids
  });
});

// ---------------------------------------------------------------------------
// D2 (2026-08-26, review Major — check-then-use). permissionSubject and
// execute() each called roster.resolve() independently, and the catalog's
// resolve reads LIVE state: `specialists:list` calls catalog.reload(), which
// the renderer fires while a consent card is on screen. So the definition
// whose fingerprint the user approved could be a DIFFERENT object from the one
// that then spawned — the "the hash pins what you approved" promise is about
// resolution TIME, and there were two of those. createTaskTool now resolves
// once per id and reuses it for the life of that tool instance (= one turn).
// ---------------------------------------------------------------------------
describe('Task tool — one roster lookup per id, per tool instance (D2)', () => {
  const BASE: SpecialistDefinition = {
    id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes and edits project docs.',
    systemPrompt: 'Write docs.', allowedTools: ['Read', 'Write'], charter: 'read-write',
    reportBudgetTokens: 500, source: 'claude-code',
    grantScope: 'project', fingerprint: 'aaaaaaaaaaaa',
  };
  const ARGS = { agent: 'docs-writer', work_dir: '/proj', description: 'd', prompt: 'a'.repeat(60) };

  /** A roster whose resolve() hands back a FRESH object every call — exactly
   *  what SpecialistCatalog does after a reload, and the only way a second
   *  lookup is observable at all (identical field values would hide it). */
  function freshRoster() {
    const handedOut: SpecialistDefinition[] = [];
    const resolve = vi.fn((id: string) => {
      if (id !== BASE.id) return undefined;
      const copy: SpecialistDefinition = { ...BASE };
      handedOut.push(copy);
      return copy;
    });
    return { handedOut, resolve, roster: { list: () => [{ ...BASE }], resolve } as SpecialistRoster };
  }

  it('permissionSubject then execute() look the id up ONCE, and spawn gets the very object the subject was built from', async () => {
    const { handedOut, resolve, roster } = freshRoster();
    const tool = createTaskTool(roster);
    // The card the user sees is built from this subject...
    const subject = tool.permissionSubject!(ARGS as any);
    expect(subject).toBe(`read-write:${subjectDir('/proj')}:file:docs-writer@aaaaaaaaaaaa`);

    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const ctx: ToolContext = {
      sessionId: 'parent-1', cwd: '/work', signal: new AbortController().signal,
      readRegistry: new Map(), todos: [],
      services: {
        specialists: {
          reserve: () => ({ ok: true, token: { parentId: 'parent-1', writer: true } }),
          release: vi.fn(), trySpendSpawnBudget: () => true, spawn,
        },
      },
    };
    const r = await tool.execute(ARGS as any, ctx);
    expect(r.isError).toBeFalsy();

    // ...and this is what actually ran. One lookup, one object: there is no
    // window between approval and spawn for a reload to swap the definition.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(handedOut).toHaveLength(1);
    expect(spawn.mock.calls[0][1].specialist).toBe(handedOut[0]);
  });

  it('memoises per id, not per tool — a second id still costs its own single lookup', () => {
    const { resolve, roster } = freshRoster();
    const tool = createTaskTool(roster);
    tool.permissionSubject!(ARGS as any);
    tool.permissionSubject!({ ...ARGS, agent: 'nobody-here' } as any);
    tool.permissionSubject!({ ...ARGS, agent: 'nobody-here' } as any);
    expect(resolve).toHaveBeenCalledTimes(2);           // one per distinct id
    expect(resolve.mock.calls.map((c) => c[0])).toEqual(['docs-writer', 'nobody-here']);
  });

  it('a NEW tool instance looks the id up again — the memo is per-turn, never a permanent cache', () => {
    const { resolve, roster } = freshRoster();
    // harness-session.ts rebuilds the Task tool at the start of EVERY turn, so
    // an edited definition still takes effect at the next turn. A memo that
    // outlived the instance would freeze the roster for the whole session.
    createTaskTool(roster).permissionSubject!(ARGS as any);
    createTaskTool(roster).permissionSubject!(ARGS as any);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// D2 (2026-08-26, review Major): permissionSubject resolved a relative
// `work_dir` against `process.cwd()` — the Electron process's own directory,
// which has nothing to do with the conversation. Two consequences, both bad
// once a grant is pinned to that path: the remembered rule named a folder the
// user was never in (so the grant they were told was saved never fired again),
// and `work_dir: '.'` produced the SAME subject in every project, letting a
// project-scoped grant travel between projects — exactly what D2 prevents.
// ---------------------------------------------------------------------------
describe('Task tool — work_dir resolves against the SESSION folder (D2)', () => {
  const posix = (p: string) => p.replace(/\\/g, '/');

  it('a relative work_dir resolves against the session folder the host passes', () => {
    const tool = createTaskTool(undefined, '/sess/root');
    expect(tool.permissionSubject!({ agent: 'explorer', work_dir: 'sub' } as any)).toBe(`read-only:${subjectDir('sub', '/sess/root')}`);
    expect(tool.permissionSubject!({ agent: 'explorer', work_dir: '.' } as any)).toBe(`read-only:${subjectDir('.', '/sess/root')}`);
  });

  it('an absolute work_dir is unaffected by the session folder', () => {
    const tool = createTaskTool(undefined, '/sess/root');
    expect(tool.permissionSubject!({ agent: 'explorer', work_dir: '/elsewhere' } as any)).toBe(`read-only:${subjectDir('/elsewhere', '/sess/root')}`);
  });

  // THE hazard: two conversations in two different projects, both hiring with
  // the natural `work_dir: '.'`. Driven through the REAL decision-path matcher,
  // never a string comparison, so this fails if either end drifts.
  it('the same work_dir "." in two projects mints two DIFFERENT keys — a grant cannot travel', () => {
    const inA = createTaskTool(undefined, '/work/projA').permissionSubject!({ agent: 'explorer', work_dir: '.' } as any)!;
    const inB = createTaskTool(undefined, '/work/projB').permissionSubject!({ agent: 'explorer', work_dir: '.' } as any)!;
    expect(inA).not.toBe(inB);
    const grant: PermissionRule = { tool: 'Task', pattern: inA, action: 'allow', match: 'exact' };
    expect(ruleMatches(grant, inA)).toBe(true);
    expect(ruleMatches(grant, inB)).toBe(false);
  });

  it('with no session folder it still falls back to process.cwd() — every pre-existing caller is unchanged', () => {
    const tool = createTaskTool();
    expect(tool.permissionSubject!({ agent: 'explorer', work_dir: 'sub' } as any))
      .toBe(`read-only:${posix(path.resolve(process.cwd(), 'sub'))}`);
  });
});

describe('Task tool — model resolution (Task 14)', () => {
  const PARENT_BINDING: ModelBinding = { providerId: 'openrouter', modelId: 'parent-model' };

  async function designatedWith(entries: Partial<Record<'budget' | 'frontier', ModelBinding>>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tool-designated-'));
    const home = new NativeHome(dir);
    const designated = new DelegatedModels(home);
    if (entries.budget) await designated.set('budget', entries.budget);
    if (entries.frontier) await designated.set('frontier', entries.frontier);
    return designated;
  }

  it('model: "budget" spawns using the designated binding', async () => {
    const budgetBinding: ModelBinding = { providerId: 'openrouter', modelId: 'cheap-model' };
    const designated = await designatedWith({ budget: budgetBinding });
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'budget' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => null } },
    );
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({ binding: budgetBinding }));
    // No fallback note — the tier WAS configured.
    expect(r.text).toBe('done');
  });

  it('model: "frontier" with no tier configured falls back to the parent binding AND appends the honest note', async () => {
    const designated = await designatedWith({});
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'frontier' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => null } },
    );
    expect(r.isError).toBeFalsy();
    // Falls back to the PARENT's own binding — resolveDelegatedBinding
    // returns it explicitly (fellBack: true), so task.ts passes it through
    // like any other resolved binding; createChild would have landed on the
    // exact same value via its own opts.binding ?? parent.session.binding
    // default even without this.
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({ binding: PARENT_BINDING }));
    expect(r.text).toBe('done\n\n(No frontier model is designated — using this conversation\'s model.)');
  });

  it('a specific model id that IS in the live catalog resolves and spawns on it', async () => {
    const designated = await designatedWith({});
    const catalog: CatalogModel[] = [{ id: 'gpt-5', providerId: 'openai', label: 'GPT-5' }];
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'gpt-5' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => catalog } },
    );
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      binding: { providerId: 'openai', modelId: 'gpt-5' },
    }));
    expect(r.text).toBe('done'); // no fallback note — this path never falls back
  });

  it('a specific model id NOT in the live catalog REFUSES the call — never spawns', async () => {
    const designated = await designatedWith({});
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'totally-made-up-model' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => [] } },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Refused: "totally-made-up-model" is not an available model. Use ModelSearch to find the exact id, or use "budget"/"frontier".',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('omitting model (and an unset specialist.modelPreference) never touches ctx.binding or ctx.services.models', async () => {
    // No `binding`, no `models` in opts — if task.ts reached for either when
    // it shouldn't, this would throw a "configuration error" result instead
    // of spawning normally, which is exactly what this test pins against.
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool({ agent: 'explorer' }, { spawn });
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.not.objectContaining({ binding: expect.anything() }));
  });

  // Task 5 (plan 1c) — the ledger record (and later the run view) needs to
  // know what model actually ran, not just what binding was passed. `label`
  // is always the raw model id — never a pretty name (see task.ts's own WHY).
  it('Task passes model {label: modelId, via: tier|named|parent, fallback} into spawn opts', async () => {
    // via: 'budget' — a tier that IS configured, no fallback.
    const budgetBinding: ModelBinding = { providerId: 'openrouter', modelId: 'cheap-model' };
    const designated1 = await designatedWith({ budget: budgetBinding });
    const spawn1 = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    await runTaskTool(
      { agent: 'explorer', model: 'budget' },
      { spawn: spawn1, binding: PARENT_BINDING, models: { designated: designated1, catalog: async () => null } },
    );
    expect(spawn1).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      model: { label: 'cheap-model', via: 'budget', fallback: false },
    }));

    // via: 'named' — a specific model id resolved against the live catalog.
    const designated2 = await designatedWith({});
    const catalog: CatalogModel[] = [{ id: 'gpt-5', providerId: 'openai', label: 'GPT-5' }];
    const spawn2 = vi.fn(async () => ({ childId: 'child-2', report: 'done' }));
    await runTaskTool(
      { agent: 'explorer', model: 'gpt-5' },
      { spawn: spawn2, binding: PARENT_BINDING, models: { designated: designated2, catalog: async () => catalog } },
    );
    expect(spawn2).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      model: { label: 'gpt-5', via: 'named', fallback: false },
    }));

    // via: 'parent' — no model requested, no specialist preference: falls
    // back to the conversation's own binding.
    const spawn3 = vi.fn(async () => ({ childId: 'child-3', report: 'done' }));
    await runTaskTool({ agent: 'explorer' }, { spawn: spawn3, binding: PARENT_BINDING });
    expect(spawn3).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      model: { label: 'parent-model', via: 'parent', fallback: false },
    }));

    // via: 'frontier' with a genuine fallback (the tier isn't configured) —
    // fallback: true, and the label is honestly the PARENT's model, not a
    // frontier model that was never actually used.
    const designated4 = await designatedWith({});
    const spawn4 = vi.fn(async () => ({ childId: 'child-4', report: 'done' }));
    await runTaskTool(
      { agent: 'explorer', model: 'frontier' },
      { spawn: spawn4, binding: PARENT_BINDING, models: { designated: designated4, catalog: async () => null } },
    );
    expect(spawn4).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      model: { label: 'parent-model', via: 'frontier', fallback: true },
    }));
  });
});

// ---------------------------------------------------------------------------
// Task 6 — the task_id management surface: steer a running child, resume a
// finished/interrupted one, or interrupt one, all through the SAME Task tool
// (task_id + interrupt, no new agent/work_dir/description/prompt needed).
// Fakes throughout except the "different parent" test, which needs the REAL
// host to prove own-children-only actually holds rather than assuming a fake
// that always answers 'not-yours' is trustworthy.
// ---------------------------------------------------------------------------
describe('Task tool — task_id management surface (Task 6)', () => {
  function manageCtx(overrides: Partial<{
    steerSpecialist: any; interruptSpecialist: any; resumeSpecialist: any; reserve: any; release: any;
  }> = {}): ToolContext {
    return {
      sessionId: 'parent-1',
      cwd: '/work',
      signal: new AbortController().signal,
      readRegistry: new Map(),
      todos: [],
      toolCallId: 'tc-manage',
      services: {
        specialists: {
          reserve: overrides.reserve ?? vi.fn(() => ({ ok: true, token: { parentId: 'parent-1', writer: false } })),
          release: overrides.release ?? vi.fn(),
          trySpendSpawnBudget: () => true,
          spawn: vi.fn(),
          spawnBackground: vi.fn(),
          steerSpecialist: overrides.steerSpecialist ?? vi.fn(() => ({ status: 'not-yours' })),
          interruptSpecialist: overrides.interruptSpecialist ?? vi.fn(() => ({ status: 'not-yours' })),
          resumeSpecialist: overrides.resumeSpecialist ?? vi.fn(async () => ({ status: 'not-yours' })),
        },
      },
    };
  }

  it('steers a RUNNING child and reports delivery, naming who received it', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'ok', title: 'Rusty the Explorer' }));
    const r = await tool.execute(
      { task_id: 'child-1', prompt: 'focus on auth.ts instead' } as any,
      manageCtx({ steerSpecialist }),
    );
    expect(steerSpecialist).toHaveBeenCalledWith('parent-1', 'child-1', 'focus on auth.ts instead');
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Steer delivered to Rusty the Explorer.');
  });

  it('resumes a FINISHED child in the foreground — the resumed run\'s report IS the tool result', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'not-running', agentType: 'explorer' }));
    const reserve = vi.fn(() => ({ ok: true, token: { parentId: 'parent-1', writer: false } }));
    const release = vi.fn();
    const resumeSpecialist = vi.fn(async () => ({ status: 'ok', childId: 'child-1', report: 'the resumed report' }));
    const r = await tool.execute(
      { task_id: 'child-1', prompt: 'continue from where you left off' } as any,
      manageCtx({ steerSpecialist, reserve, release, resumeSpecialist }),
    );
    // explorer is read-only (specialists/builtins.ts) — the reservation must
    // size its writer flag from the specialist steerSpecialist named, not a
    // default.
    expect(reserve).toHaveBeenCalledWith('parent-1', { writer: false });
    expect(resumeSpecialist).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      childId: 'child-1', prompt: 'continue from where you left off', background: false,
    }));
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('the resumed report');
    expect(release).toHaveBeenCalled(); // foreground: this call site releases once the run settles
  });

  it('resumes an INTERRUPTED child in the background — the launch ack names the task_id, and the reservation is NOT released here', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'not-running', agentType: 'worker' })); // worker is read-write
    const reserve = vi.fn(() => ({ ok: true, token: { parentId: 'parent-1', writer: true } }));
    const release = vi.fn();
    const resumeSpecialist = vi.fn(async () => ({ status: 'ok-background', childId: 'child-1', title: 'Wren the Worker' }));
    const r = await tool.execute(
      { task_id: 'child-1', prompt: 'pick up the refactor', background: true } as any,
      manageCtx({ steerSpecialist, reserve, release, resumeSpecialist }),
    );
    expect(reserve).toHaveBeenCalledWith('parent-1', { writer: true }); // worker is read-write
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Wren the Worker \(worker\) is now working in the background/);
    expect(r.text).toMatch(/task_id: child-1/);
    expect(release).not.toHaveBeenCalled(); // ownership transferred to the detached chain, same as a fresh background spawn
  });

  it('interrupt: true cancels a RUNNING child with a typed result naming what it was doing', async () => {
    const tool = createTaskTool();
    const interruptSpecialist = vi.fn(() => ({ status: 'ok', title: 'Rusty the Explorer', description: 'Find the auth bug' }));
    const r = await tool.execute({ task_id: 'child-1', interrupt: true } as any, manageCtx({ interruptSpecialist }));
    expect(interruptSpecialist).toHaveBeenCalledWith('parent-1', 'child-1');
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Interrupted Rusty the Explorer — it was: Find the auth bug.');
  });

  it('interrupt: true on a child that already finished says there is nothing to interrupt', async () => {
    const tool = createTaskTool();
    const interruptSpecialist = vi.fn(() => ({ status: 'not-running', agentType: 'explorer' }));
    const r = await tool.execute({ task_id: 'child-1', interrupt: true } as any, manageCtx({ interruptSpecialist }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/is not currently running/);
    expect(r.text).toMatch(/nothing to interrupt/);
  });

  it('refuses a task_id that never existed', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'not-yours' }));
    const r = await tool.execute({ task_id: 'ghost-child', prompt: 'hello' } as any, manageCtx({ steerSpecialist }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Refused: that task_id does not belong to a specialist of this session.');
  });

  // The only test in this describe block against the REAL host: proves a
  // task_id belonging to a DIFFERENT parent is refused the SAME way as one
  // that never existed at all (spec §5 own-children-only) — a fake that
  // always answers 'not-yours' would only prove task.ts's OWN wiring, not
  // that the host actually enforces the boundary.
  it('refuses a task_id belonging to a DIFFERENT parent, identically to a nonexistent one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tool-manage-'));
    const home = new NativeHome(root);
    const store = new SessionStore(home);
    // The model factory is never called: createChild only constructs and
    // wires the child session, it never dispatches a turn.
    const neverCalledFactory = async () => { throw new Error('model factory should never be called in this test — no turn ever runs'); };
    const host = new NativeSessionHost(
      store, neverCalledFactory, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    try {
      await host.create({ sessionId: 'parent-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      await host.create({ sessionId: 'parent-2', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const EXPLORER = resolveRealSpecialist('explorer')!;
      const { childId } = await host.createChild('parent-1', {
        specialist: EXPLORER, prompt: 'find the bug', workDir: root, parentToolCallId: 'tc-1',
      });

      const tool = createTaskTool();
      const ctxFor = (parentId: string): ToolContext => ({
        sessionId: parentId, cwd: root, signal: new AbortController().signal, readRegistry: new Map(), todos: [],
        services: {
          specialists: {
            reserve: (pid: string, opts: { writer: boolean }) => host.reserveSpecialist(pid, opts),
            release: (token: any) => host.releaseReservation(token),
            trySpendSpawnBudget: (pid: string) => host.trySpendSpecialistSpawnBudget(pid),
            spawn: (pid: string, opts: any) => host.spawnSpecialist(pid, opts),
            spawnBackground: (pid: string, opts: any) => host.spawnSpecialistBackground(pid, opts),
            steerSpecialist: (pid: string, cid: string, text: string) => host.steerSpecialist(pid, cid, text),
            interruptSpecialist: (pid: string, cid: string) => host.interruptSpecialist(pid, cid),
            resumeSpecialist: (pid: string, opts: any) => host.resumeSpecialist(pid, opts),
          },
        },
      });

      // parent-2 does not own this child — real cross-parent refusal.
      const foreign = await tool.execute({ task_id: childId, prompt: 'do something' } as any, ctxFor('parent-2'));
      // A task_id that never existed anywhere — same host, same parent-2.
      const nonexistent = await tool.execute({ task_id: 'totally-made-up-id', prompt: 'do something' } as any, ctxFor('parent-2'));

      expect(foreign.isError).toBe(true);
      expect(foreign.text).toBe('Refused: that task_id does not belong to a specialist of this session.');
      expect(nonexistent.isError).toBe(true);
      expect(nonexistent.text).toBe(foreign.text); // indistinguishable — own-children-only can't be probed

      // And parent-1 — the REAL owner — can manage it normally.
      const owned = await tool.execute({ task_id: childId, interrupt: true } as any, ctxFor('parent-1'));
      expect(owned.isError).toBeFalsy();
      expect(owned.text).toMatch(/^Interrupted/);
    } finally {
      await host.destroyAll();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });

  // ---- D2 (2026-08-26, review Critical): a resume rebuilds the child from
  // the definition file AS IT IS NOW, while the consent the user gave was for
  // the file as it was at the hire. A task_id call carries no work_dir, so it
  // has no permission subject, so no consent card can render for it — under
  // auto-edit the pattern-less Task allow answers first. The host catches this
  // and returns a typed 'definition-changed'; these pin that the tool turns
  // that into an error the model can ACT on, naming the one path that re-asks
  // the user, on BOTH resume branches. ----
  describe('a resume whose definition file changed since the hire (D2)', () => {
    // Only a file-defined helper can ever hit this — a built-in has nothing on
    // disk to change, so it carries no fingerprint to compare.
    const DOCS_WRITER: SpecialistDefinition = {
      id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes and edits project docs.',
      systemPrompt: 'Write docs.', allowedTools: ['Read', 'Write'], charter: 'read-write',
      reportBudgetTokens: 500, source: 'claude-code',
      grantScope: 'project', fingerprint: 'bbbbbbbbbbbb',
    };
    const ROSTER: SpecialistRoster = {
      list: () => [DOCS_WRITER],
      resolve: (id) => (id === 'docs-writer' ? DOCS_WRITER : undefined),
    };
    // 'not-running' means "this parent's own child, already finished" — the
    // one answer that routes a task_id call into the resume path.
    const notRunning = () => vi.fn(() => ({ status: 'not-running', agentType: 'docs-writer' }));

    function expectRefusal(text: string) {
      expect(text).toContain('"docs-writer"');
      expect(text).toContain('has changed since this specialist was hired');
      expect(text).toContain('never approved');
      // Names the ONE path that goes through the user's consent card again.
      expect(text).toContain('Hire it again');
      expect(text).toContain('no task_id');
    }

    it('foreground: refuses, says what changed, and points at the path that re-asks the user', async () => {
      const tool = createTaskTool(ROSTER);
      const token = { parentId: 'parent-1', writer: true };
      const reserve = vi.fn(() => ({ ok: true, token }));
      const release = vi.fn();
      const resumeSpecialist = vi.fn(async () => ({ status: 'definition-changed', agentType: 'docs-writer' }));
      const r = await tool.execute(
        { task_id: 'child-1', prompt: 'continue from where you left off' } as any,
        manageCtx({ steerSpecialist: notRunning(), reserve, release, resumeSpecialist }),
      );
      // docs-writer is read-write, so the resume re-takes the writer lock —
      // and must hand it straight back when the resume is refused.
      expect(reserve).toHaveBeenCalledWith('parent-1', { writer: true });
      expect(r.isError).toBe(true);
      expectRefusal(r.text);
      expect(release).toHaveBeenCalledWith(token);
    });

    it('background: refuses identically AND releases the reservation it took', async () => {
      const tool = createTaskTool(ROSTER);
      const token = { parentId: 'parent-1', writer: true };
      const reserve = vi.fn(() => ({ ok: true, token }));
      const release = vi.fn();
      const resumeSpecialist = vi.fn(async () => ({ status: 'definition-changed', agentType: 'docs-writer' }));
      const r = await tool.execute(
        { task_id: 'child-1', prompt: 'pick up the refactor', background: true } as any,
        manageCtx({ steerSpecialist: notRunning(), reserve, release, resumeSpecialist }),
      );
      expect(r.isError).toBe(true);
      expectRefusal(r.text);
      // The background branch owns its own release on every refusal — nothing
      // downstream took ownership of this reservation, so a leak here would
      // silently burn a concurrency slot for the rest of the conversation.
      expect(release).toHaveBeenCalledWith(token);
      // Never the launch ack: a refusal must not read as "it started".
      expect(r.text).not.toMatch(/working in the background/);
    });
  });
});
