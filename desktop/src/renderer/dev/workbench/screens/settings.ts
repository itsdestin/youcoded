// Settings: the drawer and every dialog it opens.
import type { ScreenEntry } from './types';

const settings = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['settings', ...tags] });

// ── Submit a ticket: practice steps ──────────────────────────────────────────────
const TICKET = 'settings/development/bug-report';
const TYPE_TITLE = { do: 'type', target: { role: 'textbox', label: 'Title' }, text: 'Settings text is cut off on my phone' };
const TYPE_DESCRIPTION = { do: 'type', target: { role: 'textbox', label: 'Description' },
  text: 'On my phone, Settings → Sound cuts off the right edge of the Volume card. I expected it to fit the screen.' };
const TICK_LOGS = { do: 'click', target: { role: 'switch', label: 'Include recent logs' } };
const TICK_FILES = { do: 'click', target: { role: 'switch', label: 'Finish with attachments in GitHub' } };
const FILL = [TYPE_TITLE, TYPE_DESCRIPTION];
const REVIEW = 'Review ticket';
const SEND = 'Submit public ticket';
const AI = 'Optional AI help';
const HAND_OVER = 'Let your assistant try to fix it';
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 640, height: 480 };
const ticket = (state: string, extra: Partial<ScreenEntry>): ScreenEntry => ({ ...settings(`${TICKET}#${state}`, 'dialog', 'ticket'), ...extra });
const TICKET_STATES: readonly ScreenEntry[] = [
  ticket('feature', { open: [{ do: 'click', target: { role: 'tab', label: 'Feature' } }] }),
  ticket('filled', { open: FILL }),
  ticket('filled-all', { open: [...FILL, TICK_LOGS, TICK_FILES] }),
  ticket('from-error', { params: { reportFrom: 'error' } }),
  ticket('review', { open: [...FILL, REVIEW] }),
  ticket('review-logs', { open: [...FILL, TICK_LOGS, REVIEW] }),
  ticket('review-files', { open: [...FILL, TICK_FILES, REVIEW] }),
  ticket('review-error', { params: { reportFrom: 'error' }, open: [...FILL, REVIEW, { do: 'click', target: { role: 'button', label: 'The error you saw From Office' } }] }),
  ticket('review-ai', { open: [...FILL, REVIEW, AI] }),
  ticket('review-logs-open', { open: [...FILL, TICK_LOGS, REVIEW, { do: 'click', target: { role: 'button', label: 'Recent logs 4 lines — open to read or remove anything private' } }] }),
  ticket('sending', { params: { ticket: 'hold' }, open: [...FILL, REVIEW, SEND] }),
  ticket('sent', { open: [...FILL, REVIEW, SEND] }),
  // The proposed stronger tag tint on the "Submitted" tag (Pill, waiting for Destin).
  ticket('sent-strong', { params: { pillTint: 'strong' }, open: [...FILL, REVIEW, SEND] }),
  ticket('browser', { open: [...FILL, TICK_FILES, REVIEW, 'Continue in GitHub'] }),
  ticket('failed', { scenario: 'refused', open: [...FILL, REVIEW, SEND] }),
  ticket('offline', { params: { network: 'offline' }, open: [...FILL, REVIEW, SEND] }),
  // The hand-over to Contribute (submit-ticket-3#ST3-Q1): what you see, with no copy yet,
  // with one already on this computer, while it downloads, and once the assistant started.
  ticket('handover', { open: [...FILL, REVIEW, AI, HAND_OVER] }),
  ticket('handover-ready', { params: { devCopy: 'ready' }, open: [...FILL, REVIEW, AI, HAND_OVER] }),
  ticket('handover-downloading', { params: { ticket: 'hold' }, open: [...FILL, REVIEW, AI, HAND_OVER, 'Download and start'] }),
  ticket('handed-over', { params: { devCopy: 'ready' }, open: [...FILL, REVIEW, AI, HAND_OVER, 'Start'] }),
  ticket('phone', { viewport: PHONE, open: FILL }),
  ticket('phone-review', { viewport: PHONE, open: [...FILL, TICK_LOGS, REVIEW] }),
  ticket('small', { viewport: SMALL, open: FILL }),
  ticket('small-review', { viewport: SMALL, open: [...FILL, TICK_LOGS, REVIEW] }),
];

