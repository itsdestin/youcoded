import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleSystemPrompt, assembleSystemPromptParts, findProjectInstructions, gitSnapshotAsync } from '../src/main/harness/prompt-assembly';
import { execFileSync } from 'child_process';
import { CODER_DEFAULT_BODY } from '../src/main/harness/prompts/coder-default';

// Each test gets a fresh tmp sandbox so filesystem walk-up state never leaks.
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-assembly-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PRESET = 'PRESET_BODY_MARKER';

describe('assembleSystemPrompt — section order', () => {
  it('orders identity → preset → project instructions → tool guidance → env, env last so later sessions reuse the cached rest', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PROJECT_INSTR_MARKER');
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '9.9.9' });

    const iIdentity = out.indexOf('YouCoded assistant');
    const iPreset = out.indexOf(PRESET);
    const iEnv = out.indexOf('<env');
    const iProject = out.indexOf('PROJECT_INSTR_MARKER');
    const iTools = out.indexOf('Prefer dedicated tools');

    expect(iIdentity).toBeGreaterThanOrEqual(0);
    expect(iPreset).toBeGreaterThan(iIdentity);
    expect(iProject).toBeGreaterThan(iPreset);
    expect(iTools).toBeGreaterThan(iProject);
    expect(iEnv).toBeGreaterThan(iTools);
  });

  it('labels the env block as a snapshot at session start', () => {
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '9.9.9' });
    expect(out).toContain('<env');
    expect(out).toContain('snapshot at session start');
    expect(out).toContain(`Working directory: ${dir}`);
    expect(out).toContain('YouCoded version: 9.9.9');
  });
});

describe('assembleSystemPrompt — project instructions walk-up', () => {
  it('prefers AGENTS.md over CLAUDE.md at the same level', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'FROM_AGENTS');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'FROM_CLAUDE');
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '1.0.0' });
    expect(out).toContain('source="AGENTS.md"');
    expect(out).toContain('FROM_AGENTS');
    expect(out).not.toContain('FROM_CLAUDE');
  });

  it('finds AGENTS.md at the root from a nested cwd (sub/dir/)', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'ROOT_INSTR');
    const nested = path.join(dir, 'sub', 'dir');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(dir, '.git')); // bound the walk-up at the repo root
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: nested, appVersion: '1.0.0' });
    expect(out).toContain('ROOT_INSTR');
    expect(out).toContain('source="AGENTS.md"');
  });

  it('stops the walk-up at the git root (does not escape the repo)', () => {
    // AGENTS.md lives ABOVE the repo; walk-up must not reach it.
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'OUTSIDE_REPO');
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: sub, appVersion: '1.0.0' });
    expect(out).not.toContain('OUTSIDE_REPO');
    expect(out).not.toContain('<project-instructions');
  });

  it('omits the project-instructions section entirely when neither file is present', () => {
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '1.0.0' });
    expect(out).not.toContain('<project-instructions');
  });

  it('finds a root-level AGENTS.md even when that dir is the git root', () => {
    // .git check must run AFTER trying the files in the dir.
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'ROOT_LEVEL_INSTR');
    fs.mkdirSync(path.join(dir, '.git'));
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '1.0.0' });
    expect(out).toContain('ROOT_LEVEL_INSTR');
  });
});

