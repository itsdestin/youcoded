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
import { uploadDir, MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_SENTENCE, sanitizeUploadName, sweepOldUploads, uploadFolderBytes, MAX_UPLOAD_FOLDER_BYTES, UPLOAD_FOLDER_FULL_SENTENCE } from '../upload-store';
import { defineChannel, type MainChannelDef } from './channel-def';
import { refuseHeadOutsideKnownFolders } from './file-gates';

export const filesChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.FS_READ_HEAD, kind: 'handle',
    // WHY (2026-10-01 one-core R3-SEC): a phone is held to the folders the computer shows (plus the upload folder its
    // attach preview reads) and to the phone deny list; the computer's own windows stay ungated, as the composer
    // attaches whatever the person picks in the OS file dialog.
    handler: async (p, ctx) => (ctx.door === 'remote' ? await refuseHeadOutsideKnownFolders(p?.filePath) : null) ?? readFileHead(p?.filePath, p?.maxBytes),
  }),
  defineChannel({ name: IPC.GET_HOME_PATH, kind: 'handle', handler: () => os.homedir() }),
  defineChannel({
    name: IPC.FILE_UPLOAD, kind: 'handle', remoteOnly: true,
    handler: async (payload) => {
      // WHY (2026-10-01 one-core R3-SEC): a size cap, checked on the base64 text BEFORE it is decoded (base64 is 4
      // characters per 3 bytes), so an oversized upload never allocates a buffer. Refused with a sentence the
      // phone shows, not a generic failure.
      if (typeof payload?.data !== 'string') return { error: 'Upload failed' };
      if (Math.floor((payload.data.length * 3) / 4) > MAX_UPLOAD_BYTES) return { error: UPLOAD_TOO_LARGE_SENTENCE };
      const dir = uploadDir();
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        // WHY (2026-10-01 one-core R3-SEC review): a ceiling on the whole folder, after an inline sweep of old files.
        const incoming = Math.floor((payload.data.length * 3) / 4);
        if ((await uploadFolderBytes(dir)) + incoming > MAX_UPLOAD_FOLDER_BYTES) {
          await sweepOldUploads(dir);
          if ((await uploadFolderBytes(dir)) + incoming > MAX_UPLOAD_FOLDER_BYTES) return { error: UPLOAD_FOLDER_FULL_SENTENCE };
        }
        // Sanitize filename — strip path separators and control characters, limit length
        const filePath = path.join(dir, `${Date.now()}-${sanitizeUploadName(payload.name)}`);
        const buffer = Buffer.from(payload.data, 'base64');
        if (buffer.length > MAX_UPLOAD_BYTES) return { error: UPLOAD_TOO_LARGE_SENTENCE };
        await fs.promises.writeFile(filePath, buffer);
        return { path: filePath };
      } catch {
        return { error: 'Upload failed' };
      }
    },
  }),
];
