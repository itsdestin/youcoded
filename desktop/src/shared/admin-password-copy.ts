// admin-password-copy.ts — the words shown when YouCoded turns down an admin
// password request, in ONE place (Destin reviews them on a deck, 2026-09-26:
// "this must never feel broken"). Shared: the main process appends the model
// line to the command's result; the card finds that line in the saved result
// and shows the card line — so the explanation survives reloads and reaches a
// phone without any extra event.

/** What the person sees on the command's card. */
export const ADMIN_REFUSED_CARD_LINE =
  "YouCoded couldn't confirm this password request came from your computer's admin program, so it didn't ask for your password.";

/** Fixed start of the line the assistant reads — the card keys on it. */
export const ADMIN_REFUSED_MODEL_MARKER = '[YouCoded] The admin password request was refused';

/** The line appended to the command's result for the assistant. `reason` is a
 *  verify/server reason code (never an environment value or anything secret). */
export function adminRefusedModelLine(reason: string): string {
  return `${ADMIN_REFUSED_MODEL_MARKER} because it could not be verified as coming from the system's sudo ` +
    `(reason: ${reason}). Do not retry the same way; tell the user sudo couldn't be used here.`;
}
