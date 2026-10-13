// @vitest-environment jsdom
// A screen that opens LATE on a local-model chat whose model loaded and then went to sleep shows the Reload button, not a permanent "loading" bar
// (one-core sync-fix3 review). Real record -> real openSession -> real reducer -> real ModelLoadingBar.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionRecords } from '../src/main/session-record';
import { openSession } from '../src/main/session-open';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import ModelLoadingBar from '../src/renderer/components/ModelLoadingBar';

const S = 's1';
const deps = (records: SessionRecords) => ({ records, knows: () => true, page: async () => ({ events: [], cursor: null, hasMore: false }) as any, native: () => null });

async function lateScreen(states: string[]) {
  const records = new SessionRecords();
  records.begin(S);
  for (const state of states) records.note(S, 'native:model-state', { sessionId: S, modelId: 'm1', state, sizeBytes: 100, loadedBytes: null });
  const reply: any = await openSession(deps(records), { sessionId: S, fresh: true });
  let st = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S } as any);
  for (const p of [...reply.before, ...reply.after].filter((x: any) => x.type === 'native:model-state')) {
    st = chatReducer(st, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: S, state: p.payload.state, modelId: p.payload.modelId, sizeBytes: p.payload.sizeBytes, loadedBytes: p.payload.loadedBytes } as any);
  }
  return st.get(S)!;
}
const bar = (s: any) => render(<ModelLoadingBar modelState={s.modelState} modelInfo={s.modelInfo} loadedBytes={s.modelLoadedBytes} everResident={s.modelEverResident} isThinking={false} onReload={vi.fn()} />);

describe('a late screen on a local-model chat', () => {
  it('whose model loaded and then slept offers Reload (it was resident)', async () => {
    const s = await lateScreen(['loading', 'loaded', 'sleeping']);
    expect(s.modelState).toBe('sleeping');
    expect(s.modelEverResident).toBe(true);
    bar(s);
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
  });
  it('whose model has only ever been loading shows the loading bar, with no Reload', async () => {
    const s = await lateScreen(['loading']);
    expect(s.modelEverResident).toBe(false);
    bar(s);
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  });
  it('whose model is loaded now gets no extra state', async () => {
    const records = new SessionRecords(); records.begin(S);
    records.note(S, 'native:model-state', { sessionId: S, modelId: 'm1', state: 'loaded', sizeBytes: 1, loadedBytes: null });
    const reply: any = await openSession(deps(records), { sessionId: S, fresh: true });
    expect([...reply.before, ...reply.after].filter((x: any) => x.type === 'native:model-state')).toHaveLength(1);
  });
});
