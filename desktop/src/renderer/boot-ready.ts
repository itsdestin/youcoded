// The page tells the Android app it shows something real (card #213, 2026-11-02): MainActivity keeps its brand loading
// screen over the page until `window.__ycBootReady` is true (polled), so a first launch shows one loading screen
// instead of five different ones. Set by App once its first-run check is done, and by the sign-in/trouble screens of
// remote-gate.tsx. Harmless on the computer and in a phone browser, where nothing reads it.
export function markBootReady(): void {
  (window as unknown as { __ycBootReady?: boolean }).__ycBootReady = true;
}
