// Where a dragged session pill lands, and how the pills around it get out of
// the way. Pure so it can be tested without mounting SessionStrip.
//
// EVERYTHING HERE IS KEYED BY SESSION ID, NEVER BY INDEX. That is the whole
// point of the module. The strip used to mix two index spaces: `dragIdx` was
// resolved against the FULL sessions array, while each pill's data attribute
// carried its index into the VISIBLE subset. Those agree only while every
// session fits — the moment packSessions pushes one into its `overflow`
// bucket (the "+N" chip), they diverge, and onReorderSessions was called with
// a canonical "from" and a visible "to". App.tsx spliced into the wrong slot,
// and the strip dimmed the wrong pill for the whole drag.
// Ids are unique (pack-sessions.ts: "Caller guarantees session ids are unique")
// so no index space can drift out from under them again.
//
// THE MODEL (2026-09-01 rebuild) — Chrome's, made to work with pills of mixed
// width. The pill in hand follows the cursor 1:1 along the strip. Its target is
// whichever SLOT its centre is nearest to, where a slot is the position the
// pill would occupy if it were dropped between a given pair of neighbours — a
// pure function of the frozen widths and the order, never of where the
// neighbours are drawn right now. Every pill between origin and target steps
// over by the dragged pill's width, so the row never changes total width and
// the gap IS the indicator.
//
// WHY nearest-slot and not nearest-neighbour: the first version asked "which
// pill's centre is closest to the cursor", which is only the same question when
// every pill is the same width. With a ~180px active pill among 24px dots the
// pill's edge covered a dot long before the cursor reached that dot's centre,
// so the gap lagged the pill by ~90px and the pill overlapped its neighbours.
// The fix that shipped for review positioned the pill by its slot instead of
// the cursor — which put the gap right but took the pill out from under the
// pointer (it hopped 26px per slot while the cursor travelled 130px). Nearest
// slot keeps the pill under the cursor AND the gap under the pill: it is never
// more than half a neighbour-width from its hole.
import { PILL_GAP } from './pack-sessions';

export { PILL_GAP };

/** One pill's horizontal extent, in client coordinates. */
export interface PillRect {
  id: string;
  left: number;
  right: number;
}

const width = (r: PillRect) => r.right - r.left;

/** A pill's SETTLED width — what it will be once its label transition ends. */
export interface PillSize { id: string; width: number }

/** Where each pill will sit once the row has settled, laid out from `originLeft`
 *  with `gap` between them. This is the geometry a drag is judged against —
 *  never the DOM's, because on a select-on-press the row is still reshaping
 *  (the old active pill collapsing, the new one opening) when the drag starts,
 *  and a hit-test against a moving row chases its own output. */
export function layoutRects(
  sizes: readonly PillSize[],
  originLeft: number,
  gap: number = PILL_GAP,
): PillRect[] {
  const out: PillRect[] = [];
  let left = originLeft;
  for (const s of sizes) {
    out.push({ id: s.id, left, right: left + s.width });
    left += s.width + gap;
  }
  return out;
}

/** The centre x the dragged pill would have at each position k in the row
 *  (k = 0 … rects.length − 1), with the other pills keeping their order. */
export function slotCentres(
  rects: readonly PillRect[],
  draggedId: string,
  gap: number = PILL_GAP,
): number[] {
  const dragged = rects.find(r => r.id === draggedId);
  if (!dragged || rects.length === 0) return [];
  const others = rects.filter(r => r.id !== draggedId);
  const half = width(dragged) / 2;
  const out: number[] = [];
  let left = rects[0].left;
  for (let k = 0; k <= others.length; k++) {
    out.push(left + half);
    if (k < others.length) left += width(others[k]) + gap;
  }
  return out;
}

/** Which pill's slot the dragged pill is heading for — the one whose slot
 *  centre is nearest `draggedCentreX` — or null when that is its own slot.
 *  The answer is an id in `rects` order, which is what neighbourOffsets takes. */
export function nearestSlotId(
  rects: readonly PillRect[],
  draggedId: string,
  draggedCentreX: number,
  gap: number = PILL_GAP,
): string | null {
  const centres = slotCentres(rects, draggedId, gap);
  if (centres.length === 0) {
    // The pill in hand is not in the row — a drag from the All Sessions menu
    // onto the strip. It has no slot of its own, so the target is simply the
    // strip pill whose centre is nearest the cursor.
    let best: string | null = null;
    let bestDist = Infinity;
    for (const r of rects) {
      const d = Math.abs(draggedCentreX - (r.left + r.right) / 2);
      if (d < bestDist) { bestDist = d; best = r.id; }
    }
    return best;
  }
  let best = 0;
  for (let k = 1; k < centres.length; k++) {
    if (Math.abs(draggedCentreX - centres[k]) < Math.abs(draggedCentreX - centres[best])) best = k;
  }
  const from = rects.findIndex(r => r.id === draggedId);
  return best === from ? null : rects[best].id;
}

