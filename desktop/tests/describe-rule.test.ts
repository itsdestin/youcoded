import { describe, it, expect } from 'vitest';
import { describeRule, ruleKind } from '../src/renderer/components/permissions/describe-rule';

describe('describeRule', () => {
  it('renders a Bash grant as the command it runs', () => {
    expect(describeRule({ tool: 'Bash', pattern: 'git push origin main', action: 'allow' }))
      .toEqual({ verb: 'Run', subject: 'git push origin main', width: 'exact' });
  });

  it('renders file tools with their path', () => {
    expect(describeRule({ tool: 'Edit', pattern: 'src/a.ts', action: 'allow' }))
      .toEqual({ verb: 'Edit', subject: 'src/a.ts', width: 'exact' });
    expect(describeRule({ tool: 'Write', pattern: 'src/b.ts', action: 'allow' }))
      .toEqual({ verb: 'Create or overwrite', subject: 'src/b.ts', width: 'exact' });
  });

  it('names the server and tool for an MCP grant', () => {
    expect(describeRule({ tool: 'mcp__github__create_issue', action: 'allow' }))
      .toEqual({ verb: 'Use the create_issue tool from the github connection', width: 'exact' });
  });

  // A server id containing a double underscore must not swallow the tool name.
  it('splits an MCP id on the FIRST separator after the prefix', () => {
    expect(describeRule({ tool: 'mcp__my__server__do_thing', action: 'allow' }).verb)
      .toBe('Use the server__do_thing tool from the my connection');
  });

  it('flags a pattern-less grant as tool-wide', () => {
    expect(describeRule({ tool: 'Write', action: 'allow' }))
      .toEqual({ verb: 'Create or overwrite', subject: undefined, width: 'tool-wide' });
  });

  // The type permits deny; nothing writes one today, but the UI must not
  // render a deny rule as though it were a grant.
  it('describes a deny rule as a block', () => {
    expect(describeRule({ tool: 'Bash', pattern: 'sudo *', action: 'deny' }))
      .toEqual({ verb: 'Never run', subject: 'sudo *', width: 'exact' });
  });

  it('falls back to the tool name for an unknown tool', () => {
    expect(describeRule({ tool: 'SomeFutureTool', pattern: 'x', action: 'allow' }))
      .toEqual({ verb: 'Use SomeFutureTool', subject: 'x', width: 'exact' });
  });

  // Fix 1 — remembered Task grants must read as plain language, never the raw
  // `${charter}:${work_dir}` envelope key task.ts's permissionSubject mints,
  // and never say "Task" out loud (model-facing vocabulary; the spec's word
  // for the user is "specialist").
  describe('Task grants (plain-language specialist copy)', () => {
    it('renders a read-only charter subject', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a read-only specialist work in', subject: '/home/x/proj', width: 'exact' });
    });

    it('renders a read-write charter subject', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-write:/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a specialist edit files in', subject: '/home/x/proj', width: 'exact' });
    });

    // The unknown-agent fallback in task.ts's permissionSubject — no charter
    // prefix, just the bare work_dir.
    it('renders a bare-path pattern (unknown-agent fallback) without a charter prefix', () => {
      expect(describeRule({ tool: 'Task', pattern: '/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a specialist work in', subject: '/home/x/proj', width: 'exact' });
    });

    it('renders a pattern-less Task grant as broad, in plain language', () => {
      expect(describeRule({ tool: 'Task', action: 'allow' }))
        .toEqual({ verb: 'Let specialists work anywhere in this project', width: 'tool-wide' });
    });

    it('groups under "commands", not the "other" catch-all', () => {
      expect(ruleKind({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' })).toBe('commands');
    });
  });

  // D2 (2026-08-26): a grant on a FILE-DEFINED helper carries the helper's own
  // id and its file's content hash — `read-only:file:code-reviewer@a1b2c3d4e5f6`
  // (everywhere) or `read-write:/work/proj:file:repo-worker@…` (that folder
  // only). Rendered by the plain charter branches these read as a DIRECTORY
  // literally named "file:code-reviewer@a1b2c3…": internal syntax on a screen
  // written for non-developers, naming no helper the user recognises, and
  // describing the everywhere-grant as if it were pinned to a place. The words
  // ARE the feature here, so they are what these pin.
  describe('file-defined helper grants (D2)', () => {
    it('a user-folder grant reads as covering every project, with no subject to imply a place', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-write:file:docs-writer@aaaaaaaaaaaa', action: 'allow' }))
        .toEqual({ verb: 'Let the docs-writer specialist edit files in every project', subject: undefined, width: 'exact' });
    });

    it('a project-scoped grant names the folder it is pinned to', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/work/proj:file:repo-reviewer@bbbbbbbbbbbb', action: 'allow' }))
        .toEqual({ verb: 'Let the repo-reviewer specialist work in', subject: '/work/proj', width: 'exact' });
    });

    // The new branch runs FIRST, ahead of the two charter-prefix branches, so
    // this is the regression that matters: a built-in's grant (no `file:`
    // segment) must render exactly as it did before the branch existed.
    it('a built-in grant is untouched by the new branch', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-write:/work/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a specialist edit files in', subject: '/work/proj', width: 'exact' });
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/work/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a read-only specialist work in', subject: '/work/proj', width: 'exact' });
    });

    // Review-2 minor 3: the hash part was `[0-9a-f]+`, so the one non-hex value
    // tools/task.ts can actually substitute — the literal 'unverified', used
    // when a definition somehow carries no fingerprint — fell through to the
    // plain-charter branch and rendered as a directory literally named
    // "file:docs-writer@unverified". Nothing after the final '@' is ever shown,
    // so the sentence is the same one; only the syntax leak is gone.
    it('reads in words even when the fingerprint is the literal "unverified"', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-write:file:docs-writer@unverified', action: 'allow' }))
        .toEqual({ verb: 'Let the docs-writer specialist edit files in every project', subject: undefined, width: 'exact' });
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/work/proj:file:repo-reviewer@unverified', action: 'allow' }))
        .toEqual({ verb: 'Let the repo-reviewer specialist work in', subject: '/work/proj', width: 'exact' });
    });

    // The whole point of the branch: nothing the user reads may carry the
    // content hash or the internal `file:` marker.
    it('never leaks the hash or the file: marker into what the screen shows', () => {
      const patterns = [
        'read-write:file:docs-writer@aaaaaaaaaaaa',
        'read-only:/work/proj:file:repo-reviewer@bbbbbbbbbbbb',
        'read-write:file:docs-writer@unverified',
      ];
      for (const pattern of patterns) {
        const d = describeRule({ tool: 'Task', pattern, action: 'allow' });
        expect(`${d.verb} ${d.subject ?? ''}`).not.toContain('file:');
        expect(`${d.verb} ${d.subject ?? ''}`).not.toMatch(/@[0-9a-f]{4}/);
      }
    });
  });

  // Task 11: a specialist-keyed rule must read as what it actually is — the
  // assistant itself never gets this permission, only a specialist working
  // under it does. Plain language, no jargon (project constraint).
  describe('specialist-keyed rules', () => {
    // Fix 3: the display NAME ("Worker"), never the raw internal agentType id
    // ("worker") — every other user-facing site (e.g. tools/task.ts's error
    // copy) names a specialist this way.
    it('names the specialist in the verb by its DISPLAY NAME, reusing the ordinary tool verb', () => {
      expect(describeRule({ tool: 'Bash', pattern: 'npm test*', action: 'allow', specialist: 'worker' }))
        .toEqual({ verb: 'Let the Worker specialist run', subject: 'npm test*', width: 'exact' });
    });

    it('still reports breadth correctly for a pattern-less specialist grant', () => {
      expect(describeRule({ tool: 'Write', action: 'allow', specialist: 'worker' }))
        .toEqual({ verb: 'Let the Worker specialist create or overwrite', subject: undefined, width: 'tool-wide' });
    });

    it('an unscoped rule (no specialist) is unaffected', () => {
      expect(describeRule({ tool: 'Bash', pattern: 'npm test*', action: 'allow' }))
        .toEqual({ verb: 'Run', subject: 'npm test*', width: 'exact' });
    });

    // A future specialist added to the registry but not yet mirrored in this
    // file's local display-name table must still read as a name, not crash
    // or render blank.
    it('falls back to capitalizing an unmapped specialist id', () => {
      expect(describeRule({ tool: 'Bash', pattern: 'x*', action: 'allow', specialist: 'archivist' }))
        .toEqual({ verb: 'Let the Archivist specialist run', subject: 'x*', width: 'exact' });
    });
  });

  // M5 2c: 'broad' was a boolean, and an exact grant and a scoped one are BOTH
  // "not broad" while covering wildly different amounts. The screen has to tell
  // them apart, so the flag became a three-way width.
  describe('width', () => {
    it('a legacy rule with no match reads as exact — PermissionStore normalizes on read', () => {
      expect(describeRule({ tool: 'Bash', pattern: 'ls -la', action: 'allow' }).width).toBe('exact');
      expect(describeRule({ tool: 'Bash', pattern: 'ls -la', action: 'allow', match: 'exact' }).width).toBe('exact');
    });

    it('a scoped push rule is wide and reads as a whole sentence', () => {
      const d = describeRule({
        tool: 'Bash', pattern: 'git push*origin master', action: 'allow', match: 'glob',
      });
      expect(d.width).toBe('wide');
      expect(d.verb).toBe('Pushing to master');
      expect(d.subject).toBeUndefined();
    });

    it('a generic wide rule reads as its own sentence too', () => {
      expect(describeRule({ tool: 'Bash', pattern: 'npm run*', action: 'allow', match: 'glob' }).verb)
        .toBe('Any npm run command');
    });

    it('a wide pattern this module cannot phrase falls back to verb + subject', () => {
      // Not a shape this app produces; the screen still renders something honest
      // rather than inventing a sentence.
      const d = describeRule({ tool: 'Bash', pattern: 'we?rd', action: 'allow', match: 'glob' });
      expect(d.verb).toBe('Run');
      expect(d.subject).toBe('we?rd');
      expect(d.width).toBe('wide');
    });

    it('an MCP grant reports exact, not tool-wide', () => {
      expect(describeRule({ tool: 'mcp__srv__tool', action: 'allow' }).width).toBe('exact');
    });

    it('a specialist grant keeps its own sentence and its own width', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' }).width).toBe('exact');
      expect(describeRule({ tool: 'Task', action: 'allow' }).width).toBe('tool-wide');
    });

    it('a remembered grant for a comment-mutation tool files under "files", same as Edit/Write', () => {
      // T8 review F1: every one of these tools' remembered rules is, by
      // construction, a Word/Excel-targeted write (the plain-text case never
      // prompts, so no "Always allow" ever exists for it) — so it should sit
      // next to a remembered Edit/Write grant on the same file, not under the
      // `other` catch-all a specialist or unrecognized future tool falls into.
      for (const tool of ['ReplyToComment', 'ResolveComment', 'ReopenComment', 'AddComment', 'MoveComment']) {
        expect(ruleKind({ tool, pattern: 'docs/brief.docx', action: 'allow' }), tool).toBe('files');
      }
    });

    it('ReadFileComments stays uncategorized, same as Read — it never mutates anything', () => {
      expect(ruleKind({ tool: 'ReadFileComments', action: 'allow' })).toBe('other');
      expect(ruleKind({ tool: 'Read', action: 'allow' })).toBe('other');
    });

    it('no description ever contains rule syntax', () => {
      const rules = [
        { tool: 'Bash', pattern: 'git push*origin master', action: 'allow' as const, match: 'glob' as const },
        { tool: 'Bash', pattern: 'npm run*', action: 'allow' as const, match: 'glob' as const },
        { tool: '*', action: 'allow' as const },
      ];
      for (const r of rules) {
        const d = describeRule(r);
        expect(`${d.verb} ${d.subject ?? ''}`).not.toMatch(/[*?]/);
      }
    });
  });
});
