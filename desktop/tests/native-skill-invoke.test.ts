// /skill-name is the path that must work on EVERY model, including the small
// local ones that never get the Skill tool (see skill-tool-gating). It loads one
// skill's body and sends it as a turn — a single injection, not a catalog riding
// every turn.
//
// The dispatcher does NOT hold a list of installed skills. An unrecognized slash
// command carries an `invoke-skill` intent alongside `handled: false`, so a
// Claude Code session forwards it to the PTY exactly as before while a native
// session asks the harness — which owns the catalog — to resolve it. That keeps
// the dispatcher provider-agnostic and avoids plumbing the skill list into two
// renderer components that have no other use for it.
import { describe, it, expect, vi } from 'vitest';
import { dispatchSlashCommand, type DispatcherInput } from '../src/renderer/state/slash-command-dispatcher';

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

  it('does not shadow a built-in — /clear stays the barrier', () => {
    // Built-ins resolve in the switch ABOVE the fallthrough, so an installed
    // skill named `clear` can never take over /clear.
    const r = dispatchSlashCommand(input('/clear', { deferUiEffectsToRuntime: true }));
    expect(r.nativeAction).toEqual({ kind: 'clear' });
  });

  it('/compact still names its own action', () => {
    expect(dispatchSlashCommand(input('/compact')).nativeAction).toEqual({ kind: 'compact' });
  });

  it('plain text is not a skill invocation', () => {
    expect(dispatchSlashCommand(input('hello there')).nativeAction).toBeUndefined();
  });

  it('the backslash escape hatch is not a skill invocation', () => {
    // "\/journal" means "send this literally", not "run the journal skill".
    const r = dispatchSlashCommand(input('\\/journal'));
    expect(r.nativeAction).toBeUndefined();
    // WHY: `rewritten` exists only on the handled:false arm of DispatcherResult.
    expect(r.handled).toBe(false);
    expect(r.handled === false && r.rewritten).toBe('/journal');
  });

  it('a bare slash is not a skill invocation', () => {
    expect(dispatchSlashCommand(input('/')).nativeAction).toBeUndefined();
  });

  it('lowercases the skill id the same way command matching does', () => {
    expect(dispatchSlashCommand(input('/Journal')).nativeAction)
      .toEqual({ kind: 'invoke-skill', skill: 'journal' });
  });
});
