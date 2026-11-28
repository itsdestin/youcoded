// The heads-up that YouCoded signed the account out by itself (card #216).
//
// WHY a toast with a "Sign in again" button (not a banner or popup): it is the same shape as the plugin
// off-switch heads-up (plugin-off-notice.ts) — the app's own Toast takes one button, draws above the message
// box on every screen, never blocks work and goes away by itself. Words and event live here so the photo-only
// build (dev/workbench/ToastPractice) shows the very same toast.
//
// WHY the words claim no cause (docs/error-message-standards.md): all we know is that the server stopped
// recognising the sign-in. We do not say it expired, was revoked or "timed out".
import { announce } from './announce';

const SESSION_LOST_MESSAGE = 'You were signed out of your YouCoded account. Friends see you as offline until you sign in again.';
const SESSION_LOST_BUTTON = 'Sign in again';

/** 30 s, not the plugin notice's 10: this one is about being offline to friends, and a person may look up late. */
export function announceSessionLost(signInAgain: () => void, durationMs = 30_000): void {
  announce(SESSION_LOST_MESSAGE, durationMs, { label: SESSION_LOST_BUTTON, onClick: signInAgain });
}
