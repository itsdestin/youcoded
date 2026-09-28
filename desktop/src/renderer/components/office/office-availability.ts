// Whether this app can run Office at all — asked of main once per app run (Task 6).
//
// WHY not "does window.claude.office exist": since Task 5 the namespace exists everywhere —
// desktop, the remote browser and the phone — so its presence says nothing. Only the desktop
// host answers status().available true (the add-on is installed at the pinned version); the
// remote client and the phone refuse the call, which reads as false here. Every Office entry
// point (Edit on an Office file, the header briefcase, the Pages rail's Office row and the
// Office page) is shown only once this says true, so remote and phone look exactly as they did
// before Office existed.
//
// WHY once: the answer cannot change while the app runs (the add-on ships with it), and
// the entry points render on every keystroke in places like the file panel header.
import { useSyncExternalStore } from 'react';

let available = false;
let asked = false;
const listeners = new Set<() => void>();

function ask(): void {
  if (asked) return;
  asked = true;
  const office = window.claude?.office;
  if (!office) return;
  // null project: availability does not depend on one.
  office.status(null).then((s) => {
    if (s?.available !== true) return;
    available = true;
    listeners.forEach((l) => l());
  }, () => { /* refused (remote, phone) or failed: Office stays hidden */ });
}

function subscribe(l: () => void) {
  listeners.add(l);
  ask();
  return () => { listeners.delete(l); };
}

/** Re-renders when the answer arrives; false until then. */
export function useOfficeAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => available, () => available);
}

/** The answer so far, for code outside a render's hooks (the file panels' header action).
 *  Starts the question if nobody has asked yet. */
export function officeAvailableNow(): boolean {
  ask();
  return available;
}

/** Tests only: forget the answer so the next caller asks again. */
export function resetOfficeAvailabilityForTests(): void {
  available = false;
  asked = false;
}
