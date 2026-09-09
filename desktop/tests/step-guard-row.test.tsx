// @vitest-environment jsdom
import React from 'react';
import * as fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StepGuardRow } from '../src/renderer/components/assistant-settings/pages';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function installNative(getStepGuard: () => Promise<number | null>, setStepGuard = vi.fn(async (value: number | null) => value)) {
  (window as any).claude = { native: { supported: true, getStepGuard, setStepGuard } };
  return setStepGuard;
}

const input = () => screen.getByRole('combobox', { name: 'Step guard' });
const commit = (value: string) => {
  fireEvent.change(input(), { target: { value } });
  fireEvent.keyDown(input(), { key: 'Enter' });
};

afterEach(() => { cleanup(); delete (window as any).claude; });

describe('Assistant Settings — Step guard', () => {
  it('is guarded by native.supported in the General page', () => {
    const source = fs.readFileSync('src/renderer/components/assistant-settings/pages.tsx', 'utf8');
    expect(source).toMatch(/native\.supported === true && <StepGuardRow/);
  });

  it('stays disabled while loading, then shows the stored value', async () => {
    const read = deferred<number | null>();
    installNative(() => read.promise);
    render(<StepGuardRow />);
    expect(input()).toBeDisabled();
    read.resolve(30);
    await waitFor(() => expect(input()).toHaveValue('30'));
    expect(input()).toBeEnabled();
  });

  it('saves explicit None and typed values above 100', async () => {
    const save = installNative(async () => 20);
    render(<StepGuardRow />);
    await waitFor(() => expect(input()).toBeEnabled());
    fireEvent.focus(input());
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(null));
    commit('125');
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(125));
  });

  it('invalid text does not save null and visibly restores the saved value', async () => {
    const save = installNative(async () => 20);
    render(<StepGuardRow />);
    await waitFor(() => expect(input()).toBeEnabled());
    commit('not a number');
    expect(await screen.findByText(/positive whole number/i)).toBeInTheDocument();
    expect(input()).toHaveValue('20');
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('failed read remains disabled and Retry can load it', async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(40);
    installNative(get);
    render(<StepGuardRow />);
    await screen.findByText(/couldn't be loaded/i);
    expect(input()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(input()).toHaveValue('40'));
    expect(input()).toBeEnabled();
  });

  it('failed write rolls back and Retry persists the same intent', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(50);
    installNative(async () => 20, save);
    render(<StepGuardRow />);
    await waitFor(() => expect(input()).toBeEnabled());
    commit('50');
    await screen.findByText(/previous setting is kept/i);
    await waitFor(() => expect(input()).toHaveValue('20'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(input()).toHaveValue('50'));
    expect(save.mock.calls).toEqual([[50], [50]]);
  });

  it('serializes rapid commits and applies the latest intent after the in-flight write', async () => {
    const first = deferred<number | null>();
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(40);
    installNative(async () => 20, save);
    render(<StepGuardRow />);
    await waitFor(() => expect(input()).toBeEnabled());
    commit('30');
    commit('40');
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(30);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls).toEqual([[30], [40]]);
    await waitFor(() => expect(input()).toHaveValue('40'));
  });

  it('does not drop a newer intent when the in-flight write fails', async () => {
    const first = deferred<number | null>();
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(40);
    installNative(async () => 20, save);
    render(<StepGuardRow />);
    await waitFor(() => expect(input()).toBeEnabled());
    commit('30');
    commit('40');
    first.reject(new Error('disk full'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls).toEqual([[30], [40]]);
    await waitFor(() => expect(input()).toHaveValue('40'));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
