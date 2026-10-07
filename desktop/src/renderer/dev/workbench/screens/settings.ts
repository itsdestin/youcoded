// Settings: the drawer and every dialog it opens.
import type { ScreenEntry } from './types';

const settings = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['settings', ...tags] });

// ── Submit a ticket: practice steps ──────────────────────────────────────────────
const TICKET = 'settings/development/bug-report';
const TYPE_TITLE = { do: 'type', target: { role: 'textbox', label: 'Title' }, text: 'Settings text is cut off on my phone' };
const TYPE_DESCRIPTION = { do: 'type', target: { role: 'textbox', label: 'Description' },
  text: 'On my phone, Settings → Sound cuts off the right edge of the Volume card. I expected it to fit the screen.' };
const TICK_LOGS = { do: 'click', target: { role: 'checkbox', label: 'Include recent logs' } };
const TICK_FILES = { do: 'click', target: { role: 'checkbox', label: 'Finish with attachments in GitHub' } };
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
  // Three looks for the include choices (ticket-practice.ts `ticketTicks`), opened from an
  // error so all three choices show; the plain `from-error` state is the shipped look.
  ticket('ticks-switches', { params: { reportFrom: 'error', ticketTicks: 'switches' } }),
  ticket('ticks-left', { params: { reportFrom: 'error', ticketTicks: 'left' } }),
  ticket('review-logs-open', { open: [...FILL, TICK_LOGS, REVIEW, { do: 'click', target: { role: 'button', label: 'Recent logs 4 lines — open to read or remove anything private' } }] }),
  ticket('handover-failed', { scenario: 'refused', open: [...FILL, REVIEW, AI, HAND_OVER], waitMs: 3500 }),
  ticket('sending', { params: { ticket: 'hold' }, open: [...FILL, REVIEW, SEND] }),
  ticket('sent', { open: [...FILL, REVIEW, SEND] }),
  ticket('browser', { open: [...FILL, TICK_FILES, REVIEW, 'Continue in GitHub'] }),
  ticket('failed', { scenario: 'refused', open: [...FILL, REVIEW, SEND] }),
  ticket('offline', { params: { network: 'offline' }, open: [...FILL, REVIEW, SEND] }),
  ticket('handing-over', { params: { ticket: 'hold' }, open: [...FILL, REVIEW, AI, HAND_OVER] }),
  ticket('handed-over', { open: [...FILL, REVIEW, AI, HAND_OVER], waitMs: 3500 }),
  ticket('phone', { viewport: PHONE, open: FILL }),
  ticket('phone-review', { viewport: PHONE, open: [...FILL, TICK_LOGS, REVIEW] }),
  ticket('small', { viewport: SMALL, open: FILL }),
  ticket('small-review', { viewport: SMALL, open: [...FILL, TICK_LOGS, REVIEW] }),
];

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
  // The one installed model with a load-failure state (mock-shim switch by model id).
  settings('settings/assistant/local/model-settings', 'dialog'),
  settings('settings/assistant/cloud/claude-code/sign-out', 'dialog'),
  settings('settings/assistant/cloud/openrouter/key', 'dialog'),
  settings('settings/assistant/permissions', 'dialog'),
  settings('settings/assistant/permissions/skip-confirm', 'dialog'),
  settings('settings/assistant/specialists', 'dialog'),
  settings('settings/appearance', 'dialog'),
  settings('settings/appearance/about', 'dialog'),
  settings('settings/buddy', 'dialog'),
  settings('settings/sound', 'dialog'),
  // Only a two-graphics-chip computer shows this row; `gpus=2` makes the practice app one.
  { ...settings('settings/performance', 'dialog'), params: { gpus: '2' } },
  settings('settings/sync', 'dialog', 'error-state'),
  { ...settings('settings/sync#ok', 'dialog'), params: { sync: 'ok' } },
  { ...settings('settings/sync#auth-error', 'dialog', 'error-state'), params: { sync: 'auth-error' } },
  { ...settings('settings/sync#oversize', 'dialog', 'error-state'), params: { sync: 'oversize' } },
  // Removed projects and their GitHub backups (project switcher round 2, backlog row 10).
  { ...settings('settings/sync#removed', 'dialog'), params: { sync: 'removed' }, open: [{ do: 'scroll', dir: 'down', times: 8 }] },
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
  settings('settings/shortcuts', 'dialog'),
  settings('settings/donate', 'dialog'),
  settings('settings/about', 'dialog'),
  // Android-only rows (isAndroid() gates AndroidSettings vs. DesktopSettings).
  { ...settings('settings/android/tier', 'dialog'), params: { platform: 'android' } },
  { ...settings('settings/android/connect-desktop', 'dialog'), params: { platform: 'android' } },
  // Sign-in and key states of the cloud providers (mock-shim switches); each picture
  // scrolls to its provider's card.
  { ...settings('settings/assistant/cloud/chatgpt#signed-out', 'dialog', 'sign-in'), params: { chatgpt: 'signed-out', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/chatgpt#waiting', 'dialog', 'sign-in'), params: { chatgpt: 'waiting', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/chatgpt#blocked', 'dialog', 'sign-in', 'error-state'), params: { chatgpt: 'blocked', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#none', 'dialog', 'sign-in'), params: { openrouter: 'none', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#waiting', 'dialog', 'sign-in'), params: { openrouter: 'none', openrouterSignIn: 'waiting', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#failed', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'none', openrouterSignIn: 'failed', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#verified', 'dialog', 'sign-in'), params: { openrouter: 'verified', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#rejected', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'rejected', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#expired', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'expired', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#wrong-type', 'dialog', 'sign-in', 'error-state'), params: { openrouter: 'wrong-type', planUsage: '1' } },
  { ...settings('settings/assistant/cloud/openrouter#unchecked', 'dialog', 'sign-in'), params: { openrouter: 'unchecked', planUsage: '1' } },
];