/** How early a neighbour gets out of the way, in px.
 *  - `margin`: the neighbour AHEAD of the pill (in the direction it is moving)
 *    yields when the pill's leading edge is this far short of its near edge.
 *    NEGATIVE means past it: −12 is a dot's CENTRE (dots are 24px since
 *    2026-09-27, when their off-centre 4px went; −14 while they were 28) — Chrome's
 *    rule, a tab swaps with its neighbour when it has crossed half of it. It
 *    was +6 ("before contact") while dots slid aside and needed a head start,
 *    then −27 (1px short of the far edge) while the dot ahead was hidden and
 *    jumped unseen, so that the dot landed exactly one gap behind the pill.
 *    That made the drop travel up to a dot's width: release with the pill
 *    over 26 of a dot's 28px and it was NOT passed, so the pill glided back
 *    a whole pitch — and at the row's end, where the clamped pill can reach
 *    a dot's far edge by only 1px, a hand let go a few px short and the pill
 *    "moved back rightward a bit" (Destin, R7). At the centre the drop travels
 *    at most half a dot, and the end slot has 11px of margin, not 1. The dot
 *    flows (SessionStrip): before the swap it is drawn shrinking at its old
 *    spot with a growing image at its new one, after the swap the other way
 *    round — the two sizes always sum to one, so the swap itself shows
 *    nothing, wherever it fires. (Only dots reach this line: a wide
 *    neighbour's `early` term wins.)
 *  - `early`: for a WIDE neighbour the trigger is its centre minus this,
 *    rather than its near edge — a dot must not send a 290px pill sliding
 *    aside the moment it touches it, or the dot ends up drawn over the wide
 *    pill's other half.
 *  - `deadband`: how far the cursor must come back before the drag counts as
 *    having REVERSED. The rules only ever move the neighbour ahead, so nothing
 *    can flap while the direction holds; the dead-band is what keeps a shaky
 *    hand at rest from counting as a reversal every other frame. */
export const DRAG_TUNE = { margin: -12, early: 20, deadband: 4 };

/** The slot the pill in hand is heading for, given the slot it is heading for
 *  NOW and the direction it is moving. Only the neighbour AHEAD ever yields:
 *  moving right, the one after the pill's slot steps left behind it as the
 *  pill's leading edge nears it; moving left, the mirror. Nothing behind the
 *  pill is touched, so the rule cannot oscillate while the direction holds —
 *  a reversal simply makes the dot that was just passed the one ahead again,
 *  and it steps back out of the way at the same early point. A drag from the
 *  All Sessions menu (the pill is not in the row) falls back to nearest.
 *  Returns the id of the pill occupying the target slot in `rects` order —
 *  what neighbourOffsets takes — or null for the pill's own slot. */
export function nextSlotId(
  rects: readonly PillRect[],
  draggedId: string,
  currentOverId: string | null,
  draggedCentreX: number,
  direction: -1 | 0 | 1,
  gap: number = PILL_GAP,
  tune: { margin: number; early: number } = DRAG_TUNE,
): string | null {
  const centres = slotCentres(rects, draggedId, gap);
  if (centres.length === 0) return nearestSlotId(rects, draggedId, draggedCentreX, gap);
  const from = rects.findIndex(r => r.id === draggedId);
  const others = rects.filter(r => r.id !== draggedId);
  let ins = currentOverId === null ? -1 : rects.findIndex(r => r.id === currentOverId);
  if (ins < 0) ins = from;
  // With the pill at position k, neighbour k sits just to its right at
  // centres[k] + w/2 + gap. Moving right it yields when the pill's leading edge
  // is `margin` short of it — a pill-centre line independent of the pill's own
  // width — but never before the neighbour's centre minus `early`.
  const lineRight = (k: number) =>
    centres[k] + Math.max(gap - tune.margin, (width(others[k]) + gap) / 2 - tune.early);
  // With the pill at position k+1, neighbour k sits just to its LEFT, ending at
  // centres[k] - w/2 + w_k. Moving left it yields when the pill's leading (left)
  // edge is `margin` short of that end, never before its centre plus `early`.
  const lineLeft = (k: number) =>
    centres[k] + Math.min(width(others[k]) + tune.margin, width(others[k]) / 2 + tune.early);
  if (direction > 0) {
    while (ins < others.length && draggedCentreX > lineRight(ins)) ins++;
  } else if (direction < 0) {
    while (ins > 0 && draggedCentreX < lineLeft(ins - 1)) ins--;
  }
  return ins === from ? null : rects[ins].id;
}

