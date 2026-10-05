// integrations.ts — integrations:list / status / install / uninstall / configure / connect (Settings and the Marketplace's
// integrations tab). The computer's own installer only.
//
// WHY (2026-10-01 one-core R3-8): six ipcMain handlers in ipc-handlers.ts. An integration installs software and signs in on
// THIS computer, and none of it was ever bridged to a phone, so the table refuses all six for a phone from the entries with
// the "not available over remote access" answer the old default gave. The installer is built in ipc-handlers.ts (it needs
// the skill provider) and handed over. Marketplace redesign Phase 3: list and status are real; install, uninstall and
// configure are manifest-driven, with the actual sign-in running through the integration's own setup.
import { IPC } from '../../shared/backend-contract';
import { listWithState, type IntegrationInstaller } from '../integration-installer';
import { defineChannel, type MainChannelDef } from './channel-def';

let installer: IntegrationInstaller | null = null;
export function bindIntegrations(next: IntegrationInstaller): void { installer = next; }
const need = (): IntegrationInstaller => { if (!installer) throw new Error('integrations are not ready'); return installer; };

export const integrationsChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.INTEGRATIONS_LIST, kind: 'handle', desktopOnly: true, handler: () => listWithState(need()) }),
  defineChannel({ name: IPC.INTEGRATIONS_STATUS, kind: 'handle', desktopOnly: true, handler: ({ slug }) => need().status(slug) }),
  defineChannel({ name: IPC.INTEGRATIONS_INSTALL, kind: 'handle', desktopOnly: true, handler: ({ slug }) => need().install(slug) }),
  defineChannel({ name: IPC.INTEGRATIONS_UNINSTALL, kind: 'handle', desktopOnly: true, handler: ({ slug }) => need().uninstall(slug) }),
  defineChannel({ name: IPC.INTEGRATIONS_CONFIGURE, kind: 'handle', desktopOnly: true, handler: ({ slug, settings }) => need().configure(slug, settings) }),
  defineChannel({ name: IPC.INTEGRATIONS_CONNECT, kind: 'handle', desktopOnly: true, handler: ({ slug }) => need().connect(slug) }),
];
