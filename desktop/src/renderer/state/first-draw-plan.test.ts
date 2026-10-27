// Freeze hunt 2026-10-22, item 3: which entries a long conversation draws on first mount.
import { describe, it, expect } from 'vitest';
import type { AssistantTurn, TimelineEntry } from './chat-types';
import { FIRST_DRAW_MIN_ENTRIES, FIRST_DRAW_MIN_KEEP, FIRST_DRAW_PX, estimateEntryHeight, planFirstDraw, timelineEntryKey } from './first-draw-plan';

const user = (i: number, extra: Partial<Extract<TimelineEntry, { kind: 'user' }>> = {}): TimelineEntry =>
  ({ kind: 'user', message: { id: `u${i}`, role: 'user', content: `question ${i}`, timestamp: i } as any, ...extra });
const turnEntry = (i: number): TimelineEntry => ({ kind: 'assistant-turn', turnId: `t${i}` });
const turn = (i: number, words = 40): AssistantTurn => ({
  id: `t${i}`, segments: [{ type: 'text', content: 'word '.repeat(words), messageId: `m${i}` }],
  stopReason: null, model: null, usage: null, anthropicRequestId: null,
});
function conversation(n: number, words = 40) {
  const timeline: TimelineEntry[] = []; const turns = new Map<string, AssistantTurn>();
  for (let i = 0; i < n; i++) { timeline.push(user(i), turnEntry(i)); turns.set(`t${i}`, turn(i, words)); }
  return { timeline, turns };
}

describe('planFirstDraw', () => {
  it('draws a short conversation whole', () => {
    const { timeline, turns } = conversation(FIRST_DRAW_MIN_ENTRIES / 2 - 1);
    expect(planFirstDraw(timeline, turns, null)).toBeUndefined();
  });

  it('folds the older entries of a long one and keeps the newest screens, never fewer than the minimum', () => {
    const { timeline, turns } = conversation(60, 200);
    const plan = planFirstDraw(timeline, turns, null)!;
    const folded = new Set(plan.map(([k]) => k));
    expect(plan.length).toBeGreaterThan(60);
    // The newest FIRST_DRAW_MIN_KEEP entries are never in the plan.
    for (const e of timeline.slice(-FIRST_DRAW_MIN_KEEP)) expect(folded.has(timelineEntryKey(e)!)).toBe(false);
    // What is kept spans at least the pixel target by the plan's own guess.
    const keptPx = timeline.filter((e) => !folded.has(timelineEntryKey(e)!)).reduce((n, e) => n + estimateEntryHeight(e, e.kind === 'assistant-turn' ? turns.get(e.turnId) : undefined), 0);
    expect(keptPx).toBeGreaterThanOrEqual(FIRST_DRAW_PX);
    expect(plan.every(([, h]) => Number.isInteger(h) && h > 0)).toBe(true);
  });

  it('keeps small entries from being folded below the minimum count, however short they are', () => {
    const { timeline, turns } = conversation(40, 1);
    const plan = planFirstDraw(timeline, turns, null)!;
    expect(timeline.length - plan.length).toBeGreaterThanOrEqual(FIRST_DRAW_MIN_KEEP);
  });

  it('never folds the live turn, a waiting prompt, an unsent message or a turn with nothing to show', () => {
    const { timeline, turns } = conversation(60, 200);
    timeline[2] = user(1, { pending: true });
    // t1 (index 3) is the live turn
    timeline.splice(4, 0, { kind: 'prompt', prompt: { promptId: 'p1', title: 'x', buttons: [] } as any });
    turns.set('t-empty', { ...turn(99), segments: [] });
    timeline.splice(5, 0, { kind: 'assistant-turn', turnId: 't-empty' });
    const folded = new Set(planFirstDraw(timeline, turns, 't1')!.map(([k]) => k));
    expect(folded.has('u1')).toBe(false);
    expect(folded.has('t1')).toBe(false);
    expect(folded.has('p1')).toBe(false);
    expect(folded.has('t-empty')).toBe(false);
    expect(folded.has('u5')).toBe(true);
  });

  it('keys match the ones ChatView draws (the retired history marker has none)', () => {
    expect(timelineEntryKey(user(7))).toBe('u7');
    expect(timelineEntryKey(turnEntry(7))).toBe('t7');
    expect(timelineEntryKey({ kind: 'prompt', prompt: { promptId: '_history_expand' } as any })).toBeNull();
  });
});
