import { describe, it, expect } from 'vitest';
import { CC_BUILTIN_COMMANDS, DISABLED_REASON } from './cc-builtin-commands';

describe('cc-builtin-commands', () => {
  it('exports a non-empty list', () => {
    expect(CC_BUILTIN_COMMANDS.length).toBeGreaterThan(0);
  });

  it('every entry is marked unclickable and sourced to cc-builtin', () => {
    for (const entry of CC_BUILTIN_COMMANDS) {
      expect(entry.clickable).toBe(false);
      expect(entry.source).toBe('cc-builtin');
      expect(entry.disabledReason).toBe(DISABLED_REASON(entry.name));
    }
  });

  it('every name starts with "/"', () => {
    for (const entry of CC_BUILTIN_COMMANDS) {
      expect(entry.name.startsWith('/')).toBe(true);
    }
  });

  it('every entry has a non-empty description', () => {
    for (const entry of CC_BUILTIN_COMMANDS) {
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('names are unique', () => {
    const names = CC_BUILTIN_COMMANDS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
