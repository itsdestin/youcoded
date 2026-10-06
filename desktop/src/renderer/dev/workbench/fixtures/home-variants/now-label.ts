// Design options for how the thermostat dial shows the room's CURRENT temperature (owner, 2026-10-05: "want to refine how the
// 'now' temp is styled on thermostat"). The line across the ring stays; only the label next to it changes. Shown in the practice
// app only (see types.ts); the chosen option gets built into home-assistant-page-dial.ts and this file is deleted.
//
//   a  Glass pill   a small rounded glass tag, thermometer + "79°", touching the line's outer end
//   b  Just number  only "79°", a bit larger and quieter, at the line's outer end (the line is the marker)
//   c  Flag         the line reaches a little past the ring and ends in a tab reading "Now 79°"
//
// WHY transform (not css/js on top): the page's script is one closure, so its dial functions cannot be reached from outside; the
// dial's text is replaced by exact match. The label still goes through the page's own placement rule (thLabelSpot), so it keeps
// its no-overlap guarantee with the - / + buttons, handles, ring and the big number; each option only tells the rule its own
// box size (the "extra" numbers below, measured from the pictures) and, for the flag, how far the line reaches.
import type { HomeVariant, HomeVariants } from './types';
import { fakeHomeAssistantIds } from '../fake-home-assistant';

// Replace one exact piece of the page's text, failing loudly if the page changed under us (so an option never silently shows nothing).
function swap(html: string, from: string, to: string): string {
  if (html.indexOf(from) < 0) throw new Error('now-label: page text not found: ' + from.slice(0, 60));
  return html.split(from).join(to);
}

interface Look { text: string; extraW: number; extraH: number; tick?: number; touch?: boolean; hold?: boolean; roomY?: number; roomX?: number }

// cur: pretend the room is at this temperature (the other screens' fake house is at 74), so the end of the dial can be seen.
function make(look: Look, cur: number | null) {
  return (html: string): string => {
    let h = html;
    if (cur != null) h = swap(h, 'function thDialInner(it, compact) {', 'function thDialInner(it0, compact) { var it = Object.assign({}, it0, { cur: ' + cur + ' });');
    h = swap(h, "var nowTxt = haveNow ? 'Now ' + esc(it.cur) + '°' : ''", "var nowTxt = haveNow ? " + look.text + " : ''");
    // The label's box as the placement rule sees it, and (flag) how far the line reaches beyond the ring.
    const tickK = look.tick ?? 12;
    h = swap(h, 'w: nowLen * 0.56 * g.nowFs + 8, h: g.nowFs * 1.25 + 2,', 'w: nowLen * 0.56 * g.nowFs + 8 + ' + look.extraW + ', h: g.nowFs * 1.25 + 2 + ' + look.extraH + ',');
    // touch: the label's edge meets the line's tip (the rule's usual 2px gap is taken off).
    h = swap(h, 'tick: 12 * k,', 'tick: ' + tickK + ' * k' + (look.touch ? ' - 2' : '') + ',');
    // roomY: how much further above/below the dial the label may reach (the card has a little spare room there).
    if (look.roomY) h = swap(h, 'my: g.my,', 'my: g.my + ' + look.roomY + ',');
    // roomX: the same sideways, on the big Climate dial only (the card's dial already has the button column's room).
    if (look.roomX) h = swap(h, 'mx: g.mx,', 'mx: g.mx + (g.btn ? 0 : ' + look.roomX + '),');
    if (look.tick) { h = swap(h, '(R - 12)', '(R - ' + look.tick + ')'); h = swap(h, '(R + 12)', '(R + ' + look.tick + ')'); }
    if (look.hold) {
      // The label stays joined to its line: instead of sliding round the ring (the page's way) it is hung off the line's tip like a pennant,
      // its nearest corner on the tip, first on the side the line leans to, then the other side, each time a little further out; if none is
      // clear it goes to the middle of the dial. (Same no-overlap test as the page's own.)
      h = swap(h, 'var rad = (o.a + turns[j]) * Math.PI / 180,', 'var rad = (o.a + (o.hold ? 0 : turns[j])) * Math.PI / 180,');
      h = swap(h, 'var x = c + ux * rc, y = c + uy * rc;', 'var x = c + ux * rc, y = c + uy * rc; if (o.hold) { var dir = sides[s] === "out" ? 1 : -1, tr = o.R + dir * (o.tick + 2) + dir * n * 2, sg = turns[j] < 0 ? -1 : 1, sx = (ux >= 0 ? 1 : -1) * dir * sg, sy = (uy >= 0 ? 1 : -1) * dir; x = c + ux * tr + sx * o.w / 2; y = c + uy * tr + sy * o.h / 2; }');
      h = swap(h, 'core: core };', 'core: core, hold: true };');
    }
    return h;
  };
}

