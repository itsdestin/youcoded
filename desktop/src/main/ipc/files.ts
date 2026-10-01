// files.ts — three single file channels: fs:read-head, file:upload and get-home-path.
//
// WHY (2026-09-30 one-core R3-7): fs:read-head and get-home-path were an ipcMain handler (in
// ipc-handlers.ts / main.ts) plus a phone `case` each; file:upload existed ONLY as a phone `case`.
//   - fs:read-head: the first bytes of a user-chosen file for the composer's attachment cards. The cap, the
//     deny list and the reasoning for NOT roots-gating it live in main/fs-read-head.ts + shared/read-head.ts;
//     a phone gets the same cap and the same sensitive-path refusal, never a wider read.
//   - get-home-path: the computer's home folder, for either door.
//   - file:upload: a phone's attach button hands a file to the computer, which writes it into its OWN temp
//     folder (never into a project) and answers where it landed. Phone only (`remoteOnly`): the computer's
//     windows never had this channel and must not gain a write-to-disk one. Kept exactly as it was, including
//     that a phone CAN do it today (see the R3-7 report).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from '../../shared/backend-contract';
import { readFileHead } from '../fs-read-head';
import { defineChannel, type MainChannelDef } from './channel-def';

export const filesChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.FS_READ_HEAD, kind: 'handle', handler: (p) => readFileHead(p?.filePath, p?.maxBytes) }),
  defineChannel({ name: IPC.GET_HOME_PATH, kind: 'handle', handler: () => os.homedir() }),
  defineChannel({
    name: IPC.FILE_UPLOAD, kind: 'handle', remoteOnly: true,
    handler: async (payload) => {
      const uploadDir = path.join(os.tmpdir(), 'claude-desktop-uploads');
      try {
        await fs.promises.mkdir(uploadDir, { recursive: true });
        // Sanitize filename — strip path separators and limit length
        const rawName = String(payload.name || 'upload').replace(/[/\\:*?"<>|]/g, '_').slice(0, 200);
        const filePath = path.join(uploadDir, `${Date.now()}-${rawName}`);
        const buffer = Buffer.from(payload.data, 'base64');
        await fs.promises.writeFile(filePath, buffer);
        return { path: filePath };
      } catch {
        return { error: 'Upload failed' };
      }
    },
  }),
];
