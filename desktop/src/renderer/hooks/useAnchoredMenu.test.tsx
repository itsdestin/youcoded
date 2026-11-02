// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act, screen } from '@testing-library/react';
import { EscCloseProvider, useDismissTop } from './use-esc-close';
import { useAnchoredMenu } from './useAnchoredMenu';

afterEach(cleanup);

// Android's Back button only reaches things registered on the Esc stack; the header menu used to close on the
// keyboard Escape yet was not on the stack, so Back with it open left the app.
describe('useAnchoredMenu and the Back button', () => {
  it('Back (useDismissTop) closes an open menu', () => {
    let dismiss: () => void = () => {};
    function Menu() {
      const { open, toggle, anchorRef, menuRef } = useAnchoredMenu<HTMLButtonElement>(200);
      dismiss = useDismissTop();
      return (<><button ref={anchorRef} onClick={toggle}>open</button>{open && <div ref={menuRef} role="menu">items</div>}</>);
    }
    render(<EscCloseProvider><Menu /></EscCloseProvider>);
    fireEvent.click(screen.getByText('open'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    act(() => { dismiss(); });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
