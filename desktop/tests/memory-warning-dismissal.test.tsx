// @vitest-environment jsdom
// The "Warn me about this model" tick, end to end through the bridge.
//
// WHY it needs its own test: the tick is the ONLY consumer of
// models.setSettings' `dismissMemoryWarning` signal, and every way it can be
// wrong looks identical on screen — the box moves either way. Mutating the
// value sent to always-`true` (so unticking never clears the dismissal) left
// the whole suite green before this file existed.
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { useNativeBinding, NativeExtras } from '../src/renderer/components/RuntimeBinding';

const TIGHT = { verdict: 'tight', headline: 'Needs about 9.5 GB; 11.0 GB free.', detail: '' };

function bridge(setSettings: any) {
  (globalThis as any).window.claude = {
    // The hook hides the whole native selector unless main says the native
    // runtime is available, so the warning card never mounts without this.
    native: { supported: true },
    providers: {
      list: vi.fn().mockResolvedValue([{ id: 'local', name: 'Local', ready: true, type: 'local-engine' }]),
      catalog: vi.fn().mockResolvedValue([{ id: 'alpha', providerId: 'local', name: 'Alpha' }]),
    },
    models: { memoryCheck: vi.fn().mockResolvedValue(TIGHT), setSettings },
  };
}

/** The smallest host that renders the warning card the way both new-session
 *  forms do: the hook, then the extras it returns. */
function Host() {
  const [binding, setBinding] = useState<any>({ providerId: 'local', modelId: 'alpha' });
  const nb = useNativeBinding({ active: true, runtime: 'native', binding, setBinding });
  return <NativeExtras nb={nb} preset="assistant" onPreset={() => {}} />;
}

async function openTheWarning() {
  render(<Host />);
  await waitFor(() => expect(screen.getByText('This model may not fit in available memory')).toBeTruthy());
  await act(async () => { fireEvent.click(screen.getByText('This model may not fit in available memory')); });
  await waitFor(() => expect(screen.getByLabelText('Warn me about this model')).toBeTruthy());
}

beforeEach(() => { (globalThis as any).window = (globalThis as any).window ?? {}; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('“Warn me about this model”', () => {
  it('sends true when the user turns the warning OFF and false when they turn it back ON', async () => {
    const setSettings = vi.fn().mockResolvedValue({});
    bridge(setSettings);
    await openTheWarning();

    // Turning the warning off = "don't warn me again".
    await act(async () => { fireEvent.click(screen.getByLabelText('Warn me about this model')); });
    expect(setSettings).toHaveBeenLastCalledWith('alpha', { dismissMemoryWarning: true });

    // Turning it back on has to UNDO that. Before this was wired, re-enabling
    // the warning only changed what was on screen: the model stayed silenced.
    await act(async () => { fireEvent.click(screen.getByLabelText('Warn me about this model')); });
    expect(setSettings).toHaveBeenLastCalledWith('alpha', { dismissMemoryWarning: false });
  });

  it('a save that fails says so and puts the tick back where it really is', async () => {
    // On a phone this is every time: there is no local engine to remember
    // anything, so the bridge rejects.
    const setSettings = vi.fn().mockRejectedValue(new Error('remote-unsupported: models:set-settings'));
    bridge(setSettings);
    await openTheWarning();

    // The Toggle primitive is a button carrying aria-checked, not an <input>.
    const toggle = () => screen.getByLabelText('Warn me about this model');
    expect(toggle().getAttribute('aria-checked')).toBe('true');   // warning on to begin with
    await act(async () => { fireEvent.click(toggle()); });

    await waitFor(() => expect(screen.getByText(
      "The local model manager isn't available via remote access yet.",
    )).toBeTruthy());
    // Not left showing a preference nothing stored.
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});

describe('the warning is drawn in the theme-derived amber (contract R30)', () => {
  it('the closed warning line asks the theme for its amber instead of hard-coding one', async () => {
    // WHY a class assertion and not a colour: jsdom has no theme engine, so the
    // pixel cannot be measured here. What CAN be pinned is that this line reads
    // its colour from `--warning-fg`, which theme-engine.ts derives per theme —
    // the readability itself is pinned in warning-color-readable.test.ts. The
    // pair is the guard; either half alone passes with the bug in place.
    const setSettings = vi.fn().mockResolvedValue({});
    bridge(setSettings);
    render(<Host />);
    await waitFor(() => expect(screen.getByText('This model may not fit in available memory')).toBeTruthy());
    const line = screen.getByText('This model may not fit in available memory');
    expect(line.className, 'uses the derived warning colour').toContain('text-warning-fg');
    expect(line.className, 'no fixed amber left in it').not.toMatch(/amber/);
  });
});
