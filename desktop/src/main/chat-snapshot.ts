import { ipcMain, WebContents } from 'electron';
import type { SerializedChatState } from '../renderer/state/chat-types';

const EXPORT_CHANNEL = 'chat:export-snapshot';
const RESPONSE_CHANNEL = 'chat:snapshot-response';
const TIMEOUT_MS = 2000;

/**
 * Request a serialized ChatState snapshot from a renderer webContents.
 * Resolves with { sessions: [] } if the renderer doesn't respond within
 * 2s (e.g. still booting). Used by the remote-access server to hand new
 * browser clients the full chat history on connect.
 */
export function requestChatSnapshot(webContents: WebContents): Promise<SerializedChatState> {
  const requestId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let settled = false;
    const onResponse = (_e: Electron.IpcMainEvent, payload: { requestId: string; snapshot: SerializedChatState }) => {
      if (settled || payload.requestId !== requestId) return;
      settled = true;
      ipcMain.off(RESPONSE_CHANNEL, onResponse);
      clearTimeout(timer);
      resolve(payload.snapshot);
    };
    ipcMain.on(RESPONSE_CHANNEL, onResponse);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ipcMain.off(RESPONSE_CHANNEL, onResponse);
      console.warn('[chat-snapshot] export timed out, returning empty snapshot');
      resolve({ sessions: [] });
    }, TIMEOUT_MS);
    try {
      webContents.send(EXPORT_CHANNEL, requestId);
    } catch (err) {
      console.error('[chat-snapshot] send failed:', err);
      if (!settled) {
        settled = true;
        ipcMain.off(RESPONSE_CHANNEL, onResponse);
        clearTimeout(timer);
        resolve({ sessions: [] });
      }
    }
  });
}
