import { useEffect } from 'react';
import { createImeRestMemory, type ImeRestMemory } from '../state/ime-rest-memory';
import { aimGlide, stepGlide, newGlide } from '../state/keyboard-glide';
import { createKeyboardLiveLift } from './keyboard-live-lift';

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
    const kb = newGlide();
    const chat = newGlide();
    let nativeTo = 0;
    let native = false;
    let lastKb = -1;
    let lastChat = -1;
    const w = window as unknown as { __ycImeOffset?: (px: number, rest?: boolean) => void };
    const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // WHY a remembered "announced → real" height (Destin, 2026-11-03: the box "overshoots the keyboard sometimes before
    // falling back down"; the phone's log caught it): Samsung's keyboard on a Z Flip7 often announces 284 when it
    // starts to slide and settles at 255 a third of a second later, after the slide. MainActivity now also sends the
    // RESTING height (`rest`); the page corrects to it, and remembers the pair so the next open aims at the real
    // height straight away. If a remembered pair is ever wrong (the keyboard really is that tall this time), the
    // resting height corrects it and the pair is forgotten — the box can never stay under the keyboard.
    let restMemory: ImeRestMemory;
    try { restMemory = createImeRestMemory(window.localStorage); } catch { restMemory = createImeRestMemory(null); }
    w.__ycImeOffset = (px: number, rest?: boolean) => {
      nativeTo = rest ? restMemory.rest(px) : restMemory.announce(px);
      native = true;
      schedule();
    };
    // What moves on the page during a glide and at its end: keyboard-live-lift.ts.
    const live = createKeyboardLiveLift();

    let lastStep = 0;
    const apply = () => {
      frame = null;
      const now = performance.now();
      // An even 60 steps a second while gliding: a 120 Hz frame is 8 ms and an uneven rhythm reads as a stutter.
      if ((kb.cur !== kb.to || chat.cur !== chat.to) && now - lastStep < 14) { schedule(); return; }
      lastStep = now;
      // innerHeight is the layout viewport; vv.height is the visible viewport.
      // Their difference equals keyboard + any other overlay chrome the UA is
      // reporting (on Android WebView: essentially just the IME).
      // Math.max guards against negative values during orientation changes.
      const reported = Math.max(0, window.innerHeight - vv.height - vv.offsetTop, nativeTo);
      const forChat = !!document.activeElement?.closest?.('.bottom-float');
      // Only the Android app's keyboard glides; a phone browser already reports it a frame at a time.
      const glide = native && !reduced();
      // Popups and menus take the keyboard's final height at once: one re-check, not one per step.
      aimGlide(kb, reported, false, now);
      aimGlide(chat, forChat ? reported : 0, glide, now);
      stepGlide(kb, now);
      const moving = stepGlide(chat, now);
      const k = Math.round(kb.cur);
      if (k !== lastKb) { lastKb = k; document.documentElement.style.setProperty('--kb-offset', `${k}px`); }
      // Clamp sub-pixel jitter — some devices fire values like 398.6 vs 399.0 back-to-back mid-animation.
      const c = Math.round(chat.cur);
      if (moving) { schedule(); live.show(c); return; }
      if (c === lastChat && !live.gliding()) return;
      lastChat = c;
      live.settle(c);
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
      document.documentElement.style.removeProperty('--vvp-offset');
      document.documentElement.style.removeProperty('--kb-offset');
    };
  }, []);
}
