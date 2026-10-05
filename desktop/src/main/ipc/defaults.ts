// defaults.ts — the session defaults (skipPermissions, model, projectFolder, permission overrides).
//
// WHY (2026-09-30 one-core R3-1): prefs-service.ts already held the one read/write; the two
// doors' bodies were identical, so this is a pure move. The sink that hands a saved override
// block to main.ts's enforcement cache is still registered once in registerIpcHandlers.
import { IPC } from '../../shared/backend-contract';
import { readDefaults, writeDefaults } from '../prefs-service';
import { defineChannel, type MainChannelDef } from './channel-def';

export const defaultsChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.DEFAULTS_GET, kind: 'handle', handler: () => readDefaults() as any }),
  defineChannel({
    name: IPC.DEFAULTS_SET, kind: 'handle',
    // A non-object payload saves nothing rather than throwing (both doors always did this).
    handler: (payload) => writeDefaults(payload && typeof payload === 'object' ? payload : {}) as any,
  }),
];
