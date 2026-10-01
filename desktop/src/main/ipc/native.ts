// native.ts — the assistant's own session channels (native:*), one table entry each, served to the
// computer's windows and to a phone.
//
// WHY (2026-09-30 one-core R3-5): these were written twice (ipc-handlers.ts and `case`s in
// remote-server.ts) and had drifted. Both doors reach the SAME NativeSessionHost through the runtime
// (ctx.runtime), so almost every body is a one-liner. A phone that arrives with no runtime yet gets the
// same "not live" answers it always did.
//
// WHAT A PHONE SEES, before -> now (the R3-5 report has the full list):
//   - set-binding / switch-model now also record the model the conversation used (the computer did).
//   - native:send ignores attachments that are not text paths, as the phone's old case did (the
//     computer now does too).
//   - set-permission-mode with a bad mode now shows an error (it used to resolve an error object).
//   - clear and invoke-skill stay refused to a phone (they had no phone case); so do the push channels.
//   - session-context-text keeps answering from the assistant host only; the computer's extra plain
//     file read for Claude Code sessions and the user-level file is NOT given to a phone.
import { IPC } from '../../shared/backend-contract';
import { readWholeContextFile } from '../claude-code-context';
import { noteModelUsed } from '../conversations/service';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

const NOT_LIVE_SEND = { status: 'failed', reason: 'not-live' } as const;

/** The one place the YOUCODED_NATIVE=0 kill switch is read in main (one-core R3-5, audit M6).
 *  WHY it still guards only the context-preference channels: that is all the switch has ever refused in
 *  main (the renderer hides the rest via `native.supported`), and refusing more here would change what an
 *  existing session can do under the switch. */
function requireNativeEnabled(ctx: MainChannelCtx): NonNullable<MainChannelCtx['runtime']> {
  if (!ctx.runtime || process.env.YOUCODED_NATIVE === '0') throw new Error('Native context preferences are not supported');
  return ctx.runtime;
}

/** After a successful mid-session model swap: record the model used so the resume selector reflects it
 *  without waiting for the next turn (the computer always did this; a phone's swap now does too). */
async function recordModelUsed(ctx: MainChannelCtx, sessionId: string): Promise<void> {
  const ref = await ctx.runtime?.resolvePortableModel(sessionId);
  if (ref) noteModelUsed(sessionId, ref);
}

