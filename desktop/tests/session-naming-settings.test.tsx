// @vitest-environment jsdom
//
// The Session naming card's write behaviour. Destin reported a "weird
// flicker/jitter" switching Off/Basic/AI: the card painted the OLD choice plus
// a loading row until the write came back. These pin the optimistic shape that
// replaced it, and the failure handling that shape must not lose.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import SessionNaming from '../src/renderer/components/assistant-settings/SessionNaming';

afterEach(cleanup);

function bridge(set: (v: unknown) => Promise<void>) {
  (window as any).claude = {
    sessionNaming: {
      get: async () => ({ mode: 'basic', model: null }),
      set,
      title: async () => ({ title: '', manual: false }),
      rename: async () => {},
    },
    // The model picker the AI mode reveals asks for these.
    native: { supported: false },
    providers: { list: async () => [], catalog: async () => [] },
  };
}

const tab = (name: string) => screen.getByRole('tab', { name });
const selected = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!;

beforeEach(() => { vi.clearAllMocks(); });

describe('Session naming settings card', () => {
  it('paints the new choice immediately, before the write comes back', async () => {
    let release: () => void = () => {};
    const set = vi.fn(() => new Promise<void>((r) => { release = () => r(); }));
    bridge(set);
    render(<SessionNaming />);
    await screen.findByRole('tab', { name: 'Basic' });

    await act(async () => { fireEvent.click(tab('Off')); });
    // The whole point: chosen NOW, not when the disk write answers.
    expect(selected().textContent).toBe('Off');
    expect(set).toHaveBeenCalledWith({ mode: 'off', model: null });
    await act(async () => { release(); });
    expect(selected().textContent).toBe('Off');
  });

  it('shows nothing extra while the write runs, and disables nothing', async () => {
    // A row that appears and disappears between the heading and the tabs is
    // what pushed the card around on every click.
    let release: () => void = () => {};
    bridge(vi.fn(() => new Promise<void>((r) => { release = () => r(); })));
    render(<SessionNaming />);
    await screen.findByRole('tab', { name: 'Basic' });
    await act(async () => { fireEvent.click(tab('Off')); });
    // The one-line explainer under the tabs DOES change with the mode — that is
    // the setting describing itself, not a flicker. What must not appear is a
    // progress row, and nothing may go disabled and back.
    expect(screen.queryByText(/your naming settings/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Loading|Saving/i);
    expect(screen.getAllByRole('tab').every((t) => !t.hasAttribute('disabled'))).toBe(true);
    await act(async () => { release(); });
  });

  it('puts the previous choice back when the write is refused, and offers Retry', async () => {
    const set = vi.fn().mockRejectedValue(new Error('Settings were not saved.'));
    bridge(set);
    render(<SessionNaming />);
    await screen.findByRole('tab', { name: 'Basic' });

    await act(async () => { fireEvent.click(tab('Off')); });
    expect(selected().textContent).toBe('Basic');
    expect(screen.getByText('Settings were not saved.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('a second click wins over the first one failing', async () => {
    // Without the queue, the failed request's revert would also discard the
    // newer choice the user had already made.
    const calls: string[] = [];
    let failFirst = true;
    const set = vi.fn(async (v: any) => {
      calls.push(v.mode);
      if (failFirst) { failFirst = false; throw new Error('nope'); }
    });
    bridge(set);
    render(<SessionNaming />);
    await screen.findByRole('tab', { name: 'Basic' });

    await act(async () => {
      fireEvent.click(tab('Off'));
      fireEvent.click(tab('AI'));
    });
    expect(calls).toEqual(['off', 'ai']);
    expect(selected().textContent).toBe('AI');
    expect(screen.queryByText('nope')).toBeNull();
  });

  it('names the naming-model default in the picker, not above it', async () => {
    bridge(vi.fn(async () => {}));
    render(<SessionNaming />);
    await screen.findByRole('tab', { name: 'Basic' });
    await act(async () => { fireEvent.click(tab('AI')); });
    expect(screen.getByText('Naming model')).toBeTruthy();
    expect(document.body.textContent).toContain('Same as Conversation (default)');
    // The old pair — a label above saying default, a control below asking for
    // a choice already made.
    expect(document.body.textContent).not.toContain('Choose a model');
    expect(document.body.textContent).not.toContain('Conversation model (default)');
  });
});
