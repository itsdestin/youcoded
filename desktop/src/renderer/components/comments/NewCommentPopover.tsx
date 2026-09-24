// NewCommentPopover — Reading mode's "add a comment" flow (Destin, round 2):
// select text → a small popup box right at the selection; Enter saves,
// Shift+Enter newline, Esc cancels. Comments mode still uses the margin
// card's own inline textarea (autoFocus on the just-added draft) — this
// popover exists because Reading mode has no margin to hold that box.
import { useEffect, useRef } from 'react';
import { Textarea } from '../ui/Textarea';
import { POPOVER_Z } from '../overlays/Overlay';
import type { DocComment } from '../../state/doc-comments-store';

interface Props {
  comment: DocComment;
  /** Fixed-position anchor, already clamped to the viewport by the caller. */
  style: React.CSSProperties;
  onTextChange: (text: string) => void;
  /** Non-empty text: keep the comment. Empty: delete the never-really-made draft. */
  onDone: () => void;
  onCancel: () => void;
}

export function NewCommentPopover({ comment, style, onTextChange, onDone, onCancel }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div
      className="fixed w-64 rounded-lg border border-edge bg-panel shadow-lg p-2 text-xs"
      style={{ zIndex: POPOVER_Z, ...style }}
    >
      <p className="text-fg-muted italic line-clamp-2 mb-1.5 border-l-2 border-edge-dim pl-2">
        &ldquo;{comment.quote}&rdquo;
      </p>
      <Textarea
        ref={ref}
        size="sm"
        rows={3}
        value={comment.text}
        placeholder="Add a comment…"
        // artifact-edit-textarea: right-click here gets real cut/copy/paste
        // (build-menu.ts) — Electron ships no default context menu.
        className="artifact-edit-textarea w-full"
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onDone();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        // Clicking away commits a non-empty note (Docs-style) rather than
        // silently discarding it; an empty draft is never worth keeping.
        onBlur={() => (comment.text.trim() ? onDone() : onCancel())}
      />
    </div>
  );
}
