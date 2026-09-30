// @vitest-environment jsdom
// Every real capture in tests/fixtures/popup-corpus/ replayed through the
// app's own pop-up detector (usePromptDetector), with the hook system's
// permission event simulated at realistic delays.
//
// WHY: the detector now gives a card to ANY Claude Code dialog that takes the
// keyboard mid-session, not just the ones it knows by name. Ordinary
// permission, question and plan menus look the same on screen — they belong
// to the hook system's cards, and must never get a second card. So for every
// capture, with the hook event arriving at once, after 150 ms, after 400 ms,
// or never:
//   • a hook-owned menu gets NO detector card while its hook card is up;
//   • with no hook at all, at most one fallback card per menu;
//   • a moment with no pop-up never gets a card (quoted menus in replies,
//     numbered lists, suggestion lists, the status line…);
//   • every card is dismissed once its pop-up is gone (a stale card would
//     block every send — hasPendingInteraction).
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  callbacks: [] as Array<(sid: string) => void>,
  screen: { text: '' },
  sessions: new Map<string, any>(),
}));

vi.mock('../src/renderer/hooks/terminal-registry', async (importActual) => {
  const actual = await importActual<typeof import('../src/renderer/hooks/terminal-registry')>();
  return {
    ...actual,
    onBufferReady: (cb: (sid: string) => void) => {
      mocks.callbacks.push(cb);
      return () => { const i = mocks.callbacks.indexOf(cb); if (i >= 0) mocks.callbacks.splice(i, 1); };
    },
    // The bench's own replay terminals read the real buffer; the detector
    // reads the frame this test is currently showing it.
    getVisibleScreenText: (id: string) => (id.startsWith('popup-bench-') ? actual.getVisibleScreenText(id) : mocks.screen.text),
  };
});

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatDispatch: () => mocks.dispatch,
  useChatStore: () => ({ getState: () => mocks.sessions, subscribeAll: () => () => {} }),
}));

import { usePromptDetector } from '../src/renderer/hooks/usePromptDetector';
import { replay, type Segment, type Fixture } from './popup-bench/bench-lib';

const DIR = process.env.POPUP_CORPUS_DIR || path.join(__dirname, 'fixtures', 'popup-corpus');
const SID = 'replay-session';
/** Menus the hook system owns (permission / AskUserQuestion / plan approval). */
const HOOK_OWNED = /permission|question|plan approval|overwrite/;
/** Settle time after a pop-up leaves before its card must be gone (the
 *  detector's DISMISS_DEBOUNCE_MS is 600). */
const DISMISS_SETTLE_MS = 700;

type Delay = number | 'never';
const DELAYS: Delay[] = [0, 150, 400, 'never'];

interface Region { state: string; note: string; from: number; to: number; t0: number; ms: number }

function regions(segs: Segment[]): Region[] {
  const out: Region[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const last = out[out.length - 1];
    if (last && last.state === s.state && last.note === s.note) { last.to = i; last.ms += s.ms; } else out.push({ state: s.state, note: s.note, from: i, to: i, t0: s.t, ms: s.ms });
  }
  return out;
}

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];
const cache = new Map<string, Segment[]>();
const cardsFor: string[] = [];

async function run(file: string, delay: Delay) {
  const fx: Fixture = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  let segs = cache.get(file);
  if (!segs) { segs = await replay(fx); cache.set(file, segs); }
  const regs = regions(segs);

  vi.useFakeTimers();
  mocks.dispatch.mockReset();
  mocks.callbacks.length = 0;
  mocks.sessions.clear();
  const events: { at: number; seg: number; type: string; promptId: string; title?: string }[] = [];
  let segIndex = 0;
  mocks.dispatch.mockImplementation((a: any) => {
    if (a.type === 'SHOW_PROMPT' || a.type === 'DISMISS_PROMPT') events.push({ at: Date.now(), seg: segIndex, type: a.type, promptId: a.promptId, title: a.title });
  });
  const hook = renderHook(() => usePromptDetector({ isStarting: () => false }));
  const setAsk = (on: boolean) => {
    if (on) mocks.sessions.set(SID, { toolCalls: new Map([['t1', { status: 'awaiting-approval' }]]), activeTurnToolIds: ['t1'], timeline: [] });
    else mocks.sessions.delete(SID);
  };

  const failures: string[] = [];
  // A hook ask, once raised, stays up until the menu is answered — through a
  // resize or any other redraw of the same menu — i.e. until a moment with no
  // pop-up at all.
  let askUp = false;
  try {
    let lastFrame = -1;
    for (const r of regs) {
      const hookOwned = r.state === 'popup' && HOOK_OWNED.test(r.note);
      if (r.state === 'none' && askUp) { setAsk(false); askUp = false; }
      let askAt = hookOwned && delay !== 'never' && !askUp ? r.t0 + delay : Infinity;
      for (let i = r.from; i <= r.to; i++) {
        const g = segs[i];
        segIndex = i;
        let remaining = g.ms;
        if (g.frame !== lastFrame) {
          lastFrame = g.frame;
          mocks.screen.text = g.screen;
          act(() => { for (const cb of [...mocks.callbacks]) cb(SID); });
        }
        // Step through the segment, raising the hook's ask when it is due.
        while (remaining > 0) {
          const now = g.t + (g.ms - remaining);
          if (askAt <= now) { setAsk(true); askUp = true; askAt = Infinity; }
          const step = Math.min(remaining, askAt !== Infinity ? Math.max(1, askAt - now) : remaining);
          act(() => { vi.advanceTimersByTime(step); });
          remaining -= step;
        }
      }

      // Judge the region.
      const inRegion = events.filter((e) => e.type === 'SHOW_PROMPT' && e.seg >= r.from && e.seg <= r.to);
      if (r.state === 'none' && inRegion.length) failures.push(`card with no pop-up: [${r.note}] "${inRegion[0].title}"`);
      if (hookOwned && delay !== 'never' && inRegion.length) failures.push(`duplicate card beside the hook card: [${r.note}] "${inRegion[0].title}"`);
      if (r.state === 'popup' && inRegion.length > 1) failures.push(`${inRegion.length} cards for one pop-up: [${r.note}]`);
      if (r.state === 'popup' && inRegion.length && (delay === 0 || delay === 'never')) cardsFor.push(`${delay === 'never' ? 'no hook ' : ''}${fx.scenario} [${r.note}] → "${inRegion[0].title}"`);
      if (r.state === 'none' && r.ms >= DISMISS_SETTLE_MS) {
        const open = new Set<string>();
        for (const e of events) {
          if (e.seg > r.to) break;
          if (e.type === 'SHOW_PROMPT') open.add(e.promptId); else open.delete(e.promptId);
        }
        if (open.size) failures.push(`card still up after its pop-up left: [${r.note}] ${[...open].join(', ')}`);
      }
    }
  } finally {
    hook.unmount();
    vi.useRealTimers();
  }
  return failures;
}

describe('pop-up corpus through the prompt detector', () => {
  beforeAll(() => { cardsFor.length = 0; });

  it('has a corpus to replay', () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    for (const delay of DELAYS) {
      it(`${file}: hook ask ${delay === 'never' ? 'never arrives' : `after ${delay} ms`} — one card per unclaimed pop-up, none beside a hook card or without a pop-up`, async () => {
        expect(await run(file, delay)).toEqual([]);
      }, 60_000);
    }
  }

  afterAll(() => {
    if (process.env.POPUP_REPLAY_REPORT) fs.writeFileSync(process.env.POPUP_REPLAY_REPORT, [...new Set(cardsFor)].sort().join('\n'));
  });
});
