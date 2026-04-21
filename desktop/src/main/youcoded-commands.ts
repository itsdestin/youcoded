// YouCoded-handled slash commands — clickable entries that open native UI
// rather than typing text into the terminal.
//
// These take precedence over filesystem and CC built-in commands with the same
// name. Promoting a CC built-in to clickable means adding it here AND adding
// a dispatcher case in slash-command-dispatcher.ts.
//
// Aliases expand to additional CommandEntry objects sharing the same
// description and handler intent, so "/compact" and "/c" both appear in
// search results and both dispatch to the same UI action.

import type { CommandEntry } from '../shared/types';

// Entries with an `aliases` field will be expanded by `expandWithAliases()`.
// The alias entries inherit source, description, and clickable from the
// canonical entry but carry their own name.
type CommandEntryWithAliases = CommandEntry & { aliases?: string[] };

export const YOUCODED_COMMANDS: CommandEntryWithAliases[] = [
  {
    name: '/compact',
    description: 'Compact conversation context',
    source: 'youcoded',
    clickable: true,
    aliases: ['/c'],
  },
  {
    name: '/clear',
    description: 'Clear and start a new conversation',
    source: 'youcoded',
    clickable: true,
  },
  {
    name: '/model',
    description: 'Switch the AI model for this session',
    source: 'youcoded',
    clickable: true,
  },
];

// Expand alias lists into flat CommandEntry arrays. Each alias entry shares
// the description and source of its canonical entry.
export function expandWithAliases(
  entries: CommandEntryWithAliases[],
): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const entry of entries) {
    const { aliases, ...base } = entry;
    out.push(base);
    if (aliases) {
      for (const alias of aliases) {
        out.push({ ...base, name: alias });
      }
    }
  }
  return out;
}
