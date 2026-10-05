// ui.ts — the small singles: platform:get, commands:list, ui:action (both directions), system:notify-stack-state and
// terminal:get-screen-text.
//
// WHY (2026-10-01 one-core R3-8): each was an ipcMain handler in ipc-handlers.ts and, for four of them, a `case` in
// remote-server.ts. What the phone sees is unchanged except where noted:
//   - platform:get answers the COMPUTER's platform on both doors (the screens that ask are about what can be installed
//     or run there).
//   - commands:list: a failure now answers the generic error the phone's page rejects, not a bare `{ ok:false }`.
//   - ui:action (a phone's screen action) and ui:action:broadcast (a window's) are two names for the two directions of
//     one relay: phone to the other phones and this computer's windows, window to every phone.
//   - system:notify-stack-state and terminal:get-screen-text are the computer's alone (the phone door refuses them from
//     the table, with the same answer the old default gave; the shim already stops polling the second one).
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

/** What main hands over: the slash-command list (CommandProvider) and the hook that tells this computer's windows a phone
 *  sent a screen action (sessionManager emits 'ui-action', which main forwards to the windows). */
interface UiDeps {
  getCommands(): Promise<unknown[]>;
  emitUiAction(action: unknown): void;
}
let deps: UiDeps | null = null;
export function bindUi(next: UiDeps): void { deps = next; }

export const uiChannels: MainChannelDef[] = [
  // Reports process.platform so the renderer can gate UI (hide Install buttons on macOS-only integrations on Windows).
  // The raw Node code: the renderer humanises it (platform-display.ts).
  defineChannel({ name: IPC.PLATFORM_GET, kind: 'handle', handler: () => process.platform }),

  // The merged slash-command list for the CommandDrawer (and the phone's / menu). Before main hands it over: empty.
  defineChannel({ name: IPC.COMMANDS_LIST, kind: 'handle', handler: async () => (deps ? deps.getCommands() : []) }),

  // UI action sync, phone to everyone else: forwarded to the other phones and to this computer's windows. Phone-only.
  defineChannel({
    name: 'ui:action', kind: 'on', remoteOnly: true,
    handler: (payload, ctx) => {
      ctx.remote?.relayToOthers({ type: 'ui:action', payload });
      deps?.emitUiAction(payload);
    },
  }),
  // UI action sync, a window to every phone.
  defineChannel({
    name: IPC.UI_ACTION_BROADCAST, kind: 'on', desktopOnly: true,
    handler: (action, ctx) => ctx.desktop?.sendToPhones({ type: 'ui:action', payload: action }),
  }),

  // No-op: Electron has no hardware back button. Kept for shape parity with SessionService.kt's handleBridgeMessage().
  defineChannel({ name: IPC.SYSTEM_NOTIFY_STACK_STATE, kind: 'on', desktopOnly: true, handler: () => {} }),

  // window.claude.terminal.getScreenText — reads the visible xterm buffer for the given session. The read happens in the
  // renderer (xterm lives there), so main calls back via executeJavaScript, ~1s cadence under the attention classifier.
  defineChannel({
    name: IPC.TERMINAL_GET_SCREEN_TEXT, kind: 'handle', desktopOnly: true,
    handler: async ({ sessionId, tailRows }, ctx) => {
      try {
        // Tail read: serialising the full 1000+-row scrollback every second was pure waste. The caller says how many
        // buffer rows it wants (the attention classifier asks for 40 — audit W24); one that omits it gets the 120-row
        // tail this handler always used. Only a positive integer is honoured — anything else falls back to the default.
        const rows = Number.isInteger(tailRows) && (tailRows as number) > 0 ? (tailRows as number) : 120;
        const sender = ctx.sender as unknown as { executeJavaScript(code: string): Promise<string> };
        return await sender.executeJavaScript(`window.__terminalRegistry?.getScreenText(${JSON.stringify(sessionId)}, ${rows}) ?? ''`);
      } catch {
        return '';
      }
    },
  }),
];
