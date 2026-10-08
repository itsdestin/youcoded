// The chat window and what opens from it (header, composer, status bar), plus
// the full-screen views reached from the header and the welcome screen.
import type { ScreenEntry } from './types';

const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });

export const CHAT: readonly ScreenEntry[] = [
  chat('chat', 'view'),
  chat('chat/sessions', 'menu'),
  chat('chat/switcher', 'menu'),
  chat('chat/rename-session', 'dialog'),
  chat('chat/close-session', 'dialog'),
  chat('chat/find', 'bar'),
  chat('chat/skills', 'drawer'),
  chat('chat/commands', 'drawer'),
  { ...chat('chat/overflow', 'menu', 'narrow'), viewport: { width: 390, height: 844 } },
  chat('chat/model-picker', 'dialog'),
  chat('chat/model-picker/fast-mode', 'dialog'),
  chat('chat/model-picker/switch-model', 'dialog'),
  chat('chat/preferences', 'dialog'),
  chat('chat/resume', 'dialog'),
  { ...chat('chat/resume#stress', 'dialog'), scenario: 'stress' },
  chat('chat/open-tasks', 'dialog'),
  chat('chat/tags', 'dialog'),
  chat('chat/status-bar', 'dialog'),
  chat('chat/status-bar/themes', 'dialog'),
  chat('chat/context', 'dialog'),
  // A real, unexpired announcement — statusData otherwise always sends `null`.
  { ...chat('chat/announcement', 'dialog'), params: { announcement: '1' } },
  chat('chat/quick-chips', 'dialog'),
  chat('chat/quick-chips/edit', 'dialog'),
  chat('chat/quick-chips/add', 'dialog'),
  chat('chat/session-context', 'dialog'),
  // A skill's fold, opened and pointed at — now the shared FoldRow (submit-ticket-5).
  { ...chat('chat/session-context#skill-open-hover', 'dialog', 'fold'), open: [{ do: 'click', target: { role: 'tab', label: 'Skills' } }, 'theme-builder Build, preview and publish a community theme', { do: 'hover', target: { role: 'button', label: 'theme-builder Build, preview and publish a community theme' } }] },
  { ...chat('chat/session-context#ancestors', 'dialog'), session: 'wb-2', params: { contextChain: '1' } },
  chat('chat/quit-sessions', 'dialog'),
  // Each first-run warning, once per kind (localStorage is unwritten on a fresh
  // photo-only tab, so every kind is still un-acknowledged).
  ...['skip-permissions', 'full-auto', 'small-model'].map((k) => chat(`chat/first-time-warning/${k}`, 'dialog')),
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
  // A just-signed-in account with no handle yet (mock-shim's `?handleMissing=1`,
  // paired with `?signedIn=1` so account.user() reports one at all).
  { name: 'handle-prompt', tags: ['dialog'], params: { signedIn: '1', handleMissing: '1' } },
  // Conversations on the practice sessions. wb-2 is the native-runtime session that the
  // seeded conversations, OpenRouter error cards and the stalled replay play into.
  { ...chat('chat#native', 'view'), session: 'wb-2' },
  // Dev-only fixture: real shared question card with duplicate wording, selected
  // and typed via explore rather than drawing a stand-in or changing the app.
  { ...chat('chat#questions-native', 'view'), session: 'wb-2', params: { seed: 'bubbles-questions-native' } },
  { ...chat('chat#questions-cc', 'view'), session: 'wb-1', params: { seed: 'bubbles-questions-cc' } },
  { ...chat('chat#chatgpt', 'view'), session: 'wb-3' },
  { ...chat('chat#chatgpt-plan-limit', 'view', 'error-state'), session: 'wb-3', params: { planLimit: '1' } },
  { ...chat('chat#stalled', 'view', 'error-state'), session: 'wb-2', params: { stalled: '1' } },
  ...['key-rejected', 'key-expired', 'credit-short', 'request-refused'].map((e) => ({ ...chat(`chat#openrouter-${e}`, 'view', 'error-state'), session: 'wb-2', params: { openrouter: 'verified', providerError: e } })),
  ...['handoff', 'reasoning-stop', 'skill-first', 'approval', 'skills-spread', 'skills-chain', 'deliverables', 'mix', 'silent-steps'].map((b) => ({ ...chat(`chat#bubbles-${b}`, 'view', 'conversation'), session: 'wb-2', params: { seed: `bubbles-${b}` } })),
  // First-run setup, one entry per step (?firstRun=<STEP>). LAUNCH_WIZARD is left out: it
  // hands over to the app after 1.5 s by design.
  ...['DETECT_PREREQUISITES', 'INSTALL_PREREQUISITES', 'AUTHENTICATE'].map((st) => ({ name: `first-run#${st.toLowerCase().replace(/_/g, '-')}`, tags: ['first-run', 'view'], params: { firstRun: st } })),
  // The sign-in step's second page, one kind opened (deck first-run-2 P2-3).
  { name: 'first-run#signin-payg', tags: ['first-run', 'view'], params: { firstRun: 'AUTHENTICATE', signInPick: 'payg' } },
  { name: 'first-run#installing', tags: ['first-run', 'view'], params: { firstRun: 'INSTALL_PREREQUISITES', prereqs: 'installing' } },
  { name: 'first-run#install-failed', tags: ['first-run', 'view'], params: { firstRun: 'INSTALL_PREREQUISITES', prereqs: 'failed' } },
  { name: 'first-run#authenticate-chatgpt', tags: ['first-run', 'view', 'sign-in'], params: { firstRun: 'AUTHENTICATE', authMode: 'chatgpt' } },
  // A new user's checklist: Git installing, then Git done at sign-in (?prereqs, mock-shim).
  { name: 'first-run#setup-installing', tags: ['first-run', 'view'], viewport: { width: 800, height: 440 }, params: { firstRun: 'INSTALL_PREREQUISITES', prereqs: 'installing' } },
  { name: 'first-run#setup-done', tags: ['first-run', 'view'], viewport: { width: 800, height: 680 }, params: { firstRun: 'AUTHENTICATE', prereqs: 'done' } },
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
  // The friends panel's states (backlog row 11; mock-shim `?friends=`): four friends with every
  // status, none yet, a request each way; then a phone and a 640×480 window. The chess lobby with
  // the same four friends shows a winning, a losing, an even and a never-played record.
  { ...chat('chat/games#friends', 'pane', 'games'), params: { signedIn: '1', friends: 'many' } },
  { ...chat('chat/games#no-friends', 'pane', 'games'), params: { signedIn: '1', friends: 'none' } },
  // Opened (it starts folded) so its rows compare with round 1's always-open card.
  { ...chat('chat/games#requests', 'pane', 'games'), params: { signedIn: '1', friends: 'requests', friendsOpen: '1' } },
  { ...chat('chat/games#phone', 'pane', 'games', 'narrow'), viewport: { width: 390, height: 844 }, params: { signedIn: '1', friends: 'many' } },
  { ...chat('chat/games#signed-out-phone', 'pane', 'games', 'narrow'), viewport: { width: 390, height: 844 } },
  { ...chat('chat/games#small', 'pane', 'games'), viewport: { width: 640, height: 480 }, params: { signedIn: '1', friends: 'many' } },
  { ...chat('chat/games/chess/lobby#friends', 'pane', 'games'), params: { signedIn: '1', autoplay: '0', friends: 'many' } },
  { ...chat('chat/games/chess/lobby#no-friends', 'pane', 'games'), params: { signedIn: '1', autoplay: '0', friends: 'none' } },
  { ...chat('chat/games/chess/lobby#phone', 'pane', 'games', 'narrow'), viewport: { width: 390, height: 844 }, params: { signedIn: '1', autoplay: '0', friends: 'many' } },
  // Round 2 (deck games-social-2): a friends list long enough to scroll and the three
  // not-connected states.
  { ...chat('chat/games#long', 'pane', 'games'), params: { signedIn: '1', friends: 'lots', friendsOpen: '1' } },
  { ...chat('chat/games#incognito', 'pane', 'games'), params: { signedIn: '1', friends: 'many', incognito: '1' } },
  // Incognito with the card opened: friends' statuses still show (hidden presence, round 5).
  { ...chat('chat/games#incognito-open', 'pane', 'games'), params: { signedIn: '1', friends: 'many', incognito: '1', friendsOpen: '1' } },
  { ...chat('chat/games#offline', 'pane', 'games'), params: { signedIn: '1', friends: 'many', network: 'offline' } },
  // Your status pill's menu open, and a friend's details popup (a Dialog, deck games-social-4).
  // The menu is opened by clicking the pill (screen list `open`), not by a practice switch.
  { ...chat('chat/games#status-menu', 'pane', 'games'), params: { signedIn: '1', friends: 'many' }, open: ['Your status: Online'] },
  { ...chat('chat/games/friend', 'dialog', 'games'), params: { signedIn: '1', friends: 'many', friendsOpen: '1' } },
  // Another computer holds this conversation: each phase of "open it here instead?".
  ...['confirm', 'force', 'undeliverable', 'claim-denied'].map((ph) => chat(`chat/takeover/${ph}`, 'dialog', 'handoff')),
  chat('chat/resume/preview', 'dialog'),
  chat('chat/resume/organize', 'dialog'),
  { ...chat('chat/resume/preview#stress', 'dialog'), scenario: 'stress' },
  // The pre-resume model picker: a fixture claudeSessionId, no real resume behind it.
  chat('chat/resume/pick-model', 'dialog'),
  { ...chat('chat/specialists', 'dialog'), session: 'wb-11' },
  { ...chat('chat/update', 'dialog'), params: { update: 'available' } },
  // Files in the viewer: a chart image, a diagram, a PDF (fixture files).
  chat('chat/files/open/a-sent-chart', 'pane', 'viewer'),
  chat('chat/files/open/a-sent-diagram', 'pane', 'viewer'),
  chat('chat/files/open/a-sent-pdf', 'pane', 'viewer'),
  // Office (design stage): a Word file's quick preview, then Edit in place.
  chat('chat/files/open/a-sent-plan', 'pane', 'viewer', 'office'),
  chat('chat/files/edit/a-sent-plan', 'pane', 'viewer', 'office'),
  // The reading view of the Word and Excel files whose comments office/*-comments shows in
  // Office's own panel — the two are compared side by side (finish plan Task 6).
  chat('chat/files/open/a-launch-brief', 'pane', 'viewer'),
  // Git review (Review changes): a commit card opened and pointed at — the card lights as one,
  // no hard line above the changes (submit-ticket-5#ST5-Q2). Marked by the drawer itself
  // ('chat/files'): the review replaces the viewer, whose own mark goes with it.
  { ...chat('chat/files/open/a-launch-brief#git-review', 'pane', 'viewer'), mark: 'chat/files',
    open: ['Review changes', '▸ a1b2c3d chat: cache the per-session selector…', { do: 'hover', target: { role: 'button', labelStarts: '▸ a1b2c3d chat: cache the per-session selector' } }] },
  chat('chat/files/open/a-q3-sales-comments', 'pane', 'viewer'),
];
