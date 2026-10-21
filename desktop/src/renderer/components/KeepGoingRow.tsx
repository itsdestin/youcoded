import { Button } from './ui';

/** The newest turn stopped at its step limit (error-card.questions#Q-6): one
 *  quiet line under the reply, with Keep going — the same task continues for
 *  another round of steps, no message to type. The footer above already says
 *  "Stopped after N steps."; this row is only the way on, so it carries no ring
 *  (nothing failed) and sits in the thinking line's place. */
export function KeepGoingRow({ onKeepGoing }: { onKeepGoing: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 in-view">
      <div className="flex items-center gap-3 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5">
        <span className="text-sm text-fg-2">The task isn't finished.</span>
        <Button size="sm" onClick={onKeepGoing}>Keep going</Button>
      </div>
    </div>
  );
}
