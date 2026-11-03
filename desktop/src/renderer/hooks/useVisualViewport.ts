import { useEffect } from 'react';

// The on-screen keyboard's height, for the page. Writes two variables on <html> (see the comment in the hook):
// --vvp-offset (the keyboard while it types into the chat's message box; globals.css lifts the message box with a
// transform and pads the chat by it) and --kb-offset (any keyboard; popups and menus keep clear of it).
//
// Where the height comes from: a phone browser over remote access reports it through visualViewport
// (index.html's interactive-widget=resizes-visual), a frame at a time. The Android app does not resize its WebView for
// the keyboard (MainActivity, card #213 — resizing redrew the whole page every frame) and sends the keyboard's final
// height once through window.__ycImeOffset; the page glides there itself.
//
// Desktop is unaffected: visualViewport.height === innerHeight and nothing calls __ycImeOffset, so both stay 0.
/** Fired on window each time --vvp-offset changes (the keyboard opened, closed or resized). */
export const KEYBOARD_OFFSET_EVENT = 'youcoded:keyboard-offset';

/** The Android keyboard's slide: ~340 ms measured on a Galaxy Z Flip7; Android's keyboard curve (fast start, gentle stop). */
const IME_GLIDE_MS = 300;
/** cubic-bezier(0.2, 0, 0, 1) at progress t (0-1): x(u) is solved for u by bisection, then y(u). */
function imeEase(t: number): number {
  const bez = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 20; i++) { u = (lo + hi) / 2; if (bez(0.2, 0, u) < t) lo = u; else hi = u; }
  return bez(0, 1, u);
}

export function useVisualViewport() {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    let frame: number | null = null;
    // The Android app's keyboard (MainActivity → window.__ycImeOffset), in CSS px. The app does not resize the page for
    // the keyboard (that redrew everything every frame), and a WebView whose size does not change reports no keyboard
    // through visualViewport, so the app sends the keyboard's FINAL height once, as it starts to slide. A phone browser
    // over remote access never calls this and keeps following visualViewport.
    //
    // WHY the page animates the value itself (Destin, 2026-11-02): when the app sent the height every frame it arrived
    // unevenly ("stuttery/flickery"); when the message box glided on its own transition while everything else jumped,
    // "the bottom edge of the frame jumps up, then the chips/input bar … slide up after" ("detached and janky"). Here
    // --vvp-offset itself moves from where it is to the target on the page's own frame clock, with the keyboard's
    // timing, so the frame's edge, the message box, the messages and the empty-chat hint move in the same frame.
    // Two values, because not every keyboard is for the chat (Destin, 2026-11-02: "when the command drawer is up and i
    // tap in its input area, i can see the chat input area slide up behind it"):
    //   --kb-offset  — the keyboard, whatever it types into: popups, the session menu and the file editor keep clear of it.
    //   --vvp-offset — the keyboard only while it types into the chat's own message box (.bottom-float); the chat's
    //                  frame edge, message box, messages and empty-chat hint follow this one, and stay put otherwise.
    type Glide = { from: number; to: number; start: number; cur: number };
    const kb: Glide = { from: 0, to: 0, start: 0, cur: 0 };
    const chat: Glide = { from: 0, to: 0, start: 0, cur: 0 };
    let nativeTo = 0;
    let native = false;
    let lastKb = -1;
    let lastChat = -1;
    const w = window as unknown as { __ycImeOffset?: (px: number) => void };
    const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    w.__ycImeOffset = (px: number) => {
      nativeTo = Number.isFinite(px) ? Math.max(0, px) : 0;
      native = true;
      document.documentElement.dataset.ime = 'native';
      schedule();
    };
    const aim = (g: Glide, to: number, glide: boolean, now: number) => {
      if (to === g.to) return;
      g.from = g.cur; g.to = to; g.start = now;
      if (!glide) g.cur = to;
    };
    // True while the glide is still moving.
    const step = (g: Glide, now: number): boolean => {
      if (g.cur === g.to) return false;
      const t = Math.min(1, (now - g.start) / IME_GLIDE_MS);
      g.cur = t >= 1 ? g.to : g.from + (g.to - g.from) * imeEase(t);
      return t < 1;
    };

    const apply = () => {
      frame = null;
      const now = performance.now();
      // innerHeight is the layout viewport; vv.height is the visible viewport.
      // Their difference equals keyboard + any other overlay chrome the UA is
      // reporting (on Android WebView: essentially just the IME).
      // Math.max guards against negative values during orientation changes.
      const reported = Math.max(0, window.innerHeight - vv.height - vv.offsetTop, nativeTo);
      const forChat = !!document.activeElement?.closest?.('.bottom-float');
      // Only the Android app's keyboard glides; a phone browser already reports it a frame at a time.
      const glide = native && !reduced();
      aim(kb, reported, glide, now);
      aim(chat, forChat ? reported : 0, glide, now);
      const moving = [step(kb, now), step(chat, now)].some(Boolean);
      if (moving) schedule();
      // Clamp sub-pixel jitter — some devices fire values like 398.6 vs 399.0 back-to-back mid-animation. Skip an
      // unchanged value (performance.md rule 6): a root variable write restyles the whole page.
      const k = Math.round(kb.cur);
      if (k !== lastKb) { lastKb = k; document.documentElement.style.setProperty('--kb-offset', `${k}px`); }
      const c = Math.round(chat.cur);
      if (c === lastChat) return;
      lastChat = c;
      document.documentElement.style.setProperty('--vvp-offset', `${c}px`);
      // ChatView keeps the newest message in view above the keyboard (it no longer gets a smaller window to notice).
      window.dispatchEvent(new CustomEvent(KEYBOARD_OFFSET_EVENT));
    };

    const schedule = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    // Typing moves between the chat and something else (a drawer, a popup) while the keyboard stays up.
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      delete w.__ycImeOffset;
      delete document.documentElement.dataset.ime;
      document.documentElement.style.removeProperty('--vvp-offset');
      document.documentElement.style.removeProperty('--kb-offset');
    };
  }, []);
}