describe('assembleSystemPrompt — fixture .git containment', () => {
  // Fix 1 (Task 3 review, 2026-08-12): the harness eval fixture
  // (eval/fixture-workspace.ts's seedFixtureWorkspace) plants an empty `.git`
  // directory specifically so this walk-up can't escape the fixture and pick up
  // a stray AGENTS.md/CLAUDE.md above it — that's the CONTROL arm for every
  // instruction A/B this evaluator will ever run. Until now nothing tested that
  // the marker actually does this: the fixture test only asserted `.git` exists,
  // and the "no <project-instructions>" test in harness-eval-runner.test.ts
  // passed identically with or without the marker, because in a clean CI/dev
  // environment nothing stray lives above os.tmpdir() anyway. This proves the
  // real containment by seeding a genuine decoy ABOVE a hand-built fixture-shaped
  // tree — see the mutation evidence in the Task 3 Fix pass 1 report for proof
  // this test actually fails without the `.git` marker.
  //
  // WHY hand-built rather than seedFixtureWorkspace(): that helper creates its
  // tree via fs.mkdtempSync under os.tmpdir() and has no way to nest it inside a
  // caller-supplied parent directory, so it can't be used to plant a decoy
  // ABOVE the fixture root. This tree mirrors its shape exactly (a `.git` dir at
  // the fixture root, nothing more) without changing seedFixtureWorkspace's
  // signature for a test-only need.
  it('the .git marker actually stops the walk-up from reaching a decoy instruction file above the fixture root', () => {
    const parent = dir; // the tmp sandbox from beforeEach — stands in for "somewhere above the fixture"
    fs.writeFileSync(path.join(parent, 'AGENTS.md'), 'DECOY_CONTENT_FROM_ABOVE_THE_FIXTURE');
    const fixtureRoot = path.join(parent, 'fixture-root');
    fs.mkdirSync(fixtureRoot);
    fs.mkdirSync(path.join(fixtureRoot, '.git')); // the marker under test

    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: fixtureRoot, appVersion: '1.0.0' });

    expect(out).not.toContain('<project-instructions');
    expect(out).not.toContain('DECOY_CONTENT_FROM_ABOVE_THE_FIXTURE');
  });
});

describe('captured ancestor instruction inventory', () => {
  it('loads broad to narrow across git directory and worktree file, selecting one per folder', async () => {
    const { prepareProjectInstructions } = await import('../src/main/harness/injection/project-instructions');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'OUTSIDE_GIT');
    const repo = path.join(dir, 'repo');
    const nested = path.join(repo, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: elsewhere');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'REPO_RULE');
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'CHILD_RULE');
    fs.writeFileSync(path.join(nested, 'CLAUDE.md'), 'IGNORED_RULE');
    const inventory = await prepareProjectInstructions(nested, 1000);
    const selected = inventory.filter(f => f.path.startsWith(dir));
    expect(selected.map(f => f.name)).toEqual(['AGENTS.md', 'CLAUDE.md', 'AGENTS.md']);
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: nested, appVersion: '1', projectInstructionFiles: inventory });
    expect(out.indexOf('OUTSIDE_GIT')).toBeLessThan(out.indexOf('REPO_RULE'));
    expect(out.indexOf('REPO_RULE')).toBeLessThan(out.indexOf('CHILD_RULE'));
    expect(out).not.toContain('IGNORED_RULE');
    expect(out).toContain(`source="${path.join(dir, 'AGENTS.md')}"`);
  });

  it('includes ancestors outside a git directory without looking up a dedicated global file or repeating one source', async () => {
    const { prepareProjectInstructions } = await import('../src/main/harness/injection/project-instructions');
    const repo = path.join(dir, 'repo'); const child = path.join(repo, 'child');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'ABOVE_REPO');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'IN_REPO');
    fs.writeFileSync(path.join(child, 'CLAUDE.md'), 'IN_CHILD');
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'CLAUDE.md'), 'DEDICATED_GLOBAL_NOT_SELECTED');
    const files = (await prepareProjectInstructions(child, 1000)).filter(f => f.path.startsWith(dir));
    expect(files.map(f => f.full)).toEqual(['ABOVE_REPO', 'IN_REPO', 'IN_CHILD']);
    expect(new Set(files.map(f => f.path)).size).toBe(files.length);
    expect(files.some(f => f.path.includes(path.join('.claude', 'CLAUDE.md')))).toBe(false);
  });

  it('deduplicates a symlinked ancestor file by physical identity while retaining first source spelling', async () => {
    const { prepareProjectInstructions } = await import('../src/main/harness/injection/project-instructions');
    const child = path.join(dir, 'child'); fs.mkdirSync(child);
    const parent = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(parent, 'PHYSICAL_INSTRUCTION');
    try { fs.symlinkSync(parent, path.join(child, 'AGENTS.md')); }
    catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    const files = (await prepareProjectInstructions(child, 1000)).filter(f => f.path.startsWith(dir));
    expect(files.map(f => f.path)).toEqual([parent]);
    expect(assembleSystemPromptParts({ presetBody: PRESET, cwd: child, appVersion: '1', projectInstructionFiles: files })
      .find(p => p.id === 'project')?.text.match(/PHYSICAL_INSTRUCTION/g)).toHaveLength(1);
  });

  it.each([0, 1, 5, 30, 80, 400])('bounds final labelled project part and records omissions at %i tokens', async (tokens) => {
    const { prepareProjectInstructions } = await import('../src/main/harness/injection/project-instructions');
    const child = path.join(dir, 'child'); fs.mkdirSync(child);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Parent\n' + 'a'.repeat(3000));
    fs.writeFileSync(path.join(child, 'CLAUDE.md'), '# Child\n' + 'b'.repeat(3000));
    const files = (await prepareProjectInstructions(child, tokens)).filter(f => f.path.startsWith(dir));
    const part = assembleSystemPromptParts({ presetBody: PRESET, cwd: child, appVersion: '1', projectInstructionFiles: files }).find(p => p.id === 'project');
    expect(files).toHaveLength(2);
    expect(part?.text.length ?? 0).toBeLessThanOrEqual(tokens * 4);
    expect(files.every(f => f.truncated && !!f.note)).toBe(true);
    if (tokens === 0) expect(part).toBeUndefined();
    if (tokens === 80) {
      expect(part?.text).toContain('Read');
      expect(part?.text).toContain('AGENTS.md');
      expect(part?.text).toContain('CLAUDE.md');
    }
    for (const file of files) if (file.text) expect(part?.text).toContain(file.text);
  });

  it('compares legacy nearest-only selection with the captured full ancestor chain', async () => {
    const { prepareProjectInstructions } = await import('../src/main/harness/injection/project-instructions');
    const child = path.join(dir, 'child'); fs.mkdirSync(child);
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PARENT_RULE');
    fs.writeFileSync(path.join(child, 'CLAUDE.md'), 'CHILD_RULE');
    expect(findProjectInstructions(child)?.text).toBe('CHILD_RULE');
    const files = (await prepareProjectInstructions(child, 1000)).filter(f => f.path.startsWith(dir));
    expect(files.map(f => f.full)).toEqual(['PARENT_RULE', 'CHILD_RULE']);
  });

  it('fits the entire chain to one budget with honest per-source cuts and no fresh reads', async () => {
    const { prepareProjectInstructions } = await import('../src/main/harness/injection/project-instructions');
    const child = path.join(dir, 'child'); fs.mkdirSync(child);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Parent\n' + 'a'.repeat(3000));
    fs.writeFileSync(path.join(child, 'CLAUDE.md'), '# Child\n' + 'b'.repeat(3000));
    const inventory = await prepareProjectInstructions(child, 400);
    expect(inventory.filter(f => f.path.startsWith(dir))).toHaveLength(2);
    expect(inventory.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(1600);
    expect(inventory.filter(f => f.path.startsWith(dir)).every(f => f.truncated && f.text.includes(f.path))).toBe(true);
    const inputs = { presetBody: PRESET, cwd: child, appVersion: '1', projectInstructionFiles: inventory };
    const projectPart = assembleSystemPromptParts(inputs).find(p => p.id === 'project');
    expect(projectPart?.text.length).toBeLessThanOrEqual(1600);
    const first = assembleSystemPrompt(inputs);
    fs.writeFileSync(path.join(child, 'CLAUDE.md'), 'CHANGED_ON_DISK');
    expect(assembleSystemPrompt({ presetBody: PRESET, cwd: child, appVersion: '1', projectInstructionFiles: inventory })).toBe(first);
    expect(first).not.toContain('CHANGED_ON_DISK');
  });
});

