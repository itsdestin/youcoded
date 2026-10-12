// Pins the placeholder-name predicate. The resumed-session title bug existed
// because 'Resuming…' was a bare string literal in App.tsx that the main
// process had never heard of — so hasTitle mistook it for a real title and
// blocked auto-title generation forever. One definition, tested, is the fix.
import { describe, it, expect } from 'vitest';
import {
  RESUMING_NATIVE,
  RESUMING_CLAUDE,
  NEW_SESSION,
  isPlaceholderSessionName,
  isRealSessionName,
  hasRealTitle,
} from '../src/shared/session-title';

describe('session-title placeholders', () => {
  it('spells the placeholders exactly as the renderer plants them', () => {
    // These are DIFFERENT strings — native uses a U+2026 ellipsis, Claude Code
    // uses three ASCII periods. Covering only one leaves half the bug alive.
    expect(RESUMING_NATIVE).toBe('Resuming…');
    expect(RESUMING_CLAUDE).toBe('Resuming...');
    expect(NEW_SESSION).toBe('New Session');
    expect(RESUMING_NATIVE).not.toBe(RESUMING_CLAUDE);
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['New Session', 'fresh-session placeholder'],
    ['Untitled', 'legacy store placeholder'],
    ['Resuming…', 'native resume placeholder'],
    ['Resuming...', 'claude resume placeholder'],
    [' Resuming… ', 'padded native resume placeholder'],
    [undefined, 'undefined'],
    [null, 'null'],
  ])('treats %j as a placeholder (%s)', (name: string | null | undefined, _label: string) => {
    expect(isPlaceholderSessionName(name as any)).toBe(true);
    expect(isRealSessionName(name as any)).toBe(false);
  });

  it.each([
    'Fixing The Login Bug',
    'Resuming The Migration', // starts with the placeholder word but is a real title
    'new session',            // case-sensitive: not the placeholder
    'Untitled Document',
  ])('treats %j as a real name', (name) => {
    expect(isRealSessionName(name)).toBe(true);
    expect(isPlaceholderSessionName(name)).toBe(false);
  });

  describe('hasRealTitle', () => {
    it('is true when the store has a real title', () => {
      expect(hasRealTitle('Fixing The Login Bug', 'Resuming…')).toBe(true);
    });

    it('is true when only the live session name is real', () => {
      expect(hasRealTitle('', 'Fixing The Login Bug')).toBe(true);
    });

    it('is FALSE when the live name is a resume placeholder', () => {
      // The whole bug: this returned true before, so the feeder never
      // generated a title for a resumed, never-titled session.
      expect(hasRealTitle(undefined, 'Resuming…')).toBe(false);
      expect(hasRealTitle(undefined, 'Resuming...')).toBe(false);
    });

    it('is false when both sides are placeholders', () => {
      expect(hasRealTitle('Untitled', 'New Session')).toBe(false);
    });
  });
});
