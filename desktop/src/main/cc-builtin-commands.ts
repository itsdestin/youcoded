// Hardcoded list of Claude Code built-in slash commands.
//
// Last verified against Claude Code CLI v2.1.211 — 2026-07-15.
// Update this stamp when re-verified; see docs/cc-dependencies.md.
//
// Intentionally EXCLUDED (issue #85): top-level CLI subcommands are not
// in-session slash commands, so they never belong in the CommandDrawer —
// notably `claude project purge` (v2.1.126; destructive: deletes all CC
// state for a project) and `claude ultrareview` (v2.1.120; CI runner).
// Typing them into the PTY as `/project purge` would do nothing.
//
// Why hardcoded: Claude Code ships as a compiled binary with no filesystem-
// discoverable manifest for its built-in commands. The SDK init message
// (`system/init.slash_commands`) omits most core meta commands (/help,
// /status, /permissions, etc.) and provides name-only data for the rest.
// Maintaining the list by hand with a `cc-dependencies.md` audit entry is
// the least-fragile path for this data. When CC adds, renames, or removes
// a built-in, the `review-cc-changes` release agent flags the drift.
//
// Every entry is unclickable: its UI is a terminal-only TUI panel that
// does not render in chat view. Promoting a built-in to clickable means
// moving it into youcoded-commands.ts and adding a dispatcher case in
// slash-command-dispatcher.ts.

import type { CommandEntry } from '../shared/types';

export const DISABLED_REASON = (name: string): string =>
  `Please run ${name} in Terminal View.`;

const CC_BUILTIN_LIST: CommandEntry[] = [
  { name: '/help',            description: 'Show Claude Code help',                            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/help') },
  { name: '/status',          description: 'Show session, config, and auth status',            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/status') },
  { name: '/permissions',     description: 'Manage tool permissions',                          source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/permissions') },
  { name: '/memory',          description: 'Edit CLAUDE.md memory files',                      source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/memory') },
  // /agents removed: CC v2.1.198 deleted the /agents wizard — the command now
  // only prints "The /agents wizard has been removed." (verified against the
  // v2.1.211 binary), so surfacing it in search would point users at a stub.
  { name: '/mcp',             description: 'Manage MCP servers',                               source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/mcp') },
  { name: '/plugin',          description: 'Manage plugins',                                   source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/plugin') },
  { name: '/hooks',           description: 'Manage hooks',                                     source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/hooks') },
  { name: '/doctor',          description: 'Diagnose the installation',                        source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/doctor') },
  { name: '/logout',          description: 'Sign out of your Anthropic account',               source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/logout') },
  { name: '/context',         description: 'Show current context-window usage',                source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/context') },
  { name: '/review',          description: 'Review a pull request',                            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/review') },
  { name: '/security-review', description: 'Review pending changes for security issues',       source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/security-review') },
  { name: '/init',            description: 'Initialize a CLAUDE.md file',                      source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/init') },
  // /extra-usage was renamed to /usage-credits in CC v2.1.144 (the old name
  // still works as an alias); list the new canonical name only.
  { name: '/usage-credits',   description: 'Configure usage credits',                          source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/usage-credits') },
  { name: '/heapdump',        description: 'Dump a heap snapshot',                             source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/heapdump') },
  { name: '/insights',        description: 'Show session insights',                            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/insights') },
  { name: '/team-onboarding', description: 'Team setup flow',                                  source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/team-onboarding') },
  // Added between the v2.1.117 and v2.1.211 anchors (issue #85 gap review):
  { name: '/cd',              description: 'Move this session to a new working directory',     source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/cd') },              // CC v2.1.169
  { name: '/goal',            description: 'Set a goal Claude checks before stopping',         source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/goal') },            // CC v2.1.139
  { name: '/reload-skills',   description: 'Re-scan skill directories without restarting',     source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/reload-skills') },   // CC v2.1.152
  { name: '/scroll-speed',    description: 'Adjust mouse wheel scroll speed',                  source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/scroll-speed') },    // CC v2.1.139
];

// WHY the stamp is applied here and not on each line (waiting-notice T5): every one of these is a Claude Code panel with no
// YouCoded-runtime equivalent, so the chat drawer hides them in a YouCoded-runtime chat. Stamping the whole list in one
// place means a command added above cannot be forgotten.
export const CC_BUILTIN_COMMANDS: CommandEntry[] = CC_BUILTIN_LIST.map((c) => ({ ...c, runsIn: 'claude-code' as const }));
