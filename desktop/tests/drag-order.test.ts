import { describe, it, expect } from 'vitest';
import {
  nearestSlotId, nextSlotId, slotCentres, clampFloatLeft, layoutRects, reorderIndices, neighbourOffsets,
  mapToSettled, PILL_GAP, DRAG_TUNE,
} from '../src/renderer/components/header/drag-order';
import { packSessions } from '../src/renderer/components/header/pack-sessions';

// Three 100px pills with a 2px gap: a=[0,100] b=[102,202] c=[204,304]
const rects = [
  { id: 'a', left: 0, right: 100 },
  { id: 'b', left: 102, right: 202 },
  { id: 'c', left: 204, right: 304 },
];

// Non-uniform widths are the whole point: a wide active pill among dots.
const mixed = [
  { id: 'wide', left: 0, right: 179 },   // the active pill
  { id: 'd1', left: 181, right: 205 },
  { id: 'd2', left: 207, right: 231 },
  { id: 'd3', left: 233, right: 257 },
];

describe('slotCentres', () => {
  it('is where the dragged pill would sit at each position, others keeping their order', () => {
    // a (100 wide) at position 0, 1, 2 among b and c.
    expect(slotCentres(rects, 'a', 2)).toEqual([50, 152, 254]);
  });

  it('handles mixed widths — the dots flow under a wide pill one at a time', () => {
    // wide (179) at each of four positions among three 24px dots.
    expect(slotCentres(mixed, 'wide', 2)).toEqual([89.5, 115.5, 141.5, 167.5]);
  });

  it('is empty when the dragged id is not in the row (a drag from the menu)', () => {
    expect(slotCentres(rects, 'zz', 2)).toEqual([]);
  });
});

describe('nearestSlotId', () => {
  it('names the pill whose slot the dragged centre is nearest to', () => {
    expect(nearestSlotId(rects, 'a', 250, 2)).toBe('c');
    expect(nearestSlotId(rects, 'a', 140, 2)).toBe('b');
  });

  it('is null while the pill is nearest its own slot', () => {
    expect(nearestSlotId(rects, 'a', 60, 2)).toBeNull();
    expect(nearestSlotId(rects, 'b', 152, 2)).toBeNull();
  });

  it('keeps a wide pill within half a dot of its hole', () => {
    // The old nearest-NEIGHBOUR test needed the cursor at a dot's centre before
    // that dot stepped aside, so a 179px pill overlapped three dots before its
    // gap opened. Now the gap follows the pill's centre: 13px past the first
    // slot centre it is already heading for d1's slot.
    expect(nearestSlotId(mixed, 'wide', 89.5 + 12, 2)).toBeNull();
    expect(nearestSlotId(mixed, 'wide', 89.5 + 14, 2)).toBe('d1');
    expect(nearestSlotId(mixed, 'wide', 167.5, 2)).toBe('d3');
  });

  it('is null when the dragged pill is the only one', () => {
    expect(nearestSlotId([rects[0]], 'a', 50, 2)).toBeNull();
  });
});

describe('layoutRects', () => {
  it('lays settled widths out from an origin with the gap between them', () => {
    // This is the geometry a drag is judged against — the row it is settling
    // INTO, not the DOM mid-animation (a select-on-press reshapes the row
    // while the drag starts).
    expect(layoutRects([{ id: 'a', width: 100 }, { id: 'b', width: 24 }, { id: 'c', width: 24 }], 10, 2))
      .toEqual([
        { id: 'a', left: 10, right: 110 },
        { id: 'b', left: 112, right: 136 },
        { id: 'c', left: 138, right: 162 },
      ]);
  });
});

