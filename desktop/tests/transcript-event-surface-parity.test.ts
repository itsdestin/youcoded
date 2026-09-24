// App.tsx and BubbleFeed.tsx each own a transcript-event switch that feeds the
// SAME chatReducer — the buddy window is a separate BrowserWindow, so it cannot
// share the main window's ChatProvider and must subscribe independently.
//
// Nothing kept the two switches in step. PR #287 added `replay-complete` to
// App.tsx only, so the buddy feed kept rendering the spinning orphaned tool card
// that PR exists to reap (found reviewing #287, 2026-08-10).
//
// This test measures the divergence instead of assuming it. KNOWN_GAPS is an
// explicit ledger, not a waiver: each entry is a type App.tsx handles and the
// buddy deliberately (or not yet) does not. Shrinking it is good; growing it
// requires a WHY here.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

// Hand-maintained because TranscriptEventType is a TYPE — it has no runtime
// value to enumerate. Keep in sync with shared/types.ts TranscriptEventType.
const TRANSCRIPT_TYPES = [
  'user-message', 'user-interrupt', 'assistant-text', 'tool-use', 'tool-result',
  'replay-complete', 'turn-complete', 'assistant-thinking', 'session-error',
  'skill-invoked', 'context-clear', 'compact-summary', 'background-task',
] as const;

/** Case labels in a file that name a transcript event type. Intersecting with
 *  TRANSCRIPT_TYPES scopes this to transcript switches and ignores the
 *  timeline-render switch ('user', 'assistant-turn', 'prompt', ...). */
function handledTypes(file: string): Set<string> {
  const text = readSource(join(RENDERER, file));
  const found = new Set<string>();
  for (const t of TRANSCRIPT_TYPES) {
    if (text.includes(`case '${t}':`)) found.add(t);
  }
  return found;
}

// Types App.tsx handles that the buddy feed does not. Each needs a reason.
const KNOWN_GAPS: Record<string, string> = {
  // Buddy has no InputBar, so there is no ESC to interrupt from — but the MAIN
  // window's ESC still ends the turn, and the buddy would not see it. Unverified
  // whether this is a real bug; out of scope for this plan.
  'user-interrupt': 'not investigated — see PR #287 review, 2026-08-10',
  // Buddy renders no skill card today.
  'skill-invoked': 'not investigated — see PR #287 review, 2026-08-10',
  // Buddy timeline would not clear on /clear.
  'context-clear': 'not investigated — see PR #287 review, 2026-08-10',
};

describe('transcript event surface parity: App.tsx vs BubbleFeed.tsx', () => {
  it('buddy handles every transcript type App does, minus the known gaps', () => {
    const app = handledTypes('App.tsx');
    const buddy = handledTypes('components/buddy/BubbleFeed.tsx');

    const missing = [...app].filter((t) => !buddy.has(t) && !(t in KNOWN_GAPS));
    expect(missing).toEqual([]);
  });

  it('buddy reaps orphaned tool cards at end of replay', () => {
    // The specific regression. Called out separately from the parity check so a
    // failure names the bug rather than a diff of two sets.
    expect(handledTypes('components/buddy/BubbleFeed.tsx')).toContain('replay-complete');
  });

  it('KNOWN_GAPS only lists types App.tsx actually handles', () => {
    // Guards the ledger itself: a stale entry would silently excuse a type that
    // no longer exists, hiding a future divergence.
    const app = handledTypes('App.tsx');
    for (const t of Object.keys(KNOWN_GAPS)) expect(app).toContain(t);
  });

  it('both switches dispatch the preparing-tool-card payload', () => {
    // Case-label parity (the test above) cannot see this: both files already
    // handle 'assistant-thinking', so a toolPreparing branch missing from one
    // of them is invisible to a label comparison.
    const app = readSource(join(RENDERER, 'App.tsx'));
    const buddy = readSource(join(RENDERER, 'components', 'buddy', 'BubbleFeed.tsx'));
    expect(app).toContain('toolPreparing');
    expect(buddy).toContain('toolPreparing');
    expect(app).toContain('NATIVE_TOOL_PREPARING');
    expect(buddy).toContain('NATIVE_TOOL_PREPARING');
  });
});

// Review of fix/specialists-ledger-bugs (2026-09-04, F1): the fix that places a
// specialist's mid-run note among its tool rows by time needs every
// TRANSCRIPT_TOOL_USE dispatcher to forward the event's `timestamp` — App.tsx
// and transcript-page-actions.ts were patched, BubbleFeed.tsx was not, so buddy
// rows were unstamped and a note fell to the tail there. Case-label parity
// above cannot see a missing FIELD, so this scans each dispatch object literal.
const TOOL_USE_DISPATCHERS = [
  'App.tsx',
  'components/buddy/BubbleFeed.tsx',
  'state/transcript-page-actions.ts',
  // The workbench replays fixtures through the same reducer; without a stamp a
  // mocked specialist card can never show a note interleaved with its rows, so
  // the fix would be unreviewable on a review deck.
  'dev/workbench/fixture-loader.ts',
];

/** Every `{ ... type: 'TRANSCRIPT_TOOL_USE' ... }` object literal in a file,
 *  found by walking back to the opening brace and forward to its match. */
function toolUseDispatchLiterals(file: string): string[] {
  const text = readSource(join(RENDERER, file));
  const needle = "type: 'TRANSCRIPT_TOOL_USE'";
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const hit = text.indexOf(needle, from);
    if (hit < 0) break;
    from = hit + needle.length;
    const open = text.lastIndexOf('{', hit);
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) { close = i; break; }
    }
    out.push(text.slice(open, close + 1));
  }
  return out;
}

describe('every TRANSCRIPT_TOOL_USE dispatcher forwards the event timestamp', () => {
  for (const file of TOOL_USE_DISPATCHERS) {
    it(`${file} stamps each tool-use dispatch`, () => {
      const literals = toolUseDispatchLiterals(file);
      // A file in this list with no dispatch at all means the list is stale.
      expect(literals.length).toBeGreaterThan(0);
      for (const lit of literals) expect(lit).toMatch(/\btimestamp:/);
    });
  }
});
