// Settings: the drawer and every dialog it opens.
import type { ScreenEntry } from './types';

const settings = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['settings', ...tags] });

export const SETTINGS: readonly ScreenEntry[] = [
  settings('settings', 'drawer'),
  settings('settings/account', 'dialog'),
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
  settings('settings/appearance/edit', 'dialog'),
  settings('settings/buddy', 'dialog'),
  settings('settings/sound', 'dialog'),
  // Only a two-graphics-chip computer shows this row; `gpus=2` makes the practice app one.
  { ...settings('settings/performance', 'dialog'), params: { gpus: '2' } },
  settings('settings/sync', 'dialog', 'error-state'),
  { ...settings('settings/sync#ok', 'dialog'), params: { sync: 'ok' } },
  { ...settings('settings/sync#auth-error', 'dialog', 'error-state'), params: { sync: 'auth-error' } },
  { ...settings('settings/sync#oversize', 'dialog', 'error-state'), params: { sync: 'oversize' } },
  // "Remove backup?" on the default fixture's one backend (drive-1).
  settings('settings/sync/remove-backend', 'dialog'),
  settings('settings/remote', 'dialog'),
  settings('settings/help', 'dialog'),
  settings('settings/development', 'dialog'),
  settings('settings/development/bug-report', 'dialog'),
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
