import { describe, it, expect } from 'vitest';
import {
  BAR_CONTENT, BAR_PADDING, BAR_GAP_PX, BAR_SIZE, CHAT_SIZE, CHAT_GAP_PX, MASCOT_SIZE,
  computeBarContentRect, computeBarPosition, computeGroupLayout, chatOffsetX,
  mascotXRangeForChat, mascotInkRect, computeTrayLayout,
} from '../src/main/buddy-bar-geometry';

const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const mascot = (x: number, y: number) => ({ x, y, width: 112, height: 112 });

/** Destin's actual workspace: a 2880×1800 panel at 200% scale, minus taskbar.
 *  Short enough that the chat cannot always fit above or below the mascot. */
const SHORT_WA = { x: 0, y: 0, width: 1440, height: 852 };

const rectsOverlap = (
  a: { x: number; y: number }, aSize: { width: number; height: number },
  b: { x: number; y: number }, bSize: { width: number; height: number },
) => a.x < b.x + bSize.width && a.x + aSize.width > b.x
  && a.y < b.y + bSize.height && a.y + aSize.height > b.y;

describe('computeBarContentRect', () => {
  it('sits to the right of the mascot, centered on his hands (not his midline)', () => {
    const r = computeBarContentRect(mascot(500, 300));
    expect(r.x).toBe(500 + 112 + BAR_GAP_PX);
    // Hands sit at 58.3% of the mascot's height, below the 50% midline.
    const handsY = 300 + Math.round(112 * 0.583);
    expect(r.y).toBe(handsY - BAR_CONTENT.height / 2);
    expect(handsY).toBeGreaterThan(300 + 56); // strictly below center
  });

  it('never flips sides — it is always to the mascot\'s right', () => {
    // Destin 2026-07-17: the bar only exists alongside an open chat, and an
    // open chat pins the mascot where the chat (which reaches further right
    // than the bar) fits. So the flip was unreachable and only added jump.
    for (const x of [0, 500, 1820, 5000]) {
      expect(computeBarContentRect(mascot(x, 300)).x).toBe(x + 112 + BAR_GAP_PX);
    }
  });

  it('always fits on screen wherever an open chat allows the mascot to be', () => {
    const range = mascotXRangeForChat(mascot(0, 300), SHORT_WA);
    for (let x = range.min; x <= range.max; x += 1) {
      const bar = computeBarContentRect(mascot(x, 300));
      expect(bar.x - BAR_PADDING).toBeGreaterThanOrEqual(SHORT_WA.x);
      expect(bar.x + bar.width + BAR_PADDING).toBeLessThanOrEqual(SHORT_WA.x + SHORT_WA.width);
    }
  });
});

describe('computeBarPosition', () => {
  it('is the content rect grown by BAR_PADDING', () => {
    const c = computeBarContentRect(mascot(500, 300));
    expect(computeBarPosition(mascot(500, 300), wa)).toEqual({
      x: c.x - BAR_PADDING,
      y: c.y - BAR_PADDING,
    });
  });

  it('clamps the window (not just the row) at the top edge', () => {
    expect(computeBarPosition(mascot(500, -40), wa).y).toBe(0);
  });

  it('window size accounts for the padding on both sides', () => {
    expect(BAR_SIZE.width).toBe(BAR_CONTENT.width + BAR_PADDING * 2);
    expect(BAR_SIZE.height).toBe(BAR_CONTENT.height + BAR_PADDING * 2);
  });
});

describe('mascotXRangeForChat', () => {
  it('stops the mascot exactly where the chat\'s right edge meets the screen', () => {
    const range = mascotXRangeForChat(mascot(0, 300), SHORT_WA);
    const dx = chatOffsetX(mascot(0, 300));
    // At max, the chat's right edge is flush with the workArea's right edge.
    expect(range.max + dx + CHAT_SIZE.width).toBe(SHORT_WA.x + SHORT_WA.width);
    // At min, the chat's left edge is flush with the workArea's left edge.
    expect(range.min + dx).toBe(SHORT_WA.x);
  });

  it('the mascot sits at the chat\'s left-hand side', () => {
    const dx = chatOffsetX(mascot(700, 300));
    // Chat starts slightly left of the mascot and extends well past his right.
    expect(dx).toBeLessThan(0);
    expect(dx + CHAT_SIZE.width).toBeGreaterThan(MASCOT_SIZE.width);
  });

  it('does not depend on the mascot position (the pair are rigid)', () => {
    expect(chatOffsetX(mascot(0, 0))).toBe(chatOffsetX(mascot(1234, 567)));
  });
});

