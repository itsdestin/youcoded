// Coverage batch A (2026-11-08): screens a user can reach that no entry photographed — states pinned by mock
// switches nobody used, first-run pages, phone width, the lower half of long Settings pages, and a few popups'
// other tabs. Catalog entries only (no app-code marks), so a release comparison can photograph an older release
// with this same list laid over its own code. No newIn unless noted: each state existed in v1.3.3.
import type { ScreenEntry } from './types';

const PHONE = { width: 390, height: 844 };
const settings = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['settings', ...tags] });
const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });
const scroll = (times: number) => ({ do: 'scroll', dir: 'down', times }) as const;

// WHY: Claude Code's own sign-in has five states and only "signed in" was ever photographed. The Cloud page and the
// model picker both change with it (a greyed Claude row, a sign-in button, "API key" instead of a plan).
const CLAUDE_STATES = ['signed-out', 'not-installed', 'unknown', 'apikey'] as const;
// The model picker only differs for signed-out and not-installed (a greyed row with a hint); unknown and API-key draw it exactly as signed-in.
const CLAUDE_CODE: readonly ScreenEntry[] = CLAUDE_STATES.flatMap((c) => [
  { ...settings(`settings/assistant/cloud#claude-${c}`, 'dialog', 'sign-in'), params: { claudeCode: c } },
  ...(c === 'signed-out' || c === 'not-installed' ? [{ ...chat(`chat/model-picker#claude-${c}`, 'dialog', 'sign-in'), params: { claudeCode: c } }] : []),
]);

// WHY: the model-switch popup's two outcomes after "Summarize and switch" were never photographed: the summary still running
// (switchFit=working never finishes) and the failure (switchFit=error). The named screen opens the popup itself, in its ask
// state (that state is `chat/model-picker/switch-model`), so one press on its button reaches each outcome.
const SWITCH_FIT: readonly ScreenEntry[] = (['working', 'error'] as const).map((f) => ({
  ...chat(`chat/model-picker/switch-model#${f}`, 'dialog', ...(f === 'error' ? ['error-state'] : [])),
  params: { switchFit: f }, open: [{ do: 'click', target: { role: 'button', label: 'Summarize and switch' } }],
}));

// WHY: Settings > Buddy shows different helper rows per desktop (Linux/KDE needs a helper; Windows and Mac do not).
const BUDDY_HELPER: readonly ScreenEntry[] = (['available', 'none', 'not-needed', 'not-needed-installed'] as const).map((m) => (
  { ...settings(`settings/buddy#helper-${m}`, 'dialog'), params: { buddyHelper: m },
    ...(m === 'not-needed' ? { sameAs: { name: 'settings/buddy#helper-available', why: 'the helper row only appears once the switch is turned on (see helper-consent)' } } : {}),
    ...(m === 'not-needed-installed' ? { sameAs: { name: 'settings/buddy', why: 'the default practice desktop already has the helper installed' } } : {}) }));

// WHY: Settings > Buddy's "helper available" state asks for consent when the switch is turned on; the closed card looks like "not needed".
const BUDDY_CONSENT: ScreenEntry = { ...settings('settings/buddy#helper-consent', 'dialog'), params: { buddyHelper: 'available' }, open: [{ do: 'click', target: { role: 'switch', label: 'Show buddy floater' } }] };

// WHY: a first-time user with no projects at all sees an explainer instead of the three tabs.
const PROJECTS_NONE: ScreenEntry = { name: 'projects#none', tags: ['view', 'projects'], params: { projects: 'none' } };

// WHY: the sign-in step's second page was photographed for "pay as you go" only; "a plan you already pay for" and "free, on
// this computer" were not, nor were the three setup pages the buttons lead to (a local model, a running local app, an API key).
const fr = (name: string, extra: Partial<ScreenEntry>): ScreenEntry => ({ name, tags: ['first-run', 'view'], ...extra, params: { firstRun: 'AUTHENTICATE', ...extra.params } });
const FIRST_RUN: readonly ScreenEntry[] = [
  fr('first-run#signin-plan', { params: { signInPick: 'plan' } }),
  fr('first-run#signin-local', { params: { signInPick: 'local' } }),
  fr('first-run#local-model-setup', { params: { signInPick: 'local' }, open: ['Use a local model'] }),
  fr('first-run#local-model-setup-tight', { params: { signInPick: 'local', localFit: 'tight' }, open: ['Use a local model'] }),
  fr('first-run#local-app-connect', { params: { signInPick: 'local', localApps: 'found' }, open: ['Use a local model', 'Use an app on this computer'] }),
  fr('first-run#api-key', { params: { signInPick: 'payg' }, open: ['Use an API key'] }),
  fr('first-run#claude-installing', { params: { claudeInstall: 'installing', authMode: 'oauth' } }),
];

