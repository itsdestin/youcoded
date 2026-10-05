// analytics.ts — the anonymous-analytics opt-out (About → Privacy).
//
// WHY (2026-09-30 one-core R3-1): this is the HOST's own telemetry switch, never served to a
// phone: the old phone door had no case for it and answered "not available over remote". The
// entries say so as policy (`remoteAllowed: false`), which produces the same answer.
import { IPC } from '../../shared/backend-contract';
import { getOptIn, setOptIn } from '../analytics-service';
import { defineChannel, type MainChannelDef } from './channel-def';

export const analyticsChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.ANALYTICS_GET_OPT_IN, kind: 'handle', remoteAllowed: false, handler: () => getOptIn() }),
  defineChannel({
    name: IPC.ANALYTICS_SET_OPT_IN, kind: 'handle', remoteAllowed: false,
    // The renderer flips optimistically and reverts on failure, so nothing is returned.
    handler: (payload) => { setOptIn(Boolean(payload?.enabled)); },
  }),
];
