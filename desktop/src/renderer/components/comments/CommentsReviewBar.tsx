// CommentsReviewBar — the slim strip at the top of the file viewer: a count
// (G-19: "label" + muted numeral, never "N comments" as one string) and the
// one primary action for this whole view (G-4), which sends every OPEN
// comment to the assistant as a batch.
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { basenameOf, useDocComments } from '../../state/doc-comments-store';

export interface CommentBatchRef {
  quote: string;
  sourceLabel: string;
  note: string;
}

interface Props {
  path: string;
  /** SessionDrawer's pane is a fixed ~480px no matter how wide the window
   *  is — narrow here means the PANE ran out of room, not the app window
   *  (ActiveArtifactView measures its own root; see use-container-narrow.ts). */
  narrow?: boolean;
}

export function CommentsReviewBar({ path, narrow = false }: Props) {
  const { comments, showResolved, setShowResolved } = useDocComments(path);
  const open = comments.filter((c) => !c.resolved);
  const resolvedCount = comments.length - open.length;

  const send = () => {
    if (open.length === 0) return;
    const refs: CommentBatchRef[] = open.map((c) => ({ quote: c.quote, sourceLabel: c.sourceLabel, note: c.text }));
    const lead = `Please go through ${open.length === 1 ? 'this comment' : `these ${open.length} comments`} on ${basenameOf(path)}:`;
    // WHY a window event, not a prop: the review bar lives in the artifact
    // viewer, the composer lives in InputBar — siblings several layers apart
    // with no shared ancestor built for this. build-menu.ts's "Ask about
    // this" already uses this exact pattern (youcoded:compose-insert) for the
    // same reason. This calls the composer's OWN normal send path — it is not
    // a second way to deliver a message.
    window.dispatchEvent(new CustomEvent('youcoded:compose-send-comments', { detail: { lead, refs } }));
  };

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 border-b border-edge bg-panel shrink-0 text-xs min-w-0">
      {!narrow && <span className="text-fg-2 font-medium shrink-0">Comments</span>}
      <Badge label={`${comments.length} comments`}>{comments.length}</Badge>
      {resolvedCount > 0 && (
        <label className="flex items-center gap-1.5 text-fg-muted select-none shrink-0" title="Show resolved comments">
          <Toggle checked={showResolved} onChange={setShowResolved} aria-label="Show resolved comments" />
          {!narrow && 'Show resolved'}
        </label>
      )}
      <div className="flex-1 min-w-0" />
      <Button
        variant="primary"
        size="sm"
        disabled={open.length === 0}
        title={open.length === 0 ? 'No open comments to send' : undefined}
        onClick={send}
        className="shrink-0"
      >
        {narrow ? 'Send' : 'Send to assistant'}
      </Button>
    </div>
  );
}
