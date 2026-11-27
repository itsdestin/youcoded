// device-noun.ts — what to call the device this backend runs on, in sentences a person reads.
//
// WHY this exists: the Android app runs this same Node backend inside the phone (headless-boot.ts),
// so messages like "Finish signing in on this computer" reach a phone user who has no computer
// in the picture. The renderer has deviceNoun() (renderer/platform.ts) for its own strings; this is
// the backend's one equivalent. headless-boot.ts calls markBackendAsPhone() once at startup (the
// headless backend only ever runs on a phone); the desktop app never calls it, so it stays 'computer'.
// A phone paired to a remote computer is not affected: those messages come from the computer's own
// backend, which never sets the flag.
let onPhone = false;

export function markBackendAsPhone(): void {
  onPhone = true;
}

export function backendDeviceNoun(): 'phone' | 'computer' {
  return onPhone ? 'phone' : 'computer';
}
