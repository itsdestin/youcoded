import { describe, it, expect } from 'vitest';
import { mergeCommandSources } from './command-provider';
import type { CommandEntry } from '../shared/types';
import type { SkillEntry } from '../shared/types';

const youcoded: CommandEntry[] = [
  { name: '/compact', description: 'yc compact', source: 'youcoded', clickable: true },
];
const filesystem: CommandEntry[] = [
  { name: '/compact', description: 'fs compact (should lose)', source: 'filesystem', clickable: true },
  { name: '/announce', description: 'fs announce',              source: 'filesystem', clickable: true },
];
const ccBuiltin: CommandEntry[] = [
  { name: '/help', description: 'cc help', source: 'cc-builtin', clickable: false, disabledReason: 'Please run /help in Terminal View.' },
  { name: '/compact', description: 'cc compact (should lose)', source: 'cc-builtin', clickable: false },
];

describe('mergeCommandSources', () => {
  it('applies precedence youcoded > filesystem > cc-builtin', () => {
    const merged = mergeCommandSources(youcoded, filesystem, ccBuiltin, []);
    const compact = merged.find((e) => e.name === '/compact');
    expect(compact?.source).toBe('youcoded');
    expect(compact?.description).toBe('yc compact');
  });

  it('keeps entries with unique names from all sources', () => {
    const merged = mergeCommandSources(youcoded, filesystem, ccBuiltin, []);
    const names = merged.map((e) => e.name);
    expect(names).toContain('/compact');
    expect(names).toContain('/announce');
    expect(names).toContain('/help');
  });

  it('drops a command whose name matches an existing skill', () => {
    const skills: SkillEntry[] = [
      { id: 'announce', displayName: 'announce', description: '', category: 'other', prompt: '/announce' } as any,
    ];
    const merged = mergeCommandSources(youcoded, filesystem, ccBuiltin, skills);
    expect(merged.find((e) => e.name === '/announce')).toBeUndefined();
  });

  it('skill-dedup is name-keyed on the command name (with /) vs skill.displayName (no /)', () => {
    const skills: SkillEntry[] = [
      { id: 'x', displayName: 'help', description: '', category: 'other', prompt: '' } as any,
    ];
    const merged = mergeCommandSources([], [], ccBuiltin, skills);
    expect(merged.find((e) => e.name === '/help')).toBeUndefined();
  });
});
