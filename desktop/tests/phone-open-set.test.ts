// phone-open-set.test.ts — the WHOLE list of channels a phone may call, pinned.
//
// WHY (2026-10-01 one-core R6-1): until now each family's test pinned only its own open channels (the R3-8 group pinned 39), so
// nothing noticed a widening that happened in another family. This pins the entire table at once. The list lives in
// fixtures/phone-open-channels.json. Changing it is a decision for Destin: a new line there is a new thing a phone can do.
import { describe, it, expect } from 'vitest';
import { CHANNEL_TABLE } from '../src/main/ipc/channel-table';
import fixture from './fixtures/phone-open-channels.json';

const phoneOpen = (d: (typeof CHANNEL_TABLE)[number]) => !d.desktopOnly && d.remoteAllowed !== false;

/** What R6-1 opened, from Destin's answers of 2026-09-30 (the R3 run log in the remote-access plan, numbered 1-4 and 8). */
const OPENED_IN_R6_1 = [
  'theme-marketplace:list', 'theme-marketplace:detail',                       // 1 browse the theme marketplace
  'skills:get-featured', 'marketplace:get-packages',                           // 2 featured and update-available skills
  'marketplace:rate', 'marketplace:rate:delete', 'marketplace:thumb', 'marketplace:thumb:get', 'marketplace:comment', 'marketplace:theme:like', // 3 rate, vote, comment
  'session:set-flag',                                                          // 4 session flags
  'native:clear', 'native:invoke-skill',                                       // 8 clear a session, run a skill command
];

describe('the complete list of what a phone may call', () => {
  const live = CHANNEL_TABLE.filter(phoneOpen).map((d) => d.name).sort();

  it('is exactly the pinned list: nothing else opened, nothing closed', () => {
    expect(live).toEqual([...fixture.open].sort());
    expect(new Set(live).size).toBe(live.length);
  });

  it('includes every channel opened on request, and none of the neighbours that were not approved', () => {
    for (const name of OPENED_IN_R6_1) expect(live, name).toContain(name);
    const stillRefused = [
      'theme-marketplace:install', 'theme-marketplace:uninstall', 'theme-marketplace:update', 'theme-marketplace:publish',
      'theme-marketplace:refresh-registry', 'theme-marketplace:resolve-publish-state', 'theme-marketplace:generate-preview',
      'skills:update', 'marketplace:install', 'marketplace:report', 'marketplace:get-config', 'marketplace:set-config',
      'marketplace:invalidate-cache', 'marketplace:read-component',
      'chatgpt:sign-in', 'openrouter:sign-in',
    ];
    for (const name of stillRefused) expect(live, name).not.toContain(name);
  });
});
