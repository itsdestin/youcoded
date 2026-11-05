// The one-time heads-up that YouCoded turned a plugin off (plugin off-switch).
//
// WHY a toast with a "Show" button (not a banner): the app's own Toast already takes a
// button and draws above the message box on every screen, so people who never open the
// Library still find out. Words and event live here so the photo-only build
// (dev/workbench/ToastPractice) shows the very same toast.
import { announce } from './announce';

const PLUGIN_TURNED_OFF_MESSAGE = 'We turned off a plugin that was found to be unsafe.';
/** Asks App to open Your library. */
export const OPEN_LIBRARY_EVENT = 'youcoded:open-library';

export function announcePluginTurnedOff(durationMs = 10_000): void {
  announce(PLUGIN_TURNED_OFF_MESSAGE, durationMs, {
    label: 'Show',
    onClick: () => window.dispatchEvent(new Event(OPEN_LIBRARY_EVENT)),
  });
}