describe('assembleSystemPrompt — byte stability (KV-cache pin)', () => {
  it('is byte-identical across two calls with the same inputs (non-git dir)', () => {
    // Non-git tmp dir → gitSnapshot returns the stable "not a repository" line,
    // and the date string is stable within a single test run.
    const inputs = { presetBody: PRESET, cwd: dir, appVersion: '2.3.4' };
    const a = assembleSystemPrompt(inputs);
    const b = assembleSystemPrompt(inputs);
    expect(a).toBe(b);
    expect(a).toContain('Git: not a repository');
  });
});

// 2026-09-16 smoothness sweep, C3: the host reads the git line ahead, off the
// main thread, and passes it in. The assembled prompt must be byte-identical
// either way, and the async reader must say exactly what the sync one says.
describe('gitSnapshot — precomputed and async', () => {
  it('a supplied gitSnapshot lands in <env> verbatim and the prompt equals the sync assembly', async () => {
    const sync = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '2.3.4' });
    const pre = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '2.3.4', gitSnapshot: await gitSnapshotAsync(dir) });
    expect(pre).toBe(sync);
    const custom = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '2.3.4', gitSnapshot: 'Git branch: feature/x (2 uncommitted change(s))' });
    expect(custom).toContain('\nGit branch: feature/x (2 uncommitted change(s))\n');
    expect(custom).not.toContain('Git: not a repository');
  });

  it('answers the fixed line for a non-repository', async () => {
    expect(await gitSnapshotAsync(dir)).toBe('Git: not a repository');
  });

  it('answers the same line as the sync reader for a real repository', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-git-'));
    try {
      execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
      // A repository with no commits has no HEAD, and both readers answer
      // "not a repository" for it — so commit first, then leave one change.
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'a.txt']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one']);
      fs.writeFileSync(path.join(repo, 'b.txt'), 'y');
      const line = await gitSnapshotAsync(repo);
      expect(line).toBe('Git branch: main (1 uncommitted change(s))');
      // The sync form is what the prompt falls back to; both must agree.
      expect(assembleSystemPrompt({ presetBody: PRESET, cwd: repo, appVersion: '1' })).toContain(line);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('CODER_DEFAULT_BODY', () => {
  it('is a non-empty original coder-shaped body', () => {
    expect(CODER_DEFAULT_BODY.length).toBeGreaterThan(100);
    expect(CODER_DEFAULT_BODY).toContain('software project');
  });
});

describe('prompt variant overlay', () => {
  const base = { presetBody: 'PRESET_BODY', cwd: process.cwd(), appVersion: '9.9.9' };

  it('default/anthropic/gpt append nothing (byte-identical to no variant)', () => {
    const none = assembleSystemPrompt({ ...base });
    expect(assembleSystemPrompt({ ...base, promptVariant: 'default' })).toBe(none);
    expect(assembleSystemPrompt({ ...base, promptVariant: 'anthropic' })).toBe(none);
    expect(assembleSystemPrompt({ ...base, promptVariant: 'gpt' })).toBe(none);
  });

  it('local-small appends the plan-then-execute overlay AFTER the preset body', () => {
    const p = assembleSystemPrompt({ ...base, promptVariant: 'local-small' });
    expect(p).toContain('PRESET_BODY');
    expect(p.indexOf('PRESET_BODY')).toBeLessThan(p.indexOf('one tool at a time'));
    expect(p).toMatch(/TodoWrite/);
  });
});

describe('assembleSystemPrompt — tool-less models (hasTools:false)', () => {
  const base = { presetBody: 'PRESET_BODY', cwd: process.cwd(), appVersion: '9.9.9' };

  it('omits the tool-guidance line AND the variant overlay when hasTools is false', () => {
    // A tool-less model (profile.supportsTools === false, e.g. Gemma 3n) gets no
    // tools attached, so it must not be told to prefer tools or call one at a time.
    const p = assembleSystemPrompt({ ...base, promptVariant: 'local-small', hasTools: false });
    expect(p).not.toContain('Prefer dedicated tools');
    expect(p).not.toContain('one tool at a time');
    // Identity + preset body are tool-agnostic and must still be present.
    expect(p).toContain('YouCoded assistant');
    expect(p).toContain('PRESET_BODY');
  });

  it('hasTools:true (default) is unchanged — keeps guidance line + overlay', () => {
    const withTools = assembleSystemPrompt({ ...base, promptVariant: 'local-small', hasTools: true });
    const defaulted = assembleSystemPrompt({ ...base, promptVariant: 'local-small' });
    expect(withTools).toBe(defaulted);   // explicit true === default
    expect(withTools).toContain('Prefer dedicated tools');
    expect(withTools).toContain('one tool at a time');
  });
});

describe('assembleSystemPrompt — shared doctrine', () => {
  const base = { presetBody: PRESET, cwd: '/tmp', appVersion: '1.0.0' };
  it('doctrine sits AFTER the project instructions and before the variant overlay', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PROJECT_INSTR_MARKER');
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '1.0.0', promptVariant: 'local-small' });
    expect(out.indexOf('Working rules, every conversation:')).toBeGreaterThan(out.indexOf('PROJECT_INSTR_MARKER'));
    expect(out.indexOf('one tool at a time')).toBeGreaterThan(out.indexOf('Working rules, every conversation:'));
  });
  it('the batching rule needs BOTH the profile flag and a non-small variant', () => {
    expect(assembleSystemPrompt({ ...base, supportsParallelToolCalls: true })).toContain('request them in one turn');
    expect(assembleSystemPrompt({ ...base })).not.toContain('request them in one turn');
    expect(assembleSystemPrompt({ ...base, supportsParallelToolCalls: true, promptVariant: 'local-small' })).not.toContain('request them in one turn');
  });
  it('local-small gets the compact doctrine and its overlay no longer says "stop"', () => {
    const out = assembleSystemPrompt({ ...base, promptVariant: 'local-small' });
    expect(out).not.toContain('Before you finish:\n- Does the result cover');
    expect(out).not.toContain('stop and answer');
    expect(out).toContain('Keep going until the task is done');
  });
  it('a specialist (audience parent) is not told how to write for the user', () => {
    expect(assembleSystemPrompt({ ...base, audience: 'parent' })).not.toContain('How you write:');
    expect(assembleSystemPrompt({ ...base })).toContain('How you write:');
  });
  it('the identity line says the model may be any vendor', () => {
    expect(assembleSystemPrompt(base)).toMatch(/any model the user chose/);
  });
});

