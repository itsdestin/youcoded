// Decision function for the App-level ESC-to-PTY passthrough.
// Extracted as a pure function so it's unit-testable without mounting App.
//
// Three guards, all must pass:
//   1. defaultPrevented: the EscCloseProvider sets this when an overlay consumed ESC,
//      so we don't both close the overlay AND interrupt Claude.
//   2. viewMode === 'chat': in terminal view, xterm already forwards ESC
//      natively to node-pty. Running our handler too would double-send.
//   3. hasActiveSession: nothing to send to otherwise.
//
// Note: BuddyChat is not a concern here. It renders in a separate window
// (buddyMode === 'buddy-chat' in App.tsx) with its own React root and its
// own `window` object, so its ESC handler cannot collide with the main
// window's listener.
export function shouldForwardEscToPty(params: {
  defaultPrevented: boolean;
  viewMode: 'chat' | 'terminal';
  hasActiveSession: boolean;
}): boolean {
  return !params.defaultPrevented
    && params.viewMode === 'chat'
    && params.hasActiveSession;
}
