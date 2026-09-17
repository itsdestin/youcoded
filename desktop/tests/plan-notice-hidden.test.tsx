// @vitest-environment jsdom
/**
 * Specialists plans, Task 10 — controller decision 17 (review 7, R8-1 + Q7-2:
 * "we should not show the note for the assistant card", option "Hide it").
 *
 * When a paused plan is handed to the assistant, the app still sends the
 * assistant its "[Plan paused]" notice as a real turn (the transcript and the
 * model's history keep it) — only its collapsed "Note for the assistant" row
 * is no longer drawn. One shared gate (chat-types.ts) decides, and every
 * timeline that draws injected turns calls it: the chat (desktop and remote —
 * the same ChatView), the buddy feed, and the conversation preview.
 * Other host notes are unaffected.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_NOTICE_PREFIX } from '../src/shared/types';
import { shouldRenderUserEntry } from '../src/renderer/state/chat-types';

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

const PLAN_NOTICE = `${PLAN_NOTICE_PREFIX} The plan "Review the auth module" is paused and needs a decision from the user. You are asked to look into it first.\n\nPlan id: plan-1`;
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
      userEntry('m-plan', PLAN_NOTICE, 'specialist-report'),
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

function expectHidden(container: HTMLElement) {
  // The user's own words and the other note still show…
  expect(container.textContent).toContain('Review the auth module please');
  const rows = Array.from(container.querySelectorAll('[data-testid="specialist-report-card"]'));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent('the provider returned 402');
  // …the plan notice does not, in any form.
  expect(container.textContent).not.toContain('is paused and needs a decision');
  expect(container.textContent).not.toContain('Plan paused');
}

describe('the plan pause notice is not drawn', () => {
  it('the gate: only an injected "[Plan paused]" turn is hidden', () => {
    expect(shouldRenderUserEntry(userEntry('a', PLAN_NOTICE, 'specialist-report'))).toBe(false);
    expect(shouldRenderUserEntry(userEntry('b', OTHER_NOTE, 'specialist-report'))).toBe(true);
    // A user who TYPES those words still sees their own message.
    expect(shouldRenderUserEntry(userEntry('c', PLAN_NOTICE))).toBe(true);
    // A report with a header (it folds into its Task card) is not this notice.
    expect(shouldRenderUserEntry(userEntry('d', PLAN_NOTICE, 'specialist-report', { childId: 'k', title: 'Kai', agentType: 'worker', status: 'completed' }))).toBe(true);
  });

  it('the chat (desktop and remote draw the same ChatView)', () => {
    const { container } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    expectHidden(container);
  });

  it('the buddy feed', () => {
    const { container } = render(<BubbleFeed sessionId="s1" />);
    expectHidden(container);
  });

  it('the conversation preview', () => {
    const { container } = render(<PreviewTimeline state={state() as any} sessionId="preview-s1" provider="claude" />);
    expectHidden(container);
  });

  it('the notice template opens with the same shared prefix (the gate and the template cannot drift)', () => {
    // plan-handoff.test.ts pins the full text; this pins that the template
    // builds its first line from the constant the gate reads.
    const src = readFileSync(join(__dirname, '../src/main/harness/plans/plan-handoff.ts'), 'utf8');
    expect(src).toMatch(/`\$\{PLAN_NOTICE_PREFIX\} The plan /);
    expect(PLAN_NOTICE_PREFIX).toBe('[Plan paused]');
  });
});