describe('nextSlotId — the neighbour ahead yields early, in either direction', () => {
  // wide (179) among three 28px dots: d1=[181,209] d2=[211,239] d3=[241,269]
  const row = [
    { id: 'wide', left: 0, right: 179 },
    { id: 'd1', left: 181, right: 209 },
    { id: 'd2', left: 211, right: 239 },
    { id: 'd3', left: 241, right: 269 },
  ];
  const c0 = 89.5;                       // the wide pill's own slot centre

  it('moving right, a dot yields when the pill\'s edge is `margin` short of it — its CENTRE, margin being −14', () => {
    // The pill's right edge is at centre + 89.5; d1's left is 181. Contact is
    // centre 91.5; the yield line is margin short of that (past it: −14 is
    // d1's centre — Chrome's rule. R7, 2026-09-03: at −27, 1px before the far
    // edge, a release with the pill over 26 of the dot's 28px was NOT a pass,
    // and the pill glided back a whole pitch; at the row's end, where the
    // clamped pill reaches the far edge by 1px, a hand let go a few px short
    // and "it moves back rightward a bit"). The dot is half-flowed by then
    // (SessionStrip's flow) and its other image is half-grown behind.
    const line = c0 + PILL_GAP - DRAG_TUNE.margin;   // 105.5
    expect(DRAG_TUNE.margin).toBe(-14);
    expect(nextSlotId(row, 'wide', null, line - 0.5, 1, 2)).toBeNull();
    expect(nextSlotId(row, 'wide', null, line + 0.5, 1, 2)).toBe('d1');
  });

  it('moving left, the dot now ahead yields at the same `margin` — its centre again', () => {
    // After passing d1 the pill is at position 1 and d1 sits at [0,28] on its
    // left. Coming back, the pill's left edge (centre − 89.5) nears d1's right
    // edge (28): contact at centre 117.5, the line is margin past that.
    const over = nextSlotId(row, 'wide', null, c0 + 31, 1, 2);
    expect(over).toBe('d1');
    const line = c0 + 28 + DRAG_TUNE.margin;         // 103.5
    expect(nextSlotId(row, 'wide', over, line + 0.5, -1, 2)).toBe('d1');
    expect(nextSlotId(row, 'wide', over, line - 0.5, -1, 2)).toBeNull();
  });

  it('a WIDE neighbour yields at its centre minus `early`, not on contact', () => {
    // dot (28) dragged right towards a 179px pill.
    const r = [{ id: 'dot', left: 0, right: 28 }, { id: 'wide', left: 30, right: 209 }];
    const c0 = 14;
    const line = c0 + (179 + 2) / 2 - DRAG_TUNE.early;   // 84.5
    expect(nextSlotId(r, 'dot', null, line - 0.5, 1, 2)).toBeNull();
    expect(nextSlotId(r, 'dot', null, line + 0.5, 1, 2)).toBe('wide');
  });

  it('never touches the neighbour BEHIND — no flapping while the direction holds', () => {
    // Just past d1 moving right: sitting still or creeping right never un-yields it.
    const over = nextSlotId(row, 'wide', null, c0 + PILL_GAP - DRAG_TUNE.margin + 1, 1, 2);
    expect(over).toBe('d1');
    expect(nextSlotId(row, 'wide', over, c0 + 5, 1, 2)).toBe('d1');
    expect(nextSlotId(row, 'wide', over, c0 + 5, 0, 2)).toBe('d1');
  });

  it('crosses several dots in one fast move', () => {
    // Three pitches on, past the third centre line (2 * 30 + 16 = 76 < 90).
    expect(nextSlotId(row, 'wide', null, c0 + 3 * 30, 1, 2)).toBe('d3');
  });

  it('falls back to nearest for a pill that is not in the row', () => {
    expect(nextSlotId(rects, 'from-menu', null, 150, 1, 2)).toBe('b');
  });
});

describe('clampFloatLeft', () => {
  it('keeps the pill in hand between the first pill\'s left edge and the last pill\'s right edge', () => {
    expect(clampFloatLeft(rects, -500, 100)).toBe(0);
    expect(clampFloatLeft(rects, 500, 100)).toBe(204);
    expect(clampFloatLeft(rects, 130, 100)).toBe(130);
  });
});

describe('nearestSlotId for a pill that is not in the row', () => {
  it('falls back to the strip pill nearest the cursor (a drag from the All Sessions menu)', () => {
    expect(nearestSlotId(rects, 'from-menu', 150, 2)).toBe('b');
    expect(nearestSlotId(rects, 'from-menu', 290, 2)).toBe('c');
  });
});

