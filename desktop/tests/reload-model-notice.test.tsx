// @vitest-environment jsdom
// Card #134 round 4: the chat's "Reload model" button says "Couldn't reload the model." when the load request itself fails.
// The real ChatView is rendered against a session whose local model was dropped while idle (the state that shows the button).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen, act } from '@testing-library/react';

// Same quiescent-session stand-ins as ChatView.test.tsx, with the model fields set so the strip offers a reload.
const mocks = vi.hoisted(() => ({
  state: {
    timeline: [] as any[], queuedMessages: [] as any[], toolCalls: new Map(), toolGroups: new Map(), assistantTurns: new Map(), activeTurnToolIds: new Set(),
    isThinking: false, promptProcessing: null, attentionState: 'ok', errorMessage: null, stallWarning: null, lastActivityAt: 0, lastOutputAt: 0,
    modelState: 'sleeping', modelInfo: { modelId: 'qwen-test', sizeBytes: 1024 }, modelLoadedBytes: 0, modelEverResident: true,
  },
  artifact: { drawerOpenBySession: {} as Record<string, boolean>, drawerExpanded: false },
}));
vi.mock('../src/renderer/state/chat-context', () => ({ useChatState: () => mocks.state, useChatDispatch: () => vi.fn() }));
vi.mock('../src/renderer/components/SessionDrawer', () => ({ SessionDrawer: () => <div>Files</div> }));
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifactSelector: (select: (s: any) => unknown) => select(mocks.artifact),
  useArtifactDispatch: () => vi.fn(),
}));
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
}

import ChatView from '../src/renderer/components/ChatView';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';

const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
let t: ReturnType<typeof toasts>;
const unsupported = Object.assign(new Error('remote-unsupported: models:load'), { code: 'REMOTE_UNSUPPORTED' });
// settle: for negative assertions, let any late toast arrive first.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => { t = toasts(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { t.off(); cleanup(); delete (window as any).claude; vi.restoreAllMocks(); });

async function reload(load: () => Promise<unknown>) {
  const loadFn = vi.fn(load);
  (window as any).claude = { models: { load: loadFn } };
  render(<ChatView sessionId="s1" visible sessionActive />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload model' })); });
  return loadFn;
}

describe('Reload model', () => {
  it('a failed load request says "Couldn\'t reload the model."', async () => {
    const load = await reload(async () => { throw new Error('engine stopped'); });
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't reload the model."]));
    expect(load).toHaveBeenCalledWith('qwen-test', 's1');
  });
  it('a load request that is accepted says nothing', async () => {
    const load = await reload(async () => ({ ok: true }));
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('qwen-test', 's1'));
    await settle();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection says nothing', async () => {
    const load = await reload(async () => { throw unsupported; });
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});
