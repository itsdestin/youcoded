// @vitest-environment jsdom
// Pins the approved Deliverables card (spec §2) plus Destin's 2026-08-25
// follow-up fixes: the card mounts CLOSED like a tool card (Ctrl+O still
// seeds it open/closed in both directions), its header carries the same "|"
// separator a tool card header does, and a failed tile shows the TOOL's own
// error text — never a hard-coded guess (error-message rule).
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { ToolCallState } from '../src/shared/types';

// The card is under test, not the preview: ArtifactThumbnail does IPC.
vi.mock('../src/renderer/components/ArtifactThumbnail', () => ({
  ArtifactThumbnail: () => <div data-testid="thumb" />,
}));

import { DeliverablesCard } from '../src/renderer/components/DeliverablesCard';
import { broadcastCollapseAll, broadcastExpandAll } from '../src/renderer/hooks/useExpandAllToggle';

// jsdom has neither matchMedia (useNarrowViewport) nor ResizeObserver (fades).
function setViewport(narrow: boolean) {
  (window as any).matchMedia = (query: string) => ({
    matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {},
  });
}
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const call = (id: string, files: string[], extra: Partial<ToolCallState> = {}): ToolCallState => ({
  toolUseId: id, toolName: 'SendUserFile', input: { files, status: 'normal' }, status: 'complete', ...extra,
});

afterEach(cleanup);

