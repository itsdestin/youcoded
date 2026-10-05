// claude-code.ts — Claude Code's own sign-in, read live, and installing it, one table entry each.
//
// WHY (2026-09-30 one-core R3-6): written twice. Both answer from THE COMPUTER's `claude` (a phone has no
// binary of its own). With no account object yet, status is `unknown`, which every reader treats as
// available: a screen must never grey a model out on the strength of a missing object. WHAT A PHONE SEES,
// before -> now: the same, including that a paired phone's page can already start the install on the
// computer (a question for Destin in the R3-6 report). Android's own app refuses it; that is not this door.
import { IPC } from '../../shared/backend-contract';
import { installClaude, nodeRefusal } from '../prerequisite-installer';
import { defineChannel, type MainChannelDef } from './channel-def';

export const claudeCodeChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.CLAUDE_CODE_STATUS, kind: 'handle',
    handler: async (opts, ctx) => {
      const account = ctx.runtime?.claudeAccount ?? null;
      if (opts?.refresh) account?.invalidate();
      return account ? account.status() : { state: 'unknown' as const };
    },
  }),
  // The installer's own { success, error } is the answer; the cached "not-installed" is dropped so the card re-reads it.
  defineChannel({
    name: IPC.CLAUDE_CODE_INSTALL, kind: 'handle',
    handler: async (_p, ctx) => {
      // WHY Node first (2026-10-02): setup no longer installs it for everyone, and Claude Code sessions cannot start
      // without it. Both doors, as before (the computer's handler and the phone's case each had this).
      const refusal = await nodeRefusal('to install Claude Code');
      if (refusal) return { success: false, error: refusal };
      const result = await installClaude();
      ctx.runtime?.claudeAccount?.invalidate();
      return result;
    },
  }),
];
