// The roster's size limits, in ONE place inside crypto/ (this folder is compiled on its own, so it cannot import ../../../shared).
// MUST equal the same-named constants in src/shared/mesh-protocol.ts (the relay's copy lives in the Worker); tests/mesh/protocol-drift.test.ts
// fails if they ever differ. Change them there and here together: the owner may change MAX_SET_DEVICES (product decision, third review).
export const MAX_SET_DEVICES = 16;
export const MAX_KNOWN_KEYS = 24;
export const MAX_ADMISSIONS_PER_SIGNER = 4;
export const ROSTER_MAX_PER_SIGNER = 256;
