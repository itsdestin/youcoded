// FloatingNotices — draws the app's two floating notice slots (state/floating-notices.ts) and listens for announce().
//
// WHY it listens here and not in App (waiting-notice T3): App used to hold the toast state, so every announcement re-rendered the
// whole app; now only this small component changes.
// WHY one stacked column (review 2, S2): the two slots used to be two separately-positioned toasts that would sit on top of each
// other. Here the routine toast is above and the needs-you notice below, in one box anchored at the usual place, so they can never overlap.
import { useEffect, useSyncExternalStore } from 'react';
import { APP_NOTICE_EVENT, type AppNoticeDetail } from '../utils/announce';
import { closeNeedsYou, getFloatingNotices, showNeedsYou, showRoutineToast, subscribeFloatingNotices } from '../state/floating-notices';
import { Toast } from './ui/Toast';
import { Button } from './ui/Button';
import { CONTENT_Z } from './overlays/Overlay';

/** Routes one announce() into the right slot. */
function routeNotice(d: AppNoticeDetail): void {
  if (!d?.message) return;
  const tone = d.tone;
  if (d.untilClosed) {
    // K-7: no timer; Dismiss on the left, its own button filled on the right. Pressing either closes only THIS notice.
    // The id exists only after showNeedsYou returns, which is before any click can happen.
    let id = 0;
    const action = d.action ? { label: d.action.label, onClick: () => { closeNeedsYou(id); d.action!.onClick(); } } : undefined;
    id = showNeedsYou({ message: d.message, tone, action });
    return;
  }
  // A routine notice with a button closes itself when the button is pressed, like "Send anyway" does.
  const action = d.action ? { label: d.action.label, onClick: () => { showRoutineToast(null); d.action!.onClick(); } } : undefined;
  showRoutineToast(d.durationMs || action || tone ? { message: d.message, durationMs: d.durationMs, action, tone } : d.message);
}

export default function FloatingNotices() {
  const { routine, needsYou } = useSyncExternalStore(subscribeFloatingNotices, getFloatingNotices, getFloatingNotices);
  useEffect(() => {
    const onNotice = (e: Event) => routeNotice((e as CustomEvent<AppNoticeDetail>).detail);
    window.addEventListener(APP_NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(APP_NOTICE_EVENT, onNotice);
  }, []);
  if (!routine && needsYou.length === 0) return null;
  const first = needsYou[0];
  const waiting = needsYou.length - 1;
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none"
      // Same spot the single toast always had (above the message box); the column grows upward from it.
      style={{ bottom: 'var(--toast-clearance, 4rem)', width: 'max-content', maxWidth: 'calc(100vw - 2rem)', zIndex: CONTENT_Z[4] }}
    >
      {routine && (
        <Toast
          key={`quick-${routine.n}`}
          variant="stacked"
          message={routine.message}
          tone={routine.tone}
          durationMs={routine.durationMs}
          onDismiss={() => showRoutineToast(null)}
          action={routine.action ? <Button variant="secondary" size="sm" onClick={routine.action.onClick}>{routine.action.label}</Button> : undefined}
          actions={routine.actions}
          dismissible={!!routine.dismissible}
        />
      )}
      {first && (
        <Toast
          key={`needs-${first.id}`}
          variant="stacked"
          message={first.message}
          tone={first.tone}
          durationMs={null}
          dismissible
          onDismiss={() => closeNeedsYou(first.id)}
          // The count sits with the words so a notice that waits is never invisible: "1 more" means one more is queued behind this.
          footnote={waiting > 0 ? `${waiting} more` : undefined}
          actions={first.action ? [{ ...first.action, primary: true }] : undefined}
        />
      )}
    </div>
  );
}
