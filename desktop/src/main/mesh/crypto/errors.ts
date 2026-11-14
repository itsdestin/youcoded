// Mesh crypto: the one error type this folder ever throws for bad INPUT.
//
// WHY a single typed error: every function that parses or verifies bytes from outside
// (a frame from a relay, a pairing message from a hostile pipe, a stored key file) must fail in
// one predictable way. Callers catch MeshCryptoError and read `.code`; anything else that
// escapes is a bug in this folder, and the fuzz test (fuzz.test.ts) fails the build if it can
// be provoked. The message NEVER contains key material, codes or frame bodies (see
// no-secret-logging.test.ts), only the code and a fixed description.

export type MeshCryptoErrorCode =
  | 'malformed' // bytes do not parse, or a field has the wrong type/size
  | 'invalid-argument' // the CALLER passed something wrong (programmer error)
  | 'unsupported-version' // header `v` we do not know: refused, never downgraded
  | 'wrong-set' // frame names a different device set
  | 'unknown-generation' // no secret held for the named generation
  | 'unknown-signer' // sender not on the roster (the caller may PARK the frame, never accept it)
  | 'not-addressed-to-me' // `to` names another device
  | 'auth-failed' // AEAD tag did not verify (wrong key, tampered header or body)
  | 'bad-signature' // Ed25519 signature did not verify
  | 'replay' // (sender, session, counter) already seen
  | 'out-of-window' // counter falls in a gap the receiver closed to stay within its memory bound: cannot be told apart from a replay
  | 'stale-state' // saved receiver state is older than the caller says it must be (a rollback)
  | 'counter-exhausted' // sender hit its per-session frame limit; start a new session
  | 'session-reused' // same (device, session) used by a second sender in this process
  | 'too-large' // frame or message exceeds the size cap
  | 'low-order-point' // peer sent a weak curve point (pairing abort)
  | 'invalid-code' // typed pairing code has a character outside the alphabet or wrong length
  | 'relay-mismatch' // relay challenge names a host other than the one dialled
  | 'bad-roster' // roster log failed verification
  | 'bad-entry'; // a single signed entry failed verification

export class MeshCryptoError extends Error {
  readonly code: MeshCryptoErrorCode;
  constructor(code: MeshCryptoErrorCode, detail?: string) {
    super(detail ? `mesh-crypto: ${code}: ${detail}` : `mesh-crypto: ${code}`);
    this.name = 'MeshCryptoError';
    this.code = code;
  }
}

/**
 * Run a parser/verifier and turn ANY non-MeshCryptoError (a RangeError from a huge allocation, a
 * TypeError from a field of the wrong shape, an OpenSSL error from a bad point) into
 * `malformed`. WHY: hostile bytes must never surface a raw engine error whose text could carry
 * unexpected content, and callers get exactly one error type to handle.
 */
export function guard<T>(fn: () => T, code: MeshCryptoErrorCode = 'malformed'): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MeshCryptoError) throw e;
    // WHY: an exception thrown by a CALLER-supplied callback is a bug in the caller, not hostile input.
    // Relabelling it `malformed` hid programming errors (a lookup that throws looked like a bad frame).
    if (e instanceof CallbackFailure) throw e.original;
    throw new MeshCryptoError(code);
  }
}

/** Marks an exception that came out of a caller-supplied callback, so `guard` lets it through unchanged. */
class CallbackFailure {
  constructor(readonly original: unknown) {}
}
/** Run a caller-supplied callback; anything it throws surfaces to OUR caller as itself. */
export function callerCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new CallbackFailure(e);
  }
}
