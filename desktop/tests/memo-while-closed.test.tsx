// @vitest-environment jsdom
// memoWhileClosed: a surface that is mounted all the time but only visible while `open`.
// While closed it ignores every prop change (the shell hands it fresh callbacks on every
// render); the moment `open` flips either way it renders with the current props.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { memoWhileClosed } from '../src/renderer/components/memo-while-closed';

function setup() {
  let renders = 0;
  const Panel = memoWhileClosed(function Panel({ open, label }: { open: boolean; label: string; onClose: () => void }) {
    renders++;
    return <div data-testid="p">{open ? label : 'closed'}</div>;
  });
  const view = (open: boolean, label: string) => <Panel open={open} label={label} onClose={() => {}} />;
  return { view, renders: () => renders };
}

describe('memoWhileClosed', () => {
  it('does not render again for new props or new callbacks while closed', () => {
    const t = setup();
    const { rerender } = render(t.view(false, 'a'));
    expect(t.renders()).toBe(1);
    rerender(t.view(false, 'b'));
    rerender(t.view(false, 'c'));
    expect(t.renders()).toBe(1);
  });

  it('opens showing the CURRENT props, and renders the closing frame', () => {
    const t = setup();
    const { rerender, getByTestId } = render(t.view(false, 'a'));
    rerender(t.view(false, 'b'));
    rerender(t.view(true, 'c'));
    expect(getByTestId('p').textContent).toBe('c');
    rerender(t.view(false, 'c'));
    expect(getByTestId('p').textContent).toBe('closed');
    expect(t.renders()).toBe(3);
  });

  it('while open, behaves like React.memo: same props skip, a new callback renders', () => {
    let renders = 0;
    const Panel = memoWhileClosed(function Panel({ open }: { open: boolean; onClose: () => void }) {
      renders++;
      return <i>{String(open)}</i>;
    });
    const onClose = () => {};
    const { rerender } = render(<Panel open onClose={onClose} />);
    rerender(<Panel open onClose={onClose} />);
    expect(renders).toBe(1);
    rerender(<Panel open onClose={() => {}} />);
    expect(renders).toBe(2);
  });
});
