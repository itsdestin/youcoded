// ONE answer to "is this person using a finger, not a mouse and keyboard?".
//
// WHY: several hints said "press Space" / "Click here" on phones (2026-11-01
// phone test). This asks the browser what the PRIMARY pointer is, so a phone says
// yes and a laptop (touchscreen or not: its primary pointer is the trackpad) says
// no. The platform check is a fallback for WebViews that do not report
// `pointer: coarse`. (An older `isTouchDevice()` in platform.ts answered by
// connection kind instead; it is gone since 2026-11-10.)
import { getPlatform } from '../platform';

export function prefersTouchInput(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches) return true;
    }
  } catch { /* matchMedia can throw in odd embeds; fall through */ }
  return getPlatform() === 'android';
}
