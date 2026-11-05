// Close codes the computer's socket host sends a phone that both ends must agree on.
//
// A newer connection from the same device signed in, so this one is closed (2026-10-22 phone reliability): a phone
// that reconnected after a silent drop left its old, dead connection on the computer for 60–80 s, which kept being
// sent to and counted as online. The page that receives this must NOT reconnect: in a browser it means another tab
// with the same saved key took over, and coming back would take it back again, forever.
export const CLOSE_REPLACED = 4011;

// A paired device went 90 days without being used, so the computer signed it out (2026-10-31). Final like an unpair:
// the page must forget its key and ask for the password, with its own sentence saying why.
export const CLOSE_DEVICE_EXPIRED = 4006;
/** The ONE number behind the sign-out and every sentence that mentions it (store, close reason, both screens). */
export const DEVICE_EXPIRY_DAYS = 90;
