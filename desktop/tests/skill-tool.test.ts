// The Skill tool hands the model a skill's instructions as tool output — the
// same shape Claude Code produces by reading SKILL.md itself. It rides
// defineTool() so it inherits truncation and abort labeling like every other tool.
import { describe, it, expect } from 'vitest';
import { createSkillTool } from '../src/main/harness/tools/skill';
import { SkillNotFound, SkillUnreadable, type SkillCatalog } from '../src/main/harness/skills/skill-catalog';

const ctx = {
  sessionId: 's', cwd: '/tmp', signal: new AbortController().signal,
  readRegistry: new Map(), todos: [],
} as any;

function catalogOf(body: string): SkillCatalog {
  return {
    list: () => [{ id: 'journal', description: 'Write a journal entry' }],
    load: (id: string) => {
      if (id !== 'journal') throw new SkillNotFound(id, ['journal']);
      return { id, displayName: 'Journal', description: 'Write a journal entry', body, file: '/tmp/skills/journal/SKILL.md' };
    },
  };
}

describe('Skill tool', () => {
  it('returns the skill body so the model can follow it', async () => {
    const res = await createSkillTool(catalogOf('1. Open the journal.')).execute({ skill: 'journal' }, ctx);
    expect(res.text).toContain('1. Open the journal.');
    expect(res.isError).toBeFalsy();
  });

  it('an unknown skill is an actionable tool result, not a throw', async () => {
    // defineTool relabels a throw as "Skill failed: …", which would bury the list
    // of skills that DO exist — the one thing that lets the model recover.
    const res = await createSkillTool(catalogOf('x')).execute({ skill: 'nope' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('journal');
    expect(res.text).not.toContain('Skill failed:');
  });

  it('an unreadable skill says why, and never returns empty instructions', async () => {
    const broken: SkillCatalog = {
      list: () => [{ id: 'broken', description: 'd' }],
      load: () => { throw new SkillUnreadable('broken', '/x/SKILL.md could not be read (ENOENT)'); },
    };
    const res = await createSkillTool(broken).execute({ skill: 'broken' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('ENOENT');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('the permission subject is the skill id, so a rule can name one skill', () => {
    expect(createSkillTool(catalogOf('x')).permissionSubject({ skill: 'journal' })).toBe('journal');
  });

  it('is NOT interactive — loading instructions is a real effect and must be gated', () => {
    // Interactive routing (harness-session.ts) skips guards AND the permission
    // decision. Correct for AskUserQuestion; wrong for a tool whose output can
    // instruct real side effects.
    expect(createSkillTool(catalogOf('x')).interactive).toBeFalsy();
  });

  it('advertises the installed skills so the model knows what it may ask for', () => {
    const tool = createSkillTool(catalogOf('x'));
    expect(tool.description).toContain('journal');
    expect(tool.description).toContain('Write a journal entry');
  });

  it('the short description carries ids only — it is the small-model variant', () => {
    // buildAiTools swaps in shortDescription under simplified presentation, so it
    // must be genuinely smaller, not a copy of the full text.
    const tool = createSkillTool(catalogOf('x'));
    expect(tool.shortDescription).toContain('journal');
    expect(tool.shortDescription!.length).toBeLessThan(tool.description.length);
  });
});