// The panel's System tab shows the prompt in pieces (Destin, review-5 G-2). The
// pieces and the prompt must be the same thing — see assembleSystemPromptParts's
// own WHY comment on why two parallel implementations would drift invisibly.
describe('assembleSystemPromptParts — the pieces ARE the prompt', () => {
  const base = { presetBody: PRESET, cwd: '/tmp', appVersion: '1.0.0' };

  it('joining the parts reproduces the prompt exactly, in every shape', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rules\nPROJECT_INSTR_MARKER');
    const shapes = [
      base,
      { ...base, cwd: dir },
      { ...base, promptVariant: 'local-small' as const },
      { ...base, hasTools: false },
      { ...base, audience: 'parent' as const, supportsParallelToolCalls: true },
      { ...base, cwd: dir, promptVariant: 'local-small' as const, instructionBudgetTokens: 5 },
    ];
    for (const shape of shapes) {
      expect(assembleSystemPromptParts(shape).map((p) => p.text).join('\n\n')).toBe(assembleSystemPrompt(shape));
    }
  });

  it('drops the parts the joined prompt drops, rather than leaving them blank', () => {
    // No instructions file in the cwd, and the default variant is a no-op — the
    // prompt has never carried either, so the panel must not list an empty row.
    const ids = assembleSystemPromptParts(base).map((p) => p.id);
    expect(ids).not.toContain('project');
    expect(ids).not.toContain('steering');
    expect(ids).toEqual(['identity', 'preset', 'doctrine', 'env']);
  });

  it('names the project instructions part only when there is a file', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'PROJECT_INSTR_MARKER');
    const part = assembleSystemPromptParts({ ...base, cwd: dir }).find((p) => p.id === 'project');
    expect(part?.text).toContain('PROJECT_INSTR_MARKER');
  });

  it('a small local model gets a steering part; a frontier one does not', () => {
    expect(assembleSystemPromptParts({ ...base, promptVariant: 'local-small' }).map((p) => p.id)).toContain('steering');
    expect(assembleSystemPromptParts(base).map((p) => p.id)).not.toContain('steering');
  });

  it('presetName labels the preset part and changes NO byte of the prompt', () => {
    const withName = { ...base, presetName: 'Coder' };
    expect(assembleSystemPrompt(withName)).toBe(assembleSystemPrompt(base));
    expect(assembleSystemPromptParts(withName).find((p) => p.id === 'preset')?.label).toBe('Its preset — Coder');
    expect(assembleSystemPromptParts(base).find((p) => p.id === 'preset')?.label).toBe('Its preset');
  });
});

describe('findProjectInstructions', () => {
  it('returns the absolute path and the FULL text, uncut', () => {
    const body = `# Big\n${'x'.repeat(5000)}`;
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), body);
    const found = findProjectInstructions(dir);
    expect(found?.path).toBe(path.join(dir, 'CLAUDE.md'));
    expect(found?.name).toBe('CLAUDE.md');
    expect(found?.text).toBe(body);
  });

  it('prefers AGENTS.md in a directory holding both, matching the prompt', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'AGENTS');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'CLAUDE');
    expect(findProjectInstructions(dir)?.text).toBe('AGENTS');
  });

  it('is null when the walk finds nothing', () => {
    expect(findProjectInstructions(dir)).toBeNull();
  });
});
