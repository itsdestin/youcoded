// The chat window and what opens from it (header, composer, status bar), plus
// the full-screen views reached from the header and the welcome screen.
import type { ScreenEntry } from './types';

const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });

export const CHAT: readonly ScreenEntry[] = [
  chat('chat', 'view'),
  chat('chat/sessions', 'menu'),
  chat('chat/switcher', 'menu'),
  chat('chat/close-session', 'dialog'),
  chat('chat/find', 'bar'),
  chat('chat/skills', 'drawer'),
  chat('chat/model-picker', 'dialog'),
  chat('chat/preferences', 'dialog'),
  chat('chat/resume', 'dialog'),
  { ...chat('chat/resume#stress', 'dialog'), scenario: 'stress' },
  chat('chat/open-tasks', 'dialog'),
  chat('chat/tags', 'dialog'),
  chat('chat/status-bar', 'dialog'),
  chat('chat/status-bar/themes', 'dialog'),
  chat('chat/quick-chips', 'dialog'),
  chat('chat/files', 'pane'),
  chat('chat/terminal', 'view'),
  chat('chat/games', 'pane'),
  // Right-click menus, opened on the first visible element of each kind.
  chat('chat/menu/assistant', 'menu'),
  chat('chat/menu/user', 'menu'),
  chat('chat/menu/composer', 'menu'),
  chat('chat/menu/code', 'menu'),
  chat('chat/menu/file', 'menu'),
  // No session at all: the first screen a new user sees.
  { name: 'welcome', tags: ['view'], scenario: 'empty' },
  { name: 'projects', tags: ['view', 'projects'] },
  { name: 'pages', tags: ['view', 'pages'] },
  { name: 'marketplace', tags: ['view', 'marketplace'] },
  { name: 'library', tags: ['view', 'marketplace'] },
  // Conversations on the practice sessions. wb-2 is the native-runtime session that the
  // seeded conversations, OpenRouter error cards and the stalled replay play into.
  { ...chat('chat#native', 'view'), session: 'wb-2' },
  { ...chat('chat#chatgpt', 'view'), session: 'wb-3' },
  { ...chat('chat#chatgpt-plan-limit', 'view', 'error-state'), session: 'wb-3', params: { planLimit: '1' } },
  { ...chat('chat#stalled', 'view', 'error-state'), session: 'wb-2', params: { stalled: '1' } },
  ...['key-rejected', 'key-expired', 'credit-short', 'request-refused'].map((e) => ({ ...chat(`chat#openrouter-${e}`, 'view', 'error-state'), session: 'wb-2', params: { openrouter: 'verified', providerError: e } })),
  ...['handoff', 'reasoning-stop', 'skill-first', 'approval', 'skills-spread', 'skills-chain', 'deliverables', 'mix', 'silent-steps'].map((b) => ({ ...chat(`chat#bubbles-${b}`, 'view', 'conversation'), session: 'wb-2', params: { seed: `bubbles-${b}` } })),
  // First-run setup, one entry per step (?firstRun=<STEP>). LAUNCH_WIZARD is left out: it
  // hands over to the app after 1.5 s by design.
  ...['DETECT_PREREQUISITES', 'INSTALL_PREREQUISITES', 'ENABLE_DEVELOPER_MODE', 'AUTHENTICATE'].map((st) => ({ name: `first-run#${st.toLowerCase().replace(/_/g, '-')}`, tags: ['first-run', 'view'], params: { firstRun: st } })),
  { name: 'first-run#authenticate-chatgpt', tags: ['first-run', 'view', 'sign-in'], params: { firstRun: 'AUTHENTICATE', authMode: 'chatgpt' } },
];