/** Gap between the chat and the mascot's ARTWORK, which is what the eye reads. */
const inkGap = (l: { mascot: { x: number; y: number }; chat: { x: number; y: number } }) => {
  const ink = mascotInkRect({ ...l.mascot, ...MASCOT_SIZE });
  return l.chat.y > l.mascot.y
    ? l.chat.y - (ink.y + ink.height)          // chat below him
    : ink.y - (l.chat.y + CHAT_SIZE.height);   // chat above him
};

describe('computeGroupLayout', () => {
  it('hangs the chat below the mascot when there is room, leaving him put', () => {
    const l = computeGroupLayout(mascot(600, 100), wa);
    expect(l.mascot).toEqual({ x: 600, y: 100 });
    expect(inkGap(l)).toBe(CHAT_GAP_PX);
    // Unchanged from the window-gap era Destin was happy with: 13 - 7px of
    // foot padding = the old 6px window gap.
    expect(l.chat.y).toBe(100 + 112 + 6);
  });

  it('flips the chat above when it would not fit below, leaving him put', () => {
    const l = computeGroupLayout(mascot(600, 900), wa);
    expect(l.mascot).toEqual({ x: 600, y: 900 });
    expect(inkGap(l)).toBe(CHAT_GAP_PX);
  });

  // Destin 2026-07-17: the gap looked ~2x wider above him than below, because
  // the rig's viewBox carries 5 units of headroom and only 2 of footroom.
  it('reads the same distance from his artwork above and below', () => {
    const below = computeGroupLayout(mascot(600, 100), wa);
    const above = computeGroupLayout(mascot(600, 900), wa);
    expect(inkGap(below)).toBe(inkGap(above));
  });

  it('lets the chat overlap only his transparent headroom, never his ink', () => {
    const above = computeGroupLayout(mascot(600, 900), wa);
    const ink = mascotInkRect({ ...above.mascot, ...MASCOT_SIZE });
    // Chat's bottom edge crosses the window's top edge...
    expect(above.chat.y + CHAT_SIZE.height).toBeGreaterThan(above.mascot.y);
    // ...but stops well short of his actual head.
    expect(above.chat.y + CHAT_SIZE.height).toBeLessThan(ink.y);
  });

  // The 2026-07-16 regression: on Destin's short workArea the mascot sat at
  // y=370, where neither slot fits. Clamping put the chat at y=0 — right on top
  // of a mascot spanning 370..482 — so the buddy could not be clicked to close
  // the chat he had just opened.
  it('never lets the chat cover the mascot, anywhere on a short workArea', () => {
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 1) {
      const l = computeGroupLayout(mascot(700, y), SHORT_WA);
      const ink = mascotInkRect({ ...l.mascot, ...MASCOT_SIZE });
      expect(
        rectsOverlap(l.chat, CHAT_SIZE, ink, ink),
        `mascot y=${y} → mascot ${l.mascot.y}, chat ${l.chat.y}`,
      ).toBe(false);
    }
  });

  it('keeps both windows fully on screen, anywhere on a short workArea', () => {
    const inside = (p: { x: number; y: number }, s: { width: number; height: number }) =>
      p.x >= SHORT_WA.x && p.y >= SHORT_WA.y
      && p.x + s.width <= SHORT_WA.x + SHORT_WA.width
      && p.y + s.height <= SHORT_WA.y + SHORT_WA.height;
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 1) {
      const l = computeGroupLayout(mascot(700, y), SHORT_WA);
      expect(inside(l.chat, CHAT_SIZE), `chat, mascot y=${y}`).toBe(true);
      expect(inside(l.mascot, MASCOT_SIZE), `mascot, mascot y=${y}`).toBe(true);
    }
  });

  it('holds the pinned gap exactly when it has to push the mascot', () => {
    // y=370 is inside the homeless band on Destin's workArea.
    const l = computeGroupLayout(mascot(1025, 370), SHORT_WA);
    expect(l.mascot.y).not.toBe(370); // he got pushed
    expect(inkGap(l)).toBe(CHAT_GAP_PX);
  });

  it('bounces the chat away from whichever edge the mascot is nearest', () => {
    // Mascot low in the band → chat bounces UP, mascot pushed down under it.
    const low = computeGroupLayout(mascot(700, 480), SHORT_WA);
    expect(low.chat.y).toBeLessThan(low.mascot.y);
    // Mascot high in the band → chat bounces DOWN, mascot pushed up above it.
    const high = computeGroupLayout(mascot(700, 260), SHORT_WA);
    expect(high.chat.y).toBeGreaterThan(high.mascot.y);
  });

  it('keeps the chat pinned horizontally — it never goes beside the mascot', () => {
    // Regression: an earlier fix put the chat BESIDE the buddy in the band,
    // which broke the pinned horizontal relationship Destin asked for.
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 20) {
      const l = computeGroupLayout(mascot(700, y), SHORT_WA);
      const overlapsHorizontally = l.chat.x < l.mascot.x + MASCOT_SIZE.width
        && l.chat.x + CHAT_SIZE.width > l.mascot.x;
      expect(overlapsHorizontally, `mascot y=${y} → chat x=${l.chat.x}`).toBe(true);
    }
  });

  it('is a fixed point — re-running on its own output changes nothing', () => {
    const once = computeGroupLayout(mascot(1025, 370), SHORT_WA);
    const twice = computeGroupLayout(
      { ...once.mascot, width: 112, height: 112 }, SHORT_WA,
    );
    expect(twice.mascot).toEqual(once.mascot);
    expect(twice.chat).toEqual(once.chat);
  });

  it('handles non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: -1440, y: 0, width: 1440, height: 852 };
    const l = computeGroupLayout({ x: -1000, y: 370, width: 112, height: 112 }, wa2);
    expect(l.chat.x).toBeGreaterThanOrEqual(wa2.x);
    expect(l.chat.x + CHAT_SIZE.width).toBeLessThanOrEqual(wa2.x + wa2.width);
    const ink = mascotInkRect({ ...l.mascot, ...MASCOT_SIZE });
    expect(rectsOverlap(l.chat, CHAT_SIZE, ink, ink)).toBe(false);
  });

  // Destin 2026-07-17: the mascot stops when the chat's right edge hits the
  // screen's right edge — the offset never stretches to keep the chat on screen.
  it('pushes the mascot left rather than sliding the chat off the right edge', () => {
    const far = computeGroupLayout(mascot(SHORT_WA.width - 112, 100), SHORT_WA);
    expect(far.mascot.x).toBeLessThan(SHORT_WA.width - 112); // he got stopped
    expect(far.chat.x + CHAT_SIZE.width).toBe(SHORT_WA.x + SHORT_WA.width);
  });

  it('holds the rigid offset at every mascot x, including past both edges', () => {
    const dx = chatOffsetX(mascot(0, 100));
    for (let x = -400; x <= SHORT_WA.width + 400; x += 7) {
      const l = computeGroupLayout(mascot(x, 100), SHORT_WA);
      // The offset is never stretched — the mascot moved instead.
      expect(l.chat.x - l.mascot.x, `mascot x=${x}`).toBe(dx);
      expect(l.chat.x).toBeGreaterThanOrEqual(SHORT_WA.x);
      expect(l.chat.x + CHAT_SIZE.width).toBeLessThanOrEqual(SHORT_WA.x + SHORT_WA.width);
    }
  });
});

