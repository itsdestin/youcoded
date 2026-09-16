// Builds the workbench's chat timelines by replaying conversation fixtures
// through the REAL chat reducer, then serializing the result into the payload
// App.tsx's `on.chatHydrate` subscriber already understands (App.tsx:1465).
//
// WHY the hydrate channel rather than dispatching into ChatProvider directly:
// `dispatch` lives inside <App/>'s provider tree, so nothing outside it can
// reach the reducer. `on.chatHydrate` is a real channel (remote-shim.ts serves
// it so a remote browser gets its timelines on connect), and App already
// subscribes to it unconditionally — so the workbench feeds the timeline through
// a shipping code path instead of an injection point carved into App.
//
// This also satisfies spec §3.3's objection to hand-authored SerializedChatState:
// nothing here is hand-authored. The shape is produced by the reducer and the
// app's own serializer, so it cannot drift from what the app expects.
import { chatReducer } from '../../state/chat-reducer';
import { serializeChatState, type ChatState, type SerializedChatState } from '../../state/chat-types';
import { loadFixture } from './fixture-loader';
import type { SessionTotals } from '../../state/session-totals';
import type { ScenarioId } from './scenarios';
import { RUNS, PLANS } from './specialist-runs';

// @ts-ignore TS1343 — Vite rewrites import.meta.glob statically at build time.
const convos = import.meta.glob('./fixtures/conversations/*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

// Bubble-grouping scenarios (2026-09-02): short native-shaped conversations,
// one per grouping case, each replayed INTO wb-2 in place of `native` when the
// page is opened with `?seed=bubbles-<name>`. Kept out of the conversations
// glob so the default workbench (and every existing review plan) is untouched.
// @ts-ignore TS1343 — Vite rewrites import.meta.glob statically at build time.
const bubbleConvos = import.meta.glob('./fixtures/bubbles/*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** Session ids must match the seeded SessionInfo rows (fixtures/sessions.ts) so
 *  each timeline lands on the session the strip is showing. A fixture with no
 *  mapping is skipped rather than dispatched into a session that does not exist. */
const SESSION_FOR: Record<string, string> = {
  'claude-code': 'wb-1',
  native: 'wb-2',
  // Sign in with ChatGPT (2026-09-04): wb-3 is bound to the ChatGPT plan's
  // catalog (fixtures/sessions.ts), and this is the conversation on it.
  chatgpt: 'wb-3',
  specialists: 'wb-11',
  // Landing-page embed (scenario=site): site.jsonl plays into the one session
  // that scenario seeds (fixtures/sessions.ts siteSessions), not wb-2.
  site: 'site-1',
};

/** `?stalled=1` replays the fixture's parked-turn line so the red
 *  "Provider may have stalled" card can be reviewed. OFF by default — see
 *  LoadOptions.includeStalled for why (it used to be on for every scenario).
 *  Guarded on `location` existing: this module is imported by a Node-environment
 *  unit test (tests/workbench-fixture-actions.test.ts), where there is no
 *  browser global and touching one would throw at import time. */
function stalledRequested(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('stalled') === '1';
}

/** `?planLimit=1`: replay the chatgpt fixture's used-up-plan error (see
 *  LoadOptions.includePlanLimit). Same node-test guard as stalledRequested(). */
function planLimitRequested(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('planLimit') === '1';
}

function seedRequested(): string | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('seed');
}

/** `?scenario=` reader, mirroring `stalledRequested()` above — same node-test
 *  guard, since this module is imported by workbench-fixture-actions.test.ts
 *  where `location` does not exist. */
function currentScenario(): ScenarioId | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('scenario') as ScenarioId | null;
}

// Task 9 (status-bar relevance review): the four native scenarios all target
// wb-2 — same session the 'native' fixture already hydrates — so the ONLY
// thing that has to change per scenario is its totals. Values are exactly the
// brief's table (task-9-brief.md Step 1), not invented here. Tokens repeat
// across statusbar-local/-metered/-unpriced (the "same tokens" note in the
// brief); statusbar-delegated additionally folds in 3 specialist runs.
const NATIVE_TOKENS = {
  inputTokens: 84_000, outputTokens: 3_200, cacheReadTokens: 61_000, cacheCreationTokens: 900,
} as const;

