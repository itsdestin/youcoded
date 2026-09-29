import React from 'react';
import { ErrorState } from './ui';

interface Props {
  /** Label shown in the fallback UI so users know which panel failed */
  name: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.name}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      // WHY ErrorState, not a hand-rolled text-destructive-fg title (guide: no
      // red/coloured body text for messages) — this is exactly ErrorState's
      // general shape (title + explainer + one action), just never routed
      // through the shared primitive.
      return (
        <div className="flex items-center justify-center h-full p-4">
          <ErrorState
            title={`${this.props.name} crashed`}
            explainer={this.state.error.message}
            onRetry={() => this.setState({ error: null })}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
