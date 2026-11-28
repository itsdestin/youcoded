// device-table.ts — what works, what is hidden and what is not built yet, on each of the three places YouCoded runs.
//
// WHY (Destin, 2026-11-18, review item R-5): which feature shows where was decided in about 83 separate spots in the
// screen code, each one guessing ("am I on a phone?"), so nobody could look at one page and see the answer, and a wrong
// guess became a button that does nothing or an error naming an internal word. This file is that one page, as data.
// Phases 1-2 only: the table and the check (tests/device-table.test.ts). NO screen reads it yet except the voice-words
// editor (V-2); moving the rest of the screens onto it is phase 3 and waits for Destin's decisions.
//
// Keep this file DATA ONLY (no imports, literal values), like capabilities.ts: a script renders it as the readable page
// (docs for Destin) and the renderer reads it through renderer/feature-gate.ts.

/** The three places. computer = the desktop app's own window. phoneApp = the Android app running its OWN backend on the
 *  phone. remote = any browser, or the Android app paired to a computer, talking to that computer (it holds no backend
 *  of its own and is refused every channel marked `desktopOnly` or `remoteAllowed: false` in main/ipc/channel-table.ts). */
export type Door = 'computer' | 'phoneApp' | 'remote';

/** works = shown and usable. hidden = deliberately not offered there because it makes no sense there. not-yet = we want it
 *  there, it is not built, so it is not offered (the "not yet" column is the to-do list). */
type DoorState = 'works' | 'hidden' | 'not-yet';

export interface DeviceRow {
  /** Stable key; screens ask featureWorks('<id>'). */
  id: string;
  /** Plain words, as Destin would say it. */
  name: string;
  /** Which part of the app, for the readable page only. */
  group: string;
  /** The channels (main/ipc families) this row speaks for. Each entry matches every channel that STARTS WITH it; when two
   *  rows match one channel the longer entry wins. A row must name at least one channel or a capability. */
  channels: string[];
  /** window.claude namespaces (the names screens call) that belong to this row ALONE, for the "shown where it does not
   *  work" scan. Left empty when a namespace is shared by rows that behave differently. */
  apis: string[];
  /** The matching yes/no in shared/capabilities.ts, when there is one; the test keeps the two from contradicting. */
  capability?: 'nativeWindows' | 'openInOs' | 'openExternal' | 'git' | 'themePictures' | 'themeRigs' | 'terminalScreenRead'
    | 'nativeSessions' | 'chatgptAccount' | 'buddy' | 'projectWrites' | 'contentSearch' | 'liveHandoff' | 'assistantBrowser';
  doors: Record<Door, DoorState>;
  /** What a device that cannot do it shows (Destin, V-1, 2026-11-18, "mixed"): 'gone' = nothing at all (it makes no sense
   *  there); 'greyed' = a setup thing, shown greyed with "Set this up on your computer". Only read where a door is not
   *  'works'. Used by phase 3, not by any screen yet. */
  whenNotWorking: 'gone' | 'greyed';
  /** true = every cell was settled from facts in the code (the channel flags and the capability sets). false = at least
   *  one cell is a judgement nobody has tried on a device; those are the cells to check first. */
  verified: boolean;
  /** One plain sentence. Required wherever a door says 'not-yet' or the row is not verified. */
  note: string;
}

/** Channels the table does not list as a feature, with the reason. They are plumbing between a window and the computer
 *  that no person ever sees as a feature, so there is nothing to show or hide. */
export const INTERNAL_CHANNELS: Array<{ channel: string; why: string }> = [
  { channel: 'session:selected', why: 'A window tells the computer which chat it is showing.' },
  { channel: 'session:terminal-ready', why: 'A window tells the computer its terminal has drawn.' },
  { channel: 'session:terminal-ack', why: 'A window confirms it received terminal output.' },
  { channel: 'session:terminal-repaint', why: 'A window asks the computer to redraw its terminal.' },
  { channel: 'ui:action:broadcast', why: 'The computer tells its own windows an action happened.' },
  { channel: 'system:notify-stack-state', why: 'The computer tells its own windows about stacked notices.' },
  { channel: 'attention:', why: 'Reports that the computer\'s windows send to each other about a chat needing attention.' },
  { channel: 'remote:attention-changed', why: 'The computer tells its windows that a chat\'s attention state changed.' },
];