// The wizard's own ✕ and Escape both return to Backup & sync's main view (SyncSetupWizard
// useEscClose → onClose); the popup stays open.
const WIZARD_ESCAPE = 'the add-a-backup wizard returns to Backup & sync';

export const SETTINGS: readonly ScreenEntry[] = [
  settings('settings', 'drawer'),
  settings('settings/account', 'dialog'),
  // WHY (2026-09-29): the signed-in Account view was never photographed, so it
  // missed the card sweep — Destin found it bare in the live app.
  { ...settings('settings/account#signed-in', 'dialog'), params: { signedIn: '1' } },
  settings('settings/account/connections', 'dialog'),
  { ...settings('settings/assistant', 'dialog'), sameAs: { name: 'settings/assistant/general', why: 'the panel opens on its General page' } },
  settings('settings/assistant/general', 'dialog'),
  settings('settings/assistant/cloud', 'dialog'),
  settings('settings/assistant/local', 'dialog'),
  settings('settings/assistant/local/engine-advanced', 'dialog'),
  // Failures with their Try again (small-fixes-1): the engine's set-up check, and a model download
  // that could not start — each was a red box with nothing to press.
  { ...settings('settings/assistant/local/engine-advanced#check-failed', 'dialog', 'error-state'), params: { fail: 'engine.prereqs' }, open: ['Set up'] },
  { ...settings('settings/assistant/local#download-failed', 'dialog', 'error-state'), params: { fail: 'models.download' }, open: ['Download'] },
  // The one installed model with a load-failure state (mock-shim switch by model id).
  settings('settings/assistant/local/model-settings', 'dialog'),
  settings('settings/assistant/cloud/claude-code/sign-out', 'dialog'),
  settings('settings/assistant/cloud/openrouter/key', 'dialog'),
  settings('settings/assistant/permissions', 'dialog'),
  // A folder opened and pointed at: the card lights as one (the ST4-2 sweep).
  // Scrolls first: the backup warning at the top of the modes card (backup-warning-1) pushed the
  // folder rows below the fold at 1440×900.
  { ...settings('settings/assistant/permissions#folder-open-hover', 'dialog', 'fold'), open: [{ do: 'scroll', dir: 'down', times: 3 }, 'youcoded /home/destin/youcoded-dev/youcoded 4 ▸', { do: 'hover', target: { role: 'button', label: 'youcoded /home/destin/youcoded-dev/youcoded 4 ▾' } }] },
  settings('settings/assistant/permissions/skip-confirm', 'dialog'),
  settings('settings/assistant/specialists', 'dialog'),
  // error-notices-1 (2026-10-12): a setting that couldn't load (one line + Retry), and a
  // general error with Report bug / Diagnose (Permissions).
  { ...settings('settings/assistant/specialists#load-failed', 'dialog', 'error-state'), params: { fail: 'specialists.getDelegatedModels' } },
  { ...settings('settings/assistant/permissions#load-failed', 'dialog', 'error-state'), params: { fail: 'permissions.list' } },
  { ...settings('settings/assistant/general#step-guard-failed', 'dialog', 'error-state'), params: { fail: 'native.getStepGuard' } },
  settings('settings/appearance', 'dialog'),
  // The two Appearance folds, now the shared FoldRow (submit-ticket-5 proposal 1).
  { ...settings('settings/appearance#custom-open', 'dialog', 'fold'), open: ['Additional customizations Message bubbles, corners, glass, particles', { do: 'scroll', dir: 'down', times: 2 }] },
  { ...settings('settings/appearance#finetune-open', 'dialog', 'fold'), open: ['Additional customizations Message bubbles, corners, glass, particles', { do: 'scroll', dir: 'down', times: 8 }, 'Fine-tune glass Set each blur and see-through level', { do: 'scroll', dir: 'down', times: 8 }] },
  settings('settings/appearance/about', 'dialog'),
  settings('settings/buddy', 'dialog'),
  settings('settings/sound', 'dialog'),
  // Only a two-graphics-chip computer shows this row; `gpus=2` makes the practice app one.
  { ...settings('settings/performance', 'dialog'), params: { gpus: '2' } },
  // Folds opened (the shared fold opens inside its box — submit-ticket-2#ST2-Q1).
  { ...settings('settings/performance#fold-open', 'dialog', 'fold'), params: { gpus: '2' }, open: ['Why YouCoded uses the discrete GPU'] },
  { ...settings('settings/performance#fold-open-hover', 'dialog', 'fold'), params: { gpus: '2' }, open: ['Why YouCoded uses the discrete GPU', { do: 'hover', target: { role: 'button', label: 'Why YouCoded uses the discrete GPU' } }], sameAs: { name: 'settings/performance#fold-open', why: 'only the pointer highlight differs, a faint tint the look-alike check may not count' } },
  settings('settings/sync', 'dialog', 'error-state'),
  { ...settings('settings/sync#log-open', 'dialog', 'fold'), params: { sync: 'ok' }, open: [{ do: 'scroll', dir: 'down', times: 8 }, 'Sync log', { do: 'scroll', dir: 'down', times: 8 }] },
  { ...settings('settings/sync#ok', 'dialog'), params: { sync: 'ok' } },
  { ...settings('settings/sync#auth-error', 'dialog', 'error-state'), params: { sync: 'auth-error' } },
  { ...settings('settings/sync#oversize', 'dialog', 'error-state'), params: { sync: 'oversize' } },
  // A GitHub backup set up before computers stopped supporting it: shown honestly (small-fixes-2).
  { ...settings('settings/sync#github-unsupported', 'dialog'), params: { syncWarn: 'github' }, open: [{ do: 'scroll', dir: 'down', times: 8 }] },
  // The wizard's sign-in step when the sign-in fails: its own reason and Try again (small-fixes-2).
  { ...settings('settings/sync#add-auth-failed', 'dialog', 'error-state'), params: { syncSetup: 'auth-failed' }, escapeStepsBack: WIZARD_ESCAPE,
    open: [{ do: 'scroll', dir: 'down', times: 8 }, '＋ Add a backup', 'Google Drive…', 'Connect to Google'] },
  // A Google Drive backup that timed out: the classifier's warning with its fix button (small-fixes-2).
  { ...settings('settings/sync#backup-timeout', 'dialog', 'error-state'), params: { syncWarn: 'timeout' }, open: [{ do: 'scroll', dir: 'down', times: 8 }] },
  // Removed projects and their GitHub backups (project switcher round 2, backlog row 10).
  { ...settings('settings/sync#removed', 'dialog'), params: { sync: 'removed' }, open: [{ do: 'scroll', dir: 'down', times: 8 }] },
  // The (i) explainer: what Backup & sync copies, and what it does not (small-fixes-1).
  { ...settings('settings/sync#explainer', 'dialog'), open: ['What is this?'] },
  // The add-a-backup wizard's two failures (small-fixes-1): the helper tool's install, and making
  // the GitHub repository on Start backup — each a notice with Try again in its button's place.
  { ...settings('settings/sync#add-install-failed', 'dialog', 'error-state'), params: { syncSetup: 'install-failed' }, escapeStepsBack: WIZARD_ESCAPE,
    open: [{ do: 'scroll', dir: 'down', times: 8 }, '＋ Add a backup', 'Google Drive…', 'Install now'] },
  { ...settings('settings/sync#add-save-failed', 'dialog', 'error-state'), params: { syncSetup: 'save-failed' }, escapeStepsBack: WIZARD_ESCAPE,
    open: [{ do: 'scroll', dir: 'down', times: 8 }, '＋ Add a backup', 'Google Drive…', 'Connect to Google', 'Start backup'] },
  // The add-a-backup wizard's sign-in and settings steps (no Done page since small-fixes-3#SF3-5).
  { ...settings('settings/sync#add-auth', 'dialog'), escapeStepsBack: WIZARD_ESCAPE, open: [{ do: 'scroll', dir: 'down', times: 8 }, '＋ Add a backup', 'Google Drive…'] },
  { ...settings('settings/sync#add-configure', 'dialog'), escapeStepsBack: WIZARD_ESCAPE, open: [{ do: 'scroll', dir: 'down', times: 8 }, '＋ Add a backup', 'Google Drive…', 'Connect to Google'] },
  // The add-a-backup picker: Google Drive (and iCloud on Mac and Windows) — no GitHub on a computer.
  { ...settings('settings/sync#add-picker', 'dialog'), escapeStepsBack: WIZARD_ESCAPE, open: [{ do: 'scroll', dir: 'down', times: 8 }, '＋ Add a backup'] },
  // "Remove backup?" on the default fixture's one backend (drive-1).
  settings('settings/sync/remove-backend', 'dialog'),
  settings('settings/remote', 'dialog'),
  settings('settings/help', 'dialog'),
  settings('settings/development/bug-report', 'dialog'),
  // Every step and outcome of the ticket (redesign backlog 13), reached the way a person
  // reaches it: typed, ticked and clicked by "open this first". `ticket=hold` keeps a send
  // or a setup waiting; `network=offline` and the `refused` scenario fail the send.
  ...TICKET_STATES,
  settings('settings/development/contribute', 'dialog'),
  { ...settings('settings/development/contribute#walkthrough', 'dialog'), open: ['How contributing works'] },
  { ...settings('settings/development/contribute#ready', 'dialog'), params: { devCopy: 'ready' } },
  { ...settings('settings/development/contribute#downloading', 'dialog'), params: { ticket: 'hold' }, open: ['Download YouCoded’s code'] },
  // Contribute's two failures, in the guide's notice box (submit-ticket-5).
  { ...settings('settings/development/contribute#failed', 'dialog'), scenario: 'refused', open: ['Download YouCoded’s code'], waitMs: 3500 },
  { ...settings('settings/development/contribute#open-failed', 'dialog'), params: { devCopy: 'ready', devOpen: 'fail' }, open: ['Open it'] },
  { ...settings('settings/development/contribute#open-failed-details', 'dialog'), params: { devCopy: 'ready', devOpen: 'fail' }, open: ['Open it', 'Details'] },
  { ...settings('settings/development/contribute#failed-details', 'dialog'), scenario: 'refused', open: ['Download YouCoded’s code', 'Details'], waitMs: 3500 },
  settings('settings/shortcuts', 'dialog'),
  settings('settings/donate', 'dialog'),
  settings('settings/about', 'dialog'),
  { ...settings('settings/about#account-open', 'dialog', 'fold'), open: ['Your account (optional)'] },
  // The fold header's hover (submit-ticket-3#ST3-5: "not rounded"). Shoot at the normal 1.5×:
  // the pointer offset that once landed a hover one row off was fixed on 2026-10-06 (a394a871).
  { ...settings('settings/about#fold-hover', 'dialog', 'fold'), open: [{ do: 'hover', target: { role: 'button', label: 'Your account (optional)' } }], sameAs: { name: 'settings/about', why: 'only the pointer highlight differs, a faint tint the look-alike check may not count' } },
  { ...settings('settings/about#stats-open', 'dialog', 'fold'), open: ['Anonymous usage stats'] },
  { ...settings('settings/about#licenses-open', 'dialog', 'fold'), open: [{ do: 'scroll', dir: 'down', times: 8 }, 'Open-source libraries'] },
  // Android-only rows (isAndroid() gates AndroidSettings vs. DesktopSettings).
  { ...settings('settings/android/tier', 'dialog'), params: { platform: 'android' } },
  { ...settings('settings/android/connect-desktop', 'dialog'), params: { platform: 'android' } },
  // Sign-in and key states of the cloud providers (mock-shim switches); each picture
  // scrolls to its provider's card.
  { ...settings('settings/assistant/cloud/chatgpt#signed-out', 'dialog', 'sign-in'), params: { chatgpt: 'signed-out', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/chatgpt#waiting', 'dialog', 'sign-in'), params: { chatgpt: 'waiting', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/chatgpt#blocked', 'dialog', 'sign-in', 'error-state'), params: { chatgpt: 'blocked', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/chatgpt#official', 'dialog', 'sign-in'), params: { chatgpt: 'official', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/chatgpt#reauth', 'dialog', 'sign-in'), params: { chatgpt: 'reauth', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#none', 'dialog', 'sign-in'), params: { openrouter: 'none', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#waiting', 'dialog', 'sign-in'), params: { openrouter: 'none', openrouterSignIn: 'waiting', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#failed', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'none', openrouterSignIn: 'failed', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#verified', 'dialog', 'sign-in'), params: { openrouter: 'verified', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#rejected', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'rejected', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#expired', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'expired', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#wrong-type', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'wrong-type', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#unchecked', 'dialog', 'sign-in'), params: { openrouter: 'unchecked', planUsage: '1' } },
];
