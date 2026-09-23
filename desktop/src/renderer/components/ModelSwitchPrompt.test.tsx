// @vitest-environment jsdom
// U11 — the "This chat is too long for [model]" popup, driven through the REAL
// model picker (ModelPickerPopup → shared ModelPicker row → switchModel IPC).
// Contract rows R2/R3: a model that fits switches directly; an overfull chat
// asks, summarizing on the current model and switching only if that works;
// X or Esc leaves the chat and model unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ModelPickerPopup from './ModelPickerPopup';
import { EscCloseProvider } from '../hooks/use-esc-close';
import { switchFailureMessage } from './ModelSwitchPrompt';

const CATALOG = [
  { id: 'big-model', providerId: 'cloud', label: 'Big Model' },
  { id: 'small-model', providerId: 'cloud', label: 'Small Model' },
];

function bridge(switchModel: ReturnType<typeof vi.fn>) {
  const interrupt = vi.fn();
  (window as any).claude = {
    providers: {
      list: vi.fn().mockResolvedValue([{ id: 'cloud', type: 'openrouter', label: 'Cloud', ready: true }]),
      catalog: vi.fn().mockResolvedValue(CATALOG),
    },
    native: { sessionsList: vi.fn().mockResolvedValue([]), switchModel, interrupt },
    models: { onDownloadProgress: () => () => {} },
  };
  return { interrupt };
}

function renderPicker() {
  const onClose = vi.fn();
  const onNativeModelChanged = vi.fn();
  const onNativeSummaryPending = vi.fn();
  render(
    <EscCloseProvider>
      <ModelPickerPopup open onClose={onClose} sessionId="s1" currentModel={null} onSelectModel={() => {}}
        provider="native" currentModelId="big-model" onNativeModelChanged={onNativeModelChanged}
        onNativeSummaryPending={onNativeSummaryPending} sendPtyCommand={() => true} />
    </EscCloseProvider>,
  );
  return { onClose, onNativeModelChanged, onNativeSummaryPending };
}

// The picker opens on favourites; search reaches the whole catalogue.
const pickSmall = async () => {
  fireEvent.change(await screen.findByPlaceholderText(/Search/i), { target: { value: 'Small' } });
  fireEvent.click(await screen.findByText(/Small Model/));
};

describe('model switch popup (U11)', () => {
  beforeEach(() => { try { window.localStorage?.clear(); } catch { /* no storage in this env */ } });
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('a model that fits switches directly — no popup', async () => {
    const switchModel = vi.fn().mockResolvedValue({ status: 'switched' });
    bridge(switchModel);
    const { onClose, onNativeModelChanged } = renderPicker();
    await pickSmall();
    await waitFor(() => expect(onNativeModelChanged).toHaveBeenCalledWith('small-model'));
    expect(onClose).toHaveBeenCalled();
    expect(switchModel).toHaveBeenCalledWith('s1', { providerId: 'cloud', modelId: 'small-model' }, false);
    expect(screen.queryByText(/too long for/)).toBeNull();
  });

  it('an overfull chat asks first, with the approved sentence, and changes nothing', async () => {
    bridge(vi.fn().mockResolvedValue({ status: 'needs-summary' }));
    const { onClose, onNativeModelChanged, onNativeSummaryPending } = renderPicker();
    await pickSmall();
    const dialog = await screen.findByRole('dialog', { name: 'Switch model' });
    expect(dialog).toHaveTextContent('This chat is too long for Small Model. Big Model can summarize older messages first.');
    expect(screen.getByRole('button', { name: 'Summarize and switch' })).toBeEnabled();
    expect(onNativeModelChanged).not.toHaveBeenCalled();
    expect(onNativeSummaryPending).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc closes only the question; the picker and model stay', async () => {
    bridge(vi.fn().mockResolvedValue({ status: 'needs-summary' }));
    const { onClose, onNativeModelChanged } = renderPicker();
    await pickSmall();
    await screen.findByRole('dialog', { name: 'Switch model' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch model' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(onNativeModelChanged).not.toHaveBeenCalled();
  });

  it('X closes the question too', async () => {
    bridge(vi.fn().mockResolvedValue({ status: 'needs-summary' }));
    const { onNativeModelChanged } = renderPicker();
    await pickSmall();
    await screen.findByRole('dialog', { name: 'Switch model' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Switch model' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch model' })).toBeNull());
    expect(onNativeModelChanged).not.toHaveBeenCalled();
  });

  it('Summarize and switch → summary card, then the switch; its marker ends the card', async () => {
    const switchModel = vi.fn()
      .mockResolvedValueOnce({ status: 'needs-summary' })
      .mockResolvedValueOnce({ status: 'switched', summarized: true });
    bridge(switchModel);
    const { onClose, onNativeModelChanged, onNativeSummaryPending } = renderPicker();
    await pickSmall();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize and switch' }));
    await waitFor(() => expect(onNativeModelChanged).toHaveBeenCalledWith('small-model'));
    expect(switchModel).toHaveBeenLastCalledWith('s1', { providerId: 'cloud', modelId: 'small-model' }, true);
    expect(onNativeSummaryPending.mock.calls).toEqual([['s1', true]]);   // no cancel: the marker ends it
    expect(onClose).toHaveBeenCalled();
  });

  it('a failed summary stays on the current model, says so, and drops the card', async () => {
    bridge(vi.fn()
      .mockResolvedValueOnce({ status: 'needs-summary' })
      .mockResolvedValueOnce({ status: 'failed', reason: 'cannot-fit' }));
    const { onClose, onNativeModelChanged, onNativeSummaryPending } = renderPicker();
    await pickSmall();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize and switch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Even after a summary, the most recent messages are too long for Small Model. Still using Big Model.');
    expect(onNativeSummaryPending.mock.calls).toEqual([['s1', true], ['s1', false]]);
    expect(onNativeModelChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closing while summarizing stops the summary and stays', async () => {
    let finish!: (v: unknown) => void;
    const switchModel = vi.fn()
      .mockResolvedValueOnce({ status: 'needs-summary' })
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { interrupt } = bridge(switchModel);
    const { onNativeModelChanged, onNativeSummaryPending } = renderPicker();
    await pickSmall();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize and switch' }));
    expect(await screen.findByRole('button', { name: 'Summarizing…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Close to stop and stay on Big Model.');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(interrupt).toHaveBeenCalledWith('s1');
    finish({ status: 'failed', reason: 'interrupted' });
    await waitFor(() => expect(onNativeSummaryPending.mock.calls).toEqual([['s1', true], ['s1', false]]));
    expect(onNativeModelChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Switch model' })).toBeNull();
  });
});

describe('switchFailureMessage', () => {
  it('every refusal says the model did not change (except a session that is gone)', () => {
    for (const reason of ['turn-in-flight', 'summary-failed', 'cannot-fit', 'too-small', 'nothing-to-compact', 'error', 'mystery']) {
      expect(switchFailureMessage(reason, 'Big', 'Small')).toContain('Still using Big.');
    }
  });
});
