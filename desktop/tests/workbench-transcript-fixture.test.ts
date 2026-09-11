// The workbench's fake transcript must produce the message SHAPES the real
// reader produces — specifically both of the shapes the tool-gap render
// branches on.
//
// Why this exists (2026-09-10). ConversationTranscript draws a "N tools — not
// shown" card, and `droppedToolCalls` records the tools that ran BEFORE the
// message carrying it, so the card belongs to the message it FOLLOWED. Getting
// that wrong is invisible between two adjacent bubbles; what makes it visible
// is whether the predecessor is an assistant (the card nests INSIDE that
// bubble, as the real chat groups) or a user (it stays on its own row).
//
// The fixture only ever produced the second shape, because it alternated
// user/assistant strictly. So a wrong fix and a right fix rendered identically
// in the workbench, every review looked at the workbench, and the thing that
// caught it was Destin asking "tool call looks the same?".
//
// Same family as tests/workbench-event-contract.test.ts (2026-09-09), where the
// fake dispatched an event the product never sent: a fake that disagrees with
// the product is worse than no fake, because it is what everyone reviews.
import { describe, it, expect } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency } from '../src/renderer/dev/workbench/mock-shim';

setLatency(0);

type Row = { role: string; content: string; seq: number; droppedToolCalls?: number };

async function transcript(): Promise<Row[]> {
  const shim = createMockShim(createStore('default')) as any;
  const res = await shim.chatsearch.read({ provider: 'claude', id: 'wb-past-0', tail: 200 });
  expect(res.ok).toBe(true);
  return res.messages as Row[];
}

describe('the workbench transcript fixture', () => {
  it('puts at least one tool gap after an ASSISTANT message', async () => {
    const rows = await transcript();
    const afterAssistant = rows.filter((m, i) => i > 0 && !!m.droppedToolCalls && rows[i - 1].role === 'assistant');
    expect(
      afterAssistant.length,
      'no gap follows an assistant message, so the workbench can never show the card nested in a bubble — '
      + 'the shape a real transcript produces, and the one a reviewer needs to see',
    ).toBeGreaterThan(0);
  });

  it('gives every gap a predecessor to belong to', async () => {
    const rows = await transcript();
    // A gap on the first row is legitimate (whatever it followed is off the top
    // of what was read) but it is the degenerate case; the fixture should not
    // consist only of those, or the nesting branch is unreachable again.
    const gaps = rows.filter((m) => !!m.droppedToolCalls);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some((m) => m.seq > 0)).toBe(true);
  });

  it('reads as a conversation, not as counters', async () => {
    const rows = await transcript();
    // The panel exists to answer "is this the conversation I meant?", which a
    // reviewer cannot judge from "User question number 12".
    expect(rows.some((m) => /step \d+|question number \d+/i.test(m.content))).toBe(false);
    expect(rows.every((m) => m.content.trim().length > 0)).toBe(true);
  });
});
