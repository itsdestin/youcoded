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
  chat('chat/commands', 'drawer'),
  { ...chat('chat/overflow', 'menu', 'narrow'), viewport: { width: 390, height: 844 } },
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
  { name: 'welcome/new-session', tags: ['view'], scenario: 'empty', sameAs: { name: 'welcome', why: 'a first-ever launch opens the form already' } },
  { name: 'projects', tags: ['view', 'projects'] },
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
  // The arcade signed in (a friend online), and its lonelier states.
  { ...chat('chat/games#signed-in', 'pane', 'games'), params: { signedIn: '1' } },
  ...['degraded', 'empty'].map((a) => ({ ...chat(`chat/games#${a}`, 'pane', 'games'), params: { signedIn: '1', arcade: a } })),
  // The status bar per kind of session (scenarios built for it).
  ...(['statusbar-cc', 'statusbar-local', 'statusbar-metered', 'statusbar-unpriced', 'statusbar-delegated'] as const).map((sc) => ({ ...chat(`chat#${sc}`, 'view', 'status-bar'), scenario: sc })),
  // A read that fails when the screen opens (?fail=<channel>).
  { ...chat('chat/skills#load-failed', 'drawer', 'error-state'), params: { fail: 'skills.list' } },
  { ...chat('chat/tags#load-failed', 'dialog', 'error-state'), params: { fail: 'tags.list' } },
  { ...chat('chat/close-session#meta-unreadable', 'dialog', 'error-state'), params: { fail: 'session.getMeta' } },
  // Each game, signed in (a friend online). Chess and Connect 4 land on a board by
  // autoplay; autoplay=0 keeps them in the lobby, where the head-to-head record shows.
  { ...chat('chat/games/flappy', 'pane', 'games'), params: { signedIn: '1' } },
  { ...chat('chat/games/flappy#alone', 'pane', 'games'), params: { signedIn: '1', arcade: 'alone' } },
  { ...chat('chat/games/flappy/play', 'pane', 'games'), params: { signedIn: '1' } },
  { ...chat('chat/games/2048', 'pane', 'games'), params: { signedIn: '1' } },
  { ...chat('chat/games/chess', 'pane', 'games'), params: { signedIn: '1' } },
  { ...chat('chat/games/chess/lobby', 'pane', 'games'), params: { signedIn: '1', autoplay: '0' } },
  { ...chat('chat/games/connect-four', 'pane', 'games'), params: { signedIn: '1' } },
  { ...chat('chat/games/connect-four/lobby', 'pane', 'games'), params: { signedIn: '1', autoplay: '0' } },
  // Another computer holds this conversation: each phase of "open it here instead?".
  ...['confirm', 'force', 'undeliverable', 'claim-denied'].map((ph) => chat(`chat/takeover/${ph}`, 'dialog', 'handoff')),
  chat('chat/resume/preview', 'dialog'),
  { ...chat('chat/resume/preview#stress', 'dialog'), scenario: 'stress' },
  { ...chat('chat/specialists', 'dialog'), session: 'wb-11' },
  chat('chat/tags/manage', 'dialog'),
  { ...chat('chat/tags/manage#load-failed', 'dialog', 'error-state'), params: { fail: 'tags.list' } },
  { ...chat('chat/update', 'dialog'), params: { update: 'available' } },
  // Files in the viewer: a chart image, a diagram, a PDF (fixture files).
  chat('chat/files/open/a-sent-chart', 'pane', 'viewer'),
  chat('chat/files/open/a-sent-diagram', 'pane', 'viewer'),
  chat('chat/files/open/a-sent-pdf', 'pane', 'viewer'),
];
