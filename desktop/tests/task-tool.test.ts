// The Task tool's own gating (typed refusals), task_id management, roster/consent keys and model resolution.
// Drives execute() against a fake ToolContext; the fake reserve()/release() stand in for the host's synchronous reserve-or-refuse
// step and only hand back the same shaped answers, so task.ts's reason-mapping and release-in-finally logic is what runs.
import { describe, it, expect, vi } from 'vitest';
import { createTaskTool } from '../src/main/harness/tools/task';
import type { ToolContext } from '../src/main/harness/tools/types';
import { SPECIALIST_SPAWN_BUDGET_PER_SESSION, HOSTED_MAX_CONCURRENT_SPECIALISTS } from '../src/main/harness/specialists/limits';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { NativeHome } from '../src/main/native-home';
import type { CatalogModel, ModelBinding } from '../src/shared/provider-types';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
// The real host is needed for the one "belongs to a DIFFERENT parent" test; a fake that always answers 'not-yours' proves nothing.
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { SessionStore } from '../src/main/harness/session-store';
import { resolveSpecialist as resolveRealSpecialist, type SpecialistDefinition, type SpecialistRoster } from '../src/main/harness/specialists/registry';
// The permission-subject tests drive the REAL matcher, so a pass proves a remembered grant does/doesn't apply.
import { ruleMatches } from '../src/shared/subject-glob';
import type { PermissionRule } from '../src/shared/permission-types';

// Windows resolves '/proj' onto the current drive, so expectations resolve the fixture the way permissionSubject does.
const subjectDir = (workDir: string, sessionCwd?: string): string =>
  path.resolve(sessionCwd ?? process.cwd(), workDir).replace(/\\/g, '/');


// WHY: ToolServices.specialists has ~10 members, but each test only wires the
// ones the code path under test actually calls (e.g. a refusal test never
// reaches spawn). The cast is deliberate and lives in this one place; vi.fn()
// mocks also don't match the strict member signatures without it.
type Specialists = NonNullable<NonNullable<ToolContext['services']>['specialists']>;
const fakeSpecialists = (partial: Record<string, unknown>): Specialists => partial as unknown as Specialists;

// A ToolContext wired with only the specialist services a test names.
const directCtx = (specialists: Record<string, unknown>): ToolContext => ({
  sessionId: 'parent-1', cwd: '/work', signal: new AbortController().signal, readRegistry: new Map(), todos: [],
  services: { specialists: fakeSpecialists(specialists) },
});

interface RunOpts {
  slotFree?: boolean;
  writerBusy?: boolean;
  spawn?: ReturnType<typeof vi.fn>;
  spawnBackground?: ReturnType<typeof vi.fn>;
  release?: ReturnType<typeof vi.fn>;
  // The per-conversation spawn budget is a SEPARATE gate from the concurrency slot; default available.
  budgetOk?: boolean;
  // Production native sessions always wire both binding and models; the helper supplies safe defaults.
  binding?: ModelBinding;
  models?: { designated: DelegatedModels; catalog: () => Promise<CatalogModel[] | null> };
  // undefined = BUILTIN_ROSTER (createTaskTool's default).
  roster?: SpecialistRoster;
  listStatus?: string | null;
}

function runTaskTool(args: Record<string, unknown>, opts: RunOpts = {}) {
  const tool = createTaskTool(opts.roster);
  const spawn = opts.spawn ?? vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
  const release = opts.release ?? vi.fn();
  const defaultBinding: ModelBinding = { providerId: 'openrouter', modelId: 'openai/gpt-5.6-fable' };
  const defaultModels = {
    // WHY: only designated.get() is consulted; the real class needs a NativeHome.
    designated: { get: () => null } as unknown as DelegatedModels,
    catalog: async (): Promise<CatalogModel[]> => [
      { id: 'deepseek/deepseek-v4-flash-0731', providerId: 'openrouter', label: 'DeepSeek V4 Flash 0731' },
    ],
  };
  const ctx: ToolContext = {
    sessionId: 'parent-1',
    cwd: '/work',
    signal: new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
    binding: opts.binding ?? defaultBinding,
    services: {
      specialists: fakeSpecialists({
        reserve: (parentId: string, reserveOpts: { writer: boolean }) => {
          if (reserveOpts.writer && opts.writerBusy) return { ok: false, reason: 'writer-busy' } as const;
          // The real reserveSpecialist() carries the resolved ceiling on an at-capacity refusal.
          if (opts.slotFree === false) return { ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS } as const;
          return { ok: true, token: { parentId, writer: reserveOpts.writer } } as const;
        },
        release,
        trySpendSpawnBudget: () => opts.budgetOk !== false,
        listStatus: () => opts.listStatus ?? null,
        spawn,
        ...(opts.spawnBackground ? { spawnBackground: opts.spawnBackground } : {}),
      }),
      models: opts.models ?? defaultModels,
    },
  };
  return tool.execute(
    { description: 'test task', prompt: 'a'.repeat(50), work_dir: '.', ...args } as any,
    ctx,
  );
}

