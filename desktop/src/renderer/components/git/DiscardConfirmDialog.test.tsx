// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { EscCloseProvider, useEscClose } from '../../hooks/use-esc-close';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Dialog now joins the shared useEscClose LIFO stack (see WHY comment in
// DiscardConfirmDialog.tsx), so it needs the provider mounted to receive ESC
// at all — matches how the real app always wraps everything in one
// EscCloseProvider at the App root.
function renderDialog(props: Partial<React.ComponentProps<typeof DiscardConfirmDialog>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  const utils = render(
    <EscCloseProvider>
      <DiscardConfirmDialog
        fileName="f.ts"
        willTrash={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />
    </EscCloseProvider>,
  );
  return { ...utils, onConfirm, onCancel };
}

function pressEsc() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

describe('DiscardConfirmDialog', () => {
  it('tracked copy states exactly what is restored and confirm fires', () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });
    expect(screen.getByText(/Restore “f.ts” to its last committed state\?/)).toBeInTheDocument();
    expect(screen.getByText(/uncommitted edits to this file will be lost/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revert changes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('never-committed copy says trash, not restore', () => {
    renderDialog({ fileName: 'new.ts', willTrash: true });
    expect(screen.getByText(/Move “new.ts” to the system trash\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to trash' })).toBeInTheDocument();
  });

  it('cancel and Escape both close without confirming', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    pressEsc();
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // Regression for the Critical review finding (Task 9): a dialog-local
  // capture-phase `stopPropagation()` listener does NOT stop the app's other
  // capture-phase window listener (EscCloseProvider) from also firing — only
  // stopImmediatePropagation would, and even that depends on registration
  // order, which favors the provider since it mounts once at App root before
  // any dialog exists. Concretely: pressing Escape while this dialog is open
  // used to ALSO fire SessionDrawer's useEscClose(drawerOpen, handleBack),
  // collapsing the whole git review underneath the dialog. This test stands
  // in a registered ESC consumer (simulating the drawer) beneath the dialog
  // and asserts only the dialog's onCancel fires on a single Escape press.
  it('does not let an underlying useEscClose consumer fire — the dialog is top of stack', () => {
    const onCancel = vi.fn();
    const underlyingClose = vi.fn(); // stands in for SessionDrawer's handleBack
    function UnderlyingConsumer() {
      useEscClose(true, underlyingClose);
      return null;
    }
    render(
      <EscCloseProvider>
        <UnderlyingConsumer />
        <DiscardConfirmDialog fileName="f.ts" willTrash={false} onConfirm={() => {}} onCancel={onCancel} />
      </EscCloseProvider>,
    );
    pressEsc();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(underlyingClose).not.toHaveBeenCalled();
  });
});
