// A pasted absolute filepath is not a slash command. Destin, 2026-08-10:
// pasting a bare path into the input box toasted "skill not found" and DELETED
// the input — the dispatcher read `/home` as the command word, fell to the
// /skill-name branch, and the native route reported the result as consumed.
//
// The discriminator is the COMMAND WORD (text before the first space): a real
// command never contains a second '/'. Verified against the app's own
// inventories — cc-builtin-commands.ts and youcoded-commands.ts hold 30 names,
// none with a slash — and skill ids namespace with ':' (plugin:skill), not '/'.
import { describe, it, expect } from 'vitest';
import { dispatchSlashCommand } from '../src/renderer/state/slash-command-dispatcher';

function dispatch(raw: string) {
  return dispatchSlashCommand({
    raw,
    sessionId: 'sess-1',
    view: 'chat',
    files: [],
    dispatch: () => {},
    timeline: [],
    callbacks: {},
    deferUiEffectsToRuntime: false,
  } as any);
}

describe('dispatchSlashCommand — absolute paths are text, not commands', () => {
  for (const path of [
    '/home/destin/youcoded-dev/ROADMAP.md',
    '/Users/destin/notes.txt',
    '/tmp/x.log',
    '/etc/hosts',
  ]) {
    it(`treats ${path} as plain text`, () => {
      const r = dispatch(path);
      expect(r.handled).toBe(false);
      // The bug: an invoke-skill intent here makes the native route claim the
      // input as consumed, which is what wiped the box.
      expect(r.nativeAction).toBeUndefined();
      // WHY the cast: `rewritten` exists only on the handled:false arm of the
      // result union, and expect() does not narrow — reads the same field.
      expect((r as { rewritten?: string }).rewritten).toBeUndefined();
    });
  }

  it('a path with a question after it is still text', () => {
    const r = dispatch('/home/destin/a b.md what does this do?');
    expect(r.handled).toBe(false);
    expect(r.nativeAction).toBeUndefined();
  });

  it('still dispatches a real built-in command', () => {
    expect(dispatch('/clear').handled).toBe(true);
  });

  it('still routes an unknown single-word command to the skill path', () => {
    // M3 item 1 — /skill-name must keep working; this is the regression guard
    // for narrowing the branch above.
    const r = dispatch('/journal');
    expect(r.nativeAction).toEqual({ kind: 'invoke-skill', skill: 'journal' });
  });

  it('still passes a path as an ARGUMENT to a real command', () => {
    const r = dispatch('/theme-builder /home/destin/wallpaper.png');
    expect(r.nativeAction).toEqual({
      kind: 'invoke-skill', skill: 'theme-builder', args: '/home/destin/wallpaper.png',
    });
  });
});
