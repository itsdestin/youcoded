// CommentsModeToggle — the header control that switches the viewer between
// Reading mode (default: highlights + hover cards, full width) and Comments
// mode (the margin/markers rail + review bar). Destin, round 2: "this should
// kinda be a distinct 'mode' entered by the user… a clear toggle… e.g. a
// speech-bubble icon button with count, pressed state." Same ring-accent
// pressed look FeedbackSection's vote buttons already use for a toggled
// secondary button, so this isn't a new pressed-state convention.
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { ChatIcon } from '../Icons';

interface Props {
  active: boolean;
  count: number;
  onToggle: () => void;
}

export function CommentsModeToggle({ active, count, onToggle }: Props) {
  return (
    <Button
      // Design lint: <Button> owns its spacing and shape, so the pressed
      // state is a variant swap rather than a hand-added ring.
      variant={active ? 'raised' : 'secondary'}
      size="sm"
      aria-pressed={active}
      aria-label={active ? 'Exit comments mode' : 'Open comments mode'}
      title={active ? 'Back to reading' : 'Open comments mode'}
      onClick={onToggle}
      className="shrink-0"
    >
      <ChatIcon className="w-3.5 h-3.5" />
      {/* Round 3: was icon+count only — read as an unlabelled bubble with a
          number, not a mode switch. */}
      <span>Comments</span>
      <Badge>{count}</Badge>
    </Button>
  );
}
