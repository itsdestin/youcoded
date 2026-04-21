// Hardcoded list of Claude Code built-in slash commands.
//
// Last verified against Claude Code CLI v2.1.116 — 2026-04-21.
// Update this stamp when re-verified; see docs/cc-dependencies.md.
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

export const CC_BUILTIN_COMMANDS: CommandEntry[] = [
  { name: '/help',            description: 'Show Claude Code help',                            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/help') },
  { name: '/status',          description: 'Show session, config, and auth status',            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/status') },
  { name: '/permissions',     description: 'Manage tool permissions',                          source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/permissions') },
  { name: '/memory',          description: 'Edit CLAUDE.md memory files',                      source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/memory') },
  { name: '/agents',          description: 'Manage subagents',                                 source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/agents') },
  { name: '/mcp',             description: 'Manage MCP servers',                               source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/mcp') },
  { name: '/plugin',          description: 'Manage plugins',                                   source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/plugin') },
  { name: '/hooks',           description: 'Manage hooks',                                     source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/hooks') },
  { name: '/doctor',          description: 'Diagnose the installation',                        source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/doctor') },
  { name: '/logout',          description: 'Sign out of your Anthropic account',               source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/logout') },
  { name: '/context',         description: 'Show current context-window usage',                source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/context') },
  { name: '/review',          description: 'Review a pull request',                            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/review') },
  { name: '/security-review', description: 'Review pending changes for security issues',       source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/security-review') },
  { name: '/init',            description: 'Initialize a CLAUDE.md file',                      source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/init') },
  { name: '/extra-usage',     description: 'Show detailed usage data',                         source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/extra-usage') },
  { name: '/heapdump',        description: 'Dump a heap snapshot',                             source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/heapdump') },
  { name: '/insights',        description: 'Show session insights',                            source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/insights') },
  { name: '/team-onboarding', description: 'Team setup flow',                                  source: 'cc-builtin', clickable: false, disabledReason: DISABLED_REASON('/team-onboarding') },
];
