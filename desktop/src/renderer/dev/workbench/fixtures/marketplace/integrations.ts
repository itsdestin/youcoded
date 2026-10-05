// Integrations for the workbench Marketplace (the "Integrations" rail and its
// detail popup). WHY this exists (2026-10-04, marketplace detail redesign): the
// workbench answered `integrations.list` with the catch-all's `[]`, so the
// integration detail popup could never be opened, photographed or reviewed —
// a screen nobody had looked at since it shipped. Three entries cover its three
// distinct looks: signed-in-needed (Connect), connected, and not available on
// this computer. Values are invented; nothing here ships.
import type { IntegrationEntry, IntegrationState } from '../../../../../shared/types';

export type WorkbenchIntegration = IntegrationEntry & { state: IntegrationState };

export const WORKBENCH_INTEGRATIONS: WorkbenchIntegration[] = [
  {
    slug: 'google-workspace',
    displayName: 'Google Workspace',
    tagline: 'Gmail, Calendar and Drive in your conversations.',
    longDescription: 'Lets the assistant read and draft email, check your calendar and find files in Drive.\n\nYou sign in with Google once; nothing is stored outside your computer.',
    kind: 'plugin',
    setup: { type: 'plugin', pluginId: 'google-workspace', requiresOAuth: true, oauthProvider: 'Google', postInstallCommand: '/google-services-setup' },
    status: 'available',
    accentColor: '#4285F4',
    lifeArea: ['work'],
    tags: ['email', 'calendar'],
    state: { slug: 'google-workspace', installed: true, connected: false },
  },
  {
    slug: 'todoist',
    displayName: 'Todoist',
    tagline: 'Add and check off tasks by asking.',
    kind: 'mcp',
    setup: { type: 'api-key', keyName: 'TODOIST_API_TOKEN' },
    status: 'available',
    accentColor: '#E44332',
    tags: ['tasks'],
    state: { slug: 'todoist', installed: true, connected: true },
  },
  {
    slug: 'imessage',
    displayName: 'iMessage',
    tagline: 'Read and send texts from your Mac.',
    kind: 'shell',
    setup: { type: 'macos-only' },
    status: 'available',
    platforms: ['darwin'],
    tags: ['messages'],
    state: { slug: 'imessage', installed: false, connected: false },
  },
];
