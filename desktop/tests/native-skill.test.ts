// Native skills, two halves. (1) /skill-name must work on EVERY model, including small local ones that never
// get the Skill tool: an unrecognized slash command carries an `invoke-skill` intent alongside `handled: false`
// (so Claude Code still forwards it to the PTY) and the native harness, which owns the catalog, resolves it.
// (2) The Skill tool as the MODEL sees it (transcripts showed GPT models loading one skill up to 33 times):
// no `args` field, a short "already loaded" reply on repeat, descriptions clipped to first 300 + last 200 chars.
import { describe, it, expect, vi } from 'vitest';
import { dispatchSlashCommand, type DispatcherInput } from '../src/renderer/state/slash-command-dispatcher';
import { createSkillTool, alreadyLoadedNotice, clipDescription } from '../src/main/harness/tools/skill';
import type { SkillCatalog } from '../src/main/harness/skills/skill-catalog';

function input(raw: string, over: Partial<DispatcherInput> = {}): DispatcherInput {
  return {
    raw, sessionId: 's', view: 'chat', files: [], dispatch: vi.fn(), timeline: [],
    callbacks: {} as any, ...over,
  } as DispatcherInput;
}

describe('/skill-name dispatch', () => {
  it('an unrecognized slash command carries an invoke-skill intent', () => {
    const r = dispatchSlashCommand(input('/journal'));
    expect(r.nativeAction).toEqual({ kind: 'invoke-skill', skill: 'journal' });
  });

  it('stays handled:false so Claude Code sessions still forward it to the PTY', () => {
    // The whole point of riding the unhandled branch: nothing changes for CC.
    expect(dispatchSlashCommand(input('/journal')).handled).toBe(false);
  });

  it('carries the arguments the user typed', () => {
    const r = dispatchSlashCommand(input('/journal today was long'));
    expect(r.nativeAction).toEqual({ kind: 'invoke-skill', skill: 'journal', args: 'today was long' });
  });

  // WHY: built-ins resolve in the switch ABOVE the fallthrough, so a skill named `clear` can never take over /clear.
  it.each([['/clear', { kind: 'clear' }], ['/compact', { kind: 'compact' }]])('built-in %s keeps its own action', (raw, action) => {
    expect(dispatchSlashCommand(input(raw, { deferUiEffectsToRuntime: true })).nativeAction).toEqual(action);
  });

  it.each(['hello there', '/'])('%j is not a skill invocation', (raw) => {
    expect(dispatchSlashCommand(input(raw)).nativeAction).toBeUndefined();
  });

  it('the backslash escape hatch is not a skill invocation', () => {
    // "\/journal" means "send this literally", not "run the journal skill".
    const r = dispatchSlashCommand(input('\\/journal'));
    expect(r.nativeAction).toBeUndefined();
    // WHY: `rewritten` exists only on the handled:false arm of DispatcherResult.
    expect(r.handled).toBe(false);
    expect(r.handled === false && r.rewritten).toBe('/journal');
  });

  it('lowercases the skill id the same way command matching does', () => {
    expect(dispatchSlashCommand(input('/Journal')).nativeAction)
      .toEqual({ kind: 'invoke-skill', skill: 'journal' });
  });
});

const ctx = { sessionId: 's', cwd: '/tmp', signal: new AbortController().signal, readRegistry: new Map(), todos: [] } as any;

function catalogOf(body: string, description = 'Write a journal entry'): SkillCatalog {
  return {
    list: () => [{ id: 'p:journal', description }],
    // Resolves the bare name too, like the real catalog does.
    load: (id: string) => ({ id: 'p:journal', displayName: 'Journal', description, body, file: '/tmp/skills/journal/SKILL.md' }),
  };
}

describe('Skill tool input', () => {
  it('has no args field, and rejects one', async () => {
    const tool = createSkillTool(catalogOf('x'));
    expect((tool.inputSchema as any).shape.args).toBeUndefined();
    expect((tool.inputSchema as any).safeParse({ skill: 'journal', args: 'note to self' }).success).toBe(false);
  });

  it('delivers the body verbatim', async () => {
    const r = await createSkillTool(catalogOf('Do $ARGUMENTS now.')).execute({ skill: 'journal' }, ctx);
    expect(r.text).toBe('<skill-instructions name="p:journal">\nDo $ARGUMENTS now.\n</skill-instructions>');
  });
});

