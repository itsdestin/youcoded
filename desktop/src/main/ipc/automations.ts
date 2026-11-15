// automations.ts — the automations:* channels, one table entry each, served to the computer's windows and
// to a phone (pages-finish step 4). The service and its `automations:changed` push live in
// main/automations/automations-service.ts.
//
// WHY every entry is closed to a PAIRED phone or remote browser for now (`remoteAllowed: false`): what a
// phone may call is Destin's decision, pinned in tests/fixtures/phone-open-channels.json, and he has not
// been asked yet. The Android app itself runs this backend as its owner, so it is not affected.
// Nothing here is reachable from inside a page: a page's own button goes through the page kit's door,
// which may only start an automation linked to that page.
import { IPC } from '../../shared/backend-contract';
import type { AutomationSummary } from '../../shared/automation-types';
import { getAutomationsService } from '../automations/automations-service';
import { defineChannel, type MainChannelDef } from './channel-def';

const str = (v: unknown) => String(v ?? '');

export const automationsChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.AUTOMATIONS_LIST, kind: 'handle', remoteAllowed: false, handler: async () => (await getAutomationsService()?.list()) ?? [] }),
  defineChannel({ name: IPC.AUTOMATIONS_RUNS, kind: 'handle', remoteAllowed: false, handler: async (p) => (await getAutomationsService()?.runs(str(p?.id))) ?? [] }),
  defineChannel({
    name: IPC.AUTOMATIONS_SAVE, kind: 'handle', remoteAllowed: false,
    handler: async (p) => {
      const svc = getAutomationsService();
      const job = p?.job as AutomationSummary | undefined;
      if (!svc || !job || typeof job.id !== 'string' || typeof job.name !== 'string' || !Array.isArray(job.tools)) throw new Error('This automation could not be saved.');
      return svc.save(job);
    },
  }),
  defineChannel({ name: IPC.AUTOMATIONS_SET_ENABLED, kind: 'handle', remoteAllowed: false, handler: async (p) => (await getAutomationsService()?.setEnabled(str(p?.id), p?.enabled === true)) ?? [] }),
  defineChannel({ name: IPC.AUTOMATIONS_RUN_NOW, kind: 'handle', remoteAllowed: false, handler: async (p) => (await getAutomationsService()?.runNow(str(p?.id)))?.jobs ?? [] }),
  defineChannel({
    name: IPC.AUTOMATIONS_ANSWER, kind: 'handle', remoteAllowed: false,
    handler: async (p) => (await getAutomationsService()?.answer(str(p?.id), p?.allow === true, typeof p?.note === 'string' ? p.note : undefined, p?.fromNowOn === true)) ?? [],
  }),
  defineChannel({ name: IPC.AUTOMATIONS_REMOVE, kind: 'handle', remoteAllowed: false, handler: async (p) => (await getAutomationsService()?.remove(str(p?.id))) ?? [] }),
];
