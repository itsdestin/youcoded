import { describe, it, expect } from 'vitest';
import { decidePermission } from '../src/main/harness/permission-engine';
import { rulesForMode, DESTRUCTIVE_DENY_LIST } from '../src/shared/permission-types';

const layers = (mode: 'ask' | 'auto-edit' | 'full-auto', remembered = [] as any[]) => ({
  presetRules: [],
  modeRules: rulesForMode(mode),
  denyList: DESTRUCTIVE_DENY_LIST,
  rememberedRules: remembered,
});

describe('decidePermission', () => {
  it('ask mode: reads allow, edits ask', () => {
    expect(decidePermission('Read', 'src/a.ts', layers('ask')).action).toBe('allow');
    expect(decidePermission('Edit', 'src/a.ts', layers('ask')).action).toBe('ask');
    expect(decidePermission('Bash', 'ls', layers('ask')).action).toBe('ask');
  });
  it('web tools are free in every mode baseline', () => {
    for (const mode of ['ask', 'auto-edit', 'full-auto'] as const) {
      const ws = decidePermission('WebSearch', 'anything', layers(mode));
      expect(ws).toMatchObject({ action: 'allow', denyListed: false });
      const wf = decidePermission('WebFetch', 'https://example.com', layers(mode));
      expect(wf).toMatchObject({ action: 'allow', denyListed: false });
    }
  });
  it('auto-edit: edits allow, bash still asks', () => {
    expect(decidePermission('Edit', 'src/a.ts', layers('auto-edit')).action).toBe('allow');
    expect(decidePermission('Bash', 'npm test', layers('auto-edit')).action).toBe('ask');
  });
  it('full-auto allows bash but the deny-list still asks — and flags denyListed', () => {
    expect(decidePermission('Bash', 'npm test', layers('full-auto')).action).toBe('allow');
    const d = decidePermission('Bash', 'git push origin master', layers('full-auto'));
    expect(d.action).toBe('ask');
    expect(d.denyListed).toBe(true);
  });
  it('SendUserFile is allowed in every mode baseline — it reads and writes nothing', () => {
    for (const mode of ['ask', 'auto-edit', 'full-auto'] as const) {
      expect(decidePermission('SendUserFile', '', layers(mode))).toMatchObject({ action: 'allow', denyListed: false });
    }
  });
  it('SendUserLink is allowed in every mode baseline — it only names URLs for the user to click', () => {
    for (const mode of ['ask', 'auto-edit', 'full-auto'] as const) {
      expect(decidePermission('SendUserLink', '', layers(mode))).toMatchObject({ action: 'allow', denyListed: false });
    }
  });
  it('an explicit remembered rule beats the deny-list (spec ruling #2)', () => {
    const d = decidePermission('Bash', 'git push origin master',
      layers('full-auto', [{ tool: 'Bash', pattern: 'git push*', action: 'allow' }]));
    expect(d.action).toBe('allow');
  });
  it('last matching rule wins WITHIN a layer', () => {
    const d = decidePermission('Edit', 'docs/readme.md', {
      presetRules: [], modeRules: [
        { tool: 'Edit', action: 'ask' },
        { tool: 'Edit', pattern: 'docs/*', action: 'allow' },
      ], denyList: [], rememberedRules: [],
    });
    expect(d.action).toBe('allow');
  });
  it('unknown tool with no matching rule defaults to ask (never silent-allow)', () => {
    expect(decidePermission('Mystery', undefined, { presetRules: [], modeRules: [], denyList: [], rememberedRules: [] }).action).toBe('ask');
  });
  it('mode layer overrides preset layer (preset allow, mode ask → ask)', () => {
    const d = decidePermission('Edit', 'src/a.ts', {
      presetRules: [{ tool: 'Edit', action: 'allow' }],
      modeRules: [{ tool: 'Edit', action: 'ask' }],
      denyList: [], rememberedRules: [],
    });
    expect(d.action).toBe('ask');
  });

  // Extra torture cases pinning the semantics table (cheap, obviously correct):
  it('a remembered deny rule wins over a mode allow', () => {
    // full-auto's `{tool:'*', action:'allow'}` is the earliest-layer catch-all;
    // a later remembered 'deny' must still win via last-match-wins.
    const d = decidePermission('Bash', 'anything', layers('full-auto', [
      { tool: 'Bash', action: 'deny' },
    ]));
    expect(d.action).toBe('deny');
    expect(d.denyListed).toBe(false); // winner is the remembered rule, not the deny-list
  });
  it('denyListed is NOT set when a remembered rule outranks the deny-list', () => {
    // The remembered rule wins, so the consequence-gated warning must NOT fire.
    const d = decidePermission('Bash', 'git push origin master',
      layers('full-auto', [{ tool: 'Bash', pattern: 'git push*', action: 'allow' }]));
    expect(d.action).toBe('allow');
    expect(d.denyListed).toBe(false);
  });

  // Task 6 — the Task tool's mode-baseline decision, PINNED (not an accident,
  // per rulesForMode's own comment): under 'ask', the Task call itself is the
  // one moment the user consents to the whole delegated envelope, so it must
  // NOT be in the always-allow baseline. Under auto-edit/full-auto, delegating
  // grants a specialist nothing beyond what those modes already grant the
  // parent directly, so Task is allowed with no extra ask.
  it('Task asks under ask mode (the ask IS the envelope-consent moment)', () => {
    expect(decidePermission('Task', 'src', layers('ask')).action).toBe('ask');
  });
  it('Task is auto-allowed under auto-edit and full-auto', () => {
    expect(decidePermission('Task', 'src', layers('auto-edit')).action).toBe('allow');
    expect(decidePermission('Task', 'src', layers('full-auto')).action).toBe('allow');
  });

  // D1 (2026-08-26) — the walk-away autonomy above was granted for BUILT-IN
  // helpers, whose behaviour ships with the app. It was silently covering
  // file-defined helpers too, because the baseline Task rule carries no
  // pattern: in auto-edit no consent card rendered at all, which bypassed both
  // halves of the plan-1c hire-grant design at once. A file-defined hire's
  // subject contains ':file:' (tools/task.ts) and a built-in's never does.
  it('auto-edit: a BUILT-IN hire still runs with no ask (unchanged)', () => {
    expect(decidePermission('Task', 'read-write:/proj', layers('auto-edit')).action).toBe('allow');
  });
  it('auto-edit: a FILE-DEFINED hire asks — user-scoped and project-scoped alike', () => {
    expect(decidePermission('Task', 'read-only:file:code-reviewer@abc123abc123', layers('auto-edit')).action)
      .toBe('ask');
    expect(decidePermission('Task', 'read-write:/proj:file:repo-worker@abc123abc123', layers('auto-edit')).action)
      .toBe('ask');
  });
  it('auto-edit: a remembered grant still wins over that ask (the always-allow has to mean something)', () => {
    const subject = 'read-only:file:code-reviewer@abc123abc123';
    const remembered = [{ tool: 'Task', pattern: subject, action: 'allow', match: 'exact' }];
    expect(decidePermission('Task', subject, layers('auto-edit', remembered)).action).toBe('allow');
  });
  it('full-auto is unchanged — it allows everything by explicit choice', () => {
    expect(decidePermission('Task', 'read-only:file:code-reviewer@abc123abc123', layers('full-auto')).action)
      .toBe('allow');
  });

  // Task 6 review fix 4: the Task tool's consent key is now CHARTER-SCOPED
  // (`${charter}:${work_dir}`, tools/task.ts's permissionSubject) precisely so
  // a remembered "Always allow" earned by a read-only specialist can never
  // silently cover a read-write one at the same path — the charter is the
  // unit of envelope consent (spec §5). subjectMatches does exact/glob text
  // matching with no charter-awareness of its own, so this is a property of
  // the SUBJECT SHAPE, not of decidePermission's logic — proving it here
  // (rather than only where the subject is built) pins that the two stay in
  // sync: if a future change made the two charters share a prefix or dropped
  // the charter from one side, this is what would catch it.
  it("a remembered rule scoped to 'read-only:/proj' does NOT match a 'read-write:/proj' subject — a standing grant never crosses charters", () => {
    const d = decidePermission('Task', 'read-write:/proj',
      layers('ask', [{ tool: 'Task', pattern: 'read-only:/proj', action: 'allow' }]));
    expect(d.action).toBe('ask');   // falls through to the safe default — no match, never silent-allow
  });

  it('…but the SAME charter at the same path does match (sanity check the pattern above isn\'t just never matching)', () => {
    const d = decidePermission('Task', 'read-write:/proj',
      layers('ask', [{ tool: 'Task', pattern: 'read-write:/proj', action: 'allow' }]));
    expect(d.action).toBe('allow');
  });
});

