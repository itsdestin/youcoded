// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import RemoteUnsupportedNotice from './RemoteUnsupportedNotice';
import {
  REMOTE_UNSUPPORTED_EVENT, remoteFeatureName, remoteUnsupportedMessage,
} from '../remote-unsupported';

function announce(channel: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent(REMOTE_UNSUPPORTED_EVENT, {
      detail: { channel, feature: remoteFeatureName(channel), message: remoteUnsupportedMessage(channel) },
    }));
  });
}

describe('remoteFeatureName', () => {
  it('maps a namespace to plain language', () => {
    expect(remoteFeatureName('social:list-friends')).toBe('Friends and challenges');
    expect(remoteFeatureName('artifacts:get')).toBe('Project files');
  });

  // 'theme-marketplace:' also starts with... nothing shared with 'theme:', but
  // 'theme:' IS a prefix of neither — the ordering hazard is real the other way:
  // a naive map could match 'theme:' first for 'theme-marketplace:list' if the
  // separator were dropped. Pin the intended winner.
  it('prefers the longer namespace when two could match', () => {
    expect(remoteFeatureName('theme-marketplace:list')).toBe('Theme browsing');
    expect(remoteFeatureName('theme:list')).toBe('Theme editing');
  });

  // The four names the local-engine work added (2026-09-05). WHY pinned: they
  // were the only rows in the table with no test, and deleting one is silent —
  // the notice falls back to the raw channel, so a phone opening its model
  // picker reads "provider:list isn't available via remote access yet." That
  // exact sentence was the regression this feature had to fix.
  it('names the local-engine and provider channels', () => {
    expect(remoteFeatureName('models:settings')).toBe('The local model manager');
    expect(remoteFeatureName('engine:prereqs')).toBe('The local engine');
    expect(remoteFeatureName('provider:list')).toBe('The model providers list');
    expect(remoteFeatureName('native:send')).toBe('The built-in assistant');
    // …and each reads as a sentence, which a plural noun would not.
    expect(remoteUnsupportedMessage('provider:list'))
      .toBe("The model providers list isn't available via remote access yet.");
  });

  it('falls back to the raw channel so the message is still specific', () => {
    expect(remoteFeatureName('wibble:frob')).toBe('wibble:frob');
  });

  it('phrases the message the way Destin asked for', () => {
    expect(remoteUnsupportedMessage('social:list-friends'))
      .toBe("Friends and challenges isn't available via remote access yet.");
  });

  // The phone's own bridge refuses too (2026-09-10). A phone doing no remote
  // access must not be told "via remote access" — that is a lie about its setup.
  it('says "on the phone" when the phone itself refused', () => {
    expect(remoteUnsupportedMessage('syncspaces:enable', 'phone'))
      .toBe("Syncing across your devices isn't available on the phone yet.");
    expect(remoteUnsupportedMessage('syncspaces:enable', 'remote'))
      .toBe("Syncing across your devices isn't available via remote access yet.");
  });

  // Both families are asked for automatically (Settings, Project View, launch);
  // an unnamed one would put a raw channel id in front of a phone user.
  it('names the sync-spaces and transcript families', () => {
    expect(remoteFeatureName('syncspaces:status')).toBe('Syncing across your devices');
    expect(remoteFeatureName('transcript:page')).toBe('Older messages');
  });
});

describe('RemoteUnsupportedNotice', () => {
  beforeEach(() => { cleanup(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing until something is unsupported', () => {
    const { container } = render(<RemoteUnsupportedNotice />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the feature message when the shim reports one', () => {
    render(<RemoteUnsupportedNotice />);
    announce('social:list-friends');
    expect(screen.getByRole('status').textContent)
      .toContain("Friends and challenges isn't available via remote access yet.");
  });

  it('auto-dismisses', () => {
    render(<RemoteUnsupportedNotice />);
    announce('artifacts:get');
    expect(screen.queryByRole('status')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6100); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('can be dismissed by hand', () => {
    render(<RemoteUnsupportedNotice />);
    announce('artifacts:get');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
