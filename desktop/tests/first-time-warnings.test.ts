// @vitest-environment jsdom
// first-time-warnings.test.ts
// The data half of the first-time warnings (spec: docs/active/specs/
// 2026-09-10-first-run-guide-design.md §1 item 7, §4, §5): which models count
// as "small", and the once-only acknowledgement flag.
//
// jsdom here ships NO localStorage (the same gap buddy-linux-migration.test.ts
// documents), so a real Map-backed one is supplied rather than mocking the
// thing under test. The docblock on line 1 is needed because the module pulls
// in PermissionsSection (for the verbatim always-asks list), whose imports
// expect a DOM.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const store = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', {
    value: localStorageShim, configurable: true, writable: true,
  });
}

import {
  hasAcknowledged,
  isSmallModel,
  markAcknowledged,
  parseParamCountB,
  warnedKey,
  WARNING_COPY,
} from '../src/renderer/components/first-time-warnings';
import { ALWAYS_ASKS } from '../src/renderer/components/PermissionsSection';
import { FirstTimeWarning, useFirstTimeGate } from '../src/renderer/components/FirstTimeWarning';

describe('isSmallModel', () => {
  it('reads a parameter count of 40B or fewer out of the id', () => {
    expect(isSmallModel({ modelId: 'qwen3-32b' })).toBe(true);
    expect(isSmallModel({ modelId: 'gemma-3-27b-it' })).toBe(true);
    expect(isSmallModel({ modelId: 'llama-3.1-8B-instruct' })).toBe(true);
    expect(isSmallModel({ modelId: 'phi-4-mini-3.8b' })).toBe(true);
  });

  it('is false above 40B', () => {
    expect(isSmallModel({ modelId: 'llama-3.3-70b' })).toBe(false);
    expect(isSmallModel({ modelId: 'qwen3-235b-a22b' })).toBe(false);
  });

  it('counts a MoE name by its first (total) number', () => {
    expect(isSmallModel({ modelId: 'qwen3-30b-a3b' })).toBe(true);
    expect(parseParamCountB('qwen3-235b-a22b')).toBe(235);
  });

  it('does not mistake other letters-and-digits for a count', () => {
    // "3b" inside "llama3b" is preceded by a letter, so it is not a count;
    // nor is "b" in "instruct" or the "3" in "gemma-3".
    expect(parseParamCountB('llama3-instruct')).toBeNull();
    expect(parseParamCountB('gemma-3-it')).toBeNull();
    expect(parseParamCountB('gpt-4.1')).toBeNull();
  });

  it('falls back to the label when the id names no size', () => {
    expect(isSmallModel({ modelId: 'my-local-model', modelLabel: 'Qwen 3 14B' })).toBe(true);
    expect(isSmallModel({ modelId: 'my-local-model', modelLabel: 'Llama 3.3 70B' })).toBe(false);
  });

  it('falls back to the local file size only when no name carries a count', () => {
    expect(isSmallModel({ modelId: 'claude-sonnet', localSizeBytes: 20e9 })).toBe(true);
    expect(isSmallModel({ modelId: 'claude-sonnet', localSizeBytes: 45e9 })).toBe(false);
    // A name with a count wins over the file size in both directions.
    expect(isSmallModel({ modelId: 'llama-3.3-70b', localSizeBytes: 20e9 })).toBe(false);
    expect(isSmallModel({ modelId: 'qwen3-32b', localSizeBytes: 45e9 })).toBe(true);
  });

  it('is false with no size anywhere (Claude aliases, cloud models)', () => {
    expect(isSmallModel({ modelId: 'claude-sonnet' })).toBe(false);
    expect(isSmallModel({ modelId: 'sonnet' })).toBe(false);
    expect(isSmallModel({})).toBe(false);
    expect(isSmallModel({ modelId: 'x', localSizeBytes: Number.NaN })).toBe(false);
  });
});

