// Task 12 follow-up 1: when this window received a plan view's warm minimum.
//
// WHY: main says how long the smaller "warm" Add budget minimum still holds
// (`warmMinimum.forMs`), measured from when it sent the view. Comparing main's
// clock with this device's would let a phone whose clock is off show the wrong
// number, so the countdown starts from THIS window's own receipt time. The
// stamp is kept beside the view object (not in chat state), so the reducer's
// state stays exactly the view main sent.
import type { PlanView } from '../../shared/types';

type WarmMinimum = NonNullable<NonNullable<PlanView['paused']>['warmMinimum']>;

const received = new WeakMap<WarmMinimum, number>();

/** Called where a view enters chat state (PLAN_CHANGED). Idempotent. */
export function markPlanReceived(plan: PlanView): void {
  const warm = plan.paused?.warmMinimum;
  if (warm && !received.has(warm)) received.set(warm, Date.now());
}

/** When `warm` expires on this device. A view that reached the card without
 *  passing the reducer is stamped the first time it is read. */
export function warmMinimumExpiresAt(warm: WarmMinimum): number {
  let at = received.get(warm);
  if (at === undefined) {
    at = Date.now();
    received.set(warm, at);
  }
  return at + warm.forMs;
}
