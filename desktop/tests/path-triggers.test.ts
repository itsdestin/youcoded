// Nested CLAUDE.md and path-scoped rules are ONE mechanism: content the model
// should see once work touches a matching path. prompt-assembly.ts takes only
// the FIRST instructions file walking cwd -> git root, so a monorepo package's
// own CLAUDE.md is invisible today.
//
// The root file stays in the system prompt (byte-stable, Global Constraint 1);
// nested ones arrive as messages.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTriggerIndex } from '../src/main/harness/injection/path-triggers';

function tmpRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triggers-'));
  fs.mkdirSync(path.join(root, '.git'));
  return fs.realpathSync(root);   // macOS /var -> /private/var; matching is path-based
}

function write(root: string, rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
}

describe('nested project instructions', () => {
  it('a file inside a nested package triggers that package\'s CLAUDE.md', async () => {
    const root = tmpRepo();
    write(root, 'CLAUDE.md', 'root rules');
    write(root, 'packages/api/CLAUDE.md', 'api package rules');
    const hits = (await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api', 'server.ts'));
    expect(hits.map((h) => h.body)).toContain('api package rules');
  });

  it('does NOT re-trigger the root file — it is already in the system prompt', async () => {
    const root = tmpRepo();
    write(root, 'CLAUDE.md', 'root rules');
    write(root, 'packages/api/CLAUDE.md', 'api package rules');
    const hits = (await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api', 'server.ts'));
    expect(hits.map((h) => h.body)).not.toContain('root rules');
  });

  it('a file outside the nested package triggers nothing', async () => {
    const root = tmpRepo();
    write(root, 'packages/api/CLAUDE.md', 'api package rules');
    expect((await buildTriggerIndex(root)).match(path.join(root, 'README.md'))).toEqual([]);
  });

  it('AGENTS.md wins over CLAUDE.md in the same directory', async () => {
    // Same precedence prompt-assembly uses: AGENTS.md is the cross-tool standard.
    const root = tmpRepo();
    write(root, 'packages/api/AGENTS.md', 'agents wins');
    write(root, 'packages/api/CLAUDE.md', 'claude loses');
    const bodies = (await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api', 'x.ts')).map((h) => h.body);
    expect(bodies).toContain('agents wins');
    expect(bodies).not.toContain('claude loses');
  });

  it('nested directories stack, least specific first', async () => {
    // The model should read the most specific instructions LAST, so they land
    // closest to the work.
    const root = tmpRepo();
    write(root, 'packages/CLAUDE.md', 'all packages');
    write(root, 'packages/api/CLAUDE.md', 'api only');
    const bodies = (await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api', 'x.ts')).map((h) => h.body);
    expect(bodies).toEqual(['all packages', 'api only']);
  });

  it('a repo with no nested instructions yields an empty index, not a crash', async () => {
    const root = tmpRepo();
    expect((await buildTriggerIndex(root)).match(path.join(root, 'x.ts'))).toEqual([]);
  });

  it('skips node_modules — a dependency\'s CLAUDE.md is not this project\'s rules', async () => {
    const root = tmpRepo();
    write(root, 'node_modules/some-dep/CLAUDE.md', 'dependency rules');
    expect((await buildTriggerIndex(root)).match(path.join(root, 'node_modules', 'some-dep', 'index.js'))).toEqual([]);
  });

  it('an empty instructions file is not a trigger', async () => {
    // Injecting an empty <project-rule> block wastes window and says nothing.
    const root = tmpRepo();
    write(root, 'packages/api/CLAUDE.md', '   \n  ');
    expect((await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api', 'x.ts'))).toEqual([]);
  });

  it('a directory PREFIX that is not a path boundary does not match', async () => {
    // packages/api must not match packages/api-client — a string startsWith
    // without the separator would.
    const root = tmpRepo();
    write(root, 'packages/api/CLAUDE.md', 'api only');
    expect((await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api-client', 'x.ts'))).toEqual([]);
  });

  it('each trigger carries a stable id and a readable source', async () => {
    const root = tmpRepo();
    write(root, 'packages/api/CLAUDE.md', 'api only');
    const [hit] = (await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api', 'x.ts'));
    expect(hit.id).toBeTruthy();
    expect(hit.source).toBe(path.join('packages', 'api', 'CLAUDE.md'));
  });
});

// ---------------------------------------------------------------------------
// Path-scoped rules (M3 item 3b). Same mechanism as nested instructions, fed by
// <cwd>/.claude/rules/*.md with `paths:` frontmatter — the convention this
// workspace already uses on Claude Code, so a repo set up for CC works natively
// with no new configuration.
// ---------------------------------------------------------------------------
describe('path-scoped rules', () => {
  const RULE = '---\npaths:\n  - "src/api/**"\n---\nAlways validate input.';

  it('a rule whose glob matches the touched file is triggered', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/api.md', RULE);
    const bodies = (await buildTriggerIndex(root)).match(path.join(root, 'src', 'api', 'users.ts')).map((h) => h.body);
    expect(bodies.join()).toContain('Always validate input');
  });

  it('a rule whose glob does not match stays out of the conversation', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/api.md', RULE);
    expect((await buildTriggerIndex(root)).match(path.join(root, 'src', 'ui', 'Button.tsx'))).toEqual([]);
  });

  it('a rule with NO paths: is ignored, never treated as global', async () => {
    // An eager rule rides every turn — exactly the cost M3 item 5 exists to
    // control. The workspace's own .claude/rules/README.md calls omitting
    // `paths:` a mistake ("omitting it makes the rule EAGER").
    const root = tmpRepo();
    write(root, '.claude/rules/loose.md', 'No frontmatter here.');
    expect((await buildTriggerIndex(root)).match(path.join(root, 'anything.ts'))).toEqual([]);
  });

  it('a rule with frontmatter but an empty paths: list is ignored too', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/empty.md', '---\npaths:\nlast_verified: 2026-01-01\n---\nBody.');
    expect((await buildTriggerIndex(root)).match(path.join(root, 'anything.ts'))).toEqual([]);
  });

  it('multiple globs in one rule all match', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/multi.md', '---\npaths:\n  - "src/api/**"\n  - "src/db/**"\n---\nBoth.');
    const idx = (await buildTriggerIndex(root));
    expect(idx.match(path.join(root, 'src', 'api', 'a.ts')).length).toBe(1);
    expect(idx.match(path.join(root, 'src', 'db', 'b.ts')).length).toBe(1);
  });

  it('a single * stays inside one path segment; ** crosses them', async () => {
    // WHY this is pinned: shared/subject-glob.ts deliberately lets * cross
    // separators (correct for bash command strings — "git push*" must match
    // "git push origin x"). Reusing it here would make src/*.ts match
    // src/deep/nested.ts and inject a rule into work it does not govern. This
    // test is the reason path-triggers has its own matcher.
    const root = tmpRepo();
    write(root, '.claude/rules/shallow.md', '---\npaths:\n  - "src/*.ts"\n---\nShallow only.');
    write(root, '.claude/rules/deep.md', '---\npaths:\n  - "src/**"\n---\nAny depth.');
    const idx = (await buildTriggerIndex(root));

    const top = idx.match(path.join(root, 'src', 'a.ts')).map((h) => h.body);
    expect(top).toContain('Shallow only.');
    expect(top).toContain('Any depth.');

    const nested = idx.match(path.join(root, 'src', 'deep', 'nested.ts')).map((h) => h.body);
    expect(nested).not.toContain('Shallow only.');
    expect(nested).toContain('Any depth.');
  });

  it('the rule BODY is injected, never its frontmatter', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/api.md', '---\npaths:\n  - "src/**"\nlast_verified: 2026-07-28\n---\nThe actual rule.');
    const [hit] = (await buildTriggerIndex(root)).match(path.join(root, 'src', 'x.ts'));
    expect(hit.body).toBe('The actual rule.');
    expect(hit.body).not.toContain('last_verified');
  });

  it('rules and nested instructions surface together from one index', async () => {
    // The point of one mechanism: a single match() answers both.
    const root = tmpRepo();
    write(root, '.claude/rules/api.md', '---\npaths:\n  - "packages/**"\n---\nRule text.');
    write(root, 'packages/api/CLAUDE.md', 'Nested text.');
    const bodies = (await buildTriggerIndex(root)).match(path.join(root, 'packages', 'api', 'x.ts')).map((h) => h.body);
    expect(bodies).toContain('Rule text.');
    expect(bodies).toContain('Nested text.');
  });

  it.each(['directory', 'worktree-file'] as const)('inherits owner-relative rules up to the nearest Git %s root', async (gitKind) => {
    const outer = tmpRepo();
    const root = path.join(outer, 'project');
    fs.mkdirSync(root);
    if (gitKind === 'directory') fs.mkdirSync(path.join(root, '.git'));
    else write(root, '.git', 'gitdir: /elsewhere/worktrees/test\n');
    const parent = outer;
    write(root, '.claude/rules/root.md', '---\npaths:\n  - "**/src/**"\n---\nRoot rule.');
    write(root, 'packages/.claude/rules/package.md', '---\npaths:\n  - "api/*.ts"\n---\nPackage rule.');
    write(parent, '.claude/rules/outside.md', '---\npaths:\n  - "**"\n---\nOutside rule.');
    try {
      const idx = await buildTriggerIndex(path.join(root, 'packages', 'api'));
      const hits = idx.match(path.join(root, 'packages', 'src', 'a.ts'));
      expect(hits.map(h => h.body)).toEqual(['Root rule.']);
      const ownerHits = idx.match(path.join(root, 'packages', 'api', 'a.ts'));
      expect(ownerHits.map(h => h.body)).toEqual(['Package rule.']);
      expect(ownerHits[0].id).toContain(path.join('packages', '.claude', 'rules', 'package.md'));
      expect(ownerHits[0].source).toBe(path.join('..', '.claude', 'rules', 'package.md'));
      expect(idx.match(path.join(parent, 'unrelated.ts'))).toEqual([]);
    } finally {
      fs.rmSync(path.join(parent, '.claude', 'rules', 'outside.md'), { force: true });
    }
  });

  it('does not inject the same physical rule twice through two owned names', async () => {
    const root = tmpRepo();
    const original = path.join(root, '.claude', 'rules', 'original.md');
    write(root, '.claude/rules/original.md', '---\npaths:\n  - "**/src/**"\n---\nShared rule.');
    const alias = path.join(root, 'pkg', '.claude', 'rules', 'alias.md');
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.linkSync(original, alias);
    const hits = (await buildTriggerIndex(path.join(root, 'pkg'))).match(path.join(root, 'pkg', 'src', 'a.ts'));
    expect(hits.map(h => h.body)).toEqual(['Shared rule.']);
  });

  it('stacks root and child rules once for a narrowed specialist and excludes external files', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/root.md', '---\npaths:\n  - "**/src/**"\n---\nRoot rule.');
    write(root, 'packages/.claude/rules/package.md', '---\npaths:\n  - "**/src/**"\n---\nPackage rule.');
    const idx = await buildTriggerIndex(path.join(root, 'packages', 'api'));
    const file = path.join(root, 'packages', 'api', 'src', 'a.ts');
    expect(idx.match(file).map(h => h.body)).toEqual(['Root rule.', 'Package rule.']);
    expect(new Set(idx.match(file).map(h => h.id)).size).toBe(2);
    expect(idx.match(path.join(path.dirname(root), 'src', 'a.ts'))).toEqual([]);
  });

  it('parses quoted YAML with comments and matches globstar on segment boundaries', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/comment.md', '---\npaths:\n  - "src/**" # source files\n---\nCOMMENT_RULE');
    write(root, '.claude/rules/glob.md', '---\npaths:\n  - "**/src/**"\n---\nGLOB_RULE');
    const idx = await buildTriggerIndex(root);
    expect(idx.match('src/a.ts').map(h => h.body)).toEqual(['COMMENT_RULE', 'GLOB_RULE']);
    expect(idx.match('pkg/src/a.ts').map(h => h.body)).toEqual(['GLOB_RULE']);
    expect(idx.match('notsrc/a.ts')).toEqual([]);
  });

  it('matches question marks, zero or multiple globstar folders, and ignores malformed patterns', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/pattern.md', '---\npaths:\n  - "src/**/file?.ts"\n  - "[unclosed"\n---\nMATCH');
    write(root, '.claude/rules/malformed.md', '---\npaths: [bad\n---\nMALFORMED');
    const idx = await buildTriggerIndex(root);
    for (const rel of ['src/file1.ts', 'src/a/file2.ts', 'src/a/b/file3.ts']) {
      expect(idx.match(rel).map(h => h.body)).toEqual(['MATCH']);
    }
    expect(idx.match('src/file12.ts')).toEqual([]);
  });

  it.each([
    ['nested mapping', 'paths:\n  nested:\n    - "src/**"', []],
    ['nested sequence', 'paths:\n  - nested:\n      - "src/**"', []],
    ['nested sibling list', 'paths:\n  - "safe/**"\n  nested:\n    - "src/**"\n  - "other/**"', ['safe/**']],
    ['malformed sibling indentation', 'paths:\n  - "safe/**"\n   - "src/**"\n  - "other/**"', ['safe/**']],
  ] as const)('does not treat %s as paths list entries', async (_case, front, expected) => {
    const root = tmpRepo();
    write(root, '.claude/rules/shape.md', `---\n${front}\n---\nRule body.`);
    const idx = await buildTriggerIndex(root);
    expect(idx.match('src/a.ts')).toEqual([]);
    expect(idx.match('nested:')).toEqual([]);
    expect(idx.match('safe/a.ts').map(h => h.body)).toEqual(expected.length ? ['Rule body.'] : []);
    expect(idx.match('other/a.ts')).toEqual([]);
  });

  it('preserves valid quoted comments and literal dashes inside paths entries', async () => {
    const root = tmpRepo();
    write(root, '.claude/rules/dashes.md', '---\npaths:\n  - "src/my-file.ts" # a comment\n  - "src/-draft.ts"\n---\nDashes.');
    const idx = await buildTriggerIndex(root);
    expect(idx.match('src/my-file.ts').map(h => h.body)).toEqual(['Dashes.']);
    expect(idx.match('src/-draft.ts').map(h => h.body)).toEqual(['Dashes.']);
  });

  it('a repo with no .claude/rules directory is fine', async () => {
    const root = tmpRepo();
    expect((await buildTriggerIndex(root)).match(path.join(root, 'x.ts'))).toEqual([]);
  });
});
