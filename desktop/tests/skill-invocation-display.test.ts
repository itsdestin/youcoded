// How a user-invoked skill APPEARS.
//
// Destin, 2026-07-28, on the first working /theme-builder: "this ui is terrible.
// it shouldn't just show the full text of the skill file as a user message."
// theme-builder's SKILL.md is ~26,000 characters, and /skill-name was routed
// through send(), so the whole file rendered as one chat bubble.
//
// The split this pins: the model's HISTORY gets the instructions, the TIMELINE
// gets a compact card. Both halves have to hold, including across a resume.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import { rebuildHistory } from '../src/main/harness/history-rebuild';
import { textChunks, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts } from './helpers/harness-fakes';

const BODY = '<skill-instructions name="p:theme-builder">\nBuild a theme.\n</skill-instructions>';

async function invoke(args?: string) {
  const seen: any[] = [];
  const model = scriptedModel([stream(...textChunks('a', 'ok'), finishChunk('stop'))], seen);
  const session = new HarnessSession(makeOpts({}), async () => model as any);
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  await session.runSkill({ skillId: 'p:theme-builder', displayName: 'Theme Builder', body: BODY, args, skillPath: '/x/SKILL.md' });
  return { events, seen, session };
}

describe('user-invoked skill — repeat guard', () => {
  // The body is now in history, so the model's own Skill call for the same
  // skill must get "already loaded" rather than a second copy (2026-09-23).
  it('marks the skill as loaded for the Skill tool', async () => {
    const { session } = await invoke();
    expect((session as any).servedSkills.has('p:theme-builder')).toBe(true);
  });
});

describe('user-invoked skill — transcript', () => {
  it('emits skill-invoked, NOT user-message', async () => {
    const { events } = await invoke();
    expect(events.map((e) => e.type)).toContain('skill-invoked');
    expect(events.map((e) => e.type)).not.toContain('user-message');
  });

  it('carries what the CARD needs: id, display name, and the file to open', async () => {
    const { events } = await invoke();
    const e = events.find((x) => x.type === 'skill-invoked')!;
    expect(e.data.skillId).toBe('p:theme-builder');
    expect(e.data.displayName).toBe('Theme Builder');
    expect(e.data.skillPath).toBe('/x/SKILL.md');
  });

  it('still gives the MODEL the full instructions', async () => {
    const { seen } = await invoke();
    expect(JSON.stringify(seen)).toContain('Build a theme.');
  });

  it('puts the user\'s own words AFTER the instructions', async () => {
    // So a skill that says "act on what the user asked" has something to act on.
    const { seen } = await invoke('make it purple');
    const prompt = JSON.stringify(seen[0]);
    expect(prompt.indexOf('Build a theme.')).toBeLessThan(prompt.indexOf('make it purple'));
  });
});

describe('user-invoked skill — resume', () => {
  it('rebuildHistory restores the instructions, not just the card', async () => {
    // A resumed session must not replay a turn whose opening move has no cause.
    const { events } = await invoke();
    const e = events.find((x) => x.type === 'skill-invoked')!;
    const history = rebuildHistory([e]);
    expect(JSON.stringify(history)).toContain('Build a theme.');
    expect(history[0].role).toBe('user');
  });

  it('a skill-invoked event with no body contributes nothing rather than an empty turn', async () => {
    const bare = { type: 'skill-invoked', sessionId: 's', uuid: 'u', timestamp: 1, data: { skillId: 'x' } } as TranscriptEvent;
    expect(rebuildHistory([bare])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Framing. The instructions alone read as a document the model was handed, and
// it replies "Understood, I have loaded the theme-builder skill. This skill
// guides a multi-phase workflow…" — a whole turn spent describing what it was
// about to do (Destin, 2026-07-28). The wording IS the mechanism, so it is a
// pure function and these assert on it directly.
// ---------------------------------------------------------------------------
import { frameSkillInvocation } from '../src/main/harness/skills/skill-invocation';

describe('frameSkillInvocation', () => {
  it('carries the instructions', () => {
    expect(frameSkillInvocation('p:theme-builder', 'Build a theme.')).toContain('Build a theme.');
  });

  it('names the invocation with the BARE command the user typed', () => {
    const out = frameSkillInvocation('wecoded-themes-plugin:theme-builder', 'x');
    expect(out).toContain('/theme-builder');
    expect(out).not.toContain('/wecoded-themes-plugin:theme-builder');
  });

  it('asks for work, not a summary — this is the whole point', () => {
    const out = frameSkillInvocation('p:x', 'do things');
    expect(out).toMatch(/Begin following these instructions now/);
    expect(out).toMatch(/do not summarize/i);
  });

  it('puts the user\'s own words LAST so the model reads them most recently', () => {
    const out = frameSkillInvocation('p:x', 'INSTRUCTIONS', 'make it purple');
    expect(out.indexOf('INSTRUCTIONS')).toBeLessThan(out.indexOf('make it purple'));
    expect(out.trimEnd().endsWith('make it purple')).toBe(true);
  });

  it('omits the user block entirely when there are no args', () => {
    const out = frameSkillInvocation('p:x', 'INSTRUCTIONS');
    expect(out.trimEnd().endsWith('do not summarize them back.')).toBe(true);
  });

  it('still tags the instructions with the QUALIFIED id', () => {
    // The bare name is for the human-facing echo; the tag identifies which
    // plugin's skill actually ran.
    expect(frameSkillInvocation('wecoded-themes-plugin:theme-builder', 'x'))
      .toContain('<skill-instructions name="wecoded-themes-plugin:theme-builder">');
  });
});
