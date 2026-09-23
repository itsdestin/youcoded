// Pins the resume-time title re-apply. The native title feeder only broadcasts
// a rename when it GENERATES a title, and an already-titled session never
// regenerates — so before this module, resuming an already-named native
// session left its header pill stuck on 'Resuming…' forever.
import { describe, it, expect, vi } from 'vitest';
import { reapplyStoredTitle, nameForTitleCheck, type ResumeTitleDeps } from '../src/main/native-resume-title';

function mkDeps(overrides: Partial<ResumeTitleDeps> = {}): ResumeTitleDeps {
  return {
    getStoredTitle: vi.fn(async () => 'Fixing The Login Bug'),
    onTitle: vi.fn(),
    ...overrides,
  };
}

describe('reapplyStoredTitle', () => {
  it('re-applies a real stored title', async () => {
    const deps = mkDeps();
    const applied = await reapplyStoredTitle(deps, 's1');

    expect(applied).toBe('Fixing The Login Bug');
    expect(deps.getStoredTitle).toHaveBeenCalledWith('s1');
    expect(deps.onTitle).toHaveBeenCalledTimes(1);
    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'Fixing The Login Bug');
  });

  it.each([undefined, '', '   ', 'Untitled', 'New Session', 'Resuming…'])(
    'never plants the placeholder %j over the live name',
    async (stored) => {
      const deps = mkDeps({ getStoredTitle: vi.fn(async () => stored as any) });
      const applied = await reapplyStoredTitle(deps, 's1');

      expect(applied).toBeNull();
      expect(deps.onTitle).not.toHaveBeenCalled();
    },
  );

  it('trims the stored title before applying it', async () => {
    const deps = mkDeps({ getStoredTitle: vi.fn(async () => '  Fixing The Login Bug  ') });
    await reapplyStoredTitle(deps, 's1');

    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'Fixing The Login Bug');
  });

  it('swallows a store read failure — a resume must never fail over a title', async () => {
    const deps = mkDeps({ getStoredTitle: vi.fn(async () => { throw new Error('store unavailable'); }) });

    await expect(reapplyStoredTitle(deps, 's1')).resolves.toBeNull();
    expect(deps.onTitle).not.toHaveBeenCalled();
  });

  it('swallows a broadcast failure for the same reason', async () => {
    const deps = mkDeps({ onTitle: vi.fn(() => { throw new Error('window destroyed'); }) });

    await expect(reapplyStoredTitle(deps, 's1')).resolves.toBeNull();
    // Assert we actually REACHED the throwing call. Without this the test would
    // still pass if a future edit made the default stored title a placeholder,
    // short-circuiting before onTitle — a vacuous green.
    expect(deps.onTitle).toHaveBeenCalledTimes(1);
  });
});

// Destin, 2026-09-02: a conversation that never got a title shows the first
// message's opening words on the pill — the same name its Resume Browser row
// shows — instead of 'Resuming…' until the next completed turn.
describe('reapplyStoredTitle — no stored title', () => {
  it('falls back to the opening words, marked provisional', async () => {
    const deps = mkDeps({
      getStoredTitle: vi.fn(async () => undefined),
      getOpeningTitle: vi.fn(async () => 'help me refactor the auth module'),
    });
    expect(await reapplyStoredTitle(deps, 's1')).toBe('help me refactor the auth module');
    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'help me refactor the auth module', { provisional: true });
  });

  it('a real stored title still wins and is not provisional', async () => {
    const getOpeningTitle = vi.fn(async () => 'raw words');
    const deps = mkDeps({ getOpeningTitle });
    await reapplyStoredTitle(deps, 's1');
    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'Fixing The Login Bug');
    expect(getOpeningTitle).not.toHaveBeenCalled();
  });

  it('plants nothing when the conversation has no opening words either', async () => {
    const deps = mkDeps({ getStoredTitle: vi.fn(async () => 'Untitled'), getOpeningTitle: vi.fn(async () => undefined) });
    expect(await reapplyStoredTitle(deps, 's1')).toBeNull();
    expect(deps.onTitle).not.toHaveBeenCalled();
  });
});

describe('nameForTitleCheck', () => {
  it('hides the provisional opening words from the has-a-title check', () => {
    expect(nameForTitleCheck('raw words', 'raw words')).toBeUndefined();
  });
  it('lets any other live name through, including one that replaced the provisional words', () => {
    expect(nameForTitleCheck('Refactoring Auth', 'raw words')).toBe('Refactoring Auth');
    expect(nameForTitleCheck('Refactoring Auth', undefined)).toBe('Refactoring Auth');
  });
});
