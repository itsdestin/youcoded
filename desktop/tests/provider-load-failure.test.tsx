// @vitest-environment jsdom
// A failed read of the model lists must say so, not look like "nothing is set up".
// WHY (error inventory 2026-09-10, rows 33 and the new-session form): both surfaces turned a
// failed read into two empty lists. The new-session form then kept Create greyed out with no
// reason; Assistant settings' "Default model" row judged the saved default against empty lists.
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { useNativeBinding, NativeExtras } from '../src/renderer/components/RuntimeBinding';
import { useAvailabilityData } from '../src/renderer/components/model/availability';
import { DESKTOP_WINDOW_CAPABILITIES } from '../src/shared/capabilities';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Host() {
  const [binding, setBinding] = useState<any>(null);
  const nb = useNativeBinding({ active: true, runtime: 'native', binding, setBinding });
  return <NativeExtras nb={nb} preset="assistant" onPreset={() => {}} />;
}

describe('new-session form when the model lists will not load', () => {
  it('says why Create is unavailable and offers Try again, which asks again', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue([{ id: 'local', name: 'Local', ready: true, type: 'local-engine' }]);
    (globalThis as any).window.claude = {
      capabilities: DESKTOP_WINDOW_CAPABILITIES,
      native: { supported: true },
      providers: { list, catalog: vi.fn().mockResolvedValue([]) },
      models: { memoryCheck: vi.fn().mockResolvedValue(null) },
    };
    render(<Host />);
    await waitFor(() => expect(screen.getByText(/Couldn't load your models/)).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    await waitFor(() => expect(screen.queryByText(/Couldn't load your models/)).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
  });
});

function Probe() {
  const a = useAvailabilityData();
  return <div data-testid="p">{a.loaded ? 'loaded' : 'not-loaded'}</div>;
}

describe('Default model row when the model lists will not load', () => {
  it('never reports the lists as loaded, so nothing is judged from empty lists', async () => {
    (globalThis as any).window.claude = {
      providers: { list: vi.fn().mockRejectedValue(new Error('nope')), catalog: vi.fn().mockResolvedValue([]) },
      claudeAccount: undefined,
    };
    render(<Probe />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('p').textContent).toBe('not-loaded');
  });
});
