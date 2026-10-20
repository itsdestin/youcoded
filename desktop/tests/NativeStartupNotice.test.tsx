// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StartupStatus } from '../src/renderer/components/NativeStartupNotice';
import type { NativeStartupState } from '../src/shared/native-startup';

const failed: NativeStartupState = { phase: 'failed', cause: 'tools', canContinue: true, attemptId: 'a', hostId: 'h', generation: 1, revision: 2,
  issues: [{ id: 'slow', label: 'Project tools', error: 'The server did not respond within its connection timeout.' }] };

describe('native startup status above the composer', () => {
  it('says what is connecting and keeps the draft as a draft', () => {
    render(<StartupStatus state={{ phase: 'connecting', attemptId: 'a', hostId: 'h', generation: 1, revision: 1 }} onAction={vi.fn()} />);
    expect(screen.getByText('Connecting tools…')).toBeInTheDocument();
    expect(screen.getByText('You can read or draft a message while this finishes.')).toBeInTheDocument();
  });
  it('offers explicit retry or continuing without failed tools, and sends nothing on its own', () => {
    const act = vi.fn(); render(<StartupStatus state={failed} onAction={act} />);
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without these tools' }));
    expect(act).toHaveBeenLastCalledWith('continue');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(act).toHaveBeenLastCalledWith('retry');
  });
  it('never offers skipping failed history preparation', () => {
    render(<StartupStatus state={{ ...failed, cause: 'preparation', canContinue: false, issues: [] }} onAction={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Continue without these tools' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
  it('disables both failure choices while one choice is being applied', () => {
    render(<StartupStatus state={failed} busy onAction={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue without these tools' })).toBeDisabled();
  });
  it('has no leftover spinner or notice once ready', () => {
    const { container } = render(<StartupStatus state={{ phase: 'ready', hostId: 'h', generation: 1, revision: 3 }} onAction={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