// WHY: Settings > Remote access had one state (the plain one with no setup preview). `remote=` gives the older panel with and
// without a connected phone; `remotePreview=` is the newer guided setup, one picture per stage, its information page, the
// Browser-encryption page (off and on) and the Add-device step.
const REMOTE_STAGES = ['setup', 'not-installed', 'sign-in-required', 'checking', 'checked', 'checked-failed', 'checked-silent', 'conflict', 'error', 'disabled', 'encrypted'] as const;
const rm = (name: string, params: Record<string, string>, open?: ScreenEntry['open']): ScreenEntry => ({ ...settings(`settings/remote#${name}`, 'dialog', 'remote'), params, ...(open ? { open } : {}),
  ...(name === 'preview-encrypted' ? { sameAs: { name: 'settings/remote#devices', why: 'draws the ready page; the difference sits on the Browser encryption page' } } : {}) });
const REMOTE: readonly ScreenEntry[] = [
  rm('setup-plain', { remote: 'setup' }),
  rm('connected-plain', { remote: 'connected' }),
  ...REMOTE_STAGES.map((st) => rm(`preview-${st}`, { remotePreview: st })),
  rm('preview-info', { remotePreview: 'ready' }, ['What is this?']),
  rm('preview-add-device', { remotePreview: 'ready' }, ['Add device']),
  rm('preview-encryption-off', { remotePreview: 'ready' }, [{ do: 'scroll', dir: 'down', times: 4 }, { do: 'click', target: { role: 'button', labelStarts: 'Browser encryption' } }]),
  rm('preview-encryption-on', { remotePreview: 'encrypted' }, [{ do: 'scroll', dir: 'down', times: 4 }, { do: 'click', target: { role: 'button', labelStarts: 'Browser encryption' } }]),
];

// WHY: the student persona (scenario site + student=1) fills Projects, Session files and Resume with a student's own work.
const STUDENT: readonly ScreenEntry[] = [
  { name: 'chat#student', tags: ['chat', 'view'], scenario: 'site', params: { student: '1' } },
  { name: 'projects#student', tags: ['view', 'projects'], scenario: 'site', params: { student: '1' } },
  { name: 'chat/resume#student', tags: ['chat', 'dialog'], scenario: 'site', params: { student: '1' } },
  { name: 'chat/files#student', tags: ['chat', 'pane'], scenario: 'site', params: { student: '1' } },
];

// WHY: an update waiting shows a pill in the chat's status bar; the dialog behind it was photographed, the chat view was not.
// The Library marks an installed skill or theme older than its listing.
const UPDATES: readonly ScreenEntry[] = [
  { ...chat('chat#update-available', 'view'), params: { update: 'available' } },
  { name: 'library#update-available', tags: ['view', 'marketplace'], params: { mpUpdate: '1' } },
  { name: 'library/themes#update-available', tags: ['view', 'marketplace'], params: { mpUpdate: '1' } },
];

// WHY: the phone is where most Settings text gets cut off, and only a handful of pages were ever photographed at 390 wide.
const ph = (e: ScreenEntry): ScreenEntry => ({ ...e, tags: [...e.tags, 'narrow'], viewport: PHONE });
const PHONE_SETTINGS: readonly ScreenEntry[] = ['settings', 'settings/account', 'settings/account/connections', 'settings/assistant/general', 'settings/assistant/cloud',
  'settings/assistant/local', 'settings/assistant/permissions', 'settings/assistant/specialists', 'settings/assistant/browser', 'settings/appearance', 'settings/appearance/about',
  'settings/buddy', 'settings/sound', 'settings/sync', 'settings/remote', 'settings/help', 'settings/shortcuts', 'settings/donate', 'settings/about', 'settings/development/contribute']
  .map((n) => ph({ ...settings(`${n}#phone`, 'dialog'), mark: n }));
// WHY: the same for the rest of the app's surfaces a phone user reaches.
const PHONE_APP: readonly ScreenEntry[] = [
  ph({ name: 'projects#phone', tags: ['view', 'projects'], mark: 'projects' }),
  ph({ ...chat('chat/resume#phone', 'dialog'), mark: 'chat/resume' }),
  ph({ ...chat('chat/model-picker#phone', 'dialog'), mark: 'chat/model-picker' }),
  ph({ ...chat('chat/status-bar#phone', 'dialog'), mark: 'chat/status-bar' }),
  ph({ ...chat('chat/tags#phone', 'dialog'), mark: 'chat/tags' }),
  ph({ ...chat('chat/session-context#phone', 'dialog'), mark: 'chat/session-context' }),
  ph({ ...chat('chat/files#phone', 'pane'), mark: 'chat/files' }),
  ph({ name: 'library#phone', tags: ['view', 'marketplace'], mark: 'library' }),
  ph({ name: 'welcome#phone', tags: ['view'], scenario: 'empty', mark: 'welcome' }),
  // chat#phone: master's chat.ts (2026-11-02) lists the same screen; a name may appear once.
  ...['DETECT_PREREQUISITES', 'INSTALL_PREREQUISITES', 'AUTHENTICATE'].map((st) => ph({ name: `first-run#${st.toLowerCase().replace(/_/g, '-')}-phone`, tags: ['first-run', 'view'], params: { firstRun: st } })),
  ph(fr('first-run#signin-plan-phone', { params: { signInPick: 'plan' } })),
  ph(fr('first-run#local-model-setup-phone', { params: { signInPick: 'local' }, open: ['Use a local model'] })),
];