describe('reorderIndices', () => {
  it('resolves both ends against the FULL session list', () => {
    expect(reorderIndices(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual({ from: 0, to: 2 });
  });

  it('stays correct when pills are missing from the strip (overflow)', () => {
    // THE REGRESSION. The strip shows a, c, d — b is in the "+1" overflow
    // bucket. Dropping a onto d is canonical (0 -> 3). The old code passed a
    // canonical "from" and a VISIBLE "to" (0 -> 2), which App.tsx spliced into
    // the wrong slot. Ids cannot desync.
    const all = ['a', 'b', 'c', 'd'];
    expect(reorderIndices(all, 'a', 'd')).toEqual({ from: 0, to: 3 });
  });

  it('returns null for an id that is not in the list', () => {
    expect(reorderIndices(['a', 'b'], 'a', 'zz')).toBeNull();
  });
});

describe('neighbourOffsets', () => {
  it('slides the pills between source and target LEFT when dragging right', () => {
    // a (100 wide) heads for c's slot: b and c step left by 100 + 2.
    const o = neighbourOffsets(rects, 'a', 'c', 2);
    expect(o.get('b')).toBe(-102);
    expect(o.get('c')).toBe(-102);
    expect(o.get('a')).toBeUndefined(); // the dragged pill is positioned by the cursor
  });

  it('slides them RIGHT when dragging left', () => {
    const o = neighbourOffsets(rects, 'c', 'a', 2);
    expect(o.get('a')).toBe(102);
    expect(o.get('b')).toBe(102);
  });

  it('moves nothing when there is no target', () => {
    expect(neighbourOffsets(rects, 'a', null, 2).size).toBe(0);
  });

  it('moves nothing when the target is the dragged pill itself', () => {
    expect(neighbourOffsets(rects, 'b', 'b', 2).size).toBe(0);
  });

  it('opens a hole exactly the size of the slot the pill is heading for', () => {
    // The row's total width must not change: the three dots vacate on the
    // right (each steps over by the wide pill's 179 + gap) what the wide pill
    // vacates on the left, and the slot it is heading for — three dots plus
    // gaps to the right of its origin — is where slotCentres says it sits.
    const offs = neighbourOffsets(mixed, 'wide', 'd3', 2);
    expect(offs.get('d1')).toBe(-181);
    expect(offs.get('d3')).toBe(-181);
    expect(slotCentres(mixed, 'wide', 2)[3]).toBe(89.5 + 3 * 26);
  });
});

describe('the index spaces the strip used to mix', () => {
  // This is the regression, demonstrated with the REAL packer rather than a
  // hand-made overflow list — so it proves the divergence is reachable in the
  // shipping layout, not just constructible on paper.
  //
  // packSessions keeps the active pill plus a PREFIX of the others and pushes
  // the tail into the "+N" chip. visibleSessions then filters the full array,
  // preserving canonical order. So the moment the active session sits past
  // that prefix, the visible list is [0, 1, …, k, active] — and the active
  // pill's position in it is NOT its position in `sessions`.
  //
  // The old code read `dragIdx` from the full array and each pill's
  // `data-session-idx` from the visible one, then handed both straight to
  // onReorderSessions. Dragging the active pill therefore spliced the wrong row.
  it('diverges on the active pill once the strip overflows', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      expandedWidth: 120,
      collapsedWidth: 24,
    }));
    // Budget fits the active pill (120) plus a couple of dots, nothing near all 8.
    const pack = packSessions({
      sessions, activeId: 's5', budget: 220, gap: PILL_GAP, triggerWidth: 24,
    });
    expect(pack.overflow.length).toBeGreaterThan(0);   // the "+N" chip is showing

    const visible = sessions
      .filter(s => pack.expanded.has(s.id) || pack.collapsed.includes(s.id))
      .map(s => s.id);
    expect(visible).toContain('s5');

    const visibleIdx = visible.indexOf('s5');
    const canonicalIdx = sessions.findIndex(s => s.id === 's5');
    expect(visibleIdx).not.toBe(canonicalIdx);          // ← the bug, reproduced

    // What the strip does now: both ends resolved against the full list, by id.
    expect(reorderIndices(sessions.map(s => s.id), 's5', visible[0]))
      .toEqual({ from: canonicalIdx, to: 0 });
  });
});

describe('mapToSettled — a cursor over a row that is still settling, asked the settled question', () => {
  // As drawn: the old name has not collapsed yet, so everything after `a` is
  // 100px further right than it will settle.
  const now = [
    { id: 'a', left: 0, right: 128 },
    { id: 'b', left: 132, right: 160 },
    { id: 'c', left: 164, right: 192 },
  ];
  const settled = [
    { id: 'a', left: 0, right: 28 },
    { id: 'b', left: 32, right: 60 },
    { id: 'c', left: 64, right: 92 },
  ];

  it('maps a pill\'s drawn left edge to its settled left edge', () => {
    expect(mapToSettled(now, settled, 132)).toBe(32);
    expect(mapToSettled(now, settled, 164)).toBe(64);
  });

  it('interpolates between edges and shifts beyond the ends', () => {
    expect(mapToSettled(now, settled, 148)).toBe(48);   // halfway b→c
    expect(mapToSettled(now, settled, 66)).toBe(16);    // halfway a→b: 0..132 → 0..32
    expect(mapToSettled(now, settled, 200)).toBe(100);  // past c: same shift as c
    expect(mapToSettled(now, settled, -10)).toBe(-10);  // before a: a does not move
  });

  it('is the identity once the row has settled', () => {
    expect(mapToSettled(settled, settled, 47)).toBe(47);
  });

  it('ignores a drawn pill the settled row does not know', () => {
    expect(mapToSettled([...now, { id: 'z', left: 300, right: 328 }], settled, 148)).toBe(48);
  });
});
