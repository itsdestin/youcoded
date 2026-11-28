// @vitest-environment jsdom
// Coming back to a local chat whose model went to sleep (review deck Q-6, 2026-11-12).
import React, { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useReturnWarm, type ReturnWarmInput } from './use-return-warm';

afterEach(cleanup);

type P = Partial<Omit<ReturnWarmInput, 'rootRef' | 'load'>>;
function Harness(props: P & { load: ReturnWarmInput['load'] }) {
  const ref = useRef<HTMLDivElement>(null);
  useReturnWarm({ rootRef: ref, sessionId: 's1', visible: true, modelId: 'm', modelState: 'sleeping',
    everResident: true, isThinking: false, ...props });
  return <div ref={ref} data-testid="root"><textarea data-testid="box" /></div>;
}

describe('useReturnWarm', () => {
  it('asks once when the user clicks back into a chat whose model is asleep', () => {
    const load = vi.fn();
    const { getByTestId } = render(<Harness load={load} />);
    expect(load).not.toHaveBeenCalled();   // nothing until the user does something
    fireEvent.pointerDown(getByTestId('root'));
    fireEvent.keyDown(getByTestId('box'), { key: 'a' });
    fireEvent.focusIn(getByTestId('box'));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('m', 's1');
  });
  it('asks when typing starts', () => {
    const load = vi.fn();
    const { getByTestId } = render(<Harness load={load} modelState="unloaded" />);
    fireEvent.keyDown(getByTestId('box'), { key: 'h' });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('asks when the user switches to the chat', () => {
    const load = vi.fn();
    const { rerender } = render(<Harness load={load} visible={false} />);
    expect(load).not.toHaveBeenCalled();
    rerender(<Harness load={load} visible />);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('asks again only after the model has been loaded and gone to sleep again', () => {
    const load = vi.fn();
    const { getByTestId, rerender } = render(<Harness load={load} />);
    fireEvent.pointerDown(getByTestId('root'));
    rerender(<Harness load={load} modelState="loading" />);
    rerender(<Harness load={load} modelState="loaded" />);
    fireEvent.pointerDown(getByTestId('root'));
    expect(load).toHaveBeenCalledTimes(1);
    rerender(<Harness load={load} modelState="sleeping" />);
    fireEvent.pointerDown(getByTestId('root'));
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['a brand-new chat (main warms it as it opens)', { everResident: false }],
    ['a reply is running', { isThinking: true }],
    ['the model is loaded', { modelState: 'loaded' as const }],
    ['a cloud chat', { modelId: null, modelState: null }],
    ['the chat is hidden', { visible: false }],
  ])('does nothing when %s', (_n, props) => {
    const load = vi.fn();
    const { getByTestId } = render(<Harness load={load} {...props} />);
    fireEvent.pointerDown(getByTestId('root'));
    fireEvent.keyDown(getByTestId('box'), { key: 'a' });
    expect(load).not.toHaveBeenCalled();
  });
});
