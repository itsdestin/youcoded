// window-broadcast.ts — send one event to every window of this app.
//
// WHY (2026-09-30 one-core R3-1): a change a phone makes through the channel table (a tag edited
// on a phone) has to reach this computer's own windows too, or they stay stale until reloaded.
// The desktop door already loops over every window for the same reason (broadcastToAllWindows in
// ipc-handlers.ts); the phone door uses this one. Kept in its own file so remote-server.ts does
// not grow and a test can replace it by passing `broadcastToWindows` to RemoteServer.
import { BrowserWindow } from 'electron';

export function sendToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
