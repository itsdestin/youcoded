// YouCoded-handled slash commands. Each has native UI implemented in
// `src/renderer/state/slash-command-dispatcher.ts`. Keep this list in
// sync with the `switch` cases in that file.
//
// `runsIn` is checked against the dispatcher itself: tests/slash-command-dispatcher.test.ts calls dispatchSlashCommand for every
// command below as a YouCoded-runtime chat and fails if the route it takes disagrees with the value written here.

import type { CommandEntry } from '../shared/types';

export const YOUCODED_COMMANDS: CommandEntry[] = [
  { name: '/compact', description: 'Compact conversation with native spinner card', source: 'youcoded', clickable: true, runsIn: 'both' },
  { name: '/clear',   description: 'Clear conversation timeline with native marker', source: 'youcoded', clickable: true, runsIn: 'both', aliases: ['/reset', '/new'] },
  { name: '/model',   description: 'Open native model picker',                        source: 'youcoded', clickable: true, runsIn: 'both' },
  { name: '/fast',    description: 'Toggle fast mode',                                source: 'youcoded', clickable: true, runsIn: 'both' },
  { name: '/effort',  description: 'Open effort-level picker',                        source: 'youcoded', clickable: true, runsIn: 'both' },
  { name: '/copy',    description: 'Copy assistant response to clipboard',            source: 'youcoded', clickable: true, runsIn: 'both' },
  { name: '/resume',  description: 'Open native Resume Browser',                      source: 'youcoded', clickable: true, runsIn: 'both' },
  { name: '/config',  description: 'Open Preferences popup',                          source: 'youcoded', clickable: true, runsIn: 'both', aliases: ['/settings'] },
  { name: '/cost',    description: 'Show native Usage card',                          source: 'youcoded', clickable: true, runsIn: 'both', aliases: ['/usage'] },
];

// Flatten primary entries + aliases so each is an independently
// searchable row in the drawer. Aliases inherit description + click
// behavior from the primary.
export function expandWithAliases(entries: CommandEntry[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const entry of entries) {
    out.push({ ...entry, aliases: undefined });
    for (const alias of entry.aliases ?? []) {
      out.push({ ...entry, name: alias, aliases: undefined });
    }
  }
  return out;
}
