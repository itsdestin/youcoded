// last-computer.ts — the computer the Android app was last using, so it can go back to it after a restart.
//
// WHY (2026-10-22 phone reliability, cause 1): the app always started on the phone's own runtime and
// the person had to open Settings and pick their computer again after every restart — and the app
// restarts whenever Android reclaims it. Only the address is kept here: the password stays in the
// app's own encrypted store (PairedDeviceStore), looked up by this address when it is needed.
//
// A separate key from `youcoded-remote-target`, which the page wipes at every Android launch so the
// local runtime can never inherit a remote address (installShim).
const KEY = 'youcoded-last-computer';

export interface LastComputer { host: string; port: number }

export function rememberLastComputer(host: string, port: number): void {
  try { localStorage.setItem(KEY, JSON.stringify({ host, port })); } catch { /* storage full or blocked: the person picks it again */ }
}

export function forgetLastComputer(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}

export function lastComputer(): LastComputer | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v.host === 'string' && typeof v.port === 'number' ? { host: v.host, port: v.port } : null;
  } catch {
    return null;
  }
}