describe('acknowledgement flag', () => {
  beforeEach(() => { store.clear(); });

  it('round-trips through localStorage under youcoded-warned-<kind>', () => {
    expect(hasAcknowledged('skip-permissions')).toBe(false);
    markAcknowledged('skip-permissions');
    expect(hasAcknowledged('skip-permissions')).toBe(true);
    expect(store.get(warnedKey('skip-permissions'))).toBe('1');
    expect(warnedKey('skip-permissions')).toBe('youcoded-warned-skip-permissions');
  });

  it('keeps the three kinds separate', () => {
    markAcknowledged('full-auto');
    expect(hasAcknowledged('full-auto')).toBe(true);
    expect(hasAcknowledged('skip-permissions')).toBe(false);
    expect(hasAcknowledged('small-model')).toBe(false);
  });

  it('only accepts the exact "1" marker', () => {
    store.set(warnedKey('small-model'), 'yes');
    expect(hasAcknowledged('small-model')).toBe(false);
  });

  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    Object.defineProperty(globalThis, 'localStorage', { value: broken, configurable: true, writable: true });
    try {
      expect(hasAcknowledged('full-auto')).toBe(false);
      expect(() => markAcknowledged('full-auto')).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: localStorageShim, configurable: true, writable: true });
    }
  });
});

// Render half. `globals` is off in vitest.config.ts, so testing-library never
// finds an afterEach to auto-unmount — cleanup is explicit (same note as
// permissions-section.test.tsx).
describe('<FirstTimeWarning>', () => {
  afterEach(cleanup);

  it('holds Continue until the box is ticked, and Cancel never continues', () => {
    const onCancel = vi.fn();
    const onContinue = vi.fn();
    render(React.createElement(FirstTimeWarning, { kind: 'skip-permissions', open: true, onCancel, onContinue }));

    expect(screen.getByRole('dialog', { name: 'Before you turn on Skip Permissions' })).toBeTruthy();
    for (const line of WARNING_COPY['skip-permissions'].body) expect(screen.getByText(line)).toBeTruthy();

    const go = screen.getByRole('button', { name: 'Turn it on' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(go.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('lists the always-asks items on the Full auto warning', () => {
    render(React.createElement(FirstTimeWarning, { kind: 'full-auto', open: true, onCancel: () => {}, onContinue: () => {} }));
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([...ALWAYS_ASKS]);
    expect(screen.getByRole('button', { name: 'Use Full auto' })).toBeTruthy();
  });

  it('the small-model explainer has no checkbox and Got it is live at once', () => {
    const onContinue = vi.fn();
    render(React.createElement(FirstTimeWarning, { kind: 'small-model', open: true, onCancel: () => {}, onContinue }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    const go = screen.getByRole('button', { name: 'Got it' }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('useFirstTimeGate', () => {
  beforeEach(() => { store.clear(); });
  afterEach(cleanup);

  function Host({ kind, proceed, onShow, onSettle }: {
    kind: 'skip-permissions' | 'small-model'; proceed: () => void; onShow?: () => void; onSettle?: () => void;
  }) {
    const { gate, dialog } = useFirstTimeGate(kind, { onShow, onSettle });
    return React.createElement(React.Fragment, null,
      React.createElement('button', { onClick: () => gate(proceed) }, 'try'),
      dialog,
    );
  }

  it('runs the action at once when already acknowledged, without a dialog', () => {
    markAcknowledged('small-model');
    const proceed = vi.fn();
    const onShow = vi.fn();
    render(React.createElement(Host, { kind: 'small-model', proceed, onShow }));
    fireEvent.click(screen.getByText('try'));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(onShow).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('otherwise shows the dialog; Cancel does nothing and leaves the flag unset', () => {
    const proceed = vi.fn();
    const onShow = vi.fn();
    const onSettle = vi.fn();
    render(React.createElement(Host, { kind: 'skip-permissions', proceed, onShow, onSettle }));
    fireEvent.click(screen.getByText('try'));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(proceed).not.toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(hasAcknowledged('skip-permissions')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Continue runs the action once, records the flag, and never asks again', () => {
    const proceed = vi.fn();
    const onSettle = vi.fn();
    render(React.createElement(Host, { kind: 'skip-permissions', proceed, onSettle }));
    fireEvent.click(screen.getByText('try'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(hasAcknowledged('skip-permissions')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Second attempt: straight through.
    fireEvent.click(screen.getByText('try'));
    expect(proceed).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('copy', () => {
  it('the two dangerous kinds carry the checkbox; the small-model explainer does not', () => {
    expect(WARNING_COPY['skip-permissions'].checkbox).toBeTruthy();
    expect(WARNING_COPY['full-auto'].checkbox).toBeTruthy();
    expect(WARNING_COPY['small-model'].checkbox).toBeUndefined();
  });

  it('Full auto repeats the Permissions page always-asks list verbatim', () => {
    expect(WARNING_COPY['full-auto'].bullets).toEqual(ALWAYS_ASKS);
    expect(ALWAYS_ASKS.length).toBeGreaterThan(0);
  });
});
