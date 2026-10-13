// folders.ts — the new-session folder picker's five channels, one body for both doors.
//
// WHY (2026-09-30 one-core R3-1): the operations already lived in folders-service.ts (shared
// since 2026-09-11); what was still written twice was the wiring. The remote copy wrapped each
// call in a try/catch that answered a soft fallback, while the desktop lets a throw reject.
// `remoteOnError` keeps both exactly: a phone still gets the answer it always got.
import os from 'os';
import { IPC } from '../../shared/backend-contract';
import { listPickerFolders, addFolder, removeFolder, renameFolder, setFolderDescription } from '../folders-service';
import { defineChannel, type MainChannelDef } from './channel-def';

export const foldersChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.FOLDERS_LIST, kind: 'handle',
    handler: () => listPickerFolders(),
    // A phone whose folder read failed still shows Home rather than an empty picker.
    remoteOnError: () => [{ path: os.homedir(), nickname: 'Home', addedAt: Date.now(), exists: true }],
  }),
  defineChannel({
    name: IPC.FOLDERS_ADD, kind: 'handle',
    handler: (payload) => addFolder(payload.folderPath, payload.nickname),
    remoteOnError: () => null,
  }),
  defineChannel({
    name: IPC.FOLDERS_REMOVE, kind: 'handle',
    handler: (payload) => removeFolder(payload.folderPath),
    remoteOnError: () => false,
  }),
  defineChannel({
    name: IPC.FOLDERS_RENAME, kind: 'handle',
    handler: (payload) => renameFolder(payload.folderPath, payload.nickname),
    remoteOnError: () => false,
  }),
  defineChannel({
    name: IPC.FOLDERS_SET_DESCRIPTION, kind: 'handle',
    handler: (payload) => setFolderDescription(payload.folderPath, payload.description),
    remoteOnError: () => false,
  }),
];
