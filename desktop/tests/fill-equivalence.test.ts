// The ONE fill path (session:open) over scripted sessions, against what the old paths showed (one-core R5-2).
//
// tests/fixtures/fill-golden.json was recorded from the OLD code before it was replaced: for every scripted session, what a window that
// watched it from the start showed (`truth`, which the old phone's snapshot was a copy of) and what a torn-off window showed after its
// own fill (`window`). A screen filled through the new path must show `truth`. Where the old torn-off window showed less (it could not
// know what only memory holds), the new path is held to `truth` too and the gap is named here, so a regression cannot hide as "it was
// always like that".
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCENARIOS, runScenario, screenOf } from './helpers/fill-scenarios';
import { fillNew, norm } from './helpers/fill-harness';

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fill-golden.json'), 'utf8')) as Record<string, { truth: any; phone: any; window: any }>;

/** Scenarios where the old torn-off window fell short of the watching window, and what it lacked. */
const OLD_WINDOW_FELL_SHORT: Record<string, string> = {
  'cc: tool run, an ask raised before anyone connected, still open': 'a Claude Code ask raised before the window opened came back as a running tool with no buttons and the turn idle',
  'native: compaction summary lands mid-conversation': 'the "Compacted" divider (a live-only line) was missing',
  'native: a provider error ends the turn': 'the provider-error banner was missing',
  'native: a turn parked by a stall (the stalled card)': 'the stalled card was missing and the turn looked idle',
  'native: connected mid-answer (the text so far exists only in memory) with a tool waiting on an ask': 'the turn looked idle (the ask itself was restored)',
  'native: connected mid-answer, text still streaming': 'the answer so far (only in memory) was missing and the turn looked idle',
};

describe('a screen filled through session:open shows what the old paths showed', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const run = await runScenario(sc);
      try {
        const g = golden[sc.name];
        const { state, reply } = await fillNew(sc, run);
        expect(reply.ok).toBe(true);
        const got = norm(screenOf(state));
        // The target: what a screen that watched the whole session shows (the old phone's snapshot was a copy of exactly this).
        expect(got).toEqual(norm(g.phone));
        // And the old torn-off window: equal wherever it was complete; where it was not, the gap is named (and the new path is the better one).
        if (OLD_WINDOW_FELL_SHORT[sc.name]) expect(norm(g.window), `the old window was expected to fall short: ${OLD_WINDOW_FELL_SHORT[sc.name]}`).not.toEqual(norm(g.phone));
        else expect(got).toEqual(norm(g.window));
      } finally { run.cleanup(); }
    });
  }
});