// Task 17: free and unpriced are now different things, so these four stopped
// saying what their names claim and are corrected here. 'statusbar-local' is a
// local engine (free, nothing unpriced); 'statusbar-unpriced' is metered with no
// published rate (NOT free); 'statusbar-delegated' is a free local parent whose
// every cent came from its metered specialists.
const STATUSBAR_TOTALS_OVERRIDE: Partial<Record<ScenarioId, { sessionId: string; totals: SessionTotals }>> = {
  // Added 2026-09-03. The Claude Code scenario used to need no totals, because
  // the bar read a CC session's tokens off the statusline fixture. It no longer
  // does — those numbers describe one request, not the session — so without an
  // entry here the CC sheet would simply lose In:/Out:/Cached:/Reuse.
  //
  // Magnitudes are a real session's shape (one of Destin's, 2026-09-03): input
  // is enormous next to output because every request re-sends the history, and
  // almost all of it is served from cache. costUsd stays 0/unpriced on purpose —
  // a Claude Code session's cost comes from the statusline's `cost.*` block,
  // which really does accumulate, and that fixture already supplies it.
  'statusbar-cc': {
    sessionId: 'wb-1',
    totals: {
      inputTokens: 29_507_217, outputTokens: 119_894,
      cacheReadTokens: 29_122_759, cacheCreationTokens: 371_600,
      costUsd: 0, anyPriced: false, anyUnpriced: false, anyFree: false,
      linesAdded: 0, linesRemoved: 0, specialistRuns: 0, specialistCostUsd: 0,
    },
  },
  'statusbar-local': {
    sessionId: 'wb-2',
    totals: { ...NATIVE_TOKENS, costUsd: 0, anyPriced: false, anyUnpriced: false, anyFree: true, linesAdded: 210, linesRemoved: 45, specialistRuns: 0, specialistCostUsd: 0 },
  },
  'statusbar-metered': {
    sessionId: 'wb-2',
    totals: { ...NATIVE_TOKENS, costUsd: 1.37, anyPriced: true, anyUnpriced: false, anyFree: false, linesAdded: 210, linesRemoved: 45, specialistRuns: 0, specialistCostUsd: 0 },
  },
  'statusbar-unpriced': {
    sessionId: 'wb-2',
    totals: { ...NATIVE_TOKENS, costUsd: 0, anyPriced: false, anyUnpriced: true, anyFree: false, linesAdded: 210, linesRemoved: 45, specialistRuns: 0, specialistCostUsd: 0 },
  },
  'statusbar-delegated': {
    sessionId: 'wb-2',
    totals: { ...NATIVE_TOKENS, costUsd: 0.61, anyPriced: true, anyUnpriced: true, anyFree: true, linesAdded: 480, linesRemoved: 96, specialistRuns: 3, specialistCostUsd: 0.61 },
  },
};

let cached: SerializedChatState | null = null;

/** The hydrate payload for every mapped conversation fixture, merged into one
 *  state the way a real multi-session snapshot arrives. Cached because the
 *  fixtures are static and the reducer replay is pure — `cached` lives for the
 *  lifetime of one page load, and a scenario switch is always a full
 *  navigation (WorkbenchToolbar's `reloadWith`), so it is never stale across
 *  scenarios despite being read once here. */
export function buildHydratePayload(): SerializedChatState {
  if (cached) return cached;

  let state: ChatState = new Map();

  // Sorted so the merge order is deterministic — import.meta.glob's key order is
  // not guaranteed, and a fixture's actions must not interleave with another's.
  // `?seed=bubbles-<name>` swaps wb-2's conversation for one bubble-grouping
  // scenario (see bubbleConvos above). Everything else loads as usual.
  const seed = seedRequested();
  const bubbleName = seed?.startsWith('bubbles-') ? seed.slice('bubbles-'.length) : null;
  const sources: Array<[name: string, raw: string, sessionId: string | undefined]> = Object.entries(convos)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, raw]) => {
      const name = path.split('/').pop()!.replace('.jsonl', '');
      return [name, raw, SESSION_FOR[name]];
    });
  if (bubbleName) {
    const raw = bubbleConvos[`./fixtures/bubbles/${bubbleName}.jsonl`];
    if (raw) {
      const i = sources.findIndex(([name]) => name === 'native');
      sources.splice(i >= 0 ? i : sources.length, i >= 0 ? 1 : 0, [`bubbles-${bubbleName}`, raw, 'wb-2']);
    } else {
      console.warn(`[workbench] no bubble-grouping fixture named "${bubbleName}"`);
    }
  }

  for (const [name, raw, sessionId] of sources) {
    // `?seed=none` (site scenario): leave the embed's conversation EMPTY so a
    // filmed loop starts with the user's first message. Every landing-page loop
    // used to open on the same "plan my week" thread, which had nothing to do
    // with what the loop then showed (Destin, 2026-08-28 loop review).
    if (name === 'site' && seed === 'none') continue;
    if (!sessionId) {
      console.warn(`[workbench] conversation fixture "${name}" has no session mapping — skipped`);
      continue;
    }

    const { actions, error } = loadFixture(name, raw, sessionId, { includeStalled: stalledRequested(), includePlanLimit: planLimitRequested() });
    if (error) { console.warn(`[workbench] ${error}`); continue; }

    state = chatReducer(state, { type: 'SESSION_INIT', sessionId });
    for (const action of actions) {
      state = chatReducer(state, action);
      // Specialists 1c: remember each declared run so the mock's stop action
      // can flip the right record (mock-shim.ts `specialists.interrupt`).
      if (action.type === 'SPECIALIST_RUN_CHANGED') RUNS.set(action.run.childId, action.run);
      // Specialists stage two (design mockup): same registration for plans, so
      // the mock plans.* calls can find the record a card's button names.
      if (action.type === 'PLAN_CHANGED') PLANS.set(action.plan.planId, action.plan);
    }
  }

  const override = STATUSBAR_TOTALS_OVERRIDE[currentScenario() ?? 'default'];
  if (override) {
    const existing = state.get(override.sessionId);
    // Guard rather than throw: a missing session here means SESSION_FOR above
    // stopped mapping wb-2, which would already have warned loudly — this just
    // avoids compounding that with a second failure.
    if (existing) state.set(override.sessionId, { ...existing, totals: override.totals });
  }

  cached = serializeChatState(state);
  return cached;
}
