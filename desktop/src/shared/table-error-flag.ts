// WHY (2026-09-30 one-core R3-3): a tiny module of its own so remote-shim.ts (which must stay
// lean for the Android WebView bundle) can import this one value without the whole backend contract.
/** WHY (2026-09-30 one-core R3-2): the flag a phone-side table reply carries when the handler
 *  THREW and the entry gave no softer answer (`remoteOnError`). The phone's page rejects any reply
 *  bearing it (remote-shim `responseOutcome`), for every channel, so a moved channel never hands
 *  its caller a failure object where the type promises a list, a record or a boolean. Lives here
 *  because the door (main/) and the page (renderer/) both read it and neither may import the other. */
export const TABLE_ERROR_FLAG = 'tableHandlerFailed' as const;