// ─── Taskbar-icon layout ─────────────────────────────────────────────────────

describe('computeTrayLayout', () => {
  const WA = { x: 0, y: 0, width: 1920, height: 1040 };
  it('bottom bar: chat above the button row, the pair against the bar', () => {
    const { chat, bar } = computeTrayLayout({ x: 1700, y: 1048, width: 24, height: 24 }, WA);
    expect(chat.x + CHAT_SIZE.width / 2).toBe(1712);
    expect(bar.y).toBe(chat.y + CHAT_SIZE.height);
    expect(bar.y + BAR_SIZE.height).toBe(1040 - 8);
  });
  it('top bar (macOS menu bar): the chat hangs from the top', () => {
    const { chat } = computeTrayLayout({ x: 1500, y: 2, width: 22, height: 22 }, { x: 0, y: 25, width: 1920, height: 1055 });
    expect(chat.y).toBe(25 + 8);
  });
  it('icon position unknown (Linux): bottom-right corner, fully on screen', () => {
    const { chat, bar } = computeTrayLayout(null, WA);
    expect(chat.x + CHAT_SIZE.width).toBe(1920 - 8);
    expect(bar.x + BAR_SIZE.width).toBeLessThanOrEqual(1920);
    expect(bar.y + BAR_SIZE.height).toBeLessThanOrEqual(1040);
  });
});
