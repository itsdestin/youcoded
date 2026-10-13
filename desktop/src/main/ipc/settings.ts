// settings.ts — Claude Code's settings.json, read and written one dot-path field at a time.
//
// WHY (2026-09-30 one-core R3-1): both doors already called claude-settings.ts (the ONE
// reader/writer: memoised read, locked atomic write, corrupt-file backup, and the refusal of
// `__proto__` / `constructor` / `prototype` path segments, audit D6/B3). The bodies were the
// same, so they are one entry each now. A paired phone reaches this: the prototype-pollution
// refusal lives in getJsonPath/setJsonPath, NOT here, so no door can skip it.
import { IPC } from '../../shared/backend-contract';
import { getField, setField } from '../claude-settings';
import { defineChannel, type MainChannelDef } from './channel-def';

export const settingsChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.SETTINGS_GET, kind: 'handle',
    handler: (payload) => {
      // An unsafe or missing path reads as "not set", never as an error.
      try { return getField(payload?.field ?? ''); } catch { return undefined; }
    },
  }),
  defineChannel({
    name: IPC.SETTINGS_SET, kind: 'handle',
    // setField answers false (never throws) for an unsafe path or a locked file.
    handler: (payload) => setField(payload?.field ?? '', payload?.value),
  }),
];
