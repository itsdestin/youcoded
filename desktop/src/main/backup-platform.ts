// backup-platform.ts — "is this backend running on a phone?", answered once, on purpose.
//
// WHY (backup fixes 2026-11-18): the phone runs this same Node backend inside a bundled Linux, so
// `process.platform` says "linux" there and nothing in the environment tells the backup code it is on a
// phone. A phone has neither rclone nor gh, so backing up to Google Drive (rclone) or GitHub (gh) can only
// fail: Drive tried `curl | sudo bash` to install rclone and then showed a red "rclone isn't installed"
// warning every hour; GitHub copied nothing yet reported "finished".
//
// The flag is set in exactly one place — headless-boot.ts, which only ever runs on a phone — and is NEVER
// derived from the environment, so a computer can never end up with Drive backup switched off by a wrong guess
// (tests pin that a service built the way main.ts builds it still pushes Drive).
let onPhone = false;

/** Called once by headless-boot.ts (the phone's backend). Never call from the desktop's main.ts. */
export function setRunningOnPhone(value: boolean): void {
  onPhone = value;
}

/** True only inside the phone's own backend. */
export function isRunningOnPhone(): boolean {
  return onPhone;
}