export const nativeChannels: MainChannelDef[] = [
  // ── Sending and queueing ────────────────────────────────────────────────────
  // M1: answers {status:'sent'|'queued'|'failed'} so the screen can draw truthful bubbles; send() never throws.
  defineChannel({
    name: IPC.NATIVE_SEND, kind: 'handle',
    handler: ({ sessionId, text, attachments }, ctx) => {
      // Only text paths are handed to the host (the phone's old rule; a hand-made message cannot slip anything else in).
      const files = (Array.isArray(attachments) ? attachments : []).filter((a): a is string => typeof a === 'string');
      return ctx.runtime ? ctx.runtime.nativeHost.send(sessionId, text, files) : NOT_LIVE_SEND;
    },
  }),
  defineChannel({ name: IPC.NATIVE_QUEUE_REMOVE, kind: 'handle', handler: ({ sessionId, queueId }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.removeQueued(sessionId, queueId) : false }),
  defineChannel({ name: IPC.NATIVE_QUEUE_SEND_NOW, kind: 'handle', handler: ({ sessionId, queueId }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.sendQueuedNow(sessionId, queueId) : false }),
  // Fire-and-forget: the host never throws for an unknown id.
  defineChannel({ name: IPC.NATIVE_INTERRUPT, kind: 'on', handler: ({ sessionId }, ctx) => { ctx.runtime?.nativeHost.interrupt(sessionId); } }),
  defineChannel({ name: IPC.NATIVE_RETRY, kind: 'on', handler: ({ sessionId }, ctx) => { ctx.runtime?.nativeHost.retryStalledStep(sessionId); } }),
  // Never throws across the bridge: a failure is a coded reason the screen can explain (error-message-standards.md).
  defineChannel({
    name: IPC.NATIVE_COMPACT, kind: 'handle',
    handler: async ({ sessionId, focus }, ctx) => {
      try { return ctx.runtime ? await ctx.runtime.nativeHost.compact(sessionId, focus) : { ok: false as const, reason: 'not-live' }; }
      catch (err: any) { return { ok: false as const, reason: 'error', detail: err?.message ?? String(err) }; }
    },
  }),
  // /clear and /skill-name had no phone case: a phone is refused, as before (a question for Destin in the R3-5 report).
  defineChannel({
    name: IPC.NATIVE_CLEAR, kind: 'handle', remoteAllowed: false,
    handler: ({ sessionId }, ctx) => {
      try { return ctx.runtime!.nativeHost.clear(sessionId); }
      catch (err: any) { return { ok: false as const, reason: 'error', detail: err?.message ?? String(err) }; }
    },
  }),
  defineChannel({
    name: IPC.NATIVE_INVOKE_SKILL, kind: 'handle', remoteAllowed: false,
    handler: async ({ sessionId, skill, args }, ctx) => {
      try { return await ctx.runtime!.nativeHost.invokeSkill(sessionId, skill, args); }
      catch (err: any) { return { ok: false as const, reason: 'error', detail: err?.message ?? String(err) }; }
    },
  }),

  // ── Models and modes ────────────────────────────────────────────────────────
  // U11: the picker's switch; the model-used write happens only once the switch really happened.
  defineChannel({
    name: IPC.NATIVE_SWITCH_MODEL, kind: 'handle',
    handler: async ({ sessionId, binding, summarize }, ctx) => {
      try {
        if (!ctx.runtime) return { status: 'failed' as const, reason: 'not-live' as const };
        const result = await ctx.runtime.nativeHost.switchModel(sessionId, binding, summarize === true);
        if (result.status === 'switched') await recordModelUsed(ctx, sessionId);
        return result;
      } catch (err: any) { return { status: 'failed' as const, reason: 'error' as const, detail: err?.message ?? String(err) }; }
    },
  }),
  defineChannel({
    name: IPC.NATIVE_SET_BINDING, kind: 'handle',
    handler: async ({ sessionId, binding }, ctx) => {
      const ok = ctx.runtime ? await ctx.runtime.nativeHost.setBinding(sessionId, binding) : false;
      if (ok) await recordModelUsed(ctx, sessionId);
      return ok;
    },
  }),
  // setPermissionMode THROWS on an unknown mode: the caller sees the failure instead of a false "applied".
  // A phone with no runtime answers null, as it did.
  defineChannel({
    name: IPC.NATIVE_SET_PERMISSION_MODE, kind: 'handle',
    handler: ({ sessionId, mode }, ctx) => (ctx.runtime ? ctx.runtime.nativeHost.setPermissionMode(sessionId, mode) : null) as any,
  }),
  // Read-only, never throws; 'ask' is the host's own default for an unknown or non-live id.
  defineChannel({ name: IPC.NATIVE_GET_PERMISSION_MODE, kind: 'handle', handler: ({ sessionId }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.getPermissionMode(sessionId) : 'ask' }),
  defineChannel({ name: IPC.NATIVE_GET_CONTEXT_PREFERENCES, kind: 'handle', handler: (_p, ctx) => requireNativeEnabled(ctx).contextSettings.read() }),
  defineChannel({
    name: IPC.NATIVE_SET_CONTEXT_PREFERENCES, kind: 'handle',
    // WHY refuse an absent runtime: a success would claim a save that never happened.
    handler: ({ patch }, ctx) => requireNativeEnabled(ctx).contextSettings.update(patch),
  }),
  defineChannel({ name: IPC.NATIVE_GET_STEP_GUARD, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.stepGuardSettings.read() : null }),
  defineChannel({ name: IPC.NATIVE_SET_STEP_GUARD, kind: 'handle', handler: ({ value }, ctx) => ctx.runtime ? ctx.runtime.stepGuardSettings.update(value) : null }),

  // ── Reading what is there ───────────────────────────────────────────────────
  defineChannel({ name: IPC.NATIVE_SESSIONS_LIST, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.nativeHost.listAsync() : [] }),
  // G-1: the Bash card's Stop button, on every surface.
  defineChannel({ name: IPC.NATIVE_KILL_SHELL, kind: 'handle', handler: ({ sessionId, shellId }, ctx) => ctx.runtime ? ctx.runtime.nativeHost.killShell(sessionId, shellId) : { ok: false as const, reason: 'not-live' } }),
  // The password never leaves this expression: it is read once, handed to the host, and nothing here (and
  // nothing the table logs, which is only an error's message) retains or prints it. A non-string or empty one
  // is refused as `false`, the host's own "unknown or expired ask" answer, rather than thrown at.
  defineChannel({
    name: IPC.NATIVE_SUBMIT_ADMIN_PASSWORD, kind: 'handle',
    handler: (payload, ctx) => ctx.runtime && typeof payload?.password === 'string' && payload.password.length > 0
      ? ctx.runtime.nativeHost.submitAdminPassword(payload.requestId, payload.password)
      : false,
  }),
  // "What the assistant was given": one file's text, read when its row is opened. The assistant host answers
  // for its own sessions (only it knows the budget the text was cut to); the computer also falls back to a
  // plain file read for a Claude Code session and for the user-level instructions. A phone is NOT given that
  // fallback (it never had it): it gets the host's answer, which is "not-live" for anything else.
  defineChannel({
    name: IPC.NATIVE_SESSION_CONTEXT_TEXT, kind: 'handle',
    handler: ({ sessionId, kind, id }, ctx) => {
      const host = ctx.runtime?.nativeHost;
      if (ctx.door === 'remote' || !ctx.desktop) return host ? host.sessionContextText(sessionId, kind as 'project' | 'skill', id) : { error: 'not-live' };
      if (kind !== 'user' && host) {
        const fromHost = host.sessionContextText(sessionId, kind, id);
        if (!('error' in fromHost) || fromHost.error !== 'not-live') return fromHost;
      }
      return readWholeContextFile(ctx.desktop.sessionManager, sessionId, kind, id);
    },
  }),
];
