/**
 * Specialists plans, Task 11 (pause handoff design §6, review 4-6): what the
 * chat shows for the notice the user's "Ask the assistant" sends.
 *
 * The notice itself is a long instruction for the model (plan id, handoff id,
 * the allowed actions); the person only needs to see that they asked. So it
 * is ONE plain line on the user's side of the chat — not a message bubble,
 * so there is nothing to edit or resend. Drawn by ChatView, the buddy feed
 * and previews alike, through chat-types.ts `userEntryRenderKind`.
 */
export function PlanAskLine() {
  return (
    <div className="flex justify-end px-1" data-testid="plan-ask-line">
      <span className="text-xs text-fg-muted">You asked the assistant about this plan.</span>
    </div>
  );
}
