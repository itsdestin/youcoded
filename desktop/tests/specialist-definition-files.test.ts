import { describe, it, expect } from 'vitest';
import {
  loadPersonalDefinition,
  loadClaudeCodeDefinition,
  deriveCharter,
  slugifyId,
  READ_ONLY_DEFAULT_TOOLS,
  STARTER_FILE_NAME,
  STARTER_FILE_CONTENTS,
} from '../src/main/harness/specialists/definition-files';
import { BUILTIN_SPECIALISTS } from '../src/main/harness/specialists/builtins';

// One `it` per row of spec §3.2 (the Claude Code mapping table) plus the
// personal-format rules above it — every mapping rule earns its own test so a
// future edit to the table can't silently drop a row without a red test.
describe('loadPersonalDefinition', () => {
  it('personal: omitted tools → read-only trio + warning', () => {
    const result = loadPersonalDefinition('/x/foo.md', '---\ndescription: Test specialist.\n---\nDo the thing.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(READ_ONLY_DEFAULT_TOOLS);
    expect(result.value.warnings).toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  it('personal: unknown tool stripped with a warning naming it', () => {
    const raw = '---\ndescription: Test.\ntools: [Read, Frobnicate, Sparkle]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain(
      '2 tools this file asked for don’t exist here and were removed: Frobnicate, Sparkle',
    );
  });

  it('personal: a single unknown tool uses singular grammar', () => {
    const raw = '---\ndescription: Test.\ntools: [Read, Frobnicate]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain('1 tool this file asked for doesn’t exist here and was removed: Frobnicate');
  });

  it('personal: Task is always stripped', () => {
    const raw = '---\ndescription: Test.\ntools: [Read, Task]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain('specialists can’t hire specialists — Task was removed');
  });

  it('personal: charter is DERIVED — a file cannot claim read-only while holding Bash', () => {
    const raw = '---\ndescription: Test.\ncharter: read-only\ntools: [Bash]\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.charter).toBe('read-write');
    expect(result.value.warnings).toContain('charter is not a setting — it follows the tools');
  });

  it('personal: legacy stepCap is ignored without a warning or stepCap', () => {
    const raw = '---\ndescription: Test.\nstepCap: 1\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition).not.toHaveProperty('stepCap');
    expect(result.value.warnings.some((warning) => warning.includes('stepCap'))).toBe(false);
  });

  it('personal: empty body → error', () => {
    const raw = '---\ndescription: Test.\n---\n   \n';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('no instructions below the frontmatter');
  });

  it('personal: description required — missing → error', () => {
    const result = loadPersonalDefinition('/x/foo.md', '---\nname: Foo\n---\nDo the thing.');
    expect(result.ok).toBe(false);
  });

  it('personal: id defaults to the filename stem, slugified', () => {
    const result = loadPersonalDefinition('/some/dir/Docs Writer.md', '---\ndescription: Test.\n---\nDo the thing.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.id).toBe('docs-writer');
  });

  // Fix 1 (review): a blank `tools:` scalar must fall back to the read-only
  // default + warning, same as an omitted key — not resolve to an explicit
  // empty list, which would silently strip a half-finished file down to a
  // specialist that can't even Read with no warning at all.
  it('personal: a blank tools: line falls back to read-only + warning, not a silent empty list', () => {
    const raw = '---\ndescription: Test.\ntools:\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(READ_ONLY_DEFAULT_TOOLS);
    expect(result.value.warnings).toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  it('personal: an explicit tools: [] still yields an empty list, no fallback', () => {
    const raw = '---\ndescription: Test.\ntools: []\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual([]);
    expect(result.value.warnings).not.toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  // Fix 2 (review): an explicit id is still slugified (it becomes part of a
  // permission key and the tool list the model reads, so it has to be safe)
  // but the file gets to see what happened, unlike every other silent
  // transform in this file.
  it('personal: an explicit id that gets slugified is announced, naming both values', () => {
    const raw = '---\ndescription: Test.\nid: My Cool ID!\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.id).toBe('my-cool-id');
    expect(result.value.warnings.some((w) => w.includes('My Cool ID!') && w.includes('my-cool-id'))).toBe(true);
  });

  // Fix (review): a blank `id:` line must fall back to the filename stem,
  // same as an omitted `id:` key — not resolve to a silent `id: ''`.
  it('personal: a blank id: line falls back to the filename stem, not an empty id', () => {
    const raw = '---\ndescription: Test.\nid:\n---\nDo the thing.';
    const result = loadPersonalDefinition('/some/dir/Docs Writer.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.id).toBe('docs-writer');
    expect(result.value.warnings.some((w) => w.startsWith('id:'))).toBe(false);
  });

  it('personal: an already-clean explicit id produces no warning', () => {
    const raw = '---\ndescription: Test.\nid: my-clean-id\n---\nDo the thing.';
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.id).toBe('my-clean-id');
    expect(result.value.warnings.some((w) => w.startsWith('id:'))).toBe(false);
  });
});

describe('loadClaudeCodeDefinition', () => {
  it('cc: comma-separated tools parse', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, Grep, Bash\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('cc: MultiEdit → Edit warning', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, MultiEdit\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain('MultiEdit was removed — Edit covers it');
  });

  it('cc: a single unavailable tool uses singular grammar', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, mcp__foo__bar\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain(
      '1 tool this file asked for isn’t available to helpers here and was removed: mcp__foo__bar',
    );
  });

  it('cc: mcp__* stripped', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, NotebookEdit, mcp__foo__bar\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain(
      '2 tools this file asked for aren’t available to helpers here and were removed: NotebookEdit, mcp__foo__bar',
    );
  });

  it('cc: Task/Agent always stripped', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, Task, Agent\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read']);
    expect(result.value.warnings).toContain('specialists can’t hire specialists — Task was removed');
  });

  it('cc: omitted tools → read-only + warning', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(READ_ONLY_DEFAULT_TOOLS);
    expect(result.value.warnings).toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  // Fix 1 (review): same fallback as the personal format — a blank `tools:`
  // scalar in a CC-style file must not resolve to a silent empty list.
  it('cc: a blank tools: line falls back to read-only + warning, not a silent empty list', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools:\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(READ_ONLY_DEFAULT_TOOLS);
    expect(result.value.warnings).toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  // Fix 3 (review): the CC loader's empty-body error duplicates the personal
  // loader's, but only the personal path had a test for it.
  it('cc: empty body → error', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\n---\n   \n';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('no instructions below the frontmatter');
  });

  // Fix 2 (review): the CC loader's explicit-empty-list rule duplicates the
  // personal loader's, but only the personal format had a regression test.
  it('cc: an explicit tools: [] still yields an empty list, no fallback', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: []\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual([]);
    expect(result.value.warnings).not.toContain('no tools listed — read-only by default; add `tools:` to widen');
  });

  it('cc: disallowedTools subtracts after mapping', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ntools: Read, Write, Edit, Bash\ndisallowedTools: Bash\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.allowedTools).toEqual(['Read', 'Write', 'Edit']);
  });

  it('cc: model haiku→budget, opus→frontier, sonnet→parent, weird→parent+warning', () => {
    const haiku = loadClaudeCodeDefinition('/agents/a.md', '---\nname: A\ndescription: Test.\nmodel: haiku\n---\nDo it.', 'user');
    const opus = loadClaudeCodeDefinition('/agents/b.md', '---\nname: B\ndescription: Test.\nmodel: opus\n---\nDo it.', 'user');
    const sonnet = loadClaudeCodeDefinition('/agents/c.md', '---\nname: C\ndescription: Test.\nmodel: sonnet\n---\nDo it.', 'user');
    const inherit = loadClaudeCodeDefinition('/agents/e.md', '---\nname: E\ndescription: Test.\nmodel: inherit\n---\nDo it.', 'user');
    const weird = loadClaudeCodeDefinition('/agents/d.md', '---\nname: D\ndescription: Test.\nmodel: gpt-5\n---\nDo it.', 'user');
    expect(haiku.ok && haiku.value.definition.modelPreference).toBe('budget');
    expect(opus.ok && opus.value.definition.modelPreference).toBe('frontier');
    expect(sonnet.ok && sonnet.value.definition.modelPreference).toBe('parent');
    expect(inherit.ok && inherit.value.definition.modelPreference).toBe('parent');
    expect(weird.ok && weird.value.definition.modelPreference).toBe('parent');
    // Fix 4 (review): "using the default (parent)" is meaningless jargon to a
    // non-developer reading only this string — it must spell out what
    // "parent" means, same gloss as the starter file uses.
    expect(
      weird.ok &&
        weird.value.warnings.some(
          (w) => w.includes('gpt-5') && w.includes('the same model your main assistant is already running on'),
        ),
    ).toBe(true);
  });

  it('cc: legacy maxTurns is ignored without a warning or stepCap', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\nmaxTurns: 12\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition).not.toHaveProperty('stepCap');
    expect(result.value.warnings.some((warning) => warning.includes('maxTurns'))).toBe(false);
  });

  it('cc: permissionMode → warning, never a failure', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\npermissionMode: bypassPermissions\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain(
      'permissionMode is ignored — helpers ask through the assistant, and approving the hire is the grant',
    );
  });

  it('cc: hooks/skills → warning, never a failure', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\nhooks:\n  pre:\n    command: foo\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toContain('hooks/skills in this file don’t run for helpers');
  });

  it('cc: color/memory ignored silently', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\ncolor: blue\nmemory: something\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.some((w) => w.toLowerCase().includes('color') || w.toLowerCase().includes('memory'))).toBe(false);
  });

  it('cc: missing name → error', () => {
    const result = loadClaudeCodeDefinition('/agents/docs-writer.md', '---\ndescription: Test.\n---\nDo the thing.', 'user');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('Claude Code agent files need a `name:`');
  });

  it('cc: id is the slug of name', () => {
    const raw = '---\nname: Docs Writer\ndescription: Test.\n---\nDo the thing.';
    const result = loadClaudeCodeDefinition('/agents/some-file-name.md', raw, 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.id).toBe('docs-writer');
  });
});

