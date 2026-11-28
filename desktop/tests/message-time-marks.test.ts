// Which messages keep their time on a phone (state/message-time-marks.ts, density-review D-5).
import { describe, it, expect } from 'vitest';
import { messageTimeMarks, TIME_BREAK_MS } from '../src/renderer/state/message-time-marks';
import type { AssistantTurn, TimelineEntry } from '../src/renderer/state/chat-types';

const user = (id: string, timestamp: number) =>
  ({ kind: 'user', message: { id, role: 'user', content: id, timestamp } }) as unknown as TimelineEntry;
const reply = (turnId: string) => ({ kind: 'assistant-turn', turnId }) as TimelineEntry;
const turn = (id: string, timestamp: number) => [id, { id, timestamp } as unknown as AssistantTurn] as const;

describe('messageTimeMarks', () => {
  const t0 = new Date(2026, 10, 2, 9, 0).getTime();

  it('keeps the first message, the newest, and the first after a break; hides the rest', () => {
    const timeline = [user('u1', t0), reply('a1'), user('u2', t0 + 60_000), reply('a2'), user('u3', t0 + TIME_BREAK_MS + 120_000), reply('a3')];
    const turns = new Map([turn('a1', t0 + 10_000), turn('a2', t0 + 70_000), turn('a3', t0 + TIME_BREAK_MS + 130_000)]);
    expect([...messageTimeMarks(timeline, turns)].sort()).toEqual(['a3', 'u1', 'u3']);
  });

  it('a new day starts a new part even after a short pause', () => {
    const late = new Date(2026, 10, 2, 23, 55).getTime();
    const timeline = [user('u1', late), user('u2', late + 10 * 60_000), user('u3', late + 11 * 60_000)];
    expect([...messageTimeMarks(timeline, new Map())].sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('skips entries with no time (cards, markers) without breaking the chain', () => {
    const card = { kind: 'usage-card', snapshot: { entryId: 'c1' } } as unknown as TimelineEntry;
    const timeline = [user('u1', t0), card, user('u2', t0 + 60_000), user('u3', t0 + 120_000)];
    expect([...messageTimeMarks(timeline, new Map())].sort()).toEqual(['u1', 'u3']);
  });
});
