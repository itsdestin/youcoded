// Close codes the computer's socket host sends a phone that both ends must agree on.
//
// A newer connection from the same device signed in, so this one is closed (2026-10-22 phone reliability): a phone
// that reconnected after a silent drop left its old, dead connection on the computer for 60–80 s, which kept being
// sent to and counted as online. The page that receives this must NOT reconnect: in a browser it means another tab
// with the same saved key took over, and coming back would take it back again, forever.
export const CLOSE_REPLACED = 4011;
