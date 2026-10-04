export interface Rect { x: number; y: number; width: number; height: number; }
export interface Point { x: number; y: number; }
export interface Size { width: number; height: number; }

/**
 * Clamp a position so the window stays fully inside the workArea.
 * Pure function — no electron deps — so it's unit-testable.
 */
export function clampToWorkArea(pos: Point, size: Size, workArea: Rect): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.max(workArea.x, Math.min(pos.x, maxX)),
    y: Math.max(workArea.y, Math.min(pos.y, maxY)),
  };
}

// Every buddy window's size lives here, and main.ts's buddyDimensions imports
// them, so the BrowserWindows and the positioning math can't drift apart.

// Visible action-bar row: three 44×44 buttons + 2 × 8px gaps = 148 wide.
export const BAR_CONTENT: Size = { width: 148, height: 44 };
// The bar WINDOW is padded around that row. The window used to be exactly
// button-height, which was fine while the buttons were inert — but they now
// scale on hover (and overshoot on pop-in), and a button growing past 1.0
// inside a content-sized window clips against the frame (Destin 2026-07-17).
export const BAR_PADDING = 8;
export const BAR_SIZE: Size = {
  width: BAR_CONTENT.width + BAR_PADDING * 2,
  height: BAR_CONTENT.height + BAR_PADDING * 2,
};
export const BAR_GAP_PX = 6;

// 112 (was 80): Destin's 2026-07-16 dev test — the buddy read too small.
export const MASCOT_SIZE: Size = { width: 112, height: 112 };
export const CHAT_SIZE: Size = { width: 320, height: 480 };

/**
 * The mascot ARTWORK's insets inside his window, as fractions of window height.
 *
 * The canonical rig uses viewBox="-3 -5 30 30" but its ink only spans y=0..23:
 * 5 units of headroom above the head (authored so raised-arm poses like welcome
 * and shocked have somewhere to go) and 2 below the feet. At 112px that's 18.7px
 * of nothing above him and 7.5px below.
 *
 * So the window's edges are a poor proxy for where he visually ends — a 6px
 * window gap reads as ~13px below him but ~25px above, nearly double. Gaps are
 * therefore measured to the INK and the per-side window gap is derived
 * (Destin 2026-07-17: "the mascot/buttons should be slightly closer to the chat
 * window when below it").
 */
const MASCOT_INK_TOP_INSET = 5 / 30;
const MASCOT_INK_BOTTOM_INSET = 2 / 30;

/**
 * Gap between the chat panel and the mascot's ARTWORK — NOT his window edge.
 * 13 reproduces the old 6px window gap on the below-the-mascot side (6 + 7.5px
 * of foot padding), which Destin was happy with; the above side now matches it
 * instead of gaping.
 */
export const CHAT_GAP_PX = 13;

/**
 * The mascot's visible artwork rect. Vertical only — the horizontal insets
 * exist too (~4px each side) but nothing needs them, and leaving the full width
 * keeps the "chat never covers him" check conservative.
 */
export function mascotInkRect(mascotBounds: Rect): Rect {
  const top = Math.round(mascotBounds.height * MASCOT_INK_TOP_INSET);
  const bottom = Math.round(mascotBounds.height * MASCOT_INK_BOTTOM_INSET);
  return {
    x: mascotBounds.x,
    y: mascotBounds.y + top,
    width: mascotBounds.width,
    height: mascotBounds.height - top - bottom,
  };
}

/**
 * Where the rig's hands sit, as a fraction of the mascot window's height.
 *
 * The canonical capsule rig (wecoded-themes/mascots/README.md) uses
 * viewBox="-3 -5 30 30" and draws arms hanging from y=9 to y=13; POSES.idle
 * drops them a further 0.5, so the mitten spans y≈11.5..13.5 and centres at
 * ≈12.5 — which is (12.5 + 5) / 30 ≈ 0.583 of the window height, a little
 * below the mascot's midline. Destin wants the action bar's row lined up with
 * the hands rather than the midline (2026-07-17).
 */
const HANDS_CENTER_FRACTION = 0.583;

/** Chat's horizontal nudge off the group's true centre — Destin's eye, 2026-07-16. */
const CHAT_NUDGE_X = 10;

/**
 * The VISIBLE button row's rect — ALWAYS to the mascot's right, vertically
 * centred on his hands. The bar window sits BAR_PADDING outside this on every
 * side; positioning math works in content space so the padding can change
 * without moving the buttons.
 *
 * WHY no left/right flip any more (Destin 2026-07-17): the bar only exists
 * while the chat is open (buddy-bar-visibility.ts), and an open chat pins the
 * mascot to an x where the chat itself fits on screen — see
 * mascotXRangeForChat. The chat reaches 303px right of the mascot and the bar
 * window only 274px, so wherever the chat fits, the bar already does. The flip
 * was unreachable code that could only make the bar jump for no reason.
 *
 * Pure — unit-tested.
 */
