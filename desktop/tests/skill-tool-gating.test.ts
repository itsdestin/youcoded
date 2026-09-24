// The Skill tool's description carries every installed skill's id and one-liner
// on EVERY turn. That is noise on a 128k window and unaffordable on an 8k one, so
// whether it is attached is a profile decision — the same three-layer profile
// Plan C landed. A small model still reaches skills through /skill-name.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import { makeOpts } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import type { SkillCatalog } from '../src/main/harness/skills/skill-catalog';

const catalog: SkillCatalog = {
  list: () => [{ id: 'journal', description: 'Write a journal entry' }, { id: 'theme-builder', description: 'Build a theme' }],
  load: (id) => ({ id, displayName: id, description: 'd', body: 'do the thing' }),
};
const emptyCatalog: SkillCatalog = { list: () => [], load: () => { throw new Error('none'); } };

function sessionWith(
  profileOver: Partial<typeof CLOUD_DEFAULT>, skillCatalog: SkillCatalog = catalog, harnessOver: any = {},
  projectSkillAllowlist?: Set<string>,
) {
  return new HarnessSession(
    makeOpts({
      profile: { ...CLOUD_DEFAULT, ...profileOver },
      skillCatalog,
      harness: { schema: 1, id: 'agent', name: 'Agent', systemPrompt: 'sys', tools: [], permissionPolicy: 'ask', ...harnessOver },
      ...(projectSkillAllowlist ? { projectSkillAllowlist } : {}),
    }),
    async () => ({} as any),
  );
}
const toolNames = (s: HarnessSession) => Object.keys((s as any).buildAiTools());

describe('Skill attachment is profile-gated', () => {
  it('a window that can afford the catalog gets Skill', () => {
    expect(toolNames(sessionWith({ exposeSkillCatalog: true }))).toContain('Skill');
  });

  it('a small window does NOT — /skill-name still reaches skills there', () => {
    expect(toolNames(sessionWith({ exposeSkillCatalog: false }))).not.toContain('Skill');
  });

  it('a tool-less model gets no tools at all, Skill included', () => {
    expect(toolNames(sessionWith({ supportsTools: false, exposeSkillCatalog: true }))).toEqual([]);
  });

  it('no skills installed means no tool — a catalog listing nothing invites invented ids', () => {
    expect(toolNames(sessionWith({ exposeSkillCatalog: true }, emptyCatalog))).not.toContain('Skill');
  });
});

describe('Skill attachment tracks a model swap', () => {
  it('swapping to a smaller model REMOVES Skill', () => {
    // Plan C re-resolves the profile on setBinding. A tool attached under the old
    // profile must not survive into a session that can no longer afford it —
    // otherwise the model keeps a catalog the new window has no room for.
    const s = sessionWith({ exposeSkillCatalog: true });
    expect(toolNames(s)).toContain('Skill');
    s.setBinding({ providerId: 'local', modelId: 'tiny' }, 8_192, { ...CLOUD_DEFAULT, exposeSkillCatalog: false });
    expect(toolNames(s)).not.toContain('Skill');
  });

  it('swapping to a larger model ADDS it back', () => {
    const s = sessionWith({ exposeSkillCatalog: false });
    expect(toolNames(s)).not.toContain('Skill');
    s.setBinding({ providerId: 'openrouter', modelId: 'big' }, 200_000, { ...CLOUD_DEFAULT, exposeSkillCatalog: true });
    expect(toolNames(s)).toContain('Skill');
  });
});

describe('the manifest skills allowlist scopes the catalog', () => {
  it('an allowlist restricts which skills the model is told about', () => {
    const names = (s: HarnessSession) => (s as any).buildAiTools().Skill.description as string;
    const scoped = sessionWith({ exposeSkillCatalog: true }, catalog, { skills: ['journal'] });
    expect(names(scoped)).toContain('journal');
    expect(names(scoped)).not.toContain('theme-builder');
  });

  it('an allowlist that matches nothing installed attaches no tool', () => {
    const scoped = sessionWith({ exposeSkillCatalog: true }, catalog, { skills: ['not-installed'] });
    expect(toolNames(scoped)).not.toContain('Skill');
  });

  it('no allowlist offers everything installed', () => {
    const d = (sessionWith({ exposeSkillCatalog: true }) as any).buildAiTools().Skill.description as string;
    expect(d).toContain('journal');
    expect(d).toContain('theme-builder');
  });
});

