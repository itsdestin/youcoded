// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSaveNotice } from '../src/renderer/hooks/useSaveNotice';

afterEach(cleanup);

// A one-toggle popup built on the hook, the way PreferencesPopup / PerformancePopup / AboutPopup use it.
function Harness({ open, save }: { open: boolean; save: (v: boolean) => Promise<unknown> }) {
  const { run, notice } = useSaveNotice(open);
  const [on, setOn] = useState(false);
  const [saved, setSaved] = useState(false);
  const toggle = (v: boolean) => {
    setOn(v);
    void run('t', 'the toggle', async () => { const r = await save(v); if (r !== false) setSaved(v); return r; }, () => setOn(saved), () => toggle(v));
  };
  return (
    <div>
      <button onClick={() => toggle(!on)}>flip</button>
      <span data-testid="value">{String(on)}</span>
      {notice('t')}
    </div>
  );
}
const deferred = () => { let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('save notices for small settings', () => {
  it('shows nothing while a save is merely slow, and nothing when it succeeds', async () => {
    const d = deferred();
    render(<Harness open save={() => d.promise} />);
    fireEvent.click(screen.getByText('flip'));
    expect(screen.getByTestId('value')).toHaveTextContent('true');
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
    await act(async () => { d.resolve(true); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  });

  it.each([
    ['resolves false', () => Promise.resolve(false)],
    ['answers ok:false', () => Promise.resolve({ ok: false, error: 'disk full' })],
    ['rejects', () => Promise.reject(new Error('disk full'))],
  ])('a save that %s snaps the control back and shows a notice with Try again', async (_n, save) => {
    render(<Harness open save={save as () => Promise<unknown>} />);
    fireEvent.click(screen.getByText('flip'));
    expect(await screen.findByText("Couldn't save the toggle")).toBeInTheDocument();
    expect(screen.getByTestId('value')).toHaveTextContent('false'); // back to the true (saved) value
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('Try again that succeeds clears the notice and applies the value', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<Harness open save={save} />);
    fireEvent.click(screen.getByText('flip'));
    await screen.findByText("Couldn't save the toggle");
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(screen.queryByText(/Couldn't save/)).toBeNull());
    expect(screen.getByTestId('value')).toHaveTextContent('true');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a later successful save of the same control clears the notice', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<Harness open save={save} />);
    fireEvent.click(screen.getByText('flip'));
    await screen.findByText("Couldn't save the toggle");
    await act(async () => { fireEvent.click(screen.getByText('flip')); });
    await waitFor(() => expect(screen.queryByText(/Couldn't save/)).toBeNull());
  });

  it('closing the popup clears the notice, and reopening shows none', async () => {
    const { rerender } = render(<Harness open save={() => Promise.resolve(false)} />);
    fireEvent.click(screen.getByText('flip'));
    await screen.findByText("Couldn't save the toggle");
    rerender(<Harness open={false} save={() => Promise.resolve(false)} />);
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
    rerender(<Harness open save={() => Promise.resolve(false)} />);
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  });

  it('a failure that arrives after the popup closed raises no notice (no false alarm from a late result)', async () => {
    const d = deferred();
    const { rerender } = render(<Harness open save={() => d.promise} />);
    fireEvent.click(screen.getByText('flip'));
    rerender(<Harness open={false} save={() => d.promise} />);
    rerender(<Harness open save={() => d.promise} />);
    await act(async () => { d.resolve(false); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  });

  it('a failure after the component unmounted does not throw or warn', async () => {
    const d = deferred();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<Harness open save={() => d.promise} />);
    fireEvent.click(screen.getByText('flip'));
    unmount();
    await act(async () => { d.reject(new Error('late')); });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an older save that fails after a newer save of the same control succeeded is ignored', async () => {
    const first = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
    render(<Harness open save={save} />);
    fireEvent.click(screen.getByText('flip'));
    await act(async () => { fireEvent.click(screen.getByText('flip')); });
    await act(async () => { first.resolve(false); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  });
});
