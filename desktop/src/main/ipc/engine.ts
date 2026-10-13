// engine.ts — the local llama.cpp engine (EngineCard): status, install, restart, backend, context and
// settings, "run in terminal", what a faster build needs, and which models are loaded. One table entry each,
// served to the computer's windows and to a phone.
//
// WHY (2026-09-30 one-core R3-6): written twice (ipc-handlers.ts and `case`s in remote-server.ts); both doors
// reach the SAME EngineManager through the runtime. The PUSHES (engine:install-progress, engine:status-changed,
// engine:models-changed) are not here: they are sent from the emitters in ipc-handlers.ts to every window and
// every phone, unchanged (who hears what is R5's job). Starting an install or a restart is the same single call
// as before, from whichever door asked. WHAT A PHONE SEES, before -> now:
//   - The same set of things, with the same answers. With no runtime yet a phone gets `null` (status) or
//     `[]` (models), as before.
//   - A failure now carries the table's failure marker; for engine:set-config, engine:prereqs and
//     engine:run-in-terminal the phone's page already rejected failures, and still does.
//   - engine:run-in-terminal: a phone's shell opens in the folder of the computer's NEWEST open session (it
//     has no window of its own), a window's in the newest session of THAT window, as before. Only the
//     computer's window then takes ownership of the new session (the phone's session is unowned, as before).
//   - The bare-value forms the phone's old cases tolerated (`payload.backend ?? payload`, ...) are gone: the
//     phone's page always sends the wrapped object, as the computer does.
import { IPC } from '../../shared/backend-contract';
import { prepareRunInTerminal, shellDisplayName } from '../session-manager';
import { nodeRefusal } from '../prerequisite-installer';
import { enginePrereqs } from '../engine/rocm-prereqs';
import { log } from '../logger';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';
import { sessionOpsWhenReady } from './session';

/** The status the moment a change was SAVED (the caller needs no second round-trip), or null with no runtime. */
const statusOf = (ctx: MainChannelCtx) => ctx.runtime?.engineManager.status() ?? null;

export const engineChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.ENGINE_STATUS, kind: 'handle', handler: (_p, ctx) => statusOf(ctx) }),
  defineChannel({ name: IPC.ENGINE_INSTALL, kind: 'handle', handler: async (_p, ctx) => { await ctx.runtime?.engineManager.install(); return statusOf(ctx); } }),
  defineChannel({ name: IPC.ENGINE_RESTART, kind: 'handle', handler: async (_p, ctx) => { await ctx.runtime?.engineManager.restart(); return statusOf(ctx); } }),
  defineChannel({ name: IPC.ENGINE_SET_BACKEND, kind: 'handle', handler: async ({ backend }, ctx) => { await ctx.runtime?.engineManager.setBackend(backend as any); return statusOf(ctx); } }),
  defineChannel({ name: IPC.ENGINE_SET_CONTEXT, kind: 'handle', handler: async ({ contextSize }, ctx) => { await ctx.runtime?.engineManager.setContext(contextSize); return statusOf(ctx); } }),
  // Every engine-wide setting in one write; the whole payload IS the patch. The answer is the status the moment
  // the value was SAVED: `configApplyPending` on it says whether the engine has picked it up yet.
  defineChannel({ name: IPC.ENGINE_SET_CONFIG, kind: 'handle', handler: async (patch, ctx) => { await ctx.runtime?.engineManager.setConfig(patch ?? {}); return statusOf(ctx); } }),
  // "Run in terminal": open a plain-shell session and TYPE the set-up command onto its prompt. Nothing runs, the
  // user presses Enter. prepareRunInTerminal refuses an empty command, a control character (a `\r` inside the
  // string would run it with nobody at the keyboard) and a $SHELL that is not installed, so a command that
  // arrives over the network is held to the same check as the computer's own button.
  defineChannel({
    name: IPC.ENGINE_RUN_IN_TERMINAL, kind: 'handle',
    handler: async ({ command }, ctx) => {
      const checked = prepareRunInTerminal(command);
      // A Terminal session runs through Node (the PTY worker), which setup no longer installs for everyone
      // (2026-10-02). A failure throws to the same FieldError beside the button. WHY both doors: the computer's
      // handler had this check and the phone's case did not; the terminal opens on the computer either way, so
      // the one entry asks for Node for both.
      const refusal = await nodeRefusal('to open a terminal');
      if (refusal) throw new Error(refusal);
      const ops = await sessionOpsWhenReady(ctx);
      // The folder: the newest live session of THIS window; a phone has no window, so the newest on the computer.
      // With none at all, createSession falls back to the home folder.
      const registry = ops.windowRegistry;
      const ids = ctx.door === 'desktop' && ctx.windowId != null && registry
        ? registry.sessionsForWindow(ctx.windowId).map((sid) => ops.sessionManager.getSession(sid))
        : ops.sessionManager.listSessions();
      let cwd = '';
      for (const s of ids) if (s && s.status !== 'destroyed') cwd = s.cwd;
      const info = ops.sessionManager.createSession({
        name: shellDisplayName(checked.shell), cwd, skipPermissions: false, provider: 'shell',
        initialCommand: checked.command,
        // Proof the command went through the validator: createSession refuses a shell session without it.
        shellToken: checked.shellToken,
      });
      // The same ownership handshake session:create does: session-created is forwarded one tick later, so without an
      // owner registered here the session would appear in the FIRST window instead of the one whose Settings the user
      // is in. A buddy window cannot own a session, so its leader takes it. A phone has no window: no owner.
      if (ctx.door === 'desktop' && ctx.windowId != null && registry) {
        let targetId = ctx.windowId;
        if (registry.getKind(ctx.windowId) === 'buddy') {
          const leader = registry.getLeaderId();
          if (leader != null) targetId = leader;
        }
        try { registry.assignSession(info.id, targetId); }
        catch (e) { log('WARN', 'IPC', 'assignSession failed for the shell session', { error: String(e) }); }
      }
      return { sessionId: info.id };
    },
  }),
  // `refresh: true` on purpose: only the card calls this, including its "Check again" button AFTER the user ran the
  // install command, and a cached answer there would strand them in the set-up box.
  defineChannel({ name: IPC.ENGINE_PREREQS, kind: 'handle', handler: ({ backend }) => enginePrereqs(backend, { refresh: true }) }),
  // Whole live per-model state (initial fetch for the coordinator's consumers).
  defineChannel({ name: IPC.ENGINE_MODELS, kind: 'handle', handler: (_p, ctx) => ctx.runtime ? ctx.runtime.engineManager.liveModels() : [] }),
];
