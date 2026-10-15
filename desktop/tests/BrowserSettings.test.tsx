// @vitest-environment jsdom
// Assistant settings → Browser: where the page lives, the two plain questions (which
// browser, show a window), the things a person may want to undo, and the confirm
// before signing out.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BrowserSettings from '../src/renderer/components/browser/BrowserSettings';
import AssistantSettingsRow from '../src/renderer/components/assistant-settings/AssistantSettings';
import { browserInfo, installBrowserBridge } from './helpers/browser-bridge';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as any).claude; });

// Just enough of window.claude for Assistant settings to open (its General page).
function stubAssistantSettings() {
  // The General page reads two preferences from localStorage, which this test environment lacks.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  (window as any).claude = {
    native: { supported: false },
    providers: { list: async () => [], catalog: async () => [] },
    models: { installed: async () => [], curated: async () => [], onDownloadProgress: () => () => {} },
    firstRun: { getState: async () => ({ authMode: 'oauth', currentStep: 'COMPLETE' }) },
    search: { list: async () => [] },
    syncSpaces: { onEvent: () => () => {} },
    on: { statusData: () => () => {} },
    off: () => {},
    folders: { list: async () => [] },
    shell: { openExternal: () => {} },
  };
}
const openAssistantSettings = () => {
  render(<AssistantSettingsRow defaults={{ skipPermissions: false, model: 'sonnet', projectFolder: '' }} onDefaultsChange={() => {}} />);
  fireEvent.click(screen.getByText('Assistant settings'));
};

describe('Settings → Browser', () => {
  // Destin, 2026-10-15 (browser-fit-1#N-1): the Browser is a page of Assistant settings,
  // not its own row in Settings.
  it('is a page of Assistant settings, and opening the panel never starts the Browser\'s worker', async () => {
    stubAssistantSettings();
    const b = installBrowserBridge();
    openAssistantSettings();
    const page = await screen.findByRole('button', { name: 'Browser' });
    expect(b.bridge.info).not.toHaveBeenCalled();
    fireEvent.click(page);
    expect(await screen.findByText('Which browser')).toBeInTheDocument();
    expect(b.bridge.info).toHaveBeenCalled();
  });

  it('has no page where the Browser is not supported', async () => {
    stubAssistantSettings();
    installBrowserBridge();
    (window as any).claude.capabilities = { assistantBrowser: false };
    openAssistantSettings();
    expect(await screen.findByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Browser' })).toBeNull();
  });

  it('switches the window on and off, and between the assistant\'s browser and My Chrome', async () => {
    const b = installBrowserBridge();
    render(<BrowserSettings />);
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
    render(<BrowserSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Show a browser window' }));
    expect(screen.getByText(/This restarts the browser for 2 chats using it/)).toBeInTheDocument();
    expect(b.bridge.setShowWindow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show window' }));
    await waitFor(() => expect(b.bridge.setShowWindow).toHaveBeenCalledWith(true));
  });

  it('lists the always-allowed sites, each removable', async () => {
    const b = installBrowserBridge(browserInfo({ settings: { ...browserInfo().settings, alwaysAllowedSites: ['github.com'] } }));
    render(<BrowserSettings />);
    expect(await screen.findByText('github.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(b.bridge.removeSite).toHaveBeenCalledWith('github.com'));
  });

  it('signing out of every site asks first', async () => {
    const b = installBrowserBridge();
    render(<BrowserSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/The assistant's browser closes and forgets every sign-in/)).toBeInTheDocument();
    expect(b.bridge.clearSignins).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of everything' }));
    await waitFor(() => expect(b.bridge.clearSignins).toHaveBeenCalled());
  });

  it('with no browser installed it offers the download, and shows a failed one\'s real reason', async () => {
    const b = installBrowserBridge(browserInfo({ browsers: [], chosen: null, install: { phase: 'failed', error: 'ENOSPC: no space left on device' } }));
    render(<BrowserSettings />);
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
});
