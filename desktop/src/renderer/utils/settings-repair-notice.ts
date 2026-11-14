// The one-time heads-up that YouCoded replaced a damaged Claude Code settings file (card #11 a).
//
// WHY a toast with a "Show old copy" button: the same shape as the plugin off-switch (plugin-off-notice.ts) and
// signed-out (session-lost-notice.ts) heads-ups — the app's own Toast draws above the message box on every
// screen and takes one button. Words live here so the photo-only build (dev/workbench/ToastPractice) shows the
// very same toast.
//
// WHY the words claim no cause (docs/error-message-standards.md): all YouCoded knows is that the file did not
// read as settings. It does not say why it was damaged, or that anything was lost beyond "the old copy is kept".
import { announce } from './announce';
import { isAndroid, isRemoteMode } from '../platform';

export const SETTINGS_REPAIR_MESSAGE = "YouCoded couldn't read your Claude Code settings file, so it kept the old copy and started a fresh one. Your own settings in the old copy were not carried over.";
const SHOW_BUTTON = 'Show old copy';

/** 30 s: it is about a file that changed behind the person's back, so someone who looks up late should still see it. */
export function announceSettingsRepaired(backupPath: string, durationMs = 30_000): void {
  // WHY no button on a phone or the Android app (card #11 a, deck C-1): the file is on the computer, and a phone's
  // showItemInFolder does nothing, so the button would be a dead tap. The words alone still tell the person.
  const canShow = !isAndroid() && !isRemoteMode();
  announce(SETTINGS_REPAIR_MESSAGE, durationMs, canShow ? {
    label: SHOW_BUTTON,
    onClick: () => { void (window as any).claude?.shell?.showItemInFolder?.(backupPath); },
  } : undefined);
}
