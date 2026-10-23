// The chat window and what opens from it (header, composer, status bar), plus
// the full-screen views reached from the header and the welcome screen.
import type { ScreenEntry } from './types';

const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });

export const CHAT: readonly ScreenEntry[] = [
  chat('chat', 'view'),
  // UI-only queue review. Before preserves this branch's existing queue design, not old master.
  ...['idle-before', 'idle-after', 'uncertain-before', 'uncertain-after', 'waiting-after'].map(q => ({
    ...chat(`chat#queue-${q}`, 'view'), session: 'wb-1', params: { queuePreview: q },
    ...(q === 'idle-after' ? { sameAs: { name: 'chat', why: 'Immediate delivery intentionally has no extra chrome.' } } : {}),
  })),
  { ...chat('chat#queue-uncertain-phone', 'view', 'narrow'), session: 'wb-1', params: { queuePreview: 'uncertain-after' }, viewport: { width: 390, height: 844 } },
  // Phone connection strips (phone-reliability review deck, 2026-10-22). The Android app, since "Use this phone only" is its button;
  // before master the same state reads the old words and has no button.
  { ...chat('chat#phone-reconnecting', 'view', 'narrow'), session: 'wb-1', viewport: { width: 390, height: 844 }, params: { connection: 'remote', platform: 'android', conversation: 'reconnecting' } },
  { ...chat('chat#phone-slow', 'view', 'narrow'), session: 'wb-1', viewport: { width: 390, height: 844 }, params: { connection: 'remote', slow: '1' }, newIn: 'after' as const },
  // The other connection bands (connection notices above the message box, 2026-10-22), and one on a computer-width browser.
  { ...chat('chat#phone-catching-up', 'view', 'narrow'), session: 'wb-1', viewport: { width: 390, height: 844 }, params: { connection: 'remote', conversation: 'restoring' } },
  { ...chat('chat#phone-out-of-date', 'view', 'narrow'), session: 'wb-1', viewport: { width: 390, height: 844 }, params: { connection: 'remote', conversation: 'incomplete' } },
  { ...chat('chat#remote-reconnecting-wide', 'view'), session: 'wb-1', params: { connection: 'remote', conversation: 'reconnecting' } },
  chat('chat/sessions', 'menu'),
  chat('chat/switcher', 'menu'),
  chat('chat/rename-session', 'dialog'),
  chat('chat/close-session', 'dialog'),
  // The close prompt's other faces (backlog row 17, deck close-session-1): a session
  // carrying only a note (wb-5), one with nothing on it (wb-2), and a phone.
  { ...chat('chat/close-session#note', 'dialog'), session: 'wb-5' },
  { ...chat('chat/close-session#bare', 'dialog'), session: 'wb-2' },
  { ...chat('chat/close-session#phone', 'dialog', 'narrow'), viewport: { width: 390, height: 844 } },
  // A tag clicked: its edit box opens inside the Tags card, as in Session details.
  { ...chat('chat/close-session#tag-edit', 'dialog'), open: ['Edit work'] },
  // The note being written in place ("+ Add a note" on a session with none).
  { ...chat('chat/close-session#note-typing', 'dialog'), session: 'wb-2', open: ['+ Add a note', { do: 'type', target: { role: 'textbox', label: 'Note' }, text: 'Pick this up after the release' }] },
  chat('chat/find', 'bar'),
  chat('chat/skills', 'drawer'),
  chat('chat/commands', 'drawer'),
  { ...chat('chat/overflow', 'menu', 'narrow'), viewport: { width: 390, height: 844 } },
  chat('chat/model-picker', 'dialog'),
  // Custom providers (2026-10-20): a search that finds nothing offers "Check for new
  // models"; the first check finds Mercury 3, a failed one says which list it couldn't reach.
  { ...chat('chat/model-picker#no-match', 'dialog'), newIn: 'after', session: 'wb-2', open: [{ do: 'type', target: { role: 'textbox', label: 'Search all models' }, text: 'mercury' }] },
  { ...chat('chat/model-picker#refreshed', 'dialog'), newIn: 'after', session: 'wb-2', waitMs: 1500, open: [{ do: 'type', target: { role: 'textbox', label: 'Search all models' }, text: 'mercury' }, 'Check for new models'] },
  { ...chat('chat/model-picker#refresh-failed', 'dialog', 'error-state'), newIn: 'after', session: 'wb-2', params: { refresh: 'fail' }, open: [{ do: 'type', target: { role: 'textbox', label: 'Search all models' }, text: 'mercury' }, 'Check for new models'] },
  chat('chat/model-picker/fast-mode', 'dialog'),
  chat('chat/model-picker/switch-model', 'dialog'),
  chat('chat/preferences', 'dialog'),
  chat('chat/resume', 'dialog'),
  { ...chat('chat/resume#stress', 'dialog'), scenario: 'stress' },
  chat('chat/open-tasks', 'dialog'),
  chat('chat/tags', 'dialog'),
  // Session details with Mark complete turned on (close-session-3), and its note being written.
  { ...chat('chat/tags#complete', 'dialog'), open: [{ do: 'click', target: { role: 'switch', label: 'Mark complete' } }] },
  // Session details with its note being written (the shared note box, close-session-2).
  { ...chat('chat/tags#note-typing', 'dialog'), open: ['+ Add a note', { do: 'type', target: { role: 'textbox', label: 'Note' }, text: 'Pick this up after the release' }] },
  // A tag's edit box open in place, and the New tag box — the pair to set beside the quick chips
  // editor's edit and add pages (final-review#CH-5/CH-6: "want to see next to tag edit menu").
  { ...chat('chat/tags#tag-edit', 'dialog'), open: ['Edit work'] },
  { ...chat('chat/tags#new-tag', 'dialog'), open: ['+ New tag'] },
  chat('chat/status-bar', 'dialog'),
  chat('chat/status-bar/themes', 'dialog'),
  chat('chat/context', 'dialog'),
  // A real, unexpired announcement — statusData otherwise always sends `null`.
  { ...chat('chat/announcement', 'dialog'), params: { announcement: '1' } },
  chat('chat/quick-chips', 'dialog'),
  chat('chat/quick-chips/edit', 'dialog'),
  chat('chat/quick-chips/add', 'dialog'),
  // Remove asks first, in place (as Delete tag does), and Add pressed with both boxes empty says
  // why under each box (as New tag's Create does) — final-review#CH-5/CH-6.
  { ...chat('chat/quick-chips/edit#remove', 'dialog'), open: ['Remove'] },
  { ...chat('chat/quick-chips/add#empty', 'dialog'), open: ['Add'] },
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
  // The Browser (2026-10-13): the panel (opened by name) and the ask card in the chat, per
  // scene of the workbench's fake browser (?browser=, dev/workbench/browser-mock.ts).
  { ...chat('chat/browser', 'pane', 'browser'), params: { browser: 'working' } },
  { ...chat('chat/browser#explainer', 'pane', 'browser'), params: { browser: 'explainer' } },
  { ...chat('chat/browser#starting', 'pane', 'browser'), params: { browser: 'starting' } },
  { ...chat('chat/browser#error', 'pane', 'browser', 'error-state'), params: { browser: 'error' } },
  { ...chat('chat/browser#narrow', 'pane', 'browser', 'narrow'), params: { browser: 'working' }, viewport: { width: 390, height: 844 } },
  ...['site', 'final', 'local', 'handoff', 'no-browser', 'downloading'].map((b) => ({ ...chat(`chat#browser-${b}`, 'view', 'browser'), params: { browser: b } })),
  // Right-click menus, opened on the first visible element of each kind.
  chat('chat/menu/assistant', 'menu'),
  chat('chat/menu/user', 'menu'),
  chat('chat/menu/composer', 'menu'),
  chat('chat/menu/code', 'menu'),
  chat('chat/menu/file', 'menu'),
  chat('chat/voice/vocabulary', 'dialog'),
  { ...chat('chat/voice/vocabulary#empty', 'dialog'), params: { vocabulary: 'empty' } },
  { ...chat('chat/voice/vocabulary#stress', 'dialog', 'stress'), scenario: 'stress', params: { vocabulary: 'stress' } },
  { ...chat('chat/voice/vocabulary#narrow', 'dialog', 'narrow'), viewport: { width: 390, height: 844 } },
  // No session at all: the first screen a new user sees.
  { name: 'welcome', tags: ['view'], scenario: 'empty' },
  { name: 'welcome/back', tags: ['dialog'], scenario: 'welcome-back', mark: 'chat/resume',
    escapeStepsBack: 'Recovery requires an explicit Resume or Start fresh choice; Escape must leave the popup open.' },
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
  // WHY: photograph the real admin confirmation and the unchanged push confirmation it reuses.
  { ...chat('chat#push-choices', 'view', 'approval'), session: 'wb-2', params: { seed: 'bubbles-push-approval', latency: '150' }, open: ['Always allow'] },
  { ...chat('chat#admin-approval', 'view', 'approval'), session: 'wb-2', params: { seed: 'bubbles-admin', latency: '150' } },
  { ...chat('chat#admin-choices', 'view', 'approval'), session: 'wb-2', params: { seed: 'bubbles-admin', latency: '150' }, open: ['Always allow'] },
  { ...chat('chat#admin-choices-phone', 'view', 'approval', 'narrow'), session: 'wb-2', params: { seed: 'bubbles-admin', latency: '150' }, open: ['Always allow'], viewport: { width: 390, height: 844 } },
  // WHY: the same recovered history remains readable at every readiness phase.
  ...['opening', 'connecting', 'failed', 'ready'].flatMap(phase => [
    { ...chat(`chat#native-startup-${phase}`, 'view', 'native-startup', ...(phase === 'failed' ? ['error-state'] : [])),
      session: 'wb-2', params: { nativeStartup: phase }, ...(phase === 'ready' ? {} : { mark: `chat/native-startup-${phase}` }) },
    { ...chat(`chat#native-startup-${phase}-narrow`, 'view', 'native-startup', 'narrow'),
      session: 'wb-2', params: { nativeStartup: phase }, viewport: { width: 390, height: 844 },
      ...(phase === 'ready' ? {} : { mark: `chat/native-startup-${phase}` }) },
  ]),
  // Dev-only fixture: real shared question card with duplicate wording, selected
  // and typed via explore rather than drawing a stand-in or changing the app.
  { ...chat('chat#questions-native', 'view'), session: 'wb-2', params: { seed: 'bubbles-questions-native' } },
  { ...chat('chat#questions-cc', 'view'), session: 'wb-1', params: { seed: 'bubbles-questions-cc' } },
  { ...chat('chat#chatgpt', 'view'), session: 'wb-3' },
  { ...chat('chat#chatgpt-plan-limit', 'view', 'error-state'), session: 'wb-3', params: { planLimit: '1' } },
  { ...chat('chat#chatgpt-app-limit', 'view', 'error-state'), session: 'wb-3', params: { planLimit: 'official', chatgpt: 'official' } },
  { ...chat('chat#stalled', 'view', 'error-state'), session: 'wb-2', params: { stalled: '1' } },
  ...['key-rejected', 'key-expired', 'credit-short', 'request-refused'].map((e) => ({ ...chat(`chat#openrouter-${e}`, 'view', 'error-state'), session: 'wb-2', params: { openrouter: 'verified', providerError: e } })),
  // The sorted error card (error-card.questions, 2026-10-21): one per kind, on an Anthropic session.
  ...['overloaded', 'spend-limit', 'key-rejected', 'too-long', 'unknown'].map((e) => ({ ...chat(`chat#anthropic-${e}`, 'view', 'error-state'), session: 'wb-2', params: { anthropicError: '1', providerError: `anthropic-${e}` } })),
  { ...chat('chat#step-limit', 'view'), session: 'wb-2', params: { anthropicError: '1', providerError: 'step-limit' } },
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
  // error-notices-1 (2026-10-12): more of the app's "couldn't load" notices, so every
  // screen family's error box can be seen (the Resume list).
  { ...chat('chat/resume#load-failed', 'dialog', 'error-state'), params: { fail: 'session.browse' } },
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
  // Background work (2026-10-22 status audit): a Claude Code and a native conversation that
  // left commands, a watcher and helpers running — the cards' wording, the Subagents chip's
  // real state and the Background chip and its popup (fixtures/bubbles/background-*.jsonl).
  { ...chat('chat#background-cc', 'view'), session: 'wb-1', params: { seed: 'bubbles-background-cc' } },
  { ...chat('chat#background-native', 'view'), session: 'wb-2', params: { seed: 'bubbles-background-native' } },
  { ...chat('chat#background-native-phone', 'view', 'narrow'), session: 'wb-2', params: { seed: 'bubbles-background-native' }, viewport: { width: 390, height: 844 } },
  { ...chat('chat/specialists#cc', 'dialog'), session: 'wb-1', params: { seed: 'bubbles-background-cc' } },
  { ...chat('chat/background#cc', 'dialog'), newIn: 'after', session: 'wb-1', params: { seed: 'bubbles-background-cc' } },
  { ...chat('chat/background#native', 'dialog'), newIn: 'after', session: 'wb-2', params: { seed: 'bubbles-background-native' } },
  // One card per management call (a note, a status check, a stop…), so each card's own words show.
  { ...chat('chat#manage-cc', 'view'), session: 'wb-1', params: { seed: 'bubbles-manage-cc' } },
  { ...chat('chat#manage-native', 'view'), session: 'wb-2', params: { seed: 'bubbles-manage-native' } },
  { ...chat('chat/update', 'dialog'), params: { update: 'available' } },
  // Actual panel driven through its launch callback; only the backend is faked.
  ...['authorizing', 'installing', 'restarting', 'failed', 'timeout'].map(phase => ({
    ...chat(`chat/update#${phase}`, 'dialog', 'update-install'),
    params: { update: 'available', updateInstall: phase },
    open: ['Launch installer'],
  })),
  { ...chat('chat/update#installing-phone', 'dialog', 'narrow'),
    params: { update: 'available', updateInstall: 'installing' },
    open: ['Launch installer'], viewport: { width: 390, height: 844 } },
  // The update's download failed: the notice box with its sentence, Open in browser instead and
  // Try again, in the Update button's place (small-fixes-2).
  { ...chat('chat/update#download-failed', 'dialog', 'error-state'), params: { update: 'available', fail: 'update.download' }, open: ['Update now…'] },
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
  { ...chat('chat/files/open/a-launch-brief#collapsed-comments', 'pane', 'viewer'),
    open: ['Comments 3', 'Shrink panel',
      { do: 'hover', target: { role: 'clickable', label: 'Beta opens to 500 customers on March 10' } }],
    waitMs: 600 },
  // Git review (Review changes): a commit card opened and pointed at — the card lights as one,
  // no hard line above the changes (submit-ticket-5#ST5-Q2). Marked by the drawer itself
  // ('chat/files'): the review replaces the viewer, whose own mark goes with it.
  { ...chat('chat/files/open/a-launch-brief#git-review', 'pane', 'viewer'), mark: 'chat/files',
    open: ['Review changes', '▸ a1b2c3d chat: cache the per-session selector…', { do: 'hover', target: { role: 'button', labelStarts: '▸ a1b2c3d chat: cache the per-session selector' } }] },
  chat('chat/files/open/a-q3-sales-comments', 'pane', 'viewer'),
  // WHY exercise the actual Add comment action rather than seed an already-open draft.
  { ...chat('chat/files/open/a-q3-sales-comments#new-comment', 'pane', 'viewer'),
    open: [
      { do: 'right-click', target: { role: 'clickable', labelStarts: 'A B C D E F G H I J K L' } },
      { do: 'click', target: { role: 'menuitem', label: 'Add comment' } },
    ] },
];
