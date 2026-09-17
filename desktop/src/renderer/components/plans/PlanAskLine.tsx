/**
 * Specialists plans, Task 11 (pause handoff design §6, review 4-6): what the
 * chat shows for the notice the user's "Ask the assistant" sends.
 *
 * The notice itself is a long instruction for the model (plan id, handoff id,
 * the allowed actions); the person only needs to see that they asked. So it
 * is ONE plain line on the user's side of the chat — not a message bubble,
 * so there is nothing to edit or resend. Drawn by ChatView, the buddy feed
 * and previews alike, through chat-types.ts `userEntryRenderKind`.
 *
 * Decision 20: when the user typed a question in the Ask box, the line ends
 * with it ("You asked the assistant about this plan: <question>"). The caller
 * reads it from the delivered notice (chat-types.ts `planAskQuestion`).
 */
export function PlanAskLine({ question }: { question?: string }) {
  return (
    <div className="flex justify-end px-1" data-testid="plan-ask-line">
      {/* pre-wrap keeps the user's own line breaks; long words still wrap. */}
      <span className="text-xs text-fg-muted text-right whitespace-pre-wrap break-words max-w-full">
        {question ? `You asked the assistant about this plan: ${question}` : 'You asked the assistant about this plan.'}
      </span>
    </div>
  );
}