export function computeBarContentRect(mascotBounds: Rect): Rect {
  const handsY = mascotBounds.y + Math.round(mascotBounds.height * HANDS_CENTER_FRACTION);
  return {
    x: mascotBounds.x + mascotBounds.width + BAR_GAP_PX,
    y: handsY - Math.round(BAR_CONTENT.height / 2),
    width: BAR_CONTENT.width,
    height: BAR_CONTENT.height,
  };
}

/**
 * How far the chat's left edge sits from the mascot's, in px. Constant (−17
 * with today's sizes): the chat is centred on the mascot+bar span and nudged
 * CHAT_NUDGE_X right, and nothing in that depends on the mascot's position, so
 * the pair are horizontally RIGID — the mascot sits at the chat's left-hand
 * side and stays there.
 */
export function chatOffsetX(mascotBounds: Rect): number {
  const bar = computeBarContentRect(mascotBounds);
  const groupLeft = Math.min(mascotBounds.x, bar.x);
  const groupRight = Math.max(mascotBounds.x + mascotBounds.width, bar.x + bar.width);
  const chatX = Math.round((groupLeft + groupRight) / 2) - Math.round(CHAT_SIZE.width / 2) + CHAT_NUDGE_X;
  return chatX - mascotBounds.x;
}

/**
 * The mascot-x range that keeps the CHAT fully on screen.
 *
 * Because the pair are horizontally rigid, "keep the chat on screen" is a
 * constraint on the MASCOT: he stops when the chat's right edge reaches the
 * workArea's right edge rather than sliding out from under it (Destin
 * 2026-07-17). BuddyWindowManager applies this while dragging, so the buddy
 * simply stops; the vertical axis is NOT constrained this way — the chat is
 * 480 tall against an 852 workArea, so pinning y would shrink the draggable
 * area to a sliver. Vertical is handled by the tier-3 bounce in
 * computeGroupLayout instead, at drag-release.
 */
export function mascotXRangeForChat(mascotBounds: Rect, workArea: Rect): { min: number; max: number } {
  const dx = chatOffsetX(mascotBounds);
  const min = workArea.x - dx;
  const max = workArea.x + workArea.width - CHAT_SIZE.width - dx;
  // max < min only if the workArea is narrower than the chat — pin to min.
  return { min, max: Math.max(min, max) };
}

/** Bar WINDOW position (the content rect grown by BAR_PADDING), clamped. */
export function computeBarPosition(mascotBounds: Rect, workArea: Rect): Point {
  const c = computeBarContentRect(mascotBounds);
  return clampToWorkArea({ x: c.x - BAR_PADDING, y: c.y - BAR_PADDING }, BAR_SIZE, workArea);
}

export interface GroupLayout {
  /** Where the mascot should sit — usually unchanged, but see the squash tier. */
  mascot: Point;
  /** Where the chat should sit relative to that mascot position. */
  chat: Point;
}

/**
 * Lay out the buddy group (mascot + chat) for a given mascot rect. The pair are
 * RIGID: the chat's position follows from the mascot's, so whenever the chat
 * would leave the screen it's the MASCOT that gives way, never the offset.
 *
 * Horizontally the mascot is simply pinned to mascotXRangeForChat.
 *
 * Vertically:
 *   1. Chat BELOW the mascot+bar group, centred on the group's visible span.
 *   2. Chat ABOVE, when it won't fit below. The horizontal relationship is
 *      pinned — above/below is the only flip (Destin 2026-07-16).
 *   3. SQUASHED: when neither fits, bounce the chat away from whichever edge
 *      the mascot is nearest, pin it fully on-screen, and PUSH THE MASCOT back
 *      to the pinned CHAT_GAP_PX so the two stay a rigid unit (Destin 2026-07-17).
 *
 * Tier 3 exists because the group needs CHAT_SIZE.height + CHAT_GAP_PX +
 * mascot height = 598px of vertical room. Below only fits when mascot.y ≤
 * waH−598; above only fits when mascot.y ≥ 486. When waH−598 < 486 every
 * position between is homeless — Destin's 1440×852 (a 2880×1800 panel at 200%
 * scale) leaves a 232px band straight through the middle of the screen.
 *
 * The original code had no tier 3 and simply clamped the chat on-screen, which
 * parked a 480-tall panel over the mascot and made him unclickable. A first fix
 * put the chat BESIDE the mascot there, but that broke the pinned horizontal
 * relationship; moving the mascot instead keeps the group rigid, which is what
 * the pinning was for. The chat is the thing that can't move freely (it's big
 * and must stay readable); the mascot is small and cheap to nudge.
 *
 * The tier-3 result is a FIXED POINT: feeding the returned mascot position back
 * in yields the same layout with no further correction, so callers can apply it
 * without oscillating.
 *
 * Pure — unit-tested, including "the chat never covers the mascot".
 */