describe('Skill tool repeat guard', () => {
  const withSet = () => ({ ...ctx, servedSkills: new Set<string>() });

  it('sends the body once, then the already-loaded notice, keyed by the resolved id', async () => {
    const tool = createSkillTool(catalogOf('1. Open the journal.'));
    const c = withSet();
    const first = await tool.execute({ skill: 'journal' }, c);
    expect(first.text).toContain('1. Open the journal.');
    // A differently spelled name for the same skill is still a repeat.
    const second = await tool.execute({ skill: 'p:journal' }, c);
    expect(second.text).toBe(alreadyLoadedNotice('p:journal'));
    expect(second.text).toBe('The p:journal skill is already loaded earlier in this conversation and still applies. Keep following those instructions. Do not try to load it again.');
    // Not an error: models retry errors, which is what this stops.
    expect(second.isError).toBeFalsy();
  });

  it('a skill the user ran as /skill-name counts as loaded', async () => {
    const c = withSet();
    c.servedSkills.add('p:journal');
    const r = await createSkillTool(catalogOf('body')).execute({ skill: 'journal' }, c);
    expect(r.text).toBe(alreadyLoadedNotice('p:journal'));
  });

  it('once the session forgets (compaction, /clear, resume), the body is sent again', async () => {
    const tool = createSkillTool(catalogOf('body'));
    const c = withSet();
    await tool.execute({ skill: 'journal' }, c);
    c.servedSkills.clear();
    expect((await tool.execute({ skill: 'journal' }, c)).text).toContain('body');
  });

  it('a skill too long to deliver whole is not remembered, so a later call still sends it', async () => {
    // maxChars 100: the body is cut on delivery. Claiming "already loaded" after
    // that would vouch for a middle the model never saw.
    const tool = createSkillTool(catalogOf('x'.repeat(500)), 100);
    const c = withSet();
    await tool.execute({ skill: 'journal' }, c);
    expect(c.servedSkills.size).toBe(0);
    expect((await tool.execute({ skill: 'journal' }, c)).text).not.toBe(alreadyLoadedNotice('p:journal'));
  });

  it('a skill that fits the cap exactly is remembered', async () => {
    const tool = createSkillTool(catalogOf('short'), 10_000);
    const c = withSet();
    await tool.execute({ skill: 'journal' }, c);
    expect(c.servedSkills.has('p:journal')).toBe(true);
  });

  it('a failed load is not remembered', async () => {
    const broken: SkillCatalog = { list: () => [], load: () => { throw new Error('gone'); } };
    const c = withSet();
    await createSkillTool(broken).execute({ skill: 'journal' }, c);
    expect(c.servedSkills.size).toBe(0);
  });
});

describe('Skill tool listing', () => {
  it('tells the model when to load a skill and not to reload one', () => {
    const d = createSkillTool(catalogOf('x')).description;
    expect(d).toContain('Load a skill only when the task clearly calls for what it covers, not because it is listed or loosely related.');
    expect(d).toContain("Once loaded, a skill stays in effect for the rest of the conversation; don't load it again.");
  });

  it('leaves descriptions of 500 characters or fewer alone', () => {
    const d = 'a '.repeat(250).trim();
    expect(clipDescription(d)).toBe(d);
  });

  it('keeps the first ~300 and last ~200 characters of a long description, cut at words', () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const clipped = clipDescription(`START ${words} END-TRIGGER`);
    expect(clipped.startsWith('START w0 w1')).toBe(true);
    expect(clipped.endsWith('END-TRIGGER')).toBe(true);
    expect(clipped).toContain(' … ');
    expect(clipped.length).toBeLessThanOrEqual(503);
    // Both halves end/start on whole words.
    const [h, t] = clipped.split(' … ');
    expect(h).toMatch(/(^| )w\d+$/);
    expect(t).toMatch(/^w\d+ /);
  });

  it('the listing uses the clipped description', () => {
    const long = 'x'.repeat(100) + ' ' + 'middle '.repeat(200) + 'TAIL-PHRASE';
    const d = createSkillTool(catalogOf('x', long)).description;
    expect(d).toContain('TAIL-PHRASE');
    expect(d).not.toContain('middle '.repeat(80));
  });
});
