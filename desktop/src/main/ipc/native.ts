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
//   - clear and invoke-skill were refused to a phone (they had no phone case); so are the push channels.
//   - session-context-text answered from the assistant host only; the computer's extra plain file read for Claude Code
//     sessions and the user-level file was NOT given to a phone.
//   R6-1 (2026-10-01; Destin, 2026-09-30, answers 8 and 9): clear and invoke-skill are open to a phone, and a phone now gets the
//   instruction-file read too, through the phone's own deny list (see the session-context-text entry).
import fs from 'fs';
import { IPC } from '../../shared/backend-contract';
import { findProjectInstructionsPath, locateContextFile, readWholeContextFile } from '../claude-code-context';
import { isPhoneDeniedFile, KEPT_ON_COMPUTER } from '../phone-read-deny';
import { noteModelUsed } from '../conversations/service';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

/** The most a phone is sent of one instruction file (the computer's panel has no cap; instruction files are small). */
const PHONE_CONTEXT_MAX_BYTES = 1024 * 1024;
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
    handler: ({ sessionId, text, attachments, sendId }, ctx) => {
      // Only text paths are handed to the host (the phone's old rule; a hand-made message cannot slip anything else in).
      const files = (Array.isArray(attachments) ? attachments : []).filter((a): a is string => typeof a === 'string');
      if (!ctx.runtime) return NOT_LIVE_SEND;
      const result = ctx.runtime.nativeHost.send(sessionId, text, files);
      // The host took it (sent now, or queued behind the running turn): note the id so a phone that lost the answer can learn so (R5-4b).
      // A 'failed' answer is NOT noted: the host did not accept it, which is exactly what "not received" means.
      if (sendId !== undefined && result && result.status !== 'failed') ctx.runtime.records.noteSend(sessionId, sendId);
      return result;
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
  // /clear and /skill-name.
  // WHY open to a phone (R6-1; Destin, 2026-09-30: "a phone may clear a session and run a skill command. Yes."): the bodies already
  // worked for any caller (they only reach the assistant host through ctx.runtime, which the phone's door fills too).
  defineChannel({
    name: IPC.NATIVE_CLEAR, kind: 'handle',
    handler: ({ sessionId }, ctx) => {
      try { return ctx.runtime!.nativeHost.clear(sessionId); }
      catch (err: any) { return { ok: false as const, reason: 'error', detail: err?.message ?? String(err) }; }
    },
  }),
  defineChannel({
    name: IPC.NATIVE_INVOKE_SKILL, kind: 'handle',
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
  // for its own sessions (only it knows the budget the text was cut to); a Claude Code session and the user-level
  // instructions have no host answer, so the file is read plainly.
  // WHY a phone gets that plain read now (R6-1; Destin, 2026-09-30, answer 9: the phone's panel may read the project and user
  // instruction files for Claude Code sessions, as the computer's does): so the phone's panel matches the computer's. What a phone
  // does NOT get: (a) a skill's file was withheld in R6-1 and is read from R6-3 on (same checks as the instruction files), and (b) any file the phone deny list refuses
  // (R3-SEC): the file is judged on its REAL path, so a CLAUDE.md that is really a link to a secret is refused with the same
  // "kept on the computer" answer every other phone read gives. The project file is found by walking up from the folder of a
  // session that is open right now, so a phone cannot name a folder of its own.
  defineChannel({
    name: IPC.NATIVE_SESSION_CONTEXT_TEXT, kind: 'handle',
    handler: async ({ sessionId, kind, id }, ctx) => {
      const host = ctx.runtime?.nativeHost;
      if (ctx.door === 'remote' || !ctx.desktop) {
        if (kind !== 'user' && host) {
          const fromHost = host.sessionContextText(sessionId, kind as 'project' | 'skill', id);
          if (!('error' in fromHost) || fromHost.error !== 'not-live') return fromHost;
        }
        // WHY these three and no others (R6-3; Destin, 2026-10-01: a skill's own file may show on a phone, under the same protections): a
        // phone may read the instruction files and a skill's SKILL.md, never any kind it invents (R6-1 review). Anything else gets the host's
        // own answer (which is what a phone always got), or not-live when there is no host. For a skill the phone sends only an id: the
        // skill's folder is looked up on the computer from its own skill scan, never taken from the phone.
        if ((kind !== 'project' && kind !== 'user' && kind !== 'skill') || !ctx.remote) return host ? host.sessionContextText(sessionId, kind as 'project' | 'skill', id) : { error: 'not-live' };
        const sessions = { getSession: (sid: string) => { const cwd = ctx.remote!.sessionCwd(sid); return cwd ? { cwd } : undefined; } };
        const cwd = kind === 'project' ? sessions.getSession(sessionId)?.cwd : undefined;
        if (kind === 'project' && !cwd) return { error: 'not-live' };
        const found = kind === 'project' ? await findProjectInstructionsPath(cwd!) : locateContextFile(sessions, sessionId, kind, id);
        const located = typeof found === 'string' ? { path: found } : found ?? { error: 'not-found' };
        if ('error' in located) return located;
        // The deny list judges the real path BEFORE the file is read, so a refused file is never opened.
        if (await isPhoneDeniedFile(located.path)) return { error: KEPT_ON_COMPUTER };
        // Read exactly the path that was judged (no second lookup), and only a regular file of sane size: a named pipe would hang the read.
        try {
          const real = await fs.promises.realpath(located.path);
          const st = await fs.promises.stat(real);
          if (!st.isFile()) return { error: 'unreadable' };
          if (st.size > PHONE_CONTEXT_MAX_BYTES) return { error: 'too-large' };
          const text = await fs.promises.readFile(real, 'utf8');
          return { path: located.path, text, full: text, truncated: false };
        } catch { return { error: 'unreadable' }; }
      }
      if (kind !== 'user' && host) {
        const fromHost = host.sessionContextText(sessionId, kind, id);
        if (!('error' in fromHost) || fromHost.error !== 'not-live') return fromHost;
      }
      return readWholeContextFile(ctx.desktop.sessionManager, sessionId, kind, id);
    },
  }),
];
