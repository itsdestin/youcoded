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
//   inPhoneApp()        this page is the Android app
//   narrow window       under 640px wide: NARROW_VIEWPORT_QUERY / useNarrowViewport (re-exported, not copied)
//   touchFirst()        fingers, not a mouse, are the main way in
//   assistantIsLocal()  the assistant runs on THIS device (false when watching a computer)
// "Can this screen do X?" stays shared/capabilities.ts; these are look-and-feel only.
import { getPlatform } from './platform';

// The other facts keep their one existing home until their callers move here (an unused copy fails the dead-code
// check): narrow window = hooks/use-narrow-viewport.ts, touch-first = utils/touch-input.ts prefersTouchInput(),
// assistant on this device = platform.ts isRemoteMode().
export function inPhoneApp(): boolean {
  return getPlatform() === 'android';
}

/** Does terminal view use the phone layout: a message box and key row under a terminal that is only looked at?
 *
 *  Today: every screen except the computer app's own window. That is the rule the released app has had since
 *  2026-04 (App.tsx isTerminalTouch); it was copied into four places, and this is now the only copy in script
 *  (the two style rules that must agree are pinned by tests/terminal-device-rule.test.ts).
 *  Whether a MOUSE laptop's browser should get the computer terminal instead is Destin's open decision; changing
 *  it is this one line plus those two style rules. */
export function phoneTerminalLayout(): boolean {
  return getPlatform() !== 'electron';
}
