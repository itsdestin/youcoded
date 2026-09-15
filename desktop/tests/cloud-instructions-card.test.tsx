// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudInstructionsCard } from '../src/renderer/components/CloudInstructionsCard';
import { cloudConsentPreview } from '../src/renderer/dev/workbench/cloud-consent-preview';
afterEach(cleanup);
describe('specific instruction download in the conversation', () => {
  it('lists only named required files in one actionable prompt, then waits without starting anything', () => {
    const preview = cloudConsentPreview(new URLSearchParams('cloudConsent=instructions&cloudMultiple=1'))!;
    render(<CloudInstructionsCard preview={preview} />);
    expect(screen.getByText(/CLAUDE.md/)).toBeInTheDocument();
    expect(screen.getByText(/project-guidelines.md/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Download and continue' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Download and continue' }));
    expect(screen.getByText(/Waiting for OneDrive/)).toBeInTheDocument();
    expect(screen.getByText('Your conversation will start when its instructions are ready.')).toBeInTheDocument();
  });
  it('keeps declined instructions visible without silently continuing', () => {
    render(<CloudInstructionsCard preview={cloudConsentPreview(new URLSearchParams('cloudConsent=instructions'))!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByText(/This conversation still needs its instructions./)).toBeInTheDocument();
    expect(screen.queryByText('Waiting for OneDrive')).not.toBeInTheDocument();
  });
  it('never restores an earlier approval when opening a new operation', () => {
    expect(cloudConsentPreview(new URLSearchParams('cloudConsent=allowed'))).toBeNull();
    expect(cloudConsentPreview(new URLSearchParams('cloudConsent=instructions'))?.initial.phase).toBe('ask');
  });
});