// T2 (project-plugin-controls, design §3): a SECOND, independent allowlist —
// the project's currently-switched-on set, frozen per session — narrows the
// same list() the preset allowlist narrows above. The two combine as an
// intersection, and neither ever reaches load().
describe('project availability narrows the catalog alongside the preset allowlist', () => {
  it('list() is the intersection — a project-off skill is dropped even with no preset allowlist', () => {
    const names = (s: HarnessSession) => (s as any).buildAiTools().Skill.description as string;
    const scoped = sessionWith({ exposeSkillCatalog: true }, catalog, {}, new Set(['journal']));
    expect(names(scoped)).toContain('journal');
    expect(names(scoped)).not.toContain('theme-builder');
  });

  it('a skill must pass BOTH the preset allowlist and the project set', () => {
    const names = (s: HarnessSession) => (s as any).buildAiTools().Skill.description as string;
    // Preset allows both; project allows only 'journal' — intersection is just 'journal'.
    const scoped = sessionWith({ exposeSkillCatalog: true }, catalog, { skills: ['journal', 'theme-builder'] }, new Set(['journal']));
    expect(names(scoped)).toContain('journal');
    expect(names(scoped)).not.toContain('theme-builder');
  });

  it('an empty project set (B-1: outside any project) offers nothing, attaching no tool', () => {
    const scoped = sessionWith({ exposeSkillCatalog: true }, catalog, {}, new Set());
    expect(toolNames(scoped)).not.toContain('Skill');
  });

  it('load() stays UNSCOPED by the project set — manual /skill keeps working for an excluded skill', () => {
    const scoped = sessionWith({ exposeSkillCatalog: true }, catalog, {}, new Set(['journal']));
    // 'theme-builder' is excluded from list() (previous test) but load() must
    // still resolve it — this is what keeps the host's invokeSkill/manual
    // /skill-name path (which never even touches this allowlist) consistent
    // with what scopedSkillCatalog() itself would do if asked to load it.
    expect((scoped as any).scopedSkillCatalog().load('theme-builder').id).toBe('theme-builder');
  });
});

describe('gating Skill leaves the other tools alone', () => {
  it('the core set is unaffected either way', () => {
    for (const expose of [true, false]) {
      const s = sessionWith({ exposeSkillCatalog: expose });
      // makeOpts passes no tools, so the set is exactly {}, {Skill}, {Task,
      // ModelSearch}, or {Skill, Task, ModelSearch} — the point is that
      // gating never DROPS something, only adds or withholds Skill. Task 6's
      // syncTaskTool runs the identical add-or-withhold dance for 'Task'
      // (CLOUD_DEFAULT.canDelegate is true and makeOpts sets no
      // isSpecialistChild), and Task 14's ModelSearch rides that same gate —
      // both filtered here too, not a regression.
      expect(toolNames(s).filter((n) => n !== 'Skill' && n !== 'Task' && n !== 'ModelSearch')).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Permission posture. Skill is a READ — narrower than Read itself, which is
// already free at the baseline — and every action a skill INSTRUCTS is performed
// by some other tool that is gated on its own terms.
// ---------------------------------------------------------------------------
import { rulesForMode, DESTRUCTIVE_DENY_LIST } from '../src/shared/permission-types';
import { decidePermission } from '../src/main/harness/permission-engine';

const layers = (mode: 'ask' | 'auto-edit' | 'full-auto', remembered = [] as any[]) => ({
  presetRules: [], modeRules: rulesForMode(mode),
  denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: remembered,
});

// ---------------------------------------------------------------------------
// Task 6 review fix 3: syncTaskTool (harness-session.ts) has TWO independent
// gates — profile.canDelegate AND !isSpecialistChild (the depth-1 guard) —
// but only the ON direction (harness-tool-presentation.test.ts, CLOUD_DEFAULT
// attaches Task) was pinned before this. Neither OFF direction had a test, so
// an accidental deletion of EITHER guard would have shipped silently — the
// depth-1 one especially, since that's the ONLY thing stopping a specialist
// from spawning its own specialists once allowedTools filtering alone has a
// bug. Mirrors the Skill ON/OFF pattern above.
// ---------------------------------------------------------------------------
describe('Task attachment is profile + depth gated (OFF direction)', () => {
  it('canDelegate: false withholds Task even for an ordinary (non-child) session', () => {
    const s = new HarnessSession(
      makeOpts({ profile: { ...CLOUD_DEFAULT, canDelegate: false } }),
      async () => ({} as any),
    );
    expect((s as any).buildAiTools()).not.toHaveProperty('Task');
  });

  it('canDelegate: true but isSpecialistChild: true STILL withholds Task (depth-1 guard)', () => {
    const s = new HarnessSession(
      makeOpts({ profile: { ...CLOUD_DEFAULT, canDelegate: true }, isSpecialistChild: true }),
      async () => ({} as any),
    );
    expect((s as any).buildAiTools()).not.toHaveProperty('Task');
  });
});

describe('Skill permission posture', () => {
  it('does not prompt in ask mode — it is a read, and a narrow one', () => {
    expect(decidePermission('Skill', 'journal', layers('ask')).action).toBe('allow');
  });

  it('is allowed in auto-edit and full-auto too', () => {
    for (const mode of ['auto-edit', 'full-auto'] as const) {
      expect(decidePermission('Skill', 'journal', layers(mode)).action, mode).toBe('allow');
    }
  });

  it('a remembered DENY still wins — last-match-wins is not bypassed', () => {
    // The baseline allow is a default posture, never a hard grant. A user who
    // denied a specific skill must stay denied.
    const v = decidePermission('Skill', 'journal',
      layers('ask', [{ tool: 'Skill', pattern: 'journal', action: 'deny' }]));
    expect(v.action).toBe('deny');
  });
});
