// @vitest-environment jsdom
// The shared popup's Enter-to-confirm and its pinned footer (`<Dialog onEnter footer>`).
// Each case is a way the close prompt's hand-made Enter listener went wrong.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { EscCloseProvider } from './use-esc-close';
import { Dialog } from '../components/ui/Dialog';

afterEach(cleanup);

function Popups({ onEnter, busy = false }: { onEnter: () => void; busy?: boolean }) {
  const [top, setTop] = useState(false);
  return (
    <EscCloseProvider>
      <Dialog open onClose={() => {}} title="Close session" onEnter={onEnter} busy={busy} noScreen="test"
        footer={<button type="button">Close session</button>}>
        <button type="button" onClick={() => setTop(true)}>Open another</button>
        <input aria-label="Note" />
      </Dialog>
      {top && <Dialog open onClose={() => setTop(false)} title="Rename session" noScreen="test"><p>on top</p></Dialog>}
    </EscCloseProvider>
  );
}
const enter = (target: Element | Window = window, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: 'Enter', ...init });

describe('Dialog onEnter', () => {
  it('Enter from outside any control confirms, once', () => {
    const onEnter = vi.fn();
    render(<Popups onEnter={onEnter} />);
    enter(document.body);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('a popup stacked on top takes Enter away from the one under it, and gives it back on close', () => {
    const onEnter = vi.fn();
    render(<Popups onEnter={onEnter} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    expect(screen.getByText('on top')).toBeInTheDocument();
    enter(document.body);
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' }); // closes the top popup only
    expect(screen.queryByText('on top')).toBeNull();
    enter(document.body);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('a focused control or a text box keeps its own Enter', () => {
    const onEnter = vi.fn();
    render(<Popups onEnter={onEnter} />);
    enter(screen.getByRole('button', { name: 'Close session' }));
    enter(screen.getByRole('textbox', { name: 'Note' }));
    enter(document.body, { shiftKey: true });
    enter(document.body, { repeat: true });
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('never fires while the popup is busy', () => {
    const onEnter = vi.fn();
    render(<Popups onEnter={onEnter} busy />);
    enter(document.body);
    expect(onEnter).not.toHaveBeenCalled();
  });
});

describe('Dialog footer', () => {
  it('sits outside the scrolling body, after it, so it never scrolls away', () => {
    render(<Popups onEnter={() => {}} />);
    const footerButton = screen.getByRole('button', { name: 'Close session' });
    const body = screen.getByRole('button', { name: 'Open another' }).closest('.scroll-fade')!;
    expect(body).not.toContainElement(footerButton);
    expect(body.compareDocumentPosition(footerButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