describe('Task tool — list: true (replaces the per-turn status block)', () => {
  it('returns the host\'s status text, and never spawns', async () => {
    const spawn = vi.fn();
    const r = await runTaskTool({ list: true, description: undefined, prompt: undefined, work_dir: undefined }, { spawn, listStatus: 'Nadia (explorer): running — 12s' });
    expect(r.text).toBe('Nadia (explorer): running — 12s');
    expect(r.isError).toBeFalsy();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('says so plainly when nothing is running or pending', async () => {
    const r = await runTaskTool({ list: true, description: undefined, prompt: undefined, work_dir: undefined }, { listStatus: null });
    expect(r.text).toBe('No specialists or background commands are running or awaiting delivery in this conversation.');
  });

  it('is described to the model as ask-once, never a loop', () => {
    const tool = createTaskTool();
    expect((tool.inputSchema as any).shape.list.description).toContain('never in a loop');
    expect(tool.description).not.toContain('<specialists-status>');
  });
});

describe('Task tool — typed refusals', () => {
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

  // The placeholder regex matches only the WHOLE trimmed prompt; these clear the 40-char floor but are still unexpanded markers.
  describe('placeholder prompt rejection', () => {
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

    // False-positive boundary: a real ~45-char sentence must NOT be caught.
    it('a real ~45-char sentence is NOT rejected as a placeholder', async () => {
      const realPrompt = 'Find every call site of parseConfig() in src/.';   // 46 chars
      expect(realPrompt.length).toBeGreaterThanOrEqual(45);
      const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
      const r = await runTaskTool({ agent: 'explorer', prompt: realPrompt }, { spawn });
      expect(r.isError).toBeFalsy();
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  // A lifetime cap per parent conversation (runaway-loop backstop), never released.
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

  // WHY: the consent key is charter-scoped, not a bare work_dir; otherwise a remembered "Always allow" for a read-only explorer
  // silently pre-approved a read-write worker at the same path.
  describe('permissionSubject — charter-scoped consent key', () => {
    it('prefixes the subject with the resolved specialist\'s charter', () => {
      const tool = createTaskTool();
      // explorer is read-only (specialists/builtins.ts); worker is read-write.
      expect(tool.permissionSubject({ agent: 'explorer', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe(`read-only:${subjectDir('/proj')}`);
      expect(tool.permissionSubject({ agent: 'worker', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe(`read-write:${subjectDir('/proj')}`);
    });

    it('falls back to the bare work_dir for an unresolvable agent name', () => {
      // execute() refuses an unknown specialist before spawning, so this text only shows on an ask about to be declined.
      const tool = createTaskTool();
      expect(tool.permissionSubject({ agent: 'wizard', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe(subjectDir('/proj'));
    });

    // WHY: '.', './x' and the absolute form of one directory minted three consent keys; approving one left the others asking.
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

    // WHY: the key doubles as display text; guards.ts canonicalize() case-folds on win32, wrong for anything a user reads back.
    // Forced via a platform stub.
    it('preserves the real casing of work_dir even on win32 (the key doubles as display text)', () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const tool = createTaskTool();
        const subject = tool.permissionSubject!({ agent: 'wizard', work_dir: '/Proj/MixedCase', description: 'd', prompt: 'p' } as any)!;
        expect(subject).toContain('MixedCase');
        expect(subject).not.toBe(subject.toLowerCase());
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    });
  });

  // background: true dispatches through spawnBackground and the detached chain owns the release — except on a THROWN launch.
  describe('background: true', () => {
    it('calls spawnBackground (not spawn) and returns the launch ack without releasing the reservation', async () => {
      const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
      const spawnBackground = vi.fn(async () => ({ childId: 'child-9', title: 'Rusty the Explorer' }));
      const release = vi.fn();
      const tool = createTaskTool();
      const token = { parentId: 'parent-1', writer: false };
      const ctx = directCtx({ reserve: () => ({ ok: true, token }), release, spawn, spawnBackground, trySpendSpawnBudget: () => true });
      const r = await tool.execute(
        { description: 'find the bug', prompt: 'a'.repeat(60), agent: 'explorer', work_dir: '.', background: true, model: 'parent' } as any,
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
      expect(release).not.toHaveBeenCalled(); // ownership transferred to the detached chain
    });

    it('a thrown background launch still releases the reservation — ownership never transferred', async () => {
      const spawnBackground = vi.fn(async () => { throw new Error('createChild blew up'); });
      const release = vi.fn();
      const tool = createTaskTool();
      const token = { parentId: 'parent-1', writer: false };
      const ctx = directCtx({ reserve: () => ({ ok: true, token }), release, spawn: vi.fn(), spawnBackground, trySpendSpawnBudget: () => true });
      const r = await tool.execute(
        { description: 'x', prompt: 'a'.repeat(60), agent: 'explorer', work_dir: '.', background: true, model: 'parent' } as any,
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
    const ctx = directCtx({ reserve: () => ({ ok: true, token }), release, trySpendSpawnBudget: () => true, spawn: async () => { throw new Error('boom'); } });
    await tool.execute({ description: 'x', prompt: 'a'.repeat(50), agent: 'explorer', work_dir: '.', model: 'parent' } as any, ctx);
    expect(release).toHaveBeenCalledWith(token);
  });
});

// An omitted model resolves to budget and needs both production bindings; the direct-context tests above opt into model: 'parent'.
// The description a model reads must name each specialist's tools and say which one has a shell (a model once hired the
// read-only explorer to run `git log`).
describe('Task tool — roster names each specialist\'s tools', () => {
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

// createTaskTool(roster) is built from the CALLER's per-project roster, never a module-level snapshot of the built-ins.
describe('Task tool — per-cwd roster', () => {
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
    // Proves it came FROM the injected roster, not a stale BUILTIN_ROSTER default.
    expect(tool.description).not.toContain('explorer');
    // The schema's `agent` field is what the model reads to pick a value; built per tool, so it enumerates THIS roster too.
    const agentFieldDescription = (tool.inputSchema as any).shape.agent.description as string;
    expect(agentFieldDescription).toContain('docs-writer');
    expect(agentFieldDescription).not.toContain('explorer');
    expect(tool.shortDescription).toContain('docs-writer');
    expect(tool.shortDescription).not.toContain('explorer');
  });

  it('permissionSubject uses the roster to find the charter', () => {
    const tool = createTaskTool(FAKE_ROSTER);
    const subject = tool.permissionSubject!({ agent: 'docs-writer', work_dir: '/proj' } as any);
    // A PERSONAL-folder specialist is 'user'-scoped, so the work dir is deliberately absent: one grant covers every project.
    expect(subject).toBe('read-write:file:docs-writer@aaaaaaaaaaaa');
  });

  // permissionSubject stops an OLD remembered grant from silently covering a specialist a repository just shipped
  // (the renderer suppressing Always-allow on a non-builtin hire is a separate file's job). Driven through the real matcher.
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

    // A pre-existing remembered grant for the built-in Worker (the shape harness-session.ts persists).
    const workerGrant: PermissionRule = { tool: 'Task', pattern: `read-write:${subjectDir('/proj')}`, action: 'allow', match: 'exact' };
    expect(ruleMatches(workerGrant, builtinSubject!)).toBe(true);   // still covers the built-in it was granted for
    expect(ruleMatches(workerGrant, fileSubject!)).toBe(false);     // must NOT auto-approve a repo-shipped helper
  });

  // How wide an "Always allow" on a hire may be; drives the REAL matcher against the shape rememberedRuleFor persists.
  describe('grant width follows grantScope, not the helper\'s name', () => {
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
      // Repo Y may ship its own code-reviewer.md under the same id; always-allowing repo X's must not pre-approve it.
      expect(ruleMatches(grantFor(inRepoX), inRepoY)).toBe(false);
    });

    it('editing the file revokes the grant — the fingerprint rides in the subject', () => {
      const before = createTaskTool(rosterOf(mk({ grantScope: 'user', fingerprint: 'aaaa11112222' })));
      const subjectBefore = before.permissionSubject!({ agent: 'code-reviewer', work_dir: '/repoX' } as any)!;
      const granted = grantFor(subjectBefore);
      expect(ruleMatches(granted, subjectBefore)).toBe(true);

      // Only the file's CONTENTS changed (e.g. Bash added): the grant must not carry to a definition the user never saw.
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

// WHY: permissionSubject and execute() each resolved the roster against LIVE state (a reload while a consent card is open),
// so the approved fingerprint could belong to a different object than the one that spawned. Resolve once per id per tool instance (one turn).
describe('Task tool — one roster lookup per id, per tool instance', () => {
  const BASE: SpecialistDefinition = {
    id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes and edits project docs.',
    systemPrompt: 'Write docs.', allowedTools: ['Read', 'Write'], charter: 'read-write',
    reportBudgetTokens: 500, source: 'claude-code',
    grantScope: 'project', fingerprint: 'aaaaaaaaaaaa',
  };
  const ARGS = { agent: 'docs-writer', work_dir: '/proj', description: 'd', prompt: 'a'.repeat(60), model: 'parent' };

  // A roster whose resolve() hands back a FRESH object each call (as SpecialistCatalog does after a reload), the only way a second lookup is observable.
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
    const subject = tool.permissionSubject!(ARGS as any); // the card the user sees is built from this
    expect(subject).toBe(`read-write:${subjectDir('/proj')}:file:docs-writer@aaaaaaaaaaaa`);

    const spawn = vi.fn<Specialists['spawn']>(async () => ({ childId: 'child-1', report: 'done' }));
    const ctx = directCtx({ reserve: () => ({ ok: true, token: { parentId: 'parent-1', writer: true } }), release: vi.fn(), trySpendSpawnBudget: () => true, spawn });
    const r = await tool.execute(ARGS as any, ctx);
    expect(r.isError).toBeFalsy();

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
    // harness-session.ts rebuilds the tool every turn, so an edited definition takes effect next turn; a longer-lived memo would freeze it.
    createTaskTool(roster).permissionSubject!(ARGS as any);
    createTaskTool(roster).permissionSubject!(ARGS as any);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

// WHY: resolving against process.cwd() (the Electron process's directory) made a remembered grant name a folder the user was never in,
// and made work_dir '.' mint the SAME subject in every project, letting a project-scoped grant travel.
describe('Task tool — work_dir resolves against the SESSION folder', () => {
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

  // Two projects both hiring with work_dir '.', through the real matcher.
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

describe('Task tool — model resolution', () => {
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
    const catalog = vi.fn(async () => null);
    const r = await runTaskTool(
      { agent: 'explorer', model: 'budget' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog } },
    );
    expect(r.isError).toBeFalsy();
    expect(catalog).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({ binding: budgetBinding }));
    // No fallback note — the tier WAS configured.
    expect(r.text).toBe('done');
  });

  it('passes the resolved automatic binding into a background specialist launch', async () => {
    const spawnBackground = vi.fn(async () => ({ childId: 'child-bg', title: 'Explorer' }));
    const r = await runTaskTool(
      { agent: 'explorer', background: true },
      { spawnBackground },
    );
    expect(r.isError).toBeFalsy();
    expect(spawnBackground).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      binding: { providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' },
    }));
  });

  it('model: "frontier" refuses safely when its curated model is unavailable', async () => {
    const designated = await designatedWith({});
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'frontier' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => [] } },
    );
    expect(r).toEqual({ text: 'SPECIALIST_MODEL_UNAVAILABLE:frontier', isError: true });
    expect(spawn).not.toHaveBeenCalled();
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

  it('omitting model uses the provider-matched automatic budget model', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool({ agent: 'explorer' }, { spawn });
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      binding: { providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' },
    }));
  });

  // The ledger needs what model actually ran; `label` is always the raw model id.
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

    // via: 'budget' — no model requested means the safe automatic tier.
    const spawn3 = vi.fn(async () => ({ childId: 'child-3', report: 'done' }));
    await runTaskTool({ agent: 'explorer' }, { spawn: spawn3 });
    expect(spawn3).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      model: { label: 'deepseek/deepseek-v4-flash-0731', via: 'budget', fallback: false },
    }));

    // via: 'frontier': the unset tier resolves to its provider-matched curated model, never the conversation parent.
    const designated4 = await designatedWith({});
    const spawn4 = vi.fn(async () => ({ childId: 'child-4', report: 'done' }));
    await runTaskTool(
      { agent: 'explorer', model: 'frontier' },
      {
        spawn: spawn4,
        binding: PARENT_BINDING,
        models: {
          designated: designated4,
          catalog: async () => [{ id: 'moonshotai/kimi-k3', providerId: 'openrouter', label: 'Kimi K3' }],
        },
      },
    );
    expect(spawn4).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      model: { label: 'moonshotai/kimi-k3', via: 'frontier', fallback: false },
    }));
  });
});

// task_id management: steer a running child, resume a finished one, or interrupt one. Fakes throughout except the
// "different parent" test, which uses the real host to prove own-children-only holds.
describe('Task tool — task_id management surface', () => {
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
        specialists: fakeSpecialists({
          reserve: overrides.reserve ?? vi.fn(() => ({ ok: true, token: { parentId: 'parent-1', writer: false } })),
          release: overrides.release ?? vi.fn(),
          trySpendSpawnBudget: () => true,
          spawn: vi.fn(),
          spawnBackground: vi.fn(),
          steerSpecialist: overrides.steerSpecialist ?? vi.fn(() => ({ status: 'not-yours' })),
          interruptSpecialist: overrides.interruptSpecialist ?? vi.fn(() => ({ status: 'not-yours' })),
          resumeSpecialist: overrides.resumeSpecialist ?? vi.fn(async () => ({ status: 'not-yours' })),
        }),
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

  it('refuses a task_id belonging to a DIFFERENT parent, identically to a nonexistent one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tool-manage-'));
    const home = new NativeHome(root);
    const store = new SessionStore(home);
    // createChild never dispatches a turn, so the model factory is never called.
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
          specialists: fakeSpecialists({
            reserve: (pid: string, opts: { writer: boolean }) => host.reserveSpecialist(pid, opts),
            release: (token: any) => host.releaseReservation(token),
            trySpendSpawnBudget: (pid: string) => host.trySpendSpecialistSpawnBudget(pid),
            spawn: (pid: string, opts: any) => host.spawnSpecialist(pid, opts),
            spawnBackground: (pid: string, opts: any) => host.spawnSpecialistBackground(pid, opts),
            steerSpecialist: (pid: string, cid: string, text: string) => host.steerSpecialist(pid, cid, text),
            interruptSpecialist: (pid: string, cid: string) => host.interruptSpecialist(pid, cid),
            resumeSpecialist: (pid: string, opts: any) => host.resumeSpecialist(pid, opts),
          }),
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

  // WHY: a resume rebuilds the child from the definition file as it is NOW, but consent was for the file at hire. A task_id call carries
  // no work_dir, so no consent card can render; the host returns 'definition-changed' and the tool must turn it into an error the
  // model can act on, on BOTH resume branches.
  describe('a resume whose definition file changed since the hire', () => {
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
    // 'not-running' = this parent's own child, already finished: the answer that routes a task_id call into resume.
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
      // read-write, so the resume re-takes the writer lock and must hand it back when refused.
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
      // The background branch owns its release on every refusal; a leak would burn a concurrency slot for the conversation.
      expect(release).toHaveBeenCalledWith(token);
      // Never the launch ack: a refusal must not read as "it started".
      expect(r.text).not.toMatch(/working in the background/);
    });
  });
});