export const DEVICE_TABLE: DeviceRow[] = [
  // ── Accounts and sign-in ──────────────────────────────────────────────────────────────────────────────────────────
  { id: 'account', name: 'Change your YouCoded account (profile, handle, sign out, delete)', group: 'Accounts and sign-in',
    channels: ['account:'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'A browser or paired phone may only SEE who is signed in; every change is refused. The phone-app cell has not been tried on a phone.' },
  { id: 'account-export', name: 'Download a copy of your account data', group: 'Accounts and sign-in',
    channels: ['account:export'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'Saves a file through the computer\'s own save box; the phone has no such box. Not tried on a phone.' },
  { id: 'chatgpt-sign-in', name: 'Sign in to a ChatGPT account', group: 'Accounts and sign-in',
    channels: ['chatgpt:sign-in'], apis: [], capability: 'openExternal', doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: true,
    note: 'Finishing the sign-in needs the device\'s own browser, which only the computer and the phone app have.' },
  { id: 'chatgpt-status', name: 'See whether ChatGPT is connected', group: 'Accounts and sign-in',
    channels: [], apis: [], capability: 'chatgptAccount', doors: { computer: 'works', phoneApp: 'works', remote: 'works' }, whenNotWorking: 'gone', verified: true,
    note: 'A browser sees the computer\'s ChatGPT status; only the sign-in itself is computer-side.' },
  { id: 'openrouter-sign-in', name: 'Sign in with OpenRouter', group: 'Accounts and sign-in',
    channels: ['openrouter:'], apis: [], capability: 'openExternal', doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: true,
    note: 'Same reason as ChatGPT: the sign-in opens the device\'s own browser.' },
  { id: 'claude-code-setup', name: 'Install and sign in to Claude Code', group: 'Accounts and sign-in',
    channels: ['claude-code:'], apis: ['claudeCode'], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'The phone app\'s cell has not been tried on a phone.' },
  { id: 'first-run-setup', name: 'First-time setup wizard', group: 'Accounts and sign-in',
    channels: ['first-run:'], apis: ['firstRun'], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'Sets up the device it runs on, so a browser looking at a computer never shows it.' },
  { id: 'social', name: 'Friends, requests and presence', group: 'Accounts and sign-in',
    channels: ['social:'], apis: ['social'], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'A browser is refused all of it. The phone-app cell has not been tried on a phone.' },
  { id: 'share-usage', name: 'Share anonymous usage numbers', group: 'Accounts and sign-in',
    channels: ['analytics:'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'A browser cannot read or change it. The phone-app cell has not been tried on a phone.' },

  // ── Chat, files and projects ──────────────────────────────────────────────────────────────────────────────────────
  { id: 'built-in-assistant', name: 'The built-in assistant (its own models and keys)', group: 'Chat, files and projects',
    channels: [], apis: [], capability: 'nativeSessions', doors: { computer: 'works', phoneApp: 'works', remote: 'works' }, whenNotWorking: 'gone', verified: true,
    note: 'A browser drives a session that runs on the computer, when that computer has the assistant switched on.' },
  { id: 'live-handoff', name: 'Take over a chat running on another device', group: 'Chat, files and projects',
    channels: [], apis: [], capability: 'liveHandoff', doors: { computer: 'works', phoneApp: 'works', remote: 'works' }, whenNotWorking: 'gone', verified: true,
    note: '' },
  { id: 'browse-files', name: 'Look through a project\'s files', group: 'Chat, files and projects',
    channels: ['artifacts:list', 'artifacts:get', 'artifacts:read-binary', 'artifacts:download', 'artifacts:check-existence', 'artifacts:resolve-path', 'artifacts:watch-project', 'artifacts:unwatch-project'],
    apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'works' }, whenNotWorking: 'gone', verified: true, note: '' },
  { id: 'search-file-contents', name: 'Search inside the words of a project\'s files', group: 'Chat, files and projects',
    channels: ['artifacts:search-content'], apis: [], capability: 'contentSearch', doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'A browser has no search of its own and the computer does not offer it one yet.' },
  { id: 'change-files', name: 'Add, rename, save or remove a project\'s files and records', group: 'Chat, files and projects',
    channels: ['artifacts:append-version', 'artifacts:rename', 'artifacts:remove-record', 'artifacts:save', 'artifacts:import-file', 'artifacts:include-external', 'artifacts:exclude', 'artifacts:delete-project', 'project:write-context-file'],
    apis: [], capability: 'projectWrites', doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: true,
    note: 'A browser can read a project but not change it.' },
  { id: 'git-review', name: 'See and commit a file\'s Git changes', group: 'Chat, files and projects',
    channels: ['git:'], apis: ['git'], capability: 'git', doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: '' },
  { id: 'terminal-read', name: 'The "is Claude stuck?" check that reads the terminal\'s screen', group: 'Chat, files and projects',
    channels: ['terminal:get-screen-text'], apis: [], capability: 'terminalScreenRead', doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'A browser has no terminal of its own to read; the computer reports when a chat needs attention instead.' },
  { id: 'reopen-closed-chats', name: 'Reopen a chat you closed', group: 'Chat, files and projects',
    channels: ['session:reopen-list', 'session:forget-reopen'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell is a guess; the phone may be able to do this and nobody has tried.' },
  { id: 'office', name: 'Open and edit Word, Excel and PowerPoint files', group: 'Chat, files and projects',
    channels: ['office:'], apis: ['office'], doors: { computer: 'works', phoneApp: 'not-yet', remote: 'not-yet' }, whenNotWorking: 'gone', verified: false,
    note: 'The editor itself says "isn\'t available here yet" in its own pane, so this row shows nothing extra.' },
  { id: 'pages-programs', name: 'Pages that run programs or connect a bank', group: 'Chat, files and projects',
    channels: ['pages:plaid', 'pages:run-program', 'pages:stop-programs'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell is a guess: nobody has tried a program-running page on a phone.' },
  { id: 'automations', name: 'Automations (the assistant doing a job on a schedule or from a page button)', group: 'Chat, files and projects',
    channels: ['automations:'], apis: [], doors: { computer: 'works', phoneApp: 'not-yet', remote: 'not-yet' }, whenNotWorking: 'gone', verified: false,
    note: 'Closed to a browser and a paired phone until Destin decides what a phone may do (pages-finish step 4 deck, Q-phones). Not tried in the phone app.' },
  { id: 'pages-delete', name: 'Delete a page', group: 'Chat, files and projects',
    channels: ['pages:delete'], apis: [], doors: { computer: 'works', phoneApp: 'not-yet', remote: 'not-yet' }, whenNotWorking: 'gone', verified: false,
    note: 'Closed to a browser and a paired phone until Destin decides (same deck, Q-phones): deleting is hard to undo. Not tried in the phone app.' },
  { id: 'pages-folder', name: 'Choose the folder a page may use', group: 'Chat, files and projects',
    channels: ['pages:choose-folder', 'pages:set-folder'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'Uses the computer\'s own folder chooser, and the folder is on the computer. The phone-app cell is a guess: not tried on a phone.' },

  // ── Voice ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'voice-typing', name: 'Speak your message (voice typing)', group: 'Voice',
    channels: ['voice:status', 'voice:download', 'voice:start', 'voice:stop', 'voice:cancel', 'voice:mic-access', 'voice:audio'], apis: ['voice'],
    doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'The phone app uses its own speech engine. A browser reaching a computer has no voice (decided on the voice questions deck, Q-7).' },
  { id: 'voice-words', name: 'Custom words for voice typing (right-click the microphone)', group: 'Voice',
    channels: ['voice:vocabulary'], apis: ['voiceVocabulary'], doors: { computer: 'works', phoneApp: 'not-yet', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'Destin, 2026-11-18 (V-2): hidden on the phone app until the phone\'s own speech engine can use it; kept here as not-yet so it stays on the to-do list.' },

  // ── Windows and desktop extras ────────────────────────────────────────────────────────────────────────────────────
  { id: 'detach-windows', name: 'Pop a chat into its own window or drag it between windows', group: 'Windows and desktop extras',
    channels: ['detach:', 'window:open-detached', 'session:detach-', 'session:drag-', 'window:focus-and-switch', 'session:drop-resolve'], apis: ['detach'],
    capability: 'nativeWindows', doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'Needs more than one window of its own.' },
  { id: 'window-buttons', name: 'Window buttons, icon and size', group: 'Windows and desktop extras',
    channels: ['window:'], apis: [], capability: 'nativeWindows', doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: '' },
  { id: 'buddy', name: 'The floating buddy', group: 'Windows and desktop extras',
    channels: ['buddy:'], apis: ['buddy'], capability: 'buddy', doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: '' },
  { id: 'assistant-browser', name: 'The assistant\'s own web browser', group: 'Windows and desktop extras',
    channels: ['browser:'], apis: ['browser'], capability: 'assistantBrowser', doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'Its live picture and controls are not sent to phones in this release.' },
  { id: 'open-in-computer', name: 'Open a file or folder in the computer\'s own apps', group: 'Windows and desktop extras',
    channels: ['shell:open-path', 'shell:show-item-in-folder', 'shell:picture-action'], apis: [], capability: 'openInOs', doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: '' },
  { id: 'open-link', name: 'Open a web link in the device\'s own browser', group: 'Windows and desktop extras',
    channels: ['shell:open-external', 'shell:open-changelog'], apis: [], capability: 'openExternal', doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: true,
    note: 'A browser shows the address to copy instead.' },
  { id: 'file-pickers', name: 'Pick a file, folder or sound with the computer\'s own dialog', group: 'Windows and desktop extras',
    channels: ['dialog:', 'clipboard:save-image'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone app picks files its own way (file:upload). The phone-app cell is a guess.' },
  { id: 'theme-pictures', name: 'Wallpapers and pictures that belong to a theme', group: 'Windows and desktop extras',
    channels: [], apis: [], capability: 'themePictures', doors: { computer: 'works', phoneApp: 'works', remote: 'not-yet' }, whenNotWorking: 'gone', verified: true,
    note: 'A browser cannot load a theme\'s picture files from the computer yet.' },
  { id: 'animated-mascots', name: 'Animated theme mascots', group: 'Windows and desktop extras',
    channels: [], apis: [], capability: 'themeRigs', doors: { computer: 'works', phoneApp: 'not-yet', remote: 'not-yet' }, whenNotWorking: 'gone', verified: true,
    note: 'They load their pieces while drawing, which neither a browser nor the phone app can do yet.' },

  // ── Setup and settings ────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'remote-access-setup', name: 'Set up remote access (password, devices, Tailscale)', group: 'Setup and settings',
    channels: ['remote:set-password', 'remote:set-config', 'remote:devices:rename', 'remote:devices:unpair', 'remote:install-tailscale', 'remote:auth-tailscale'], apis: [],
    doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'A paired browser can look but not change. The phone-app cell is a guess: remote access serves OTHER devices from a computer.' },
  { id: 'integrations', name: 'Connect outside services (integrations)', group: 'Setup and settings',
    channels: ['integrations:'], apis: ['integrations'], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'A browser is refused all of it. The phone-app cell has not been tried on a phone.' },
  { id: 'report-a-bug', name: 'Look at the log and report a bug', group: 'Setup and settings',
    channels: ['dev:log-tail', 'dev:diagnostics', 'dev:summarize-issue', 'dev:submit-issue'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'The phone-app cell has not been tried on a phone.' },
  { id: 'dev-workspace', name: 'Developer workspace setup', group: 'Setup and settings',
    channels: ['dev:install-workspace', 'dev:setup-', 'dev:open-session-in'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell is a guess.' },
  { id: 'restart-and-speed', name: 'Restart the app and speed settings', group: 'Setup and settings',
    channels: ['app:restart', 'performance:'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell is a guess.' },
  { id: 'app-update', name: 'Download and install an app update', group: 'Setup and settings',
    channels: ['update:download', 'update:cancel', 'update:launch', 'update:get-cached-download', 'update:restart-to-update'], apis: [], doors: { computer: 'works', phoneApp: 'hidden', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell is a guess: the phone app is updated some other way.' },
  { id: 'whats-new', name: 'Read what is new in an update', group: 'Setup and settings',
    channels: ['update:changelog'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell has not been tried on a phone.' },
  { id: 'connection-check', name: 'Check the internet connection', group: 'Setup and settings',
    channels: ['network:check'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell has not been tried on a phone.' },
  { id: 'skills-install', name: 'Install or remove skills', group: 'Setup and settings',
    channels: ['skills:install', 'skills:install-many', 'skills:uninstall', 'skills:update'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'works' }, whenNotWorking: 'greyed', verified: false,
    note: 'Today a paired browser CAN do this. Whether it should is open (review item R-5, question D-3); this row records what is true now.' },
  { id: 'marketplace-refresh', name: 'Refresh the skill store and read a skill\'s files', group: 'Setup and settings',
    channels: ['marketplace:invalidate-cache', 'marketplace:read-component'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell has not been tried on a phone.' },
  { id: 'theme-edit', name: 'Edit and save a theme, mark favourite themes', group: 'Setup and settings',
    channels: ['theme:write-file', 'appearance:favorite-theme'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'greyed', verified: false,
    note: 'A browser can use a theme but not change one. The phone-app cell has not been tried on a phone.' },
  { id: 'theme-publish-tools', name: 'Refresh the theme registry and make theme previews', group: 'Setup and settings',
    channels: ['theme-marketplace:refresh-registry', 'theme-marketplace:generate-preview'], apis: [], doors: { computer: 'works', phoneApp: 'works', remote: 'hidden' }, whenNotWorking: 'gone', verified: false,
    note: 'The phone-app cell has not been tried on a phone.' },
];

/** Every channel claim in the table, for the test and the check: the longest claim that a channel starts with wins. */
export function rowForChannel(channel: string): DeviceRow | undefined {
  let best: { row: DeviceRow; len: number } | undefined;
  for (const row of DEVICE_TABLE) {
    for (const claim of row.channels) {
      if (channel.startsWith(claim) && (!best || claim.length > best.len)) best = { row, len: claim.length };
    }
  }
  return best?.row;
}

/** True when this channel is listed above as plumbing rather than a feature. */
export function isInternalChannel(channel: string): boolean {
  return INTERNAL_CHANNELS.some((c) => channel.startsWith(c.channel));
}
