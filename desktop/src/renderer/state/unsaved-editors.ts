// Which non-Office editors in this window have unsaved edits (a text file open for editing in
// the file viewer). Main reads it through `office:other-unsaved` before a quit tears anything
// down (Task 6 fix round 9).
//
// WHY main has to know up front: such an editor vetoes its window's unload (ActiveArtifactView's
// beforeunload guard) — rightly — but a quit only meets that veto AFTER teardown, when every
// chat session has already been stopped and the quit can neither finish nor be undone. So each
// dirty editor holds a mark here, the window tells main whenever "any unsaved?" changes, and
// the quit gate refuses to start teardown while any window says yes.
const holders = new Set<symbol>();
let reported = false;

function report(): void {
  const now = holders.size > 0;
  if (now === reported) return;
  reported = now;
  window.claude?.office?.setOtherUnsaved?.(now);
}

/** A dirty editor holds this until it is clean again (or goes away): call the returned release. */
export function holdUnsavedEditor(): () => void {
  const key = Symbol('unsaved-editor');
  holders.add(key);
  report();
  return () => { holders.delete(key); report(); };
}