/** Where the pill in hand may be drawn: it rides the strip, never past the
 *  first pill's left edge or the last pill's right. `left` is the wanted left
 *  edge in client px, `width` the pill's settled width. */
export function clampFloatLeft(rects: readonly PillRect[], left: number, width: number): number {
  if (rects.length === 0) return left;
  const min = rects[0].left;
  const max = rects[rects.length - 1].right - width;
  return Math.min(max, Math.max(min, left));
}

/** Canonical from/to for `onReorderSessions`, which splices into the full
 *  sessions array. Null when either id is unknown — a session can close
 *  mid-drag, and reordering against a stale list is worse than not reordering. */
export function reorderIndices(
  sessionIds: readonly string[],
  fromId: string,
  toId: string,
): { from: number; to: number } | null {
  const from = sessionIds.indexOf(fromId);
  const to = sessionIds.indexOf(toId);
  if (from === -1 || to === -1) return null;
  return { from, to };
}

/** How far each pill slides to open the gap the dragged pill is heading for,
 *  in CSS px (negative = left). The dragged pill is absent from the map: it is
 *  positioned by the cursor, not by this.
 *
 *  Every pill between the dragged pill's origin and its target steps over by
 *  exactly the dragged pill's width (plus one gap), so the row never changes
 *  total width and the gap IS the insertion indicator. */
export function neighbourOffsets(
  rects: readonly PillRect[],
  draggedId: string,
  overId: string | null,
  gap: number = PILL_GAP,
): Map<string, number> {
  const out = new Map<string, number>();
  if (overId === null || overId === draggedId) return out;

  const from = rects.findIndex(r => r.id === draggedId);
  const to = rects.findIndex(r => r.id === overId);
  if (from === -1 || to === -1) return out;

  const shift = width(rects[from]) + gap;

  if (to > from) {
    // Dragging right: everything from just after the origin through the target
    // steps LEFT into the space the dragged pill vacated.
    for (let i = from + 1; i <= to; i++) out.set(rects[i].id, -shift);
  } else {
    for (let i = to; i < from; i++) out.set(rects[i].id, shift);
  }
  return out;
}

/** An x in the row AS DRAWN (each pill at its `now` left, transforms taken
 *  out) mapped to the same place in the row as it will SETTLE — piecewise
 *  linear between pill left edges, a plain shift beyond the ends. The yield
 *  lines (nextSlotId) are defined on settled geometry; this is how a cursor
 *  over a row that is still settling is asked the same question.
 *
 *  WHY (2026-09-02): pressing a dot collapses the old name and re-centres the
 *  strip, so the row slides ~150px under a stationary cursor over 260ms — and
 *  a drag usually starts inside that window. Judged against settled geometry
 *  alone, the pill in hand was "already" seven slots along, and seven dots
 *  yielded at once, far ahead of anything visible. Mapping the cursor through
 *  where the dots ARE makes a dot yield when the pill visibly reaches it. */
export function mapToSettled(
  now: readonly PillRect[],
  settled: readonly PillRect[],
  x: number,
): number {
  const settledLeft = new Map(settled.map((r) => [r.id, r.left]));
  const pairs = now
    .filter((r) => settledLeft.has(r.id))
    .map((r) => ({ from: r.left, to: settledLeft.get(r.id)! }))
    .sort((a, b) => a.from - b.from);
  if (pairs.length === 0) return x;
  if (x <= pairs[0].from) return x + (pairs[0].to - pairs[0].from);
  const last = pairs[pairs.length - 1];
  if (x >= last.from) return x + (last.to - last.from);
  for (let k = 0; k + 1 < pairs.length; k++) {
    const a = pairs[k], b = pairs[k + 1];
    if (x >= a.from && x <= b.from) {
      const t = b.from === a.from ? 0 : (x - a.from) / (b.from - a.from);
      return a.to + t * (b.to - a.to);
    }
  }
  return x;
}
