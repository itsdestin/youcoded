// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SpecialistReportCard from './SpecialistReportCard';

afterEach(cleanup);

// 2026-08-16 (Destin, 1b hands-on): a delivered specialist report is a
// user-ROLE turn on the wire (the parent model reads it). It first rendered
// as the user's own accent bubble, then as a full notice; Destin's ruling:
// "these reports just shouldn't be rendering at all in chat … should only
// register as a 'task completion' toolcard." This pins the compact card.
const TEXT = '[Background specialist finished] Briar the Worthy Worker (worker) completed the task you delegated ("Create and delete test file", started 0m ago, 2 steps).\n\n## Report from Briar the Worthy Worker (worker)\n\n- Created and deleted the marker file.';
const message = { id: 'm1', role: 'user' as const, timestamp: 1_700_000_000_000, content: TEXT };
const meta = { childId: 'c1', title: 'Briar the Worthy Worker', agentType: 'worker', description: 'Create and delete test file', status: 'completed' as const, steps: 2 };

describe('SpecialistReportCard', () => {
  it('is a collapsed one-line card by default — no user bubble, no report body', () => {
    const { container } = render(<SpecialistReportCard message={message} injected="specialist-report" meta={meta} sessionId="s1" showTimestamps={false} />);
    expect(screen.getByTestId('specialist-report-card')).toHaveAttribute('data-status', 'completed');
    expect(container.querySelector('.user-bubble')).toBeNull();
    // Header says who finished and what they were asked, with the step count.
    expect(screen.getByText(/Briar the Worthy Worker/)).toBeInTheDocument();
    expect(screen.getByText(/Create and delete test file.*2 steps/)).toBeInTheDocument();
    // The report itself is NOT on screen until expanded.
    expect(container.textContent).not.toContain('Created and deleted the marker file');
    expect(container.textContent).not.toContain('[Background specialist finished]');
  });

  it('expands to the markdown-rendered report body, minus the preamble the header already covers', () => {
    const { container } = render(<SpecialistReportCard message={message} injected="specialist-report" meta={meta} sessionId="s1" showTimestamps={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('h2')?.textContent).toContain('Report from Briar the Worthy Worker');
    expect(container.textContent).toContain('Created and deleted the marker file');
    expect(container.textContent).not.toContain('## Report');
    expect(container.textContent).not.toContain('[Background specialist finished]');
  });

  it('marks a failed run and falls back to the prose when no meta is present', () => {
    const failedText = '[Background specialist failed] Kai the Efficient Explorer (explorer): the provider returned 402. Partial transcript: specialist session c9.';
    render(<SpecialistReportCard message={{ ...message, content: failedText }} injected="specialist-report" sessionId="s1" showTimestamps={false} />);
    expect(screen.getByTestId('specialist-report-card')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByText('Note for the assistant')).toBeInTheDocument();
    expect(screen.getByText(/Kai the Efficient Explorer \(explorer\): the provider returned 402/)).toBeInTheDocument();
  });
});
