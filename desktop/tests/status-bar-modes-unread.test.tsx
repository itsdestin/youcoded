// @vitest-environment jsdom
// WHY (card #134 round 4, Destin Q-1): until the saved Effort/Fast values are read, the effort label and
// the Fast chip are hidden instead of showing "Auto effort" / fast-off as if the user had chosen them.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import StatusBar from '../src/renderer/components/StatusBar';
import { makeStoreWrapper } from './helpers/chat-store-harness';

beforeEach(() => {
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});
afterEach(cleanup);

function bar(extra: Record<string, unknown>) {
  const statusData = { usage: null, updateStatus: null, announcement: null, contextPercent: null, gitBranch: null, sessionStats: null, syncWarnings: [] } as any;
  return render(
    <StatusBar statusData={statusData} provider="claude" sessionId="s1" model={{ kind: 'alias', alias: 'sonnet' } as any} {...extra} />,
    { wrapper: makeStoreWrapper(['s1']).wrapper },
  );
}

describe('Effort and Fast chips before the saved values are read', () => {
  it('hides the effort label and the Fast chip while unread', () => {
    const { container } = bar({ fast: true, effort: 'high', modesUnread: true });
    expect(container.textContent).not.toMatch(/effort/i);
    expect(container.querySelector('[aria-label="Fast mode on"]')).toBeNull();
    expect(container.querySelector('[data-model-chip]')).not.toBeNull(); // the model chip itself stays
  });
  it('shows both exactly as before once read', () => {
    const { container } = bar({ fast: true, effort: 'high', modesUnread: false });
    expect(container.textContent).toContain('High effort');
    expect(container.querySelector('[aria-label="Fast mode on"]')).not.toBeNull();
  });
  it('callers that never pass the flag are unchanged', () => {
    const { container } = bar({ effort: 'low' });
    expect(container.textContent).toContain('Low effort');
  });
});
