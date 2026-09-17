// @vitest-environment jsdom
/**
 * Specialists plans, Task 10 then Task 11 — how the chat draws a plan notice.
 *
 * Task 10 (review 7, R8-1 + Q7-2, "Hide it"): the automatic "[Plan paused]"
 * notice was never drawn. Task 11 (pause handoff §6, revision 4): the notice
 * now exists only because the user pressed "Ask the assistant", so it is
 * drawn as ONE plain line on the user's side — "You asked the assistant about
 * this plan." — with no edit or resend (review 4-6). The notice text itself is
 * the transcript text; no new event and no history-only note. One shared
 * render kind (chat-types.ts `userEntryRenderKind`: show / hide / ask-line)
 * decides, and every timeline that draws injected turns uses it: the chat
 * (desktop and remote — the same ChatView), the buddy feed and the
 * conversation preview. An older automatic notice stays hidden (the user
 * never asked it); other host notes are unaffected.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_ASK_NOTICE_LEAD, PLAN_NOTICE_PREFIX } from '../src/shared/types';
import { userEntryRenderKind } from '../src/renderer/state/chat-types';

const mocks = vi.hoisted(() => ({ state: {} as any }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
}));
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => ({ state: { drawerOpenBySession: {}, drawerExpanded: false }, dispatch: vi.fn() }),
}));

import ChatView from '../src/renderer/components/ChatView';
import { BubbleFeed } from '../src/renderer/components/buddy/BubbleFeed';
import PreviewTimeline from '../src/renderer/components/PreviewTimeline';

/** Before Task 11: sent without the user asking. */
const AUTO_NOTICE = `${PLAN_NOTICE_PREFIX} The plan "Review the auth module" is paused and needs a decision from the user. You are asked to look into it first.\n\nPlan id: plan-1`;
/** Task 11: what "Ask the assistant" sends. */
const ASK_NOTICE = `${PLAN_ASK_NOTICE_LEAD}\n\nPlan: "Review the auth module"\nPlan id: plan-2`;
const ASK_LINE = 'You asked the assistant about this plan.';
const OTHER_NOTE = '[Background specialist failed] Kai the Explorer (explorer): the provider returned 402.';

const userEntry = (id: string, content: string, injected?: string, injectedMeta?: any) => ({
  kind: 'user' as const,
  message: { id, role: 'user' as const, content, timestamp: 1000 },
  ...(injected ? { injected } : {}),
  ...(injectedMeta ? { injectedMeta } : {}),
});

function state() {
  return {
    timeline: [
      userEntry('m-user', 'Review the auth module please'),
      userEntry('m-plan', AUTO_NOTICE, 'specialist-report'),
      userEntry('m-ask', ASK_NOTICE, 'specialist-report'),
      userEntry('m-other', OTHER_NOTE, 'specialist-report'),
    ],
    queuedMessages: [], toolCalls: new Map(), toolGroups: new Map(), assistantTurns: new Map(),
    activeTurnToolIds: new Set(), isThinking: false, compactionPending: false, promptProcessing: null,
    attentionState: 'ok', errorMessage: null, stallWarning: null, lastActivityAt: 0, lastOutputAt: 0,
    modelState: 'idle', modelInfo: null, modelLoadedBytes: 0, modelEverResident: false,
  };
}

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
}

beforeEach(() => {
  mocks.state = state();
  (window as any).claude = {
    on: { transcriptEvent: (h: unknown) => h, hookEvent: (h: unknown) => h, specialistEvent: () => () => {}, shellEvent: () => () => {} },
    off: () => {},
    detach: { requestTranscriptPage: () => Promise.resolve(null) },
  };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

function expectDrawn(container: HTMLElement) {
  // The user's own words and the other note still show…
  expect(container.textContent).toContain('Review the auth module please');
  const rows = Array.from(container.querySelectorAll('[data-testid="specialist-report-card"]'));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent('the provider returned 402');
  // …the question the user asked is one plain line, with nothing to press…
  const lines = Array.from(container.querySelectorAll('[data-testid="plan-ask-line"]'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveTextContent(ASK_LINE);
  expect(lines[0].querySelectorAll('button')).toHaveLength(0);
  // …and neither notice's own text is drawn, in any form.
  expect(container.textContent).not.toContain('is paused and needs a decision');
  expect(container.textContent).not.toContain('Plan paused');
  expect(container.textContent).not.toContain('The user asked you about');
}

describe('plan notices in the chat', () => {
  it('the render kind: an asked notice is a line, an automatic one is hidden, everything else shows', () => {
    expect(userEntryRenderKind(userEntry('a', ASK_NOTICE, 'specialist-report'))).toBe('ask-line');
    expect(userEntryRenderKind(userEntry('b', AUTO_NOTICE, 'specialist-report'))).toBe('hide');
    expect(userEntryRenderKind(userEntry('c', OTHER_NOTE, 'specialist-report'))).toBe('show');
    // A user who TYPES those words still sees their own message.
    expect(userEntryRenderKind(userEntry('d', ASK_NOTICE))).toBe('show');
    expect(userEntryRenderKind(userEntry('e', AUTO_NOTICE))).toBe('show');
    // A report with a header (it folds into its Task card) is not this notice.
    expect(userEntryRenderKind(userEntry('f', ASK_NOTICE, 'specialist-report', { childId: 'k', title: 'Kai', agentType: 'worker', status: 'completed' }))).toBe('show');
  });

  it('the chat (desktop and remote draw the same ChatView)', () => {
    const { container } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    expectDrawn(container);
  });

  it('the buddy feed', () => {
    const { container } = render(<BubbleFeed sessionId="s1" />);
    expectDrawn(container);
  });

  it('the conversation preview', () => {
    const { container } = render(<PreviewTimeline state={state() as any} sessionId="preview-s1" provider="claude" />);
    expectDrawn(container);
  });

  it('the line sits on the user\'s side', () => {
    const { container } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    const line = container.querySelector('[data-testid="plan-ask-line"]')!;
    expect(line.className.split(/\s+/)).toContain('justify-end');
  });

  it('the notice template opens with the same shared lead (the render kind and the template cannot drift)', () => {
    // plan-handoff.test.ts pins the full text; this pins that the template
    // builds its first line from the constant the render kind reads.
    const src = readFileSync(join(__dirname, '../src/main/harness/plans/plan-handoff.ts'), 'utf8');
    expect(src).toMatch(/^\s*PLAN_ASK_NOTICE_LEAD,$/m);
    expect(PLAN_ASK_NOTICE_LEAD).toBe('[Plan paused] The user asked you about this paused plan.');
  });
});