// A small thermometer, drawn as a mask so it takes the text's colour in any theme.
const THERMO = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M9.3 5a2.7 2.7 0 0 1 5.4 0v7.6a5.2 5.2 0 1 1-5.4 0z'/%3E%3C/svg%3E")`;

const CSS_A = String.raw`
  .th-dial .th-now-lbl { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px 2px 5px; font-size: 12px; font-weight: 600; color: var(--fg);
    background: color-mix(in srgb, var(--fg) 14%, var(--inset)); border: 1px solid var(--edge); border-radius: 9999px; box-shadow: 0 1px 3px rgba(0,0,0,.28); }
  .th-dial .th-now-lbl::before { content: ''; width: 11px; height: 14px; flex-shrink: 0; background: currentColor; opacity: .75;
    -webkit-mask: ${THERMO} center / contain no-repeat; mask: ${THERMO} center / contain no-repeat; }
  .th-compact .th-dial .th-now-lbl { font-size: 10px; padding: 1px 5px 1px 4px; gap: 2px; }
  .th-compact .th-dial .th-now-lbl::before { width: 9px; height: 12px; }
`;
const CSS_B = String.raw`
  .th-dial .th-now-lbl { padding: 0; font-size: 15px; font-weight: 400; color: var(--fg-2); background: none;
    text-shadow: 0 0 3px var(--inset), 0 0 3px var(--inset), 0 0 5px var(--inset); }
  .th-compact .th-dial .th-now-lbl { font-size: 12px; padding: 0; }
`;
const CSS_C = String.raw`
  .th-dial svg { overflow: visible; }
  .th-dial .th-now-lbl { padding: 2px 6px; font-size: 12px; font-weight: 600; color: var(--canvas); background: var(--fg); border-radius: var(--radius-sm); box-shadow: 0 1px 3px rgba(0,0,0,.3); }
  .th-compact .th-dial .th-now-lbl { font-size: 10px; padding: 1px 4px; }
`;

const A: Look = { text: "esc(it.cur) + '°'", extraW: 20, extraH: 6, touch: true, hold: true, roomY: 12, roomX: 20 };
const B: Look = { text: "esc(it.cur) + '°'", extraW: 4, extraH: 4, hold: true, roomY: 12, roomX: 20 };
const C: Look = { text: "'Now ' + esc(it.cur) + '°'", extraW: 8, extraH: 5, tick: 18, touch: true, hold: true, roomY: 12, roomX: 20 };

// Only the thermostat on the Home tab's card (every other device hidden), its room open; the Climate view needs no hiding.
const ONLY_THERMO = () => ({ hidden: fakeHomeAssistantIds().filter((id) => id !== 'climate.thermostat'), startOpen: ['upstairs'] });

function set(key: string, name: string, css: string, look: Look): HomeVariants {
  const v = (label: string, cur: number | null, data: Record<string, unknown>): HomeVariant => ({ label: name + label, css, transform: make(look, cur), data });
  return {
    [key]: v(', Home card', null, ONLY_THERMO()),
    [key + '-hot']: v(', Home card, hot room', 90, ONLY_THERMO()),
    [key + '-climate']: v(', Climate dial', null, { view: 'climate' }),
    [key + '-climate-hot']: v(', Climate dial, hot room', 90, { view: 'climate' }),
  };
}

export const VARIANTS: HomeVariants = {
  ...set('a', 'Glass pill', CSS_A, A),
  ...set('b', 'Just the number', CSS_B, B),
  ...set('c', 'Flag on the line', CSS_C, C),
};