describe('both loaders', () => {
  it('both: prompt is wrapped in the shared prefix/suffix', () => {
    const sharedPrefix = BUILTIN_SPECIALISTS[0].systemPrompt.split('\n\n')[0];
    const personal = loadPersonalDefinition('/x/foo.md', '---\ndescription: Test.\n---\nDo the thing.');
    const cc = loadClaudeCodeDefinition('/agents/foo.md', '---\nname: Foo\ndescription: Test.\n---\nDo the thing.', 'user');
    expect(personal.ok && personal.value.definition.systemPrompt.startsWith(sharedPrefix)).toBe(true);
    expect(cc.ok && cc.value.definition.systemPrompt.startsWith(sharedPrefix)).toBe(true);
  });

  it('both: a 2,000-char description is cut to 300 in the definition, kept whole in fullDescription, and warned', () => {
    const longDescription = 'x'.repeat(2000);
    const raw = `---\ndescription: ${longDescription}\n---\nDo the thing.`;
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.description.length).toBe(300);
    expect(result.value.definition.description.endsWith('…')).toBe(true);
    expect(result.value.fullDescription).toBe(longDescription);
    expect(result.value.warnings).toContain(
      "description shortened to 300 characters for the assistant's tool list — the full text is here",
    );
  });

  it('both: a description exactly at the cap is not cut and carries no fullDescription', () => {
    const exact300 = 'x'.repeat(300);
    const raw = `---\ndescription: ${exact300}\n---\nDo the thing.`;
    const result = loadPersonalDefinition('/x/foo.md', raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definition.description).toBe(exact300);
    expect(result.value.fullDescription).toBeUndefined();
  });

  it('both: source is stamped', () => {
    const personal = loadPersonalDefinition('/x/foo.md', '---\ndescription: Test.\n---\nDo the thing.');
    const cc = loadClaudeCodeDefinition('/agents/foo.md', '---\nname: Foo\ndescription: Test.\n---\nDo the thing.', 'user');
    expect(personal.ok && personal.value.definition.source).toBe('personal');
    expect(cc.ok && cc.value.definition.source).toBe('claude-code');
  });

  // D2 (2026-08-26) — grantScope decides how wide an "Always allow" on this
  // helper may be, and the fingerprint is what makes that grant expire when the
  // file changes. Both ride INSIDE the permission subject (tools/task.ts), so
  // neither had a test before this one: `tsconfig.json` includes only `src/**`,
  // so a two-argument call in this file compiled fine and simply ran with
  // grantScope: undefined.
  it('both: the personal folder is always the USER\'s own — grantScope is not a parameter there', () => {
    const personal = loadPersonalDefinition('/x/foo.md', '---\ndescription: Test.\n---\nDo the thing.');
    expect(personal.ok && personal.value.definition.grantScope).toBe('user');
  });

  it('cc: grantScope is whatever the CALLER (the catalog) says the folder was', () => {
    const raw = '---\nname: Foo\ndescription: Test.\n---\nDo the thing.';
    const user = loadClaudeCodeDefinition('/home/d/.claude/agents/foo.md', raw, 'user');
    const project = loadClaudeCodeDefinition('/work/proj/.claude/agents/foo.md', raw, 'project');
    expect(user.ok && user.value.definition.grantScope).toBe('user');
    expect(project.ok && project.value.definition.grantScope).toBe('project');
  });

  it('both: the fingerprint is 12 hex characters, stable for the same bytes and different for different ones', () => {
    const a = '---\ndescription: Test.\n---\nDo the thing.';
    const b = '---\ndescription: Test.\n---\nDo the thing, plus Bash.';
    const first = loadPersonalDefinition('/x/foo.md', a);
    const again = loadPersonalDefinition('/x/foo.md', a);
    const edited = loadPersonalDefinition('/x/foo.md', b);
    // Every load must succeed FIRST: `first.ok && again.ok && fp` compared to
    // `again.ok && fp` would pass as `false === false` if a load failed, and the
    // whole "stable" claim below would be vacuous.
    expect([first.ok, again.ok, edited.ok]).toEqual([true, true, true]);
    expect(first.ok && first.value.definition.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // Same bytes, same subject — otherwise a standing grant would expire on
    // every read and the user would be asked again forever.
    expect(first.ok && again.ok && first.value.definition.fingerprint)
      .toBe(again.ok && again.value.definition.fingerprint);
    // Different bytes, different subject — this IS the "edit the file and you
    // are asked again" promise the card makes.
    expect(first.ok && edited.ok && first.value.definition.fingerprint)
      .not.toBe(edited.ok && edited.value.definition.fingerprint);
    // The PATH is not part of it: the same bytes hash the same wherever the file
    // sits, and only grantScope decides how wide the grant is.
    const named = '---\nname: Foo\ndescription: Test.\n---\nDo the thing.';
    const ccUser = loadClaudeCodeDefinition('/home/d/.claude/agents/foo.md', named, 'user');
    const ccProject = loadClaudeCodeDefinition('/work/proj/.claude/agents/foo.md', named, 'project');
    expect([ccUser.ok, ccProject.ok]).toEqual([true, true]);
    expect(ccUser.ok && ccUser.value.definition.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(ccUser.ok && ccUser.value.definition.fingerprint)
      .toBe(ccProject.ok && ccProject.value.definition.fingerprint);
  });
});

describe('deriveCharter', () => {
  it('is read-write when the tools include Write, Edit, or Bash', () => {
    expect(deriveCharter(['Read', 'Write'])).toBe('read-write');
    expect(deriveCharter(['Read', 'Edit'])).toBe('read-write');
    expect(deriveCharter(['Read', 'Bash'])).toBe('read-write');
  });

  it('is read-only otherwise', () => {
    expect(deriveCharter(['Read', 'Glob', 'Grep'])).toBe('read-only');
    expect(deriveCharter([])).toBe('read-only');
  });
});

describe('slugifyId', () => {
  it('lowercases, replaces non-alphanumerics with dashes, collapses runs, and trims', () => {
    expect(slugifyId('Docs Writer')).toBe('docs-writer');
    expect(slugifyId('  Foo__Bar!!  ')).toBe('foo-bar');
    expect(slugifyId('already-a-slug')).toBe('already-a-slug');
  });
});

describe('STARTER_FILE_CONTENTS', () => {
  it('STARTER_FILE_CONTENTS parses as a valid personal definition with zero warnings', () => {
    const result = loadPersonalDefinition(`/whatever/${STARTER_FILE_NAME}`, STARTER_FILE_CONTENTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toEqual([]);
  });

  it('lists tools: explicitly', () => {
    expect(STARTER_FILE_CONTENTS).toMatch(/^tools:/m);
  });
});
