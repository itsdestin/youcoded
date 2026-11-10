// device.ts: ONE place that answers "what kind of device is this screen?".
//
// WHY (Destin, 2026-11-09 final review, S-4 and "fix this all"): about fifteen places asked "is this a phone?" in
// their own way (the app kind, the window width, the pointer, a style rule keyed on the page's label), and they
// disagreed. Two accidents came from it: a hidden terminal on the COMPUTER app started resizing its session (a phone
// fix with one check missing), and a MOUSE laptop reaching a computer through a web browser has drawn the phone's
// terminal (message box, key row, scroll arrows) since April while still accepting typing straight into the terminal.
// The history, with pictures: youcoded-dev docs/active/design/2026-11-09-phone-final-review/terminal-by-device.html
//
// Four facts, each read at CALL time (the app kind and connection are only known after the backend says hello):
//   phone app      inPhoneApp(), below
//   narrow window  under 640px wide: hooks/use-narrow-viewport.ts
//   touch          fingers, not a mouse, are the main way in: utils/touch-input.ts prefersTouchInput()
//   local          the assistant runs on THIS device: platform.ts isRemoteMode()
// The last three keep their existing home until their callers move here (an unused copy fails the dead-code check).
// "Can this screen do X?" stays shared/capabilities.ts; these are look-and-feel only.
import { getPlatform } from './platform';
import { prefersTouchInput } from './utils/touch-input';
import { NARROW_VIEWPORT_QUERY } from './hooks/use-narrow-viewport';

export function inPhoneApp(): boolean {
  return getPlatform() === 'android';
}

/** One pane at a time (a list, then the thing picked from it) instead of two side by side?
 *  Yes in a narrow window, and always in the phone app: a foldable's inner screen is wider than 640px, so width
 *  alone left a squeezed two-pane layout on a phone (2026-11-01 phone test). Pass the caller's own
 *  useNarrowViewport() reading so the screen re-draws when the window is resized. */
export function onePaneLayout(narrow: boolean): boolean {
  return narrow || inPhoneApp();
}

/** Should buttons and rows be finger-sized (taller, easier to tap)?
 *
 *  Yes on a touch screen, and in a narrow window on a computer. WHY (Destin's final-review answers: narrow computer
 *  windows get the phone's "spacing yes, rest no"; touch-and-narrow): this used to ask "is this the Android app?",
 *  so a phone's web browser on remote access, a tablet and a narrow computer window got mouse-sized buttons.
 *  Read at draw time, not subscribed: these are answer cards and chips that redraw often. */
export function fingerSized(): boolean {
  if (prefersTouchInput()) return true;
  try { return typeof window !== 'undefined' && !!window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches; } catch { return false; }
}

/** Does terminal view use the phone layout: a message box and key row under a terminal that is only looked at?
 *
 *  Yes for the phone app and a touch browser (phone, tablet); no for the computer app AND a mouse laptop's browser.
 *  WHY the laptop changed (Destin, 2026-11-10, "yeah computer makes more sense"): since 2026-04 the rule was "anything
 *  but the computer app", which gave a mouse laptop on remote access the phone's message box, key row and scroll arrows
 *  stretched across a big screen while its terminal still took typing: two ways to type. Nobody chose that.
 *  The page learns which browser it is from the handshake (platform.ts platformAfterHandshake): touch → 'browser',
 *  mouse → the computer's answer ('desktop'). */
export function phoneTerminalLayout(): boolean {
  const p = getPlatform();
  return p === 'android' || p === 'browser';
}

/** Tell the style sheets which terminal layout this is: <html data-term-layout="phone|computer">.
 *  WHY its own label: the style rules used to key on data-platform, which is written once at page load, before a
 *  browser knows what it is. Called here at load and again by remote-shim once the handshake has answered. */
export function markTerminalLayout(): void {
  if (typeof document === 'undefined' || !document.documentElement?.dataset) return;
  document.documentElement.dataset.termLayout = phoneTerminalLayout() ? 'phone' : 'computer';
}
markTerminalLayout();
