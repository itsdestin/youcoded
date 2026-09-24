// @vitest-environment jsdom
/**
 * Where a plan card is drawn in the conversation.
 *
 * Decision 29: a plan AWAITING APPROVAL is lifted out of its place in the
 * conversation and re-drawn as the last thing in the chat — exactly what an
 * unanswered permission prompt already does — and snaps back once answered.
 * Only `proposed` lifts; running, paused, interrupted and finished plans stay
 * where they are.
 *
 * Decision 28: a plan attempt that produced no plan is not drawn at all while
 * its turn is still running, because the assistant gets one automatic repair
 * and a failure it fixes itself is never shown. It appears when the turn ends
 * with no usable plan.
 *
 * The chat (desktop and remote) and the buddy feed draw the same cards, so
 * both are asserted here.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PlanView } from '../src/shared/types';

const mocks = vi.hoisted(() => ({ state: {} as any }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
}));
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  // ChatView reads the artifact store through narrow selectors (perf, 2026-09-23).
  useArtifactSelector: (select: (s: any) => unknown) => select({ drawerOpenBySession: {}, drawerExpanded: false }),
  useArtifactDispatch: () => vi.fn(),
}));
// The plan card's own body is pinned by the plan-card tests; here only WHERE
// the card lands matters, so a stub that names the card and its plan state is
// the whole signature.
vi.mock('../src/renderer/components/ToolCard', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/components/ToolCard')>()),
  default: ({ tool }: { tool: { toolName: string; plan?: { status: string } } }) => (
    <div data-tool={tool.toolName} data-plan={tool.plan?.status ?? 'none'} />
  ),
}));

import ChatView from '../src/renderer/components/ChatView';
import { BubbleFeed } from '../src/renderer/components/buddy/BubbleFeed';

const CARD = 'call-plan';

const plan = (over: Partial<PlanView> = {}): PlanView => ({
  planId: 'plan-1', toolUseId: CARD, title: 'Review the auth module', status: 'proposed',
  steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, status: 'pending' }],
  model: { label: 'm' }, seq: 1,
  ...over,
});

function state(over: { plan?: PlanView; live?: boolean; status?: string } = {}) {
  const live = over.live ?? false;
  return {
    timeline: [
      { kind: 'user' as const, message: { id: 'm1', role: 'user' as const, content: 'Review the auth module', timestamp: 1000 } },
      { kind: 'assistant-turn' as const, turnId: 't1' },
    ],
    assistantTurns: new Map([['t1', {
      id: 't1', segments: [{ type: 'tool-group' as const, groupId: 'g1' }],
      timestamp: 1000, stopReason: null, model: null, usage: null, anthropicRequestId: null,
    }]]),
    toolGroups: new Map([['g1', { id: 'g1', toolIds: [CARD] }]]),
    toolCalls: new Map([[CARD, {
      toolUseId: CARD, toolName: 'propose_plan', input: { goal: 'Review the auth module' },
      status: over.status ?? 'complete', ...(over.plan ? { plan: over.plan } : {}),
    }]]),
    currentTurnId: live ? 't1' : null,
    activeTurnToolIds: live ? new Set([CARD]) : new Set(),
    queuedMessages: [], isThinking: false, compactionPending: false, promptProcessing: null,
    attentionState: 'ok', errorMessage: null, stallWarning: null, lastActivityAt: 0, lastOutputAt: 0,
    modelState: 'idle', modelInfo: null, modelLoadedBytes: 0, modelEverResident: false,
  };
}

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
}
(window as any).matchMedia ??= (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} });
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => {
  (window as any).claude = {
    on: { transcriptEvent: (h: unknown) => h, hookEvent: (h: unknown) => h, specialistEvent: () => () => {}, shellEvent: () => () => {}, planEvent: () => () => {} },
    off: () => {},
    detach: { requestTranscriptPage: () => Promise.resolve(null) },
  };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

/** Every plan card in the DOM, and whether it was drawn inside the
 *  conversation timeline (in place) or lifted below it. */
function cards(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-tool="propose_plan"]')).map((el) => ({
    planStatus: el.getAttribute('data-plan'),
    lifted: el.closest('.timeline-entry') === null,
  }));
}

const surfaces: [string, () => HTMLElement][] = [
  ['the chat', () => render(<ChatView sessionId="s1" visible={true} sessionActive={true} />).container],
  ['the buddy feed', () => render(<BubbleFeed sessionId="s1" />).container],
];

describe('a plan awaiting approval is drawn at the end of the chat', () => {
  for (const [name, mount] of surfaces) {
    it(`${name} draws a proposed plan once, lifted out of its tool group`, () => {
      mocks.state = state({ plan: plan({ status: 'proposed' }) });
      const container = mount();
      expect(cards(container)).toEqual([{ planStatus: 'proposed', lifted: true }]);
      // The turn it left holds nothing else, so it must not keep a bubble.
      expect(container.querySelector('.timeline-entry .assistant-bubble')).toBeNull();
    });

    it(`${name} leaves every other plan state where it is`, () => {
      for (const status of ['writing', 'running', 'paused', 'interrupted', 'completed', 'stopped', 'failed'] as const) {
        mocks.state = state({ plan: plan({ status }) });
        expect([status, cards(mount())]).toEqual([status, [{ planStatus: status, lifted: false }]]);
        cleanup();
      }
    });

    it(`${name} puts an answered plan back in its place`, () => {
      mocks.state = state({ plan: plan({ status: 'running', seq: 2 }) });
      expect(cards(mount())).toEqual([{ planStatus: 'running', lifted: false }]);
    });
  }
});

describe('a plan attempt the assistant may still repair is not drawn', () => {
  // failedPlanProjection's id: a shell that never became a journal record.
  const shell = plan({ planId: `writing:${CARD}`, status: 'failed', steps: [], title: '', seq: 1, failure: { detail: "The assistant's plan wasn't in a form the app can use." } });

  for (const [name, mount] of surfaces) {
    it(`${name} hides a spent plan shell while the turn is still running`, () => {
      mocks.state = state({ plan: shell, live: true, status: 'failed' });
      expect(cards(mount())).toEqual([]);
    });

    it(`${name} shows it once the turn has ended with no plan`, () => {
      mocks.state = state({ plan: shell, status: 'failed' });
      expect(cards(mount())).toEqual([{ planStatus: 'failed', lifted: false }]);
    });
  }
});