// WHY: the lower half of long Settings pages was in no picture. Each is scrolled to its end (extra turns past the end change
// nothing), and the longer pages also get a middle picture so no stretch is missed.
const END = scroll(30);
const SCROLLED: readonly ScreenEntry[] = [
  ...['settings/assistant/general', 'settings/assistant/local', 'settings/sound', 'settings/remote', 'settings/help', 'settings/shortcuts', 'settings/assistant/permissions']
    .map((n) => ({ ...settings(`${n}#bottom`, 'dialog'), mark: n, open: [END] })),
  { ...settings('settings/assistant/local#middle', 'dialog'), mark: 'settings/assistant/local', open: [scroll(4)] },
  { ...settings('settings/assistant/permissions#middle', 'dialog'), mark: 'settings/assistant/permissions', open: [scroll(5)] },
];

// WHY: the Backup & sync popup's Projects and Conversations tabs (only Devices was photographed), and Resume's empty search
// and phone filter sheet, and Find in chat with a hit and with none.
const SYNC_TABS: readonly ScreenEntry[] = [
  { ...settings('settings/sync#ok-projects', 'dialog'), params: { sync: 'ok' }, open: [{ do: 'click', target: { role: 'tab', label: '3 Projects' } }] },
  { ...settings('settings/sync#ok-conversations', 'dialog'), params: { sync: 'ok' }, open: [{ do: 'click', target: { role: 'tab', label: '5 Conversations' } }] },
];
const SEARCH_RESUME = { do: 'type', target: { role: 'textbox', label: 'Search sessions' }, text: 'zzzz' };
const FIND = (text: string) => [{ do: 'type', target: { role: 'textbox', label: 'Find in chat' }, text }];
// WHY: a document comment that could not be saved (the file is open in another app) and one whose quoted text has left the file.
const NEW_COMMENT = [
  { do: 'right-click', target: { role: 'clickable', labelStarts: 'A B C D E F G H I J K L' } },
  { do: 'click', target: { role: 'menuitem', label: 'Add comment' } },
  { do: 'type', target: { role: 'textbox', label: 'New comment' }, text: 'Check this total before Friday' },
  { do: 'click', target: { role: 'button', label: 'Post comment' } },
];
const MISC: readonly ScreenEntry[] = [
  { ...chat('chat/files/open/a-q3-sales-comments#comment-failed', 'pane', 'viewer', 'error-state'), params: { docCommentsFail: 'file-open-elsewhere' }, open: [...NEW_COMMENT, { do: 'click', target: { role: 'button', labelStarts: 'Comments' } }] },
  { ...chat('chat/files/open/a-onboarding-plan#detached', 'pane', 'viewer'), params: { docCommentsDetached: '1' }, open: [{ do: 'click', target: { role: 'button', labelStarts: 'Comments' } }] },
  { ...chat('chat/resume#no-matches', 'dialog'), open: [SEARCH_RESUME] },
  ph({ ...chat('chat/resume#filter-sheet-phone', 'dialog', 'popover'), mark: 'chat/resume', open: [{ do: 'click', target: { role: 'button', label: 'Filters' } }] }),
  ph({ ...chat('chat/resume#no-matches-phone', 'dialog'), mark: 'chat/resume', open: [SEARCH_RESUME] }),
  { ...chat('chat/find#results', 'bar'), open: FIND('permission') },
  { ...chat('chat/find#none', 'bar'), open: FIND('zzzqq') },
];

export const COVERAGE_A: readonly ScreenEntry[] = [
  ...CLAUDE_CODE,
  ...SWITCH_FIT,
  ...BUDDY_HELPER,
  BUDDY_CONSENT,
  PROJECTS_NONE,
  ...FIRST_RUN,
  ...REMOTE,
  ...STUDENT,
  ...UPDATES,
  ...PHONE_SETTINGS,
  ...PHONE_APP,
  ...SCROLLED,
  ...SYNC_TABS,
  ...MISC,
];
