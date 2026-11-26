// ScreenNotice — a notice that lives ON the screen that raised it (Destin, waiting-notice deck R-screen).
//
// WHY: the "resume a chat" list and the screen for moving a chat between devices are not part of whichever chat happens to be open
// behind them, so a failure raised there must not show in that chat's strip (or float over something unrelated). It is the same
// thin band as the chat strip, with the same button order (Dismiss outlined on the left, the main action filled on the right).
import { NoticeBand } from './NoticeBand';

export interface ScreenNoticeData {
  text: string;
  tone?: 'warn' | 'error';
  /** The screen's own retry, drawn filled and rightmost. Absent = sentence only. */
  retry?: () => void;
}

export function ScreenNotice({ notice, onDismiss, className }: { notice: ScreenNoticeData; onDismiss?: () => void; className?: string }) {
  return (
    <NoticeBand
      className={className}
      tone={notice.tone ?? 'error'}
      text={notice.text}
      onDismiss={onDismiss}
      actions={notice.retry ? [{ label: 'Try again', primary: true, onClick: notice.retry }] : undefined}
    />
  );
}
