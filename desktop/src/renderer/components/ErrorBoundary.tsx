import React from 'react';
import { ErrorState } from './ui';
import { BugReportPopup } from './development/BugReportPopup';
import type { ReportContext } from './development/ReportDesign';

interface Props {
  /** Label shown in the fallback UI so users know which panel failed */
  name: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  /** The bug report opened from this crash (Report bug / Diagnose), or null. */
  report: ReportContext | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, report: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.name}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const raw = this.state.error.message || String(this.state.error);
      // WHY the "we don't know why" shape (final review F19; docs/error-message-standards.md
      // shape 2; guide "Status and notices"): a render crash has no known cause, so the box
      // says so in plain words with a bold title in the normal colour, offers Report bug and
      // Diagnose (both hand the real message to the bug report) beside Try again, and keeps
      // JavaScript's own words under a Details fold — they were the sentence.
      return (
        <div className="flex items-center justify-center h-full p-4">
          <div className="w-full max-w-md space-y-2">
            <ErrorState
              title={`${this.props.name} stopped working`}
              explainer="Something went wrong while showing this part of the app. Try again, or report it so it can be fixed."
              onRetry={() => this.setState({ error: null })}
              onReportBug={() => this.setState({ report: { surface: this.props.name, error: raw } })}
              onDiagnose={() => this.setState({ report: { surface: this.props.name, error: raw, diagnose: true } })}
              details={raw} // popup-cards-8#Q-1: Details sits inside the error box, everywhere
            />
          </div>
          <BugReportPopup open={!!this.state.report} onClose={() => this.setState({ report: null })} context={this.state.report ?? undefined} />
        </div>
      );
    }
    return this.props.children;
  }
}