describe('DeliverablesCard', () => {
  it('mounts CLOSED, and a header click reveals one tile per file', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/docs/a.md', '/tmp/b.png'])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(2);
    expect(screen.getByText('a.md')).toBeInTheDocument();
    expect(screen.getByText('/tmp/')).toBeInTheDocument(); // external folder shown absolute
  });

  it('renders the | separator between the glyph and the "Deliverables" label, like a tool card', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'])]} sessionId="s" />);
    const label = screen.getByText('Deliverables');
    const sep = label.previousElementSibling;
    expect(sep).toHaveTextContent('|');
    expect(sep?.className).toContain('select-none');
  });

  it('header click on an expanded card collapses it back to one line', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'], { input: { files: ['/p/a.md'], caption: 'the report' } })]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables')); // open first — the card mounts closed now
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Deliverables')); // then close it again
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    expect(screen.getByText('the report')).toBeInTheDocument(); // caption survives in the header
  });

  it('merges several calls: files concatenate, captions stack under the strip', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[
      call('t1', ['/p/a.md'], { input: { files: ['/p/a.md'], caption: 'first' } }),
      call('t2', ['/p/b.md', '/p/c.md'], { input: { files: ['/p/b.md', '/p/c.md'], caption: 'second' } }),
    ]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(3);
    expect(screen.getByText('first').tagName).toBe('P');
    expect(screen.getByText('second').tagName).toBe('P');
  });

  it("a failed tile shows the tool's own error text, never a fixed guess", () => {
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    // No header click: a failed call now seeds the card open (Finding 2 fix)
    // — see the dedicated "mounts OPEN" test below for that behavior itself.
    render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    expect(screen.getByText(/is a directory/)).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).toBeNull();
    expect(screen.getByTestId('sent-file-tile')).toHaveAttribute('data-hint', expect.stringContaining('is a directory'));
  });

  it('a failed tile with NO error text names the path and invents no cause', () => {
    // The repo guard (status-strip-authority.test.tsx) scans for the SHAPE
    // `someError || 'a guess'`. This pins the behaviour behind it: when the tool
    // gave us no reason, the tooltip must say nothing about WHY. The overlay
    // already tells the user it failed (docs/error-message-standards.md).
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed' })]} sessionId="s" />);
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    const tile = screen.getByTestId('sent-file-tile');
    expect(tile).toHaveAttribute('data-hint', '/tmp/out');
    expect(tile.getAttribute('data-hint')).not.toMatch(/could not|couldn|failed|not found|—/i);
  });

  it('a running call shows Sending…', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'], { status: 'running' })]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });

  it('a card whose only call failed mounts OPEN and shows the error text without any click (Finding 2 fix)', () => {
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    // No click on the header — a failure must be visible on first paint.
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    expect(screen.getByText(/is a directory/)).toBeInTheDocument();
  });

  it('a card whose calls all succeeded still mounts collapsed', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
  });

  it('a failure arriving mid-flight (running -> failed on the SAME instance) opens the card with no click', () => {
    // This is the live-delivery path, not replay: the card mounts while the
    // call is still 'running' (hasFailure false at first render, so the
    // mount-time seed alone would miss it), then the SAME tool entry flips to
    // 'failed' on a later render — exactly what chat-reducer does when a
    // result arrives. `rerender` keeps the component instance so this can
    // only pass via the live effect, never the mount seed. A fresh `render`
    // per status would reproduce the replay case and pass against the broken
    // seed-only code — the trap the rest of this suite fell into.
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    const { rerender } = render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'running' })]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    rerender(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    expect(screen.getByText(/is a directory/)).toBeInTheDocument();
  });

  it('a card the mid-flight failure opened can still be collapsed by the user, and stays collapsed', () => {
    // Pins the transition guard (wasFailed ref): once hasFailure has already
    // gone true, a LATER re-render for an unrelated reason (here, a caption
    // showing up) must not force `open` back on and undo the user's click.
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    const { rerender } = render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'running' })]} sessionId="s" />);
    rerender(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Deliverables')); // user collapses it
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    rerender(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err, input: { files: ['/tmp/out'], caption: 'still failed' } })]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
  });

  it('a SECOND call failing after the user collapsed the card (from the first failure) reopens it — an aggregate "any failed?" boolean cannot change value twice', () => {
    // Reproduces the exact trace from the finding: one card merges every
    // SendUserFile call in the bubble, so it routinely holds 2+ concurrent
    // deliveries. call1 and call2 both start running, call1 fails and opens
    // the card, the user reads it and collapses it, then call2 ALSO fails —
    // that must reopen the card and show call2's error with no click.
    setViewport(false);
    const err1 = 'SendUserFile failed — nothing was sent:\n- /tmp/out1 is a directory';
    const err2 = 'SendUserFile failed — nothing was sent:\n- /tmp/out2 is a directory';
    const { rerender } = render(<DeliverablesCard tools={[
      call('t1', ['/tmp/out1'], { status: 'running' }),
      call('t2', ['/tmp/out2'], { status: 'running' }),
    ]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();

    // call1 fails -> card opens with no click.
    rerender(<DeliverablesCard tools={[
      call('t1', ['/tmp/out1'], { status: 'failed', error: err1 }),
      call('t2', ['/tmp/out2'], { status: 'running' }),
    ]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getByText(/out1 is a directory/)).toBeInTheDocument();

    // User reads call1's error and collapses the card.
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();

    // call2 ALSO fails while call1 is still failed (hasFailure stays true
    // the whole time) -> the card must reopen and show call2's error.
    rerender(<DeliverablesCard tools={[
      call('t1', ['/tmp/out1'], { status: 'failed', error: err1 }),
      call('t2', ['/tmp/out2'], { status: 'failed', error: err2 }),
    ]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getByText(/out2 is a directory/)).toBeInTheDocument();
  });

  it('a call RECOVERING (failed -> complete) while a sibling stays failed does not reopen a card the user collapsed', () => {
    // Guards the ref gate itself: failedIdsKey changes value here too
    // ("t1,t2" -> "t2"), since recovery removes an id from the failed list
    // just as surely as a new failure adds one. Only the ref — which never
    // "forgets" an id it already marked surfaced — knows this key change
    // carries no NEW id, so it must not reopen the card. A version of this
    // effect that fires on any key change (ignoring the ref) would reopen
    // it here, which is exactly the bug this test exists to catch.
    setViewport(false);
    const err1 = 'SendUserFile failed — nothing was sent:\n- /tmp/out1 is a directory';
    const err2 = 'SendUserFile failed — nothing was sent:\n- /tmp/out2 is a directory';
    const { rerender } = render(<DeliverablesCard tools={[
      call('t1', ['/tmp/out1'], { status: 'failed', error: err1 }),
      call('t2', ['/tmp/out2'], { status: 'failed', error: err2 }),
    ]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Deliverables')); // user collapses it
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();

    // t1 recovers (failed -> complete); t2 is still failed. Key changes
    // from "t1,t2" to "t2" but introduces no id the ref hasn't seen.
    rerender(<DeliverablesCard tools={[
      call('t1', ['/tmp/out1'], { status: 'complete' }),
      call('t2', ['/tmp/out2'], { status: 'failed', error: err2 }),
    ]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
  });

  // Run LAST: broadcastCollapseAll/broadcastExpandAll flip a module-level flag
  // in useExpandAllToggle.ts that persists for the rest of this file's test
  // run (by design — see that file's header comment), so a test earlier in
  // this list would silently inherit 'expanded' or 'collapsed' mode instead
  // of the plain default this suite otherwise relies on.
  it('seeds CLOSED when Ctrl+O collapse-all is active at mount, and reopens on expand-all', () => {
    setViewport(false);
    broadcastCollapseAll();
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    act(() => broadcastExpandAll());
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
  });

});
