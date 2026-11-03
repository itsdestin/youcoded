// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StartupStatus } from '../src/renderer/components/NativeStartupNotice';
import { forgetNativeStartup, getNativeStartup, resetNativeStartups, setNativeStartup, subscribeNativeStartup } from '../src/renderer/state/native-startup-store';
import type { NativeStartupState } from '../src/shared/native-startup';

const failed: NativeStartupState = { phase: 'failed', cause: 'tools', canContinue: true, attemptId: 'a', hostId: 'h', generation: 1, revision: 2,
  issues: [{ id: 'slow', label: 'Project tools', error: 'The server did not respond within its connection timeout.' }] };

describe('native startup status above the composer', () => {
  it('says what is connecting and keeps the draft as a draft', () => {
    render(<StartupStatus state={{ phase: 'connecting', attemptId: 'a', hostId: 'h', generation: 1, revision: 1 }} onAction={vi.fn()} />);
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    // WHY: a connecting state offers no failure buttons; the reassurance line's wording is not pinned.
    expect(screen.queryByRole('button')).toBeNull();
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

const state = (phase: 'ready' | 'connecting', generation = 1, revision = 1): NativeStartupState => phase === 'ready'
  ? { phase, hostId: 'host', generation, revision } : { phase, hostId: 'host', generation, revision, attemptId: 'attempt' };

describe('native startup live facts', () => {
  beforeEach(() => resetNativeStartups());
  it('does not replace a live ready push with an older page-fill snapshot', () => {
    setNativeStartup('a', state('ready', 1, 3));
    setNativeStartup('a', state('connecting', 1, 2));
    expect(getNativeStartup('a')?.phase).toBe('ready');
  });
  it('does not apply an old generation to a reopened chat', () => {
    setNativeStartup('a', state('ready', 2, 1));
    setNativeStartup('a', state('connecting', 1, 99));
    expect(getNativeStartup('a')?.phase).toBe('ready');
  });
  it('forgets closed chats without letting a late snapshot resurrect their gate', () => {
    setNativeStartup('a', state('connecting'));
    forgetNativeStartup('a');
    setNativeStartup('a', state('ready', 1, 5));
    expect(getNativeStartup('a')).toBeUndefined();
    setNativeStartup('a', state('connecting', 2));
    expect(getNativeStartup('a')?.phase).toBe('connecting');
  });
  it('notifies only the changed session and ignores repeated versions', () => {
    const a = vi.fn(), b = vi.fn();
    const offA = subscribeNativeStartup('a', a), offB = subscribeNativeStartup('b', b);
    setNativeStartup('a', state('connecting'));
    setNativeStartup('a', state('connecting'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    offA(); offB();
  });
  it('ignores malformed facts instead of silently changing readiness', () => {
    setNativeStartup('a', state('connecting'));
    setNativeStartup('a', { phase: 'ready' } as NativeStartupState);
    expect(getNativeStartup('a')?.phase).toBe('connecting');
  });
});
