// Tests for SpecialistCatalog — the disk-reading half of user-defined
// specialists (Task 3, plan 1c). Real filesystem (temp dirs per test), no fs
// mocking except where a test needs to PROVE no read happened.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SpecialistCatalog, resolveOffered, type RawEntry } from '../src/main/harness/specialists/catalog';
import { STARTER_FILE_NAME } from '../src/main/harness/specialists/definition-files';
import { MAX_OFFERED_SPECIALISTS } from '../src/main/harness/specialists/limits';
import { BUILTIN_SPECIALISTS } from '../src/main/harness/specialists/builtins';

function personalFile(id: string, extra = ''): string {
  return `---\ndescription: Specialist ${id}.\nid: ${id}\n${extra}---\nDo ${id} things.\n`;
}

function ccFile(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: CC specialist ${name}.\n${extra}---\nDo ${name} things.\n`;
}

describe('SpecialistCatalog', () => {
  let homeRoot: string;
  let home: NativeHome;
  let claudeUserDir: string;
  let cwd: string;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-catalog-home-'));
    home = new NativeHome(homeRoot);
    claudeUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-catalog-ccuser-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-catalog-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(claudeUserDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function personalDir(): string {
    return path.join(homeRoot, '.youcoded', 'specialists');
  }
  function projectAgentsDir(): string {
    return path.join(cwd, '.claude', 'agents');
  }

  it('built-ins load with no folders present', async () => {
    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    const ids = catalog.roster(cwd).list().map((d) => d.id).sort();
    expect(ids).toEqual(['explorer', 'researcher', 'reviewer', 'worker']);
  });

  it('personal file appears in roster(cwd) with source personal and its path', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    fs.writeFileSync(path.join(personalDir(), 'my-helper.md'), personalFile('my-helper'));

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    const roster = catalog.roster(cwd);
    const def = roster.resolve('my-helper');
    expect(def).toBeDefined();
    expect(def!.source).toBe('personal');

    const entry = catalog.snapshot(cwd).entries.find((e) => e.definition.id === 'my-helper');
    expect(entry?.source).toBe('personal');
    expect(entry?.path).toBe(path.join(personalDir(), 'my-helper.md'));
  });

  it('CC user-level and project files both load as claude-code, told apart by path', async () => {
    fs.writeFileSync(path.join(claudeUserDir, 'user-helper.md'), ccFile('User Helper'));
    fs.mkdirSync(projectAgentsDir(), { recursive: true });
    fs.writeFileSync(path.join(projectAgentsDir(), 'project-helper.md'), ccFile('Project Helper'));

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    const entries = catalog.snapshot(cwd).entries;
    const userEntry = entries.find((e) => e.definition.id === 'user-helper');
    const projectEntry = entries.find((e) => e.definition.id === 'project-helper');
    expect(userEntry?.source).toBe('claude-code');
    expect(userEntry?.path).toBe(path.join(claudeUserDir, 'user-helper.md'));
    expect(projectEntry?.source).toBe('claude-code');
    expect(projectEntry?.path).toBe(path.join(projectAgentsDir(), 'project-helper.md'));
  });

  // D2 (2026-08-26) — THE decision that keeps a repo-shipped helper's grant from
  // travelling. Only the catalog knows which folder a file came from
  // ('claude-code' spans two), so it is the only place the literals live. This
  // test is what makes swapping them at catalog.ts (refreshClaudeUser /
  // refreshProject) fail instead of passing 393 other tests.
  it('the FOLDER a file came from decides its grantScope', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    fs.writeFileSync(path.join(personalDir(), 'mine.md'), personalFile('mine'));
    fs.writeFileSync(path.join(claudeUserDir, 'user-helper.md'), ccFile('User Helper'));
    fs.mkdirSync(projectAgentsDir(), { recursive: true });
    fs.writeFileSync(path.join(projectAgentsDir(), 'project-helper.md'), ccFile('Project Helper'));

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    const roster = catalog.roster(cwd);

    // The two folders the user owns: a grant may travel to every project.
    expect(roster.resolve('mine')!.grantScope).toBe('user');
    expect(roster.resolve('user-helper')!.grantScope).toBe('user');
    // Inside the repo: the untrusted case, pinned to this work dir.
    expect(roster.resolve('project-helper')!.grantScope).toBe('project');
    // Built-ins keep the 1b subject shape, so no existing grant is lost.
    expect(roster.resolve('worker')!.grantScope).toBe('builtin');

    // Every file-defined one carries the content hash that makes an edit re-ask;
    // a built-in has no file, so it has none.
    for (const id of ['mine', 'user-helper', 'project-helper']) {
      expect(roster.resolve(id)!.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(roster.resolve('worker')!.fingerprint).toBeUndefined();
  });

  it('a personal file named worker.md is SKIPPED with a collision error — built-in ids are reserved', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    fs.writeFileSync(path.join(personalDir(), 'worker.md'), personalFile('worker'));

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    // "worker" still resolves to the BUILT-IN — the file never shadows it.
    expect(catalog.roster(cwd).resolve('worker')?.source).toBe('builtin');
    expect(catalog.roster(cwd).list().filter((d) => d.id === 'worker')).toHaveLength(1);

    const skipped = catalog.snapshot(cwd).skipped;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].source).toBe('personal');
    expect(skipped[0].error).toBe(
      '"worker" is already the name of a built-in specialist — rename this file\'s name/id',
    );
  });

  it('a project file colliding with a personal id is skipped; the personal one stays', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    fs.writeFileSync(path.join(personalDir(), 'shared.md'), personalFile('shared'));
    fs.mkdirSync(projectAgentsDir(), { recursive: true });
    fs.writeFileSync(path.join(projectAgentsDir(), 'shared.md'), ccFile('Shared'));

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    const def = catalog.roster(cwd).resolve('shared');
    expect(def?.source).toBe('personal');

    const skipped = catalog.snapshot(cwd).skipped;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].source).toBe('claude-code');
    expect(skipped[0].error).toBe(
      '"shared" is already the name of a file in your specialists folder — rename this file\'s name/id',
    );
  });

  it('a file that fails to parse is a SkippedFile and never in roster()', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    fs.writeFileSync(path.join(personalDir(), 'broken.md'), 'not a frontmatter file at all');

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    expect(catalog.roster(cwd).list().some((d) => d.id === 'broken')).toBe(false);

    const skipped = catalog.snapshot(cwd).skipped;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].path).toBe(path.join(personalDir(), 'broken.md'));
    expect(skipped[0].error).toBe('no frontmatter section found (file must start with ---)');
  });

  it('the 21st non-built-in definition is offered:false with the cap warning and absent from roster().list()', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    for (let i = 1; i <= MAX_OFFERED_SPECIALISTS + 1; i++) {
      const id = `spec-${String(i).padStart(2, '0')}`;
      fs.writeFileSync(path.join(personalDir(), `${id}.md`), personalFile(id));
    }

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);

    const list = catalog.roster(cwd).list();
    const nonBuiltinIds = list.map((d) => d.id).filter((id) => id.startsWith('spec-'));
    expect(nonBuiltinIds).toHaveLength(MAX_OFFERED_SPECIALISTS);
    expect(nonBuiltinIds).not.toContain('spec-21');

    const overflowEntry = catalog.snapshot(cwd).entries.find((e) => e.definition.id === 'spec-21');
    expect(overflowEntry?.offered).toBe(false);
    expect(overflowEntry?.warnings).toContain(
      `not offered to the assistant — more than ${MAX_OFFERED_SPECIALISTS} specialists are defined for this folder; remove or move some`,
    );
    expect(catalog.roster(cwd).resolve('spec-21')).toBeUndefined();
  });

  it('ensureFresh: editing a file’s CONTENT (same name, same folder) is detected — the fingerprint is per file, not the directory', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    const filePath = path.join(personalDir(), 'evolving.md');
    fs.writeFileSync(filePath, personalFile('evolving', 'tools: [Read]\n'));

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    expect(catalog.roster(cwd).resolve('evolving')?.allowedTools).toEqual(['Read']);

    // Force the mtime forward by a full second so this edit can never land in
    // the same millisecond as the original write (the documented blind spot).
    const bumped = new Date(Date.now() + 1000);
    fs.writeFileSync(filePath, personalFile('evolving', 'tools: [Read, Bash]\n'));
    fs.utimesSync(filePath, bumped, bumped);

    const changed = await catalog.ensureFresh(cwd);
    expect(changed).toBe(true);
    expect(catalog.roster(cwd).resolve('evolving')?.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('ensureFresh returns false and reads nothing when nothing changed', async () => {
    fs.mkdirSync(personalDir(), { recursive: true });
    fs.writeFileSync(path.join(personalDir(), 'stable.md'), personalFile('stable'));

    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    const first = await catalog.ensureFresh(cwd);
    expect(first).toBe(true);

    const spy = vi.spyOn(fs, 'readFileSync');
    spy.mockClear();
    const second = await catalog.ensureFresh(cwd);
    expect(second).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ensureFresh on a never-seen cwd loads all three sources (returns true) — there is no separate first-load path', async () => {
    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    const changed = await catalog.ensureFresh(cwd);
    expect(changed).toBe(true);
  });

  it('two cwds loaded; nothing about cwd A changes when cwd B is loaded again', async () => {
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-catalog-cwd-b-'));
    try {
      fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'alpha.md'), ccFile('Alpha'));
      fs.mkdirSync(path.join(cwdB, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(cwdB, '.claude', 'agents', 'beta.md'), ccFile('Beta'));

      const catalog = new SpecialistCatalog({ home, claudeUserDir });
      await catalog.ensureFresh(cwd);
      const beforeIds = catalog.roster(cwd).list().map((d) => d.id).sort();

      await catalog.ensureFresh(cwdB);
      const afterIds = catalog.roster(cwd).list().map((d) => d.id).sort();

      expect(afterIds).toEqual(beforeIds);
      expect(afterIds).toContain('alpha');
      expect(afterIds).not.toContain('beta');
    } finally {
      fs.rmSync(cwdB, { recursive: true, force: true });
    }
  });

  it('ensureFresh never creates <cwd>/.claude/agents', async () => {
    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    expect(fs.existsSync(path.join(cwd, '.claude', 'agents'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  it('ensurePersonalFolder writes example.md once and never overwrites an edited one', async () => {
    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    const target = path.join(personalDir(), STARTER_FILE_NAME);
    expect(fs.existsSync(target)).toBe(false);

    await catalog.ensurePersonalFolder();
    expect(fs.existsSync(target)).toBe(true);
    expect(catalog.snapshot().entries.some((e) => e.definition.id === 'example')).toBe(true);

    fs.writeFileSync(target, 'the user edited this file directly');
    await catalog.ensurePersonalFolder();
    expect(fs.readFileSync(target, 'utf8')).toBe('the user edited this file directly');
  });

  it('snapshot().folders reports all three paths', async () => {
    const catalog = new SpecialistCatalog({ home, claudeUserDir });
    await catalog.ensureFresh(cwd);
    const folders = catalog.snapshot(cwd).folders;
    expect(folders.personal).toBe(personalDir());
    expect(folders.claudeUser).toBe(claudeUserDir);
    expect(folders.project).toBe(projectAgentsDir());
  });
});

// resolveOffered is the pure collision/cap function — no disk I/O at all, so
// these exercise it directly with in-memory RawEntry fixtures.
describe('resolveOffered (pure)', () => {
  function rawEntry(id: string, source: 'personal' | 'claude-code', p: string): RawEntry {
    return {
      definition: {
        id,
        displayName: id,
        description: `${id} desc`,
        systemPrompt: 'x',
        allowedTools: ['Read'],
        charter: 'read-only',
        reportBudgetTokens: 2000,
        source,
      },
      source,
      path: p,
      warnings: [],
    };
  }

  it('a file colliding with a built-in id is skipped, never shadowing it', () => {
    const { entries, skipped } = resolveOffered(
      BUILTIN_SPECIALISTS,
      [rawEntry('worker', 'personal', '/p/worker.md')],
      [],
      [],
    );
    expect(entries.find((e) => e.definition.id === 'worker')?.source).toBe('builtin');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].error).toContain('a built-in specialist');
  });

  it('only the first MAX_OFFERED_SPECIALISTS non-builtin entries are offered', () => {
    const many = Array.from({ length: MAX_OFFERED_SPECIALISTS + 3 }, (_, i) =>
      rawEntry(`x-${i}`, 'personal', `/p/x-${i}.md`),
    );
    const { entries } = resolveOffered(BUILTIN_SPECIALISTS, many, [], []);
    const offeredCount = entries.filter((e) => e.offered).length;
    // built-ins are always offered too, so subtract them back out.
    expect(offeredCount - BUILTIN_SPECIALISTS.length).toBe(MAX_OFFERED_SPECIALISTS);
  });
});