export function computeGroupLayout(mascotBounds: Rect, workArea: Rect): GroupLayout {
  // Horizontal: pin the MASCOT so the chat lands on screen, keeping the rigid
  // offset intact rather than sliding the chat relative to him.
  const dx = chatOffsetX(mascotBounds);
  const range = mascotXRangeForChat(mascotBounds, workArea);
  const mascotX = Math.round(Math.max(range.min, Math.min(mascotBounds.x, range.max)));
  const x = mascotX + dx;
  const mascot: Point = { x: mascotX, y: mascotBounds.y };

  // Window-edge gaps derived per side so the gap to his ARTWORK is CHAT_GAP_PX
  // both above and below him. gapAbove goes NEGATIVE (his headroom is ~19px of
  // nothing), i.e. the chat's bottom edge slides over the mascot window's
  // transparent top strip. That's safe on both counts: the mascot renders above
  // the chat (BuddyWindowManager.raiseSatellites), and BuddyChat's root carries
  // 12px of bottom padding, so nothing interactive lives in the overlapped strip.
  const gapBelow = CHAT_GAP_PX - Math.round(mascotBounds.height * MASCOT_INK_BOTTOM_INSET);
  const gapAbove = CHAT_GAP_PX - Math.round(mascotBounds.height * MASCOT_INK_TOP_INSET);

  const belowY = mascotBounds.y + mascotBounds.height + gapBelow;
  if (belowY + CHAT_SIZE.height <= workArea.y + workArea.height) {
    return { mascot, chat: { x, y: belowY } };
  }
  const aboveY = mascotBounds.y - CHAT_SIZE.height - gapAbove;
  if (aboveY >= workArea.y) {
    return { mascot, chat: { x, y: aboveY } };
  }

  // Tier 3. Bounce away from the nearer edge: a mascot low on the screen sends
  // the chat up, a mascot high on the screen sends it down. That also happens to
  // be the choice that moves the mascot the shortest distance.
  const roomAbove = mascotBounds.y - workArea.y;
  const roomBelow = workArea.y + workArea.height - (mascotBounds.y + mascotBounds.height);
  const chatGoesAbove = roomAbove >= roomBelow;
  const chatY = chatGoesAbove ? workArea.y : workArea.y + workArea.height - CHAT_SIZE.height;
  const mascotY = chatGoesAbove
    ? chatY + CHAT_SIZE.height + gapAbove
    : chatY - gapBelow - mascotBounds.height;
  const mascotSize: Size = { width: mascotBounds.width, height: mascotBounds.height };
  return {
    mascot: clampToWorkArea({ x: mascotX, y: mascotY }, mascotSize, workArea),
    chat: { x, y: chatY },
  };
}

/** Breathing room between the taskbar-style chat and the screen edge. */
const TRAY_EDGE_GAP_PX = 8;

/**
 * Where the chat and its button row go when the buddy is a TASKBAR ICON
 * instead of a floating mascot (the "taskbar icon" buddy style).
 *
 * WHY its own layout and not computeGroupLayout with a pretend mascot: that
 * layout reserves a 112px hole for the mascot and hangs the button row off his
 * hands, so with no mascot drawn the buttons would float beside empty space.
 * Here the chat sits against the bar the icon lives in, horizontally centred
 * on the icon, with the button row tucked directly under the chat.
 *
 * `icon` is where the OS says the icon is — null where it won't say (Linux),
 * which falls back to the bottom-right corner, where most Linux panels keep
 * their tray. An icon in the top half of the screen (the macOS menu bar, a
 * top panel) puts the chat at the top; anything else at the bottom.
 *
 * Pure — unit-tested.
 */
export function computeTrayLayout(icon: Rect | null, workArea: Rect): { chat: Point; bar: Point } {
  const groupHeight = CHAT_SIZE.height + BAR_SIZE.height;
  const atTop = !!icon && icon.y + icon.height / 2 < workArea.y + workArea.height / 2;
  const centreX = icon
    ? icon.x + icon.width / 2
    : workArea.x + workArea.width - TRAY_EDGE_GAP_PX - CHAT_SIZE.width / 2;
  const chatY = atTop
    ? workArea.y + TRAY_EDGE_GAP_PX
    : workArea.y + workArea.height - TRAY_EDGE_GAP_PX - groupHeight;
  const chat = clampToWorkArea(
    { x: Math.round(centreX - CHAT_SIZE.width / 2), y: Math.round(chatY) },
    CHAT_SIZE,
    workArea,
  );
  const bar = clampToWorkArea(
    { x: chat.x + Math.round((CHAT_SIZE.width - BAR_SIZE.width) / 2), y: chat.y + CHAT_SIZE.height },
    BAR_SIZE,
    workArea,
  );
  return { chat, bar };
}
