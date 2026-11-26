// NoticeBand — the one thin band a notice is drawn in: the words, then Dismiss (outlined, leftmost), then the notice's own buttons
// (outlined ones first, the filled main one last and rightmost).
//
// WHY one component (code-review consolidation): the chat's strip (ChatNoticeStrip) and the notice on the resume / handoff screens
// (ScreenNotice) drew the same band with the same button order in two near-identical copies, which had started to drift. Both now
// call this, so the band, the narrow-screen layout and the screen-reader roles can only change in one place.
import type { ReactNode } from 'react';
import { StatusStrip } from './ui/StatusStrip';
import { Button } from './ui/Button';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';

export interface NoticeBandAction {
  label: string;
  onClick: () => void;
  /** The one filled button, drawn last (rightmost). */
  primary?: boolean;
}

export function NoticeBand({ tone, text, onDismiss, actions = [], className, mark }: {
  tone: 'warn' | 'error';
  text: ReactNode;
  /** Absent = no Dismiss button (a screen that has no way to close its notice). */
  onDismiss?: () => void;
  actions?: NoticeBandAction[];
  /** Classes for the wrapping element (each place the band sits has its own spacing). */
  className?: string;
  /** Anything drawn inside the wrapper before the band (the screen-picture marker). */
  mark?: ReactNode;
}) {
  // WHY (R-phone): on a phone the buttons sit on their own full-width line under the words, as the design guide
  // says for buttons that cannot share the line; beside the words they squeezed the sentence onto two lines.
  const narrow = useNarrowViewport();
  const isError = tone === 'error';
  const hasButtons = !!onDismiss || actions.length > 0;
  // Outlined ones first, the filled main one last, whatever order the caller listed them in.
  const ordered = [...actions.filter((a) => !a.primary), ...actions.filter((a) => a.primary)];
  return (
    // Error notices announce themselves to screen readers at once (C1); the rest wait their turn.
    <div className={className} role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'}>
      {mark}
      <StatusStrip
        tone={tone}
        actionBelow={narrow}
        action={hasButtons ? (
          <span className={`flex items-center gap-1.5 ${narrow ? 'w-full' : 'shrink-0'}`}>
            {onDismiss && <Button variant="secondary" size="sm" className={narrow ? 'flex-1' : undefined} onClick={onDismiss}>Dismiss</Button>}
            {ordered.map((a) => (
              <Button key={a.label} variant={a.primary ? 'primary' : 'secondary'} size="sm" className={narrow ? 'flex-1' : undefined} onClick={a.onClick}>{a.label}</Button>
            ))}
          </span>
        ) : undefined}
      >
        {text}
      </StatusStrip>
    </div>
  );
}
