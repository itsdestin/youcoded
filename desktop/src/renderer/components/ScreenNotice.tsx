// ScreenNotice — a notice that lives ON the screen that raised it (Destin, waiting-notice deck R-screen).
//
// WHY: the "resume a chat" list and the screen for moving a chat between devices are not part of whichever chat happens to be open
// behind them, so a failure raised there must not show in that chat's strip (or float over something unrelated). It is the same
// thin band as the chat strip, with the same button order (Dismiss outlined on the left, the main action filled on the right).
import { StatusStrip } from './ui/StatusStrip';
import { Button } from './ui/Button';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';

export interface ScreenNoticeData {
  text: string;
  tone?: 'warn' | 'error';
  /** The screen's own retry, drawn filled and rightmost. Absent = sentence only. */
  retry?: () => void;
}

export function ScreenNotice({ notice, onDismiss, className }: { notice: ScreenNoticeData; onDismiss?: () => void; className?: string }) {
  const narrow = useNarrowViewport();
  const hasButtons = !!onDismiss || !!notice.retry;
  return (
    <div className={className} role={notice.tone === 'error' ? 'alert' : 'status'} aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}>
      <StatusStrip
        tone={notice.tone ?? 'error'}
        actionBelow={narrow}
        action={hasButtons ? (
          <span className={`flex items-center gap-1.5 ${narrow ? 'w-full' : 'shrink-0'}`}>
            {onDismiss && <Button variant="secondary" size="sm" className={narrow ? 'flex-1' : undefined} onClick={onDismiss}>Dismiss</Button>}
            {notice.retry && <Button variant="primary" size="sm" className={narrow ? 'flex-1' : undefined} onClick={notice.retry}>Try again</Button>}
          </span>
        ) : undefined}
      >
        {notice.text}
      </StatusStrip>
    </div>
  );
}