describe('decidePermission with the matcher safety rules', () => {
  const remembered = [{
    tool: 'Bash', action: 'allow' as const, match: 'glob' as const,
    pattern: 'git push*origin feat/x',
  }];

  it('the grant covers its own branch', () => {
    expect(decidePermission('Bash', 'git push origin feat/x', layers('full-auto', remembered)))
      .toEqual({ action: 'allow', denyListed: false });
  });

  it('another branch is not covered — the deny-list layer wins and it still asks', () => {
    expect(decidePermission('Bash', 'git push origin master', layers('full-auto', remembered)))
      .toEqual({ action: 'ask', denyListed: true });
  });

  it('a destructive flag on the granted branch still asks', () => {
    expect(decidePermission('Bash', 'git push --delete origin feat/x', layers('full-auto', remembered)))
      .toEqual({ action: 'ask', denyListed: true });
  });

  it('Full-auto still allows an ordinary chained command with no grant at all', () => {
    // Safety rule 1 narrows GRANTS, not the '*' mode baseline — Full-auto has no
    // pattern, so a chained command it never asked about is unaffected.
    expect(decidePermission('Bash', 'ls -la && pwd', layers('full-auto', remembered)))
      .toEqual({ action: 'allow', denyListed: false });
  });
});

// Product decision (doc-comments follow-up, 2026-09-27): the assistant asks
// before changing comments ONLY on Word/Excel files, and never asks for
// plain-text/markdown/code comments or for reading comments at all.
describe('doc-comments tools follow the same tier Edit/Write already have, per mode', () => {
  const MUTATIONS = ['ReplyToComment', 'ResolveComment', 'ReopenComment', 'AddComment', 'MoveComment'] as const;

  it('ask mode: ReadFileComments is always allow, whatever the target', () => {
    expect(decidePermission('ReadFileComments', 'docs/plan.md', layers('ask')).action).toBe('allow');
    expect(decidePermission('ReadFileComments', 'docs/brief.docx', layers('ask')).action).toBe('allow');
    expect(decidePermission('ReadFileComments', undefined, layers('ask')).action).toBe('allow');
  });

  it('ask mode: a mutation on a plain-text/markdown/code target allows, including the undefined subject a real call carries', () => {
    for (const tool of MUTATIONS) {
      // A plain-text/markdown/code target's permissionSubject is undefined
      // (doc-comments-tools.ts) — decidePermission sees `subject ?? ''`.
      expect(decidePermission(tool, undefined, layers('ask')).action, tool).toBe('allow');
      expect(decidePermission(tool, 'docs/plan.md', layers('ask')).action, tool).toBe('allow');
      expect(decidePermission(tool, 'notes/readme', layers('ask')).action, tool).toBe('allow');
    }
  });

  it('ask mode: a mutation on a .docx/.xlsx target asks, matching Edit/Write\'s own tier there', () => {
    for (const tool of MUTATIONS) {
      expect(decidePermission(tool, 'docs/brief.docx', layers('ask')).action, tool).toBe('ask');
      expect(decidePermission(tool, 'reports/q3.xlsx', layers('ask')).action, tool).toBe('ask');
    }
  });

  it('ask mode: the .docx/.xlsx match is case-insensitive and survives an absolute Windows path', () => {
    for (const tool of MUTATIONS) {
      expect(decidePermission(tool, 'C:\\Users\\dest\\Reports\\Q3.XLSX', layers('ask')).action, tool).toBe('ask');
      expect(decidePermission(tool, '/home/dest/docs/BRIEF.DOCX', layers('ask')).action, tool).toBe('ask');
    }
  });

  it('auto-edit: a mutation on a .docx/.xlsx target allows, the same tier Edit/Write already get in this mode', () => {
    for (const tool of MUTATIONS) {
      expect(decidePermission(tool, 'docs/brief.docx', layers('auto-edit')).action, tool).toBe('allow');
      expect(decidePermission(tool, 'reports/q3.xlsx', layers('auto-edit')).action, tool).toBe('allow');
      expect(decidePermission(tool, 'docs/plan.md', layers('auto-edit')).action, tool).toBe('allow');
    }
  });

  it('full-auto allows every doc-comments tool regardless of target, same as everything else in that mode', () => {
    for (const tool of [...MUTATIONS, 'ReadFileComments']) {
      expect(decidePermission(tool, 'docs/brief.docx', layers('full-auto')).action, tool).toBe('allow');
    }
  });

  it('a remembered deny on a specific Word file still wins over the mode-baseline ask (and the plain-text allow)', () => {
    const remembered = [{ tool: 'ReplyToComment', pattern: 'docs/brief.docx', action: 'deny' as const }];
    expect(decidePermission('ReplyToComment', 'docs/brief.docx', layers('ask', remembered)).action).toBe('deny');
    // A deny scoped to one exact file must not leak onto a different one.
    expect(decidePermission('ReplyToComment', 'docs/other.docx', layers('ask', remembered)).action).toBe('ask');
  });

  it('an "Always allow" grant for one exact Word file keeps working under ask mode, exactly like it already does for Edit', () => {
    const remembered = [{ tool: 'ReplyToComment', pattern: 'docs/brief.docx', action: 'allow' as const, match: 'exact' as const }];
    expect(decidePermission('ReplyToComment', 'docs/brief.docx', layers('ask', remembered)).action).toBe('allow');
    // The grant is scoped to the ONE file it was given for.
    expect(decidePermission('ReplyToComment', 'docs/other.docx', layers('ask', remembered)).action).toBe('ask');
  });
});
