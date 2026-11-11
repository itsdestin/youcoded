// How far a chat's messages slide while the Android keyboard glides (card #213). The messages ride up by transform
// during the glide, then the scroller is shortened by the keyboard's height and re-pinned to the bottom; the slide must
// equal what that re-pin will scroll, or the messages jump at the hand-over.
//
// WHY its own function (Destin, 2026-11-02: "you didnt fix the banner. its still jumping"): the first version read the
// height of everything from the scroller's scrollHeight, which reports the VISIBLE height when the conversation is
// shorter than the window — so an empty chat slid up the keyboard's full height, then dropped back.

/** The scroller as the glide began: `contentHeight` is the real height of everything in it (messages + its padding),
 *  `visibleHeight` its height on screen, `scrollTop` its position. `lift` is how far the keyboard has risen so far. */
export function keyboardContentLift(
  start: { contentHeight: number; visibleHeight: number; scrollTop: number },
  lift: number,
): number {
  // After the re-pin, the scroller is `lift` shorter and sits at its bottom (or at 0 when it no longer overflows).
  const pinnedTop = Math.max(0, start.contentHeight - (start.visibleHeight - lift));
  return pinnedTop - start.scrollTop;
}
