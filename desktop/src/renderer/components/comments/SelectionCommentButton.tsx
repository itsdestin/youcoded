// SelectionCommentButton — Reading mode's fast path to a new comment
// (Destin, round 2): select text → a small floating "Comment" button right
// at the selection. Right-click → "Add comment" (build-menu.ts) still works
// too; this is the faster, more discoverable entry point Google Docs uses.
import { Button } from '../ui/Button';
import { POPOVER_Z } from '../overlays/Overlay';

interface Props {
  /** Selection's own bounding rect (already viewport-relative). */
  rect: DOMRect;
  onClick: () => void;
}

export function SelectionCommentButton({ rect, onClick }: Props) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="fixed shadow-md"
      style={{
        zIndex: POPOVER_Z,
        // Centered just above the selection; clamped so it never runs off
        // the left/top edge on a selection near the corner of the pane.
        left: Math.max(4, rect.left + rect.width / 2 - 40),
        top: Math.max(4, rect.top - 34),
      }}
      // The click on THIS button is itself a mousedown that would otherwise
      // clear the selection before onClick fires — preserve it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      Comment
    </Button>
  );
}
