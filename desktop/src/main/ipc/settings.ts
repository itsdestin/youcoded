// settings.ts — Claude Code's settings.json, read and written one dot-path field at a time.
//
// WHY (2026-09-30 one-core R3-1): both doors already called claude-settings.ts (the ONE
// reader/writer: memoised read, locked atomic write, corrupt-file backup, and the refusal of
// `__proto__` / `constructor` / `prototype` path segments, audit D6/B3). The bodies were the
// same, so they are one entry each now. A paired phone reaches this: the prototype-pollution
// refusal lives in getJsonPath/setJsonPath, NOT here, so no door can skip it.
import { IPC } from '../../shared/backend-contract';
import { getField, setField, takeSettingsRepairNotice } from '../claude-settings';
import { defineChannel, type MainChannelDef } from './channel-def';

export const settingsChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.SETTINGS_GET, kind: 'handle',
    handler: async (payload) => {
      // An unsafe or missing path reads as "not set", never as an error.
      try { return await getField(payload?.field ?? ''); } catch { return undefined; }
    },
  }),
  defineChannel({
    name: IPC.SETTINGS_SET, kind: 'handle',
    // setField answers false (never throws) for an unsafe path or a locked file.
    handler: (payload) => setField(payload?.field ?? '', payload?.value),
  }),
  // Card #11 a. WHY open to a phone (Destin, overnight deck C-1, 2026-11-13: "Yes, phones too"): the Android app does the
  // same repair, and that is where a silent reset is most likely to go unnoticed. The answer is only the kept file's
  // location; the notice is handed out once in total, so whichever window asks first (the computer's own, at launch) gets it.
  defineChannel({
    name: IPC.SETTINGS_REPAIR_NOTICE, kind: 'handle',
    handler: () => takeSettingsRepairNotice(),
  }),
];
