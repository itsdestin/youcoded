// @vitest-environment jsdom
// Settings → Browser: the two plain questions (which browser, show a window),
// the things a person may want to undo, and the confirm before signing out.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BrowserSettingsButton, { BrowserSettingsDialog, browserSettingsSummary } from '../src/renderer/components/browser/BrowserSettingsButton';
import { browserInfo, installBrowserBridge } from './helpers/browser-bridge';

afterEach(() => cleanup());

describe('Settings → Browser', () => {
  it('the row never starts the Browser\'s worker just by being drawn', () => {
    const b = installBrowserBridge();
    render(<BrowserSettingsButton />);
    expect(screen.getByText('Browser')).toBeInTheDocument();
    expect(b.bridge.info).not.toHaveBeenCalled();
  });

  it('is absent where the Browser is not supported', () => {
    installBrowserBridge();
    (window as any).claude.capabilities = { assistantBrowser: false };
    const { container } = render(<BrowserSettingsButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('switches the window on and off, and between the assistant\'s browser and My Chrome', async () => {
    const b = installBrowserBridge();
    render(<BrowserSettingsDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Show a browser window' }));
    await waitFor(() => expect(b.bridge.setShowWindow).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByText('My Chrome (Experimental)'));
    await waitFor(() => expect(b.bridge.updateSettings).toHaveBeenCalledWith({ useMyChrome: true }));
    expect(await screen.findByText(/chrome:\/\/inspect\/#remote-debugging/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByText('Chrome is ready.')).toBeInTheDocument();
  });

  it('asks first when switching would restart the browser for chats with pages open', async () => {
    const b = installBrowserBridge(browserInfo({ sessionsWithTabs: 2 }));
    render(<BrowserSettingsDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Show a browser window' }));
    expect(screen.getByText(/This restarts the browser for 2 chats using it/)).toBeInTheDocument();
    expect(b.bridge.setShowWindow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show window' }));
    await waitFor(() => expect(b.bridge.setShowWindow).toHaveBeenCalledWith(true));
  });

  it('lists the always-allowed sites, each removable', async () => {
    const b = installBrowserBridge(browserInfo({ settings: { ...browserInfo().settings, alwaysAllowedSites: ['github.com'] } }));
    render(<BrowserSettingsDialog onClose={() => {}} />);
    expect(await screen.findByText('github.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(b.bridge.removeSite).toHaveBeenCalledWith('github.com'));
  });

  it('signing out of every site asks first', async () => {
    const b = installBrowserBridge();
    render(<BrowserSettingsDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/The assistant's browser closes and forgets every sign-in/)).toBeInTheDocument();
    expect(b.bridge.clearSignins).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of everything' }));
    await waitFor(() => expect(b.bridge.clearSignins).toHaveBeenCalled());
  });

  it('with no browser installed it offers the download, and shows a failed one\'s real reason', async () => {
    const b = installBrowserBridge(browserInfo({ browsers: [], chosen: null, install: { phase: 'failed', error: 'ENOSPC: no space left on device' } }));
    render(<BrowserSettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/No Chrome, Edge, Chromium or Brave was found/)).toBeInTheDocument();
    // One plain sentence; the installer's own words wait under Details inside the box (guide "Status
    // and notices": machine words never in the sentence).
    expect(screen.getByText("The download didn't finish.")).toBeInTheDocument();
    expect(screen.queryByText(/ENOSPC/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText(/ENOSPC: no space left on device/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' })); // every retry reads "Try again" (error-notices-1#EN-Q1)
    await waitFor(() => expect(b.bridge.download).toHaveBeenCalled());
  });

  it('summarises the choice on the row', () => {
    expect(browserSettingsSummary(browserInfo())).toBe('Google Chrome · hidden');
    expect(browserSettingsSummary(browserInfo({ settings: { ...browserInfo().settings, useMyChrome: true } }))).toBe('My Chrome (Experimental)');
    expect(browserSettingsSummary(browserInfo({ chosen: null, install: { phase: 'downloading', percent: 12 } }))).toBe('Downloading… 12%');
  });
});
