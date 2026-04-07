import React from 'react';

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
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-fg-muted text-xs p-4">
          <span className="text-red-400 font-medium">{this.props.name} crashed</span>
          <span className="text-fg-faint max-w-md text-center break-words">
            {this.state.error.message}
          </span>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 px-3 py-1 rounded-sm bg-inset hover:bg-edge text-fg-2 transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
